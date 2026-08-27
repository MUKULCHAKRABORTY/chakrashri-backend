/**
 * Refund ledger — closes PAY-02.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * The old flow was: call Razorpay -> UPDATE orders -> restore stock -> UPDATE
 * status. Four separate, non-transactional steps with the irreversible one
 * FIRST. If the process was redeployed, killed, or simply lost its database
 * connection after step one, the customer's money was refunded and the database
 * had no idea — the order still read `paid`, so the next admin to look refunded
 * it again. Real money, twice, with nothing recording either.
 *
 * It also clamped each refund against the order TOTAL rather than the remaining
 * balance, and set the order to `refunded` after a partial refund — which both
 * blocked any further partial refund and restored ALL the stock for a partially
 * returned order.
 *
 * ---------------------------------------------------------------------------
 * THE FIX: WRITE INTENT FIRST
 * ---------------------------------------------------------------------------
 * 1. Insert a `refunds` row with status 'initiated' and COMMIT. The intent now
 *    survives a crash, and — because the remaining-balance calculation counts
 *    'initiated' rows — a second admin clicking refund is blocked rather than
 *    computing the same balance and issuing a duplicate.
 * 2. Call Razorpay, stamping our ledger row id into the refund's `notes`.
 * 3. Record the outcome and apply the side effects (stock, status) in one
 *    transaction.
 *
 * ON RAZORPAY AND IDEMPOTENCY KEYS — worth being precise about, because the
 * obvious design does not work here. Razorpay's Refunds API has no general
 * idempotency-key header (unlike Stripe), and the Node SDK's
 * `payments.refund(paymentId, params, callback)` takes a callback as its third
 * argument, with no way to pass custom headers through. So we cannot make the
 * gateway itself de-duplicate a retry.
 *
 * What we do instead is make the ambiguity *resolvable*: the ledger row id
 * travels in `notes.ledgerId`, so a row left in 'initiated' after a crash is
 * never a guess. reconcileStuckRefunds() lists the payment's refunds at
 * Razorpay and looks for that exact id — an authoritative yes or no, from which
 * the row becomes 'processed' or 'failed'. Nothing is ever refunded twice
 * because nothing is ever retried blind.
 *
 * The remaining refundable balance is then a simple SUM over this table, which
 * is what makes correct partial refunds fall out naturally.
 */
const crypto = require('crypto');
const db = require('../config/db');
const razorpay = require('../config/razorpay');
const { logger } = require('./logger');
// The IN-TRANSACTION variants, deliberately. The transaction-owning versions
// (restoreOrderStock / releaseBookingSlot) would no-op here, because by the time
// they ran the status was already 'refunded' and their idempotency guard treats
// that as "someone else already restored it". See the note in utils/stock.js.
const { restoreOrderStockInTransaction, STOCK_RESTORED_STATUSES } = require('./stock');
const { releaseBookingSlotInTransaction } = require('./bookingSlots');

const ENTITY_TABLES = {
  order: 'orders',
  puja_booking: 'puja_bookings',
  astrology_booking: 'astrology_bookings'
};

