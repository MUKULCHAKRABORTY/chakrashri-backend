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
 * SKIPS CLEANLY when no test database is configured, so `npm run verify` on a
 * laptop with no Postgres still passes. CI provides one (see .github/workflows).
 *
 * SAFETY: refuses to run against anything that does not look like a throwaway
 * test database. These tests create and delete rows; pointing them at
 * production would be destructive, so the guard is deliberately paranoid.
 *
 * Run: DATABASE_URL=postgres://... node test/db-integration.test.js
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

const DATABASE_URL = process.env.DATABASE_URL || '';

if (!DATABASE_URL) {
  console.log('\n[db-integration] No DATABASE_URL set — skipping database integration tests.');
  console.log('                 CI runs these against a Postgres service container.\n');
  process.exit(0);
}

// --- Guard rail -------------------------------------------------------------
// These tests write and delete. Refuse anything that is not obviously a test
// database. A false negative here costs a config tweak; a false positive costs
// production data.
const looksLikeTestDb = /test|localhost|127\.0\.0\.1|ci/i.test(DATABASE_URL);
if (!looksLikeTestDb) {
  console.error('\n[db-integration] REFUSING TO RUN.');
  console.error('  DATABASE_URL does not look like a disposable test database.');
  console.error('  These tests create and delete rows. Point them at a throwaway database');
  console.error('  whose URL contains "test", "ci" or "localhost".\n');
  process.exit(1);
}

const db = require('../src/config/db');
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
  test('migrations 013 and 014 have been applied', async () => {
    const { rows } = await db.query('SELECT filename FROM _migrations ORDER BY filename');
    const applied = rows.map((r) => r.filename);
    assert.ok(applied.some((f) => f.startsWith('013_')), 'migration 013 has not been applied');
    assert.ok(applied.some((f) => f.startsWith('014_')), 'migration 014 has not been applied');
  });

  test('the new tables exist', async () => {
    for (const table of ['refunds', 'practitioners', 'availability_slots', 'email_verification_tokens']) {
      const { rows } = await db.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
      assert.ok(rows[0].reg, `table ${table} is missing`);
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
// Runner + cleanup
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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await db.pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})();
