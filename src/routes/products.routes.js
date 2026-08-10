const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- Public: list products (with pagination + filters) ----------
router.get('/', async (req, res) => {
  const { category, search } = req.query;
  // Parse and clamp explicitly — req.query values are always strings, and an
  // unclamped limit (e.g. ?limit=999999999) would let any client force a
  // full-table scan/return, a cheap DoS vector against the DB.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
  const offset = (page - 1) * limit;
  const conditions = ['is_active = true'];
  const params = [];

  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`name ILIKE $${params.length}`);
  }

  params.push(limit, offset);
  const sql = `SELECT p.id, p.sku, p.name, p.slug, p.category, p.price_paise, p.mrp_paise, p.badge, p.rating,
                      p.review_count, p.stock_qty,
                      (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order LIMIT 1) AS image_url
               FROM products p
               WHERE ${conditions.join(' AND ')}
               ORDER BY p.created_at DESC
               LIMIT $${params.length - 1} OFFSET $${params.length}`;
  try {
    const result = await db.query(sql, params);
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load products.' });
  }
});

// ---------- Public: single product by slug ----------
router.get('/:slug', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM products WHERE slug = $1 AND is_active = true', [req.params.slug]);
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found.' });
    const images = await db.query(
      'SELECT url FROM product_images WHERE product_id = $1 ORDER BY sort_order',
      [result.rows[0].id]
    );
    res.json({ product: result.rows[0], images: images.rows.map((r) => r.url) });
  } catch (err) {
    res.status(500).json({ error: 'Could not load product.' });
  }
});

// ---------- Admin: create product ----------
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'staff'),
  [
    body('name').trim().isLength({ min: 2 }),
    body('slug').trim().isSlug(),
    body('price_paise').isInt({ min: 1 }),
    body('mrp_paise').isInt({ min: 1 }),
    body('category').notEmpty(),
    body('sku').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      sku, name, slug, category, price_paise, mrp_paise, material,
      short_desc, long_desc, badge, stock_qty = 0, hsn_code, gst_rate = 3
    } = req.body;

    try {
      const result = await db.query(
        `INSERT INTO products
          (sku, name, slug, category, price_paise, mrp_paise, material, short_desc, long_desc,
           badge, stock_qty, hsn_code, gst_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [sku, name, slug, category, price_paise, mrp_paise, material, short_desc, long_desc,
          badge, stock_qty, hsn_code, gst_rate]
      );
      await db.query(
        `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id)
         VALUES ($1, 'create_product', 'product', $2)`,
        [req.user.id, result.rows[0].id]
      );
      res.status(201).json({ product: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'SKU or slug already exists.' });
      res.status(500).json({ error: 'Could not create product.' });
    }
  }
);

// ---------- Admin: update product ----------
router.put('/:id', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const allowedFields = [
    'name', 'category', 'price_paise', 'mrp_paise', 'material', 'short_desc',
    'long_desc', 'badge', 'stock_qty', 'is_active', 'hsn_code', 'gst_rate'
  ];
  // The POST route validates types via express-validator; this route
  // previously had no equivalent check, so a malformed or malicious request
  // could set a negative price, negative stock, or an absurd GST rate.
  const numericChecks = {
    price_paise: (v) => Number.isInteger(v) && v > 0,
    mrp_paise: (v) => Number.isInteger(v) && v > 0,
    stock_qty: (v) => Number.isInteger(v) && v >= 0,
    gst_rate: (v) => typeof v === 'number' && v >= 0 && v <= 28
  };
  for (const [field, check] of Object.entries(numericChecks)) {
    if (req.body[field] !== undefined && !check(req.body[field])) {
      return res.status(400).json({ error: `Invalid value for ${field}.` });
    }
  }

  const updates = [];
  const params = [];
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      params.push(req.body[field]);
      updates.push(`${field} = $${params.length}`);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });

  params.push(req.params.id);
  try {
    const result = await db.query(
      `UPDATE products SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found.' });
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id)
       VALUES ($1, 'update_product', 'product', $2)`,
      [req.user.id, req.params.id]
    );
    res.json({ product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not update product.' });
  }
});

// ---------- Admin: delete (soft-delete) product ----------
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await db.query('UPDATE products SET is_active = false WHERE id = $1', [req.params.id]);
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id)
       VALUES ($1, 'delete_product', 'product', $2)`,
      [req.user.id, req.params.id]
    );
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Could not delete product.' });
  }
});

