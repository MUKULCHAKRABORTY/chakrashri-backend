/**
 * Tests the REAL validateAndComputeCoupon() in src/utils/coupons.js against a
 * mocked DB client — using the same require.cache injection trick as
 * test/unit.test.js section [4], for the same reason stated there: a
 * reimplementation of the logic under test can pass while the real function
 * has a bug, and never actually be exercised.
 *
 * GAP THIS CLOSES: test/unit.test.js section [3b] only tests the discount
 * *arithmetic* via a hand-copied local function (computeDiscount) — its own
 * comment says as much. The eligibility checks that gate real money
 * (inactive, not-yet-valid, expired, below minimum order, usage limits) live
 * entirely inside validateAndComputeCoupon and, before this file, were never
 * run against the actual production code at all.
 *
 * Run: node test/coupons.test.js
 */
const assert = require('assert');
const path = require('path');

const queue = [];
function section(name) { queue.push({ type: 'section', name }); }
function test(name, fn) { queue.push({ type: 'test', name, fn }); }

const couponsModulePath = require.resolve('../src/utils/coupons.js');
const dbConfigPath = require.resolve(path.join(path.dirname(couponsModulePath), '..', 'config', 'db.js'));

function makeFakeDb(couponRow, redemptionCount) {
  const queries = [];
  const fakeDb = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT * FROM coupons WHERE code')) {
        if (!couponRow) return { rows: [] };
        return { rows: [couponRow] };
      }
      if (sql.includes('FROM coupon_redemptions WHERE coupon_id')) {
        return { rows: [{ cnt: redemptionCount || 0 }] };
      }
      throw new Error('Unexpected query in coupon test mock: ' + sql);
    }
  };
  return { fakeDb, queries };
}

async function withMockedDb(fakeDb, fn) {
  const originalCacheEntry = require.cache[dbConfigPath];
  require.cache[dbConfigPath] = { id: dbConfigPath, filename: dbConfigPath, loaded: true, exports: fakeDb };
  delete require.cache[couponsModulePath];
  try {
    const coupons = require('../src/utils/coupons');
    return await fn(coupons);
  } finally {
    delete require.cache[couponsModulePath];
    if (originalCacheEntry) require.cache[dbConfigPath] = originalCacheEntry;
    else delete require.cache[dbConfigPath];
  }
}

function baseCoupon(overrides) {
  return Object.assign(
    {
      id: 'c1',
      code: 'SAVE10',
      is_active: true,
      valid_from: null,
      valid_until: null,
      min_order_paise: 0,
      usage_limit_total: null,
      used_count: 0,
      usage_limit_per_customer: 1,
      discount_type: 'percentage',
      discount_percent: '10.00',
      discount_value_paise: null,
      max_discount_paise: null
    },
    overrides
  );
}

async function expectRejection(promise, statusExpected, messagePattern) {
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    if (statusExpected !== undefined) assert.strictEqual(err.status, statusExpected, `expected status ${statusExpected}, got ${err.status} (${err.message})`);
    if (messagePattern) assert.match(err.message, messagePattern);
  }
  assert.strictEqual(threw, true, 'expected the call to reject, but it resolved');
}

