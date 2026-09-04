/**
 * Integration tests against a REAL PostgreSQL database.
 *
 * WHY THESE EXIST
 * All 101 pre-existing tests mock src/config/db.js. That is the right choice for
 * fast, dependency-free unit tests, but it means nothing ever proved the things
 * that only a real database can decide:
 *
 *   - Does a concurrent checkout of the last unit actually serialise, or does
 *     the row lock only look correct? A mock cannot deadlock, and it cannot
 *     demonstrate that `WHERE stock_qty >= $1` refuses a race.
 *   - Does the migration-012 trigger really keep products.stock_qty equal to
 *     the sum of its variants, including when the last variant is deleted?
 *   - Do the CHECK constraints added in 013 actually refuse the bad rows they
 *     were written to refuse?
 *   - Does the refund ledger arithmetic compose correctly across several
 *     partial refunds?
 *
 * "The oversell fix works" was, until now, an assertion about a mock.
 *
 * SKIPS LOUDLY when no throwaway database is configured, so `npm run verify` on
 * a laptop with no Postgres still passes — but says plainly what did not run,
 * because a suite that removes itself from the gate without anyone noticing is
 * worse than one that fails. CI sets REQUIRE_DB_TESTS=true, which turns any
 * skip into a failure.
 *
 * SAFETY: refuses to run against anything that does not look like a throwaway
 * test database. These tests create and delete rows; pointing them at
 * production would be destructive, so the guard is deliberately paranoid.
 *
 * Run: TEST_DATABASE_URL=postgres://... node test/db-integration.test.js
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

// Load .env so this is configurable on any machine without shell exports.
// dotenv never overwrites a variable already present in the real environment,
// so CI's service-container DATABASE_URL still wins over anything in a file.
try { require('dotenv').config(); } catch { /* optional */ }

// TEST_DATABASE_URL first, deliberately. A developer's .env holds the PRODUCTION
// DATABASE_URL, and these tests create and delete rows — so the variable that
// selects a database to write to must be one you have to set on purpose.
const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';

// CI sets this. Then a skip — for ANY reason — is a failure, because in CI a
// skip does not mean "no database here", it means the service container broke
// and this gate has quietly stopped testing anything.
const REQUIRE_DB = process.env.REQUIRE_DB_TESTS === 'true';

function skip(lines) {
  const label = REQUIRE_DB ? 'FAILED' : 'SKIPPED';
  const out = REQUIRE_DB ? console.error : console.log;
  out(`\n[db-integration] ${label}: the 29 database integration tests did NOT run.`);
  lines.forEach((l) => out('                 ' + l));
  if (REQUIRE_DB) {
    console.error('                 REQUIRE_DB_TESTS=true, so this cannot be skipped.\n');
    process.exit(1);
  }
  out('');
  out('                 These are the tests that prove oversell is impossible under');
  out('                 concurrency, that a refund returns stock exactly once, and that');
  out('                 the audit log cannot be edited. `npm test` passing without them');
  out('                 is a weaker claim than it looks — run them before you deploy.\n');
  process.exit(0);
}

if (!DATABASE_URL) {
  skip([
    'No TEST_DATABASE_URL (or DATABASE_URL) is set.',
    'Point TEST_DATABASE_URL at a THROWAWAY database — a Neon branch, a local',
    'Postgres, or a second database whose name contains "test".'
  ]);
}

