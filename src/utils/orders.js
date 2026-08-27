const crypto = require('crypto');
const db = require('../config/db');
const { validateAndComputeCoupon, recordCouponRedemption } = require('./coupons');
const { DEFAULTS: SETTINGS_DEFAULTS } = require('./settings');

/**
 * Builds the out-of-stock message shown at checkout. Tells the customer both
 * what IS available and exactly how many to remove, rather than only saying
 * "not enough stock" and leaving them to work it out themselves.
 * Exported so the exact wording is covered by tests.
 */
function stockShortfallMessage(productName, available, requested) {
  if (available <= 0) {
    return `"${productName}" is out of stock right now.`;
  }
  const excess = requested - available;
  return `Stock available for "${productName}": ${available}. Kindly remove ${excess} to buy it.`;
}

/**
 * Validates raw cart items and aggregates duplicate entries into a single
 * quantity per (product, variant) pair. Pulled out as its own pure function
 * (no DB, no I/O) specifically so it can be unit-tested directly — this is
 * the exact logic that, when it didn't exist, allowed the same product
 * listed twice in one cart to pass two independent stock checks and
 * oversell. Testing this function directly, rather than a reimplementation
 * of it, is what actually proves the fix holds.
 *
 * A variantId is optional per item — when present, the item is aggregated
 * (and later stock-checked) against that SPECIFIC variant, not the base
 * product, since two different variants (e.g. "Red" vs "Blue") are
 * independent purchasable units with their own stock.
 *
 * @param {Array<{productId: string, variantId?: string|null, quantity: number}>} items
 * @returns {Array<{productId: string, variantId: string|null, quantity: number}>}
 * @throws {Error & {status: number}} on invalid input
 */
function validateAndAggregateCart(items) {
  if (!Array.isArray(items) || !items.length) {
    throw Object.assign(new Error('Cart is empty.'), { status: 400 });
  }
  // A bounded cart. Without this, a client could post 100,000 line items and
  // every one of them would be validated, aggregated and turned into a row
  // lock — a cheap way to hold a transaction open across the whole catalog.
  if (items.length > 100) {
    throw Object.assign(new Error('Your cart has too many different items. Please split the order.'), { status: 400 });
  }
  for (const item of items) {
    if (
      !item ||
      typeof item.productId !== 'string' ||
      (item.variantId !== undefined && item.variantId !== null && typeof item.variantId !== 'string') ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 50
    ) {
      throw Object.assign(new Error('Cart contains an invalid item or quantity.'), { status: 400 });
    }
  }

  const aggregated = Object.values(
    items.reduce((acc, item) => {
      const variantId = item.variantId || null;
      const key = item.productId + '::' + (variantId || '');
      if (!acc[key]) acc[key] = { productId: item.productId, variantId, quantity: 0 };
      acc[key].quantity += item.quantity;
      return acc;
    }, {})
  );

  for (const item of aggregated) {
    if (item.quantity > 50) {
      throw Object.assign(new Error('Cart contains an invalid item or quantity.'), { status: 400 });
    }
  }

  return aggregated;
}

/**
 * Pure money math: subtotal, free-shipping threshold, GST, and (optionally)
 * a coupon discount. Every value in and out is an integer number of paise;
 * nothing here ever touches a float, which is what avoids the classic
 * "0.1 + 0.2" rounding-drift class of bug in financial calculations.
 *
 * Discount handling, spelled out since it's the one place with a genuine
 * business-logic choice rather than a purely mechanical calculation:
 *  - The free-shipping threshold is evaluated on the ORIGINAL subtotal
 *    (before discount) — it's based on the value of what's being bought,
 *    not what ends up being paid after a coupon.
 *  - GST is scaled proportionally to the discount ratio rather than
 *    allocated per-line-item. E.g. a 20%-off coupon reduces the GST total
 *    by 20% too. This is a simplification of India's actual GST-on-discount
 *    rules (which can depend on how the discount is structured/disclosed on
 *    the invoice) — flagged here for your accountant/CA to confirm is
 *    correct for your specific coupon structures before relying on it for
 *    tax filing.
 *  - The discount can never exceed the subtotal (validateAndComputeCoupon
 *    already clamps this, but it's re-clamped here too as a second,
 *    independent safety net).
 *
 * HYG-03: the shipping threshold and flat rate used to be compiled in as
 * literals, so a festive free-shipping promotion needed a code change and a
 * deploy. They now come from site_settings via the optional `pricing`
 * argument — and default to exactly the previous constants, so calling this
 * with two arguments behaves identically to before.
 *
 * @param {Array<{lineTotalPaise: number, gstRate: number}>} orderItems
 * @param {number} [discountPaise] - already-validated discount from a coupon, if any
 * @param {{free_shipping_threshold_paise?: number, shipping_flat_paise?: number}} [pricing]
 * @returns {{subtotalPaise: number, shippingPaise: number, gstPaise: number, discountPaise: number, totalPaise: number}}
 */
