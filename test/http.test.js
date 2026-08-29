/**
 * HTTP-level tests against the REAL Express app (src/server.js) — the actual
 * middleware stack (helmet, cors, rate limiting, body parsing, auth
 * middleware, error handling) wired up exactly as it runs in production.
 * Only src/config/db.js is swapped for an in-memory mock (via require.cache,
 * same technique as test/unit.test.js and test/coupons.test.js) so this runs
 * with no real Postgres — Razorpay's config module is left REAL since
 * constructing a Razorpay client does not make a network call.
 *
 * GAP THIS CLOSES: before this file, nothing in the test suite ever sent an
 * actual HTTP request through the app. requireAuth/requireRole gating, the
 * per-route auth rate limiter, Razorpay webhook HMAC verification, CORS
 * origin handling, and JSON body-parse error handling were all unexercised
 * by automation — the only way to find a regression in any of them was
 * manual testing or a production incident.
 *
 * Run: node test/http.test.js
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // ask the OS for a free ephemeral port
process.env.JWT_SECRET = 'test_jwt_secret_do_not_use_in_prod';
process.env.JWT_EXPIRES_IN = '7d';
process.env.CLIENT_URL = 'https://app.example.test';
process.env.ADDITIONAL_CLIENT_ORIGINS = 'https://preview.example.test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'dummy_webhook_secret';
process.env.RATE_LIMIT_WINDOW_MS = '900000';
process.env.RATE_LIMIT_MAX = '600';

const dbConfigPath = require.resolve('../src/config/db.js');
const serverPath = require.resolve('../src/server.js');

const seenQueries = [];
const fakeDb = {
  async query(sql, params) {
    seenQueries.push(sql);
    if (sql.includes('SELECT id FROM users WHERE email')) return { rows: [] };
    if (sql.startsWith('INSERT INTO users')) {
      return { rows: [{ id: 'u_test_1', name: params[0], email: params[1], role: 'customer' }] };
    }
    if (sql.includes('FROM users WHERE email') && sql.includes('is_active = true')) return { rows: [] };
    if (sql.startsWith('SELECT o.id, o.order_number')) return { rows: [] };
    if (sql.includes("SELECT COUNT(*) FROM products WHERE is_active")) return { rows: [{ count: '3' }] };
    if (sql.includes("SELECT COUNT(*) FROM orders WHERE status")) return { rows: [{ count: '7' }] };
    if (sql.includes('COALESCE(SUM(total_paise)')) return { rows: [{ total: '450000' }] };
    if (sql.includes("FROM puja_bookings WHERE status = 'requested'")) return { rows: [{ count: '1' }] };
    if (sql.includes('SELECT id, name, email FROM users WHERE email')) return { rows: [] };

    // These two were deliberately left unstubbed at first, and the mock's throw
    // was caught by the fail-soft paths in the routes — both tests passed, but
    // every green run printed two `"level":"error"` lines with a stack trace.
    // A suite that prints errors on success teaches people to ignore errors,
    // which is how a real one gets scrolled past. Stubbing them turns the noise
    // into an asserted branch instead of removing the check.
    //
    // Empty rows here is not a convenience — it is the interesting case: a
    // webhook naming an order this database has never seen (a replayed event, a
    // webhook aimed at the wrong environment). It must exit cleanly, not 500.
    if (sql.includes('FROM orders WHERE razorpay_order_id')) return { rows: [] };
    // Registration issues an email-verification token. The mailer no-ops here
    // because SMTP_HOST is unset, which is what we want: the route's own logic
    // is under test, not nodemailer's.
    if (sql.includes('INSERT INTO email_verification_tokens')) return { rows: [], rowCount: 1 };

    throw new Error('Unexpected query in http test mock: ' + sql);
  },
  async withTransaction(fn) {
    return fn(fakeDb);
  },
  pool: { end: async () => {} }
};

require.cache[dbConfigPath] = { id: dbConfigPath, filename: dbConfigPath, loaded: true, exports: fakeDb };
const app = require('../src/server'); // starts listening immediately (PORT=0 -> ephemeral)

const queue = [];
function section(name) { queue.push({ type: 'section', name }); }
function test(name, fn) { queue.push({ type: 'test', name, fn }); }

function signToken(payload, opts) {
  return jwt.sign(payload, process.env.JWT_SECRET, Object.assign({ expiresIn: '1h' }, opts));
}

function req(port, urlPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(body));
    const finalHeaders = Object.assign({}, headers);
    if (payload) finalHeaders['Content-Length'] = Buffer.byteLength(payload);
    const request = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: finalHeaders },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON, fine */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

