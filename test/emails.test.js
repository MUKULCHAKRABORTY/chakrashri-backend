/**
 * THE EMAIL PATH, ACTUALLY EXECUTED.
 *
 * WHY THIS EXISTS
 * Three templates and one scheduled job were added without a single one of them
 * ever being run. They sit on money paths — a customer whose booking payment is
 * under review has usually already been charged — and none of them fails
 * loudly. A template that throws is caught upstream, logged, and swallowed; the
 * first sign is a customer asking why they never heard anything.
 *
 * Reading these files proves they parse. It does not prove that a template
 * renders, that a null amount does not print "₹NaN" in a message about money, or
 * that a failed send releases its claim marker so the booking can be chased
 * again. Only running them proves that.
 *
 * Nothing is sent and nothing touches a database. Two seams are stubbed:
 *   - the mail engine's sendMail, replaced BEFORE templates.js loads, because
 *     templates.js destructures it at load time and a later patch would do
 *     nothing at all;
 *   - the db module, which returns rows shaped like what each query selects.
 *     Returning rows matters: a job handed an empty result set exits on its
 *     first line and proves nothing about the code after it.
 *
 * Run: node test/emails.test.js
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub/stub';
process.env.SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://chakrashri.netlify.app';

const queue = [];
function section(name) { queue.push({ type: 'section', name }); }
function test(name, fn) { queue.push({ type: 'test', name, fn }); }

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------
const sent = [];
const queries = [];
const MODE = { failSends: false };

/** Rows shaped like what each job's queries actually select. */
function rowsFor(sql) {
  const s = String(sql);
  if (/UPDATE\s+orders/i.test(s) && /recovery_email_sent_at/i.test(s)) {
    return [{ id: '00000000-0000-0000-0000-0000000000a1' }];
  }
  if (/UPDATE\s+(puja|astrology)_bookings/i.test(s) && /recovery_email_sent_at/i.test(s)) {
    return [{ id: '00000000-0000-0000-0000-0000000000b1', user_id: '00000000-0000-0000-0000-0000000000u1',
              amount_paise: 180000, preferred_date: '2026-10-02', service_name: 'Satyanarayan Puja' }];
  }
  if (/FROM\s+users/i.test(s)) {
    return [{ id: '00000000-0000-0000-0000-0000000000u1', email: 'buyer@example.com', name: 'Meera' }];
  }
  if (/stock_notifications|back_in_stock/i.test(s)) {
    return [{ id: 'n1', email: 'buyer@example.com', name: 'Meera', product_id: 'p1',
              product_name: 'Sphatik Mala', slug: 'sphatik-mala', stock_qty: 4 }];
  }
  if (/FROM\s+orders/i.test(s) || /order_items/i.test(s)) {
    return [{ id: '00000000-0000-0000-0000-0000000000a1', order_number: 'CS-1001',
              email: 'buyer@example.com', customer_name: 'Meera', total_paise: 250000,
              user_id: '00000000-0000-0000-0000-0000000000u1', name: 'Sphatik Mala', quantity: 1 }];
  }
  if (/(puja|astrology)_bookings/i.test(s)) {
    return [{ id: '00000000-0000-0000-0000-0000000000b1', email: 'buyer@example.com', name: 'Meera',
              user_id: '00000000-0000-0000-0000-0000000000u1', amount_paise: 180000,
              preferred_date: '2026-10-02', preferred_time: '09:00', service_name: 'Satyanarayan Puja' }];
  }
  if (/site_settings/i.test(s)) return [{ key: 'abandoned_cart_email_after_minutes', value: '20' }];
  if (/COUNT|SUM|COALESCE/i.test(s)) return [{ count: 3, total: 500000, n: 3 }];
  return [];
}

const db = {
  query: (sql) => { queries.push(String(sql)); const rows = rowsFor(sql); return Promise.resolve({ rows, rowCount: rows.length }); },
  getClient: async () => ({ query: (s) => db.query(s), release() {} }),
  transaction: async (fn) => fn({ query: (s) => db.query(s) }),
  pool: { end: async () => {} }
};

const realEngine = require(path.join(ROOT, 'src/utils/email/engine.js'));
/* { sent: true } is the exact shape the real engine returns on success and the
   exact shape every caller checks. Getting this wrong in a stub makes real code
   look broken, which is its own kind of false alarm. */
