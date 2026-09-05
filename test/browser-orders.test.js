/**
 * Browser-level test for the admin order drawer and the low-stock panel.
 *
 * WHY THIS EXISTS
 * Three things a static read cannot settle:
 *
 *   1. WHICH PRODUCT IS THIS? An order line showed only the frozen name
 *      snapshot. This catalog has several similarly-named products, so a packer
 *      reading "Sphatik Shivling" cannot tell which one to put in the box. The
 *      name is now a link to that exact product, and the line carries the SKU
 *      and the VARIANT's SKU — the fields actually printed on stock.
 *   2. THE ADDRESS A COURIER NEEDS. Retyping an address out of a definition
 *      list is where wrong pincodes come from, and a wrong pincode is a
 *      returned parcel. It is produced once, in label format.
 *   3. A LOW VARIANT WAS INVISIBLE. products.stock_qty on a variant product is
 *      the SUM of its variants (migration 012's trigger), so three sizes with 2
 *      each report 6, clear a threshold of 5, and never appear — while every
 *      size is one order from unsellable.
 *
 * Requires playwright + chromium. Skips cleanly when unavailable;
 * REQUIRE_BROWSER_TESTS=true turns that skip into a failure, as CI sets.
 *
 * Run: node test/browser-orders.test.js
 */
const REQUIRE_BROWSER = process.env.REQUIRE_BROWSER_TESTS === 'true';
const INSTALL_HINT = 'npx playwright install chromium';

function skip(reason, hint) {
  if (REQUIRE_BROWSER) {
    console.error('\n[browser-orders] FAILED: ' + reason + '.');
    console.error('                 REQUIRE_BROWSER_TESTS=true, so this cannot be skipped.');
    console.error('                 Fix with: ' + hint + '\n');
    process.exit(1);
  }
  console.log('\n[browser-orders] SKIPPED: ' + reason + '.');
  console.log('                 To run it:  ' + hint + '\n');
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  skip('the playwright package is not installed', 'npm install   then   ' + INSTALL_HINT);
}

const fs = require('fs');
const http = require('http');
const path = require('path');