function calculateOrderTotals(orderItems, discountPaise, pricing) {
  const freeShippingThreshold = Number(
    (pricing && pricing.free_shipping_threshold_paise) ?? SETTINGS_DEFAULTS.free_shipping_threshold_paise
  );
  const shippingFlat = Number(
    (pricing && pricing.shipping_flat_paise) ?? SETTINGS_DEFAULTS.shipping_flat_paise
  );

  const subtotalPaise = orderItems.reduce((sum, i) => sum + Number(i.lineTotalPaise), 0);
  const shippingPaise = subtotalPaise >= freeShippingThreshold ? 0 : shippingFlat;
  const originalGstPaise = Math.round(
    orderItems.reduce((sum, i) => sum + (Number(i.lineTotalPaise) * Number(i.gstRate)) / 100, 0)
  );

  const safeDiscount = Math.max(0, Math.min(Number(discountPaise) || 0, subtotalPaise));
  const discountedSubtotal = subtotalPaise - safeDiscount;
  const gstPaise = subtotalPaise > 0
    ? Math.round(originalGstPaise * (discountedSubtotal / subtotalPaise))
    : 0;

  return {
    subtotalPaise,
    shippingPaise,
    gstPaise,
    discountPaise: safeDiscount,
    totalPaise: discountedSubtotal + shippingPaise + gstPaise
  };
}

/**
 * Loads the shipping address, PROVING it belongs to the buyer, and returns
 * both the row and an immutable snapshot of it.
 *
 * AUTH-01 — the ownership half. shippingAddressId used to be validated only
 * as "a non-empty string" and inserted straight into orders. The foreign key
 * required the address to exist, but nothing required it to belong to
 * req.user.id — so an authenticated customer could attach a stranger's
 * address to their own order, and the admin order-detail view would then
 * render that stranger's name, phone, email and street back to them. Every
 * other address route was correctly scoped with `AND user_id = $1`; this one
 * path was not.
 *
 * DATA-01 — the snapshot half. order_items freeze the product name, price and
 * variant at purchase time so history stays accurate. The address was a live
 * foreign key, so a customer who moved house and edited their saved address
 * silently rewrote the delivery address on every order they had ever placed.
 * Both problems are solved by the same query, so they are solved together.
 */
