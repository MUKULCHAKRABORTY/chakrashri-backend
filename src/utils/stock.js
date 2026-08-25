const db = require('../config/db');

// Once an order reaches one of these statuses, its reserved stock has been
// (or should be) returned to the catalog. Used to avoid double-restoring
// stock if, say, an admin cancels an order that a webhook already marked
// payment_failed.
const STOCK_RESTORED_STATUSES = new Set(['cancelled', 'refunded', 'payment_failed']);

/**
 * Restores stock reserved by an order's line items and sets the order to
 * `finalStatus`. Safe to call multiple times for the same order — it checks
 * the order's current status under a row lock and no-ops if that status is
 * already one where stock was restored (or the order doesn't exist).
 *
 * Used by:
 *  - payments.routes.js (Razorpay order-creation failure, payment.failed webhook)
 *  - admin.routes.js (admin manually cancels/refunds an order)
 *  - scripts/release-expired-orders.js (abandoned-checkout sweep)
 */
async function restoreOrderStock(orderId, finalStatus, reason, adminUserId) {
  if (!STOCK_RESTORED_STATUSES.has(finalStatus)) {
    throw new Error(`restoreOrderStock called with a non-terminal status: ${finalStatus}`);
  }
  return db.withTransaction(async (client) => {
    const { rows: order } = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!order.length) return { restored: false, reason: 'order_not_found' };
    if (STOCK_RESTORED_STATUSES.has(order[0].status)) {
      return { restored: false, reason: 'already_restored', previousStatus: order[0].status };
    }

    const { rows: items } = await client.query('SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = $1', [orderId]);
    for (const item of items) {
      if (item.variant_id) {
        await client.query('UPDATE product_variants SET stock_qty = stock_qty + $1 WHERE id = $2', [item.quantity, item.variant_id]);
      } else {
        await client.query('UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2', [item.quantity, item.product_id]);
      }
    }
    await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [orderId, finalStatus]);
    await client.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'stock_released', 'order', $2, $3)`,
      [adminUserId || null, orderId, JSON.stringify({ reason, finalStatus })]
    );
    return { restored: true, itemCount: items.length };
  });
}

module.exports = { restoreOrderStock, STOCK_RESTORED_STATUSES };
