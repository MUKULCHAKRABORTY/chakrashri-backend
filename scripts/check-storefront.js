#!/usr/bin/env node
/**
 * Answers the two questions you actually have after building the storefront
 * artifacts: "did the snapshot capture everything?" and "do shared links show
 * the right thing?".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT A ONE-LINER
 * ---------------------------------------------------------------------------
 * Both checks were originally handed over as `node -e '...'` one-liners, and
 * both FAILED when run: PowerShell re-quotes arguments on their way to a native
 * executable, so the double quotes inside a single-quoted string are stripped
 * and node receives `require(./catalog.json)` — a syntax error that looks like
 * a broken project rather than a broken command.
 *
 * A verification command that cannot be pasted and run is worse than no
 * verification command, because it costs the reader time and confidence before
 * telling them nothing. An npm script has no quoting to get wrong.
 *
 * RUN:
 *   npm run check:storefront          what is in catalog.json and product/
 *   npm run check:share               ...plus what the LIVE site serves
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'catalog.json');
const PAGES = path.join(ROOT, 'product');
// See the note in generate-product-pages.js: read the origin, never assume it.
// Netlify sets URL to the site's primary domain during a build.
const SITE_ORIGIN = (process.env.SITE_ORIGIN || process.env.URL || 'https://chakrashri.netlify.app').replace(/\/+$/, '');
const LIVE = process.argv.includes('--live');

let problems = 0;
const ok = (m) => console.log('  OK    ' + m);
const warn = (m) => { console.log('  NOTE  ' + m); };
const bad = (m) => { console.log('  FAIL  ' + m); problems++; };

function readSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) {
    bad('catalog.json does not exist. Run: npm run snapshot');
    return null;
  }
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    if (snap.schema !== 1) { bad(`catalog.json has schema ${snap.schema}, expected 1`); return null; }
    if (!Array.isArray(snap.products)) { bad('catalog.json has no products array'); return null; }
    return snap;
  } catch (err) {
    bad('catalog.json is not readable JSON: ' + err.message);
    return null;
  }
}

function checkSnapshot(snap) {
  console.log('\nCatalog snapshot (catalog.json)');

  const n = snap.products.length;
  if (!n) { bad('the snapshot contains ZERO products — first-time visitors would see an empty shop'); return; }
  ok(`${n} products, ${(snap.categories || []).length} categories, ` +
     `${((snap.bookingServices || {}).puja || []).length + ((snap.bookingServices || {}).astrology || []).length} booking services`);

  const ageMs = Date.now() - new Date(snap.generatedAt).getTime();
  const ageHrs = ageMs / 3600000;
  if (!isFinite(ageHrs)) warn('generatedAt is unreadable');
  else if (ageHrs > 24 * 7) warn(`generated ${Math.round(ageHrs / 24)} days ago — run npm run snapshot before deploying`);
  else ok(`generated ${ageHrs < 1 ? Math.round(ageMs / 60000) + ' minutes' : Math.round(ageHrs) + ' hours'} ago`);

  // Every field the storefront renders from. A product missing one of these
  // renders as a broken card rather than failing loudly, so check here instead.
  const missingSlug = snap.products.filter((p) => !p.slug);
  const missingName = snap.products.filter((p) => !p.name);
  const missingPrice = snap.products.filter((p) => p.price_paise === undefined || p.price_paise === null);
  if (missingSlug.length) bad(`${missingSlug.length} product(s) have no slug — they cannot be linked to or prerendered`);
  if (missingName.length) bad(`${missingName.length} product(s) have no name`);
  if (missingPrice.length) bad(`${missingPrice.length} product(s) have no price`);
  if (!missingSlug.length && !missingName.length && !missingPrice.length) ok('every product has a slug, a name and a price');

  const dupes = {};
  snap.products.forEach((p) => { if (p.slug) dupes[p.slug] = (dupes[p.slug] || 0) + 1; });
  const dupeSlugs = Object.keys(dupes).filter((s) => dupes[s] > 1);
  if (dupeSlugs.length) bad(`duplicate slugs, which collide as pages: ${dupeSlugs.join(', ')}`);
  else ok('no duplicate slugs');

  // Not a failure: a product with no photo still sells, it just shares a plainer
  // link preview. Worth surfacing because it is invisible until someone shares.
  const noImage = snap.products.filter((p) => !p.image_url);
  if (noImage.length) warn(`${noImage.length} of ${n} products have no image — their shared links show a text-only card: ${noImage.map((p) => p.slug).join(', ')}`);
  else ok('every product has an image for its link preview');

  const outOfStock = snap.products.filter((p) => Number(p.stock_qty) === 0);
  if (outOfStock.length) warn(`${outOfStock.length} product(s) currently out of stock: ${outOfStock.map((p) => p.slug).join(', ')}`);
}

/**
 * The three places the origin is a literal, checked against the one the build
 * actually uses.
 *
 * THE BUG THIS EXISTS FOR: index.html's canonical, its og:url and the Sitemap
 * line in robots.txt cannot read an environment variable, so they are the one
 * thing a domain switch silently leaves behind. Pointing canonical at a domain
 * that is not attached tells Google every real page is a duplicate of a dead
 * address — a failure with no visible symptom on the site itself.
 */
