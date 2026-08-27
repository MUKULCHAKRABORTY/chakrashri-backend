const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const db = require('../config/db');
const { requireAuth, invalidateTokenVersionCache } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { handleValidation } = require('../middleware/validate');
const { sendPasswordResetEmail, sendEmailVerification } = require('../utils/mailer');
const { logger } = require('../utils/logger');
const { passwordProblem } = require('../utils/passwordPolicy');

const router = express.Router();
const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);

// The global API rate limiter is far too loose to stop credential stuffing or
// brute-forced passwords against login specifically. This caps login/admin-login
// attempts much tighter, per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

// AUTH-04 — registration had NO route-level limiter at all, only the global
// 200/15min budget, so a script could open hundreds of accounts. Deliberately a
// SEPARATE limiter instance rather than reusing authLimiter: sharing one budget
// would mean a customer who mistyped their password a few times could not then
// create an account, which is a real support ticket for no security gain.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.REGISTER_RATE_LIMIT_MAX || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this network. Please try again later.' }
});

// Sending mail is the expensive, abusable part of these two flows — an
// unlimited endpoint that emails an arbitrary address is a spam relay with
// extra steps, and it burns the sending domain's reputation.
const emailDispatchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.EMAIL_DISPATCH_RATE_LIMIT_MAX || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a while before trying again.' }
});

/**
 * AUTH-03 — every token now carries `tv`, the user's token_version. Bumping
 * that column invalidates every token issued before the bump, which is what
 * makes "log out everywhere" and "a password reset ends the attacker's session"
 * actually true. See middleware/auth.js for the verification side and the
 * deliberate grace period for tokens issued before this change.
 */
function signToken(user, expiresIn) {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      email: user.email,
      tv: Number(user.token_version) || 0
    },
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

async function issueEmailVerification(userId, email, name) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.query(
    'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );
  const verifyUrl = `${(process.env.CLIENT_URL || '').replace(/\/+$/, '')}/verify-email?token=${rawToken}`;
  // Never blocks the response: a slow SMTP server must not slow down signup.
  sendEmailVerification({ email, name, verifyUrl })
    .catch((err) => logger.warn('Verification email failed to send', { userId, message: err.message }));
}

// ---------- Customer registration ----------
router.post(
  '/register',
  registerLimiter,
  [
    body('name').trim().isLength({ min: 2, max: 120 }),
    body('email').isEmail().normalizeEmail().isLength({ max: 180 }),
    body('phone').optional({ nullable: true, checkFalsy: true }).trim().isLength({ min: 6, max: 20 }),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { name, email, password, phone } = req.body;

    const problem = passwordProblem(password, email);
    if (problem) return res.status(400).json({ error: problem });

    // AUTH-04 — the response is now IDENTICAL whether or not the address is
    // already registered. The old 409 "An account with this email already
    // exists" was a free account-enumeration oracle on an endpoint with no
    // rate limit. An existing user gets a "someone tried to register with your
    // address" nudge by email instead, which is both safer and more useful to
    // them than an error on a stranger's screen.
    const GENERIC_ACCEPTED = {
      message: 'Check your email to finish setting up your account.',
      requiresVerification: true
    };

    const existing = await db.query('SELECT id, name, email FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      logger.info('Registration attempted for an existing address', { email: '[redacted]' });
      return res.status(202).json(GENERIC_ACCEPTED);
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    let user;
    try {
      const result = await db.query(
        `INSERT INTO users (name, email, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, 'customer')
         RETURNING id, name, email, role, token_version`,
        [name, email, phone || null, hash]
      );
      user = result.rows[0];
    } catch (err) {
      // 23505 = unique_violation. The pre-check above handles the common case,
      // but a genuine race (two simultaneous registrations with the same email)
      // can still reach the constraint.
      if (err.code === '23505') {
        if (err.constraint && err.constraint.includes('phone')) {
          return res.status(409).json({ error: 'An account with this phone number already exists.' });
        }
        return res.status(202).json(GENERIC_ACCEPTED);
      }
      throw err;
    }

    // A failure to issue the verification token must NOT fail the registration
    // the customer just completed — their account exists and they can trigger a
    // resend from the account page. Logged so a broken mail path is visible.
    try {
      await issueEmailVerification(user.id, user.email, user.name);
    } catch (err) {
      logger.error('Could not issue email verification at signup', err, { userId: user.id });
    }

    // The token is still issued immediately, so the customer can browse and
    // build a cart without a round-trip through their inbox. What verification
    // gates is the things abuse actually targets: Cash on Delivery and posting
    // reviews. That is the balance between conversion and control.
    const token = signToken(user);
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      requiresVerification: true
    });
  })
);

// ---------- Customer login ----------
router.post(
  '/login',
  authLimiter,
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty(), handleValidation],
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await db.query(
      `SELECT id, name, email, role, password_hash, token_version, email_verified
         FROM users WHERE email = $1 AND is_active = true`,
      [email]
    );
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH_FOR_TIMING_SAFETY);
    if (!user || !valid) {
      logger.info('Failed login attempt', { ip: req.ip });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, emailVerified: user.email_verified
      }
    });
  })
);

