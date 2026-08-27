const express = require('express');
const { body } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireCapability, CAPABILITIES: C } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateUuidParam, handleValidation, isUuid } = require('../middleware/validate');

const router = express.Router();
router.param('id', validateUuidParam('id'));

// ---------- Public: list active services, optionally filtered by type ----------
router.get('/', asyncHandler(async (req, res) => {
  const { type } = req.query;
  const conditions = ['bs.is_active = true'];
  const queryParams = [];
  if (type) {
    if (!['puja', 'astrology'].includes(type)) {
      return res.status(400).json({ error: 'type must be "puja" or "astrology".' });
    }
    queryParams.push(type);
    conditions.push(`bs.service_type = $${queryParams.length}`);
  }
  // has_slots tells the storefront whether it must show a slot picker for this
  // service — the same information the shop grid needs about product variants,
  // and for the same reason: without it the customer submits a booking that the
  // server then rejects for a reason the UI never mentioned.
  const { rows } = await db.query(
    `SELECT bs.id, bs.service_type, bs.name, bs.description, bs.price_paise, bs.duration_label,
            EXISTS(
              SELECT 1 FROM availability_slots s
               WHERE s.is_active = true AND s.starts_at > now()
                 AND s.service_type = bs.service_type
                 AND (s.service_id = bs.id OR s.service_id IS NULL)
            ) AS has_slots
     FROM booking_services bs
     WHERE ${conditions.join(' AND ')}
     ORDER BY bs.sort_order ASC, bs.name ASC`,
    queryParams
  );
  res.json({ services: rows });
}));

// ---------- Admin: list ALL services (including inactive) ----------
router.get('/admin/all', requireAuth, requireCapability(C.BOOKINGS_READ), asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM booking_services ORDER BY service_type, sort_order ASC');
  res.json({ services: rows });
}));

// ---------- Admin: create a service ----------
router.post(
  '/',
  requireAuth,
  requireCapability(C.BOOKINGS_WRITE),
  [
    body('service_type').isIn(['puja', 'astrology']),
    body('name').trim().isLength({ min: 2, max: 150 }),
    // .toInt() matters: JSON sends a real number, but if anything upstream ever
    // stringifies it, isInt() alone validates without coercing the value
    // actually used afterward — toInt() guarantees req.body.price_paise is a
    // genuine JS integer by the time the handler runs, not a numeric string.
    body('price_paise').isInt({ min: 1 }).toInt(),
    body('duration_label').optional({ nullable: true }).isString().isLength({ max: 60 }),
    body('description').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    body('sort_order').optional({ nullable: true }).isInt().toInt(),
    body('is_active').optional().isBoolean(),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    // HYG-01 — the previous version of this handler carried a live production
    // diagnostic: a `to_regclass('public.booking_services')` probe checking
    // whether the table was visible on the transaction's connection, plus a
    // `failedStatement` tag and a `step` field echoed back to the client. That
    // was written to chase a specific past incident; it is not something a
    // production endpoint should do on every call, and returning the internal
    // step name (and the Postgres SQLSTATE alongside it) tells a caller far more
    // about the schema than they should learn from an error. Removed. The
    // structured logger now carries the same diagnostic value with none of the
    // exposure.
    const { service_type, name, description, price_paise, duration_label, sort_order, is_active } = req.body;

    const service = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO booking_services (service_type, name, description, price_paise, duration_label, sort_order, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [service_type, name, description || null, price_paise, duration_label || null, sort_order || 0, is_active !== false]
      );
      await client.query(
        `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
         VALUES ($1,'create_booking_service','booking_service',$2,$3)`,
        [req.user.id, rows[0].id, JSON.stringify({ name, service_type, price_paise })]
      );
      return rows[0];
    });
    res.status(201).json({ service });
  })
);

