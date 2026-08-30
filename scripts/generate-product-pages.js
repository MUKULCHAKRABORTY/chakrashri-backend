#!/usr/bin/env node
/**
 * Writes a real static HTML page for every product: product/<slug>/index.html.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES
 * ---------------------------------------------------------------------------
 * _redirects serves the SAME index.html for every path, and that file's head
 * carries the generic site title, description and no image. updatePageMeta()
 * rewrites those per view — but it rewrites them in JavaScript, and the crawlers
 * that build link previews do not execute JavaScript.
 *
 * WhatsApp is the dominant sharing channel for this market. Every product link
 * shared there rendered as "Chakrashri — Sacred Objects, Puja Booking &
 * Astrology" with no picture and no price, whichever product it pointed at.
 * Facebook, Twitter/X, Slack, Telegram, LinkedIn and iMessage all behave the
 * same way. A prerendered page fixes all of them at once, because the correct
 * tags are already in the bytes the crawler receives.
 *
 * It helps Google too. Googlebot does render JavaScript, but rendering is a
 * second pass on a separate budget — server-rendered title, description, image
 * and Product/Offer JSON-LD are indexed on the first pass instead.
 *
 * ---------------------------------------------------------------------------
 * WHY A FULL COPY OF index.html, AND WHY THAT IS NOT AS WASTEFUL AS IT LOOKS
 * ---------------------------------------------------------------------------
 * index.html is one 460KB file with all CSS and JS inline — there are no shared
 * external assets a small stub could link to. So each product page is that file
 * with its head rewritten.
 *
 * Uncompressed that reads alarming. On the wire it is not: Netlify serves these
 * brotli-compressed at roughly 80-90KB, and a visitor downloads exactly ONE of
 * them — every navigation after the entry page is client-side routing, not a
 * new document. The real cost is a repeat visitor who enters at two different
 * products on different days paying for two documents instead of one cached
 * one. That is a fair trade for link previews that work.
 *
 * The generated pages are NOT committed (.gitignore) — they are build output,
 * rebuilt from the live catalog on every deploy.
 *
 * ---------------------------------------------------------------------------
 * ORDERING
 * ---------------------------------------------------------------------------
 * Runs after generate-catalog-snapshot.js, and reads catalog.json rather than
 * hitting the API again: the snapshot has already woken the instance and paged
 * through the whole catalog, so a second pass would be slower and could
 * disagree with the file the storefront is about to render from.
 *
 * RUN: node scripts/generate-product-pages.js   (npm run prerender)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'index.html');
const SNAPSHOT = path.join(ROOT, 'catalog.json');
const OUT_ROOT = path.join(ROOT, 'product');
// Records exactly which directories this script created, so pruning can only
// ever remove its own output. Without it, prune logic that walked product/ and
// deleted "anything not in the current catalog" would happily delete a
// directory someone had put there for another reason.
const MANIFEST = path.join(OUT_ROOT, '.prerendered.json');

// The storefront's own origin. Read from the environment, never assumed.
//
// Netlify sets URL during every build to the site's PRIMARY domain, so this
// follows a custom domain automatically the moment one is attached — no code
// change, no forgotten constant. SITE_ORIGIN overrides it for local runs.
//
// THE BUG THIS FIXES: this defaulted to the custom domain www.chakrashri.com,
// which is not attached yet. Every generated canonical, og:url, sitemap entry
// and JSON-LD offer URL therefore pointed at a hostname that 404s — telling
// Google the real pages were duplicates of a dead address, and giving every
// WhatsApp link preview a dead destination. `npm run check:share` caught it.
const SITE_ORIGIN = (process.env.SITE_ORIGIN || process.env.URL || 'https://chakrashri.netlify.app').replace(/\/+$/, '');

// A ceiling, not a target. At ~85KB compressed each, a few hundred pages is a
// few tens of megabytes of deploy — fine. Several thousand is not, and silently
// producing that on a build is worse than refusing and saying so.
const MAX_PAGES = parseInt(process.env.PRERENDER_MAX_PAGES || '400', 10);

// Mirrors CAT_LABELS in index.html. Duplicated deliberately, and checked by
// test/frontend.test.js, because importing anything out of a 460KB inline
// <script> would mean parsing the whole storefront at build time.
const CAT_LABELS = {
  lingam: 'Sphatik Lingams', yantra: 'Sri Yantras', idols: 'Idols & Murtis',
  malas: 'Malas', bracelets: 'Bracelets', books: 'Spiritual Books',
  samagri: 'Puja Samagri Kits'
};

// Mirrors MINOR_WORDS in index.html. Categories are admin-created and
// free-form, so most of them fall through to the title-caser below.
const MINOR_WORDS = ['and', 'or', 'of', 'the', 'a', 'an', 'for', 'in', 'on', 'with', 'to'];

/**
 * Must produce EXACTLY what catLabel() in index.html produces.
 *
 * THE BUG THIS FIXES: this used to be a one-line word-boundary uppercase,
 * which disagrees with the storefront on any multi-word category.
 * "books and gifts" rendered as "Books and Gifts" in the breadcrumb but
 * "Books And Gifts" in the Product JSON-LD; "GIFT SETS" was normalised by the
 * storefront and left shouting here; stray spaces survived here and were
 * collapsed there.
 *
 * Nothing breaks visibly — the page simply tells Google a different category
 * name than it shows the customer, on every category added from here on.
 *
 * test/frontend.test.js runs both implementations over the same inputs and
 * fails if they ever diverge again.
 */
