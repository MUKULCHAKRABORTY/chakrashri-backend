const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- Public: list active services, optionally filtered by type ----------
router.get('/', async (req, res) => {
  const { type } = req.query;
  const conditions = ['is_active = true'];
  const queryParams = [];
  if (type) {
    if (!['puja', 'astrology'].includes(type)) {
      return res.status(400).json({ error: 'type must be "puja" or "astrology".' });
    }
    queryParams.push(type);
    conditions.push(`service_type = $${queryParams.length}`);
  }
  try {
    const { rows } = await db.query(
      `SELECT id, service_type, name, description, price_paise, duration_label
       FROM booking_services WHERE ${conditions.join(' AND ')} ORDER BY sort_order ASC, name ASC`,
      queryParams
    );
    res.json({ services: rows });
  } catch (err) {
    console.error('[booking-services] GET / failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not load services.' });
  }
});

// ---------- Admin: list ALL services (including inactive) ----------
router.get('/admin/all', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM booking_services ORDER BY service_type, sort_order ASC');
    res.json({ services: rows });
  } catch (err) {
    console.error('[booking-services] GET /admin/all failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not load services.' });
  }
});

// ---------- Admin: create a service ----------
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'staff'),
  [
    body('service_type').isIn(['puja', 'astrology']),
    body('name').trim().isLength({ min: 2 }),
    body('price_paise').isInt({ min: 1 }).toInt(), // .toInt() matters: JSON sends a real number, but if anything upstream
                                                      // ever stringifies it, isInt() alone validates without coercing the
                                                      // value actually used afterward — toInt() guarantees req.body.price_paise
                                                      // is a genuine JS integer by the time the handler runs, not a numeric string.
    body('duration_label').optional({ nullable: true }).isString().isLength({ max: 60 }),
    body('description').optional({ nullable: true }).isString(),
    body('sort_order').optional({ nullable: true }).isInt().toInt(),
    body('is_active').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { service_type, name, description, price_paise, duration_label, sort_order, is_active } = req.body;
    try {
      // Both inserts now share one transaction: if the audit-log write fails
      // for any reason, the whole thing rolls back and the admin sees an
      // honest failure — previously these were two separate queries, so an
      // audit-log failure could report "could not create service" to the
      // admin while the service had actually already been committed,
      // silently creating a duplicate on retry.
      const service = await db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO booking_services (service_type, name, description, price_paise, duration_label, sort_order, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [service_type, name, description || null, price_paise, duration_label || null, sort_order || 0, is_active !== false]
        );
        await client.query(
          `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id) VALUES ($1,'create_booking_service','booking_service',$2)`,
          [req.user.id, rows[0].id]
        );
        return rows[0];
      });
      res.status(201).json({ service });
    } catch (err) {
      // Logged in full server-side (visible in Render's Logs tab) so the
      // exact cause is diagnosable — the response to the client stays
      // generic plus a safe Postgres error code (e.g. '23505', '23514',
      // '42P01'), which is standard practice: identifies the failure class
      // without leaking query text, schema internals, or stack traces.
      console.error('[booking-services] POST / failed:', err.message, err.code || '', err.detail || '');
      res.status(500).json({ error: 'Could not create service.', code: err.code || null });
    }
  }
);

// ---------- Admin: update a service ----------
router.put('/:id', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const allowed = ['name', 'description', 'price_paise', 'duration_label', 'sort_order', 'is_active'];
  const updates = [];
  const params = [];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
  });
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });
  if (req.body.price_paise !== undefined && !(Number.isInteger(req.body.price_paise) && req.body.price_paise > 0)) {
    return res.status(400).json({ error: 'price_paise must be a positive integer.' });
  }

  params.push(req.params.id);
  try {
    const service = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE booking_services SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!rows.length) throw Object.assign(new Error('Service not found.'), { status: 404 });
      await client.query(
        `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id) VALUES ($1,'update_booking_service','booking_service',$2)`,
        [req.user.id, req.params.id]
      );
      return rows[0];
    });
    res.json({ service });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[booking-services] PUT /:id failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not update service.', code: err.code || null });
  }
});

// ---------- Admin: delete (soft) a service ----------
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await db.withTransaction(async (client) => {
      await client.query('UPDATE booking_services SET is_active = false WHERE id = $1', [req.params.id]);
      await client.query(
        `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id) VALUES ($1,'delete_booking_service','booking_service',$2)`,
        [req.user.id, req.params.id]
      );
    });
    res.status(204).send();
  } catch (err) {
    console.error('[booking-services] DELETE /:id failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not delete service.', code: err.code || null });
  }
});

module.exports = router;