// --- Guard rail -------------------------------------------------------------
// These tests write and delete. Refuse anything that is not obviously a
// disposable database.
//
// The previous version tested the WHOLE connection string against
// /test|localhost|127\.0\.0\.1|ci/. Two problems with that, and the second is
// the dangerous one:
//
//   1. `ci` as a bare substring matches inside ordinary words — and a Neon
//      endpoint id is random, so a host like ep-precious-sun-12345 authorises a
//      destructive run on a production database by coincidence.
//   2. It searched the credentials too. A randomly generated PASSWORD containing
//      "ci" or "test" would have been enough to unlock it. A secret should never
//      be able to grant permission.
//
// So: decide on the HOST and DATABASE NAME only, never the credentials, and
// require a whole-word marker. A false negative costs one config tweak. A false
// positive costs the client's live orders.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function looksDisposable(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not a URL we can dissect — fall back to the database name at the end of a
    // key=value DSN, and refuse if even that is unreadable.
    return /(^|[\s;])dbname=\S*(^|[^a-z])(test|ci)([^a-z]|$)/i.test(rawUrl);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOCAL_HOSTNAMES.has(host)) return true;

  const dbName = decodeURIComponent(url.pathname.replace(/^\//, '')).toLowerCase();
  // Whole-word "test" or "ci", separated by a non-letter or a string boundary:
  // matches chakrashri_test, test-db, ci, shop_ci — not "precious" or "civic".
  return /(^|[^a-z])(test|ci)([^a-z]|$)/.test(dbName);
}

if (!looksDisposable(DATABASE_URL)) {
  const shown = (() => {
    try {
      const u = new URL(DATABASE_URL);
      return `${u.hostname}${u.pathname}`; // host + database only; never the password
    } catch { return '(unparseable connection string)'; }
  })();
  skip([
    'The configured database does not look disposable: ' + shown,
    'These tests CREATE AND DELETE rows, so running them against production',
    'would destroy real orders. Refusing on purpose.',
    'Set TEST_DATABASE_URL to a database whose name contains "test" or "ci",',
    'or whose host is localhost.'
  ]);
}

// ---------------------------------------------------------------------------
// The guard above approved DATABASE_URL. This line makes the pool USE it.
// ---------------------------------------------------------------------------
// Without this, introducing TEST_DATABASE_URL created the worst possible
// version of this file: the guard validated the throwaway database while
// src/config/db.js — which reads process.env.DATABASE_URL — connected to the
// production one. Destructive tests would have run against live orders while
// the console reported that a test database had been checked. A guard that
// inspects a different thing from the one being used is not a guard.
//
// So the approved URL becomes THE url, before anything opens a connection.
process.env.DATABASE_URL = DATABASE_URL;

const db = require('../src/config/db');

// Belt and braces: prove the pool really did end up on the approved database.
// The connection string may be rewritten by the TLS normaliser in config/db.js,
// so compare host and database name rather than the whole string.
(function assertConnectedToApprovedDatabase() {
  const actual = db.basePoolConfig.connectionString;
  const target = (u) => { try { const x = new URL(u); return x.hostname + x.pathname; } catch { return u; } };
  if (target(actual) !== target(DATABASE_URL)) {
    console.error('\n[db-integration] ABORTING: the pool is not on the database that was checked.');
    console.error('  approved: ' + target(DATABASE_URL));
    console.error('  actual:   ' + target(actual) + '\n');
    process.exit(1);
  }
})();
const { reserveStockAndCreateOrder } = require('../src/utils/orders');
const { restoreOrderStock } = require('../src/utils/stock');

const queue = [];
function section(name) { queue.push({ type: 'section', name }); }
function test(name, fn) { queue.push({ type: 'test', name, fn }); }

const created = { users: [], products: [], orders: [], slots: [], practitioners: [] };

function uniq(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

async function makeUser(role = 'customer') {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified)
     VALUES ($1, $2, 'x', $3, true) RETURNING id`,
    ['Test User', `${uniq('t')}@test.invalid`, role]
  );
  created.users.push(rows[0].id);
  return rows[0].id;
}

async function makeProduct({ stock = 10, price = 50000 } = {}) {
  const slug = uniq('test-product');
  const { rows } = await db.query(
    `INSERT INTO products (sku, name, slug, category, price_paise, mrp_paise, stock_qty, gst_rate)
     VALUES ($1,$2,$3,'test',$4,$4,$5,3) RETURNING id`,
    [uniq('SKU'), 'Test Product', slug, price, stock]
  );
  created.products.push(rows[0].id);
  return rows[0].id;
}

async function makeAddress(userId) {
  const { rows } = await db.query(
    `INSERT INTO addresses (user_id, full_name, phone, line1, city, state, pincode)
     VALUES ($1,'Test Person','9876543210','1 Test Street','Kolkata','West Bengal','700001')
     RETURNING id`,
    [userId]
  );
  return rows[0].id;
}

async function stockOf(productId) {
  const { rows } = await db.query('SELECT stock_qty FROM products WHERE id = $1', [productId]);
  return Number(rows[0].stock_qty);
}

// ============================================================
section('[db-1] The schema this code expects actually exists');
// ============================================================
{
  test('migrations 013, 014 and 015 have been applied', async () => {
    const { rows } = await db.query('SELECT filename FROM _migrations ORDER BY filename');
    const applied = rows.map((r) => r.filename);
    assert.ok(applied.some((f) => f.startsWith('013_')), 'migration 013 has not been applied');
    assert.ok(applied.some((f) => f.startsWith('014_')), 'migration 014 has not been applied');
    // 015 was added to this list after a release where nobody could say whether
    // it had been applied to a given database. That question is CI's job, not a
    // thing to reconstruct by hand before each deploy.
    assert.ok(applied.some((f) => f.startsWith('015_')), 'migration 015 has not been applied');
  });

  test('the new tables exist', async () => {
    for (const table of ['refunds', 'practitioners', 'availability_slots', 'email_verification_tokens']) {
      const { rows } = await db.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
      assert.ok(rows[0].reg, `table ${table} is missing`);
    }
  });

  test('015: the email system has the tables it writes to on every send', async () => {
    for (const table of [
      'email_log', 'email_subscriptions', 'email_suppressions',
      'stock_notifications', 'contact_messages'
    ]) {
      const { rows } = await db.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
      assert.ok(rows[0].reg, `table ${table} is missing — every email send would fail to record`);
    }
  });

  test('015: the abandoned-checkout marker exists, without which recovery mail repeats every sweep', async () => {
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'orders' AND column_name = 'recovery_email_sent_at'`
    );
    assert.strictEqual(rows.length, 1, 'orders.recovery_email_sent_at is missing');
  });

  test('015: the email settings rows are seeded AND editable through the settings module', async () => {
    const { DEFAULTS } = require('../src/utils/settings');
    const { rows } = await db.query(
      `SELECT key FROM site_settings WHERE key = ANY($1)`,
      [['admin_alert_email', 'email_admin_alerts_enabled', 'email_marketing_enabled',
        'abandoned_cart_email_after_minutes', 'booking_reminder_hours_before',
        'low_stock_alert_threshold']]
    );
    const seeded = rows.map((r) => r.key);
    assert.strictEqual(seeded.length, 6, `only ${seeded.length} of the 6 email settings are seeded`);
    // Seeded is not the same as reachable: setSetting() refuses any key absent
    // from DEFAULTS, which is how these stayed read-only after 015 shipped.
    for (const key of seeded) {
      assert.ok(Object.prototype.hasOwnProperty.call(DEFAULTS, key),
        `${key} exists in the database but no admin can change it`);
    }
  });

  test('PERF-01: the index that matters most actually exists', async () => {
    const { rows } = await db.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'order_items' AND indexname = 'idx_order_items_order'`
    );
    assert.strictEqual(rows.length, 1,
      'order_items(order_id) has no index — every order view and stock restore sequential-scans the line-item table');
  });

  test('BIZ-04: products.rating no longer defaults to a fabricated 4.5', async () => {
    const { rows } = await db.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'rating'`
    );
    assert.ok(!rows[0].column_default || !String(rows[0].column_default).includes('4.5'),
      'a new product would still be created with an invented rating');
  });
}

// ============================================================
section('[db-2] Oversell is impossible under real concurrency');
// ============================================================
{
  test('THE CORE INVARIANT: two simultaneous checkouts for the LAST unit — exactly one wins', async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const productId = await makeProduct({ stock: 1 });
    const addrA = await makeAddress(userA);
    const addrB = await makeAddress(userB);

    const attempt = (userId, shippingAddressId) => reserveStockAndCreateOrder({
      userId,
      items: [{ productId, quantity: 1 }],
      shippingAddressId,
      paymentMethod: 'cod',
      initialStatus: 'processing'
    }).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e }));

    // Fired together, so they genuinely contend for the same row lock.
    const [a, b] = await Promise.all([attempt(userA, addrA), attempt(userB, addrB)]);
    const winners = [a, b].filter((x) => x.ok);
    const losers = [a, b].filter((x) => !x.ok);

    assert.strictEqual(winners.length, 1, 'exactly one checkout must succeed for a single unit of stock');
    assert.strictEqual(losers.length, 1);
    assert.match(losers[0].e.message, /stock|out of stock/i);
    assert.strictEqual(await stockOf(productId), 0, 'stock must land at exactly 0, never negative');

    winners.forEach((w) => created.orders.push(w.r.id));
  });

  test('ten simultaneous checkouts against five units sell exactly five', async () => {
    const productId = await makeProduct({ stock: 5 });
    const users = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
    const addresses = await Promise.all(users.map((u) => makeAddress(u)));

    const results = await Promise.all(users.map((userId, i) =>
      reserveStockAndCreateOrder({
        userId,
        items: [{ productId, quantity: 1 }],
        shippingAddressId: addresses[i],
        paymentMethod: 'cod',
        initialStatus: 'processing'
      }).then((r) => ({ ok: true, r })).catch(() => ({ ok: false }))
    ));

    const sold = results.filter((r) => r.ok);
    assert.strictEqual(sold.length, 5, `expected exactly 5 successful orders, got ${sold.length}`);
    assert.strictEqual(await stockOf(productId), 0);
    sold.forEach((s) => created.orders.push(s.r.id));
  });

  test('DB-01: concurrent checkouts of the SAME two products in OPPOSITE cart order do not deadlock', async () => {
    // This is the case ORDER BY id was added for. Without consistent lock
    // ordering, cart {A,B} and cart {B,A} can each hold one lock and wait for
    // the other; Postgres kills one with 40P01 and the customer sees a failed
    // checkout for a purchase that would have succeeded a millisecond later.
    const p1 = await makeProduct({ stock: 50 });
    const p2 = await makeProduct({ stock: 50 });
    const users = await Promise.all(Array.from({ length: 8 }, () => makeUser()));
    const addresses = await Promise.all(users.map((u) => makeAddress(u)));

    const results = await Promise.all(users.map((userId, i) =>
      reserveStockAndCreateOrder({
        userId,
        // Half the carts list the products one way round, half the other.
        items: i % 2 === 0
          ? [{ productId: p1, quantity: 1 }, { productId: p2, quantity: 1 }]
          : [{ productId: p2, quantity: 1 }, { productId: p1, quantity: 1 }],
        shippingAddressId: addresses[i],
        paymentMethod: 'cod',
        initialStatus: 'processing'
      }).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e }))
    ));

    const failed = results.filter((r) => !r.ok);
    assert.strictEqual(failed.length, 0,
      `all 8 checkouts should succeed; failures: ${failed.map((f) => f.e.code || f.e.message).join(', ')}`);
    results.forEach((r) => created.orders.push(r.r.id));
  });
}