const fakeEngine = Object.assign(Object.create(null), realEngine, {
  sendMail: async (opts) => {
    sent.push(opts);
    return MODE.failSends ? { sent: false, reason: 'smtp_down' } : { sent: true };
  }
});

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === './engine' && parent && /email/.test(parent.filename)) return fakeEngine;
  if (/config[\\/]db$/.test(request) || request.endsWith('/config/db')) return db;
  return origLoad.apply(this, arguments);
};

const T = require(path.join(ROOT, 'src/utils/email/templates.js'));
const jobs = require(path.join(ROOT, 'scripts/send-scheduled-emails.js'));

const XSS = '<script>alert(1)</script>';

// ============================================================
section('[mail-1] Every template added this cycle actually renders');
// ============================================================
{
  const CASES = [
    ['contact reply, normal', () => T.sendContactReply({
      toEmail: 'a@b.c', toName: 'Anita', subject: 'Re: your mala',
      replyBody: 'Thank you for writing.\n\nIt was dispatched today.',
      originalMessage: { subject: 'Where is my mala?', message: 'Ordered last week.', when: '2 May' },
      messageId: 'm1' })],
    ['contact reply, no original message', () => T.sendContactReply({
      toEmail: 'a@b.c', toName: null, subject: 'Hello', replyBody: 'Body.',
      originalMessage: null, messageId: 'm3' })],
    ['booking payment review, puja', () => T.sendBookingPaymentReview({
      email: 'a@b.c', name: 'Ravi', type: 'puja', bookingId: 'b1', amountPaise: 250000 })],
    ['booking payment review, no name', () => T.sendBookingPaymentReview({
      email: 'a@b.c', name: null, type: 'astrology', bookingId: 'b2', amountPaise: 0 })],
    ['booking abandoned, puja', () => T.sendBookingAbandoned({
      email: 'a@b.c', name: 'Meera', type: 'puja', bookingId: 'b3',
      preferredDate: '2026-10-02', amountPaise: 180000 })],
    ['booking abandoned, no date', () => T.sendBookingAbandoned({
      email: 'a@b.c', name: 'Sunil', type: 'astrology', bookingId: 'b4',
      preferredDate: null, amountPaise: 90000 })]
  ];

  for (const [label, run] of CASES) {
    test(label + ' — renders, is transactional, and is deduped', async () => {
      const before = sent.length;
      await run();
      const opts = sent[before];
      assert.ok(opts, 'produced no mail at all');
      assert.ok(String(opts.html || '').length > 200, 'rendered an implausibly short body');
      assert.match(String(opts.category), /transactional/i,
        'service mail — consent and the marketing kill switch must not be able to swallow it');
      assert.ok(opts.dedupeKey, 'without a dedupe key a double-click sends twice');
    });
  }

  test('THE INJECTION CASE: nothing a person typed becomes live markup', async () => {
    const before = sent.length;
    await T.sendContactReply({ toEmail: 'a@b.c', toName: XSS, subject: XSS, replyBody: XSS,
      originalMessage: { subject: XSS, message: XSS, when: XSS }, messageId: 'x1' });
    await T.sendBookingPaymentReview({ email: 'a@b.c', name: XSS, type: 'puja', bookingId: XSS, amountPaise: null });
    await T.sendBookingAbandoned({ email: 'a@b.c', name: XSS, type: XSS, bookingId: XSS,
      preferredDate: XSS, amountPaise: -1 });
    for (const opts of sent.slice(before)) {
      assert.ok(!String(opts.html).includes(XSS),
        'an admin reply and a customer name both reach these templates as free text');
    }
  });
}

