const express = require('express');
const { body } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireRole, requireCapability, CAPABILITIES: C } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { normaliseTerm } = require('../utils/text');
const { REVENUE_STATUS_SQL } = require('../utils/orderStatus');
const { validateUuidParam, handleValidation } = require('../middleware/validate');
const { restoreOrderStock, restoreOrderStockInTransaction, STOCK_RESTORED_STATUSES } = require('../utils/stock');
const { issueRefund } = require('../utils/refunds');
const {
  sendOrderStatusUpdate, sendRefundInitiated, sendAdminRefundIssued, sendReviewApproved,
  sendContactReply, sendNewsletter
} = require('../utils/mailer');
// The unsubscribe link a marketing email is required to carry. Built per
// recipient by the engine, because it is signed with that address.
const { unsubscribeUrlFor } = require('../utils/email/engine');
const { loadOrderForEmail, fireAndForget } = require('../utils/orderEmails');
const { getSettings, setSetting, DEFAULTS: SETTING_DEFAULTS } = require('../utils/settings');
const { recomputeProductRating } = require('../utils/reviews');
const { capabilitiesForRole } = require('../middleware/capabilities');
const { logger } = require('../utils/logger');

const router = express.Router();

// AUTH-02 — every admin endpoint used to be gated by this ONE line:
//   router.use(requireAuth, requireRole('admin','staff'))
// which handed `staff` the authority to issue real Razorpay refunds, export the
// full customer list with emails and phone numbers, and read the audit log
// recording its own actions. This still admits both roles to the router — staff
// genuinely need most of it to run the shop — but every route below now names
// the capability it needs, and the role→capability map in
// middleware/capabilities.js decides. See that file for where the line is drawn
// and why.
router.use(requireAuth, requireRole('admin', 'staff'));

// HYG-02 — a non-UUID :id used to reach Postgres and surface as a 500 rather
// than a 400. One line, applied to every route in this file.
router.param('id', validateUuidParam('id'));

// The admin UI hides controls the signed-in user cannot use; without this it
// would have to hardcode the role→permission map in JavaScript, where it would
// immediately drift from the server's.
router.get('/me/capabilities', asyncHandler(async (req, res) => {
  res.json({ role: req.user.role, capabilities: capabilitiesForRole(req.user.role) });
}));

// ---------- Dashboard overview stats ----------
router.get('/overview', requireCapability(C.ANALYTICS_READ), asyncHandler(async (req, res) => {
  const [products, orders, revenue, pujaBookings, needsReview] = await Promise.all([
    db.query('SELECT COUNT(*) FROM products WHERE is_active = true'),
    db.query("SELECT COUNT(*) FROM orders WHERE status NOT IN ('payment_failed')"),
    db.query(`SELECT COALESCE(SUM(total_paise),0) AS total FROM orders WHERE status IN ${REVENUE_STATUS_SQL}`),
    db.query("SELECT COUNT(*) FROM puja_bookings WHERE status = 'requested'"),
    // PAY-01 surfaces mismatched payments as 'payment_review'. A state nobody
    // can see is a state nobody resolves, so it gets a dashboard number.
    db.query("SELECT COUNT(*) FROM orders WHERE status = 'payment_review'")
  ]);
  res.json({
    activeProducts: parseInt(products.rows[0].count, 10),
    totalOrders: parseInt(orders.rows[0].count, 10),
    totalRevenuePaise: parseInt(revenue.rows[0].total, 10),
    pendingPujaBookings: parseInt(pujaBookings.rows[0].count, 10),
    ordersNeedingPaymentReview: parseInt(needsReview.rows[0].count, 10)
  });
}));