// ---------- Admin: update a service ----------
router.put('/:id', requireAuth, requireCapability(C.BOOKINGS_WRITE), asyncHandler(async (req, res) => {
  const allowed = ['name', 'description', 'price_paise', 'duration_label', 'sort_order', 'is_active'];

  if (req.body.price_paise !== undefined && !(Number.isInteger(req.body.price_paise) && req.body.price_paise > 0)) {
    return res.status(400).json({ error: 'price_paise must be a positive integer.' });
  }
  if (req.body.is_active !== undefined && typeof req.body.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be true or false.' });
  }
  if (req.body.name !== undefined && String(req.body.name).trim().length < 2) {
    return res.status(400).json({ error: 'Service name is too short.' });
  }

  const updates = [];
  const params = [];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
  });
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });

  params.push(req.params.id);
  try {
    const service = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE booking_services SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!rows.length) throw Object.assign(new Error('Service not found.'), { status: 404 });
      await client.query(
        `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
         VALUES ($1,'update_booking_service','booking_service',$2,$3)`,
        [req.user.id, req.params.id, JSON.stringify({ fields: Object.keys(req.body).filter((k) => allowed.includes(k)) })]
      );
      return rows[0];
    });
    res.json({ service });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    throw err;
  }
}));

// ---------- Admin: delete (soft) a service ----------
router.delete('/:id', requireAuth, requireCapability(C.BOOKINGS_WRITE), asyncHandler(async (req, res) => {
  const found = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'UPDATE booking_services SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!rows.length) return false;
    await client.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id) VALUES ($1,'delete_booking_service','booking_service',$2)`,
      [req.user.id, req.params.id]
    );
    return true;
  });
  if (!found) return res.status(404).json({ error: 'Service not found.' });
  res.status(204).send();
}));

// ============================================================
// Practitioners and availability slots (BIZ-02)
// ============================================================

router.get('/practitioners', requireAuth, requireCapability(C.BOOKINGS_READ), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM practitioners ORDER BY is_active DESC, full_name ASC LIMIT 500'
  );
  res.json({ practitioners: rows });
}));

router.post(
  '/practitioners',
  requireAuth,
  requireCapability(C.BOOKINGS_WRITE),
  [
    body('full_name').trim().isLength({ min: 2, max: 120 }),
    body('practitioner_type').isIn(['puja', 'astrology', 'both']),
    body('phone').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 20 }),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
    body('bio').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    body('languages').optional({ nullable: true }).isString().isLength({ max: 200 }),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { full_name, practitioner_type, phone, email, bio, languages } = req.body;
    const { rows } = await db.query(
      `INSERT INTO practitioners (full_name, practitioner_type, phone, email, bio, languages)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [full_name, practitioner_type, phone || null, email || null, bio || null, languages || null]
    );
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES ($1,'create_practitioner','practitioner',$2,$3)`,
      [req.user.id, rows[0].id, JSON.stringify({ full_name, practitioner_type })]
    );
    res.status(201).json({ practitioner: rows[0] });
  })
);

router.put('/practitioners/:id', requireAuth, requireCapability(C.BOOKINGS_WRITE), asyncHandler(async (req, res) => {
  const allowed = ['full_name', 'practitioner_type', 'phone', 'email', 'bio', 'languages', 'is_active'];
  if (req.body.practitioner_type !== undefined && !['puja', 'astrology', 'both'].includes(req.body.practitioner_type)) {
    return res.status(400).json({ error: 'practitioner_type must be puja, astrology or both.' });
  }
  if (req.body.is_active !== undefined && typeof req.body.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be true or false.' });
  }
  const updates = [];
  const params = [];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
  });
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });
  params.push(req.params.id);
  const { rows } = await db.query(
    `UPDATE practitioners SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'Practitioner not found.' });
  res.json({ practitioner: rows[0] });
}));

