/**
 * Generates sitemap.xml from the live product catalog — closes the last part
 * of SEO-01.
 *
 * WHY GENERATED AND NOT HAND-WRITTEN
 * A hand-written sitemap goes stale the first time a product is added or
 * deactivated, and a stale sitemap is worse than none: it tells Google about
 * URLs that 404 and omits the ones that exist, which costs crawl budget and
 * trust. This reads the same public API the storefront reads, so the sitemap is
 * correct by construction on every deploy.
 *
 * RUN: node scripts/generate-sitemap.js
 * Wired into netlify.toml's build command, so it runs on every storefront
 * deploy without anyone remembering to.
 *
 * FAILS SOFT, DELIBERATELY: if the API is unreachable (cold start, deploy
 * ordering, a network blip), it writes a sitemap containing the static pages
 * rather than failing the build. A deploy that is blocked because a sitemap
 * could not be generated is a worse outcome than a deploy with a sitemap that
 * is missing product URLs for a few hours until the next build.
 */
const fs = require('fs');
const path = require('path');

const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://www.chakrashri.com').replace(/\/+$/, '');
const API_BASE = (process.env.API_BASE || 'https://chakrashri-api.onrender.com').replace(/\/+$/, '');
const OUTPUT = path.join(__dirname, '..', 'sitemap.xml');
const FETCH_TIMEOUT_MS = parseInt(process.env.SITEMAP_FETCH_TIMEOUT_MS || '20000', 10);

// The pages that always exist, with a crawl priority reflecting how much of the
// business each actually carries. Cart/checkout/wishlist/orders are deliberately
// absent — they are per-customer and are disallowed in robots.txt.
const STATIC_PAGES = [
  { loc: '/', priority: '1.0', changefreq: 'daily' },
  { loc: '/shop', priority: '0.9', changefreq: 'daily' },
  { loc: '/puja', priority: '0.9', changefreq: 'weekly' },
  { loc: '/astrology', priority: '0.9', changefreq: 'weekly' },
  { loc: '/blog', priority: '0.6', changefreq: 'weekly' },
  { loc: '/about', priority: '0.5', changefreq: 'monthly' },
  { loc: '/contact', priority: '0.5', changefreq: 'monthly' },
  { loc: '/policies', priority: '0.3', changefreq: 'yearly' }
];

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function urlEntry({ loc, lastmod, changefreq, priority }) {
  return [
    '  <url>',
    `    <loc>${xmlEscape(SITE_ORIGIN + loc)}</loc>`,
    lastmod ? `    <lastmod>${xmlEscape(new Date(lastmod).toISOString().slice(0, 10))}</lastmod>` : null,
    changefreq ? `    <changefreq>${changefreq}</changefreq>` : null,
    priority ? `    <priority>${priority}</priority>` : null,
    '  </url>'
  ].filter(Boolean).join('\n');
}

async function fetchProducts() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/products/meta/slugs`, { signal: controller.signal });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const body = await res.json();
    return Array.isArray(body.products) ? body.products : [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCategories() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/products/meta/top-categories?limit=20`, { signal: controller.signal });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.categories) ? body.categories : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const entries = STATIC_PAGES.map(urlEntry);
  let productCount = 0;
  let categoryCount = 0;

  try {
    const [products, categories] = await Promise.all([fetchProducts(), fetchCategories()]);

    for (const c of categories) {
      if (!c.category) continue;
      categoryCount++;
      entries.push(urlEntry({
        loc: '/shop?category=' + encodeURIComponent(c.category),
        changefreq: 'weekly',
        priority: '0.7'
      }));
    }

    for (const p of products) {
      if (!p.slug) continue;
      productCount++;
      entries.push(urlEntry({
        loc: '/product/' + encodeURIComponent(p.slug),
        lastmod: p.updated_at,
        changefreq: 'weekly',
        priority: '0.8'
      }));
    }
  } catch (err) {
    // Soft failure — see the note at the top of this file.
    console.warn(`[sitemap] Could not reach the catalog API (${err.message}). Writing the static pages only.`);
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries.join('\n'),
    '</urlset>',
    ''
  ].join('\n');

  fs.writeFileSync(OUTPUT, xml, 'utf8');
  console.log(`[sitemap] Wrote ${OUTPUT}: ${STATIC_PAGES.length} static + ${categoryCount} category + ${productCount} product URLs.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[sitemap] Generation failed:', err.message);
    // Still non-fatal to the build: write what we can and move on.
    try {
      fs.writeFileSync(
        OUTPUT,
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${STATIC_PAGES.map(urlEntry).join('\n')}\n</urlset>\n`,
        'utf8'
      );
    } catch { /* nothing further to do */ }
    process.exit(0);
  });
}

module.exports = { urlEntry, xmlEscape, STATIC_PAGES };
