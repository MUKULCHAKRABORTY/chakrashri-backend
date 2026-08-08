const express = require('express');
const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { restoreOrderStock } = require('../utils/stock');
const { timingSafeEqualHex } = require('../utils/crypto');
const { reserveStockAndCreateOrder } = require('../utils/orders');
const { sendOrderConfirmation } = require('../utils/mailer');

const router = express.Router();

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
router.post('/create-order', requireAuth, async (req, res) => {
  const { items, shippingAddressId, paymentMethod } = req.body; // items: [{ productId, quantity }]
  const method = paymentMethod === 'cod' ? 'cod' : 'razorpay';

  // A shipping address is mandatory for a physical-goods order — without
  // one, a fully paid order has nowhere to be shipped. /api/addresses now
  // exists specifically so the front end can create one before reaching here.
  if (!shippingAddressId || typeof shippingAddressId !== 'string') {
    return res.status(400).json({ error: 'A shipping address is required to place an order.' });
  }

  let orderId, orderNumber, totalPaise;
  try {
    const result = await reserveStockAndCreateOrder({
      userId: req.user.id,
      items,
      shippingAddressId,
      paymentMethod: method,
      initialStatus: method === 'cod' ? 'processing' : 'pending' // COD has nothing to wait for; Razorpay awaits payment
    });
    orderId = result.id;
    orderNumber = result.number;
    totalPaise = result.total;
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'Could not create order.' });
  }

  // ---------- Cash on Delivery: nothing more to do, order is placed ----------
  if (method === 'cod') {
    try {
      const { rows: fullOrder } = await db.query(
        `SELECT o.order_number, o.total_paise, u.email AS customer_email, u.name AS customer_name
         FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
        [orderId]
      );
      const { rows: orderItems } = await db.query(
        'SELECT product_name_snapshot, quantity, line_total_paise FROM order_items WHERE order_id = $1',
        [orderId]
      );
      if (fullOrder.length) sendOrderConfirmation(fullOrder[0], orderItems).catch(() => {});
    } catch {
      // Confirmation email failure must never fail an already-placed COD order.
    }
    return res.json({
      requiresRazorpay: false,
      orderId,
      orderNumber,
      totalPaise,
      paymentMethod: 'cod'
    });
  }

  // ---------- Razorpay: create the gateway order and hand back checkout details ----------
  try {
    const razorpayOrder = await razorpay.orders.create({
      amount: totalPaise,
      currency: 'INR',
      receipt: orderNumber,
      notes: { internalOrderId: orderId }
    });
    await db.query('UPDATE orders SET razorpay_order_id = $1 WHERE id = $2', [razorpayOrder.id, orderId]);
    res.json({
      requiresRazorpay: true,
      orderId,
      orderNumber,
      razorpayOrderId: razorpayOrder.id,
      amountPaise: totalPaise,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    await restoreOrderStock(orderId, 'cancelled', 'razorpay_order_creation_failed');
    res.status(502).json({ error: 'Could not connect to the payment gateway. Please try again.' });
  }
});

/**
 * STEP 2 — Verify payment signature after Razorpay Checkout succeeds
 * client-side. This is the step the current demo skips entirely — without
 * it, anyone could call your "mark as paid" endpoint directly and get a
 * free order. HMAC-SHA256 verification proves the payment is genuine.
 */
router.post('/verify', requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields.' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (!timingSafeEqualHex(expectedSignature, razorpay_signature)) {
    return res.status(400).json({ error: 'Payment verification failed. Signature mismatch.' });
  }

  try {
    // Ownership check: this order must belong to the caller. Stock was
    // already reserved at /create-order time (see comments there), so this
    // step only needs to flip status — it must NOT decrement stock again.
    const { rows: existing } = await db.query('SELECT id, user_id FROM orders WHERE razorpay_order_id = $1', [
      razorpay_order_id
    ]);
    if (!existing.length) return res.status(404).json({ error: 'Order not found.' });
    if (existing[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'This order does not belong to your account.' });
    }

    const { rows } = await db.query(
      `UPDATE orders
       SET status = 'paid', razorpay_payment_id = $1, razorpay_signature = $2, updated_at = now()
       WHERE razorpay_order_id = $3 AND status = 'pending'
       RETURNING id, order_number`,
      [razorpay_payment_id, razorpay_signature, razorpay_order_id]
    );
    if (!rows.length) {
      // Order existed but wasn't in 'pending' state — most likely the webhook
      // already marked it paid (or failed/cancelled). Treat as idempotent success
      // if it's already paid, otherwise surface the real state.
      const { rows: current } = await db.query('SELECT status, order_number FROM orders WHERE razorpay_order_id = $1', [razorpay_order_id]);
      if (current[0]?.status === 'paid') return res.json({ success: true, orderNumber: current[0].order_number });
      return res.status(409).json({ error: `Order is in state "${current[0]?.status}" and cannot be confirmed.` });
    }

    // Send confirmation email — failure here must never fail the response,
    // since the payment itself already succeeded; sendOrderConfirmation
    // fails safe internally and just logs if SMTP isn't configured/down.
    const { rows: fullOrder } = await db.query(
      `SELECT o.order_number, o.total_paise, u.email AS customer_email, u.name AS customer_name
       FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
      [rows[0].id]
    );
    const { rows: orderItems } = await db.query(
      'SELECT product_name_snapshot, quantity, line_total_paise FROM order_items WHERE order_id = $1',
      [rows[0].id]
    );
    if (fullOrder.length) sendOrderConfirmation(fullOrder[0], orderItems).catch(() => {});

    res.json({ success: true, orderNumber: rows[0].order_number });
  } catch (err) {
    res.status(500).json({ error: 'Could not finalize order.' });
  }
});

