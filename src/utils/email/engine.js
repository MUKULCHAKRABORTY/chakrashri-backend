/**
 * The email engine: everything that is true of every message we send.
 *
 * Templates live in ./templates.js and know nothing about transports, consent
 * or logging — they build a subject and a body and hand it here. This file
 * decides whether the message is allowed to go, makes sure it goes at most
 * once, sends it, and records what happened.
 *
 * THE FOUR RULES, and why each exists:
 *
 *  1. A send never breaks the thing that triggered it. A customer's order must
 *     succeed even if the SMTP provider is down. Every failure here is logged
 *     and returned, never thrown.
 *
 *  2. One real-world event sends at most one email. Three independent paths can
 *     confirm a payment — the browser calling verify, the gateway's webhook,
 *     and the reconciler — and all three legitimately reach the same code. The
 *     dedupe key makes the second and third no-ops at the database level rather
 *     than relying on every caller to remember.
 *
 *  3. Consent is checked here, not at the call site. A template author cannot
 *     accidentally send marketing to someone who opted out, because they never
 *     get the choice.
 *
 *  4. Losing the database must not lose the email. If the log or consent lookup
 *     fails, a transactional message still goes out. The alternative — dropping
 *     a customer's order confirmation because a bookkeeping table was briefly
 *     unreachable — is far worse than sending one email twice.
 */
const nodemailer = require('nodemailer');
const { logger } = require('../logger');

// Categories decide what consent and suppression rules apply.
const CATEGORY = {
  // Service messages about something the person did: orders, bookings,
  // password resets. No opt-in required — they asked for these by transacting.
  TRANSACTIONAL: 'transactional',
  // Internal alerts to our own team. Never subject to customer consent.
  OPERATIONAL: 'operational',
  // Anything sent because we want to be in touch rather than because they did
  // something. Requires a confirmed subscription and carries an unsubscribe
  // link. Abandoned-cart recovery counts: the customer did not ask to be
  // reminded, and DPDP Act 2023 treats "we noticed you left something" as
  // marketing even though it references their own session.
  MARKETING: 'marketing'
};

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null; // not configured yet — see .env.example
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    // Without these, a hung SMTP connection holds the Node socket open
    // indefinitely. Every caller treats mail as fire-and-forget, so a hang does
    // not block a response — but it does leak a socket per stuck send.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
  return transporter;
}

/** Exposed so tests can force a rebuild after changing SMTP_* env vars. */
function resetTransporter() { transporter = null; }

/**
 * HTML-escapes a value before it goes into an email body.
 *
 * WHY THIS IS NEEDED: templates interpolate values straight into HTML —
 * a customer name, a product name, a contact message. Those come from
 * public-facing forms. Someone who sets their name to
 * `<a href="http://phish.example">Click here</a>` gets that rendered as real
 * markup by every HTML mail client. The storefront and admin console both
 * escape rigorously; email is the output surface that leaves the building.
 */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapes a URL for use in an href. Rejects anything that is not http(s) —
 * `javascript:` and `data:` URLs execute in some mail clients, and every URL in
 * these templates is built from CLIENT_URL, so a non-http value means a
 * misconfiguration rather than a legitimate case.
 */
