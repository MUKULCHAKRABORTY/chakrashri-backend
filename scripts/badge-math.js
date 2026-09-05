// Runs the REAL badge maths lifted out of index.html against distributions a
// shop actually passes through, from three orders to a runaway hit.
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function grab(name) {
  const i = html.search(new RegExp('function ' + name + '\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  const s = html.indexOf('{', i);
  for (let k = s; k < html.length; k++) {
    if (html[k] === '{') d++;
    else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); }
  }
}

const consts = html.match(/const NEW_ARRIVAL_DAYS[\s\S]*?const MIN_SELLING_PRODUCTS = \d+;/)[0];
const limitedMax = html.match(/const LIMITED_STOCK_MAX = \d+;/)[0];
const suppressed = html.match(/const BADGE_SUPPRESSED = \[[^\]]*\];/)[0];
const src = consts + '\n' + limitedMax + '\n' + suppressed
  + '\nlet _bestsellerCut = { src: null, value: null };\n'
  + grab('bestsellerThreshold') + '\n' + grab('isBestseller') + '\n' + grab('isNewArrival')
  + '\n' + grab('isLimited') + '\n' + grab('badgeIsSuppressed') + '\n' + grab('effectiveBadge')
  + '\n' + grab('badgeInfo') + '\n' + grab('discountTagHTML')
  + '\nreturn { bestsellerThreshold, isBestseller, isNewArrival, isLimited,'
  + ' effectiveBadge, badgeInfo, discountTagHTML };';

const mk = (P) => new Function('PRODUCTS', src)(P);

let failed = 0;
function expect(label, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failed++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got ' + JSON.stringify(actual) + ' wanted ' + JSON.stringify(wanted)));
}

function run(units) {
  const P = units.map((u, i) => ({ id: i, unitsSold: u }));
  const a = mk(P);
  return { cut: a.bestsellerThreshold(), flagged: P.filter(a.isBestseller).map((p) => p.unitsSold) };
}

console.log('\nThe bestseller threshold, over distributions a real shop passes through:\n');

// Too few products have sold anything to speak of a distribution at all.
expect('3 selling products is not a distribution — nothing is a bestseller',
  run([1, 2, 1, 0, 0]), { cut: null, flagged: [] });

expect('empty catalog says "cannot tell", never "everything"',
  run([]), { cut: null, flagged: [] });

// 5 sellers: 80th percentile of [1,2,3,10,40] is rank ceil(.8*5)-1 = 3 -> 10.
expect('a wide spread picks the genuine top of the range',
  run([1, 2, 3, 10, 40, 0, 0]), { cut: 10, flagged: [10, 40] });

// Everything equal: the percentile lands on 5, so all of them qualify. That is
// the mathematically honest answer — nothing outsells anything.
expect('when everything sells identically, the percentile does not invent a winner',
  run([5, 5, 5, 5, 5, 5]), { cut: 5, flagged: [5, 5, 5, 5, 5, 5] });

// One runaway hit among ones: rank ceil(.8*6)-1 = 4 -> sorted [1,1,1,1,1,900][4] = 1,
// floored to MIN_BESTSELLER_UNITS = 3, so only the hit clears it.
expect('THE FLOOR: a product that sold once is never a bestseller',
  run([1, 1, 1, 1, 1, 900]), { cut: 3, flagged: [900] });

expect('all-tiny sales are floored out entirely',
  run([1, 1, 1, 1, 2]), { cut: 3, flagged: [] });

// The cache must not leak an answer between different catalogs.
{
  const a = mk([{ unitsSold: 1 }, { unitsSold: 1 }, { unitsSold: 1 }, { unitsSold: 1 }, { unitsSold: 50 }]);
  const first = a.bestsellerThreshold();
  const second = a.bestsellerThreshold();
  expect('the memoised threshold is stable across repeated calls', [first, second], [3, 3]);
}

console.log('\nNew arrivals, at the boundaries:\n');
const a = mk([]);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
expect('today is new', a.isNewArrival({ createdAt: daysAgo(0) }), true);
expect('day 29 is still new', a.isNewArrival({ createdAt: daysAgo(29) }), true);
expect('day 31 is not', a.isNewArrival({ createdAt: daysAgo(31) }), false);
expect('a future-dated row is bad data, not a new arrival',
  a.isNewArrival({ createdAt: daysAgo(-5) }), false);