/** Total already refunded (or in flight) against an entity, in paise. */
async function refundedTotalPaise(client, entityType, entityId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
       FROM refunds
      WHERE entity_type = $1 AND entity_id = $2 AND status IN ('initiated','processed')`,
    [entityType, entityId]
  );
  return Number(rows[0].total) || 0;
}

/**
 * Issues a refund.
 *
 * @param {object} params
 * @param {'order'|'puja_booking'|'astrology_booking'} params.entityType
 * @param {string} params.entityId
 * @param {string} params.razorpayPaymentId
 * @param {number} params.capturedTotalPaise - the full amount captured for this entity
 * @param {number|null} params.requestedAmountPaise - null/absent means "refund the remaining balance"
 * @param {string} params.adminUserId
 * @param {boolean} [params.restock=true] - restore inventory (orders only)
 * @param {string} [params.reason]
 */
async function issueRefund({
  entityType, entityId, razorpayPaymentId, capturedTotalPaise,
  requestedAmountPaise, adminUserId, restock = true, reason
}) {
  if (!ENTITY_TABLES[entityType]) {
    throw Object.assign(new Error('Unknown refund entity type.'), { status: 400 });
  }
  if (!razorpayPaymentId) {
    throw Object.assign(new Error('This record has no captured payment to refund.'), { status: 409 });
  }

  const captured = Number(capturedTotalPaise);
  if (!Number.isInteger(captured) || captured <= 0) {
    throw Object.assign(new Error('The captured amount for this record is not a valid figure.'), { status: 409 });
  }

  // ---- Step 1: reserve the amount and record intent, atomically -----------
  const prepared = await db.withTransaction(async (client) => {
    // DEFENCE IN DEPTH: refuse to refund something whose stock or slot has
    // already been returned.
    //
    // This function restores inventory with the IN-TRANSACTION helpers, which
    // deliberately carry no idempotency guard — the caller owns the status
    // transition, so a guard there would only fight it. That places the burden
    // of "has this already been given back?" on every caller, and a caller that
    // forgets INVENTS INVENTORY: refunding an order that was already cancelled
    // put its units back a second time.
    //
    // The route layer checks this too. It is repeated here because a rule that
    // only lives at the edge is one refactor away from being lost, and the cost
    // of losing this one is phantom stock the shop then oversells.
    if (entityType === 'order') {
      const { rows: statusRows } = await client.query(
        'SELECT status FROM orders WHERE id = $1 FOR UPDATE', [entityId]
      );
      if (!statusRows.length) throw Object.assign(new Error('Order not found.'), { status: 404 });
      if (STOCK_RESTORED_STATUSES.has(statusRows[0].status)) {
        throw Object.assign(
          new Error(`This order is already "${statusRows[0].status}" — its stock has been returned, so it cannot be refunded again.`),
          { status: 409 }
        );
      }
    } else {
      const table = ENTITY_TABLES[entityType];
      const { rows: statusRows } = await client.query(
        `SELECT payment_status FROM ${table} WHERE id = $1 FOR UPDATE`, [entityId]
      );
      if (!statusRows.length) throw Object.assign(new Error('Booking not found.'), { status: 404 });
      if (['failed', 'refunded'].includes(statusRows[0].payment_status)) {
        throw Object.assign(
          new Error(`This booking is already "${statusRows[0].payment_status}" — its slot has been released, so it cannot be refunded again.`),
          { status: 409 }
        );
      }
    }

    // Lock the ledger rows for this entity so two admins clicking refund at the
    // same moment cannot both compute the same remaining balance.
    await client.query(
      'SELECT id FROM refunds WHERE entity_type = $1 AND entity_id = $2 FOR UPDATE',
      [entityType, entityId]
    );

    const already = await refundedTotalPaise(client, entityType, entityId);
    const remaining = captured - already;
    if (remaining <= 0) {
      throw Object.assign(
        new Error(`This has already been fully refunded (₹${(already / 100).toLocaleString('en-IN')}).`),
        { status: 409 }
      );
    }

    let amount;
    if (requestedAmountPaise === null || requestedAmountPaise === undefined) {
      amount = remaining; // default: refund whatever is left
    } else {
      amount = Number(requestedAmountPaise);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw Object.assign(new Error('Refund amount must be a positive whole number of paise.'), { status: 400 });
      }
      if (amount > remaining) {
        throw Object.assign(
          new Error(`Only ₹${(remaining / 100).toLocaleString('en-IN')} remains refundable on this record.`),
          { status: 400 }
        );
      }
    }

    // A unique key per ledger row. It is not sent to Razorpay as an
    // idempotency header (see the note at the top of this file — that API does
    // not exist); it exists so this table can never contain two rows for the
    // same logical refund attempt, and so a support conversation can name one.
    const idempotencyKey = `${entityType}-${entityId}-${already}-${crypto.randomBytes(6).toString('hex')}`;

    const { rows } = await client.query(
      `INSERT INTO refunds (entity_type, entity_id, razorpay_payment_id, amount_paise,
                            status, idempotency_key, requested_by, restock)
       VALUES ($1,$2,$3,$4,'initiated',$5,$6,$7)
       RETURNING id, amount_paise, idempotency_key`,
      [entityType, entityId, razorpayPaymentId, amount, idempotencyKey, adminUserId || null, Boolean(restock)]
    );
    return { refund: rows[0], alreadyRefunded: already, remainingAfter: remaining - amount, capturedTotal: captured };
  });

  // ---- Step 2: the irreversible call, now backed by committed intent ------
  let gatewayRefund;
  try {
    gatewayRefund = await razorpay.payments.refund(razorpayPaymentId, {
      amount: prepared.refund.amount_paise,
      speed: 'normal',
      // ledgerId is the thread back to our row. Razorpay echoes notes on the
      // refund object, so reconcileStuckRefunds() can identify OUR refund among
      // several against the same payment with certainty rather than by
      // matching on amount. Razorpay caps notes at 15 keys / 256 chars each.
      notes: {
        ledgerId: prepared.refund.id,
        reason: String(reason || 'admin_initiated_refund').slice(0, 200),
        entityType,
        entityId,
        adminUserId: adminUserId || 'system'
      }
    });
  } catch (err) {
    await db.query(
      `UPDATE refunds SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
      [prepared.refund.id, (err.error && err.error.description) || err.message || 'Gateway error']
    );
    logger.error('Razorpay refund failed', err, { entityType, entityId, refundId: prepared.refund.id });
    throw Object.assign(
      new Error(`Refund failed at the payment gateway: ${(err.error && err.error.description) || err.message}`),
      { status: 502 }
    );
  }

  // ---- Step 3: record the outcome and apply side effects ------------------
  const fullyRefunded = prepared.remainingAfter <= 0;

  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE refunds SET status = 'processed', razorpay_refund_id = $2, updated_at = now() WHERE id = $1`,
      [prepared.refund.id, gatewayRefund.id]
    );

    const totalRefunded = prepared.alreadyRefunded + prepared.refund.amount_paise;

    // ---- Inventory / capacity, BEFORE the status write, IN this transaction --
    //
    // THE BUG THIS ORDERING FIXES: this used to happen after the transaction
    // committed, by calling restoreOrderStock() / releaseBookingSlot(). Both of
    // those are idempotent — they re-read the entity's status and no-op if it is
    // already terminal. By then the status was 'refunded', so they saw a
    // completed restore, returned {restored:false}, and the units were gone from
    // sellable inventory permanently. No error, no log, no audit row. A refunded
    // booking held its practitioner's seat forever for the same reason.
    //
    // Doing it here means refund ledger, stock, audit trail and status all
    // commit together or not at all — which is what "atomic" was supposed to
    // mean in the first place.
    if (fullyRefunded && restock) {
      if (entityType === 'order') {
        await restoreOrderStockInTransaction(client, entityId, reason || 'admin_refund', adminUserId, 'paid', 'refunded');
      } else {
        await releaseBookingSlotInTransaction(client, ENTITY_TABLES[entityType], entityId, reason || 'admin_refund', adminUserId);
      }
    }

    if (entityType === 'order') {
      await client.query(
        `UPDATE orders
            SET refund_id = $2,
                refunded_amount_paise = $3,
                status = CASE WHEN $4 THEN 'refunded' ELSE 'partially_refunded' END,
                updated_at = now()
          WHERE id = $1`,
        [entityId, gatewayRefund.id, totalRefunded, fullyRefunded]
      );
    } else {
      const table = ENTITY_TABLES[entityType];
      await client.query(
        `UPDATE ${table}
            SET refund_id = $2,
                refunded_amount_paise = $3,
                payment_status = CASE WHEN $4 THEN 'refunded' ELSE 'partially_refunded' END,
                updated_at = now()
          WHERE id = $1`,
        [entityId, gatewayRefund.id, totalRefunded, fullyRefunded]
      );
    }

    // OPS-03: the order refund path used to log only {status:'refunded'} — no
    // amount, no gateway refund id, no prior status. "Which staff member
    // refunded how much to whom, and when" is the first question in any payment
    // dispute, and the log could not answer it.
    await client.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'refund_issued', $2, $3, $4)`,
      [adminUserId || null, entityType, entityId, JSON.stringify({
        refundLedgerId: prepared.refund.id,
        razorpayRefundId: gatewayRefund.id,
        razorpayPaymentId,
        amountPaise: prepared.refund.amount_paise,
        previouslyRefundedPaise: prepared.alreadyRefunded,
        totalRefundedPaise: totalRefunded,
        capturedTotalPaise: prepared.capturedTotal,
        fullyRefunded,
        restock: Boolean(restock),
        reason: reason || 'admin_initiated_refund'
      })]
    );
  });

  // Inventory and capacity are handled INSIDE the transaction above, not here.
  //
  // Only a FULL refund restores stock. A partial refund is usually one returned
  // item out of several — restoring the whole order's stock for it would invent
  // units that were never returned. Per-item restocking needs a real returns/RMA
  // flow; until that exists, the safe direction is to leave stock alone and let
  // the admin adjust it deliberately.

  return {
    refundId: gatewayRefund.id,
    ledgerId: prepared.refund.id,
    amountPaise: prepared.refund.amount_paise,
    totalRefundedPaise: prepared.alreadyRefunded + prepared.refund.amount_paise,
    fullyRefunded
  };
}