function safeUrl(url) {
  const raw = String(url || '');
  if (!/^https?:\/\//i.test(raw)) return null;
  return esc(raw);
}

function formatRupees(paise) {
  return `₹${(Number(paise) / 100).toFixed(2)}`;
}

/** CLIENT_URL without a trailing slash, so `${clientUrl()}/product/x` is never `//product/x`. */
function clientUrl() {
  return String(process.env.CLIENT_URL || '').replace(/\/+$/, '');
}

// --------------------------------------------------------------------------
// The shell
// --------------------------------------------------------------------------
// Every message shares one frame, so a customer recognises us at a glance and
// so a change to the footer is one edit rather than twenty-five. Deliberately
// table-based with inline styles: Outlook still ignores <style> blocks and
// most of flexbox, and an email that collapses in Outlook is an email a large
// share of Indian business customers cannot read.
const BRAND = {
  name: 'Chakrashri',
  ink: '#241f1a',
  soft: '#6b625a',
  rule: '#e7e0d6',
  ground: '#faf7f2',
  accent: '#9a5b1d'
};

function button(href, label) {
  const safe = safeUrl(href);
  if (!safe) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr>
    <td style="background:${BRAND.accent};border-radius:6px;">
      <a href="${safe}" style="display:inline-block;padding:12px 26px;color:#ffffff;font-weight:600;text-decoration:none;font-size:15px;">${esc(label)}</a>
    </td></tr></table>`;
}

/**
 * @param {object}  o
 * @param {string}  o.heading       the first line the reader sees
 * @param {string}  o.body          pre-escaped HTML from a template
 * @param {string} [o.preheader]    the grey line mail clients show beside the
 *                                  subject. Left unset, clients scrape the first
 *                                  words of the body, which is usually "Hi ,".
 * @param {string} [o.unsubscribeUrl] present only for marketing, where it is
 *                                  legally required and must be one click.
 */
function renderShell({ heading, body, preheader, unsubscribeUrl }) {
  const unsub = safeUrl(unsubscribeUrl);
  const footer = unsub
    ? `<p style="margin:16px 0 0;font-size:12px;color:${BRAND.soft};">
         You are receiving this because you subscribed to ${esc(BRAND.name)} updates.
         <a href="${unsub}" style="color:${BRAND.soft};">Unsubscribe</a> — one click, no sign-in, takes effect immediately.
       </p>`
    : `<p style="margin:16px 0 0;font-size:12px;color:${BRAND.soft};">
         You are receiving this because of an order, booking or account action at ${esc(BRAND.name)}.
       </p>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.ground};">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;">${esc(preheader || '')}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.ground};padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${BRAND.rule};border-radius:8px;">
    <tr><td style="padding:22px 30px 0;">
      <p style="margin:0;font-size:17px;font-weight:700;letter-spacing:.04em;color:${BRAND.accent};">${esc(BRAND.name)}</p>
    </td></tr>
    <tr><td style="padding:14px 30px 26px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink};font-size:15px;line-height:1.62;">
      <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;font-weight:600;color:${BRAND.ink};">${esc(heading)}</h1>
      ${body}
    </td></tr>
    <tr><td style="padding:0 30px 24px;border-top:1px solid ${BRAND.rule};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      ${footer}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/** Renders items as a table. Used by the order emails and the invoice. */