async function loadOwnedAddressSnapshot(client, addressId, userId) {
  const { rows } = await client.query(
    `SELECT id, full_name, phone, email, line1, line2, city, state, pincode, country
       FROM addresses
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [addressId, userId]
  );
  if (!rows.length) {
    // Deliberately the same message whether the address does not exist or
    // belongs to someone else — distinguishing them would turn this into an
    // oracle for probing which address IDs are real.
    throw Object.assign(
      new Error('That delivery address could not be found on your account.'),
      { status: 403 }
    );
  }
  const a = rows[0];
  return {
    address: a,
    snapshot: {
      full_name: a.full_name,
      phone: a.phone,
      email: a.email,
      line1: a.line1,
      line2: a.line2,
      city: a.city,
      state: a.state,
      pincode: a.pincode,
      country: a.country,
      snapshot_source: 'checkout'
    }
  };
}

/**
 * Validates a cart, aggregates duplicate product entries, atomically checks
 * and reserves stock (row-locked, oversell-proof), applies a coupon if one
 * is supplied (also row-locked, so two concurrent checkouts can't both
 * slip past a usage limit), and inserts the order + order_items — all
 * inside one database transaction. Shared by every checkout path
 * (Razorpay, COD, and any future payment method) so the correctness-
 * critical parts of checkout exist in exactly one place.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {Array<{productId: string, variantId?: string, quantity: number}>} params.items
 * @param {string|null} params.shippingAddressId
 * @param {'razorpay'|'cod'} params.paymentMethod
 * @param {string} params.initialStatus - 'pending' for razorpay (awaiting payment), 'processing' for cod
 * @param {string|null} [params.couponCode]
 * @param {object} [params.settings] - resolved site settings; defaults preserve prior behaviour
 * @returns {Promise<{id, number, total, discountPaise, couponCode, shippingSnapshot}>}
 */
async function reserveStockAndCreateOrder({
  userId, items, shippingAddressId, paymentMethod, initialStatus, couponCode, settings
}) {
  const aggregatedItems = validateAndAggregateCart(items);
  const config = settings || SETTINGS_DEFAULTS;

  return db.withTransaction(async (client) => {
    // Ownership + snapshot first: no point locking half the catalog for an
    // order that is about to be rejected. Skipped entirely when no address is
    // supplied, which is the case for callers that do not ship goods.
    let shippingSnapshot = null;
    if (shippingAddressId) {
      ({ snapshot: shippingSnapshot } = await loadOwnedAddressSnapshot(client, shippingAddressId, userId));
    }

    const productIds = [...new Set(aggregatedItems.map((i) => i.productId))];
    // DB-01: ORDER BY id makes every transaction acquire row locks in the SAME
    // total order. Without it Postgres locks in whatever order the chosen plan
    // produces, so two customers checking out carts {A,B} and {B,A} at the same
    // instant can each hold one lock and wait for the other — Postgres kills
    // one with SQLSTATE 40P01 and the customer sees a failed checkout. With a
    // consistent order that cycle cannot form. (config/db.js also retries the
    // two contention SQLSTATEs, as a second line of defence.)
    const { rows: products } = await client.query(
      `SELECT id, name, price_paise, stock_qty, gst_rate FROM products
       WHERE id = ANY($1) AND is_active = true
       ORDER BY id
       FOR UPDATE`,
      [productIds]
    );

    // Variant rows are locked too (FOR UPDATE) for the same reason product
    // rows are — two concurrent checkouts for the last unit of "Red / M"
    // must not both pass the stock check against the same stale snapshot.
    // Same ORDER BY, same reason.
    const variantIds = aggregatedItems.filter((i) => i.variantId).map((i) => i.variantId);
    let variants = [];
    if (variantIds.length) {
      const { rows } = await client.query(
        'SELECT * FROM product_variants WHERE id = ANY($1) AND is_active = true ORDER BY id FOR UPDATE',
        [variantIds]
      );
      variants = rows;
    }

    // Which of these products actually have active variants? A product with
    // variants can ONLY be bought through one of them.
    //
    // This guard is load-bearing, not cosmetic: products.stock_qty for a
    // variant product is now derived by a database trigger from the variant
    // sum. If a "base product" purchase were allowed, its decrement to
    // products.stock_qty would be immediately overwritten by the trigger on
    // the next variant change — silently erasing the sale from inventory and
    // handing out free stock. Rejecting it here is what makes the derived
    // model safe.
    const { rows: variantCounts } = await client.query(
      `SELECT product_id, COUNT(*)::int AS cnt FROM product_variants
       WHERE product_id = ANY($1) AND is_active = true GROUP BY product_id`,
      [productIds]
    );
    const hasVariants = new Set(variantCounts.filter((r) => r.cnt > 0).map((r) => r.product_id));

    const orderItems = aggregatedItems.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      if (!product) throw Object.assign(new Error('One of the items in your cart is no longer available.'), { status: 400 });

      if (!item.variantId && hasVariants.has(product.id)) {
        throw Object.assign(
          new Error(`Please choose an option for "${product.name}" before checking out.`),
          { status: 400 }
        );
      }

      if (item.variantId) {
        const variant = variants.find((v) => v.id === item.variantId && v.product_id === item.productId);
        if (!variant) {
          throw Object.assign(new Error(`The selected option for "${product.name}" is no longer available.`), { status: 400 });
        }
        if (variant.stock_qty < item.quantity) {
          throw Object.assign(new Error(stockShortfallMessage(product.name, variant.stock_qty, item.quantity)), { status: 409 });
        }
        // A variant's own price overrides the base product price when set;
        // NULL means "inherit the product's price" — this lets an admin
        // price only the variants that differ, without repricing every one.
        // Number() on both sides: BIGINT now parses to a number in
        // config/db.js, but being explicit here means this function stays
        // correct even when handed rows from a caller that did not.
        const unitPrice = variant.price_paise != null ? Number(variant.price_paise) : Number(product.price_paise);
        return {
          productId: product.id,
          variantId: variant.id,
          variantSnapshot: variant.option_values,
          name: product.name,
          unitPricePaise: unitPrice,
          quantity: item.quantity,
          lineTotalPaise: unitPrice * item.quantity,
          gstRate: Number(product.gst_rate),
          isVariant: true
        };
      }

      if (product.stock_qty < item.quantity) {
        throw Object.assign(new Error(stockShortfallMessage(product.name, product.stock_qty, item.quantity)), { status: 409 });
      }
      const unitPrice = Number(product.price_paise);
      return {
        productId: product.id,
        variantId: null,
        variantSnapshot: null,
        name: product.name,
        unitPricePaise: unitPrice,
        quantity: item.quantity,
        lineTotalPaise: unitPrice * item.quantity,
        gstRate: Number(product.gst_rate),
        isVariant: false
      };
    });

    // Decrement stock — variant stock for variant items, product stock
    // otherwise. Same WHERE-clause backstop as before: the UPDATE itself
    // can never take stock below zero even if application logic upstream
    // were ever wrong, because the row simply won't match if insufficient.
    for (const item of orderItems) {
      if (item.isVariant) {
        const { rowCount } = await client.query(
          'UPDATE product_variants SET stock_qty = stock_qty - $1 WHERE id = $2 AND stock_qty >= $1',
          [item.quantity, item.variantId]
        );
        if (rowCount === 0) {
          throw Object.assign(new Error(`"${item.name}" (selected option) no longer has enough stock.`), { status: 409 });
        }
      } else {
        const { rowCount } = await client.query(
          'UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2 AND stock_qty >= $1',
          [item.quantity, item.productId]
        );
        if (rowCount === 0) {
          throw Object.assign(new Error(`"${item.name}" no longer has enough stock.`), { status: 409 });
        }
      }
    }

    const rawSubtotal = orderItems.reduce((sum, i) => sum + i.lineTotalPaise, 0);

    let coupon = null;
    let discountPaise = 0;
    if (couponCode) {
      const result = await validateAndComputeCoupon({
        client, code: couponCode, userId, subtotalPaise: rawSubtotal, lockForUpdate: true
      });
      coupon = result.coupon;
      discountPaise = result.discountPaise;
    }

    const { subtotalPaise, shippingPaise, gstPaise, discountPaise: finalDiscount, totalPaise: total } =
      calculateOrderTotals(orderItems, discountPaise, config);

    if (total <= 0) {
      throw Object.assign(
        new Error(couponCode
          ? 'This coupon cannot be applied to this order.'
          : 'This order has no payable amount.'),
        { status: 400 }
      );
    }

    // BIZ-07 — COD ceiling, enforced server-side inside the same transaction
    // that prices the order, so the number checked is the number charged.
    // COD return-to-origin rates in Indian D2C commonly run 20-35%, and every
    // RTO costs shipping both ways on a sale that never happened.
    if (paymentMethod === 'cod' && Number(config.cod_max_order_paise) > 0 && total > Number(config.cod_max_order_paise)) {
      throw Object.assign(
        new Error(`Cash on Delivery is available on orders up to ₹${Math.floor(Number(config.cod_max_order_paise) / 100).toLocaleString('en-IN')}. Please pay online for this order.`),
        { status: 400 }
      );
    }

    const insertOrder = (orderNumber) =>
      client.query(
        `INSERT INTO orders
          (order_number, user_id, status, subtotal_paise, shipping_paise, gst_paise, total_paise,
           shipping_address_id, shipping_address_snapshot, payment_method, coupon_code, discount_paise)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, order_number`,
        [orderNumber, userId, initialStatus, subtotalPaise, shippingPaise, gstPaise, total,
          shippingAddressId || null,
          shippingSnapshot ? JSON.stringify(shippingSnapshot) : null,
          paymentMethod, coupon ? coupon.code : null, finalDiscount]
      );

    const generateNumber = () => 'CHK-' + new Date().getFullYear() + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();

    let orderRows;
    try {
      ({ rows: orderRows } = await insertOrder(generateNumber()));
    } catch (err) {
      if (err.code === '23505') {
        ({ rows: orderRows } = await insertOrder(generateNumber()));
      } else {
        throw err;
      }
    }
    const id = orderRows[0].id;

    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items
          (order_id, product_id, product_name_snapshot, unit_price_paise, quantity, line_total_paise, variant_id, variant_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        // variantSnapshot is an ARRAY, so it must be stringified for the jsonb
        // column — pg turns arrays into Postgres array literals, not JSON.
        // Without this, every variant purchase would fail at this insert.
        [id, item.productId, item.name, item.unitPricePaise, item.quantity, item.lineTotalPaise, item.variantId,
          item.variantSnapshot ? JSON.stringify(item.variantSnapshot) : null]
      );
    }

    if (coupon) {
      await recordCouponRedemption(client, { couponId: coupon.id, userId, orderId: id, discountPaise: finalDiscount });
    }

    return {
      id,
      number: orderRows[0].order_number,
      total,
      discountPaise: finalDiscount,
      couponCode: coupon ? coupon.code : null,
      shippingSnapshot
    };
  });
}

module.exports = {
  reserveStockAndCreateOrder,
  validateAndAggregateCart,
  calculateOrderTotals,
  stockShortfallMessage,
  loadOwnedAddressSnapshot
};
