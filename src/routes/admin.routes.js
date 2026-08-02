const express = require('express');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { restoreOrderStock, STOCK_RESTORED_STATUSES } = require('../utils/stock');

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

// ---------- Update order status (fulfillment) ----------
router.patch('/orders/:id/status', async (req, res) => {
  const { status, trackingNumber, courierName } = req.body;
  const allowed = ['processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  try {
    // Cancelling or refunding must restore the stock that was reserved at
    // order-creation time — this was previously missing entirely, meaning
    // an admin cancelling a paid order would permanently "lose" that
    // inventory from the catalog. restoreOrderStock is idempotent, so it's
    // safe even if a webhook already restored it for this order.
    if (STOCK_RESTORED_STATUSES.has(status)) {
      const result = await restoreOrderStock(req.params.id, status, 'admin_status_change', req.user.id);
      if (result.reason === 'order_not_found') {
        return res.status(404).json({ error: 'Order not found.' });
      }
      // If stock was already restored by something else (e.g. a webhook),
      // restoreOrderStock no-ops on stock but we still want the requested
      // status/tracking fields applied below, so fall through.
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
    // TODO: notify customer of status change (email/SMS/WhatsApp)
    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not update order status.' });
  }
});

module.exports = router;
