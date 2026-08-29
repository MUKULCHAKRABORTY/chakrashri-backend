/**
 * Browser-level test for the admin settings screen.
 *
 * WHY THIS EXISTS
 * The settings screen is the fix for a defect that static checks could not have
 * caught and very nearly repeated: migration 015 seeded six email settings,
 * described them as editable in "the admin console's settings screen", and no
 * such screen existed. A grep for "settings" in admin.html returned nothing.
 *
 * The frontend suite now asserts the screen is wired to the right endpoints,
 * but wiring is not rendering. These controls are built with DOM calls, their
 * labels are associated by assigning htmlFor, and the dirty-tracking compares
 * live control values against what the server last returned. Every one of those
 * is a runtime property: reading the source tells you the code intends to do it,
 * and only a browser tells you it did.
 *
 * So this renders the REAL SETTING_META, settingControl, loadSettings,
 * changedSettings, markSettingsDirty and saveSettings extracted from admin.html
 * against a stubbed API, then asserts what an admin would actually see and what
 * the server would actually receive.
 *
 * Requires playwright + chromium. Skips cleanly when they are unavailable, so
 * `npm test` still passes on a machine without them — and REQUIRE_BROWSER_TESTS
 * turns that skip into a failure, exactly as the card test does.
 *
 * Run: node test/browser-settings.test.js
 */
const REQUIRE_BROWSER = process.env.REQUIRE_BROWSER_TESTS === 'true';
const INSTALL_HINT = 'npx playwright install chromium';

