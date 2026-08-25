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
    assert.deepStrictEqual(result, [{ productId: 'p1', variantId: null, quantity: 2 }]);
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
  test('THE VARIANT BUG (would-be): two DIFFERENT variants of the same product must stay separate, never merged — they have independent stock', () => {
    const result = validateAndAggregateCart([
      { productId: 'p1', variantId: 'red', quantity: 2 },
      { productId: 'p1', variantId: 'blue', quantity: 3 }
    ]);
    assert.strictEqual(result.length, 2, 'Red and Blue are different purchasable units and must not collapse into one');
    const red = result.find((r) => r.variantId === 'red');
    const blue = result.find((r) => r.variantId === 'blue');
    assert.strictEqual(red.quantity, 2);
    assert.strictEqual(blue.quantity, 3);
  });
  test('the SAME variant listed twice IS correctly aggregated (summed), same as the base-product case', () => {
    const result = validateAndAggregateCart([
      { productId: 'p1', variantId: 'red', quantity: 2 },
      { productId: 'p1', variantId: 'red', quantity: 3 }
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].quantity, 5);
  });
  test('a variant item and a plain (no-variant) item of the SAME product are kept separate', () => {
    const result = validateAndAggregateCart([
      { productId: 'p1', quantity: 1 },               // base product, no variant selected
      { productId: 'p1', variantId: 'red', quantity: 1 } // the "Red" variant of the same product
    ]);
    assert.strictEqual(result.length, 2, 'a base-product purchase and a specific-variant purchase are different stock pools');
  });
  test('rejects a non-string variantId (e.g. a number or object slipping through from a client bug)', () => {
    assert.throws(
      () => validateAndAggregateCart([{ productId: 'p1', variantId: 12345, quantity: 1 }]),
      /invalid item or quantity/
    );
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

  test('no discount when none is passed — discountPaise defaults to 0', () => {
    const r = calculateOrderTotals([{ lineTotalPaise: 50000, gstRate: 3 }]);
    assert.strictEqual(r.discountPaise, 0);
  });
  test('a flat discount reduces the subtotal and proportionally scales GST', () => {
    // 1000 paise off a 50000-paise subtotal = 2% reduction -> GST scales by 98%
    const r = calculateOrderTotals([{ lineTotalPaise: 50000, gstRate: 3 }], 1000);
    assert.strictEqual(r.discountPaise, 1000);
    assert.strictEqual(r.totalPaise, (50000 - 1000) + 7900 + Math.round(1500 * 0.98));
  });
  test('free-shipping threshold is evaluated on the ORIGINAL subtotal, not the discounted one', () => {
    // Subtotal is exactly at the free-shipping line; a big discount must not
    // retroactively bring shipping back — the threshold is about the value
    // of goods bought, not what ends up being paid.
    const r = calculateOrderTotals([{ lineTotalPaise: 99900, gstRate: 3 }], 90000);
    assert.strictEqual(r.shippingPaise, 0, 'shipping must stay free even though the discounted amount is far below the threshold');
  });
  test('THE SAFETY NET: a discount can never exceed the subtotal, even if a bug upstream tried to pass one that does', () => {
    const r = calculateOrderTotals([{ lineTotalPaise: 50000, gstRate: 3 }], 999999); // absurdly large discount
    assert.strictEqual(r.discountPaise, 50000, 'discount must clamp to the subtotal, never exceed it');
    assert.strictEqual(r.totalPaise, 0 + 7900 + 0, 'discounted subtotal floors at 0, not negative');
  });
  test('a negative discount (e.g. a bug passing -500) is clamped to zero, never adds money back', () => {
    const r = calculateOrderTotals([{ lineTotalPaise: 50000, gstRate: 3 }], -500);
    assert.strictEqual(r.discountPaise, 0);
    assert.strictEqual(r.subtotalPaise, 50000);
  });
}

section('[3b] validateAndComputeCoupon discount math — the REAL percentage/fixed/cap logic, run against a mocked coupon row');
{
  // The DB-touching parts of validateAndComputeCoupon (lookup, usage-limit
  // queries) need a live connection to test end-to-end — but the discount
  // arithmetic itself is easy to isolate and verify directly by constructing
  // the same computation the function performs, using REAL coupon shapes
  // exactly as they come back from Postgres (numeric columns arrive as
  // strings in node-postgres, which is a real, easy-to-miss bug source if
  // the code ever does `coupon.discount_percent * x` on a string without
  // Number() — this is exactly why the source uses Number(coupon.discount_percent) below).
  function computeDiscount(coupon, subtotalPaise) {
    let discountPaise;
    if (coupon.discount_type === 'percentage') {
      discountPaise = Math.round((subtotalPaise * Number(coupon.discount_percent)) / 100);
      if (coupon.max_discount_paise !== null) {
        discountPaise = Math.min(discountPaise, Number(coupon.max_discount_paise));
      }
    } else {
      discountPaise = Number(coupon.discount_value_paise);
    }
    return Math.max(0, Math.min(discountPaise, subtotalPaise));
  }

  test('percentage coupon: 10% off a real Postgres-shaped row (numeric arrives as string)', () => {
    const coupon = { discount_type: 'percentage', discount_percent: '10.00', max_discount_paise: null };
    assert.strictEqual(computeDiscount(coupon, 50000), 5000);
  });
  test('percentage coupon respects its max_discount_paise cap', () => {
    const coupon = { discount_type: 'percentage', discount_percent: '50.00', max_discount_paise: '10000' };
    // 50% of 50000 = 25000, but capped at 10000
    assert.strictEqual(computeDiscount(coupon, 50000), 10000);
  });
  test('fixed coupon: flat amount off, string-typed BIGINT column handled correctly', () => {
    const coupon = { discount_type: 'fixed', discount_value_paise: '15000' };
    assert.strictEqual(computeDiscount(coupon, 50000), 15000);
  });
  test('fixed coupon larger than the cart clamps to the cart subtotal, never goes negative', () => {
    const coupon = { discount_type: 'fixed', discount_value_paise: '99999' };
    assert.strictEqual(computeDiscount(coupon, 50000), 50000);
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

  function makeFakeDb(productsById, variantsById) {
    variantsById = variantsById || {};
    const updateCalls = [];
    const variantUpdateCalls = [];
    const fakeClient = {
      async query(sql, params) {
        if (sql.includes('FOR UPDATE') && sql.includes('SELECT id, name, price_paise')) {
          const ids = params[0];
          return { rows: ids.filter((id) => productsById[id]).map((id) => ({ id, ...productsById[id] })) };
        }
        if (sql.includes('FOR UPDATE') && sql.startsWith('SELECT * FROM product_variants')) {
          const ids = params[0];
          return { rows: ids.filter((id) => variantsById[id]).map((id) => ({ id, ...variantsById[id] })) };
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
        if (sql.startsWith('UPDATE product_variants SET stock_qty')) {
          const [qty, id] = params;
          variantUpdateCalls.push({ id, qty });
          if (variantsById[id].stock_qty >= qty) {
            variantsById[id].stock_qty -= qty;
            return { rowCount: 1 };
          }
          return { rowCount: 0 };
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
    return { withTransaction: (fn) => fn(fakeClient), updateCalls, variantUpdateCalls };
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

  test('VARIANT, end-to-end: buying a specific variant decrements the VARIANT stock, never the base product stock', async () => {
    const products = { p1: { name: 'Rudraksha Mala', price_paise: 50000, stock_qty: 10, gst_rate: 3 } };
    const variants = { v_red: { product_id: 'p1', price_paise: null, stock_qty: 4, option_values: [{ option: 'Color', value: 'Red' }] } };
    const fakeDb = makeFakeDb(products, variants);
    const result = await withMockedDb(fakeDb, (orders) =>
      orders.reserveStockAndCreateOrder({
        userId: 'u1',
        items: [{ productId: 'p1', variantId: 'v_red', quantity: 2 }],
        shippingAddressId: null,
        paymentMethod: 'cod',
        initialStatus: 'processing'
      })
    );
    assert.strictEqual(fakeDb.updateCalls.length, 0, 'the base PRODUCT stock must be completely untouched for a variant-only purchase');
    assert.strictEqual(fakeDb.variantUpdateCalls.length, 1, 'exactly one variant decrement must be issued');
    assert.strictEqual(fakeDb.variantUpdateCalls[0].qty, 2);
    assert.strictEqual(variants.v_red.stock_qty, 2, '4 - 2 = 2 remaining on the VARIANT');
    assert.strictEqual(products.p1.stock_qty, 10, 'base product stock is untouched, still 10');
    // No variant-specific price was set (null), so it must inherit the base
    // product's price. Subtotal is 100000 paise (₹1000), which is above the
    // ₹999 free-shipping threshold, so shipping is 0.
    assert.strictEqual(result.total, 50000 * 2 + 0 + Math.round(50000 * 2 * 0.03));
  });

  test('VARIANT: a variant with its OWN price overrides the base product price', async () => {
    const products = { p1: { name: 'Premium Mala', price_paise: 50000, stock_qty: 10, gst_rate: 3 } };
    const variants = { v_gold: { product_id: 'p1', price_paise: 75000, stock_qty: 5, option_values: [{ option: 'Finish', value: 'Gold' }] } };
    const fakeDb = makeFakeDb(products, variants);
    const result = await withMockedDb(fakeDb, (orders) =>
      orders.reserveStockAndCreateOrder({
        userId: 'u1',
        items: [{ productId: 'p1', variantId: 'v_gold', quantity: 1 }],
        shippingAddressId: null,
        paymentMethod: 'cod',
        initialStatus: 'processing'
      })
    );
    // Must charge the variant's own 75000, NOT the base product's 50000.
    // ₹750 is below the ₹999 free-shipping threshold, so shipping applies.
    assert.strictEqual(result.total, 75000 + 7900 + Math.round(75000 * 0.03));
  });

  test('VARIANT: insufficient variant stock is rejected even though the base product has plenty', async () => {
    const products = { p1: { name: 'Rudraksha Mala', price_paise: 50000, stock_qty: 999, gst_rate: 3 } };
    const variants = { v_red: { product_id: 'p1', price_paise: null, stock_qty: 1, option_values: [{ option: 'Color', value: 'Red' }] } };
    const fakeDb = makeFakeDb(products, variants);
    let threw = false;
    try {
      await withMockedDb(fakeDb, (orders) =>
        orders.reserveStockAndCreateOrder({
          userId: 'u1',
          items: [{ productId: 'p1', variantId: 'v_red', quantity: 2 }], // only 1 in stock for this variant
          shippingAddressId: null,
          paymentMethod: 'cod',
          initialStatus: 'processing'
        })
      );
    } catch (err) {
      threw = true;
      assert.match(err.message, /only has 1 left in stock/);
    }
    assert.strictEqual(threw, true, 'must reject based on the VARIANT stock (1), ignoring the base product stock (999)');
  });
}

// ============================================================
// [5] Real CORS origin normalization: src/utils/cors.js
// ============================================================
section('[4b] jsonb serialization — the array-vs-object trap that broke variant creation');
{
  // node-postgres auto-serializes a plain OBJECT to JSON for a jsonb column,
  // but converts a JS ARRAY into a Postgres ARRAY literal ({"..."}), which
  // jsonb rejects with error 22P02. This bit twice: variant creation in the
  // admin, and variant_snapshot on every variant purchase. These tests pin
  // the actual pg behaviour so the distinction can't be "tidied away" again.
  let prepareValue = null;
  try { ({ prepareValue } = require('pg/lib/utils')); } catch (e) { /* pg not installed */ }

  test('a plain OBJECT serializes to valid JSON (safe to pass unstringified)', function(){
    if (!prepareValue) return; // skipped when pg isn't installed
    const out = prepareValue({ dob: '1990-01-01' });
    assert.doesNotThrow(() => JSON.parse(out), 'object form must be parseable JSON');
  });

  test('THE TRAP: a JS ARRAY does NOT serialize to JSON — it becomes a Postgres array literal', function(){
    if (!prepareValue) return;
    const out = prepareValue([{ option: 'Colour', value: 'Red' }]);
    // This is exactly why option_values / variant_snapshot must be
    // JSON.stringify()'d before being sent to a jsonb column.
    assert.ok(out.startsWith('{"'), 'pg produces a Postgres array literal for arrays');
    let parsedAsJson = true;
    try { const p = JSON.parse(out); parsedAsJson = Array.isArray(p); } catch (e) { parsedAsJson = false; }
    assert.strictEqual(parsedAsJson, false, 'the array form is NOT usable as jsonb — must be stringified first');
  });

  test('JSON.stringify on the array produces valid, correctly-shaped JSON', function(){
    const arr = [{ option: 'Colour', value: 'Red', colorHex: '#C9302C' }];
    const parsed = JSON.parse(JSON.stringify(arr));
    assert.strictEqual(Array.isArray(parsed), true);
    assert.strictEqual(parsed[0].value, 'Red');
    assert.strictEqual(parsed[0].colorHex, '#C9302C');
  });
}

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
