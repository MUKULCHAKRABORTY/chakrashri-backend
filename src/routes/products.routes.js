const express = require('express');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireRole, requireCapability, CAPABILITIES: C } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateUuidParam, handleValidation, isUuid } = require('../middleware/validate');
const { normaliseTerm } = require('../utils/text');
const { recomputeProductRating } = require('../utils/reviews');
const { getSettings } = require('../utils/settings');
const { logger } = require('../utils/logger');

const router = express.Router();

// HYG-02 — every :id / :variantId / :optionId / :valueId / :imageId /
// :propertyId in this file is a UUID. Without these, a crawler hitting
// /api/products/wp-admin/reviews made Postgres raise 22P02 and the route
// returned 500 — a client error reported as a server error, polluting error
// monitoring and telling the caller their input reached the database.
['id', 'variantId', 'optionId', 'valueId', 'imageId', 'propertyId'].forEach((name) => {
  router.param(name, validateUuidParam(name));
});

// BIZ-05 — review submission had no limiter beyond the global 200/15min budget.
const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.REVIEW_RATE_LIMIT_MAX || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id) || req.ip,
  message: { error: 'You have submitted several reviews recently. Please try again later.' }
});

// The columns the storefront actually renders. Enumerated rather than SELECT *
// so a future internal column (cost price, supplier, margin) is not published
// to every visitor the moment it is added (HYG-04).
const PUBLIC_PRODUCT_COLUMNS = `
  p.id, p.sku, p.name, p.slug, p.category, p.price_paise, p.mrp_paise, p.material,
  p.short_desc, p.long_desc, p.badge, p.rating, p.review_count, p.stock_qty,
  p.hsn_code, p.gst_rate, p.created_at
`;

// ---------- Public: list products (with pagination + filters) ----------
router.get('/', asyncHandler(async (req, res) => {
  const { category, search } = req.query;
  // Parse and clamp explicitly — req.query values are always strings, and an
  // unclamped limit (e.g. ?limit=999999999) would let any client force a
  // full-table scan/return, a cheap DoS vector against the DB.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
  const offset = (page - 1) * limit;
  const conditions = ['p.is_active = true'];
  const params = [];

  if (category) {
    params.push(normaliseTerm(category));
    conditions.push(`p.category = $${params.length}`);
  }
  if (search) {
    // HYG-07 — still ILIKE, but now backed by the pg_trgm GIN indexes added in
    // migration 014, so the leading wildcard no longer forces a sequential scan.
    // Searching sku as well as name matters for staff and for customers quoting
    // a code from an invoice. Bounded so a 10KB "search term" cannot be used to
    // make Postgres do expensive trigram work.
    params.push(`%${String(search).slice(0, 80)}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
  }

  params.push(limit, offset);
  const sql = `SELECT ${PUBLIC_PRODUCT_COLUMNS},
                      (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order LIMIT 1) AS image_url,
                      -- The shop grid needs to know a product has variants BEFORE
                      -- the detail page loads: without it, a quick-add on the grid
                      -- would put a variant product in the cart with no variant
                      -- chosen, and checkout would then reject the whole order.
                      EXISTS(SELECT 1 FROM product_variants v
                              WHERE v.product_id = p.id AND v.is_active = true) AS has_variants,
                      COUNT(*) OVER() AS total_count
               FROM products p
               WHERE ${conditions.join(' AND ')}
               ORDER BY p.created_at DESC
               LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await db.query(sql, params);
  const totalCount = result.rows.length ? Number(result.rows[0].total_count) : 0;
  res.json({
    products: result.rows.map(({ total_count, ...row }) => row),
    // The endpoint returned a bare array before, so the storefront could not
    // render a page count — only "next" and find out afterwards.
    pagination: { page, limit, totalCount, totalPages: Math.max(1, Math.ceil(totalCount / limit)) }
  });
}));

// ---------- Public: categories ranked by real sales ----------
// Powers the homepage "Shop By Category" strip. Ranking is by units actually
// sold (paid orders only — pending/failed carts must not influence it), with
// product count as the tie-breaker so a brand-new category with no sales yet
// still surfaces above an empty one.
router.get('/meta/top-categories', asyncHandler(async (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 7));
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
            AND o.status IN ('paid','processing','shipped','delivered','partially_refunded')
     WHERE p.is_active = true AND p.category IS NOT NULL AND p.category <> ''
     GROUP BY p.category
     ORDER BY units_sold DESC, product_count DESC, p.category ASC
     LIMIT $1`,
    [limit]
  );
  res.json({ categories: rows });
}));

// ---------- Public: every active slug, for sitemap generation (SEO-01) ----------
// scripts/generate-sitemap.js consumes this. Kept deliberately tiny and cheap:
// it is fetched by a build step, not by visitors.
router.get('/meta/slugs', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT slug, category, updated_at FROM products WHERE is_active = true ORDER BY updated_at DESC LIMIT 5000`
  );
  res.set('Cache-Control', 'public, max-age=600');
  res.json({ products: rows });
}));