function skip(reason, hint) {
  if (REQUIRE_BROWSER) {
    console.error('\n[browser-settings] FAILED: ' + reason + '.');
    console.error('                   REQUIRE_BROWSER_TESTS=true, so this cannot be skipped.');
    console.error('                   Fix with: ' + hint + '\n');
    process.exit(1);
  }
  console.log('\n[browser-settings] SKIPPED: ' + reason + '.');
  console.log('                   To run it:  ' + hint);
  console.log('                   (One-time per machine. Every other suite still ran.)\n');
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

/** A top-level function, `async` included — dropping the keyword would leave the
 *  `await` inside loadSettings/saveSettings as a syntax error in the harness. */
function fn(name) {
  const m = admin.match(new RegExp('(?:async\\s+)?function ' + name + '\\s*\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('could not extract function ' + name + ' from admin.html');
  return m[0];
}

/** A top-level const/let whose initialiser is an object or array literal. */
function decl(name) {
  const start = admin.search(new RegExp('(?:const|let)\\s+' + name + '\\s*='));
  if (start === -1) throw new Error('could not extract ' + name + ' from admin.html');
  let i = admin.indexOf('=', start) + 1;
  while (/\s/.test(admin[i])) i++;
  const open = admin[i];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) throw new Error(name + ' is not an object or array literal');
  let depth = 0;
  for (; i < admin.length; i++) {
    if (admin[i] === open) depth++;
    else if (admin[i] === close) {
      depth--;
      if (depth === 0) return admin.slice(start, i + 1) + ';';
    }
  }
  throw new Error('unterminated literal for ' + name);
}

// `some_new_setting` is deliberately NOT in SETTING_META. A setting added to
// DEFAULTS server-side must still appear, with a humanised label — the failure
// this whole screen exists to prevent is a setting that silently has no UI.
const RESPONSE = {
  editable: [
    'free_shipping_threshold_paise', 'shipping_flat_paise', 'cod_enabled',
    'cod_max_order_paise', 'cod_requires_verified_contact', 'max_cod_rto_before_block',
    'order_reservation_expiry_minutes', 'reviews_require_approval',
    'admin_alert_email', 'email_admin_alerts_enabled', 'email_marketing_enabled',
    'abandoned_cart_email_after_minutes', 'booking_reminder_hours_before',
    'low_stock_alert_threshold', 'some_new_setting'
  ],
  settings: {
    free_shipping_threshold_paise: 99900, shipping_flat_paise: 7900, cod_enabled: true,
    cod_max_order_paise: 500000, cod_requires_verified_contact: false,
    max_cod_rto_before_block: 2, order_reservation_expiry_minutes: 30,
    reviews_require_approval: false, admin_alert_email: '',
    email_admin_alerts_enabled: true, email_marketing_enabled: true,
    abandoned_cart_email_after_minutes: 20, booking_reminder_hours_before: 24,
    low_stock_alert_threshold: 5, some_new_setting: 'hello'
  }
};

const harness = `<!doctype html><html><body>
<div id="toastWrap"></div>
<div id="settingsBody"></div>
<div id="settingsFooter" style="display:none;">
  <span id="settingsDirty"></span>
  <button id="settingsSaveBtn" disabled>Save changes</button>
</div>
<script>
window.__puts = [];
window.__toasts = [];
window.__reject = null;
window.__response = ${JSON.stringify(RESPONSE)};

${admin.match(/function qs\(sel, root\)[^\n]*\n/)[0]}
${admin.match(/function qsa\(sel, root\)[^\n]*\n/)[0]}
${fn('esc')}
${admin.match(/function paise\(p\)[^\n]*\n/)[0]}

function toast(msg, type){ window.__toasts.push({ msg: msg, type: type }); }

async function api(path, opts){
  if (path === '/api/admin/settings') return window.__response;
  window.__puts.push({ path: path, method: opts && opts.method, body: opts && opts.body });
  if (window.__reject && path.indexOf(window.__reject.key) !== -1) throw { error: window.__reject.message };
  return { ok: true };
}

${decl('SETTING_META')}
${decl('SETTING_GROUP_ORDER')}
${decl('settingsLoaded')}
${fn('humaniseKey')}
${fn('settingControl')}
${fn('loadSettings')}
${fn('changedSettings')}
${fn('markSettingsDirty')}
${fn('saveSettings')}
</script></body></html>`;

const results = [];
function check(name, run) {
  try { run(); results.push([true, name]); }
  catch (e) { results.push([false, name, e.message]); }
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (!/Executable doesn.t exist|playwright install|Please run the following command/i.test(msg)) throw err;
    skip('the Chromium binary has not been downloaded on this machine', INSTALL_HINT);
    return;
  }

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  // charset=utf-8 is load-bearing: the harness carries ₹ (from the real paise()
  // helper) and an em dash. Served without it, Chromium decodes the UTF-8 bytes
  // as latin-1 and the rupee sign arrives mangled, so the hint assertion fails
  // for a reason that has nothing to do with the code under test.
  await page.route('**/*', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: harness }));
  await page.goto('https://admin.test/');

  console.log('\nRendering the REAL settings screen against a stubbed API:\n');

  const render = await page.evaluate(async () => {
    await loadSettings();
    const fields = Array.from(document.querySelectorAll('#settingsBody .field'));
    const fieldFor = (id) => fields.find((f) => f.querySelector('#' + id));
    return {
      count: fields.length,
      everyControlIsLabelled: fields.every((f) => {
        const l = f.querySelector('label');
        const c = f.querySelector('[data-setting]');
        return !!l && !!c && !!c.id && l.htmlFor === c.id;
      }),
      groups: Array.from(document.querySelectorAll('#settingsBody h3')).map((h) => h.textContent),
      email: (() => { const e = document.getElementById('set_admin_alert_email'); return { type: e.type, value: e.value }; })(),
      marketing: (() => { const e = document.getElementById('set_email_marketing_enabled'); return { tag: e.tagName, value: e.value, text: e.options[e.selectedIndex].text }; })(),
      threshold: (() => { const e = document.getElementById('set_free_shipping_threshold_paise'); return { type: e.type, value: e.value }; })(),
      paiseHint: (fieldFor('set_free_shipping_threshold_paise').querySelector('.hint') || {}).textContent,
      unknownLabel: (() => { const f = fieldFor('set_some_new_setting'); return f ? f.querySelector('label').textContent : null; })(),
      saveDisabled: document.getElementById('settingsSaveBtn').disabled,
      dirty: document.getElementById('settingsDirty').textContent,
      footer: document.getElementById('settingsFooter').style.display
    };
  });

  check('every editable key the server returns gets rendered', () => {
    assert.strictEqual(render.count, RESPONSE.editable.length,
      `rendered ${render.count} controls for ${RESPONSE.editable.length} editable settings`);
  });

  check('THE FINDING: every control has a label actually associated with it, not just placed near it', () => {
    assert.strictEqual(render.everyControlIsLabelled, true,
      'at least one control has no label whose htmlFor matches its id — a screen reader would announce it as unlabelled');
  });

  check('settings are grouped rather than dumped as one flat list of database keys', () => {
    assert.ok(render.groups.includes('Email'), 'no Email group: ' + JSON.stringify(render.groups));
    assert.ok(render.groups.length >= 4, 'expected at least four groups, got ' + render.groups.length);
  });

  check('a boolean renders as a Yes/No choice, not a raw true/false text box', () => {
    assert.strictEqual(render.marketing.tag, 'SELECT');
    assert.strictEqual(render.marketing.value, 'true');
    assert.strictEqual(render.marketing.text, 'Yes');
  });

  check('the alert address renders as an email field and starts empty, matching the 015 seed', () => {
    assert.strictEqual(render.email.type, 'email');
    assert.strictEqual(render.email.value, '');
  });

  check('a paise value shows its rupee equivalent, so 99900 cannot be read as ₹99,900', () => {
    assert.strictEqual(render.threshold.value, '99900');
    assert.ok(/₹\s?999\b/.test(render.paiseHint), 'hint does not show ₹999: ' + render.paiseHint);
  });

  check('a setting with no SETTING_META entry still renders, with a humanised label', () => {
    assert.strictEqual(render.unknownLabel, 'Some new setting',
      'an unlabelled new setting would be invisible to the admin, which is the original bug');
  });

  check('a freshly loaded screen has nothing to save', () => {
    assert.strictEqual(render.saveDisabled, true);
    assert.strictEqual(render.dirty, 'No unsaved changes');
    assert.strictEqual(render.footer, 'flex');
  });

  const edited = await page.evaluate(async () => {
    const e = document.getElementById('set_admin_alert_email');
    e.value = 'ops@chakrashri.com';
    e.dispatchEvent(new Event('input'));
    const afterEdit = {
      dirty: document.getElementById('settingsDirty').textContent,
      saveDisabled: document.getElementById('settingsSaveBtn').disabled
    };
    window.__puts = [];
    await saveSettings();
    return { afterEdit, puts: window.__puts, toasts: window.__toasts.slice() };
  });

  check('editing one control reports exactly one unsaved change and enables Save', () => {
    assert.strictEqual(edited.afterEdit.saveDisabled, false, 'Save stayed disabled after an edit');
    assert.strictEqual(edited.afterEdit.dirty, '1 unsaved change');
  });

  check('saving PUTs only the key that changed, to the per-key endpoint', () => {
    assert.strictEqual(edited.puts.length, 1, 'expected one PUT, got ' + JSON.stringify(edited.puts));
    assert.strictEqual(edited.puts[0].method, 'PUT');
    assert.ok(edited.puts[0].path.endsWith('/api/admin/settings/admin_alert_email'), edited.puts[0].path);
    assert.strictEqual(JSON.parse(edited.puts[0].body).value, 'ops@chakrashri.com');
  });

  const rejected = await page.evaluate(async () => {
    window.__toasts = [];
    window.__reject = {
      key: 'admin_alert_email',
      message: 'admin_alert_email must be a single email address with no display name, or empty to fall back to FROM_EMAIL.'
    };
    const e = document.getElementById('set_admin_alert_email');
    e.value = 'ops@x.com, attacker@evil.com';
    e.dispatchEvent(new Event('input'));
    await saveSettings();
    return { toasts: window.__toasts.slice() };
  });

  check("a server rejection surfaces the server's own message, not a generic failure", () => {
    const errs = rejected.toasts.filter((t) => t.type === 'err');
    assert.ok(errs.length, 'no error toast was shown for a rejected save');
    assert.ok(/single email address with no display name/.test(errs[0].msg),
      'the admin is not told WHY it was refused: ' + errs[0].msg);
    assert.ok(!rejected.toasts.some((t) => t.type === 'ok'),
      'a failed save also reported success');
  });

  check('rendering the screen logs no page errors', () => {
    assert.deepStrictEqual(pageErrors, []);
  });

  await browser.close();

  let failed = 0;
  for (const [ok, name, msg] of results) {
    if (ok) console.log('  PASS  ' + name);
    else { failed++; console.log('  FAIL  ' + name + '\n          ' + msg); }
  }
  console.log(failed ? `\n  ${failed} FAILED\n` : '\n  SETTINGS SCREEN RENDERS AND SAVES CORRECTLY\n');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\n[browser-settings] crashed: ' + (err && err.stack || err) + '\n');
  process.exit(1);
});
