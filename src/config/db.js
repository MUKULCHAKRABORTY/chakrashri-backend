const { Pool, types } = require('pg');

// ---------------------------------------------------------------------------
// BIGINT parsing — closes DATA-02
// ---------------------------------------------------------------------------
// node-postgres returns int8 (BIGINT, type OID 20) as a JavaScript *string* by
// default, because a 64-bit integer can exceed Number.MAX_SAFE_INTEGER and
// silently lose precision. Every money column in this schema is BIGINT, so
// every price, total and refund amount arrived as a string.
//
// Most arithmetic coerced harmlessly ('50000' * 2 === 100000), which is why
// nothing had broken — but two paths passed those strings straight to
// Razorpay as an `amount`, and any future `+` near them would concatenate two
// amounts into a wrong number rather than throwing. Inconsistent typing in a
// money domain is a latent bug waiting for the wrong operator.
//
// Parsing to Number is safe HERE specifically: amounts are paise, so
// Number.MAX_SAFE_INTEGER (9.007e15) is about ₹90 trillion. Counts from
// COUNT(*) are equally far from the boundary. If a genuinely large BIGINT is
// ever introduced (a bytes-transferred counter, say), it must be cast to text
// in the query rather than reverting this.
types.setTypeParser(types.builtins.INT8, (value) => (value === null ? null : parseInt(value, 10)));

// NUMERIC (OID 1700) is deliberately LEFT as a string. It is arbitrary
// precision by design — gst_rate, discount_percent and rating live here — and
// silently converting it to a float would reintroduce exactly the rounding
// drift the integer-paise convention exists to avoid. Call sites use
// Number(...) explicitly where they need arithmetic, which keeps the
// conversion visible at the point it happens.

// ---------------------------------------------------------------------------
// TLS mode — closes a scheduled, silent downgrade
// ---------------------------------------------------------------------------
// Two things about how `pg` resolves SSL are easy to get wrong, and this
// codebase had both.
//
// FIRST: when a config carries BOTH a connectionString and an explicit `ssl`
// property, pg re-parses the connection string and the parsed result WINS. So
// an `sslmode=` in DATABASE_URL silently overrides `ssl: ...` set here, and any
// env var gating that property is dead config. The comment that used to sit on
// this line described DB_SSL as the control for certificate validation. It was
// not, and a misleading comment on a security control is worse than none.
//
// SECOND, and the reason this function exists: pg currently treats sslmode
// 'require', 'prefer' and 'verify-ca' as aliases for 'verify-full' — encrypted
// AND authenticated. pg v9 / pg-connection-string v3 will adopt libpq
// semantics, where 'require' means encrypted but NOT authenticated: the server
// may present any certificate at all and the connection still succeeds. That is
// a man-in-the-middle window that opens on a routine dependency bump, with no
// code change, no error, and no test failure. Postgres emits a deprecation
// warning about it on every boot today.
//
// So resolve it explicitly and now. 'require' and 'verify-ca' are rewritten to
// 'verify-full', which is EXACTLY what they already do today — this changes no
// behaviour on any current version, and survives the change on the next one.
//
// Deliberately NOT rewritten:
//   'prefer'  — means "try TLS, fall back to plaintext". Forcing verify-full
//               would break a local dev Postgres with no TLS at all, so it is
//               warned about rather than changed.
//   'disable' / 'allow' — an explicit choice, usually a local socket.
//   localhost / 127.0.0.1 / ::1 — a dev database commonly has a self-signed
//               certificate that verify-full is right to reject. Managed
//               providers (Neon, RDS, Supabase) use publicly trusted CAs, so
//               verify-full works there with no custom CA bundle.
//
// Escape hatch: DB_SSL_NORMALIZE=false leaves the URL untouched.
const ALIASED_SSL_MODES = new Set(['require', 'verify-ca']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

function normalizeConnectionString(raw) {
  const result = { connectionString: raw, changed: false, from: null, warning: null };
  if (!raw || process.env.DB_SSL_NORMALIZE === 'false') return result;

  let url;
  try {
    url = new URL(raw);
  } catch {
    // A connection string pg accepts but WHATWG URL does not (a key=value DSN,
    // say). Never break startup over a cosmetic fix — hand back the original.
    return result;
  }

  const mode = (url.searchParams.get('sslmode') || '').toLowerCase();
  if (!mode) return result;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOCAL_HOSTS.has(host)) return result;

  if (mode === 'prefer') {
    result.warning =
      "DATABASE_URL uses sslmode=prefer, which permits an UNENCRYPTED fallback. " +
      'Use sslmode=verify-full for a managed database.';
    return result;
  }

  if (!ALIASED_SSL_MODES.has(mode)) return result;

  url.searchParams.set('sslmode', 'verify-full');
  result.connectionString = url.toString();
  result.changed = true;
  result.from = mode;
  return result;
}

