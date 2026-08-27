/**
 * Async route-handler wrapper — closes OPS-01.
 *
 * THE PROBLEM
 * Express 4 does not understand promises. If an `async` handler rejects and
 * nothing catches it, Express never learns about it: no response is sent, the
 * client hangs until timeout, and — since Node 15 — the unhandled rejection
 * terminates the whole process by default, taking every other in-flight
 * request down with it.
 *
 * Most handlers in this codebase wrap their body in try/catch, which is why
 * this has not bitten yet. But that is a convention, not a guarantee, and
 * there was at least one real hole: payments.routes.js awaited
 * restoreOrderStock() *inside* a catch block with no outer try, so a Razorpay
 * outage — precisely when the system is already degraded — escalated into a
 * full process restart.
 *
 * Wrapping every handler means the guarantee no longer depends on a future
 * developer remembering the convention.
 *
 * WHY NOT MONKEY-PATCH EXPRESS
 * The `express-async-errors` approach (patching Layer.prototype.handle) needs
 * no per-route change, but reaches into express/lib internals that are not a
 * public API and have moved between majors. An explicit wrapper is one extra
 * token per route and cannot break on an express upgrade. Express 5 handles
 * this natively — at that point this file becomes a no-op and can be deleted
 * in a single pass.
 *
 * The process-level handlers in server.js are the backstop for anything this
 * wrapper cannot reach (timers, event emitters, fire-and-forget IIFEs).
 */
function asyncHandler(fn) {
  return function wrappedAsyncHandler(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
