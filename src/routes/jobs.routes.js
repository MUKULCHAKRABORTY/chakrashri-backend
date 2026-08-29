/**
 * FREE-TIER JOB TRIGGER — the stand-in for the three cron services in
 * render.yaml that Render's free plan does not provide.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * render.yaml defines three cron services. On the free plan they do not exist,
 * and skipping them is not cosmetic:
 *
 *   • expiry-sweep       — without it, every abandoned checkout holds its stock
 *                          forever and the catalog slowly sells out of nothing.
 *   • payment-reconcile  — without it, "customer paid, webhook was throttled"
 *                          ends with the order cancelled AND the money captured.
 *                          This matters MORE on the free plan, not less: a free
 *                          instance sleeps after ~15 minutes, so a Razorpay
 *                          webhook can arrive at a cold instance and time out.
 *   • scheduled-emails   — restock alerts, booking reminders, abandoned-checkout
 *                          recovery, daily digest.
 *
 * A free external scheduler (cron-job.org, UptimeRobot, Better Stack) calls this
 * endpoint on a schedule. The same call also keeps the instance warm, so it
 * replaces the separate keep-alive ping rather than adding to it.
 *
 * ---------------------------------------------------------------------------
 * WHY CHILD PROCESSES AND NOT require()
 * ---------------------------------------------------------------------------
 * This is the important one. Two of the three scripts CANNOT be imported:
 * release-expired-orders.js and reconcile-payments.js call main() at the top
 * level, then `db.pool.end()` and `process.exit()`. Requiring either one from
 * the web process would run it immediately, close the connection pool the API
 * is serving requests from, and then exit the server. (send-scheduled-emails.js
 * is guarded with `require.main === module` and exports its functions, so only
 * one of the three is import-safe — which is exactly the kind of asymmetry that
 * turns into a 3am outage.)
 *
 * Spawning them as their own process is what Render's cron would do anyway. It
 * preserves their exit codes, keeps their pool separate from the API's, and
 * means a job that crashes cannot take the API with it.
 *
 * ---------------------------------------------------------------------------
 * SECURITY
 * ---------------------------------------------------------------------------
 * The token is read from a header, never a query string: morgan logs every
 * request URL, so `?token=...` would write the credential into the log on every
 * single run.
 *
 * With JOBS_TRIGGER_TOKEN unset the endpoint refuses to do anything (503). It
 * fails CLOSED — a missing configuration must never leave a "run arbitrary
 * background work" endpoint open to the internet.
 *
 * This router is deliberately left under the global rate limiter. Legitimate
 * traffic here is a handful of requests per hour; the limiter is free
 * protection against someone brute-forcing the token.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { logger } = require('../utils/logger');

const router = express.Router();

/** Job name (used in the URL and the logs) -> the script Render's cron would run. */
const JOBS = Object.freeze({
  'expiry-sweep': 'release-expired-orders.js',
  'payment-reconcile': 'reconcile-payments.js',
  'scheduled-emails': 'send-scheduled-emails.js'
});

// Order matters. The sweep cancels expired orders and releases their stock;
// running reconciliation immediately afterwards gives the reconciler the chance
// to notice that one of those "expired" orders was in fact paid, before anyone
// sees a wrongly-cancelled order. Emails run last so they describe settled state.
const RUN_ORDER = ['expiry-sweep', 'payment-reconcile', 'scheduled-emails'];

// A single job may not run longer than this. Without a cap, one hung child
// (a stalled Razorpay call, a lost database connection) would hold the lock
// below forever and silently stop every future run.
const JOB_TIMEOUT_MS = parseInt(process.env.JOBS_TIMEOUT_MS || '240000', 10); // 4 min

// If a run somehow outlives this, assume the process was restarted mid-run and
// let a new one start. Belt and braces on top of the per-job timeout.
const LOCK_STALE_MS = JOB_TIMEOUT_MS * RUN_ORDER.length + 60000;

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');

let running = false;
let runStartedAt = null;
let lastRun = null;

/**
 * Constant-time comparison. A plain `===` on a secret leaks its length and,
 * in principle, its content through timing — cheap to avoid, so avoid it.
 */