// ---------- Orders (real, paginated, with items) ----------
router.get('/orders', requireCapability(C.ORDERS_READ), asyncHandler(async (req, res) => {
  // Parsed and clamped explicitly, same reasoning as products.routes.js —
  // req.query values are strings, and an unclamped limit is a cheap DoS vector.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE o.status = $${params.length}`;
  }
  params.push(limit, offset);

  // The list previously returned `o.*`, which includes razorpay_signature and
  // the raw address snapshot on every row of every page. Enumerating the
  // columns keeps the payload to what the table actually renders.
  const result = await db.query(
    `SELECT o.id, o.order_number, o.status, o.total_paise, o.subtotal_paise, o.discount_paise,
            o.shipping_paise, o.gst_paise, o.payment_method, o.coupon_code,
            o.razorpay_order_id, o.razorpay_payment_id, o.refund_id, o.refunded_amount_paise,
            o.tracking_number, o.courier_name, o.payment_review_reason,
            o.created_at, o.updated_at,
            u.name AS customer_name, u.email AS customer_email,
            COUNT(*) OVER() AS total_count
     FROM orders o LEFT JOIN users u ON u.id = o.user_id
     ${where}
     ORDER BY o.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  // The list had no total count, so the admin UI could not render a real pager
  // — it could only offer "next" and find out afterwards whether there was one.
  const totalCount = result.rows.length ? Number(result.rows[0].total_count) : 0;
  res.json({
    orders: result.rows.map(({ total_count, ...row }) => row),
    pagination: { page, limit, totalCount, totalPages: Math.max(1, Math.ceil(totalCount / limit)) }
  });
}));

// ---------- Single order detail, with line items ----------
router.get('/orders/:id', requireCapability(C.ORDERS_READ), asyncHandler(async (req, res) => {
  const { rows: orderRows } = await db.query(
    `SELECT o.*, u.name AS customer_name, u.email AS customer_email,
            a.full_name AS ship_name, a.phone AS ship_phone, a.email AS ship_email, a.line1 AS ship_line1,
            a.line2 AS ship_line2, a.city AS ship_city, a.state AS ship_state, a.pincode AS ship_pincode,
            a.country AS ship_country
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     LEFT JOIN addresses a ON a.id = o.shipping_address_id
     WHERE o.id = $1`,
    [req.params.id]
  );
  if (!orderRows.length) return res.status(404).json({ error: 'Order not found.' });

  const order = orderRows[0];

  // DATA-01 — ship to the SNAPSHOT, not the live address row. The joined
  // columns above are kept only so an admin can see whether the customer's
  // current address has since changed; the ship_* fields the warehouse acts on
  // come from what was frozen at purchase time. Orders placed before migration
  // 013 fall back to the join, which is all that exists for them.
  const snap = order.shipping_address_snapshot;
  if (snap) {
    order.ship_name = snap.full_name;
    order.ship_phone = snap.phone;
    order.ship_email = snap.email;
    order.ship_line1 = snap.line1;
    order.ship_line2 = snap.line2;
    order.ship_city = snap.city;
    order.ship_state = snap.state;
    order.ship_pincode = snap.pincode;
    order.ship_country = snap.country;
  }

  /* LEFT JOINs, both of them, and that is load-bearing: a product deleted
     since the order was placed must not make the order's own items vanish from
     the screen. The snapshot columns still carry what was bought; the joined
     columns simply go null, and the UI falls back to them. */
  const { rows: items } = await db.query(
    `SELECT oi.id, oi.product_id, oi.product_name_snapshot, oi.unit_price_paise,
            oi.quantity, oi.line_total_paise, oi.variant_id, oi.variant_snapshot,
            p.sku, p.slug, p.category, p.subcategory,
            v.sku AS variant_sku
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       LEFT JOIN product_variants v ON v.id = oi.variant_id
      WHERE oi.order_id = $1 ORDER BY oi.id`,
    [req.params.id]
  );
  const { rows: refunds } = await db.query(
    `SELECT id, amount_paise, status, razorpay_refund_id, created_at, failure_reason
       FROM refunds WHERE entity_type = 'order' AND entity_id = $1 ORDER BY created_at`,
    [req.params.id]
  );
  const refundedPaise = refunds
    .filter((r) => r.status === 'processed')
    .reduce((sum, r) => sum + Number(r.amount_paise), 0);

  res.json({
    order,
    items,
    refunds,
    refundSummary: {
      refundedPaise,
      refundablePaise: Math.max(0, Number(order.total_paise) - refundedPaise)
    }
  });
}));

// ---------- Update order status (fulfilment) ----------
// Refunds are NO LONGER reachable through this endpoint. They moved to their
// own route below with its own capability, because "change a status" and "send
// money back to a customer" are not the same action and should never have
// shared a permission, a code path or an audit entry.
router.patch('/orders/:id/status', requireCapability(C.ORDERS_FULFIL), asyncHandler(async (req, res) => {
  const { status, trackingNumber, courierName } = req.body;
  const allowed = ['processing', 'shipped', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({
      error: 'Invalid status.',
      hint: status === 'refunded'
        ? 'Use POST /api/admin/orders/:id/refund to return money to the customer.'
        : undefined
    });
  }

  const { rows: existingRows } = await db.query(
    'SELECT id, status, total_paise, razorpay_payment_id, payment_method FROM orders WHERE id = $1',
    [req.params.id]
  );
  if (!existingRows.length) return res.status(404).json({ error: 'Order not found.' });
  const existingOrder = existingRows[0];

  // "Money was collected" must mean money ACTUALLY captured through the
  // gateway, not merely that the order reached a fulfilment status. A COD
  // order sitting at 'processing' has had nothing captured: the cash is
  // collected at the door. The gate is the presence of a real Razorpay payment
  // id, which is the only thing that can actually be refunded.
  const hasCapturedPayment = Boolean(existingOrder.razorpay_payment_id);
  const reachedFulfilment = ['paid', 'processing', 'shipped', 'delivered'].includes(existingOrder.status);

  if (status === 'cancelled' && hasCapturedPayment && reachedFulfilment) {
    return res.status(409).json({
      error: 'This order has a captured online payment. Refund it instead of cancelling, so the customer actually gets their money back.'
    });
  }

  if (status === 'cancelled') {
    const result = await restoreOrderStock(req.params.id, 'cancelled', 'admin_status_change', req.user.id);
    if (result.reason === 'order_not_found') return res.status(404).json({ error: 'Order not found.' });
  }

  const result = await db.query(
    `UPDATE orders
     SET status = $1, tracking_number = COALESCE($2, tracking_number),
         courier_name = COALESCE($3, courier_name), updated_at = now()
     WHERE id = $4 RETURNING *`,
    [status, trackingNumber || null, courierName || null, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });

  // OPS-03 — the audit entry used to record only {status}. It now records what
  // actually changed, which is the difference between a log and an audit trail.
  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
     VALUES ($1, 'update_order_status', 'order', $2, $3)`,
    [req.user.id, req.params.id, JSON.stringify({
      previousStatus: existingOrder.status,
      newStatus: status,
      trackingNumber: trackingNumber || null,
      courierName: courierName || null,
      paymentMethod: existingOrder.payment_method
    })]
  );

  // Fire-and-forget: a slow/failed email must never block the status update
  // itself from succeeding and being returned to the admin. Wrapped so a
  // rejection inside this IIFE cannot become an unhandled rejection (OPS-01).
  (async () => {
    try {
      const { rows: customerRows } = await db.query(
        `SELECT o.order_number, o.status, o.tracking_number, o.courier_name, o.total_paise,
                u.email AS customer_email, u.name AS customer_name
         FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
        [req.params.id]
      );
      if (!customerRows.length) return;
      const { rows: itemRows } = await db.query(
        `SELECT oi.product_name_snapshot, p.slug
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1`,
        [req.params.id]
      );
      await sendOrderStatusUpdate(customerRows[0], itemRows);
    } catch (err) {
      logger.warn('Order status update email failed', { orderId: req.params.id, message: err.message });
    }
  })().catch(() => {});

  res.json({ order: result.rows[0] });
}));

// ---------- Refund an order (real money movement) ----------
// PAY-02 — the whole flow lives in utils/refunds.js: intent is committed before
// the gateway is called, partial refunds compose against a remaining balance,
// and a crash mid-flight is resolvable rather than ambiguous. See that file.
router.post('/orders/:id/refund', requireCapability(C.ORDERS_REFUND), asyncHandler(async (req, res) => {
  const { amountPaise, reason, restock } = req.body;

  const { rows } = await db.query(
    'SELECT id, status, total_paise, razorpay_payment_id, payment_method FROM orders WHERE id = $1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
  const order = rows[0];

  if (!order.razorpay_payment_id) {
    return res.status(409).json({
      error: order.payment_method === 'cod'
        ? 'This is a Cash on Delivery order — there is no online payment to refund.'
        : 'This order has no captured payment to refund.'
    });
  }

  // ---------------------------------------------------------------------------
  // STATUS PRECONDITION — load-bearing, not cosmetic.
  //
  // issueRefund() restores stock with restoreOrderStockInTransaction(), which by
  // design has NO idempotency guard: the caller owns the status transition, so
  // the guard would only ever get in its way. The consequence is that the guard
  // is no longer available to absorb a second call — and this route previously
  // gated on nothing but the presence of a payment id.
  //
  // That made two ordinary sequences double-restore stock and INVENT inventory:
  //   1. reject a payment review (stock returned) -> then refund
  //   2. staff cancels the order (stock returned) -> then an admin refunds
  // Both leave razorpay_payment_id set, so both passed the old check.
  //
  // The rule: an order may only be refunded from a status where the goods are
  // still considered sold. Every status in STOCK_RESTORED_STATUSES has already
  // had its stock returned and must be refused. The booking refund route has
  // carried the equivalent guard since it was written; this brings the order
  // route into line with it.
  // ---------------------------------------------------------------------------
  const REFUNDABLE_STATUSES = new Set([
    'paid', 'processing', 'shipped', 'delivered', 'partially_refunded', 'payment_review'
  ]);
  if (!REFUNDABLE_STATUSES.has(order.status)) {
    return res.status(409).json({
      error: STOCK_RESTORED_STATUSES.has(order.status)
        ? `This order is already "${order.status}" — its stock has been returned and it cannot be refunded again. If money is still with the gateway, refund it in the Razorpay dashboard; the refund webhook will record it here.`
        : `An order in state "${order.status}" cannot be refunded.`
    });
  }

  try {
    const result = await issueRefund({
      entityType: 'order',
      entityId: order.id,
      razorpayPaymentId: order.razorpay_payment_id,
      capturedTotalPaise: Number(order.total_paise),
      requestedAmountPaise: (amountPaise === undefined || amountPaise === null) ? null : Number(amountPaise),
      adminUserId: req.user.id,
      restock: restock !== false,
      reason: reason || 'admin_initiated_refund'
    });
    // A refund reaches the customer's bank in 5-7 working days. Without this
    // email they watch an unchanged balance for a week and conclude nothing
    // happened — which becomes a support ticket, and sometimes a chargeback
    // for a refund that was already on its way.
    //
    // Sent AFTER the gateway call succeeded, never before: telling someone
    // money is coming and then failing to send it is the one order of
    // operations that must not happen.
    const forEmail = await loadOrderForEmail(order.id);
    if (forEmail) {
      // issueRefund's real contract:
      //   { refundId, ledgerId, amountPaise, totalRefundedPaise, fullyRefunded }
      // amountPaise is THIS refund; fullyRefunded accounts for earlier partial
      // refunds too, which is why the email uses it rather than comparing this
      // one amount against the order total — a second partial refund that
      // completes the order should not be described as partial.
      fireAndForget(sendRefundInitiated({
        order: forEmail.order,
        amountPaise: result.amountPaise,
        refundId: result.ledgerId,
        isPartial: !result.fullyRefunded
      }), { orderId: order.id, template: 'refund_initiated' });

      fireAndForget(sendAdminRefundIssued({
        order: forEmail.order,
        amountPaise: result.amountPaise,
        adminName: req.user && req.user.name,
        refundId: result.ledgerId
      }), { orderId: order.id, template: 'admin_refund_issued' });
    }

    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error('Order refund failed', err, { orderId: order.id });
    res.status(500).json({ error: 'Could not process the refund. No money has been moved — please try again.' });
  }
}));

// ---------- Orders parked for payment review (PAY-01) ----------
router.get('/orders/needs-review/list', requireCapability(C.ORDERS_READ), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT o.id, o.order_number, o.status, o.total_paise, o.payment_review_reason,
            o.razorpay_order_id, o.razorpay_payment_id, o.created_at,
            u.name AS customer_name, u.email AS customer_email
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
      WHERE o.status = 'payment_review'
      ORDER BY o.created_at DESC LIMIT 200`
  );
  res.json({ orders: rows });
}));

// Resolving a review is a money decision (it either accepts a payment as
// settled or writes it off), so it needs the refund capability, not fulfilment.
router.post('/orders/:id/resolve-review', requireCapability(C.ORDERS_REFUND), asyncHandler(async (req, res) => {
  const { resolution, note } = req.body; // 'accept' | 'reject'
  if (!['accept', 'reject'].includes(resolution)) {
    return res.status(400).json({ error: 'Resolution must be "accept" or "reject".' });
  }

  const outcome = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT id, status, order_number FROM orders WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );
    if (!rows.length) throw Object.assign(new Error('Order not found.'), { status: 404 });
    if (rows[0].status !== 'payment_review') {
      throw Object.assign(new Error(`Order is "${rows[0].status}", not awaiting payment review.`), { status: 409 });
    }

    const newStatus = resolution === 'accept' ? 'paid' : 'payment_failed';

    // Rejecting means the money never arrived, so the reserved stock goes back.
    //
    // This MUST happen inside this transaction, before the status write. Calling
    // restoreOrderStock() after the transaction committed would find the order
    // already at 'payment_failed' — a status its idempotency guard treats as
    // "stock already restored" — so it would silently no-op and the units would
    // be lost. Same failure shape as the refund path; see utils/stock.js.
    if (newStatus === 'payment_failed') {
      await restoreOrderStockInTransaction(
        client, req.params.id, 'payment_review_rejected', req.user.id, 'payment_review', 'payment_failed'
      );
    }

    await client.query(
      'UPDATE orders SET status = $2, updated_at = now() WHERE id = $1',
      [req.params.id, newStatus]
    );
    await client.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'resolve_payment_review', 'order', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ resolution, newStatus, note: note || null })]
    );
    return { orderNumber: rows[0].order_number, newStatus, stockRestored: newStatus === 'payment_failed' };
  });

  res.json(outcome);
}));

