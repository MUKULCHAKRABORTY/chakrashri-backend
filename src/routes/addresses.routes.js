const express = require('express');
const { body } = require('express-validator');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateUuidParam, handleValidation } = require('../middleware/validate');
const { pincodeProblem, phoneProblem } = require('../utils/addressValidation');

const router = express.Router();
router.use(requireAuth); // every address belongs to a specific customer — never public
router.param('id', validateUuidParam('id'));

const ADDRESS_COLUMNS = 'id, user_id, full_name, phone, email, line1, line2, city, state, pincode, country, is_default, created_at';

// ---------- List the logged-in customer's saved addresses ----------
router.get('/', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT ${ADDRESS_COLUMNS} FROM addresses
      WHERE user_id = $1 AND deleted_at IS NULL
      ORDER BY is_default DESC, created_at DESC`,
    [req.user.id]
  );
  res.json({ addresses: result.rows });
}));

// ---------- Create a new address for the logged-in customer ----------
router.post(
  '/',
  [
    body('full_name').trim().isLength({ min: 2, max: 120 }),
    body('phone').trim().notEmpty(),
    body('line1').trim().isLength({ min: 3, max: 200 }),
    body('line2').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 200 }),
    body('city').trim().isLength({ min: 2, max: 100 }),
    body('state').trim().isLength({ min: 2, max: 100 }),
    body('pincode').trim().notEmpty(),
    body('country').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 60 }),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { full_name, phone, email, line1, line2, city, state, pincode, country, is_default } = req.body;

    const pinProblem = pincodeProblem(pincode, country);
    if (pinProblem) return res.status(400).json({ error: pinProblem });
    const phProblem = phoneProblem(phone);
    if (phProblem) return res.status(400).json({ error: phProblem });

    // A hard cap. Without one, an authenticated account can insert unbounded
    // rows — and every one of them is PII this business then has to protect.
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM addresses WHERE user_id = $1 AND deleted_at IS NULL',
      [req.user.id]
    );
    if (countRows[0].cnt >= 25) {
      return res.status(409).json({ error: 'You have reached the maximum number of saved addresses. Please delete one first.' });
    }

    // Both statements in ONE transaction: clearing the old default and setting
    // the new one used to be two separate calls, so a failure between them left
    // the account with no default address at all.
    const address = await db.withTransaction(async (client) => {
      const makeDefault = Boolean(is_default) || countRows[0].cnt === 0;
      if (makeDefault) {
        await client.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
      }
      const result = await client.query(
        `INSERT INTO addresses (user_id, full_name, phone, email, line1, line2, city, state, pincode, country, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING ${ADDRESS_COLUMNS}`,
        [req.user.id, full_name, phone, email || null, line1, line2 || null, city, state, pincode,
          country || 'India', makeDefault]
      );
      return result.rows[0];
    });

    res.status(201).json(address);
  })
);

// ---------- Update an address (must belong to the caller) ----------
router.put('/:id', asyncHandler(async (req, res) => {
  const allowedFields = ['full_name', 'phone', 'email', 'line1', 'line2', 'city', 'state', 'pincode', 'country', 'is_default'];

  if (req.body.pincode !== undefined) {
    const problem = pincodeProblem(req.body.pincode, req.body.country);
    if (problem) return res.status(400).json({ error: problem });
  }
  if (req.body.phone !== undefined) {
    const problem = phoneProblem(req.body.phone);
    if (problem) return res.status(400).json({ error: problem });
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

  // DATA-01 note: editing an address no longer rewrites history. Every order
  // now carries its own frozen shipping_address_snapshot taken at checkout, so
  // this only changes what will be used for FUTURE orders — which is what a
  // customer editing their address book expects it to mean.
  const address = await db.withTransaction(async (client) => {
    if (req.body.is_default) {
      await client.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    }
    params.push(req.params.id, req.user.id);
    const result = await client.query(
      `UPDATE addresses SET ${updates.join(', ')}, updated_at = now()
        WHERE id = $${params.length - 1} AND user_id = $${params.length} AND deleted_at IS NULL
        RETURNING ${ADDRESS_COLUMNS}`,
      params
    );
    return result.rows[0] || null;
  });

  if (!address) return res.status(404).json({ error: 'Address not found.' });
  res.json(address);
}));

// ---------- Delete an address (must belong to the caller) ----------
// DATA-01 — this used to be a hard DELETE against a row that orders referenced
// with a NO ACTION foreign key. Postgres raised 23503 and the route turned it
// into an opaque 500, so a customer simply could not delete any address they
// had ever ordered with, and got a broken button with no explanation.
//
// It is now a soft delete: the row disappears from the customer's address book
// immediately, order history keeps its own snapshot, and nothing referencing it
// breaks.
router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE addresses SET deleted_at = now(), is_default = false, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING id, is_default`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return null;

    // If that was the default, promote the most recent remaining address so the
    // customer is never left with an address book and no default selected.
    await client.query(
      `UPDATE addresses SET is_default = true
        WHERE id = (
          SELECT id FROM addresses
           WHERE user_id = $1 AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM addresses WHERE user_id = $1 AND deleted_at IS NULL AND is_default = true
        )`,
      [req.user.id]
    );
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: 'Address not found.' });
  res.status(204).send();
}));

module.exports = router;