const sslResolution = normalizeConnectionString(process.env.DATABASE_URL);

// Shared connection settings. Exported so a long-running maintenance task (the
// migration runner) can build its own pool from the same base without
// duplicating the SSL configuration and drifting from it.
const basePoolConfig = {
  connectionString: sslResolution.connectionString,
  // Only consulted when DATABASE_URL carries no sslmode of its own — a parsed
  // sslmode overrides this property (see above). rejectUnauthorized: true
  // validates the server's certificate against Node's trusted CA store; false
  // would leave the connection encrypted but unauthenticated, open to a
  // man-in-the-middle presenting any certificate at all.
  //
  // This stays OPT-IN rather than defaulting to on, and the reason is worth
  // keeping: the CI job and the integration tests run against a local Postgres
  // that speaks no TLS at all. Defaulting this to a verifying TLS config would
  // make every one of those connections fail, to protect a loopback socket that
  // was never exposed. Managed databases carry sslmode in the URL and are
  // covered by the normalisation above, which is where the real protection is.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  // Bound how long a checked-out connection may block. Without these, a
  // network partition to Neon leaves requests hanging until the client's own
  // timeout, holding a pool slot the whole time — 20 of those and the API is
  // effectively down while reporting itself healthy.
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '15000', 10),
  // A checkout transaction holds row locks; an idle-in-transaction session
  // holding them indefinitely blocks every other buyer of the same product.
  idle_in_transaction_session_timeout: parseInt(process.env.DB_IDLE_TX_TIMEOUT_MS || '20000', 10)
};

// Say what happened, once, at boot. Only speaks when there is something to say:
// a local test database with no sslmode in its URL stays silent, so CI output is
// unchanged. Uses the same lazy-logger pattern as the pool error handler because
// this module loads before utils/logger is safe to depend on.
if (sslResolution.changed || sslResolution.warning) {
  const notice = sslResolution.changed
    ? {
      level: 'info',
      msg: `Database TLS mode normalised: sslmode=${sslResolution.from} -> sslmode=verify-full`,
      detail:
          'Identical behaviour on the current pg version; this pins it so a future ' +
          'pg upgrade cannot silently drop certificate verification. Set ' +
          'DB_SSL_NORMALIZE=false to opt out, or put sslmode=verify-full in DATABASE_URL ' +
          'to make it explicit at the source.'
    }
    : { level: 'warn', msg: sslResolution.warning, detail: null };
  try {
    require('../utils/logger').logger[notice.level](notice.msg, { detail: notice.detail });
  } catch {
    // eslint-disable-next-line no-console
    console.log(`[db] ${notice.msg}${notice.detail ? ' — ' + notice.detail : ''}`);
  }
}

const pool = new Pool(basePoolConfig);