// ---------- Mark a COD order as returned to origin (BIZ-07) ----------
// RTO is the dominant cost of COD in Indian D2C. Recording it is what makes the
// automatic block meaningful — without a count there is nothing to act on.
router.post('/orders/:id/mark-rto', requireCapability(C.ORDERS_FULFIL), asyncHandler(async (req, res) => {
  const settings = await getSettings();

  const outcome = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id, user_id, status, payment_method, rto_marked_at FROM orders WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!rows.length) throw Object.assign(new Error('Order not found.'), { status: 404 });
    const order = rows[0];
    if (order.payment_method !== 'cod') {
      throw Object.assign(new Error('Only Cash on Delivery orders can be marked as returned to origin.'), { status: 400 });
    }
    if (order.rto_marked_at) {
      throw Object.assign(new Error('This order is already marked as returned.'), { status: 409 });
    }

    await client.query('UPDATE orders SET rto_marked_at = now(), updated_at = now() WHERE id = $1', [req.params.id]);

    const { rows: userRows } = await client.query(
      `UPDATE users SET cod_rto_count = cod_rto_count + 1, updated_at = now()
        WHERE id = $1 RETURNING cod_rto_count, cod_blocked`,
      [order.user_id]
    );
    const rtoCount = userRows.length ? Number(userRows[0].cod_rto_count) : 0;
    let blocked = userRows.length ? userRows[0].cod_blocked : false;

    const threshold = Number(settings.max_cod_rto_before_block);
    if (!blocked && threshold > 0 && rtoCount >= threshold) {
      await client.query(
        `UPDATE users SET cod_blocked = true, cod_blocked_reason = $2 WHERE id = $1`,
        [order.user_id, `Auto-blocked after ${rtoCount} returned COD orders`]
      );
      blocked = true;
    }

    await client.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'mark_cod_rto', 'order', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ customerId: order.user_id, rtoCount, codBlocked: blocked })]
    );

    return { rtoCount, codBlocked: blocked };
  });

  // The goods came back, so the stock comes back with them.
  await restoreOrderStock(req.params.id, 'cancelled', 'cod_returned_to_origin', req.user.id)
    .catch((err) => logger.error('RTO recorded but stock restore failed', err, { orderId: req.params.id }));

  res.json(outcome);
}));

