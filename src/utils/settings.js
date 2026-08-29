/**
 * Runtime commerce settings, read from the `site_settings` table — closes
 * HYG-03 and provides the configuration surface BIZ-07 (COD controls) needs.
 *
 * THE PROBLEM
 * The free-shipping threshold (₹999) and the shipping charge (₹79) were
 * hardcoded inside calculateOrderTotals(). Changing either — a festive-season
 * free-shipping promotion, say — meant a code edit, a pull request and a
 * deploy, for a number the client should be able to change themselves. The
 * site_settings table already existed for exactly this kind of value; it was
 * only being used for the cache-busting counter.
 *
 * CACHING
 * These are read on every checkout, so an uncached lookup would add a query to
 * the hottest path in the system. A short TTL means a change made in the admin
 * panel takes effect within seconds without a deploy, which is the behaviour a
 * shop owner expects from a settings screen.
 *
 * FAILING SAFE
 * If the table is unreachable, checkout must not fail — it falls back to the
 * same constants that were previously hardcoded. A settings outage degrades to
 * "yesterday's pricing rules", never to "no orders can be placed". The one
 * exception is that a failure is logged loudly, because silently serving stale
 * pricing is only acceptable if somebody knows it is happening.
 */
const db = require('../config/db');
const { logger } = require('./logger');

// These are the values that were previously compiled into the source. They
// remain the defaults, so behaviour is identical on a database with no rows in
// site_settings — which is what makes this change safe to deploy before the
// admin UI for editing them exists.
const DEFAULTS = Object.freeze({
  free_shipping_threshold_paise: 99900,   // ₹999
  shipping_flat_paise: 7900,              // ₹79
  cod_enabled: true,
  cod_max_order_paise: 500000,            // ₹5,000 — see BIZ-07
  cod_requires_verified_contact: false,   // flip on once OTP delivery is wired
  max_cod_rto_before_block: 2,
  order_reservation_expiry_minutes: 30,
  reviews_require_approval: false,

  // Migration 015 seeds these six rows, and every consumer reads them with its
  // own raw query and its own hardcoded fallback — but until they were listed
  // here they could not be changed. setSetting() rejects any key absent from
  // DEFAULTS, so `PUT /api/admin/settings/admin_alert_email` answered
  // "400 Unknown setting" and GET /settings never returned them: a settings row
  // the product seeds, documents and reads, but that no admin could edit.
  //
  // The values below are identical to 015's seeds and to each consumer's
  // fallback, so adding them changes no behaviour on any existing database.
  // It only makes them reachable from the admin console.
  admin_alert_email: '',                  // '' = fall back to ADMIN_ALERT_EMAIL, then FROM_EMAIL
  email_admin_alerts_enabled: true,
  email_marketing_enabled: true,
  abandoned_cart_email_after_minutes: 20,
  booking_reminder_hours_before: 24,
  low_stock_alert_threshold: 5
});

const NUMERIC_KEYS = new Set([
  'free_shipping_threshold_paise', 'shipping_flat_paise', 'cod_max_order_paise',
  'max_cod_rto_before_block', 'order_reservation_expiry_minutes',
  'abandoned_cart_email_after_minutes', 'booking_reminder_hours_before',
  'low_stock_alert_threshold'
]);
const BOOLEAN_KEYS = new Set([
  'cod_enabled', 'cod_requires_verified_contact', 'reviews_require_approval',
  'email_admin_alerts_enabled', 'email_marketing_enabled'
]);
// Validated on write rather than on use. This value becomes the `To:` header of
// every operational alert, so a malformed one does not fail until an alert is
// already being sent — which is exactly the moment the failure is least likely
// to be noticed, because the thing that was lost was the notification itself.
const EMAIL_KEYS = new Set(['admin_alert_email']);

const TTL_MS = parseInt(process.env.SETTINGS_CACHE_MS || '30000', 10);

let cache = null;
let cacheExpiresAt = 0;
let inFlight = null;

