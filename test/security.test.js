/**
 * Regression tests for the security and correctness fixes from the audit.
 *
 * Every test here names the finding it locks down, so that if one ever fails,
 * the failure message tells you which defect has come back rather than only
 * which function broke.
 *
 * Like the rest of this suite, these exercise the REAL modules — no
 * reimplementations — using only Node's built-ins.
 *
 * Run: node test/security.test.js
 */
const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const queue = [];
function section(name) { queue.push({ type: 'section', name }); }
function test(name, fn) { queue.push({ type: 'test', name, fn }); }

// ============================================================
// AUTH-02 — capability-based authorization
// ============================================================
section('[sec-1] AUTH-02 — staff must not inherit admin authority');
{
  const {
    CAPABILITIES: C, capabilitiesForRole, roleHasCapability, requireCapability
  } = require('../src/middleware/capabilities');

  test('THE FINDING: staff can no longer issue refunds — the single most expensive thing the old blanket role gate allowed', () => {
    assert.strictEqual(roleHasCapability('staff', C.ORDERS_REFUND), false);
    assert.strictEqual(roleHasCapability('admin', C.ORDERS_REFUND), true);
  });

  test('staff can no longer export the bulk customer list (emails, phones, lifetime value)', () => {
    assert.strictEqual(roleHasCapability('staff', C.CUSTOMERS_READ), false);
    assert.strictEqual(roleHasCapability('admin', C.CUSTOMERS_READ), true);
  });

  test('staff can no longer read the audit log that records their own actions', () => {
    assert.strictEqual(roleHasCapability('staff', C.AUDIT_READ), false);
  });

  test('staff CAN still do the day-to-day job — catalog, fulfilment, bookings — so this is a separation, not a lockout', () => {
    for (const cap of [C.CATALOG_WRITE, C.ORDERS_READ, C.ORDERS_FULFIL, C.BOOKINGS_WRITE, C.ANALYTICS_READ]) {
      assert.strictEqual(roleHasCapability('staff', cap), true, `staff should retain ${cap}`);
    }
  });

  test('a customer holds no admin capability at all', () => {
    assert.deepStrictEqual(capabilitiesForRole('customer'), []);
  });

  test('an unknown or spoofed role falls back to no capabilities, never to a default grant', () => {
    assert.deepStrictEqual(capabilitiesForRole('superadmin'), []);
    assert.deepStrictEqual(capabilitiesForRole(undefined), []);
    assert.deepStrictEqual(capabilitiesForRole(null), []);
  });

  test('admin holds EVERY defined capability — a new capability is never silently withheld from admins', () => {
    const all = Object.values(C);
    const granted = capabilitiesForRole('admin');
    for (const cap of all) assert.ok(granted.includes(cap), `admin is missing ${cap}`);
  });

  function runGuard(role, ...caps) {
    const req = { user: role ? { id: 'u1', role } : null };
    let statusCode = 200; let body = null; let nextCalled = false;
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; return this; }
    };
    requireCapability(...caps)(req, res, () => { nextCalled = true; });
    return { statusCode, body, nextCalled };
  }

  test('requireCapability lets an authorized caller through', () => {
    const r = runGuard('admin', C.ORDERS_REFUND);
    assert.strictEqual(r.nextCalled, true);
  });

  test('requireCapability returns 403 (not 401) for an authenticated caller lacking the capability', () => {
    const r = runGuard('staff', C.ORDERS_REFUND);
    assert.strictEqual(r.nextCalled, false);
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(r.body.requiredCapability, C.ORDERS_REFUND);
  });

  test('requireCapability returns 401 when there is no authenticated user at all', () => {
    const r = runGuard(null, C.ORDERS_READ);
    assert.strictEqual(r.statusCode, 401);
  });

  test('multiple capabilities are required together (AND, not OR) — a route needing both PII and money needs both grants', () => {
    assert.strictEqual(runGuard('staff', C.CATALOG_READ, C.ORDERS_REFUND).statusCode, 403);
    assert.strictEqual(runGuard('admin', C.CATALOG_READ, C.ORDERS_REFUND).nextCalled, true);
  });
}

