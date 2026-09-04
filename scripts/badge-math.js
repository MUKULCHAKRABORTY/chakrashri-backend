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
const src = consts + '\nlet _bestsellerCut = { src: null, value: null };\n'
  + grab('bestsellerThreshold') + '\n' + grab('isBestseller') + '\n' + grab('isNewArrival')
  + '\nreturn { bestsellerThreshold, isBestseller, isNewArrival };';

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

console.log(failed ? '\n  ' + failed + ' FAILED\n' : '\n  the badge maths holds on every distribution\n');
process.exit(failed ? 1 : 0);
