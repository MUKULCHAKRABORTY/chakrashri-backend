/**
 * Structured JSON logging with per-request correlation — closes OPS-04.
 *
 * WHY THIS EXISTS
 * Several handlers used to `catch` an error and return a bare 500 without
 * recording anything at all, and the places that did log used `console.error`
 * with no request id, no user id and no route. The practical consequence was
 * that a broken checkout was discovered by a customer complaining, not by the
 * system — and once discovered, there was nothing to correlate.
 *
 * WHY NO DEPENDENCY
 * pino is the better long-term answer and this module is deliberately shaped
 * like it (level methods, a child-logger-ish bind, JSON lines) so swapping is
 * a small change. It is written dependency-free on purpose: the deploy runs
 * `npm install` on every push, and adding a logging dependency to fix an
 * observability gap would widen the supply-chain surface at the same time.
 * If/when pino is adopted, only this file changes.
 *
 * WHY AsyncLocalStorage
 * It is in Node core (node:async_hooks) and carries the request id through
 * every await in a handler without threading a context argument through every
 * function signature. That means utils/orders.js can log with the right
 * request id without knowing anything about HTTP.
 *
 * NEVER LOGGED: request bodies, Authorization headers, passwords, tokens,
 * card data, or birth_details. Log identifiers, not payloads.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('crypto');

const store = new AsyncLocalStorage();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = LEVELS[(process.env.LOG_LEVEL || '').toLowerCase()] ||
  (process.env.NODE_ENV === 'test' ? LEVELS.error : LEVELS.info);

// Belt-and-braces: even though nothing intentionally logs these, a future
// caller passing a whole object through could. Redact by key name.
const REDACT_KEYS = new Set([
  'password', 'newPassword', 'password_hash', 'token', 'authorization',
  'jwt', 'secret', 'razorpay_signature', 'signature', 'birth_details',
  'birthDetails', 'otp', 'card', 'cvv'
]);

function redact(value, depth) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.has(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level, msg, fields) {
  if (LEVELS[level] < configuredLevel) return;
  const ctx = store.getStore();
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx ? { requestId: ctx.requestId, userId: ctx.userId, route: ctx.route } : {}),
    ...(fields ? redact(fields, 0) : {})
  };
  // stdout for everything: Render, Docker and journald all collect stdout, and
  // splitting across streams makes ordering non-deterministic in aggregators.
  process.stdout.write(JSON.stringify(line) + '\n');
}

/**
 * Normalises anything thrown into loggable fields. Error instances lose their
 * message and stack under JSON.stringify, which is the single most common
 * reason a production log says only "{}" at the moment it matters most.
 */
function errorFields(err) {
  if (!err) return { err: null };
  if (err instanceof Error) {
    return {
      err: {
        name: err.name,
        message: err.message,
        code: err.code || undefined,        // Postgres SQLSTATE, when present
        constraint: err.constraint || undefined,
        status: err.status || undefined,
        stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
      }
    };
  }
  return { err: String(err) };
}

const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, errOrFields, extra) => {
    const fields = errOrFields instanceof Error
      ? { ...errorFields(errOrFields), ...(extra || {}) }
      : { ...(errOrFields || {}), ...(extra || {}) };
    emit('error', msg, fields);
  }
};

/**
 * Express middleware: assigns each request a correlation id, echoes it back in
 * `X-Request-Id` so a customer support ticket can quote it, and binds it for
 * the entire async lifetime of the request.
 *
 * An inbound X-Request-Id is honoured only if it looks like an id we generated
 * — never echo arbitrary client input into log lines that a human will read.
 */
function requestContext(req, res, next) {
  const inbound = req.headers['x-request-id'];
  const requestId = (typeof inbound === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(inbound))
    ? inbound
    : crypto.randomBytes(9).toString('base64url');

  res.setHeader('X-Request-Id', requestId);
  const ctx = { requestId, userId: null, route: `${req.method} ${req.path}` };
  req.requestId = requestId;
  store.run(ctx, () => next());
}

/** Called by requireAuth once the caller is known, so later lines carry it. */
function setUserId(userId) {
  const ctx = store.getStore();
  if (ctx) ctx.userId = userId;
}

function getRequestId() {
  const ctx = store.getStore();
  return ctx ? ctx.requestId : null;
}

module.exports = { logger, requestContext, setUserId, getRequestId, errorFields };