// ============================================================
// AUTH-04 — password policy
// ============================================================
section('[sec-2] AUTH-04 — the password policy rejects what actually gets compromised');
{
  const { passwordProblem } = require('../src/utils/passwordPolicy');

  test('THE FINDING: an 8-character minimum accepted "password" and "12345678" — it no longer does', () => {
    assert.ok(passwordProblem('password', 'a@b.com'));
    assert.ok(passwordProblem('12345678', 'a@b.com'));
    assert.ok(passwordProblem('qwertyuiop', 'a@b.com'));
  });

  test('still rejects anything under 8 characters', () => {
    assert.match(passwordProblem('short1', 'a@b.com'), /at least 8/);
  });

  test('rejects a password containing the user\'s own email local-part', () => {
    assert.match(passwordProblem('anjali1234', 'anjali@example.com'), /email address/);
  });

  test('a short local-part is NOT treated as a substring match — "ram@x.com" must not block every password containing "ram"', () => {
    assert.strictEqual(passwordProblem('programmerlife', 'ram@x.com'), null);
  });

  test('rejects a single repeated character', () => {
    assert.ok(passwordProblem('aaaaaaaaaa', 'a@b.com'));
  });

  test('rejects an absurdly long password rather than hashing it (bcrypt truncates at 72 bytes anyway)', () => {
    assert.match(passwordProblem('a'.repeat(5000) + 'Zx9', 'a@b.com'), /too long/);
  });

  test('ACCEPTS a good passphrase — the policy must not push people towards "Password1!" and a sticky note', () => {
    assert.strictEqual(passwordProblem('correct horse battery staple', 'a@b.com'), null);
    assert.strictEqual(passwordProblem('sphatik-lingam-2026', 'a@b.com'), null);
  });

  test('handles non-string input without throwing', () => {
    assert.ok(passwordProblem(null, 'a@b.com'));
    assert.ok(passwordProblem(undefined, null));
    assert.ok(passwordProblem(12345678, 'a@b.com'));
  });
}

// ============================================================
// HYG-02 — UUID validation
// ============================================================
section('[sec-3] HYG-02 — a malformed :id is a 400, not a 500 from Postgres');
{
  const { isUuid, validateUuidParam } = require('../src/middleware/validate');

  test('accepts a real UUID', () => {
    assert.strictEqual(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true);
  });

  test('THE FINDING: a crawler probing /api/products/wp-admin no longer reaches Postgres', () => {
    assert.strictEqual(isUuid('wp-admin'), false);
    assert.strictEqual(isUuid("1' OR '1'='1"), false);
    assert.strictEqual(isUuid(''), false);
    assert.strictEqual(isUuid(null), false);
  });

  test('rejects a UUID-shaped string with an invalid version nibble', () => {
    assert.strictEqual(isUuid('3f2504e0-4f89-01d3-9a0c-0305e82c3301'), false);
  });

  test('the param guard returns 400 with a clear message rather than calling next()', () => {
    let statusCode = 200; let body = null; let nextCalled = false;
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
    validateUuidParam('id')({}, res, () => { nextCalled = true; }, 'not-a-uuid');
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(statusCode, 400);
    assert.match(body.error, /Invalid id format/);
  });
}

// ============================================================
// BIZ-06 — booking dates in IST
// ============================================================
section('[sec-4] BIZ-06 — booking dates are evaluated in IST, not the server\'s UTC clock');
{
  const { isTodayOrFuture, todayInBookingTz, BOOKING_TZ } = require('../src/utils/bookingDates');

  test('the booking timezone is Asia/Kolkata, not the host timezone', () => {
    assert.strictEqual(BOOKING_TZ, 'Asia/Kolkata');
  });

  test('THE FINDING: at 02:00 IST (20:30 UTC the previous day), "today" in Kolkata is still accepted', () => {
    // 2026-09-14T02:00 IST is 2026-09-13T20:30Z. A UTC-based check would call
    // "today" the 13th and reject a booking for the 14th as being in the past.
    const at0200Ist = new Date('2026-09-13T20:30:00Z');
    assert.strictEqual(todayInBookingTz(at0200Ist), '2026-09-14',
      'the IST calendar date must already have rolled over');
  });

  test('and the reverse: at 23:00 IST the date has NOT yet rolled over', () => {
    const at2300Ist = new Date('2026-09-14T17:30:00Z');
    assert.strictEqual(todayInBookingTz(at2300Ist), '2026-09-14');
  });

  test('today is accepted', () => {
    assert.strictEqual(isTodayOrFuture(todayInBookingTz()), true);
  });

  test('yesterday is rejected with a customer-facing message', () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.throws(() => isTodayOrFuture(yesterday), /cannot be in the past/);
  });

  test('a date more than a year out is rejected — a booking for 2087 is a typo or a probe', () => {
    assert.throws(() => isTodayOrFuture('2087-01-01'), /within the next year/);
  });

  test('a malformed date is rejected without throwing something unhelpful', () => {
    assert.throws(() => isTodayOrFuture('not-a-date'), /valid date/);
    assert.throws(() => isTodayOrFuture(''), /valid date/);
  });
}

