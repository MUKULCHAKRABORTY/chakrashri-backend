const express = require('express');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireCapability, CAPABILITIES: C } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateUuidParam, handleValidation } = require('../middleware/validate');
const { validateAndComputeCoupon } = require('../utils/coupons');
const { validateAndAggregateCart } = require('../utils/orders');
const { logger } = require('../utils/logger');

const router = express.Router();
router.param('id', validateUuidParam('id'));

/**
 * BIZ-01 — coupon codes are guessable, and this endpoint used to answer
 * "is DIWALI50 a real code?" with a distinct 404 at up to 200 requests per 15
 * minutes per IP. That is a dictionary attack against private and influencer-
 * specific codes with the server doing the checking for free.
 *
 * Keyed by user rather than IP: the thing being protected is the coupon
 * catalog, and an authenticated account is the unit an attacker has to spend to
 * keep guessing.
 */
const couponAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.COUPON_VALIDATE_RATE_LIMIT_MAX || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id) || req.ip,
  message: { error: 'Too many coupon attempts. Please wait a few minutes and try again.' }
});

// ---------- Customer: validate a coupon against the current cart ----------
/**
 * This is what the "Apply" button at checkout calls. It does NOT lock the
 * coupon row or record a redemption — that only happens for real inside
 * reserveStockAndCreateOrder, at the moment the order is actually placed. This
 * endpoint exists purely to give the customer fast, accurate feedback before
 * they commit.
 *
 * BIZ-01, the other half: it used to accept `subtotalPaise` straight from the
 * request body, so anyone could claim a ₹50,000 cart to see what a
 * high-minimum coupon would give. No money was ever at risk — the real
 * redemption recomputes the subtotal server-side inside the transaction — but
 * the preview could lie, and a preview that disagrees with checkout is a
 * support ticket every time. It now prices the ACTUAL cart, exactly as
 * checkout will.
 */
router.post(
  '/validate',
  requireAuth,
  couponAttemptLimiter,
  [
    body('code').trim().isLength({ min: 1, max: 40 }),
    body('items').optional().isArray({ max: 100 }),
    body('subtotalPaise').optional().isInt({ min: 0 }),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    // DEPLOY-SKEW FALLBACK, deliberately kept.
    //
    // The storefront is deployed to Netlify separately from this API, so for a
    // few minutes after an API deploy an older client is still sending only
    // `subtotalPaise`. Hard-failing those requests would break the Apply button
    // for real customers mid-deploy to fix an issue that was never a money risk
    // (checkout always recomputed the subtotal server-side anyway).
    //
    // So: when `items` is present the cart is priced from the database and the
    // preview is authoritative. When it is absent we fall back to the client's
    // figure and label the response `verified: false`, which is exactly the old
    // behaviour and no worse. Remove this branch once the storefront has been
    // deployed and the field is always sent.
    const hasItems = Array.isArray(req.body.items) && req.body.items.length > 0;

    if (!hasItems) {
      const claimed = parseInt(req.body.subtotalPaise, 10);
      if (!Number.isInteger(claimed) || claimed < 0) {
        return res.status(400).json({ error: 'Please send your cart items to check this coupon.' });
      }
      try {
        const { coupon, discountPaise } = await validateAndComputeCoupon({
          code: req.body.code, userId: req.user.id, subtotalPaise: claimed
        });
        return res.json({
          valid: true, verified: false,
          code: coupon.code, description: coupon.description,
          discountPaise, subtotalPaise: claimed
        });
      } catch (err) {
        logger.info('Coupon validation rejected (unverified cart)', { userId: req.user.id });
        return res.status(400).json({ valid: false, error: err.message || 'This coupon cannot be applied to your cart.' });
      }
    }

    let aggregated;
    try {
      aggregated = validateAndAggregateCart(req.body.items);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    // Price the cart from the database, never from the client. Same query shape
    // checkout uses, minus the row locks — this is a read-only preview and must
    // not hold locks a customer might abandon.
    const productIds = [...new Set(aggregated.map((i) => i.productId))];
    const variantIds = aggregated.filter((i) => i.variantId).map((i) => i.variantId);

    const [{ rows: products }, variantResult] = await Promise.all([
      db.query('SELECT id, price_paise FROM products WHERE id = ANY($1) AND is_active = true', [productIds]),
      variantIds.length
        ? db.query('SELECT id, product_id, price_paise FROM product_variants WHERE id = ANY($1) AND is_active = true', [variantIds])
        : Promise.resolve({ rows: [] })
    ]);
    const variants = variantResult.rows;

    let subtotalPaise = 0;
    for (const item of aggregated) {
      const product = products.find((p) => p.id === item.productId);
      if (!product) return res.status(400).json({ error: 'One of the items in your cart is no longer available.' });
      let unitPrice = Number(product.price_paise);
      if (item.variantId) {
        const variant = variants.find((v) => v.id === item.variantId && v.product_id === item.productId);
        if (!variant) return res.status(400).json({ error: 'One of the selected options is no longer available.' });
        if (variant.price_paise != null) unitPrice = Number(variant.price_paise);
      }
      subtotalPaise += unitPrice * item.quantity;
    }

    try {
      const { coupon, discountPaise } = await validateAndComputeCoupon({
        code: req.body.code,
        userId: req.user.id,
        subtotalPaise
      });
      res.json({
        valid: true,
        verified: true,
        code: coupon.code,
        description: coupon.description,
        discountPaise,
        subtotalPaise
      });
    } catch (err) {
      // Every rejection reason returns 400 with the same shape. Distinguishing
      // "no such code" (404) from "not applicable" (400) told an attacker which
      // of their guesses were real codes — the one thing this endpoint must not
      // reveal. The customer-facing message still explains what to do.
      logger.info('Coupon validation rejected', { userId: req.user.id, reason: err.status });
      res.status(400).json({ valid: false, error: err.message || 'This coupon cannot be applied to your cart.' });
    }
  })
);

