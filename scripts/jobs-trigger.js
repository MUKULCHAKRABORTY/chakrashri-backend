/**
 * Talks to the free-plan job trigger (src/routes/jobs.routes.js).
 *
 * WHY THIS EXISTS
 * On Render's free plan the three cron services in render.yaml do not exist, so
 * the expiry sweep, payment reconciliation and scheduled emails are driven by an
 * external scheduler calling an HTTP endpoint instead. That leaves two questions
 * a human needs to answer regularly:
 *
 *   1. "Is the schedule actually firing?"  — jobs:status
 *   2. "Run it NOW, I am not waiting."     — jobs:run
 *
 * Doing that with curl means handling the token by hand every time, which is how
 * secrets end up in shell history and in screenshots. This reads it from .env,
 * exactly like test:db and test:razorpay read theirs, and never prints it.
 *
 * Run:
 *   npm run jobs:status
 *   npm run jobs:run
 *   node scripts/jobs-trigger.js run payment-reconcile
 */
require('dotenv').config();
const http = require('http');
const https = require('https');

const KNOWN_JOBS = ['expiry-sweep', 'payment-reconcile', 'scheduled-emails'];

// A free instance that has gone to sleep takes ~50s to answer its first request.
// Anything less than that reports a false failure on the one call most likely to
// hit a cold start — the first one after a quiet night.
const TIMEOUT_MS = parseInt(process.env.JOBS_HTTP_TIMEOUT_MS || '90000', 10);

function fail(message, hint) {
  console.error(`\n[jobs] ${message}\n`);
  if (hint) console.error(hint + '\n');
  process.exit(1);
}

const base = (process.env.API_BASE || '').replace(/\/+$/, '');
if (!base) {
  fail('API_BASE is not set.', '  Add it to .env, e.g. API_BASE=https://chakrashri-api.onrender.com');
}