// ---------- Public: single product by slug ----------
router.get('/:slug', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT ${PUBLIC_PRODUCT_COLUMNS} FROM products p WHERE p.slug = $1 AND p.is_active = true`,
    [req.params.slug]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Product not found.' });
  const productId = result.rows[0].id;

  // Four independent reads issued together rather than sequentially. On a
  // managed Postgres like Neon each round-trip is real latency, and this is the
  // single most-requested authenticated-free endpoint on the site.
  const [images, properties, options, variants] = await Promise.all([
    db.query('SELECT url FROM product_images WHERE product_id = $1 ORDER BY sort_order', [productId]),
    db.query('SELECT property_name, property_value, color_hex FROM product_properties WHERE product_id = $1 ORDER BY sort_order', [productId]),
    db.query('SELECT id, option_name, option_type FROM product_options WHERE product_id = $1 ORDER BY sort_order', [productId]),
    db.query(
      `SELECT id, sku, option_values, price_paise, stock_qty, image_url
       FROM product_variants WHERE product_id = $1 AND is_active = true ORDER BY created_at`,
      [productId]
    )
  ]);

  // One query for all option values instead of one per option — the previous
  // version looped and awaited inside the loop, so a product with eight options
  // cost eight sequential round-trips (a textbook N+1).
  const optionIds = options.rows.map((o) => o.id);
  const { rows: allValues } = optionIds.length
    ? await db.query(
      'SELECT id, option_id, value, color_hex FROM product_option_values WHERE option_id = ANY($1) ORDER BY sort_order',
      [optionIds]
    )
    : { rows: [] };
  const valuesByOption = allValues.reduce((acc, v) => {
    (acc[v.option_id] = acc[v.option_id] || []).push(v);
    return acc;
  }, {});

  res.json({
    product: result.rows[0],
    images: images.rows.map((r) => r.url),
    properties: properties.rows,
    options: options.rows.map((o) => ({ ...o, values: valuesByOption[o.id] || [] })),
    variants: variants.rows
  });
}));

// ---------- Admin: create product ----------
router.post(
  '/',
  requireAuth,
  requireCapability(C.CATALOG_WRITE),
  [
    body('name').trim().isLength({ min: 2, max: 200 }),
    body('slug').trim().isSlug().isLength({ max: 220 }),
    body('price_paise').isInt({ min: 1 }).toInt(),
    body('mrp_paise').isInt({ min: 1 }).toInt(),
    body('category').trim().notEmpty().isLength({ max: 80 }),
    body('sku').trim().notEmpty().isLength({ max: 60 }),
    body('stock_qty').optional().isInt({ min: 0 }).toInt(),
    body('gst_rate').optional().isFloat({ min: 0, max: 28 }).toFloat(),
    // These two MUST match the caps PUT /:id enforces. Without them a product
    // could be created with a 600-character short_desc and then never edited
    // again — every save re-sends the description unchanged, so the update was
    // rejected forever, including a price or stock correction. A create route
    // that is more permissive than its update route is a trap.
    body('short_desc').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('long_desc').optional({ nullable: true }).isString().isLength({ max: 20000 }),
    body('material').optional({ nullable: true }).isString().isLength({ max: 120 }),
    body('badge').optional({ nullable: true }).isString().isLength({ max: 40 }),
    body('hsn_code').optional({ nullable: true }).isString().isLength({ max: 10 }),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
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
        `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
         VALUES ($1, 'create_product', 'product', $2, $3)`,
        [req.user.id, result.rows[0].id, JSON.stringify({ sku, slug, name, price_paise })]
      );
      res.status(201).json({ product: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'SKU or slug already exists.' });
      throw err;
    }
  })
);

// ---------- Admin: update product ----------
router.put('/:id', requireAuth, requireCapability(C.CATALOG_WRITE), asyncHandler(async (req, res) => {
  const allowedFields = [
    'name', 'category', 'price_paise', 'mrp_paise', 'material', 'short_desc',
    'long_desc', 'badge', 'stock_qty', 'is_active', 'hsn_code', 'gst_rate'
  ];

  // For a product with variants, stock_qty is DERIVED (a DB trigger keeps it
  // equal to the sum of its active variants). The product form still posts a
  // stock_qty field, so without this guard clicking "Save Product" would write
  // the stale number from that field straight over the freshly-calculated
  // total. Silently dropping it is right here: the value isn't the admin's to
  // set, and failing the whole save would block legitimate edits to name/price.
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

  // The POST route validates types via express-validator; this route previously
  // had no equivalent check, so a malformed or malicious request could set a
  // negative price, negative stock, or an absurd GST rate.
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
  // Length bounds the POST route enforces and this one did not — a 10MB
  // long_desc would be accepted and then served to every visitor.
  // Length caps, applied ONLY to values that actually changed.
  //
  // Rows created before these caps existed can exceed them. The admin form
  // re-sends every field on every save, so a blanket check would reject an
  // unrelated price or stock edit on a legacy product and leave it permanently
  // uneditable. Comparing against what is stored means the cap blocks new
  // over-length content while never trapping an existing row.
  const lengthChecks = { name: 200, category: 80, material: 120, badge: 40, hsn_code: 10, short_desc: 500, long_desc: 20000 };
  const submittedLongFields = Object.entries(lengthChecks).filter(
    ([field, max]) => req.body[field] !== undefined && req.body[field] !== null && String(req.body[field]).length > max
  );
  if (submittedLongFields.length) {
    const { rows: currentRows } = await db.query(
      'SELECT name, category, material, badge, hsn_code, short_desc, long_desc FROM products WHERE id = $1',
      [req.params.id]
    );
    if (!currentRows.length) return res.status(404).json({ error: 'Product not found.' });
    for (const [field, max] of submittedLongFields) {
      const unchanged = String(req.body[field]) === String(currentRows[0][field] ?? '');
      if (!unchanged) {
        return res.status(400).json({
          error: `${field} is too long (max ${max} characters).`
        });
      }
    }
  }
  if (req.body.is_active !== undefined && typeof req.body.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be true or false.' });
  }

  const updates = [];
  const params = [];
  // Canonical lowercase storage so "Malas"/"malas"/" MALAS " can never become
  // three separate categories in the shop filter.
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
  const result = await db.query(
    `UPDATE products SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Product not found.' });

  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
     VALUES ($1, 'update_product', 'product', $2, $3)`,
    [req.user.id, req.params.id, JSON.stringify({ fields: Object.keys(req.body).filter((k) => allowedFields.includes(k)) })]
  );
  res.json({ product: result.rows[0], stockOverrideIgnored });
}));

// ---------- Admin: delete (soft-delete) product ----------
router.delete('/:id', requireAuth, requireCapability(C.CATALOG_DELETE), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'UPDATE products SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Product not found.' });
  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id)
     VALUES ($1, 'delete_product', 'product', $2)`,
    [req.user.id, req.params.id]
  );
  res.status(204).send();
}));

