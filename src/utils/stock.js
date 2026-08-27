const db = require('../config/db');
const { logger } = require('./logger');

// Once an order reaches one of these statuses, its reserved stock has been
// (or should be) returned to the catalog. Used to avoid double-restoring
// stock if, say, an admin cancels an order that a webhook already marked
// payment_failed.
//
// NOTE: 'partially_refunded' is deliberately NOT in this set. A partial refund
// is usually one returned item out of several, so the order's remaining items
// are still sold and their stock must stay decremented. Treating it as
// "restored" would invent inventory that was never returned — see the note in
// utils/refunds.js about why per-item restocking needs a real returns flow.
const STOCK_RESTORED_STATUSES = new Set(['cancelled', 'refunded', 'payment_failed']);

/**
 * Puts an order's line items back into stock, INSIDE a transaction the caller
 * already owns. Does NOT check or change the order's status — the caller has
 * decided that already.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM restoreOrderStock()
 * ---------------------------------------------------------------------------
 * This split fixes a real bug, and the shape of the bug is worth recording
 * because it is easy to reintroduce.
 *
 * restoreOrderStock() is idempotent: it re-reads the order's status under a row
 * lock and no-ops if that status is already one where stock was restored. That
 * guard is what lets the webhook, an admin and the expiry sweep all fire on the
 * same order safely.
 *
 * But a caller that has ALREADY committed `status = 'refunded'` and then calls
 * restoreOrderStock() trips its own guard: the function sees 'refunded', decides
 * the stock must have been restored by whoever set it, and returns without doing
 * anything. No error, no log, no audit row — the units are simply gone from
 * sellable inventory forever. The refund path did exactly this, because the
 * status write and the stock restore lived in different transactions with the
 * status write first.
 *
 * So: a caller that owns the status transition calls THIS function inside its
 * own transaction, before or alongside the status write, and everything commits
 * atomically. A caller that does not know the current status calls
 * restoreOrderStock() and gets the guard.
 */
async function restoreOrderStockInTransaction(client, orderId, reason, adminUserId, previousStatus, finalStatus) {
  const { rows: items } = await client.query(
    'SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = $1',
    [orderId]
  );

  // Restore in a deterministic order for the same reason checkout locks in a
  // deterministic order (DB-01): a restore and a concurrent checkout touching
  // the same two products must not be able to form a lock cycle.
  const ordered = [...items].sort((a, b) => {
    const ka = `${a.variant_id || ''}:${a.product_id}`;
    const kb = `${b.variant_id || ''}:${b.product_id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  for (const item of ordered) {
    if (item.variant_id) {
      await client.query('UPDATE product_variants SET stock_qty = stock_qty + $1 WHERE id = $2', [item.quantity, item.variant_id]);
    } else {
      await client.query('UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2', [item.quantity, item.product_id]);
    }
  }

  await client.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
     VALUES ($1, 'stock_released', 'order', $2, $3)`,
    // finalStatus is recorded as well as previousStatus. The refactor briefly
    // dropped it, which left every stock_released entry saying where the order
    // came FROM but not what it was set TO — half an audit trail.
    [adminUserId || null, orderId, JSON.stringify({
      reason,
      previousStatus: previousStatus || null,
      finalStatus: finalStatus || null,
      itemCount: ordered.length
    })]
  );

  // NOTE: deliberately NOT logged here. This runs inside the caller's
  // transaction, which may still roll back — logging success at this point
  // emits a line for work that was subsequently undone. The caller logs after
  // its commit.
  return { itemCount: ordered.length };
}

/**
 * Restores stock reserved by an order's line items and sets the order to
 * `finalStatus`. Safe to call multiple times for the same order — it checks
 * the order's current status under a row lock and no-ops if that status is
 * already one where stock was restored (or the order doesn't exist).
 *
 * Used by:
 *  - payments.routes.js (Razorpay order-creation failure, payment.failed webhook)
 *  - admin.routes.js (admin manually cancels an order, COD return-to-origin)
 *  - scripts/release-expired-orders.js (abandoned-checkout sweep)
 *
 * Callers that have already decided and written the status must use
 * restoreOrderStockInTransaction() instead — see the note on that function.
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

    const previousStatus = order[0].status;
    const { itemCount } = await restoreOrderStockInTransaction(
      client, orderId, reason, adminUserId, previousStatus, finalStatus
    );
    await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [orderId, finalStatus]);

    return { restored: true, itemCount, previousStatus, finalStatus };
  }).then((result) => {
    // Logged only once the transaction has actually committed.
    if (result.restored) {
      logger.info('Order stock restored', {
        orderId, reason, previousStatus: result.previousStatus, finalStatus, itemCount: result.itemCount
      });
    }
    return result;
  });
}

module.exports = { restoreOrderStock, restoreOrderStockInTransaction, STOCK_RESTORED_STATUSES };
