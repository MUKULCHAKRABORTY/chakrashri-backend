/**
 * Releases stock reserved by orders that were created but never completed
 * (customer abandoned checkout — no payment success, no failure webhook
 * either, so nothing else in the system would ever clean these up).
 *
 * Schedule this to run every 5-10 minutes via your host's cron/scheduled-task
 * feature (Render Cron Jobs, Railway Cron, a plain `crontab` entry on a VM, etc.):
 *
 *   node scripts/release-expired-orders.js
 *
 * Safe to run concurrently with itself, with the payment webhook, or with an
 * admin cancelling the same order — all three paths now go through the same
 * shared, row-locked, idempotent restoreOrderStock() in src/utils/stock.js,
 * so a given order's stock can only ever be restored once.
 */
require('dotenv').config();
const db = require('../src/config/db');
const { restoreOrderStock } = require('../src/utils/stock');

const EXPIRY_MINUTES = parseInt(process.env.ORDER_RESERVATION_EXPIRY_MINUTES || '30', 10);

async function main() {
  const { rows: expired } = await db.query(
    `SELECT id, order_number FROM orders
     WHERE status = 'pending' AND created_at < now() - interval '${EXPIRY_MINUTES} minutes'`
  );

  if (!expired.length) {
    console.log(`[${new Date().toISOString()}] No expired pending orders found.`);
    process.exit(0);
  }

  console.log(`[${new Date().toISOString()}] Releasing ${expired.length} expired order(s)...`);
  for (const order of expired) {
    try {
      const result = await restoreOrderStock(order.id, 'cancelled', 'expired_abandoned_checkout');
      console.log(`  ${order.order_number}: ${result.restored ? 'released' : 'skipped (' + result.reason + ')'}`);
    } catch (err) {
      console.error(`  FAILED to release ${order.order_number}:`, err.message);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Expiry sweep failed:', err);
  process.exit(1);
});
