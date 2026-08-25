const crypto = require('crypto');
const db = require('../config/db');
const { validateAndComputeCoupon, recordCouponRedemption } = require('./coupons');

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
 * a coupon discount — pulled out for the same reason as
 * validateAndAggregateCart above. Every value in and out is an integer
 * number of paise; nothing here ever touches a float, which is what avoids
 * the classic "0.1 + 0.2" rounding-drift class of bug in financial
 * calculations.
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
 * @param {Array<{lineTotalPaise: number, gstRate: number}>} orderItems
 * @param {number} [discountPaise] - already-validated discount from a coupon, if any
 * @returns {{subtotalPaise: number, shippingPaise: number, gstPaise: number, discountPaise: number, totalPaise: number}}
 */
function calculateOrderTotals(orderItems, discountPaise) {
  const subtotalPaise = orderItems.reduce((sum, i) => sum + i.lineTotalPaise, 0);
  const shippingPaise = subtotalPaise >= 99900 ? 0 : 7900; // free shipping over ₹999, based on original goods value
  const originalGstPaise = Math.round(orderItems.reduce((sum, i) => sum + (i.lineTotalPaise * i.gstRate) / 100, 0));

  const safeDiscount = Math.max(0, Math.min(discountPaise || 0, subtotalPaise));
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
 * @param {Array<{productId: string, quantity: number}>} params.items
 * @param {string|null} params.shippingAddressId
 * @param {'razorpay'|'cod'} params.paymentMethod
 * @param {string} params.initialStatus - 'pending' for razorpay (awaiting payment), 'processing' for cod (nothing to wait for)
 * @param {string|null} [params.couponCode]
 * @returns {Promise<{id: string, number: string, total: number, discountPaise: number, couponCode: string|null}>}
 */
async function reserveStockAndCreateOrder({ userId, items, shippingAddressId, paymentMethod, initialStatus, couponCode }) {
  const aggregatedItems = validateAndAggregateCart(items);

  return db.withTransaction(async (client) => {
    const productIds = [...new Set(aggregatedItems.map((i) => i.productId))];
    const { rows: products } = await client.query(
      `SELECT id, name, price_paise, stock_qty, gst_rate FROM products
       WHERE id = ANY($1) AND is_active = true FOR UPDATE`,
      [productIds]
    );

    // Variant rows are locked too (FOR UPDATE) for the same reason product
    // rows are — two concurrent checkouts for the last unit of "Red / M"
    // must not both pass the stock check against the same stale snapshot.
    const variantIds = aggregatedItems.filter((i) => i.variantId).map((i) => i.variantId);
    let variants = [];
    if (variantIds.length) {
      const { rows } = await client.query(
        'SELECT * FROM product_variants WHERE id = ANY($1) AND is_active = true FOR UPDATE',
        [variantIds]
      );
      variants = rows;
    }

    const orderItems = aggregatedItems.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      if (!product) throw Object.assign(new Error('One of the items in your cart is no longer available.'), { status: 400 });

      if (item.variantId) {
        const variant = variants.find((v) => v.id === item.variantId && v.product_id === item.productId);
        if (!variant) {
          throw Object.assign(new Error(`The selected option for "${product.name}" is no longer available.`), { status: 400 });
        }
        if (variant.stock_qty < item.quantity) {
          throw Object.assign(new Error(`"${product.name}" (selected option) only has ${variant.stock_qty} left in stock.`), { status: 409 });
        }
        // A variant's own price overrides the base product price when set;
        // NULL means "inherit the product's price" — this lets an admin
        // price only the variants that differ, without repricing every one.
        const unitPrice = variant.price_paise != null ? Number(variant.price_paise) : product.price_paise;
        return {
          productId: product.id,
          variantId: variant.id,
          variantSnapshot: variant.option_values,
          name: product.name,
          unitPricePaise: unitPrice,
          quantity: item.quantity,
          lineTotalPaise: unitPrice * item.quantity,
          gstRate: product.gst_rate,
          isVariant: true
        };
      }

      if (product.stock_qty < item.quantity) {
        throw Object.assign(new Error(`"${product.name}" only has ${product.stock_qty} left in stock.`), { status: 409 });
      }
      return {
        productId: product.id,
        variantId: null,
        variantSnapshot: null,
        name: product.name,
        unitPricePaise: product.price_paise,
        quantity: item.quantity,
        lineTotalPaise: product.price_paise * item.quantity,
        gstRate: product.gst_rate,
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
      calculateOrderTotals(orderItems, discountPaise);

    if (total <= 0) {
      throw Object.assign(new Error('This coupon cannot be applied to this order.'), { status: 400 });
    }

    const insertOrder = (orderNumber) =>
      client.query(
        `INSERT INTO orders
          (order_number, user_id, status, subtotal_paise, shipping_paise, gst_paise, total_paise,
           shipping_address_id, payment_method, coupon_code, discount_paise)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, order_number`,
        [orderNumber, userId, initialStatus, subtotalPaise, shippingPaise, gstPaise, total,
          shippingAddressId || null, paymentMethod, coupon ? coupon.code : null, finalDiscount]
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

    return { id, number: orderRows[0].order_number, total, discountPaise: finalDiscount, couponCode: coupon ? coupon.code : null };
  });
}

module.exports = { reserveStockAndCreateOrder, validateAndAggregateCart, calculateOrderTotals };
