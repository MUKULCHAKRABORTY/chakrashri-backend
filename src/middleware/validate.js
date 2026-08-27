/**
 * Request-shape validation helpers — closes HYG-02 and standardises the
 * express-validator result handling that was previously copy-pasted (and, in
 * one route, forgotten entirely) in every handler.
 */
const { validationResult } = require('express-validator');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Rejects a malformed UUID before it reaches Postgres.
 *
 * THE PROBLEM: every `/:id` route passed req.params.id straight into a query.
 * A non-UUID value (a crawler probing /api/products/wp-admin, a typo, a
 * scanner) made Postgres raise 22P02 "invalid input syntax for type uuid",
 * which the route's catch-all turned into a 500. That is wrong three times
 * over: it is a client error not a server error, it pollutes error monitoring
 * with noise that hides real failures, and a 500 tells an attacker their input
 * reached the database.
 *
 * Mount with router.param so it applies to every route in a file at once:
 *   router.param('id', validateUuidParam('id'))
 */
function validateUuidParam(name) {
  return function uuidParamGuard(req, res, next, value) {
    if (!UUID_RE.test(String(value || ''))) {
      return res.status(400).json({ error: `Invalid ${name} format.` });
    }
    return next();
  };
}

/** Same check for use inside a handler body. */
function isUuid(value) {
  return UUID_RE.test(String(value || ''));
}

/**
 * Terminates a validator chain. Use as the last entry in the middleware array
 * so a handler can assume its input is already the right shape:
 *   router.post('/x', [body('a').isInt(), handleValidation], asyncHandler(fn))
 */
function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  const list = errors.array();

  // BACKWARD COMPATIBILITY, deliberately.
  //
  // The storefront and admin console both read `err.errors[0].msg` — that is
  // express-validator's own key name, and three call sites depend on it. An
  // earlier version of this function renamed it to `message`, which did not
  // throw but quietly degraded every field-level error into a generic
  // "some details are not valid". Emitting BOTH keys costs nothing and means
  // old and new clients are equally well served.
  //
  // `error` is also the FIRST specific message rather than a generic sentence,
  // so a client that only reads `err.error` — which is most of them — still
  // tells the customer what to actually fix.
  return res.status(400).json({
    error: list[0] ? list[0].msg : 'Some of the details provided are not valid.',
    errors: list.map((e) => ({
      field: e.path || e.param,
      msg: e.msg,      // express-validator's key — existing clients read this
      message: e.msg   // clearer alias for anything written from here on
    }))
  });
}

module.exports = { validateUuidParam, isUuid, handleValidation, UUID_RE };
