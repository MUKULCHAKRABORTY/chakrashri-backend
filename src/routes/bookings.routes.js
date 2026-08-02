const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// isISO8601() alone accepts any valid date, including yesterday or the year
// 1900 — it only checks format, not whether the date makes sense for a
// booking. This closes that gap for both booking types below.
function isTodayOrFuture(value) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(value);
  if (date < today) throw new Error('Preferred date cannot be in the past.');
  return true;
}

// ---------- Create a puja booking ----------
router.post(
  '/puja',
  requireAuth,
  [
    body('pujaType').notEmpty(),
    body('preferredDate').isISO8601().custom(isTodayOrFuture),
    body('preferredTimeSlot').notEmpty(),
    body('contactName').notEmpty(),
    body('contactPhone').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { pujaType, preferredDate, preferredTimeSlot, contactName, contactPhone, notes } = req.body;
    try {
      const result = await db.query(
        `INSERT INTO puja_bookings
          (user_id, puja_type, preferred_date, preferred_time_slot, contact_name, contact_phone, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user.id, pujaType, preferredDate, preferredTimeSlot, contactName, contactPhone, notes || null]
      );
      // TODO: notify ops team + send confirmation to customer (email/WhatsApp)
      res.status(201).json({ booking: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: 'Could not create booking.' });
    }
  }
);

// ---------- Create an astrology consultation booking ----------
router.post(
  '/astrology',
  requireAuth,
  [
    body('consultationMode').isIn(['call', 'video', 'chat']),
    body('preferredDate').isISO8601().custom(isTodayOrFuture),
    body('preferredTimeSlot').notEmpty(),
    body('contactName').notEmpty(),
    body('contactPhone').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      consultationMode, preferredDate, preferredTimeSlot,
      contactName, contactPhone, birthDetails
    } = req.body;
    try {
      // NOTE: birthDetails (DOB/time/place) is sensitive personal data under
      // India's DPDP Act 2023 — store encrypted at rest if possible, and only
      // ever return it to the owning user or an authorized astrologer.
      const result = await db.query(
        `INSERT INTO astrology_bookings
          (user_id, consultation_mode, preferred_date, preferred_time_slot, contact_name, contact_phone, birth_details)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status, preferred_date, preferred_time_slot`,
        [req.user.id, consultationMode, preferredDate, preferredTimeSlot, contactName, contactPhone, birthDetails || null]
      );
      res.status(201).json({ booking: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: 'Could not create booking.' });
    }
  }
);

// ---------- Admin: list bookings ----------
router.get('/puja', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM puja_bookings ORDER BY created_at DESC LIMIT 200');
    res.json({ bookings: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load puja bookings.' });
  }
});

router.get('/astrology', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, user_id, consultation_mode, preferred_date, preferred_time_slot, status, contact_name,
              contact_phone, created_at
       FROM astrology_bookings ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ bookings: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load astrology bookings.' });
  }
});

module.exports = router;
