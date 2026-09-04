/**
 * THE ONE DECLARATION OF WHAT A CRAWLER CAN SEE.
 *
 * WHY THIS FILE EXISTS
 * Two independent things read a product row and turn it into something a search
 * engine indexes:
 *
 *   1. scripts/generate-product-pages.js writes the prerendered page — its
 *      title, description, canonical, Open Graph tags and Product JSON-LD.
 *   2. scripts/publish-catalog-if-changed.js decides whether the deployed site
 *      is STALE, by fingerprinting the live catalog and comparing it to the
 *      published one. A changed fingerprint triggers a Netlify rebuild.
 *
 * Those two must agree about which fields matter, and they were maintained by
 * hand in two places. They had already drifted: the prerenderer reads
 * `subcategory` for the JSON-LD category path and the breadcrumb, and the
 * fingerprint did not include it — so an admin re-filing a product under a new
 * subcategory changed nothing the fingerprint could see, no rebuild was
 * triggered, and the live page kept the old category in its structured data
 * indefinitely. Silent, permanent, and invisible without looking at the JSON-LD
 * of a deployed page.
 *
 * So the list lives here, once. The fingerprint is built from it, and
 * `[fe-49]` fails the build if the prerenderer reads a product field that is
 * not declared here. Adding a new field to the SEO output therefore FORCES a
 * decision about whether changing it should republish the site — which is the
 * only way this stays correct for products, pages and services nobody has
 * created yet.
 */

/**
 * Fields whose value changes what a crawler sees on a product page.
 *
 * Adding one here makes a change to it trigger a rebuild. Leaving one out means
 * an edit to it will never reach the live page until something else changes.
 */
const SEO_PRODUCT_FIELDS = [
  // Identity and addressing.
  'id',           // fingerprint key; not rendered, but rows must be comparable
  'slug',         // the URL itself, and the canonical
  'name',         // <title>, og:title, JSON-LD name, og:image:alt
  'sku',          // JSON-LD sku

  // Classification — both levels reach the JSON-LD category and the breadcrumb.
  'category',
  'subcategory',

  // Copy.
  'short_desc',   // meta description, og:description, JSON-LD description

  // The picture every social platform shows. An admin editing this is the
  // single most common catalogue change, and it must republish.
  'image_url',

  // Commerce facts that appear in the Offer, and that Google will compare
  // against the visible page.
  'price_paise',
  'mrp_paise',
  'stock_qty',    // drives availability: InStock vs OutOfStock
  'has_variants', // a variant product's offer and buyability differ

  // Rich-result inputs. aggregateRating is only emitted when these are real.
  'rating',
  'review_count',

  // Shown as a badge on the card a crawler renders.
  'badge'
];

/**
 * Product fields the prerenderer may read WITHOUT them affecting the crawler's
 * view, and therefore without needing to trigger a republish.
 *
 * Every entry needs a reason. This is the escape hatch for the guard in
 * `[fe-49]`, and an escape hatch with no justification is just a hole.
 */
const SEO_IRRELEVANT_FIELDS = {
  // Read defensively by injectProductJsonLd, which accepts both the storefront's
  // camelCase shape and the API's snake_case one. Never present on an API row.
  desc: 'a storefront-shaped alias for short_desc; never on an API row',
  img: 'a legacy alias that no product object in this project has ever carried',
  image: 'a local variable in the generator, not a field on the row',
  short: 'a fragment of short_desc matched by the field scanner, not a field',
  schema: 'a local in the JSON-LD builder, not a field on the row',
  products: 'the collection itself, not a field on a product'
};

/**
 * What makes a meta description good — declared ONCE.
 *
 * This rule had drifted into three disagreeing copies within a single working
 * session: the audit wanted 50-165 for a page, 40-and-no-ceiling for a product,
 * and the admin form told the seller 70-155. A 45-character description was
 * therefore red in the console and green in the audit, and a seller following
 * one of them could never satisfy the other.
 *
 * The three numbers mean three different things, and conflating them is what
 * produced the drift:
 *
 *   MIN       below this there is not enough text for Google to build a snippet
 *             from, so the result falls back to whatever it scrapes off the
 *             page. A REAL problem, and the only one worth a warning.
 *   IDEAL_MAX Google renders roughly this much. Going over is NOT a defect —
 *             the first ~155 characters still show and still read well — so
 *             this is informational and never an advisory. Eight of eleven
 *             products are over it today and every one of them is fine.
 *   HARD_MAX  past this, somebody has pasted the long description into the
 *             summary field. That IS worth saying.
 *
 * admin.html is a static file and cannot require() this, so it mirrors the
 * numbers and `[fe-50]` fails the build if the two ever stop agreeing.
 */
const SEO_DESCRIPTION = Object.freeze({ MIN: 70, IDEAL_MAX: 155, HARD_MAX: 300 });

module.exports = { SEO_PRODUCT_FIELDS, SEO_IRRELEVANT_FIELDS, SEO_DESCRIPTION };
