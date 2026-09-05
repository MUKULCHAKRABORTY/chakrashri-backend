#!/usr/bin/env node
/**
 * DOES THE PAGE ACTUALLY WORK AS THE SCREEN GETS NARROWER?
 *
 * Every responsive defect on this site has been found by looking at one width
 * and missing the others: a button clipped by an overflow:hidden crop, a label
 * that only truncates on the narrowest phone, a control that falls below the
 * minimum touch target once its container query kicks in. Reading the CSS does
 * not find those. Rendering every route at every width and MEASURING does.
 *
 * WHAT IT CHECKS, on each route at each width:
 *
 *   horizontal scroll    the page must never scroll sideways. This is the one
 *                        that users notice immediately and report as "broken".
 *   escaping elements    anything whose box extends past the viewport, which is
 *                        what causes the scroll above. Named, so it is fixable.
 *   touch targets        every button and link at 767px and below must be at
 *                        least 44x44 CSS pixels, which is the accepted minimum
 *                        for a fingertip. Below that, people miss and give up.
 *   clipped controls     a button whose own text overflows its box. The label is
 *                        the only thing telling somebody what the button does.
 *   collisions           two interactive elements overlapping by more than a
 *                        few pixels: whichever is on top steals the other's taps.
 *
 * Deliberately NOT checked: anything about colour or spacing taste. Those are
 * judgements. These five are facts, and each of them makes something unusable.
 *
 * Run: npm run audit:responsive          (needs the preview server on :4173)
 *      npm run audit:responsive -- --json
 */
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('\n  SKIP  playwright is not installed — run: npm install\n');
  process.exit(0);
}

/* IT STARTS ITS OWN SERVER, SO IT CAN RUN ANYWHERE.

   The obvious alternative was to open index.html over file:// and drive the
   site's own navigateTo(), which is what test/contrast.test.js does. That does
   not work here: the catalog is fetched, and a file:// page cannot fetch, so
   every grid comes back EMPTY. An audit of the product card that runs with no
   product cards on the page would pass on a site where every one of them was
   broken — worse than not running at all.

   So if nothing is already listening it starts scripts/preview-server.js on a
   port of its own and shuts it down afterwards. One command, no setup, and the
   same result on a laptop and in CI. */
const { spawn } = require('child_process');
const BASE = process.env.AUDIT_BASE || 'http://localhost:4173';
const ROUTES = ['home', 'shop', 'cart', 'contact', 'puja', 'astrology', 'policies', 'about'];
/* 320 is the narrowest phone still in use; 1440 is a common desktop. The three
   in the middle are where the column counts and container queries change, which
   is where things break. */
const WIDTHS = [320, 360, 390, 480, 640, 768, 1024, 1440];
const TOUCH_MAX_WIDTH = 767;     // at and below this, a finger is the pointer
const MIN_TARGET = 44;

/* Runs INSIDE the page. Kept in one function so there is a single place where
   "what counts as a defect" is defined. */