function checkOrigins() {
  console.log('');
  console.log('Storefront origin (' + SITE_ORIGIN + ')');
  const host = SITE_ORIGIN.replace(/^https?:\/\//, '');

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const canonical = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || '';
  const ogUrl = (html.match(/<meta property="og:url" content="([^"]*)"/) || [])[1] || '';

  if (canonical.indexOf(host) > -1) ok('index.html canonical matches');
  else bad(`index.html canonical is ${canonical || '(none)'} but the build uses ${SITE_ORIGIN} — Google would treat the live pages as duplicates of that address`);

  if (ogUrl.indexOf(host) > -1) ok('index.html og:url matches');
  else bad(`index.html og:url is ${ogUrl || '(none)'} but the build uses ${SITE_ORIGIN} — shared links would point there`);

  const robotsPath = path.join(ROOT, 'robots.txt');
  if (fs.existsSync(robotsPath)) {
    const robots = fs.readFileSync(robotsPath, 'utf8');
    const sitemap = (robots.match(/Sitemap:\s*(\S+)/) || [])[1] || '';
    if (sitemap.indexOf(host) > -1) ok('robots.txt Sitemap matches');
    else bad(`robots.txt points at ${sitemap || '(none)'} but the build uses ${SITE_ORIGIN}`);
  }
}

function checkPages(snap) {
  console.log('\nPrerendered product pages (product/)');
  if (!fs.existsSync(PAGES)) {
    warn('no product/ directory yet. Netlify generates it on deploy; run npm run prerender to check it locally.');
    return;
  }
  const dirs = fs.readdirSync(PAGES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  ok(`${dirs.length} page(s) generated`);

  const slugs = snap.products.map((p) => p.slug).filter(Boolean);
  const missing = slugs.filter((s) => dirs.indexOf(s) === -1);
  const orphan = dirs.filter((d) => slugs.indexOf(d) === -1);
  if (missing.length) bad(`${missing.length} product(s) have no page — their links keep the generic preview: ${missing.join(', ')}`);
  else ok('every product in the snapshot has a page');
  if (orphan.length) bad(`${orphan.length} page(s) for products that no longer exist: ${orphan.join(', ')}`);

  // Spot-check one page's head rather than trusting the generator's own report.
  const sample = dirs.find((d) => slugs.indexOf(d) > -1);
  if (!sample) return;
  const html = fs.readFileSync(path.join(PAGES, sample, 'index.html'), 'utf8');
  const product = snap.products.find((p) => p.slug === sample);
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const ogImage = (html.match(/<meta property="og:image" content="([^"]*)"/) || [])[1] || null;

  if (title.indexOf(product.name) > -1) ok(`sample page /${sample} carries its own title`);
  else bad(`sample page /${sample} still has the generic title: ${title}`);

  if (html.indexOf('"@type": "Product"') > -1 || html.indexOf('"@type":"Product"') > -1) ok('sample page carries Product structured data');
  else bad('sample page has no Product JSON-LD');

  if (product.image_url && !ogImage) bad(`sample page has a product image but no og:image`);
  else if (ogImage) ok('sample page carries og:image for the link preview');

  if (html.indexOf('window.__PRERENDER__') > -1) ok('sample page inlines its product, so it renders with the API cold');
  else bad('sample page has no inline product payload');
}

async function checkLive(snap) {
  console.log(`\nLive site (${SITE_ORIGIN})`);
  const product = snap.products.find((p) => p.slug);
  if (!product) { bad('no product to check'); return; }
  const url = `${SITE_ORIGIN}/product/${encodeURIComponent(product.slug)}`;

  let html;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) { bad(`${url} returned ${res.status}`); return; }
      html = await res.text();
    } finally { clearTimeout(timer); }
  } catch (err) {
    bad(`could not fetch ${url}: ${err.message}`);
    return;
  }

  const ogTitle = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '';
  console.log(`  URL   ${url}`);
  console.log(`  og:title = ${ogTitle || '(none)'}`);

  if (!ogTitle) bad('no og:title at all — shared links will show nothing');
  else if (ogTitle.indexOf(product.name) > -1) ok('the live page names the product — shared links are correct');
  else bad('the live page still serves the generic site title. The prerender step did not run in the Netlify build.');

  const liveCatalog = `${SITE_ORIGIN}/catalog.json`;
  try {
    const res = await fetch(liveCatalog);
    const body = await res.json();
    if (Array.isArray(body.products) && body.products.length) ok(`${liveCatalog} is being served (${body.products.length} products)`);
    else bad(`${liveCatalog} is served but has no products`);
  } catch (err) {
    bad(`${liveCatalog} is not being served — first-time visitors get skeletons until the API wakes`);
  }
}

async function main() {
  const snap = readSnapshot();
  if (!snap) { process.exitCode = 1; return; }
  checkOrigins();
  checkSnapshot(snap);
  checkPages(snap);
  if (LIVE) await checkLive(snap);

  console.log('');
  if (problems) {
    console.log(`${problems} problem(s) found. Fix these before deploying.`);
    process.exitCode = 1;
  } else {
    console.log('All checks passed.');
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('check failed:', err.message); process.exitCode = 1; });
}
