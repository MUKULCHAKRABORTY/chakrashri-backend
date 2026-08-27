/**
 * PAYMENT RECONCILIATION — the safety net for "payment succeeded but the
 * order/booking still says pending".
 *
 * There are three independent paths that should confirm a payment:
 *   1. the browser calling /verify right after checkout,
 *   2. Razorpay's server-to-server webhook,
 *   3. this script.
 *
 * (1) fails if the customer closes the tab, loses signal, or their request hits
 * the API while it's cold-starting. (2) fails if the webhook secret is wrong,
 * the endpoint is briefly unreachable, or the service is asleep when Razorpay
 * calls it. Both are realistic — and when both miss, the customer's money is
 * captured while the order sits at "pending" until the expiry sweep cancels it
 * and hands the stock back. The customer paid and got nothing.
 *
 * OPS-02: this script existed, its own header said "schedule it every ~15
 * minutes", and nothing scheduled it. render.yaml now declares it as a cron
 * service alongside the expiry sweep.
 *
 * It is deliberately read-then-fix: it never invents a payment, it only records
 * what Razorpay confirms as captured, and it refuses to auto-confirm when the
 * amounts disagree.
 *
 * Run: node scripts/reconcile-payments.js
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const db = require('../src/config/db');
const razorpay = require('../src/config/razorpay');
const { reconcileStuckRefunds } = require('../src/utils/refunds');
const { logger } = require('../src/utils/logger');

// Only look at recent items — an order pending for a month is not a
// reconciliation case, it's an abandoned checkout the expiry sweep handles.
const LOOKBACK_HOURS = parseInt(process.env.RECONCILE_LOOKBACK_HOURS || '72', 10);

// Every mismatch is a case a human must look at before goods ship. Counted and
// returned so the process can exit non-zero, which is what makes the platform's
// cron history show a problem instead of a green tick.
const findings = { fixed: 0, mismatched: 0, errors: 0 };

/**
 * Records a mismatch in the audit log as well as the console, so it survives
 * log rotation and shows up in the admin's audit view rather than only in a
 * cron output nobody reads.
 */
