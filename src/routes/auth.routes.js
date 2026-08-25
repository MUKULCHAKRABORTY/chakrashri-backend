const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { sendPasswordResetEmail } = require('../utils/mailer');

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

// Precomputed once at startup, not per-request: without this, the "user not
// found" path returns immediately while the "wrong password" path spends
// ~100ms+ in bcrypt.compare — an attacker measuring response times could use
// that gap to enumerate which emails have accounts, even though every
// response says the same generic "Invalid email or password." Comparing
// against this dummy hash on every login attempt (found or not) makes both
// paths cost the same regardless of whether the account exists.
const DUMMY_HASH_FOR_TIMING_SAFETY = bcrypt.hashSync('a-timing-safety-placeholder', SALT_ROUNDS);

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
      const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH_FOR_TIMING_SAFETY);
      if (!user || !valid) return res.status(401).json({ error: 'Invalid email or password.' });

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
    // This check existed in the validator array above but was never actually
    // read — meaning malformed input (missing password, non-email string)
    // fell straight through to the database query and bcrypt.compare
    // instead of getting a clean 400, previously surfacing as a generic 500.
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    try {
      const result = await db.query(
        "SELECT * FROM users WHERE email = $1 AND role IN ('admin','staff') AND is_active = true",
        [email]
      );
      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH_FOR_TIMING_SAFETY);
      if (!user || !valid) return res.status(401).json({ error: 'Invalid credentials.' });

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

// ---------- Forgot password ----------
// Always responds with the same generic message whether or not the email
// has an account — a different response for "not found" vs "email sent"
// would let anyone enumerate which addresses are registered.
router.post(
  '/forgot-password',
  authLimiter,
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    const generic = { message: 'If an account exists for that email, a reset link has been sent.' };
    if (!errors.isEmpty()) return res.json(generic); // still generic even on bad input — don't leak validation details either

    try {
      const { rows } = await db.query('SELECT id, name, email FROM users WHERE email = $1 AND is_active = true', [req.body.email]);
      if (rows.length) {
        const user = rows[0];
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

        await db.query(
          'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
          [user.id, tokenHash, expiresAt]
        );

        const resetUrl = `${(process.env.CLIENT_URL || '').replace(/\/+$/, '')}/reset-password?token=${rawToken}`;
        sendPasswordResetEmail({ email: user.email, resetUrl }).catch(() => {});
      }
      // Deliberately identical response and (roughly) identical timing whether
      // or not `rows.length` was 0 — the DB query and generic response happen
      // either way, so there's no branch that returns meaningfully faster.
      res.json(generic);
    } catch (err) {
      res.json(generic); // never reveal server errors here either — same reasoning as above
    }
  }
);

// ---------- Reset password ----------
router.post(
  '/reset-password',
  authLimiter,
  [body('token').notEmpty(), body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { token, newPassword } = req.body;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    try {
      const result = await db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id, user_id FROM password_reset_tokens
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
           FOR UPDATE`,
          [tokenHash]
        );
        if (!rows.length) {
          throw Object.assign(new Error('This reset link is invalid or has expired. Please request a new one.'), { status: 400 });
        }
        const { id: tokenId, user_id: userId } = rows[0];

        const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, userId]);
        // Mark used immediately, inside the same transaction/lock — a second
        // concurrent request with the same token (e.g. a double-click, or an
        // email link scanned by a security tool) can't reuse it.
        await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [tokenId]);
        // Invalidate any other outstanding reset tokens for this user too —
        // a password reset should retire every previously issued link, not
        // just the one that was used.
        await client.query(
          'UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
          [userId]
        );
        return { userId };
      });
      res.json({ message: 'Password has been reset. You can now log in with your new password.' });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Could not reset password.' });
    }
  }
);

// ---------- Who am I? ----------
// The front end calls this on load and whenever the account modal opens, to
// decide whether to show the login form or the account panel. It was missing
// entirely, so that call 404'd every time and the UI always fell back to the
// login form even for a logged-in customer.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, email, phone, role, created_at FROM users WHERE id = $1 AND is_active = true',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Account not found.' });
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not load your account.' });
  }
});

module.exports = router;
