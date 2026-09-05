/**
 * Browser-level test for the admin review moderation screen.
 *
 * WHY THIS EXISTS
 *
 * The screen is new, and the thing it replaces was not a broken screen — it was
 * NO screen. GET /api/admin/reviews and PATCH /api/admin/reviews/:id have
 * existed since migration 005, gated behind the reviews:moderate capability and
 * writing every decision to the audit log, and nothing in the console ever
 * called either. A review went live on the product page the moment a customer
 * wrote it, and the only way to take one down was hand-written SQL. Granting
 * somebody reviews:moderate unlocked nothing, because there was nothing to
 * unlock.
 *
 * WHAT ONLY A BROWSER CAN ANSWER HERE
 *
 *   1. WHAT THE CARD CONTAINS. A rating renders as five separate elements with
 *      a spoken label, a hidden review shows the reason it was hidden, and a
 *      review with no written comment still renders something a person can act
 *      on rather than an empty box. All of those are properties of the produced
 *      DOM, not of the source.
 *   2. WHAT THE SERVER RECEIVES. Hiding must send `approve:false` WITH a
 *      reason, and publishing must send `approve:true` — to the per-review
 *      endpoint. Reading the source shows the intent; running it shows the
 *      request.
 *   3. THAT A HIDE WITHOUT A REASON NEVER LEAVES THE BROWSER. The server
 *      refuses it with a 400, and the moderator should be told before the round
 *      trip rather than after it.
 *   4. THAT NOTHING A CUSTOMER TYPED BECOMES MARKUP. A review is the most
 *      directly attacker-controlled text in this console: anyone who buys one
 *      item can write one.
 *
 * Requires playwright + chromium. Skips cleanly when unavailable;
 * REQUIRE_BROWSER_TESTS=true turns that skip into a failure, as CI sets.
 *
 * Run: node test/browser-reviews.test.js
 */
const REQUIRE_BROWSER = process.env.REQUIRE_BROWSER_TESTS === 'true';
const INSTALL_HINT = 'npx playwright install chromium';