// ============================================================
// Admin product views — deliberately separate from the public
// GET /api/products endpoint, which always filters WHERE is_active = true
// and returns a limited field set. An admin needs to see (and reactivate)
// hidden/deactivated products too, and needs every field for editing.
// ============================================================
router.get('/products', requireCapability(C.CATALOG_READ), asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const { search, category, subcategory, badge } = req.query;
  const conditions = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR sku ILIKE $${params.length})`);
  }
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (subcategory) {
    // Exactly the category rule, one level down: AND-ed with the others, and
    // normalised the same way, so "Scripture" from a dropdown matches the
    // "scripture" stored by the write path (migration 016 enforces lowercase).
    params.push(normaliseTerm(subcategory));
    conditions.push(`subcategory = $${params.length}`);
  }
  if (badge) {
    // Combined with category via AND, so selecting both narrows to products
    // matching both — which is the expected behaviour when two filters are set.
    params.push(badge);
    conditions.push(`badge = $${params.length}`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit, offset);

  // variant_count tells the admin UI whether this product's stock is a derived
  // figure (sum of its variants, maintained by a DB trigger) or a
  // directly-managed number — the two are edited in completely different
  // places, so showing a bare number without that context is misleading.
  const { rows } = await db.query(
    `SELECT p.*,
            (SELECT COUNT(*)::int FROM product_variants v
              WHERE v.product_id = p.id AND v.is_active = true) AS variant_count,
            /* The exact number the storefront ranks bestsellers by, counted by
               the exact same rule (REVENUE_STATUS_SQL). The shop now computes a
               Bestseller badge from real sales, so without this the console
               shows a badge it cannot explain, and "it decided on its own and I
               cannot see why" is not something anyone should have to accept
               about their own shop. */
            COALESCE((SELECT SUM(oi.quantity)::int
                        FROM order_items oi
                        JOIN orders o ON o.id = oi.order_id
                       WHERE oi.product_id = p.id
                         AND o.status IN ${REVENUE_STATUS_SQL}), 0) AS units_sold,
            /* An option row with no variant behind it makes a product that
               looks live and cannot be bought: the shop asks the customer to
               choose, and nothing they choose resolves to anything. It is
               invisible from the product list — active, in stock, normal — so
               the console has to be told to look for it. */
            (SELECT COUNT(*)::int FROM product_options po
              WHERE po.product_id = p.id) AS option_count,
            COUNT(*) OVER() AS total_count
     FROM products p ${where}
     ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalCount = rows.length ? Number(rows[0].total_count) : 0;
  res.json({
    products: rows.map(({ total_count, ...row }) => row),
    pagination: { page, limit, totalCount, totalPages: Math.max(1, Math.ceil(totalCount / limit)) }
  });
}));

router.get('/products/:id', requireCapability(C.CATALOG_READ), asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Product not found.' });

  // One round-trip per collection instead of one per option: the previous
  // version issued a query inside a loop over options (a textbook N+1), which
  // on a product with eight options meant nine sequential round-trips to Neon.
  const [images, properties, options, variants] = await Promise.all([
    db.query('SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order', [req.params.id]),
    db.query('SELECT * FROM product_properties WHERE product_id = $1 ORDER BY sort_order', [req.params.id]),
    db.query('SELECT * FROM product_options WHERE product_id = $1 ORDER BY sort_order', [req.params.id]),
    db.query('SELECT * FROM product_variants WHERE product_id = $1 ORDER BY created_at', [req.params.id])
  ]);
  const optionIds = options.rows.map((o) => o.id);
  const { rows: allValues } = optionIds.length
    ? await db.query('SELECT * FROM product_option_values WHERE option_id = ANY($1) ORDER BY sort_order', [optionIds])
    : { rows: [] };
  const valuesByOption = allValues.reduce((acc, v) => {
    (acc[v.option_id] = acc[v.option_id] || []).push(v);
    return acc;
  }, {});
  const optionsWithValues = options.rows.map((o) => ({ ...o, values: valuesByOption[o.id] || [] }));

  res.json({
    product: rows[0],
    images: images.rows,
    properties: properties.rows,
    options: optionsWithValues,
    variants: variants.rows
  });
}));

// ============================================================
// Analytics — power the dashboard's charts and summary widgets
// ============================================================

