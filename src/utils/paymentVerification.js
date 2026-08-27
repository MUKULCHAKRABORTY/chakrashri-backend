/**
 * Authoritative payment checks — closes PAY-01.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RAZORPAY SIGNATURE ACTUALLY PROVES
 * ---------------------------------------------------------------------------
 * HMAC-SHA256 over `order_id|payment_id` with the key secret proves that this
 * (order, payment) pair really was produced by Razorpay for this merchant.
 * That is a genuine and necessary check — but it is a check of AUTHENTICITY,
 * not of SETTLEMENT. It says nothing about:
 *
 *   - whether the payment was CAPTURED, or merely AUTHORIZED. An authorized
 *     payment is a hold on the customer's card; the money has not moved. If
 *     auto-capture is off, or a capture later fails, the signature is still
 *     perfectly valid — so the previous code marked the order paid and the
 *     goods shipped against money that never arrived.
 *   - whether the amount captured matches what the order is worth.
 *   - whether the currency matches.
 *   - whether the payment even belongs to the order being confirmed.
 *
 * This module asks Razorpay directly and requires all four. It is the same
 * standard scripts/reconcile-payments.js already applied — that script refused
 * to auto-confirm on an amount mismatch, while the live checkout path it exists
 * to back up did not check at all. The safety net was stricter than the thing
 * it was protecting; this makes the hot path the strictest.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT FAIL THE REQUEST ON MISMATCH
 * ---------------------------------------------------------------------------
 * A mismatch is not necessarily fraud — a partial capture, a currency
 * misconfiguration or a genuine Razorpay-side edge case all land here. What it
 * always is, is something a human must look at before goods leave the
 * warehouse. So a mismatch produces a distinct, loud, auditable outcome rather
 * than either silently accepting it or telling the customer their real payment
 * failed.
 */
const razorpay = require('../config/razorpay');
const { logger } = require('./logger');

const MISMATCH = 'payment_mismatch';
const NOT_CAPTURED = 'payment_not_captured';
const UNVERIFIABLE = 'payment_unverifiable';

/**
 * Fetches the payment from Razorpay and asserts it settles `expectedAmountPaise`
 * against `razorpayOrderId`.
 *
 * @returns {Promise<{ok: true, payment: object} | {ok: false, reason: string, detail: object}>}
 *   Never throws for a business-level mismatch — the caller decides the HTTP
 *   response. It only rejects if something truly unexpected happens, which the
 *   caller's asyncHandler will surface.
 */
async function verifyCapturedPayment({ razorpayOrderId, razorpayPaymentId, expectedAmountPaise, currency }) {
  const expected = Number(expectedAmountPaise);
  const expectedCurrency = currency || 'INR';

  if (!Number.isInteger(expected) || expected <= 0) {
    // A non-integer expected amount means the caller passed a BIGINT string or
    // a float. Refuse rather than compare loosely — this is money.
    return {
      ok: false,
      reason: UNVERIFIABLE,
      detail: { message: 'Expected amount is not a positive integer number of paise.', expectedAmountPaise }
    };
  }

  let payment;
  try {
    payment = await razorpay.payments.fetch(razorpayPaymentId);
  } catch (err) {
    logger.error('Razorpay payment fetch failed during verification', err, {
      razorpayOrderId, razorpayPaymentId
    });
    return {
      ok: false,
      reason: UNVERIFIABLE,
      detail: { message: err.error?.description || err.message || 'Gateway unreachable.' }
    };
  }

  if (!payment) {
    return { ok: false, reason: UNVERIFIABLE, detail: { message: 'Gateway returned no payment.' } };
  }

  // 1. The payment must belong to the order being confirmed. Without this, a
  //    valid signature for payment P against order A could be replayed to
  //    confirm order B (both belonging to the attacker) — the HMAC covers the
  //    pair, but nothing previously checked the pair against our own record.
  if (payment.order_id !== razorpayOrderId) {
    return {
      ok: false,
      reason: MISMATCH,
      detail: { message: 'Payment does not belong to this order.', gatewayOrderId: payment.order_id }
    };
  }

  // 2. Captured, not merely authorized. This is the money-loss case.
  if (payment.status !== 'captured') {
    return {
      ok: false,
      reason: NOT_CAPTURED,
      detail: { message: `Payment status is "${payment.status}", not captured.`, status: payment.status }
    };
  }

  // 3. Exact amount. Razorpay returns paise as a number; Number() guards
  //    against a string arriving from a future SDK change.
  if (Number(payment.amount) !== expected) {
    return {
      ok: false,
      reason: MISMATCH,
      detail: { message: 'Captured amount does not match the order total.', capturedPaise: Number(payment.amount), expectedPaise: expected }
    };
  }

  // 4. Currency. A mismatched currency with a matching numeric amount would be
  //    a catastrophic silent loss (₹1,000 settled as $1,000 or vice versa).
  if (String(payment.currency).toUpperCase() !== expectedCurrency.toUpperCase()) {
    return {
      ok: false,
      reason: MISMATCH,
      detail: { message: 'Currency mismatch.', capturedCurrency: payment.currency, expectedCurrency }
    };
  }

  return { ok: true, payment };
}

/**
 * Records a verification failure on the entity and in the audit log so a human
 * can review it. Deliberately does NOT change payment status — an order stuck
 * at `pending` with a review flag is recoverable; an order wrongly marked paid
 * is not.
 */
async function flagForReview(client, { entityType, entityId, reason, detail }) {
  await client.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
     VALUES (NULL, 'payment_verification_failed', $1, $2, $3)`,
    [entityType, entityId, JSON.stringify({ reason, ...detail })]
  );
  logger.error('PAYMENT VERIFICATION FAILED — manual review required', null, {
    entityType, entityId, reason, ...detail
  });
}

module.exports = {
  verifyCapturedPayment,
  flagForReview,
  REASONS: { MISMATCH, NOT_CAPTURED, UNVERIFIABLE }
};
