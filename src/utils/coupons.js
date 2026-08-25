const db = require('../config/db');

/**
 * Validates a coupon code against a cart subtotal and a specific customer,
 * and computes the exact discount. This is the ONE place discount math
 * happens — both the "Apply" button at checkout (a preview, no state
 * change) and the real order-creation redemption call this same function,
 * so there is no way for the two to disagree with each other.
 *
 * @param {object} params
 * @param {object} params.client - a DB client. Pass a transaction client
 *   (with the coupon row already locked via lockForUpdate=true) when this
 *   is being called as part of actually redeeming the coupon at checkout;
 *   pass the plain db module for a read-only preview.
 * @param {string} params.code - raw code as typed by the customer
 * @param {string} params.userId
 * @param {number} params.subtotalPaise - cart subtotal BEFORE discount
 * @param {boolean} [params.lockForUpdate] - lock the coupon row (only valid
 *   inside a transaction) so two concurrent redemptions of a limited coupon
 *   can't both pass the usage-limit check
 * @returns {Promise<{coupon: object, discountPaise: number}>}
 * @throws {Error & {status: number}} with a customer-facing message on any
 *   invalid/expired/exhausted/not-yet-met-minimum condition
 */
async function validateAndComputeCoupon({ client, code, userId, subtotalPaise, lockForUpdate }) {
  if (!code || typeof code !== 'string') {
    throw Object.assign(new Error('Please enter a coupon code.'), { status: 400 });
  }
  const normalizedCode = code.trim().toUpperCase();
  const runner = client || db;

  const { rows } = await runner.query(
    `SELECT * FROM coupons WHERE code = $1${lockForUpdate ? ' FOR UPDATE' : ''}`,
    [normalizedCode]
  );
  if (!rows.length) {
    throw Object.assign(new Error('This coupon code is not valid.'), { status: 404 });
  }
  const coupon = rows[0];

  if (!coupon.is_active) {
    throw Object.assign(new Error('This coupon is no longer active.'), { status: 400 });
  }
  const now = new Date();
  if (coupon.valid_from && new Date(coupon.valid_from) > now) {
    throw Object.assign(new Error('This coupon is not active yet.'), { status: 400 });
  }
  if (coupon.valid_until && new Date(coupon.valid_until) < now) {
    throw Object.assign(new Error('This coupon has expired.'), { status: 400 });
  }
  if (subtotalPaise < Number(coupon.min_order_paise)) {
    const minRupees = (Number(coupon.min_order_paise) / 100).toFixed(0);
    throw Object.assign(new Error(`This coupon needs a minimum order of ₹${minRupees}.`), { status: 400 });
  }
  if (coupon.usage_limit_total !== null && coupon.used_count >= coupon.usage_limit_total) {
    throw Object.assign(new Error('This coupon has reached its usage limit.'), { status: 400 });
  }

  const { rows: customerUses } = await runner.query(
    'SELECT COUNT(*)::int AS cnt FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2',
    [coupon.id, userId]
  );
  if (customerUses[0].cnt >= coupon.usage_limit_per_customer) {
    throw Object.assign(new Error('You have already used this coupon the maximum number of times.'), { status: 400 });
  }

  // Compute the discount. Every branch is clamped so a coupon can never
  // discount more than the order is actually worth, regardless of how it
  // was configured — a defensive floor against a misconfigured coupon
  // accidentally producing a negative or free order.
  let discountPaise;
  if (coupon.discount_type === 'percentage') {
    discountPaise = Math.round((subtotalPaise * Number(coupon.discount_percent)) / 100);
    if (coupon.max_discount_paise !== null) {
      discountPaise = Math.min(discountPaise, Number(coupon.max_discount_paise));
    }
  } else {
    discountPaise = Number(coupon.discount_value_paise);
  }
  discountPaise = Math.max(0, Math.min(discountPaise, subtotalPaise));

  return { coupon, discountPaise };
}

/**
 * Records a redemption and increments the coupon's usage counter. Must be
 * called inside the SAME transaction as the order creation it belongs to —
 * if the order transaction rolls back (e.g. stock became unavailable), this
 * rolls back with it, so a failed checkout can never burn a coupon use.
 */
async function recordCouponRedemption(client, { couponId, userId, orderId, discountPaise }) {
  await client.query(
    `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id, discount_applied_paise)
     VALUES ($1,$2,$3,$4)`,
    [couponId, userId, orderId, discountPaise]
  );
  await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [couponId]);
}

module.exports = { validateAndComputeCoupon, recordCouponRedemption };
