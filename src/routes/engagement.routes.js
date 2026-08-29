/**
 * Things a visitor submits that are not an order or a booking:
 * back-in-stock requests, newsletter subscription, and the contact form.
 *
 * WHY THIS FILE EXISTS. The storefront shipped all three of these as forms that
 * showed a confirmation toast and threw the input away — "We'll email you when
 * this is back in stock", "Thanks for subscribing!", "Message sent — we'll get
 * back to you within a day." No endpoint, no table, no email behind any of
 * them. A promise the software cannot keep is worse than an absent feature: the
 * customer stops watching for a restock that will never be announced, and a
 * support request evaporates while they wait for a reply.
 *
 * Every route here is PUBLIC and UNAUTHENTICATED, which makes each one three
 * things an attacker wants: a way to send mail to an arbitrary address, a way
 * to write rows into your database for free, and an oracle for "does this
 * person shop here?". The rate limits and the uniform responses below are not
 * decoration.
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const db = require('../config/db');
const { asyncHandler } = require('../middleware/asyncHandler');
const { handleValidation } = require('../middleware/validate');
const { logger } = require('../utils/logger');
const {
  sendSubscriptionConfirm, sendSubscriptionWelcome
} = require('../utils/mailer');
const { clientUrl } = require('../utils/email/engine');

const router = express.Router();

const hash = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();

// Anything that can cause an email to be sent to an address the sender chose.
// An unlimited version of this is a spam relay with extra steps, and it burns
// the sending domain's reputation for every genuine customer.
const dispatchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.ENGAGE_DISPATCH_LIMIT || '8', 10),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many requests. Please wait a while before trying again.' }
});

// Writes rows but sends no mail. Looser, because the abuse is cheaper, but not
// unlimited — an unbounded public INSERT is a way to fill someone's database.
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.ENGAGE_WRITE_LIMIT || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many submissions. Please wait a while before trying again.' }
});

// ===========================================================================
// BACK IN STOCK
// ===========================================================================
/**
 * POST /api/engage/stock-notify  { productId, variantId?, email }
 *
 * Deliberately does NOT reveal whether the address is already on the list, and
 * deliberately does not require an account: the storefront's button appears on
 * a product page a signed-out visitor can reach, and forcing a sign-up at that
 * moment is how you convert an interested customer into a closed tab.
 */
router.post(
  '/stock-notify',
  writeLimiter,
  [
    body('productId').isUUID().withMessage('A valid product is required.'),
    body('variantId').optional({ nullable: true }).isUUID(),
    body('email').isEmail().normalizeEmail().withMessage('A valid email address is required.'),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { productId, variantId, email } = req.body;

    // Check the product exists and is actually unavailable. Accepting a
    // waitlist entry for something already in stock produces a restock email
    // that never comes, which is the exact failure this feature replaces.
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.is_active,
              CASE WHEN $2::uuid IS NULL THEN p.stock_qty ELSE v.stock_qty END AS stock_qty,
              CASE WHEN $2::uuid IS NULL THEN true ELSE (v.id IS NOT NULL) END AS variant_ok
         FROM products p
         LEFT JOIN product_variants v ON v.id = $2::uuid AND v.product_id = p.id
        WHERE p.id = $1`,
      [productId, variantId || null]
    );
    if (!rows.length || !rows[0].is_active || !rows[0].variant_ok) {
      return res.status(404).json({ error: 'That product is no longer available.' });
    }
    if (Number(rows[0].stock_qty) > 0) {
      return res.status(400).json({
        error: 'Good news — this is in stock right now.',
        inStock: true
      });
    }

    // ON CONFLICT against the partial unique index: joining the same waitlist
    // twice is a no-op rather than an error the customer has to understand.
    await db.query(
      `INSERT INTO stock_notifications (product_id, variant_id, email, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(email))
         WHERE notified_at IS NULL
       DO NOTHING`,
      [productId, variantId || null, email, (req.user && req.user.id) || null]
    );

    return res.json({
      ok: true,
      message: "You're on the list. We'll email you once, as soon as it's back."
    });
  })
);

// ===========================================================================
// NEWSLETTER — double opt-in
// ===========================================================================
/**
 * POST /api/engage/newsletter  { email, consentText? }
 *
 * Double opt-in, for two reasons that both matter. Legally, DPDP Act 2023 wants
 * consent that is free, specific, informed and unambiguous, and a confirmed
 * click is the only version of that you can later evidence. Practically, it
 * stops someone signing up an address they do not own, and it keeps the list
 * clean enough that mailbox providers keep delivering to the inbox.
 *
 * The response is IDENTICAL whether the address is new, already pending, or
 * already confirmed. Anything else turns this box into a "does this person shop
 * here?" oracle that anyone can query.
 */
router.post(
  '/newsletter',
  dispatchLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Please enter a valid email address.'),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const email = normEmail(req.body.email);
    const uniformResponse = {
      ok: true,
      message: 'Almost there — check your inbox and click the confirmation link.'
    };

    const rawToken = crypto.randomBytes(24).toString('hex');
    const consentText = 'Panchang updates, new arrivals and festival offers, a couple of times a month.';

    const { rows } = await db.query(
      `INSERT INTO email_subscriptions
         (email, status, confirm_token_hash, confirm_expires_at, source, consent_text, consent_ip)
       VALUES ($1, 'pending', $2, now() + interval '48 hours', $3, $4, $5)
       ON CONFLICT (lower(email)) DO UPDATE
         SET confirm_token_hash = EXCLUDED.confirm_token_hash,
             confirm_expires_at = EXCLUDED.confirm_expires_at,
             consent_text       = EXCLUDED.consent_text,
             consent_ip         = EXCLUDED.consent_ip,
             updated_at         = now(),
             -- Re-subscribing after unsubscribing has to work, and has to go
             -- back through confirmation rather than silently reviving old
             -- consent. A confirmed subscriber stays confirmed: re-submitting
             -- the form must not quietly unsubscribe them.
             status = CASE WHEN email_subscriptions.status = 'confirmed'
                           THEN 'confirmed' ELSE 'pending' END
       RETURNING status`,
      [email, hash(rawToken), req.body.source || 'footer_form', consentText, req.ip]
    );

    // Already confirmed: send nothing, say the same thing. They are on the list
    // and a second confirmation email would just be confusing.
    if (rows.length && rows[0].status === 'confirmed') return res.json(uniformResponse);

    const confirmUrl = `${clientUrl()}/newsletter/confirm?token=${encodeURIComponent(rawToken)}`;
    sendSubscriptionConfirm({ email, confirmUrl }).catch((err) =>
      logger.error('Subscription confirmation email failed', err));

    return res.json(uniformResponse);
  })
);

/** POST /api/engage/newsletter/confirm  { token } */
router.post(
  '/newsletter/confirm',
  [body('token').isString().isLength({ min: 20, max: 200 }), handleValidation],
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE email_subscriptions
          SET status = 'confirmed',
              confirmed_at = now(),
              confirm_token_hash = NULL,
              confirm_expires_at = NULL,
              unsubscribed_at = NULL,
              updated_at = now()
        WHERE confirm_token_hash = $1
          AND confirm_expires_at > now()
        RETURNING email, unsubscribe_token`,
      [hash(req.body.token)]
    );
    if (!rows.length) {
      return res.status(400).json({ error: 'That confirmation link is invalid or has expired. Please subscribe again.' });
    }
    const { email, unsubscribe_token: unsubToken } = rows[0];
    sendSubscriptionWelcome({
      email,
      unsubscribeUrl: `${clientUrl()}/unsubscribe?token=${encodeURIComponent(unsubToken)}`
    }).catch((err) => logger.error('Subscription welcome email failed', err));

    return res.json({ ok: true, message: "You're subscribed. Welcome." });
  })
);

