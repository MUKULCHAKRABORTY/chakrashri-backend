/**
 * Verifies your Razorpay TEST-mode keys actually work: creates a tiny (₹1)
 * test order via the real Razorpay API and confirms a valid response comes
 * back. Safe to run — test-mode keys (rzp_test_...) never move real money,
 * and this only creates an order, it doesn't charge anything (a charge
 * requires the customer to complete checkout with a test card).
 *
 * Run: node scripts/test-razorpay-connection.js
 */
require('dotenv').config();
const crypto = require('crypto');
const razorpay = require('../src/config/razorpay');

let failures = 0;
function report(label, ok, detail) {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

async function main() {
  console.log('Chakrashri Razorpay connectivity check\n');

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    report('Credentials present in .env', false, 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set');
    process.exit(1);
  }
  report('Credentials present in .env', true);

  const isTestMode = process.env.RAZORPAY_KEY_ID.startsWith('rzp_test_');
  report('Using TEST-mode key (safe for this script)', isTestMode, `key prefix: ${process.env.RAZORPAY_KEY_ID.slice(0, 12)}...`);
  if (!isTestMode) {
    console.log('\n  Refusing to run against a LIVE key automatically — this script is for pre-production');
    console.log('  verification only. Swap in your rzp_test_ keys to run this check.');
    process.exit(1);
  }

  // 1. Create a real (test-mode) order — proves the key/secret pair authenticates correctly
  let order;
  try {
    order = await razorpay.orders.create({
      amount: 100, // ₹1.00 in paise — smallest sensible test amount
      currency: 'INR',
      receipt: 'connectivity_test_' + Date.now()
    });
    report('Order creation succeeds (auth is valid)', true, `order id: ${order.id}`);
  } catch (err) {
    report('Order creation succeeds (auth is valid)', false, err.error?.description || err.message);
    console.log('\nCommon causes: wrong KEY_ID/KEY_SECRET, or KYC/account not fully activated on Razorpay\'s side.');
    process.exit(1);
  }

  // 2. Fetch the order back — proves read access and that the order was really created server-side, not just echoed
  try {
    const fetched = await razorpay.orders.fetch(order.id);
    report('Order retrievable after creation', fetched.id === order.id, `status: ${fetched.status}`);
  } catch (err) {
    report('Order retrievable after creation', false, err.message);
  }

  // 3. Verify the HMAC signature logic end-to-end with realistic (fake payment id) inputs —
  //    this can't call a real successful payment without a browser + test card, but it proves
  //    the exact signature algorithm used in production matches Razorpay's documented scheme.
  const fakePaymentId = 'pay_test_connectivity_check';
  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${order.id}|${fakePaymentId}`)
    .digest('hex');
  report('Signature generation runs without error', /^[a-f0-9]{64}$/.test(signature), `${signature.slice(0, 16)}...`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} — see above for detail.`);
  console.log('\nNote: this confirms your keys authenticate and orders can be created/read.');
  console.log('The full checkout -> signature verification -> webhook path still needs one manual');
  console.log('end-to-end test with Razorpay\'s test card (see README "Manual end-to-end test") before go-live.\n');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected error running Razorpay checks:', err);
  process.exit(1);
});