async function flagMismatch(entityType, entityId, detail) {
  findings.mismatched++;
  logger.error('RECONCILIATION MISMATCH — manual review required', null, { entityType, entityId, ...detail });
  try {
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES (NULL, 'reconciliation_mismatch', $1, $2, $3)`,
      [entityType, entityId, JSON.stringify(detail)]
    );
  } catch (err) {
    logger.error('Could not record reconciliation mismatch in the audit log', err);
  }
}

async function reconcileOrders() {
  const { rows } = await db.query(
    `SELECT id, order_number, razorpay_order_id, total_paise
     FROM orders
     WHERE status = 'pending'
       AND razorpay_order_id IS NOT NULL
       AND created_at > now() - make_interval(hours => $1)
     ORDER BY created_at`,
    [LOOKBACK_HOURS]
  );
  if (!rows.length) { logger.info('Reconcile: nothing pending in orders'); return; }

  for (const order of rows) {
    try {
      const payments = await razorpay.orders.fetchPayments(order.razorpay_order_id);
      const items = (payments && payments.items) || [];
      const captured = items.find((p) => p.status === 'captured');

      if (captured) {
        // Guard against a partial/mismatched capture being treated as full
        // payment. This is the same check /verify and the webhook now apply —
        // this script was already doing it correctly while the live paths were
        // not, which is the inconsistency PAY-01 was about.
        if (Number(captured.amount) !== Number(order.total_paise)
            || String(captured.currency || 'INR').toUpperCase() !== 'INR') {
          await db.query(
            `UPDATE orders SET status = 'payment_review',
                               payment_review_reason = $2,
                               razorpay_payment_id = COALESCE(razorpay_payment_id, $3),
                               updated_at = now()
              WHERE id = $1 AND status = 'pending'`,
            [order.id,
              `reconciliation_mismatch: captured ${captured.amount} ${captured.currency}, expected ${order.total_paise} INR`,
              captured.id]
          );
          await flagMismatch('order', order.id, {
            orderNumber: order.order_number,
            capturedPaise: Number(captured.amount),
            expectedPaise: Number(order.total_paise),
            currency: captured.currency
          });
          continue;
        }

        const { rowCount } = await db.query(
          `UPDATE orders SET status = 'paid', razorpay_payment_id = $1, updated_at = now()
           WHERE id = $2 AND status = 'pending'`,
          [captured.id, order.id]
        );
        if (rowCount) {
          findings.fixed++;
          logger.warn('Reconciled an order whose captured payment was never recorded', {
            orderNumber: order.order_number, razorpayPaymentId: captured.id
          });
        }
      } else if (items.some((p) => p.status === 'failed')) {
        logger.info('Payment failed at the gateway; the expiry sweep will release stock', {
          orderNumber: order.order_number
        });
      }
    } catch (err) {
      findings.errors++;
      logger.error('Error reconciling order', err, { orderNumber: order.order_number });
    }
  }
}

async function reconcileBookings(table, entityType, label) {
  const { rows } = await db.query(
    `SELECT id, razorpay_order_id, amount_paise
     FROM ${table}
     WHERE payment_status = 'unpaid'
       AND razorpay_order_id IS NOT NULL
       AND created_at > now() - make_interval(hours => $1)
     ORDER BY created_at`,
    [LOOKBACK_HOURS]
  );
  if (!rows.length) { logger.info(`Reconcile: nothing pending in ${label}`); return; }

  for (const b of rows) {
    try {
      const payments = await razorpay.orders.fetchPayments(b.razorpay_order_id);
      const items = (payments && payments.items) || [];
      const captured = items.find((p) => p.status === 'captured');
      if (!captured) continue;

      if (Number(captured.amount) !== Number(b.amount_paise)
          || String(captured.currency || 'INR').toUpperCase() !== 'INR') {
        await db.query(
          `UPDATE ${table} SET payment_status = 'payment_review', updated_at = now()
            WHERE id = $1 AND payment_status = 'unpaid'`,
          [b.id]
        );
        await flagMismatch(entityType, b.id, {
          capturedPaise: Number(captured.amount),
          expectedPaise: Number(b.amount_paise),
          currency: captured.currency
        });
        continue;
      }

      const { rowCount } = await db.query(
        `UPDATE ${table} SET payment_status = 'paid', razorpay_payment_id = $1, updated_at = now()
         WHERE id = $2 AND payment_status = 'unpaid'`,
        [captured.id, b.id]
      );
      if (rowCount) {
        findings.fixed++;
        logger.warn(`Reconciled a ${label} whose captured payment was never recorded`, {
          bookingId: b.id, razorpayPaymentId: captured.id
        });
      }
    } catch (err) {
      findings.errors++;
      logger.error(`Error reconciling ${label}`, err, { bookingId: b.id });
    }
  }
}

async function main() {
  logger.info('Reconciliation starting', { lookbackHours: LOOKBACK_HOURS });

  await reconcileOrders();
  await reconcileBookings('puja_bookings', 'puja_booking', 'puja booking');
  await reconcileBookings('astrology_bookings', 'astrology_booking', 'astrology booking');

  // PAY-02 — resolve any refund left in 'initiated' by a crash between the
  // gateway call and the outcome write. The ledger records intent first
  // precisely so this question has a definite answer.
  try {
    const refunds = await reconcileStuckRefunds(10);
    if (refunds.checked) logger.warn('Resolved in-flight refunds', refunds);
  } catch (err) {
    findings.errors++;
    logger.error('Refund reconciliation failed', err);
  }

  logger.info('Reconciliation complete', findings);
  await db.pool.end().catch(() => {});

  // Exit non-zero on anything a human needs to see. A cron job that always
  // reports success is a cron job nobody checks — and a mismatch here means
  // real money is in a state the system cannot resolve on its own.
  process.exit(findings.mismatched > 0 || findings.errors > 0 ? 1 : 0);
}

main().catch(async (err) => {
  logger.error('Reconciliation failed', err);
  await db.pool.end().catch(() => {});
  process.exit(1);
});
