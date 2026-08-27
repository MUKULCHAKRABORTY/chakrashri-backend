const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { logger, setUserId } = require('../utils/logger');
const { requireCapability, CAPABILITIES, capabilitiesForRole } = require('./capabilities');
const { UUID_RE } = require('./validate');

/**
 * Verifies the JWT sent in the Authorization: Bearer <token> header and
 * attaches the decoded payload to req.user.
 *
 * ---------------------------------------------------------------------------
 * TOKEN REVOCATION (AUTH-03)
 * ---------------------------------------------------------------------------
 * JWTs are stateless: once signed, they are valid until they expire, no matter
 * what happens to the account. That meant resetting a password — the single
 * most common action a worried customer takes — did NOT end an attacker's
 * existing session. It retired every outstanding *reset* token correctly, but
 * the seven-day access token kept working.
 *
 * The fix is a `token_version` integer on the user. It is embedded in every
 * token this app issues (claim `tv`) and compared against the stored value on
 * each request. Bumping the column invalidates every token issued before the
 * bump — which is what "log out everywhere" actually means. It is incremented
 * by: password reset, explicit logout-everywhere, and account deactivation.
 *
 * ROLLOUT, deliberately gradual:
 * Tokens issued BEFORE this deploy carry no `tv` claim. Rejecting them would
 * force-logout every signed-in customer at the moment of deploy — a real
 * availability and conversion cost to fix a latent issue. So a token with no
 * `tv` is accepted during a grace window and simply skips the check; it cannot
 * outlive JWT_EXPIRES_IN anyway. Set REQUIRE_TOKEN_VERSION=true once that
 * window has passed (7 days by default) to close it permanently. The env var
 * exists so this is a config flip, not a code change and redeploy.
 *
 * PERFORMANCE
 * A naive implementation adds a database round-trip to every authenticated
 * request. A tiny TTL cache keeps the common path in memory; the TTL bounds
 * how long a revoked token can still be honoured (default 10s), which is the
 * standard trade-off and orders of magnitude better than the 7 days it
 * replaces. The cache is per-process and self-limiting.
 */

const REQUIRE_TOKEN_VERSION = process.env.REQUIRE_TOKEN_VERSION === 'true';
const TOKEN_VERSION_TTL_MS = parseInt(process.env.TOKEN_VERSION_CACHE_MS || '10000', 10);
const TOKEN_VERSION_CACHE_MAX = 5000;

const tokenVersionCache = new Map(); // userId -> { version, expiresAt }

function cacheGet(userId) {
  const hit = tokenVersionCache.get(userId);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    tokenVersionCache.delete(userId);
    return undefined;
  }
  return hit.version;
}

function cacheSet(userId, version) {
  // Cheap bound: a full clear beats an LRU here because entries are tiny and
  // expire in seconds anyway — the only thing that must not happen is
  // unbounded growth under a token-enumeration attempt.
  if (tokenVersionCache.size >= TOKEN_VERSION_CACHE_MAX) tokenVersionCache.clear();
  tokenVersionCache.set(userId, { version, expiresAt: Date.now() + TOKEN_VERSION_TTL_MS });
}

/** Called after any action that must end existing sessions for a user. */
function invalidateTokenVersionCache(userId) {
  tokenVersionCache.delete(userId);
}

async function currentTokenVersion(userId) {
  const cached = cacheGet(userId);
  if (cached !== undefined) return cached;
  const { rows } = await db.query(
    'SELECT token_version, is_active FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length || rows[0].is_active === false) {
    cacheSet(userId, null); // null = no valid session possible
    return null;
  }
  const version = Number(rows[0].token_version) || 0;
  cacheSet(userId, version);
  return version;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }

  const hasVersionClaim = payload.tv !== undefined && payload.tv !== null;

  if (hasVersionClaim || REQUIRE_TOKEN_VERSION) {
    if (!hasVersionClaim) {
      // Grace window is over and this is a pre-upgrade token.
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }

    // Validate the shape of the `id` claim BEFORE it reaches Postgres.
    //
    // Without this, a token carrying a malformed id (an empty string, or
    // anything not a UUID) makes the lookup raise 22P02, which the catch below
    // correctly refuses — but reports as 503 "service unavailable". That is the
    // wrong answer twice over: it tells the caller the server is broken when
    // their token is, it fills error monitoring with noise that hides real
    // database problems, and it lets anyone make the API look unhealthy by
    // sending a signed token with a junk id. A bad token is 401.
    if (!UUID_RE.test(String(payload.id || ''))) {
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }

    try {
      const current = await currentTokenVersion(payload.id);
      if (current === null || Number(payload.tv) !== current) {
        return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      }
    } catch (err) {
      // Fail CLOSED. An authorization check that cannot complete must not be
      // treated as a pass — the alternative is that a database blip silently
      // re-enables every revoked session in the system.
      logger.error('Token version check failed', err, { userId: payload.id });
      return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
    }
  }

  req.user = payload; // { id, role, email, tv }
  req.capabilities = capabilitiesForRole(payload.role);
  setUserId(payload.id);
  return next();
}

/**
 * Legacy role gate, kept because it is still the right tool for the coarse
 * customer-vs-staff boundary (e.g. "this endpoint is not for customers").
 * For anything that moves money or reads bulk PII, use requireCapability —
 * see middleware/capabilities.js for why.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
  requireCapability,
  CAPABILITIES,
  invalidateTokenVersionCache,
  // exported for tests
  _tokenVersionCache: tokenVersionCache
};