// ============================================================
// Address validation
// ============================================================
section('[sec-5] Deliverable addresses — a bad PIN or phone fails at the form, not at the door');
{
  const { pincodeProblem, phoneProblem } = require('../src/utils/addressValidation');

  test('THE FINDING: "4-10 characters of anything" accepted junk PIN codes; six digits are now required', () => {
    assert.strictEqual(pincodeProblem('560001', 'India'), null);
    assert.ok(pincodeProblem('5600', 'India'));
    assert.ok(pincodeProblem('abcdef', 'India'));
    assert.ok(pincodeProblem('56000A', 'India'));
  });

  test('an Indian PIN code never starts with 0', () => {
    assert.ok(pincodeProblem('012345', 'India'));
  });

  test('India is the default when no country is given', () => {
    assert.strictEqual(pincodeProblem('110001', null), null);
    assert.ok(pincodeProblem('1100', undefined));
  });

  test('a non-Indian postal code uses the looser rule rather than being rejected outright', () => {
    assert.strictEqual(pincodeProblem('SW1A 1AA', 'United Kingdom'), null);
    assert.strictEqual(pincodeProblem('94103', 'USA'), null);
  });

  test('phone: accepts the three forms Indian customers actually type', () => {
    assert.strictEqual(phoneProblem('9876543210'), null);
    assert.strictEqual(phoneProblem('+91 98765 43210'), null);
    assert.strictEqual(phoneProblem('09876543210'), null);
  });

  test('phone: rejects a 10-digit number that cannot be an Indian mobile (a landline missing its STD code)', () => {
    assert.match(phoneProblem('2226543210'), /Indian mobile/);
  });

  test('phone: rejects obvious junk', () => {
    assert.ok(phoneProblem('12'));
    assert.ok(phoneProblem('not a phone'));
    assert.ok(phoneProblem(''));
  });
}

