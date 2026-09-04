/**
 * Which order statuses count as a real sale.
 *
 * This one list decides site-wide revenue, the daily revenue chart, top
 * products, top categories, a customer's lifetime value, and — since the shop
 * began computing its own Bestseller badges — which products get badged. It was
 * written out by hand in seven different queries across three files, which is
 * exactly the shape of bug this codebase keeps producing: the rule is correct in
 * six places and quietly wrong in the seventh, and nothing fails.
 *
 * The distinction being drawn: a `pending` order is a cart that was never paid
 * for, `payment_review` is money we cannot yet account for, and `cancelled`,
 * `refunded` and `payment_failed` are all non-sales. `partially_refunded` IS a
 * sale — goods left the building and some money was kept.
 *
 * Two NEARBY rules are deliberately not this one and must not be folded in:
 *   - "has reached fulfilment" (admin.routes.js, payments.routes.js) omits
 *     partially_refunded, because it asks whether we have started shipping.
 *   - the admin status-change whitelist includes payment_review, because that is
 *     a state a human must be able to move an order into.
 */
const REVENUE_STATUSES = Object.freeze([
  'paid', 'processing', 'shipped', 'delivered', 'partially_refunded'
]);

/**
 * The same list as a ready-to-interpolate SQL tuple: `('paid','processing',…)`.
 *
 * Built FROM the array rather than typed a second time, so the two can never
 * disagree. Safe to interpolate because it is derived from a frozen literal in
 * this file and never from request input — there is no path by which a caller
 * can influence its contents.
 */
const REVENUE_STATUS_SQL = `(${REVENUE_STATUSES.map((s) => `'${s}'`).join(',')})`;

module.exports = { REVENUE_STATUSES, REVENUE_STATUS_SQL };
