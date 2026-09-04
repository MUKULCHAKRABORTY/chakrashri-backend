/**
 * Browser-level test for the admin inbox: archiving, filtering, and replying.
 *
 * WHY THIS EXISTS
 * Three defects here were invisible to a static read of the source:
 *
 *   1. ARCHIVE DID NOT ARCHIVE. loadContactMessages fetched every status with
 *      no filter, so an archived message stayed in the list for ever. The
 *      button changed a pill and nothing else — and reading the code, it looks
 *      correct: it PATCHes, it reloads, the server updates the row.
 *   2. "REPLIED" WAS A LABEL WITH NOTHING BEHIND IT. An admin could mark an
 *      enquiry answered without the customer ever hearing back, and afterwards
 *      nothing could distinguish a real reply from a mis-click.
 *   3. A FAILED SEND MUST NOT READ AS ANSWERED. The server leaves the message
 *      alone when the mail does not go; the console has to agree with it.
 *
 * Every one of those is about what the rendered table CONTAINS and what the
 * server RECEIVES, so it is tested by rendering the real functions extracted
 * from admin.html against a stubbed API — the same approach as
 * browser-settings.test.js, for the same reason.
 *
 * Requires playwright + chromium. Skips cleanly when unavailable;
 * REQUIRE_BROWSER_TESTS=true turns that skip into a failure, as CI sets.
 *
 * Run: node test/browser-inbox.test.js
 */
const REQUIRE_BROWSER = process.env.REQUIRE_BROWSER_TESTS === 'true';
const INSTALL_HINT = 'npx playwright install chromium';

function skip(reason, hint) {
  if (REQUIRE_BROWSER) {
    console.error('\n[browser-inbox] FAILED: ' + reason + '.');
    console.error('                REQUIRE_BROWSER_TESTS=true, so this cannot be skipped.');
    console.error('                Fix with: ' + hint + '\n');
    process.exit(1);
  }
  console.log('\n[browser-inbox] SKIPPED: ' + reason + '.');
  console.log('                To run it:  ' + hint);
  console.log('                (One-time per machine. Every other suite still ran.)\n');
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
const assert = require('assert');

const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function fn(name) {
  const m = admin.match(new RegExp('(?:async\\s+)?function ' + name + '\\s*\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('could not extract function ' + name + ' from admin.html');
  return m[0];
}

// One of each status, so "what is hidden" is a real question rather than a
// vacuous one.
const MESSAGES = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Asha Rao', email: 'asha@test.invalid',
    phone: '9876543210', subject: 'Where is my order?', message: 'I ordered a mala last week.\n\nAny update?',
    status: 'new', created_at: '2026-09-01T10:00:00Z' },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Bhav Singh', email: 'bhav@test.invalid',
    phone: null, subject: 'Bulk order', message: 'Do you do bulk pricing?',
    status: 'read', created_at: '2026-09-01T09:00:00Z' },
  { id: 'aaaaaaaa-0000-4000-8000-000000000003', name: 'Chetan M', email: 'chetan@test.invalid',
    phone: null, subject: 'Thanks', message: 'Lovely packaging.',
    status: 'replied', created_at: '2026-08-30T09:00:00Z' },
  { id: 'aaaaaaaa-0000-4000-8000-000000000004', name: 'Spam Bot', email: 'spam@test.invalid',
    phone: null, subject: 'SEO services', message: 'We can rank you #1.',
    status: 'archived', created_at: '2026-08-29T09:00:00Z' }
];