// ---------- Admin: add a product image ----------
// URL-based rather than file upload: Render's local disk doesn't persist across
// deploys, so a local-file upload endpoint would silently lose every image on
// the next deploy. Until real object storage (Cloudinary/S3) is wired up, admins
// host images elsewhere and paste the URL.
router.post('/:id/images', requireAuth, requireCapability(C.CATALOG_WRITE), asyncHandler(async (req, res) => {
  const { url, sortOrder } = req.body;
  // https only, and a length bound. An http:// image on an https page is a
  // mixed-content block in every modern browser, so it would silently not
  // render — better to reject it here than to debug a blank product page later.
  if (typeof url !== 'string' || !/^https:\/\/[^\s"'<>]{4,2000}$/i.test(url)) {
    return res.status(400).json({ error: 'A valid https:// image URL is required.' });
  }
  const { rows: productRows } = await db.query('SELECT id FROM products WHERE id = $1', [req.params.id]);
  if (!productRows.length) return res.status(404).json({ error: 'Product not found.' });

  const result = await db.query(
    'INSERT INTO product_images (product_id, url, sort_order) VALUES ($1, $2, $3) RETURNING *',
    [req.params.id, url, Number.isInteger(sortOrder) ? sortOrder : 0]
  );
  res.status(201).json({ image: result.rows[0] });
}));

// ---------- Admin: remove a product image ----------
router.delete('/:id/images/:imageId', requireAuth, requireCapability(C.CATALOG_WRITE), asyncHandler(async (req, res) => {
  const result = await db.query(
    'DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING id',
    [req.params.imageId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Image not found on this product.' });
  res.status(204).send();
}));

// ============================================================
// Product Reviews — gated to verified (delivered) purchases only
// ============================================================

// ---------- Public: list reviews for a product ----------
router.get('/:id/reviews', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const offset = (page - 1) * limit;
  // BIZ-05 — hidden reviews disappear from the storefront. Without this filter
  // moderation would be cosmetic: an admin could mark a review hidden and it
  // would keep rendering on the product page.
  const { rows } = await db.query(
    `SELECT id, rating, comment, reviewer_name_snapshot, created_at,
            COUNT(*) OVER() AS total_count
     FROM product_reviews WHERE product_id = $1 AND is_approved = true
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [req.params.id, limit, offset]
  );
  res.json({
    reviews: rows.map(({ total_count, ...row }) => row),
    totalCount: rows.length ? Number(rows[0].total_count) : 0
  });
}));

// ---------- Auth: can the current user review this product? ----------
// Drives the frontend UI (show/hide the review form) — but the POST endpoint
// below re-checks this itself server-side regardless, since a client-side-only
// gate is never trustworthy on its own.
router.get('/:id/review-eligibility', requireAuth, asyncHandler(async (req, res) => {
  const [purchased, existing, account] = await Promise.all([
    db.query(
      `SELECT 1 FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.product_id = $1 AND o.user_id = $2 AND o.status = 'delivered' LIMIT 1`,
      [req.params.id, req.user.id]
    ),
    db.query('SELECT id FROM product_reviews WHERE product_id = $1 AND user_id = $2', [req.params.id, req.user.id]),
    db.query('SELECT email_verified FROM users WHERE id = $1', [req.user.id])
  ]);
  const emailVerified = account.rows.length ? account.rows[0].email_verified : false;
  res.json({
    verifiedPurchase: purchased.rows.length > 0,
    alreadyReviewed: existing.rows.length > 0,
    emailVerified,
    canReview: purchased.rows.length > 0 && existing.rows.length === 0 && emailVerified
  });
}));

// ---------- Auth: submit a review (verified-purchase gated) ----------
router.post(
  '/:id/reviews',
  requireAuth,
  reviewLimiter,
  [
    body('rating').isInt({ min: 1, max: 5 }).toInt(),
    body('comment').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { rating, comment } = req.body;
    const settings = await getSettings();

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

        // AUTH-04 — an unverified account can place a COD order, receive it and
        // then post a "verified purchase" review under any name it likes. Email
        // verification is the cheap control that closes that loop.
        const { rows: userRows } = await client.query(
          'SELECT name, email_verified FROM users WHERE id = $1',
          [req.user.id]
        );
        if (!userRows.length) throw Object.assign(new Error('Account not found.'), { status: 404 });
        if (!userRows[0].email_verified) {
          throw Object.assign(
            new Error('Please verify your email address before posting a review. You can resend the link from your account page.'),
            { status: 403 }
          );
        }
        const reviewerName = userRows[0].name || 'Verified Customer';

        let reviewRow;
        try {
          const { rows } = await client.query(
            `INSERT INTO product_reviews (product_id, user_id, order_id, rating, comment, reviewer_name_snapshot, is_approved)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [req.params.id, req.user.id, purchased[0].id, rating, comment || null, reviewerName,
              // BIZ-05 — publish immediately by default (today's behaviour), or
              // hold for moderation if the shop owner flips the setting. No
              // deploy needed to switch, which matters the first time a review
              // arrives that should never have gone live.
              !settings.reviews_require_approval]
          );
          reviewRow = rows[0];
        } catch (err) {
          if (err.code === '23505') {
            throw Object.assign(new Error('You have already reviewed this product.'), { status: 409 });
          }
          throw err;
        }

        // Recompute the product's aggregate from real APPROVED data — avoids
        // the two numbers ever drifting out of sync, and means a hidden review
        // actually stops counting towards the star rating.
        await recomputeProductRating(client, req.params.id);

        return reviewRow;
      });
      res.status(201).json({
        review: result,
        pendingApproval: !result.is_approved
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  })
);

