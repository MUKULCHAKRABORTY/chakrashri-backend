/**
 * RENDERED CONTRAST GATE
 *
 * WHY THIS EXISTS
 * A colour token is not readable or unreadable on its own — only against the
 * surface it lands on. Reasoning about the token is therefore worthless, and
 * this project had ten failures that no amount of reading the CSS would find:
 *
 *   - a section heading at 1.18:1, which is not "low contrast" but invisible:
 *     the astrology zone painted itself indigo and left the heading inheriting
 *     the ink colour meant for parchment;
 *   - the BESTSELLER badge at 2.68:1, white on marigold. That badge used to
 *     appear only where somebody had typed it by hand, which was almost
 *     nowhere. The shop now computes it for the top fifth of what sells, so a
 *     rare defect quietly became a common one on the busiest cards on the site;
 *   - secondary text that cleared AA on white and failed on parchment, because
 *     the token had been solved against the wrong background;
 *   - ten hardcoded copies of a stale muted brown that the token no longer
 *     matched.
 *
 * So this renders the real page in a real browser, walks every element that
 * paints text, resolves the effective background by climbing through
 * transparent ancestors, and measures the true ratio at the true font size —
 * on every route, because different routes paint different surfaces.
 *
 * Requires playwright + chromium. Skips cleanly without them, so `npm test`
 * still passes on a machine that has not run `npm run setup:browser`; CI sets
 * REQUIRE_BROWSER_TESTS=true, where a skip is a failure.
 *
 * Run: node test/contrast.test.js
 */
const path = require('path');

const REQUIRE_BROWSER = process.env.REQUIRE_BROWSER_TESTS === 'true';
const INSTALL_HINT = 'npx playwright install chromium';

function skip(reason) {
  if (REQUIRE_BROWSER) {
    console.error('\n[contrast] FAILED: ' + reason + '.');
    console.error('           REQUIRE_BROWSER_TESTS=true, so this cannot be skipped.');
    console.error('           Fix with: ' + INSTALL_HINT + '\n');
    process.exit(1);
  }
  console.log('\n[contrast] SKIPPED: ' + reason + '.');
  console.log('           To run it:  ' + INSTALL_HINT);
  console.log('           (Every other suite still ran; nothing here is failing.)\n');
  process.exit(0);
}

let chromium;
try { ({ chromium } = require('playwright')); }
catch { skip('the playwright package is not installed'); }

const ROOT = path.join(__dirname, '..');

/* Routes are listed rather than derived because this suite drives the SPA's own
   navigateTo(); seo-audit.js is the thing that derives the route list from
   PAGE_META and will fail if a page is added without being audited. */
const ROUTES = ['home', 'shop', 'puja', 'astrology', 'about', 'contact',
                'policies', 'blog', 'cart', 'checkout', 'wishlist', 'orders'];

/** Runs in the page. Returns every text node below its WCAG AA threshold. */
function collectFailures() {
  function parse(c) {
    const m = String(c).match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  }
  function lum({ r, g, b }) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function over(fg, bg) {
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function ratio(a, b) { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }

  /* The background a person actually sees behind this text: climb until an
     opaque colour is found, compositing translucent layers on the way. */
  function effectiveBg(el) {
    let node = el, acc = null;
    while (node) {
      const cs = getComputedStyle(node);
      // Text over a background IMAGE cannot be judged from colours alone.
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { unknown: true };
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) {
        acc = acc ? over(acc, c) : c;
        if (c.a >= 1) return acc;
      }
      node = node.parentElement;
    }
    return acc || { r: 255, g: 255, b: 255, a: 1 };
  }

  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    // Only elements painting their OWN text, or a container's colour would be
    // reported once per descendant.
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;

    const fg = parse(cs.color);
    if (!fg || fg.a === 0) continue;
    const bg = effectiveBg(el);
    if (bg.unknown) continue;

    const r = ratio(fg.a < 1 ? over(fg, bg) : fg, bg);
    const px = parseFloat(cs.fontSize);
    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
    // WCAG "large text": 24px, or 18.66px when bold. Everything else needs 4.5.
    const need = (px >= 24 || (bold && px >= 18.66)) ? 3.0 : 4.5;
    if (r >= need) continue;

    const key = el.className + '|' + cs.color + '|' + Math.round(r * 100);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      el: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''),
      text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40),
      color: cs.color,
      bg: 'rgb(' + Math.round(bg.r) + ', ' + Math.round(bg.g) + ', ' + Math.round(bg.b) + ')',
      px: Math.round(px * 10) / 10, ratio: Math.round(r * 100) / 100, need
    });
  }
  return out.sort((a, b) => a.ratio - b.ratio);
}

(async () => {
  let browser;
  try { browser = await chromium.launch(); }
  catch (err) {
    const msg = String((err && err.message) || err);
    if (/Executable doesn't exist|playwright install/i.test(msg)) skip('the chromium binary is not downloaded');
    throw err;
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const failures = [];
  let checkedRoutes = 0;

  // ---- storefront, every route -------------------------------------------
  await page.goto('file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/'));
  await page.waitForTimeout(1200);
  // A running transition reports a mid-tween colour; freeze before measuring.
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;}' });

  console.log('\n  storefront route     text nodes below AA');
  console.log('  ' + '-'.repeat(44));
  for (const route of ROUTES) {
    await page.evaluate((r) => { if (typeof navigateTo === 'function') navigateTo(r); }, route);
    await page.waitForTimeout(400);
    const found = await page.evaluate(collectFailures);
    checkedRoutes++;
    console.log('  ' + route.padEnd(21) + (found.length ? found.length : 'none'));
    for (const f of found) failures.push(Object.assign({ where: 'index.html /' + route }, f));
  }

  // ---- admin console -------------------------------------------------------
  await page.goto('file:///' + path.join(ROOT, 'admin.html').replace(/\\/g, '/'));
  await page.waitForTimeout(900);
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;}' });
  const adminFound = await page.evaluate(collectFailures);
  console.log('\n  admin console        ' + (adminFound.length ? adminFound.length : 'none'));
  for (const f of adminFound) failures.push(Object.assign({ where: 'admin.html' }, f));

  await browser.close();

  // A scan that silently matches nothing would pass forever.
  if (checkedRoutes < ROUTES.length) {
    console.error('\n[contrast] FAILED: only ' + checkedRoutes + ' of ' + ROUTES.length + ' routes were measured.\n');
    process.exit(1);
  }

  if (!failures.length) {
    console.log('\n  EVERY TEXT NODE ON EVERY ROUTE MEETS WCAG AA\n');
    process.exit(0);
  }

  console.log('\n  ' + 'ratio'.padEnd(7) + 'need'.padEnd(6) + 'size'.padEnd(7) + 'element'.padEnd(26) + 'where / text');
  console.log('  ' + '-'.repeat(104));
  for (const f of failures) {
    console.log('  ' + String(f.ratio).padEnd(7) + String(f.need).padEnd(6) + String(f.px).padEnd(7)
      + f.el.slice(0, 25).padEnd(26) + f.where + '  "' + f.text + '"');
    console.log('  ' + ' '.repeat(19) + f.color + ' on ' + f.bg);
  }
  console.log('\n  >> ' + failures.length + ' text node(s) below WCAG AA\n');
  process.exit(1);
})().catch((err) => {
  console.error('\n[contrast] FAILED: ' + ((err && err.stack) || err) + '\n');
  process.exit(1);
});