function itemsTable(items) {
  const cell = `padding:8px 10px;border-bottom:1px solid ${BRAND.rule};font-size:14px;`;
  const rows = (items || []).map((i) => `<tr>
      <td style="${cell}">${esc(i.product_name_snapshot || i.name || '')}</td>
      <td style="${cell}text-align:center;">${esc(i.quantity)}</td>
      <td style="${cell}text-align:right;">${esc(formatRupees(i.line_total_paise))}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 4px;">
    <tr>
      <th align="left"   style="padding:8px 10px;border-bottom:2px solid ${BRAND.rule};font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:${BRAND.soft};">Item</th>
      <th align="center" style="padding:8px 10px;border-bottom:2px solid ${BRAND.rule};font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:${BRAND.soft};">Qty</th>
      <th align="right"  style="padding:8px 10px;border-bottom:2px solid ${BRAND.rule};font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:${BRAND.soft};">Total</th>
    </tr>${rows}</table>`;
}

/** A right-aligned label/value line, for totals blocks. */
function totalsRow(label, value, strong) {
  const weight = strong ? 'font-weight:700;' : '';
  return `<tr>
    <td style="padding:3px 10px;text-align:right;font-size:14px;color:${BRAND.soft};${weight}">${esc(label)}</td>
    <td style="padding:3px 10px;text-align:right;font-size:14px;width:120px;${weight}">${esc(value)}</td>
  </tr>`;
}

// --------------------------------------------------------------------------
// Consent, suppression and dedupe
// --------------------------------------------------------------------------
// All three read the database, and all three fail OPEN for transactional mail
// and CLOSED for marketing. That asymmetry is deliberate: a database blip must
// not stop an order confirmation, and it must not become an excuse to mail
// somebody who asked us not to.
//
// db is required lazily. This module is pulled in by route files that load very
// early, and the config module has its own boot-time work.
function db() {
  // eslint-disable-next-line global-require
  return require('../../config/db');
}

async function isSuppressed(email, category) {
  try {
    const { rows } = await db().query(
      'SELECT reason FROM email_suppressions WHERE email = lower($1)', [String(email || '')]
    );
    if (!rows.length) return false;
    // A hard bounce means the mailbox does not exist. Continuing to send to it
    // damages the sending domain's reputation for every other customer, so it
    // blocks everything including transactional.
    if (rows[0].reason === 'hard_bounce') return true;
    // A complaint or a manual block is about unwanted contact, not a dead
    // mailbox — it stops marketing but must not stop someone receiving the
    // receipt for something they just paid for.
    return category === CATEGORY.MARKETING;
  } catch (err) {
    // Fail open for service mail, closed for marketing.
    return category === CATEGORY.MARKETING;
  }
}

/**
 * The global marketing kill switch (`email_marketing_enabled`).
 *
 * Migration 015 seeds this row and documents it as the switch that decides
 * whether marketing goes out, but nothing read it: flipping it to 'false' saved
 * successfully and every campaign kept sending. A control that reports success
 * and changes nothing is the failure mode 015's own header warns about — a
 * promise the software cannot keep.
 *
 * Fails OPEN, unlike the per-recipient consent check below. That looks like the
 * wrong direction for marketing until you note that hasMarketingConsent() fails
 * CLOSED on the same outage: with the database unreachable, no send can prove
 * consent, so nothing marketing goes out regardless of what this returns. Making
 * this one fail closed too would only mean a database blip silently disables a
 * switch the admin never touched.
 */
async function marketingEnabled() {
  try {
    const { rows } = await db().query(
      "SELECT value FROM site_settings WHERE key = 'email_marketing_enabled'"
    );
    return !rows.length || String(rows[0].value) !== 'false';
  } catch (err) {
    return true;
  }
}

async function hasMarketingConsent(email) {
  try {
    const { rows } = await db().query(
      "SELECT status FROM email_subscriptions WHERE lower(email) = lower($1)", [String(email || '')]
    );
    return rows.length > 0 && rows[0].status === 'confirmed';
  } catch (err) {
    return false; // no proof of consent is not consent
  }
}

async function unsubscribeUrlFor(email) {
  try {
    const { rows } = await db().query(
      'SELECT unsubscribe_token FROM email_subscriptions WHERE lower(email) = lower($1)', [String(email || '')]
    );
    if (!rows.length) return null;
    return `${clientUrl()}/unsubscribe?token=${encodeURIComponent(rows[0].unsubscribe_token)}`;
  } catch (err) {
    return null;
  }
}

/**
 * Claims the right to send. Returns the log row id, or null when this exact
 * event has already been sent.
 *
 * The claim goes in BEFORE the send, so two concurrent callers cannot both
 * pass. On failure the claim is released (dedupe_key set to NULL) so a retry is
 * possible — a failed send must never permanently poison its own event key.
 */
async function claimSend({ template, recipient, userId, subject, dedupeKey }) {
  try {
    const { rows } = await db().query(
      `INSERT INTO email_log (template, recipient, user_id, subject, status, dedupe_key)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [template, recipient, userId || null, String(subject).slice(0, 240), dedupeKey || null]
    );
    if (!rows.length) return { id: null, duplicate: true };
    return { id: rows[0].id, duplicate: false };
  } catch (err) {
    // No log table, no database, or a mocked client in a test. Send anyway —
    // rule 4. We lose dedupe for this one message, which is the cheaper loss.
    logger.warn('Email log unavailable — sending without dedupe', { template, error: err.message });
    return { id: null, duplicate: false };
  }
}

async function finishSend(logId, status, error, dedupeKey) {
  if (!logId) return;
  try {
    // Releasing the dedupe key on failure is what makes a retry possible.
    //
    // The success flag is its own parameter rather than re-using $2 inside the
    // CASE. Postgres deduces a parameter's type from every place it appears, so
    // `SET status = $2 ... CASE WHEN $2 = 'sent'` makes it varchar in one spot
    // and text in another and the statement is refused at runtime with
    // "inconsistent types deduced for parameter $2". A boolean computed here is
    // both immune to that and easier to read than a cast.
    await db().query(
      `UPDATE email_log
          SET status = $2,
              error = $3,
              dedupe_key = CASE WHEN $4 THEN dedupe_key ELSE NULL END
        WHERE id = $1`,
      [logId, status, error ? String(error).slice(0, 2000) : null, status === 'sent']
    );
  } catch (err) {
    logger.warn('Could not record email outcome', { logId, error: err.message });
  }
  // dedupeKey is accepted for symmetry with claimSend and to keep call sites
  // readable; the SQL above already has everything it needs.
  void dedupeKey;
}

// --------------------------------------------------------------------------
// The one send function
// --------------------------------------------------------------------------
/**
 * @param {object}   o
 * @param {string}   o.to
 * @param {string}   o.subject
 * @param {string}   o.html          a full document, normally from renderShell
 * @param {string}   o.template      short stable name, e.g. 'order_shipped'
 * @param {string}  [o.category]     defaults to transactional
 * @param {string}  [o.dedupeKey]    omit for events that may legitimately repeat
 * @param {string}  [o.userId]
 * @returns {Promise<{sent:boolean, reason?:string, duplicate?:boolean}>}
 */
async function sendMail({ to, subject, html, template, category, dedupeKey, userId }) {
  const cat = category || CATEGORY.TRANSACTIONAL;
  const name = template || 'unknown';
  const recipient = String(to || '').trim();

  if (!recipient) return { sent: false, reason: 'no_recipient' };

  // Subjects are a mail HEADER, and headers are newline-delimited. A CR or LF
  // reaching one is how header injection works — everything after it is read as
  // a new header, which is a way to add a Bcc. Templates build subjects from
  // order numbers and product names, which come from forms, so the guard
  // belongs here rather than in each of twenty-four templates. Nodemailer
  // encodes headers correctly today; this stops a future version, or a direct
  // sendMail call, from depending on that.
  // eslint-disable-next-line no-param-reassign
  subject = String(subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);

  if (await isSuppressed(recipient, cat)) {
    await recordSkip(name, recipient, userId, subject, 'suppressed');
    return { sent: false, reason: 'suppressed' };
  }

  // Checked before consent so the log distinguishes "we have this list switched
  // off" from "this person never opted in". Same outcome, completely different
  // thing to do about it.
  if (cat === CATEGORY.MARKETING && !(await marketingEnabled())) {
    await recordSkip(name, recipient, userId, subject, 'skipped_marketing_disabled');
    return { sent: false, reason: 'marketing_disabled' };
  }

  if (cat === CATEGORY.MARKETING && !(await hasMarketingConsent(recipient))) {
    await recordSkip(name, recipient, userId, subject, 'skipped_no_consent');
    return { sent: false, reason: 'no_consent' };
  }

  const claim = await claimSend({ template: name, recipient, userId, subject, dedupeKey });
  if (claim.duplicate) {
    logger.info('Email suppressed as duplicate', { template: name, dedupeKey });
    return { sent: false, reason: 'duplicate', duplicate: true };
  }

  const t = getTransporter();
  if (!t) {
    await finishSend(claim.id, 'skipped_not_configured', null, dedupeKey);
    logger.warn('SMTP not configured — email skipped', { subject, template: name });
    return { sent: false, reason: 'smtp_not_configured' };
  }

  try {
    await t.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: recipient,
      subject,
      html
    });
    await finishSend(claim.id, 'sent', null, dedupeKey);
    logger.info('Email sent', { subject, template: name });
    return { sent: true };
  } catch (err) {
    await finishSend(claim.id, 'failed', err.message, dedupeKey);
    // The recipient address is deliberately not in the log line — it is
    // personal data, and the template name plus the request id is enough to
    // trace a failure. It IS in email_log, which is access-controlled.
    logger.error('Email delivery failed', err, { subject, template: name });
    return { sent: false, reason: err.message };
  }
}

async function recordSkip(template, recipient, userId, subject, status) {
  try {
    await db().query(
      `INSERT INTO email_log (template, recipient, user_id, subject, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [template, recipient, userId || null, String(subject).slice(0, 240), status]
    );
  } catch (err) { /* best effort — never block on bookkeeping */ }
}

/**
 * The `reason` values from sendMail that mean "this will never succeed, stop
 * trying" — as opposed to a transient failure worth retrying.
 *
 * sendMail returns a fixed vocabulary for deliberate skips, but on a real SMTP
 * error it returns the driver's message verbatim, which cannot be enumerated.
 * So the test is membership of THIS set, not absence from some failure list:
 * anything not listed here is treated as retryable. That direction is the safe
 * one — the cost of a wrong guess is one extra delivery attempt, whereas
 * guessing the other way loses the email permanently.
 *
 * Callers that claim a row before sending (a `notified_at` marker, say) must
 * release that claim when the reason is NOT in this set, or a transient SMTP
 * blip silently marks the notification delivered forever.
 */
const TERMINAL_SKIP_REASONS = Object.freeze(new Set([
  'duplicate',            // another path already sent it — the dedupe key did its job
  'suppressed',           // hard bounce or complaint; retrying damages sender reputation
  'no_recipient',         // no address to send to; a retry has nothing new to work with
  'no_consent',           // marketing without opt-in; consent is not going to appear on retry
  'marketing_disabled'    // the admin switched the list off; that is a decision, not a fault
]));

module.exports = {
  CATEGORY,
  TERMINAL_SKIP_REASONS,
  BRAND,
  sendMail,
  renderShell,
  button,
  itemsTable,
  totalsRow,
  esc,
  safeUrl,
  formatRupees,
  clientUrl,
  hasMarketingConsent,
  isSuppressed,
  unsubscribeUrlFor,
  getTransporter,
  resetTransporter
};