/**
 * Records a refund that was created OUTSIDE this application — someone
 * clicking refund in the Razorpay dashboard. Previously invisible: the money
 * went back and the order stayed 'paid' forever, so the books disagreed with
 * the bank and nobody found out until a reconciliation.
 *
 * Called from the refund.processed / refund.created webhook.
 */
async function recordExternalRefund(refundEntity, eventId) {
  const razorpayRefundId = refundEntity.id;
  const razorpayPaymentId = refundEntity.payment_id;
  const amountPaise = Number(refundEntity.amount);
  if (!razorpayRefundId || !razorpayPaymentId || !Number.isFinite(amountPaise)) return;

  await db.withTransaction(async (client) => {
    // Already known? Either we issued it, or this event has been redelivered.
    const { rows: known } = await client.query(
      'SELECT id FROM refunds WHERE razorpay_refund_id = $1',
      [razorpayRefundId]
    );
    if (known.length) return;

    // Find what this payment belongs to.
    let entityType = null;
    let entityId = null;
    let capturedTotal = 0;

    const { rows: orderRows } = await client.query(
      'SELECT id, total_paise FROM orders WHERE razorpay_payment_id = $1',
      [razorpayPaymentId]
    );
    if (orderRows.length) {
      entityType = 'order'; entityId = orderRows[0].id; capturedTotal = Number(orderRows[0].total_paise);
    } else {
      for (const [type, table] of [['puja_booking', 'puja_bookings'], ['astrology_booking', 'astrology_bookings']]) {
        const { rows } = await client.query(
          `SELECT id, amount_paise FROM ${table} WHERE razorpay_payment_id = $1`,
          [razorpayPaymentId]
        );
        if (rows.length) {
          entityType = type; entityId = rows[0].id; capturedTotal = Number(rows[0].amount_paise);
          break;
        }
      }
    }

    if (!entityType) {
      logger.warn('Refund webhook for a payment this system does not recognise', { razorpayPaymentId, razorpayRefundId });
      return;
    }

    await client.query(
      `INSERT INTO refunds (entity_type, entity_id, razorpay_payment_id, razorpay_refund_id,
                            amount_paise, status, idempotency_key, restock)
       VALUES ($1,$2,$3,$4,$5,'processed',$6,false)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [entityType, entityId, razorpayPaymentId, razorpayRefundId, amountPaise, `external-${razorpayRefundId}`]
    );

    const totalRefunded = await refundedTotalPaise(client, entityType, entityId);
    const fullyRefunded = totalRefunded >= capturedTotal;

    if (entityType === 'order') {
      await client.query(
        `UPDATE orders SET refund_id = $2, refunded_amount_paise = $3,
                           status = CASE WHEN $4 THEN 'refunded' ELSE 'partially_refunded' END,
                           updated_at = now()
          WHERE id = $1 AND status NOT IN ('refunded')`,
        [entityId, razorpayRefundId, totalRefunded, fullyRefunded]
      );
    } else {
      const table = ENTITY_TABLES[entityType];
      await client.query(
        `UPDATE ${table} SET refund_id = $2, refunded_amount_paise = $3,
                             payment_status = CASE WHEN $4 THEN 'refunded' ELSE 'partially_refunded' END,
                             updated_at = now()
          WHERE id = $1 AND payment_status NOT IN ('refunded')`,
        [entityId, razorpayRefundId, totalRefunded, fullyRefunded]
      );
    }

    await client.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES (NULL, 'refund_recorded_from_gateway', $1, $2, $3)`,
      [entityType, entityId, JSON.stringify({ razorpayRefundId, razorpayPaymentId, amountPaise, totalRefunded, fullyRefunded, eventId })]
    );

    logger.info('Recorded a refund created outside the admin panel', { entityType, entityId, razorpayRefundId, amountPaise });
  });
}

