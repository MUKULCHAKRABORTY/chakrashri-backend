const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const razorpay = require('../config/razorpay');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { handleValidation, isUuid } = require('../middleware/validate');
const { restoreOrderStock } = require('../utils/stock');
const { timingSafeEqualHex } = require('../utils/crypto');
const { reserveStockAndCreateOrder } = require('../utils/orders');
const {
  sendOrderConfirmation, sendAdminNewOrder, sendPaymentUnderReview,
  sendAdminPaymentReview, sendPaymentFailed
} = require('../utils/mailer');
const { loadOrderForEmail, fireAndForget } = require('../utils/orderEmails');
const { verifyCapturedPayment, flagForReview, REASONS } = require('../utils/paymentVerification');
const { getSettings } = require('../utils/settings');
const { logger } = require('../utils/logger');

const router = express.Router();

// Checkout is expensive: it opens a transaction and takes row locks across the
// products in the cart. The global 200/15min budget is far too loose to stop
// someone spamming order creation to hold reserved stock hostage (the expiry
// sweep releases it, but only after 30 minutes). This is generous for a real
// shopper — nobody legitimately places 20 orders in 15 minutes — and tight
// enough to make denial-of-inventory impractical.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.CHECKOUT_RATE_LIMIT_MAX || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed by user, not IP: a family behind one NAT or a corporate office should
  // not share a checkout budget, and an authenticated user is the thing being
  // limited anyway. Falls back to IP if somehow unauthenticated.
  keyGenerator: (req) => (req.user && req.user.id) || req.ip,
  message: { error: 'Too many checkout attempts. Please wait a few minutes and try again.' }
});

/**
 * STEP 1 — Create an order server-side, for EITHER payment method.
 * The front end calls this single endpoint after building the cart,
 * choosing 'razorpay' or 'cod' via `paymentMethod` in the request body.
 *
 * IMPORTANT: this used to be two separate endpoints (/create-order always
 * hardcoded to Razorpay, and a second /create-cod-order for COD) — but the
 * front end only ever calls this one URL and passes `paymentMethod` in the
 * body to choose between them. That mismatch meant selecting Cash on
 * Delivery on the live site still silently went through the Razorpay path,
 * since this endpoint never looked at `paymentMethod` at all. Consolidated
 * into one endpoint that actually branches on it, matching what the front
 * end sends.
 */