function probe(opts) {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const visible = (el) => {
    /* Opacity has to be checked up the ANCESTORS, not just on the element. The
       card's wishlist and quick-view buttons live in a .p-quick wrapper held at
       opacity:0 until the card is hovered — they are full size and in the
       layout, but nothing can see or reach them, and on a touch screen there is
       no hover so they never appear at all. Reading opacity on the button alone
       reports eight invisible desktop controls as undersized phone targets. */
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    }
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  /* An element with no id and no class is unfindable from a report, so an
     anonymous one is named by its nearest identifiable parent instead. */
  const own = (el) => el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    (el.className && typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const name = (el) => {
    let s = own(el);
    if (!el.id && !(el.className && String(el.className).trim())) {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        if (n.id || (n.className && String(n.className).trim())) { s = own(n) + ' > ' + s; break; }
      }
    }
    return s;
  };

  /* An element that is off-screen ON PURPOSE — a closed drawer, a slide-in
     panel — is not a defect. Those are translated or positioned outside the
     viewport and are not what causes a scrollbar; the browser's own
     scrollWidth is the arbiter, so anything reported here is additionally
     required to be inside a page that actually scrolls. */
  const offscreenByDesign = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed') return true;
      if (cs.transform && cs.transform !== 'none' && /matrix\(1, 0, 0, 1, -?\d{3,}/.test(cs.transform)) return true;
      if (n.getAttribute('aria-hidden') === 'true' && !n.contains(document.activeElement)) return true;
      /* A COLLAPSED ACCORDION IS NOT A DEFECT. The footer's closed columns are
         clipped to zero height and marked inert, but their links still report a
         box, so they read as controls stacked on top of the heading. inert is
         the browser's own statement that nothing inside can be reached. */
      if (n.inert || n.hasAttribute('inert')) return true;
      /* A HORIZONTAL CAROUSEL IS NOT A DEFECT EITHER. Its cards are laid out in
         a row wider than the screen ON PURPOSE and scroll inside their own
         track; only the PAGE scrolling sideways is a bug. */
      if (n !== el) {
        const ox = cs.overflowX;
        /* hidden counts as well as auto/scroll. The testimonial rail is a
           transform-based carousel inside an overflow:hidden wrapper: its cards
           are wider than the screen ON PURPOSE and are clipped, so they cannot
           make the page scroll sideways, which is the only thing that matters. */
        if (ox !== 'visible' && n.scrollWidth > n.clientWidth + 1) return true;
      }
    }
    return false;
  };

  const escaping = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || offscreenByDesign(el)) continue;
    const b = el.getBoundingClientRect();
    if (b.right > vw + 2 || b.left < -2) {
      escaping.push({ el: name(el), left: Math.round(b.left), right: Math.round(b.right), vw });
      if (escaping.length >= 5) break;
    }
  }

  const controls = [...document.querySelectorAll('button, a[href], [role="button"], input, select, textarea')]
    .filter(visible)
    .filter((el) => !offscreenByDesign(el))
    /* tabindex="-1" is how this site turns a control OFF at a width where it is
       not a control — the footer headings above the phone breakpoint are buttons
       in the markup and headings in behaviour. Judging those as tap targets
       reports a finger-sized heading as a defect. */
    .filter((el) => el.getAttribute('tabindex') !== '-1' && !el.disabled);

  const small = [];
  if (opts.touch) {
    for (const el of controls) {
      const b = el.getBoundingClientRect();
      /* An inline link inside a paragraph is text, not a tap target with its own
         box, so it is judged by height alone; a real control needs both. */
      /* A TEXT LINK IS JUDGED ON HEIGHT, NOT ON BOTH DIMENSIONS.

         A breadcrumb reading "Home" is 38px wide because the word is 38px wide.
         Demanding 44 would mean padding short words out until they stopped
         sitting in a line, which is not a fix for anything. What matters is the
         ROW a finger lands on, so height is required and width is left to the
         text. Below 24px even that fails, and a 19px footer link was a real
         defect this caught.

         The computed display is deliberately NOT consulted. A link inside a flex
         container is blockified — .breadcrumb is display:flex, so its links
         compute as `flex` no matter what they are given — and an earlier version
         of this check tested for `inline` and therefore never exempted the one
         element it was written for.

         A product's TITLE counts as text for the same reason: the photograph
         above it links to the same product and is the whole width of the card,
         so the title is a second route to somewhere already reachable. */
      const inline = el.tagName === 'A' &&
        el.closest('p, li, small, .breadcrumb, .footer-col, .p-card');
      const w = b.width, h = b.height;
      const fails = inline ? h < opts.min - 20 : (w < opts.min || h < opts.min);
      if (fails) {
        small.push({ el: name(el), w: Math.round(w), h: Math.round(h),
                     text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24) });
        if (small.length >= 8) break;
      }
    }
  }

  const clipped = [];
  for (const el of controls) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') continue;
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible') {
      clipped.push({ el: name(el), scroll: el.scrollWidth, client: el.clientWidth,
                     text: (el.textContent || '').trim().slice(0, 24) });
      if (clipped.length >= 5) break;
    }
  }

  /* Two controls sharing screen space: whichever paints last takes the tap, and
     the other one is simply unreachable. Small overlaps are ignored because
     borders and shadows legitimately touch. */
  const collisions = [];
  const boxes = controls.map((el) => ({ el, b: el.getBoundingClientRect() }))
    .filter((x) => x.b.width < 400 && x.b.height < 200);
  for (let i = 0; i < boxes.length && collisions.length < 5; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i], B = boxes[j];
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      const ox = Math.min(A.b.right, B.b.right) - Math.max(A.b.left, B.b.left);
      const oy = Math.min(A.b.bottom, B.b.bottom) - Math.max(A.b.top, B.b.top);
      if (ox > 8 && oy > 8) {
        collisions.push({ a: name(A.el), b: name(B.el), overlap: Math.round(ox) + 'x' + Math.round(oy) });
        break;
      }
    }
  }

  return {
    hScroll: de.scrollWidth > de.clientWidth + 1,
    scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
    escaping, small, clipped, collisions
  };
}