/**
 * STEP 3 — Webhook (server-to-server, independent of the browser).
 * Configure this URL in the Razorpay Dashboard > Webhooks. This is the
 * authoritative source of truth for payment status — it fires even if the
 * customer closes their browser mid-checkout, which /verify alone cannot
 * catch. Needs the raw request body, so it's mounted with express.raw()
 * in server.js rather than the global JSON parser.
 */
router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(req.body) // raw Buffer
    .digest('hex');

  if (!timingSafeEqualHex(expected, signature)) {
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }

  try {
    const event = JSON.parse(req.body.toString());
    const notes = event.payload?.payment?.entity?.notes || {};
    const isBookingPayment = notes.bookingId && notes.bookingType;
    const bookingTable = notes.bookingType === 'puja' ? 'puja_bookings' : notes.bookingType === 'astrology' ? 'astrology_bookings' : null;

    if (event.event === 'payment.captured') {
      const rzpOrderId = event.payload.payment.entity.order_id;
      if (isBookingPayment && bookingTable) {
        await db.query(
          `UPDATE ${bookingTable} SET payment_status = 'paid', razorpay_payment_id = $2, updated_at = now()
           WHERE razorpay_order_id = $1 AND payment_status = 'unpaid'`,
          [rzpOrderId, event.payload.payment.entity.id]
        );
      } else {
        await db.query(
          `UPDATE orders SET status = 'paid', razorpay_payment_id = $2, updated_at = now()
           WHERE razorpay_order_id = $1 AND status = 'pending'`,
          [rzpOrderId, event.payload.payment.entity.id]
        );
      }
    }
    if (event.event === 'payment.failed') {
      const rzpOrderId = event.payload.payment.entity.order_id;
      if (isBookingPayment && bookingTable) {
        // Bookings don't reserve stock, so there's nothing to restore — just
        // mark the payment failed so it doesn't sit as "unpaid" indefinitely.
        await db.query(
          `UPDATE ${bookingTable} SET payment_status = 'failed', updated_at = now()
           WHERE razorpay_order_id = $1 AND payment_status = 'unpaid'`,
          [rzpOrderId]
        );
      } else {
        const { rows } = await db.query('SELECT id FROM orders WHERE razorpay_order_id = $1', [rzpOrderId]);
        if (rows.length) {
          // Restores stock reserved at order-creation time AND sets status to
          // 'payment_failed' in one atomic, idempotent step.
          await restoreOrderStock(rows[0].id, 'payment_failed', 'razorpay_payment_failed_webhook');
        }
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

module.exports = router;
