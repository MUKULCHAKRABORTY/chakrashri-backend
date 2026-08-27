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
  reviews_require_approval: false
});

const NUMERIC_KEYS = new Set([
  'free_shipping_threshold_paise', 'shipping_flat_paise', 'cod_max_order_paise',
  'max_cod_rto_before_block', 'order_reservation_expiry_minutes'
]);
const BOOLEAN_KEYS = new Set([
  'cod_enabled', 'cod_requires_verified_contact', 'reviews_require_approval'
]);

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
  return rawValue;
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
  await db.query(
    `INSERT INTO site_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, asText, adminUserId || null]
  );
  invalidate();
  return { key, value: coerced };
}

module.exports = { getSettings, setSetting, invalidate, DEFAULTS };
