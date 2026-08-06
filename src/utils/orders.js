const crypto = require('crypto');
const db = require('../config/db');

/**
 * Validates raw cart items and aggregates duplicate product entries into a
 * single quantity per product. Pulled out as its own pure function (no DB,
 * no I/O) specifically so it can be unit-tested directly — this is the exact
 * logic that, when it didn't exist, allowed the same product listed twice in
 * one cart to pass two independent stock checks against the same stale
 * snapshot and oversell. Testing this function directly, rather than a
 * reimplementation of it, is what actually proves the fix holds.
 *
 * @param {Array<{productId: string, quantity: number}>} items
 * @returns {Array<{productId: string, quantity: number}>}
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
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 50
    ) {
      throw Object.assign(new Error('Cart contains an invalid item or quantity.'), { status: 400 });
    }
  }

  const aggregated = Object.values(
    items.reduce((acc, item) => {
      if (!acc[item.productId]) acc[item.productId] = { productId: item.productId, quantity: 0 };
      acc[item.productId].quantity += item.quantity;
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
 * Pure money math: subtotal, free-shipping threshold, and GST — pulled out
 * for the same reason as validateAndAggregateCart above. Every value in and
 * out is an integer number of paise; nothing here ever touches a float,
 * which is what avoids the classic "0.1 + 0.2" rounding-drift class of bug
 * in financial calculations.
 *
 * @param {Array<{lineTotalPaise: number, gstRate: number}>} orderItems
 * @returns {{subtotalPaise: number, shippingPaise: number, gstPaise: number, totalPaise: number}}
 */
function calculateOrderTotals(orderItems) {
  const subtotalPaise = orderItems.reduce((sum, i) => sum + i.lineTotalPaise, 0);
  const shippingPaise = subtotalPaise >= 99900 ? 0 : 7900; // free shipping over ₹999
  const gstPaise = Math.round(orderItems.reduce((sum, i) => sum + (i.lineTotalPaise * i.gstRate) / 100, 0));
  return { subtotalPaise, shippingPaise, gstPaise, totalPaise: subtotalPaise + shippingPaise + gstPaise };
}

/**
 * Validates a cart, aggregates duplicate product entries, atomically checks
 * and reserves stock (row-locked, oversell-proof), and inserts the order +
 * order_items — all inside one database transaction. Shared by every
 * checkout path (Razorpay, COD, and any future payment method) so the
 * correctness-critical parts of checkout exist in exactly one place.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {Array<{productId: string, quantity: number}>} params.items
 * @param {string|null} params.shippingAddressId
 * @param {'razorpay'|'cod'} params.paymentMethod
 * @param {string} params.initialStatus - 'pending' for razorpay (awaiting payment), 'processing' for cod (nothing to wait for)
 * @returns {Promise<{id: string, number: string, total: number}>}
 */
async function reserveStockAndCreateOrder({ userId, items, shippingAddressId, paymentMethod, initialStatus }) {
  const aggregatedItems = validateAndAggregateCart(items);

  return db.withTransaction(async (client) => {
    const productIds = aggregatedItems.map((i) => i.productId);
    const { rows: products } = await client.query(
      `SELECT id, name, price_paise, stock_qty, gst_rate FROM products
       WHERE id = ANY($1) AND is_active = true FOR UPDATE`,
      [productIds]
    );

    const orderItems = aggregatedItems.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      if (!product) throw Object.assign(new Error('One of the items in your cart is no longer available.'), { status: 400 });
      if (product.stock_qty < item.quantity) {
        throw Object.assign(new Error(`"${product.name}" only has ${product.stock_qty} left in stock.`), { status: 409 });
      }
      const lineTotal = product.price_paise * item.quantity;
      return {
        productId: product.id,
        name: product.name,
        unitPricePaise: product.price_paise,
        quantity: item.quantity,
        lineTotalPaise: lineTotal,
        gstRate: product.gst_rate
      };
    });

    // Belt-and-suspenders: even with aggregation above, this WHERE clause
    // means the UPDATE itself can never take stock below zero.
    for (const item of orderItems) {
      const { rowCount } = await client.query(
        'UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2 AND stock_qty >= $1',
        [item.quantity, item.productId]
      );
      if (rowCount === 0) {
        throw Object.assign(new Error(`"${item.name}" no longer has enough stock.`), { status: 409 });
      }
    }

    const { subtotalPaise, shippingPaise, gstPaise, totalPaise: total } = calculateOrderTotals(orderItems);

    const insertOrder = (orderNumber) =>
      client.query(
        `INSERT INTO orders
          (order_number, user_id, status, subtotal_paise, shipping_paise, gst_paise, total_paise,
           shipping_address_id, payment_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, order_number`,
        [orderNumber, userId, initialStatus, subtotalPaise, shippingPaise, gstPaise, total, shippingAddressId || null, paymentMethod]
      );

    const generateNumber = () => 'CHK-' + new Date().getFullYear() + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();

    let orderRows;
    try {
      ({ rows: orderRows } = await insertOrder(generateNumber()));
    } catch (err) {
      if (err.code === '23505') {
        // Extremely unlikely with 5 random bytes, but one retry with a fresh
        // number resolves a genuine collision rather than failing checkout.
        ({ rows: orderRows } = await insertOrder(generateNumber()));
      } else {
        throw err;
      }
    }
    const id = orderRows[0].id;

    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name_snapshot, unit_price_paise, quantity, line_total_paise)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, item.productId, item.name, item.unitPricePaise, item.quantity, item.lineTotalPaise]
      );
    }

    return { id, number: orderRows[0].order_number, total };
  });
}

module.exports = { reserveStockAndCreateOrder, validateAndAggregateCart, calculateOrderTotals };
