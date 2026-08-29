require('dotenv').config();

// BIZ-06 — pin the process timezone before anything reads a clock. Render runs
// UTC, 5.5 hours behind IST, so "today" in Node was still yesterday in Kolkata
// between midnight and 05:30 — which rejected same-day bookings made early in
// the morning and offset every daily revenue bucket. Set here rather than only
// in render.yaml so a local run, a cron job and a container all agree.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------------------
// Fail fast on missing secrets
// ---------------------------------------------------------------------------
// Without JWT_SECRET, jsonwebtoken throws on the first login — but the server
// starts, reports itself healthy, and serves public pages, so the failure looks
// like "login is broken" rather than "the deploy is misconfigured". Checking at
// boot turns a confusing runtime symptom into an obvious startup error.
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const PRODUCTION_ONLY_ENV = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'CLIENT_URL'];

if (process.env.NODE_ENV !== 'test') {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (process.env.NODE_ENV === 'production') missing.push(...PRODUCTION_ONLY_ENV.filter((k) => !process.env[k]));
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.length < 32) {
    // eslint-disable-next-line no-console
    console.error('FATAL: JWT_SECRET is too short. Use at least 32 characters (64 hex chars from `openssl rand -hex 32`).');
    process.exit(1);
  }
}

const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/products.routes');
const paymentRoutes = require('./routes/payments.routes');
const bookingRoutes = require('./routes/bookings.routes');
const adminRoutes = require('./routes/admin.routes');
const customerRoutes = require('./routes/customer.routes');
const addressRoutes = require('./routes/addresses.routes');
const bookingServicesRoutes = require('./routes/bookingServices.routes');
const couponRoutes = require('./routes/coupons.routes');
const siteRoutes = require('./routes/site.routes');
const supportRoutes = require('./routes/support.routes');
const engagementRoutes = require('./routes/engagement.routes');
const jobsRoutes = require('./routes/jobs.routes');
const db = require('./config/db');
const { normalizeOrigin } = require('./utils/cors');
const { logger, requestContext, getRequestId } = require('./utils/logger');

const app = express();

// Render (like most PaaS hosts) sits behind a reverse proxy, so every
// incoming request's socket IP is Render's proxy, not the real client.
// Without trust proxy set, express-rate-limit and req.ip both see that one
// proxy IP for every visitor — meaning the "10 login attempts per 15 min"
// limiter would apply to your ENTIRE user base combined, not per-customer,
// so a handful of legitimate failed logins could lock everyone out of
// login/registration simultaneously. `1` trusts exactly one hop (Render's
// own proxy), which is correct for this deployment — trusting proxies
// blindly (`true`) would let a client spoof their IP via X-Forwarded-For.
app.set('trust proxy', 1);

// Express advertises itself in an X-Powered-By header by default. It tells an
// attacker which stack to target and tells a customer nothing.
app.disable('x-powered-by');

// ---------- Security & infra middleware ----------
app.use(helmet({
  // FE-01 — the storefront and admin console are static files served by
  // Netlify, so their CSP lives in the `_headers` file shipped alongside them.
  // This one covers API responses. `default-src 'none'` is correct for a pure
  // JSON API: it serves no scripts, styles, images or frames of its own, so
  // nothing legitimate is blocked and an error page that somehow reflected
  // content could not execute anything.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"]
    }
  },
  // Tell browsers to use HTTPS for this host for a year. Render terminates TLS,
  // so the header is safe to send; it is what stops a first-request downgrade.
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // the storefront is a different origin
  referrerPolicy: { policy: 'no-referrer' }
}));

// Request correlation must come early so every log line from here on — including
// ones written by error handlers — carries the same id (OPS-04).
app.use(requestContext);

// CORS: matches CLIENT_URL against the browser's actual Origin header.
// Origin headers never include a trailing slash or a path (they're always
// scheme://host[:port]), so a CLIENT_URL value with a trailing slash — an
// easy copy-paste mistake — would silently fail every cross-origin request
// with no useful error beyond a generic CORS rejection in the browser
// console. Normalizing both sides here closes that specific failure mode.
//
// ADDITIONAL_ORIGINS exists for the staging/preview deploys Netlify creates per
// branch, which would otherwise each need a config change to be testable.
const allowedOrigins = [
  normalizeOrigin(process.env.CLIENT_URL),
  ...String(process.env.ADDITIONAL_CLIENT_ORIGINS || '').split(',').map(normalizeOrigin)
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header at all: server-to-server calls, curl, health probes and
      // the Razorpay webhook. CORS is a browser mechanism; there is nothing to
      // enforce for a caller that is not a browser.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(normalizeOrigin(origin))) return callback(null, true);
      logger.warn('Blocked cross-origin request', { origin });
      return callback(null, false);
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id']
  })
);

