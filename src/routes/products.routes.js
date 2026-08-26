const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { normaliseTerm } = require('../utils/text');

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
                      (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order LIMIT 1) AS image_url,
                      -- The shop grid needs to know a product has variants BEFORE
                      -- the detail page loads: without it, a quick-add on the grid
                      -- would put a variant product in the cart with no variant
                      -- chosen, and checkout would then reject the whole order.
                      EXISTS(SELECT 1 FROM product_variants v
                              WHERE v.product_id = p.id AND v.is_active = true) AS has_variants
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

// ---------- Public: categories ranked by real sales ----------
// Powers the homepage "Shop By Category" strip. Ranking is by units actually
// sold (paid orders only — pending/failed carts must not influence it), with
// product count as the tie-breaker so a brand-new category with no sales yet
// still surfaces above an empty one.
router.get('/meta/top-categories', async (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 7));
  try {
    const { rows } = await db.query(
      `SELECT p.category,
              COUNT(DISTINCT p.id)::int AS product_count,
              COALESCE(SUM(oi.quantity), 0)::int AS units_sold
       FROM products p
       LEFT JOIN order_items oi ON oi.product_id = p.id
       -- The status filter lives in the JOIN, not WHERE: in a WHERE clause it
       -- would turn this LEFT JOIN into an INNER JOIN and silently drop every
       -- category that has never sold anything.
       LEFT JOIN orders o ON o.id = oi.order_id
              AND o.status IN ('paid','processing','shipped','delivered')
       WHERE p.is_active = true AND p.category IS NOT NULL AND p.category <> ''
       GROUP BY p.category
       ORDER BY units_sold DESC, product_count DESC, p.category ASC
       LIMIT $1`,
      [limit]
    );
    res.json({ categories: rows });
  } catch (err) {
    console.error('[products] top-categories failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not load categories.' });
  }
});

// ---------- Public: single product by slug ----------
router.get('/:slug', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM products WHERE slug = $1 AND is_active = true', [req.params.slug]);
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found.' });
    const productId = result.rows[0].id;

    const images = await db.query(
      'SELECT url FROM product_images WHERE product_id = $1 ORDER BY sort_order',
      [productId]
    );
    const properties = await db.query(
      'SELECT property_name, property_value, color_hex FROM product_properties WHERE product_id = $1 ORDER BY sort_order',
      [productId]
    );
    const options = await db.query(
      'SELECT id, option_name, option_type FROM product_options WHERE product_id = $1 ORDER BY sort_order',
      [productId]
    );
    for (const opt of options.rows) {
      const values = await db.query(
        'SELECT id, value, color_hex FROM product_option_values WHERE option_id = $1 ORDER BY sort_order',
        [opt.id]
      );
      opt.values = values.rows;
    }
    const variants = await db.query(
      `SELECT id, sku, option_values, price_paise, stock_qty, image_url
       FROM product_variants WHERE product_id = $1 AND is_active = true ORDER BY created_at`,
      [productId]
    );

    res.json({
      product: result.rows[0],
      images: images.rows.map((r) => r.url),
      properties: properties.rows,
      options: options.rows,
      variants: variants.rows
    });
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
        [sku, name, slug, normaliseTerm(category), price_paise, mrp_paise, material, short_desc, long_desc,
          normaliseTerm(badge), stock_qty, hsn_code, gst_rate]
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

  // #19 — For a product with variants, stock_qty is DERIVED (a DB trigger keeps
  // it equal to the sum of its active variants). The product form still posts a
  // stock_qty field, so without this guard clicking "Save Product" would write
  // the stale number from that field straight over the freshly-calculated
  // total — which is exactly the "variant edits don't update the total" symptom.
  // Silently dropping it is right here: the value isn't the admin's to set, and
  // failing the whole save would block legitimate edits to name/price/etc.
  let stockOverrideIgnored = false;
  if (req.body.stock_qty !== undefined) {
    const { rows: vc } = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM product_variants WHERE product_id = $1',
      [req.params.id]
    );
    if (vc[0].cnt > 0) {
      delete req.body.stock_qty;
      stockOverrideIgnored = true;
    }
  }
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
  // #21 — canonical lowercase storage so "Malas"/"malas"/" MALAS " can never
  // become three separate categories in the shop filter.
  if (req.body.category !== undefined) req.body.category = normaliseTerm(req.body.category);
  if (req.body.badge !== undefined) req.body.badge = normaliseTerm(req.body.badge);

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
    res.json({ product: result.rows[0], stockOverrideIgnored });
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

// ============================================================
// Product Properties — informational display attributes only
// (e.g. "Material: Brass", "Origin: India"). NOT purchasable variants —
// see the Options/Variants section below for those.
// ============================================================

