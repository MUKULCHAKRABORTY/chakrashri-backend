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
  const sql = `SELECT id, sku, name, slug, category, price_paise, mrp_paise, badge, rating,
                      review_count, stock_qty
               FROM products
               WHERE ${conditions.join(' AND ')}
               ORDER BY created_at DESC
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

module.exports = router;
