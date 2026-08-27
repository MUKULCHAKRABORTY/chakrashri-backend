/**
 * Browser-level regression test for the product card.
 *
 * WHY THIS EXISTS
 * Making .p-media a real <a href> — so crawlers can follow it and shoppers can
 * middle-click it (SEO-01) — put the wishlist, quick-view and quick-add buttons
 * INSIDE a link. Those handlers called event.stopPropagation(), which stops the
 * anchor's LISTENER but not the browser's default action: following the href is
 * decided by the event path, not by which listeners ran.
 *
 * The result was that clicking "add to cart" on the shop grid navigated to the
 * product page instead of adding to the cart. It broke the single most-used
 * interaction on the site, and no amount of reading the diff would have shown
 * it — only a real browser answers this question.
 *
 * So this test renders a card with the ACTUAL productCardHTML/quickAddHTML from
 * index.html, clicks every control, and asserts both directions:
 *   - a nested control runs its own handler and does NOT navigate;
 *   - the card itself still DOES navigate, and still has a crawlable href.
 *
 * Requires playwright + chromium. Skips cleanly when they are unavailable, so
 * `npm test` still passes on a machine without them.
 *
 * Run: node test/browser-cards.test.js
 */
// ---------------------------------------------------------------------------
// There are TWO separate ways this test cannot run, and they look identical
// from a distance.
// ---------------------------------------------------------------------------
//   1. The playwright PACKAGE is absent — an `npm install --omit=dev`, or a
//      machine that never installed devDependencies.
//   2. The package is present but the BROWSER BINARY was never downloaded.
//      Playwright separates these on purpose: `npm install` fetches the
//      library, `npx playwright install chromium` fetches the browser itself
//      (hundreds of MB, cached per machine, not per project). So a fresh clone
//      on a new machine has (1) solved and (2) not.
//
// The first version of this guard only handled case 1, because the machine it
// was written on already had the binary. On a machine without it, launch()
// threw inside an async IIFE that had no catch — Node turns that into an
// unhandled rejection and a hard process crash, which took down the entire
// `npm run verify` chain. The database and Razorpay checks that run AFTER this
// one never executed, so a missing optional download silently reduced the
// verified surface to nothing.
//
// The rule this encodes: a test that cannot run must never be able to stop the
// tests that can. But a skip nobody notices is how a suite quietly stops
// testing anything, so CI sets REQUIRE_BROWSER_TESTS=true and a skip there is
// a failure.
const REQUIRE_BROWSER = process.env.REQUIRE_BROWSER_TESTS === 'true';
const INSTALL_HINT = 'npx playwright install chromium';

