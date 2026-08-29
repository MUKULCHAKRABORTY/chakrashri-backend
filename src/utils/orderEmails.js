/**
 * One place that knows what an order email needs to be loaded with.
 *
 * WHY THIS EXISTS. Two call sites in payments.routes.js each ran their own
 * query selecting exactly four columns — order_number, total_paise, and the
 * customer's name and email. That was enough for the old confirmation template,
 * which listed items and a single total.
 *
 * The moment the template grew a real money breakdown, those queries became
 * silently wrong: subtotal_paise, gst_paise and shipping_paise arrived as
 * undefined and rendered as `₹NaN` in a customer's receipt. Nothing throws,
 * nothing logs, and no test that mocks the database can see it, because the
 * mock returns whatever the test author thought the query returned.
 *
 * So the shape lives here, next to the templates that consume it, and every
 * sender loads through this function. Adding a field to a template means adding
 * it once, in one query, rather than discovering three months later which of
 * five call sites was never updated.
 */
const db = require('../config/db');
const { logger } = require('./logger');

/**
 * @param {string} orderId
 * @param {object} [client] a transaction client, when the caller already has one
 * @returns {Promise<{order: object, items: object[]}|null>}
 */
async function loadOrderForEmail(orderId, client) {
  const q = client || db;
  try {
    const { rows } = await q.query(
      `SELECT o.id, o.order_number, o.user_id, o.status, o.payment_method,
              o.subtotal_paise, o.discount_paise, o.shipping_paise, o.gst_paise, o.total_paise,
              o.courier_name, o.tracking_number, o.invoice_number,
              o.payment_review_reason, o.created_at,
              u.email AS customer_email, u.name AS customer_name
         FROM orders o
         JOIN users u ON u.id = o.user_id
        WHERE o.id = $1`,
      [orderId]
    );
    if (!rows.length) return null;

    // slug, hsn_code and gst_rate come from products rather than the snapshot
    // columns on purpose. The snapshot exists so a later price or name change
    // cannot rewrite a customer's history; a slug is a routing detail and a HSN
    // code is a tax classification, and for both the CURRENT value is the
    // correct one — a review link has to point where the product lives today.
    const { rows: items } = await q.query(
      `SELECT oi.product_name_snapshot, oi.quantity, oi.unit_price_paise, oi.line_total_paise,
              p.slug, p.hsn_code, p.gst_rate
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1
        ORDER BY oi.product_name_snapshot`,
      [orderId]
    );

    return { order: rows[0], items };
  } catch (err) {
    // An email is never worth failing the transaction that triggered it.
    logger.warn('Could not load order for email', { orderId, message: err.message });
    return null;
  }
}

/**
 * Fire-and-forget wrapper. Every email in this codebase is sent this way: the
 * customer's order has already succeeded by the time we get here, and a mail
 * server having a bad minute must not turn a completed purchase into an error
 * response. The rejection is logged rather than swallowed, so a systematic
 * failure is visible in the logs and in email_log rather than invisible.
 */
function fireAndForget(promise, context) {
  Promise.resolve(promise).catch((err) => {
    logger.warn('Email dispatch failed', Object.assign({ message: err.message }, context || {}));
  });
}

module.exports = { loadOrderForEmail, fireAndForget };