// server.js doesn't export the underlying net.Server (only `app`), so we
// resolve the ephemeral port by asking it directly. app.listen has already
// been called synchronously by the time require() above returns.
function getPort() {
  // Express stores nothing useful for this; instead we walk process._getActiveHandles
  // is fragile — simplest robust option: intercept via app's internal server.
  // Node's http.Server is reachable through app._router is not guaranteed, so
  // we instead rely on the 'listening' server captured at require time below.
}

let PORT;

section('[http-1] Health check & 404 handling');
{
  test('GET /api/health returns 200 with status ok', async () => {
    const res = await req(PORT, '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.status, 'ok');
    assert.ok(res.json.time);
  });

  test('GET an unknown /api path returns a clean 404 JSON error, not a stack trace', async () => {
    const res = await req(PORT, '/api/this-route-does-not-exist');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.json.error, 'Not found.');
  });

  test('GET / (outside /api entirely) also falls through to the same 404 handler', async () => {
    const res = await req(PORT, '/');
    assert.strictEqual(res.status, 404);
  });
}

section('[http-2] requireAuth / requireRole gating — real middleware, real JWTs');
{
  test('protected route with no Authorization header -> 401', async () => {
    const res = await req(PORT, '/api/customer/orders');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.json.error, 'Authentication required.');
  });

  test('protected route with a garbage bearer token -> 401, not a 500', async () => {
    const res = await req(PORT, '/api/customer/orders', { headers: { Authorization: 'Bearer not-a-real-jwt' } });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.json.error, 'Invalid or expired session.');
  });

  test('protected route with a token signed by a DIFFERENT secret -> 401 (can\'t forge a session)', async () => {
    const forged = jwt.sign({ id: 'attacker', role: 'admin', email: 'x@x.com' }, 'wrong_secret', { expiresIn: '1h' });
    const res = await req(PORT, '/api/customer/orders', { headers: { Authorization: `Bearer ${forged}` } });
    assert.strictEqual(res.status, 401);
  });

  test('protected route with an EXPIRED token -> 401', async () => {
    const expired = signToken({ id: 'u1', role: 'customer', email: 'c@x.com' }, { expiresIn: -10 });
    const res = await req(PORT, '/api/customer/orders', { headers: { Authorization: `Bearer ${expired}` } });
    assert.strictEqual(res.status, 401);
  });

  test('valid customer token reaches the real handler -> 200', async () => {
    const token = signToken({ id: 'u1', role: 'customer', email: 'c@x.com' });
    const res = await req(PORT, '/api/customer/orders', { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.orders, []);
  });

  test('admin-only route with a valid CUSTOMER token -> 403, not 401 (authenticated but not authorized)', async () => {
    const token = signToken({ id: 'u1', role: 'customer', email: 'c@x.com' });
    const res = await req(PORT, '/api/admin/overview', { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(res.status, 403);
    assert.match(res.json.error, /do not have permission/);
  });

  test('admin-only route with no token at all -> 401, not 403 (auth failure reported before role failure)', async () => {
    const res = await req(PORT, '/api/admin/overview');
    assert.strictEqual(res.status, 401);
  });

  test('admin-only route with a valid ADMIN token -> 200, real handler runs', async () => {
    const token = signToken({ id: 'a1', role: 'admin', email: 'a@x.com' });
    const res = await req(PORT, '/api/admin/overview', { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.activeProducts, 3);
    assert.strictEqual(res.json.totalOrders, 7);
    assert.strictEqual(res.json.totalRevenuePaise, 450000);
  });

  test('admin-only route also accepts STAFF role, not just admin', async () => {
    const token = signToken({ id: 's1', role: 'staff', email: 's@x.com' });
    const res = await req(PORT, '/api/admin/overview', { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(res.status, 200);
  });
}

section('[http-3] Per-route auth rate limiter (10 req / 15 min on /api/auth/login)');
{
  test('10 rapid login attempts are all processed (401 each, wrong password), the 11th is rate-limited (429)', async () => {
    const body = JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-123' });
    const headers = { 'Content-Type': 'application/json' };
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const res = await req(PORT, '/api/auth/login', { method: 'POST', headers, body });
      statuses.push(res.status);
    }
    assert.deepStrictEqual(statuses.slice(0, 10), new Array(10).fill(401), 'first 10 attempts should all reach the handler and fail auth normally');
    assert.strictEqual(statuses[10], 429, 'the 11th attempt within the window must be blocked by the auth-specific limiter');
  });

  test('FINDING: the 10-request budget is SHARED across /login and /forgot-password, not independent per route — both mount the same authLimiter instance', async () => {
    // A fresh IP-scoped rate-limit window: uses the X-Forwarded-For override
    // below so this test does not inherit the previous test's exhausted count
    // (trust proxy=1 means exactly one X-Forwarded-For hop is honored).
    const ip = '10.0.0.42';
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip };
    for (let i = 0; i < 5; i++) {
      const res = await req(PORT, '/api/auth/login', {
        method: 'POST', headers, body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' })
      });
      assert.strictEqual(res.status, 401, `login attempt ${i + 1} should reach the handler normally`);
    }
    for (let i = 0; i < 5; i++) {
      const res = await req(PORT, '/api/auth/forgot-password', {
        method: 'POST', headers, body: JSON.stringify({ email: 'nobody@example.com' })
      });
      assert.strictEqual(res.status, 200, `forgot-password attempt ${i + 1} should reach the handler normally (its own 5 slots of the SHARED 10)`);
    }
    // The 11th request total for this IP, on a THIRD different route sharing
    // the same limiter — if the budgets were independent per-route, this
    // would still succeed (5/10 used on forgot-password). It doesn't.
    const res = await req(PORT, '/api/auth/login', {
      method: 'POST', headers, body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' })
    });
    assert.strictEqual(res.status, 429, 'the shared budget is exhausted by the combined 10 calls across both routes');
  });
}

section('[http-4] Razorpay webhook — raw-body HMAC signature verification');
{
  test('wrong signature is rejected with 400, event is never processed', async () => {
    const payload = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { order_id: 'order_x', id: 'pay_x' } } } });
    const res = await req(PORT, '/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef'.repeat(8) },
      body: payload
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.json.error, /Invalid webhook signature/);
  });

  test('missing signature header is rejected with 400, not a 500 from a null HMAC compare', async () => {
    const payload = JSON.stringify({ event: 'payment.captured' });
    const res = await req(PORT, '/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
    assert.strictEqual(res.status, 400);
  });

  test('a CORRECTLY signed webhook passes verification and is processed (matches the exact algorithm the route uses)', async () => {
    const payload = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { order_id: 'order_nonexistent_test', id: 'pay_test_1', notes: {} } } }
    });
    const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(payload).digest('hex');
    const res = await req(PORT, '/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
      body: payload
    });
    // Two distinct claims, and the second is the one worth having:
    //   1. a genuine signature clears the gate (not a 400, unlike the cases above);
    //   2. an event naming an order this database does not have is handled — it
    //      looks the order up, finds nothing, and returns cleanly.
    // Razorpay retries any non-2xx, so answering an unknown order with a 500
    // would earn a retry storm for an event that can never succeed.
    assert.notStrictEqual(res.status, 400, 'a validly signed webhook must not be rejected as an invalid signature');
    assert.strictEqual(res.status, 200, 'an unknown order must be acknowledged, not retried forever');
    assert.ok(
      seenQueries.some((q) => q.includes('FROM orders WHERE razorpay_order_id')),
      'the webhook must actually look the order up — a 200 without the lookup would mean it exited earlier than we think'
    );
  });
}