expect('a missing date is not new', a.isNewArrival({ createdAt: null }), false);
expect('an unparseable date is not new', a.isNewArrival({ createdAt: 'not-a-date' }), false);
expect('no product at all does not throw', a.isNewArrival(null), false);


// ---------------------------------------------------------------------------
console.log('\nWhich badge wins, and why:\n');
{
  // Ten sellers, so the percentile has a real distribution to work from.
  const shop = [];
  for (let i = 0; i < 10; i++) shop.push({ id: 'p' + i, unitsSold: i * 3, stock: true, stockQty: 50, createdAt: daysAgo(400) });
  const b = mk(shop);
  const base = { stock: true, stockQty: 50, unitsSold: 0, createdAt: daysAgo(400) };
  const with_ = (o) => Object.assign({}, base, o);

  expect('a typed badge beats every computation',
    b.effectiveBadge(with_({ badge: 'Certified', stockQty: 2, unitsSold: 999 })), 'Certified');

  /* The third state. Blank means "decide for me" and a word means "use this",
     and without a way to say NOTHING a seller could not take a badge off a
     product the maths had badged — an ordinary decision for a line being
     discontinued. */
  for (const word of ['none', 'hide', 'off', 'no', 'hidden', 'NONE', ' Hide ']) {
    expect('suppressed by "' + word.trim() + '"',
      b.effectiveBadge(with_({ badge: word, stockQty: 1, unitsSold: 999 })), '');
  }

  /* Scarcity outranks social proof: "Bestseller" builds interest, "Only 2 left"
     closes, and a product that is both should say the one with a deadline. */
  expect('low stock outranks bestseller',
    b.effectiveBadge(with_({ stockQty: 2, unitsSold: 999 })), 'limited');
  expect('bestseller outranks new when stock is healthy',
    b.effectiveBadge(with_({ unitsSold: 999, createdAt: daysAgo(1) })), 'bestseller');
  expect('new when it is only new', b.effectiveBadge(with_({ createdAt: daysAgo(1) })), 'new');
  expect('nothing when it is nothing', b.effectiveBadge(base), '');
}

console.log('\nLimited shows the REAL count, and never invents one:\n');
{
  const b = mk([]);
  expect('five in stock is limited', b.isLimited({ stock: true, stockQty: 5 }), true);
  expect('six is not', b.isLimited({ stock: true, stockQty: 6 }), false);
  expect('sold out is out of stock, not limited', b.isLimited({ stock: false, stockQty: 0 }), false);
  /* The one that matters. A counter ticking down on a timer is the most
     recognisable dark pattern in retail, and this shop sells temple objects to
     people who are trusting it. No stock figure means no scarcity claim. */
  expect('an unknown quantity is NOT limited — scarcity is never invented',
    b.isLimited({ stock: true, stockQty: null }), false);
  expect('the label states the true number', b.badgeInfo('limited', { stockQty: 3 }).text, 'Only 3 left');
}

console.log('\nThe discount tier follows the SIZE of the saving:\n');
{
  const b = mk([]);
  const tier = (pct) => {
    const m = b.discountTagHTML({ mrp: 100, price: 100 - pct }).match(/dt-(\w+)/);
    return m ? m[1] : 'none';
  };
  /* It used to hash the product id, so a 5% saving could draw the loudest
     treatment on the grid while a 70% one sat still. The decoration and the
     number disagreed, and the decoration is louder. Now the treatment IS the
     information, and the grid can be scanned by colour alone. */
  expect('5% is stated, not sold', tier(5), 'low');
  expect('24% still low', tier(24), 'low');
  expect('25% starts to breathe', tier(25), 'mid');
  expect('49% still mid', tier(49), 'mid');
  expect('50% catches the light', tier(50), 'high');
  expect('74% still high', tier(74), 'high');
  expect('75% is the only tier allowed to be emphatic', tier(75), 'max');
  expect('90% still max', tier(90), 'max');
  expect('no saving renders nothing', b.discountTagHTML({ mrp: 100, price: 100 }), '');
  expect('a saving that rounds to zero renders nothing', b.discountTagHTML({ mrp: 1000, price: 999 }), '');
}

console.log(failed ? '\n  ' + failed + ' FAILED\n' : '\n  the badge maths holds on every distribution\n');
process.exit(failed ? 1 : 0);