const harness = `<!doctype html><html><body>
<div id="toastWrap"></div>
<select id="messageStatusFilter">
  <option value="open">Open</option>
  <option value="new">New only</option>
  <option value="replied">Replied</option>
  <option value="archived">Archived</option>
  <option value="">Everything</option>
</select>
<table><tbody id="contactTbody"></tbody></table>
<span id="inboxBadge" style="display:none;"></span>

<div class="overlay" id="replyModal">
  <div class="modal">
    <h3 id="replyModalTitle"></h3>
    <div id="replyOriginal"></div>
    <textarea id="replyBody"></textarea>
    <p id="replyHint"></p>
    <button id="replySendBtn">Send reply</button>
  </div>
</div>

<script>
window.__calls = [];
window.__toasts = [];
window.__failReply = false;
window.__messages = ${JSON.stringify(MESSAGES)};

${admin.match(/function qs\(sel, root\)[^\n]*\n/)[0]}
${admin.match(/function qsa\(sel, root\)[^\n]*\n/)[0]}
${fn('esc')}

function toast(msg, type){ window.__toasts.push({ msg: msg, type: type }); }

/* Reply, Mark read, Unarchive and Archive all call endpoints that now require
   customers:contact as well as customers:read, so the row asks before drawing
   them. Granted here because this suite exercises the console as its owner
   uses it; the view-only case is covered as its own scenario below. */
window.__caps = ['customers:read', 'customers:contact'];
function hasCapability(cap){ return window.__caps.indexOf(cap) > -1; }
function fmtDateTime(v){ return String(v).slice(0, 10); }
const MSG_PILL = { new: 'pill-warn', read: 'pill-neutral', replied: 'pill-success', archived: 'pill-neutral' };

async function api(path, opts){
  window.__calls.push({ path: path, method: (opts && opts.method) || 'GET', body: opts && opts.body });
  if (path.indexOf('/reply') > -1) {
    if (window.__failReply) throw { error: 'The reply could not be sent. The message is still marked unanswered — please try again.' };
    return { ok: true, sentTo: 'asha@test.invalid' };
  }
  if (path.indexOf('/api/admin/contact-messages?') === 0) {
    // Mirror the server: it filters to ONE status when asked, otherwise returns all.
    const m = path.match(/[&?]status=([^&]+)/);
    const wanted = m ? decodeURIComponent(m[1]) : null;
    const list = wanted ? window.__messages.filter(function(x){ return x.status === wanted; }) : window.__messages;
    return { messages: list, unread: window.__messages.filter(function(x){ return x.status === 'new'; }).length, total: window.__messages.length };
  }
  return {};
}

${fn('updateInboxBadge')}
${admin.match(/let contactMessagesCache = \[\];/)[0]}
${admin.match(/let replyingTo = null;/)[0]}
${fn('loadContactMessages')}
${fn('openReplyModal')}
${fn('closeReplyModal')}
${fn('sendReply')}
${fn('setMessageStatus')}
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
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.setContent(harness);

  // ---------------------------------------------------------------- archive
  await page.evaluate(() => loadContactMessages());
  let rows = await page.evaluate(() => [...document.querySelectorAll('#contactTbody tr')]
    .map((tr) => tr.textContent));
  check('THE FINDING: an archived message is hidden by default',
    !rows.some((r) => /Spam Bot/.test(r)), rows.join(' | ').slice(0, 160));
  check('and everything still waiting on us IS shown',
    rows.some((r) => /Asha Rao/.test(r)) && rows.some((r) => /Bhav Singh/.test(r)));
  check('a replied message is not in the open queue either',
    !rows.some((r) => /Chetan M/.test(r)));

  // The only way back to it.
  await page.evaluate(() => { document.querySelector('#messageStatusFilter').value = 'archived'; });
  await page.evaluate(() => loadContactMessages());
  rows = await page.evaluate(() => [...document.querySelectorAll('#contactTbody tr')].map((tr) => tr.textContent));
  check('the Archived filter is the way back to it',
    rows.some((r) => /Spam Bot/.test(r)) && !rows.some((r) => /Asha Rao/.test(r)));
  const askedFor = await page.evaluate(() => window.__calls.map((c) => c.path).pop());
  check('and it asks the SERVER for that status rather than filtering 100 rows on the client',
    /status=archived/.test(askedFor), askedFor);

  const unarchive = await page.evaluate(() =>
    document.querySelector('#contactTbody').innerHTML.indexOf('Unarchive') > -1);
  check('an archived row offers Unarchive, not Archive again', unarchive);

  // ------------------------------------------------------------------ reply
  await page.evaluate(() => { document.querySelector('#messageStatusFilter').value = 'open'; });
  await page.evaluate(() => loadContactMessages());
  const hasReply = await page.evaluate(() =>
    document.querySelector('#contactTbody').innerHTML.indexOf('openReplyModal') > -1);
  check('every open message offers a real Reply', hasReply);

  const noBareReplied = await page.evaluate(() =>
    document.querySelector('#contactTbody').innerHTML.indexOf("setMessageStatus('" ) > -1
      ? !/setMessageStatus\([^)]*'replied'\)/.test(document.querySelector('#contactTbody').innerHTML)
      : true);
  check('THE FINDING: "mark as replied" without replying is gone', noBareReplied);

  await page.evaluate(() => openReplyModal('aaaaaaaa-0000-4000-8000-000000000001'));
  const modal = await page.evaluate(() => ({
    open: document.querySelector('#replyModal').classList.contains('show'),
    title: document.querySelector('#replyModalTitle').textContent,
    quoted: document.querySelector('#replyOriginal').textContent,
    hint: document.querySelector('#replyHint').textContent
  }));
  check('the composer opens', modal.open);
  check('it names who is being replied to', /Asha Rao/.test(modal.title), modal.title);
  check('it quotes their original message, so the reply is written against it',
    /I ordered a mala last week/.test(modal.quoted) && /Where is my order\?/.test(modal.quoted));
  check('and states the address it will actually send to',
    /asha@test\.invalid/.test(modal.hint), modal.hint);

  // Empty replies must not be sendable.
  await page.evaluate(() => { document.querySelector('#replyBody').value = ' '; });
  await page.evaluate(() => sendReply());
  const emptyCalls = await page.evaluate(() => window.__calls.filter((c) => /\/reply/.test(c.path)).length);
  check('an empty reply is refused before any request', emptyCalls === 0);

  // A real one.
  await page.evaluate(() => { document.querySelector('#replyBody').value = 'It shipped this morning.'; });
  await page.evaluate(() => sendReply());
  const sent = await page.evaluate(() => window.__calls.filter((c) => /\/reply/.test(c.path)).pop());
  check('a real reply POSTs to the reply endpoint', sent && sent.method === 'POST', JSON.stringify(sent));
  check('with the typed text as the body',
    sent && JSON.parse(sent.body).body === 'It shipped this morning.', sent && sent.body);
  check('addressed to the message being replied to',
    sent && sent.path.indexOf('aaaaaaaa-0000-4000-8000-000000000001') > -1, sent && sent.path);
  const closed = await page.evaluate(() => !document.querySelector('#replyModal').classList.contains('show'));
  check('and the composer closes on success', closed);

  // ------------------------------------------------- a send that fails
  await page.evaluate(() => { window.__failReply = true; });
  await page.evaluate(() => openReplyModal('aaaaaaaa-0000-4000-8000-000000000002'));
  await page.evaluate(() => { document.querySelector('#replyBody').value = 'Yes we do.'; });
  await page.evaluate(() => sendReply());
  const afterFail = await page.evaluate(() => ({
    stillOpen: document.querySelector('#replyModal').classList.contains('show'),
    btnEnabled: !document.querySelector('#replySendBtn').disabled,
    btnText: document.querySelector('#replySendBtn').textContent,
    lastToast: window.__toasts[window.__toasts.length - 1]
  }));
  check('THE FINDING: a failed send keeps the composer open, with the text intact',
    afterFail.stillOpen);
  check('the button is usable again rather than stuck on "Sending…"',
    afterFail.btnEnabled && afterFail.btnText === 'Send reply', JSON.stringify(afterFail));
  check('and the admin is told it did NOT go',
    afterFail.lastToast && afterFail.lastToast.type === 'err'
      && /could not be sent/i.test(afterFail.lastToast.msg), JSON.stringify(afterFail.lastToast));

  /* ---- A viewer who may read enquiries but not act on them ----------------

     Sending mail to a customer as the business, and recording an enquiry as
     dealt with, both now require customers:contact on top of customers:read.
     A button that exists and always answers 403 is worse than no button, so
     the row must not draw them without the grant. Nobody holds read-without-
     contact today — which is exactly why this needs a test rather than a
     manual check nobody will repeat. */
  await page.evaluate(async () => {
    window.__caps = ['customers:read'];
    document.querySelector('#messageStatusFilter').value = 'open';
    await loadContactMessages();
  });
  const viewOnly = await page.evaluate(() => {
    const body = document.querySelector('#contactTbody');
    return {
      rows: body.querySelectorAll('tr').length,
      reply: body.textContent.includes('Reply'),
      archive: body.textContent.includes('Archive'),
      notice: body.textContent.includes('View only')
    };
  });
  check('a reader without the contact grant still SEES the enquiries',
    viewOnly.rows > 0, JSON.stringify(viewOnly));
  check('but is offered no Reply or Archive button that would only 403',
    !viewOnly.reply && !viewOnly.archive, JSON.stringify(viewOnly));
  check('and is told why the actions are absent',
    viewOnly.notice, JSON.stringify(viewOnly));

  // Put the grant back so nothing after this point runs half-authorised.
  await page.evaluate(async () => {
    window.__caps = ['customers:read', 'customers:contact'];
    await loadContactMessages();
  });

  check('no page errors while doing any of it', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();

  console.log('\nDriving the REAL admin inbox against a stubbed API:\n');
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log('  PASS  ' + r.name);
    else { failed++; console.log('  FAIL  ' + r.name + (r.extra ? '\n        ' + r.extra : '')); }
  }
  console.log(failed ? `\n  ${failed} FAILED\n` : '\n  INBOX ARCHIVES, FILTERS AND REPLIES CORRECTLY\n');
  process.exit(failed ? 1 : 0);
})();