function titleCaseTerm(term) {
  return String(term)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      if (i > 0 && MINOR_WORDS.indexOf(w) > -1) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

function catLabel(key) {
  if (!key) return 'Uncategorized';
  if (CAT_LABELS[key]) return CAT_LABELS[key];
  return titleCaseTerm(String(key).replace(/[-_]+/g, ' '));
}

/**
 * Escapes a value for use inside a double-quoted HTML attribute.
 *
 * This is the security boundary of this script. Product names and descriptions
 * are admin-entered and are being written into <meta content="..."> in a page
 * served from our own origin — an unescaped double quote would break out of the
 * attribute and everything after it becomes markup. `<` and `>` are escaped too
 * so a value can never open a tag even if the quoting is later changed. `&`
 * goes first, or it would double-escape the entities added after it.
 */
function attr(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escapes for HTML text content (the <title> element). */
function text(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Serialises a value for embedding in a <script> block.
 *
 * JSON.stringify alone is NOT enough. A description containing the literal
 * characters `</script>` would close the block early and everything after it
 * would be parsed as markup — the same class of bug scripts/check-syntax.js
 * exists to catch. Escaping the `<` of every `</` closes that. U+2028 and
 * U+2029 are valid inside a JSON string but are line terminators in JavaScript,
 * so they are escaped too.
 */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function productImageUrl(p) {
  const url = (p && (p.image_url || p.imageUrl || p.img)) || '';
  return /^https?:\/\//.test(url) ? url : null;
}

/** Matches the title navigateTo() sets, so nothing flickers when the SPA boots. */
function titleFor(p) {
  return p.name + ' — Buy Online | Chakrashri';
}

/** Matches the description navigateTo() sets, including the 300-char clamp. */
function descriptionFor(p) {
  const raw = p.short_desc || p.shortDesc || p.desc ||
    ('Buy ' + p.name + ' from Chakrashri — authentic, carefully sourced, delivered across India.');
  return String(raw).slice(0, 300);
}

/**
 * Product/Offer/AggregateRating structured data. Deliberately the same shape as
 * injectProductJsonLd() in index.html — change one, change both; the frontend
 * test asserts they agree on the fields that matter.
 */
function productJsonLd(p) {
  const image = productImageUrl(p);
  const qty = (p.stock_qty === undefined || p.stock_qty === null) ? null : Number(p.stock_qty);
  const reviewCount = Number(p.review_count || 0);
  const rating = Number(p.rating);

  const data = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: descriptionFor(p).slice(0, 500),
    sku: p.sku || undefined,
    category: p.category ? catLabel(p.category) : undefined,
    image: image ? [image] : [],
    offers: {
      '@type': 'Offer',
      url: SITE_ORIGIN + '/product/' + encodeURIComponent(p.slug),
      priceCurrency: 'INR',
      price: (Number(p.price_paise || 0) / 100).toFixed(2),
      // null means "genuinely unknown" and stays optimistic; a real 0 does not.
      // Advertising an out-of-stock product as InStock is a structured-data
      // mismatch Google issues manual actions over.
      availability: (qty === null || qty > 0)
        ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      seller: { '@type': 'Organization', name: 'Chakrashri' }
    }
  };

  // BIZ-04 — only emit a rating when real reviews exist. Publishing
  // aggregateRating for a product with zero reviews is the fabricated rating the
  // audit flagged, and Google treats it as a manual-action risk.
  if (reviewCount > 0 && rating > 0) {
    data.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: rating.toFixed(1),
      reviewCount: reviewCount,
      bestRating: '5',
      worstRating: '1'
    };
  }

  Object.keys(data).forEach((k) => { if (data[k] === undefined) delete data[k]; });
  return data;
}

/**
 * Rewrites the head of index.html for one product.
 *
 * Exported and unit-tested, because this is string surgery on a 460KB file and
 * a pattern that silently matched nothing would produce pages that look fine
 * and carry the wrong tags — precisely the failure being fixed. Every
 * replacement therefore reports whether it actually changed anything.
 */
function renderProductPage(html, p) {
  const url = SITE_ORIGIN + '/product/' + encodeURIComponent(p.slug);
  const title = titleFor(p);
  const description = descriptionFor(p);
  const image = productImageUrl(p);
  const missed = [];

  function replaceOnce(label, pattern, replacement) {
    const before = html;
    html = html.replace(pattern, replacement);
    if (html === before) missed.push(label);
  }

  replaceOnce('title', /<title>[\s\S]*?<\/title>/, '<title>' + text(title) + '</title>');
  replaceOnce('description', /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="' + attr(description) + '">');
  replaceOnce('canonical', /<link rel="canonical" href="[^"]*">/,
    '<link rel="canonical" href="' + attr(url) + '">');
  replaceOnce('og:type', /<meta property="og:type" content="[^"]*">/,
    '<meta property="og:type" content="product">');
  replaceOnce('og:title', /<meta property="og:title" content="[^"]*">/,
    '<meta property="og:title" content="' + attr(title) + '">');
  replaceOnce('og:description', /<meta property="og:description" content="[^"]*">/,
    '<meta property="og:description" content="' + attr(description) + '">');
  replaceOnce('og:url', /<meta property="og:url" content="[^"]*">/,
    '<meta property="og:url" content="' + attr(url) + '">');
  replaceOnce('twitter:title', /<meta name="twitter:title" content="[^"]*">/,
    '<meta name="twitter:title" content="' + attr(title) + '">');
  replaceOnce('twitter:description', /<meta name="twitter:description" content="[^"]*">/,
    '<meta name="twitter:description" content="' + attr(description) + '">');

  // og:image is ADDED here, not replaced — index.html ships without one,
  // because a site-wide default would be wrong on a product page and a broken
  // image URL in a preview card is worse than no image at all.
  // summary_large_image is only claimed when there is a large image to show.
  replaceOnce('twitter:card', /<meta name="twitter:card" content="[^"]*">/,
    '<meta name="twitter:card" content="' + (image ? 'summary_large_image' : 'summary') + '">' +
    (image
      ? '\n<meta property="og:image" content="' + attr(image) + '">' +
        '\n<meta property="og:image:alt" content="' + attr(p.name) + '">' +
        '\n<meta name="twitter:image" content="' + attr(image) + '">'
      : ''));

  replaceOnce('json-ld', /<script type="application\/ld\+json" id="ldPage"><\/script>/,
    '<script type="application/ld+json" id="ldPage">' + jsonForScript(productJsonLd(p)) + '</script>');

  // The product's own API row, inline. Lets the detail view render before
  // catalog.json has even been fetched — see seedPrerenderedProduct().
  replaceOnce('prerender-payload', /(\r?\n\s*window\.__API_BASE__ = ")/,
    '\n  window.__PRERENDER__ = { product: ' + jsonForScript(p) + ' };$1');

  return { html, missed };
}