function skip(reason, hint) {
  if (REQUIRE_BROWSER) {
    console.error('\n[browser-reviews] FAILED: ' + reason + '.');
    console.error('                  REQUIRE_BROWSER_TESTS=true, so this cannot be skipped.');
    console.error('                  Fix with: ' + hint + '\n');
    process.exit(1);
  }
  console.log('\n[browser-reviews] SKIPPED: ' + reason + '.');
  console.log('                  To run it:  ' + hint);
  console.log('                  (One-time per machine. Every other suite still ran.)\n');
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

/* One live review, one hidden review carrying a reason, one rating with no
   comment, and one whose text is an injection attempt. Each exists because a
   different branch of the renderer only runs for it. */
const REVIEWS = [
  { id: 'rrrrrrrr-0000-4000-8000-000000000001', product_id: 'p1', product_name: 'Sphatik Mala',
    product_slug: 'sphatik-mala', rating: 5, comment: 'Beautiful piece.\n\nArrived well packed.',
    reviewer_name_snapshot: 'Asha Rao', reviewer_email: 'asha@test.invalid',
    is_approved: true, hidden_reason: null, created_at: '2026-09-01T10:00:00Z', moderated_at: null },
  { id: 'rrrrrrrr-0000-4000-8000-000000000002', product_id: 'p2', product_name: 'Shree Yantra',
    product_slug: 'shree-yantra', rating: 1, comment: 'Buy from my shop instead, cheaper!!!',
    reviewer_name_snapshot: 'Spam Bot', reviewer_email: 'spam@test.invalid',
    is_approved: false, hidden_reason: 'Advertising a competitor',
    created_at: '2026-08-30T09:00:00Z', moderated_at: '2026-08-31T09:00:00Z' },
  { id: 'rrrrrrrr-0000-4000-8000-000000000003', product_id: 'p3', product_name: 'Puja Table',
    product_slug: 'puja-table', rating: 4, comment: '',
    reviewer_name_snapshot: null, reviewer_email: null,
    is_approved: true, hidden_reason: null, created_at: '2026-08-28T09:00:00Z', moderated_at: null },
  { id: 'rrrrrrrr-0000-4000-8000-000000000004', product_id: 'p4',
    product_name: '<img src=x onerror="window.__pwned=1">', product_slug: 'x',
    rating: 3, comment: '<script>window.__pwned = 2;<\/script>',
    reviewer_name_snapshot: '"><b>bold</b>', reviewer_email: null,
    is_approved: false, hidden_reason: '<i>italic</i>',
    created_at: '2026-08-27T09:00:00Z', moderated_at: null }
];

const harness = `<!doctype html><html><body>
<div id="toastWrap"></div>
<button class="btn btn-sm rv-tab active" data-rv="pending"></button>
<button class="btn btn-sm rv-tab" data-rv="all"></button>
<span id="reviewsCount"></span>
<div id="reviewsList"></div>
<span class="pill" id="navReviewsBadge" style="display:none;"></span>

<script>
window.__calls = [];
window.__toasts = [];
/* The closing sequence is broken up on the way in. One of these fixtures is a
   review whose text is a script tag, and the HTML parser ends a <script>
   element at the first closing tag it sees — inside a string, inside a comment,
   anywhere. Embedded raw, that fixture truncates this harness and every
   function below it is undefined, which is a confusing way to learn that the
   escaping works. */
window.__reviews = ${JSON.stringify(REVIEWS).replace(/<\//g, '<\\/')};
window.__fail = null;

${admin.match(/function qs\(sel, root\)[^\n]*\n/)[0]}
${admin.match(/function qsa\(sel, root\)[^\n]*\n/)[0]}
${fn('esc')}
${admin.match(/function fmtDate\(d\)[^\n]*\n/)[0]}

function toast(msg, type){ window.__toasts.push({ msg: msg, type: type }); }

async function api(path, opts){
  const method = (opts && opts.method) || 'GET';
  window.__calls.push({ path: path, method: method, body: opts && opts.body });
  if (window.__fail) throw { error: window.__fail };
  if (method === 'PATCH') {
    // Mirror the server: it refuses a hide with no reason.
    const sent = JSON.parse((opts && opts.body) || '{}');
    if (sent.approve === false && !sent.reason) throw { error: 'Please give a reason when hiding a review — it is recorded in the audit log.' };
    const row = window.__reviews.find(function(r){ return path.indexOf(r.id) > -1; });
    if (row) { row.is_approved = sent.approve !== false; row.hidden_reason = sent.reason || null; }
    return { ok: true };
  }
  const onlyHidden = /hidden=true/.test(path);
  const list = onlyHidden ? window.__reviews.filter(function(r){ return r.is_approved === false; }) : window.__reviews;
  return { reviews: list };
}

${admin.match(/let reviewFilter = 'pending';/)[0]}
${fn('switchReviewFilter')}
${fn('reviewStars')}
${fn('storefrontProductHref')}
${fn('reviewCardHTML')}
${fn('loadReviews')}
${fn('refreshReviewBadge')}
${fn('openHideReview')}
${fn('cancelHideReview')}
${fn('approveReview')}
${fn('hideReview')}
</script></body></html>`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    skip('chromium is not installed for playwright', INSTALL_HINT);
  }
  /* SERVED OVER HTTP, NOT setContent.
     The console builds a storefront link from its own origin, because Netlify
     serves /admin from the storefront domain and a second constant to keep in
     sync is a second thing to get wrong. A page loaded by setContent has the
     origin `about:blank`, so that link correctly refuses to be built — and the
     one assertion about it would be testing the fallback for ever while
     believing it had tested the link. A throwaway server gives the page a real
     origin, which is the situation this screen actually runs in. */
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(harness);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(origin + '/', { waitUntil: 'load' });

  // ------------------------------------------------------------ the queue
  await page.evaluate(() => loadReviews());
  let cards = await page.evaluate(() =>
    [...document.querySelectorAll('.rv-card')].map((c) => c.dataset.review));
  check('the default view is only what still needs a decision',
    cards.length === 2 && cards.every((id) => /0000000000(02|04)$/.test(id)),
    cards.join(', '));

  const askedFor = await page.evaluate(() => window.__calls.map((c) => c.path)[0]);
  check('and it asks the SERVER for that set rather than filtering every review on the client',
    /hidden=true/.test(askedFor), askedFor);

  await page.evaluate(() => switchReviewFilter('all'));
  cards = await page.evaluate(() => [...document.querySelectorAll('.rv-card')].length);
  check('the All tab is the way back to the ones already published', cards === 4, String(cards));

  // ------------------------------------------------------------- the card
  const live = await page.evaluate(() => {
    const c = document.querySelector('[data-review$="0000000001"]');
    return {
      stars: c.querySelectorAll('.rv-stars svg').length,
      lit: c.querySelectorAll('.rv-stars svg.on').length,
      label: c.querySelector('.rv-stars').getAttribute('aria-label'),
      pill: c.querySelector('.pill').textContent.trim(),
      link: c.querySelector('.rv-prod a') ? c.querySelector('.rv-prod a').getAttribute('href') : null,
      action: c.querySelector('.rv-actions .btn').textContent.trim()
    };
  });
  check('a rating is five elements with a spoken label, never a run of star characters',
    live.stars === 5 && live.lit === 5 && live.label === '5 out of 5', JSON.stringify(live));
  check('a published review says so, and the only action offered is to take it down',
    live.pill === 'Live on the site' && /Hide/.test(live.action), JSON.stringify(live));
  check('the product name links to the page the review is actually on',
    live.link && live.link.indexOf('/product/sphatik-mala') > -1, String(live.link));

  const hidden = await page.evaluate(() => {
    const c = document.querySelector('[data-review$="0000000002"]');
    return {
      pill: c.querySelector('.pill').textContent.trim(),
      reason: c.querySelector('.rv-reason') ? c.querySelector('.rv-reason').textContent : null,
      action: c.querySelector('.rv-actions .btn').textContent.trim(),
      lit: c.querySelectorAll('.rv-stars svg.on').length
    };
  });
  check('a hidden review shows WHY it was hidden, so the decision can be reviewed later',
    /Advertising a competitor/.test(hidden.reason || ''), String(hidden.reason));
  check('and the only action offered is to publish it', /Publish/.test(hidden.action), hidden.action);
  check('one star lights one star', hidden.lit === 1, String(hidden.lit));

  const bare = await page.evaluate(() => {
    const c = document.querySelector('[data-review$="0000000003"]');
    return { body: c.querySelector('.rv-body').textContent.trim(),
             empty: c.querySelector('.rv-body').classList.contains('rv-empty'),
             who: c.querySelector('.rv-meta span').textContent.trim() };
  });
  check('a rating with no written comment still renders something a person can judge',
    bare.empty && bare.body.length > 0, JSON.stringify(bare));
  check('and a review with no name is Anonymous rather than blank', bare.who === 'Anonymous', bare.who);

  // ------------------------------------------------------------ injection
  const pwned = await page.evaluate(() => ({
    flag: window.__pwned || null,
    imgs: document.querySelectorAll('.rv-card img').length,
    scripts: document.querySelectorAll('.rv-card script').length,
    bolds: document.querySelectorAll('.rv-card b, .rv-card i').length,
    shown: (document.querySelector('[data-review$="0000000004"]') || {}).textContent || ''
  }));
  check('THE INJECTION CASE: nothing a customer typed becomes live markup',
    pwned.flag === null && pwned.imgs === 0 && pwned.scripts === 0 && pwned.bolds === 0,
    JSON.stringify(pwned).slice(0, 200));
  check('and it is still shown, as the text it is, so a moderator can see what was written',
    /window.__pwned/.test(pwned.shown), pwned.shown.slice(0, 80));

  // --------------------------------------------------------- the decision
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(() => approveReview('rrrrrrrr-0000-4000-8000-000000000002'));
  let sent = await page.evaluate(() => window.__calls.filter((c) => c.method === 'PATCH')[0]);
  check('publishing sends approve:true to that one review',
    sent && sent.path.indexOf('/api/admin/reviews/rrrrrrrr-0000-4000-8000-000000000002') === 0 &&
    JSON.parse(sent.body).approve === true, JSON.stringify(sent));

  // Hiding: the reason field is part of the card, and empty is refused here.
  await page.evaluate(() => { window.__calls.length = 0; window.__toasts.length = 0; });
  await page.evaluate(() => switchReviewFilter('all'));
  const boxHidden = await page.evaluate(() => {
    const box = document.querySelector('#rvHide-rrrrrrrr-0000-4000-8000-000000000001');
    return box ? box.classList.contains('show') : null;
  });
  check('the reason field starts closed, so the card is readable while deciding', boxHidden === false);

  await page.evaluate(() => openHideReview('rrrrrrrr-0000-4000-8000-000000000001'));
  const boxOpen = await page.evaluate(() =>
    document.querySelector('#rvHide-rrrrrrrr-0000-4000-8000-000000000001').classList.contains('show'));
  check('and opens beside the review rather than over it', boxOpen === true);

  await page.evaluate(() => { window.__calls.length = 0; window.__toasts.length = 0; });
  await page.evaluate(() => hideReview('rrrrrrrr-0000-4000-8000-000000000001'));
  const noReason = await page.evaluate(() => ({
    patches: window.__calls.filter((c) => c.method === 'PATCH').length,
    toasts: window.__toasts.map((t) => t.msg)
  }));
  check('THE 400 THE SERVER WOULD SEND: a hide with no reason never leaves the browser',
    noReason.patches === 0 && noReason.toasts.some((m) => /reason/i.test(m)),
    JSON.stringify(noReason));

  await page.evaluate(() => {
    document.querySelector('#rvReason-rrrrrrrr-0000-4000-8000-000000000001').value = 'Names a competitor';
  });
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(() => hideReview('rrrrrrrr-0000-4000-8000-000000000001'));
  sent = await page.evaluate(() => window.__calls.filter((c) => c.method === 'PATCH')[0]);
  const body = sent ? JSON.parse(sent.body) : {};
  check('with a reason it sends approve:false AND the reason, for the audit log',
    body.approve === false && body.reason === 'Names a competitor', JSON.stringify(body));

  // ------------------------------------------------------------ the badge
  await page.evaluate(() => refreshReviewBadge());
  const badge = await page.evaluate(() => {
    const b = document.querySelector('#navReviewsBadge');
    return { text: b.textContent, shown: b.style.display !== 'none' };
  });
  check('the waiting count rides on the nav item, so it is visible from every screen',
    badge.shown && Number(badge.text) > 0, JSON.stringify(badge));

  // ------------------------------------------------------------- failures
  await page.evaluate(() => { window.__fail = 'Your session has expired.'; });
  await page.evaluate(() => loadReviews());
  const failed = await page.evaluate(() => document.querySelector('#reviewsList').textContent);
  check("a server refusal surfaces the SERVER's message, not a generic failure",
    /session has expired/.test(failed), failed.slice(0, 80));

  await page.evaluate(() => { window.__fail = null; window.__reviews.length = 0; });
  await page.evaluate(() => loadReviews());
  const empty = await page.evaluate(() => document.querySelector('#reviewsList').textContent);
  check('an empty queue says what that MEANS rather than showing a blank panel',
    /Nothing is waiting/.test(empty) || /No reviews/.test(empty), empty.slice(0, 100));

  check('rendering the screen logs no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  server.close();

  console.log('\nRendering the REAL review moderation screen against a stubbed API:\n');
  let failures = 0;
  for (const r of results) {
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name);
    if (!r.ok) { failures++; if (r.extra) console.log('        got: ' + r.extra); }
  }
  console.log(failures
    ? '\n  ' + failures + ' FAILED\n'
    : '\n  REVIEW MODERATION RENDERS, DECIDES AND REPORTS CORRECTLY\n');
  process.exit(failures ? 1 : 0);
})();
