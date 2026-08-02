const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');

const router = express.Router();
const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);

// The global API rate limiter (200 req/15min) is far too loose to stop
// credential stuffing or brute-forced passwords against login specifically.
// This caps login/admin-login attempts much tighter, per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

function signToken(user, expiresIn) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: expiresIn || process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ---------- Customer registration ----------
router.post(
  '/register',
  [
    body('name').trim().isLength({ min: 2 }),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, password, phone } = req.body;
    try {
      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length) return res.status(409).json({ error: 'An account with this email already exists.' });

      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      const result = await db.query(
        `INSERT INTO users (name, email, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, 'customer')
         RETURNING id, name, email, role`,
        [name, email, phone || null, hash]
      );
      const user = result.rows[0];
      const token = signToken(user);
      res.status(201).json({ token, user });
      // TODO: send verification email via nodemailer (see utils/mailer.js)
    } catch (err) {
      // 23505 = Postgres unique_violation. The email pre-check above handles
      // the common case, but a genuine race (two simultaneous registrations
      // with the same email) can still slip past it and hit the DB
      // constraint directly — so don't assume it's always the phone column;
      // check err.constraint to report the right field.
      if (err.code === '23505') {
        const field = err.constraint && err.constraint.includes('email') ? 'email address' : 'phone number';
        return res.status(409).json({ error: `An account with this ${field} already exists.` });
      }
      res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
  }
);

// ---------- Customer login ----------
router.post(
  '/login',
  authLimiter,
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    try {
      const result = await db.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email]);
      const user = result.rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

      const token = signToken(user);
      res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    } catch (err) {
      res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  }
);

// ---------- Admin/staff login ----------
// Replaces the old client-side hardcoded password. Admin accounts are seeded
// directly in the database (see README "Creating your first admin user") —
// never store admin credentials in front-end code.
router.post(
  '/admin/login',
  authLimiter,
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res) => {
    const { email, password } = req.body;
    try {
      const result = await db.query(
        "SELECT * FROM users WHERE email = $1 AND role IN ('admin','staff') AND is_active = true",
        [email]
      );
      const user = result.rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });

      const token = signToken(user, process.env.ADMIN_JWT_EXPIRES_IN || '8h');
      await db.query(
        `INSERT INTO admin_audit_log (admin_user_id, action, detail) VALUES ($1, 'login', '{}')`,
        [user.id]
      );
      res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    } catch (err) {
      res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  }
);

module.exports = router;