// BIZ-06 — every date bucket below is computed in IST, not in the database
// server's timezone. Render runs UTC, 5.5 hours behind: without this a sale at
// 11pm IST landed on the next day's bar, so the revenue chart was silently
// offset and could not be reconciled against a bank statement.
const IST = "'Asia/Kolkata'";

router.get('/analytics/revenue-by-day', requireCapability(C.ANALYTICS_READ), asyncHandler(async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const { rows } = await db.query(
    `SELECT to_char(date_trunc('day', created_at AT TIME ZONE ${IST}), 'YYYY-MM-DD') AS day,
            COALESCE(SUM(total_paise), 0) AS revenue_paise,
            COUNT(*) AS order_count
     FROM orders
     WHERE status IN ${REVENUE_STATUS_SQL}
       AND created_at >= now() - make_interval(days => $1)
     GROUP BY 1 ORDER BY 1`,
    [days]
  );
  res.json({ days: rows, timezone: 'Asia/Kolkata' });
}));

router.get('/analytics/top-products', requireCapability(C.ANALYTICS_READ), asyncHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.slug, p.category, SUM(oi.quantity) AS units_sold, SUM(oi.line_total_paise) AS revenue_paise
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     WHERE o.status IN ${REVENUE_STATUS_SQL}
     GROUP BY p.id, p.name, p.slug, p.category
     ORDER BY units_sold DESC
     LIMIT $1`,
    [limit]
  );
  res.json({ products: rows });
}));

router.get('/analytics/order-status-breakdown', requireCapability(C.ANALYTICS_READ), asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY status');
  res.json({ breakdown: rows });
}));

// ---------- Products running low on stock ----------
router.get('/low-stock', requireCapability(C.CATALOG_READ), asyncHandler(async (req, res) => {
  const threshold = Math.min(1000, Math.max(0, parseInt(req.query.threshold, 10) || 5));

  /* THE BLIND SPOT THIS CLOSES.

     products.stock_qty on a variant product is a DERIVED figure — the sum of
     its active variants, maintained by migration 012's trigger. So three sizes
     holding 2 each report 6, clear a threshold of 5, and never appear here,
     while every individual size is one order away from unsellable. The seller
     finds out when a customer cannot check out.

     Two queries rather than one, because they answer different questions and a
     UNION would force the same columns onto both:

       - a product with NO variants, low on its own directly-managed stock;
       - a VARIANT that is low, named so it can be restocked.

     A variant product is deliberately excluded from the first: its stock_qty is
     not a number anybody manages, and listing "Dhoti: 6 left" beside "Dhoti /
     Size M: 2 left" is noise that hides the actionable row. */
  const { rows: products } = await db.query(
    `SELECT p.id, p.name, p.slug, p.sku, p.stock_qty, p.category, p.subcategory
       FROM products p
      WHERE p.is_active = true
        AND p.stock_qty <= $1
        AND NOT EXISTS (SELECT 1 FROM product_variants v
                         WHERE v.product_id = p.id AND v.is_active = true)
      ORDER BY p.stock_qty ASC LIMIT 100`,
    [threshold]
  );

  const { rows: variants } = await db.query(
    `SELECT v.id AS variant_id, v.sku AS variant_sku, v.stock_qty,
            v.option_values,
            p.id AS product_id, p.name AS product_name, p.slug AS product_slug,
            p.sku AS product_sku, p.category, p.subcategory
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.is_active = true AND p.is_active = true AND v.stock_qty <= $1
      ORDER BY v.stock_qty ASC LIMIT 100`,
    [threshold]
  );

  res.json({ products, variants, threshold });
}));

// ============================================================
// Customers — bulk PII, admin-only (AUTH-02)
// ============================================================
router.get('/customers', requireCapability(C.CUSTOMERS_READ), asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const { search } = req.query;
  const params = [];
  let where = "WHERE u.role = 'customer'";
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.phone, u.created_at, u.email_verified, u.cod_blocked, u.cod_rto_count,
            COUNT(o.id) FILTER (WHERE o.status IN ${REVENUE_STATUS_SQL}) AS completed_order_count,
            COALESCE(SUM(o.total_paise) FILTER (WHERE o.status IN ${REVENUE_STATUS_SQL}), 0) AS lifetime_value_paise
     FROM users u
     LEFT JOIN orders o ON o.user_id = u.id
     ${where}
     GROUP BY u.id
     ORDER BY u.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // Reading the full customer list is a bulk-PII event. Under the DPDP Act the
  // question "who accessed this data and when" needs an answer, and a list
  // endpoint that leaves no trace cannot give one.
  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, detail)
     VALUES ($1, 'read_customer_list', 'user', $2)`,
    [req.user.id, JSON.stringify({ rowCount: rows.length, search: search ? '[provided]' : null, page })]
  );

  res.json({ customers: rows });
}));

// Unblock a customer who was auto-blocked from COD (BIZ-07).
router.post('/customers/:id/cod-block', requireCapability(C.CUSTOMERS_READ, C.ORDERS_FULFIL), asyncHandler(async (req, res) => {
  const blocked = req.body.blocked !== false;
  const { rows } = await db.query(
    `UPDATE users SET cod_blocked = $2, cod_blocked_reason = $3, updated_at = now()
      WHERE id = $1 AND role = 'customer' RETURNING id, cod_blocked, cod_rto_count`,
    [req.params.id, blocked, blocked ? (req.body.reason || 'Blocked by staff') : null]
  );
  if (!rows.length) return res.status(404).json({ error: 'Customer not found.' });
  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
     VALUES ($1, 'set_cod_block', 'user', $2, $3)`,
    [req.user.id, req.params.id, JSON.stringify({ blocked, reason: req.body.reason || null })]
  );
  res.json({ customer: rows[0] });
}));

// ============================================================
// Review moderation (BIZ-05)
// ============================================================
router.get('/reviews', requireCapability(C.REVIEWS_MODERATE), asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const onlyHidden = req.query.hidden === 'true';
  const { rows } = await db.query(
    `SELECT r.id, r.product_id, r.rating, r.comment, r.reviewer_name_snapshot, r.is_approved,
            r.hidden_reason, r.created_at, r.moderated_at,
            p.name AS product_name, p.slug AS product_slug,
            u.email AS reviewer_email
       FROM product_reviews r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN users u ON u.id = r.user_id
      ${onlyHidden ? 'WHERE r.is_approved = false' : ''}
      ORDER BY r.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ reviews: rows });
}));

