const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth); // every address belongs to a specific customer — never public

// ---------- List the logged-in customer's saved addresses ----------
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
      [req.user.id]
    );
    res.json({ addresses: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load addresses.' });
  }
});

// ---------- Create a new address for the logged-in customer ----------
router.post(
  '/',
  [
    body('full_name').trim().notEmpty(),
    body('phone').trim().notEmpty(),
    body('line1').trim().notEmpty(),
    body('city').trim().notEmpty(),
    body('state').trim().notEmpty(),
    body('pincode').trim().isLength({ min: 4, max: 10 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { full_name, phone, line1, line2, city, state, pincode, country, is_default } = req.body;
    try {
      // If this is marked default (or it's the customer's first address),
      // clear any existing default first so there's never more than one.
      if (is_default) {
        await db.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
      }
      const result = await db.query(
        `INSERT INTO addresses (user_id, full_name, phone, line1, line2, city, state, pincode, country, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [req.user.id, full_name, phone, line1, line2 || null, city, state, pincode, country || 'India', !!is_default]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Could not save address.' });
    }
  }
);

// ---------- Update an address (must belong to the caller) ----------
router.put('/:id', async (req, res) => {
  const allowedFields = ['full_name', 'phone', 'line1', 'line2', 'city', 'state', 'pincode', 'country', 'is_default'];
  const updates = [];
  const params = [];
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      params.push(req.body[field]);
      updates.push(`${field} = $${params.length}`);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });

  try {
    if (req.body.is_default) {
      await db.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    }
    params.push(req.params.id, req.user.id);
    const result = await db.query(
      `UPDATE addresses SET ${updates.join(', ')} WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Address not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Could not update address.' });
  }
});

// ---------- Delete an address (must belong to the caller) ----------
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING id', [
      req.params.id,
      req.user.id
    ]);
    if (!result.rows.length) return res.status(404).json({ error: 'Address not found.' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Could not delete address.' });
  }
});

module.exports = router;