function tokenMatches(provided) {
  const expected = process.env.JOBS_TRIGGER_TOKEN || '';
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which would itself be a length
  // oracle — hash both sides first so the comparison is always equal-length.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Token from `Authorization: Bearer <t>` or `X-Jobs-Token: <t>`. Never the URL. */
function presentedToken(req) {
  const auth = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return (req.get('x-jobs-token') || '').trim();
}

function requireToken(req, res, next) {
  const configured = process.env.JOBS_TRIGGER_TOKEN || '';
  if (configured.length < 32) {
    // Fail closed, and say why — an operator reading this needs to know the
    // endpoint is inert rather than assuming their jobs are running.
    logger.warn('Job trigger called but JOBS_TRIGGER_TOKEN is unset or too short', {
      configuredLength: configured.length
    });
    return res.status(503).json({
      error: 'Job trigger is not configured. Set JOBS_TRIGGER_TOKEN (32+ characters) to enable it.'
    });
  }
  // "No token arrived" and "the wrong token arrived" are the same 401 to a
  // caller, but they are completely different problems to fix — a scheduler
  // whose header was never saved versus one holding a stale value. Saying which
  // leaks nothing about the correct token and turns a guessing game into a
  // one-line diagnosis. (This distinction is here because a real cron-job.org
  // schedule returned 401 every ten minutes and the message could not say why.)
  const presented = presentedToken(req);
  if (!presented) {
    logger.warn('Job trigger called with no token header', { ip: req.ip });
    return res.status(401).json({
      error: 'No job trigger token was presented. Send it as the header "X-Jobs-Token", or as "Authorization: Bearer <token>".'
    });
  }
  if (!tokenMatches(presented)) {
    // Length is logged, never the value: it is the single most useful clue for
    // a truncated copy-paste, and on its own it reveals nothing usable.
    logger.warn('Job trigger rejected a bad token', { ip: req.ip, presentedLength: presented.length });
    return res.status(401).json({
      error: 'Invalid job trigger token. The value sent does not match JOBS_TRIGGER_TOKEN on the server.'
    });
  }
  return next();
}

/**
 * Runs one script as its own process. Never rejects: a job failing is a normal,
 * reportable outcome, not an exception — one broken job must not prevent the
 * others in the sequence from running.
 */
function runOne(name) {
  return new Promise((resolve) => {
    const file = JOBS[name];
    const startedAt = Date.now();
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, file)], {
      env: process.env,
      cwd: path.join(__dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    const capture = (chunk) => { if (out.length < 4000) out += chunk.toString(); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      logger.error('Job exceeded its time limit and was killed', null, { job: name, ms: JOB_TIMEOUT_MS });
      child.kill('SIGKILL');
    }, JOB_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.error('Job could not be started', err, { job: name });
      resolve({ job: name, ok: false, code: null, ms: Date.now() - startedAt, error: err.message });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - startedAt;
      // These scripts exit non-zero deliberately when a human needs to look —
      // a payment mismatch, a failed send. That is a real signal, so log it as
      // a failure rather than flattening every run to "done".
      const ok = code === 0;
      if (ok) logger.info('Job finished', { job: name, ms });
      else logger.error('Job reported a failure', null, { job: name, code, signal, ms, output: out.slice(-1500) });
      resolve({ job: name, ok, code, signal: signal || null, ms });
    });
  });
}

/** Runs the requested jobs in sequence. Sequential on purpose: a free instance
 *  has ~512MB, and three Node processes each holding a pg pool is not worth the
 *  few seconds saved. */
async function runSequence(names) {
  const results = [];
  for (const name of names) results.push(await runOne(name));
  return results;
}

function startRun(names, trigger) {
  running = true;
  runStartedAt = Date.now();
  // Deliberately not awaited: the caller is an external cron with a short HTTP
  // timeout (cron-job.org allows 30s, and a cold start alone can take ~50s).
  // It gets 202 immediately; the outcome goes to the log and to GET /status.
  runSequence(names)
    .then((results) => {
      lastRun = {
        trigger,
        jobs: results,
        finishedAt: new Date().toISOString(),
        ms: Date.now() - runStartedAt,
        ok: results.every((r) => r.ok)
      };
      logger.info('Job run complete', { trigger, ok: lastRun.ok, ms: lastRun.ms });
    })
    .catch((err) => {
      // runOne never rejects, so reaching here means a bug in this file rather
      // than a failing job. Record it instead of leaving the lock stuck.
      logger.error('Job runner crashed', err, { trigger });
      lastRun = { trigger, error: err.message, finishedAt: new Date().toISOString(), ok: false };
    })
    .finally(() => {
      running = false;
      runStartedAt = null;
    });
}

function lockHeld() {
  if (!running) return false;
  if (runStartedAt && Date.now() - runStartedAt > LOCK_STALE_MS) {
    logger.warn('Clearing a stale job lock', { heldMs: Date.now() - runStartedAt });
    running = false;
    runStartedAt = null;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// POST /api/internal/jobs/run          — everything, in RUN_ORDER
// POST /api/internal/jobs/run/:job     — one named job
// ---------------------------------------------------------------------------
router.post('/run', requireToken, (req, res) => {
  if (lockHeld()) {
    // 200, not an error: an overlapping tick is normal and expected behaviour
    // for a scheduler, and returning a failure would make the cron dashboard
    // show red for something working exactly as intended.
    return res.status(200).json({ started: false, reason: 'already_running', since: new Date(runStartedAt).toISOString() });
  }
  startRun(RUN_ORDER, 'all');
  return res.status(202).json({ started: true, jobs: RUN_ORDER });
});

router.post('/run/:job', requireToken, (req, res) => {
  const name = req.params.job;
  if (!Object.prototype.hasOwnProperty.call(JOBS, name)) {
    return res.status(404).json({ error: `Unknown job: ${name}`, known: Object.keys(JOBS) });
  }
  if (lockHeld()) {
    return res.status(200).json({ started: false, reason: 'already_running', since: new Date(runStartedAt).toISOString() });
  }
  startRun([name], name);
  return res.status(202).json({ started: true, jobs: [name] });
});

// What happened last time. The 202 above tells you a run started, not that it
// worked — this is where you find out, without shell access to the instance.
router.get('/status', requireToken, (req, res) => {
  res.json({
    running: lockHeld(),
    since: runStartedAt ? new Date(runStartedAt).toISOString() : null,
    lastRun,
    known: Object.keys(JOBS)
  });
});

module.exports = router;
// Exported for tests, which must not spawn real jobs against a real database.
module.exports.__internals = { JOBS, RUN_ORDER, tokenMatches };