section('[http-5] CORS — origin allow-list matches CLIENT_URL exactly');
{
  test('request from the configured CLIENT_URL origin gets Access-Control-Allow-Origin echoed back', async () => {
    const res = await req(PORT, '/api/health', { headers: { Origin: process.env.CLIENT_URL } });
    assert.strictEqual(res.headers['access-control-allow-origin'], process.env.CLIENT_URL);
    assert.strictEqual(res.headers['access-control-allow-credentials'], 'true');
  });

  // WHAT THIS ASSERTION USED TO SAY, AND WHY IT CHANGED.
  //
  // The origin was previously configured as a plain STRING, which makes the
  // `cors` package echo CLIENT_URL back on every response regardless of who
  // asked. That was safe — an unrelated page still gets refused by the BROWSER,
  // because the returned header does not equal that page's own origin — and the
  // old test asserted exactly that, to catch a future refactor to `origin:true`
  // (which reflects any origin, and IS a hole).
  //
  // The config is now a FUNCTION with an allow-list, which is strictly stronger:
  // a disallowed origin gets no Access-Control-Allow-Origin header at all rather
  // than one that happens not to match, and the rejection is logged. It also
  // supports ADDITIONAL_CLIENT_ORIGINS for Netlify branch previews, which a
  // single string cannot.
  //
  // So the assertion is inverted, and the original intent is preserved: this
  // still fails loudly if someone refactors to `origin: true`, because that
  // WOULD reflect evil.example.com back and the check below would see it.
  test('an origin that is NOT in the allow-list gets no Access-Control-Allow-Origin header at all (and never a reflected one)', async () => {
    const res = await req(PORT, '/api/health', { headers: { Origin: 'https://evil.example.com' } });
    assert.notStrictEqual(
      res.headers['access-control-allow-origin'],
      'https://evil.example.com',
      'the caller\'s own origin must NEVER be reflected back — that would be origin:true, which allows any site to read authenticated responses'
    );
    assert.strictEqual(
      res.headers['access-control-allow-origin'],
      undefined,
      'a disallowed origin should receive no CORS grant header whatsoever'
    );
  });

  test('a second allowed origin from ADDITIONAL_CLIENT_ORIGINS is accepted, so branch previews work without a config change', async () => {
    const res = await req(PORT, '/api/health', { headers: { Origin: process.env.ADDITIONAL_CLIENT_ORIGINS } });
    assert.strictEqual(res.headers['access-control-allow-origin'], process.env.ADDITIONAL_CLIENT_ORIGINS);
  });
}