// ============================================================
// Product Properties — informational display attributes only
// (e.g. "Material: Brass", "Origin: India"). NOT purchasable variants —
// see the Options/Variants section below for those.
// ============================================================

router.post(
  '/:id/properties',
  requireAuth,
  requireCapability(C.CATALOG_WRITE),
  [
    body('property_name').trim().isLength({ min: 1, max: 60 }),
    body('property_value').trim().isLength({ min: 1, max: 120 }),
    body('color_hex').optional({ nullable: true }).matches(/^#[0-9A-Fa-f]{6}$/),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    // The FK would catch a missing product, but as a 500 with a Postgres error
    // code rather than a 404 with a sentence.
    const { rows: exists } = await db.query('SELECT id FROM products WHERE id = $1', [req.params.id]);
    if (!exists.length) return res.status(404).json({ error: 'Product not found.' });

    const { rows } = await db.query(
      `INSERT INTO product_properties (product_id, property_name, property_value, color_hex, sort_order)
       VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order),0)+1 FROM product_properties WHERE product_id = $1))
       RETURNING *`,
      [req.params.id, req.body.property_name, req.body.property_value, req.body.color_hex || null]
    );
    res.status(201).json({ property: rows[0] });
  })
);

router.delete('/:id/properties/:propertyId', requireAuth, requireCapability(C.CATALOG_WRITE), asyncHandler(async (req, res) => {
  const result = await db.query(
    'DELETE FROM product_properties WHERE id = $1 AND product_id = $2 RETURNING id',
    [req.params.propertyId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Property not found on this product.' });
  res.status(204).send();
}));

// ============================================================
// Product Options & Variants — purchasable variations (Color, Size, etc).
// Each variant is an independently priced/stocked/imaged SKU. See the
// design note at the top of migrations/008_product_variants.sql.
// ============================================================

router.post(
  '/:id/options',
  requireAuth,
  requireCapability(C.CATALOG_WRITE),
  [
    body('option_name').trim().isLength({ min: 1, max: 60 }),
    body('option_type').isIn(['text', 'color']),
    body('values').optional().isArray({ max: 100 }),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { option_name, option_type, values } = req.body;

    const { rows: exists } = await db.query('SELECT id FROM products WHERE id = $1', [req.params.id]);
    if (!exists.length) return res.status(404).json({ error: 'Product not found.' });

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
            if (v.value.length > 80) {
              throw Object.assign(new Error(`Option value "${v.value.slice(0, 20)}…" is too long.`), { status: 400 });
            }
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
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  })
);

router.post(
  '/:id/options/:optionId/values',
  requireAuth,
  requireCapability(C.CATALOG_WRITE),
  [
    body('value').trim().isLength({ min: 1, max: 80 }),
    body('colorHex').optional({ nullable: true }).matches(/^#[0-9A-Fa-f]{6}$/),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    // Scoped to this product, so an option id belonging to a different product
    // cannot be extended through this route.
    const { rows: owns } = await db.query(
      'SELECT id FROM product_options WHERE id = $1 AND product_id = $2',
      [req.params.optionId, req.params.id]
    );
    if (!owns.length) return res.status(404).json({ error: 'Option not found on this product.' });

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
      throw err;
    }
  })
);

