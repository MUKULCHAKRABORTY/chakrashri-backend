const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateAndComputeCoupon } = require('../utils/coupons');

const router = express.Router();

// ---------- Customer: validate a coupon against the current cart (preview only, no redemption) ----------
// This is what the "Apply" button at checkout calls. It does NOT lock the
// coupon row or record a redemption — that only happens for real inside
// reserveStockAndCreateOrder, at the moment the order is actually placed.
// This endpoint exists purely to give the customer fast, accurate feedback
// before they commit to checkout.
router.post(
  '/validate',
  requireAuth,
  [body('code').trim().notEmpty(), body('subtotalPaise').isInt({ min: 0 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Please enter a coupon code.' });

    try {
      const { coupon, discountPaise } = await validateAndComputeCoupon({
        code: req.body.code,
        userId: req.user.id,
        subtotalPaise: req.body.subtotalPaise
      });
      res.json({
        valid: true,
        code: coupon.code,
        description: coupon.description,
        discountPaise
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Could not validate coupon.' });
    }
  }
);

// ---------- Admin: list all coupons ----------
router.get('/admin/all', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json({ coupons: rows });
  } catch (err) {
    console.error('[coupons] GET /admin/all failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not load coupons.' });
  }
});

// ---------- Admin: create a coupon ----------
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'staff'),
  [
    body('code').trim().isLength({ min: 3, max: 40 }),
    body('discount_type').isIn(['percentage', 'fixed']),
    body('discount_percent').if(body('discount_type').equals('percentage')).isFloat({ min: 0.01, max: 100 }),
    body('discount_value_paise').if(body('discount_type').equals('fixed')).isInt({ min: 1 }),
    body('max_discount_paise').optional({ nullable: true }).isInt({ min: 1 }),
    body('min_order_paise').optional({ nullable: true }).isInt({ min: 0 }),
    body('usage_limit_total').optional({ nullable: true }).isInt({ min: 1 }),
    body('usage_limit_per_customer').optional({ nullable: true }).isInt({ min: 1 }),
    body('valid_until').optional({ nullable: true }).isISO8601()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      code, description, discount_type, discount_percent, discount_value_paise,
      max_discount_paise, min_order_paise, usage_limit_total, usage_limit_per_customer,
      valid_from, valid_until, is_active
    } = req.body;

    try {
      const { rows } = await db.query(
        `INSERT INTO coupons
          (code, description, discount_type, discount_percent, discount_value_paise, max_discount_paise,
           min_order_paise, usage_limit_total, usage_limit_per_customer, valid_from, valid_until, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          code.trim().toUpperCase(), description || null, discount_type,
          discount_type === 'percentage' ? discount_percent : null,
          discount_type === 'fixed' ? discount_value_paise : null,
          max_discount_paise || null, min_order_paise || 0,
          usage_limit_total || null, usage_limit_per_customer || 1,
          valid_from || new Date().toISOString(), valid_until || null, is_active !== false
        ]
      );
      await db.query(
        `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id) VALUES ($1,'create_coupon','coupon',$2)`,
        [req.user.id, rows[0].id]
      );
      res.status(201).json({ coupon: rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'A coupon with this code already exists.' });
      console.error('[coupons] POST / failed:', err.message, err.code || '');
      res.status(500).json({ error: 'Could not create coupon.', code: err.code || null });
    }
  }
);

// ---------- Admin: update a coupon ----------
router.put('/:id', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const allowed = [
    'description', 'discount_percent', 'discount_value_paise', 'max_discount_paise',
    'min_order_paise', 'usage_limit_total', 'usage_limit_per_customer', 'valid_from', 'valid_until', 'is_active'
  ];
  const updates = [];
  const params = [];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
  });
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });

  params.push(req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE coupons SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Coupon not found.' });
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id) VALUES ($1,'update_coupon','coupon',$2)`,
      [req.user.id, req.params.id]
    );
    res.json({ coupon: rows[0] });
  } catch (err) {
    console.error('[coupons] PUT /:id failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not update coupon.', code: err.code || null });
  }
});

// ---------- Admin: deactivate a coupon (soft delete — redemption history must survive) ----------
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await db.query('UPDATE coupons SET is_active = false WHERE id = $1', [req.params.id]);
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id) VALUES ($1,'deactivate_coupon','coupon',$2)`,
      [req.user.id, req.params.id]
    );
    res.status(204).send();
  } catch (err) {
    console.error('[coupons] DELETE /:id failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not deactivate coupon.', code: err.code || null });
  }
});

module.exports = router;
