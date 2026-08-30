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
      // apiFetch OR queuedPost. queuedPost is the outbox wrapper: it calls
      // apiFetch first and only falls back to local storage when the request
      // could not be delivered, so the guarantee this test exists to protect —
      // that the form reaches the server rather than just showing a toast — is
      // stronger than it was, not weaker. See OUTBOX_ROUTES in index.html.
      assert.ok(/apiFetch\s*\(|queuedPost\s*\(/.test(fn),
        fnName + ' never issues a request');
      if (/queuedPost\s*\(/.test(fn)) {
        assert.ok(!/^\s*toast\(/m.test(fn.split('queuedPost')[0].split('\n').slice(-3).join('\n')),
          fnName + ' confirms to the customer before attempting delivery');
      }
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
section('[fe-12] The storefront cannot silently show a truncated catalog');
{
  // THE FINDING: loadCatalog asked for `?limit=1000`. The API clamps limit to
  // 100 — deliberately, as a DoS guard — and reports the real total in
  // pagination.totalCount, which the storefront never read. So the 101st product
  // would simply not appear: no error, no warning, and an HTTP 200. At the time
  // this was found the catalog held 10 products, i.e. 90 of headroom before a
  // silent, invisible failure.
  const index = read('index.html');
  const load = extractFunction(index, 'loadCatalog');

  test('loadCatalog exists and no longer asks for a limit the server will silently clamp', () => {
    assert.ok(load, 'loadCatalog is missing from index.html');
    assert.ok(!/limit=1000/.test(load),
      'still requesting limit=1000 — the server caps it at 100 and says nothing');
  });

  test('THE FINDING: it pages through the catalog instead of taking one response', () => {
    assert.ok(/[?&]page=/.test(load), 'loadCatalog never requests a page beyond the first');
    assert.ok(/limit=\$\{PAGE_SIZE\}|limit=100/.test(load),
      'the page size should match the server cap so no request is silently clamped');
  });

  test('it compares what it received against the server\'s totalCount', () => {
    assert.ok(/totalCount/.test(load),
      'loadCatalog does not read pagination.totalCount, so it cannot know the catalog was truncated');
  });

  test('an incomplete catalog is reported, not swallowed', () => {
    assert.ok(/console\.warn[\s\S]{0,200}INCOMPLETE/i.test(load),
      'a short catalog is accepted silently — the failure this whole section exists to prevent');
  });

  test('the page loop is bounded, so a paging bug cannot hang the storefront', () => {
    assert.ok(/page\s*<=\s*\d+/.test(load),
      'the pagination loop has no upper bound; a server that always reports more would spin forever');
  });

  // Caught while reviewing the pagination fix above, which had introduced it.
  // The original guard was `if (body && body.products)` — and an empty ARRAY is
  // truthy, so an empty catalog from the API correctly won over local storage.
  // Rewriting that as `if (rows.length)` silently changed the meaning: with every
  // product deactivated the storefront would fall through to the cached copy and
  // show customers items that are no longer for sale. That is worse than the
  // truncation being fixed, because it invents inventory rather than hiding it.
  test('an EMPTY catalog from the API is respected, not replaced with stale local data', () => {
    assert.ok(!/if\s*\(\s*rows\.length\s*\)/.test(load),
      'the API result is gated on rows.length — an empty catalog would fall through to the stale storage fallback and resurrect deleted products');
    assert.ok(/apiAnswered/.test(load),
      'loadCatalog does not distinguish "the API answered" from "the API returned products"; those are different questions and only the first should decide whether to use the fallback');
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
section('[fe-13] Prerendered product pages carry the right link preview');
// ============================================================
// scripts/generate-product-pages.js rewrites the head of a 460KB index.html
// with string replacement. A pattern that silently matched nothing would emit
// pages that look perfect and carry the GENERIC preview — the exact bug the
// script exists to fix, reintroduced invisibly. These tests are the guard.
{
  const gen = require('../scripts/generate-product-pages.js');

  // A product chosen to exercise every branch at once: an ampersand and a
  // double quote that must be escaped, a real image, a stock count, reviews.
  const PRODUCT = {
    id: 7,
    slug: 'sphatik-shivling-2in',
    name: 'Sphatik "Premium" Shivling & Base',
    category: 'lingam',
    price_paise: 249900,
    mrp_paise: 349900,
    rating: '4.6',
    review_count: 18,
    badge: 'bestseller',
    stock_qty: 7,
    has_variants: false,
    sku: 'CS-LNG-001',
    short_desc: 'Natural clear quartz shivling, hand-finished.',
    long_desc: 'Longer copy.',
    material: 'Sphatik',
    image_url: 'https://cdn.example.test/shivling.jpg'
  };

  const source = read('index.html');
  const rendered = gen.renderProductPage(source, PRODUCT);
  const out = rendered.html;

  function metaContent(html, selector) {
    const re = new RegExp('<meta ' + selector + ' content="([^"]*)"');
    const m = html.match(re);
    return m ? m[1] : null;
  }

  test('THE FINDING: every head tag is actually rewritten — nothing silently missed', () => {
    assert.deepStrictEqual(rendered.missed, [],
      'these replacements matched nothing, so the page would carry the generic preview: ' + rendered.missed.join(', '));
  });

  test('the title and og:title name the product, not the site', () => {
    assert.match(out, /<title>Sphatik &quot;Premium&quot; Shivling &amp; Base — Buy Online \| Chakrashri<\/title>|<title>Sphatik "Premium" Shivling &amp; Base — Buy Online \| Chakrashri<\/title>/,
      'the <title> still reads as the generic site title');
    const ogTitle = metaContent(out, 'property="og:title"');
    assert.ok(ogTitle && ogTitle.indexOf('Shivling') > -1, 'og:title does not name the product: ' + ogTitle);
    assert.ok(ogTitle.indexOf('Sacred Objects, Puja Booking') === -1, 'og:title is still the generic site title');
  });

  test('og:url and canonical point at this product, not the home page', () => {
    // The origin is read from the generator, never hardcoded here: the live site
    // is currently the Netlify subdomain and moves to the custom domain later,
    // and a test that pins one of those fails the day the other becomes true.
    const origin = (process.env.SITE_ORIGIN || process.env.URL || 'https://chakrashri.netlify.app').replace(/\/+$/, '');
    const expected = origin + '/product/sphatik-shivling-2in';
    assert.strictEqual(metaContent(out, 'property="og:url"'), expected);
    assert.ok(out.indexOf('<link rel="canonical" href="' + expected + '">') > -1,
      'canonical should be ' + expected);
  });

  test('og:type is product, so a share card renders as an item and not a website', () => {
    assert.strictEqual(metaContent(out, 'property="og:type"'), 'product');
  });

  test('THE OTHER FINDING: an image reaches the preview card at all', () => {
    // index.html ships with no og:image, and the code that used to add one read
    // p.img — a field no product object in this project has ever had. So every
    // shared link was pictureless. The generator adds it from image_url.
    assert.strictEqual(metaContent(out, 'property="og:image"'), 'https://cdn.example.test/shivling.jpg');
    assert.strictEqual(metaContent(out, 'name="twitter:image"'), 'https://cdn.example.test/shivling.jpg');
    assert.strictEqual(metaContent(out, 'name="twitter:card"'), 'summary_large_image');
  });

  test('a product with no image does NOT claim a large-image card', () => {
    const noImage = gen.renderProductPage(source, Object.assign({}, PRODUCT, { image_url: null }));
    assert.deepStrictEqual(noImage.missed, []);
    assert.strictEqual(metaContent(noImage.html, 'property="og:image"'), null,
      'og:image was emitted with no image to point at — a broken preview image is worse than none');
    assert.strictEqual(metaContent(noImage.html, 'name="twitter:card"'), 'summary');
  });

  test('quotes and ampersands in a product name cannot break out of an attribute', () => {
    const ogTitle = metaContent(out, 'property="og:title"');
    assert.ok(ogTitle.indexOf('"') === -1, 'a raw double quote in og:title ends the attribute early');
    assert.ok(/&quot;/.test(ogTitle), 'the quote should be escaped, not stripped');
    assert.ok(/&amp;/.test(ogTitle), 'the ampersand should be escaped');
    // The malicious case: a name that tries to close the tag and open a script.
    const evil = gen.renderProductPage(source, Object.assign({}, PRODUCT, {
      name: 'X"><script>alert(1)</script>'
    }));
    const ogEvil = metaContent(evil.html, 'property="og:title"');
    assert.ok(ogEvil.indexOf('<script') === -1 && ogEvil.indexOf('">') === -1,
      'a product name was able to escape the meta attribute');
  });

  test('the JSON-LD island is valid JSON and describes this product', () => {
    const m = out.match(/<script type="application\/ld\+json" id="ldPage">([\s\S]*?)<\/script>/);
    assert.ok(m, 'the per-page JSON-LD island is missing or was not filled');
    let data;
    assert.doesNotThrow(() => { data = JSON.parse(m[1]); }, 'the JSON-LD island is not valid JSON');
    assert.strictEqual(data['@type'], 'Product');
    assert.strictEqual(data.sku, 'CS-LNG-001');
    assert.strictEqual(data.offers.price, '2499.00', 'price must be rupees, not paise');
    assert.strictEqual(data.offers.priceCurrency, 'INR');
    assert.strictEqual(data.category, 'Sphatik Lingams');
    assert.ok(data.description.length > 0, 'BUG: the JSON-LD description used to always be empty');
  });

  test('BIZ-04 — availability reflects real stock, and a rating is only claimed when reviews exist', () => {
    const inStock = gen.productJsonLd(PRODUCT);
    assert.strictEqual(inStock.offers.availability, 'https://schema.org/InStock');
    assert.ok(inStock.aggregateRating, '18 real reviews should produce an aggregateRating');
    assert.strictEqual(inStock.aggregateRating.reviewCount, 18);

    const soldOut = gen.productJsonLd(Object.assign({}, PRODUCT, { stock_qty: 0 }));
    assert.strictEqual(soldOut.offers.availability, 'https://schema.org/OutOfStock',
      'BUG: an out-of-stock product was advertised to Google as InStock');

    const unrated = gen.productJsonLd(Object.assign({}, PRODUCT, { review_count: 0, rating: null }));
    assert.strictEqual(unrated.aggregateRating, undefined,
      'publishing a rating for a product with no reviews is the fabricated rating BIZ-04 removed');
  });

  test('a closing script tag inside product copy cannot truncate the page', () => {
    // The failure scripts/check-syntax.js exists to catch, arriving from the
    // database instead of from a source edit.
    const nasty = gen.renderProductPage(source, Object.assign({}, PRODUCT, {
      short_desc: 'Ends the block: </script><script>alert(1)</script>'
    }));
    assert.deepStrictEqual(nasty.missed, []);
    const payload = nasty.html.match(/window\.__PRERENDER__ = \{ product: ([\s\S]*?) \};/);
    assert.ok(payload, 'the inline product payload is missing');
    assert.ok(payload[1].indexOf('</script>') === -1,
      'a raw </script> reached the inline payload and would truncate the document');
    assert.doesNotThrow(() => JSON.parse(payload[1]), 'the inline payload is not valid JSON');
  });

  test('the inline payload is the real product row, so the page renders before catalog.json', () => {
    const payload = out.match(/window\.__PRERENDER__ = \{ product: ([\s\S]*?) \};/);
    const row = JSON.parse(payload[1]);
    assert.strictEqual(row.slug, PRODUCT.slug);
    assert.strictEqual(row.price_paise, PRODUCT.price_paise);
    assert.strictEqual(row.stock_qty, PRODUCT.stock_qty);
  });

  test('index.html knows how to consume that payload', () => {
    const html = read('index.html');
    assert.match(html, /window\.__PRERENDER__/,
      'the storefront never reads __PRERENDER__, so the inline payload is dead weight');
    assert.match(html, /function seedPrerenderedProduct/);
    assert.match(html, /seedPrerenderedProduct\(\);[\s\S]{0,200}readBootSnapshot/,
      'the inline product must be seeded BEFORE the snapshot is awaited, or a prerendered page still waits on the CDN');
  });

  test('the page still boots as the full storefront — the app script survives the rewrite', () => {
    const originalScripts = inlineScriptBodies(source).length;
    const rewrittenScripts = inlineScriptBodies(out).length;
    assert.strictEqual(rewrittenScripts, originalScripts,
      'the rewrite changed how many inline script blocks exist — something was truncated');
    assert.ok(out.length > source.length - 2000,
      'the rewritten page is dramatically shorter than the source; content was lost');
    assert.match(out, /document\.addEventListener\('DOMContentLoaded', init\)/,
      'the SPA boot hook is gone, so the prerendered page would never become interactive');
  });

  test("the generator's category labels match the storefront's, so a crumb and a rich result agree", () => {
    const html = read('index.html');
    const m = html.match(/const CAT_LABELS = \{([^}]*)\}/);
    assert.ok(m, 'CAT_LABELS not found in index.html');
    const inPage = {};
    for (const pair of m[1].split(',')) {
      const kv = pair.match(/\s*(\w+)\s*:\s*'([^']*)'/);
      if (kv) inPage[kv[1]] = kv[2];
    }
    assert.deepStrictEqual(gen.CAT_LABELS, inPage,
      'scripts/generate-product-pages.js and index.html disagree about category labels');
  });

  test('_redirects lets a real prerendered file win over the SPA catch-all', () => {
    const redirects = read('_redirects');
    const catchAll = redirects.split('\n').findIndex((l) => /^\/\*\s+\/index\.html\s+200/.test(l.trim()));
    assert.ok(catchAll > -1, 'the SPA catch-all is missing');
    assert.ok(!/^\/\*\s+\/index\.html\s+200!/m.test(redirects),
      'the catch-all is FORCED (200!), which would shadow every prerendered product page');
  });
}

// ============================================================
section('[fe-14] A visitor is never shown data that is not real');
// ============================================================
// The storefront runs on infrastructure that sleeps. Everything here guards the
// same rule: when we cannot say what is true, say nothing — never invent it.
{
  const html = read('index.html');

  test('THE FINDING: the demo catalog is gone — a sleeping API can no longer produce a shop full of products that do not exist', () => {
    assert.ok(!/Natural Sphatik Shivling – 2 Inch/.test(html),
      'the seeded demo product is still in the file and can still reach a customer');
    assert.ok(!/id:'lin-01'/.test(html) && !/id:'mal-01'/.test(html) && !/id:'bok-01'/.test(html),
      'demo product objects are still defined');
    assert.match(html, /let PRODUCTS = \[\];/,
      'PRODUCTS must start empty so nothing can render before a real source answers');
  });

  test('the mega-menu no longer links to product ids that exist in no catalog', () => {
    assert.ok(!/onclick="openProduct\('(lin|mal|idl|yan|bra|bok)-\d+'\)/.test(html),
      'a hardcoded demo product link is still present — it 404s against a real catalog');
    assert.match(html, /id="megaPicks"/, 'the picks column should be filled from the real catalog');
    assert.match(html, /function renderMegaMenuPicks/);
  });

  test('a total failure produces an honest message and a retry, not fabricated stock', () => {
    assert.match(html, /catalogSource = 'unavailable'/,
      'there must be a terminal state distinct from "loading" and from "empty result"');
    assert.match(html, /We could not load the collection/,
      'the failure state needs its own wording — "No products found" describes a different problem');
    assert.match(html, /function retryCatalogLoad/, 'the retry button must actually retry');
  });

  test('the loading state can never become permanent', () => {
    assert.match(html, /setTimeout\(hideAwakeningScreen, AWAKEN_MAX_MS\)/,
      'the awakening screen needs an unconditional ceiling, or a failed boot traps the visitor behind it');
    assert.match(html, /addEventListener\('error', function\(\)\{ hideAwakeningScreen\(\); \}\)/);
    assert.match(html, /addEventListener\('unhandledrejection', function\(\)\{ hideAwakeningScreen\(\); \}\)/,
      'init() is async, so a throw inside it is a REJECTION and fires no error event — without this listener a dead boot sits behind a full-screen overlay');
    assert.match(html, /catalogSource = 'unavailable';/,
      'loadCatalog must always resolve catalogSource, or the skeletons pulse forever');
  });
}

// ============================================================
section('[fe-15] The cart survives a sleeping backend');
// ============================================================
// A cart line stored only { id, qty }, so every name and price came from a live
// PRODUCTS lookup. While the catalog was unavailable the lines were filtered
// out: the badge said 3 and the drawer said "Your cart is empty", and the
// checkout quoted a total that excluded them.
{
  const html = read('index.html');

  test('THE FINDING: a cart line carries what it needs to describe itself', () => {
    assert.match(html, /function cartLineSnapshot/);
    assert.match(html, /function productFromCartLine/);
    assert.match(html, /snap: cartLineSnapshot\(p\)/,
      'a new cart line must record its own name and price at the moment it is added');
  });

  test('an unresolvable product falls back to the line snapshot instead of vanishing', () => {
    assert.match(html, /getProduct\(l\.id\) \|\| productFromCartLine\(l\)/,
      'getCartLinesWithProducts still drops any line the live catalog cannot resolve');
  });

  test('carts saved before snapshots existed are healed once a catalog arrives', () => {
    assert.match(html, /function backfillCartSnapshots/);
    assert.match(html, /backfillCartSnapshots\(\);[\s\S]{0,400}renderFeaturedGrid\(\)/,
      'the backfill must run before the views that read those lines are re-rendered');
  });

  test('THE MONEY GUARD: checkout refuses to quote a total it cannot vouch for', () => {
    assert.match(html, /function cartHasUnresolvedLines/);
    // placeOrder is now the waiting-experience wrapper; placeOrderNow is what
    // actually takes the money, so that is where the guard has to be.
    const start = html.indexOf('async function placeOrderNow');
    assert.ok(start > -1, 'placeOrderNow is missing');
    const body = html.slice(start, start + 6000);
    assert.match(body, /if\(cartHasUnresolvedLines\(\)\)/,
      'placeOrderNow must not proceed while a line is missing from the displayed total');
    const guardAt = body.indexOf('cartHasUnresolvedLines()');
    const payAt = body.indexOf('checkoutProcessing');
    assert.ok(payAt > -1, 'could not find the payment UI switch inside placeOrderNow');
    assert.ok(guardAt > -1 && guardAt < payAt,
      'the guard must run BEFORE the payment UI is shown, not after');
  });

  test('the client still never sends prices — the server remains the only source of an amount', () => {
    assert.match(html, /\{ productId: l\.id, variantId: l\.variantId \|\| null, quantity: l\.qty \}/,
      'the order payload must carry ids and quantities only');
    const payload = html.match(/const items = cart\.map\(function\(l\)\{[\s\S]{0,200}?\}\);/);
    assert.ok(payload, 'could not find the order items payload');
    assert.ok(!/price|amount|total|snap/i.test(payload[0]),
      'a price reached the order payload — the server must compute every amount itself');
  });
}

// ============================================================
section('[fe-16] Waking both sleeping services, and not disrupting the visitor');
// ============================================================
{
  const html = read('index.html');

  test('THE FINDING: the database is woken too, not just the web process', () => {
    assert.match(html, /knock\('\/api\/health'\)/,
      'the liveness knock is missing — it is the earliest signal the server is back');
    assert.match(html, /knock\('\/api\/ready'\)/,
      'nothing wakes Neon: /api/health touches no database, so the compute only starts resuming when the first real query lands, and the visitor pays both cold starts in series');
  });

  test('both knocks are sent from the <head>, before the app script parses', () => {
    const headEnd = html.indexOf('</head>');
    assert.ok(html.indexOf("knock('/api/health')") < headEnd && html.indexOf("knock('/api/ready')") < headEnd,
      'the wake-up calls moved out of the head — that costs ~1.5s of the cold start');
  });

  test('a cache-busting reload cannot yank the page out from under someone mid-visit', () => {
    assert.match(html, /function hasUserInteracted/);
    assert.match(html, /!hasUserInteracted\(\)/,
      'checkSiteVersion resolves 30-60s into a cold visit; reloading then would discard the scroll position, an open drawer, or a half-filled address form');
  });

  test('the awakening screen is in the markup, so it paints before the app exists', () => {
    const bodyAt = html.indexOf('<body>');
    const screenAt = html.indexOf('id="awakenScreen"');
    const scriptAt = html.indexOf('const API_BASE');
    assert.ok(screenAt > bodyAt && screenAt < scriptAt,
      'a loading screen rendered by the app it is covering for is no loading screen at all');
    assert.match(html, /prefers-reduced-motion:reduce\)\{\s*#awakenScreen/,
      'a full-viewport animation with no reduced-motion escape is an accessibility failure');
  });
}

// ============================================================
section('[fe-17] Actions taken while the backend is asleep are not lost');
// ============================================================
{
  const html = read('index.html');

  test('THE FINDING: engagement actions are queued instead of failing', () => {
    assert.match(html, /function queuedPost/);
    assert.match(html, /const OUTBOX_ROUTES = \{/);
    for (const p of ['/api/engage/stock-notify', '/api/engage/newsletter', '/api/engage/contact']) {
      assert.ok(html.indexOf("queuedPost('" + p + "'") > -1,
        p + ' still posts directly, so a cold instance turns it into a dead end');
    }
  });

  test('THE SAFETY RULE: money and identity can never be queued', () => {
    const block = html.slice(html.indexOf('const OUTBOX_ROUTES = {'), html.indexOf('function readOutbox'));
    for (const forbidden of ['payments', 'orders', 'bookings', 'auth', 'checkout']) {
      assert.ok(block.indexOf(forbidden) === -1,
        'the outbox allowlist names "' + forbidden + '" — telling someone a payment or booking succeeded before it did is worse than any wait');
    }
    assert.match(html, /queuedPost called for a path that is not queueable/,
      'queuedPost must refuse an unlisted path outright, so a future call site cannot make a payment fire-and-forget');
  });

  test('a request the server actually REFUSED is not replayed forever', () => {
    assert.match(html, /function isTransportFailure/);
    assert.match(html, /if\(!isTransportFailure\(err\)\) throw err;/,
      'a 4xx must surface to the customer, not be queued — queueing a rejection just replays the rejection');
  });

  test('the non-idempotent endpoint cannot open duplicate support tickets', () => {
    // stock-notify and newsletter are ON CONFLICT upserts server-side; contact
    // is a plain INSERT (see engagement.routes.js), so it needs a dispatch cap.
    assert.match(html, /idempotent: false/, 'contact must be marked non-idempotent');
    assert.match(html, /!route\.idempotent && item\.dispatched >= 2/,
      'a non-idempotent queued item must stop being retried and be handed back to the customer');
  });

  test('the queue is bounded in size and age', () => {
    assert.match(html, /OUTBOX_MAX_ITEMS/);
    assert.match(html, /OUTBOX_MAX_AGE_MS/);
    assert.match(html, /i\.at > cutoff/,
      'a restock alert requested a month ago should not be delivered silently now');
  });

  test('the queue drains on every free opportunity, and probes only when it has something to send', () => {
    assert.match(html, /visibilitychange[\s\S]{0,160}outboxCount\(\)/);
    assert.match(html, /addEventListener\('online'[\s\S]{0,120}outboxCount\(\)/);
    assert.match(html, /if\(outboxCount\(\)\) scheduleOutboxFlush/,
      'flushing must be gated on the queue being non-empty, or every visitor pays for a probe they do not need');
  });
}

// ============================================================
section('[fe-18] The wait before a payment is spent well, and never loses the intent');
// ============================================================
{
  const html = read('index.html');

  test('readiness is re-checked, not answered once at page load', () => {
    assert.match(html, /function isBackendKnownAwake/);
    assert.match(html, /BACKEND_READY_TTL_MS/,
      'a cached "awake" must expire — Render sleeps after ~15 min and Neon after ~5, so a session that started warm can go cold mid-visit');
    assert.match(html, /\/api\/ready/, 'the probe must be /api/ready, which reports on the database too');
  });

  test('THE FINDING: checkout and both bookings wait for a confirmed backend', () => {
    assert.match(html, /return withBackendReady\(placeOrderNow/);
    assert.match(html, /return withBackendReady\(confirmPujaBookingNow/);
    assert.match(html, /return withBackendReady\(confirmAstroBookingNow/);
  });

  test('an already-awake backend adds no delay at all', () => {
    // The fast path lives in runWithBackendReady; withBackendReady is now the
    // re-entrancy guard that wraps it.
    const fn = html.slice(html.indexOf('async function runWithBackendReady'), html.indexOf('async function runWithBackendReady') + 900);
    assert.match(fn, /if\(isBackendKnownAwake\(\)\) return intent\(\);/,
      'the fast path must return before anything is rendered');
    const openAt = fn.indexOf('openWaitingExperience');
    const fastAt = fn.indexOf('isBackendKnownAwake');
    assert.ok(fastAt > -1 && fastAt < openAt, 'the waiting screen must not be reachable when the backend is already up');
  });

  test('THE RULE THAT MATTERS: the cart is read when the order runs, not when it was requested', () => {
    const now = html.slice(html.indexOf('async function placeOrderNow'), html.indexOf('async function placeOrderNow') + 1600);
    assert.match(now, /const items = cart\.map/,
      'items must be built inside placeOrderNow, or anything added from the waiting screen is silently dropped from the order');
  });

  test('cancelling actually cancels — it does not hide the box and fire the order later', () => {
    assert.match(html, /function cancelWaitingExperience/);
    assert.match(html, /waitState\.cancelled = true/);
    assert.match(html, /if\(waitState\.cancelled\)\{ closeWaitingExperience\(\); return undefined; \}/);
    assert.match(html, /if\(waitState\.open\)\{ cancelWaitingExperience\(\); return; \}/,
      'Escape must route through cancel, not closeModal, or the pending intent survives with nothing on screen');
  });

  test('suggestions are varied, and never invented', () => {
    assert.match(html, /const WAIT_STRATEGIES = \[/);
    const ids = html.match(/^\s*id: '([a-z-]+)',$/gm) || [];
    assert.ok(ids.length >= 5, 'expected several distinct suggestion strategies, found ' + ids.length);
    assert.match(html, /waitSeenStrategies\(\)/, 'shown strategies must be tracked so the same one does not simply reappear');
    assert.match(html, /seen\.indexOf\(b\.id\) === -1/);
    // Everything offered must come from the real catalog.
    const strat = html.slice(html.indexOf('const WAIT_STRATEGIES = ['), html.indexOf('function pickWaitStrategy'));
    assert.ok(strat.indexOf('PRODUCTS.filter') > -1, 'suggested products must come from the real catalog');
    assert.ok(!/price: *[0-9]/.test(strat), 'a hardcoded price appears in the suggestion strategies — nothing shown may be invented');
  });

  test('a suggested item can be added with the server still cold', () => {
    assert.match(html, /function waitAddSuggestion/);
    const fn = html.slice(html.indexOf('function waitAddSuggestion'), html.indexOf('function waitAddSuggestion') + 700);
    assert.match(fn, /addToCart\(/, 'adding from the waiting screen must be the ordinary local cart write');
    assert.ok(!/apiFetch|fetch\(/.test(fn), 'adding a suggestion must not need the network — that is the whole point');
  });

  test('the wait is bounded and fails honestly', () => {
    assert.match(html, /WAIT_MAX_MS/);
    assert.match(html, /Nothing has been charged and your cart is saved/,
      'a timeout must say plainly that no money moved');
  });
}

// ============================================================
section('[fe-19] Regressions found in the final audit — locked shut');
// ============================================================
// Four defects introduced while building the outbox and the waiting screen,
// each caught by re-reading the code rather than by a failing test. These are
// the tests that would have caught them.
{
  const html = read('index.html');

  test('THE DUPLICATE-CHARGE BUG: only one money action can be in flight', () => {
    assert.match(html, /let intentInFlight = false;/,
      'nothing stops a second tap on Place Order during the wait — that is two orders and two charges');
    const fn = html.slice(html.indexOf('async function withBackendReady'), html.indexOf('async function runWithBackendReady'));
    assert.match(fn, /if\(intentInFlight\)\{/, 'the guard must be checked before anything else happens');
    assert.match(fn, /intentInFlight = true;/);
    assert.match(fn, /finally \{[\s\S]{0,200}intentInFlight = false;/,
      'the guard must be released in a finally, or one thrown intent locks checkout for the rest of the session');
  });

  test('the Place Order button is disabled while its action is pending', () => {
    assert.match(html, /id="placeOrderBtn"/, 'the button needs an id so it can be disabled');
    assert.match(html, /busyButton: '#placeOrderBtn'/);
    assert.match(html, /if\(busyBtn\)\{ busyBtn\.disabled = false;/,
      're-enabling must also be in the finally, or a failed attempt leaves checkout permanently dead');
  });

  test('THE INSTANT-QUEUE BUG: a queued action must not wait on a sleeping server first', () => {
    const fn = html.slice(html.indexOf('async function queuedPost'), html.indexOf('function isTransportFailure'));
    assert.ok(!/opts\.tryLiveFirst !== false/.test(fn),
      'the old condition is back: undefined !== false is true, so every queued action attempts a live POST against a sleeping instance and blocks for the full apiFetch timeout');
    assert.match(fn, /isBackendKnownAwake\(\) \|\| opts\.tryLiveFirst === true/,
      'live delivery must be attempted only when the backend is known up, or explicitly requested');
  });

  test('leaving the page cancels a pending payment rather than firing it later', () => {
    const fn = html.slice(html.indexOf("addEventListener('popstate'"), html.indexOf("addEventListener('popstate'") + 700);
    assert.match(fn, /waitState && waitState\.open\) cancelWaitingExperience\(\)/,
      'browser-back leaves the modal open and the intent live — it would place an order from a screen the customer had already left');
  });

  test('the suggestion rotation timer cannot be orphaned', () => {
    const fn = html.slice(html.indexOf('function openWaitingExperience'), html.indexOf('function openWaitingExperience') + 700);
    assert.match(fn, /if\(waitState\.rotateTimer\)\{ clearInterval/,
      'reopening without clearing abandons the previous interval, which keeps re-rendering into a modal nobody is looking at');
  });

  test('the outbox flush lock is claimed before the probe it awaits', () => {
    const fn = html.slice(html.indexOf('async function flushOutbox'), html.indexOf('async function flushOutbox') + 900);
    const lockAt = fn.indexOf('outboxFlushing = true');
    const probeAt = fn.indexOf('await probeBackend()');
    assert.ok(lockAt > -1 && probeAt > -1 && lockAt < probeAt,
      'the probe awaits, so two callers arriving together would both pass an unclaimed lock and deliver the same items twice');
  });

  test('the related rail never asks a customer to clear filters that do not exist', () => {
    const fn = html.slice(html.indexOf('function renderRelatedProducts'), html.indexOf('function renderRelatedProducts') + 2200);
    assert.ok(fn.indexOf("renderGridInto('relatedGrid', related)") > -1, 'renderRelatedProducts is missing');
    // Passing an empty list straight through renders the SHOP grid's empty
    // state -- "No products found / Try adjusting your filters / Clear Filters"
    // -- inside a product page, where there are no filters at all.
    assert.match(fn, /if\(!related\.length\)\{/,
      'an empty related list must hide the section, not render the shop empty state into it');
    assert.match(fn, /section\.style\.display = 'none'/);
    assert.match(fn, /related = related\.concat\(fill\)/,
      'a category with no siblings should top the rail up from the rest of the catalog rather than showing nothing');
    assert.match(fn, /sameCat\.length \? 'Related Products' : 'More From Chakrashri'/,
      'products topped up from other categories must not be labelled "Related"');
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
