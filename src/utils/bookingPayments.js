const db = require('../config/db');
const razorpay = require('../config/razorpay');
const { serviceHasPublishedSlots, reserveSlot } = require('./bookingSlots');
const { logger } = require('./logger');

/**
 * Creates a booking (puja or astrology) and its associated Razorpay order,
 * with the price looked up server-side from booking_services — never trust an
 * amount the client claims. This mirrors reserveStockAndCreateOrder's "never
 * trust the client for money" principle.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY
 * ---------------------------------------------------------------------------
 * 1. CAPACITY (BIZ-02). If the service has published availability slots, one
 *    must be chosen and a seat is reserved inside the SAME transaction as the
 *    booking insert — so a failure anywhere rolls the seat back rather than
 *    leaking capacity. The rule deliberately mirrors the one this codebase
 *    already uses for product variants ("a product that HAS variants can only
 *    be bought through one of them"), which means services with no slots
 *    published behave exactly as they do today and this is safe to deploy
 *    before a single practitioner exists.
 *
 * 2. TRANSACTIONAL INSERT. The booking insert and the slot reservation are one
 *    transaction. The Razorpay call stays OUTSIDE it — a network call has no
 *    business holding a database transaction open, and it cannot be rolled
 *    back anyway.
 *
 * 3. AMOUNT TYPE (DATA-02). service.price_paise is a BIGINT, which node-pg used
 *    to return as a string, and that string went straight to Razorpay as the
 *    `amount`. config/db.js now parses INT8 to a number; Number() here is the
 *    belt-and-braces that keeps this correct regardless.
 */
async function createBookingWithPayment({ bookingType, userId, serviceId, slotId, fields }) {
  if (!['puja', 'astrology'].includes(bookingType)) {
    throw Object.assign(new Error('Invalid booking type.'), { status: 400 });
  }
  if (!serviceId || typeof serviceId !== 'string') {
    throw Object.assign(new Error('A service must be selected.'), { status: 400 });
  }

  const table = bookingType === 'puja' ? 'puja_bookings' : 'astrology_bookings';

  // ---- Everything that must be atomic, in one transaction -----------------
  const created = await db.withTransaction(async (client) => {
    const { rows: services } = await client.query(
      'SELECT id, name, price_paise FROM booking_services WHERE id = $1 AND service_type = $2 AND is_active = true',
      [serviceId, bookingType]
    );
    if (!services.length) {
      throw Object.assign(new Error('The selected service is no longer available.'), { status: 400 });
    }
    const service = services[0];
    const amountPaise = Number(service.price_paise);
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw Object.assign(new Error('This service is not correctly priced. Please contact us.'), { status: 409 });
    }

    let reservedSlot = null;
    if (slotId) {
      ({ slot: reservedSlot } = await reserveSlot(client, { slotId, serviceId, serviceType: bookingType }));
    } else if (await serviceHasPublishedSlots(client, serviceId, bookingType)) {
      // The same shape of guard as "please choose an option for this product".
      throw Object.assign(
        new Error('Please choose an available time slot for this service before continuing.'),
        { status: 400 }
      );
    }

    const columns = ['user_id', 'service_id', 'contact_name', 'contact_phone', 'preferred_date',
      'preferred_time_slot', 'amount_paise', 'payment_status'];
    const values = [userId, serviceId, fields.contact_name, fields.contact_phone, fields.preferred_date,
      fields.preferred_time_slot, amountPaise, 'unpaid'];

    if (reservedSlot) {
      columns.push('slot_id', 'scheduled_at');
      values.push(reservedSlot.id, reservedSlot.starts_at);
      if (reservedSlot.practitioner_id) {
        columns.push(bookingType === 'puja' ? 'pandit_id' : 'astrologer_id');
        values.push(reservedSlot.practitioner_id);
      }
    }

    if (bookingType === 'puja') {
      columns.push('puja_type', 'preferred_mode', 'notes');
      values.push(service.name, fields.preferred_mode || null, fields.notes || null);
    } else {
      columns.push('consultation_mode', 'birth_details');
      // birth_details is an OBJECT, which pg serialises to jsonb correctly.
      // (Arrays are the case that needs JSON.stringify — see the note in
      // products.routes.js on variant option_values.)
      values.push(fields.consultation_mode, fields.birth_details || null);
    }

    const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
    const { rows: bookingRows } = await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) RETURNING id`,
      values
    );

    return {
      bookingId: bookingRows[0].id,
      amountPaise,
      slot: reservedSlot
    };
  });

  // ---- The gateway call, outside the transaction --------------------------
  try {
    const razorpayOrder = await razorpay.orders.create({
      amount: created.amountPaise,
      currency: 'INR',
      receipt: `${bookingType}-${created.bookingId}`.slice(0, 40),
      // Distinguishes this from a product-order payment in the shared webhook
      // handler (src/routes/payments.routes.js), which branches on whichever of
      // these two note keys is present.
      notes: { bookingId: created.bookingId, bookingType }
    });
    await db.query(`UPDATE ${table} SET razorpay_order_id = $1 WHERE id = $2`, [razorpayOrder.id, created.bookingId]);

    return {
      bookingId: created.bookingId,
      razorpayOrderId: razorpayOrder.id,
      amountPaise: created.amountPaise,
      keyId: process.env.RAZORPAY_KEY_ID,
      slot: created.slot
        ? { id: created.slot.id, startsAt: created.slot.starts_at, label: created.slot.label }
        : null
    };
  } catch (err) {
    // The gateway call failed after the booking row was created. Release the
    // seat and remove the row rather than leaving an orphaned, permanently
    // unpaid booking holding capacity in the admin dashboard.
    //
    // Wrapped in its own try/catch: if THIS fails too, the customer still needs
    // a clear answer, and the booking expiry sweep (BIZ-03) will clean up the
    // orphan within the reservation window. That is the same reasoning as the
    // compensating call in payments.routes.js — a cleanup failure must never
    // replace the real error with a confusing one, or crash the process.
    try {
      await db.withTransaction(async (client) => {
        const { rows } = await client.query(`SELECT slot_id FROM ${table} WHERE id = $1`, [created.bookingId]);
        if (rows.length && rows[0].slot_id) {
          await client.query(
            'UPDATE availability_slots SET booked_count = GREATEST(booked_count - 1, 0), updated_at = now() WHERE id = $1',
            [rows[0].slot_id]
          );
        }
        await client.query(`DELETE FROM ${table} WHERE id = $1`, [created.bookingId]);
      });
    } catch (cleanupErr) {
      logger.error('Could not clean up booking after gateway failure — expiry sweep will recover it',
        cleanupErr, { bookingId: created.bookingId, table });
    }

    logger.error('Razorpay order creation failed for booking', err, { bookingType, serviceId });
    throw Object.assign(new Error('Could not connect to the payment gateway. Please try again.'), { status: 502 });
  }
}

module.exports = { createBookingWithPayment };