// ============================================================
section('[db-3] AUTH-01 — a shipping address must belong to the buyer');
// ============================================================
{
  test('THE FINDING: attaching another customer\'s address to your own order is refused', async () => {
    const victim = await makeUser();
    const attacker = await makeUser();
    const victimAddress = await makeAddress(victim);
    const productId = await makeProduct({ stock: 5 });

    await assert.rejects(
      () => reserveStockAndCreateOrder({
        userId: attacker,
        items: [{ productId, quantity: 1 }],
        shippingAddressId: victimAddress,
        paymentMethod: 'cod',
        initialStatus: 'processing'
      }),
      (err) => err.status === 403 && /could not be found on your account/i.test(err.message)
    );

    assert.strictEqual(await stockOf(productId), 5, 'a rejected order must not consume stock');
  });

  test('DATA-01: the order freezes a snapshot, so editing the address later cannot rewrite history', async () => {
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 5 });

    const order = await reserveStockAndCreateOrder({
      userId,
      items: [{ productId, quantity: 1 }],
      shippingAddressId: addressId,
      paymentMethod: 'cod',
      initialStatus: 'processing'
    });
    created.orders.push(order.id);

    // The customer moves house.
    await db.query(
      `UPDATE addresses SET line1 = 'NEW ADDRESS AFTER MOVING', city = 'Mumbai' WHERE id = $1`,
      [addressId]
    );

    const { rows } = await db.query(
      'SELECT shipping_address_snapshot FROM orders WHERE id = $1',
      [order.id]
    );
    assert.strictEqual(rows[0].shipping_address_snapshot.line1, '1 Test Street',
      'the already-placed order must still show where it was actually being shipped');
    assert.strictEqual(rows[0].shipping_address_snapshot.city, 'Kolkata');
  });

  test('an address that has been soft-deleted cannot be used for a new order', async () => {
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 5 });
    await db.query('UPDATE addresses SET deleted_at = now() WHERE id = $1', [addressId]);

    await assert.rejects(
      () => reserveStockAndCreateOrder({
        userId, items: [{ productId, quantity: 1 }], shippingAddressId: addressId,
        paymentMethod: 'cod', initialStatus: 'processing'
      }),
      (err) => err.status === 403
    );
  });
}

// ============================================================
section('[db-4] The variant stock trigger holds');
// ============================================================
{
  test('products.stock_qty tracks the sum of active variants', async () => {
    const productId = await makeProduct({ stock: 0 });
    const mk = (qty) => db.query(
      `INSERT INTO product_variants (product_id, option_values, stock_qty)
       VALUES ($1, $2, $3) RETURNING id`,
      [productId, JSON.stringify([{ option: 'Size', value: uniq('v') }]), qty]
    );
    const v1 = (await mk(3)).rows[0].id;
    const v2 = (await mk(4)).rows[0].id;
    assert.strictEqual(await stockOf(productId), 7);

    await db.query('UPDATE product_variants SET stock_qty = 10 WHERE id = $1', [v1]);
    assert.strictEqual(await stockOf(productId), 14);

    await db.query('UPDATE product_variants SET is_active = false WHERE id = $1', [v2]);
    assert.strictEqual(await stockOf(productId), 10, 'an inactive variant must stop contributing');

    await db.query('DELETE FROM product_variants WHERE product_id = $1', [productId]);
    assert.strictEqual(await stockOf(productId), 0,
      'deleting the last variant must zero the product, not leave a stale sellable number');
  });

  test('a variant purchase decrements the VARIANT and lets the trigger re-derive the product', async () => {
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 0 });
    const { rows } = await db.query(
      `INSERT INTO product_variants (product_id, option_values, stock_qty, price_paise)
       VALUES ($1, $2, 5, 60000) RETURNING id`,
      [productId, JSON.stringify([{ option: 'Colour', value: 'Red' }])]
    );
    const variantId = rows[0].id;
    assert.strictEqual(await stockOf(productId), 5);

    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, variantId, quantity: 2 }],
      shippingAddressId: addressId, paymentMethod: 'cod', initialStatus: 'processing'
    });
    created.orders.push(order.id);

    const { rows: vr } = await db.query('SELECT stock_qty FROM product_variants WHERE id = $1', [variantId]);
    assert.strictEqual(Number(vr[0].stock_qty), 3);
    assert.strictEqual(await stockOf(productId), 3, 'the trigger must have re-derived the product total');
    assert.strictEqual(order.total, 60000 * 2 + 0 + Math.round(60000 * 2 * 0.03),
      'the variant price must override the base product price');
  });

  test('a product WITH variants cannot be bought without choosing one', async () => {
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 0 });
    await db.query(
      `INSERT INTO product_variants (product_id, option_values, stock_qty) VALUES ($1, $2, 5)`,
      [productId, JSON.stringify([{ option: 'Size', value: 'M' }])]
    );

    await assert.rejects(
      () => reserveStockAndCreateOrder({
        userId, items: [{ productId, quantity: 1 }],
        shippingAddressId: addressId, paymentMethod: 'cod', initialStatus: 'processing'
      }),
      /choose an option/i
    );
  });
}

