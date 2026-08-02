const express = require('express');
const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { restoreOrderStock } = require('../utils/stock');

const router = express.Router();

/**
 * STEP 1 — Create a Razorpay order server-side.
 * The front end calls this AFTER building the cart, gets back an order_id,
 * and opens Razorpay Checkout with it. Amount is always recalculated here
 * from the database — never trust a total sent by the client.
 */
router.post('/create-order', requireAuth, async (req, res) => {
  const { items, shippingAddressId } = req.body; // items: [{ productId, quantity }]
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Cart is empty.' });
  }
  for (const item of items) {
    if (
      !item ||
      typeof item.productId !== 'string' ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 50
    ) {
      return res.status(400).json({ error: 'Cart contains an invalid item or quantity.' });
    }
  }

  let orderId, orderNumber, totalPaise;
  try {
    const result = await db.withTransaction(async (client) => {
      const productIds = items.map((i) => i.productId);
      const { rows: products } = await client.query(
        `SELECT id, name, price_paise, stock_qty, gst_rate FROM products
         WHERE id = ANY($1) AND is_active = true FOR UPDATE`,
        [productIds]
      );

      let subtotalPaise = 0;
      const orderItems = items.map((item) => {
        const product = products.find((p) => p.id === item.productId);
        if (!product) throw Object.assign(new Error('One of the items in your cart is no longer available.'), { status: 400 });
        if (product.stock_qty < item.quantity) {
          throw Object.assign(new Error(`"${product.name}" only has ${product.stock_qty} left in stock.`), { status: 409 });
        }
        const lineTotal = product.price_paise * item.quantity;
        subtotalPaise += lineTotal;
        return {
          productId: product.id,
          name: product.name,
          unitPricePaise: product.price_paise,
          quantity: item.quantity,
          lineTotalPaise: lineTotal,
          gstRate: product.gst_rate
        };
      });

      for (const item of orderItems) {
        await client.query('UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2', [
          item.quantity,
          item.productId
        ]);
      }

      const shippingPaise = subtotalPaise >= 99900 ? 0 : 7900;
      const gstPaise = Math.round(orderItems.reduce((sum, i) => sum + (i.lineTotalPaise * i.gstRate) / 100, 0));
      const total = subtotalPaise + shippingPaise + gstPaise;
      const number = 'CHK-' + new Date().getFullYear() + '-' + Date.now().toString().slice(-6);

      const { rows: orderRows } = await client.query(
        `INSERT INTO orders
          (order_number, user_id, status, subtotal_paise, shipping_paise, gst_paise, total_paise,
           shipping_address_id, payment_method)
         VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,'razorpay')
         RETURNING id`,
        [number, req.user.id, subtotalPaise, shippingPaise, gstPaise, total, shippingAddressId || null]
      );
      const id = orderRows[0].id;

      for (const item of orderItems) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name_snapshot, unit_price_paise, quantity, line_total_paise)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, item.productId, item.name, item.unitPricePaise, item.quantity, item.lineTotalPaise]
        );
      }

      return { id, number, total };
    });
    orderId = result.id;
    orderNumber = result.number;
    totalPaise = result.total;
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'Could not create order.' });
  }

  try {
    const razorpayOrder = await razorpay.orders.create({
      amount: totalPaise,
      currency: 'INR',
      receipt: orderNumber,
      notes: { internalOrderId: orderId }
    });
    await db.query('UPDATE orders SET razorpay_order_id = $1 WHERE id = $2', [razorpayOrder.id, orderId]);
    res.json({
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

  if (expectedSignature !== razorpay_signature) {
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

    // TODO: trigger order confirmation email/SMS (utils/mailer.js, utils/sms.js)
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

  if (signature !== expected) {
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }

  const event = JSON.parse(req.body.toString());
  try {
    if (event.event === 'payment.captured') {
      const rzpOrderId = event.payload.payment.entity.order_id;
      await db.query(
        `UPDATE orders SET status = 'paid', razorpay_payment_id = $2, updated_at = now()
         WHERE razorpay_order_id = $1 AND status = 'pending'`,
        [rzpOrderId, event.payload.payment.entity.id]
      );
    }
    if (event.event === 'payment.failed') {
      const rzpOrderId = event.payload.payment.entity.order_id;
      const { rows } = await db.query('SELECT id FROM orders WHERE razorpay_order_id = $1', [rzpOrderId]);
      if (rows.length) {
        // Restores stock reserved at order-creation time AND sets status to
        // 'payment_failed' in one atomic, idempotent step.
        await restoreOrderStock(rows[0].id, 'payment_failed', 'razorpay_payment_failed_webhook');
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

module.exports = router;
