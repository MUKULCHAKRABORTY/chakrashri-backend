const Razorpay = require('razorpay');

/**
 * Lazily-constructed Razorpay client.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT JUST `new Razorpay({...})` AT THE TOP LEVEL
 * ---------------------------------------------------------------------------
 * The SDK throws `'key_id' or 'oauthToken' is mandatory` from its constructor.
 * Constructing at module load meant that a missing or briefly-unset
 * RAZORPAY_KEY_ID took down the ENTIRE application at require time — before any
 * route was mounted, before the env-var check in server.js could report which
 * variable was actually missing, and with a stack trace pointing at
 * node_modules rather than at the misconfiguration.
 *
 * On a platform that restarts a failing process, that is a crash loop whose
 * error message names the wrong thing. The storefront is down, the logs say
 * "key_id is mandatory", and nothing indicates that the fix is one env var in a
 * dashboard.
 *
 * It also made the module impossible to require in a test without inventing
 * fake credentials, which is how three integration tests that never touch
 * Razorpay ended up failing for want of a key.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES INSTEAD
 * ---------------------------------------------------------------------------
 * The client is built on FIRST USE and then cached. Requiring this module is
 * free and cannot fail. Every existing call site is untouched —
 * `razorpay.orders.create(...)`, `razorpay.payments.refund(...)` and the rest
 * all work exactly as before, because the proxy forwards property access to the
 * real client.
 *
 * If the credentials are genuinely missing, the failure now happens at the
 * moment a payment is attempted, with a message that names the actual problem.
 * And in production it never gets that far: server.js refuses to start without
 * these variables (see the fail-fast block at the top of that file).
 */
let client = null;

function build() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw Object.assign(
      new Error(
        'Razorpay is not configured: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must both be set. ' +
        'Set them in the Render dashboard (or .env locally) — see .env.example.'
      ),
      { status: 503, code: 'RAZORPAY_NOT_CONFIGURED' }
    );
  }

  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

function getClient() {
  if (!client) client = build();
  return client;
}

/** Lets a test swap in a stub without touching require.cache. */
function _setClientForTests(stub) {
  client = stub;
}

/** True when both credentials are present — for a health/readiness check. */
function isConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

// A Proxy rather than a hand-written façade: the SDK's surface is large
// (orders, payments, refunds, subscriptions, …) and a façade would have to be
// updated every time a new resource is used, failing in a confusing way until
// someone noticed. Forwarding everything keeps this a drop-in replacement.
const proxy = new Proxy({}, {
  get(_target, prop) {
    if (prop === '_setClientForTests') return _setClientForTests;
    if (prop === 'isConfigured') return isConfigured;
    // Node inspects modules for these during logging and promise resolution;
    // answering undefined avoids constructing a client as a side effect of a
    // console.log or an `await`.
    if (prop === 'then' || prop === 'inspect' || typeof prop === 'symbol') return undefined;

    const value = getClient()[prop];
    return typeof value === 'function' ? value.bind(getClient()) : value;
  },
  has(_target, prop) {
    return prop in getClient();
  }
});

module.exports = proxy;
