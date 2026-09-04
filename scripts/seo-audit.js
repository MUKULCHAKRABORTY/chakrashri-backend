/**
 * A real SEO audit: renders every route and reads what a crawler would get.
 *
 * WHY THIS EXISTS AS A SCRIPT, NOT A CHECKLIST
 * Every signal here is a RUNTIME property. This storefront is a single page
 * that rewrites its own <title>, description, canonical and JSON-LD on every
 * navigation, so reading index.html tells you the code intends to set them and
 * nothing about whether a given route actually ends up with a unique title, one
 * <h1>, or a canonical that points at itself. A stale canonical or a duplicated
 * title is invisible in source and fatal in search.
 *
 * It renders each route in a real browser, extracts what is in the head and the
 * body at that moment, and reports the problems. It also checks the artefacts a
 * crawler reads before it ever runs JavaScript: robots.txt, the sitemap, the
 * prerendered product pages, and the redirect rules.
 *
 * Requires playwright + chromium. Skips cleanly when unavailable;
 * REQUIRE_BROWSER_TESTS=true turns that skip into a failure, as CI sets.
 *
 * Run: npm run seo:audit
 */
const REQUIRE_BROWSER = process.env.REQUIRE_BROWSER_TESTS === 'true';
const INSTALL_HINT = 'npx playwright install chromium';

function skip(reason, hint) {
  if (REQUIRE_BROWSER) {
    console.error('\n[seo-audit] FAILED: ' + reason + '.');
    console.error('            REQUIRE_BROWSER_TESTS=true, so this cannot be skipped.');
    console.error('            Fix with: ' + hint + '\n');
    process.exit(1);
  }
  console.log('\n[seo-audit] SKIPPED: ' + reason + '.');
  console.log('            To run it:  ' + hint + '\n');
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  skip('the playwright package is not installed', 'npm install   then   ' + INSTALL_HINT);
}

const fs = require('fs');
const path = require('path');
const http = require('http');
// The single declaration of what makes a description good. Read, never retyped:
// this file used to carry two more copies of it, disagreeing with each other
// and with the admin form.
const { SEO_DESCRIPTION } = require('./seo-fields');

const ROOT = path.join(__dirname, '..');
const PORT = 5731;

/* ---------------------------------------------------------------- findings

   TWO SEVERITIES, and the distinction is what keeps this gate usable.

   A BLOCKING finding is something the code got wrong and a deploy would ship:
   a canonical pointing at the wrong page, a duplicate title, an indexable page
   marked noindex, a private page that is not. Those are defects.

   An ADVISORY finding is something only a person can fix — a product whose
   description is too thin to earn a snippet is the seller's copy, not a bug.
   Blocking a release on somebody's copywriting is how a gate gets switched off,
   and a gate that is off catches nothing at all. Advisories are printed every
   run, loudly enough to act on, and do not fail the build. */
const findings = [];
let checks = 0;
function ok(label) { checks++; }
function fail(where, what, detail) {
  checks++;
  findings.push({ where, what, detail, blocking: true });
}
function advise(where, what, detail) {
  checks++;
  findings.push({ where, what, detail, blocking: false });
}
function check(cond, where, what, detail) {
  if (cond) ok(); else fail(where, what, detail);
}
// Same shape, advisory severity.
function suggest(cond, where, what, detail) {
  if (cond) ok(); else advise(where, what, detail);
}

// A tiny static server so the SPA runs over http:// (canonical and og:url read
// location.origin, which is not a real origin under file://).
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/') rel = '/index.html';
      let file = path.join(ROOT, rel);
      // The SPA fallback Netlify provides via _redirects. Without it every
      // route under test would 404 and the audit would measure nothing.
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        const indexed = path.join(file, 'index.html');
        file = fs.existsSync(indexed) ? indexed : path.join(ROOT, 'index.html');
      }
      try {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(fs.readFileSync(file));
      } catch {
        res.writeHead(404); res.end('not found');
      }
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/* THE ROUTE LIST IS DERIVED FROM THE SITE, NOT TYPED HERE.

   A hardcoded list audits the pages that existed the day it was written. Add a
   page next month and it is simply not checked — no title rule, no canonical
   rule, no h1 rule, nothing — and the gate stays green while the new page ships
   with whatever it happens to have.

   PAGE_META in index.html is the storefront's own declaration of every route it
   can show, and its `noindex` flag is the same one updatePageMeta() acts on. So
   the audit reads that: a page added there is audited from the moment it exists,
   and a page marked noindex is checked for being noindex rather than for being
   indexable. Nobody has to remember this file.

   `product` and `blog-post` are parameterised and are covered separately —
   every prerendered product page is audited below, by file. */