// ============================================================
section('[mail-2] A message about money never prints a nonsense figure');
// ============================================================
{
  test('a null, zero, missing or negative amount is omitted, not rendered', async () => {
    /* This one was real: the guard was truthy rather than > 0, so a corrupt
       amount_paise of -1 rendered as "of ₹-0.01" in an email about money that
       had already been taken. Omitting the clause reads perfectly. */
    for (const amountPaise of [null, 0, undefined, -1, -250000]) {
      const before = sent.length;
      await T.sendBookingPaymentReview({ email: 'a@b.c', name: 'R', type: 'puja', bookingId: 'b', amountPaise });
      const text = String(sent[before].html).replace(/<[^>]+>/g, '');
      assert.ok(!/₹\s*-/.test(text), 'rendered a negative amount for ' + amountPaise);
      assert.ok(!/NaN|Infinity|undefined|null/.test(text), 'rendered a non-number for ' + amountPaise);
    }
  });

  test('a real amount is still shown, in rupees', async () => {
    const before = sent.length;
    await T.sendBookingPaymentReview({ email: 'a@b.c', name: 'R', type: 'puja', bookingId: 'b', amountPaise: 250000 });
    assert.match(String(sent[before].html), /₹\s?2,?500/,
      '250000 paise is ₹2500 — a guard that hides every amount is not a fix');
  });

  test('a missing or unparseable date never reaches the customer as "Invalid Date"', async () => {
    for (const preferredDate of ['2026-10-02', null, undefined, 'not-a-date', '']) {
      const before = sent.length;
      await T.sendBookingAbandoned({ email: 'a@b.c', name: 'M', type: 'puja', bookingId: 'b',
        preferredDate, amountPaise: 180000 });
      const text = String(sent[before].html).replace(/<[^>]+>/g, '');
      assert.ok(!/Invalid Date|NaN|undefined|null/.test(text), 'leaked a bad date for ' + preferredDate);
    }
  });
}

// ============================================================
section('[mail-3] Every scheduled job runs, and claims behave under failure');
// ============================================================
{
  test('the export list is DERIVED from the job registry, never typed beside it', () => {
    /* runAbandonedBookings had already been missed. It ran correctly in
       production, because main() iterates JOBS — but nothing could import it,
       so the one job added this cycle was the one job no test could reach. */
    assert.ok(jobs.JOBS && typeof jobs.JOBS === 'object', 'the registry itself must be exported');
    for (const [key, fn] of Object.entries(jobs.JOBS)) {
      assert.strictEqual(typeof jobs[key], 'function', 'registry key ' + key + ' is not exported');
      assert.strictEqual(typeof jobs[fn.name], 'function', 'function ' + fn.name + ' is not exported');
    }
    assert.ok(Object.keys(jobs.JOBS).length >= 5, 'expected the full set of jobs');
  });

  test('every job completes when sends succeed, and claims nothing back', async () => {
    MODE.failSends = false;
    const q0 = queries.length;
    for (const [name, fn] of Object.entries(jobs.JOBS)) {
      const r = await fn().catch((e) => { throw new Error('job "' + name + '" threw: ' + e.message); });
      assert.ok(r && typeof r === 'object', 'job "' + name + '" returned nothing to report on');
      assert.strictEqual(Number(r.failed || 0), 0, 'job "' + name + '" reported a failure on the success path');
    }
    const released = queries.slice(q0).filter((q) => /recovery_email_sent_at = NULL/i.test(q));
    assert.strictEqual(released.length, 0,
      'a successful send released its claim marker — that customer would be mailed again');
  });

  test('THE RETRY PATH: a failed send releases its marker so it can be chased again', async () => {
    MODE.failSends = true;
    const q0 = queries.length;
    for (const [name, fn] of Object.entries(jobs.JOBS)) {
      await fn().catch((e) => { throw new Error('job "' + name + '" threw under send failure: ' + e.message); });
    }
    const released = queries.slice(q0).filter((q) => /recovery_email_sent_at = NULL/i.test(q));
    assert.ok(released.length >= 3,
      'claim-then-send only works if a failure gives the claim back: one order plus both booking types, '
      + 'got ' + released.length);
    MODE.failSends = false;
  });

  test('no query ships a literal ${...}', () => {
    // A template literal that was actually an ordinary quoted string parses
    // fine and fails only when Postgres sees it, at 3am, on a money path.
    const leaked = queries.filter((q) => q.includes('${'));
    assert.deepStrictEqual(leaked.map((q) => q.slice(0, 60)), []);
  });
}

// ============================================================
// Runner
// ============================================================
(async () => {
  let passed = 0; let failed = 0;
  for (const item of queue) {
    if (item.type === 'section') { console.log('\n' + item.name); continue; }
    try { await item.fn(); console.log('  PASS -', item.name); passed++; }
    catch (e) { console.log('  FAIL -', item.name, '\n        ', e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`(${queries.length} queries issued against the stub, ${sent.length} messages composed, none sent)\n`);
  process.exit(failed ? 1 : 0);
})();