// ============================================================
section('[db-5] Stock restoration is idempotent');
// ============================================================
{
  test('restoreOrderStock returns stock exactly once, however many times it is called', async () => {
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 10 });

    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 3 }],
      shippingAddressId: addressId, paymentMethod: 'razorpay', initialStatus: 'pending'
    });
    created.orders.push(order.id);
    assert.strictEqual(await stockOf(productId), 7);

    const first = await restoreOrderStock(order.id, 'cancelled', 'test');
    assert.strictEqual(first.restored, true);
    assert.strictEqual(await stockOf(productId), 10);

    // The webhook, an admin and the sweep can all fire on the same order.
    const second = await restoreOrderStock(order.id, 'payment_failed', 'test-again');
    assert.strictEqual(second.restored, false);
    assert.strictEqual(second.reason, 'already_restored');
    assert.strictEqual(await stockOf(productId), 10, 'stock must not be handed back twice');
  });

  test('three concurrent restores of the same order still return the stock only once', async () => {
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 10 });
    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 4 }],
      shippingAddressId: addressId, paymentMethod: 'razorpay', initialStatus: 'pending'
    });
    created.orders.push(order.id);

    const outcomes = await Promise.all([
      restoreOrderStock(order.id, 'cancelled', 'race-1').catch(() => ({ restored: false })),
      restoreOrderStock(order.id, 'payment_failed', 'race-2').catch(() => ({ restored: false })),
      restoreOrderStock(order.id, 'cancelled', 'race-3').catch(() => ({ restored: false }))
    ]);
    assert.strictEqual(outcomes.filter((o) => o.restored).length, 1,
      'exactly one concurrent restore should win');
    assert.strictEqual(await stockOf(productId), 10);
  });
}

// ============================================================
section('[db-6] Database-level constraints refuse bad data');
// ============================================================
{
  test('stock can never go negative, even by direct SQL', async () => {
    const productId = await makeProduct({ stock: 1 });
    await assert.rejects(
      () => db.query('UPDATE products SET stock_qty = -1 WHERE id = $1', [productId]),
      (err) => err.code === '23514'
    );
  });

  test('a line total that disagrees with unit price times quantity is refused', async () => {
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 5 });
    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 1 }],
      shippingAddressId: addressId, paymentMethod: 'cod', initialStatus: 'processing'
    });
    created.orders.push(order.id);

    await assert.rejects(
      () => db.query(
        `INSERT INTO order_items (order_id, product_id, product_name_snapshot, unit_price_paise, quantity, line_total_paise)
         VALUES ($1,$2,'X',10000,2,1)`,
        [order.id, productId]
      ),
      (err) => err.code === '23514'
    );
  });

  test('a discount larger than the subtotal is refused', async () => {
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 5 });
    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 1 }],
      shippingAddressId: addressId, paymentMethod: 'cod', initialStatus: 'processing'
    });
    created.orders.push(order.id);

    await assert.rejects(
      () => db.query('UPDATE orders SET discount_paise = subtotal_paise + 1 WHERE id = $1', [order.id]),
      (err) => err.code === '23514'
    );
  });

  test('OPS-03: the audit log is append-only — it cannot be edited or deleted', async () => {
    const { rows } = await db.query(
      `INSERT INTO admin_audit_log (action, entity_type, detail) VALUES ('test_append_only','test','{}') RETURNING id`
    );
    const id = rows[0].id;
    await assert.rejects(
      () => db.query(`UPDATE admin_audit_log SET action = 'tampered' WHERE id = $1`, [id]),
      /append-only/
    );
    await assert.rejects(
      () => db.query('DELETE FROM admin_audit_log WHERE id = $1', [id]),
      /append-only/
    );
  });

  test('BIZ-02: a slot cannot be booked beyond its capacity, even by direct SQL', async () => {
    const { rows: pr } = await db.query(
      `INSERT INTO practitioners (full_name, practitioner_type) VALUES ('Test Pandit','puja') RETURNING id`
    );
    created.practitioners.push(pr[0].id);
    const { rows: sr } = await db.query(
      `INSERT INTO availability_slots (practitioner_id, service_type, starts_at, capacity, booked_count)
       VALUES ($1,'puja', now() + interval '2 days', 2, 2) RETURNING id`,
      [pr[0].id]
    );
    created.slots.push(sr[0].id);

    await assert.rejects(
      () => db.query('UPDATE availability_slots SET booked_count = 3 WHERE id = $1', [sr[0].id]),
      (err) => err.code === '23514'
    );
  });
}

// ============================================================
section('[db-7] PAY-02 — refund ledger arithmetic');
// ============================================================
{
  test('partial refunds compose against the remaining balance rather than the total', async () => {
    const { refundedTotalPaise } = require('../src/utils/refunds');
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 5, price: 100000 });
    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 1 }],
      shippingAddressId: addressId, paymentMethod: 'razorpay', initialStatus: 'pending'
    });
    created.orders.push(order.id);

    await db.query(
      `INSERT INTO refunds (entity_type, entity_id, razorpay_payment_id, amount_paise, status, idempotency_key)
       VALUES ('order',$1,'pay_test',30000,'processed',$2)`,
      [order.id, uniq('idem')]
    );
    await db.query(
      `INSERT INTO refunds (entity_type, entity_id, razorpay_payment_id, amount_paise, status, idempotency_key)
       VALUES ('order',$1,'pay_test',20000,'processed',$2)`,
      [order.id, uniq('idem')]
    );

    const total = await db.withTransaction((client) => refundedTotalPaise(client, 'order', order.id));
    assert.strictEqual(total, 50000, 'two partial refunds must sum');
  });

  test("an 'initiated' refund counts towards the balance, so a crash cannot be followed by a duplicate", async () => {
    const { refundedTotalPaise } = require('../src/utils/refunds');
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 5, price: 100000 });
    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 1 }],
      shippingAddressId: addressId, paymentMethod: 'razorpay', initialStatus: 'pending'
    });
    created.orders.push(order.id);

    // Simulates the crash window: intent committed, gateway outcome unknown.
    await db.query(
      `INSERT INTO refunds (entity_type, entity_id, razorpay_payment_id, amount_paise, status, idempotency_key)
       VALUES ('order',$1,'pay_test',100000,'initiated',$2)`,
      [order.id, uniq('idem')]
    );

    const total = await db.withTransaction((client) => refundedTotalPaise(client, 'order', order.id));
    assert.strictEqual(total, 100000,
      'an in-flight refund must be counted — otherwise the next admin computes a full remaining balance and refunds twice');
  });

  test('a failed refund does NOT count against the balance, so it can be retried', async () => {
    const { refundedTotalPaise } = require('../src/utils/refunds');
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 5, price: 100000 });
    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 1 }],
      shippingAddressId: addressId, paymentMethod: 'razorpay', initialStatus: 'pending'
    });
    created.orders.push(order.id);

    await db.query(
      `INSERT INTO refunds (entity_type, entity_id, razorpay_payment_id, amount_paise, status, idempotency_key, failure_reason)
       VALUES ('order',$1,'pay_test',100000,'failed',$2,'gateway rejected')`,
      [order.id, uniq('idem')]
    );

    const total = await db.withTransaction((client) => refundedTotalPaise(client, 'order', order.id));
    assert.strictEqual(total, 0);
  });
}