section('[coupons-1] validateAndComputeCoupon — real eligibility checks against a mocked DB');
{
  test('rejects an unknown code with 404', async () => {
    const { fakeDb } = makeFakeDb(null);
    await withMockedDb(fakeDb, (coupons) =>
      expectRejection(
        coupons.validateAndComputeCoupon({ code: 'NOPE', userId: 'u1', subtotalPaise: 10000 }),
        404,
        /not valid/
      )
    );
  });

  test('rejects a non-string / empty code before ever touching the DB', async () => {
    const { fakeDb, queries } = makeFakeDb(baseCoupon());
    await withMockedDb(fakeDb, (coupons) =>
      expectRejection(coupons.validateAndComputeCoupon({ code: '', userId: 'u1', subtotalPaise: 10000 }), 400, /enter a coupon code/)
    );
    assert.strictEqual(queries.length, 0, 'must not query the DB for a code that fails basic validation');
  });

  test('rejects a deactivated coupon', async () => {
    const { fakeDb } = makeFakeDb(baseCoupon({ is_active: false }));
    await withMockedDb(fakeDb, (coupons) =>
      expectRejection(
        coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 }),
        400,
        /no longer active/
      )
    );
  });

  test('rejects a coupon that is not valid yet (valid_from in the future)', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { fakeDb } = makeFakeDb(baseCoupon({ valid_from: future }));
    await withMockedDb(fakeDb, (coupons) =>
      expectRejection(
        coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 }),
        400,
        /not active yet/
      )
    );
  });

  test('rejects an expired coupon (valid_until in the past)', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { fakeDb } = makeFakeDb(baseCoupon({ valid_until: past }));
    await withMockedDb(fakeDb, (coupons) =>
      expectRejection(
        coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 }),
        400,
        /expired/
      )
    );
  });

  test('accepts a coupon exactly at its valid_until instant is NOT expired-boundary flaky: one second before expiry passes', async () => {
    const almostExpired = new Date(Date.now() + 1000).toISOString();
    const { fakeDb } = makeFakeDb(baseCoupon({ valid_until: almostExpired }));
    const { discountPaise } = await withMockedDb(fakeDb, (coupons) =>
      coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 })
    );
    assert.strictEqual(discountPaise, 1000);
  });

  test('rejects an order below the coupon minimum, with the minimum stated in rupees', async () => {
    const { fakeDb } = makeFakeDb(baseCoupon({ min_order_paise: 50000 }));
    await withMockedDb(fakeDb, (coupons) =>
      expectRejection(
        coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 }),
        400,
        /minimum order of ₹500/
      )
    );
  });

  test('accepts an order exactly AT the minimum (boundary is inclusive, not exclusive)', async () => {
    const { fakeDb } = makeFakeDb(baseCoupon({ min_order_paise: 10000 }));
    const result = await withMockedDb(fakeDb, (coupons) =>
      coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 })
    );
    assert.strictEqual(result.discountPaise, 1000);
  });

  test('rejects once the total usage limit is reached (used_count >= usage_limit_total)', async () => {
    const { fakeDb } = makeFakeDb(baseCoupon({ usage_limit_total: 5, used_count: 5 }));
    await withMockedDb(fakeDb, (coupons) =>
      expectRejection(
        coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 }),
        400,
        /usage limit/
      )
    );
  });

  test('accepts one below the total usage limit', async () => {
    const { fakeDb } = makeFakeDb(baseCoupon({ usage_limit_total: 5, used_count: 4 }));
    const result = await withMockedDb(fakeDb, (coupons) =>
      coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 })
    );
    assert.strictEqual(result.discountPaise, 1000);
  });

  test('rejects a customer who has already used their per-customer allowance', async () => {
    const { fakeDb } = makeFakeDb(baseCoupon({ usage_limit_per_customer: 2 }), 2);
    await withMockedDb(fakeDb, (coupons) =>
      expectRejection(
        coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 }),
        400,
        /maximum number of times/
      )
    );
  });

  test('a DIFFERENT customer is unaffected by another customer\'s redemption count (per-customer, not global)', async () => {
    // Same coupon row, but the per-customer redemption lookup for THIS user
    // returns 0 — this is what proves the query is scoped by user_id and not
    // accidentally counting every redemption of the coupon.
    const { fakeDb } = makeFakeDb(baseCoupon({ usage_limit_per_customer: 1 }), 0);
    const result = await withMockedDb(fakeDb, (coupons) =>
      coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u2', subtotalPaise: 10000 })
    );
    assert.strictEqual(result.discountPaise, 1000);
  });

  test('normalizes the code (trims + uppercases) before querying, so "  save10  " matches "SAVE10"', async () => {
    const { fakeDb, queries } = makeFakeDb(baseCoupon());
    await withMockedDb(fakeDb, (coupons) =>
      coupons.validateAndComputeCoupon({ code: '  save10  ', userId: 'u1', subtotalPaise: 10000 })
    );
    assert.strictEqual(queries[0].params[0], 'SAVE10');
  });

  test('lockForUpdate=true appends FOR UPDATE to the coupon lookup query (row-locking for real redemption)', async () => {
    const { fakeDb, queries } = makeFakeDb(baseCoupon());
    await withMockedDb(fakeDb, (coupons) =>
      coupons.validateAndComputeCoupon({ client: fakeDb, code: 'SAVE10', userId: 'u1', subtotalPaise: 10000, lockForUpdate: true })
    );
    assert.match(queries[0].sql, /FOR UPDATE/);
  });

  test('lockForUpdate omitted/false does NOT lock the row (read-only preview path, e.g. the "Apply" button)', async () => {
    const { fakeDb, queries } = makeFakeDb(baseCoupon());
    await withMockedDb(fakeDb, (coupons) =>
      coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 })
    );
    assert.doesNotMatch(queries[0].sql, /FOR UPDATE/);
  });

  test('fixed-type coupon end-to-end through the real function, not just the arithmetic', async () => {
    const { fakeDb } = makeFakeDb(baseCoupon({ discount_type: 'fixed', discount_value_paise: '15000', discount_percent: null }));
    const result = await withMockedDb(fakeDb, (coupons) =>
      coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 50000 })
    );
    assert.strictEqual(result.discountPaise, 15000);
  });

  test('a coupon with an unreached usage_limit_total of null never rejects on that ground', async () => {
    const { fakeDb } = makeFakeDb(baseCoupon({ usage_limit_total: null, used_count: 99999 }));
    const result = await withMockedDb(fakeDb, (coupons) =>
      coupons.validateAndComputeCoupon({ code: 'SAVE10', userId: 'u1', subtotalPaise: 10000 })
    );
    assert.strictEqual(result.discountPaise, 1000);
  });
}

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
