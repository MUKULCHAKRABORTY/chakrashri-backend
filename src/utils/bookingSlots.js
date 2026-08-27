/**
 * Booking capacity — closes BIZ-02 and BIZ-03.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * Products cannot oversell: the cart is aggregated before checking, rows are
 * locked FOR UPDATE inside a transaction, and the decrement carries a
 * `stock_qty >= $1` guard that simply will not match if the logic above it is
 * ever wrong. Three independent layers.
 *
 * Services had none of that. `preferred_date` and `preferred_time_slot` were
 * free text with no availability table, no capacity limit and no uniqueness, so
 * twenty customers could book "Griha Pravesh Puja, 14 Sept, morning" and all
 * twenty were charged. The failure surfaced on the day, when one pandit could
 * not be in twenty homes — every one of those a refund plus a reputational cost
 * in a category that runs entirely on trust.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN
 * ---------------------------------------------------------------------------
 * Deliberately the SAME shape as product stock, because that pattern is already
 * proven in this codebase and a second, different concurrency model would be a
 * second thing to get wrong:
 *
 *   SELECT ... FOR UPDATE      -> serialise concurrent bookers of one slot
 *   UPDATE ... WHERE booked_count < capacity  -> guard that cannot overbook
 *   CHECK (booked_count <= capacity)          -> database-level backstop
 *
 * ---------------------------------------------------------------------------
 * BACKWARD COMPATIBILITY — the important part
 * ---------------------------------------------------------------------------
 * Requiring a slot outright would break every existing booking flow the moment
 * this deploys, before the client has entered a single practitioner. So the
 * rule mirrors the one this codebase already uses for product variants:
 *
 *   "A product that HAS variants can only be bought through one of them."
 *   "A service that HAS published slots can only be booked through one of them."
 *
 * With no slots published, bookings behave exactly as they do today. The moment
 * the first slot is published for a service, capacity starts being enforced for
 * it. That makes this safe to deploy immediately and adopt gradually.
 */
const db = require('../config/db');
const { logger } = require('./logger');

/**
 * Does this service have any bookable published slots? If so, a slot becomes
 * mandatory for it — see the note above.
 */
async function serviceHasPublishedSlots(client, serviceId, serviceType) {
  const { rows } = await client.query(
    `SELECT 1 FROM availability_slots
      WHERE is_active = true
        AND starts_at > now()
        AND service_type = $2
        AND (service_id = $1 OR service_id IS NULL)
      LIMIT 1`,
    [serviceId, serviceType]
  );
  return rows.length > 0;
}

/**
 * Reserves one seat on a slot. MUST be called inside the same transaction that
 * creates the booking, so a failure to insert the booking releases the seat
 * automatically rather than leaking capacity.
 *
 * @returns {{slot: object}} the locked slot row, for the caller to snapshot
 * @throws {Error & {status:number}} with a customer-facing message
 */
async function reserveSlot(client, { slotId, serviceId, serviceType }) {
  const { rows } = await client.query(
    `SELECT id, practitioner_id, service_id, service_type, starts_at, ends_at, label, capacity, booked_count
       FROM availability_slots
      WHERE id = $1 AND is_active = true
      FOR UPDATE`,
    [slotId]
  );
  if (!rows.length) {
    throw Object.assign(new Error('That time slot is no longer available. Please pick another.'), { status: 409 });
  }
  const slot = rows[0];

  if (slot.service_type !== serviceType) {
    throw Object.assign(new Error('That time slot is not available for this service.'), { status: 400 });
  }
  // service_id NULL means "any service of this type" — a general availability
  // window rather than one tied to a specific offering.
  if (slot.service_id && slot.service_id !== serviceId) {
    throw Object.assign(new Error('That time slot is not available for this service.'), { status: 400 });
  }
  // Compared in the database, not in Node: `now()` is authoritative and
  // timezone-correct regardless of what the application server thinks the time
  // is, which is the root of BIZ-06.
  const { rows: freshness } = await client.query(
    'SELECT ($1::timestamptz > now()) AS is_future', [slot.starts_at]
  );
  if (!freshness[0].is_future) {
    throw Object.assign(new Error('That time slot has already passed. Please pick another.'), { status: 400 });
  }

  const { rowCount } = await client.query(
    `UPDATE availability_slots
        SET booked_count = booked_count + 1, updated_at = now()
      WHERE id = $1 AND booked_count < capacity`,
    [slotId]
  );
  if (rowCount === 0) {
    // The guard did its job: someone else took the last seat between the read
    // and the write, or capacity was reduced under us.
    throw Object.assign(new Error('That time slot has just been taken. Please pick another.'), { status: 409 });
  }

  return { slot };
}

/**
 * Releases a seat and marks the booking terminal. Idempotent and row-locked,
 * exactly like restoreOrderStock() — because the same three callers race on it
 * (the payment-failed webhook, an admin cancelling, and the expiry sweep) and
 * a seat must only ever be given back once.
 *
 * @param {string} table 'puja_bookings' | 'astrology_bookings'
 * @param {string} bookingId
 * @param {string} finalPaymentStatus 'failed' | 'refunded'
 * @param {string} reason for the audit log
 */
const RELEASED_PAYMENT_STATUSES = new Set(['failed', 'refunded', 'partially_refunded']);

/**
 * Frees a booking's seat INSIDE a transaction the caller already owns, without
 * checking or changing payment_status.
 *
 * Exists for the same reason as restoreOrderStockInTransaction() — see the long
 * note on that function. In short: releaseBookingSlot() no-ops when it sees a
 * payment status that is already terminal, so a caller that has ALREADY
 * committed `payment_status = 'refunded'` and then calls it trips its own guard,
 * and the practitioner's seat is never freed. The refund path did exactly that:
 * a refunded booking held its slot forever, with no error and no log line.
 */
