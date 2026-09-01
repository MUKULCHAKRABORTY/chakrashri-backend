// Runs the REAL renderMobileNavCategories() against catalogs it has never seen.
// Nothing is reimplemented here: every function is lifted out of index.html by
// brace-matching, so if the page changes, this changes with it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function grab(name) {
  const i = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  if (i < 0) throw new Error('missing function ' + name);
  let d = 0;
  const s = html.indexOf('{', i);
  for (let k = s; k < html.length; k++) {
    if (html[k] === '{') d++;
    else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const NEEDED = ['escapeHtml', 'jsAttr', 'titleCaseTerm', 'catLabel', 'categoryTree',
                'rankedCategories', 'renderMobileNavCategories', 'toggleMnavCat'];

// A minimal DOM: only what the renderer touches.
function makeHost() {
  const host = {
    innerHTML: '',
    _children: null,
    get children() { return this._children || []; }
  };
  return host;
}

function buildSandbox(products, filters, salesRank) {
  const host = makeHost();
  const minor = html.match(/const MINOR_WORDS = [^;]+;/);
  if (!minor) throw new Error('MINOR_WORDS not found');
  // Lifted, not retyped: if the storefront changes 15 to something else, this
  // follows it rather than quietly testing a number nobody uses any more.
  const topN = html.match(/const MNAV_TOP_CATEGORIES = \d+;/);
  if (!topN) throw new Error('MNAV_TOP_CATEGORIES not found');
  const src = minor[0] + '\n' + topN[0] + '\n\n' + NEEDED.map(grab).join('\n\n') +
    '\nreturn { renderMobileNavCategories, categoryTree, rankedCategories, catLabel, jsAttr, escapeHtml, TOP_N: MNAV_TOP_CATEGORIES };';
  const fn = new Function('PRODUCTS', 'shopFilters', 'CAT_LABELS', 'mnavOpenCats', 'categorySalesRank', 'qs', 'console', src);
  const api = fn(products, filters, {}, new Set(),
                 salesRank === undefined ? null : salesRank,
                 (sel) => (sel === '#mnavShopSub' ? host : null), console);
  return { api, host };
}

// ---------------------------------------------------------------- assertions
let failures = [];
let checks = 0;
function check(cond, label, extra) {
  checks++;
  if (!cond) failures.push(label + (extra ? '\n        ' + extra : ''));
}

function p(id, cat, sub) {
  // The storefront's own field names: categoryTree() reads p.cat / p.subcat.
  return { id, slug: 's' + id, name: 'P' + id, cat: cat, subcat: sub || '',
           price: 100, stock_qty: 5, is_active: true, images: [] };
}

// Pull every onclick payload back out and confirm the slug survived the trip.
function onclicks(out) {
  const re = /onchange="([^"]*)"/g;
  const found = [];
  let m;
  while ((m = re.exec(out))) {
    // The browser decodes entities when it parses the attribute; do the same.
    found.push(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                   .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  }
  return found;
}