// Log lines carry the request id so a customer support ticket quoting it can be
// traced end to end through everything that request touched.
morgan.token('reqid', () => getRequestId() || '-');
app.use(morgan(
  process.env.NODE_ENV === 'production'
    ? ':remote-addr :method :url :status :res[content-length] - :response-time ms reqid=:reqid'
    : 'dev',
  { skip: () => process.env.NODE_ENV === 'test' }
));
app.use(cookieParser());

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '600', 10),
  standardHeaders: true,
  legacyHeaders: false,
  // CRITICAL — never rate-limit machine endpoints.
  //
  // Render probes `healthCheckPath` (/api/health) roughly every 5 seconds:
  // 180 requests per 15-minute window, against a 200-request budget. That
  // consumed ~90% of the allowance before a single customer arrived, so real
  // traffic tipped it over and /api/health began returning 429 — at which
  // point RENDER'S OWN PROBE saw a failing health check, marked the service
  // unhealthy and cycled it. The observed "server keeps going down" was the
  // rate limiter throttling the platform's monitor, not a crash.
  //
  // The webhook is exempt for a different but equally serious reason: a
  // throttled Razorpay webhook means a captured payment never gets recorded.
  // Its authenticity is already enforced by HMAC signature verification, which
  // is a far stronger control than an IP rate limit.
  skip: (req) => req.path === '/health' || req.path === '/ready' || req.path.startsWith('/payments/webhook')
});
app.use('/api/', limiter);

// Razorpay webhook needs the RAW body for signature verification —
// mount it BEFORE express.json() and only for that one path.
app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
// 2mb was generous for an API whose largest legitimate body is a product
// description. Lowering it shrinks what an unauthenticated caller can make the
// process allocate and parse.
app.use(express.json({ limit: '256kb' }));

// ---------- Routes ----------
// Liveness: is the process up? Deliberately does NOT touch the database —
// Render restarts the service when this fails, and restarting the API does not
// fix a database outage. It would turn a degraded read path into a crash loop.
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Readiness: is the process able to serve traffic? This one DOES check the
// database, for a load balancer or an uptime monitor that should route around a
// broken instance rather than restart it.
app.get('/api/ready', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ready', database: 'ok', time: new Date().toISOString() });
  } catch (err) {
    logger.error('Readiness check failed', err);
    res.status(503).json({ status: 'degraded', database: 'unreachable' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/booking-services', bookingServicesRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/site', siteRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/engage', engagementRoutes);

// Free-plan stand-in for the three cron services in render.yaml, which Render's
// free tier does not provide. Token-guarded, and inert until JOBS_TRIGGER_TOKEN
// is set. Left under the rate limiter above on purpose — see jobs.routes.js.
app.use('/api/internal/jobs', jobsRoutes);

// ---------- 404 + error handling ----------
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    // Full context, server-side only. Previously several handlers returned a
    // bare 500 having logged nothing at all, so a broken checkout was
    // discovered by a customer complaining rather than by the system (OPS-04).
    logger.error('Unhandled request error', err, {
      method: req.method,
      path: req.originalUrl,
      userId: req.user ? req.user.id : null
    });
  } else {
    logger.warn('Request rejected', { status, message: err.message, path: req.originalUrl });
  }

  if (res.headersSent) return next(err);

  // HYG-01 — never echo `err.code`, `err.detail` or a stack to the client.
  // Several routes used to return the raw Postgres SQLSTATE, which tells an
  // attacker their input reached the database and which constraint it hit. The
  // request id is what a customer should quote to support; it is meaningless to
  // anyone else and maps to the full detail in the logs.
  const body = { error: status >= 500 ? 'Something went wrong. Please try again.' : (err.message || 'Request could not be processed.') };
  const requestId = getRequestId();
  if (requestId) body.requestId = requestId;

  res.status(status).json(body);
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => logger.info('Chakrashri API listening', { port: PORT, tz: process.env.TZ }));

// ---------------------------------------------------------------------------
// Graceful shutdown and crash safety — OPS-01
// ---------------------------------------------------------------------------
// Render (and most hosts) send SIGTERM before killing a process during a deploy
// or restart. Without handling it, in-flight requests — including a checkout
// mid-transaction, holding a row lock on products — get cut off abruptly. This
// stops accepting new connections, lets existing requests finish, then closes
// the database pool cleanly.
let shuttingDown = false;

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal });

  server.close(async () => {
    try {
      await db.pool.end();
    } catch (err) {
      logger.error('Error closing DB pool', err);
    }
    logger.info('Shutdown complete');
    process.exit(exitCode);
  });

  // Safety net: if something hangs (e.g. a stuck connection), don't let the
  // process wait forever — force-exit after a bounded grace period.
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(exitCode || 1);
  }, parseInt(process.env.SHUTDOWN_GRACE_MS || '10000', 10)).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// THE BACKSTOP THIS PROCESS PREVIOUSLY HAD NONE OF.
//
// Since Node 15, an unhandled promise rejection terminates the process by
// default — abruptly, with no log line explaining why, killing every other
// in-flight request. Express 4 does not catch async handler rejections either,
// so any `await` that threw outside a try/catch took the whole API down. There
// was at least one real path: payments.routes.js awaited restoreOrderStock()
// inside a catch block with no outer try.
//
// middleware/asyncHandler.js now routes route-level rejections into the error
// handler above. These two listeners catch what it cannot reach — timers, event
// emitters, fire-and-forget work — and turn an abrupt death into a logged,
// graceful shutdown so the platform restarts a clean process and the logs say
// what happened.
process.on('unhandledRejection', (reason) => {
  logger.error('UNHANDLED PROMISE REJECTION — shutting down gracefully', reason instanceof Error ? reason : null, {
    reason: reason instanceof Error ? undefined : String(reason)
  });
  shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  // An uncaught exception leaves the process in an undefined state, so the only
  // safe action is to log and exit — never to continue serving. The graceful
  // path still lets in-flight requests drain rather than dropping them.
  logger.error('UNCAUGHT EXCEPTION — shutting down', err);
  shutdown('uncaughtException', 1);
});

module.exports = app;
