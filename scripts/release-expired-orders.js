/**
 * Releases stock and booking capacity reserved by checkouts that were started
 * but never completed (customer abandoned — no payment success, no failure
 * webhook either, so nothing else in the system would ever clean these up).
 *
 * Schedule every 5-10 minutes via your host's cron feature. render.yaml
 * declares it as a cron service running every ten minutes.
 * (Written out in words on purpose: the cron expression for that contains the
 *  two characters that close a block comment, which silently truncates this
 *  header and turns the rest of it into code.)
 *
 * Safe to run concurrently with itself, with the payment webhook, or with an
 * admin cancelling the same order — every path goes through the same shared,
 * row-locked, idempotent helpers (restoreOrderStock / releaseBookingSlot), so a
 * given order's stock or a booking's seat can only ever be returned once.
 *
 * BIZ-03: bookings are now swept too. The orders sweep existed; the booking
 * equivalent did not, so an abandoned booking sat as a live "requested" row
 * forever — and once capacity is enforced (BIZ-02), that becomes a
 * denial-of-inventory vector against a practitioner's calendar.
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const db = require('../src/config/db');
const { restoreOrderStock } = require('../src/utils/stock');
const { releaseExpiredBookings } = require('../src/utils/bookingSlots');
const { getSettings } = require('../src/utils/settings');
const { logger } = require('../src/utils/logger');

async function resolveExpiryMinutes() {
  // HYG-03 — the window is a business decision (how long to hold stock for
  // someone mid-checkout), so it belongs in site_settings where the shop owner
  // can change it. The env var remains as an override, and the compiled default
  // is the final fallback, so this works on a database that has never been
  // migrated.
  try {
    const settings = await getSettings();
    const fromSettings = Number(settings.order_reservation_expiry_minutes);
    if (Number.isFinite(fromSettings) && fromSettings > 0) return Math.floor(fromSettings);
  } catch {
    // getSettings never throws, but belt and braces: a sweep that cannot read
    // its configuration must still run with a sane default rather than not run.
  }
  const raw = parseInt(process.env.ORDER_RESERVATION_EXPIRY_MINUTES || '30', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

async function sweepOrders(expiryMinutes) {
  // make_interval() with a bound parameter rather than string interpolation.
  // The value is sanitised above, but building SQL by concatenation inside a
  // scheduled job is a habit worth not having.
  const { rows: expired } = await db.query(
    `SELECT id, order_number FROM orders
      WHERE status = 'pending'
        AND created_at < now() - make_interval(mins => $1)
      ORDER BY created_at
      LIMIT 500`,
    [expiryMinutes]
  );

  if (!expired.length) {
    logger.info('Expiry sweep: no expired pending orders');
    return { released: 0, skipped: 0, failed: 0 };
  }

  const result = { released: 0, skipped: 0, failed: 0 };
  for (const order of expired) {
    try {
      const outcome = await restoreOrderStock(order.id, 'cancelled', 'expired_abandoned_checkout');
      if (outcome.restored) result.released++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      logger.error('Failed to release expired order', err, { orderNumber: order.order_number });
    }
  }
  return result;
}

async function main() {
  const expiryMinutes = await resolveExpiryMinutes();
  logger.info('Expiry sweep starting', { expiryMinutes });

  const orders = await sweepOrders(expiryMinutes);
  const bookings = await releaseExpiredBookings(expiryMinutes);

  logger.info('Expiry sweep complete', {
    orders: { released: orders.released, skipped: orders.skipped, failed: orders.failed },
    bookings: { released: bookings.released, skipped: bookings.skipped, failed: bookings.failed }
  });

  // Close the pool rather than calling process.exit() with work possibly still
  // in flight. A non-zero exit when anything failed is what makes a broken
  // sweep visible in the platform's cron history instead of silently green.
  await db.pool.end().catch(() => {});
  const anyFailed = orders.failed > 0 || bookings.failed > 0;
  process.exit(anyFailed ? 1 : 0);
}

main().catch(async (err) => {
  logger.error('Expiry sweep failed', err);
  await db.pool.end().catch(() => {});
  process.exit(1);
});