// ============================================================
section('[db-8] Refunds actually return inventory — the ordering bug');
// ============================================================
{
  const crypto2 = require('crypto');
  const razorpay = require('../src/config/razorpay');
  const { issueRefund } = require('../src/utils/refunds');

  // Stub the gateway. These tests are about what the DATABASE ends up holding,
  // not about Razorpay; a network call here would make them slow and flaky.
  function stubGateway() {
    razorpay._setClientForTests({
      payments: {
        refund: async (paymentId, params) => ({
          id: 'rfnd_' + crypto2.randomBytes(5).toString('hex'),
          amount: params.amount
        })
      }
    });
  }

  test('THE FINDING: a FULL refund returns the units to sellable stock', async () => {
    // This regressed once and would have lost inventory permanently, silently.
    // issueRefund committed status='refunded' and THEN called restoreOrderStock,
    // whose own idempotency guard treats 'refunded' as "already restored" — so it
    // no-opped. No error, no log, no audit row, units gone.
    stubGateway();
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 10, price: 100000 });

    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 3 }], shippingAddressId: addressId,
      paymentMethod: 'razorpay', initialStatus: 'pending'
    });
    created.orders.push(order.id);
    await db.query("UPDATE orders SET status='paid', razorpay_payment_id='pay_test' WHERE id=$1", [order.id]);
    assert.strictEqual(await stockOf(productId), 7);

    await issueRefund({
      entityType: 'order', entityId: order.id, razorpayPaymentId: 'pay_test',
      capturedTotalPaise: Number(order.total), requestedAmountPaise: null,
      adminUserId: null, restock: true, reason: 'integration_test'
    });

    assert.strictEqual(await stockOf(productId), 10, 'a full refund must return every unit to stock');

    const { rows: audit } = await db.query(
      "SELECT action FROM admin_audit_log WHERE entity_id = $1", [order.id]
    );
    const actions = audit.map((a) => a.action);
    assert.ok(actions.includes('stock_released'), 'the stock release must be audit-logged');
    assert.ok(actions.includes('refund_issued'), 'the refund must be audit-logged');
  });

  test('a PARTIAL refund leaves stock alone — it must not invent returned units', async () => {
    stubGateway();
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 10, price: 100000 });

    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 2 }], shippingAddressId: addressId,
      paymentMethod: 'razorpay', initialStatus: 'pending'
    });
    created.orders.push(order.id);
    await db.query("UPDATE orders SET status='paid', razorpay_payment_id='pay_test2' WHERE id=$1", [order.id]);
    const before = await stockOf(productId);

    await issueRefund({
      entityType: 'order', entityId: order.id, razorpayPaymentId: 'pay_test2',
      capturedTotalPaise: Number(order.total), requestedAmountPaise: 1000,
      adminUserId: null, restock: true, reason: 'partial'
    });

    assert.strictEqual(await stockOf(productId), before,
      'a partial refund is one item out of several — restoring the whole order would invent units');
    const { rows } = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.strictEqual(rows[0].status, 'partially_refunded');
  });

  test('refunding a booking frees the practitioner\'s seat', async () => {
    stubGateway();
    const userId = await makeUser();
    const { rows: [svc] } = await db.query(
      "INSERT INTO booking_services (service_type,name,price_paise) VALUES ('puja',$1,210000) RETURNING id",
      [uniq('svc')]
    );
    const { rows: [pr] } = await db.query(
      "INSERT INTO practitioners (full_name,practitioner_type) VALUES ('Test Pandit','puja') RETURNING id"
    );
    created.practitioners.push(pr.id);
    const { rows: [slot] } = await db.query(
      `INSERT INTO availability_slots (practitioner_id,service_type,service_id,starts_at,capacity,booked_count)
       VALUES ($1,'puja',$2, now() + interval '3 days', 2, 1) RETURNING id`,
      [pr.id, svc.id]
    );
    created.slots.push(slot.id);
    const { rows: [bk] } = await db.query(
      `INSERT INTO puja_bookings (user_id,service_id,slot_id,puja_type,preferred_date,preferred_time_slot,
                                  contact_name,contact_phone,amount_paise,payment_status,razorpay_payment_id)
       VALUES ($1,$2,$3,'P', CURRENT_DATE + 3,'AM','T','9876543210',210000,'paid','pay_bk') RETURNING id`,
      [userId, svc.id, slot.id]
    );

    await issueRefund({
      entityType: 'puja_booking', entityId: bk.id, razorpayPaymentId: 'pay_bk',
      capturedTotalPaise: 210000, requestedAmountPaise: null,
      adminUserId: null, restock: true, reason: 'integration_test'
    });

    const { rows } = await db.query('SELECT booked_count FROM availability_slots WHERE id = $1', [slot.id]);
    assert.strictEqual(Number(rows[0].booked_count), 0,
      'a refunded booking must give its seat back — otherwise the practitioner\'s day looks full forever');
  });

  test('rejecting a payment review returns the reserved stock', async () => {
    const { restoreOrderStockInTransaction } = require('../src/utils/stock');
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 5 });

    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 2 }], shippingAddressId: addressId,
      paymentMethod: 'razorpay', initialStatus: 'pending'
    });
    created.orders.push(order.id);
    await db.query("UPDATE orders SET status='payment_review' WHERE id=$1", [order.id]);
    assert.strictEqual(await stockOf(productId), 3);

    // Exactly what the route does: restore inside the transaction, then set status.
    await db.withTransaction(async (client) => {
      await restoreOrderStockInTransaction(client, order.id, 'payment_review_rejected', null, 'payment_review');
      await client.query("UPDATE orders SET status='payment_failed' WHERE id=$1", [order.id]);
    });

    assert.strictEqual(await stockOf(productId), 5,
      'rejecting a review means the money never arrived, so the units must go back');
  });
}