section('[http-6] Body parsing & security headers');
{
  test('malformed JSON body is a clean 400 via the error handler, not an unhandled crash', async () => {
    const res = await req(PORT, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not valid json'
    });
    assert.strictEqual(res.status, 400);
  });

  test('helmet security headers are present on every response (X-Content-Type-Options: nosniff)', async () => {
    const res = await req(PORT, '/api/health');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  });

  test('registration with an invalid email is rejected by validation before touching business logic', async () => {
    const res = await req(PORT, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test User', email: 'not-an-email', password: 'longenoughpassword' })
    });
    assert.strictEqual(res.status, 400);
    assert.ok(Array.isArray(res.json.errors));
  });

  test('a valid registration reaches the real DB-backed handler end-to-end and returns a usable JWT', async () => {
    const res = await req(PORT, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test User', email: 'newcustomer@example.com', password: 'longenoughpassword' })
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.user.email, 'newcustomer@example.com');
    const decoded = jwt.verify(res.json.token, process.env.JWT_SECRET);
    assert.strictEqual(decoded.role, 'customer');
  });
}

// ============================================================
section('[http-7] Free-plan job trigger — the guard, never the jobs');
// ============================================================
// !!! DO NOT ADD A TEST THAT POSTS TO /run OR /run/:job WITH A VALID TOKEN. !!!
//
// That endpoint spawns scripts/release-expired-orders.js and
// scripts/reconcile-payments.js as real child processes. Those scripts call
// dotenv.config() themselves, so they would load the REAL .env, connect to the
// PRODUCTION database, and cancel real orders and release real stock — while
// this suite's db mock sat unused, because the mock only replaces the module
// inside THIS process, not inside a child.
//
// Every test below therefore stops at the guard: 503 before configuration, 401
// on a bad token, and 404 for an unknown job name — which is reached only after
// the token check passes, so it proves authentication works without running
// anything. GET /status never spawns.
{
  const GOOD = 'j'.repeat(40); // 32+ chars, as the route requires

  function withToken(value, fn) {
    const prev = process.env.JOBS_TRIGGER_TOKEN;
    if (value === null) delete process.env.JOBS_TRIGGER_TOKEN;
    else process.env.JOBS_TRIGGER_TOKEN = value;
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        if (prev === undefined) delete process.env.JOBS_TRIGGER_TOKEN;
        else process.env.JOBS_TRIGGER_TOKEN = prev;
      });
  }

  test('THE FINDING: with no token configured the trigger is inert (503), not open', () =>
    withToken(null, async () => {
      const res = await req(PORT, '/api/internal/jobs/run', { method: 'POST' });
      assert.strictEqual(res.status, 503, 'an unconfigured job trigger must refuse, never run');
      assert.match(res.json.error, /JOBS_TRIGGER_TOKEN/);
    }));

  test('a token shorter than 32 characters is treated as unconfigured, not as a weak password', () =>
    withToken('short', async () => {
      const res = await req(PORT, '/api/internal/jobs/run', { method: 'POST' });
      assert.strictEqual(res.status, 503);
    }));

  test('a configured trigger rejects a request with no token at all', () =>
    withToken(GOOD, async () => {
      const res = await req(PORT, '/api/internal/jobs/run', { method: 'POST' });
      assert.strictEqual(res.status, 401);
    }));

  test('a wrong token is rejected, whether it is longer or shorter than the real one', () =>
    withToken(GOOD, async () => {
      for (const bad of ['x'.repeat(40), 'j'.repeat(39), 'j'.repeat(41), '']) {
        const res = await req(PORT, '/api/internal/jobs/run', {
          method: 'POST', headers: { 'X-Jobs-Token': bad }
        });
        assert.strictEqual(res.status, 401, `token ${JSON.stringify(bad.slice(0, 8))}… was accepted`);
      }
    }));

  test('a valid token reaches routing — an unknown job name is a 404, and nothing is spawned', () =>
    withToken(GOOD, async () => {
      const res = await req(PORT, '/api/internal/jobs/run/not-a-real-job', {
        method: 'POST', headers: { 'X-Jobs-Token': GOOD }
      });
      assert.strictEqual(res.status, 404, 'the token was not accepted, so this proves nothing');
      assert.ok(Array.isArray(res.json.known), 'the 404 should name the jobs that do exist');
      assert.ok(res.json.known.includes('payment-reconcile'));
    }));

  test('Authorization: Bearer is accepted as well as X-Jobs-Token', () =>
    withToken(GOOD, async () => {
      const res = await req(PORT, '/api/internal/jobs/run/not-a-real-job', {
        method: 'POST', headers: { Authorization: `Bearer ${GOOD}` }
      });
      assert.strictEqual(res.status, 404, 'Bearer form was not accepted');
    }));

  test('status reports what the last run did, and is itself token-guarded', () =>
    withToken(GOOD, async () => {
      const denied = await req(PORT, '/api/internal/jobs/status');
      assert.strictEqual(denied.status, 401, 'status leaked without a token');

      const res = await req(PORT, '/api/internal/jobs/status', { headers: { 'X-Jobs-Token': GOOD } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.running, false);
      assert.deepStrictEqual(res.json.known.sort(), ['expiry-sweep', 'payment-reconcile', 'scheduled-emails']);
    }));

  // These two are pure lookups against the route module's own tables — no
  // request, no spawn. They exist because both failures are invisible until a
  // job is actually due, which is the worst possible moment to discover them.
  test('every job in the run order is a job that exists', () => {
    const { JOBS, RUN_ORDER } = require('../src/routes/jobs.routes').__internals;
    for (const name of RUN_ORDER) {
      assert.ok(Object.prototype.hasOwnProperty.call(JOBS, name),
        `RUN_ORDER lists "${name}", which is not in JOBS — the trigger would try to spawn undefined`);
    }
    assert.strictEqual(RUN_ORDER.length, Object.keys(JOBS).length,
      'a job is defined but never runs in the "run everything" sequence');
  });

  test('every job points at a script that is actually on disk', () => {
    const fs = require('fs');
    const p = require('path');
    const { JOBS } = require('../src/routes/jobs.routes').__internals;
    for (const [name, file] of Object.entries(JOBS)) {
      const full = p.join(__dirname, '..', 'scripts', file);
      assert.ok(fs.existsSync(full),
        `job "${name}" points at scripts/${file}, which does not exist — renaming a script would break the schedule silently`);
    }
  });

  test('the token never appears in a URL, so it cannot be written to the request log', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'routes', 'jobs.routes.js'), 'utf8'
    );
    assert.ok(!/req\.query/.test(src),
      'the trigger reads the token from req.query somewhere — morgan logs every URL, so that writes the credential to the log on every run');
  });
}

(async () => {
  // Resolve the ephemeral port Node actually bound to. server.js only exports
  // `app`, so the listening net.Server is found via Node's internal handle
  // list — the one thing every Node process running this test has in common.
  const handles = process._getActiveHandles ? process._getActiveHandles() : [];
  const httpServer = handles.find((h) => h && h.constructor && h.constructor.name === 'Server' && typeof h.address === 'function');
  if (!httpServer) {
    console.error('Could not locate the running http.Server to determine its ephemeral port. Aborting.');
    process.exit(1);
  }
  PORT = httpServer.address().port;
  console.log(`(test server listening on 127.0.0.1:${PORT})`);

  let passed = 0, failed = 0;
  for (const item of queue) {
    if (item.type === 'section') {
      console.log('\n' + item.name);
      continue;
    }
    try {
      await item.fn();
      console.log('  PASS -', item.name);
      passed++;
    } catch (e) {
      console.log('  FAIL -', item.name, '\n        ', e.message);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  httpServer.close();
  process.exit(failed ? 1 : 0);
})();
