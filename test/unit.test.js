/**
 * Standalone tests for the pieces of payments.routes.js that don't require
 * a live Postgres connection or real Razorpay credentials: signature
 * verification (pure crypto) and the subtotal/shipping/GST math (pure
 * arithmetic). Run: node test/unit.test.js
 */
const crypto = require('crypto');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS -', name); passed++; }
  catch (e) { console.log('  FAIL -', name, '\n        ', e.message); failed++; }
}

console.log('\n[1] Razorpay HMAC signature verification');
{
  const secret = 'test_secret_key';
  function verify(orderId, paymentId, signature) {
    const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    return expected === signature;
  }
  const orderId = 'order_ABC123';
  const paymentId = 'pay_XYZ789';
  const validSig = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  test('accepts a genuine signature', () => {
    assert.strictEqual(verify(orderId, paymentId, validSig), true);
  });
  test('rejects a tampered signature', () => {
    assert.strictEqual(verify(orderId, paymentId, 'deadbeef' + validSig.slice(8)), false);
  });
  test('rejects a signature computed for a different order id (replay across orders)', () => {
    const otherSig = crypto.createHmac('sha256', secret).update(`order_DIFFERENT|${paymentId}`).digest('hex');
    assert.strictEqual(verify(orderId, paymentId, otherSig), false);
  });
  test('rejects empty signature', () => {
    assert.strictEqual(verify(orderId, paymentId, ''), false);
  });
}

console.log('\n[2] Order total calculation (subtotal + shipping + GST, integer paise)');
{
  function calcTotal(items) {
    // Mirrors the logic in payments.routes.js create-order
    let subtotalPaise = 0;
    const lines = items.map((i) => {
      const lineTotal = i.pricePaise * i.quantity;
      subtotalPaise += lineTotal;
      return { ...i, lineTotal };
    });
    const shippingPaise = subtotalPaise >= 99900 ? 0 : 7900;
    const gstPaise = Math.round(lines.reduce((sum, i) => sum + (i.lineTotal * i.gstRate) / 100, 0));
    return { subtotalPaise, shippingPaise, gstPaise, totalPaise: subtotalPaise + shippingPaise + gstPaise };
  }

  test('single item under free-shipping threshold gets shipping charged', () => {
    const r = calcTotal([{ pricePaise: 50000, quantity: 1, gstRate: 3 }]); // ₹500
    assert.strictEqual(r.subtotalPaise, 50000);
    assert.strictEqual(r.shippingPaise, 7900);
    assert.strictEqual(r.gstPaise, 1500); // 3% of 50000
    assert.strictEqual(r.totalPaise, 50000 + 7900 + 1500);
  });

  test('order at/above ₹999 gets free shipping', () => {
    const r = calcTotal([{ pricePaise: 99900, quantity: 1, gstRate: 3 }]);
    assert.strictEqual(r.shippingPaise, 0);
  });

  test('multiple items with different GST rates sum correctly', () => {
    const r = calcTotal([
      { pricePaise: 100000, quantity: 2, gstRate: 3 },  // 200000 paise, 3% = 6000
      { pricePaise: 50000, quantity: 1, gstRate: 5 }    // 50000 paise, 5% = 2500
    ]);
    assert.strictEqual(r.subtotalPaise, 250000);
    assert.strictEqual(r.gstPaise, 8500);
    assert.strictEqual(r.shippingPaise, 0); // over 99900 threshold
  });

  test('GST rounds to nearest paise rather than accumulating float drift', () => {
    const r = calcTotal([{ pricePaise: 3333, quantity: 3, gstRate: 3 }]); // 9999 * 3% = 299.97
    assert.strictEqual(r.gstPaise, 300);
  });
}

console.log('\n[3] Cart input validation (mirrors create-order guard clauses)');
{
  function validateItems(items) {
    if (!Array.isArray(items) || !items.length) return { ok: false, error: 'Cart is empty.' };
    for (const item of items) {
      if (
        !item ||
        typeof item.productId !== 'string' ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 50
      ) {
        return { ok: false, error: 'Cart contains an invalid item or quantity.' };
      }
    }
    return { ok: true };
  }

  test('rejects empty cart', () => {
    assert.strictEqual(validateItems([]).ok, false);
  });
  test('rejects negative quantity (the bug found in code review)', () => {
    assert.strictEqual(validateItems([{ productId: 'p1', quantity: -1 }]).ok, false);
  });
  test('rejects zero quantity', () => {
    assert.strictEqual(validateItems([{ productId: 'p1', quantity: 0 }]).ok, false);
  });
  test('rejects non-integer quantity (e.g. 1.5)', () => {
    assert.strictEqual(validateItems([{ productId: 'p1', quantity: 1.5 }]).ok, false);
  });
  test('rejects absurdly large quantity (potential abuse/overflow attempt)', () => {
    assert.strictEqual(validateItems([{ productId: 'p1', quantity: 999999 }]).ok, false);
  });
  test('accepts a normal valid cart', () => {
    assert.strictEqual(validateItems([{ productId: 'p1', quantity: 2 }]).ok, true);
  });
  test('rejects missing productId', () => {
    assert.strictEqual(validateItems([{ quantity: 1 }]).ok, false);
  });
}

console.log('\n[4] Stock-restoration idempotency guard (mirrors utils/stock.js logic)');
{
  const STOCK_RESTORED_STATUSES = new Set(['cancelled', 'refunded', 'payment_failed']);
  function shouldRestore(currentStatus) {
    return !STOCK_RESTORED_STATUSES.has(currentStatus);
  }

  test('restores stock when order is still pending', () => {
    assert.strictEqual(shouldRestore('pending'), true);
  });
  test('restores stock when order is paid (admin cancels a paid order)', () => {
    assert.strictEqual(shouldRestore('paid'), true);
  });
  test('does NOT restore stock twice if already cancelled', () => {
    assert.strictEqual(shouldRestore('cancelled'), false);
  });
  test('does NOT restore stock twice if already refunded', () => {
    assert.strictEqual(shouldRestore('refunded'), false);
  });
  test('does NOT restore stock twice if already payment_failed', () => {
    assert.strictEqual(shouldRestore('payment_failed'), false);
  });
  test('restores stock for an order mid-fulfillment (processing/shipped) that gets cancelled', () => {
    assert.strictEqual(shouldRestore('processing'), true);
    assert.strictEqual(shouldRestore('shipped'), true);
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