router.post(
  '/:id/properties',
  requireAuth,
  requireRole('admin', 'staff'),
  [
    body('property_name').trim().isLength({ min: 1, max: 60 }),
    body('property_value').trim().isLength({ min: 1, max: 120 }),
    body('color_hex').optional({ nullable: true }).matches(/^#[0-9A-Fa-f]{6}$/)
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const { rows } = await db.query(
        `INSERT INTO product_properties (product_id, property_name, property_value, color_hex, sort_order)
         VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order),0)+1 FROM product_properties WHERE product_id = $1))
         RETURNING *`,
        [req.params.id, req.body.property_name, req.body.property_value, req.body.color_hex || null]
      );
      res.status(201).json({ property: rows[0] });
    } catch (err) {
      console.error('[products] POST /:id/properties failed:', err.message, err.code || '');
      res.status(500).json({ error: 'Could not add property.', code: err.code || null });
    }
  }
);

router.delete('/:id/properties/:propertyId', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM product_properties WHERE id = $1 AND product_id = $2 RETURNING id',
      [req.params.propertyId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Property not found on this product.' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Could not remove property.' });
  }
});

// ============================================================
// Product Options & Variants — purchasable variations (Color, Size, etc).
// Each variant is an independently priced/stocked/imaged SKU. See the
// design note at the top of migrations/008_product_variants.sql.
// ============================================================

// ---------- Admin: create an option, optionally with its values in the same call ----------
router.post(
  '/:id/options',
  requireAuth,
  requireRole('admin', 'staff'),
  [
    body('option_name').trim().isLength({ min: 1, max: 60 }),
    body('option_type').isIn(['text', 'color']),
    body('values').optional().isArray()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { option_name, option_type, values } = req.body;

    try {
      const option = await db.withTransaction(async (client) => {
        const { rows: optRows } = await client.query(
          `INSERT INTO product_options (product_id, option_name, option_type, sort_order)
           VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort_order),0)+1 FROM product_options WHERE product_id = $1))
           RETURNING *`,
          [req.params.id, option_name, option_type]
        );
        const opt = optRows[0];
        opt.values = [];

        if (Array.isArray(values)) {
          for (const v of values) {
            if (!v || typeof v.value !== 'string' || !v.value.trim()) continue;
            if (option_type === 'color' && v.colorHex && !/^#[0-9A-Fa-f]{6}$/.test(v.colorHex)) {
              throw Object.assign(new Error(`Invalid color for value "${v.value}".`), { status: 400 });
            }
            const { rows: valRows } = await client.query(
              `INSERT INTO product_option_values (option_id, value, color_hex, sort_order)
               VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort_order),0)+1 FROM product_option_values WHERE option_id = $1))
               RETURNING *`,
              [opt.id, v.value.trim(), option_type === 'color' ? (v.colorHex || null) : null]
            );
            opt.values.push(valRows[0]);
          }
        }
        return opt;
      });
      res.status(201).json({ option });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'This product already has an option with that name.' });
      console.error('[products] POST /:id/options failed:', err.message, err.code || '');
      res.status(err.status || 500).json({ error: err.message || 'Could not create option.', code: err.code || null });
    }
  }
);

// ---------- Admin: add a single value to an existing option ----------
router.post(
  '/:id/options/:optionId/values',
  requireAuth,
  requireRole('admin', 'staff'),
  [body('value').trim().isLength({ min: 1, max: 80 }), body('colorHex').optional({ nullable: true }).matches(/^#[0-9A-Fa-f]{6}$/)],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const { rows } = await db.query(
        `INSERT INTO product_option_values (option_id, value, color_hex, sort_order)
         VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort_order),0)+1 FROM product_option_values WHERE option_id = $1))
         RETURNING *`,
        [req.params.optionId, req.body.value, req.body.colorHex || null]
      );
      res.status(201).json({ value: rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'This option already has that value.' });
      res.status(500).json({ error: 'Could not add value.', code: err.code || null });
    }
  }
);

