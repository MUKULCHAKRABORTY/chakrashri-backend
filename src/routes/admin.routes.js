const express = require('express');
const db = require('../config/db');
const razorpay = require('../config/razorpay');
const { requireAuth, requireRole } = require('../middleware/auth');
const { restoreOrderStock, STOCK_RESTORED_STATUSES } = require('../utils/stock');
const { sendOrderStatusUpdate } = require('../utils/mailer');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'staff'));

// ---------- Dashboard overview stats ----------
router.get('/overview', async (req, res) => {
  try {
    const [products, orders, revenue, pujaBookings] = await Promise.all([
      db.query('SELECT COUNT(*) FROM products WHERE is_active = true'),
      db.query("SELECT COUNT(*) FROM orders WHERE status != 'payment_failed'"),
      db.query("SELECT COALESCE(SUM(total_paise),0) AS total FROM orders WHERE status IN ('paid','processing','shipped','delivered')"),
      db.query("SELECT COUNT(*) FROM puja_bookings WHERE status = 'requested'")
    ]);
    res.json({
      activeProducts: parseInt(products.rows[0].count, 10),
      totalOrders: parseInt(orders.rows[0].count, 10),
      totalRevenuePaise: parseInt(revenue.rows[0].total, 10),
      pendingPujaBookings: parseInt(pujaBookings.rows[0].count, 10)
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load dashboard stats.' });
  }
});

// ---------- Orders (real, paginated, with items) ----------
router.get('/orders', async (req, res) => {
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
    where = `WHERE status = $${params.length}`;
  }
  params.push(limit, offset);
  try {
    const result = await db.query(
      `SELECT o.*, u.name AS customer_name, u.email AS customer_email
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

// ---------- Single order detail, with line items (for the order detail view) ----------
router.get('/orders/:id', async (req, res) => {
  try {
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
    const { rows: items } = await db.query(
      'SELECT id, product_id, product_name_snapshot, unit_price_paise, quantity, line_total_paise, variant_id, variant_snapshot FROM order_items WHERE order_id = $1',
      [req.params.id]
    );
    res.json({ order: orderRows[0], items });
  } catch (err) {
    res.status(500).json({ error: 'Could not load order.' });
  }
});

// ---------- Update order status (fulfillment) ----------
router.patch('/orders/:id/status', async (req, res) => {
  const { status, trackingNumber, courierName, refundAmountPaise } = req.body;
  const allowed = ['processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  try {
    const { rows: existingRows } = await db.query(
      'SELECT id, status, total_paise, razorpay_payment_id FROM orders WHERE id = $1',
      [req.params.id]
    );
    if (!existingRows.length) return res.status(404).json({ error: 'Order not found.' });
    const existingOrder = existingRows[0];
    // #34 — "Money was collected" must mean money ACTUALLY captured through the
    // gateway, not merely that the order reached a fulfilment status. A COD
    // order sitting at 'processing' has had nothing captured: the cash is
    // collected at the door. Blocking 'cancelled' for it was wrong — there is
    // nothing to refund, and it left staff with no way to cancel a COD order
    // the customer had called to cancel. The gate is now the presence of a real
    // Razorpay payment id, which is the only thing that can actually be refunded.
    const hasCapturedPayment = !!existingOrder.razorpay_payment_id;
    const reachedFulfilment = ['paid', 'processing', 'shipped', 'delivered'].includes(existingOrder.status);
    const moneyWasCollected = hasCapturedPayment && reachedFulfilment;

    // A paid order can no longer be silently "cancelled" — that would restore
    // stock and hide the order from active fulfillment while Razorpay still
    // shows the payment as captured, meaning the customer paid for nothing
    // and no one would notice. Once money has moved, the only path back is
    // 'refunded', which actually returns it via the Razorpay Refunds API below.
    if (status === 'cancelled' && moneyWasCollected) {
      return res.status(409).json({
        error: 'This order has a captured online payment. Use "refunded" instead of "cancelled" so the customer actually gets their money back.'
      });
    }

    if (status === 'refunded') {
      if (!existingOrder.razorpay_payment_id) {
        return res.status(409).json({ error: 'This order has no captured payment to refund.' });
      }
      if (STOCK_RESTORED_STATUSES.has(existingOrder.status)) {
        return res.status(409).json({ error: `Order is already "${existingOrder.status}" — refund already handled or not applicable.` });
      }
      const amountToRefund = Number.isInteger(refundAmountPaise) && refundAmountPaise > 0
        ? Math.min(refundAmountPaise, existingOrder.total_paise) // never refund more than was actually paid
        : existingOrder.total_paise; // default: full refund

      let refund;
      try {
        refund = await razorpay.payments.refund(existingOrder.razorpay_payment_id, {
          amount: amountToRefund,
          speed: 'normal',
          notes: { reason: 'admin_initiated_refund', adminUserId: req.user.id }
        });
      } catch (err) {
        return res.status(502).json({ error: `Razorpay refund failed: ${err.error?.description || err.message}` });
      }
      await db.query(
        'UPDATE orders SET refund_id = $1, refunded_amount_paise = $2 WHERE id = $3',
        [refund.id, amountToRefund, req.params.id]
      );
    }

    // Cancelling or refunding must restore the stock that was reserved at
    // order-creation time — restoreOrderStock is idempotent, so it's safe
    // even if a webhook already restored it for this order.
    if (STOCK_RESTORED_STATUSES.has(status)) {
      const result = await restoreOrderStock(req.params.id, status, 'admin_status_change', req.user.id);
      if (result.reason === 'order_not_found') {
        return res.status(404).json({ error: 'Order not found.' });
      }
    }

    const result = await db.query(
      `UPDATE orders
       SET status = $1, tracking_number = COALESCE($2, tracking_number),
           courier_name = COALESCE($3, courier_name), updated_at = now()
       WHERE id = $4 RETURNING *`,
      [status, trackingNumber || null, courierName || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });

    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'update_order_status', 'order', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ status })]
    );

    // Fire-and-forget: a slow/failed email must never block the status
    // update itself from succeeding and being returned to the admin.
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
        console.error('[admin.routes] Failed to send order status update email:', err.message);
      }
    })();

    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not update order status.' });
  }
});

// ============================================================
// Admin product views — deliberately separate from the public
// GET /api/products endpoint, which always filters WHERE is_active = true
// and returns a limited field set. An admin needs to see (and reactivate)
// hidden/deactivated products too, and needs every field for editing.
// ============================================================
router.get('/products', async (req, res) => {
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
  try {
    // variant_count tells the admin UI whether this product's stock is a
    // derived figure (sum of its variants, maintained by a DB trigger) or a
    // directly-managed number — the two are edited in completely different
    // places, so showing a bare number without that context is misleading.
    // The WHERE columns need no `p.` prefix: `products p` is the only table in
    // this scope, and the subquery has its own alias, so there's no ambiguity.
    const { rows } = await db.query(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM product_variants v
                WHERE v.product_id = p.id AND v.is_active = true) AS variant_count
       FROM products p ${where}
       ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load products.' });
  }
});

router.get('/products/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Product not found.' });
    const { rows: images } = await db.query('SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order', [req.params.id]);
    const { rows: properties } = await db.query('SELECT * FROM product_properties WHERE product_id = $1 ORDER BY sort_order', [req.params.id]);
    const { rows: options } = await db.query('SELECT * FROM product_options WHERE product_id = $1 ORDER BY sort_order', [req.params.id]);
    for (const opt of options) {
      const { rows: values } = await db.query('SELECT * FROM product_option_values WHERE option_id = $1 ORDER BY sort_order', [opt.id]);
      opt.values = values;
    }
    const { rows: variants } = await db.query('SELECT * FROM product_variants WHERE product_id = $1 ORDER BY created_at', [req.params.id]);
    res.json({ product: rows[0], images, properties, options, variants });
  } catch (err) {
    res.status(500).json({ error: 'Could not load product.' });
  }
});

// ============================================================
// Analytics — power the dashboard's charts and summary widgets
// ============================================================

// ---------- Revenue by day, for a line/bar chart ----------
router.get('/analytics/revenue-by-day', async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  try {
    const { rows } = await db.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              COALESCE(SUM(total_paise), 0) AS revenue_paise,
              COUNT(*) AS order_count
       FROM orders
       WHERE status IN ('paid','processing','shipped','delivered')
         AND created_at >= now() - ($1 || ' days')::interval
       GROUP BY 1 ORDER BY 1`,
      [days]
    );
    res.json({ days: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load revenue analytics.' });
  }
});

// ---------- Best-selling products, for a leaderboard/bar chart ----------
router.get('/analytics/top-products', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.category, SUM(oi.quantity) AS units_sold, SUM(oi.line_total_paise) AS revenue_paise
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       WHERE o.status IN ('paid','processing','shipped','delivered')
       GROUP BY p.id, p.name, p.category
       ORDER BY units_sold DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load top-products analytics.' });
  }
});

// ---------- Order status breakdown, for a donut chart ----------
router.get('/analytics/order-status-breakdown', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT status, COUNT(*) AS count FROM orders GROUP BY status');
    res.json({ breakdown: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load order status breakdown.' });
  }
});

// ---------- Products running low on stock, for a dashboard alert widget ----------
router.get('/low-stock', async (req, res) => {
  const threshold = Math.min(1000, Math.max(0, parseInt(req.query.threshold, 10) || 5));
  try {
    const { rows } = await db.query(
      `SELECT id, name, sku, stock_qty, category FROM products
       WHERE is_active = true AND stock_qty <= $1
       ORDER BY stock_qty ASC LIMIT 100`,
      [threshold]
    );
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load low-stock products.' });
  }
});

// ============================================================
// Customers
// ============================================================
router.get('/customers', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const { search } = req.query;
  const params = [];
  let where = "WHERE role = 'customer'";
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }
  params.push(limit, offset);
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, u.created_at,
              COUNT(o.id) FILTER (WHERE o.status IN ('paid','processing','shipped','delivered')) AS completed_order_count,
              COALESCE(SUM(o.total_paise) FILTER (WHERE o.status IN ('paid','processing','shipped','delivered')), 0) AS lifetime_value_paise
       FROM users u
       LEFT JOIN orders o ON o.user_id = u.id
       ${where}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ customers: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

// ============================================================
// Audit log — every admin write action, for accountability at scale
// ============================================================
router.get('/audit-log', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = (page - 1) * limit;
  try {
    const { rows } = await db.query(
      `SELECT l.*, u.name AS admin_name, u.email AS admin_email
       FROM admin_audit_log l
       LEFT JOIN users u ON u.id = l.admin_user_id
       ORDER BY l.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ entries: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load audit log.' });
  }
});

module.exports = router;