// ============================================================
section('[db-9] Stock can never be restored twice — the phantom-inventory guard');
// ============================================================
{
  const crypto3 = require('crypto');
  const razorpay = require('../src/config/razorpay');
  const { issueRefund } = require('../src/utils/refunds');
  const { restoreOrderStock } = require('../src/utils/stock');

  test('THE FINDING: cancelling an order and THEN refunding it must not invent stock', async () => {
    // restoreOrderStockInTransaction() has no idempotency guard by design — the
    // caller owns the status transition. That put the burden on every caller,
    // and the refund route originally gated only on "has a payment id", which a
    // cancelled or review-rejected order still does. The result was stock
    // returned twice: phantom units the shop would then oversell.
    razorpay._setClientForTests({
      payments: { refund: async (pid, p) => ({ id: 'rfnd_' + crypto3.randomBytes(4).toString('hex'), amount: p.amount }) }
    });

    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const productId = await makeProduct({ stock: 10, price: 100000 });

    const order = await reserveStockAndCreateOrder({
      userId, items: [{ productId, quantity: 3 }], shippingAddressId: addressId,
      paymentMethod: 'razorpay', initialStatus: 'pending'
    });
    created.orders.push(order.id);
    await db.query("UPDATE orders SET status='paid', razorpay_payment_id='pay_dbl' WHERE id=$1", [order.id]);
    assert.strictEqual(await stockOf(productId), 7);

    // First restore: an admin cancels. Stock legitimately comes back.
    await restoreOrderStock(order.id, 'cancelled', 'admin_cancel', null);
    assert.strictEqual(await stockOf(productId), 10);

    // Second attempt: refund the same order. Must be refused, not restocked.
    await assert.rejects(
      () => issueRefund({
        entityType: 'order', entityId: order.id, razorpayPaymentId: 'pay_dbl',
        capturedTotalPaise: Number(order.total), requestedAmountPaise: null,
        adminUserId: null, restock: true, reason: 'second_attempt'
      }),
      (err) => err.status === 409 && /already|cannot be refunded again/i.test(err.message)
    );

    assert.strictEqual(await stockOf(productId), 10,
      'stock must stay at 10 — a second restore would invent 3 units the shop does not have');
  });

  test('the same guard protects bookings whose slot was already released', async () => {
    razorpay._setClientForTests({
      payments: { refund: async (pid, p) => ({ id: 'rfnd_' + crypto3.randomBytes(4).toString('hex'), amount: p.amount }) }
    });
    const userId = await makeUser();
    const { rows: [svc] } = await db.query(
      "INSERT INTO booking_services (service_type,name,price_paise) VALUES ('puja',$1,210000) RETURNING id", [uniq('svc')]
    );
    const { rows: [pr] } = await db.query(
      "INSERT INTO practitioners (full_name,practitioner_type) VALUES ('P','puja') RETURNING id"
    );
    created.practitioners.push(pr.id);
    const { rows: [slot] } = await db.query(
      `INSERT INTO availability_slots (practitioner_id,service_type,service_id,starts_at,capacity,booked_count)
       VALUES ($1,'puja',$2, now() + interval '3 days', 2, 1) RETURNING id`, [pr.id, svc.id]
    );
    created.slots.push(slot.id);
    const { rows: [bk] } = await db.query(
      `INSERT INTO puja_bookings (user_id,service_id,slot_id,puja_type,preferred_date,preferred_time_slot,
                                  contact_name,contact_phone,amount_paise,payment_status,razorpay_payment_id)
       VALUES ($1,$2,$3,'P', CURRENT_DATE + 3,'AM','T','9876543210',210000,'failed','pay_bk2') RETURNING id`,
      [userId, svc.id, slot.id]
    );

    await assert.rejects(
      () => issueRefund({
        entityType: 'puja_booking', entityId: bk.id, razorpayPaymentId: 'pay_bk2',
        capturedTotalPaise: 210000, requestedAmountPaise: null,
        adminUserId: null, restock: true, reason: 'second_attempt'
      }),
      (err) => err.status === 409
    );

    const { rows } = await db.query('SELECT booked_count FROM availability_slots WHERE id = $1', [slot.id]);
    assert.strictEqual(Number(rows[0].booked_count), 1, 'the seat count must be untouched by a refused refund');
  });
}