function coerce(key, rawValue) {
  if (rawValue === null || rawValue === undefined) return DEFAULTS[key];
  if (NUMERIC_KEYS.has(key)) {
    const n = parseInt(rawValue, 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULTS[key];
  }
  if (BOOLEAN_KEYS.has(key)) {
    return rawValue === 'true' || rawValue === '1' || rawValue === true;
  }
  if (EMAIL_KEYS.has(key)) return String(rawValue).trim();
  return rawValue;
}

/**
 * Deliberately strict: one bare address, no display name.
 *
 * The value is used directly as a `To:` header, so CR and LF must be rejected —
 * either would let a stored setting inject extra headers (Bcc:, Reply-To:) into
 * every alert. `<>,;` are excluded for the same reason: they are the characters
 * that turn one recipient into several. A display-name form ("Shop <a@b.com>")
 * is not worth the parsing surface for a field one person sets once.
 */
function isBareEmailAddress(value) {
  return /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[A-Za-z]{2,}$/.test(value);
}

async function load() {
  const { rows } = await db.query(
    'SELECT key, value FROM site_settings WHERE key = ANY($1)',
    [Object.keys(DEFAULTS)]
  );
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const resolved = {};
  for (const key of Object.keys(DEFAULTS)) {
    resolved[key] = coerce(key, byKey[key]);
  }
  return Object.freeze(resolved);
}

/**
 * Returns the current settings, cached. Never throws — on failure it returns
 * the last known-good values, or the compiled defaults if nothing has ever
 * loaded successfully.
 */
async function getSettings() {
  const now = Date.now();
  if (cache && cacheExpiresAt > now) return cache;

  // Collapse a thundering herd: on a cold cache under load, one query serves
  // every concurrent caller rather than each opening its own.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const fresh = await load();
      cache = fresh;
      cacheExpiresAt = Date.now() + TTL_MS;
      return fresh;
    } catch (err) {
      logger.error('Could not load site settings — falling back', err, {
        usingStaleCache: Boolean(cache)
      });
      // Short retry window so a transient blip does not pin stale values for
      // the full TTL, but long enough not to hammer a database that is down.
      cacheExpiresAt = Date.now() + 5000;
      cache = cache || Object.freeze({ ...DEFAULTS });
      return cache;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Call after any write to site_settings so the change is visible immediately. */
function invalidate() {
  cache = null;
  cacheExpiresAt = 0;
}

/**
 * Writes one setting. Values are stored as text (matching the existing table
 * shape) and validated against the same coercion rules used on read, so an
 * unusable value is rejected at write time rather than silently falling back
 * to a default forever.
 */
async function setSetting(key, value, adminUserId) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    throw Object.assign(new Error(`Unknown setting: ${key}`), { status: 400 });
  }
  const asText = String(value);
  const coerced = coerce(key, asText);
  if (NUMERIC_KEYS.has(key) && String(coerced) !== asText.trim()) {
    throw Object.assign(new Error(`${key} must be a non-negative integer.`), { status: 400 });
  }
  if (BOOLEAN_KEYS.has(key) && !['true', 'false', '1', '0'].includes(asText)) {
    throw Object.assign(new Error(`${key} must be true or false.`), { status: 400 });
  }
  if (EMAIL_KEYS.has(key) && coerced !== '' && !isBareEmailAddress(coerced)) {
    throw Object.assign(
      new Error(`${key} must be a single email address with no display name, or empty to fall back to FROM_EMAIL.`),
      { status: 400 }
    );
  }
  // Store the canonical form, not the raw input.
  //
  // For emails: " a@b.com " would otherwise sit in the table with the whitespace
  // it was pasted with, working only because every reader remembers to trim it.
  //
  // For booleans this is a correctness fix, not tidiness. setSetting accepts
  // '0' and '1' as well as 'true'/'false', but the two email switches
  // (email_admin_alerts_enabled, email_marketing_enabled) are read straight off
  // the row by templates.js and engine.js, which test `value !== 'false'`. Store
  // a literal '0' and those readers see "not the string false" and treat the
  // switch as ON, while this module's own coerce() reports it as OFF. The
  // settings screen would show marketing disabled while marketing kept sending.
  // Writing 'true'/'false' makes every reader agree.
  const storedValue = (EMAIL_KEYS.has(key) || BOOLEAN_KEYS.has(key)) ? String(coerced) : asText;
  await db.query(
    `INSERT INTO site_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, storedValue, adminUserId || null]
  );
  invalidate();
  return { key, value: coerced };
}

module.exports = { getSettings, setSetting, invalidate, DEFAULTS };
