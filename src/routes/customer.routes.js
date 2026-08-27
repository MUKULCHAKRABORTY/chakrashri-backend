const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateUuidParam } = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);
router.param('id', validateUuidParam('id'));

// ---------- My orders ----------
router.get('/orders', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const { rows } = await db.query(
    `SELECT o.id, o.order_number, o.status, o.total_paise, o.payment_method, o.tracking_number,
            o.courier_name, o.created_at, o.refunded_amount_paise,
            COALESCE(STRING_AGG(oi.product_name_snapshot, ', ' ORDER BY oi.id), '') AS product_names,
            COALESCE(SUM(oi.quantity), 0) AS total_quantity,
            COUNT(*) OVER() AS total_count
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.user_id = $1
     GROUP BY o.id
     ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]
  );
  res.json({
    orders: rows.map(({ total_count, ...row }) => row),
    pagination: {
      page, limit,
      totalCount: rows.length ? Number(rows[0].total_count) : 0
    }
  });
}));

// ---------- One order, with line items — ownership-checked ----------
router.get('/orders/:id', asyncHandler(async (req, res) => {
  // The ownership check is in the WHERE clause rather than a read-then-compare.
  // Functionally equivalent for a correct implementation, but it removes the
  // possibility of a future edit adding an early `return res.json(order)`
  // before the check — and a 404 rather than a 403 tells an enumerator nothing
  // about whether the id exists at all.
  const { rows: orderRows } = await db.query(
    `SELECT id, order_number, status, subtotal_paise, shipping_paise, gst_paise, discount_paise,
            total_paise, coupon_code, payment_method, tracking_number, courier_name,
            refunded_amount_paise, shipping_address_snapshot, created_at, updated_at
       FROM orders WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!orderRows.length) return res.status(404).json({ error: 'Order not found.' });

  const { rows: items } = await db.query(
    `SELECT oi.product_id, oi.product_name_snapshot, oi.unit_price_paise, oi.quantity, oi.line_total_paise,
            oi.variant_id, oi.variant_snapshot,
            p.slug AS product_slug,
            EXISTS(
              SELECT 1 FROM product_reviews pr WHERE pr.product_id = oi.product_id AND pr.user_id = $2
            ) AS already_reviewed
     FROM order_items oi
     LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [req.params.id, req.user.id]
  );
  res.json({ order: orderRows[0], items });
}));

// ---------- My puja bookings ----------
router.get('/bookings/puja', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT pb.id, pb.puja_type, pb.preferred_date, pb.preferred_time_slot, pb.scheduled_at, pb.status,
            pb.payment_status, pb.amount_paise, pb.notes, pb.created_at,
            pb.refund_id, pb.refunded_amount_paise,
            COALESCE(bs.name, pb.puja_type) AS service_name,
            s.label AS slot_label
     FROM puja_bookings pb
     LEFT JOIN booking_services bs ON bs.id = pb.service_id
     LEFT JOIN availability_slots s ON s.id = pb.slot_id
     WHERE pb.user_id = $1 ORDER BY pb.created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ bookings: rows });
}));

// ---------- My astrology bookings ----------
// Deliberately excludes birth_details from the list view — sensitive under
// DPDP Act 2023, only returned on the single-booking detail endpoint below
// where ownership is explicitly re-checked.
router.get('/bookings/astrology', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ab.id, ab.consultation_mode, ab.preferred_date, ab.preferred_time_slot, ab.scheduled_at, ab.status,
            ab.payment_status, ab.amount_paise, ab.created_at,
            ab.refund_id, ab.refunded_amount_paise,
            COALESCE(bs.name, ab.consultation_mode) AS service_name,
            s.label AS slot_label
     FROM astrology_bookings ab
     LEFT JOIN booking_services bs ON bs.id = ab.service_id
     LEFT JOIN availability_slots s ON s.id = ab.slot_id
     WHERE ab.user_id = $1 ORDER BY ab.created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ bookings: rows });
}));

// ---------- One astrology booking, including the customer's OWN birth details ----------
// The customer is the data subject, so returning their own birth details to
// them is exactly what the DPDP Act contemplates. Scoped by user_id in the
// WHERE clause so it can only ever be their own.
router.get('/bookings/astrology/:id', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ab.id, ab.consultation_mode, ab.preferred_date, ab.preferred_time_slot, ab.scheduled_at,
            ab.status, ab.payment_status, ab.amount_paise, ab.contact_name, ab.contact_phone,
            ab.birth_details, ab.refund_id, ab.refunded_amount_paise, ab.created_at,
            COALESCE(bs.name, ab.consultation_mode) AS service_name
       FROM astrology_bookings ab
       LEFT JOIN booking_services bs ON bs.id = ab.service_id
      WHERE ab.id = $1 AND ab.user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ booking: rows[0] });
}));

/**
 * DPDP Act 2023 — data portability.
 *
 * The Act grants a right of access to one's own personal data, and there was no
 * endpoint that provided it: answering a request meant an engineer running SQL
 * by hand against production. This assembles everything held about the
 * requesting account, scoped by user_id throughout, and is deliberately
 * self-service so the obligation is met without anyone touching a database
 * console.
 */
router.get('/me/data-export', asyncHandler(async (req, res) => {
  const [profile, addresses, orders, orderItems, pujaBookings, astroBookings, reviews, redemptions] = await Promise.all([
    db.query(`SELECT id, name, email, phone, role, email_verified, created_at, updated_at
                FROM users WHERE id = $1`, [req.user.id]),
    db.query(`SELECT id, full_name, phone, email, line1, line2, city, state, pincode, country,
                     is_default, created_at, deleted_at
                FROM addresses WHERE user_id = $1`, [req.user.id]),
    db.query(`SELECT id, order_number, status, subtotal_paise, shipping_paise, gst_paise, discount_paise,
                     total_paise, coupon_code, payment_method, tracking_number, courier_name,
                     shipping_address_snapshot, refunded_amount_paise, created_at
                FROM orders WHERE user_id = $1 ORDER BY created_at`, [req.user.id]),
    db.query(`SELECT oi.order_id, oi.product_name_snapshot, oi.unit_price_paise, oi.quantity,
                     oi.line_total_paise, oi.variant_snapshot
                FROM order_items oi JOIN orders o ON o.id = oi.order_id
               WHERE o.user_id = $1 ORDER BY oi.order_id`, [req.user.id]),
    db.query(`SELECT id, puja_type, preferred_date, preferred_time_slot, status, payment_status,
                     amount_paise, contact_name, contact_phone, notes, created_at
                FROM puja_bookings WHERE user_id = $1 ORDER BY created_at`, [req.user.id]),
    db.query(`SELECT id, consultation_mode, preferred_date, preferred_time_slot, status, payment_status,
                     amount_paise, contact_name, contact_phone, birth_details, created_at
                FROM astrology_bookings WHERE user_id = $1 ORDER BY created_at`, [req.user.id]),
    db.query(`SELECT r.id, r.rating, r.comment, r.reviewer_name_snapshot, r.created_at, p.name AS product_name
                FROM product_reviews r JOIN products p ON p.id = r.product_id
               WHERE r.user_id = $1 ORDER BY r.created_at`, [req.user.id]),
    db.query(`SELECT cr.id, c.code, cr.discount_applied_paise, cr.created_at
                FROM coupon_redemptions cr JOIN coupons c ON c.id = cr.coupon_id
               WHERE cr.user_id = $1 ORDER BY cr.created_at`, [req.user.id])
  ]);

  const itemsByOrder = orderItems.rows.reduce((acc, item) => {
    (acc[item.order_id] = acc[item.order_id] || []).push(item);
    return acc;
  }, {});

  res.set('Content-Disposition', `attachment; filename="chakrashri-my-data-${Date.now()}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    notice: 'This file contains the personal data Chakrashri holds about your account.',
    profile: profile.rows[0] || null,
    addresses: addresses.rows,
    orders: orders.rows.map((o) => ({ ...o, items: itemsByOrder[o.id] || [] })),
    pujaBookings: pujaBookings.rows,
    astrologyBookings: astroBookings.rows,
    reviews: reviews.rows,
    couponRedemptions: redemptions.rows
  });
}));

module.exports = router;