// ---------- Admin: list all coupons ----------
router.get('/admin/all', requireAuth, requireCapability(C.COUPONS_READ), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM coupon_redemptions r WHERE r.coupon_id = c.id) AS redemption_count
       FROM coupons c ORDER BY c.created_at DESC LIMIT 500`
  );
  res.json({ coupons: rows });
}));

// ---------- Admin: create a coupon ----------
router.post(
  '/',
  requireAuth,
  requireCapability(C.COUPONS_WRITE),
  [
    // Restricted to the character set a customer can actually type without
    // ambiguity. A code containing a space or a lookalike character generates
    // support tickets, not redemptions.
    body('code').trim().isLength({ min: 3, max: 40 }).matches(/^[A-Za-z0-9_-]+$/)
      .withMessage('Coupon codes may contain only letters, numbers, hyphens and underscores.'),
    body('description').optional({ nullable: true }).isString().isLength({ max: 200 }),
    body('discount_type').isIn(['percentage', 'fixed']),
    body('discount_percent').if(body('discount_type').equals('percentage')).isFloat({ min: 0.01, max: 100 }).toFloat(),
    body('discount_value_paise').if(body('discount_type').equals('fixed')).isInt({ min: 1 }).toInt(),
    body('max_discount_paise').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
    body('min_order_paise').optional({ nullable: true }).isInt({ min: 0 }).toInt(),
    body('usage_limit_total').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
    body('usage_limit_per_customer').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
    body('valid_from').optional({ nullable: true }).isISO8601(),
    body('valid_until').optional({ nullable: true }).isISO8601(),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const {
      code, description, discount_type, discount_percent, discount_value_paise,
      max_discount_paise, min_order_paise, usage_limit_total, usage_limit_per_customer,
      valid_from, valid_until, is_active
    } = req.body;

    // A window that closes before it opens creates a coupon that can never be
    // used, which then generates a support ticket when a customer tries.
    if (valid_from && valid_until && new Date(valid_until) <= new Date(valid_from)) {
      return res.status(400).json({ error: 'The end date must be after the start date.' });
    }

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
        `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
         VALUES ($1,'create_coupon','coupon',$2,$3)`,
        [req.user.id, rows[0].id, JSON.stringify({
          code: rows[0].code, discount_type, discount_percent, discount_value_paise, usage_limit_total
        })]
      );
      res.status(201).json({ coupon: rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'A coupon with this code already exists.' });
      throw err;
    }
  })
);

// ---------- Admin: update a coupon ----------
router.put('/:id', requireAuth, requireCapability(C.COUPONS_WRITE), asyncHandler(async (req, res) => {
  const allowed = [
    'description', 'discount_percent', 'discount_value_paise', 'max_discount_paise',
    'min_order_paise', 'usage_limit_total', 'usage_limit_per_customer', 'valid_from', 'valid_until', 'is_active'
  ];

  // The create route validates every one of these; this one validated none, so
  // a 500%-off coupon or a negative minimum could be written straight in. The
  // discount is clamped at redemption time so no money could actually be lost —
  // but a coupon that displays "500% off" to a customer is its own problem.
  const checks = {
    discount_percent: (v) => v === null || (typeof v === 'number' && v > 0 && v <= 100),
    discount_value_paise: (v) => v === null || (Number.isInteger(v) && v > 0),
    max_discount_paise: (v) => v === null || (Number.isInteger(v) && v > 0),
    min_order_paise: (v) => Number.isInteger(v) && v >= 0,
    usage_limit_total: (v) => v === null || (Number.isInteger(v) && v >= 1),
    usage_limit_per_customer: (v) => Number.isInteger(v) && v >= 1,
    is_active: (v) => typeof v === 'boolean',
    description: (v) => v === null || (typeof v === 'string' && v.length <= 200)
  };
  for (const [field, check] of Object.entries(checks)) {
    if (req.body[field] !== undefined && !check(req.body[field])) {
      return res.status(400).json({ error: `Invalid value for ${field}.` });
    }
  }
  for (const field of ['valid_from', 'valid_until']) {
    if (req.body[field] !== undefined && req.body[field] !== null && Number.isNaN(Date.parse(req.body[field]))) {
      return res.status(400).json({ error: `Invalid date for ${field}.` });
    }
  }

  const updates = [];
  const params = [];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
  });
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });

  params.push(req.params.id);
  const { rows } = await db.query(
    `UPDATE coupons SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'Coupon not found.' });

  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
     VALUES ($1,'update_coupon','coupon',$2,$3)`,
    [req.user.id, req.params.id, JSON.stringify({ fields: Object.keys(req.body).filter((k) => allowed.includes(k)) })]
  );
  res.json({ coupon: rows[0] });
}));

// ---------- Admin: deactivate a coupon (soft delete — redemption history must survive) ----------
router.delete('/:id', requireAuth, requireCapability(C.COUPONS_WRITE), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'UPDATE coupons SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Coupon not found.' });
  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id) VALUES ($1,'deactivate_coupon','coupon',$2)`,
    [req.user.id, req.params.id]
  );
  res.status(204).send();
}));

module.exports = router;
