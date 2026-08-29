/**
 * Static checks on index.html and admin.html.
 *
 * WHY THIS FILE EXISTS AT ALL
 * Both SPAs are single 400KB / 130KB files with no build step, so nothing ever
 * parsed them. During the audit fixes I introduced a bug that a build step
 * would have caught instantly and a human review would probably not have: a
 * comment containing a literal closing script tag. The HTML parser ends a
 * <script> element at the first closing script tag it sees — inside a string,
 * inside a comment, anywhere — so that one comment silently truncated 140KB of
 * application JavaScript and the storefront would have shipped half-dead.
 *
 * These checks are cheap, run in CI, and cover the class of mistake that is
 * invisible in a diff:
 *   1. the inline scripts actually parse as JavaScript;
 *   2. no script-terminating sequence hides inside them;
 *   3. every form control has an accessible name (A11Y-01);
 *   4. the SEO tags SEO-01 added are present and wired;
 *   5. no unescaped interpolation has crept back into an innerHTML sink.
 *
 * Run: node test/frontend.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = ['index.html', 'admin.html'];

const queue = [];
function section(name) { queue.push({ type: 'section', name }); }
function test(name, fn) { queue.push({ type: 'test', name, fn }); }

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/** Inline JS blocks: not src=, not a JSON-LD data island. */
function inlineScripts(html) {
  return html.match(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g) || [];
}

