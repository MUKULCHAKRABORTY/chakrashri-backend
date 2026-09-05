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
/* The price tag's three treatments are chosen across a whole list, so the two
   functions that do it carry state between them. Lifted verbatim rather than
   stubbed: which treatment a card gets is part of what this suite renders, and a
   stub would let the real rule rot while the harness stayed green. */
function decl(re, what) {
  const m = html.match(re);
  if (!m) throw new Error('could not extract ' + what);
  return m[0];
}

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
  function badgeInfo(b){ return { key:String(b), text:String(b) }; }
  function catLabel(c){ return c; }
  // Added when productCardHTML started showing the full category path. A card
  // that throws renders nothing, and the symptom was a 30-second timeout on a
  // button that never existed — see the render guard below.
  function catPath(p){ return p && p.subcat ? (catLabel(p.cat)+'/'+catLabel(p.subcat)) : catLabel(p && p.cat); }
  /* The card asks what badge a product should show, and that is now COMPUTED
     from sales and age rather than read off a column. Stubbed to the admin
     value here: this suite is about what the card's controls DO, and the badge
     maths has its own coverage in scripts/badge-math.js. */
  function effectiveBadge(p){ return (p && p.badge) || ''; }
  function starsHTML(){ return '<span class="stars"></span>'; }
  function formatINR(n){ return '\\u20b9'+n; }
  /* Readable from the test, because the card has TWO shapes and the shape it
     takes is decided by this number alone. Fixed at nought, half the control
     was never rendered, let alone clicked. */
  function cartQtyForProduct(){ return window.__qty || 0; }
  function ratingBlockHTML(){ return '<span>r</span>'; }
  function hasRating(p){ return !!(Number(p && p.reviews) > 0 && Number(p && p.rating) > 0); }
  function toggleWishlist(id){ window.__calls.push('wishlist:'+id); }
  function openQuickView(id){ window.__calls.push('quickview:'+id); }
  function notifyStock(id){ window.__calls.push('notify:'+id); }
  function quickAdjust(id,d){ window.__calls.push('cart:'+id+':'+d); }
  function openProduct(id){ window.__calls.push('navigate:'+id); }

  /* The badge's ground and movement are dealt per product with a neighbour
     rule. This replaced the price chip's three treatments, which went with the
     chip; the mechanism is the same one. */
  ${decl(/const BADGE_COLORS = \d+;/, 'BADGE_COLORS')}
  ${decl(/const BADGE_ANIMS = \d+;/, 'BADGE_ANIMS')}
  ${decl(/let _badgeStyle = Object\.create\(null\);/, '_badgeStyle')}
  ${fn('assignBadgeStyles')}
  ${fn('badgeStyleClass')}

  /* The REAL price sticker, not a stub. It is pure — a price, an MRP and
     formatINR — so there is nothing to fake, and stubbing it would leave the
     one element that now sits where the add button used to be untested. */
  ${fn('priceRowHTML')}
  ${fn('discountTagHTML')}

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
                    price:1299, mrp:1799, badge:'bestseller', stock:true, rating:4.5, reviews:12, material:'Quartz' };
  /* The fixture carries a badge because the card's top-left corner is now one
     of only three things on the photograph, and a null badge rendered none —
     so the layout check below was asserting about an empty corner. */
  /* Render inside a try so a missing dependency reports ITSELF.

     productCardHTML is extracted from index.html and run against the stubs
     above. When it gains a new dependency that is not stubbed here, it throws,
     the grid stays empty, and every locator below times out after 30 seconds
     with no hint as to why — which is exactly what happened when the card
     started calling catPath(). One line turns that into the function name. */
  try {
    document.getElementById('grid').innerHTML = productCardHTML(product, 0);
  } catch (err) {
    document.getElementById('grid').setAttribute('data-render-error', String(err && err.message || err));
  }
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

  // Fail on a render error immediately, with the missing name, rather than
  // letting three click locators time out one after another.
  const renderError = await page.getAttribute('#grid', 'data-render-error');
  if (renderError) {
    console.error('\n[browser-cards] FAILED: the card could not render — ' + renderError);
    console.error('  productCardHTML has a dependency that this harness does not stub.\n');
    await browser.close();
    process.exit(1);
  }

  const results = [];
  for (const [label, sel] of [
    ['wishlist heart', '.p-wish'],
    ['quick view eye', '.p-qview'],
    ['add to cart',    '.qa-cart']
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

  /* ---- the same button once something is in the basket ----
     It becomes a stepper, and all three of its parts are targets. Two add, one
     removes: pressing the cart in the middle means what it meant when this was
     a single Add to Cart button, because a customer does not know the control
     changed shape underneath them. */
  await page.evaluate(() => {
    window.__qty = 2;
    document.getElementById('grid').innerHTML = productCardHTML(
      { id: 'p1', name: 'Sphatik Shivling', slug: 'sphatik-shivling', cat: 'x',
        price: 100, mrp: 200, stock: 5, rating: 5, reviews: 3, badge: 'bestseller' }, 0);
  });
  const stepResults = [];
  for (const [label, sel, want] of [
    ['minus removes one', '.qa-step-btn:nth-of-type(1)', 'cart:p1:-1'],
    ['the cart adds one', '.qa-step-mid', 'cart:p1:1'],
    ['plus adds one', '.qa-step-btn:nth-last-of-type(1)', 'cart:p1:1']
  ]) {
    await page.evaluate(() => { window.__calls = []; });
    await page.click(sel);
    await page.waitForTimeout(120);
    const calls = await page.evaluate(() => window.__calls);
    const good = calls.length === 1 && calls[0] === want;
    if (!good) ok = false;
    stepResults.push(`  ${good ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} -> ${JSON.stringify(calls)}`);
  }
  console.log('\nThe same control once something is in the basket:\n');
  stepResults.forEach((l) => console.log(l));
  const stepShape = await page.evaluate(() => {
    const st = document.querySelector('.qa-step');
    return { targets: st.querySelectorAll('button').length,
             count: (st.querySelector('.qa-step-n') || {}).textContent,
             onIcon: !!st.querySelector('.qa-step-ic .qa-step-n'),
             ring: getComputedStyle(st.querySelector('.qa-step-btn'), '::before').content };
  });
  const shapeChecks = [
    ['three targets, no more', stepShape.targets === 3],
    ['the count reads what is in the basket', stepShape.count === '2'],
    ['and rides on the cart icon, not beside it', stepShape.onIcon],
    ['no circle drawn behind the signs', stepShape.ring === 'none']
  ];
  for (const [label, good] of shapeChecks) {
    if (!good) ok = false;
    console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (!shapeChecks.every((c) => c[1])) console.log('        got: ' + JSON.stringify(stepShape));
  await page.evaluate(() => { window.__qty = 0; });
  await page.goto('https://shop.test/');

  const href = await page.getAttribute('.p-media', 'href');
  console.log(`  ${href === '/product/sphatik-shivling' ? 'PASS' : 'FAIL'}  crawlable href  -> ${href}`);
  if (href !== '/product/sphatik-shivling') ok = false;

  /* ---- what is on the photograph, and what is in the body ----
     The card has been through three arrangements. This pins the one it is in:
     the photograph carries the badge and the two controls and nothing else, and
     the body reads title, rating, price, button. */
  const layout = await page.evaluate(() => {
    const media = document.querySelector('.p-media');
    const body = document.querySelector('.p-body');
    const kids = [...body.children].map((el) => el.className.split(' ')[0]);
    return {
      onPhoto: { badge: !!media.querySelector('.badge'), wish: !!media.querySelector('.p-wish'),
                 qview: !!media.querySelector('.p-qview'),
                 priceOrAdd: !!media.querySelector('.p-pricerow, .p-cta, .p-pricetag, .p-quickadd') },
      order: kids,
      badgeGround: [...(document.querySelector('.badge') || { classList: [] }).classList]
        .find((c) => /^bg-c\d$/.test(c)) || null,
      badgeMove: [...(document.querySelector('.badge') || { classList: [] }).classList]
        .find((c) => /^bg-a\d$/.test(c)) || null,
      badgeKind: document.querySelector('.badge')
        ? document.querySelector('.badge').dataset.badge : null
    };
  });
  const layoutChecks = [
    ['the photograph carries the badge and both controls',
      layout.onPhoto.badge && layout.onPhoto.wish && layout.onPhoto.qview],
    ['and nothing else — no price, no add control on it',
      !layout.onPhoto.priceOrAdd],
    /* p-material is filtered out: it is markup the LIST view uses and the grid
       hides, so it is legitimately in the DOM and legitimately not on screen. */
    ['the body reads name, rating, price, button in that order',
      JSON.stringify(layout.order.filter((c) => c !== 'p-material'))
        === JSON.stringify(['p-name', 'p-rating', 'p-pricerow', 'p-cta'])],
    ['the badge takes a dealt ground and a dealt movement',
      !!layout.badgeGround && !!layout.badgeMove],
    /* Whatever key badgeInfo returned — the stub above returns the raw badge
       value — must reach the markup as data rather than as a class. The real
       badgeInfo maps 'bestseller' to 'best'; what is asserted here is the
       plumbing, not the mapping, which badge-math owns. */
    ['and names its kind in data, not in a class that styles nothing',
      layout.badgeKind === 'bestseller']
  ];
  for (const [label, good] of layoutChecks) {
    if (!good) ok = false;
    console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (!layoutChecks.every((c) => c[1])) console.log('        got: ' + JSON.stringify(layout));

  /* Buy Now inherited the price chip's treatment, and the rule that came with
     it: no two cards near each other may run the same movement. */
  const anims = await page.evaluate(() => {
    const mk = (id) => ({ id, name: id, slug: id, cat: 'x', price: 100, mrp: 200,
                          stock: 5, rating: 5, reviews: 1, badge: 'new' });
    const list = ['a1', 'b2', 'c3', 'd4'].map(mk);
    assignBadgeStyles(list);
    const host = document.createElement('div');
    host.innerHTML = list.map((p, i) => productCardHTML(p, i)).join('');
    return {
      grounds: [...host.querySelectorAll('.badge')]
        .map((b) => [...b.classList].find((c) => /^bg-c\d$/.test(c)) || null),
      moves: [...host.querySelectorAll('.badge')]
        .map((b) => [...b.classList].find((c) => /^bg-a\d$/.test(c)) || null)
    };
  });
  const animChecks = [
    ['every badge is dealt a ground and a movement',
      anims.grounds.length === 4 && anims.grounds.every(Boolean) && anims.moves.every(Boolean)],
    ['no two badges side by side share a ground',
      anims.grounds.every((v, i) => i === 0 || v !== anims.grounds[i - 1])],
    ['and no two share a movement either — the two axes are independent',
      anims.moves.every((v, i) => i === 0 || v !== anims.moves[i - 1])]
  ];
  for (const [label, good] of animChecks) {
    if (!good) ok = false;
    console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (!animChecks.every((c) => c[1])) console.log('        got: ' + JSON.stringify(anims));

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