const PARAMETERISED = new Set(['product', 'blog-post']);

function deriveRoutes() {
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const start = src.indexOf('const PAGE_META = {');
  if (start < 0) {
    throw new Error('Could not find PAGE_META in index.html — the audit derives its route list from it.');
  }
  let depth = 0, end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  const block = src.slice(start, end + 1);

  const routes = [];
  // Each entry looks like `name: { title: '...', description: '...', noindex: true }`
  const entryRe = /(?:^|\n)\s*'?([a-zA-Z-]+)'?:\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = entryRe.exec(block))) {
    const name = m[1];
    if (PARAMETERISED.has(name)) continue;
    const body = m[2];
    routes.push({
      name,
      path: name === 'home' ? '/' : '/' + name,
      index: !/noindex:\s*true/.test(body)
    });
  }
  if (routes.length < 5) {
    throw new Error('Only ' + routes.length + ' routes parsed out of PAGE_META — the shape changed, '
      + 'and auditing a handful of pages while believing it covers the site is worse than not running.');
  }
  return routes;
}

const ROUTES = deriveRoutes();

async function readSeo(page) {
  return page.evaluate(() => {
    const meta = (sel, attr) => {
      const el = document.querySelector(sel);
      return el ? (el.getAttribute(attr || 'content') || '').trim() : null;
    };
    /* VISIBLE headings only, in document order.

       This is a single-page app: every route's markup stays in the DOM and one
       section is shown at a time. Counting the hidden ones reported eleven
       <h1>s on every route and heading "skips" across a boundary no reader
       ever crosses. offsetParent is null for anything inside a display:none
       ancestor, which is exactly how the inactive pages are hidden. */
    const visible = (el) => {
      // offsetParent alone is not enough. Modals on this page are hidden with
      // opacity/visibility rather than display:none, so their headings kept
      // reporting as visible and polluted the outline with "Confirm Your
      // Booking" on pages that have no booking on them.
      if (el.offsetParent === null) return false;
      if (!el.getClientRects().length) return false;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
      }
      return true;
    };
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .filter(visible)
      .map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.trim().slice(0, 60) }));
    // Counted separately so "no visible h1" is still reported as the fault it is.
    const hiddenH1s = document.querySelectorAll('h1').length - headings.filter((h) => h.level === 1).length;
    /* Reported per block, with its id and a slice of its content: "a JSON-LD
       block is not valid JSON" is not actionable when a page carries three of
       them. */
    const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => {
        const txt = s.textContent || '';
        try { JSON.parse(txt); return { id: s.id || '(no id)', ok: true }; }
        catch (e) { return { id: s.id || '(no id)', ok: false, len: txt.length, head: txt.trim().slice(0, 60) }; }
      });
    // Only images the crawler can actually see on this route.
    const imgs = [...document.querySelectorAll('img')]
      .filter((i) => i.offsetParent !== null)
      .map((i) => ({ alt: i.getAttribute('alt'), src: (i.getAttribute('src') || '').slice(0, 60),
                     w: i.getAttribute('width'), h: i.getAttribute('height'), loading: i.getAttribute('loading') }));
    const links = [...document.querySelectorAll('a')]
      .filter((a) => a.offsetParent !== null)
      .map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim().slice(0, 40) }));
    return {
      url: location.href,
      lang: document.documentElement.getAttribute('lang'),
      title: (document.title || '').trim(),
      description: meta('meta[name="description"]'),
      canonical: meta('link[rel="canonical"]', 'href'),
      robots: meta('meta[name="robots"]'),
      ogTitle: meta('meta[property="og:title"]'),
      ogDesc: meta('meta[property="og:description"]'),
      ogUrl: meta('meta[property="og:url"]'),
      ogImage: meta('meta[property="og:image"]'),
      ogType: meta('meta[property="og:type"]'),
      twitterCard: meta('meta[name="twitter:card"]'),
      h1s: headings.filter((h) => h.level === 1),
      hiddenH1s,
      headings,
      jsonld,
      imgs,
      links,
      viewport: meta('meta[name="viewport"]')
    };
  });
}