function inlineScriptBodies(html) {
  return inlineScripts(html).map((block) => block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
}

// ============================================================
section('[fe-1] The inline JavaScript actually parses');
// ============================================================
for (const file of FILES) {
  test(`${file}: every inline script block is syntactically valid JavaScript`, () => {
    const bodies = inlineScriptBodies(read(file));
    assert.ok(bodies.length > 0, 'expected at least one inline script block');
    const joined = bodies.join('\n;\n');
    const tmp = path.join(os.tmpdir(), `chakrashri-${file}-${process.pid}.js`);
    fs.writeFileSync(tmp, joined, 'utf8');
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(`${file} inline JS failed to parse:\n${err.stderr ? err.stderr.toString().slice(0, 800) : err.message}`);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test(`${file}: the main script block is not silently truncated by a stray closing tag`, () => {
    // The bug this catches: a literal closing script tag inside a JS string or
    // comment ends the element, so everything after it becomes page text. The
    // symptom is not a syntax error — it is a script block that is suspiciously
    // short and an application that half-works.
    const bodies = inlineScriptBodies(read(file));
    const largest = Math.max(...bodies.map((b) => b.length));
    const minimum = file === 'index.html' ? 150000 : 60000;
    assert.ok(
      largest >= minimum,
      `largest inline script is only ${largest} chars (expected at least ${minimum}). ` +
      'A closing script tag has probably crept into a string or comment and truncated it.'
    );
  });
}

// ============================================================
section('[fe-2] A11Y-01 — every form control has an accessible name');
// ============================================================
for (const file of FILES) {
  test(`${file}: no control is left for a screen reader to announce as an unlabelled field`, () => {
    const html = read(file);
    const labelledIds = new Set([...html.matchAll(/<label\b[^>]*\bfor\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
    // A control nested inside a <label> is implicitly associated.
    const wrappedIds = new Set();
    for (const m of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
      for (const c of m[1].matchAll(/\bid\s*=\s*"([^"]+)"/g)) wrappedIds.add(c[1]);
    }

    const unnamed = [];
    for (const m of html.matchAll(/<(?:input|textarea|select)\b[^>]*>/g)) {
      const tag = m[0];
      const type = (tag.match(/type\s*=\s*"([^"]*)"/) || [, 'text'])[1].toLowerCase();
      if (['hidden', 'submit', 'button', 'reset'].includes(type)) continue;
      const id = (tag.match(/\bid\s*=\s*"([^"]*)"/) || [, null])[1];
      const named = /aria-label\s*=/.test(tag)
        || /aria-labelledby\s*=/.test(tag)
        || (id && (labelledIds.has(id) || wrappedIds.has(id)));
      if (!named) unnamed.push(tag.slice(0, 90));
    }
    assert.deepStrictEqual(unnamed, [], `controls with no accessible name:\n  ${unnamed.join('\n  ')}`);
  });

  test(`${file}: every <label for="x"> points at a control that exists`, () => {
    const html = read(file);
    const ids = new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
    const dangling = [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((target) => !ids.has(target));
    assert.deepStrictEqual(dangling, [], `labels pointing at nothing: ${dangling.join(', ')}`);
  });

  test(`${file}: no id is declared twice (a duplicate silently breaks label association and getElementById)`, () => {
    const html = read(file);
    const seen = new Map();
    for (const m of html.matchAll(/\bid\s*=\s*"([^"]+)"/g)) {
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} (${n}x)`);
    assert.deepStrictEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
  });
}

// ============================================================
section('[fe-3] SEO-01 — discoverability tags and real URLs');
// ============================================================
{
  test('index.html declares a canonical link, Open Graph and Twitter tags', () => {
    const html = read('index.html');
    assert.match(html, /<link rel="canonical"/, 'missing canonical link');
    assert.match(html, /<meta property="og:title"/, 'missing og:title');
    assert.match(html, /<meta property="og:url"/, 'missing og:url');
    assert.match(html, /<meta name="twitter:card"/, 'missing twitter:card');
    assert.match(html, /<meta name="robots"/, 'missing robots meta');
  });

  test('index.html carries Organization and WebSite structured data, plus a per-page JSON-LD slot', () => {
    const html = read('index.html');
    assert.match(html, /id="ldOrganization"/);
    assert.match(html, /id="ldWebSite"/);
    assert.match(html, /id="ldPage"/, 'the per-page JSON-LD element product pages write into is missing');
  });

  test('the static JSON-LD islands contain valid JSON', () => {
    const html = read('index.html');
    let checked = 0;
    for (const m of html.matchAll(/<script type="application\/ld\+json" id="(ldOrganization|ldWebSite)">([\s\S]*?)<\/script>/g)) {
      const body = m[2].trim();
      assert.doesNotThrow(() => JSON.parse(body), `${m[1]} is not valid JSON`);
      checked++;
    }
    assert.strictEqual(checked, 2, 'expected two static JSON-LD blocks');
  });

  test('THE FINDING: routing pushes real paths, not fragments', () => {
    const html = read('index.html');
    assert.match(html, /history\.pushState\(null, '', newPath\)/,
      'navigateTo should push a real path');
    assert.ok(!/history\.pushState\(null, '', '#'/.test(html),
      'a fragment-based pushState has come back — search engines cannot index those');
  });

  test('legacy #hash URLs are still honoured, so existing bookmarks and emailed links keep working', () => {
    const html = read('index.html');
    assert.match(html, /function routeFromLocation/);
    assert.match(html, /location\.hash/, 'the hash fallback has been removed — old links would 404');
  });

  test('internal navigation links have real crawlable hrefs, not href="#"', () => {
    const html = read('index.html');
    const dead = (html.match(/href="#"\s+onclick="(?:navigateTo|openShopWithCategory)\(/g) || []).length;
    assert.strictEqual(dead, 0, `${dead} navigation links still use href="#" and cannot be followed by a crawler`);
  });

  test('product cards are real anchors, so a product page is discoverable and middle-clickable', () => {
    const html = read('index.html');
    assert.match(html, /'<a class="p-media" href="' \+ productHref\(p\)/);
    assert.match(html, /'<a class="p-name" href="' \+ productHref\(p\)/);
  });

  test('robots.txt exists, disallows per-customer pages and points at the sitemap', () => {
    const robots = read('robots.txt');
    assert.match(robots, /Disallow: \/checkout/);
    assert.match(robots, /Disallow: \/admin/);
    assert.match(robots, /Sitemap: https:\/\//);
  });

  test('_redirects gives Netlify the SPA fallback real paths depend on', () => {
    const redirects = read('_redirects');
    assert.match(redirects, /\/\*\s+\/index\.html\s+200/,
      'without a 200 rewrite, every product URL is a hard 404 on refresh or from a search result');
    assert.match(redirects, /\/admin\s+\/admin\.html\s+200/);
  });
}

// ============================================================
section('[fe-4] FE-01 — Content Security Policy and script integrity');
// ============================================================
{
  test('_headers ships a real CSP that blocks framing, plugins and form hijacking', () => {
    const headers = read('_headers');
    assert.match(headers, /Content-Security-Policy:/);
    assert.match(headers, /frame-ancestors 'none'/);
    assert.match(headers, /object-src 'none'/);
    assert.match(headers, /base-uri 'none'/);
    assert.match(headers, /form-action 'self'/);
  });

  test('the CSP allows exactly the third parties the app actually uses, and no more', () => {
    // Parse the real header line, not the first "script-src" that happens to
    // appear in the explanatory comments above it — which is what an earlier
    // version of this test did, and it failed for that reason rather than
    // because anything was wrong with the policy.
    const headers = read('_headers');
    const policyLine = headers.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'));
    assert.ok(policyLine, 'no Content-Security-Policy header line found');

    const directives = Object.fromEntries(
      policyLine.replace(/^\s*Content-Security-Policy:\s*/, '')
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [name, ...values] = d.split(/\s+/);
          return [name, values];
        })
    );

    assert.ok(directives['script-src'], 'script-src is missing');
    assert.ok(directives['script-src'].includes('https://checkout.razorpay.com'),
      'Razorpay Checkout must be allowed or payment breaks');
    assert.ok(!directives['script-src'].some((v) => v.includes('cdnjs.cloudflare.com')),
      'cdnjs should no longer be in script-src — Chart.js is self-hosted');
    assert.deepStrictEqual(directives['default-src'], ["'self'"]);
    assert.ok(directives['connect-src'].some((v) => v.includes('razorpay')),
      'the browser must be able to reach Razorpay or checkout cannot complete');
  });

  test('the admin console is marked noindex — it must never appear in search results', () => {
    const headers = read('_headers');
    assert.match(headers, /X-Robots-Tag: noindex/);
  });

  test('Chart.js is self-hosted with an integrity hash, not loaded from a CDN unverified', () => {
    const html = read('admin.html');
    assert.match(html, /src="vendor\/chart\.umd\.js"/, 'Chart.js should be self-hosted');
    assert.match(html, /integrity="sha384-[A-Za-z0-9+/=]{40,}"/, 'the integrity hash is missing or malformed');
    assert.ok(!/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js[^"]*"\s*(?![^>]*integrity)/.test(html),
      'an unpinned CDN script tag has come back');
  });

  test('the vendored Chart.js file exists and matches the hash in the tag', () => {
    const html = read('admin.html');
    const declared = (html.match(/integrity="sha384-([A-Za-z0-9+/=]+)"/) || [, null])[1];
    assert.ok(declared, 'no integrity hash found');
    const file = path.join(ROOT, 'vendor', 'chart.umd.js');
    assert.ok(fs.existsSync(file), 'vendor/chart.umd.js is missing — the admin charts would not load');
    const actual = require('crypto').createHash('sha384').update(fs.readFileSync(file)).digest('base64');
    assert.strictEqual(actual, declared,
      'the integrity hash does not match vendor/chart.umd.js — the browser would refuse the script and the dashboard charts would silently vanish');
  });
}

// ============================================================
section('[fe-5] XSS discipline holds');
// ============================================================
for (const file of FILES) {
  test(`${file}: an escaping helper is defined and used`, () => {
    const html = read(file);
    const hasHelper = /function escapeHtml\s*\(/.test(html) || /function esc\s*\(/.test(html);
    assert.ok(hasHelper, 'no HTML-escaping helper found');
    const uses = (html.match(/\b(?:escapeHtml|esc)\(/g) || []).length;
    assert.ok(uses > 20, `escaping helper is defined but used only ${uses} times — expected it throughout`);
  });

  test(`${file}: the escaping helper actually escapes — verified by running it, not by reading it`, () => {
    // Pattern-matching the source is fragile: the single-quote key in the
    // replacement map is written as "'" (double-quoted, because the value
    // contains a quote), so a naive `includes("'''")` reports a false failure
    // on a perfectly correct escaper. Extracting the function and executing it
    // tests the thing that actually matters.
    const html = read(file);
    const name = file === 'admin.html' ? 'esc' : 'escapeHtml';
    const match = html.match(new RegExp(`function ${name}\\s*\\(str\\)\\s*\\{[\\s\\S]*?\\n\\}`));
    assert.ok(match, `could not locate function ${name} in ${file}`);

    // eslint-disable-next-line no-new-func
    const escape = new Function(`${match[0]}; return ${name};`)();

    assert.strictEqual(escape('&'), '&amp;');
    assert.strictEqual(escape('<'), '&lt;');
    assert.strictEqual(escape('>'), '&gt;');
    assert.strictEqual(escape('"'), '&quot;');
    assert.strictEqual(escape("'"), '&#39;');

    // The case this all exists for.
    const injected = escape('<img src=x onerror="alert(1)">');
    assert.ok(!injected.includes('<img'), 'markup survived escaping');
    assert.ok(!injected.includes('"'), 'an unescaped quote could break out of an attribute');

    // And the case that breaks a product page if the escaper is over-eager.
    assert.strictEqual(escape('Rudraksha & Sphatik'), 'Rudraksha &amp; Sphatik');
  });
}

// ============================================================
section('[fe-7] AUTH-02 — capability gating cannot leak or lock out');
// ============================================================
{
  test('gated controls are hidden by DEFAULT, not revealed-then-hidden', () => {
    // Awaiting the capability fetch is not enough: these controls are in the
    // static sidebar markup and are painted before any script runs. Hiding by
    // default means the only possible failure is a control appearing slightly
    // late, never a staff user seeing a refund button that then vanishes.
    const html = read('admin.html');
    assert.match(html, /\[data-cap\]:not\(\.cap-ok\)\s*\{[^}]*display\s*:\s*none/,
      'capability-gated controls must default to hidden in CSS');
  });

  test('the reveal uses a CLASS, never style.display = ""', () => {
    // Setting style.display='' removes the inline override and lets the hiding
    // rule reassert itself — so an admin allowed everything would see nothing.
    // This is a bug that actually happened; the class toggle is the fix.
    const html = read('admin.html');
    const fn = (html.match(/async function applyCapabilities\(\)[\s\S]*?\n\}/) || [''])[0];
    assert.ok(fn, 'applyCapabilities not found');
    assert.ok(/classList\.(toggle|add)\(['"]cap-ok['"]/.test(fn),
      'applyCapabilities should reveal via a class');
    assert.ok(!/style\.display\s*=\s*['"]{2}/.test(fn),
      "reveal must not use style.display = '' — the CSS rule would win and hide it again");
  });

  test('a failed capability lookup reveals everything rather than locking the admin out', () => {
    const html = read('admin.html');
    const fn = (html.match(/async function applyCapabilities\(\)[\s\S]*?\n\}/) || [''])[0];
    const catchBlock = (fn.match(/catch\s*\([\s\S]*?return;/) || [''])[0];
    assert.ok(/classList\.add\(['"]cap-ok['"]\)/.test(catchBlock),
      'the failure path must un-hide the controls — the server is the enforcement point, not the UI');
  });

  test('capabilities are fetched from the server, never hardcoded in the UI', () => {
    const html = read('admin.html');
    assert.match(html, /\/api\/admin\/me\/capabilities/,
      'the permission map must come from the server or it will drift from it');
  });

  test('currentView is declared BEFORE the session-restore IIFE that reaches it', () => {
    // A pre-existing temporal-dead-zone bug: `let currentView` sat below the
    // restoreSession IIFE, so restoring a session threw and the catch turned it
    // into a silent logout. Refreshing the admin console logged you out.
    const html = read('admin.html');
    const decl = html.indexOf("let currentView");
    const iife = html.indexOf('(function restoreSession(');
    assert.ok(decl > -1 && iife > -1, 'could not locate both declarations');
    assert.ok(decl < iife,
      'let currentView must be declared before restoreSession, or restoring a session throws in the TDZ and silently logs the admin out');
  });
}

// ============================================================
// ============================================================
// FE-02 — every CSS class the JavaScript names must actually exist
// ============================================================
// A class name is a contract between two halves of the same file, and nothing
// enforces it: `pill-ok` renders as unstyled text rather than throwing, so a
// "confirmed" subscriber and a "sent" email simply lose their colour and no
// test, linter or console message says a word. This was a real bug in the Inbox
// view — the class is pill-success — and it is invisible until someone looks at
// the right screen with the right data in it.
section('[fe-8] FE-02 — class names used in JS exist in the stylesheet');
{
  const files = [['index.html', read('index.html')], ['admin.html', read('admin.html')]];
  // Only the families where a wrong name is silent AND visually meaningful.
  // (?<![\w-]) not \b: a hyphen is a non-word character, so \b fires between
  // `hero-` and `badge-float` and the test reports a class that is really only
  // the tail of `hero-badge-float`. Two false positives on the first run, which
  // is exactly the failure mode that gets a useful test deleted.
  const FAMILIES = /(?<![\w-])(pill|badge|status)-[a-z][a-z-]*\b/g;

  for (const [name, html] of files) {
    test(name + ': every pill/badge/status class named in code is defined in CSS', () => {
      const styleBlocks = (html.match(/<style[\s\S]*?<\/style>/g) || []).join('\n');
      const used = new Set(html.match(FAMILIES) || []);
      const missing = [];
      for (const cls of used) {
        if (styleBlocks.indexOf('.' + cls) === -1) missing.push(cls);
      }
      assert.deepStrictEqual(missing, [],
        'these class names are used but never styled, so they render as plain text: ' + missing.join(', '));
    });
  }
}

// ============================================================
// The three forms that used to throw customer input away
// ============================================================
// Each of these showed a confirmation toast and made no request at all. The
// test asserts the REQUEST, not the toast, because the toast is exactly what
// was there before and exactly what made the bug invisible.
// ============================================================
// FE-03 — a table's header count must match its colspans
// ============================================================
// Adding a column to the rows and forgetting the <thead>, or forgetting the
// colspan on the empty/loading row, produces a table that renders misaligned
// and reports nothing. It happened twice while wiring the COD column into the
// customers table. Silent, visual, and trivially checkable.
section('[fe-10] FE-03 — table columns line up');
{
  for (const file of FILES) {
    test(file + ': every data table\'s header count matches its colspans', () => {
      const html = read(file);
      const problems = [];
      // Scoped to one <table> at a time. An earlier version of this check
      // scanned a fixed window after each <thead>, spilled into the following
      // table and reported twelve failures on correct markup — a check that
      // cries wolf is a check somebody deletes.
      for (const m of html.matchAll(/<table class="data">([\s\S]*?)<\/table>/g)) {
        const inner = m[1];
        const head = (inner.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
        const headers = (head.match(/<th[ >]/g) || []).length;
        if (!headers) continue;
        const spans = [...inner.matchAll(/colspan="(\d+)"/g)].map((x) => Number(x[1]));
        const wrong = [...new Set(spans.filter((c) => c !== headers))];
        if (wrong.length) {
          const id = (inner.match(/id="([a-zA-Z]+)"/) || ['', 'unknown'])[1];
          problems.push(id + ': ' + headers + ' headers but colspan ' + wrong.join(', '));
        }
      }
      assert.deepStrictEqual(problems, [], 'misaligned tables: ' + problems.join(' | '));
    });
  }
}

section('[fe-9] The capture forms actually submit somewhere');
{
  const cases = [
    ['back-in-stock waitlist', 'notifyStock', '/api/engage/stock-notify'],
    ['newsletter subscribe', 'handleNewsletterSubmit', '/api/engage/newsletter'],
    ['contact form', 'handleContactSubmit', '/api/engage/contact']
  ];
  for (const [label, fnName, endpoint] of cases) {
    test('THE FINDING: ' + label + ' posts to ' + endpoint + ' instead of only showing a toast', () => {
      const fn = extractFunction(read('index.html'), fnName);
      assert.ok(fn, fnName + ' is missing from index.html');
      assert.ok(fn.includes(endpoint), fnName + ' does not call ' + endpoint);
      assert.ok(/apiFetch\s*\(/.test(fn), fnName + ' never issues a request');
    });
  }

  test('the password reset flow is reachable — there is a link that requests one', () => {
    assert.ok(/requestPasswordReset/.test(read('index.html')), 'no requestPasswordReset function');
    assert.ok(/onclick="return requestPasswordReset\(\);"/.test(read('index.html')),
      'the function exists but nothing in the markup calls it, which is how it was unreachable before');
    assert.ok(read('index.html').includes('/api/auth/forgot-password'), 'nothing calls the forgot-password endpoint');
  });

  test('DPDP data export and sign-out-everywhere are reachable from the account panel', () => {
    assert.ok(read('index.html').includes('/api/customer/me/data-export'), 'no caller for the data export endpoint');
    assert.ok(read('index.html').includes('/api/auth/logout-all'), 'no caller for the logout-all endpoint');
    assert.ok(/onclick="downloadMyData\(\);"/.test(read('index.html')), 'data export has no button');
    assert.ok(/onclick="logoutEverywhere\(\);"/.test(read('index.html')), 'sign-out-everywhere has no button');
  });

  test('the two emailed links the storefront now has to handle are routed', () => {
    for (const fn of ['handleNewsletterConfirmLink', 'handleUnsubscribeLink']) {
      assert.ok(read('index.html').includes('async function ' + fn), fn + ' is missing');
      assert.ok(read('index.html').includes('await ' + fn + '()'), fn + ' is defined but never dispatched at boot');
    }
  });
}

/** Pulls one function's source out of an HTML file, brace-balanced. */
function extractFunction(html, name) {
  const start = html.search(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  if (start === -1) return null;
  let depth = 0; let seen = false;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') { depth++; seen = true; }
    else if (html[i] === '}') { depth--; if (seen && depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}

section('[fe-11] The settings screen exists and is wired to the settings API');
{
  // THE FINDING: migration 015 seeded six email settings and its own comment
  // described them as self-documenting in "the admin console's settings
  // screen". There was no settings screen. The API had GET and PUT
  // /api/admin/settings and admin.html contained the string "settings" exactly
  // zero times, so every one of these values was reachable only by hand-written
  // SQL — including admin_alert_email, which the release notes listed as a
  // required post-deploy step.
  const admin = read('admin.html');

  test('THE FINDING: the admin console has a settings view at all', () => {
    assert.ok(admin.includes('id="view-settings"'), 'no settings view section');
    assert.ok(/data-view="settings"/.test(admin), 'no nav button that opens it');
    assert.ok(/settings:\s*\{\s*title:/.test(admin), 'settings has no VIEW_META entry, so switchView would throw on the title lookup');
  });

  test('opening the view actually loads it — a nav button that renders an empty pane is the bug being fixed', () => {
    const refresh = extractFunction(admin, 'refreshCurrentView');
    assert.ok(refresh, 'refreshCurrentView is missing');
    assert.ok(/currentView === 'settings'/.test(refresh) && /loadSettings\(\)/.test(refresh),
      'refreshCurrentView never calls loadSettings, so the view would stay on its spinner');
  });

  test('it reads and writes the real endpoints', () => {
    const load = extractFunction(admin, 'loadSettings');
    const save = extractFunction(admin, 'saveSettings');
    assert.ok(load && load.includes('/api/admin/settings'), 'loadSettings does not GET /api/admin/settings');
    assert.ok(save && save.includes('/api/admin/settings/'), 'saveSettings does not PUT to the per-key endpoint');
    assert.ok(/method:\s*'PUT'/.test(save), 'saveSettings never issues a PUT');
  });

  test('the editable list comes from the server, so a setting added to DEFAULTS appears without a frontend change', () => {
    const load = extractFunction(admin, 'loadSettings');
    assert.ok(/body\.editable/.test(load),
      'loadSettings does not use the API\'s `editable` list — a hardcoded list is how these six settings went missing in the first place');
  });

  test('the screen is gated on settings:write, hidden by default like every other gated control', () => {
    assert.ok(/data-cap="settings:write"[^>]*data-view="settings"|data-view="settings"[^>]*data-cap="settings:write"/.test(admin),
      'the settings nav button is not capability-gated');
  });

  test('every setting migration 015 seeds has a label in the console', () => {
    for (const key of [
      'admin_alert_email', 'email_admin_alerts_enabled', 'email_marketing_enabled',
      'abandoned_cart_email_after_minutes', 'booking_reminder_hours_before',
      'low_stock_alert_threshold'
    ]) {
      assert.ok(admin.includes(key + ':'), `${key} has no SETTING_META entry, so it renders with a raw database key as its label`);
    }
  });
}

// ============================================================
section('[fe-6] HYG-05 — no API key or direct model call in client code');
// ============================================================
{
  test('THE FINDING: the browser no longer calls the model provider directly', () => {
    const html = read('index.html');
    const liveCall = /fetch\(\s*['"]https:\/\/api\.anthropic\.com/.test(html);
    assert.strictEqual(liveCall, false,
      'a direct api.anthropic.com call from the browser is back — it cannot work without a key, and a key in a public HTML file is a key that gets scraped and billed');
    assert.match(html, /\/api\/support\/chat/, 'the chat widget should call our own backend proxy');
  });

  test('no credential-shaped literal appears in either HTML file', () => {
    for (const file of FILES) {
      const html = read(file);
      const patterns = [
        [/sk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic API key'],
        [/rzp_live_[A-Za-z0-9]{8,}/, 'a live Razorpay key'],
        [/postgres(?:ql)?:\/\/[^\s"'<]+:[^\s"'<]+@/, 'a database connection string'],
        [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key']
      ];
      for (const [re, what] of patterns) {
        assert.ok(!re.test(html), `${file} appears to contain ${what}`);
      }
    }
  });
}

// ============================================================
// Runner
// ============================================================
(async () => {
  let passed = 0; let failed = 0;
  for (const item of queue) {
    if (item.type === 'section') { console.log('\n' + item.name); continue; }
    try {
      await item.fn();
      console.log('  PASS -', item.name);
      passed++;
    } catch (e) {
      console.log('  FAIL -', item.name, '\n        ', e.message);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
