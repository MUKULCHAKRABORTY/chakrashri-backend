#!/usr/bin/env node
/**
 * Keeps the PUBLISHED catalog snapshot in step with the live catalog.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * The storefront renders its first paint from catalog.json, which is written at
 * BUILD time. A returning visitor also has their own copy in localStorage,
 * refreshed on every visit — so they always see the last data the site actually
 * served them.
 *
 * A FIRST-TIME visitor has neither. All they have is whatever catalog.json was
 * published on the last deploy. If a price changed, a product sold out or a new
 * item was listed since then, that is what they see until someone deploys
 * again — and on a site that deploys rarely, "since then" can be weeks.
 *
 * This closes that: it compares the live catalog against the one currently
 * being served and asks Netlify to rebuild ONLY when they actually differ. The
 * rebuild re-runs generate-catalog-snapshot.js and generate-product-pages.js,
 * so the published snapshot, the sitemap and every prerendered product page all
 * refresh together.
 *
 * ---------------------------------------------------------------------------
 * WHY CHANGE DETECTION AND NOT A TIMER
 * ---------------------------------------------------------------------------
 * Netlify's free plan allows 300 build minutes a month. Rebuilding on a fixed
 * schedule would exhaust that and then stop deploying anything at all,
 * including real code changes — a far worse failure than a slightly stale
 * price. A catalog changes when someone edits a product, which on this site is
 * a handful of times a week, so comparing first turns "hundreds of builds" into
 * "a few".
 *
 * generatedAt is excluded from the comparison for the same reason: it changes
 * on every run and would make every run look like a change.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 * ---------------------------------------------------------------------------
 * Read-only against production, and it triggers nothing unless it is certain:
 * if the live catalog cannot be fetched, comes back empty, or the deployed one
 * cannot be read, it does NOTHING and exits 0. A build hook fired on bad data
 * would publish an empty shop.
 *
 * RUN: node scripts/publish-catalog-if-changed.js
 *      node scripts/publish-catalog-if-changed.js --dry-run   (compare only)
 */
const crypto = require('crypto');
const { SEO_PRODUCT_FIELDS } = require('./seo-fields');

const API_BASE = (process.env.API_BASE || 'https://chakrashri-api.onrender.com').replace(/\/+$/, '');
// See the note in generate-product-pages.js: read the origin, never assume it.
// Netlify sets URL to the site's primary domain during a build.
const SITE_ORIGIN = (process.env.SITE_ORIGIN || process.env.URL || 'https://chakrashri.netlify.app').replace(/\/+$/, '');
const BUILD_HOOK = process.env.NETLIFY_BUILD_HOOK_URL || '';
const DRY_RUN = process.argv.includes('--dry-run');

const WARMUP_TIMEOUT_MS = parseInt(process.env.SNAPSHOT_WARMUP_TIMEOUT_MS || '90000', 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.SNAPSHOT_FETCH_TIMEOUT_MS || '30000', 10);
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Same wake-and-wait as the snapshot generator: this always runs against a cold API. */
async function waitForApi() {
  const deadline = Date.now() + WARMUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`${API_BASE}/api/health`, 10000);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return false;
}

async function fetchLiveCatalog() {
  let rows = [];
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await fetchJson(`${API_BASE}/api/products?limit=${PAGE_SIZE}&page=${page}`);
    if (!body || !Array.isArray(body.products)) break;
    rows = rows.concat(body.products);
    totalCount = (body.pagination && body.pagination.totalCount !== undefined)
      ? Number(body.pagination.totalCount) : null;
    if (totalCount === null || rows.length >= totalCount || body.products.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * A stable fingerprint of what a CRAWLER would actually see.
 *
 * Built from the one declared list in scripts/seo-fields.js rather than a
 * hand-written array here. That array had already drifted from what the
 * prerenderer reads: `subcategory` feeds the JSON-LD category path and the
 * breadcrumb, and it was missing — so re-filing a product under a new
 * subcategory changed nothing this function could see, no rebuild was
 * triggered, and the deployed page kept the old category in its structured
 * data indefinitely.
 *
 * Deriving it means a field can only be forgotten in ONE place, and `[fe-49]`
 * fails the build if the prerenderer reads a field that is not declared.
 *
 * Anything not on the list — a timestamp, an internal counter, a column added
 * later that nothing renders — is deliberately excluded: it would make
 * untouched catalogs look different and trigger pointless rebuilds. Sorted by
 * id so the API returning rows in a different order is not a change.
 */
function fingerprint(products) {
  const shaped = (products || [])
    .map((p) => SEO_PRODUCT_FIELDS.map((f) => (p[f] === undefined ? null : p[f])))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash('sha256').update(JSON.stringify(shaped)).digest('hex');
}

async function main() {
  if (!BUILD_HOOK && !DRY_RUN) {
    // Not an error. The hook is optional — without it the snapshot simply
    // refreshes on the next manual deploy, which is how this worked before.
    console.log('[publish] NETLIFY_BUILD_HOOK_URL is not set — nothing to do.');
    console.log('[publish] Set it to have the published catalog refresh itself. See README.');
    return;
  }

  if (!(await waitForApi())) {
    console.log('[publish] The API did not wake in time. Doing nothing — a build triggered on data we could not read is worse than a stale one.');
    return;
  }

  let live;
  try {
    live = await fetchLiveCatalog();
  } catch (err) {
    console.log(`[publish] Could not read the live catalog (${err.message}). Doing nothing.`);
    return;
  }

  if (!live.length) {
    // Same reasoning as generate-catalog-snapshot.js: an empty result here is
    // far more likely to be a half-woken database than a genuinely empty shop,
    // and publishing it would empty the storefront for every new visitor.
    console.log('[publish] The live catalog came back empty. Refusing to publish that. Doing nothing.');
    return;
  }

  let published = null;
  try {
    published = await fetchJson(`${SITE_ORIGIN}/catalog.json`);
  } catch (err) {
    console.log(`[publish] No readable catalog.json is deployed yet (${err.message}) — treating this as a change.`);
  }

  const liveHash = fingerprint(live);
  const publishedHash = published && Array.isArray(published.products) ? fingerprint(published.products) : null;

  if (publishedHash === liveHash) {
    console.log(`[publish] No change (${live.length} products, ${liveHash.slice(0, 12)}). No build triggered.`);
    return;
  }

  console.log(`[publish] Catalog changed: deployed ${publishedHash ? publishedHash.slice(0, 12) : 'none'} -> live ${liveHash.slice(0, 12)} (${live.length} products).`);

  if (DRY_RUN) {
    console.log('[publish] --dry-run: would trigger a Netlify build.');
    return;
  }

  const res = await fetch(BUILD_HOOK, { method: 'POST', body: '{}' });
  if (!res.ok) throw new Error(`Netlify build hook returned ${res.status}`);
  console.log('[publish] Netlify build triggered. The snapshot, sitemap and product pages all refresh with it.');
}

if (require.main === module) {
  main().catch((err) => {
    // Loud, but never a failed job: this is a freshness optimisation, and a red
    // cross here would train everyone to ignore this workflow.
    console.error('[publish] Failed:', err.message);
  });
}

module.exports = { fingerprint };