function run(label, products, filters, salesRank) {
  const { api, host } = buildSandbox(products, filters || { cat: '', subcat: '' }, salesRank);
  api.renderMobileNavCategories();
  const out = host.innerHTML;

  // 1. Always exactly one wrapper — the collapse depends on it.
  const wrappers = (out.match(/class="mnav-sub-inner"/g) || []).length;
  check(wrappers === 1, `[${label}] exactly one .mnav-sub-inner wrapper`, `got ${wrappers}`);

  // 2. All Products is ALWAYS reachable. With no categories at all this is the
  //    only way into the shop from a phone.
  check(/mnav-allrow/.test(out), `[${label}] All Products row is present`);

  // 3. And it is LAST. Read the final row's whole class attribute rather than
  //    matching a fixed string: the row also carries `active` when nothing else
  //    is filtered, which a literal comparison would miss.
  const lastRow = out.lastIndexOf('class="mnav-row');
  const lastCls = lastRow > -1 ? out.slice(lastRow + 7, out.indexOf('"', lastRow + 7)) : '';
  check(/(^| )mnav-allrow( |$)/.test(lastCls),
    `[${label}] All Products is the last row`, `last row class: "${lastCls}"`);

  // 4. Every onchange must be syntactically valid JS with the slug intact.
  for (const code of onclicks(out)) {
    let ok = true, err = '';
    try { new Function(code.replace(/openShopWithCategory|closeAllDrawers/g, 'noop')); }
    catch (e) { ok = false; err = e.message; }
    check(ok, `[${label}] onchange parses as JS`, code.slice(0, 120) + '  ->  ' + err);
  }

  // 5. No raw quote can escape an attribute: count that every attribute closes.
  const badAttr = /(?:onchange|aria-label|data-cat)="[^"]*"[^\s>/]/.test(out);
  check(!badAttr, `[${label}] no attribute breaks out of its quotes`);

  // 6. A toggle appears only where subcategories exist.
  const cats = [...out.matchAll(/data-cat="([^"]*)"/g)].map(m => m[1]);
  const tree = api.categoryTree();
  const shown = api.rankedCategories(tree).slice(0, api.TOP_N);
  check(cats.length === shown.length,
    `[${label}] one .mnav-cat per SHOWN category`, `rows ${cats.length} vs shown ${shown.length}`);
  check(cats.length <= api.TOP_N,
    `[${label}] never more than the top ${api.TOP_N}`, `got ${cats.length}`);
  // The rows must be the shown slice, in that order — not merely the right count.
  const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  check(cats.map(unesc).join('\u0000') === shown.map(n => n.cat).join('\u0000'),
    `[${label}] the rows ARE the ranked slice, in order`);
  const toggles = (out.match(/class="mnav-cattoggle"/g) || []).length;
  const expectToggles = shown.filter(n => n.subs.length > 0).length;
  check(toggles === expectToggles,
    `[${label}] toggle only where subcategories exist`, `got ${toggles} expected ${expectToggles}`);

  // 7. Sub rows exist for every subcategory of a shown category.
  const subRows = (out.match(/mnav-subrow/g) || []).length;
  const expectSubs = shown.reduce((n, c) => n + c.subs.length, 0);
  check(subRows === expectSubs,
    `[${label}] a row per subcategory`, `got ${subRows} expected ${expectSubs}`);

  // 7b. All Categories is always offered, and always ABOVE All Products.
  const acAt = out.indexOf('mnav-actionrow');
  const apAt = out.lastIndexOf('mnav-allrow');
  check(acAt > -1, `[${label}] the All Categories row is present`);
  check(acAt > -1 && apAt > acAt, `[${label}] All Categories sits above All Products`);

  // 8. Every row carries a radio, and exactly one radio is checked per group.
  const rows = (out.match(/class="mnav-row/g) || []).length;
  const radios = (out.match(/<input type="radio"/g) || []).length;
  const actionRows = (out.match(/mnav-actionrow/g) || []).length;
  // Every SELECTABLE row has a radio. All Categories is an action, not a
  // selection, so it deliberately has none — hence the subtraction.
  check(rows - actionRows === radios,
    `[${label}] every selectable row has a radio`, `rows ${rows} actions ${actionRows} radios ${radios}`);
  const checkedCat = (out.match(/name="mnavCat"[^>]*\schecked/g) || []).length;
  check(checkedCat <= 1, `[${label}] at most one category radio is checked`, `got ${checkedCat}`);
  const checkedSub = (out.match(/name="mnavSub"[^>]*\schecked/g) || []).length;
  check(checkedSub <= 1, `[${label}] at most one subcategory radio is checked`, `got ${checkedSub}`);

  // 9. Counts must be the real counts.
  shown.forEach(node => {
    const esc = api.escapeHtml(node.cat);
    const seg = out.slice(out.indexOf('data-cat="' + esc + '"'));
    const cnt = seg.match(/<span class="mnav-count">(\d+)<\/span>/);
    check(cnt && Number(cnt[1]) === node.count,
      `[${label}] count for "${node.cat}"`, `markup ${cnt && cnt[1]} vs tree ${node.count}`);
  });

  return { out, tree };
}

// ============================================================ the catalogs
const CASES = [];

CASES.push(['empty catalog', []]);
CASES.push(['one product, no category', [p(1, '')]]);
CASES.push(['one category no subs', [p(1, 'malas')]]);
CASES.push(['normal shape', [p(1, 'book', 'scripture'), p(2, 'book'), p(3, 'malas'), p(4, 'yantra')]]);

// Names an admin could really type.
const NASTY = [
  "rudraksha's mala",
  'sacred "gems"',
  'back\\slash',
  '</script><script>alert(1)</script>',
  'ampersand & co',
  'रुद्राक्ष',
  'emoji 🔱 category',
  '   spaced   out   ',
  '---',
  'a'.repeat(200),
  'tab\tinside',
  'new\nline',
  'quote"and\'both',
];
NASTY.forEach((n, i) => {
  CASES.push([`nasty category: ${JSON.stringify(n).slice(0, 40)}`, [p(1, n), p(2, n, 'sub' + i)]]);
  CASES.push([`nasty subcategory: ${JSON.stringify(n).slice(0, 40)}`, [p(1, 'book', n), p(2, 'book')]]);
});

// Scale: what the drawer looks like after two years of the admin adding things.
const many = [];
for (let c = 0; c < 40; c++) {
  many.push(p(1000 + c, 'cat-' + c));
  for (let s = 0; s < 12; s++) many.push(p(2000 + c * 20 + s, 'cat-' + c, 'sub-' + s));
}
CASES.push(['40 categories x 12 subcategories', many]);

// Selection states.
CASES.push(['filtered to a category', [p(1, 'book', 'scripture'), p(2, 'malas')], { cat: 'malas', subcat: '' }]);
CASES.push(['filtered to a subcategory', [p(1, 'book', 'scripture'), p(2, 'malas')], { cat: 'book', subcat: 'scripture' }]);
CASES.push(['filtered to all', [p(1, 'book')], { cat: 'all', subcat: '' }]);
CASES.push(['filtered to a category that no longer exists',
  [p(1, 'book')], { cat: 'deleted-cat', subcat: 'gone' }]);

for (const [label, products, filters] of CASES) {
  try {
    run(label, products, filters);
  } catch (e) {
    failures.push(`[${label}] THREW: ${e.message}`);
  }
}

// ==========================================================================
// THE RANKING MATHS. "Top 15 by most sold" is a claim about an ORDER, and an
// order that is not total is an order that changes between page loads.
// ==========================================================================
{
  // 40 categories of deliberately varying depth.
  const cats = [];
  for (let c = 0; c < 40; c++) {
    const depth = (c % 5) + 1;              // 1..5 products each
    for (let n = 0; n < depth; n++) cats.push(p(50000 + c * 10 + n, 'cat-' + String(c).padStart(2, '0')));
  }

  // Sales figures with deliberate ties, and four categories left UNRANKED to
  // stand in for "outside the server's top-20 window".
  const rank = Object.create(null);
  for (let c = 0; c < 36; c++) rank['cat-' + String(c).padStart(2, '0')] = (c % 7) * 10;

  const { api } = buildSandbox(cats, { cat: '', subcat: '' }, rank);
  const tree = api.categoryTree();
  const ordered = api.rankedCategories(tree);

  check(ordered.length === tree.length, '[rank] ranking keeps every category', `${ordered.length} vs ${tree.length}`);

  // 1. Primary key: units DESC.
  let monotonic = true;
  for (let i = 1; i < ordered.length; i++) {
    const u = k => (Object.prototype.hasOwnProperty.call(rank, k) ? rank[k] : -1);
    if (u(ordered[i - 1].cat) < u(ordered[i].cat)) monotonic = false;
  }
  check(monotonic, '[rank] units sold never increases down the list');

  // 2. Ties break by product count DESC, then name ASC — and nothing else.
  let tiesOk = true, tieDetail = '';
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i];
    const u = k => (Object.prototype.hasOwnProperty.call(rank, k) ? rank[k] : -1);
    if (u(a.cat) !== u(b.cat)) continue;
    if (a.count < b.count) { tiesOk = false; tieDetail = `${a.cat}(${a.count}) before ${b.cat}(${b.count})`; break; }
    if (a.count === b.count && a.cat.localeCompare(b.cat) > 0) {
      tiesOk = false; tieDetail = `${a.cat} before ${b.cat} on equal units and depth`; break;
    }
  }
  check(tiesOk, '[rank] equal units break by depth then name', tieDetail);

  // 3. An unranked category can never outrank a ranked one. This is the claim
  //    that makes a 20-row server window safe for a 15-row client list.
  const firstUnranked = ordered.findIndex(n => !Object.prototype.hasOwnProperty.call(rank, n.cat));
  const lastRanked = ordered.map(n => Object.prototype.hasOwnProperty.call(rank, n.cat)).lastIndexOf(true);
  check(firstUnranked === -1 || firstUnranked > lastRanked,
    '[rank] every ranked category outranks every unranked one',
    `first unranked at ${firstUnranked}, last ranked at ${lastRanked}`);

  // 4. Exactly the top N reach the drawer, and they are the head of the order.
  const { api: api2, host: host2 } = buildSandbox(cats, { cat: '', subcat: '' }, rank);
  api2.renderMobileNavCategories();
  const shownCats = [...host2.innerHTML.matchAll(/data-cat="([^"]*)"/g)].map(m => m[1]);
  check(shownCats.length === api2.TOP_N, `[rank] exactly ${api2.TOP_N} categories reach the drawer`, `got ${shownCats.length}`);
  check(shownCats.join('|') === ordered.slice(0, api2.TOP_N).map(n => n.cat).join('|'),
    '[rank] the drawer shows the HEAD of the ranking, not an arbitrary 15');

  // 5. Determinism: the same inputs must produce the same 15, every time.
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const s = buildSandbox(cats, { cat: '', subcat: '' }, rank);
    runs.push(s.api.rankedCategories(s.api.categoryTree()).map(n => n.cat).join('|'));
  }
  check(new Set(runs).size === 1, '[rank] the same catalogue always ranks the same way');

  // 6. COLD START: with no sales data the order must fall back to the tree's
  //    own total order rather than to nothing.
  const cold = buildSandbox(cats, { cat: '', subcat: '' }, null);
  const coldTree = cold.api.categoryTree();
  check(cold.api.rankedCategories(coldTree).map(n => n.cat).join('|') === coldTree.map(n => n.cat).join('|'),
    '[rank] with no sales data, catalogue depth is the fallback order');
  cold.api.renderMobileNavCategories();
  check((cold.host.innerHTML.match(/data-cat=/g) || []).length === cold.api.TOP_N,
    '[rank] and the drawer still shows a full top slice during a cold start');

  // 7. Sales data must actually CHANGE the order, or none of the above proves
  //    anything. Rank the alphabetically-last category top and watch it move.
  const boost = Object.create(null);
  boost['cat-39'] = 99999;
  const b = buildSandbox(cats, { cat: '', subcat: '' }, boost);
  check(b.api.rankedCategories(b.api.categoryTree())[0].cat === 'cat-39',
    '[rank] units sold really does drive the order');
}

// ---- the active-subcategory reveal must actually mark the group open ----
{
  const { api, host } = buildSandbox([p(1, 'book', 'scripture'), p(2, 'malas')],
    { cat: 'book', subcat: 'scripture' });
  api.renderMobileNavCategories();
  check(/class="mnav-cat open" data-cat="book"/.test(host.innerHTML),
    '[reveal] the group holding the active subcategory renders open');
}

console.log(`\n${checks} checks, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.slice(0, 25).forEach(f => console.log('  - ' + f));
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  process.exit(1);
}
console.log('the drawer holds up on every catalog thrown at it');