// ============================================================
section('[db-10] The marketing kill switch actually stops marketing');
// ============================================================
// Migration 015 seeded email_marketing_enabled and documented it as the switch
// that decides whether campaigns go out. Nothing read it: an admin could turn
// marketing off, watch the save succeed, and every campaign kept sending.
//
// Neither test below can reach SMTP — both assert on a send that returns before
// the transporter is ever constructed. That is deliberate: a test suite must not
// be one refactor away from mailing real people.
{
  const { sendMail, CATEGORY } = require('../src/utils/email/engine');

  async function setMarketingEnabled(value) {
    await db.query(
      `INSERT INTO site_settings (key, value) VALUES ('email_marketing_enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [value]
    );
  }

  test('THE FINDING: the switch overrides consent — a fully opted-in subscriber is still not mailed', async () => {
    const recipient = `killswitch-${Date.now()}@example.invalid`;
    // Real, confirmed consent, so the ONLY thing that can stop this send is the
    // switch under test. Without this the test would pass for the wrong reason.
    await db.query(
      `INSERT INTO email_subscriptions (email, status, confirmed_at)
       VALUES ($1, 'confirmed', now())`,
      [recipient]
    );
    try {
      await setMarketingEnabled('false');
      const r = await sendMail({
        to: recipient,
        subject: 'Campaign that must not go out',
        html: '<p>hi</p>',
        template: 'test_marketing_killswitch',
        category: CATEGORY.MARKETING
      });
      assert.strictEqual(r.sent, false, 'a marketing email was sent with the kill switch off');
      assert.strictEqual(r.reason, 'marketing_disabled');

      const { rows } = await db.query(
        'SELECT status FROM email_log WHERE recipient = $1', [recipient]
      );
      assert.strictEqual(rows[0].status, 'skipped_marketing_disabled',
        'the skip was not recorded as a kill-switch skip, so nobody could tell why the campaign stopped');
    } finally {
      await setMarketingEnabled('true');
      await db.query('DELETE FROM email_log WHERE recipient = $1', [recipient]);
      await db.query('DELETE FROM email_subscriptions WHERE email = $1', [recipient]);
    }
  });

  test("'0' means off in the mail engine too — the settings API and the engine cannot disagree", async () => {
    const { setSetting } = require('../src/utils/settings');
    const recipient = `zero-${Date.now()}@example.invalid`;
    await db.query(
      `INSERT INTO email_subscriptions (email, status, confirmed_at)
       VALUES ($1, 'confirmed', now())`,
      [recipient]
    );
    try {
      // setSetting accepts '0' as boolean false. Stored verbatim, engine.js's
      // `value !== 'false'` test reads "0" as ON — so the settings screen would
      // report marketing disabled while campaigns kept going out.
      await setSetting('email_marketing_enabled', '0', null);
      const r = await sendMail({
        to: recipient,
        subject: 'Campaign that must not go out',
        html: '<p>hi</p>',
        template: 'test_marketing_zero',
        category: CATEGORY.MARKETING
      });
      assert.strictEqual(r.reason, 'marketing_disabled',
        "the switch set to '0' disabled marketing in the settings API but not in the mail engine");
    } finally {
      await setMarketingEnabled('true');
      await db.query('DELETE FROM email_log WHERE recipient = $1', [recipient]);
      await db.query('DELETE FROM email_subscriptions WHERE email = $1', [recipient]);
    }
  });

  test('with the switch back ON the normal consent check is reached, so the switch is not simply always blocking', async () => {
    const recipient = `noconsent-${Date.now()}@example.invalid`;
    try {
      await setMarketingEnabled('true');
      const r = await sendMail({
        to: recipient,
        subject: 'Campaign to a stranger',
        html: '<p>hi</p>',
        template: 'test_marketing_killswitch',
        category: CATEGORY.MARKETING
      });
      assert.strictEqual(r.sent, false);
      assert.strictEqual(r.reason, 'no_consent');
    } finally {
      await db.query('DELETE FROM email_log WHERE recipient = $1', [recipient]);
    }
  });

  // There is deliberately NO test here that a transactional email survives the
  // switch. Proving that requires letting sendMail run past the marketing gates,
  // and the next thing it does is hand the message to a configured SMTP
  // transporter — which on a developer machine with real SMTP_* values means the
  // suite mails somebody. The guard that matters is visible in engine.js instead:
  // both marketing checks are conditioned on `cat === CATEGORY.MARKETING`.
}

// ============================================================
section('[db-11] A failed send releases its claim instead of losing the customer');
// ============================================================
// THE FINDING: runBackInStock claims rows by setting notified_at BEFORE it
// attempts the send — correct, because it is what stops two concurrent runs
// mailing the same person twice. But the claim was never released when the send
// failed. The admin console then showed the notification delivered, the cron
// exited 0, and a customer who had explicitly asked to be told about a product
// was never told and never retried.
//
// This forces a REAL send failure by pointing SMTP at a closed port. Mocking
// sendMail would prove nothing here: the thing under test is the SQL that puts
// notified_at back.
{
  const { resetTransporter } = require('../src/utils/email/engine');
  const { runBackInStock } = require('../scripts/send-scheduled-emails');

  async function withDeadSmtp(fn) {
    const prevHost = process.env.SMTP_HOST;
    const prevPort = process.env.SMTP_PORT;
    // Port 1 on loopback refuses instantly. A bogus hostname would instead wait
    // out the 10s connection timeout and make this suite crawl.
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1';
    resetTransporter();
    try {
      return await fn();
    } finally {
      if (prevHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = prevHost;
      if (prevPort === undefined) delete process.env.SMTP_PORT; else process.env.SMTP_PORT = prevPort;
      resetTransporter();
    }
  }

  test('THE FINDING: a back-in-stock send that fails leaves notified_at NULL, so the next run retries it', async () => {
    const productId = await makeProduct({ stock: 5 });
    const email = `retry-${Date.now()}@example.invalid`;
    const { rows: ins } = await db.query(
      'INSERT INTO stock_notifications (product_id, email) VALUES ($1, $2) RETURNING id',
      [productId, email]
    );
    const id = ins[0].id;

    try {
      const result = await withDeadSmtp(() => runBackInStock());

      assert.ok(result.failed >= 1,
        'the job did not count the failed send, so its exit code would still report success');

      const { rows } = await db.query('SELECT notified_at FROM stock_notifications WHERE id = $1', [id]);
      assert.strictEqual(rows[0].notified_at, null,
        'notified_at stayed set after the send failed — this customer would be marked notified forever and never actually told');
    } finally {
      await db.query('DELETE FROM stock_notifications WHERE id = $1', [id]);
      await db.query('DELETE FROM email_log WHERE recipient = $1', [email]);
    }
  });

  test('the failure is recorded in email_log, so it can be diagnosed after the fact', async () => {
    const productId = await makeProduct({ stock: 5 });
    const email = `logged-${Date.now()}@example.invalid`;
    const { rows: ins } = await db.query(
      'INSERT INTO stock_notifications (product_id, email) VALUES ($1, $2) RETURNING id',
      [productId, email]
    );
    try {
      await withDeadSmtp(() => runBackInStock());
      const { rows } = await db.query(
        'SELECT status, error FROM email_log WHERE recipient = $1 ORDER BY created_at DESC LIMIT 1',
        [email]
      );
      assert.strictEqual(rows.length, 1, 'the failed send left no trace in email_log');
      assert.strictEqual(rows[0].status, 'failed');
      assert.ok(rows[0].error, 'the SMTP error was not recorded, so `npm run email:log --failed` would show no reason');
    } finally {
      await db.query('DELETE FROM stock_notifications WHERE id = $1', [ins[0].id]);
      await db.query('DELETE FROM email_log WHERE recipient = $1', [email]);
    }
  });
}

// ============================================================
section('[db-12] "Most sold" must count money that was actually taken');
// ============================================================
// The category ranking behind the storefront's top-15 list summed
// order_items.quantity across a LEFT JOIN whose status filter sat in the ON
// clause. The filter was in the right place — a WHERE would have dropped every
// category that has never sold — but the SUM was not conditioned on it, so the
// order_items row survived when the orders row did not. A pending, cancelled,
// refunded or payment_failed order therefore counted exactly as much toward
// "most sold" as a delivered one.
{
  /* The real query, IMPORTED from the route so this tests exactly what ships.

     This used to slice the SQL out of the file as text, between the first two
     backticks. That worked until the query gained an interpolation: the slice
     then handed Postgres a literal `${...}` and every check here failed with
     "syntax error at or near $" — while the route was entirely correct. A test
     that re-derives what it is testing will eventually test something else. */
  const TOP_CATEGORIES_SQL = require('../src/routes/products.routes.js').TOP_CATEGORIES_SQL;
  if (typeof TOP_CATEGORIES_SQL !== 'string' || !TOP_CATEGORIES_SQL.includes('SELECT p.category')) {
    throw new Error('products.routes.js no longer exports TOP_CATEGORIES_SQL — [db-12] is testing nothing.');
  }
  if (TOP_CATEGORIES_SQL.includes('${')) {
    throw new Error('TOP_CATEGORIES_SQL carries an unresolved template interpolation.');
  }

  async function makeProductIn(category, stock = 100) {
    const { rows } = await db.query(
      `INSERT INTO products (sku, name, slug, category, price_paise, mrp_paise, stock_qty, gst_rate)
       VALUES ($1,$2,$3,$4,10000,10000,$5,3) RETURNING id`,
      [uniq('SKU'), 'Rank Test', uniq('rank-product'), category, stock]
    );
    created.products.push(rows[0].id);
    return rows[0].id;
  }

  async function makeOrderWith(userId, addressId, productId, quantity, status) {
    const { rows } = await db.query(
      `INSERT INTO orders (order_number, user_id, shipping_address_id, status, payment_method,
                           subtotal_paise, gst_paise, shipping_paise, discount_paise, total_paise)
       VALUES ($1,$2,$3,$4,'razorpay',10000,0,0,0,10000) RETURNING id`,
      // order_number is VARCHAR(30) UNIQUE NOT NULL; uniq() keeps it short and
      // collision-free across a parallel run.
      [uniq('T'), userId, addressId, status]
    );
    created.orders.push(rows[0].id);
    await db.query(
      `INSERT INTO order_items (order_id, product_id, product_name_snapshot, quantity,
                                unit_price_paise, line_total_paise)
       VALUES ($1,$2,'Rank Test',$3,10000,$4)`,
      [rows[0].id, productId, quantity, 10000 * quantity]
    );
    return rows[0].id;
  }

  async function unitsFor(category) {
    const { rows } = await db.query(TOP_CATEGORIES_SQL, [20]);
    const hit = rows.find(r => r.category === category);
    return hit ? hit.units_sold : null;
  }

  test('THE FINDING: an unpaid order contributes nothing to the ranking', async () => {
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const cat = uniq('rankcat');
    const productId = await makeProductIn(cat);

    // One genuine sale.
    await makeOrderWith(userId, addressId, productId, 2, 'delivered');
    assert.strictEqual(await unitsFor(cat), 2, 'a delivered order must count');

    // Everything that is not money in the bank.
    for (const status of ['pending', 'cancelled', 'refunded', 'payment_failed']) {
      await makeOrderWith(userId, addressId, productId, 50, status);
    }
    const after = await unitsFor(cat);
    assert.strictEqual(after, 2,
      `200 units across pending/cancelled/refunded/payment_failed inflated the count to ${after}`);
  });

  test('every status that IS money still counts', async () => {
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const cat = uniq('rankcat');
    const productId = await makeProductIn(cat);

    // partially_refunded counts: part of that sale was kept.
    const counted = ['paid', 'processing', 'shipped', 'delivered', 'partially_refunded'];
    for (const status of counted) await makeOrderWith(userId, addressId, productId, 3, status);

    assert.strictEqual(await unitsFor(cat), counted.length * 3,
      'a status that represents taken money must not be dropped');
  });

  test('a category that has never sold is still listed, at zero', async () => {
    // This is why the filter belongs in the JOIN. Moving it to a WHERE would
    // make the list silently omit every new category until its first sale.
    const cat = uniq('rankcat');
    await makeProductIn(cat);
    assert.strictEqual(await unitsFor(cat), 0,
      'it must appear with 0, not vanish and not come back NULL');
  });

  test('the order is TOTAL, so "top 15" is the same 15 every time', async () => {
    // Equal units and equal product counts must still have a defined order, or
    // the list reshuffles between page loads for no visible reason.
    const userId = await makeUser();
    const addressId = await makeAddress(userId);
    const a = 'zz-' + uniq('rank');
    const b = 'aa-' + uniq('rank');
    const pa = await makeProductIn(a);
    const pb = await makeProductIn(b);
    await makeOrderWith(userId, addressId, pa, 5, 'delivered');
    await makeOrderWith(userId, addressId, pb, 5, 'delivered');

    const seen = [];
    for (let i = 0; i < 3; i++) {
      const { rows } = await db.query(TOP_CATEGORIES_SQL, [20]);
      seen.push(rows.filter(r => r.category === a || r.category === b).map(r => r.category).join(','));
    }
    assert.strictEqual(new Set(seen).size, 1, 'the same query returned different orders: ' + seen.join(' | '));
    assert.ok(seen[0].startsWith(b), 'equal rows must break the tie alphabetically, so "' + b + '" comes first');
  });
}

// ============================================================
// Runner + cleanup
// ============================================================
/* Is this the database going away, rather than a test failing?

   The distinction matters more than it looks. When the connection drops
   mid-run, EVERY remaining test throws the same transport error, and the suite
   used to report each one as a failure — one dropped connection was read as a
   dozen broken behaviours, with the real cause buried in the first line of a
   long log. That is a suite that lies about what it found, and the cost is
   somebody hunting a bug that was never there.

   Matching on codes first and message text only as a fallback: node and pg
   report these inconsistently, but an assertion error carries neither. */
const TRANSPORT_CODES = new Set([
  'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ECONNABORTED',
  '57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004'
]);
const TRANSPORT_TEXT = /connection terminated|connection ended|client has encountered a connection error|terminating connection|server closed the connection|connection refused|getaddrinfo|socket hang up|timeout exceeded when trying to connect/i;

function isDatabaseGone(err) {
  if (!err) return false;
  // An assertion failure is never a transport failure, whatever it says.
  if (err.name === 'AssertionError' || err.code === 'ERR_ASSERTION') return false;
  if (err.code && TRANSPORT_CODES.has(String(err.code))) return true;
  return TRANSPORT_TEXT.test(String(err.message || ''));
}

(async () => {
  let passed = 0; let failed = 0; let aborted = null;
  for (const item of queue) {
    if (item.type === 'section') { console.log('\n' + item.name); continue; }
    try {
      await item.fn();
      console.log('  PASS -', item.name);
      passed++;
    } catch (e) {
      if (isDatabaseGone(e)) {
        // Stop here. Every remaining test would throw the same transport error
        // and report it as if the code were at fault.
        aborted = { at: item.name, err: e };
        break;
      }
      console.log('  FAIL -', item.name, '\n        ', e.message);
      failed++;
    }
  }

  if (aborted) {
    console.log('\n' + '='.repeat(72));
    console.log('  THE DATABASE CONNECTION WENT AWAY. THIS IS NOT A CODE FAILURE.');
    console.log('='.repeat(72));
    console.log('  Lost during: ' + aborted.at);
    console.log('  Reason:      ' + (aborted.err.code ? aborted.err.code + ' — ' : '') + aborted.err.message);
    console.log('');
    console.log('  ' + passed + ' test(s) passed before the connection dropped; the rest never ran.');
    console.log('  Nothing here says anything about the code under test.');
    console.log('');
    console.log('  Neon free-tier computes suspend when idle and the pooler endpoint can');
    console.log('  briefly stop resolving. Re-run the suite:');
    console.log('');
    console.log('      npm run test:db-integration');
    console.log('');
    console.log('  The run is still marked FAILED, because a gate that has not actually');
    console.log('  verified anything must never report green.');
    console.log('='.repeat(72));
  }

  // Clean up in FK order. Best-effort: a cleanup failure must not turn a green
  // run red, but it is reported so a leaking test is visible.
  try {
    if (created.orders.length) {
      await db.query('DELETE FROM order_items WHERE order_id = ANY($1)', [created.orders]);
      await db.query('DELETE FROM refunds WHERE entity_id = ANY($1)', [created.orders]);
      await db.query('DELETE FROM orders WHERE id = ANY($1)', [created.orders]);
    }
    // Bookings reference slots, so clear the reference before deleting the slot.
    if (created.slots.length) {
      await db.query('DELETE FROM puja_bookings WHERE slot_id = ANY($1)', [created.slots]);
      await db.query('DELETE FROM astrology_bookings WHERE slot_id = ANY($1)', [created.slots]);
      await db.query('DELETE FROM availability_slots WHERE id = ANY($1)', [created.slots]);
    }
    if (created.practitioners.length) await db.query('DELETE FROM practitioners WHERE id = ANY($1)', [created.practitioners]);
    if (created.products.length) {
      await db.query('DELETE FROM product_variants WHERE product_id = ANY($1)', [created.products]);
      await db.query('DELETE FROM products WHERE id = ANY($1)', [created.products]);
    }
    if (created.users.length) {
      await db.query('DELETE FROM addresses WHERE user_id = ANY($1)', [created.users]);
      await db.query('DELETE FROM users WHERE id = ANY($1)', [created.users]);
    }
  } catch (err) {
    console.warn('  (cleanup warning:', err.message, ')');
  }

  console.log(`\n${passed} passed, ${failed} failed${aborted ? ', RUN ABORTED (database unreachable)' : ''}\n`);
  await db.pool.end().catch(() => {});
  // An abort exits non-zero even with no failed assertion: the gate verified
  // less than it was asked to, and that must never read as success.
  process.exit(failed || aborted ? 1 : 0);
})();