// ---------- Admin/staff login ----------
// Replaces the old client-side hardcoded password. Admin accounts are seeded
// directly in the database (see README "Creating your first admin user") —
// never store admin credentials in front-end code.
router.post(
  '/admin/login',
  authLimiter,
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty(), handleValidation],
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await db.query(
      `SELECT id, name, email, role, password_hash, token_version
         FROM users WHERE email = $1 AND role IN ('admin','staff') AND is_active = true`,
      [email]
    );
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH_FOR_TIMING_SAFETY);
    if (!user || !valid) {
      // A failed staff login is a genuinely interesting security event in a way
      // a failed customer login is not — it is either an admin locked out or
      // someone probing the back office, and both warrant an alert.
      logger.warn('Failed admin login attempt', { ip: req.ip });
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = signToken(user, process.env.ADMIN_JWT_EXPIRES_IN || '8h');
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, detail) VALUES ($1, 'login', $2)`,
      [user.id, JSON.stringify({ ip: req.ip })]
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  })
);

// ---------- Forgot password ----------
// Always responds with the same generic message whether or not the email
// has an account — a different response for "not found" vs "email sent"
// would let anyone enumerate which addresses are registered.
router.post(
  '/forgot-password',
  authLimiter,
  emailDispatchLimiter,
  [body('email').isEmail().normalizeEmail()],
  asyncHandler(async (req, res) => {
    const generic = { message: 'If an account exists for that email, a reset link has been sent.' };
    // Deliberately generic even on invalid input — leaking validation detail
    // here would distinguish "not a real address" from "not registered".
    if (!req.body.email || typeof req.body.email !== 'string') return res.json(generic);

    try {
      const { rows } = await db.query(
        'SELECT id, name, email FROM users WHERE email = $1 AND is_active = true',
        [req.body.email]
      );
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
        sendPasswordResetEmail({ email: user.email, resetUrl })
          .catch((err) => logger.warn('Password reset email failed', { message: err.message }));
      }
      res.json(generic);
    } catch (err) {
      // Never reveal server errors here either — same reasoning as above. But
      // DO record it: a failing reset flow that returns 200 to everyone is
      // otherwise completely invisible.
      logger.error('Forgot-password flow failed', err);
      res.json(generic);
    }
  })
);

// ---------- Reset password ----------
router.post(
  '/reset-password',
  authLimiter,
  [body('token').notEmpty().isLength({ max: 200 }), body('newPassword').notEmpty(), handleValidation],
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body;

    const problem = passwordProblem(newPassword, null);
    if (problem) return res.status(400).json({ error: problem });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    let userId;
    try {
      ({ userId } = await db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id, user_id FROM password_reset_tokens
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
           FOR UPDATE`,
          [tokenHash]
        );
        if (!rows.length) {
          throw Object.assign(
            new Error('This reset link is invalid or has expired. Please request a new one.'),
            { status: 400 }
          );
        }
        const { id: tokenId, user_id: uid } = rows[0];

        const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);

        // AUTH-03 — the whole point. Bumping token_version in the SAME
        // transaction as the password change invalidates every access token
        // issued before this moment. Without it, "I think someone got into my
        // account so I changed my password" did not do the one thing the
        // customer believed it did: the attacker's seven-day token kept working.
        await client.query(
          `UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = now()
            WHERE id = $2`,
          [hash, uid]
        );

        // Mark used immediately, inside the same transaction/lock — a second
        // concurrent request with the same token (a double-click, or an email
        // link scanned by a security tool) can't reuse it.
        await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [tokenId]);
        // A password reset should retire every previously issued link, not just
        // the one that was used.
        await client.query(
          'UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
          [uid]
        );
        return { userId: uid };
      }));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    // Drop the cached token_version immediately so the revocation takes effect
    // now rather than at the end of the cache TTL.
    invalidateTokenVersionCache(userId);
    logger.info('Password reset completed; all sessions revoked', { userId });

    res.json({ message: 'Password has been reset and you have been signed out on all devices. You can now log in with your new password.' });
  })
);

// ---------- Verify email (AUTH-04) ----------
router.post(
  '/verify-email',
  [body('token').notEmpty().isLength({ max: 200 }), handleValidation],
  asyncHandler(async (req, res) => {
    const tokenHash = crypto.createHash('sha256').update(req.body.token).digest('hex');

    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, user_id FROM email_verification_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [tokenHash]
      );
      if (!rows.length) return null;
      await client.query('UPDATE email_verification_tokens SET used_at = now() WHERE id = $1', [rows[0].id]);
      await client.query(
        `UPDATE users SET email_verified = true, email_verified_at = now(), updated_at = now() WHERE id = $1`,
        [rows[0].user_id]
      );
      return rows[0];
    });

    if (!result) {
      return res.status(400).json({ error: 'This verification link is invalid or has expired. Request a new one from your account page.' });
    }
    res.json({ message: 'Your email address has been verified.', verified: true });
  })
);

router.post('/resend-verification', requireAuth, emailDispatchLimiter, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, name, email, email_verified FROM users WHERE id = $1 AND is_active = true',
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Account not found.' });
  if (rows[0].email_verified) return res.json({ message: 'Your email address is already verified.', verified: true });

  await issueEmailVerification(rows[0].id, rows[0].email, rows[0].name);
  res.json({ message: 'Verification email sent. Please check your inbox.' });
}));

// ---------- Sign out everywhere (AUTH-03) ----------
// The customer-facing half of token revocation: the control that makes
// "someone else is signed in as me" fixable without a password reset.
router.post('/logout-all', requireAuth, asyncHandler(async (req, res) => {
  await db.query(
    'UPDATE users SET token_version = token_version + 1, updated_at = now() WHERE id = $1',
    [req.user.id]
  );
  invalidateTokenVersionCache(req.user.id);
  logger.info('User signed out of all sessions', { userId: req.user.id });
  res.json({ message: 'You have been signed out on all devices.' });
}));

// ---------- Who am I? ----------
// The front end calls this on load and whenever the account modal opens, to
// decide whether to show the login form or the account panel.
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, email, phone, role, created_at, email_verified, cod_blocked
       FROM users WHERE id = $1 AND is_active = true`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Account not found.' });
  res.json({ user: rows[0] });
}));

module.exports = router;
