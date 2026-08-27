/**
 * Product rating aggregation — one implementation, used by both the review
 * submit path and the admin moderation path.
 *
 * WHY IT LIVES HERE
 * Before moderation existed, the recompute was inlined in the submit handler in
 * products.routes.js. Adding a second caller (an admin hiding a review) with
 * its own copy is exactly how two code paths end up disagreeing about what a
 * product's star rating means — the same reasoning that put coupon validation
 * in one shared function.
 *
 * WHY IT COUNTS ONLY APPROVED REVIEWS (BIZ-05)
 * Hiding an abusive review has to actually correct the score. If the aggregate
 * were computed over every row, a hidden 1-star review would stay baked into
 * the average forever and the moderation action would be cosmetic.
 *
 * WHY NULL AND NOT 4.5 (BIZ-04)
 * Every product used to be created with rating = 4.5 by database default and
 * displayed those stars beside "0 reviews". A rating not derived from genuine
 * consumer feedback is misleading under India's CCPA guidance on fake reviews
 * and BIS IS 19000:2022 — and a catalog of identical 4.5s reads as fake to
 * customers anyway. NULL means "no reviews yet", which the storefront renders
 * honestly.
 */

async function recomputeProductRating(client, productId) {
  const { rows } = await client.query(
    `SELECT AVG(rating)::numeric(2,1) AS avg_rating, COUNT(*)::int AS cnt
       FROM product_reviews WHERE product_id = $1 AND is_approved = true`,
    [productId]
  );
  const count = Number(rows[0].cnt) || 0;
  await client.query(
    'UPDATE products SET rating = $1, review_count = $2 WHERE id = $3',
    [count > 0 ? rows[0].avg_rating : null, count, productId]
  );
  return { rating: count > 0 ? rows[0].avg_rating : null, reviewCount: count };
}

module.exports = { recomputeProductRating };