// ---------- Admin: add a product image ----------
// URL-based rather than file upload: Render's local disk doesn't persist
// across deploys, so a local-file upload endpoint would silently lose every
// image on the next deploy. Until real object storage (Cloudinary/S3, see
// README TODOs) is wired up, admins host images elsewhere (e.g. a CDN, or
// even a quick upload to Cloudinary's free tier manually) and paste the URL.
router.post('/:id/images', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const { url, sortOrder } = req.body;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'A valid image URL is required.' });
  }
  try {
    const { rows: productRows } = await db.query('SELECT id FROM products WHERE id = $1', [req.params.id]);
    if (!productRows.length) return res.status(404).json({ error: 'Product not found.' });

    const result = await db.query(
      'INSERT INTO product_images (product_id, url, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, url, Number.isInteger(sortOrder) ? sortOrder : 0]
    );
    res.status(201).json({ image: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not add image.' });
  }
});

// ---------- Admin: remove a product image ----------
router.delete('/:id/images/:imageId', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING id',
      [req.params.imageId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Image not found on this product.' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Could not remove image.' });
  }
});

// ============================================================
// Product Reviews — gated to verified (delivered) purchases only
// ============================================================

// ---------- Public: list reviews for a product ----------
router.get('/:id/reviews', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const offset = (page - 1) * limit;
  try {
    const { rows } = await db.query(
      `SELECT id, rating, comment, reviewer_name_snapshot, created_at
       FROM product_reviews WHERE product_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json({ reviews: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load reviews.' });
  }
});

// ---------- Auth: can the current user review this product? ----------
// Drives the frontend UI (show/hide the review form) — but the POST
// endpoint below re-checks this itself server-side regardless, since a
// client-side-only gate is never trustworthy on its own.
router.get('/:id/review-eligibility', requireAuth, async (req, res) => {
  try {
    const { rows: purchased } = await db.query(
      `SELECT 1 FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.product_id = $1 AND o.user_id = $2 AND o.status = 'delivered' LIMIT 1`,
      [req.params.id, req.user.id]
    );
    const { rows: existing } = await db.query(
      'SELECT id FROM product_reviews WHERE product_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({
      verifiedPurchase: purchased.length > 0,
      alreadyReviewed: existing.length > 0,
      canReview: purchased.length > 0 && existing.length === 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not check review eligibility.' });
  }
});

// ---------- Auth: submit a review (verified-purchase gated) ----------
router.post(
  '/:id/reviews',
  requireAuth,
  [
    body('rating').isInt({ min: 1, max: 5 }).toInt(),
    body('comment').optional({ nullable: true }).isString().isLength({ max: 2000 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { rating, comment } = req.body;
    try {
      const result = await db.withTransaction(async (client) => {
        // Re-verified here, server-side, regardless of what the eligibility
        // endpoint said earlier — that endpoint only drives UI; this is the
        // actual gate. A delivered order_item for this exact product is the
        // "verified purchase" bar, matching real e-commerce platforms.
        const { rows: purchased } = await client.query(
          `SELECT o.id FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE oi.product_id = $1 AND o.user_id = $2 AND o.status = 'delivered' LIMIT 1`,
          [req.params.id, req.user.id]
        );
        if (!purchased.length) {
          throw Object.assign(new Error('You can only review products from a delivered order.'), { status: 403 });
        }

        const { rows: userRows } = await client.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        const reviewerName = userRows[0] ? userRows[0].name : 'Verified Customer';

        let reviewRow;
        try {
          const { rows } = await client.query(
            `INSERT INTO product_reviews (product_id, user_id, order_id, rating, comment, reviewer_name_snapshot)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [req.params.id, req.user.id, purchased[0].id, rating, comment || null, reviewerName]
          );
          reviewRow = rows[0];
        } catch (err) {
          if (err.code === '23505') {
            throw Object.assign(new Error('You have already reviewed this product.'), { status: 409 });
          }
          throw err;
        }

        // Recompute the product's aggregate rating/count from real data —
        // avoids the two numbers ever drifting out of sync with the
        // underlying reviews, which a simple increment-on-write could do
        // over time (e.g. if a review is ever deleted by an admin later).
        const { rows: agg } = await client.query(
          'SELECT AVG(rating)::numeric(2,1) AS avg_rating, COUNT(*) AS cnt FROM product_reviews WHERE product_id = $1',
          [req.params.id]
        );
        await client.query('UPDATE products SET rating = $1, review_count = $2 WHERE id = $3', [
          agg[0].avg_rating, agg[0].cnt, req.params.id
        ]);

        return reviewRow;
      });
      res.status(201).json({ review: result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Could not submit review.' });
    }
  }
);

module.exports = router;
