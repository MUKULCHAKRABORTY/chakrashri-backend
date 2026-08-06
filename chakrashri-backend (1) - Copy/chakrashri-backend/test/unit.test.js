/**
 * Tests the REAL application modules — not reimplementations of their logic.
 * This distinction matters: an earlier version of this suite reimplemented
 * signature verification and cart validation as local copies, which meant a
 * genuine bug in the real create-order code (the same product listed twice
 * in one cart could pass two independent stock checks and oversell) went
 * completely undetected, because the tests were never actually exercising
 * the code that runs in production. Every test below either imports the
 * real module directly, or — for the one function that depends on a live
 * database (reserveStockAndCreateOrder) — runs the REAL function against a
 * manually mocked database client, using only Node's built-in require.cache
 * (no test framework or extra dependency needed).
 *
 * Run: node test/unit.test.js
 */
const assert = require('assert');
const path = require('path');

const queue = [];
function section(name) { queue.push({ type: 'section', name }); }
function test(name, fn) { queue.push({ type: 'test', name, fn }); }

// ============================================================
// [1] Real signature verification: src/utils/crypto.js
// ============================================================
section('[1] timingSafeEqualHex — the REAL comparison used by /verify and /webhook');
{
  const crypto = require('crypto');
  const { timingSafeEqualHex } = require('../src/utils/crypto');

  const secret = 'test_secret_key';
  const orderId = 'order_ABC123';
  const paymentId = 'pay_XYZ789';
  const validSig = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const otherSig = crypto.createHmac('sha256', secret).update(`order_DIFFERENT|${paymentId}`).digest('hex');

  test('accepts a genuine signature', () => {
    assert.strictEqual(timingSafeEqualHex(validSig, validSig), true);
  });
  test('rejects a tampered signature', () => {
    assert.strictEqual(timingSafeEqualHex(validSig, 'deadbeef' + validSig.slice(8)), false);
  });
  test('rejects a signature computed for a different order id', () => {
    assert.strictEqual(timingSafeEqualHex(validSig, otherSig), false);
  });
  test('rejects empty signature without throwing', () => {
    assert.strictEqual(timingSafeEqualHex(validSig, ''), false);
  });
  test('rejects non-string input without throwing', () => {
    assert.strictEqual(timingSafeEqualHex(validSig, null), false);
    assert.strictEqual(timingSafeEqualHex(undefined, validSig), false);
  });
  test('rejects non-hex garbage without throwing', () => {
    assert.strictEqual(timingSafeEqualHex(validSig, 'not-hex-at-all-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), false);
  });
  test('an early-byte mismatch and a late-byte mismatch both correctly return false via the same code path', () => {
    // Not a rigorous timing-attack proof (that needs a controlled benchmark
    // environment) — just confirms both cases are handled by timingSafeEqual
    // itself rather than a short-circuiting comparison.
    const earlyMismatch = 'f' + validSig.slice(1);
    const lateMismatch = validSig.slice(0, -1) + (validSig.slice(-1) === 'f' ? 'e' : 'f');
    assert.strictEqual(timingSafeEqualHex(validSig, earlyMismatch), false);
    assert.strictEqual(timingSafeEqualHex(validSig, lateMismatch), false);
  });
}

// ============================================================
// [2] Real cart validation/aggregation: src/utils/orders.js
// ============================================================
section('[2] validateAndAggregateCart — the REAL function create-order and create-cod-order both call');
{
  const { validateAndAggregateCart } = require('../src/utils/orders');

  test('rejects empty cart', () => {
    assert.throws(() => validateAndAggregateCart([]), /Cart is empty/);
  });
  test('rejects negative quantity', () => {
    assert.throws(() => validateAndAggregateCart([{ productId: 'p1', quantity: -1 }]), /invalid item or quantity/);
  });
  test('rejects zero quantity', () => {
    assert.throws(() => validateAndAggregateCart([{ productId: 'p1', quantity: 0 }]), /invalid item or quantity/);
  });
  test('rejects non-integer quantity', () => {
    assert.throws(() => validateAndAggregateCart([{ productId: 'p1', quantity: 1.5 }]), /invalid item or quantity/);
  });
  test('rejects missing productId', () => {
    assert.throws(() => validateAndAggregateCart([{ quantity: 1 }]), /invalid item or quantity/);
  });
  test('accepts a normal valid cart, unchanged', () => {
    const result = validateAndAggregateCart([{ productId: 'p1', quantity: 2 }]);
    assert.deepStrictEqual(result, [{ productId: 'p1', quantity: 2 }]);
  });
  test('THE BUG: same product listed twice is aggregated into one entry with the summed quantity', () => {
    const result = validateAndAggregateCart([
      { productId: 'p1', quantity: 2 },
      { productId: 'p1', quantity: 3 }
    ]);
    assert.strictEqual(result.length, 1, 'must collapse to exactly one entry per product');
    assert.strictEqual(result[0].quantity, 5, 'quantities must be summed, not just the last one kept');
  });
  test('aggregation rejects the cart if the SUMMED quantity exceeds the per-item cap', () => {
    // 30 + 25 = 55 > 50 cap. Each individual line is under the cap, so this
    // must be caught by the post-aggregation check, not the pre-aggregation one.
    assert.throws(
      () => validateAndAggregateCart([{ productId: 'p1', quantity: 30 }, { productId: 'p1', quantity: 25 }]),
      /invalid item or quantity/
    );
  });
  test('different products are kept separate, not merged together', () => {
    const result = validateAndAggregateCart([
      { productId: 'p1', quantity: 2 },
      { productId: 'p2', quantity: 3 }
    ]);
    assert.strictEqual(result.length, 2);
  });
}

// ============================================================
// [3] Real order-totals math: src/utils/orders.js
// ============================================================
section('[3] calculateOrderTotals — the REAL money math (subtotal + shipping + GST, integer paise)');
{
  const { calculateOrderTotals } = require('../src/utils/orders');

  test('single item under free-shipping threshold gets shipping charged', () => {
    const r = calculateOrderTotals([{ lineTotalPaise: 50000, gstRate: 3 }]); // ₹500
    assert.strictEqual(r.subtotalPaise, 50000);
    assert.strictEqual(r.shippingPaise, 7900);
    assert.strictEqual(r.gstPaise, 1500);
    assert.strictEqual(r.totalPaise, 50000 + 7900 + 1500);
  });
  test('order at/above ₹999 gets free shipping', () => {
    const r = calculateOrderTotals([{ lineTotalPaise: 99900, gstRate: 3 }]);
    assert.strictEqual(r.shippingPaise, 0);
  });
  test('multiple items with different GST rates sum correctly', () => {
    const r = calculateOrderTotals([
      { lineTotalPaise: 200000, gstRate: 3 },
      { lineTotalPaise: 50000, gstRate: 5 }
    ]);
    assert.strictEqual(r.subtotalPaise, 250000);
    assert.strictEqual(r.gstPaise, 8500);
    assert.strictEqual(r.shippingPaise, 0);
  });
  test('GST rounds to nearest paise rather than accumulating float drift', () => {
    const r = calculateOrderTotals([{ lineTotalPaise: 9999, gstRate: 3 }]); // 9999 * 3% = 299.97
    assert.strictEqual(r.gstPaise, 300);
  });
}

// ============================================================
// [4] Real end-to-end reservation logic against a MOCKED database client
// ============================================================
section("[4] reserveStockAndCreateOrder — the REAL checkout function, run against a mocked DB client");
{
  // Manual module mock: inject a fake '../config/db' into require.cache
  // BEFORE requiring utils/orders.js, so requiring it never needs the real
  // 'pg' package or a live connection — this exercises the actual
  // production function end-to-end (aggregation -> stock check -> the
  // exact UPDATE statements it issues), not a stand-in for it.
  const ordersModulePath = require.resolve('../src/utils/orders.js');
  const dbConfigPath = require.resolve(path.join(path.dirname(ordersModulePath), '..', 'config', 'db.js'));

  function makeFakeDb(productsById) {
    const updateCalls = [];
    const fakeClient = {
      async query(sql, params) {
        if (sql.includes('FOR UPDATE') && sql.includes('SELECT id, name, price_paise')) {
          const ids = params[0];
          return { rows: ids.filter((id) => productsById[id]).map((id) => ({ id, ...productsById[id] })) };
        }
        if (sql.startsWith('UPDATE products SET stock_qty')) {
          const [qty, id] = params;
          updateCalls.push({ id, qty });
          if (productsById[id].stock_qty >= qty) {
            productsById[id].stock_qty -= qty;
            return { rowCount: 1 };
          }
          return { rowCount: 0 }; // matches the real WHERE stock_qty >= $1 guard
        }
        if (sql.startsWith('INSERT INTO orders')) {
          return { rows: [{ id: 'order_fake_1', order_number: 'CHK-TEST-0001' }] };
        }
        if (sql.startsWith('INSERT INTO order_items')) {
          return { rows: [] };
        }
        throw new Error('Unexpected query in mock: ' + sql);
      }
    };
    return { withTransaction: (fn) => fn(fakeClient), updateCalls };
  }

  async function withMockedDb(fakeDb, fn) {
    const originalCacheEntry = require.cache[dbConfigPath];
    require.cache[dbConfigPath] = { id: dbConfigPath, filename: dbConfigPath, loaded: true, exports: fakeDb };
    delete require.cache[ordersModulePath]; // force orders.js to re-require and pick up the mock
    try {
      const orders = require('../src/utils/orders');
      return await fn(orders);
    } finally {
      delete require.cache[ordersModulePath];
      if (originalCacheEntry) require.cache[dbConfigPath] = originalCacheEntry;
      else delete require.cache[dbConfigPath];
    }
  }

  test('THE BUG, end-to-end: duplicate product in cart issues exactly ONE stock check for the summed quantity, and correctly rejects an oversell instead of allowing it', async () => {
    const products = { p1: { name: 'Rudraksha Mala', price_paise: 50000, stock_qty: 3, gst_rate: 3 } };
    const fakeDb = makeFakeDb(products);
    let threw = false;
    try {
      await withMockedDb(fakeDb, (orders) =>
        orders.reserveStockAndCreateOrder({
          userId: 'u1',
          items: [{ productId: 'p1', quantity: 2 }, { productId: 'p1', quantity: 2 }], // 2+2=4 requested, only 3 in stock
          shippingAddressId: null,
          paymentMethod: 'cod',
          initialStatus: 'processing'
        })
      );
    } catch (err) {
      threw = true;
      assert.match(err.message, /only has 3 left in stock/);
    }
    assert.strictEqual(threw, true, 'must reject an oversell attempt instead of silently succeeding');
    assert.strictEqual(fakeDb.updateCalls.length, 0, 'no stock should be touched when the aggregated request exceeds availability');
  });

  test('a duplicate cart entry that DOES fit in stock succeeds with exactly one decrement for the combined quantity', async () => {
    const products = { p1: { name: 'Rudraksha Mala', price_paise: 50000, stock_qty: 10, gst_rate: 3 } };
    const fakeDb = makeFakeDb(products);
    const result = await withMockedDb(fakeDb, (orders) =>
      orders.reserveStockAndCreateOrder({
        userId: 'u1',
        items: [{ productId: 'p1', quantity: 3 }, { productId: 'p1', quantity: 2 }], // 3+2=5, 10 in stock
        shippingAddressId: null,
        paymentMethod: 'cod',
        initialStatus: 'processing'
      })
    );
    assert.strictEqual(fakeDb.updateCalls.length, 1, 'must issue exactly one decrement, not two');
    assert.strictEqual(fakeDb.updateCalls[0].qty, 5, 'the single decrement must be for the SUMMED quantity');
    assert.strictEqual(products.p1.stock_qty, 5, '10 - 5 = 5 remaining');
    assert.strictEqual(result.total, 50000 * 5 + 0 + Math.round(50000 * 5 * 0.03));
  });
}

// ============================================================
// [5] Real CORS origin normalization: src/utils/cors.js
// ============================================================
section('[5] normalizeOrigin — the REAL function server.js uses for CLIENT_URL (the exact bug hit during deployment)');
{
  const { normalizeOrigin } = require('../src/utils/cors');

  test('strips a single trailing slash — the exact deployment bug hit', () => {
    assert.strictEqual(normalizeOrigin('https://chakrashri.netlify.app/'), 'https://chakrashri.netlify.app');
  });
  test('leaves a URL with no trailing slash unchanged', () => {
    assert.strictEqual(normalizeOrigin('https://chakrashri.netlify.app'), 'https://chakrashri.netlify.app');
  });
  test('strips multiple trailing slashes', () => {
    assert.strictEqual(normalizeOrigin('https://chakrashri.netlify.app///'), 'https://chakrashri.netlify.app');
  });
  test('handles empty/undefined without throwing', () => {
    assert.strictEqual(normalizeOrigin(undefined), '');
    assert.strictEqual(normalizeOrigin(''), '');
  });
}

// ============================================================
// [6] Stock-restoration idempotency: src/utils/stock.js
// ============================================================
section("[6] STOCK_RESTORED_STATUSES — the REAL set used by restoreOrderStock's idempotency guard");
{
  const { STOCK_RESTORED_STATUSES } = require('../src/utils/stock');

  test('pending orders should still be restorable', () => {
    assert.strictEqual(STOCK_RESTORED_STATUSES.has('pending'), false);
  });
  test('paid orders should still be restorable (admin cancels a paid order)', () => {
    assert.strictEqual(STOCK_RESTORED_STATUSES.has('paid'), false);
  });
  test('already-cancelled orders must not be restored again', () => {
    assert.strictEqual(STOCK_RESTORED_STATUSES.has('cancelled'), true);
  });
  test('already-refunded orders must not be restored again', () => {
    assert.strictEqual(STOCK_RESTORED_STATUSES.has('refunded'), true);
  });
  test('already payment_failed orders must not be restored again', () => {
    assert.strictEqual(STOCK_RESTORED_STATUSES.has('payment_failed'), true);
  });
}

// ============================================================
// Runner — executes the queued sections/tests IN ORDER, properly awaiting
// async test functions so a rejected assertion inside one actually fails
// the suite instead of becoming a silent unhandled rejection.
// ============================================================
(async () => {
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
  process.exit(failed ? 1 : 0);
})();