router.post('/create-order', requireAuth, checkoutLimiter, asyncHandler(async (req, res) => {
  const { items, shippingAddressId, paymentMethod, couponCode } = req.body; // items: [{ productId, variantId?, quantity }]
  const method = paymentMethod === 'cod' ? 'cod' : 'razorpay';

  // A shipping address is mandatory for a physical-goods order — without
  // one, a fully paid order has nowhere to be shipped. /api/addresses now
  // exists specifically so the front end can create one before reaching here.
  // The UUID shape is checked here so a malformed value returns a clean 400
  // rather than reaching Postgres and surfacing as a 500 (HYG-02).
  if (!shippingAddressId || typeof shippingAddressId !== 'string' || !isUuid(shippingAddressId)) {
    return res.status(400).json({ error: 'A valid shipping address is required to place an order.' });
  }

  const settings = await getSettings();

  // BIZ-07 — COD gates that need the user record, checked before any stock is
  // reserved so a rejected COD order never briefly holds inventory.
  if (method === 'cod') {
    if (!settings.cod_enabled) {
      return res.status(400).json({ error: 'Cash on Delivery is currently unavailable. Please pay online.' });
    }
    const { rows: userRows } = await db.query(
      'SELECT cod_blocked, email_verified, phone_verified FROM users WHERE id = $1',
      [req.user.id]
    );
    const account = userRows[0] || {};
    if (account.cod_blocked) {
      // Deliberately does not say "you have been blocked for refusing
      // deliveries" — that invites an argument at the checkout page. It says
      // what to do instead.
      return res.status(403).json({ error: 'Cash on Delivery is not available on this account. Please pay online to place this order.' });
    }
    if (settings.cod_requires_verified_contact && !account.email_verified && !account.phone_verified) {
      return res.status(403).json({
        error: 'Please verify your email or phone number before using Cash on Delivery.',
        code: 'VERIFICATION_REQUIRED'
      });
    }
  }

  let orderId, orderNumber, totalPaise, discountPaise, appliedCouponCode;
  try {
    const result = await reserveStockAndCreateOrder({
      userId: req.user.id,
      items,
      shippingAddressId,
      paymentMethod: method,
      initialStatus: method === 'cod' ? 'processing' : 'pending', // COD has nothing to wait for; Razorpay awaits payment
      couponCode: couponCode || null,
      settings
    });
    orderId = result.id;
    orderNumber = result.number;
    totalPaise = result.total;
    discountPaise = result.discountPaise;
    appliedCouponCode = result.couponCode;
  } catch (err) {
    // A thrown error carrying an explicit `status` is a business rule the
    // customer needs to read (out of stock, coupon invalid, address not
    // theirs). Anything else is a real fault: log it with the request id and
    // give the customer a generic message rather than leaking internals.
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error('Order creation failed', err, { userId: req.user.id });
    return res.status(500).json({ error: 'Could not create your order. Please try again.' });
  }

  // ---------- Cash on Delivery: nothing more to do, order is placed ----------
  if (method === 'cod') {
    // loadOrderForEmail rather than a bespoke four-column query: the templates
    // now show a real money breakdown, and a query that omits subtotal_paise
    // renders it as ₹NaN in the customer's receipt without erroring anywhere.
    const forEmail = await loadOrderForEmail(orderId);
    if (forEmail) {
      fireAndForget(sendOrderConfirmation(forEmail.order, forEmail.items), { orderId, template: 'order_confirmation' });
      fireAndForget(sendAdminNewOrder(forEmail.order, forEmail.items), { orderId, template: 'admin_new_order' });
    }
    return res.json({
      requiresRazorpay: false,
      orderId,
      orderNumber,
      totalPaise,
      discountPaise,
      couponCode: appliedCouponCode,
      paymentMethod: 'cod'
    });
  }

  // ---------- Razorpay: create the gateway order and hand back checkout details ----------
  try {
    const razorpayOrder = await razorpay.orders.create({
      // Number() is belt-and-braces: totalPaise is computed in JS so it is
      // already a number, but sending Razorpay a string `amount` is exactly
      // the class of bug DATA-02 describes and it must never regress here.
      amount: Number(totalPaise),
      currency: 'INR',
      receipt: orderNumber,
      notes: { internalOrderId: orderId }
    });
    await db.query('UPDATE orders SET razorpay_order_id = $1 WHERE id = $2', [razorpayOrder.id, orderId]);
    return res.json({
      requiresRazorpay: true,
      orderId,
      orderNumber,
      razorpayOrderId: razorpayOrder.id,
      amountPaise: Number(totalPaise),
      discountPaise,
      couponCode: appliedCouponCode,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    logger.error('Razorpay order creation failed', err, { orderId, orderNumber });
    // OPS-01: this compensating call is itself a transaction and can throw
    // (deadlock, connection loss). It used to sit in a catch block with no
    // outer try, so a gateway outage — exactly when the system is already
    // degraded — escalated into an unhandled rejection and a full process
    // crash. Now the worst case is one order left holding stock until the
    // expiry sweep releases it 30 minutes later.
    try {
      await restoreOrderStock(orderId, 'cancelled', 'razorpay_order_creation_failed');
    } catch (restoreErr) {
      logger.error('Could not release stock after gateway failure — expiry sweep will recover it', restoreErr, { orderId });
    }
    return res.status(502).json({ error: 'Could not connect to the payment gateway. Please try again.' });
  }
}));

/**
 * STEP 2 — Confirm a payment after Razorpay Checkout succeeds client-side.
 *
 * TWO INDEPENDENT CHECKS, both required:
 *
 *  1. SIGNATURE — HMAC-SHA256 over `order_id|payment_id` proves this pair was
 *     genuinely produced by Razorpay for this merchant. Compared in constant
 *     time so the comparison itself leaks nothing.
 *
 *  2. SETTLEMENT (PAY-01) — the signature says nothing about whether money
 *     actually moved. An AUTHORIZED payment is only a hold on the card; if
 *     auto-capture is off or a capture later fails, the signature is still
 *     perfectly valid. The previous code stopped after check 1, so an
 *     uncaptured payment marked the order paid and the goods shipped against
 *     money that never arrived. utils/paymentVerification.js asks Razorpay
 *     directly and requires captured status, exact amount, matching currency
 *     and matching order.
 *
 * The second check was already being performed by scripts/reconcile-payments.js
 * — the safety net was stricter than the live path it exists to back up.
 */
router.post('/verify', requireAuth, asyncHandler(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields.' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (!timingSafeEqualHex(expectedSignature, razorpay_signature)) {
    logger.warn('Payment signature mismatch', { userId: req.user.id, razorpay_order_id });
    return res.status(400).json({ error: 'Payment verification failed. Signature mismatch.' });
  }

  // Ownership check: this order must belong to the caller. Stock was already
  // reserved at /create-order time, so this step only flips status — it must
  // NOT decrement stock again.
  const { rows: existing } = await db.query(
    'SELECT id, user_id, status, total_paise, order_number FROM orders WHERE razorpay_order_id = $1',
    [razorpay_order_id]
  );
  if (!existing.length) return res.status(404).json({ error: 'Order not found.' });
  const order = existing[0];
  if (order.user_id !== req.user.id) {
    logger.warn('Cross-account payment confirmation attempt', { userId: req.user.id, orderId: order.id });
    return res.status(403).json({ error: 'This order does not belong to your account.' });
  }

  // Idempotent success: a double-click, or the webhook having already landed.
  if (order.status === 'paid' || order.status === 'processing' || order.status === 'shipped' || order.status === 'delivered') {
    return res.json({ success: true, orderNumber: order.order_number });
  }
  if (order.status !== 'pending') {
    return res.status(409).json({ error: `Order is in state "${order.status}" and cannot be confirmed.` });
  }

  const verification = await verifyCapturedPayment({
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    expectedAmountPaise: Number(order.total_paise),
    currency: 'INR'
  });

  if (!verification.ok) {
    if (verification.reason === REASONS.UNVERIFIABLE) {
      // We could not reach Razorpay. The customer's payment may well be fine,
      // so do NOT tell them it failed and do NOT mark the order paid. Leave it
      // pending: the webhook or the reconciler will resolve it, both of which
      // apply the same checks.
      logger.warn('Payment verification could not reach the gateway; leaving order pending', {
        orderId: order.id, ...verification.detail
      });
      return res.status(202).json({
        pending: true,
        orderNumber: order.order_number,
        message: 'We are confirming your payment. Your order will update shortly — you will receive an email once it is confirmed.'
      });
    }

    // A real mismatch: captured amount, currency or capture status disagrees.
    // Park it for a human rather than either accepting it or telling the
    // customer their genuine payment failed.
    await db.withTransaction(async (client) => {
      await client.query(
        `UPDATE orders SET status = 'payment_review', payment_review_reason = $2,
                           razorpay_payment_id = $3, updated_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [order.id, `${verification.reason}: ${verification.detail.message}`, razorpay_payment_id]
      );
      await flagForReview(client, {
        entityType: 'order', entityId: order.id,
        reason: verification.reason, detail: verification.detail
      });
    });
    // Tell BOTH sides. The customer must not be left watching an order that
    // says nothing, and this state holds stock and possibly their money — an
    // admin who never learns of it never clears it, because nothing else will.
    const reviewEmail = await loadOrderForEmail(order.id);
    if (reviewEmail) {
      fireAndForget(sendPaymentUnderReview(reviewEmail.order), { orderId: order.id, template: 'order_payment_review' });
      fireAndForget(sendAdminPaymentReview(reviewEmail.order, `${verification.reason}: ${verification.detail.message}`),
        { orderId: order.id, template: 'admin_payment_review' });
    }

    return res.status(202).json({
      pending: true,
      orderNumber: order.order_number,
      message: 'We have received your payment and are verifying it. Our team will confirm your order shortly.'
    });
  }

  const { rows } = await db.query(
    `UPDATE orders
     SET status = 'paid', razorpay_payment_id = $1, razorpay_signature = $2, updated_at = now()
     WHERE razorpay_order_id = $3 AND status = 'pending'
     RETURNING id, order_number`,
    [razorpay_payment_id, razorpay_signature, razorpay_order_id]
  );
  if (!rows.length) {
    // Lost a race with the webhook between the status read above and this
    // write. Whichever won, the outcome is the same for the customer.
    const { rows: current } = await db.query('SELECT status, order_number FROM orders WHERE razorpay_order_id = $1', [razorpay_order_id]);
    if (current[0] && ['paid', 'processing', 'shipped', 'delivered'].includes(current[0].status)) {
      return res.json({ success: true, orderNumber: current[0].order_number });
    }
    return res.status(409).json({ error: `Order is in state "${current[0]?.status}" and cannot be confirmed.` });
  }

  // Send confirmation email — failure here must never fail the response,
  // since the payment itself already succeeded.
  // The dedupe key inside sendOrderConfirmation is what makes this safe to
  // reach from here AND from the webhook AND from the reconciler: all three
  // legitimately confirm the same order, and the customer must get one email.
  const forEmail = await loadOrderForEmail(rows[0].id);
  if (forEmail) {
    fireAndForget(sendOrderConfirmation(forEmail.order, forEmail.items), { orderId: rows[0].id, template: 'order_confirmation' });
    fireAndForget(sendAdminNewOrder(forEmail.order, forEmail.items), { orderId: rows[0].id, template: 'admin_new_order' });
  }

  return res.json({ success: true, orderNumber: rows[0].order_number });
}));

/**
 * STEP 3 — Webhook (server-to-server, independent of the browser).
 * Configure this URL in the Razorpay Dashboard > Webhooks. This is the
 * authoritative source of truth for payment status — it fires even if the
 * customer closes their browser mid-checkout, which /verify alone cannot
 * catch. Needs the raw request body, so it's mounted with express.raw()
 * in server.js rather than the global JSON parser.
 *
 * Always answers 200 once the signature is valid and the event has been
 * recorded. Razorpay retries on any non-2xx, so returning 500 for a
 * downstream problem turns one transient database blip into an indefinite
 * retry storm against the same failing code path.
 */
router.post('/webhook', asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if (!timingSafeEqualHex(expected, signature)) {
    logger.warn('Webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    // A body that passed HMAC but is not JSON cannot be fixed by retrying.
    logger.error('Webhook body passed signature check but is not valid JSON', err);
    return res.status(400).json({ error: 'Malformed webhook payload.' });
  }

  const eventId = req.headers['x-razorpay-event-id'] || null;

  try {
    await handleWebhookEvent(event, eventId);
  } catch (err) {
    logger.error('Webhook processing failed', err, { eventId, eventType: event.event });
    // 500 asks Razorpay to retry, which is right for a transient failure and
    // safe because every handler below is idempotent.
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }

  return res.status(200).json({ received: true });
}));

/**
 * Webhook event handling, split out so it is testable without an HTTP layer.
 *
 * Idempotency: every UPDATE is guarded by the state it expects to transition
 * FROM, so a redelivered event is a no-op rather than a double-apply. Razorpay
 * redelivers on any non-2xx and occasionally delivers the same event twice
 * even on success, so this is not optional.
 */
async function handleWebhookEvent(event, eventId) {
  const entity = event.payload?.payment?.entity || {};
  const notes = entity.notes || {};
  const isBookingPayment = Boolean(notes.bookingId && notes.bookingType);
  const bookingTable = notes.bookingType === 'puja' ? 'puja_bookings'
    : notes.bookingType === 'astrology' ? 'astrology_bookings'
      : null;

  if (event.event === 'payment.captured') {
    const rzpOrderId = entity.order_id;
    const capturedPaise = Number(entity.amount);
    const currency = String(entity.currency || 'INR').toUpperCase();

    if (isBookingPayment && bookingTable) {
      // PAY-01 for bookings: the webhook payload already carries the captured
      // amount, so no extra gateway round-trip is needed — compare it against
      // what the booking is actually worth before marking it paid.
      const { rows } = await db.query(
        `SELECT id, amount_paise, payment_status FROM ${bookingTable} WHERE razorpay_order_id = $1`,
        [rzpOrderId]
      );
      if (!rows.length) {
        logger.warn('Webhook for unknown booking', { rzpOrderId, bookingTable });
        return;
      }
      const booking = rows[0];
      if (booking.payment_status !== 'unpaid') return; // already settled — idempotent no-op

      if (capturedPaise !== Number(booking.amount_paise) || currency !== 'INR') {
        await db.withTransaction(async (client) => {
          await client.query(
            `UPDATE ${bookingTable} SET payment_status = 'payment_review', razorpay_payment_id = $2, updated_at = now()
             WHERE id = $1 AND payment_status = 'unpaid'`,
            [booking.id, entity.id]
          );
          await flagForReview(client, {
            entityType: `${notes.bookingType}_booking`, entityId: booking.id,
            reason: REASONS.MISMATCH,
            detail: { capturedPaise, expectedPaise: Number(booking.amount_paise), currency, eventId }
          });
        });
        return;
      }

      await db.query(
        `UPDATE ${bookingTable} SET payment_status = 'paid', razorpay_payment_id = $2, updated_at = now()
         WHERE razorpay_order_id = $1 AND payment_status = 'unpaid'`,
        [rzpOrderId, entity.id]
      );
      return;
    }

    const { rows } = await db.query(
      'SELECT id, total_paise, status FROM orders WHERE razorpay_order_id = $1',
      [rzpOrderId]
    );
    if (!rows.length) {
      logger.warn('Webhook for unknown order', { rzpOrderId });
      return;
    }
    const order = rows[0];
    if (order.status !== 'pending') return; // already settled — idempotent no-op

    if (capturedPaise !== Number(order.total_paise) || currency !== 'INR') {
      await db.withTransaction(async (client) => {
        await client.query(
          `UPDATE orders SET status = 'payment_review', payment_review_reason = $2,
                             razorpay_payment_id = $3, updated_at = now()
           WHERE id = $1 AND status = 'pending'`,
          [order.id, `amount_or_currency_mismatch: captured ${capturedPaise} ${currency}, expected ${order.total_paise} INR`, entity.id]
        );
        await flagForReview(client, {
          entityType: 'order', entityId: order.id,
          reason: REASONS.MISMATCH,
          detail: { capturedPaise, expectedPaise: Number(order.total_paise), currency, eventId }
        });
      });
      const reviewEmail = await loadOrderForEmail(order.id);
      if (reviewEmail) {
        fireAndForget(sendPaymentUnderReview(reviewEmail.order), { orderId: order.id, template: 'order_payment_review' });
        fireAndForget(sendAdminPaymentReview(reviewEmail.order,
          `amount_or_currency_mismatch: captured ${capturedPaise} ${currency}, expected ${order.total_paise} INR`),
        { orderId: order.id, template: 'admin_payment_review' });
      }
      return;
    }

    const { rowCount: confirmed } = await db.query(
      `UPDATE orders SET status = 'paid', razorpay_payment_id = $2, updated_at = now()
       WHERE razorpay_order_id = $1 AND status = 'pending'`,
      [rzpOrderId, entity.id]
    );

    // THE GAP THIS CLOSES: this path exists precisely for the customer who paid
    // and then closed the tab, so the browser never called /verify. Their order
    // was marked paid here and no confirmation email was ever sent — they paid
    // and heard nothing. Sending is safe because the confirmation carries a
    // dedupe key on the order, so the browser path and this one cannot both
    // mail the same customer.
    //
    // rowCount guards the OTHER direction: a webhook retry for an order already
    // moved on from 'pending' updates nothing, and must not then behave as if
    // it had just been paid.
    if (confirmed > 0) {
      const forEmail = await loadOrderForEmail(order.id);
      if (forEmail) {
        fireAndForget(sendOrderConfirmation(forEmail.order, forEmail.items), { orderId: order.id, template: 'order_confirmation' });
        fireAndForget(sendAdminNewOrder(forEmail.order, forEmail.items), { orderId: order.id, template: 'admin_new_order' });
      }
    }
    return;
  }

  if (event.event === 'payment.failed') {
    const rzpOrderId = entity.order_id;
    if (isBookingPayment && bookingTable) {
      // Bookings reserve a slot rather than stock; releasing it is handled by
      // the same helper the expiry sweep uses, so the two cannot disagree.
      const { rows } = await db.query(
        `SELECT id FROM ${bookingTable} WHERE razorpay_order_id = $1 AND payment_status = 'unpaid'`,
        [rzpOrderId]
      );
      if (rows.length) {
        const { releaseBookingSlot } = require('../utils/bookingSlots');
        await releaseBookingSlot(bookingTable, rows[0].id, 'failed', 'razorpay_payment_failed_webhook');
      }
      return;
    }
    const { rows } = await db.query('SELECT id FROM orders WHERE razorpay_order_id = $1', [rzpOrderId]);
    if (rows.length) {
      // Restores stock reserved at order-creation time AND sets status to
      // 'payment_failed' in one atomic, idempotent step.
      await restoreOrderStock(rows[0].id, 'payment_failed', 'razorpay_payment_failed_webhook');

      // A failed payment is the moment a customer decides whether to try again
      // or give up, and silence reliably produces the second outcome. The email
      // says plainly that nothing was charged, because the most common support
      // ticket after a failure is "have you taken my money?".
      const forEmail = await loadOrderForEmail(rows[0].id);
      if (forEmail) {
        fireAndForget(sendPaymentFailed(forEmail.order), { orderId: rows[0].id, template: 'order_payment_failed' });
      }
    }
    return;
  }

  // Refunds initiated from the Razorpay dashboard rather than the admin panel
  // used to be invisible to this system: the money went back and the order
  // stayed 'paid' forever. Recording them keeps the ledger honest whichever
  // side started the refund.
  if (event.event === 'refund.processed' || event.event === 'refund.created') {
    const refundEntity = event.payload?.refund?.entity;
    if (!refundEntity) return;
    const { recordExternalRefund } = require('../utils/refunds');
    await recordExternalRefund(refundEntity, eventId);
    return;
  }

  logger.debug('Unhandled webhook event', { eventType: event.event, eventId });
}

module.exports = router;
module.exports.handleWebhookEvent = handleWebhookEvent;