router.patch(
  '/:id/options/:optionId/values/:valueId',
  requireAuth,
  requireCapability(C.CATALOG_WRITE),
  [
    body('colorHex').optional({ nullable: true }).matches(/^#[0-9A-Fa-f]{6}$/),
    body('value').optional().isString().isLength({ min: 1, max: 80 }),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { rows: owns } = await db.query(
      'SELECT id FROM product_options WHERE id = $1 AND product_id = $2',
      [req.params.optionId, req.params.id]
    );
    if (!owns.length) return res.status(404).json({ error: 'Option not found on this product.' });

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
      throw err;
    }
  })
);

router.delete('/:id/options/:optionId', requireAuth, requireCapability(C.CATALOG_WRITE), asyncHandler(async (req, res) => {
  // Deleting an option cascades to its values (FK ON DELETE CASCADE), but
  // deliberately does NOT touch any variant that already references it —
  // variants store their own frozen option_values JSONB snapshot, exactly like
  // order_items do, so existing variants and past orders stay historically
  // accurate even after the option definition is removed.
  const { rowCount } = await db.query(
    'DELETE FROM product_options WHERE id = $1 AND product_id = $2',
    [req.params.optionId, req.params.id]
  );
  // Returning 204 for a delete that matched nothing told the admin UI the
  // option was gone when it never existed on that product.
  if (!rowCount) return res.status(404).json({ error: 'Option not found on this product.' });
  res.status(204).send();
}));

