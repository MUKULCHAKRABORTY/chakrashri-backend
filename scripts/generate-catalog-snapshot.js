#!/usr/bin/env node
/**
 * Writes catalog.json — the storefront's build-time catalog snapshot.
 *
 * WHY THIS EXISTS
 * The API runs on Render's free plan, which spins the instance down after ~15
 * minutes of inactivity; the first request afterwards pays a 30-60 second cold
 * boot. Neon suspends its compute after ~5 minutes on top of that. Before this
 * script, index.html could not render its catalog until that boot finished, so
 * the first visitor after a quiet hour watched an empty storefront for the best
 * part of a minute.
 *
 * This snapshot is fetched from Netlify's edge in ~50ms, so the grid, the
 * category rail and every product page render immediately. index.html then
 * fetches the live API in the background and reconciles — stale-while-
 * revalidate, done at the application level because a free-tier origin cannot
 * do it at the CDN.
 *
 * WHAT IT IS NOT
 * Never authoritative for money. Price and stock here are display values that
 * may be minutes or days old; the server re-validates both at add-to-cart and
 * again at checkout (utils/stock.js, utils/orders.js). Keep it that way — the
 * moment a checkout total is computed from this file, a stale snapshot becomes
 * a mispriced order.
 *
 * RUN: node scripts/generate-catalog-snapshot.js
 * Wired into netlify.toml's build command alongside the sitemap generator.
 */
const fs = require('fs');
const path = require('path');

const API_BASE = (process.env.API_BASE || 'https://chakrashri-api.onrender.com').replace(/\/+$/, '');
const OUTPUT = path.join(__dirname, '..', 'catalog.json');

// Generous on purpose. This is a build step with no user waiting on it, and the
// thing it is fetching from is a free instance that may be stone cold — a short
// timeout here just guarantees the empty snapshot this script exists to avoid.
const FETCH_TIMEOUT_MS = parseInt(process.env.SNAPSHOT_FETCH_TIMEOUT_MS || '30000', 10);
const WARMUP_TIMEOUT_MS = parseInt(process.env.SNAPSHOT_WARMUP_TIMEOUT_MS || '90000', 10);
const PAGE_SIZE = 100;   // the API clamps /api/products?limit to 100
const MAX_PAGES = 50;    // 5,000 products; a runaway loop is worse than a truncated snapshot

async function fetchJson(pathname, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(API_BASE + pathname, { signal: controller.signal });
    if (!res.ok) throw new Error(`${pathname} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll /api/health until the instance answers.
 *
 * A build almost always runs against a COLD API: you deploy after a quiet
 * period, and the storefront build starts the moment the push lands. Fetching
 * the catalog directly would hit the cold boot with a normal timeout and give
 * up. /api/health is exempt from the rate limiter and touches no database, so
 * polling it is the cheapest possible way to wait out the boot.
 */
async function waitForApi() {
  const deadline = Date.now() + WARMUP_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      await fetchJson('/api/health', 10000);
      if (attempt > 1) console.log(`[catalog] API answered after ${attempt} attempts.`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return false;
}

async function fetchAllProducts() {
  let rows = [];
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await fetchJson(`/api/products?limit=${PAGE_SIZE}&page=${page}`);
    if (!body || !Array.isArray(body.products)) break;
    rows = rows.concat(body.products);
    totalCount = (body.pagination && body.pagination.totalCount !== undefined)
      ? Number(body.pagination.totalCount)
      : null;
    if (totalCount === null || rows.length >= totalCount || body.products.length < PAGE_SIZE) break;
  }
  // A snapshot that is short of the real catalog hides products from every
  // visitor until the next deploy, with no error anywhere. Say so.
  if (totalCount !== null && rows.length < totalCount) {
    console.warn(`[catalog] INCOMPLETE: captured ${rows.length} of ${totalCount} products.`);
  }
  return rows;
}

async function softFetch(pathname, pick, label) {
  try {
    const body = await fetchJson(pathname);
    return pick(body) || [];
  } catch (err) {
    console.warn(`[catalog] Could not fetch ${label} (${err.message}) — snapshot will omit it.`);
    return [];
  }
}

async function main() {
  const warm = await waitForApi();
  if (!warm) {
    // THE IMPORTANT FAILURE MODE. Writing an empty snapshot would be far worse
    // than writing none: index.html trusts this file for its first paint, so an
    // empty one shows every visitor an empty shop until the next deploy. The
    // copy already in the repo is stale but correct, so leave it alone.
    console.warn(`[catalog] API did not wake within ${WARMUP_TIMEOUT_MS}ms — keeping the existing snapshot.`);
    console.warn(`[catalog] ${fs.existsSync(OUTPUT) ? 'Existing catalog.json left in place.' : 'No catalog.json exists; the storefront will fall back to the live API.'}`);
    return;
  }

  let products;
  try {
    products = await fetchAllProducts();
  } catch (err) {
    console.warn(`[catalog] Product fetch failed (${err.message}) — keeping the existing snapshot.`);
    return;
  }

  // Same reasoning as above, for the case where the API answers but returns
  // nothing. An empty result is a legitimate answer at runtime (every product
  // deactivated) and index.html honours it there — but at BUILD time it is far
  // more likely to be a half-woken database than a genuinely empty shop, and
  // the cost of guessing wrong is an empty storefront.
  if (!products.length) {
    console.warn('[catalog] API returned zero products — keeping the existing snapshot rather than publishing an empty shop.');
    return;
  }

  const [categories, puja, astrology] = await Promise.all([
    softFetch('/api/products/meta/top-categories?limit=7', (b) => b.categories, 'top categories'),
    softFetch('/api/booking-services?type=puja', (b) => b.services, 'puja services'),
    softFetch('/api/booking-services?type=astrology', (b) => b.services, 'astrology services')
  ]);

  const snapshot = {
    // Bumped only when the SHAPE changes. index.html refuses a snapshot whose
    // schema it does not recognise rather than rendering fields that moved.
    schema: 1,
    generatedAt: new Date().toISOString(),
    products,
    categories,
    bookingServices: { puja, astrology }
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(snapshot), 'utf8');
  const kb = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
  console.log(`[catalog] Wrote catalog.json: ${products.length} products, ${categories.length} categories, ${puja.length + astrology.length} services (${kb} KB).`);
}

if (require.main === module) {
  main().catch((err) => {
    // Never fail the build over this. A deploy blocked because a snapshot could
    // not be refreshed is worse than a deploy carrying yesterday's snapshot.
    console.error('[catalog] Snapshot generation failed:', err.message);
    process.exit(0);
  });
}

module.exports = { main };