/**
 * A pool for work that is SUPPOSED to take a long time.
 *
 * THE BUG THIS FIXES: the migration runner used the shared request pool, which
 * carries a 15-second statement_timeout. That bound is correct for an HTTP
 * request — it stops a stuck query holding a pool slot — and completely wrong
 * for a migration. Migration 014 exists specifically to build indexes on the
 * order and order_items tables its own header says are going to grow, and 013
 * backfills every order's shipping address. Both finish instantly on an empty
 * database and are cancelled with SQLSTATE 57014 on a populated one.
 *
 * Because render.yaml runs `npm run migrate` as a preDeployCommand, that
 * cancellation does not just skip a migration — it fails the deploy. And since
 * 014 runs outside a transaction, a cancelled CONCURRENTLY build also leaves an
 * INVALID index behind.
 *
 * So: no statement timeout, no idle-in-transaction timeout, and a small pool,
 * because a migration is one connection doing one thing at a time.
 */
function createMaintenancePool(overrides) {
  return new Pool({
    ...basePoolConfig,
    max: 2,
    statement_timeout: 0,
    idle_in_transaction_session_timeout: 0,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
    ...(overrides || {})
  });
}

pool.on('error', (err) => {
  // Lazily required: config/db is loaded very early and utils/logger must not
  // become a hard dependency of establishing a connection.
  try {
    require('../utils/logger').logger.error('Unexpected error on idle Postgres client', err);
  } catch {
    // eslint-disable-next-line no-console
    console.error('Unexpected error on idle Postgres client', err);
  }
});

// Postgres SQLSTATEs that mean "this transaction lost a race; running it again
// is likely to succeed". Retrying anything else would risk repeating a
// genuinely invalid write.
const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01'  // deadlock_detected
]);

const MAX_TX_ATTEMPTS = parseInt(process.env.DB_TX_MAX_ATTEMPTS || '3', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` inside a BEGIN/COMMIT transaction on a single checked-out client.
 * Use this for any multi-statement write where partial failure or concurrent
 * requests could corrupt data (e.g. checking + decrementing stock, which must
 * not interleave between two simultaneous checkouts of the same item).
 * `fn` receives a client with the same `.query()` signature as the pool.
 *
 * DEADLOCK RETRY (part of DB-01)
 * Even with consistent lock ordering (see the ORDER BY in utils/orders.js),
 * Postgres can abort a transaction with 40P01/40001 under contention. Without
 * a retry that surfaces to the customer as a failed checkout for a purchase
 * that would have succeeded a millisecond later. The retry is bounded, uses
 * jittered backoff so two colliding requests do not immediately re-collide,
 * and only ever fires for those two SQLSTATEs.
 *
 * IMPORTANT: `fn` must be idempotent with respect to anything outside the
 * transaction. Everything inside rolls back cleanly; a side effect such as
 * calling a payment gateway does not, so those belong outside.
 */
async function withTransaction(fn, options) {
  const maxAttempts = (options && options.maxAttempts) || MAX_TX_ATTEMPTS;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Defensive: explicitly pin the schema search path for this transaction.
      // db.query() (used by simple reads elsewhere in the app) has never shown
      // this problem, only writes routed through a transaction client — this
      // costs nothing and is a safe no-op if search_path was already correct.
      await client.query('SET search_path TO public');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // A failed ROLLBACK means the connection is already broken. Report the
        // original error — the rollback failure is a symptom, not the cause.
        try {
          require('../utils/logger').logger.warn('ROLLBACK failed', { message: rollbackErr.message });
        } catch { /* logging must never mask the real error */ }
      }
      lastError = err;
      if (!RETRYABLE_SQLSTATES.has(err.code) || attempt === maxAttempts) throw err;

      const backoffMs = Math.round((2 ** (attempt - 1)) * 25 * (1 + Math.random()));
      try {
        require('../utils/logger').logger.warn('Retrying transaction after contention', {
          sqlstate: err.code, attempt, maxAttempts, backoffMs
        });
      } catch { /* ignore */ }
      await sleep(backoffMs);
    } finally {
      client.release();
    }
  }
  throw lastError;
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  withTransaction,
  pool,
  createMaintenancePool,
  basePoolConfig,
  RETRYABLE_SQLSTATES,
  // Exported for test/security.test.js. A TLS decision that is only ever
  // exercised by booting against a real managed database is a TLS decision
  // nobody checks.
  normalizeConnectionString
};