router.patch('/reviews/:id', requireCapability(C.REVIEWS_MODERATE), asyncHandler(async (req, res) => {
  const approve = req.body.approve !== false;
  const reason = req.body.reason || null;
  if (!approve && !reason) {
    return res.status(400).json({ error: 'Please give a reason when hiding a review — it is recorded in the audit log.' });
  }

  const updated = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE product_reviews
          SET is_approved = $2, hidden_reason = $3, moderated_by = $4, moderated_at = now()
        WHERE id = $1
        RETURNING id, product_id, is_approved`,
      [req.params.id, approve, approve ? null : reason, req.user.id]
    );
    if (!rows.length) throw Object.assign(new Error('Review not found.'), { status: 404 });

    // Recompute the product aggregate from APPROVED reviews only, so hiding a
    // review actually corrects the star rating rather than leaving the hidden
    // review's score baked into it.
    await recomputeProductRating(client, rows[0].product_id);

    await client.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'moderate_review', 'product_review', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ approved: approve, reason })]
    );
    return rows[0];
  });

  // Only on approval, and only once. A rejection deliberately sends nothing:
  // a "your review was hidden" email invites an argument with a customer over
  // a judgement call, and the moderator's reason is recorded in the audit log
  // where it belongs.
  if (updated.is_approved) {
    try {
      const { rows: r } = await db.query(
        `SELECT u.email, u.name, p.name AS product_name, p.slug
           FROM product_reviews pr
           JOIN users u ON u.id = pr.user_id
           JOIN products p ON p.id = pr.product_id
          WHERE pr.id = $1`,
        [req.params.id]
      );
      if (r.length) {
        fireAndForget(sendReviewApproved({
          email: r[0].email, name: r[0].name,
          productName: r[0].product_name, productSlug: r[0].slug,
          reviewId: req.params.id
        }), { reviewId: req.params.id, template: 'review_approved' });
      }
    } catch (err) {
      logger.warn('Could not send review-approved email', { message: err.message });
    }
  }

  res.json({ review: updated });
}));

// ============================================================
// Commerce settings (HYG-03 / BIZ-07)
// ============================================================
router.get('/settings', requireCapability(C.ANALYTICS_READ), asyncHandler(async (req, res) => {
  const settings = await getSettings();
  res.json({ settings, editable: Object.keys(SETTING_DEFAULTS) });
}));

router.put('/settings/:key', requireCapability(C.SETTINGS_WRITE), asyncHandler(async (req, res) => {
  try {
    const result = await setSetting(req.params.key, req.body.value, req.user.id);
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, detail)
       VALUES ($1, 'update_setting', 'site_settings', $2)`,
      [req.user.id, JSON.stringify({ key: req.params.key, value: String(req.body.value) })]
    );
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

// ============================================================
// Audit log — every admin write action, for accountability at scale
// ============================================================
router.get('/audit-log', requireCapability(C.AUDIT_READ), asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = (page - 1) * limit;
  const { action, entityType } = req.query;
  const params = [];
  const conditions = [];
  if (action) { params.push(action); conditions.push(`l.action = $${params.length}`); }
  if (entityType) { params.push(entityType); conditions.push(`l.entity_type = $${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit, offset);

  const { rows } = await db.query(
    `SELECT l.*, u.name AS admin_name, u.email AS admin_email
     FROM admin_audit_log l
     LEFT JOIN users u ON u.id = l.admin_user_id
     ${where}
     ORDER BY l.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ entries: rows });
}));


// ===========================================================================
// INBOXES — the three surfaces that used to throw customer input away
// ===========================================================================
// All four routes below read customer email addresses in bulk, which is
// precisely the PII surface CUSTOMERS_READ exists to gate. Staff do not hold
// it; that is the separation, not an oversight.

// ---------- Contact messages ----------
router.get('/contact-messages', requireCapability(C.CUSTOMERS_READ), asyncHandler(async (req, res) => {
  const status = ['new', 'read', 'replied', 'archived'].includes(req.query.status) ? req.query.status : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const { rows } = await db.query(
    `SELECT cm.id, cm.name, cm.email, cm.phone, cm.subject, cm.message, cm.status,
            cm.admin_notes, cm.handled_at, cm.created_at,
            h.name AS handled_by_name
       FROM contact_messages cm
       LEFT JOIN users h ON h.id = cm.handled_by
      WHERE ($1::text IS NULL OR cm.status = $1)
      ORDER BY cm.created_at DESC
      LIMIT $2`,
    [status, limit]
  );
  const { rows: counts } = await db.query(
    "SELECT count(*) FILTER (WHERE status = 'new')::int AS unread, count(*)::int AS total FROM contact_messages"
  );
  res.json({ messages: rows, unread: counts[0].unread, total: counts[0].total });
}));