// ---------- Admin: list slots (including full and past ones) ----------
router.get('/slots', requireAuth, requireCapability(C.BOOKINGS_READ), asyncHandler(async (req, res) => {
  const { serviceType, practitionerId } = req.query;
  const conditions = [];
  const params = [];
  if (serviceType) {
    if (!['puja', 'astrology'].includes(serviceType)) return res.status(400).json({ error: 'Invalid serviceType.' });
    params.push(serviceType);
    conditions.push(`s.service_type = $${params.length}`);
  }
  if (practitionerId) {
    if (!isUuid(practitionerId)) return res.status(400).json({ error: 'Invalid practitionerId.' });
    params.push(practitionerId);
    conditions.push(`s.practitioner_id = $${params.length}`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await db.query(
    `SELECT s.*, p.full_name AS practitioner_name, bs.name AS service_name
       FROM availability_slots s
       LEFT JOIN practitioners p ON p.id = s.practitioner_id
       LEFT JOIN booking_services bs ON bs.id = s.service_id
       ${where}
      ORDER BY s.starts_at DESC LIMIT 500`,
    params
  );
  res.json({ slots: rows });
}));

/**
 * Creates one slot, or a repeating series of them.
 *
 * The bulk form exists because the alternative is an admin clicking "add slot"
 * ninety times to publish a month of mornings, and a capacity system nobody
 * populates enforces nothing at all.
 */
router.post(
  '/slots',
  requireAuth,
  requireCapability(C.BOOKINGS_WRITE),
  [
    body('service_type').isIn(['puja', 'astrology']),
    body('starts_at').isISO8601(),
    body('capacity').optional().isInt({ min: 1, max: 100 }).toInt(),
    body('label').optional({ nullable: true }).isString().isLength({ max: 60 }),
    body('repeatDays').optional().isInt({ min: 1, max: 90 }).toInt(),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { service_type, service_id, practitioner_id, starts_at, ends_at, label, capacity, repeatDays } = req.body;
    if (service_id && !isUuid(service_id)) return res.status(400).json({ error: 'Invalid service_id.' });
    if (practitioner_id && !isUuid(practitioner_id)) return res.status(400).json({ error: 'Invalid practitioner_id.' });

    const start = new Date(starts_at);
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Invalid start time.' });
    if (start.getTime() < Date.now() - 60 * 1000) {
      return res.status(400).json({ error: 'A slot cannot start in the past.' });
    }
    if (ends_at && new Date(ends_at) <= start) {
      return res.status(400).json({ error: 'The end time must be after the start time.' });
    }

    const days = Number.isInteger(repeatDays) ? repeatDays : 1;
    const created = await db.withTransaction(async (client) => {
      const inserted = [];
      for (let i = 0; i < days; i++) {
        const slotStart = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
        const slotEnd = ends_at ? new Date(new Date(ends_at).getTime() + i * 24 * 60 * 60 * 1000) : null;
        const { rows } = await client.query(
          `INSERT INTO availability_slots
             (practitioner_id, service_type, service_id, starts_at, ends_at, label, capacity)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [practitioner_id || null, service_type, service_id || null, slotStart, slotEnd,
            label || null, Number.isInteger(capacity) ? capacity : 1]
        );
        inserted.push(rows[0]);
      }
      await client.query(
        `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, detail)
         VALUES ($1,'create_availability_slots','availability_slot',$2)`,
        [req.user.id, JSON.stringify({ count: inserted.length, service_type, startsAt: starts_at, capacity })]
      );
      return inserted;
    });

    res.status(201).json({ slots: created, count: created.length });
  })
);

router.patch('/slots/:id', requireAuth, requireCapability(C.BOOKINGS_WRITE), asyncHandler(async (req, res) => {
  const { capacity, is_active, label } = req.body;
  const updates = [];
  const params = [];

  if (capacity !== undefined) {
    if (!Number.isInteger(capacity) || capacity < 1) return res.status(400).json({ error: 'capacity must be a positive integer.' });
    params.push(capacity); updates.push(`capacity = $${params.length}`);
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be true or false.' });
    params.push(is_active); updates.push(`is_active = $${params.length}`);
  }
  if (label !== undefined) { params.push(label); updates.push(`label = $${params.length}`); }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });

  params.push(req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE availability_slots SET ${updates.join(', ')}, updated_at = now()
        WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Slot not found.' });
    res.json({ slot: rows[0] });
  } catch (err) {
    // The chk_slots_not_overbooked CHECK constraint refuses a capacity below
    // what is already booked. That is exactly right — the alternative is
    // silently overbooking people who have already paid — so translate it into
    // a sentence the admin can act on rather than a 500.
    if (err.code === '23514') {
      return res.status(409).json({ error: 'Capacity cannot be set below the number of bookings already taken on this slot.' });
    }
    throw err;
  }
}));

module.exports = router;