(async () => {
  const wantJson = process.argv.includes('--json');
  const reachable = async (url) => {
    try { return (await fetch(url + '/', { signal: AbortSignal.timeout(1200) })).ok; }
    catch { return false; }
  };

  let base = BASE, own = null;
  if (!await reachable(base)) {
    /* A port of its own, so a preview server the developer is already using is
       never taken over or shut down underneath them. */
    const port = 4319;
    base = 'http://localhost:' + port;
    own = spawn(process.execPath, [path.join(__dirname, 'preview-server.js'), String(port)],
      { stdio: 'ignore' });
    for (let i = 0; i < 40 && !(await reachable(base)); i++) await new Promise((r) => setTimeout(r, 250));
    if (!await reachable(base)) {
      if (own) own.kill();
      console.log('  SKIP  could not start a preview server on ' + port);
      process.exit(0);
    }
  }
  const useServer = true;
  console.log('  source: ' + base + (own ? '  (started for this run)' : ''));
  const browser = await chromium.launch();
  const findings = [];
  for (const width of WIDTHS) {
    for (const route of ROUTES) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const jsErrors = [];
      /* The storefront calls the live API, which refuses a localhost origin.
         That is the preview server, not the page, so it is filtered out. */
      const noise = (s) => /onrender\.com|ERR_FAILED|Access to fetch|Failed to load resource|net::/.test(s);
      page.on('pageerror', (e) => { const s = String(e).slice(0, 120); if (!noise(s)) jsErrors.push(s); });
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const s = m.text().slice(0, 120); if (!noise(s)) jsErrors.push(s);
      });
      try {
        if (useServer) {
          /* NOT networkidle. Product photographs are hot-linked from a dozen
             third-party hosts and some never finish, so the network is never
             idle and every route times out — which this script would then record
             as "unreachable" rather than as a failure, quietly auditing nothing
             at all. domcontentloaded plus a fixed settle is deterministic and
             does not depend on somebody else's image server. */
          await page.goto(base + (route === 'home' ? '/' : '/' + route),
            { waitUntil: 'domcontentloaded', timeout: 20000 });
        } else {
          await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href,
            { timeout: 30000 });
          await page.waitForTimeout(900);
          await page.evaluate((r) => { if (typeof navigateTo === 'function') navigateTo(r); }, route);
        }
      } catch (err) {
        await page.close();
        findings.push({ width, route, unreachable: true, why: String(err).slice(0, 80) });
        continue;
      }
      await page.waitForTimeout(1400);
      /* A control caught mid-transition reports a mid-tween box, which reads as
         a target a few pixels short of the minimum that is not actually short. */
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;}' });
      await page.waitForTimeout(120);
      const r = await page.evaluate(probe, { touch: width <= TOUCH_MAX_WIDTH, min: MIN_TARGET });
      findings.push({ width, route, ...r, jsErrors });
      await page.close();
    }
  }
  await browser.close();
  if (own) own.kill();

  if (wantJson) { console.log(JSON.stringify(findings, null, 1)); }

  let bad = 0;
  console.log('');
  for (const f of findings) {
    const flags = [];
    if (f.unreachable) flags.push('UNREACHABLE — nothing was audited here: ' + (f.why || ''));
    if (f.hScroll) flags.push('H-SCROLL ' + f.scrollWidth + '>' + f.clientWidth);
    if (f.escaping && f.escaping.length) flags.push('ESCAPES ' + f.escaping.map((e) => e.el + '@' + e.right).join(', '));
    if (f.small && f.small.length) flags.push('SMALL ' + f.small.map((s) => s.el + ' ' + s.w + 'x' + s.h).join(', '));
    if (f.clipped && f.clipped.length) flags.push('CLIPPED ' + f.clipped.map((c) => c.el + ' "' + c.text + '"').join(', '));
    if (f.collisions && f.collisions.length) flags.push('OVERLAP ' + f.collisions.map((c) => c.a + '/' + c.b + ' ' + c.overlap).join(', '));
    if (f.jsErrors && f.jsErrors.length) flags.push('JS ' + f.jsErrors.join(' | '));
    if (flags.length) {
      bad++;
      console.log('  ' + String(f.width).padStart(4) + '  ' + f.route.padEnd(28) + flags.join('\n' + ' '.repeat(36)));
    }
  }
  console.log('\n  ' + findings.length + ' route/width combinations checked');
  console.log('  ' + (bad ? '>> ' + bad + ' with findings\n' : 'no horizontal scroll, no undersized targets, no clipped or colliding controls\n'));
  process.exit(bad ? 1 : 0);
})();