const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function fn(name) {
  const m = admin.match(new RegExp('(?:async\\s+)?function ' + name + '\\s*\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('could not extract function ' + name + ' from admin.html');
  return m[0];
}

const ORDER = {
  id: 'oooooooo-0000-4000-8000-000000000001',
  order_number: 'CHK-2026-000123',
  ship_name: 'Asha Rao', ship_phone: '9876543210', ship_email: 'asha@test.invalid',
  ship_line1: '12 Temple Road', ship_line2: 'Near Ganesh Mandir',
  ship_city: 'Kolkata', ship_state: 'West Bengal', ship_pincode: '700001', ship_country: 'India'
};

// Two similarly-named products — the exact situation the link exists for.
const ITEMS = [
  { id: 1, product_id: 'pppppppp-0000-4000-8000-000000000001',
    product_name_snapshot: 'Sphatik Shivling', sku: 'SPH-SHIV-01', slug: 'sphatik-shivling',
    category: 'lingam', subcategory: null, quantity: 1,
    unit_price_paise: 250000, line_total_paise: 250000,
    variant_id: null, variant_snapshot: null, variant_sku: null },
  { id: 2, product_id: 'pppppppp-0000-4000-8000-000000000002',
    product_name_snapshot: 'Dhoti', sku: 'DHO-01', slug: 'dhoti',
    category: 'dhoti', subcategory: null, quantity: 2,
    unit_price_paise: 66000, line_total_paise: 132000,
    variant_id: 'vvvvvvvv-0000-4000-8000-000000000001',
    variant_snapshot: [{ option: 'Size', value: 'M' }], variant_sku: 'DHO-01-M' },
  // A product deleted since the order was placed: the line must still render.
  { id: 3, product_id: null, product_name_snapshot: 'Discontinued Mala',
    sku: null, slug: null, category: null, subcategory: null, quantity: 1,
    unit_price_paise: 50000, line_total_paise: 50000,
    variant_id: null, variant_snapshot: null, variant_sku: null }
];

/* `slug` on both shapes, because that is what /api/admin/low-stock returns and
   what a product link is built from. Before the link pointed at the storefront
   it was built from the id, and a fixture without a slug would now render the
   name as plain text — which is the renderer refusing to emit a URL it knows
   would 404, and exactly the case [fe-55] guards. */
const LOW_STOCK = {
  products: [{ id: 'pppppppp-0000-4000-8000-000000000003', name: 'Rudraksha Mala',
               slug: 'rudraksha-mala', sku: 'RUD-01', stock_qty: 1, category: 'malas' }],
  variants: [
    { variant_id: 'v1', variant_sku: 'DHO-01-M', stock_qty: 2,
      option_values: [{ option: 'Size', value: 'M' }],
      product_id: 'pppppppp-0000-4000-8000-000000000002', product_name: 'Dhoti',
      product_slug: 'dhoti', product_sku: 'DHO-01', category: 'dhoti' },
    { variant_id: 'v2', variant_sku: 'DHO-01-L', stock_qty: 0,
      option_values: [{ option: 'Size', value: 'L' }],
      product_id: 'pppppppp-0000-4000-8000-000000000002', product_name: 'Dhoti',
      product_slug: 'dhoti', product_sku: 'DHO-01', category: 'dhoti' }
  ],
  threshold: 5
};

const harness = `<!doctype html><html><body>
<div id="toastWrap"></div>
<table id="lowStockTable"><tbody></tbody></table>
<div id="itemsOut"></div>
<div id="addrOut"></div>
<script>
window.__toasts = [];
window.__copied = null;
window.__lowStock = ${JSON.stringify(LOW_STOCK)};
window.__items = ${JSON.stringify(ITEMS)};
window.__order = ${JSON.stringify(ORDER)};
window.__openedProduct = null;

${admin.match(/function qs\(sel, root\)[^\n]*\n/)[0]}
${admin.match(/function qsa\(sel, root\)[^\n]*\n/)[0]}
${fn('esc')}
${admin.match(/function paise\(p\)[^\n]*\n/)[0]}
function toast(msg, type){ window.__toasts.push({ msg: msg, type: type }); }
async function api(path){ if(/low-stock/.test(path)) return window.__lowStock; return {}; }
function openProductForm(id){ window.__openedProduct = id; }

${admin.match(/const UUID_RE = .*/)[0]}
${fn('storefrontProductHref')}
${fn('productLink')}
${admin.match(/let currentOrderForLabel = null;/)[0]}
${fn('shippingAddressFields')}
${fn('shippingAddressBlock')}
${fn('copyShippingAddress')}
${fn('variantOptionLabel')}
${fn('stockPill')}
${admin.match(/const lowStockOpen = new Set\(\);/)[0]}
${fn('toggleLowStockGroup')}
${fn('loadLowStock')}

// The order-items template, lifted verbatim out of renderOrderDetail so this
// tests the markup that actually ships rather than a copy of it.
function renderItems(items){
  ${(() => {
    const src = fn('renderOrderDetail');
    const start = src.indexOf('const itemsHtml = items.map');
    const end = src.indexOf(".join('');", start) + ".join('');".length;
    if (start < 0) throw new Error('could not lift itemsHtml out of renderOrderDetail');
    return src.slice(start, end);
  })()}
  return itemsHtml;
}
</script></body></html>`;

const results = [];
function check(name, cond, extra) { results.push({ name, ok: !!cond, extra }); }

(async () => {
  let browser;
  try { browser = await chromium.launch(); }
  catch { skip('chromium is not installed for playwright', INSTALL_HINT); }
  /* SERVED OVER HTTP, NOT setContent.

     A product name now links to the storefront, and the console builds that URL
     from its own origin — Netlify serves /admin from the storefront domain, so
     a second constant to keep in sync would be a second thing to get wrong. A
     page loaded by setContent has the origin `about:blank`, so the link
     correctly refuses to be built and every name renders as plain text. The
     assertions below would then be testing the fallback for ever while
     believing they had tested the link. A throwaway server gives the page a
     real origin, which is the situation the console actually runs in. */
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(harness);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Clipboard is unavailable in this context; the fallback path is what runs.
  await page.goto(origin + '/', { waitUntil: 'load' });

  // ------------------------------------------------------- order line detail
  const itemsHtml = await page.evaluate(() => renderItems(window.__items));
  // href comes BEFORE the class on the anchor, so the two are matched
  // independently rather than in an assumed order.
  check('THE FINDING: the product name is a link to that exact product',
    /href="[^"]*\/product\/sphatik-shivling"/.test(itemsHtml) &&
    /class="product-link"/.test(itemsHtml),
    itemsHtml.slice(0, 200));
  check('the line carries the SKU a packer reads off the shelf',
    /SKU <code class="mono">SPH-SHIV-01<\/code>/.test(itemsHtml));
  check('a variant line names the option AND the variant SKU',
    /Size: <b>M<\/b>/.test(itemsHtml) && /variant SKU <code class="mono">DHO-01-M<\/code>/.test(itemsHtml));
  check('unit price is shown beside the quantity, so a line total can be checked',
    /each/.test(itemsHtml));
  check('a product deleted since the order still renders, and says so',
    /Discontinued Mala/.test(itemsHtml) && /no longer in catalogue/.test(itemsHtml));
  check('and its name is NOT a dead link',
    !/product-link[^>]*href="[^"]*(null|undefined)/.test(itemsHtml), itemsHtml.slice(0, 160));

  /* THE DESTINATION CHANGED, AND THAT IS THE POINT.
     A product name used to call openProductForm(), so somebody reading an order
     to see what was bought was dropped into an edit screen. It is now an anchor
     to the storefront page the customer saw. */
  await page.evaluate(() => {
    document.querySelector('#itemsOut').innerHTML = '<table>' + renderItems(window.__items) + '</table>';
  });
  const link = await page.evaluate(() => {
    const a = document.querySelector('#itemsOut .product-link');
    return a ? { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') } : null;
  });
  check('the product name is a real anchor to the storefront product page',
    link && /\/product\/sphatik-shivling$/.test(link.href), JSON.stringify(link));
  check('opening in a new tab, so a packer does not lose the order they were reading',
    link && link.target === '_blank' && /noopener/.test(link.rel || ''), JSON.stringify(link));
  check('and nothing in the order still opens the edit form',
    !/openProductForm/.test(itemsHtml), itemsHtml.slice(0, 120));
  const opened = await page.evaluate(() => window.__openedProduct);
  check('the edit form was never opened by any of it', opened === null, String(opened));

  // ------------------------------------------------------------- the address
  const block = await page.evaluate(() => { currentOrderForLabel = window.__order; return shippingAddressBlock(window.__order); });
  const lines = block.split('\n');
  /* EVERY LINE NAMES ITS FIELD.

     This block used to be bare values — "Asha Rao", "12 Temple Road",
     "Kolkata - 700001" — so a packer pasting it into a courier portal had to
     work out from POSITION which box each line belonged in, and a missing
     optional line shifted everything below it up by one. City and PIN were
     merged onto one line for exactly that reason, which is no longer needed
     once each line says what it is. */
  check('every line names its field, so nothing depends on position',
    lines.every((l) => / : /.test(l)) && lines.length >= 9, JSON.stringify(lines));
  check('the recipient leads, labelled the way the drawer labels it',
    lines[0] === 'Recipient Name : Asha Rao', JSON.stringify(lines[0]));
  check('city and PIN are their own labelled lines now',
    lines.includes('City : Kolkata') && lines.includes('PIN Code : 700001'), JSON.stringify(lines));
  check('state, country and phone are all present',
    block.includes('State : West Bengal') && block.includes('Country : India') &&
    block.includes('Phone : 9876543210'));
  /* THE ORDER REFERENCE, LAST. Without it a pasted address could not be tied
     back to the order it came from. */
  check('and the order id is the last line, so the address reads top-down first',
    lines[lines.length - 1] === 'Order ID : CHK-2026-000123', JSON.stringify(lines[lines.length - 1]));
  /* The account email is an admin detail — where the customer signs in, not
     where the parcel goes — so it is on the screen and off the label. */
  const withAccount = await page.evaluate(() =>
    shippingAddressBlock(Object.assign({}, window.__order, { customer_email: 'other@test.invalid' })));
  check('the account email stays off the label even when it differs',
    !withAccount.includes('other@test.invalid'), withAccount);
  check('an empty landmark does not leave a blank line in the middle',
    !/\n\n/.test(block), JSON.stringify(block));

  const noAddr = await page.evaluate(() => shippingAddressBlock({ order_number: 'X' }));
  check('an order with no address produces nothing rather than a block of undefined',
    noAddr === '', JSON.stringify(noAddr));

  // The copy path must not throw when the clipboard API is unavailable.
  await page.evaluate(async () => { currentOrderForLabel = window.__order; await copyShippingAddress(); });
  const afterCopy = await page.evaluate(() => window.__toasts[window.__toasts.length - 1]);
  check('a blocked clipboard falls back instead of failing silently',
    !!afterCopy, JSON.stringify(afterCopy));

  // ---------------------------------------------------------- the low stock
  await page.evaluate(() => loadLowStock());
  const lowHtml = await page.evaluate(() => document.querySelector('#lowStockTable tbody').innerHTML);
  check('THE FINDING: a low VARIANT is listed, named by its option',
    /Size: M/.test(lowHtml) && /Size: L/.test(lowHtml), lowHtml.slice(0, 200));
  check('with the variant SKU, so it can actually be restocked',
    /DHO-01-M/.test(lowHtml) && /DHO-01-L/.test(lowHtml));
  check('a sold-out variant is flagged more severely than a low one',
    /pill-danger">Out of stock/.test(lowHtml) && /pill-warn">2 left/.test(lowHtml));
  check('variants come FIRST — they are the rows that can be acted on',
    lowHtml.indexOf('DHO-01-M') < lowHtml.indexOf('RUD-01'));
  check('a plain product low on its own stock is still listed',
    /Rudraksha Mala/.test(lowHtml) && /RUD-01/.test(lowHtml));
  check('and every name in the panel is a link to the STOREFRONT product page',
    (lowHtml.match(/class="product-link"/g) || []).length >= 3 &&
    /\/product\/dhoti/.test(lowHtml) && /\/product\/rudraksha-mala/.test(lowHtml) &&
    !/openProductForm/.test(lowHtml), lowHtml.slice(0, 200));

  /* ---- the disclosure ----
     The panel used to repeat the base product name once per size, so a dhoti in
     five sizes filled it with the word "Dhoti" and buried every other product
     that needed attention. One row per product now, opened to see the sizes. */
  let ls = await page.evaluate(() => ({
    groups: document.querySelectorAll('#lowStockTable .ls-group').length,
    plain: document.querySelectorAll('#lowStockTable .ls-plain').length,
    variantRows: document.querySelectorAll('#lowStockTable .ls-variant').length,
    visibleVariants: [...document.querySelectorAll('#lowStockTable .ls-variant')].filter(r => !r.hidden).length,
    expanded: document.querySelector('#lowStockTable .ls-toggle').getAttribute('aria-expanded'),
    summary: (document.querySelector('#lowStockTable .ls-summary') || {}).textContent || ''
  }));
  check('the two dhoti sizes are ONE row, not two repeats of the product name',
    ls.groups === 1 && ls.plain === 1, JSON.stringify(ls));
  check('collapsed to start, and its sizes are genuinely hidden — not merely off-screen',
    ls.expanded === 'false' && ls.variantRows === 2 && ls.visibleVariants === 0, JSON.stringify(ls));
  check('and the row says what is behind it before you open it',
    /2 variants low/.test(ls.summary) && /1 out of stock/.test(ls.summary), ls.summary);

  await page.evaluate(() => toggleLowStockGroup('pppppppp-0000-4000-8000-000000000002'));
  ls = await page.evaluate(() => ({
    visibleVariants: [...document.querySelectorAll('#lowStockTable .ls-variant')].filter(r => !r.hidden).length,
    expanded: document.querySelector('#lowStockTable .ls-toggle').getAttribute('aria-expanded'),
    worstFirst: [...document.querySelectorAll('#lowStockTable .ls-variant')]
      .map(r => r.textContent).join(' | ')
  }));
  check('opening it reveals every size, with the state announced',
    ls.visibleVariants === 2 && ls.expanded === 'true', JSON.stringify(ls));
  check('worst first, so the size that is actually out leads',
    ls.worstFirst.indexOf('Size: L') < ls.worstFirst.indexOf('Size: M'), ls.worstFirst.slice(0, 160));

  check('no page errors while doing any of it', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  server.close();

  console.log('\nDriving the REAL admin order drawer and low-stock panel:\n');
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log('  PASS  ' + r.name);
    else { failed++; console.log('  FAIL  ' + r.name + (r.extra ? '\n        ' + r.extra : '')); }
  }
  console.log(failed ? `\n  ${failed} FAILED\n` : '\n  ORDER LINES, LABELS AND VARIANT STOCK ALL CORRECT\n');
  process.exit(failed ? 1 : 0);
})();