// ============================================================
// PAY-01 — payment settlement verification
// ============================================================
section('[sec-6] PAY-01 — a valid signature is not proof the money moved');
{
  const razorpayPath = require.resolve('../src/config/razorpay.js');

  function withMockedRazorpay(payment, fn) {
    const original = require.cache[razorpayPath];
    const verifierPath = require.resolve('../src/utils/paymentVerification.js');
    require.cache[razorpayPath] = {
      id: razorpayPath,
      filename: razorpayPath,
      loaded: true,
      exports: {
        payments: {
          fetch: async () => {
            if (payment instanceof Error) throw payment;
            return payment;
          }
        }
      }
    };
    delete require.cache[verifierPath];
    try {
      return fn(require('../src/utils/paymentVerification'));
    } finally {
      delete require.cache[verifierPath];
      if (original) require.cache[razorpayPath] = original;
      else delete require.cache[razorpayPath];
    }
  }

  const GOOD = { id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 150000, currency: 'INR' };

  test('a fully captured payment for the exact amount verifies', async () => {
    const result = await withMockedRazorpay(GOOD, (v) => v.verifyCapturedPayment({
      razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', expectedAmountPaise: 150000
    }));
    assert.strictEqual(result.ok, true);
  });

  test('THE FINDING: an AUTHORIZED-but-not-captured payment is REJECTED — this is the money-loss case', async () => {
    // A valid signature is produced for an authorized payment too. The old code
    // stopped at the signature, so the order was marked paid and shipped while
    // no money had actually settled.
    const result = await withMockedRazorpay({ ...GOOD, status: 'authorized' }, (v) => v.verifyCapturedPayment({
      razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', expectedAmountPaise: 150000
    }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'payment_not_captured');
  });

  test('a capture for LESS than the order total is rejected', async () => {
    const result = await withMockedRazorpay({ ...GOOD, amount: 100 }, (v) => v.verifyCapturedPayment({
      razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', expectedAmountPaise: 150000
    }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'payment_mismatch');
    assert.strictEqual(result.detail.capturedPaise, 100);
  });

  test('a capture in the WRONG CURRENCY is rejected even when the number matches', async () => {
    // ₹1,500 settled as $1,500 would be a catastrophic silent loss in the
    // opposite direction, and the numeric amount alone cannot distinguish them.
    const result = await withMockedRazorpay({ ...GOOD, currency: 'USD' }, (v) => v.verifyCapturedPayment({
      razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', expectedAmountPaise: 150000
    }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'payment_mismatch');
  });

  test('a payment belonging to a DIFFERENT order is rejected — the HMAC covers the pair, not our record of it', async () => {
    const result = await withMockedRazorpay({ ...GOOD, order_id: 'order_someone_else' }, (v) => v.verifyCapturedPayment({
      razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', expectedAmountPaise: 150000
    }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'payment_mismatch');
  });

  test('an unreachable gateway is UNVERIFIABLE, which is deliberately distinct from a mismatch', async () => {
    // The distinction matters: a mismatch parks the order for review, while an
    // unreachable gateway leaves it pending for the webhook or reconciler to
    // resolve. Collapsing the two would either accept unverified payments or
    // tell customers with good payments that they failed.
    const result = await withMockedRazorpay(new Error('ETIMEDOUT'), (v) => v.verifyCapturedPayment({
      razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', expectedAmountPaise: 150000
    }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'payment_unverifiable');
  });

  test('a non-integer expected amount (a BIGINT arriving as a string, or a float) is refused rather than loosely compared', async () => {
    const result = await withMockedRazorpay(GOOD, (v) => v.verifyCapturedPayment({
      razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', expectedAmountPaise: 1500.5
    }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'payment_unverifiable');
  });

  test('a string amount that is numerically correct still verifies, because Number() coerces it before comparing', async () => {
    const result = await withMockedRazorpay({ ...GOOD, amount: '150000' }, (v) => v.verifyCapturedPayment({
      razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', expectedAmountPaise: 150000
    }));
    assert.strictEqual(result.ok, true);
  });
}

// ============================================================
// Email output escaping
// ============================================================
section('[sec-7] Emails escape user-controlled text — the one output surface that leaves the building');
{
  const { esc, safeUrl } = require('../src/utils/mailer');

  test('THE FINDING: a customer name containing markup is escaped, not rendered', () => {
    const out = esc('<a href="http://phish.example">Click here</a>');
    assert.ok(!out.includes('<a '), 'markup must not survive into an HTML email');
    assert.ok(out.includes('&lt;a'));
  });

  test('escapes every character that matters in an HTML attribute or body', () => {
    assert.strictEqual(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });

  test('null and undefined become an empty string, never the text "null"', () => {
    assert.strictEqual(esc(null), '');
    assert.strictEqual(esc(undefined), '');
  });

  test('safeUrl accepts http(s) and rejects javascript: and data: — both execute in some mail clients', () => {
    assert.ok(safeUrl('https://www.chakrashri.com/reset?token=abc'));
    assert.strictEqual(safeUrl('javascript:alert(1)'), null);
    assert.strictEqual(safeUrl('data:text/html,<script>alert(1)</script>'), null);
    assert.strictEqual(safeUrl(''), null);
  });
}

// ============================================================
// OPS-04 — logging never leaks credentials
// ============================================================
section('[sec-8] OPS-04 — structured logging redacts secrets');
{
  const { logger } = require('../src/utils/logger');

  function captureStdout(fn) {
    const original = process.stdout.write;
    const chunks = [];
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    const prevLevel = process.env.LOG_LEVEL;
    try { fn(); } finally { process.stdout.write = original; process.env.LOG_LEVEL = prevLevel; }
    return chunks.join('');
  }

  test('a password or token passed in a log field is redacted, never written out', () => {
    const out = captureStdout(() => {
      logger.error('test line', null, {
        password: 'hunter2',
        token: 'eyJhbGciOi.secret.value',
        razorpay_signature: 'abc123',
        orderId: 'ord_1'
      });
    });
    assert.ok(!out.includes('hunter2'), 'password must not appear in the log');
    assert.ok(!out.includes('eyJhbGciOi'), 'token must not appear in the log');
    assert.ok(!out.includes('abc123'), 'signature must not appear in the log');
    assert.ok(out.includes('[redacted]'));
    assert.ok(out.includes('ord_1'), 'non-sensitive identifiers must still be logged');
  });

  test('redaction reaches nested objects, not just the top level', () => {
    const out = captureStdout(() => {
      logger.error('nested', null, { context: { user: { password: 'hunter2' } } });
    });
    assert.ok(!out.includes('hunter2'));
  });

  test('birth_details (DPDP-sensitive) is redacted if a future caller ever passes it', () => {
    const out = captureStdout(() => {
      logger.error('booking', null, { birth_details: { dob: '1990-01-01', place: 'Kolkata' } });
    });
    assert.ok(!out.includes('1990-01-01'));
  });

  test('an Error is serialised with its message and code — JSON.stringify alone would emit "{}"', () => {
    const out = captureStdout(() => {
      const err = Object.assign(new Error('boom'), { code: '23505' });
      logger.error('failed', err);
    });
    assert.ok(out.includes('boom'));
    assert.ok(out.includes('23505'));
  });

  test('every emitted line is valid JSON, so a log aggregator can parse it', () => {
    const out = captureStdout(() => logger.error('structured', null, { a: 1 }));
    for (const line of out.trim().split('\n')) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.ts && parsed.level && parsed.msg);
    }
  });
}

// ============================================================
// HYG-03 / DATA-02 — pricing configuration and money typing
// ============================================================
section('[sec-9] HYG-03 — shipping rules come from settings, with the old constants as defaults');
{
  const { calculateOrderTotals } = require('../src/utils/orders');
  const { DEFAULTS } = require('../src/utils/settings');

  test('the compiled defaults are exactly the values that used to be hardcoded, so behaviour is unchanged', () => {
    assert.strictEqual(DEFAULTS.free_shipping_threshold_paise, 99900); // ₹999
    assert.strictEqual(DEFAULTS.shipping_flat_paise, 7900);            // ₹79
  });

  test('a two-argument call behaves identically to before this change', () => {
    const r = calculateOrderTotals([{ lineTotalPaise: 50000, gstRate: 3 }]);
    assert.strictEqual(r.shippingPaise, 7900);
    assert.strictEqual(r.totalPaise, 50000 + 7900 + 1500);
  });

  test('a festive free-shipping promotion is a settings change, not a deploy', () => {
    const r = calculateOrderTotals([{ lineTotalPaise: 50000, gstRate: 3 }], 0, {
      free_shipping_threshold_paise: 0, shipping_flat_paise: 7900
    });
    assert.strictEqual(r.shippingPaise, 0);
  });

  test('a raised shipping charge applies below the threshold', () => {
    const r = calculateOrderTotals([{ lineTotalPaise: 50000, gstRate: 3 }], 0, {
      free_shipping_threshold_paise: 200000, shipping_flat_paise: 12000
    });
    assert.strictEqual(r.shippingPaise, 12000);
  });

  test('DATA-02: a BIGINT arriving as a STRING still produces correct integer money math', () => {
    // node-postgres returns int8 as a string by default. config/db.js now parses
    // it, but this proves the arithmetic is correct either way — the failure
    // mode being guarded against is a `+` concatenating two amounts.
    const r = calculateOrderTotals([{ lineTotalPaise: '50000', gstRate: '3' }]);
    assert.strictEqual(typeof r.subtotalPaise, 'number');
    assert.strictEqual(r.subtotalPaise, 50000);
    assert.strictEqual(r.gstPaise, 1500);
    assert.strictEqual(r.totalPaise, 59400);
  });

  test('the config parser is registered for INT8, so BIGINT columns arrive as numbers', () => {
    const { types } = require('pg');
    require('../src/config/db'); // registers the parser as a side effect of loading
    const parse = types.getTypeParser(types.builtins.INT8);
    assert.strictEqual(parse('150000'), 150000);
    assert.strictEqual(typeof parse('150000'), 'number');
  });
}

// ============================================================
// AUTH-01 — cart bounds
// ============================================================
section('[sec-10] Checkout input bounds');
{
  const { validateAndAggregateCart } = require('../src/utils/orders');

  test('a cart with an absurd number of distinct line items is rejected before any row is locked', () => {
    const huge = Array.from({ length: 200 }, (_, i) => ({ productId: 'p' + i, quantity: 1 }));
    assert.throws(() => validateAndAggregateCart(huge), /too many different items/);
  });

  test('a cart at the boundary is still accepted', () => {
    const atLimit = Array.from({ length: 100 }, (_, i) => ({ productId: 'p' + i, quantity: 1 }));
    assert.strictEqual(validateAndAggregateCart(atLimit).length, 100);
  });
}

// ============================================================
// TLS-01 — a scheduled, silent downgrade of the database connection
// ============================================================
// pg treats sslmode=require as verify-full TODAY. pg v9 will treat it as
// libpq does: encrypted but UNAUTHENTICATED. That turns a routine dependency
// bump into a man-in-the-middle window with no code change and no failing
// test. Rewriting it to verify-full is a no-op now and correct later.
section('[sec-11] TLS-01 — sslmode aliases are resolved before pg v9 redefines them');
{
  const { normalizeConnectionString } = require('../src/config/db');
  const NEON = 'postgresql://u:p@ep-x.ap-south-1.aws.neon.tech/db';
  const mode = (s) => new URL(s).searchParams.get('sslmode');

  test('THE FINDING: sslmode=require becomes verify-full, so the pg v9 semantics change cannot downgrade it', () => {
    const r = normalizeConnectionString(`${NEON}?sslmode=require`);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.from, 'require');
    assert.strictEqual(mode(r.connectionString), 'verify-full');
  });

  test('sslmode=verify-ca is also an alias today and is resolved the same way', () => {
    assert.strictEqual(mode(normalizeConnectionString(`${NEON}?sslmode=verify-ca`).connectionString), 'verify-full');
  });

  test('every other part of the URL survives untouched — credentials, host, database, other params', () => {
    const src = `${NEON}?sslmode=require&channel_binding=require&application_name=chakrashri`;
    const out = new URL(normalizeConnectionString(src).connectionString);
    const orig = new URL(src);
    assert.strictEqual(out.username, orig.username);
    assert.strictEqual(out.password, orig.password);
    assert.strictEqual(out.host, orig.host);
    assert.strictEqual(out.pathname, orig.pathname);
    assert.strictEqual(out.searchParams.get('channel_binding'), 'require');
    assert.strictEqual(out.searchParams.get('application_name'), 'chakrashri');
  });

  test('an already-correct sslmode=verify-full is left exactly as it was', () => {
    const src = `${NEON}?sslmode=verify-full`;
    const r = normalizeConnectionString(src);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.connectionString, src);
  });

  test('sslmode=prefer is WARNED about, never rewritten — it permits a plaintext fallback a local dev database relies on', () => {
    const r = normalizeConnectionString(`${NEON}?sslmode=prefer`);
    assert.strictEqual(r.changed, false);
    assert.match(r.warning, /UNENCRYPTED/);
  });

  test('sslmode=disable is an explicit choice and is respected', () => {
    const r = normalizeConnectionString(`${NEON}?sslmode=disable`);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.warning, null);
  });

  test('THE REGRESSION THIS MUST NOT CAUSE: a local test database is never forced into verify-full, which it cannot satisfy', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const r = normalizeConnectionString(`postgresql://postgres@${host}:5432/chakrashri_test?sslmode=require`);
      assert.strictEqual(r.changed, false, `${host} must be left alone`);
    }
  });

  test('a URL with no sslmode at all is untouched, so CI and local development are unaffected', () => {
    const src = 'postgresql://postgres@db.internal:5432/chakrashri_test';
    assert.strictEqual(normalizeConnectionString(src).connectionString, src);
  });

  test('a key=value DSN that WHATWG URL cannot parse is returned unchanged rather than throwing at boot', () => {
    const src = 'host=db.internal port=5432 dbname=test sslmode=require';
    const r = normalizeConnectionString(src);
    assert.strictEqual(r.connectionString, src);
    assert.strictEqual(r.changed, false);
  });

  test('an absent DATABASE_URL does not throw — the pool reports a missing URL itself, this must not pre-empt it', () => {
    for (const v of [undefined, null, '']) {
      assert.strictEqual(normalizeConnectionString(v).connectionString, v);
    }
  });

  test('DB_SSL_NORMALIZE=false is a real escape hatch, not a decoration', () => {
    const src = `${NEON}?sslmode=require`;
    const prev = process.env.DB_SSL_NORMALIZE;
    process.env.DB_SSL_NORMALIZE = 'false';
    try {
      assert.strictEqual(normalizeConnectionString(src).connectionString, src);
    } finally {
      if (prev === undefined) delete process.env.DB_SSL_NORMALIZE; else process.env.DB_SSL_NORMALIZE = prev;
    }
    // ...and the hatch closes again afterwards, so one test cannot disable the next.
    assert.strictEqual(normalizeConnectionString(src).changed, true);
  });
}

