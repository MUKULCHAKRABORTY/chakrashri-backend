/**
 * PAYMENT RECONCILIATION — the safety net for "payment succeeded but the
 * order/booking still says pending".
 *
 * There are three independent paths that should confirm a payment:
 *   1. the browser calling /verify right after checkout,
 *   2. Razorpay's server-to-server webhook,
 *   3. this script.
 *
 * (1) fails if the customer closes the tab, loses signal, or their request
 * hits the API while it's cold-starting. (2) fails if the webhook secret is
 * wrong, the endpoint is briefly unreachable, or the service is asleep when
 * Razorpay calls it. Both are realistic — and when both miss, the customer's
 * money is captured while the order sits at "pending" forever.
 *
 * This script asks Razorpay directly what actually happened and reconciles
 * the database to match. It is deliberately read-then-fix: it never invents a
 * payment, it only records payments Razorpay confirms as captured.
 *
 * Run: node scripts/reconcile-payments.js
 * Schedule it every ~15 minutes alongside release-expired-orders.js.
 */
require('dotenv').config();
const db = require('../src/config/db');
const razorpay = require('../src/config/razorpay');

// Only look at recent items — an order pending for a month is not a
// reconciliation case, it's an abandoned checkout the expiry sweep handles.
const LOOKBACK_HOURS = parseInt(process.env.RECONCILE_LOOKBACK_HOURS || '72', 10);

async function reconcileOrders() {
  const { rows } = await db.query(
    `SELECT id, order_number, razorpay_order_id, total_paise
     FROM orders
     WHERE status = 'pending'
       AND razorpay_order_id IS NOT NULL
       AND created_at > now() - ($1 || ' hours')::interval`,
    [LOOKBACK_HOURS]
  );
  if (!rows.length) { console.log('  orders: nothing pending to reconcile'); return; }

  for (const order of rows) {
    try {
      const payments = await razorpay.orders.fetchPayments(order.razorpay_order_id);
      const captured = (payments.items || []).find((p) => p.status === 'captured');

      if (captured) {
        // Guard against a partial/mismatched capture being treated as full
        // payment — if the amounts disagree, flag it rather than silently
        // marking the order paid.
        if (Number(captured.amount) !== Number(order.total_paise)) {
          console.warn(`  ! ${order.order_number}: captured ${captured.amount} but order total is ${order.total_paise} — NOT auto-confirming, needs manual review`);
          continue;
        }
        const { rowCount } = await db.query(
          `UPDATE orders SET status = 'paid', razorpay_payment_id = $1, updated_at = now()
           WHERE id = $2 AND status = 'pending'`,
          [captured.id, order.id]
        );
        if (rowCount) console.log(`  FIXED ${order.order_number}: payment ${captured.id} was captured but never recorded`);
      } else {
        const failed = (payments.items || []).some((p) => p.status === 'failed');
        if (failed) console.log(`  ${order.order_number}: payment failed at Razorpay (expiry sweep will release stock)`);
      }
    } catch (err) {
      console.error(`  ERROR reconciling ${order.order_number}:`, err.error?.description || err.message);
    }
  }
}

async function reconcileBookings(table, label) {
  const { rows } = await db.query(
    `SELECT id, razorpay_order_id, amount_paise
     FROM ${table}
     WHERE payment_status = 'unpaid'
       AND razorpay_order_id IS NOT NULL
       AND created_at > now() - ($1 || ' hours')::interval`,
    [LOOKBACK_HOURS]
  );
  if (!rows.length) { console.log(`  ${label}: nothing pending to reconcile`); return; }

  for (const b of rows) {
    try {
      const payments = await razorpay.orders.fetchPayments(b.razorpay_order_id);
      const captured = (payments.items || []).find((p) => p.status === 'captured');
      if (captured) {
        if (Number(captured.amount) !== Number(b.amount_paise)) {
          console.warn(`  ! ${label} ${b.id}: amount mismatch — NOT auto-confirming`);
          continue;
        }
        const { rowCount } = await db.query(
          `UPDATE ${table} SET payment_status = 'paid', razorpay_payment_id = $1, updated_at = now()
           WHERE id = $2 AND payment_status = 'unpaid'`,
          [captured.id, b.id]
        );
        if (rowCount) console.log(`  FIXED ${label} ${b.id}: payment ${captured.id} was captured but never recorded`);
      }
    } catch (err) {
      console.error(`  ERROR reconciling ${label} ${b.id}:`, err.error?.description || err.message);
    }
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Reconciling payments (last ${LOOKBACK_HOURS}h)...`);
  await reconcileOrders();
  await reconcileBookings('puja_bookings', 'puja booking');
  await reconcileBookings('astrology_bookings', 'astrology booking');
  console.log('Reconciliation complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Reconciliation failed:', err);
  process.exit(1);
});