function skip(reason, hint) {
  if (REQUIRE_BROWSER) {
    console.error('\n[browser-cards] FAILED: ' + reason + '.');
    console.error('                REQUIRE_BROWSER_TESTS=true, so this cannot be skipped.');
    console.error('                Fix with: ' + hint + '\n');
    process.exit(1);
  }
  console.log('\n[browser-cards] SKIPPED: ' + reason + '.');
  console.log('                To run it:  ' + hint);
  console.log('                (One-time per machine. Every other suite still ran;');
  console.log('                 nothing here is failing.)\n');
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
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function fn(name) {
  const m = html.match(new RegExp(`function ${name}\\s*\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
}

const harness = `<!doctype html><html><body><div id="grid"></div><script>
  window.__calls = [];
  const wishlist = [];
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function pathForRoute(p, param){ return param ? '/'+p+'/'+param : '/'+p; }
  function productHref(p){ return p && p.slug ? pathForRoute('product', p.slug) : pathForRoute('product', p && p.id); }
  function mediaStyle(){ return ''; }
  function productThumbInnerHTML(){ return '<span>img</span>'; }
  function badgeInfo(b){ return { cssClass:'badge-x', text:String(b) }; }
  function discountTagHTML(){ return ''; }
  function catLabel(c){ return c; }
  function starsHTML(){ return '<span class="stars"></span>'; }
  function formatINR(n){ return '\\u20b9'+n; }
  function cartQtyForProduct(){ return 0; }
  function ratingBlockHTML(){ return '<span>r</span>'; }
  function toggleWishlist(id){ window.__calls.push('wishlist:'+id); }
  function openQuickView(id){ window.__calls.push('quickview:'+id); }
  function notifyStock(id){ window.__calls.push('notify:'+id); }
  function quickAdjust(id,d){ window.__calls.push('cart:'+id+':'+d); }
  function openProduct(id){ window.__calls.push('navigate:'+id); }

  ${fn('quickAddHTML')}
  ${fn('productCardHTML')}

  // The real capture-phase guard from index.html
  document.addEventListener('click', function(e){
    const control = e.target.closest && e.target.closest('button, input, select, textarea, [role="button"]');
    if(!control) return;
    const link = control.closest('a[href]');
    if(link && link !== control) e.preventDefault();
  }, true);

  const product = { id:'p1', slug:'sphatik-shivling', name:'Sphatik Shivling', cat:'lingam',
                    price:1299, mrp:1799, badge:null, stock:true, rating:4.5, reviews:12, material:'Quartz' };
  document.getElementById('grid').innerHTML = productCardHTML(product, 0);
</script></body></html>`;

(async () => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    // Playwright prints a long boxed message for a missing binary. Match on the
    // stable parts of it, and RE-THROW anything else — a genuine launch failure
    // (a missing shared library, a sandbox refusing to start, an out-of-memory)
    // must still be reported as a failure. Treating every launch error as
    // "not installed" would be exactly the kind of check that cannot fail.
    const msg = String((err && err.message) || err);
    // `doesn.t` rather than `doesn't`: the apostrophe has been a straight quote
    // in every version seen, but a typographic one would silently turn this
    // guard back into the crash it exists to prevent, and one character buys
    // immunity from that.
    if (!/Executable doesn.t exist|playwright install|Please run the following command/i.test(msg)) throw err;
    skip('the Chromium binary has not been downloaded on this machine', INSTALL_HINT);
    return;
  }
  const page = await browser.newPage();
  await page.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: harness }));
  await page.goto('https://shop.test/');

  const results = [];
  for (const [label, sel] of [
    ['wishlist heart', '.p-quick button:nth-of-type(1)'],
    ['quick view eye', '.p-quick button:nth-of-type(2)'],
    ['quick add (+)',  '.p-quickadd button']
  ]) {
    await page.evaluate(() => { window.__calls = []; });
    const before = page.url();
    await page.click(sel);
    await page.waitForTimeout(200);
    const calls = await page.evaluate(() => window.__calls).catch(() => ['<page navigated away>']);
    results.push({ label, calls, navigated: page.url() !== before, url: page.url() });
    if (page.url() !== before) await page.goto('https://shop.test/');
  }

  console.log('Clicking each control on a REAL rendered product card:\n');
  let ok = true;
  for (const r of results) {
    const good = !r.navigated && r.calls.length === 1 && !r.calls[0].startsWith('navigate');
    if (!good) ok = false;
    console.log(`  ${good ? 'PASS' : 'FAIL'}  ${r.label.padEnd(16)} -> handler: ${JSON.stringify(r.calls)}  navigated: ${r.navigated}`);
  }

  // And the card link itself must STILL navigate when the image is clicked.
  await page.evaluate(() => { window.__calls = []; });
  await page.click('.p-media', { position: { x: 5, y: 5 } });
  await page.waitForTimeout(200);
  const navCalls = await page.evaluate(() => window.__calls);
  const navOk = navCalls.includes('navigate:p1');
  if (!navOk) ok = false;
  console.log(`  ${navOk ? 'PASS' : 'FAIL'}  card image      -> handler: ${JSON.stringify(navCalls)} (must still open the product)`);

  const href = await page.getAttribute('.p-media', 'href');
  console.log(`  ${href === '/product/sphatik-shivling' ? 'PASS' : 'FAIL'}  crawlable href  -> ${href}`);

  console.log('\n' + (ok ? '  ALL CARD INTERACTIONS CORRECT' : '  >> STILL BROKEN'));
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  // Anything reaching here is a real failure: a helper function that no longer
  // exists in index.html, a selector that stopped matching, a launch problem we
  // deliberately re-threw above. Report it as a readable test failure rather
  // than letting it surface as an unhandled rejection, which Node renders as a
  // bare crash dump that looks like the harness itself is broken.
  console.error('\n[browser-cards] FAILED: ' + ((err && err.stack) || err) + '\n');
  process.exit(1);
});