async function releaseBookingSlotInTransaction(client, table, bookingId, reason, adminUserId) {
  if (!['puja_bookings', 'astrology_bookings'].includes(table)) {
    throw new Error(`releaseBookingSlotInTransaction called with an unknown table: ${table}`);
  }
  const { rows } = await client.query(`SELECT slot_id FROM ${table} WHERE id = $1`, [bookingId]);
  if (!rows.length) return { released: false, reason: 'booking_not_found' };

  if (rows[0].slot_id) {
    // GREATEST(...,0) rather than a bare decrement: if the counter were ever
    // corrected by hand, this must not drive it negative and trip the CHECK
    // constraint, which would abort a release that should always succeed.
    await client.query(
      `UPDATE availability_slots
          SET booked_count = GREATEST(booked_count - 1, 0), updated_at = now()
        WHERE id = $1`,
      [rows[0].slot_id]
    );
  }

  await client.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
     VALUES ($1, 'booking_slot_released', $2, $3, $4)`,
    [adminUserId || null, table === 'puja_bookings' ? 'puja_booking' : 'astrology_booking', bookingId,
      JSON.stringify({ reason, slotId: rows[0].slot_id })]
  );

  return { released: true, slotId: rows[0].slot_id };
}

async function releaseBookingSlot(table, bookingId, finalPaymentStatus, reason, adminUserId) {
  if (!['puja_bookings', 'astrology_bookings'].includes(table)) {
    throw new Error(`releaseBookingSlot called with an unknown table: ${table}`);
  }
  if (!RELEASED_PAYMENT_STATUSES.has(finalPaymentStatus)) {
    throw new Error(`releaseBookingSlot called with a non-terminal payment status: ${finalPaymentStatus}`);
  }

  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, slot_id, payment_status, status FROM ${table} WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    if (!rows.length) return { released: false, reason: 'booking_not_found' };
    const booking = rows[0];

    if (RELEASED_PAYMENT_STATUSES.has(booking.payment_status)) {
      return { released: false, reason: 'already_released', previousStatus: booking.payment_status };
    }

    const released = await releaseBookingSlotInTransaction(client, table, bookingId, reason, adminUserId);

    await client.query(
      `UPDATE ${table}
          SET payment_status = $2,
              status = CASE WHEN status IN ('requested','confirmed') THEN 'cancelled' ELSE status END,
              updated_at = now()
        WHERE id = $1`,
      [bookingId, finalPaymentStatus]
    );

    return { released: true, slotId: released.slotId, previousStatus: booking.payment_status };
  });
}

/**
 * Public availability listing. Only ever returns future, active slots with room
 * left — the storefront should not be able to render a slot it cannot book,
 * which is the UI half of the same problem.
 */
async function listAvailableSlots({ serviceType, serviceId, fromDate, days }) {
  const horizon = Math.min(90, Math.max(1, parseInt(days, 10) || 30));
  const { rows } = await db.query(
    `SELECT s.id, s.starts_at, s.ends_at, s.label, s.capacity, s.booked_count,
            (s.capacity - s.booked_count) AS seats_left,
            p.id AS practitioner_id, p.full_name AS practitioner_name
       FROM availability_slots s
       LEFT JOIN practitioners p ON p.id = s.practitioner_id AND p.is_active = true
      WHERE s.is_active = true
        AND s.service_type = $1
        AND ($2::uuid IS NULL OR s.service_id = $2::uuid OR s.service_id IS NULL)
        AND s.booked_count < s.capacity
        AND s.starts_at > GREATEST(now(), COALESCE($3::timestamptz, now()))
        AND s.starts_at < now() + ($4 || ' days')::interval
      ORDER BY s.starts_at ASC
      LIMIT 500`,
    [serviceType, serviceId || null, fromDate || null, horizon]
  );
  return rows;
}

/**
 * Sweeps unpaid bookings past the reservation window, releasing their slots.
 * BIZ-03: the orders sweep existed; the booking equivalent did not, so an
 * abandoned booking sat as a live request forever — and once capacity is
 * enforced, that becomes a denial-of-inventory vector.
 */
async function releaseExpiredBookings(expiryMinutes) {
  const minutes = Number.isFinite(expiryMinutes) && expiryMinutes > 0 ? Math.floor(expiryMinutes) : 30;
  const results = { released: 0, skipped: 0, failed: 0 };

  for (const table of ['puja_bookings', 'astrology_bookings']) {
    // make_interval() with a bound parameter rather than string interpolation:
    // the value is already sanitised above, but building SQL by concatenation
    // is a habit worth not having anywhere near a scheduled job.
    const { rows: expired } = await db.query(
      `SELECT id FROM ${table}
        WHERE payment_status = 'unpaid'
          AND created_at < now() - make_interval(mins => $1)`,
      [minutes]
    );
    for (const row of expired) {
      try {
        const result = await releaseBookingSlot(table, row.id, 'failed', 'expired_abandoned_booking');
        if (result.released) results.released++;
        else results.skipped++;
      } catch (err) {
        results.failed++;
        logger.error('Failed to release expired booking', err, { table, bookingId: row.id });
      }
    }
  }
  return results;
}

module.exports = {
  serviceHasPublishedSlots,
  reserveSlot,
  releaseBookingSlot,
  releaseBookingSlotInTransaction,
  listAvailableSlots,
  releaseExpiredBookings,
  RELEASED_PAYMENT_STATUSES
};
