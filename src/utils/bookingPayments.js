const db = require('../config/db');
const razorpay = require('../config/razorpay');

/**
 * Creates a booking (puja or astrology) and its associated Razorpay order,
 * with the price looked up server-side from booking_services — never trust
 * an amount the client claims. This mirrors reserveStockAndCreateOrder's
 * "never trust the client for money" principle, and replaces what used to
 * be a completely fake confirmation with no backend call at all.
 *
 * @param {object} params
 * @param {'puja'|'astrology'} params.bookingType
 * @param {string} params.userId
 * @param {string} params.serviceId
 * @param {object} params.fields - the booking-type-specific columns to insert
 *   (contact_name, contact_phone, preferred_date, preferred_time_slot, notes,
 *   preferred_mode for puja; consultation_mode, birth_details for astrology)
 * @returns {Promise<{bookingId: string, razorpayOrderId: string, amountPaise: number, keyId: string}>}
 */
async function createBookingWithPayment({ bookingType, userId, serviceId, fields }) {
  if (!['puja', 'astrology'].includes(bookingType)) {
    throw Object.assign(new Error('Invalid booking type.'), { status: 400 });
  }
  if (!serviceId || typeof serviceId !== 'string') {
    throw Object.assign(new Error('A service must be selected.'), { status: 400 });
  }

  const { rows: services } = await db.query(
    'SELECT id, name, price_paise FROM booking_services WHERE id = $1 AND service_type = $2 AND is_active = true',
    [serviceId, bookingType]
  );
  if (!services.length) {
    throw Object.assign(new Error('The selected service is no longer available.'), { status: 400 });
  }
  const service = services[0];

  const table = bookingType === 'puja' ? 'puja_bookings' : 'astrology_bookings';
  const columns = ['user_id', 'service_id', 'contact_name', 'contact_phone', 'preferred_date', 'preferred_time_slot', 'amount_paise', 'payment_status'];
  const values = [userId, serviceId, fields.contact_name, fields.contact_phone, fields.preferred_date, fields.preferred_time_slot, service.price_paise, 'unpaid'];

  if (bookingType === 'puja') {
    columns.push('puja_type', 'preferred_mode', 'notes');
    values.push(service.name, fields.preferred_mode || null, fields.notes || null);
  } else {
    columns.push('consultation_mode', 'birth_details');
    values.push(fields.consultation_mode, fields.birth_details || null);
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
  const { rows: bookingRows } = await db.query(
    `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) RETURNING id`,
    values
  );
  const bookingId = bookingRows[0].id;

  try {
    const razorpayOrder = await razorpay.orders.create({
      amount: service.price_paise,
      currency: 'INR',
      receipt: `${bookingType}-${bookingId}`.slice(0, 40),
      // Distinguishes this from a product-order payment in the shared webhook
      // handler (src/routes/payments.routes.js), which branches on whichever
      // of these two note keys is present.
      notes: { bookingId, bookingType }
    });
    await db.query(`UPDATE ${table} SET razorpay_order_id = $1 WHERE id = $2`, [razorpayOrder.id, bookingId]);
    return { bookingId, razorpayOrderId: razorpayOrder.id, amountPaise: service.price_paise, keyId: process.env.RAZORPAY_KEY_ID };
  } catch (err) {
    // The Razorpay call failed after the booking row was created — delete it
    // rather than leave an orphaned, permanently-unpaid booking sitting in
    // the admin dashboard with no way to complete payment.
    await db.query(`DELETE FROM ${table} WHERE id = $1`, [bookingId]);
    throw Object.assign(new Error('Could not connect to the payment gateway. Please try again.'), { status: 502 });
  }
}

module.exports = { createBookingWithPayment };