/**
 * POST /api/engage/newsletter/unsubscribe  { token }
 *
 * No sign-in, no password, no "are you sure". DPDP Act 2023 requires that
 * withdrawing consent be as easy as giving it, and every extra step here is a
 * step towards someone marking the message as spam instead — which costs the
 * sending domain far more than the subscriber did.
 *
 * Unknown tokens return success rather than 404. A recipient who unsubscribed
 * last year and clicks the old link again should see "you're unsubscribed", not
 * an error page suggesting they are somehow still on the list.
 */
router.post(
  '/newsletter/unsubscribe',
  [body('token').isString().isLength({ min: 10, max: 200 }), handleValidation],
  asyncHandler(async (req, res) => {
    await db.query(
      `UPDATE email_subscriptions
          SET status = 'unsubscribed', unsubscribed_at = now(), updated_at = now()
        WHERE unsubscribe_token = $1 AND status <> 'unsubscribed'`,
      [req.body.token]
    );
    return res.json({ ok: true, message: "You've been unsubscribed. You won't receive marketing emails from us again." });
  })
);

// ===========================================================================
// CONTACT
// ===========================================================================
/**
 * POST /api/engage/contact
 *
 * Stored, not emailed — a deliberate choice. An alert email that bounces or
 * lands in a spam folder is a customer who never hears back AND no record that
 * they ever wrote. The admin console reads this table and the daily digest
 * counts what is still unread, so an unanswered message gets louder rather
 * than quieter.
 */
router.post(
  '/contact',
  writeLimiter,
  [
    body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Please tell us your name.'),
    body('email').isEmail().normalizeEmail().withMessage('Please enter a valid email address.'),
    body('phone').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 20 }),
    body('subject').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 200 }),
    body('message').trim().isLength({ min: 10, max: 5000 })
      .withMessage('Please include a message of at least 10 characters.'),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { name, email, phone, subject, message } = req.body;
    const { rows } = await db.query(
      `INSERT INTO contact_messages (name, email, phone, subject, message, user_id, submitted_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [name, email, phone || null, subject || null, message, (req.user && req.user.id) || null, req.ip]
    );
    logger.info('Contact message received', { messageId: rows[0].id });
    return res.status(201).json({
      ok: true,
      message: "Thank you — your message is with our team. We reply within one working day."
    });
  })
);

module.exports = router;