function loadCatalog() {
  if (!fs.existsSync(SNAPSHOT)) return null;
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    if (!snap || snap.schema !== 1 || !Array.isArray(snap.products)) return null;
    return snap.products;
  } catch (err) {
    console.warn(`[prerender] catalog.json is unreadable (${err.message}).`);
    return null;
  }
}

function readManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return Array.isArray(m.slugs) ? m.slugs : [];
  } catch (err) { return []; }
}

/**
 * Removes pages this script previously generated for products that no longer
 * exist. Without it, deactivating a product leaves its page served forever:
 * still shareable, still indexed, still quoting a price for something nobody
 * can buy.
 *
 * Driven by the manifest, never by "everything in product/" — so it can only
 * delete directories it created itself.
 */
function pruneStalePages(keepSlugs) {
  let removed = 0;
  for (const slug of readManifest()) {
    if (keepSlugs.has(slug)) continue;
    const dir = path.join(OUT_ROOT, slug);
    // path.resolve guards against a manifest entry like "../.." — the manifest
    // is our own output, but a delete loop should never take that on trust.
    if (!path.resolve(dir).startsWith(path.resolve(OUT_ROOT) + path.sep)) continue;
    if (!fs.existsSync(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

function main() {
  const products = loadCatalog();

  if (!products || !products.length) {
    // Soft failure, same reasoning as the snapshot generator: a deploy carrying
    // yesterday's product pages beats a deploy blocked over link previews. With
    // no catalog.json the storefront still works — the SPA renders every
    // product client-side, exactly as it did before this script existed.
    console.warn('[prerender] No usable catalog.json — skipping. Product pages fall back to the SPA.');
    return;
  }

  const usable = products.filter((p) => p && p.slug && p.name);
  if (usable.length > MAX_PAGES) {
    console.warn(`[prerender] ${usable.length} products exceeds PRERENDER_MAX_PAGES=${MAX_PAGES}. Prerendering the first ${MAX_PAGES}; the rest still work via the SPA, they just share the generic link preview. Raise the cap deliberately if this is expected.`);
  }
  const batch = usable.slice(0, MAX_PAGES);

  const source = fs.readFileSync(SOURCE, 'utf8');

  // Render everything BEFORE writing anything. If the head of index.html has
  // changed shape, we want to find out while the previous build's pages are
  // still intact rather than half-way through replacing them with broken ones.
  const rendered = [];
  const missedTotals = new Map();
  for (const p of batch) {
    const { html, missed } = renderProductPage(source, p);
    missed.forEach((m) => missedTotals.set(m, (missedTotals.get(m) || 0) + 1));
    rendered.push({ slug: p.slug, html });
  }

  if (missedTotals.size) {
    // The failure that looks like success: pages written, deploy green, every
    // link preview silently wrong. Refuse to publish them and say why.
    console.error('[prerender] ABORTED — these tags were not rewritten, so the pages would carry the WRONG link preview:');
    for (const [tag, count] of missedTotals) console.error(`    ${tag}: missed on ${count} page(s)`);
    console.error('[prerender] The head of index.html has changed shape. Fix the patterns in renderProductPage().');
    console.error('[prerender] No pages written. Product links keep the generic preview until this is fixed.');
    return;
  }

  fs.mkdirSync(OUT_ROOT, { recursive: true });
  for (const page of rendered) {
    const dir = path.join(OUT_ROOT, page.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), page.html, 'utf8');
  }

  const pruned = pruneStalePages(new Set(rendered.map((r) => r.slug)));
  fs.writeFileSync(MANIFEST, JSON.stringify({
    generatedAt: new Date().toISOString(),
    slugs: rendered.map((r) => r.slug)
  }), 'utf8');

  const kb = (Buffer.byteLength(source, 'utf8') / 1024).toFixed(0);
  console.log(`[prerender] Wrote ${rendered.length} product page(s)${pruned ? `, pruned ${pruned} stale` : ''} (~${kb}KB each uncompressed, ~85KB served).`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[prerender] Generation failed:', err.message);
  }
  // Always 0. Link previews must never be able to block a deploy — every
  // failure path above leaves the storefront working exactly as it did before
  // this script existed.
  process.exitCode = 0;
}

module.exports = {
  renderProductPage, productJsonLd, titleFor, descriptionFor, titleCaseTerm, MINOR_WORDS,
  productImageUrl, attr, text, jsonForScript, catLabel, CAT_LABELS
};