(async () => {
  let browser;
  try { browser = await chromium.launch(); }
  catch { skip('chromium is not installed for playwright', INSTALL_HINT); }

  const server = await serve();
  const page = await browser.newPage();
  const base = 'http://127.0.0.1:' + PORT;

  const seen = { titles: new Map(), descriptions: new Map() };
  const perRoute = [];

  for (const route of ROUTES) {
    await page.goto(base + route.path, { waitUntil: 'domcontentloaded' });
    // The SPA sets its head after boot; give the catalog snapshot time to land.
    await page.waitForTimeout(1800);
    const seo = await readSeo(page);
    perRoute.push({ route, seo });
    const W = route.path;

    // ---- title -----------------------------------------------------------
    check(!!seo.title, W, 'has no <title>');
    if (seo.title) {
      check(seo.title.length >= 15, W, 'title is too short to say anything', seo.title);
      // Google truncates around 60 characters. Longer is not an error, but it
      // means the tail is never read, so it is reported.
      suggest(seo.title.length <= 65, W, 'title is longer than ~60 chars and will be truncated',
        seo.title.length + ': ' + seo.title);
      const prev = seen.titles.get(seo.title);
      check(!prev, W, 'DUPLICATE title, already used by ' + prev, seo.title);
      seen.titles.set(seo.title, W);
    }

    // ---- description -----------------------------------------------------
    check(!!seo.description, W, 'has no meta description');
    if (seo.description) {
      // Length only matters where the page can appear in results. A noindex
      // cart page having a short description is not a defect.
      if (route.index) {
        suggest(seo.description.length >= SEO_DESCRIPTION.MIN, W,
          'meta description is too thin to earn a snippet', seo.description);
        /* Deliberately HARD_MAX, not IDEAL_MAX. Going past what Google renders
           is not a fault — the first ~155 characters still show — and an
           advisory that fires on most of a healthy catalogue teaches people to
           ignore advisories. Only genuinely runaway text is reported. */
        suggest(seo.description.length <= SEO_DESCRIPTION.HARD_MAX, W,
          'meta description is far longer than a summary', seo.description.length + ' chars');
      }
      const prev = seen.descriptions.get(seo.description);
      check(!prev, W, 'DUPLICATE meta description, already used by ' + prev);
      seen.descriptions.set(seo.description, W);
    }

    // ---- canonical -------------------------------------------------------
    check(!!seo.canonical, W, 'has no canonical');
    if (seo.canonical) {
      check(/^https?:\/\//.test(seo.canonical), W, 'canonical is not absolute', seo.canonical);
      // It must point at THIS route. A canonical stuck on the home page tells
      // Google every other page is a duplicate of it.
      const canonPath = (() => { try { return new URL(seo.canonical).pathname; } catch { return null; } })();
      check(canonPath === route.path || (route.path === '/' && canonPath === '/'),
        W, 'canonical points somewhere else — this route reads as a duplicate', seo.canonical);
    }

    // ---- indexability ----------------------------------------------------
    if (route.index) {
      check(!/noindex/i.test(seo.robots || ''), W, 'an indexable page is marked noindex', seo.robots);
    } else {
      check(/noindex/i.test(seo.robots || ''), W,
        'a private page is NOT marked noindex — carts and orders must never be indexed', seo.robots);
    }

    // ---- open graph / twitter -------------------------------------------
    check(!!seo.ogTitle, W, 'no og:title');
    check(!!seo.ogDesc, W, 'no og:description');
    check(!!seo.ogImage, W, 'no og:image — shared links render without a picture');
    if (seo.ogUrl) {
      const ogPath = (() => { try { return new URL(seo.ogUrl).pathname; } catch { return null; } })();
      check(ogPath === route.path, W, 'og:url points at a different page', seo.ogUrl);
    } else fail(W, 'no og:url');
    check(!!seo.twitterCard, W, 'no twitter:card');

    // ---- structure -------------------------------------------------------
    check(seo.h1s.length === 1, W,
      seo.h1s.length === 0 ? 'no VISIBLE <h1>' : 'more than one visible <h1>',
      seo.h1s.map((h) => h.text).join(' | '));
    check(seo.lang === 'en' || /^en-/.test(seo.lang || ''), W, 'html lang is not English', seo.lang);
    check(!!seo.viewport, W, 'no viewport meta — mobile ranking depends on it');

    // Heading order: a jump from h2 straight to h4 breaks the outline a crawler
    // builds of the page.
    let lastLevel = 0, skipped = null;
    for (const h of seo.headings) {
      if (lastLevel && h.level > lastLevel + 1) { skipped = 'h' + lastLevel + ' -> h' + h.level + ' at "' + h.text + '"'; break; }
      lastLevel = h.level;
    }
    check(!skipped, W, 'heading level skipped', skipped);

    // ---- images ----------------------------------------------------------
    const noAlt = seo.imgs.filter((i) => i.alt === null);
    check(noAlt.length === 0, W, noAlt.length + ' visible image(s) have no alt attribute',
      noAlt.map((i) => i.src).join(', ').slice(0, 120));

    // ---- links -----------------------------------------------------------
    const deadHrefs = seo.links.filter((l) => !l.href || l.href === '#');
    check(deadHrefs.length === 0, W, deadHrefs.length + ' link(s) have no crawlable href',
      deadHrefs.map((l) => l.text).join(', ').slice(0, 120));

    // ---- structured data -------------------------------------------------
    const badLd = seo.jsonld.filter((b) => !b.ok);
    check(badLd.length === 0, W, 'JSON-LD block(s) not valid JSON',
      badLd.map((b) => '#' + b.id + ' (' + b.len + ' chars) ' + JSON.stringify(b.head)).join('; '));
  }

  // ======================================================================
  // Artefacts a crawler reads BEFORE any JavaScript runs.
  // ======================================================================
  const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return null; } };

  const robots = read('robots.txt');
  check(!!robots, 'robots.txt', 'is missing');
  if (robots) {
    check(/Sitemap:\s*https?:\/\//i.test(robots), 'robots.txt', 'does not point at an absolute sitemap URL');
    for (const priv of ['/checkout', '/cart', '/orders']) {
      check(robots.includes('Disallow: ' + priv), 'robots.txt', 'does not disallow ' + priv);
    }
    check(!/^Disallow:\s*\/\s*$/m.test(robots), 'robots.txt', 'DISALLOWS THE WHOLE SITE');
  }

  const sitemap = read('sitemap.xml');
  check(!!sitemap, 'sitemap.xml', 'is missing');
  if (sitemap) {
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    check(locs.length > 0, 'sitemap.xml', 'contains no URLs');
    // A sitemap that lists a noindex URL sends contradictory instructions.
    const priv = locs.filter((u) => /\/(cart|checkout|orders|wishlist)(\/|$)/.test(u));
    check(priv.length === 0, 'sitemap.xml', 'lists private pages that are noindex', priv.join(', '));
    const rel = locs.filter((u) => !/^https?:\/\//.test(u));
    check(rel.length === 0, 'sitemap.xml', 'contains relative URLs — every <loc> must be absolute', rel.join(', '));
    const dupes = locs.filter((u, i) => locs.indexOf(u) !== i);
    check(dupes.length === 0, 'sitemap.xml', 'contains duplicate URLs', dupes.join(', '));
    // Every indexable route should be discoverable.
    for (const r of ROUTES.filter((x) => x.index)) {
      const want = r.path === '/' ? '/' : r.path;
      check(locs.some((u) => { try { return new URL(u).pathname === want; } catch { return false; } }),
        'sitemap.xml', 'does not list ' + want);
    }
  }

  // Prerendered product pages: what a crawler that runs no JavaScript sees.
  const productDir = path.join(ROOT, 'product');
  if (fs.existsSync(productDir)) {
    const slugs = fs.readdirSync(productDir).filter((d) => fs.existsSync(path.join(productDir, d, 'index.html')));
    check(slugs.length > 0, 'product/', 'exists but contains no prerendered pages');
    const titles = new Map();
    for (const slug of slugs) {
      const html = fs.readFileSync(path.join(productDir, slug, 'index.html'), 'utf8');
      const W = 'product/' + slug;
      const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
      const canon = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
      const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
      check(!!title && !/^Chakrashri —/.test(title), W, 'still carries the generic site title', title);
      check(!!canon && canon.includes('/product/' + slug), W, 'canonical does not point at this product', canon);
      // The same floor the admin form shows while the seller is typing it.
      suggest(!!desc && desc.length >= SEO_DESCRIPTION.MIN, W,
        'description is too thin to earn a snippet — this is product copy, not code', desc);
      suggest(!desc || desc.length <= SEO_DESCRIPTION.HARD_MAX, W,
        'description is far longer than a summary', (desc || '').length + ' chars');
      const prev = titles.get(title);
      check(!prev, W, 'DUPLICATE prerendered title, shared with ' + prev, title);
      titles.set(title, W);
      /* [^>]* after the type: these tags carry an id (ldOrganization, ldWebSite,
         ldPage), and a pattern that demanded the tag close right after the type
         matched none of them and reported ten false failures. */
      const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
      let hasProduct = false;
      let badLd = 0;
      for (const m of ld) {
        try { const o = JSON.parse(m[1]); if (o['@type'] === 'Product') hasProduct = true; }
        catch { badLd++; }
      }
      check(ld.length > 0, W, 'has no JSON-LD at all');
      check(badLd === 0, W, badLd + ' JSON-LD block(s) are not valid JSON');
      check(hasProduct, W, 'has no Product JSON-LD — no rich result is possible');
    }
  }

  const redirects = read('_redirects');
  check(!!redirects, '_redirects', 'is missing — every deep link would 404 on Netlify');
  if (redirects) {
    check(/\/\*\s+\/index\.html\s+200/.test(redirects), '_redirects', 'has no SPA fallback rule');
  }

  await browser.close();
  server.close();

  // ------------------------------------------------------------- report
  console.log('\nSEO audit — ' + ROUTES.length + ' routes rendered, ' + checks + ' checks\n');

  const blocking = findings.filter((f) => f.blocking);
  const advisories = findings.filter((f) => !f.blocking);

  const report = (title, list) => {
    if (!list.length) return;
    console.log('  ' + title);
    const byWhere = new Map();
    for (const f of list) {
      if (!byWhere.has(f.where)) byWhere.set(f.where, []);
      byWhere.get(f.where).push(f);
    }
    for (const [where, group] of byWhere) {
      console.log('    ' + where);
      for (const f of group) console.log('      - ' + f.what + (f.detail ? '\n          ' + f.detail : ''));
    }
    console.log('');
  };

  report('DEFECTS — these would ship:', blocking);
  report('WORTH FIXING — copy and content, not code:', advisories);

  if (!blocking.length) {
    console.log('  Every route carries a unique title, its own canonical, one h1, complete');
    console.log('  social tags, alt text on every image, crawlable links and valid JSON-LD.');
    if (advisories.length) {
      console.log('  ' + advisories.length + ' advisory item(s) above are for a person to write, and do not fail the build.');
    }
    console.log('');
    process.exit(0);
  }
  console.log('  ' + blocking.length + ' defect(s) — the build fails until they are fixed.\n');
  process.exit(1);
})();