// Reading the enquiry AND acting on it: both grants, because this changes what
// the customer's message is recorded as having been dealt with.
router.patch('/contact-messages/:id', requireCapability(C.CUSTOMERS_READ, C.CUSTOMERS_CONTACT), asyncHandler(async (req, res) => {
  const { status, adminNotes } = req.body;
  if (status && !['new', 'read', 'replied', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'Status must be new, read, replied or archived.' });
  }
  const { rows } = await db.query(
    `UPDATE contact_messages
        SET status      = COALESCE($2, status),
            admin_notes = COALESCE($3, admin_notes),
            handled_by  = $4,
            handled_at  = now()
      WHERE id = $1
      RETURNING id, status, admin_notes`,
    [req.params.id, status || null, adminNotes || null, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Message not found.' });
  res.json({ message: rows[0] });
}));

/* Reply to a contact enquiry, by email, from the console.

   THE GAP THIS CLOSES: there was a "Replied" button that set a status and sent
   nothing. An admin could mark an enquiry answered without the customer ever
   hearing back, and nothing in the system could tell the difference between a
   real reply and a mis-click.

   The status is only moved to 'replied' AFTER the send is accepted. If the mail
   fails the message stays where it was, so the queue still shows it as
   outstanding rather than quietly losing it. */
/* Sending mail to a customer, signed as the business. A read grant must never
   carry this: requireCapability demands ALL of the listed capabilities, so this
   needs the contact grant as well as the one that lets you see the enquiry. */
router.post('/contact-messages/:id/reply', requireCapability(C.CUSTOMERS_READ, C.CUSTOMERS_CONTACT), asyncHandler(async (req, res) => {
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (body.length < 2) return res.status(400).json({ error: 'Write a reply before sending.' });
  if (body.length > 5000) return res.status(400).json({ error: 'That reply is too long — 5000 characters maximum.' });

  const { rows } = await db.query(
    'SELECT id, name, email, subject, message, created_at FROM contact_messages WHERE id = $1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Message not found.' });
  const msg = rows[0];

  const subject = msg.subject ? ('Re: ' + msg.subject) : 'Re: your message to Chakrashri';
  const result = await sendContactReply({
    toEmail: msg.email,
    toName: msg.name,
    subject,
    replyBody: body,
    messageId: msg.id,
    originalMessage: {
      subject: msg.subject,
      message: msg.message,
      when: new Date(msg.created_at).toISOString().slice(0, 10)
    }
  });

  if (!result || result.sent === false) {
    // Left as-is on purpose: an unsent reply must not read as answered.
    return res.status(502).json({ error: 'The reply could not be sent. The message is still marked unanswered — please try again.' });
  }

  // Appended, not overwritten: an enquiry can be replied to more than once and
  // the console is the only record of what was actually said.
  await db.query(
    `UPDATE contact_messages
        SET status = 'replied',
            admin_notes = COALESCE(admin_notes || E'\n\n', '') || $2,
            handled_by = $3,
            handled_at = now()
      WHERE id = $1`,
    [msg.id, '[' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '] ' + body, req.user.id]
  );

  res.json({ ok: true, sentTo: msg.email });
}));

// ---------- Newsletter subscribers ----------
router.get('/subscribers', requireCapability(C.CUSTOMERS_READ), asyncHandler(async (req, res) => {
  const status = ['pending', 'confirmed', 'unsubscribed'].includes(req.query.status) ? req.query.status : null;
  const { rows } = await db.query(
    `SELECT email, status, source, consent_text, confirmed_at, unsubscribed_at, created_at
       FROM email_subscriptions
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC LIMIT 500`,
    [status]
  );
  const { rows: counts } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'confirmed')::int   AS confirmed,
            count(*) FILTER (WHERE status = 'pending')::int     AS pending,
            count(*) FILTER (WHERE status = 'unsubscribed')::int AS unsubscribed
       FROM email_subscriptions`
  );
  // consent_text is returned deliberately: if anyone ever asks what a
  // subscriber agreed to, the answer has to be the wording they actually saw,
  // not today's wording.
  res.json({ subscribers: rows, counts: counts[0] });
}));

// ---------- Who is waiting for a restock ----------
// Buying decisions, not marketing: twelve people waiting on one variant is the
// clearest reorder signal a small shop gets, and it is invisible anywhere else.
router.get('/stock-waitlist', requireCapability(C.CATALOG_READ), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id AS product_id, p.name, p.slug, p.sku, p.stock_qty,
            sn.variant_id, v.sku AS variant_sku,
            count(*)::int AS waiting,
            min(sn.created_at) AS waiting_since
       FROM stock_notifications sn
       JOIN products p ON p.id = sn.product_id
       LEFT JOIN product_variants v ON v.id = sn.variant_id
      WHERE sn.notified_at IS NULL
      GROUP BY p.id, p.name, p.slug, p.sku, p.stock_qty, sn.variant_id, v.sku
      ORDER BY waiting DESC, waiting_since ASC
      LIMIT 200`
  );
  res.json({ waitlist: rows });
}));

/* ---------- Send one update to every confirmed subscriber ----------

   THE ORPHAN THIS CONNECTS. templates.sendNewsletter has existed since the
   email system was built — marketing category, per-campaign dedupe key,
   unsubscribe link, consent check — and NOTHING has ever called it. The list
   has been collecting confirmed subscribers who could never be written to, and
   the only reason nobody noticed is that a feature with no screen looks exactly
   like a feature that was never asked for.

   WHAT THIS ROUTE IS RESPONSIBLE FOR, and what it deliberately leaves alone:

   - It sends to CONFIRMED subscribers only. A pending address has clicked
     nothing; mailing it is the definition of unsolicited.
   - It does NOT re-implement consent, suppression or the unsubscribe footer.
     sendMail already refuses a suppressed address, refuses one with no
     marketing consent, refuses everything when the marketing switch is off, and
     writes each outcome to email_log. Restating any of that here would create a
     second place for it to drift.
   - The body is PLAIN TEXT that an admin typed, and it is escaped and split
     into paragraphs here. It is never passed through as markup: this is the one
     route in the console that turns typed input into an email read by every
     subscriber, so it is the last place to trust a string.
   - campaignId is supplied by the caller and is the idempotency key. A
     double-submit carries the same id, the engine's dedupe drops the second
     copy per recipient, and nobody is mailed twice. A deliberate resend later
     carries a new id and goes out. */