const token = (process.env.JOBS_TRIGGER_TOKEN || '').trim();
if (token.length < 32) {
  fail(
    token ? 'JOBS_TRIGGER_TOKEN is shorter than 32 characters.' : 'JOBS_TRIGGER_TOKEN is not set in .env.',
    '  This is the same value you set in the Render dashboard. Copy it into .env\n'
    + '  (which is gitignored) so this script can use it:\n\n'
    + '    JOBS_TRIGGER_TOKEN=<the value from Render>\n\n'
    + '  Generate one, if you have not already:\n'
    + '    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

const [, , rawAction, rawJob] = process.argv;
const action = (rawAction || 'status').toLowerCase();

if (!['status', 'run'].includes(action)) {
  fail(`Unknown action "${action}".`, '  Usage: node scripts/jobs-trigger.js [status|run] [job-name]');
}
if (rawJob && !KNOWN_JOBS.includes(rawJob)) {
  fail(`Unknown job "${rawJob}".`, '  Known jobs: ' + KNOWN_JOBS.join(', '));
}

const path = action === 'status'
  ? '/api/internal/jobs/status'
  : `/api/internal/jobs/run${rawJob ? '/' + rawJob : ''}`;

/**
 * Uses the built-in http/https modules rather than global fetch, with
 * `agent: false`.
 *
 * fetch() keeps its socket in a connection pool after the response, and calling
 * process.exit() while that pool is still open aborts the process on Windows
 * with a libuv assertion ("UV_HANDLE_CLOSING") printed AFTER the real output —
 * so a correct run looked like a crash. A one-shot CLI has nothing to gain from
 * connection reuse, so opting out of keep-alive removes the problem rather than
 * working around it. This also matches test/http.test.js, which drives the API
 * the same way.
 */
function request(url, method, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        agent: false,
        timeout: TIMEOUT_MS
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON, keep the text */ }
          // `ok` is provided here rather than derived at the call site because
          // this object replaced a fetch Response, and fetch's `ok` is the one
          // property the calling code already relied on. Omitting it made
          // `!res.ok` always true, so every successful call reported
          // "Unexpected response 200" — a silent break introduced by swapping
          // the HTTP client underneath the caller.
          const status = res.statusCode;
          resolve({ status, ok: status >= 200 && status < 300, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`no response within ${TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const url = base + path;

  const what = action === 'status' ? 'Checking status' : `Starting ${rawJob || 'all jobs'}`;
  console.log(`\n[jobs] ${what} at ${base}`);
  if (action === 'run') console.log('       (a sleeping free instance can take ~50s to wake — waiting)');

  let res;
  try {
    // The token goes in a header, never the URL: the server logs :url on every
    // request, so a query parameter would write the credential into the log.
    res = await request(url, action === 'status' ? 'GET' : 'POST', {
      'X-Jobs-Token': token,
      Accept: 'application/json'
    });
  } catch (err) {
    fail(`Could not reach the API: ${err.message}`,
      '  If the instance was asleep this can happen on the FIRST call and succeed on the second.\n'
      + '  If it repeats, check the service is live in the Render dashboard.');
  }

  const body = res.json;

  // Each status code means something specific and actionable. Saying "request
  // failed" would throw that away.
  if (res.status === 401) {
    fail('The API rejected the token (401).',
      '  JOBS_TRIGGER_TOKEN in .env does not match the value set in the Render dashboard.');
  }
  if (res.status === 503) {
    fail('The endpoint is disabled on the server (503).',
      '  JOBS_TRIGGER_TOKEN is unset or under 32 characters in the RENDER environment.\n'
      + '  Set it there and redeploy — it fails closed on purpose.');
  }
  if (res.status === 404) {
    fail('The endpoint does not exist on the deployed build (404).',
      '  The running service predates src/routes/jobs.routes.js. Deploy the current main.');
  }
  if (!res.ok) {
    fail(`Unexpected response ${res.status}.`, '  ' + JSON.stringify(body));
  }

  if (action === 'run') {
    if (body && body.started === false) {
      console.log(`\n  A run is ALREADY in progress (since ${body.since}). Nothing new was started.`);
      console.log('  That is normal if the scheduler fired moments ago.\n');
      return;
    }
    console.log(`\n  Started: ${(body.jobs || []).join(', ')}`);
    console.log('  The server returns immediately, so this does NOT mean the jobs succeeded.');
    console.log('  Check the outcome in a minute:  npm run jobs:status\n');
    return;
  }

  // status
  console.log('');
  console.log(`  Currently running: ${body.running ? `yes (since ${body.since})` : 'no'}`);

  if (!body.lastRun) {
    console.log('\n  NO RUN HAS EVER HAPPENED.');
    console.log('  Nothing has triggered this endpoint since the service last restarted, so');
    console.log('  abandoned checkouts are not being released and payments are not being');
    console.log('  reconciled. Either the external scheduler is not configured, or it is');
    console.log('  failing before it reaches the API.');
    console.log('\n  Note: this state resets on every deploy — the record is in memory, not the');
    console.log('  database. A recent deploy is a normal reason to see this.\n');
    process.exitCode = 1;
    return;
  }

  const r = body.lastRun;
  console.log(`  Last run: ${r.finishedAt} (${r.ms}ms) — ${r.ok ? 'all jobs OK' : 'SOMETHING FAILED'}`);
  for (const j of r.jobs || []) {
    console.log(`    ${j.ok ? 'OK  ' : 'FAIL'}  ${j.job.padEnd(20)} exit=${j.code}${j.signal ? ' signal=' + j.signal : ''} ${j.ms}ms`);
  }
  if (!r.ok) {
    console.log('\n  A non-zero exit is deliberate in these scripts: the reconciler exits non-zero');
    console.log('  when an amount mismatch needs a human. Check the Render logs for detail.\n');
    process.exitCode = 1;
  } else {
    console.log('');
  }
}

main().catch((err) => {
  console.error('\n[jobs] Unexpected failure: ' + (err && err.stack || err) + '\n');
  process.exit(1);
});