/**
 * Resolves refunds left in 'initiated' by a crash between the gateway call and
 * the outcome write. Run from scripts/reconcile-payments.js.
 *
 * Asks Razorpay what actually happened to each in-flight refund rather than
 * guessing — the whole point of recording intent first is that this question
 * has an answer.
 */
async function reconcileStuckRefunds(olderThanMinutes = 10) {
  const { rows } = await db.query(
    `SELECT id, entity_type, entity_id, razorpay_payment_id, amount_paise, idempotency_key
       FROM refunds
      WHERE status = 'initiated'
        AND created_at < now() - make_interval(mins => $1)`,
    [Math.max(1, Math.floor(olderThanMinutes))]
  );
  if (!rows.length) return { checked: 0, resolved: 0 };

  let resolved = 0;
  for (const row of rows) {
    try {
      const list = await razorpay.payments.fetchMultipleRefund(row.razorpay_payment_id);
      const items = (list && list.items) || [];
      // Exact identification via the ledger id we stamped into notes at issue
      // time. Falling back to an amount match would be wrong when a payment has
      // two partial refunds of the same value, so it is deliberately not done:
      // "no refund carries our id" is a definite answer, and a definite answer
      // is the whole reason intent is written first.
      const match = items.find(
        (r) => r && r.notes && String(r.notes.ledgerId) === String(row.id) && r.status !== 'failed'
      );
      if (match) {
        await db.query(
          `UPDATE refunds SET status = 'processed', razorpay_refund_id = $2, updated_at = now() WHERE id = $1`,
          [row.id, match.id]
        );
        logger.warn('Resolved a refund that was stuck in-flight', { ledgerId: row.id, razorpayRefundId: match.id });
      } else {
        await db.query(
          `UPDATE refunds SET status = 'failed', failure_reason = 'Not found at gateway during reconciliation', updated_at = now()
            WHERE id = $1`,
          [row.id]
        );
        logger.warn('Marked a stuck refund as failed — the gateway has no matching refund', { ledgerId: row.id });
      }
      resolved++;
    } catch (err) {
      logger.error('Could not reconcile stuck refund', err, { ledgerId: row.id });
    }
  }
  return { checked: rows.length, resolved };
}

module.exports = { issueRefund, recordExternalRefund, reconcileStuckRefunds, refundedTotalPaise };