// ============================================================
// The email settings migration 015 seeds but nothing could edit
// ============================================================
section('[sec-12] The settings 015 seeds are actually editable, and admin_alert_email cannot inject headers');
{
  const { DEFAULTS, setSetting } = require('../src/utils/settings');

  // THE FINDING: 015 seeded six rows, documented them as the configuration
  // surface for the email system, and shipped consumers that read them — but
  // setSetting() rejects any key absent from DEFAULTS, so every one of them
  // answered "400 Unknown setting" and GET /settings never returned them. The
  // release notes' own action item ("set admin_alert_email in the admin
  // console") was impossible to carry out.
  test('THE FINDING: every setting migration 015 seeds is editable, not just seeded', () => {
    for (const key of [
      'admin_alert_email', 'email_admin_alerts_enabled', 'email_marketing_enabled',
      'abandoned_cart_email_after_minutes', 'booking_reminder_hours_before',
      'low_stock_alert_threshold'
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(DEFAULTS, key),
        `${key} is seeded by migration 015 but missing from DEFAULTS, so no admin can change it`
      );
    }
  });

  test('the defaults match what 015 seeds, so listing them changed no behaviour', () => {
    assert.strictEqual(DEFAULTS.admin_alert_email, '');
    assert.strictEqual(DEFAULTS.email_admin_alerts_enabled, true);
    assert.strictEqual(DEFAULTS.email_marketing_enabled, true);
    assert.strictEqual(DEFAULTS.abandoned_cart_email_after_minutes, 20);
    assert.strictEqual(DEFAULTS.booking_reminder_hours_before, 24);
    assert.strictEqual(DEFAULTS.low_stock_alert_threshold, 5);
  });

  // admin_alert_email becomes the `To:` header of every operational alert, so
  // it is an injection surface the moment it is editable. Every value below is
  // rejected before setSetting reaches the database, which is why this runs in
  // the offline suite.
  const injections = [
    ['a CR/LF that would start a new header', 'ops@x.com\r\nBcc: attacker@evil.com'],
    ['a bare newline', 'ops@x.com\nBcc: attacker@evil.com'],
    ['a comma that turns one recipient into two', 'ops@x.com,attacker@evil.com'],
    ['a semicolon recipient list', 'ops@x.com;attacker@evil.com'],
    ['a display-name form smuggling angle brackets', 'Ops <ops@x.com> <attacker@evil.com>'],
    ['not an address at all', 'not-an-email'],
    ['a hostname with no TLD', 'ops@localhost']
  ];
  for (const [why, value] of injections) {
    test(`admin_alert_email refuses ${why}`, async () => {
      await assert.rejects(
        () => setSetting('admin_alert_email', value, null),
        (err) => err.status === 400,
        `${JSON.stringify(value)} was accepted as an alert recipient`
      );
    });
  }

  test('a key that is genuinely unknown is still refused', async () => {
    await assert.rejects(
      () => setSetting('not_a_real_setting', 'x', null),
      (err) => err.status === 400
    );
  });
}

// ============================================================
// Runner
// ============================================================
(async () => {
  let passed = 0; let failed = 0;
  for (const item of queue) {
    if (item.type === 'section') { console.log('\n' + item.name); continue; }
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
  process.exit(failed ? 1 : 0);
})();