router.patch(
  '/:id/options/:optionId/values/:valueId',
  requireAuth,
  requireRole('admin', 'staff'),
  [body('colorHex').optional({ nullable: true }).matches(/^#[0-9A-Fa-f]{6}$/), body('value').optional().isString().isLength({ min: 1, max: 80 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const updates = [];
    const params = [];
    if (req.body.value !== undefined) { params.push(req.body.value); updates.push(`value = $${params.length}`); }
    if (req.body.colorHex !== undefined) { params.push(req.body.colorHex); updates.push(`color_hex = $${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });

    params.push(req.params.valueId, req.params.optionId);
    try {
      const { rows } = await db.query(
        `UPDATE product_option_values SET ${updates.join(', ')}
         WHERE id = $${params.length - 1} AND option_id = $${params.length} RETURNING *`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: 'Option value not found.' });
      res.json({ value: rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'This option already has that value.' });
      res.status(500).json({ error: 'Could not update value.', code: err.code || null });
    }
  }
);

router.delete('/:id/options/:optionId', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    // Deleting an option cascades to its values (FK ON DELETE CASCADE), but
    // deliberately does NOT touch any variant that already references it —
    // variants store their own frozen option_values JSONB snapshot, exactly
    // like order_items do, so existing variants and past orders stay
    // historically accurate even after the option definition is removed.
    await db.query('DELETE FROM product_options WHERE id = $1 AND product_id = $2', [req.params.optionId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Could not remove option.' });
  }
});

router.delete('/:id/options/:optionId/values/:valueId', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    await db.query('DELETE FROM product_option_values WHERE id = $1 AND option_id = $2', [req.params.valueId, req.params.optionId]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Could not remove value.' });
  }
});

// ---------- Admin: full options+values+variants view (for the edit form) ----------
router.get('/:id/options-and-variants', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const { rows: options } = await db.query(
      'SELECT * FROM product_options WHERE product_id = $1 ORDER BY sort_order', [req.params.id]
    );
    for (const opt of options) {
      const { rows: values } = await db.query(
        'SELECT * FROM product_option_values WHERE option_id = $1 ORDER BY sort_order', [opt.id]
      );
      opt.values = values;
    }
    const { rows: variants } = await db.query(
      'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY created_at', [req.params.id]
    );
    res.json({ options, variants });
  } catch (err) {
    console.error('[products] GET /:id/options-and-variants failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not load options and variants.' });
  }
});

// ---------- Admin: create a variant ----------
router.post(
  '/:id/variants',
  requireAuth,
  requireRole('admin', 'staff'),
  [
    body('option_values').isArray({ min: 1 }),
    body('stock_qty').isInt({ min: 0 }),
    body('price_paise').optional({ nullable: true }).isInt({ min: 1 }),
    body('sku').optional({ nullable: true }).isString(),
    body('image_url').optional({ nullable: true }).isURL()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { option_values, stock_qty, price_paise, sku, image_url } = req.body;
    // Defensive shape-check on each entry — this JSONB blob is read back
    // verbatim on every product page load and every future order, so it's
    // worth rejecting anything malformed here rather than storing it.
    for (const ov of option_values) {
      if (!ov || typeof ov.option !== 'string' || typeof ov.value !== 'string') {
        return res.status(400).json({ error: 'Each option value needs an "option" and a "value".' });
      }
    }
    try {
      const { rows } = await db.query(
        `INSERT INTO product_variants (product_id, sku, option_values, price_paise, stock_qty, image_url)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        // JSON.stringify is REQUIRED here even though pg auto-serializes plain
        // objects for jsonb: pg converts a JS *array* into a Postgres ARRAY
        // literal ({"{...}"}) rather than JSON, which jsonb then rejects with
        // error 22P02. Objects (e.g. birth_details) are fine unstringified;
        // arrays are not. Verified against pg's own prepareValue().
        [req.params.id, sku || null, JSON.stringify(option_values), price_paise || null, stock_qty, image_url || null]
      );
      res.status(201).json({ variant: rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'A variant with this SKU already exists.' });
      console.error('[products] POST /:id/variants failed:', err.message, err.code || '');
      res.status(500).json({ error: 'Could not create variant.', code: err.code || null });
    }
  }
);

// ---------- Admin: update a variant ----------
router.put('/:id/variants/:variantId', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const allowed = ['sku', 'price_paise', 'stock_qty', 'image_url', 'is_active'];
  const updates = [];
  const params = [];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
  });
  if (req.body.option_values !== undefined) {
    params.push(JSON.stringify(req.body.option_values)); // array -> jsonb, see note in the POST handler above
    updates.push(`option_values = $${params.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });

  params.push(req.params.variantId, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE product_variants SET ${updates.join(', ')}, updated_at = now()
       WHERE id = $${params.length - 1} AND product_id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Variant not found.' });
    res.json({ variant: rows[0] });
  } catch (err) {
    console.error('[products] PUT /:id/variants/:variantId failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not update variant.', code: err.code || null });
  }
});

// ---------- Admin: remove a variant (soft delete — order history references it) ----------
router.delete('/:id/variants/:variantId', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    await db.query('UPDATE product_variants SET is_active = false WHERE id = $1 AND product_id = $2', [req.params.variantId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Could not remove variant.' });
  }
});

module.exports = router;