router.post(
  '/subscribers/broadcast',
  requireCapability(C.CUSTOMERS_READ, C.SUBSCRIBERS_BROADCAST),
  [
    body('subject').trim().isLength({ min: 3, max: 200 })
      .withMessage('A subject between 3 and 200 characters is required.'),
    body('heading').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 200 }),
    body('message').trim().isLength({ min: 10, max: 5000 })
      .withMessage('The update must be between 10 and 5000 characters.'),
    body('campaignId').trim().isLength({ min: 8, max: 64 })
      .withMessage('A campaign id is required so a double submit cannot send twice.')
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    const { subject, message, campaignId } = req.body;
    const heading = (req.body.heading || '').trim() || subject;

    const { rows: recipients } = await db.query(
      `SELECT email FROM email_subscriptions
        WHERE status = 'confirmed'
        ORDER BY created_at ASC
        LIMIT 5000`
    );

    if (!recipients.length) {
      return res.status(400).json({ error: 'There are no confirmed subscribers to send to yet.' });
    }

    /* A blank line starts a paragraph; inside one, **bold** and [label](url)
       become the only two tags this route can emit. Everything else the admin
       typed is escaped, so their `<script>` reaches subscribers as the text
       `<script>` — see renderUpdateInline for why the input is a syntax rather
       than markup. */
    const bodyHtml = String(message)
      .split(/\r?\n\s*\r?\n/)
      .map((para) => para.trim())
      .filter(Boolean)
      .map((para) => `<p style="margin:0 0 16px;">${renderUpdateInline(para)}</p>`)
      .join('');

    /* The plain-text half of the message, built from the SOURCE rather than
       reduced back out of the HTML. The engine can derive one when it has to,
       and here it does not have to: the admin typed plain text in the first
       place, so this is the better of the two by construction. */
    const bodyText = renderUpdatePlain(message);

    const counts = { total: recipients.length, sent: 0, skipped: 0, failed: 0 };

    /* Sequential, on purpose. This runs on a free-tier instance against a
       shared SMTP account; firing five thousand concurrent sends is how an
       account gets rate-limited or blocked, and a marketing send has no
       deadline. Each recipient's failure is counted and the run continues — one
       bad address must not stop the list. */
    for (const r of recipients) {
      try {
        const result = await sendNewsletter({
          email: r.email,
          subject,
          heading,
          bodyHtml,
          bodyText,
          unsubscribeUrl: await unsubscribeUrlFor(r.email),
          campaignId
        });
        if (result && result.sent) counts.sent += 1;
        else counts.skipped += 1;
      } catch (err) {
        counts.failed += 1;
        logger.error('Subscriber broadcast send failed', err, { campaignId });
      }
    }

    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'broadcast_subscribers', 'email_subscription', NULL, $2)`,
      [req.user.id, JSON.stringify({ campaignId, subject, ...counts })]
    );

    res.json({ ok: true, ...counts });
  })
);

/* Escapes a paragraph and keeps its single line breaks as <br>. An admin who
   presses Enter once inside a paragraph means a line break; the alternative is
   silently running their lines together. */
function escapeHtmlLines(text) {
  return escapeUpdateText(text).replace(/\r?\n/g, '<br>');
}

function escapeUpdateText(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* BOLD AND LINKS, FROM A SYNTAX RATHER THAN FROM MARKUP.

   An owner writing to the whole subscriber list needs to emphasise a date and
   link to a product. The obvious way to allow that is a rich-text box that
   produces HTML, and it is the wrong way: it means accepting HTML from a form
   and sanitising it, and a sanitiser is a denylist of everything an attacker
   might try. On the one route in this application whose output is read by every
   subscriber, that is the wrong shape of problem to take on.

   So the input stays PLAIN TEXT and carries two markers:

     **bold**                       ->  <strong>bold</strong>
     [label](https://example.com)   ->  <a href="https://example.com">label</a>

   and the HTML is produced by this function, which can emit those two tags and
   nothing else. An admin who types `<script>` gets `<script>` shown to their
   subscribers as the text they typed, because every piece of their input is
   escaped on the way out — the tags here are added around escaped text, never
   parsed out of it.

   THE URL IS MATCHED, NOT TRUSTED. The pattern admits `https?://` followed by
   characters that cannot terminate an attribute or a tag, so `javascript:`,
   `data:` and a quote that would break out of the href are all simply not
   matches — the text is left alone and shown literally. That is a whitelist,
   which is the only kind of check worth having here. */
const UPDATE_LINK_OR_BOLD =
  /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s()<>"'`]{1,500})\)|\*\*([^*\n]{1,300})\*\*/g;

function renderUpdateInline(raw) {
  let out = '';
  let last = 0;
  const re = new RegExp(UPDATE_LINK_OR_BOLD.source, 'g');
  let m;
  while ((m = re.exec(raw))) {
    out += escapeUpdateText(raw.slice(last, m.index));
    if (m[1] !== undefined) {
      /* A link. The label may itself contain **bold**, so it goes through the
         bold pass; the URL never does — it is escaped and nothing else. */
      const label = renderUpdateBoldOnly(m[1]);
      out += '<a href="' + escapeUpdateText(m[2]) + '"'
        + ' style="color:#9a5b1d;text-decoration:underline;">' + label + '</a>';
    } else {
      out += '<strong>' + escapeUpdateText(m[3]) + '</strong>';
    }
    last = m.index + m[0].length;
  }
  out += escapeUpdateText(raw.slice(last));
  /* A single newline inside a paragraph is a line break the writer meant; a
     blank line has already split the paragraphs before this is called. */
  return out.replace(/\r?\n/g, '<br>');
}

function renderUpdateBoldOnly(raw) {
  let out = '';
  let last = 0;
  const re = /\*\*([^*\n]{1,300})\*\*/g;
  let m;
  while ((m = re.exec(raw))) {
    out += escapeUpdateText(raw.slice(last, m.index));
    out += '<strong>' + escapeUpdateText(m[1]) + '</strong>';
    last = m.index + m[0].length;
  }
  return out + escapeUpdateText(raw.slice(last));
}

/* The same message with the markers resolved for the plain-text part. A link
   keeps its URL in parentheses — in a text part a link that has lost its
   destination is a dead end — and bold simply loses its asterisks. */
function renderUpdatePlain(raw) {
  return String(raw)
    .replace(new RegExp(UPDATE_LINK_OR_BOLD.source, 'g'),
      (whole, label, url, bold) => (label !== undefined ? `${label} (${url})` : bold))
    .replace(/\r?\n{3,}/g, '\n\n')
    .trim();
}

// ---------- Email delivery ----------
// The question this answers is "did the customer actually get it?", which was
// previously unanswerable. Failures first, because those are the ones that need
// somebody to do something.
router.get('/email-log', requireCapability(C.CUSTOMERS_READ), asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const onlyFailed = req.query.failed === 'true';
  const { rows } = await db.query(
    `SELECT id, template, recipient, subject, status, error, created_at
       FROM email_log
      WHERE ($1::boolean IS NOT TRUE OR status = 'failed')
      ORDER BY created_at DESC
      LIMIT $2`,
    [onlyFailed, limit]
  );
  const { rows: summary } = await db.query(
    `SELECT status, count(*)::int AS n
       FROM email_log
      WHERE created_at > now() - interval '7 days'
      GROUP BY status ORDER BY n DESC`
  );
  res.json({ emails: rows, last7Days: summary });
}));

module.exports = router;
