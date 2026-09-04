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

const LOW_STOCK = {
  products: [{ id: 'pppppppp-0000-4000-8000-000000000003', name: 'Rudraksha Mala', sku: 'RUD-01', stock_qty: 1, category: 'malas' }],
  variants: [
    { variant_id: 'v1', variant_sku: 'DHO-01-M', stock_qty: 2,
      option_values: [{ option: 'Size', value: 'M' }],
      product_id: 'pppppppp-0000-4000-8000-000000000002', product_name: 'Dhoti', product_sku: 'DHO-01', category: 'dhoti' },
    { variant_id: 'v2', variant_sku: 'DHO-01-L', stock_qty: 0,
      option_values: [{ option: 'Size', value: 'L' }],
      product_id: 'pppppppp-0000-4000-8000-000000000002', product_name: 'Dhoti', product_sku: 'DHO-01', category: 'dhoti' }
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

${fn('productLink')}
${admin.match(/let currentOrderForLabel = null;/)[0]}
${fn('shippingAddressBlock')}
${fn('copyShippingAddress')}
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
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Clipboard is unavailable in this context; the fallback path is what runs.
  await page.setContent(harness);

  // ------------------------------------------------------- order line detail
  const itemsHtml = await page.evaluate(() => renderItems(window.__items));
  check('THE FINDING: the product name is a link to that exact product',
    /class="product-link"[^>]*openProductForm\('pppppppp-0000-4000-8000-000000000001'\)/.test(itemsHtml),
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
    !/openProductForm\('null'\)/.test(itemsHtml) && !/openProductForm\(''\)/.test(itemsHtml));

  await page.evaluate(() => {
    document.querySelector('#itemsOut').innerHTML = '<table>' + renderItems(window.__items) + '</table>';
    document.querySelector('#itemsOut').querySelector('.product-link').click();
  });
  const opened = await page.evaluate(() => window.__openedProduct);
  check('clicking it opens that product', opened === 'pppppppp-0000-4000-8000-000000000001', String(opened));

  // ------------------------------------------------------------- the address
  const block = await page.evaluate(() => { currentOrderForLabel = window.__order; return shippingAddressBlock(window.__order); });
  const lines = block.split('\n');
  check('the address is one block, in courier order',
    lines[0] === 'Asha Rao' && lines[1] === '12 Temple Road', JSON.stringify(lines));
  check('THE ONE THAT MATTERS: city and PIN are on one line, as a label needs',
    lines.includes('Kolkata - 700001'), JSON.stringify(lines));
  check('state, country and phone are all present',
    block.includes('West Bengal') && block.includes('India') && block.includes('Phone: 9876543210'));
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
    /pill-danger">0 left/.test(lowHtml) && /pill-warn">2 left/.test(lowHtml));
  check('variants come FIRST — they are the rows that can be acted on',
    lowHtml.indexOf('DHO-01-M') < lowHtml.indexOf('RUD-01'));
  check('a plain product low on its own stock is still listed',
    /Rudraksha Mala/.test(lowHtml) && /RUD-01/.test(lowHtml));
  check('and every name in the panel is a link',
    (lowHtml.match(/class="product-link"/g) || []).length === 3, lowHtml.slice(0, 120));

  check('no page errors while doing any of it', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();

  console.log('\nDriving the REAL admin order drawer and low-stock panel:\n');
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log('  PASS  ' + r.name);
    else { failed++; console.log('  FAIL  ' + r.name + (r.extra ? '\n        ' + r.extra : '')); }
  }
  console.log(failed ? `\n  ${failed} FAILED\n` : '\n  ORDER LINES, LABELS AND VARIANT STOCK ALL CORRECT\n');
  process.exit(failed ? 1 : 0);
})();
