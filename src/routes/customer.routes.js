const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ---------- My orders ----------
router.get('/orders', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  try {
    const { rows } = await db.query(
      `SELECT o.id, o.order_number, o.status, o.total_paise, o.payment_method, o.tracking_number,
              o.courier_name, o.created_at,
              COALESCE(STRING_AGG(oi.product_name_snapshot, ', ' ORDER BY oi.id), '') AS product_names,
              COALESCE(SUM(oi.quantity), 0) AS total_quantity
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    res.json({ orders: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load your orders.' });
  }
});

// ---------- One order, with line items — ownership-checked ----------
router.get('/orders/:id', async (req, res) => {
  try {
    const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!orderRows.length) return res.status(404).json({ error: 'Order not found.' });
    // Ownership check: a customer can only view their own orders, even if
    // they guess or enumerate another order's UUID.
    if (orderRows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'This order does not belong to your account.' });
    }
    const { rows: items } = await db.query(
      `SELECT oi.product_id, oi.product_name_snapshot, oi.unit_price_paise, oi.quantity, oi.line_total_paise,
              oi.variant_id, oi.variant_snapshot,
              p.slug AS product_slug,
              EXISTS(
                SELECT 1 FROM product_reviews pr WHERE pr.product_id = oi.product_id AND pr.user_id = $2
              ) AS already_reviewed
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
      [req.params.id, req.user.id]
    );
    res.json({ order: orderRows[0], items });
  } catch (err) {
    res.status(500).json({ error: 'Could not load order.' });
  }
});

// ---------- My puja bookings ----------
router.get('/bookings/puja', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, puja_type, preferred_date, preferred_time_slot, status, payment_status, amount_paise, notes, created_at
       FROM puja_bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({ bookings: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load your bookings.' });
  }
});

// ---------- My astrology bookings ----------
// Deliberately excludes birth_details from the list view — sensitive under
// DPDP Act 2023, only returned on the single-booking detail endpoint below
// where ownership is explicitly re-checked.
router.get('/bookings/astrology', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, consultation_mode, preferred_date, preferred_time_slot, status, payment_status, amount_paise, created_at
       FROM astrology_bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({ bookings: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load your bookings.' });
  }
});

module.exports = router;
