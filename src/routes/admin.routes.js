const express = require('express');
const { body } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireRole, requireCapability, CAPABILITIES: C } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateUuidParam, handleValidation } = require('../middleware/validate');
const { restoreOrderStock, restoreOrderStockInTransaction, STOCK_RESTORED_STATUSES } = require('../utils/stock');
const { issueRefund } = require('../utils/refunds');
const { sendOrderStatusUpdate } = require('../utils/mailer');
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
    db.query("SELECT COALESCE(SUM(total_paise),0) AS total FROM orders WHERE status IN ('paid','processing','shipped','delivered','partially_refunded')"),
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

  const { rows: items } = await db.query(
    `SELECT id, product_id, product_name_snapshot, unit_price_paise, quantity, line_total_paise,
            variant_id, variant_snapshot
       FROM order_items WHERE order_id = $1 ORDER BY id`,
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
  const { search, category, badge } = req.query;
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
     WHERE status IN ('paid','processing','shipped','delivered','partially_refunded')
       AND created_at >= now() - make_interval(days => $1)
     GROUP BY 1 ORDER BY 1`,
    [days]
  );
  res.json({ days: rows, timezone: 'Asia/Kolkata' });
}));

router.get('/analytics/top-products', requireCapability(C.ANALYTICS_READ), asyncHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.category, SUM(oi.quantity) AS units_sold, SUM(oi.line_total_paise) AS revenue_paise
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     WHERE o.status IN ('paid','processing','shipped','delivered','partially_refunded')
     GROUP BY p.id, p.name, p.category
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
  const { rows } = await db.query(
    `SELECT id, name, sku, stock_qty, category FROM products
     WHERE is_active = true AND stock_qty <= $1
     ORDER BY stock_qty ASC LIMIT 100`,
    [threshold]
  );
  res.json({ products: rows });
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
            COUNT(o.id) FILTER (WHERE o.status IN ('paid','processing','shipped','delivered','partially_refunded')) AS completed_order_count,
            COALESCE(SUM(o.total_paise) FILTER (WHERE o.status IN ('paid','processing','shipped','delivered','partially_refunded')), 0) AS lifetime_value_paise
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

module.exports = router;