router.delete('/:id/options/:optionId/values/:valueId', requireAuth, requireCapability(C.CATALOG_WRITE), asyncHandler(async (req, res) => {
  const { rowCount } = await db.query(
    'DELETE FROM product_option_values WHERE id = $1 AND option_id = $2',
    [req.params.valueId, req.params.optionId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Option value not found.' });
  res.status(204).send();
}));

// ---------- Admin: full options+values+variants view (for the edit form) ----------
router.get('/:id/options-and-variants', requireAuth, requireCapability(C.CATALOG_READ), asyncHandler(async (req, res) => {
  const [options, variants] = await Promise.all([
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
  res.json({
    options: options.rows.map((o) => ({ ...o, values: valuesByOption[o.id] || [] })),
    variants: variants.rows
  });
}));

// ---------- Admin: create a variant ----------
router.post(
  '/:id/variants',
  requireAuth,
  requireCapability(C.CATALOG_WRITE),
  [
    body('option_values').isArray({ min: 1, max: 10 }),
    body('stock_qty').isInt({ min: 0 }).toInt(),
    body('price_paise').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
    body('sku').optional({ nullable: true }).isString().isLength({ max: 60 }),
    body('image_url').optional({ nullable: true }).isURL({ protocols: ['https'], require_protocol: true }),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { option_values, stock_qty, price_paise, sku, image_url } = req.body;
    // Defensive shape-check on each entry — this JSONB blob is read back
    // verbatim on every product page load and every future order, so it's
    // worth rejecting anything malformed here rather than storing it.
    for (const ov of option_values) {
      if (!ov || typeof ov.option !== 'string' || typeof ov.value !== 'string'
          || ov.option.length > 60 || ov.value.length > 80) {
        return res.status(400).json({ error: 'Each option value needs a valid "option" and "value".' });
      }
    }

    const { rows: exists } = await db.query('SELECT id FROM products WHERE id = $1', [req.params.id]);
    if (!exists.length) return res.status(404).json({ error: 'Product not found.' });

    try {
      const { rows } = await db.query(
        `INSERT INTO product_variants (product_id, sku, option_values, price_paise, stock_qty, image_url)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        // JSON.stringify is REQUIRED here even though pg auto-serializes plain
        // objects for jsonb: pg converts a JS *array* into a Postgres ARRAY
        // literal ({"{...}"}) rather than JSON, which jsonb then rejects with
        // error 22P02. Objects are fine unstringified; arrays are not.
        [req.params.id, sku || null, JSON.stringify(option_values), price_paise || null, stock_qty, image_url || null]
      );
      res.status(201).json({ variant: rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'A variant with this SKU already exists.' });
      throw err;
    }
  })
);

// ---------- Admin: update a variant ----------
router.put('/:id/variants/:variantId', requireAuth, requireCapability(C.CATALOG_WRITE), asyncHandler(async (req, res) => {
  const allowed = ['sku', 'price_paise', 'stock_qty', 'image_url', 'is_active'];

  // Same class of gap the PUT /:id route had: no type checking at all, so a
  // negative variant stock or a zero price could be written directly.
  if (req.body.price_paise !== undefined && req.body.price_paise !== null
      && !(Number.isInteger(req.body.price_paise) && req.body.price_paise > 0)) {
    return res.status(400).json({ error: 'price_paise must be a positive integer, or null to inherit the product price.' });
  }
  if (req.body.stock_qty !== undefined && !(Number.isInteger(req.body.stock_qty) && req.body.stock_qty >= 0)) {
    return res.status(400).json({ error: 'stock_qty must be a non-negative integer.' });
  }
  if (req.body.is_active !== undefined && typeof req.body.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be true or false.' });
  }
  if (req.body.image_url !== undefined && req.body.image_url !== null
      && !/^https:\/\/[^\s"'<>]{4,2000}$/i.test(String(req.body.image_url))) {
    return res.status(400).json({ error: 'image_url must be a valid https:// URL.' });
  }

  const updates = [];
  const params = [];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
  });
  if (req.body.option_values !== undefined) {
    if (!Array.isArray(req.body.option_values) || !req.body.option_values.length) {
      return res.status(400).json({ error: 'option_values must be a non-empty array.' });
    }
    params.push(JSON.stringify(req.body.option_values)); // array -> jsonb, see note in the POST handler
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
    if (err.code === '23505') return res.status(409).json({ error: 'A variant with this SKU already exists.' });
    throw err;
  }
}));

// ---------- Admin: remove a variant (soft delete — order history references it) ----------
router.delete('/:id/variants/:variantId', requireAuth, requireCapability(C.CATALOG_WRITE), asyncHandler(async (req, res) => {
  const { rowCount } = await db.query(
    'UPDATE product_variants SET is_active = false, updated_at = now() WHERE id = $1 AND product_id = $2',
    [req.params.variantId, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Variant not found.' });
  res.status(204).send();
}));

module.exports = router;
