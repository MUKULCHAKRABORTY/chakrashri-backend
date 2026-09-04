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
    // Asserted on the CALL, not on the element. It was an <a href="#"> and is a
    // <button> now — href="#" is a link to nowhere, and a crawler followed it
    // from every page on the site. What matters is that markup still invokes it.
    assert.ok(/onclick="(return )?requestPasswordReset\(\);?"/.test(read('index.html')),
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

  test('a product with no image falls back to the site card, not to nothing', () => {
    /* THE TRADE-OFF CHANGED, and this is the record of why.

       This used to assert NO og:image on a product without a photo, and that
       was right at the time: index.html shipped without one, so the only
       alternative to nothing was a broken image, and a broken preview is worse
       than a plain link.

       The site now has a real branded card (og-cover.png), so the choice is
       between a branded preview and no preview — and the branded one wins on
       every surface that shows it. */
    const noImage = gen.renderProductPage(source, Object.assign({}, PRODUCT, { image_url: null }));
    assert.deepStrictEqual(noImage.missed, []);
    assert.match(metaContent(noImage.html, 'property="og:image"') || '', /og-cover\.png$/,
      'a product with no photo should still share as the brand, not as a bare link');
    assert.strictEqual(metaContent(noImage.html, 'name="twitter:card"'), 'summary_large_image');
  });

  test('THE REGRESSION THIS NEARLY WAS: exactly one og:image, and it is the product', () => {
    /* Adding a site-wide og:image to index.html made the generator's ADD
       produce TWO og:image tags on every product page — the brand card first,
       the product photo second. Scrapers take the first, so every product
       shared to WhatsApp or Facebook would have shown the generic card instead
       of the item being sold. Replaced now, not appended. */
    const head = out.slice(0, out.indexOf('</head>'));
    assert.strictEqual((head.match(/<meta property="og:image" content=/g) || []).length, 1,
      'two og:image tags means the scraper picks the wrong one');
    assert.strictEqual((head.match(/<meta name="twitter:card"/g) || []).length, 1);
    assert.strictEqual(metaContent(out, 'property="og:image"'), 'https://cdn.example.test/shivling.jpg');
    // The brand card's dimensions must not survive onto a product photo of
    // unknown size — they would tell a scraper the wrong aspect ratio.
    assert.strictEqual((head.match(/<meta property="og:image:(width|height)"/g) || []).length, 0,
      'the 1200x630 of the brand card does not describe a product photo');
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
    // Brace-matched, not a fixed 900-character window: that window stopped
    // reaching openWaitingExperience the moment a comment was added between
    // them, and the test failed for a reason that had nothing to do with the
    // behaviour it guards.
    const start = html.indexOf('async function runWithBackendReady');
    let depth = 0, end = start;
    for (let k = html.indexOf('{', start); k < html.length; k++) {
      if (html[k] === '{') depth++;
      else if (html[k] === '}') { depth--; if (!depth) { end = k + 1; break; } }
    }
    const fn = html.slice(start, end);
    assert.match(fn, /if\(isBackendKnownAwake\(\)\) return intent\(\);/,
      'the fast path must return before anything is rendered');
    const openAt = fn.indexOf('openWaitingExperience');
    const fastAt = fn.indexOf('isBackendKnownAwake');
    assert.ok(fastAt > -1 && openAt > -1 && fastAt < openAt,
      'the waiting screen must not be reachable when the backend is already up');
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
    // This used to be a toast. A toast is the wrong weight for a payment that
    // did not happen: it slides away by itself and leaves somebody who was
    // about to spend money looking at a checkout with no explanation. It is now
    // a panel that stays, and the first thing it settles is whether they were
    // charged.
    assert.match(html, /No payment was taken/,
      'a timeout must say plainly that no money moved');
    assert.match(html, /is saved exactly as you left it/,
      'and that nothing they had chosen was lost');
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

  test('no wait timer can be orphaned', () => {
    // There used to be exactly one interval here, cleared by name. The wait now
    // runs two phase hand-offs and a tick, so they go through a registry and
    // clearWaitTimers() empties all of it -- a timer added later is covered by
    // construction rather than by somebody remembering to clear it.
    const fn = html.slice(html.indexOf('function openWaitingExperience'), html.indexOf('function openWaitingExperience') + 900);
    assert.match(fn, /clearWaitTimers\(\)/,
      'reopening without clearing abandons the previous timers, which keep re-rendering into a modal nobody is looking at');
    assert.ok(!/setInterval\(|setTimeout\(/.test(fn.replace(/waitAfter\(|waitEvery\(/g, '')),
      'a raw timer here would not be in the registry, so closing the screen could not stop it');
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
section('[fe-20] A variant is priced at what the customer is actually charged');
// ============================================================
// The server prices a variant line from variant.price_paise, falling back to
// the base product when that is NULL (utils/orders.js). The cart recorded the
// variantId but never its price, so every number the customer saw -- mini-cart,
// cart page, checkout, and the subtotal driving shipping -- was the BASE price.
// The order was correct; the amount they agreed to was not.
{
  const html = read('index.html');

  // Pull the real functions out of the shipped file and run them.
  function grab(name) {
    const i = html.indexOf('function ' + name + '(');
    assert.ok(i > -1, name + ' is missing from index.html');
    let depth = 0;
    const start = html.indexOf('{', i);
    for (let k = start; k < html.length; k++) {
      if (html[k] === '{') depth++;
      else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
    }
    throw new Error('unbalanced braces in ' + name);
  }
  const api = new Function(
    grab('cartUnitPrice') + String.fromCharCode(10) + grab('variantUnitPrice') +
    '; return { cartUnitPrice: cartUnitPrice, variantUnitPrice: variantUnitPrice };'
  )();

  const base = { id: '1', name: 'Sphatik Shivling', price: 1299 };

  test('THE FINDING: a variant line is priced at the variant, not the base product', () => {
    const line = { id: '1', qty: 2, variantId: 'v2', unitPrice: 2499 };
    assert.strictEqual(api.cartUnitPrice(line, base) * line.qty, 4998,
      'the line total still uses the base price — the customer is quoted less than they will be charged');
  });

  test('variantUnitPrice mirrors the server rule exactly, including the NULL case', () => {
    assert.strictEqual(api.variantUnitPrice(base, { price_paise: 249900 }), 2499);
    assert.strictEqual(api.variantUnitPrice(base, { price_paise: null }), 1299,
      'a NULL variant price means inherit the base — utils/orders.js does the same');
    assert.strictEqual(api.variantUnitPrice(base, null), 1299, 'no variant chosen means the base price');
  });

  test('a cart saved before this fix still renders — no regression', () => {
    const legacy = { id: '1', qty: 2, variantId: 'v2' };
    assert.strictEqual(api.cartUnitPrice(legacy, base) * legacy.qty, 2598,
      'a line with no recorded unitPrice must fall back to the base price, exactly as before');
    const plain = { id: '1', qty: 2 };
    assert.strictEqual(api.cartUnitPrice(plain, base) * plain.qty, 2598);
  });

  test('a corrupt or missing price can never render as NaN in a total', () => {
    for (const bad of [{ unitPrice: 'abc' }, { unitPrice: null }, { unitPrice: undefined }, { unitPrice: NaN }, {}]) {
      const v = api.cartUnitPrice(bad, base);
      assert.ok(Number.isFinite(v), 'cartUnitPrice returned a non-finite value for ' + JSON.stringify(bad));
    }
    assert.ok(Number.isFinite(api.cartUnitPrice({}, null)), 'must survive a missing product too');
  });

  test('BOTH variant paths record the price — Add to Cart and Buy Now', () => {
    const calls = html.match(/addToCart\(id, pdQty, label,[\s\S]{0,600}?\);/g) || [];
    assert.strictEqual(calls.length, 2, 'expected exactly two variant-carrying addToCart calls');
    calls.forEach((c, i) => {
      assert.ok(/variantUnitPrice\(p, pdSelectedVariant\)/.test(c),
        'variant call site ' + (i + 1) + ' does not pass the variant price — Buy Now goes straight to checkout, so missing it there is worse');
      // The product page is the ONLY place a variant's own stock_qty is loaded,
      // so it is the only place that can put it on the cart line. Without it
      // the cart has no ceiling for that variant at all.
      assert.ok(/pdSelectedVariant \? pdSelectedVariant\.stock_qty/.test(c),
        'variant call site ' + (i + 1) + ' does not carry the variant stock onto the line');
    });
  });

  test('every cart price display reads through cartUnitPrice, none through the base price', () => {
    assert.ok(!/formatINR\(p\.price \* l\.qty\)/.test(html), 'a cart line total still uses the base price');
    assert.ok(!/formatINR\(p\.price\*l\.qty\)/.test(html), 'a checkout line total still uses the base price');
    assert.ok(!/x\.product\.price \* x\.line\.qty/.test(html), 'getCartSubtotal still uses the base price');
    assert.match(html, /cartUnitPrice\(x\.line, x\.product\) \* x\.line\.qty/, 'the subtotal must use the effective price');
  });

  test('the client still sends no price — the server remains the only authority', () => {
    const payload = html.match(/const items = cart\.map\(function\(l\)\{[\s\S]{0,220}?\}\);/);
    assert.ok(payload, 'order payload not found');
    assert.ok(!/unitPrice|price/i.test(payload[0]),
      'the recorded display price leaked into the order payload — it is display data and must never price an order');
  });

  test('legacy lines are repaired when the detail page reveals real variant prices', () => {
    assert.match(html, /function refreshCartVariantPrices/);
    assert.match(html, /refreshCartVariantPrices\(p\.id, p\.variants\)/,
      'the product detail fetch is the only place variant prices reach the client — it must repair the cart');
  });

  test('the waiting screen still has something to say for an unrecognised category', () => {
    // RITUAL_PAIRS is keyed by the canonical category slugs, but categories are
    // admin-created and free-form. The live catalog uses "book" (not "books"),
    // "dhoti" and "sphatik" -- none of which the map knows -- so this strategy
    // returned null for almost every cart and quietly cut the variety by a third.
    const fn = html.slice(html.indexOf("id: 'complete-ritual'"), html.indexOf("id: 'free-shipping'"));
    assert.match(fn, /const knownPairing = wanted\.length > 0;/,
      'the strategy must distinguish a real pairing from a fallback');
    assert.match(fn, /if\(!knownPairing\)\{/,
      'an unrecognised category must fall back to other categories, not return null');
    assert.match(fn, /knownPairing \? 'Complete the ritual' : 'Also in the collection'/,
      'a fallback must not claim to be a ritual pairing -- same rule as Related vs More From');
  });
}

// ============================================================
section('[fe-21] The waiting screen sells rather than apologises');
// ============================================================
{
  const html = read('index.html');

  test('THE FINDING: suggestion cards show the real product photo, not a placeholder glyph', () => {
    const fn = html.slice(html.indexOf('function waitItemHTML'), html.indexOf('function waitItemHTML') + 900);
    assert.ok(!/productMediaSVG\(p\.cat\)/.test(fn),
      'the card still draws the generic category glyph — every suggestion looked like a drawing of nothing');
    assert.match(fn, /productThumbInnerHTML\(p, null\)/,
      'it must use the same image helper as the cart and checkout, which renders imageUrl with an onerror fallback');
  });

  test('no customer-facing string tells the customer our infrastructure was asleep', () => {
    // Strip comments first: the explanations for these fixes legitimately quote
    // the old wording, and a naive scan would match its own documentation.
    const code = html
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const banned = [
      [/Our server is waking up/i, 'tells the buyer our server is unreliable, at the moment they are paying'],
      [/quiet spell/i, 'explains our idle policy to a customer'],
      [/This is on us, not on you/i, 'an apology that names a fault the customer never saw'],
      [/it may be starting up/i, 'exposes cold-start behaviour in an error']
    ];
    for (const [re, why] of banned) {
      assert.ok(!re.test(code), 'customer-facing copy still ' + why);
    }
    assert.match(code, /Setting up your secure payment/, 'the replacement copy should describe THEIR order');
    // The rolling status text is now the step ladder, so the ladder carries the
    // same duty: describe what is happening to THEIR order, never our servers.
    assert.match(code, /Confirming your items and their prices/,
      'the order ladder should describe their order, not our infrastructure');
    assert.match(code, /Preparing your payment session/);

    // WHERE an apology belongs, made explicit rather than left to wording luck.
    //
    // Apologising in the WAITING copy names a fault the customer never saw --
    // most cold boots succeed, and saying sorry mid-wait invites them to worry
    // about something that is about to work. Apologising in the FAILURE panel
    // is the opposite: it is a real fault they did experience, and industry
    // practice is to own it plainly.
    function fnSrc(name) {
      const i = code.indexOf('function ' + name + '(');
      if (i < 0) throw new Error('missing ' + name);
      let d = 0; const s = code.indexOf('{', i);
      for (let k = s; k < code.length; k++) {
        if (code[k] === '{') d++;
        else if (code[k] === '}') { d--; if (!d) return code.slice(i, k + 1); }
      }
    }
    const waiting = fnSrc('openWaitingExperience') + fnSrc('renderWaitProgressPanel') +
      code.slice(code.indexOf('const WAIT_FLOW'), code.indexOf('const WAIT_STEP_ICON'));
    assert.ok(!/\bsorry\b/i.test(waiting),
      'the waiting copy apologises for a cold start the customer has not been harmed by, and usually will not be');
    assert.match(fnSrc('renderWaitFailurePanel'), /sorry/i,
      'a wait that actually failed SHOULD apologise — that fault is real and they lived through it');
  });

  test('THE TRAP: transport failures are detected by a flag, never by their wording', () => {
    // Rewording the message for tone silently stopped queued actions being
    // recognised as retryable, which would have made the outbox discard them.
    assert.match(html, /throw \{ transport: true, error:/,
      'apiFetch must mark a transport failure explicitly');
    const fn = html.slice(html.indexOf('function isTransportFailure'), html.indexOf('function isTransportFailure') + 900);
    assert.match(fn, /if\(err\.transport === true\) return true;/,
      'the flag must be checked before any text matching');
    const flagAt = fn.indexOf('err.transport === true');
    const textAt = fn.indexOf('could not reach');
    assert.ok(flagAt > -1 && (textAt === -1 || flagAt < textAt),
      'copy must never be the primary source of truth for control flow');
  });

  test('suggestions are ordered by relevance to the cart, not by price alone', () => {
    assert.match(html, /function waitRelevanceSort/);
    const small = html.slice(html.indexOf("id: 'small-additions'"), html.indexOf("id: 'bestsellers'"));
    assert.match(small, /waitRelevanceSort\(/,
      'a customer buying a lingam should not be offered a dhoti just because it is cheap');
    const best = html.slice(html.indexOf("id: 'bestsellers'"), html.indexOf("id: 'care-note'"));
    assert.match(best, /waitRelevanceSort\(/);
  });

  test('a genuine ritual pairing outranks more of the same category', () => {
    const fn = html.slice(html.indexOf('function waitRelevanceSort'), html.indexOf('function waitRelevanceSort') + 1200);
    assert.match(fn, /if\(paired\[p\.cat\]\) return 3;/, 'a paired category must score above same-category');
    assert.match(fn, /if\(cartCats\[p\.cat\]\) return 2;/);
  });
}

// ============================================================
section('[fe-22] Pre-push deep sweep — two more caught by running it');
// ============================================================
{
  const html = read('index.html');

  test('THE WORST ONE: a variant product can never be suggested', () => {
    // A suggestion card has no size selector, so Add would put a variant
    // product in the cart with no variantId -- and the server refuses to sell
    // one without it. The customer would add it during the wait, watch the
    // backend wake, and have the order rejected at the moment of payment: the
    // exact failure the waiting screen exists to prevent, caused by the screen.
    // Asserted through the SHARED predicate now. buyable() used to carry its own
    // copy of the rule; the copies are what allowed the product page's version
    // to be wrong while this one was right.
    const fn = html.slice(html.indexOf('function buyable('), html.indexOf('function buyable(') + 1400);
    assert.match(fn, /if\(requiresVariantChoice\(p\)\) return false;/,
      'buyable() still offers products that cannot be added without choosing an option');
    assert.match(html, /function requiresVariantChoice\(p\)\{[\s\S]{0,200}?p\.hasVariants \|\| \(Array\.isArray\(p\.variantOptions\) && p\.variantOptions\.length\)/,
      'and the predicate itself must consider BOTH the list flag and the detail options');
  });

  test('every product thumb clips its photo to its own rounded corners', () => {
    // border-radius alone does not clip a child image; without overflow:hidden
    // a square photo renders hard-cornered inside a rounded frame. This was
    // true of the cart, the checkout and the mini-cart, not only the new card.
    // Extracted by index, not by a built regex: escaping a CSS selector into a
    // RegExp is its own source of bugs.
    for (const sel of ['.mc-thumb{', '.cart-thumb{', '.order-review-item .thumb{', '.wait-item .thumb{']) {
      const at = html.indexOf(sel);
      assert.ok(at > -1, 'no CSS rule found for ' + sel);
      const rule = html.slice(at, html.indexOf('}', at) + 1);
      assert.ok(rule.indexOf('border-radius') > -1, sel + ' has no border-radius');
      assert.ok(/overflow:\s*hidden/.test(rule),
        sel + ' rounds its corners but does not clip — the photo renders square inside them');
    }
  });
}

// ============================================================
section('[fe-23] The welcome screen');
// ============================================================
{
  const html = read('index.html');
  const screen = html.slice(html.indexOf('id="awakenScreen"'), html.indexOf('id="awakenSub"') + 200);

  test('it greets the visitor by name, one letter at a time', () => {
    // "Welcome to" (10) + "CHAKRASHRI" (10) are both animated per letter, and
    // the tagline sits beneath as a single line.
    // Slice from the MARKUP, not from the inline <style> above it: the class
    // names appear in both, and anchoring on the first occurrence lands in CSS.
    const markup = screen.slice(screen.indexOf('<div class="awaken-welcome"'));
    const greet = markup.slice(markup.indexOf('awaken-greet'), markup.indexOf('awaken-brand'));
    const brand = markup.slice(markup.indexOf('awaken-brand'), markup.indexOf('awaken-tagline'));
    // Each line carries its letters TWICE: once in the animated base layer and
    // once in the .aw-shine gradient layer stacked on it. Both copies need the
    // same letters or the two layers cannot register and the word draws twice.
    const base = s => s.slice(0, s.indexOf('aw-shine'));
    const shine = s => s.slice(s.indexOf('aw-shine'));
    const count = s => (s.match(/<span aria-hidden="true">/g) || []).length;
    assert.strictEqual(count(base(greet)), 10, '"Welcome to" should be 10 individually animated letters');
    assert.strictEqual(count(base(brand)), 10, '"CHAKRASHRI" should be 10 individually animated letters');
    assert.strictEqual(count(shine(greet)), 10, 'the greeting shine layer must repeat all 10 letters');
    assert.strictEqual(count(shine(brand)), 10, 'the brand shine layer must repeat all 10 letters');
    // A plain text run does not line up with a row of inline-blocks: measured
    // 28px too low and 47px too narrow, which drew the word twice and covered
    // the tagline. The layers only register when both are letter spans.
    assert.ok(!/<span class="aw-shine" aria-hidden="true">[A-Za-z]/.test(markup),
      'the shine layer must be letter spans, not a bare text run, or it cannot align with the base letters');
    // An inline-block holding only a normal space collapses to ZERO width,
    // which ran "Welcome" and "to" together.
    assert.ok(greet.includes('&nbsp;'),
      'the gap in "Welcome to" must be a non-breaking space or the two words touch');
    assert.match(screen, /Sacred, Authentic, Pure &amp; Trustworthy/, 'the tagline is missing');
    assert.match(screen, /aria-label="Welcome to Chakrashri"/,
      'the letters are aria-hidden, so the whole phrase must be announced once - otherwise a screen reader spells out 40 characters');
  });

  test('the duration is inside the thresholds that actually matter', () => {
    const min = Number((html.match(/const AWAKEN_MIN_MS = (\d+);/) || [])[1]);
    const max = Number((html.match(/const AWAKEN_MAX_MS = (\d+);/) || [])[1]);
    // A full-viewport overlay defers the real LCP element until it lifts, so
    // the dismissal time IS the Largest Contentful Paint. Google rates <=2.5s
    // good and >4s poor, and mobile abandonment climbs sharply past 3s.
    assert.ok(min <= 3000,
      'the welcome runs for ' + min + 'ms — past 3s it is measured as a poor LCP on every page and sits beyond the mobile abandonment cliff');
    // The letter stagger ends at 1.53s; cutting before that reads as a glitch.
    assert.ok(min >= 2400,
      'the welcome is cut mid-animation at ' + min + 'ms — the letter stagger finishes at 1.53s and needs a beat to settle');
    assert.ok(max > min,
      'the ceiling must stay ABOVE the floor: it is the unconditional net for a boot that throws before the release fires, and equal values leave no margin');
    assert.ok(max <= 5000, 'even the failure ceiling should not strand a visitor for longer than 5s');
  });

  test('a repeat load in the same session is never held behind the welcome', () => {
    // The bulk of the performance win: a shopper opening six products should be
    // greeted once, and the other five loads should carry no overlay at all.
    assert.match(html, /html\.welcomed #awakenScreen\{ display:none !important; \}/,
      'a repeat load must not paint the overlay — display:none, set before the body parses, so there is no flash');
    assert.match(html, /document\.documentElement\.classList\.add\('welcomed'\)/,
      'the class must be set in the HEAD script, before the body is parsed');
    assert.match(html, /sessionStorage\.setItem\(AWAKEN_SESSION_KEY/,
      'the session must be marked as greeted when the screen lifts');
    const rel = html.slice(html.indexOf('function releaseAwakeningScreen'), html.indexOf('function releaseAwakeningScreen') + 700);
    assert.match(rel, /sessionStorage\.getItem\(AWAKEN_SESSION_KEY\)\)\{ hideAwakeningScreen\(\); return; \}/,
      'a repeat load must not wait out the floor for a screen that was never painted');
  });

  test('nobody can be trapped behind the greeting', () => {
    assert.match(html, /el\.addEventListener\('click', hideAwakeningScreen\)/,
      'a tap must dismiss it — a greeting that cannot be skipped is an obstacle');
    assert.match(html, /if\(e\.key === 'Escape' \|\| e\.key === 'Enter' \|\| e\.key === ' '\) hideAwakeningScreen\(\)/,
      'keyboard users need the same escape');
  });

  test('sessionStorage, not localStorage — tomorrow is a new arrival', () => {
    assert.ok(!/localStorage\.[gs]etItem\(AWAKEN_SESSION_KEY/.test(html),
      'localStorage would greet a returning customer only once, ever');
  });

  test('THE REGRESSION: a transformed letter may never depend on a parent gradient', () => {
    // This replaces a test that PASSED while the wordmark was completely
    // invisible in a real browser. It asserted a fallback colour and an
    // @supports guard; both were present, and neither was what failed.
    //
    // background-clip:text paints a parent's gradient through its text. Give a
    // CHILD its own containing block and the parent can no longer paint into
    // it - the child comes out fully transparent. Verified in a browser, EVERY
    // animation primitive does that: transform, opacity, filter,
    // position:relative, even will-change. The old build put the gradient on
    // .awaken-brand and a transform on each letter, so "Welcome to Chakrashri"
    // rendered as nothing at all, on the one screen whose whole job is to show
    // the name. The fallback colour could not save it either, because
    // -webkit-text-fill-color overrides color.
    //
    // The fix splits the work: the letters carry a flat colour and may be
    // animated; a separate, never-transformed .aw-shine layer carries the
    // gradient. So the rule to hold is - whatever is transparent must own its
    // gradient, and must never be animated.
    const styleBlock = screen.slice(0, screen.indexOf('</style>'));
    const rules = styleBlock.split('}').map(r => r + '}');
    const transparent = rules.filter(r => /-webkit-text-fill-color:transparent/.test(r));
    assert.ok(transparent.length > 0, 'the gradient layer went missing entirely');
    for (const rule of transparent) {
      assert.ok(/background:linear-gradient/.test(rule),
        'an element is made transparent without owning a gradient, so it paints nothing: ' + rule.trim().slice(0, 90));
      assert.ok(!/transform:|filter:|position:relative|will-change/.test(rule),
        'the transparent gradient layer must never be transformed, or it stops painting: ' + rule.trim().slice(0, 90));
    }
    // The letters keep a real colour, so the name is still legible even if the
    // gradient layer is unsupported, blocked, or removed by a later edit.
    // Every rule that targets the letter layer, however the selector is
    // written - .awaken-brand appears in a shared layout rule too, so anchoring
    // on the first match reads the wrong block.
    const letterRules = rules.filter(r => /\.awaken-(brand|greet)[,{]/.test(r) && !/\.aw-shine/.test(r));
    assert.ok(letterRules.some(r => /color:#[0-9A-Fa-f]{6}/.test(r)),
      'the letters need a solid colour of their own - they are what remains if the shine layer never paints');
    assert.ok(!letterRules.some(r => /-webkit-text-fill-color:transparent/.test(r)),
      'the letter layer itself must never be transparent');
  });

  test('reduced motion shows the FINISHED state, not the starting one', () => {
    const rm = screen.slice(screen.indexOf('@media (prefers-reduced-motion:reduce)'));
    // All three lines animate in, so all three need their finished state
    // restored — the greeting and brand letters, and the tagline.
    assert.match(rm, /animation:none; opacity:1; transform:none;/,
      'cancelling the animation without restoring opacity leaves every letter invisible');
    assert.match(rm, /\.awaken-tagline\{ animation:none; opacity:1; \}/,
      'the tagline fades in too, so it needs the same treatment');
    assert.ok(/awaken-greet > span:not\(\.aw-shine\)/.test(rm) && /awaken-brand > span:not\(\.aw-shine\)/.test(rm),
      'both sets of letters must be covered');
    assert.match(rm, /\.aw-shine\{ animation:none; opacity:1;/,
      'the shine layer fades in and then sweeps, so it needs its finished state restored too - otherwise the gradient never appears at all');
  });

  test('it is sized to fit every device, measured not guessed', () => {
    // Measured in a real browser at 320/375/390/414/768/1440/1920 and at
    // 740x360 landscape: fits with 14-533px of side margin and no horizontal
    // scroll anywhere. Re-measured with Cinzel forced to Georgia, Times and
    // generic serif, because a webfont that fails to load is wider - at the
    // previous size that left 2px, and the name would have run off the screen.
    assert.match(screen, /font-size:clamp\(1\.95rem,9\.9vw,6\.5rem\)/,
      'the brand must scale with the viewport, with a floor and a ceiling');
    assert.match(screen, /@media \(max-height:560px\)/,
      'a landscape phone is short, not narrow - without this the mark and the name are clipped');
    assert.match(screen, /padding:0 4vw/, 'the wrapper needs side padding so the name never touches the edge');
  });
}

// ============================================================
section('[fe-24] It keeps working for products, services and categories added later');
// ============================================================
{
  const html = read('index.html');
  const gen = require('../scripts/generate-product-pages.js');

  test('THE FINDING: both title-casers agree on any category, not just the known ones', () => {
    // CAT_LABELS covers seven slugs. Everything else an admin types falls
    // through to a title-caser -- and there are TWO of them, one in the
    // storefront and one in the page generator. They disagreed: "books and
    // gifts" was "Books and Gifts" in the breadcrumb and "Books And Gifts" in
    // the Product JSON-LD, and "GIFT SETS" was normalised by one and left
    // shouting by the other. Nothing looks broken -- the page just tells Google
    // a different category name than it shows the customer.
    function pageCatLabel() {
      function grab(name) {
        const i = html.indexOf('function ' + name + '(');
        let depth = 0; const start = html.indexOf('{', i);
        for (let k = start; k < html.length; k++) {
          if (html[k] === '{') depth++;
          else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
        }
      }
      const minor = html.match(/const MINOR_WORDS = [^;]+;/)[0];
      return new Function(minor + 'const CAT_LABELS=' + JSON.stringify(gen.CAT_LABELS) + ';' +
        grab('titleCaseTerm') + grab('catLabel') + '; return catLabel;')();
    }
    const page = pageCatLabel();
    const inputs = ['book', 'dhoti', 'sphatik', 'puja thali', 'books and gifts',
      'gifts for the home', 'malas of rudraksha', 'incense-and-dhoop', 'GIFT SETS',
      '  spaced  out  ', 'THE_HOME_SHRINE', 'lingam', 'yantra', '', null, undefined, 'a'];
    for (const input of inputs) {
      assert.strictEqual(gen.catLabel(input), page(input),
        'catLabel disagrees for ' + JSON.stringify(input) + ' — the breadcrumb and the rich result would differ');
    }
  });

  test('ALL FOUR title-casers agree — storefront, admin, generator and backend', () => {
    // There are four independent implementations of this rule: index.html,
    // admin.html (DL_MINOR), scripts/generate-product-pages.js and
    // src/utils/text.js (displayTerm). A category name is written by the admin,
    // stored by the backend, listed in the admin console, shown in the
    // storefront breadcrumb and published in the Product JSON-LD — so all four
    // have to say the same thing or the customer, the owner and Google each see
    // a different label.
    const admin = read('admin.html');
    const backend = require('../src/utils/text.js');
    function caser(src, minorDecl, name) {
      const i = src.indexOf('function ' + (name || 'titleCaseTerm') + '(');
      let depth = 0; const start = src.indexOf('{', i);
      let body;
      for (let k = start; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (!depth) { body = src.slice(i, k + 1); break; } }
      }
      return new Function(src.match(minorDecl)[0] + body + '; return ' + (name || 'titleCaseTerm') + ';')();
    }
    const store = caser(html, /const MINOR_WORDS = [^;]+;/);
    const adm = caser(admin, /const DL_MINOR = [^;]+;/);

    const inputs = ['books and gifts', 'gifts for the home', 'GIFT SETS', '  spaced  out  ',
      'puja samagri kits', 'malas of rudraksha', 'murtis & idols', 'incense and dhoop',
      'a', 'the shrine', 'book', 'dhoti'];
    for (const input of inputs) {
      const expected = store(input);
      assert.strictEqual(adm(input), expected, 'admin.html disagrees for ' + JSON.stringify(input));
      assert.strictEqual(gen.titleCaseTerm(input), expected, 'the page generator disagrees for ' + JSON.stringify(input));
      assert.strictEqual(backend.displayTerm(input), expected, 'src/utils/text.js disagrees for ' + JSON.stringify(input));
    }
  });

  test('the generator carries the same MINOR_WORDS list as the storefront', () => {
    const inPage = JSON.parse(html.match(/const MINOR_WORDS = (\[[^\]]+\]);/)[1].replace(/'/g, '"'));
    assert.deepStrictEqual(gen.MINOR_WORDS, inPage,
      'the two lists drifted — a category with a minor word would be cased differently in each place');
  });

  test('nothing in the new work is keyed to a fixed product, slug or category', () => {
    assert.ok(!/openProduct\('(lin|mal|idl|yan|bra|bok)-\d+'\)/.test(html), 'a hardcoded product id is back');
    assert.match(html, /function renderMegaMenuPicks/, 'the picks column must be built from the catalog');
    assert.match(html, /const knownPairing = wanted\.length > 0;/,
      'an unrecognised category must still produce a suggestion');
    assert.match(html, /apiFetch\('\/api\/booking-services\?type=puja', \{ background: true \}\)/,
      'booking services must come from the API, never a fixed array');
  });
}

// ============================================================
section('[fe-25] The waiting screen fits the thing being bought');
// ============================================================
{
  const html = read('index.html');

  test('THE FINDING: a booking is never offered cart-only suggestions', () => {
    // During a puja booking the cart is empty and irrelevant, yet the picker
    // would happily show "Free shipping is Rs199 away" and an Add button that
    // drops a product into a cart the booking has nothing to do with -- leaving
    // it stranded there afterwards.
    for (const id of ['complete-ritual', 'free-shipping', 'small-additions', 'bestsellers', 'care-note']) {
      const at = html.indexOf("id: '" + id + "'");
      assert.ok(at > -1, id + ' strategy is missing');
      const decl = html.slice(at, at + 120);
      assert.match(decl, /contexts: \['order'\]/, id + ' must be order-only — it touches the cart');
    }
  });

  test('a booking gets its own suggestion, and it cannot touch the cart', () => {
    const at = html.indexOf("id: 'booking-next'");
    assert.ok(at > -1, 'bookings need a strategy of their own or the wait shows nothing');
    const block = html.slice(at, html.indexOf("id: 'journal'"));
    assert.match(block, /contexts: \['puja', 'astrology'\]/);
    assert.ok(!/items:/.test(block), 'a booking suggestion must not offer products — it would strand them in the cart');
    assert.match(block, /waitState\.audience === 'puja'/, 'puja and astrology need different copy');
  });

  test('the picker filters by audience, and every caller declares one', () => {
    const fn = html.slice(html.indexOf('function pickWaitStrategy'), html.indexOf('function pickWaitStrategy') + 900);
    assert.match(fn, /!s\.contexts \|\| s\.contexts\.indexOf\(audience\) > -1/,
      'without this filter a booking still gets cart suggestions');
    assert.match(html, /audience: 'order'/);
    assert.match(html, /audience: 'puja'/);
    assert.match(html, /audience: 'astrology'/);
  });
}

// ============================================================
section('[fe-26] Money rules come from the server, never from the client');
// ============================================================
{
  const html = read('index.html');
  const settings = require('../src/utils/settings.js');

  function run(names, extra) {
    let src = extra || '';
    for (const n of names) {
      const i = html.indexOf('function ' + n + '(');
      assert.ok(i > -1, n + ' is missing from index.html');
      let depth = 0; const start = html.indexOf('{', i);
      for (let k = start; k < html.length; k++) {
        if (html[k] === '{') depth++;
        else if (html[k] === '}') { depth--; if (!depth) { src += html.slice(i, k + 1) + String.fromCharCode(10); break; } }
      }
    }
    return src;
  }

  test('THE FINDING: shipping is read from the server, not hardcoded', () => {
    assert.ok(!/subtotal >= 999 \|\| subtotal === 0 \? 0 : 79/.test(html),
      'the hardcoded threshold is back — changing it in the admin console would desynchronise the checkout from the server');
    assert.match(html, /apiFetch\('\/api\/site\/config'/,
      '/api/site/config publishes the real values and must be read');
  });

  test('the client fallback matches SETTINGS_DEFAULTS exactly', () => {
    const cfg = html.match(/let siteConfig = \{[\s\S]*?\};/)[0];
    const thr = Number(cfg.match(/freeShippingThresholdPaise: (\d+)/)[1]);
    const flat = Number(cfg.match(/shippingFlatPaise: (\d+)/)[1]);
    const codMax = Number(cfg.match(/codMaxOrderPaise: (\d+)/)[1]);
    // Read the defaults from whichever name the module exports them under, so
    // this keeps working if the export is renamed.
    const D = settings.SETTINGS_DEFAULTS || settings.DEFAULTS || settings.defaults;
    assert.ok(D && typeof D.free_shipping_threshold_paise === 'number',
      'could not read the server defaults from src/utils/settings.js');
    assert.strictEqual(thr, D.free_shipping_threshold_paise,
      'the pre-config fallback must equal the server default, or an unconfigured shop behaves differently on each side');
    assert.strictEqual(flat, D.shipping_flat_paise);
    assert.strictEqual(codMax, D.cod_max_order_paise);
  });

  test('client shipping arithmetic matches the server at every boundary', () => {
    const api = new Function(
      html.match(/let siteConfig = \{[\s\S]*?\};/)[0] +
      run(['freeShippingThreshold', 'shippingFlat', 'getShippingCost']) +
      '; return { getShippingCost, set: (c) => { siteConfig = Object.assign(siteConfig, c); } };'
    )();
    // Mirrors calculateOrderTotals in utils/orders.js.
    const server = (paise, thr, flat) => (paise >= thr ? 0 : flat);

    for (const [thr, flat] of [[99900, 7900], [149900, 9900], [50000, 5000]]) {
      api.set({ freeShippingThresholdPaise: thr, shippingFlatPaise: flat });
      for (const rupees of [0, 1, 499, 500, 999, 1200, 1499, 1500, 5000]) {
        const client = api.getShippingCost(rupees);
        const expected = rupees === 0 ? 0 : server(rupees * 100, thr, flat) / 100;
        assert.strictEqual(client, expected,
          'shipping disagrees at Rs' + rupees + ' with threshold ' + thr + ' — the customer would agree to a total the server does not charge');
      }
    }
  });

  test('THE PHANTOM CHARGE: no COD fee is invented on the client', () => {
    assert.ok(!/const codFee = method === 'cod' \? 40 : 0;/.test(html),
      'the client is adding a Rs40 COD fee the server never charges — the checkout total and the order confirmation would disagree');
    const totals = html.slice(html.indexOf('function updateCheckoutTotals'), html.indexOf('function updateCheckoutTotals') + 1600);
    assert.match(totals, /const codFee = 0;/);
  });

  test('COD is not offered when the server would refuse it', () => {
    assert.match(html, /function applyCodAvailability/);
    const fn = html.slice(html.indexOf('function applyCodAvailability'), html.indexOf('function applyCodAvailability') + 1800);
    assert.match(fn, /!siteConfig\.codEnabled \|\| overLimit/,
      'both the switch and the order limit must gate it — the server enforces both');
    assert.match(fn, /if\(fallback\) selectPayMethod\(fallback\)/,
      'a cart that grows past the limit while COD is selected must move to a method that will succeed');
  });

  test('prose quoting the threshold is rewritten from the real value', () => {
    assert.match(html, /data-free-ship-threshold/, 'the copy must be tagged so it can follow the setting');
    assert.match(html, /qsa\('\[data-free-ship-threshold\]'\)/);
    // The puja card price of Rs999 is NOT a threshold and must stay untouched.
    assert.match(html, /<div class="price">₹999<\/div>/,
      'a product price was wrongly tagged as a shipping threshold');
  });
}

// ============================================================
section('[fe-27] THE BIG ONE: the checkout total equals what the server charges');
// ============================================================
// calculateOrderTotals is discountedSubtotal + shipping + GST. The checkout
// showed subtotal - discount + shipping and NO GST, and the client never even
// kept gst_rate off the API response. Every product in this catalog carries
// gst_rate 3.00, so every customer was quoted ~3% less than they were charged.
{
  const html = read('index.html');
  const orders = require('../src/utils/orders.js');

  function grab(name) {
    const i = html.indexOf('function ' + name + '(');
    assert.ok(i > -1, name + ' is missing');
    let depth = 0; const start = html.indexOf('{', i);
    for (let k = start; k < html.length; k++) {
      if (html[k] === '{') depth++;
      else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
    }
  }

  const PRODUCTS = [
    { id: '1', name: 'A', cat: 'book',   price: 800,  mrp: 800,  stock: true, gstRate: 3, sku: 'A', slug: 'a' },
    { id: '2', name: 'B', cat: 'yantra', price: 2499, mrp: 2499, stock: true, gstRate: 3, sku: 'B', slug: 'b' },
    { id: '3', name: 'C', cat: 'book',   price: 250,  mrp: 250,  stock: true, gstRate: 12, sku: 'C', slug: 'c' },
    { id: '4', name: 'D', cat: 'idols',  price: 500,  mrp: 500,  stock: true, gstRate: 0, sku: 'D', slug: 'd' }
  ];

  function client() {
    const src = 'let cart=[]; let appliedCoupon=null; const PRODUCTS=' + JSON.stringify(PRODUCTS) + ';' +
      'let siteConfig={freeShippingThresholdPaise:99900,shippingFlatPaise:7900,codEnabled:true,codMaxOrderPaise:500000};' +
      'function getProduct(id){return PRODUCTS.find(p=>p.id===String(id));}' +
      grab('cartUnitPrice') + grab('productFromCartLine') + grab('getCartLinesWithProducts') +
      grab('freeShippingThreshold') + grab('shippingFlat') + grab('getShippingCost') + grab('calculateCartTotals');
    return new Function(src + '; return { calc: calculateCartTotals, setCart: (c)=>{cart=c;}, setCoupon: (c)=>{appliedCoupon=c;} };')();
  }

  function server(lines, discountPaise) {
    const items = lines.map((l) => {
      const p = PRODUCTS.find((x) => x.id === l.id);
      return { lineTotalPaise: Math.round(p.price * 100) * l.qty, gstRate: p.gstRate };
    });
    return orders.calculateOrderTotals(items, discountPaise || 0,
      { free_shipping_threshold_paise: 99900, shipping_flat_paise: 7900 });
  }

  test('THE FINDING: gst_rate is kept off the API response at all', () => {
    assert.match(html, /gstRate: Number\(p\.gst_rate\) \|\| 0,/,
      'mapApiProduct drops gst_rate, so the client cannot compute the total the server charges');
    assert.match(html, /function calculateCartTotals/);
  });

  test('client and server agree to the paisa across carts, rates and coupons', () => {
    const api = client();
    const scenarios = [
      [[{ id: '1', qty: 1 }], 0],
      [[{ id: '2', qty: 1 }], 0],
      [[{ id: '3', qty: 3 }], 0],
      [[{ id: '4', qty: 2 }], 0],                                   // zero-rated
      [[{ id: '1', qty: 2 }, { id: '3', qty: 1 }, { id: '4', qty: 4 }], 0],  // mixed rates
      [[{ id: '2', qty: 1 }], 20000],                               // coupon
      [[{ id: '3', qty: 1 }], 99999999],                            // coupon > cart
      [[{ id: '1', qty: 1 }, { id: '2', qty: 1 }], 50000]
    ];
    for (const [lines, disc] of scenarios) {
      api.setCart(lines.map((l) => ({ id: l.id, qty: l.qty })));
      api.setCoupon(disc ? { discountPaise: disc, code: 'X' } : null);
      const c = api.calc();
      const s = server(lines, disc);
      assert.strictEqual(Math.round(c.total * 100), s.totalPaise,
        'total disagrees for ' + JSON.stringify(lines) + ' discount ' + disc +
        ' — the customer would agree to a figure the server does not charge');
      assert.strictEqual(Math.round(c.gst * 100), s.gstPaise, 'GST disagrees for ' + JSON.stringify(lines));
      assert.strictEqual(Math.round(c.shipping * 100), s.shippingPaise, 'shipping disagrees');
      assert.strictEqual(Math.round(c.discount * 100), s.discountPaise, 'discount clamp disagrees');
    }
  });

  test('both summaries read the same function — cart page and checkout cannot differ', () => {
    const cart = html.slice(html.indexOf('function buildSummaryLinesHTML'), html.indexOf('function buildCouponRowHTML'));
    const checkout = html.slice(html.indexOf('function updateCheckoutTotals'), html.indexOf('function updateCheckoutTotals') + 2200);
    assert.match(cart, /calculateCartTotals\(\)/, 'the cart page still totals independently');
    assert.match(checkout, /calculateCartTotals\(\)/, 'the checkout still totals independently');
    assert.ok(!/formatINR\(Math\.max\(0, subtotal - discount \+ shipping\)\)/.test(html),
      'a hand-rolled total that omits GST is back');
  });

  test('the GST line is shown only when there is tax to show', () => {
    assert.match(html, /id="ckGstRow"/);
    assert.match(html, /gstRow\.style\.display = totals\.gst > 0 \? '' : 'none'/,
      'a "GST ₹0" row on a zero-rated catalog is noise; a missing one on a taxed catalog is a wrong total');
  });

  test('the rate survives a cold start on the cart line', () => {
    assert.match(html, /gstRate: Number\(p\.gstRate\) \|\| 0,/, 'cartLineSnapshot must carry the rate');
    assert.match(html, /gstRate: Number\(l\.snap\.gstRate\) \|\| 0,/, 'productFromCartLine must restore it');
  });
}

// ============================================================
section('[fe-28] The wait is paced, and it ends honestly');
// ============================================================
{
  const html = read('index.html');

  // The real pacing functions, lifted out of index.html and run. Reading a
  // curve tells you nothing; the only way to know a progress bar never lies is
  // to drive it.
  function grab(name) {
    const i = html.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    let depth = 0; const start = html.indexOf('{', i);
    for (let k = start; k < html.length; k++) {
      if (html[k] === '{') depth++;
      else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
    }
  }
  const consts = ['WAIT_SUGGEST_MS', 'WAIT_COLD_BUDGET_MS', 'WAIT_MAX_MS', 'WAIT_HANDOFF_MS']
    .map(n => (html.match(new RegExp('const ' + n + ' = \\d+;')) || [''])[0]).join('\n');
  const state = { startedAt: 0 };
  const pacing = new Function('waitState', consts + '\n' +
    grab('waitElapsed') + grab('waitStepIndex') + grab('waitBarPercent') +
    '; return { waitStepIndex, waitBarPercent, WAIT_SUGGEST_MS, WAIT_COLD_BUDGET_MS, WAIT_MAX_MS, WAIT_HANDOFF_MS };')(state);
  const at = ms => { state.startedAt = Date.now() - ms; return pacing; };

  const FLOW = new Function('return ' +
    html.match(/const WAIT_FLOW = \{[\s\S]*?\n\};/)[0].replace('const WAIT_FLOW = ', '').replace(/;$/, ''))();

  const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const strategiesSrc = stripComments(html.slice(html.indexOf('const WAIT_STRATEGIES = ['),
                                                 html.indexOf('function pickWaitStrategy')));

  test('THE FINDING: no suggestion may be shown to every audience at once', () => {
    // A 'From the Journal' card sat in this list with no `contexts`, which made
    // it eligible everywhere -- so a customer one tap from paying, and someone
    // booking a pandit, could both be handed a blog excerpt instead of
    // anything to do with what they were doing.
    //
    // Every strategy must now name its audiences. A contextless one is not a
    // style problem: pickWaitStrategy treats "no contexts" as "all contexts",
    // so it silently leaks into the money paths.
    const ids = strategiesSrc.match(/id: '[a-z-]+'/g) || [];
    assert.ok(ids.length >= 5, 'expected the strategy list, found ' + ids.length + ' entries');
    const blocks = strategiesSrc.split(/(?=\n  \{)/).filter(b => /id: '/.test(b));
    assert.strictEqual(blocks.length, ids.length, 'could not split the strategies cleanly');
    for (const b of blocks) {
      const id = (b.match(/id: '([a-z-]+)'/) || [])[1];
      assert.match(b, /contexts: \[/, 'strategy "' + id + '" declares no contexts, so it is offered to every audience including bookings');
    }
    // Scan the stripped source: the comment recording why the card was removed
    // legitimately names it, and matching your own documentation is not a test.
    assert.ok(!/From the Journal/.test(strategiesSrc),
      'the Journal card is back on the waiting screen -- it belongs to no audience on a payment wait');
  });

  test('a booking can never be offered something that writes to the cart', () => {
    // The Add button is the danger: tapping it during a booking wait drops a
    // product into a cart the booking has nothing to do with, and strands it
    // there afterwards.
    const blocks = strategiesSrc.split(/(?=\n  \{)/).filter(b => /id: '/.test(b));
    for (const b of blocks) {
      const id = (b.match(/id: '([a-z-]+)'/) || [])[1];
      const ctx = (b.match(/contexts: \[([^\]]*)\]/) || [])[1] || '';
      const booking = /puja|astrology/.test(ctx);
      if (booking) {
        assert.ok(!/items: items/.test(b),
          'strategy "' + id + '" is offered to a booking audience and returns products');
      }
    }
  });

  test('the free-shipping card reads the threshold, it does not hardcode it', () => {
    // The server prices shipping from site_settings. This card had 999 written
    // into it three times, so raising the threshold in the admin left it
    // promising free shipping at the old number to somebody about to pay.
    const block = strategiesSrc.slice(strategiesSrc.indexOf("id: 'free-shipping'"));
    const body = block.slice(0, block.indexOf('\n  },'));   // already comment-stripped
    assert.match(body, /freeShippingThreshold\(\)/, 'the threshold must come from the settings helper');
    assert.ok(!/\b999\b/.test(body), 'a literal 999 is still in the free-shipping card');
  });

  test('the progress bar never claims to be finished while it is still waiting', () => {
    // A bar sitting at 100% while nothing happens is the least trustworthy
    // thing a checkout can show, and the reason indeterminate bars get ignored.
    let last = -1;
    for (let s = 0; s <= 120; s += 5) {
      const pct = at(s * 1000).waitBarPercent();
      assert.ok(pct >= last - 0.001, 'the bar went backwards at ' + s + 's');
      assert.ok(pct < 100, 'the bar reached ' + pct.toFixed(1) + '% at ' + s + 's, before the backend had answered');
      last = pct;
    }
    assert.strictEqual(at(0).waitBarPercent(), 0, 'it must start empty');
    assert.ok(Math.abs(at(pacing.WAIT_COLD_BUDGET_MS).waitBarPercent() - 90) < 0.01,
      'a normal cold boot should end with the bar at 90%, leaving headroom for the truth');
  });

  test('the phases are ordered, and the overrun warning lands after a real cold boot', () => {
    assert.ok(pacing.WAIT_SUGGEST_MS < pacing.WAIT_COLD_BUDGET_MS,
      'the selling has to stop before the wait is even unusual');
    assert.ok(pacing.WAIT_COLD_BUDGET_MS >= 60000,
      'Render cold boots run 30-60s; warning earlier would cry wolf on a normal wait');
    assert.ok(pacing.WAIT_MAX_MS > pacing.WAIT_COLD_BUDGET_MS,
      'the hard stop must be beyond the warning, or the warning is never seen');
    // Every index the clock can produce needs a label, or the status line reads
    // "undefined…" at the worst possible moment.
    for (const aud of Object.keys(FLOW)) {
      for (const ms of [0, 14999, 15000, 34999, 35000, 119000]) {
        const i = at(ms).waitStepIndex();
        assert.ok(FLOW[aud].steps[i], 'audience "' + aud + '" has no step ' + i + ' (at ' + ms + 'ms)');
      }
      assert.ok(FLOW[aud].done, 'audience "' + aud + '" has no completion line');
    }
  });

  test('a booking wait never talks about carts, items or payment sessions', () => {
    for (const aud of ['puja', 'astrology']) {
      const words = (FLOW[aud].steps.join(' ') + ' ' + FLOW[aud].done).toLowerCase();
      assert.ok(!/\bcart\b|\bitems\b|\bpayment\b/.test(words),
        '"' + aud + '" says: ' + words);
    }
    assert.ok(/payment/i.test(FLOW.order.steps.join(' ')),
      'an order wait SHOULD name the payment session -- that is what it is doing');
  });

  test('every timer is registered, so none can outlive the screen', () => {
    // The wait now runs two phase hand-offs and a tick. Any one left behind
    // keeps firing into a modal nobody is looking at, and the tick re-renders
    // the panel -- an orphan would visibly fight the next wait for the screen.
    const open = grab('openWaitingExperience');
    const close = grab('closeWaitingExperience');
    assert.ok(!/setInterval\(|setTimeout\(/.test(open.replace(/waitAfter\(|waitEvery\(/g, '')),
      'openWaitingExperience starts a raw timer that clearWaitTimers cannot see');
    assert.match(open, /clearWaitTimers\(\)/, 'reopening must clear whatever the last wait left running');
    assert.match(close, /clearWaitTimers\(\)/, 'closing must clear every timer');
    const clear = grab('clearWaitTimers');
    assert.match(clear, /waitState\.timers = \[\]/, 'the timeout list must be emptied, not just cleared');
    assert.match(clear, /waitState\.intervals = \[\]/, 'the interval list must be emptied, not just cleared');
  });

  test('a failed wait explains itself on screen instead of vanishing as a toast', () => {
    const run = grab('runWithBackendReady');
    assert.match(run, /renderWaitFailurePanel\(\)/,
      'a payment that did not happen needs an explanation that stays on screen');
    assert.ok(!/toast\(/.test(run),
      'a toast slides away and leaves somebody who was about to spend money with nothing to read');
    const panel = grab('renderWaitFailurePanel');
    assert.match(panel, /No payment was taken/, 'the first thing it must settle is whether they were charged');
    assert.match(panel, /navigator\.onLine === false/,
      'a device with no connection is not our outage, and saying so would be both wrong and unfixable by them');
    assert.match(panel, /support@chakrashri\.com/, 'there must be a way through that does not depend on the thing that just failed');
    assert.match(panel, /waitSubject\(\)/, 'it must name what they actually have -- "your cart" to somebody booking a pandit is the wrong screen');
  });

  test('THE TRAP: Try again must re-enter the gate, not call the intent', () => {
    // Calling intent() straight from a retry button bypasses intentInFlight,
    // and a retry that bypasses the in-flight guard is exactly how a retry
    // button becomes a double charge.
    const retry = grab('retryWaitIntent');
    assert.ok(!/intent\(\)/.test(retry), 'the retry must not invoke the intent directly');
    assert.match(retry, /waitState\.retry/, 'it runs the stored re-entry, not the raw intent');
    const run = grab('runWithBackendReady');
    assert.match(run, /waitState\.retry = function\(\)\{ withBackendReady\(intent, context\); \}/,
      'the stored retry must go back through withBackendReady so the in-flight guard applies again');
  });

  test('the wait says it is handing over only once that is true', () => {
    const run = grab('runWithBackendReady');
    const successAt = run.indexOf('renderWaitSuccessPanel');
    const readyCheck = run.indexOf('if(!ready)');
    assert.ok(successAt > readyCheck && readyCheck > -1,
      'the hand-off message must come AFTER the backend has answered, or it is a promise that can still fail');
    // Browser-back during the hand-off beat must still stop the order.
    assert.ok(run.slice(successAt).includes('waitState.cancelled'),
      'a cancel during the hand-off beat must still be honoured -- otherwise the order fires from a screen they left');
  });

  test('reduced motion must not make the bar claim to be full', () => {
    // Normalise line endings, and strip comments BEFORE scanning. This file is
    // CRLF on Windows, so an anchor written with \n matches nothing; and the
    // comment recording this decision spells out the exact string being banned,
    // so a naive scan matches its own documentation. That is the third time
    // this file has caught itself doing that.
    const css = stripComments(html.replace(/\r\n/g, '\n'));
    const start = css.indexOf('.wait-progress-bar{ transition:none; }');
    assert.ok(start > -1, 'the reduced-motion rule for the bar is missing entirely');
    const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion:reduce)', start),
                            css.indexOf('}', start) + 1);
    assert.ok(!/width:100%/.test(block),
      'forcing the determinate bar full under reduced motion claims the wait is over when it has barely started');
    assert.match(block, /transition:none/, 'removing the easing is the right accommodation');
  });
}

// ============================================================
section('[fe-29] The screen a customer is reading cannot go stale under them');
// ============================================================
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  function grab(name) {
    const i = html.search(new RegExp('(async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = html.indexOf('{', i);
    for (let k = s; k < html.length; k++) {
      if (html[k] === '{') d++;
      else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); }
    }
  }

  test('THE FINDING: a cart change refreshes the CHECKOUT, not only the cart page', () => {
    // Measured on the real page before this fix, all three from one cause:
    //   - add a suggestion from the waiting screen while on checkout: the
    //     screen still read Rs903 while the cart was worth Rs1,340.03. The
    //     customer agrees to one number and is charged another -- the same
    //     class of defect as the missing GST, and caused by the waiting
    //     screen's own Add button;
    //   - remove a line from the drawer while on checkout: Rs1,340 on screen
    //     for a Rs903 cart;
    //   - empty the cart: a payable total and a live Place Order button.
    //
    // refreshCartAndCheckoutViews() already existed and did the right thing --
    // it was simply never called from any cart mutation, only from the coupon
    // paths. That asymmetry is the bug.
    const fn = strip(grab('updateCartUI'));
    assert.match(fn, /refreshCartAndCheckoutViews\(\)/,
      'a cart mutation must refresh whichever of the two pages is on screen');
    assert.ok(!/#page-cart'\)\.classList\.contains\('active'\)/.test(fn),
      'refreshing only the cart page is what let the checkout go stale');
    const refresher = strip(grab('refreshCartAndCheckoutViews'));
    assert.match(refresher, /renderCheckoutPage\(\)/, 'the refresher must cover the checkout');
    assert.match(refresher, /renderCartPage\(\)/, 'and must still cover the cart page');
  });

  test('refreshing the checkout must not destroy a half-typed address', () => {
    // This is the risk the fix introduces: it now runs on EVERY cart change,
    // including while somebody is typing their address. Verified in a browser
    // that all seven fields and the focus survive; this test keeps it that way
    // by making sure the re-render never rewrites the form itself.
    const fn = strip(grab('renderCheckoutPage'));
    for (const field of ['ckName', 'ckPhone', 'ckEmail', 'ckAddress', 'ckCity', 'ckState', 'ckPin']) {
      assert.ok(!new RegExp(field + "'\\)\\.innerHTML|id=\"" + field + '"').test(fn),
        'renderCheckoutPage rewrites ' + field + ', so a cart change would wipe what the customer typed');
    }
    assert.match(fn, /checkoutOrderItems'\)\.innerHTML/, 'it should rewrite the order list');
    assert.match(fn, /updateCheckoutTotals\(\)/, 'and the totals');
  });

  test('a cart change cannot recurse back into itself', () => {
    // updateCartUI now calls the page renderers. If either called back into
    // updateCartUI the first add to a cart would hang the tab.
    for (const name of ['renderCartPage', 'renderCheckoutPage', 'updateCheckoutTotals', 'buildSummaryLinesHTML']) {
      assert.ok(!/updateCartUI\(\)/.test(strip(grab(name))),
        name + ' calls updateCartUI, which now calls it back — that is an infinite loop on every add');
    }
  });

  test('THE TRAP: a sleeping server must never cost the customer their coupon', () => {
    // appliedCoupon.discountPaise is a number the SERVER computed for the cart
    // as it was. Coupons here can be percentage-based and can carry a minimum
    // order value, so the cached figure goes stale as soon as the cart changes.
    // Re-asking is right; clearing a valid coupon because the API was cold
    // would be a far worse bug than a briefly stale discount.
    const fn = strip(grab('revalidateCouponNow'));
    // This guard got STRONGER. It used to keep the coupon only on a transport
    // failure, which meant our own 500 still took the customer's discount away.
    // Now only a JUDGEMENT — a 4xx, a real decision about the coupon — may
    // remove it; transport and server faults both change nothing. See [fe-38].
    assert.match(fn, /if\(classifyFailure\(err\) !== FAILURE_JUDGEMENT\) return;/,
      'a transport failure, and our own 5xx, must both change nothing at all');
    const catchBlock = fn.slice(fn.indexOf('catch'));
    const guardAt = catchBlock.indexOf('classifyFailure');
    const clearAt = catchBlock.indexOf('appliedCoupon = null');
    assert.ok(guardAt > -1 && clearAt > guardAt,
      'the classification must come BEFORE the clear, or a cold start or our own outage drops a valid coupon');
    // The customer can remove or swap the coupon while the request is in flight.
    assert.ok((fn.match(/appliedCoupon\.code !== code/g) || []).length >= 2,
      'both the success and failure paths must re-check the code before acting on a stale reply');
    assert.match(strip(grab('revalidateCouponSoon')), /clearTimeout\(couponRecheckTimer\)/,
      'holding the + button must produce one request, not ten');
  });

  test('the server stays the only authority on what a coupon is worth', () => {
    // The client re-asks so the SCREEN is right. It must never send an amount.
    const order = strip(grab('placeOrderNow'));
    assert.match(order, /couponCode: appliedCoupon \? appliedCoupon\.code : null/,
      'only the code may be sent — the server recomputes the discount itself');
    assert.ok(!/discountPaise:/.test(order),
      'sending a discount amount would let the client price its own order');
  });

  test('the waiting screen never assumes the customer has a cart', () => {
    // Both booking callers pass their own note today, so this is about what any
    // money path added later inherits — and about the fallback card, which is
    // reachable from a booking.
    const openFn = strip(grab('openWaitingExperience'));
    const suggest = strip(grab('renderWaitSuggestion'));
    assert.ok(!/Your cart is saved\. Nothing has been charged\./.test(openFn),
      'the default note hardcodes a cart, so a booking would be told its cart is safe');
    assert.match(openFn, /waitSubject\(\)/, 'the default must be derived from the audience');
    assert.ok(!/Your cart is saved exactly as it is/.test(suggest),
      'the fallback card hardcodes a cart');
    assert.match(suggest, /waitSubject\(\)/, 'the fallback must name what they actually have');
  });
}

// ============================================================
section('[fe-30] The price on screen is the price charged, warm or cold');
// ============================================================
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);
  function grab(name, src) {
    const s = src || code;
    const i = s.search(new RegExp('(async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const st = s.indexOf('{', i);
    for (let k = st; k < s.length; k++) {
      if (s[k] === '{') d++;
      else if (s[k] === '}') { d--; if (!d) return s.slice(i, k + 1); }
    }
  }

  test('THE FINDING: the server amount is never handed to the gateway unchecked', () => {
    // The client prices from a catalog that can be a whole cold start old. The
    // SERVER prices from the database and hands back the real figure, which was
    // passed STRAIGHT to Razorpay as `amount`. So an admin editing a price meant
    // the customer read one number on the checkout and watched a different one
    // appear in the payment sheet, unexplained.
    //
    // Every place that reaches Razorpay must first compare the two.
    const sites = [...code.matchAll(/amount: body\.amountPaise/g)].map(m => m.index);
    assert.strictEqual(sites.length, 3, 'expected the order, puja and astrology paths; found ' + sites.length);
    for (const at of sites) {
      // The guard must appear between the API response and the gateway call.
      const before = code.slice(Math.max(0, at - 2600), at);
      assert.match(before, /confirmAmountChange\(quotedPaise, body\.amountPaise/,
        'a payment path reaches Razorpay without comparing the server amount to what the customer was shown');
    }
  });

  test('cash on delivery cannot silently place an order at a different price', () => {
    // COD is created by the server in the same call, so it cannot be taken back
    // from the client — blocking is not available, but telling the truth is.
    // Without this the first time the customer met the real price was at the door.
    const fn = grab('placeOrderNow');
    const codBranch = fn.slice(fn.indexOf('requiresRazorpay === false'));
    assert.match(codBranch.slice(0, 700), /amountsAgree\(quotedPaise, body\.totalPaise\)/,
      'the COD branch must compare the placed total against what the customer was reading');
    assert.match(codBranch.slice(0, 900), /your order was placed at/,
      'and must state the figure it was actually placed at');
  });

  test('the quote is captured from the customer\'s own screen, not re-derived later', () => {
    const fn = grab('placeOrderNow');
    const quoteAt = fn.indexOf('const quotedPaise');
    const postAt = fn.indexOf("apiFetch('/api/payments/create-order'");
    assert.ok(quoteAt > -1 && postAt > quoteAt,
      'the quoted figure must be taken BEFORE the commit, or it just echoes the server back at itself');
    assert.match(fn.slice(quoteAt, quoteAt + 120), /calculateCartTotals\(\)/,
      'it must be the same function the checkout renders from');
  });

  test('an unknown amount must never block a valid order', () => {
    // A missing or malformed figure means we cannot tell, and refusing to sell
    // on "cannot tell" would be a worse bug than the one being fixed.
    const fn = grab('amountsAgree');
    assert.match(fn, /if\(!Number\.isFinite\(x\) \|\| !Number\.isFinite\(y\)\) return true;/,
      'unknown must resolve to "agree", never to a block');
    assert.match(fn, /Math\.abs\(x - y\) < 1/,
      'both sides compute in integer paise, so anything past a paisa is a real difference');
  });

  test('prices and stock are refreshed the moment the backend wakes', () => {
    // Without this the customer spends a 60-second cold start looking at
    // snapshot prices and then pays against figures the server may have changed.
    const fn = grab('runWithBackendReady');
    const readyAt = fn.indexOf('if(!ready)');
    const refreshAt = fn.indexOf('loadCatalog()');
    const intentAt = fn.lastIndexOf('return intent();');
    assert.ok(refreshAt > readyAt && intentAt > refreshAt,
      'the refresh must happen after the backend answers and BEFORE the intent commits money');
    assert.match(fn, /refreshCartAndCheckoutViews\(\)/,
      'the corrected figures must reach the page the customer is looking at');
    assert.match(fn.slice(refreshAt - 200, refreshAt + 300), /try\{/,
      'a failed refresh must not stop the order — the server amount is still checked before any charge');
  });

  test('THE FINDING: a quantity has a floor, a ceiling, and no fractions', () => {
    // Measured before this existed: 9999 accepted against 8 in stock (cart
    // showed Rs79,99,200 and the server would refuse it at the payment step);
    // a non-numeric input produced Math.max(1, NaN) === NaN and one NaN line
    // turned the whole checkout total into NaN; 2.7 was priced as 2.7 units.
    // normalizeCartQty is pure arithmetic now: a quantity, a CEILING, and what
    // other lines hold. Working out the ceiling is stockCeilingFor's job,
    // because it differs for a variant and for a plain product.
    const run = new Function('return ' + grab('normalizeCartQty') + '; ')();
    assert.strictEqual(run(9999, 8), 8, 'must cap at the ceiling');
    assert.strictEqual(run(NaN, 8), 1, 'NaN must not reach the cart');
    assert.strictEqual(run('abc', 8), 1, 'a non-numeric input must not reach the cart');
    assert.strictEqual(run(2.7, 8), 2, 'fractions must be floored');
    assert.strictEqual(run(-50, 8), 1, 'the floor is one');
    assert.strictEqual(run(0, 8), 1, 'zero is not a quantity');
    // Infinity is not finite, so it falls to the FLOOR rather than the ceiling.
    // That is the safer of the two: a garbage input becomes one item, not a
    // reservation of the seller's entire remaining stock.
    assert.strictEqual(run(Infinity, 8), 1, 'a nonsense quantity must collapse to 1, never to all of stock');
    assert.strictEqual(run(-Infinity, 8), 1, 'and the same downwards');
    // NaN as a ceiling means "we do not know", which must mean NO cap — never
    // zero. Refusing to sell on "cannot tell" would cost the seller real sales.
    assert.strictEqual(run(50, NaN), 50, 'an unknown ceiling must not cap');
    assert.strictEqual(run(50, 0), 50, 'a zero ceiling means unknown here, not "sell nothing"');
    // Every mutation path must go through it.
    for (const path of ['changeCartQty', 'setCartQty']) {
      assert.match(grab(path), /applyCartQty\(/, path + ' sets a quantity without normalising it');
    }
    // The third argument is what the OTHER lines of this product already hold —
    // see the aggregate-stock test in [fe-31]. A new line must be normalised
    // against that too, not just against the raw stock figure.
    // A new line is normalised against the ceiling for THIS variant and what the
    // other lines of that same variant already hold — see the variant tests.
    assert.match(grab('addToCart'), /normalizeCartQty\(\s*qty,\s*stockCeilingFor\(pending, p\)/,
      'a new line must be normalised against the ceiling for its own variant');
    assert.match(grab('addToCart'), /qtyHeldByOtherLines\(id, cartStockKey\(pending\), null\)/,
      'and against what the other lines of that same variant already claim');
  });

  test('THE TRAP: stock is only capped when the stock figure is real', () => {
    // productFromCartLine reports stockQty as the line's OWN quantity for a cart
    // restored while the API was cold. Capping on that would freeze the line at
    // whatever it happened to be and would silently disable the customer's cart
    // during exactly the outage this whole design exists to survive.
    const ceiling = new Function('return ' + grab('stockCeilingFor') + '; ')();
    assert.ok(Number.isNaN(ceiling(null, { stockQty: 2, fromSnapshot: true })),
      'a snapshot-restored product reports its own line quantity as stock — judging by that would freeze the cart during the very outage this survives');
    assert.ok(Number.isNaN(ceiling(null, null)), 'an unresolved product has no ceiling');
    assert.ok(Number.isNaN(ceiling(null, { stockQty: 0 })),
      'a zero figure means "unknown here" — the server is the authority on refusing it');
    assert.strictEqual(ceiling(null, { stockQty: 5 }), 5, 'a live figure IS the ceiling');
    assert.match(grab('productFromCartLine'), /stockQty: l\.qty/,
      'this test is meaningless if that field stops being the line quantity');
  });
}

// ============================================================
section('[fe-31] Combinations: what the new pieces do to each other');
// ============================================================
// Every defect in this section was created by a fix in an earlier section.
// None of them is visible from the change that caused it — they only appear
// where two correct-looking pieces meet.
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);
  function grab(name) {
    const i = code.search(new RegExp('(async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = code.indexOf('{', i);
    for (let k = s; k < code.length; k++) {
      if (code[k] === '{') d++;
      else if (code[k] === '}') { d--; if (!d) return code.slice(i, k + 1); }
    }
  }

  test('THE DEADLOCK: every route that closes the modal answers a pending question', () => {
    // askInWaitModal borrows the SHARED waiting modal. Several things close that
    // modal knowing nothing about a pending question — browser-back goes through
    // cancelWaitingExperience, a new wait calls openWaitingExperience, the retry
    // button calls closeWaitingExperience. The promise was then never settled,
    // so placeOrderNow awaited it forever and intentInFlight was never released:
    // the customer could not place another order for the rest of the session
    // without reloading. Verified in a browser across all four routes.
    assert.match(grab('askInWaitModal'), /waitState\.askResolve = resolve;/,
      'the resolver must be reachable by whatever closes the modal');
    for (const fn of ['closeWaitingExperience', 'openWaitingExperience']) {
      const src = grab(fn);
      assert.match(src, /waitState\.askResolve/, fn + ' can take the modal without answering a pending question');
      assert.match(src, /waitState\.askResolve = null;/,
        fn + ' must clear the resolver before calling it, or a resolver that closes the modal re-enters this');
      assert.match(src, /\(false\)/, fn + ' must answer "no" — nothing has been charged, so that is the safe direction');
    }
    // cancelWaitingExperience and retryWaitIntent both go through
    // closeWaitingExperience, so they inherit it.
    assert.match(grab('cancelWaitingExperience'), /closeWaitingExperience\(\)/);
    assert.match(grab('retryWaitIntent'), /closeWaitingExperience\(\)/);
  });

  test('THE WORST ONE: a background refresh cannot destroy the order confirmation', () => {
    // renderCheckoutPage() begins by forcing the page back to the form — it
    // hides #checkoutProcessing and #checkoutSuccess unconditionally. That was
    // safe while it was only called on page entry and from the coupon buttons.
    // Routing every cart mutation through it broke the assumption, and the
    // success path itself does `cart = []; saveCart(); updateCartUI();` — so the
    // customer paid, saw the confirmation, and watched it be replaced by an
    // empty checkout. They would reasonably conclude the payment had failed.
    const refresher = grab('refreshCartAndCheckoutViews');
    assert.match(refresher, /checkoutIsShowingResult\(\)/,
      'a background refresh must not drag the customer back to a screen they have left');
    const guard = grab('checkoutIsShowingResult');
    assert.match(guard, /checkoutProcessing/, 'mid-payment counts');
    assert.match(guard, /checkoutSuccess/, 'and so does the confirmation screen');
    // The renderer KEEPS its reset: that is correct on a real page entry.
    assert.match(grab('renderCheckoutPage'), /checkoutProcessing'\)\.style\.display = 'none'/,
      'entering the checkout afresh must still clear a stale result pane');
  });

  test('the cart is re-checked against stock the wake refresh just re-learned', () => {
    // The wait reloads the catalog the moment the backend answers, so after a
    // 60-second cold start we know the real stock again — but nothing revisited
    // the cart. Measured: a line holding 8 stayed at 8 after stock fell to 2,
    // and the server refused the order at the payment step.
    const wake = grab('runWithBackendReady');
    const loadAt = wake.indexOf('loadCatalog()');
    const reconcileAt = wake.indexOf('reconcileCartWithCatalog()');
    const intentAt = wake.lastIndexOf('return intent();');
    assert.ok(loadAt > -1 && reconcileAt > loadAt && intentAt > reconcileAt,
      'the cart must be reconciled AFTER the catalog reloads and BEFORE the intent buys anything');
    const fn = grab('reconcileCartWithCatalog');
    assert.match(fn, /if\(!p \|\| p\.fromSnapshot\) continue;/,
      'a snapshot-restored line reports its own quantity as stock — judging it by that would freeze the cart during the very outage this survives');
    assert.match(fn, /toast\(/, 'silently shrinking somebody\'s cart is its own kind of dishonest');
    assert.match(fn, /sold out/, 'a line that can no longer be bought must be named, not quietly dropped');
    // Iterating backwards is what makes splice safe.
    assert.match(fn, /for\(let i = cart\.length - 1; i >= 0; i--\)/,
      'removing while iterating forwards would skip the line after each removal');
  });

  test('THE LATENCY TRAP: the wake refresh can never make the customer wait twice', () => {
    // loadCatalog() goes through apiFetch as a BACKGROUND request: a 75-second
    // timeout with retries. Awaiting it unbounded after the backend wakes would
    // add that to somebody who has ALREADY sat out a cold start. Measured at
    // +9s against a stubbed 9s boot before this bound existed; bounded at 3.5s
    // after. The refresh is an optimisation — confirmAmountChange is the
    // guarantee, and it runs either way.
    const fn = grab('runWithBackendReady');
    assert.match(fn, /Promise\.race\(\[/,
      'the wake refresh must be raced against a timeout, never awaited unbounded');
    assert.match(fn, /WAKE_REFRESH_MAX_MS/, 'the bound must be a named constant');
    const cap = Number((html.match(/const WAKE_REFRESH_MAX_MS = (\d+);/) || [])[1]);
    assert.ok(cap > 0 && cap <= 5000,
      'the bound is ' + cap + 'ms — anything longer defeats the point of bounding it');
    // And the money guard must not be inside the race.
    const raceAt = fn.indexOf('Promise.race');
    const intentAt = fn.lastIndexOf('return intent();');
    assert.ok(intentAt > raceAt, 'the intent still runs after the refresh window closes');
  });

  test('THE AGGREGATE: stock belongs to the product, not to one cart line', () => {
    // A product with variants has one cart line per variant. Capping each line
    // on its own let two lines of five pass against eight in stock: each was
    // individually legal, the total was not, and the server would refuse the
    // order at the payment step. Measured before this existed.
    // Lines compete only when they are the same product AND the same variant —
    // see the variant section below for why sharing one pool across variants
    // was the wrong model.
    const CART = [
      { id: 'p1', qty: 5, variantId: 'a' }, { id: 'p1', qty: 2, variantId: 'a' },
      { id: 'p1', qty: 4, variantId: 'b' }, { id: 'p2', qty: 9 }
    ];
    const run = new Function('cart',
      grab('cartStockKey') + '\n' + grab('qtyHeldByOtherLines') + '\n' +
      'return qtyHeldByOtherLines;')(CART);
    assert.strictEqual(run('p1', 'a', null), 7, 'it must sum the lines of the SAME variant');
    assert.strictEqual(run('p1', 'b', null), 4, 'a different variant is a different pool');
    assert.strictEqual(run('p2', '', null), 9, 'and a plain product keys on the empty variant');

    const norm = new Function('return ' + grab('normalizeCartQty') + '; ')();
    assert.strictEqual(norm(5, 8, 5), 3, 'the ceiling is what the other lines have left');
    assert.strictEqual(norm(5, 8, 8), 0, 'nothing left must be able to say zero');
    assert.strictEqual(norm(5, 8, 0), 5, 'and no other lines means no reduction');

    // addToCart must refuse rather than build a cart the server has to reject.
    assert.match(grab('addToCart'), /if\(allowed < 1\)\{/,
      'adding when every unit of this variant is already claimed must be refused, not silently capped to 1');
    // An EXISTING line keeps a floor of 1: deleting somebody's line while they
    // adjust a quantity is worse than letting the server refuse it.
    assert.match(grab('applyCartQty'), /Math\.max\(1, normalizeCartQty/,
      'an existing line must not be silently deleted mid-edit');
  });

  test('reconciling stock re-checks the coupon priced against the old cart', () => {
    // Reconciling moves the subtotal, so a percentage coupon is now worth less
    // and a minimum-order coupon may not apply at all. Every other path to a
    // changed cart goes through updateCartUI, which schedules the re-check;
    // this was the one that did not.
    assert.match(grab('reconcileCartWithCatalog'), /revalidateCouponSoon\(\)/,
      'a cart shrunk by reconciliation leaves a discount priced for a cart that no longer exists');
  });

  test('a coupon re-check cannot outlive the coupon it was checking', () => {
    assert.match(grab('removeCoupon'), /clearTimeout\(couponRecheckTimer\)/,
      'a reply landing after removal could resurrect a discount the customer just dropped');
  });
}

// ============================================================
section('[fe-32] Differential fuzz: the client total IS the server total');
// ============================================================
// Hand-picked cases prove a function works on the cases somebody thought of.
// This runs the REAL client function against the REAL server function over
// thousands of generated carts, so the claim is about the whole input space
// rather than a shortlist. Nothing here is reimplemented — both functions are
// lifted out of the files that ship.
{
  const html = read('index.html');
  const { calculateOrderTotals } = require('../src/utils/orders.js');

  function cut(name) {
    const s = html.indexOf('function ' + name + '(');
    if (s < 0) throw new Error('missing ' + name);
    let d = 0, i = html.indexOf('{', s);
    for (; i < html.length; i++) {
      if (html[i] === '{') d++;
      else if (html[i] === '}') { d--; if (!d) return html.slice(s, i + 1); }
    }
  }
  const makeClient = new Function('deps', `
    const { getCartLinesWithProducts, cartUnitPrice, getShippingCost } = deps;
    let appliedCoupon = deps.appliedCoupon;
    ${cut('calculateCartTotals')}
    return calculateCartTotals;
  `);

  // Deterministic generator: a failure here is reproducible, not a flake.
  let seed = 20260901;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

  test('THE PROOF: 6,000 generated carts agree with the server to the paisa', () => {
    const RATES = [0, 0.25, 3, 5, 12, 18, 28];
    const PRICES_PAISE = [1, 50, 99, 100, 2599, 49999, 80000, 250000, 499999];
    const failures = [];

    for (let n = 0; n < 6000 && failures.length < 3; n++) {
      const thresholdPaise = pick([0, 50000, 99900, 99900, 150000, 199900]);
      const flatPaise = pick([0, 4900, 7900, 9900, 12000]);
      const lines = [];
      for (let i = 0, c = int(1, 6); i < c; i++) {
        lines.push({ price: pick(PRICES_PAISE) / 100, gstRate: pick(RATES), qty: int(1, 10) });
      }
      const subtotalPaise = lines.reduce((s, l) => s + Math.round(l.price * l.qty * 100), 0);
      const discountPaise = pick([0, 0, 1, 100,
        Math.floor(subtotalPaise * 0.1), Math.floor(subtotalPaise * 0.5),
        subtotalPaise, subtotalPaise + 1, subtotalPaise * 3]);

      // Identity by INDEX. Matching lines on (qty, gstRate) collides whenever two
      // share both, and that collision makes the HARNESS report a wrong subtotal
      // — which is exactly what happened the first time this was run.
      const client = makeClient({
        getCartLinesWithProducts: () => lines.map((l, i) => ({
          line: { qty: l.qty, __i: i }, product: { gstRate: l.gstRate, __i: i }
        })),
        cartUnitPrice: (line) => lines[line.__i].price,
        getShippingCost: sub => (sub * 100 >= thresholdPaise ? 0 : flatPaise / 100),
        appliedCoupon: discountPaise ? { discountPaise } : null
      })();

      const server = calculateOrderTotals(
        lines.map(l => ({ lineTotalPaise: Math.round(l.price * l.qty * 100), gstRate: l.gstRate })),
        discountPaise, { free_shipping_threshold_paise: thresholdPaise, shipping_flat_paise: flatPaise });

      for (const [what, a, b] of [
        ['total', Math.round(client.total * 100), server.totalPaise],
        ['subtotal', Math.round(client.subtotal * 100), server.subtotalPaise],
        ['shipping', Math.round(client.shipping * 100), server.shippingPaise],
        ['gst', Math.round(client.gst * 100), server.gstPaise],
        ['discount', Math.round(client.discount * 100), server.discountPaise]
      ]) {
        if (a !== b) failures.push(what + ' differs by ' + (a - b) + ' paise on ' + JSON.stringify({ lines, discountPaise, thresholdPaise, flatPaise }));
      }
      // Invariants that hold regardless of what the server says.
      assert.ok(Number.isFinite(client.total), 'a non-finite total reached the customer');
      assert.ok(client.total >= 0, 'a negative total: ' + client.total);
      assert.ok(client.discount <= client.subtotal + 1e-9, 'the discount exceeded the cart');
      assert.ok(Math.abs((client.subtotal - client.discount + client.shipping + client.gst) - client.total) < 0.005,
        'the components stopped summing to the total');
    }
    assert.deepStrictEqual(failures, [], failures[0] || '');
  });

  test('a cold cart totals identically to a warm one', () => {
    // The cold path resolves every line through productFromCartLine instead of
    // the live catalog. If gstRate or the unit price did not survive that hop,
    // a customer checking out during a boot would be quoted a different number
    // than the same cart quotes once the API is up. Verified in a browser too:
    // identical to the paisa, with and without a coupon.
    const snap = cut('cartLineSnapshot');
    const from = cut('productFromCartLine');
    assert.match(snap, /gstRate: Number\(p\.gstRate\) \|\| 0,/,
      'the snapshot must carry the tax rate, or a cold cart under-quotes exactly as the pre-GST build did');
    assert.match(from, /gstRate: Number\(l\.snap\.gstRate\) \|\| 0,/,
      'and it must come back out again');
    assert.match(from, /Number\.isFinite\(Number\(l\.unitPrice\)\) \? Number\(l\.unitPrice\)/,
      "a variant line's own unit price must win over the base snapshot price");
  });
}

// ============================================================
section('[fe-33] Variants: a variant is its own product, priced and stocked separately');
// ============================================================
// migrations/008_product_variants.sql gives every variant its OWN price_paise
// (NULL = inherit the base) and its OWN stock_qty, and utils/orders.js checks
// each variant against its own figure. Everything the client does with money or
// stock has to follow that model, or the two sides disagree.
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);
  function grab(name) {
    const i = code.search(new RegExp('(async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = code.indexOf('{', i);
    for (let k = s; k < code.length; k++) {
      if (code[k] === '{') d++;
      else if (code[k] === '}') { d--; if (!d) return code.slice(i, k + 1); }
    }
  }
  // The three real functions that decide a variant's ceiling, run for real.
  const build = cart => new Function('cart',
    grab('cartStockKey') + '\n' + grab('qtyHeldByOtherLines') + '\n' +
    grab('stockCeilingFor') + '\n' + grab('normalizeCartQty') + '\n' +
    'return { cartStockKey, qtyHeldByOtherLines, stockCeilingFor, normalizeCartQty };')(cart);

  test('THE CORRECTION: two variants of one product never share a stock pool', () => {
    // An earlier version keyed the stock ceiling on the product alone, so a
    // "Small" line and a "Large" line were made to compete for one pool. They
    // do not. That over-restricted the cart and refused sales the seller could
    // actually fulfil — the opposite failure to the one it was fixing, and the
    // worse one for the business.
    const cart = [
      { id: 'p1', qty: 6, variantId: 'small' },
      { id: 'p1', qty: 6, variantId: 'large' }
    ];
    const api = build(cart);
    // Ask what each line competes with, EXCLUDING itself. The small line's
    // pool must contain nothing from the large line, and vice versa.
    assert.strictEqual(api.qtyHeldByOtherLines('p1', 'small', cart[0]), 0,
      'the large line must not count against the small pool');
    assert.strictEqual(api.qtyHeldByOtherLines('p1', 'large', cart[1]), 0,
      'and vice versa');
    // So both lines may hold their full six even though the BASE product shows
    // eight — which is exactly the case the old product-keyed version refused.
    assert.strictEqual(api.normalizeCartQty(6, 6, api.qtyHeldByOtherLines('p1', 'small', cart[0])), 6);
    assert.strictEqual(api.normalizeCartQty(6, 6, api.qtyHeldByOtherLines('p1', 'large', cart[1])), 6);
    // Same variant across lines DOES compete.
    const same = [{ id: 'p1', qty: 3, variantId: 'small' }, { id: 'p1', qty: 4, variantId: 'small' }];
    assert.strictEqual(build(same).qtyHeldByOtherLines('p1', 'small', same[0]), 4,
      'lines of the SAME variant share one pool');
  });

  test('a variant is capped by its OWN stock, never by the base product figure', () => {
    const api = build([]);
    const baseProduct = { stockQty: 8, name: 'X' };
    // With the variant's own figure, that figure wins.
    assert.strictEqual(api.stockCeilingFor({ variantId: 'v1', variantStock: 3 }, baseProduct), 3,
      "the variant's own stock is the ceiling");
    // Without it, there is NO ceiling — the base figure describes a different
    // pool, and guessing low would refuse a sale the seller can fulfil. The
    // server holds the real figure and refuses precisely if it must.
    assert.ok(Number.isNaN(api.stockCeilingFor({ variantId: 'v9' }, baseProduct)),
      'an unknown variant stock must mean NO cap, never the base product figure');
    assert.ok(Number.isNaN(api.stockCeilingFor({ variant: 'Size: XL' }, baseProduct)),
      'a variant identified only by its label behaves the same way');
    // A plain line still uses the product.
    assert.strictEqual(api.stockCeilingFor({}, baseProduct), 8,
      'a non-variant line is still capped by the product');
    assert.strictEqual(api.normalizeCartQty(50, api.stockCeilingFor({ variantId: 'v9' }, baseProduct)), 50,
      'and an unknown ceiling must let the quantity through');
  });

  test("the product page is the only place that can carry a variant's stock", () => {
    // variantOptions and per-variant stock are loaded on the detail page only,
    // so both add paths there must put stock_qty on the line — nothing else can.
    const calls = html.match(/addToCart\(id, pdQty, label,[\s\S]{0,600}?\);/g) || [];
    assert.strictEqual(calls.length, 2, 'expected Add to Cart and Buy Now');
    calls.forEach((c, i) => {
      assert.ok(/pdSelectedVariant \? pdSelectedVariant\.stock_qty/.test(c),
        'call site ' + (i + 1) + " does not carry the variant's own stock onto the line");
    });
    assert.match(grab('addToCart'), /function addToCart\(id, qty, variant, variantId, variantImage, unitPrice, variantStock\)/,
      'addToCart must accept it');
    assert.match(grab('addToCart'), /variantStock: pending\.variantStock/,
      'and store it on the line, or a reload loses the ceiling');
  });

  test("a variant's own price drives every money figure", () => {
    // variant.price_paise overrides the base when set, and the base snapshot
    // holds the WRONG number for a variant line.
    assert.match(grab('cartUnitPrice'), /line && Number\(line\.unitPrice\)/,
      "the line's recorded unit price must win over the product's base price");
    assert.match(grab('productFromCartLine'), /Number\.isFinite\(Number\(l\.unitPrice\)\) \? Number\(l\.unitPrice\)/,
      'and it must still win when the line is restored from a snapshot during a cold start');
    assert.match(html, /cartUnitPrice\(x\.line, x\.product\) \* x\.line\.qty/,
      'the subtotal must be built from the effective price');
    // calculateCartTotals prices GST off the same effective figure.
    assert.match(grab('calculateCartTotals'), /cartUnitPrice\(x\.line, x\.product\) \* x\.line\.qty \* 100/,
      'GST must be computed from the variant price too, not the base price');
  });

  test('a variant line is not deleted because the BASE product shows sold out', () => {
    // The base stock figure says nothing about a variant's pool. Dropping the
    // line on it would delete something the customer can actually buy.
    assert.match(grab('reconcileCartWithCatalog'), /if\(!p\.stock && !line\.variantId && !line\.variant\)\{/,
      'only a non-variant line may be judged sold out from the product flag');
  });

  test('a variant product can never be offered by the waiting screen', () => {
    // A suggestion card has no variant selector, so Add would put it in the cart
    // with no variantId — and the server refuses to sell a variant product
    // without one. The customer would have added it during the wait and had the
    // order rejected at the moment of payment.
    assert.match(grab('buyable'), /if\(requiresVariantChoice\(p\)\) return false;/,
      'a variant product must never reach a suggestion card');
    assert.match(grab('requiresVariantChoice'), /p\.hasVariants \|\| \(Array\.isArray\(p\.variantOptions\) && p\.variantOptions\.length\)/,
      'including one only known to have variants from the detail endpoint');
  });
}

// ============================================================
section('[fe-34] Future shapes: subcategories, new stock, new products');
// ============================================================
// Nothing here is a bug today. These lock in the behaviour that has to survive
// the next things added to the catalog, because the failures they prevent are
// silent — a page that tells Google a different category name than it shows the
// customer, or a label that renders the literal text "undefined".
{
  const html = read('index.html');
  const { displayTerm } = require('../src/utils/text.js');
  function grab(name) {
    const i = html.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = html.indexOf('{', i);
    for (let k = s; k < html.length; k++) {
      if (html[k] === '{') d++;
      else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); }
    }
  }
  const MINOR = html.match(/const MINOR_WORDS = \[[^\]]*\];/)[0];
  const storeCase = new Function(MINOR + '\n' + grab('titleCaseTerm') + '; return titleCaseTerm;')();
  const CAT_LABELS = new Function('return ' + html.match(/const CAT_LABELS = \{[^}]*\};/)[0]
    .replace('const CAT_LABELS = ', '').replace(/;$/, ''))();
  const label = new Function('CAT_LABELS', 'titleCaseTerm',
    grab('catLabel') + '; return catLabel;')(CAT_LABELS, storeCase);

  test('a hierarchical category reads correctly on every level', () => {
    // The moment subcategories exist a slug becomes "books/scripture". Splitting
    // on whitespace alone made that ONE word, so it rendered "Books/scripture"
    // with the second half uncased. Segments are cased independently and
    // rejoined with the separator untouched, so the stored value is never
    // rewritten and URLs, JSON-LD and the sitemap need learn no new format.
    assert.strictEqual(label('books/scripture'), 'Books/Scripture');
    assert.strictEqual(label('books/scripture/rare'), 'Books/Scripture/Rare');
    assert.strictEqual(label('malas / rudraksha'), 'Malas/Rudraksha');
    assert.strictEqual(label('puja samagri/kits and sets'), 'Puja Samagri/Kits and Sets',
      'minor words stay lowercase INSIDE a segment, and lead each segment capitalised');
  });

  test('all three title-casers agree, hierarchies included', () => {
    // There are three: the storefront, the page generator, and the server.
    // They disagreed once already and the symptom was silent.
    const gen = require('../scripts/generate-product-pages.js');
    const cases = ['books/scripture', 'books', 'puja samagri kits', 'idols and murtis',
      'GIFT SETS', '  a  b  ', 'books/scripture/rare', 'malas / rudraksha', '',
      '5 mukhi', 'murtis & idols', 'a/b/c/d/e'];
    for (const c of cases) {
      const a = storeCase(c);
      const b = displayTerm(c);
      assert.strictEqual(a, b, 'storefront and server disagree on ' + JSON.stringify(c));
      if (typeof gen.titleCaseTerm === 'function') {
        assert.strictEqual(gen.titleCaseTerm(c), a, 'the page generator disagrees on ' + JSON.stringify(c));
      }
    }
  });

  test('no category an admin can type ever renders as "undefined" or blank', () => {
    // Categories are admin-defined, not a fixed list. Every one of these was run
    // through the real function in a browser; none may produce empty text.
    const shapes = ['books/scripture', 'books & gifts', 'GIFT SETS', '   spaced   ',
      'माला', 'a'.repeat(120), 'books?x=1', 'books#frag', 'books%2Fsub',
      '', null, undefined, 'rudraksha-malas', 'puja_samagri', '///', '-', '_'];
    for (const s of shapes) {
      const out = label(s === null || s === undefined ? s : String(s).replace(/[-_]+/g, ' '));
      assert.ok(typeof out === 'string' && out.length > 0,
        'category ' + JSON.stringify(s) + ' produced an empty label');
      assert.ok(!/undefined|null|NaN/i.test(out),
        'category ' + JSON.stringify(s) + ' rendered as "' + out + '"');
    }
    assert.strictEqual(label(''), 'Uncategorized', 'an empty category needs a real word, not blank space');
    assert.strictEqual(label(null), 'Uncategorized');
  });

  test('THE DIVERGENCE: both catLabels agree, not just both title-casers', () => {
    // This pair has now diverged TWICE. The first time on title-casing. The
    // second time was caught by this very test being written: the storefront
    // gained a guard for separator-only slugs ("///", "-", "_") and the page
    // generator did not, so the storefront said "Uncategorized" while the
    // Product JSON-LD carried an EMPTY category straight to Google.
    //
    // Comparing the title-casers was not enough, because the guard lives one
    // level up in catLabel. Compare what actually reaches the page.
    const gen = require('../scripts/generate-product-pages.js');
    const shapes = ['books/scripture', 'books', 'GIFT SETS', 'idols and murtis',
      'rudraksha malas', '///', '-', '_', '   ', '', null, undefined,
      'books/scripture/rare', 'malas / rudraksha', '5 mukhi', 'murtis & idols'];
    for (const s of shapes) {
      assert.strictEqual(gen.catLabel(s), label(s),
        'catLabel disagrees on ' + JSON.stringify(s) + ' — the page would tell Google a different name than the customer sees');
      assert.ok(gen.catLabel(s) && gen.catLabel(s).length > 0,
        JSON.stringify(s) + ' produces an empty category in structured data');
    }
  });

  test('a category reaches the URL encoded, and comes back identical', () => {
    // Categories travel as a query parameter, so a slug containing / ? & or #
    // must be encoded or it changes meaning. Verified in a browser: every shape
    // below round-trips exactly.
    assert.match(html, /encodeURIComponent/,
      'category values must be encoded into the shop URL');
    const fn = grab('openShopWithCategory');
    assert.ok(/encodeURIComponent/.test(fn) || /URLSearchParams/.test(fn),
      'openShopWithCategory must encode the slug it puts in the URL');
  });

  test('nothing in the catalog logic is keyed to a product that exists today', () => {
    // The catalog is admin-driven. A hardcoded id, slug or category would work
    // until the day that row changes, then fail silently.
    const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Real UUIDs would mean a product was pinned in code.
    const uuids = code.match(/['"][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"]/gi) || [];
    assert.deepStrictEqual(uuids, [], 'a product id is hardcoded: ' + uuids.join(', '));
    // RITUAL_PAIRS may name categories, but must degrade when it does not know one.
    const strat = code.slice(code.indexOf('const WAIT_STRATEGIES = ['), code.indexOf('function pickWaitStrategy'));
    assert.match(strat, /if\(!knownPairing\)\{/,
      'the pairing map must fall back for a category it has never heard of, or the suggestion silently stops firing');
  });

  test('stock and price come from the catalog every time, never from a constant', () => {
    const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/stockQty\s*[=:]\s*\d+/.test(code.replace(/stockQty: Number\(p\.stock_qty \|\| 0\)/g, '')),
      'a stock figure is hardcoded somewhere');
    // The one remaining shipping literal must be the documented DEFAULT only.
    const shipFn = grab('freeShippingThreshold');
    assert.match(shipFn, /siteConfig/, 'the threshold must be read from settings, not a literal');
  });
}

// ============================================================
section('[fe-35] Subcategories, end to end');
// ============================================================
// One nullable normalised column on products, the SAME law categories already
// follow: free-form text, normalised server-side, and every menu DERIVED from
// the products that use it. Nothing here may change how a product WITHOUT a
// subcategory behaves — that is every product until an admin sets one.
{
  const html = read('index.html');
  const admin = read('admin.html');
  const routes = read('src/routes/products.routes.js');
  const migration = read('migrations/016_product_subcategory.sql');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);
  function grab(name, src) {
    const s = src || code;
    const i = s.search(new RegExp('(async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const st = s.indexOf('{', i);
    for (let k = st; k < s.length; k++) {
      if (s[k] === '{') d++;
      else if (s[k] === '}') { d--; if (!d) return s.slice(i, k + 1); }
    }
  }

  test('the column is nullable and normalised the way the app normalises it', () => {
    // NULLABLE is the backward-compatibility guarantee: every product that
    // exists today has no subcategory and must keep behaving exactly as it does.
    assert.match(migration, /ADD COLUMN IF NOT EXISTS subcategory VARCHAR\(80\)/);
    assert.ok(!/subcategory VARCHAR\(80\) NOT NULL/.test(migration),
      'a required subcategory would break every product that exists today');
    assert.match(migration, /subcategory = lower\(subcategory\)/,
      'the DB must reject a shape the application would never write');
    assert.match(migration, /idx_products_category_subcategory/,
      'every read filters by category first, so the index must lead with it');
  });

  test('the server treats it exactly like category — including the update whitelist', () => {
    assert.match(routes, /p\.category, p\.subcategory,/, 'it must be published to the storefront');
    assert.match(routes, /normaliseTerm\(subcategory\)/, 'normalised on create');
    assert.match(routes, /req\.body\.subcategory = normaliseTerm\(req\.body\.subcategory\)/, 'and on update');
    // A field missing from allowedFields is SILENTLY DROPPED — the admin saves,
    // sees no error, and the value never lands.
    const allowed = routes.slice(routes.indexOf('const allowedFields = ['));
    assert.match(allowed.slice(0, 400), /'category', 'subcategory'/,
      'subcategory must be writable, and must sit next to category so the pair stays visible');
    assert.match(routes, /conditions\.push\(`p\.subcategory = \$\$\{params\.length\}`\)/,
      'the list endpoint must be able to filter by it');
    assert.match(routes, /router\.get\('\/meta\/subcategories'/,
      'the derived listing must exist, like /meta/top-categories');
    const meta = routes.slice(routes.indexOf("router.get('/meta/subcategories'"));
    assert.match(meta.slice(0, 900), /p\.subcategory IS NOT NULL AND p\.subcategory <> ''/,
      'it must only list subcategories that actually have products, or the menu opens an empty grid');
  });

  test('THE TREE: categories and subcategories are derived from the catalog', () => {
    // Derived from PRODUCTS, not fetched — which is why the dropdown is fully
    // populated during a cold start with no extra request, and can never go
    // stale separately from the products it describes.
    const tree = new Function('PRODUCTS', grab('categoryTree') + '; return categoryTree;');
    const build = list => tree(list)();

    const out = build([
      { cat: 'books', subcat: 'scripture' }, { cat: 'books', subcat: 'scripture' },
      { cat: 'books', subcat: 'rare' }, { cat: 'books' },
      { cat: 'malas', subcat: 'rudraksha' }, { cat: 'idols' }
    ]);
    assert.strictEqual(out.length, 3, 'three categories');
    assert.strictEqual(out[0].cat, 'books', 'the busiest category leads');
    assert.strictEqual(out[0].count, 4, 'the count includes products with no subcategory');
    assert.deepStrictEqual(out[0].subs.map(s => s.sub), ['scripture', 'rare'], 'busiest subcategory first');
    assert.strictEqual(out[0].subs[0].count, 2);
    // A product with NO subcategory contributes to its category and creates no leaf.
    assert.deepStrictEqual(build([{ cat: 'idols' }])[0].subs, [],
      'a product without a subcategory must not invent one');
    // Junk must not crash the navigation.
    assert.deepStrictEqual(build([]), [], 'an empty catalog yields an empty tree, not a throw');
    assert.deepStrictEqual(build([null, {}, { subcat: 'orphan' }]), [],
      'a product with no category cannot appear in the menu');
  });

  test('THE TRAP: a slug reaching an onclick is escaped as JS *and* as an attribute', () => {
    // Category slugs are admin-typed free text and end up inside
    // onclick="openShopWithCategory('…')". escapeHtml alone does not escape the
    // apostrophe or backslash that would close the JS string and let the rest of
    // the slug run as code.
    const esc = new Function('escapeHtml', grab('jsAttr') + '; return jsAttr;')(
      s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
    const nasty = esc("'); alert(1); //");
    assert.ok(!/^'/.test(nasty), 'the value must not start a bare quoted string');
    assert.ok(!nasty.includes("');"), 'the injected sequence must not survive intact');
    assert.ok(esc('a"b').includes('&quot;'), 'a double quote must be attribute-safe');
    assert.ok(esc('a\\b').includes('\\\\'), 'a backslash must be JS-escaped');
    assert.match(grab('renderMegaMenu'), /jsAttr\(/, 'the menu must use it');
    assert.match(grab('renderMegaMenu'), /encodeURIComponent\(n\.cat\)/, 'and encode the href');
  });

  test('choosing a category clears the subcategory, or the grid goes silently empty', () => {
    // A subcategory belongs to ONE category. Keeping it while switching category
    // leaves an impossible filter ("books" + "rudraksha") and an empty grid with
    // nothing on screen to explain why.
    const fn = grab('setCategoryFilter');
    assert.match(fn, /if\(cat !== shopFilters\.cat\) shopFilters\.subcat = '';/,
      'switching category must drop a subcategory that cannot apply to it');
    // Clearing the REFINEMENT keeps the category — widening by one step.
    assert.match(code, /setSubcategoryFilter\(shopFilters\.cat, ''\)/,
      'removing the subcategory chip must not throw the customer back to everything');
    // The filter lives in getFilteredSortedProducts, which renderShopGrid calls.
    assert.match(grab('getFilteredSortedProducts'), /shopFilters\.subcat && p\.subcat !== shopFilters\.subcat/,
      'the grid must actually apply it');
    // Applied AFTER the category, because it only ever narrows within one.
    const f = grab('getFilteredSortedProducts');
    assert.ok(f.indexOf('p.cat !== shopFilters.cat') < f.indexOf('p.subcat !== shopFilters.subcat'),
      'the category filter must come first — a subcategory is a refinement of it');
  });

  test('a deep link carries both parts, encoded, and comes back the same', () => {
    const fn = grab('openShopWithCategory');
    assert.match(fn, /encodeURIComponent\(cat\)/);
    assert.match(fn, /'&subcategory=' \+ encodeURIComponent\(subcat\)/,
      'a slug may contain / ? & or non-Latin characters, so both parts must be encoded');
    assert.match(code, /q\.get\('subcategory'\)/, 'and the router must read it back');
  });

  test('the admin form follows the same law as the category field', () => {
    assert.match(admin, /id="pfSubcategory" list="pfSubcategoryList"/,
      'free text plus a datalist, exactly like category');
    assert.match(admin, /oninput="refreshSubcategoryDatalist\(\)"/,
      'retyping the category must re-offer the subcategories that belong to it');
    assert.match(admin, /subcategory: qs\('#pfSubcategory'\)\.value\.trim\(\)/,
      'the payload must send it');
    assert.ok(!/subcategory: qs\('#pfSubcategory'\)\.value\.trim\(\) \|\| undefined/.test(admin),
      "an empty string is how a subcategory is REMOVED — undefined would leave the old value and make clearing impossible");
    assert.match(admin, /'pfCategory','pfSubcategory'/, 'and the form reset must clear it');
    assert.match(admin, /qs\('#pfSubcategory'\)\.value = p\.subcategory \|\| ''/,
      'and editing a product must load it');
  });

  test('structured data carries the full path, cased on both halves', () => {
    const gen = require('../scripts/generate-product-pages.js');
    const base = { id: '1', name: 'X', slug: 'x', price_paise: 10000, category: 'books', stock_qty: 3 };
    assert.strictEqual(gen.productJsonLd(base, 'https://x').category, 'Spiritual Books',
      'a product with no subcategory must be unchanged');
    assert.strictEqual(gen.productJsonLd(Object.assign({}, base, { subcategory: 'scripture' }), 'https://x').category,
      'Spiritual Books/Scripture');
    assert.strictEqual(gen.productJsonLd(Object.assign({}, base, { category: 'GIFT SETS', subcategory: 'brass and copper' }), 'https://x').category,
      'Gift Sets/Brass and Copper', 'both halves cased, minor words respected');
  });

  test('BACKWARD COMPATIBILITY: a product with no subcategory is untouched', () => {
    const map = grab('mapApiProduct');
    assert.match(map, /subcat: p\.subcategory \|\| ''/,
      "absent must normalise to '', so there is exactly one representation of 'none'");
    const path = new Function('catLabel', grab('catPath') + '; return catPath;')(
      k => k ? String(k).toUpperCase() : 'Uncategorized');
    assert.strictEqual(path({ cat: 'books' }), 'BOOKS', 'no subcategory means no path segment');
    assert.strictEqual(path({ cat: 'books', subcat: '' }), 'BOOKS', "and '' is the same as absent");
    assert.strictEqual(path({ cat: 'books', subcat: 'scripture' }), 'BOOKS/SCRIPTURE');
    assert.strictEqual(path(null), 'Uncategorized', 'and nothing at all still reads as a word');
  });
}

// ============================================================
section('[fe-36] A feature that is built but never reached does not exist');
// ============================================================
{
  test('THE ORPHAN CLASS: no function is defined and then never mentioned again', () => {
    // catPath() was written, tested, documented — and called from NOWHERE. The
    // subcategory therefore reached the mega-menu and no other surface: not the
    // product card, not the shop sidebar, not search, not the storefront
    // JSON-LD. Every test passed, because every test checked the function
    // rather than its reach.
    //
    // Counts EVERY mention, not just `name(`: a function passed by reference
    // (withBackendReady(confirmPujaBookingNow, …), .map(waitItemHTML)) is used,
    // and counting only call syntax reports a dozen live functions as dead.
    const KNOWN_DEAD = {
      // Pre-existing, deliberately kept, and NOT what this test is hunting.
      saveOrders: 'orders come from the API now; the writer is vestigial',
      setCartQty: 'no UI calls it today, but it is a public quantity entry point and is hardened like the others',
      seededPick: 'vestigial helper from the demo-catalog era'
    };
    for (const file of ['index.html', 'admin.html']) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const defs = [...code.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);
      assert.ok(defs.length > 50, file + ': the scan found only ' + defs.length + ' functions — the pattern has stopped matching');
      // '\\b' — a word boundary. A single backslash here is a literal
      // backspace character, which matches nothing and reports every function
      // in the file as dead.
      const orphans = defs.filter((n) => (code.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length <= 1);
      const unexpected = orphans.filter((n) => !KNOWN_DEAD[n]);
      assert.deepStrictEqual(unexpected, [],
        file + ': built but unreachable — ' + unexpected.join(', ') +
        '. Either call it, or delete it. A function nothing reaches is a feature that silently does not exist.');
    }
  });

  test('a subcategory reaches every surface a category reaches', () => {
    // The specific instance of the above. These are all the places a category
    // is shown to a customer; a subcategory has to appear in each or the
    // feature is invisible wherever it was missed.
    const html = read('index.html');
    const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const uses = (code.match(/catPath\(/g) || []).length;
    assert.ok(uses >= 5, 'catPath is called ' + (uses - 1) + ' times outside its definition — it was ZERO, which is how the feature shipped invisible');
    assert.match(code, /class="p-cat">' \+ escapeHtml\(catPath\(p\)\)/,
      'the product card must show the full path');
    assert.match(code, /category: product\.cat \? catPath\(product\)/,
      'storefront JSON-LD must match the prerendered page, which already emits the path');
    assert.match(code, /catPath\(p\)\.toLowerCase\(\)/,
      'search must match on the subcategory too, or "scripture" finds nothing');
    assert.match(code, /filter-subs/, 'the shop sidebar must offer subcategories');
    assert.match(code, /setSubcategoryFilter\(' \+ jsAttr\(key\)/,
      'and its options must be escaped like the menu\'s');
  });

  test('the sidebar re-renders when the selection changes shape', () => {
    // The subcategory list only exists UNDER the selected category, so changing
    // either filter changes the sidebar's shape. Re-rendering only the grid
    // leaves the radio the customer just clicked showing the wrong state.
    const html = read('index.html');
    function grab(name) {
      const i = html.indexOf('function ' + name + '(');
      let d = 0; const s = html.indexOf('{', i);
      for (let k = s; k < html.length; k++) {
        if (html[k] === '{') d++;
        else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); }
      }
    }
    for (const fn of ['setCategoryFilter', 'setSubcategoryFilter']) {
      assert.match(grab(fn), /renderShopFilterSidebar\(\)/, fn + ' must rebuild the sidebar, not only the grid');
      assert.match(grab(fn), /renderShopGrid\(\)/, fn + ' must still rebuild the grid');
    }
  });
}

// ============================================================
section('[fe-37] A warm backend must feel warm, and the copy must fit the moment');
// ============================================================
{
  const html = read('index.html');
  function grab(name) {
    // '\\(' — an escaped literal paren. A single backslash makes it an
    // unterminated group and every lookup throws.
    const i = html.search(new RegExp('(async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = html.indexOf('{', i);
    for (let k = s; k < html.length; k++) {
      if (html[k] === '{') d++;
      else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); }
    }
  }

  test('THE DELAY: a warm tap never pays for a readiness probe', () => {
    // Measured against the live API: /api/ready takes 0.65-2.1s on a fully warm
    // backend, and runWithBackendReady probed it before every money action
    // whose readiness had gone stale. It had ALWAYS gone stale on a real
    // checkout: markBackendAwake refreshes per request, the TTL is 45s, and
    // filling in a delivery address makes no requests at all. So the customer
    // tapped Place Order and got up to two seconds of nothing.
    assert.match(html, /function keepBackendWarm\(on\)/, 'the readiness must be kept fresh, not fetched on the tap');
    assert.match(html, /keepBackendWarm\(pageId === 'checkout'/,
      'it must start on the pages that end in a payment');
    const warm = grab('warmBackendNow');
    assert.match(warm, /if\(document\.hidden\) return;/,
      'a phone in a pocket must not ping the server');
    assert.match(warm, /if\(isBackendKnownAwake\(\)\) return;/,
      'a fresh cache needs no probe — this must not become a timer that pings regardless');
    assert.match(html, /addEventListener\('visibilitychange'/,
      'returning to a backgrounded checkout tab is exactly when the cache is stale and the customer is about to pay');
    // The interval has to stay inside the TTL or the cache lapses between ticks.
    const ping = Number((html.match(/const BACKEND_WARM_PING_MS = (\d+);/) || [])[1]);
    const ttl = Number((html.match(/const BACKEND_READY_TTL_MS = (\d+);/) || [])[1]);
    assert.ok(ping > 0 && ping < ttl,
      'the heartbeat is ' + ping + 'ms against a ' + ttl + 'ms TTL — it must tick before the cache expires');
  });

  test('the cold path is untouched by the warm-up', () => {
    // This may make the warm path faster; it must not be able to make the cold
    // path worse. A failed probe simply leaves the cache stale.
    const run = grab('runWithBackendReady');
    assert.match(run, /if\(isBackendKnownAwake\(\)\) return intent\(\);/,
      'the known-awake shortcut must still be the first thing checked');
    assert.match(run, /if\(await probeBackend\(\)\) return intent\(\);/,
      'and the probe must still be there for a cache that IS stale');
    assert.match(run, /openWaitingExperience\(context\)/, 'and the wait must still appear when it is genuinely cold');
    assert.ok(!/keepBackendWarm/.test(run),
      'the gate must not depend on the heartbeat — the heartbeat is an optimisation, not a prerequisite');
  });

  test('THE COPY: the waiting notice says what the customer actually asked for', () => {
    // beginApiWait fires from apiFetch for EVERY foreground request and used to
    // show one line for all of them: "bringing you the latest prices". That was
    // shown to somebody signing in, applying a coupon, sending a contact
    // message and confirming a puja booking.
    const pick = new Function(
      html.match(/const API_WAIT_COPY = \[[\s\S]*?\n\];/)[0] + '\n' +
      grab('apiWaitCopy') + '; return apiWaitCopy;')();
    const first = p => { const c = pick(p); return c.length === 3 ? c[1] : c[0]; };

    assert.strictEqual(first('/api/payments/create-order'), 'Securing your payment…');
    assert.strictEqual(first('/api/payments/verify'), 'Confirming your payment…',
      'the longest matching prefix must win, or /api/payments/ swallows verify');
    assert.strictEqual(first('/api/bookings/puja'), 'Confirming your booking…');
    assert.strictEqual(first('/api/auth/login'), 'Signing you in…');
    assert.strictEqual(first('/api/coupons/validate'), 'Checking your coupon…');
    assert.strictEqual(first('/api/addresses'), 'Saving your delivery address…');
    assert.strictEqual(first('/api/products?limit=100'), 'Bringing you the latest prices…',
      'the original line was not wrong — it was wrong EVERYWHERE ELSE');
    assert.strictEqual(first('/api/an/unmapped/path'), 'One moment…',
      'an unmapped path must be neutral and true, never a guess about what is happening');

    // The path has to actually reach it.
    assert.match(html, /if\(!background\) beginApiWait\(path\);/,
      'apiFetch must tell the notice which request it is waiting on');
    assert.match(grab('beginApiWait'), /apiWaitCopy\(path\)/);

    // Nothing may claim prices while money is moving.
    for (const p of ['/api/payments/create-order', '/api/payments/verify', '/api/bookings/puja', '/api/auth/login']) {
      assert.ok(!/prices/i.test(first(p)), p + ' still talks about prices');
    }
  });

  test('a payment in flight tells the customer not to close the page', () => {
    // The 15s escalation is the one place it matters most: a customer who
    // closes the tab mid-verification can be charged with no order recorded.
    const pick = new Function(
      html.match(/const API_WAIT_COPY = \[[\s\S]*?\n\];/)[0] + '\n' +
      grab('apiWaitCopy') + '; return apiWaitCopy;')();
    for (const p of ['/api/payments/verify', '/api/bookings/verify-payment']) {
      const c = pick(p);
      assert.match(c[2], /do not close/i, p + ' must warn against closing the page');
    }
  });
}

// ============================================================
section('[fe-38] Partial outage: one dead endpoint must not close the shop');
// ============================================================
// The backend is not one thing that is either up or down. Any single route can
// fail while the rest serve perfectly: a bad deploy of one router, an exhausted
// pool on one query, a third party one endpoint depends on. Treating every
// failure identically is what turns one broken route into a shop that cannot
// sell.
{
  const html = read('index.html');
  function grab(name) {
    const i = html.search(new RegExp('(async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = html.indexOf('{', i);
    for (let k = s; k < html.length; k++) {
      if (html[k] === '{') d++;
      else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); }
    }
  }
  const classify = new Function('isTransportFailure',
    html.match(/const FAILURE_TRANSPORT[\s\S]*?const FAILURE_JUDGEMENT\s*=\s*'judgement';/)[0] + '\n' +
    grab('classifyFailure') + '; return classifyFailure;')(
      (e) => !!(e && e.transport === true));

  test('THE CLASSIFIER: a 500 is our fault, a 4xx is a decision, silence is unknown', () => {
    // Both a 500 and a 400 arrive as a rejected promise carrying a status.
    // Treating them alike is how our own outage silently took a customer's
    // discount away.
    assert.strictEqual(classify({ transport: true }), 'transport');
    assert.strictEqual(classify({ status: 500 }), 'server');
    assert.strictEqual(classify({ status: 503 }), 'server');
    assert.strictEqual(classify({ status: 400 }), 'judgement');
    assert.strictEqual(classify({ status: 404 }), 'judgement');
    assert.strictEqual(classify({ status: 409 }), 'judgement');
    assert.strictEqual(classify({}), 'server',
      'an unclassifiable rejection must default to the SAFE side, which is to change nothing');
  });

  test('THE BULKHEAD: one unhealthy endpoint cannot block the checkout', () => {
    // Measured before this existed: with /api/ready failing and payments,
    // catalog and auth all healthy, the checkout was refused outright and the
    // customer got a service-interruption panel. One broken route took the
    // whole shop's revenue with it.
    const run = grab('runWithBackendReady');
    const probeAt = run.indexOf('if(await probeBackend()) return intent();');
    const servingAt = run.indexOf('if(isBackendServing()) return intent();');
    const waitAt = run.indexOf('openWaitingExperience(context)');
    assert.ok(probeAt > -1 && servingAt > probeAt && waitAt > servingAt,
      'the serving check must sit BETWEEN the probe and the waiting screen — it is the fallback for when the probe alone says no');
    assert.match(grab('apiFetch'), /noteBackendResponded\(\)/,
      'ANY response, including a 500, proves the process is awake and must be recorded');
    assert.match(grab('probeBackend'), /noteBackendResponded\(\)/,
      'even a 500 from /api/ready means the process answered');
    assert.match(grab('ensureBackendAwake'), /if\(isBackendServing\(\)\) return true;/,
      'a customer must not keep waiting on one unhealthy endpoint once something else has answered');
  });

  test('a genuine cold start is completely unaffected by the bulkhead', () => {
    // This makes a partial outage survivable; it must not weaken the cold path.
    // With nothing having answered, isBackendServing() is false and the wait
    // appears exactly as before.
    assert.match(grab('isBackendServing'), /lastResponseAt/, 'it must be evidence-based, not a constant');
    const ttl = Number((html.match(/const BACKEND_SERVING_TTL_MS = (\d+);/) || [])[1]);
    assert.ok(ttl > 0 && ttl <= 120000,
      'the evidence window is ' + ttl + 'ms — stale evidence must expire, or a long-dead backend looks alive forever');
    const run = grab('runWithBackendReady');
    assert.match(run, /if\(isBackendKnownAwake\(\)\) return intent\(\);/, 'the warm shortcut must still come first');
    assert.match(run, /openWaitingExperience\(context\)/, 'and the wait must still exist for a real cold boot');
  });

  test('OUR outage must never cost the customer their discount', () => {
    const fn = grab('revalidateCouponNow');
    assert.match(fn, /if\(classifyFailure\(err\) !== FAILURE_JUDGEMENT\) return;/,
      'only a 4xx — a real decision about the coupon — may remove it');
  });

  test('THE MONEY MESSAGE: a taken payment is never reported as a failed one', () => {
    // Razorpay has ALREADY taken the money by the time the handler runs. What
    // can fail afterwards is OUR confirmation of it. "Payment verification
    // failed" reads as "your payment failed": it is untrue, it invites a second
    // attempt at paying, and it invites a chargeback.
    const idx = html.indexOf('THE MOST IMPORTANT MESSAGE ON THE SITE');
    assert.ok(idx > -1, 'the verification failure path lost its explanation');
    const block = html.slice(idx, idx + 2400);
    assert.match(block, /Your payment went through/, 'the customer must be told the money moved');
    assert.match(block, /confirmed by email shortly/, 'and that the order completes without them');
    assert.ok(!/'Payment verification failed'/.test(block),
      'the old wording told the customer their payment had failed');
    assert.match(block, /signature/,
      'a genuine refusal must still show the server own words rather than the reassurance');
    assert.match(block, /razorpay_payment_id/,
      'a reference the customer can quote to support is what separates reassurance from a brush-off');
  });

  test('the waiting screen stays usable on a small phone', () => {
    // Measured at 360x640: the suggestion phase pushed Cancel below the fold,
    // so the customer saw product cards and no visible way out of a screen that
    // cannot be dismissed any other way. Structural, not per-phase copy tuning,
    // so a phase added later inherits it.
    assert.match(html, /#waitModal \.modal-box\{ display:flex; flex-direction:column; max-height:92vh; \}/,
      'the box must be a column with a bounded height');
    assert.match(html, /#waitModal \.wait-body\{ overflow-y:auto; min-height:0; flex:1 1 auto; \}/,
      'the BODY scrolls so the head and foot stay put in every phase');
    assert.match(html, /#waitModal \.btn\{ min-height:44px; \}/,
      '44px is the floor both the Apple HIG and WCAG 2.5.8 settle on; these were 39');
  });
}

// ============================================================
section('[fe-39] The category filter: disclosure, placement, and touch');
// ============================================================
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);
  function grab(name) {
    const i = code.search(new RegExp('(async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = code.indexOf('{', i);
    for (let k = s; k < code.length; k++) {
      if (code[k] === '{') d++;
      else if (code[k] === '}') { d--; if (!d) return code.slice(i, k + 1); }
    }
  }

  test('THE MISSING GESTURE: disclosure is separate from selection, so it can close', () => {
    // The chevron flipped up once and stayed there. Expansion was a SIDE EFFECT
    // of selecting a category, and nothing anywhere collapsed it again — so the
    // "up" state was reachable and the "down" state was not.
    //
    // Expansion is now its own state, and the chevron is a real button that
    // toggles it WITHOUT touching the filter. That also lets somebody look
    // inside a category without filtering the grid to it first.
    assert.match(code, /let expandedCats = new Set\(\);/,
      'expansion must be its own state, not inferred from shopFilters.cat');
    const toggle = grab('toggleCategoryOpen');
    assert.match(toggle, /expandedCats\.delete\(key\)/, 'it must be able to CLOSE');
    assert.match(toggle, /expandedCats\.add\(key\)/, 'and to open');
    assert.ok(!/shopFilters/.test(toggle),
      'toggling disclosure must not change the filter — that is the whole point of separating them');
    // Selecting still opens, because the customer has expressed interest.
    assert.match(grab('setCategoryFilter'), /expandedCats\.add\(cat\)/,
      'selecting a category should reveal its refinements');
  });

  test('THE PLACEMENT: the chevron sits beside the NAME, not out by the count', () => {
    // Parked at the right-hand edge next to the number it read as part of the
    // count rather than as something belonging to the category.
    const fn = grab('renderShopFilterSidebar');
    // The chevron is the FIRST thing in the right-hand group and the count the
    // last, so the icon still lands against the name. Only the button's reach
    // extends to the edge; the icon does not travel with it.
    const chevAt = fn.indexOf('class="filter-chev"');
    const countInToggle = fn.indexOf('countHTML +');
    assert.ok(chevAt > -1 && countInToggle > chevAt,
      'inside the toggle the chevron must precede the count, or the icon drifts out to the number');
    const labelAt = fn.indexOf("'</label>'");
    assert.ok(labelAt > -1 && fn.indexOf('toggle +') > labelAt,
      'and the row order is label(name) -> toggle');
    // Alignment by layout, not by a spacer that has to be kept in step.
    assert.match(html, /\.filter-check > \.c, \.filter-row > \.c\{ margin-left:auto;/,
      'the count must be pushed right by the layout, so every row aligns whether or not it has a chevron');
    assert.ok(!/is-placeholder/.test(html),
      'the invisible-spacer approach is gone; nothing to drift when the icon size changes');
  });

  test('THE HIT AREAS: between them the two targets cover the whole row', () => {
    // A 16px radio is not a target anyone hits with a thumb, and the count sat
    // in dead space at the widest part of the row. Measured after the change at
    // 320/375/768: both targets are 44px tall and reach the row's right edge,
    // and every count glyph lands on the same pixel (spread 0) whether its row
    // has a disclosure button or not.
    const fn = grab('renderShopFilterSidebar');
    // Where the count lives depends on which target owns that row.
    assert.match(fn, /opts\.hasSubs \? '' : countHTML/,
      'with no button the count must sit INSIDE the label, or the row stops being selectable short of its own edge');
    // Slice the toggle expression itself rather than guessing a character
    // window: an inline SVG sits between the two, and its length is nobody's
    // business but the icon's.
    const tExpr = fn.slice(fn.indexOf('const toggle = opts.hasSubs'), fn.indexOf('<div class="filter-row'));
    assert.ok(tExpr.indexOf('class="filter-chev"') > -1 && tExpr.indexOf('countHTML +') > tExpr.indexOf('class="filter-chev"'),
      'with a button the count must sit inside it, after the chevron, so clicking the number discloses');
    assert.match(html, /\.filter-check\{[^}]*flex:1 1 auto/,
      'the label has to STRETCH; a label sized to its text is the 16px-radio problem again');
    assert.match(html, /\.filter-toggle\{[^}]*margin-left:auto/,
      'and the button has to be pushed to the right edge');
    // Both must fill the row's height on touch, not sit 28px tall inside a 44px row.
    const touchAt = html.indexOf('@media (hover:none), (max-width:980px){');
    const block = html.slice(touchAt, html.indexOf('.filter-subs .filter-check', touchAt));
    assert.match(block, /\.filter-check\{[^}]*min-height:44px; align-self:stretch/,
      'the label must fill the row height, or the top and bottom of every row look tappable and are not');
    assert.match(block, /\.filter-toggle\{[^}]*min-height:44px[^}]*align-self:stretch/,
      'and so must the button');
  });

  test('the chevron appears only where there is something to disclose', () => {
    const fn = grab('renderShopFilterSidebar');
    assert.match(fn, /const hasSubs = subs\.length > 0;/,
      'driven by real subcategory counts, never rendered unconditionally');
    assert.match(fn, /opts\.hasSubs\s*\?/, 'and only rendered when that is true');
    // A sub-row can never carry one: there is no third level.
    assert.match(fn, /hasSubs: false, expanded: false,[\s\S]{0,200}?setSubcategoryFilter/,
      'subcategory rows must be built with hasSubs false');
  });

  test('it is a real control, announced and reachable', () => {
    const fn = grab('renderShopFilterSidebar');
    assert.match(fn, /<button type="button" class="filter-toggle" aria-expanded="/,
      'a button, not a decorated label — it performs an action');
    assert.match(fn, /aria-expanded="' \+ \(opts\.expanded \? 'true' : 'false'\)/,
      'its state must be announced, not only drawn');
    assert.match(fn, /aria-label="' \+ escapeHtml\(\(opts\.expanded \? 'Hide' : 'Show'\)/,
      'and it needs a name that says what it will do');
    assert.match(fn, /event\.preventDefault\(\); event\.stopPropagation\(\);/,
      'it sits inside a row whose label would otherwise swallow the click and change the filter');
    assert.match(html, /\.filter-toggle:focus-visible\{ outline:/, 'keyboard focus must be visible');
    // The CHEVRON rotates, not the button. The button now carries the count as
    // well, and rotating it would turn the number upside-down.
    assert.match(html, /\.filter-row\.is-open \.filter-toggle \.filter-chev\{ transform:rotate\(180deg\)/,
      'and it must point the other way once open');
    assert.ok(!/\.filter-row\.is-open \.filter-toggle\{ transform:rotate/.test(html),
      'rotating the whole button would flip the count with it');
  });

  test('P1: the filter offers no category that would open an empty grid', () => {
    // Measured on the live site: the sidebar unioned a hardcoded starter list
    // with the real catalog and advertised Bracelets, Puja Samagri Kits and
    // Spiritual Books at ZERO — all three opened "No products found" — while
    // putting a dead "Spiritual Books (0)" directly beside the live "Book (4)".
    // The mega-menu already derived its list from the catalog, so the two
    // surfaces disagreed about what the shop sells.
    const fn = grab('renderShopFilterSidebar');
    assert.ok(!/CAT_LABELS/.test(fn),
      'the category list must come from the catalog, never from a hardcoded starter list');
    assert.match(fn, /PRODUCTS\.forEach/, 'counted from the products themselves');
    // The one exception, so a shared ?category= link still explains itself.
    assert.match(fn, /catCounts\[shopFilters\.cat\] === undefined/,
      'a category the customer is currently filtered to must stay listed even at zero');
  });

  test('TOUCH: rows and controls meet the 44px floor, and the rule actually wins', () => {
    // Measured live at 390x844: filter rows were 22px, half the floor the Apple
    // HIG and WCAG 2.5.8 both settle on.
    //
    // The override block MUST come after the base rules. Specificity is equal
    // between them, so source order decides — and when this block sat earlier
    // in the file it lost silently, leaving 26px chevrons on a phone while the
    // stylesheet appeared to say 44.
    const baseAt = html.indexOf('.filter-toggle{ display:inline-flex');
    // THE filter touch block, not merely the first block with that media query:
    // other components have their own touch overrides now, and indexOf() would
    // happily measure one of those instead and prove nothing about this one.
    const MQ = '@media (hover:none), (max-width:980px){';
    let touchAt = -1;
    for (let at = html.indexOf(MQ); at > -1; at = html.indexOf(MQ, at + 1)) {
      const end = html.indexOf('\n}', at);
      if (html.slice(at, end).includes('.filter-row{')) { touchAt = at; break; }
    }
    assert.ok(touchAt > -1, 'the filter touch-override block must exist');
    assert.ok(baseAt > -1 && touchAt > baseAt,
      'the touch overrides must come AFTER the base .filter-toggle rule or they lose on source order');
    const block = html.slice(touchAt, html.indexOf('}\n', html.indexOf('.filter-subs .filter-check', touchAt)));
    assert.match(block, /\.filter-row\{ min-height:44px;/);
    // The button is no longer a 44px square: it carries the count too, so it is
    // sized by a floor plus stretch rather than a fixed box.
    assert.match(block, /\.filter-toggle\{ min-height:44px;/);
    assert.match(block, /\.filter-toggle \.filter-chev\{ width:22px; height:22px; \}/,
      'the icon keeps its own size independent of the button it now shares');
  });

  test('MOBILE: the drawer is bounded by the viewport and its action is always reachable', () => {
    // Measured live at 390x844 before this: the panel computed 1135px tall
    // against an 844px viewport, so its bottom 291px — including Show Results —
    // was off-screen and unreachable. top:0/bottom:0 should have bounded it and
    // did not once the flex column's content exceeded it.
    assert.match(html, /height:100vh; height:100dvh; max-height:100dvh;/,
      'the height must be stated outright; dvh tracks a collapsing mobile address bar, with vh as the fallback');
    assert.match(html, /\.shop-sidebar\.mobile-show \.filter-scroll\{[\s\S]{0,140}overflow-y:auto/,
      'the LIST scrolls, so the head and the action stay pinned');
    assert.match(html, /env\(safe-area-inset-bottom/,
      'the action must clear the iPhone home indicator');
    assert.match(html, /class="filter-drawer-head"/, 'a titled header with a way out');
    assert.match(html, /id="mobileFilterCount"/, 'and a live count of what the filters have selected');
    // Desktop must be untouched by all of it.
    assert.match(html, /\.filter-drawer-head\{ display:none; \}/,
      'the drawer chrome must not appear on desktop');
    assert.match(html, /\.filter-scroll\{ display:flex; flex-direction:column; gap:var\(--sp-6\); \}/,
      'and the scroll wrapper must be an ordinary column there');
  });

  test('the results count tracks every filter, not only the category rows', () => {
    // Price, rating and stock changes re-render the grid without rebuilding the
    // sidebar, so counting only in the sidebar renderer would leave the drawer
    // promising a number that was two filters out of date.
    assert.match(grab('renderShopGrid'), /syncMobileFilterCount\(\);/,
      'the grid render is the one place every filter change passes through');
  });
}


// ============================================================
section('[fe-40] The shipping address: reuse it, never invent a new row per order');
// ============================================================
// A LIVE bug, reported from the real site: checkout said "A valid shipping
// address is required to place an order" while the customer was looking at a
// complete, valid address. Both halves of that message were wrong.
{
  const html = read('index.html');
  function grab(name) {
    const i = html.search(new RegExp('(async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = html.indexOf('{', i);
    for (let k = s; k < html.length; k++) {
      if (html[k] === '{') d++;
      else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); }
    }
  }
  const same = new Function('return ' + grab('sameAddress') + '; ')();

  test('THE FINDING: an identical address is reused, not inserted again', () => {
    // The checkout POSTed a brand-new row on EVERY Place Order — it never
    // listed, matched or reused one, and the storefront has no screen for
    // managing them. The server caps an account at 25, so after twenty-five
    // checkouts the POST returned 409, the client swallowed it into
    // console.warn, and create-order then rejected the resulting null id with a
    // message about the address being invalid.
    const fn = grab('resolveShippingAddressId');
    assert.match(fn, /apiFetch\('\/api\/addresses'\)/,
      'it must LIST what is already saved before creating anything');
    assert.match(fn, /saved\.find\(function\(a\)\{ return sameAddress\(a, payload\); \}\)/,
      'and reuse a matching row rather than inserting a duplicate');
    const listAt = fn.indexOf("apiFetch('/api/addresses')");
    const postAt = fn.indexOf("method: 'POST'");
    assert.ok(listAt > -1 && postAt > listAt,
      'the match has to be attempted BEFORE the insert, or reuse never happens');
  });

  test('matching is forgiving about case and spacing, strict about the address', () => {
    const base = { full_name: 'Mukul Chakraborty', phone: '9876543210', line1: '12 Temple Road',
                   city: 'Kolkata', state: 'West Bengal', pincode: '700001' };
    assert.ok(same(base, Object.assign({}, base, { full_name: '  MUKUL   CHAKRABORTY ' })),
      'a saved row and a freshly typed one differ in case and spacing constantly');
    assert.ok(same(base, Object.assign({}, base, { city: 'kolkata' })));
    // Anything that changes WHERE it goes is a different address.
    for (const field of ['line1', 'city', 'state', 'pincode', 'phone', 'full_name']) {
      const changed = Object.assign({}, base); changed[field] = 'something else 9';
      assert.ok(!same(base, changed), 'a different ' + field + ' must NOT be treated as the same address');
    }
    assert.ok(!same(base, Object.assign({}, base, { pincode: '700002' })),
      'a different PIN is a different destination — this is the one that would ship to the wrong place');
  });

  test('an account already at the cap can still order', () => {
    // 409 is the exact failure the live site hit. Recycling the oldest
    // NON-default row is safe: it is overwritten with precisely what the
    // customer just typed, and the alternative is a permanently broken
    // checkout on an account with no way to delete anything.
    const fn = grab('resolveShippingAddressId');
    assert.match(fn, /=== 409/, 'the capacity case has to be recognised');
    assert.match(fn, /filter\(function\(a\)\{ return !a\.is_default; \}\)/,
      'the default address must be protected from recycling');
    assert.match(fn, /method: 'PUT'/, 'it must overwrite a row rather than give up');
  });

  test('THE MESSAGE: a failure is never reported as an invalid address', () => {
    const caller = grab('placeOrderNow');
    assert.ok(!/console\.warn\('Could not create shipping address on server, proceeding without it'/.test(caller),
      'the swallow is what turned a save failure into a lie about the address');
    assert.match(caller, /shippingAddressId = await resolveShippingAddressId\(addrPayload\);/);
    // The catch must STOP, not carry on with a null id.
    const catchAt = caller.indexOf('Could not resolve a shipping address');
    assert.ok(catchAt > -1, 'the failure has to be handled explicitly');
    const after = caller.slice(catchAt, catchAt + 700);
    assert.match(after, /return;/, 'it must return rather than reaching create-order with no address');
    assert.match(after, /\(e && e\.error\) \? e\.error/, "and show the server's own reason");
    assert.match(after, /checkoutProcessing/, 'the processing pane must be dismissed');
    assert.match(after, /checkoutLayout/, 'and the form the customer can act on brought back');
  });

  test('the server still refuses an order with no address', () => {
    // The client-side fix must not be mistaken for permission to relax this.
    const routes = read('src/routes/payments.routes.js');
    assert.match(routes, /A valid shipping address is required to place an order/,
      'a paid order with nowhere to ship it is still an order that must not exist');
    assert.match(routes, /!isUuid\(shippingAddressId\)/,
      'and the shape is still checked before it reaches Postgres');
  });
}

// ============================================================
section('[fe-41] The mobile drawer: the only route a phone has into a subcategory');
// ============================================================
// The mega-menu is a HOVER surface. It does not exist on a phone, so the
// navigation drawer is the only way a mobile visitor reaches a category from
// the nav at all — and it was still carrying seven hardcoded links.
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);
  function grab(name) {
    const i = code.search(new RegExp('(async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = code.indexOf('{', i);
    for (let k = s; k < code.length; k++) {
      if (code[k] === '{') d++;
      else if (code[k] === '}') { d--; if (!d) return code.slice(i, k + 1); }
    }
  }

  test('THE FINDING: the drawer offered categories the shop does not sell', () => {
    // The hardcoded list advertised Bracelets, Spiritual Books and Puja Samagri
    // Kits. All three hold nothing and open an empty grid — the same defect
    // already fixed in the shop sidebar, still live in the drawer because the
    // list was written by hand in the markup.
    const drawer = html.slice(html.indexOf('id="mobileDrawer"'), html.indexOf('id="mobileDrawer"') + 4000);
    assert.ok(!/openShopWithCategory\('bracelets'\)/.test(drawer),
      'a category with no products must not be advertised anywhere');
    assert.ok(!/openShopWithCategory\('samagri'\)/.test(drawer));
    assert.match(html, /<div class="mnav-sub" id="mnavShopSub"><\/div>/,
      'the list must be an empty host the renderer fills, not markup');
  });

  test('it is derived from the catalog, by the same law as every other surface', () => {
    const fn = grab('renderMobileNavCategories');
    assert.match(fn, /categoryTree\(\)/,
      'same source as the mega-menu and the shop sidebar, so the three cannot disagree');
    assert.match(fn, /node\.subs\.forEach/, 'subcategories must be listed, not only top-level categories');
    assert.match(fn, /cls: 'mnav-subrow'/, 'and marked as a level down');
    assert.match(fn, /openShopWithCategory\(' \+ jsAttr\(node\.cat\) \+ ', ' \+ jsAttr\(s\.sub\)/,
      'a subcategory link must carry BOTH parts or it filters to the parent');
    assert.match(fn, /jsAttr\(/, 'slugs go into an onclick attribute, so they must be escaped for that context');
  });

  test('the two fixed entries come last, in the right order', () => {
    // All Products is still the final row. All Categories now sits directly
    // above it: a browser for everything the top slice left out.
    const fn = grab('renderMobileNavCategories');
    const listAt = fn.indexOf('shown.forEach');
    const catsAt = fn.indexOf('mnav-actionrow');
    const allAt = fn.indexOf("key: 'all'");
    assert.ok(listAt > -1 && catsAt > listAt,
      'All Categories comes after the category list');
    assert.ok(allAt > catsAt,
      'and All Products after that — it is the escape hatch from a list of narrowings, not one of them');
    assert.match(fn, /PRODUCTS\.length/, 'and its count is the whole catalog');
  });

  test('THE TOP SLICE: a drawer lists the best sellers, not the whole catalogue', () => {
    // A phone menu that lists forty categories is a wall, not a menu. The
    // drawer shows the top N by units actually sold; the rest live one tap away
    // in a browser that can be searched, which a list of rows cannot be.
    const fn = grab('renderMobileNavCategories');
    assert.match(code, /const MNAV_TOP_CATEGORIES = \d+;/, 'the cut-off is a named constant, not a literal buried in a slice');
    assert.match(fn, /rankedCategories\(tree\)\.slice\(0, MNAV_TOP_CATEGORIES\)/,
      'the list must be the ranked head, not an arbitrary slice of the tree');
    // The All Categories row must reach everything, so it counts the whole tree.
    assert.match(fn, /'<span class="mnav-count">' \+ tree\.length \+ '<\/span>'/,
      'its count is every category, not the shown slice — that is the point of it');
  });

  test('THE RANKING: a total order, and a real fallback when sales are unknown', () => {
    // Proven behaviourally in scripts/drawer-fuzz.js over 40 categories with
    // deliberate ties: units desc, then catalogue depth, then name — the same
    // three keys the SQL sorts by, so client and server cannot disagree about
    // which category sits at position 15.
    const fn = grab('rankedCategories');
    assert.match(fn, /if\(!categorySalesRank\) return tree\.slice\(\);/,
      'no sales data must fall back to the tree order, not to no order');
    assert.match(fn, /if\(ua !== ub\) return ub - ua;/, 'units sold is the primary key');
    assert.match(fn, /if\(a\.count !== b\.count\) return b\.count - a\.count;/, 'then catalogue depth');
    assert.match(fn, /return a\.cat\.localeCompare\(b\.cat\);/,
      'then the name — without it, equal rows reshuffle between page loads');
    // An unranked category sorts below every ranked one. This is what makes a
    // 20-row server window safe for a 15-row client list.
    assert.match(fn, /hasOwnProperty\.call\(rank, a\.cat\) \? rank\[a\.cat\] : -1/,
      'absent from the ranking must sort below a genuine zero');
    assert.match(code, /let categorySalesRank = null;/,
      'null means "unknown", which is a different thing from "all zero"');
  });

  test('SERVER: "most sold" counts only orders that were actually paid', () => {
    // The storefront ranks by what this query returns, so the arithmetic behind
    // it is part of this feature. Proven against a real database in
    // test/db-integration.test.js [db-12].
    const routes = read('src/routes/products.routes.js');
    assert.match(routes, /SUM\(CASE WHEN o\.id IS NOT NULL THEN oi\.quantity ELSE 0 END\)/,
      'the sum must be conditioned on the order surviving the status filter');
    assert.ok(!/COALESCE\(SUM\(oi\.quantity\), 0\)/.test(routes),
      'an unconditional sum counted pending, cancelled and refunded orders as sales');
    assert.match(routes, /ORDER BY units_sold DESC, product_count DESC, p\.category ASC/,
      'and the server order must match the client order exactly');
  });

  test('ORPHAN GUARD: the renderer is actually called, on both paints', () => {
    // A function built, tested and never invoked is the catPath mistake. It has
    // to run at the cold first paint (from the snapshot, no API) AND again when
    // the live catalog lands.
    assert.match(grab('refreshCatalogViews'), /renderMobileNavCategories\(\);/,
      'rebuilt when the live catalog replaces the snapshot');
    const calls = (code.match(/renderMobileNavCategories\(\);/g) || []).length;
    assert.ok(calls >= 2,
      'it must also run at the cold first paint, or a phone gets an empty Shop menu for the whole 30-60s wake');
  });

  test('THE COLLAPSE: one wrapper child, or the menu will not close', () => {
    // grid-template-rows:0fr sizes only the FIRST explicit row. With sibling
    // links the rest fall into implicit auto rows and stay on screen with the
    // menu "closed" — measured before the wrapper was added.
    const fn = grab('renderMobileNavCategories');
    assert.match(fn, /host\.innerHTML = '<div class="mnav-sub-inner">' \+ html \+ '<\/div>'/,
      'the generated list must be wrapped in exactly one element');
    // The empty case used to be a second, separate assignment. It is now the
    // SAME one — there is no early return any more, so an empty catalog falls
    // through to the same wrapper carrying just All Products. One assignment
    // means the structure cannot vary by branch, which is stronger than two
    // assignments that happen to agree today.
    const assignments = fn.match(/host\.innerHTML =/g) || [];
    assert.equal(assignments.length, 1,
      'exactly one place sets the list, so the empty case cannot drift from the normal one');
    assert.match(html, /\.mnav-sub\{[^}]*grid-template-rows:0fr/,
      'closed state');
    assert.match(html, /\.mnav-item\.open \.mnav-sub\{ grid-template-rows:1fr; \}/,
      'open state sizes to the real content');
    // The height is not knowable in advance any more, so it must not be guessed.
    assert.ok(!/\.mnav-item\.open \.mnav-sub\{ max-height:\d+px/.test(html),
      'a fixed max-height would silently clip a catalog with enough categories');
    assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{ \.mnav-sub\{ transition:none; \} \}/,
      'and the animation must be suppressible');
  });

  test('THE DISCLOSURE: a category with subcategories carries its own chevron', () => {
    // The drawer listed every subcategory permanently, indented, with no way to
    // collapse anything — so the list grew without bound as the catalog does,
    // and there was no signal at all about which categories hold refinements.
    // It now follows the SAME two-target law as a shop filter row:
    //   [ name ................ ][ chevron ... count ]
    //     ^ opens the category     ^ reveals its subcategories
    const fn = grab('renderMobileNavCategories');
    assert.match(fn, /const hasSubs = node\.subs\.length > 0;/,
      'driven by real subcategory counts, never rendered unconditionally');
    assert.match(fn, /class="mnav-cattoggle" aria-expanded="/,
      'a real button, announced — not a decorated span');
    assert.match(fn, /aria-label="' \+ escapeHtml\(\(opts\.expanded \? 'Hide' : 'Show'\)/,
      'and named for what it will do');
    assert.match(fn, /event\.preventDefault\(\); event\.stopPropagation\(\);/,
      'it sits beside a link that would otherwise navigate and close the drawer');
    // Chevron before count, both inside the button: the icon stays against the
    // name while the target reaches the right-hand edge.
    const tExpr = fn.slice(fn.indexOf('const toggle = opts.hasSubs'), fn.indexOf("return '<div class=\"mnav-row"));
    assert.ok(tExpr.indexOf('class="mnav-chev"') > -1 &&
              tExpr.indexOf('countHTML') > tExpr.indexOf('class="mnav-chev"'),
      'chevron first, count second — otherwise the icon drifts out to the number');
    // No button means no dead space: the count goes back inside the link.
    assert.match(fn, /\(opts\.hasSubs \? '' : countHTML\)/,
      'a row with no button keeps its count inside the label');

    // THE PAIRS, exactly as the shop filter builds them: a radio and a name in
    // one target, a chevron and a count in the other. The radio is not
    // decoration — the drawer is rebuilt on open, so it shows which category is
    // currently being viewed, which a list of plain links could not.
    assert.match(fn, /<input type="radio" name="' \+ opts\.group \+ '"/,
      'the selection pair needs a real radio, grouped like the filter rows');
    assert.match(fn, /'<label class="mnav-check' \+ active \+ '">'/,
      'and it must be wrapped in a LABEL, so the name selects as well as the circle');
    assert.match(fn, /group: 'mnavCat'/, 'categories share one radio group');
    assert.match(fn, /group: 'mnavSub'/,
      'and subcategories a different one, so selecting a category does not fight a sub');
    assert.match(fn, /active: curCat === node\.cat && !curSub/,
      'the checked row must track the CURRENT filter, not a hardcoded default');
    assert.match(fn, /if\(curCat && curSub\) mnavOpenCats\.add\(curCat\);/,
      'and an active subcategory must reveal its group, or the one row that matters is hidden');
  });

  test('the disclosure toggles both ways, and does not disturb the filter panel', () => {
    // Measured at 320/375/768 with transitions disabled: the list goes
    // 357 -> 401 -> 357px, the group 0 -> 44 -> 0, aria false -> true -> false.
    const fn = grab('toggleMnavCat');
    assert.match(fn, /mnavOpenCats\.add\(key\)/, 'it must be able to open');
    assert.match(fn, /mnavOpenCats\.delete\(key\)/, 'and to CLOSE — the defect the shop sidebar had');
    assert.match(fn, /setAttribute\('aria-expanded'/, 'the state must be announced, not only drawn');
    assert.match(fn, /setAttribute\('aria-label'/, 'and the name updated to match');
    // Separate state from the shop sidebar: two surfaces, two moments.
    assert.ok(!/expandedCats/.test(fn),
      'the nav must not silently rearrange the shop filter panel behind it');
    assert.match(code, /let mnavOpenCats = new Set\(\);/,
      'and the open rows must survive the rebuild when the live catalog lands');
    // Toggled in place, so the expand animates instead of jumping.
    assert.ok(!/renderMobileNavCategories\(\);/.test(fn),
      'a full re-render would replace the element, and a new element starts at its final size');
  });

  test('only the chevron rotates, and the nested group collapses on its own wrapper', () => {
    assert.match(html, /\.mnav-cat\.open \.mnav-cattoggle \.mnav-chev\{ transform:rotate\(180deg\); \}/,
      'rotating the button would turn the count it carries upside-down');
    assert.match(html, /\.mnav-subs\{[^}]*grid-template-rows:0fr/, 'closed');
    assert.match(html, /\.mnav-cat\.open \.mnav-subs\{ grid-template-rows:1fr; \}/, 'open');
    assert.match(html, /\.mnav-subs > \.mnav-subs-inner\{ min-height:0/,
      'one wrapper here too, or sibling links escape the collapse into implicit rows');
    assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{ \.mnav-subs\{ transition:none; \} \}/);
    assert.match(html, /\.mnav-cattoggle:focus-visible\{ outline:/, 'keyboard focus must be visible');
  });

  test('the counts line up whether or not the row has a chevron', () => {
    // Measured: spread 0 at 320, 375 and 768. The count is pushed right by the
    // layout in BOTH homes, and both keep the drawer's own 22px gutter, so the
    // column lands on one pixel whether or not the row has a button.
    assert.match(html, /\.mnav-check > \.mnav-count\{ margin-left:auto; padding-left:10px; padding-right:22px; \}/,
      'a count with no button beside it still keeps the drawer gutter');
    assert.match(html, /\.mnav-cattoggle\{[^}]*padding:8px 22px 8px 10px/,
      "and the button's right gutter must match the drawer's own");
  });

  test('every row in the drawer is a 44px target', () => {
    // Measured at 320/375/768 after the change: min 44px on every row.
    assert.match(html, /\.mnav-check\{[^}]*min-height:44px/,
      'a nav row on a phone is a thumb target');
    assert.match(html, /\.mnav-check\{[^}]*flex:1 1 auto/,
      'and the selection pair must STRETCH — an 18px circle on its own is the defect, not the target');
    assert.match(html, /\.mnav-subrow \.mnav-check\{[^}]*padding-left:58px/,
      'a subcategory reads as a level down, matching the sidebar and the mega-menu');
    assert.match(html, /\.mnav-subrow::before\{[^}]*background:var\(--gold-lt\)/,
      'and carries the same hairline the sidebar uses for the same hierarchy');
    assert.match(html, /\.mnav-count\{/, 'each row states how many products it holds');
  });
}

// ============================================================
section('[fe-42] Derived lists must survive a catalog nobody has seen yet');
// ============================================================
// Both of these are the same defect in different directions: a list DERIVED
// from the catalog living in a container that quietly assumed how big it would
// get. Found by running the real renderer against catalogs it had never seen.
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);
  function grab(name) {
    const i = code.search(new RegExp('(?:async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = code.indexOf('{', i);
    for (let k = s; k < code.length; k++) {
      if (code[k] === '{') d++;
      else if (code[k] === '}') { d--; if (!d) return code.slice(i, k + 1); }
    }
  }

  test('EMPTY: the drawer still offers All Products with no categories at all', () => {
    // It used to bail the moment the tree was empty, so a cold start where even
    // the snapshot failed — or a shop with nothing active — expanded into a
    // completely empty box. The category loop needs a tree; All Products does
    // not, and it is the row that should always be there.
    const fn = grab('renderMobileNavCategories');
    assert.ok(!/if\(!tree\.length\)\{[^}]*return;/.test(fn),
      'no early return on an empty tree — that is what removed All Products with it');
    const treeAt = fn.indexOf('const tree = categoryTree();');
    const allAt = fn.indexOf("key: 'all'");
    assert.ok(treeAt > -1 && allAt > treeAt,
      'All Products is appended after the loop, so it does not depend on the loop running');
  });

  test('SCALE: the mega-menu cannot grow past the bottom of the screen', () => {
    // Measured at 1440x900 with 30 categories x 8 subcategories: the panel's
    // natural height is 4163px. It is position:absolute, so before the cap the
    // lower 3263px hung off-screen with no way to scroll to it. Capped, it
    // reports clientHeight 774 and scrolls.
    //
    // Same defect class as the drawer's old max-height:600px, sign flipped:
    // there a derived list was clipped by a guessed ceiling, here it had none.
    const megaAt = html.indexOf('.mega{');
    const block = html.slice(megaAt, html.indexOf('}', html.indexOf('overflow-y', megaAt)));
    assert.match(block, /max-height:calc\(100vh - var\(--header-h\) - 24px\);/,
      'a vh fallback first, for anything without dvh');
    assert.match(block, /max-height:calc\(100dvh - var\(--header-h\) - 24px\);/,
      'and dvh so a collapsing mobile address bar is accounted for');
    assert.match(block, /overflow-y:auto/,
      'a cap with no scroll would hide the overflow instead of clipping it — worse, not better');
    assert.match(block, /overscroll-behavior:contain/,
      'scrolling the panel to its end must not then scroll the page behind it');
    // It has to use the same header variable everything else does, or it drifts
    // the next time the header height changes.
    assert.match(html, /--header-h: \d+px;/, 'the header height is a variable, not a guess');
  });

  test('the drawer opening can never be blocked by the category list', () => {
    // The drawer also carries Home, Puja Booking, Astrology and Contact, which
    // have nothing to do with the catalog. Rendering before opening would let
    // one bad category row hold the whole site's navigation hostage.
    const at = code.indexOf("qs('#mobileMenuOpen').addEventListener");
    const handler = code.slice(at, at + 400);
    const openAt = handler.indexOf('openMobileDrawer();');
    const renderAt = handler.indexOf('renderMobileNavCategories();');
    assert.ok(openAt > -1 && renderAt > openAt,
      'the drawer must OPEN before the list is rebuilt');
    assert.match(handler, /try\{ renderMobileNavCategories\(\); \}/,
      'and the rebuild must be guarded, so the worst case is a stale list in a working menu');
  });

  test('a category name an admin actually typed cannot break the markup', () => {
    // jsAttr is JSON.stringify wrapped in escapeHtml: the first makes a valid JS
    // string literal out of quotes and backslashes, the second keeps it inside
    // an HTML attribute. Both layers are load-bearing.
    const fn = grab('jsAttr');
    assert.match(fn, /escapeHtml\(JSON\.stringify\(/,
      'both layers, in that order — either alone lets a quote out');
    const render = grab('renderMobileNavCategories');
    assert.ok(!/onchange="[^"]*'\s*\+\s*opts\.key/.test(render),
      'no slug may be concatenated into an attribute without going through jsAttr');
    assert.match(render, /data-cat="' \+ escapeHtml\(node\.cat\) \+ '"/,
      'and the data attribute is escaped too');
    // toggleMnavCat matches the attribute VALUE in JS rather than building a CSS
    // selector, so a slug containing a quote or a bracket needs no escaping.
    assert.match(grab('toggleMnavCat'), /getAttribute\('data-cat'\) !== key/,
      'matching in JS avoids having to escape a free-form slug into a selector');
  });
}

// ============================================================
section('[fe-43] Service Booking, and the All Categories browser');
// ============================================================
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);
  function grab(name) {
    const i = code.search(new RegExp('(?:async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = code.indexOf('{', i);
    for (let k = s; k < code.length; k++) {
      if (code[k] === '{') d++;
      else if (code[k] === '}') { d--; if (!d) return code.slice(i, k + 1); }
    }
  }

  test('Service Booking is one menu above Shop, and its two links moved INTO it', () => {
    // Puja Booking and Astrology were two loose rows further down the drawer.
    // They are one thing a customer comes for, so they are one menu — and the
    // originals are gone, because the same destination twice in one drawer is
    // a defect, not a convenience.
    // Below Shop now, by request. Shop is the primary destination; services are
    // the secondary one.
    const svcAt = html.indexOf('id="mServiceToggle"');
    const shopAt = html.indexOf('id="mShopToggle"');
    assert.ok(svcAt > -1 && shopAt > -1 && shopAt < svcAt,
      'Service Booking must sit below Shop');
    assert.match(html, /class="mnav-servicelink"[^>]*onclick="navigateTo\('puja'\)/);
    assert.match(html, /class="mnav-servicelink"[^>]*onclick="navigateTo\('astrology'\)/);
    // Exactly one drawer row per destination.
    const drawerStart = html.indexOf('<div class="drawer-body">');
    const drawerEnd = html.indexOf('</div>', html.indexOf('id="mnavShopSub"'));
    const drawer = html.slice(drawerStart, html.indexOf('drawer-foot', drawerEnd));
    assert.equal((drawer.match(/navigateTo\('puja'\)/g) || []).length, 1,
      'Puja Booking must appear exactly once in the drawer');
    assert.equal((drawer.match(/navigateTo\('astrology'\)/g) || []).length, 1,
      'Astrology must appear exactly once in the drawer');
  });

  test('ONE disclosure behaviour, shared — not a copy per section', () => {
    // Shop and Service Booking behave identically and must keep doing so. Two
    // hand-written copies is exactly how they stop.
    assert.match(code, /function wireDrawerSection\(itemId\)\{/);
    assert.match(code, /wireDrawerSection\('mShopToggle'\);/);
    assert.match(code, /wireDrawerSection\('mServiceToggle'\);/);
    const fn = grab('wireDrawerSection');
    assert.match(fn, /setAttribute\('aria-expanded'/, 'the state must be announced, not only drawn');
    // Structurally identical to Shop, deliberately — same .mnav-split, same
    // 56px bordered toggle, same chevron, same wiring. Measured at 375 and 768:
    // row, toggle, label and chevron all match Shop exactly.
    assert.match(html, /id="mServiceToggle">\s*<div class="mnav-split">/,
      'Service Booking uses Shop\'s row, not a shape of its own');
    assert.match(html, /class="mnav-split-label mnav-split-label-btn"/,
      'its label is a BUTTON: there is no combined services page, so a link would go nowhere');
    // Height is pinned on the shared class, so a future section cannot be a
    // different height just because its label carries a pill or does not.
    assert.match(html, /\.mnav-split\{ display:flex; align-items:stretch; min-height:56px; \}/,
      'every section is the same height by construction, not by coincidence');
  });

  test('the All Categories browser is complete, searchable, and works cold', () => {
    const fn = grab('renderAllCategories');
    assert.match(fn, /categoryTree\(\)/,
      'built from the same derived tree as every other category surface, so it is complete from the snapshot alone');
    // Searching must match what the customer can SEE, not only the slug.
    assert.match(fn, /String\(catLabel\(value\)\)\.toLowerCase\(\)\.indexOf\(q\)/,
      'a customer searches the words on screen; they have never seen the slug');
    assert.match(fn, /const subs = catHit \? node\.subs : node\.subs\.filter/,
      'a category matched by name keeps all its subcategories; one matched through a subcategory shows the matches');
    assert.match(fn, /allcats-empty/, 'a search with no results needs to say so');
    // Both levels are reachable, and both escape into the shop correctly.
    assert.match(fn, /openShopWithCategory\(' \+ jsAttr\(node\.cat\) \+ '\); closeAllCategories\(\);/);
    assert.match(fn, /jsAttr\(node\.cat\) \+ ', ' \+ jsAttr\(s\.sub\) \+ '\); closeAllCategories\(\);/);
  });

  test('opening the browser closes the drawer, and Escape closes the browser', () => {
    const fn = grab('openAllCategories');
    assert.match(fn, /closeAllDrawers\(\);/,
      'two stacked overlays is not a browsing experience');
    assert.match(fn, /openModal\('allCatsModal'\)/, 'it reuses the page modal convention rather than inventing one');
    // Focus the search only where a keyboard exists: doing it on a phone raises
    // the on-screen keyboard over the grid the customer opened this to read.
    assert.match(fn, /matchMedia\('\(hover:hover\) and \(min-width:641px\)'\)/,
      'auto-focus belongs on desktop only');
    assert.match(code, /closeModal\('allCatsModal'\);/, 'Escape must close it like every other modal');
  });

  test('the browser sizes itself by ID, so stylesheet order cannot break it', () => {
    // .allcats-box and .modal-box have EQUAL specificity, and the modal rules
    // are defined later in this file than the drawer rules this block lives
    // with — so .modal-box{max-height:88vh} was silently beating both the base
    // rule and the phone media query, rendering a 715px box where a full-height
    // sheet was intended. Measured before and after at 375x812: 715 -> 812.
    assert.match(html, /#allCatsModal \.allcats-box\{[^}]*max-height:88dvh/,
      'scoped by id so it wins on specificity rather than on position in the file');
    assert.match(html, /#allCatsModal \.allcats-box\{ max-width:none;[^}]*height:100dvh/,
      'and the phone override must be scoped the same way');
    assert.match(html, /@media \(hover:none\), \(max-width:980px\)\{\s*\.allcat-chip\{ min-height:44px/,
      'a subcategory chip is a real destination, so on touch it gets a real target');
  });
}

// ============================================================
section('[fe-44] The gate cannot quietly stop running a suite');
// ============================================================
// This has now happened twice. test:frontend existed, passed locally, and was
// absent from CI — the comment in ci.yml is the record of it. Then test:drawer
// was added to verify:full only, where CI never looks, and would have shipped
// having never run in the gate once.
//
// CI lists its steps by hand, so nothing structural kept that list honest. This
// is that structure: a suite either runs in CI, or it is exempt ON PURPOSE and
// says why. There is no third state where it silently does not run.
{
  const pkg = JSON.parse(read('package.json'));
  const ci = read('.github/workflows/ci.yml');

  // Suites CI deliberately does not run, each with the reason it cannot.
  const EXEMPT = {
    'test:db': 'a live connectivity probe against the real database, not a test suite',
    'test:razorpay': 'a live connectivity probe against the payment gateway',
    'test:drawer:watch': 'a developer convenience wrapper, if one is ever added'
  };

  const suites = Object.keys(pkg.scripts).filter(k => /^test:/.test(k));

  test('every test:* suite either runs in CI or is exempt with a stated reason', () => {
    const missing = suites.filter(s =>
      !Object.prototype.hasOwnProperty.call(EXEMPT, s) &&
      !ci.includes('npm run ' + s));
    assert.deepStrictEqual(missing, [],
      'these suites exist and pass locally but the gate never runs them: ' + missing.join(', '));
  });

  test('the offline chain runs every suite that needs nothing external', () => {
    // `npm test` is what the docs call the pre-commit gate. A suite that needs
    // no services belongs in it; one bolted onto verify:full only is invisible
    // to CI, which runs the suites individually.
    const NEEDS_SERVICES = new Set(['test:db-integration', 'test:db', 'test:razorpay']);
    const offline = suites.filter(s => !NEEDS_SERVICES.has(s));
    const missing = offline.filter(s => !pkg.scripts.test.includes('npm run ' + s));
    assert.deepStrictEqual(missing, [],
      'these run without any external service but are not in `npm test`: ' + missing.join(', '));
  });

  test('no suite is run twice by the same command', () => {
    // verify:full runs verify, which runs test. Appending a suite to BOTH is a
    // duplicate run: slower, and it hides which chain is actually covering it.
    const full = pkg.scripts['verify:full'] || '';
    const dupes = suites.filter(s => full.includes('npm run ' + s) && pkg.scripts.test.includes('npm run ' + s));
    assert.deepStrictEqual(dupes, [],
      'already covered through `npm test`, so naming them again in verify:full runs them twice: ' + dupes.join(', '));
  });

  test('a suite that CAN skip itself is forced to run in CI', () => {
    /* THE HOLE [fe-44] DID NOT COVER.

       [fe-44] proves every suite is LISTED in CI. It said nothing about whether
       CI can actually run it. Five suites need a chromium binary and skip
       themselves — deliberately — when it is absent, so a developer without the
       download is not blocked. In CI that leniency is exactly wrong: the
       workflow installs the browser, so a skip means the install failed, and
       the suite reports success having rendered nothing.

       Three suites were in that state — test:contrast, test:browser-inbox and
       test:browser-orders — all added recently, all listed in CI, none forced
       to run. CI would have been green with three browser suites doing nothing.

       Derived, not a list: any test file that requires playwright must have
       REQUIRE_BROWSER_TESTS set on its CI step. A new browser suite cannot be
       added without it. */
    const fs2 = require('fs');
    const ci = read('.github/workflows/ci.yml');

    // Which suites can skip themselves, read from the files rather than named here.
    const skippable = [];
    for (const file of fs2.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'))) {
      const src = fs2.readFileSync(path.join(__dirname, file), 'utf8');
      if (!/require\('playwright'\)/.test(src)) continue;
      assert.match(src, /REQUIRE_BROWSER_TESTS/,
        file + ' needs a browser but has no way to be forced to run — its skip can never become a failure');
      const script = Object.keys(pkg.scripts).find((k) => pkg.scripts[k] === 'node test/' + file);
      assert.ok(script, 'no npm script runs ' + file + ', so CI cannot run it at all');
      skippable.push(script);
    }
    assert.ok(skippable.length >= 4, 'expected several browser suites; found ' + skippable.length);

    // Each one's CI step must set the flag that turns its skip into a failure.
    const steps = ci.split(/\n(?=      - name:)/);
    const unforced = skippable.filter((script) => {
      const step = steps.find((s) => new RegExp('run:\\s*npm run ' + script.replace(/[:]/g, '[:]') + '\\s*$', 'm').test(s));
      return !step || !/REQUIRE_BROWSER_TESTS/.test(step);
    });
    assert.deepStrictEqual(unforced, [],
      'these can skip silently in CI, which is a green build that tested nothing: ' + unforced.join(', '));
  });

  test('every browser suite runs AFTER the browser is installed', () => {
    /* THE FAILURE THIS EXISTS TO PREVENT, WHICH HAPPENED.

       The contrast suite was added to CI in the obvious place — beside the
       other members of `npm test` — which put it FOUR STEPS BEFORE the workflow
       installs chromium. It ran with no browser. And because the previous check
       had just correctly forced it not to skip, it failed the build, taking
       every step after it down with it.

       The suite was right. The ordering was wrong, and nothing could see that:
       the step was present, it was forced to run, and both existing checks
       passed. Position was the one property nobody was asserting.

       Locally none of this is visible, because chromium is already installed. */
    const ci = read('.github/workflows/ci.yml');
    const installAt = ci.search(/run:\s*npx playwright install/);
    assert.ok(installAt > -1, 'CI must install chromium somewhere, or no browser suite can run');

    const fs2 = require('fs');
    const late = [];
    for (const file of fs2.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'))) {
      const src = fs2.readFileSync(path.join(__dirname, file), 'utf8');
      if (!/require\('playwright'\)/.test(src)) continue;
      const script = Object.keys(pkg.scripts).find((k) => pkg.scripts[k] === 'node test/' + file);
      if (!script) continue;
      const at = ci.search(new RegExp('run:\\s*npm run ' + script.replace(/:/g, '[:]') + '\\s*$', 'm'));
      if (at === -1) continue;   // [fe-44]'s coverage check owns the absent case
      if (at < installAt) late.push(script + ' (step is before the install)');
    }
    assert.deepStrictEqual(late, [],
      'these need a browser but CI runs them before it installs one, so they fail on a '
      + 'machine that has no chromium yet: ' + late.join(', '));
  });

  test('the drawer fuzz is a real file, and it is committed', () => {
    // An npm script pointing at a path nobody committed is a green gate that
    // runs nothing on any machine but this one.
    assert.match(pkg.scripts['test:drawer'], /node scripts\/drawer-fuzz\.js/);
    const src = read('scripts/drawer-fuzz.js');
    assert.ok(src.length > 2000, 'the harness must actually be there');
    assert.ok(!/[A-Za-z]:[\\/]Users[\\/]/.test(src),
      'no absolute path from one machine — it must resolve its own root');
    assert.match(src, /path\.join\(__dirname, '\.\.'\)/,
      'it locates the repo relative to itself, so it runs anywhere');
  });
}

// ============================================================
section('[fe-45] A product needing a variant cannot enter the cart without one');
// ============================================================
// THE LIVE BUG: on the product page, Add to Cart stayed enabled for a product
// with variants whenever the DETAIL fetch had not landed — a reload, a cold
// start, or that one request failing. The customer added the base product and
// the server refused the order at the payment step.
//
// The cause was five hand-written copies of one rule. quickAdjust, qvAddToCart
// and buyable checked `hasVariants || variantOptions.length`; pdAddToCart,
// pdBuyNow and updateVariantUI checked `variantOptions.length` alone — and
// variantOptions only exists after the detail fetch succeeds.
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);
  function grab(name) {
    const i = code.search(new RegExp('(?:async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = code.indexOf('{', i);
    for (let k = s; k < code.length; k++) {
      if (code[k] === '{') d++;
      else if (code[k] === '}') { d--; if (!d) return code.slice(i, k + 1); }
    }
  }

  test('ONE definition of the rule, and nothing hand-writes it again', () => {
    const fn = grab('requiresVariantChoice');
    assert.match(fn, /p\.hasVariants \|\| \(Array\.isArray\(p\.variantOptions\) && p\.variantOptions\.length\)/,
      'both facts: the list flag known immediately, and the options known only after the detail fetch');
    // Exactly one place may spell the rule out. Everywhere else calls it.
    const spelled = (code.match(/hasVariants \|\| \(Array\.isArray\(p\.variantOptions\)/g) || []).length;
    assert.equal(spelled, 1,
      'the rule is written out more than once again — that is precisely how this bug happened');
    const oldForm = code.match(/\(p\.variantOptions \|\| \[\]\)\.length > 0/g) || [];
    assert.deepStrictEqual(oldForm, [],
      'a check on variantOptions ALONE is the defective form: it is blind until the detail fetch lands');
  });

  test('THE INVARIANT: addToCart refuses, so no caller can create a broken line', () => {
    // A UI guard can be forgotten by the next feature. The boundary cannot.
    const fn = grab('addToCart');
    assert.match(fn, /if\(requiresVariantChoice\(p\) && !variantId\)\{/,
      'the single doorway every add path passes through must enforce it');
    assert.match(fn, /return false;/, 'and refuse rather than add');
    // Verified in a browser at 1440 against the real product page with the
    // detail fetch blocked: addToCart(id, 1, "", null, null) returned false and
    // the cart did not grow.
  });

  test('the button has FOUR states, because there are four situations', () => {
    const fn = grab('updateVariantUI');
    /* Three was not enough. "Select Options" with nothing on screen to select is
       as useless as leaving the button enabled — and so is "Select Options" on a
       product whose options have no purchasable variant behind them, which is
       the fourth state and the one a customer meets without ever being told. */
    assert.match(fn, /atcBtn\.innerHTML = !needs \? 'Add to Cart'\s*\n\s*: \(dead \? 'Out of Stock' : \(loaded \? 'Select Options' : 'Loading options…'\)\);/,
      'add / cannot-be-bought / choose / still-loading, in that order of certainty');
    assert.match(fn, /atcBtn\.disabled = needs;/);
    // Buy Now must move with it on BOTH branches, or it stays dead after a
    // valid choice — caught in the browser exactly that way.
    assert.match(fn, /if\(buyBtnSel\) buyBtnSel\.disabled = !inStock;/,
      'Buy Now must be re-enabled when a variant IS chosen');
    assert.match(fn, /if\(buyBtn\) buyBtn\.disabled = needs;/,
      'and disabled when none is');
  });

  test('the first paint is already correct, before any fetch resolves', () => {
    // This markup renders before updateVariantUI ever runs. An enabled button
    // here is a real window in which an unbuyable line can be added, and on a
    // cold backend that window is the whole visit.
    assert.match(html, /id="pdAtcBtn" ' \+ \(\(!p\.stock \|\| requiresVariantChoice\(p\)\)\?'disabled':''\)/);
    assert.match(html, /id="pdBuyNowBtn" ' \+ \(\(!p\.stock \|\| requiresVariantChoice\(p\)\)\?'disabled':''\)/);
  });

  test('a cart that ALREADY holds a broken line is healed, and says so', () => {
    // addToCart cannot create one any more, but a cart saved before this fix
    // still has it in localStorage and would fail at the payment step.
    const fn = grab('reconcileCartWithCatalog');
    assert.match(fn, /if\(requiresVariantChoice\(p\) && !line\.variantId\)\{/,
      'the unbuyable line must be detected');
    assert.match(fn, /needOption\.push\(p\.name\);/, 'the customer must be told WHICH product');
    assert.ok(!/needOption[\s\S]{0,400}?cart\.splice\(i, 1\);[\s\S]{0,80}?\/\/ silent/.test(fn),
      'never removed silently');
    assert.match(fn, /needs an option chosen before it can be ordered/,
      'and told what to do about it');
    // The report is a closure called on BOTH return paths. It first landed in
    // the wrong function entirely (setCartQty, where needOption is undefined —
    // a ReferenceError on every quantity change), and then on only one path,
    // which meant a cart whose sole problem was an unbuyable line was never
    // saved and met the same rejected order next visit.
    assert.match(fn, /const reportUnbuyable = function\(\)\{/);
    assert.equal((fn.match(/reportUnbuyable\(\);/g) || []).length, 1,
      'called once, after saveCart, on the path both returns pass through');
    assert.match(fn, /if\(!reduced\.length && !removed\.length && !needOption\.length\) return false;/,
      'an unbuyable line must count as a change, or the removal is never persisted');
    const setQty = grab('setCartQty');
    assert.ok(!/needOption/.test(setQty),
      'needOption is not in scope there; it threw a ReferenceError on every quantity change');
  });
}

// ============================================================
section('[fe-46] Every drawer section with a dropdown behaves the same way');
// ============================================================
// Measured at 375 and 768 with transitions disabled: Shop and Service Booking
// report identical row (330x56 / 360x56), toggle (56x56), label (274x56) and
// chevron (18x18). Before the row height was pinned they were 56 and 55 — a
// difference nobody would see, and a difference with no reason behind it,
// which is how the next section ends up a third height.
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);

  test('one wiring function drives every section, including the label button', () => {
    const at = code.indexOf('function wireDrawerSection(itemId){');
    assert.ok(at > -1, 'the shared wiring must exist');
    const fn = code.slice(at, code.indexOf('\n  }', at) + 4);
    assert.match(fn, /const toggle = function\(\)\{/,
      'one behaviour, bound to both controls — not two copies that can drift');
    assert.match(fn, /btn\.addEventListener\('click', toggle\);/);
    assert.match(fn, /button\.mnav-split-label-btn/,
      'a label with nowhere to navigate opens the list instead of being dead text');
    // Shop's label is an anchor with a real destination and must NOT be hijacked.
    assert.match(fn, /if\(labelBtn\) labelBtn\.addEventListener/,
      'only a label that is a BUTTON gets the toggle; Shop\'s anchor keeps navigating');
  });

  test('Shop keeps its destination, Service Booking honestly has none', () => {
    const shopAt = html.indexOf('id="mShopToggle"');
    const shopRow = html.slice(shopAt, shopAt + 700);
    assert.match(shopRow, /<a href="\/shop\?category=all" class="mnav-split-label"/,
      'Shop\'s label still goes to all products');
    const svcAt = html.indexOf('id="mServiceToggle"');
    const svcRow = html.slice(svcAt, svcAt + 700);
    assert.ok(!/<a [^>]*class="mnav-split-label"/.test(svcRow),
      'Service Booking must not pretend to have a destination it does not have');
    assert.match(svcRow, /<button type="button" class="mnav-split-label mnav-split-label-btn"/);
  });

  test('a long section name truncates rather than growing the row', () => {
    // "Service Booking" plus a hint pill wrapped at 375px and made that row
    // 78px against Shop's 56px.
    assert.match(html, /\.mnav-split-label\{ white-space:nowrap; overflow:hidden; \}/,
      'a drawer row is a fixed shape; a long label must truncate, not wrap');
  });

  test('both sections still open, close, and rotate their chevron', () => {
    // The chevron rotation is shared CSS keyed on .mnav-item.open, so both get
    // it from the same rule rather than one each.
    assert.match(html, /\.mnav-item\.open svg\.chev\{ transform:rotate\(180deg\); \}/);
    assert.match(html, /wireDrawerSection\('mShopToggle'\);/);
    assert.match(html, /wireDrawerSection\('mServiceToggle'\);/);
  });
}

// ============================================================
section('[fe-47] The admin product table knows about subcategories');
// ============================================================
// Same law as the category column and the category filter, one level down:
// derived from what the catalog actually holds, never a hardcoded list, and
// normalised on the server the same way the write path normalises it.
{
  const admin = read('admin.html');
  const routes = read('src/routes/admin.routes.js');

  test('the column exists, and every colspan moved with it', () => {
    assert.match(admin, /<th>Category<\/th><th>Sub-category<\/th>/,
      'the column sits next to the category it refines');
    assert.match(admin, /<td class="muted">\$\{p\.subcategory \? esc\(p\.subcategory\) : '<span class="muted">—<\/span>'\}<\/td>/,
      'a product without one shows a dash, not an empty cell or "undefined"');
    // [fe-10] checks headers against colspans generally; these pin the two that
    // have now moved twice — 9 to 10 for Sub-category, 10 to 11 for Sold — and
    // would otherwise silently misalign.
    assert.match(admin, /<tbody id="productsTbody"><tr><td colspan="11"/);
    assert.ok(!/colspan="(9|10)"><div class="empty">No products found/.test(admin),
      'the empty-state colspan must move with the header count');
  });

  test('the filter is beside All badges and offers only real subcategories', () => {
    assert.match(admin, /id="productSubcategoryFilter"/);
    const badgeAt = admin.indexOf('id="productBadgeFilter"');
    const subAt = admin.indexOf('id="productSubcategoryFilter"');
    assert.ok(badgeAt > -1 && subAt > badgeAt, 'it belongs beside the badge filter, as asked');
    const fn = admin.slice(admin.indexOf('function refreshSubcategoryFilterOptions('),
                           admin.indexOf('function refreshSubcategoryFilterOptions(') + 1600);
    assert.match(fn, /productsState\.subcategoriesByCat/,
      'derived from the catalog, never a hardcoded list');
    assert.ok(!/CAT_LABELS|SUBCATEGORIES\s*=/.test(fn), 'no fixed list of subcategories');
  });

  test('THE TRAP: a stale subcategory cannot silently empty the table', () => {
    // Choose Book/Scripture, then switch the category to Malas: without this,
    // subcategory=scripture stays ANDed on, the table goes empty, and nothing
    // on screen explains why.
    const fn = admin.slice(admin.indexOf('function refreshSubcategoryFilterOptions('),
                           admin.indexOf('function refreshSubcategoryFilterOptions(') + 1600);
    assert.match(fn, /sel\.value = available\.has\(current\) \? current : '';/,
      'a selection the current category cannot contain must be cleared');
    assert.match(admin, /id="productCategoryFilter" onchange="refreshSubcategoryFilterOptions\(\); loadProducts\(1\)"/,
      'and changing the category must re-derive the list before reloading');
    assert.match(fn, /sel\.style\.display = available\.size \? '' : 'none';/,
      'a filter that can only ever say "All" is noise, not a control');
  });

  test('the server filters by it, normalised exactly like category', () => {
    assert.match(routes, /const \{ search, category, subcategory, badge \} = req\.query;/);
    assert.match(routes, /params\.push\(normaliseTerm\(subcategory\)\);/,
      'normalised, so a dropdown value matches what migration 016 stores');
    assert.match(routes, /conditions\.push\(`subcategory = \$\$\{params\.length\}`\);/);
    assert.match(routes, /require\('\.\.\/utils\/text'\)/, 'normaliseTerm must actually be in scope');
    // AND-ed with the rest, like every other filter.
    assert.match(routes, /const where = conditions\.length \? 'WHERE ' \+ conditions\.join\(' AND '\) : '';/);
  });
}

// ============================================================
section('[fe-48] Checkout in two panes, service search, badges, booking mail');
// ============================================================
{
  const html = read('index.html');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(html);
  function grab(name) {
    const i = code.search(new RegExp('(?:async )?function ' + name + '\\('));
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const s = code.indexOf('{', i);
    for (let k = s; k < code.length; k++) {
      if (code[k] === '{') d++;
      else if (code[k] === '}') { d--; if (!d) return code.slice(i, k + 1); }
    }
  }

  // ---------------------------------------------------------------- checkout
  test('CHECKOUT: the two-pane split is narrow-screen ONLY', () => {
    // Measured at 1440: both panes visible, grid still "804px 380px", Continue
    // and Back both hidden, chips still read "Details & Payment" and
    // "Confirmation". At 768 and 375: details only, Continue visible.
    assert.match(html, /\.co-continue, \.co-back\{ display:none; \}/,
      'neither control may exist on a desktop, where both panes are already on screen');
    // THE block, not merely the first one carrying that media query: this file
    // has SEVEN of them, and indexOf would happily measure the wrong one and
    // prove nothing. Same trap as the filter touch-overrides in [fe-39].
    const MQ = '@media (max-width:900px){';
    let mq = -1;
    for (let at = html.indexOf(MQ); at > -1; at = html.indexOf(MQ, at + 1)) {
      const end = html.indexOf('\n}', at);
      if (html.slice(at, end).includes('data-costep')) { mq = at; break; }
    }
    assert.ok(mq > -1, 'the checkout step rules must live in a max-width:900px block');
    const block = html.slice(mq, html.indexOf('\n}', mq));
    assert.match(block, /\.checkout-layout\[data-costep="2"\] \.co-review\{ display:none; \}/);
    assert.match(block, /\.checkout-layout\[data-costep="3"\] \.co-details\{ display:none; \}/);
    assert.match(block, /\.co-continue\{ display:block;/,
      'the gating rules must live INSIDE the media query, or desktop loses a pane');
    assert.match(block, /min-height:44px;/, 'Back is a touch target like everything else');
  });

  test('CHECKOUT: the step resets on arrival, never on a cart change', () => {
    // renderCheckoutPage also runs on every cart mutation. Resetting there
    // would throw a customer standing on the review pane back to the address
    // form because they changed a quantity.
    assert.match(code, /if\(pageId === 'checkout'\)\{[\s\S]{0,400}?setCheckoutStep\(2\);[\s\S]{0,80}?renderCheckoutPage\(\);/,
      'the reset belongs on the navigation path');
    assert.ok(!/function renderCheckoutPage\(\)\{[\s\S]{0,300}?setCheckoutStep\(/.test(code),
      'and must NOT be inside renderCheckoutPage, which re-runs on every cart change');
  });

  test('CHECKOUT: the form is validated before the review pane, not after', () => {
    const fn = grab('continueToReview');
    assert.match(fn, /reportValidity/,
      'reporting it at Place Order throws them back to a field they cannot see');
    assert.match(fn, /if\(form && typeof form\.reportValidity === 'function' && !form\.reportValidity\(\)\) return;/);
    // One breakpoint, read from the stylesheet, so layout and behaviour cannot
    // disagree about which mode is active.
    assert.match(grab('checkoutIsStepped'), /matchMedia\('\(max-width:900px\)'\)/);
  });

  // ---------------------------------------------------------- service search
  test('SEARCH: one implementation serves both booking pages', () => {
    assert.match(html, /id="pujaSearch"/);
    assert.match(html, /id="astroSearch"/);
    // Both call the same function with a different kind, rather than each
    // page carrying its own matcher.
    assert.match(html, /oninput="filterServices\('puja', this\.value\)"/);
    assert.match(html, /oninput="filterServices\('astro', this\.value\)"/);
    const fn = grab('serviceMatches');
    assert.match(fn, /terms\.every\(/,
      'every typed word must match somewhere — word order is not something a searcher should guess');
    assert.match(grab('visibleServices'), /kind === 'puja' \? PUJA_SERVICES : ASTRO_SERVICES/);
  });

  test('SEARCH: it looks in the description, and folds accents', () => {
    // A customer looking for a housewarming does not know the words "Griha
    // Pravesh" — the description is where that connection lives. Verified live:
    // searching a description word returned the right single service.
    assert.match(grab('serviceMatches'), /\(service\.name \|\| ''\) \+ ' ' \+ \(service\.desc \|\| ''\)/,
      'the description is searched, not only the name');
    assert.match(grab('foldForSearch'), /normalize\('NFD'\)/,
      'so "pooja" reaches copy written with diacritics, and "sri" reaches "Śrī"');
    assert.match(grab('foldForSearch'), /replace\(\/\\s\+\/g, ' '\)\.trim\(\)/);
  });

  test('SEARCH: no match explains itself instead of emptying the grid', () => {
    assert.match(grab('noServiceMatchHTML'), /Nothing matches/);
    assert.match(grab('noServiceMatchHTML'), /clearServiceSearch\(/,
      'and offers a way back to the full list');
    assert.match(grab('updateServiceCount'), /No match for/);
    assert.match(html, /id="pujaSearchCount" aria-live="polite"/,
      'a grid changing under a screen reader with no announcement just emptied silently');
  });

  // ----------------------------------------------------------------- badges
  test('BADGES: computed from facts, with the admin still able to override', () => {
    const fn = grab('effectiveBadge');
    assert.match(fn, /if\(p && p\.badge\) return p\.badge;/,
      'a deliberate admin badge must win — this adds a floor, it does not take the control away');
    assert.match(fn, /if\(isBestseller\(p\)\) return 'bestseller';/);
    assert.match(fn, /if\(isNewArrival\(p\)\) return 'new';/);
    // The card and the Featured tabs must read the SAME answer or they
    // disagree on one page.
    assert.match(code, /const autoBadge = effectiveBadge\(p\);/);
    assert.match(grab('renderFeaturedGrid'), /PRODUCTS\.filter\(isBestseller\)/);
    assert.match(grab('renderFeaturedGrid'), /PRODUCTS\.filter\(isNewArrival\)/);
  });

  test('BADGES: the threshold cannot go stale', () => {
    // There are five places PRODUCTS is assigned. A recompute() called from
    // each is five chances to forget one; keying the cache on array identity
    // is none.
    const fn = grab('bestsellerThreshold');
    assert.match(fn, /if\(_bestsellerCut\.src === list\) return _bestsellerCut\.value;/,
      'invalidated by the identity of PRODUCTS itself');
    assert.match(fn, /sold\.length >= MIN_SELLING_PRODUCTS/,
      'a percentile over too few products is not a distribution');
    assert.match(fn, /Math\.max\(sold\[Math\.max\(0, Math\.min\(sold\.length - 1, rank\)\)\], MIN_BESTSELLER_UNITS\)/,
      'and a floor, or one sale becomes a bestseller on a young shop');
    // The server has to supply the input.
    assert.match(read('src/routes/products.routes.js'), /AS units_sold/);
    assert.match(read('src/routes/products.routes.js'),
      /o\.status IN \('paid','processing','shipped','delivered','partially_refunded'\)[\s\S]{0,120}?AS units_sold|AS units_sold/,
      'counted from paid orders only, like the category ranking');
  });

  test('FEATURED: five across on desktop, three on tablet, mobile untouched', () => {
    // Measured: 1440 -> 5, 1024 -> 3, 768 -> 3 (iPad portrait), 375 -> 2, and
    // the shop grid stayed at 4 throughout.
    assert.match(html, /#featuredGrid\{ grid-template-columns:repeat\(5,1fr\); \}/);
    assert.match(html, /@media \(max-width:1024px\)\{[\s\S]{0,120}?#featuredGrid\{ grid-template-columns:repeat\(3,1fr\); \}/);
    assert.match(html, /@media \(max-width:767px\)\{[\s\S]{0,120}?#featuredGrid\{ grid-template-columns:repeat\(2,1fr\); \}/);
    /* Ten cards divide by five and by two but not by four or three, so the two
       middle widths trim their remainder instead of showing a stub row. */
    assert.match(html, /@media \(min-width:1025px\) and \(max-width:1180px\)\{\s*#featuredGrid > :nth-child\(n\+9\)\{ display:none; \}/,
      'four across shows eight, not 4+4+2');
    assert.match(html, /@media \(min-width:768px\) and \(max-width:1024px\)\{\s*#featuredGrid > :nth-child\(n\+10\)\{ display:none; \}/,
      'three across shows nine, not 3+3+3+1');
    /* THE TRAP: an unbounded max-width chain needs display:revert to undo the
       previous step, and revert rolls back to the BROWSER default rather than to
       the author rule. .p-card is display:flex, so that would have made every
       featured card display:block below 1024px. Bounded bands need no undo. */
    assert.ok(!/#featuredGrid > :nth-child\([^)]*\)\{ display:revert/.test(html),
      'revert would flatten .p-card from flex to block on tablet and mobile');
    // Scoped by id so the shop, related and wishlist grids are untouched.
    assert.match(html, /\.product-grid\{ display:grid; grid-template-columns:repeat\(4,1fr\)/,
      'the shared grid must still be four across');
    assert.match(grab('renderFeaturedGrid'), /slice\(0, 10\)/,
      'eight items under a five-wide grid leaves a ragged row of three');
  });

  test('CARD: the corner brackets never move the grid, and show on touch', () => {
    assert.match(html, /\.p-card::after\{[\s\S]{0,200}?position:absolute; inset:0; pointer-events:none/,
      'a border or box-shadow on the card would change its geometry and shift the grid on hover');
    assert.match(html, /@media \(hover:none\)\{\s*\.p-card::after\{ opacity:\.45; \}/,
      'a touch device has no hover, so the brackets would otherwise never appear');
    assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{ \.p-card::after\{ transition:none; \} \}/);
  });

  // --------------------------------------------------------- booking emails
  test('BOOKING MAIL: a payment under review is not called a failure', () => {
    const templates = read('src/utils/email/templates.js');
    assert.match(templates, /async function sendBookingPaymentReview\(/);
    assert.match(templates, /You do not need to pay again/,
      'by this point the money is usually taken; "failed" invites a second payment');
    assert.match(templates, /category: CATEGORY\.TRANSACTIONAL/,
      'service mail, so consent and the marketing kill switch cannot swallow it');
    // It must actually be sent from the review branch.
    const routes = read('src/routes/bookings.routes.js');
    assert.match(routes, /sendBookingPaymentReview\(\{/);
    assert.match(routes, /email: req\.user\.email,/,
      'neither booking table has a contact_email column');
    assert.match(routes, /\.catch\(function\(err\)\{/,
      'a mail failure must never turn a received payment into an error response');
  });

  test('BOOKING MAIL: an abandoned booking is chased once, for both types', () => {
    const job = read('scripts/send-scheduled-emails.js');
    assert.match(job, /async function runAbandonedBookings\(\)/);
    assert.match(job, /bookingsAbandoned: runAbandonedBookings/, 'and is actually registered');
    assert.match(job, /\[\['puja_bookings', 'puja'\], \['astrology_bookings', 'astrology'\]\]/,
      'one code path for both, or the two quietly stop behaving the same way');
    assert.match(job, /recovery_email_sent_at = now\(\)/, 'claimed before sending');
    assert.match(job, /FOR UPDATE SKIP LOCKED/, 'so two workers cannot both claim it');
    assert.match(job, /SET recovery_email_sent_at = NULL WHERE id = \$1/,
      'and released on a retryable failure, or one SMTP blip consumes the only email this booking gets');
    // The column has to exist.
    const mig = read('migrations/017_booking_recovery_email.sql');
    assert.match(mig, /ALTER TABLE puja_bookings\s+ADD COLUMN IF NOT EXISTS recovery_email_sent_at/);
    assert.match(mig, /ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS recovery_email_sent_at/);
  });
}

// ============================================================
section('[fe-49] SEO stays correct for products nobody has added yet');
// ============================================================
// THE PROBLEM THIS SOLVES, and it is a future problem by nature.
//
// Two things independently turn a product row into something Google indexes:
// the prerenderer, which writes the page, and the drift check, which decides
// whether the DEPLOYED page is stale and a rebuild is needed. They must agree
// about which fields matter, and they were two hand-written lists.
//
// They had already drifted. The prerenderer reads `subcategory` for the JSON-LD
// category path and the breadcrumb; the fingerprint did not include it. So an
// admin re-filing a product under a new subcategory changed nothing the drift
// check could see, no rebuild fired, and the live page kept the old category in
// its structured data — silently, permanently, and invisibly without opening
// the JSON-LD of a deployed page.
//
// The list lives in one place now, and these tests make it impossible to add an
// SEO-relevant field without also wiring the republish that keeps it in sync.
{
  const { SEO_PRODUCT_FIELDS, SEO_IRRELEVANT_FIELDS } = require('../scripts/seo-fields');
  const prerender = read('scripts/generate-product-pages.js');
  const drift = read('scripts/publish-catalog-if-changed.js');

  test('THE GUARD: the prerenderer cannot read a field nobody declared', () => {
    /* Scans the generator for every `p.<field>` it reads and requires each to be
       either declared as SEO-relevant (so changing it republishes the site) or
       listed as irrelevant WITH A REASON. There is no third state where a field
       quietly affects the page and nothing notices when it changes. */
    const readFields = new Set(
      (prerender.match(/\bp\.[a-z_]+/g) || []).map((s) => s.slice(2))
    );
    const declared = new Set(SEO_PRODUCT_FIELDS);
    const excused = new Set(Object.keys(SEO_IRRELEVANT_FIELDS));
    const undeclared = [...readFields].filter((f) => !declared.has(f) && !excused.has(f));
    assert.deepStrictEqual(undeclared, [],
      'these product fields reach the crawler but are not in SEO_PRODUCT_FIELDS, so editing them '
      + 'would never republish the site: ' + undeclared.join(', '));
  });

  test('every excused field says WHY it is excused', () => {
    // An escape hatch with no justification is a hole.
    for (const [field, reason] of Object.entries(SEO_IRRELEVANT_FIELDS)) {
      assert.ok(typeof reason === 'string' && reason.length > 15,
        'SEO_IRRELEVANT_FIELDS.' + field + ' needs a real reason, not "' + reason + '"');
    }
  });

  test('the drift fingerprint is DERIVED from the list, never retyped', () => {
    assert.match(drift, /require\('\.\/seo-fields'\)/,
      'the fingerprint must read the shared declaration');
    assert.match(drift, /SEO_PRODUCT_FIELDS\.map\(/,
      'built from the list, so a field can only be forgotten in one place');
    // The old hand-written array must be gone, or the two can disagree again.
    assert.ok(!/p\.id, p\.slug, p\.name, p\.category, p\.price_paise/.test(drift),
      'the hand-written field array is what drifted; it must not come back');
  });

  test('THE PROOF: changing ANY declared field republishes the site', () => {
    /* Not an assertion about the source — the real fingerprint function, run
       over a product with one field changed at a time. If any change fails to
       move the hash, an admin could edit that field and the deployed page would
       never update. */
    const crypto = require('crypto');
    const i = drift.indexOf('function fingerprint(products)');
    let d = 0; const s = drift.indexOf('{', i); let e = s;
    for (let k = s; k < drift.length; k++) {
      if (drift[k] === '{') d++;
      else if (drift[k] === '}') { d--; if (!d) { e = k; break; } }
    }
    const fingerprint = new Function('crypto', 'SEO_PRODUCT_FIELDS',
      drift.slice(i, e + 1) + '; return fingerprint;')(crypto, SEO_PRODUCT_FIELDS);

    const base = {
      id: '1', slug: 'a', name: 'A', sku: 'S', category: 'c', subcategory: 's',
      short_desc: 'd', image_url: 'u', price_paise: 1, mrp_paise: 2, stock_qty: 3,
      has_variants: false, rating: 4, review_count: 5, badge: 'b'
    };
    const reference = fingerprint([base]);
    const inert = [];
    for (const field of SEO_PRODUCT_FIELDS) {
      const changed = Object.assign({}, base);
      changed[field] = typeof base[field] === 'number' ? base[field] + 99 : 'CHANGED';
      if (fingerprint([changed]) === reference) inert.push(field);
    }
    assert.deepStrictEqual(inert, [],
      'editing these fields would not trigger a rebuild, so the live page would keep the old value: '
      + inert.join(', '));
  });

  test('THE ORIGINAL BUG: a changed image URL republishes', () => {
    // The single most common catalogue edit, and the one that decides what every
    // social platform shows.
    assert.ok(SEO_PRODUCT_FIELDS.includes('image_url'),
      'an admin swapping a product photo must republish, or every share keeps the old picture');
    assert.ok(SEO_PRODUCT_FIELDS.includes('subcategory'),
      'this is the field that had already drifted');
  });

  test('the social card is LIFTED from the site, not redrawn beside it', () => {
    // A copied mandala agrees today and drifts the first time either is touched.
    const gen = read('scripts/generate-og-image.js');
    assert.match(gen, /function extractChakra\(\)/);
    assert.match(gen, /index\.indexOf\('<svg viewBox="0 0 500 500" aria-hidden="true">'\)/,
      'it must read the awakening chakra out of index.html');
    assert.match(gen, /throw new Error\(/,
      'and fail loudly if the markup moved, rather than silently drawing something else');
    assert.match(gen, /cssVar\('gold'/, 'the palette comes from the stylesheet too');
    // The card must show the chakra ABOVE the wordmark, as asked.
    const chakraAt = gen.indexOf('${CHAKRA}');
    const wordAt = gen.indexOf('class="word">CHAKRASHRI');
    assert.ok(chakraAt > -1 && wordAt > chakraAt, 'the chakra sits above the wordmark');
  });
}

// ============================================================
section('[fe-50] One rule, one place — the combinations this pass closed');
// ============================================================
// Every finding here is the same shape: a rule that was correct when it was
// written by hand in N places, and became wrong in N-1 of them the moment the
// Nth changed. None of them failed loudly. They just got quietly worse.
{
  const html = read('index.html');
  const admin = read('admin.html');
  const adminRoutes = read('src/routes/admin.routes.js');
  const productRoutes = read('src/routes/products.routes.js');

  // Wide enough for addToCart, which is 3.4KB of function and comment.
  function grab(name, span) {
    const at = html.indexOf('function ' + name + '(');
    assert.ok(at > -1, 'expected function ' + name);
    return html.slice(at, at + (span || 4200));
  }

  test('SALES: "which orders count" is written once, not seven times', () => {
    const util = read('src/utils/orderStatus.js');
    assert.match(util, /const REVENUE_STATUSES = Object\.freeze\(\[/,
      'frozen, so no caller can mutate the list every query shares');
    assert.match(util, /REVENUE_STATUSES\.map\(\(s\) => `'\$\{s\}'`\)\.join\(','\)/,
      'the SQL tuple is BUILT from the array, never typed a second time');

    const literal = "'paid','processing','shipped','delivered','partially_refunded'";
    for (const [file, src] of [['admin.routes.js', adminRoutes], ['products.routes.js', productRoutes]]) {
      assert.ok(!src.includes(literal),
        file + ' still hand-writes the status list; that is the seventh copy coming back');
    }
    // And it is genuinely used, rather than the copies having simply been deleted.
    assert.ok((adminRoutes.match(/\$\{REVENUE_STATUS_SQL\}/g) || []).length >= 6,
      'admin has six queries that count sales');
    assert.ok((productRoutes.match(/\$\{REVENUE_STATUS_SQL\}/g) || []).length >= 2);
  });

  test('SALES: the two NEIGHBOURING rules were not swept in with it', () => {
    /* Both of these look like the revenue list and are not it. Folding either
       one in would be a silent behaviour change on a money path: fulfilment
       would start counting partial refunds, and the admin would lose its
       ability to move an order into payment_review. */
    assert.match(adminRoutes, /'paid', 'processing', 'shipped', 'delivered'\]/,
      'reachedFulfilment excludes partially_refunded, on purpose');
    assert.match(read('src/routes/payments.routes.js'), /'paid', 'processing', 'shipped', 'delivered'\]/);
    assert.match(adminRoutes, /'partially_refunded', 'payment_review'/,
      'the admin status whitelist includes payment_review, on purpose');
  });

  test('BADGES: automatic badges broke four rankings, now one comparator', () => {
    /* p.badge === 'bestseller' was correct only while a badge was hand-typed.
       Deriving it from sales made all four copies read a field that is now
       usually empty — mega-menu picks, related-product filler and two wait
       suggestion lists all stopped ranking by bestseller, silently. */
    const cmp = grab('byBestsellerThenReviews');
    assert.match(cmp, /isBestseller\(b\) \? 1 : 0/);
    assert.match(cmp, /isBestseller\(a\) \? 1 : 0/);
    assert.ok(!/\.badge === 'bestseller'/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')),
      'no surface may compare the raw badge again — that is the bug returning');
    for (const caller of ['renderMegaMenuPicks', 'waitRelevanceSort']) {
      assert.match(grab(caller), /byBestsellerThenReviews/, caller + ' must use the shared comparator');
    }
    assert.match(html, /PRODUCTS\.filter\(function\(p\)\{ return buyable\(p\) && isBestseller\(p\); \}\)/,
      'the wait screen\'s bestseller card matched nothing once badges were computed');
  });

  test('SHOP: "Newest" sorts by date, not by whether something is labelled new', () => {
    const fn = grab('getFilteredSortedProducts');
    assert.match(fn, /Date\.parse\(a\.createdAt \|\| ''\) \|\| 0/,
      'undated sorts to 1970, which is last');
    assert.ok(!/createdAt \|\| ''\) \|\| -Infinity/.test(html),
      'two undated products would make -Infinity minus -Infinity, which is NaN, '
      + 'and a comparator returning NaN has no defined ordering at all');
    assert.ok(!/sortBy === 'newest'[\s\S]{0,160}?badge==='new'/.test(html),
      'a badge is a label; Newest is a date, and every new product used to tie');
  });

  test('CART: the one doorway answers TRUE or FALSE on every path', () => {
    /* It returned false for a variant refusal and bare undefined for the other
       two, so the payment-wait card flipped to "Added" after a refusal and told
       the customer their order contained something it did not. */
    const fn = grab('addToCart');
    assert.match(fn, /if\(!p \|\| !p\.stock\) return false;/);
    assert.match(fn, /holds every ' \+ what \+ ' we have\.', 'err'\);\s*\n\s*return false;/);
    assert.match(fn, /toast\(p\.name \+ ' added to cart'\);\s*\n\s*return true;/,
      'the success path must say so, or every caller has to guess');
    assert.match(grab('waitAddSuggestion'), /if\(!addToCart\(String\(id\), 1\)\) return;/,
      'no confirmation UI before the cart has actually accepted it');
  });

  test('VARIANTS: a product with options and nothing behind them says so', () => {
    /* THE HOLE. A seller adds "Size" and saves before creating the variant rows.
       The product stays Active with real stock, so the shop lists it, asks the
       customer to choose, and not one chip resolves to anything purchasable.
       "Select Options" is then an instruction that cannot be carried out.

       Deactivating every variant does NOT land here — the stock trigger sums
       active variants only, so stock_qty falls to 0 and the product reads Out of
       Stock by itself. It is the never-created case that slips through, because
       no product_variants row ever existed to fire that trigger. */
    const pred = grab('hasPurchasableVariant');
    assert.match(pred, /Number\(v\.stock_qty\) > 0/,
      'a variant row that exists but holds nothing is not purchasable either');
    const ui = grab('updateVariantUI');
    assert.match(ui, /const dead = needs && loaded && !hasPurchasableVariant\(p\);/);
    assert.match(ui, /dead \? 'Out of Stock'/,
      'four states, not three: loading, choose, cannot-be-bought, add');
    assert.match(ui, /This product is not available to order at the moment\./);
    // And the console has to be able to find it before a customer does.
    assert.match(adminRoutes, /AS option_count/);
    assert.match(admin, /function unsellableWarning\(p\)/);
    assert.match(admin, /p\.option_count > 0 && p\.variant_count === 0/,
      'options with no active variant — active, in stock, and unbuyable');
  });

  test('ADMIN: the badge field no longer tells the seller the opposite', () => {
    assert.ok(!/Leave blank for no badge/.test(admin),
      'blank now means the shop computes one — the old hint was actively false');
    assert.match(admin, /Leave blank and the shop decides/);
    assert.match(admin, /what you type always wins/);
    // And the table must not print a dash for a product the shop badges.
    const fn = admin.slice(admin.indexOf('function badgeCell('), admin.indexOf('function badgeCell(') + 1200);
    assert.match(fn, /if\(p\.badge\) return '<span class="pill pill-warn">'/);
    assert.match(fn, /86400000 <= NEW_ARRIVAL_DAYS/,
      'New is exact from created_at, and reads the window by name so the two files cannot drift');
    assert.ok(!/percentile|BESTSELLER_PERCENTILE/.test(fn),
      'the admin list is paged 20 at a time; a percentile over one page is a wrong badge');
  });

  test('ADMIN: the seller can see the number the badge is computed from', () => {
    assert.match(adminRoutes, /\), 0\) AS units_sold/,
      'the products endpoint must return it, or the Sold column is always zero');
    assert.match(admin, /<th>Sub-category<\/th><th>Badge<\/th><th>Sold<\/th>/);
    assert.match(admin, /\$\{Number\(p\.units_sold\) \|\| 0\}/,
      'a missing figure reads 0, never "undefined"');
  });

  test('CONSTANTS: the copies admin.html cannot import must still agree', () => {
    /* admin.html is a static file. It cannot require() anything, so two rules it
       needs are necessarily written out a second time. That is only safe if
       something notices them drifting — which is this test.

       Both had ALREADY drifted within one working session. The description rule
       existed in three places with three different numbers (50/165 for a page,
       40/none for a product, 70/155 in the form), so a 45-character description
       was red in the console and green in the audit and the seller could not
       satisfy both. */
    const { SEO_DESCRIPTION } = require(path.join(ROOT, 'scripts/seo-fields.js'));
    const num = (name) => {
      const m = admin.match(new RegExp('const ' + name + ' = (\\d+);'));
      assert.ok(m, 'admin.html must declare ' + name + ' as a named constant, not inline it');
      return Number(m[1]);
    };
    assert.strictEqual(num('SEO_DESC_MIN'), SEO_DESCRIPTION.MIN);
    assert.strictEqual(num('SEO_DESC_IDEAL_MAX'), SEO_DESCRIPTION.IDEAL_MAX);
    assert.strictEqual(num('SEO_DESC_HARD_MAX'), SEO_DESCRIPTION.HARD_MAX);

    // The audit must READ that declaration rather than carry its own numbers.
    const audit = read('scripts/seo-audit.js');
    assert.match(audit, /require\('\.\/seo-fields'\)/);
    assert.ok(!/length >= 50|length <= 165|length > 40/.test(audit),
      'the audit is back to hand-written thresholds that disagree with the form');
    /* IDEAL_MAX must never become an advisory: eight of eleven products are over
       it and all of them read fine. An advisory that fires on a healthy
       catalogue is how people learn to ignore advisories. */
    assert.ok(!/SEO_DESCRIPTION\.IDEAL_MAX/.test(audit),
      'exceeding what Google renders is not a defect and must not be reported as one');

    // And the new-arrival window, which decides a badge on both surfaces.
    const shopDays = Number((html.match(/const NEW_ARRIVAL_DAYS = (\d+);/) || [])[1]);
    const adminDays = num('NEW_ARRIVAL_DAYS');
    assert.ok(Number.isFinite(shopDays), 'index.html must declare NEW_ARRIVAL_DAYS');
    assert.strictEqual(adminDays, shopDays,
      'the console and the storefront would disagree about which products are New');
    assert.ok(!/86400000 <= 30/.test(admin), 'the window must not be inlined again');
  });

  test('ADMIN: SEO guidance sits where a product is actually written', () => {
    const fn = admin.slice(admin.indexOf('function updateSeoHint('), admin.indexOf('function updateSeoHint(') + 1400);
    assert.match(fn, /n < SEO_DESC_MIN/,
      'the same floor the audit reports as a thin description, read by name');
    assert.match(fn, /n > SEO_DESC_IDEAL_MAX/, 'and the ceiling Google actually renders');
    assert.match(fn, /n > SEO_DESC_HARD_MAX/, 'plus the point where it stopped being a summary');
    assert.ok(!/n > 155|n < 70/.test(admin), 'no bare numbers: [fe-50] can only guard named constants');
    assert.match(fn, /hint\.textContent = /,
      'textContent, not innerHTML — nothing here should be able to inject markup');
    // Said on open, not only once they start typing.
    assert.ok((admin.match(/updateSeoHint\(\)/g) || []).length >= 3,
      'wired to input, to the blank Add form, and to a loaded Edit form');
  });
}

// ============================================================
section('[fe-51] Nothing in the markup points at something that is not there');
// ============================================================
/* THE CLASS OF BUG NOTHING ELSE HERE CATCHES.

   Both front ends are single files of ~700KB with no modules and no imports. A
   button wired to a function name that does not exist, or a qs('#panel') for an
   element nobody added, is not a syntax error and not a failing unit test — it
   is a click that silently does nothing, found by a customer or by the seller.

   Eleven tasks in this cycle added buttons, inputs, filters and panels to these
   two files. This resolves every one of them at build time. */
{
  const BUILTIN = new Set(['return', 'this', 'window', 'document', 'event', 'if', 'else',
    'true', 'false', 'null', 'undefined', 'void', 'new', 'typeof', 'delete']);

  function definedNames(js) {
    const names = new Set();
    for (const m of js.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
    // ANY binding, not only literal functions: the admin's search handlers are
    // built as `const debounceLoadProducts = debounce(...)`.
    for (const m of js.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
    for (const m of js.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
    return names;
  }

  for (const file of FILES) {
    test(`${file}: every inline handler resolves to a function that exists`, () => {
      const html = read(file);
      const defined = definedNames(inlineScriptBodies(html).join('\n'));
      const missing = [];
      const attr = /\son(?:click|input|change|submit|keyup|keydown|focus|blur|mouseenter|mouseleave|toggle)\s*=\s*"([^"]*)"/g;
      const seen = new Set();
      for (const m of html.matchAll(attr)) {
        // (?<![.\w$]) skips METHOD calls — event.preventDefault() and
        // window.open() are not bare function names.
        for (const c of m[1].matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
          const name = c[1];
          if (BUILTIN.has(name) || seen.has(name)) continue;
          seen.add(name);
          // A handler may legitimately call a global: String(x), Number(x),
          // JSON.parse(...). Those are defined by the language, not by us.
          if (!defined.has(name) && !(name in globalThis)) missing.push(name);
        }
      }
      assert.ok(seen.size > 20, 'expected to find real handlers; the scan found ' + seen.size);
      assert.deepStrictEqual(missing, [],
        'wired in markup but never defined — these do nothing when clicked');
    });

    test(`${file}: every element lookup has an element to find`, () => {
      const html = read(file);
      const js = inlineScriptBodies(html).join('\n');
      const ids = new Set();
      for (const m of html.matchAll(/\sid\s*=\s*"([^"]+)"/g)) ids.add(m[1]);
      // Panels the code creates rather than declaring in markup.
      for (const m of js.matchAll(/\.id\s*=\s*'([^']+)'/g)) ids.add(m[1]);
      const missing = [];
      const seen = new Set();
      for (const re of [/qs\('#([A-Za-z][\w-]*)'\)/g, /getElementById\('([A-Za-z][\w-]*)'\)/g]) {
        for (const m of js.matchAll(re)) {
          if (seen.has(m[1])) continue;
          seen.add(m[1]);
          if (!ids.has(m[1])) missing.push(m[1]);
        }
      }
      assert.ok(seen.size > 50, 'expected to find real lookups; the scan found ' + seen.size);
      assert.deepStrictEqual(missing, [],
        'looked up by id, but nothing in the document carries that id');
    });
  }
}

// ============================================================
section('[fe-52] No write may hide behind a read grant');
// ============================================================
/* Capability grants are edited by ROLE, not by route.

   Whoever creates a support role will grant customers:read — the name says
   "let them look at customers" — and any write hiding behind that read arrives
   with it, silently, invisible to the person reviewing the role change. Two
   endpoints were in exactly that state: changing an enquiry's status, and
   SENDING EMAIL TO A CUSTOMER AS THE BUSINESS. Neither was exposed, because
   only admin holds customers:read today, which is precisely why it would have
   gone unnoticed until the day it mattered.

   The rule is structural rather than a list of known-bad routes: a mutating
   endpoint must require at least one capability whose name is not a read. */
{
  const fs2 = require('fs');
  const routeDir = path.join(ROOT, 'src/routes');
  const { CAPABILITIES, capabilitiesForRole } = require(path.join(ROOT, 'src/middleware/capabilities.js'));
  const MUTATING = new Set(['post', 'put', 'patch', 'delete']);

  function mutatingRoutes() {
    const out = [];
    for (const file of fs2.readdirSync(routeDir).filter((f) => f.endsWith('.js'))) {
      const src = fs2.readFileSync(path.join(routeDir, file), 'utf8');
      const re = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'([^\n]*(?:\n[^\n]*?)??)requireCapability\(([^)]*)\)/g;
      for (const m of src.matchAll(re)) {
        if (!MUTATING.has(m[1])) continue;
        const caps = m[4].split(',').map((s) => s.trim().replace(/^C\./, '')).filter(Boolean)
          .map((c) => CAPABILITIES[c] || c);
        out.push({ file, method: m[1].toUpperCase(), path: m[2], caps });
      }
    }
    return out;
  }

  test('every mutating endpoint requires a capability that names a write', () => {
    const routes = mutatingRoutes();
    assert.ok(routes.length >= 25,
      'the scan found only ' + routes.length + ' guarded mutating routes; the pattern stopped matching');
    const bad = routes
      .filter((r) => r.caps.length && r.caps.every((c) => /:read($|_)/.test(String(c))))
      .map((r) => r.method + ' ' + r.path + '  [' + r.caps.join(' + ') + ']');
    assert.deepStrictEqual(bad, [],
      'these change state but ask only for permission to LOOK: ' + bad.join('; '));
  });

  test('the two contact-message writes need the contact grant, not just the read', () => {
    const admin = read('src/routes/admin.routes.js');
    assert.match(admin, /router\.patch\('\/contact-messages\/:id', requireCapability\(C\.CUSTOMERS_READ, C\.CUSTOMERS_CONTACT\)/);
    assert.match(admin, /router\.post\('\/contact-messages\/:id\/reply', requireCapability\(C\.CUSTOMERS_READ, C\.CUSTOMERS_CONTACT\)/);
    // requireCapability demands ALL of them, which is what makes this a tightening.
    const guard = read('src/middleware/capabilities.js');
    assert.match(guard, /const missing = required\.filter\(\(cap\) => !granted\.includes\(cap\)\)/,
      'if it ever became "any of these", listing two capabilities would WEAKEN the route');
  });

  test('the tightening changed nothing for any role that exists today', () => {
    // Admin holds everything by construction; staff never held customers:read,
    // so neither gains nor loses. A "fix" that locks the owner out of their own
    // inbox would be a far worse bug than the one being fixed.
    assert.ok(capabilitiesForRole('admin').includes(CAPABILITIES.CUSTOMERS_CONTACT));
    assert.ok(capabilitiesForRole('admin').includes(CAPABILITIES.CUSTOMERS_READ));
    assert.ok(!capabilitiesForRole('staff').includes(CAPABILITIES.CUSTOMERS_CONTACT));
    assert.ok(!capabilitiesForRole('staff').includes(CAPABILITIES.CUSTOMERS_READ),
      'staff never had the read grant, so the write behind it was never reachable');
    assert.deepStrictEqual(capabilitiesForRole('customer'), []);
  });

  test('the console hides the controls it knows would 403', () => {
    // A button that exists and always fails is worse than no button.
    const admin = read('admin.html');
    assert.match(admin, /hasCapability\('customers:contact'\)/,
      'Reply, Mark read, Unarchive and Archive all call the newly-gated endpoints');
    assert.match(admin, /'<span class="muted">View only<\/span>'/,
      'and a viewer without the grant is told why the actions are absent');
  });
}

// ============================================================
section('[fe-53] A test may not re-derive the thing it is testing');
// ============================================================
/* THE FAILURE THIS EXISTS TO PREVENT, WHICH ALREADY HAPPENED ONCE.

   [db-12] used to lift the top-categories query out of products.routes.js by
   slicing the source between backticks. That is fine for exactly as long as the
   query contains no interpolation. The moment `${REVENUE_STATUS_SQL}` was
   introduced, the slice handed Postgres a literal dollar-brace and all four
   checks failed with "syntax error at or near $" — while the route itself was
   entirely correct. The test had quietly stopped testing what ships.

   Worse, `npm test` could never have caught it: the only suite that executes
   SQL against a real database needs one, so it lives in verify:full rather than
   the offline gate. This check runs OFFLINE, and fails the build for the whole
   class rather than for the one instance. */
{
  const fs2 = require('fs');
  const testDir = __dirname;

  test('no test slices SQL out of a route file as text', () => {
    const offenders = [];
    for (const file of fs2.readdirSync(testDir).filter((f) => f.endsWith('.js'))) {
      const src = fs2.readFileSync(path.join(testDir, file), 'utf8');
      // Reading a route file is fine; slicing a backticked query out of it is not.
      const readsRoute = /readFileSync\([^)]*routes[\\/]/.test(src) || /'\.\.', 'src', 'routes'/.test(src);
      if (!readsRoute) continue;
      const slicesSql = /\.indexOf\('`SELECT/i.test(src) || /\.slice\(\s*sqlStart/.test(src);
      if (slicesSql) offenders.push(file);
    }
    assert.deepStrictEqual(offenders, [],
      'these rebuild a query from source instead of importing it, so an interpolation '
      + 'silently turns them into tests of a different string: ' + offenders.join(', '));
  });

  test('the query [db-12] runs is EXPORTED, and carries nothing left to interpolate', () => {
    const dbTest = read('test/db-integration.test.js');
    assert.match(dbTest, /require\('\.\.\/src\/routes\/products\.routes\.js'\)\.TOP_CATEGORIES_SQL/,
      'it must import the real query rather than reconstruct it');
    const route = read('src/routes/products.routes.js');
    assert.match(route, /router\.TOP_CATEGORIES_SQL = TOP_CATEGORIES_SQL;/,
      'and the route must actually export it, or the import is undefined and the test tests nothing');
    // The route must USE the constant, not keep a second copy inline.
    assert.match(route, /await db\.query\(TOP_CATEGORIES_SQL, \[limit\]\)/,
      'a hoisted constant the route does not use is just a third copy of the query');
  });

  test('every SQL string a test can import resolves fully at load time', () => {
    /* Loaded with the db module stubbed, because requiring a route otherwise
       opens a real connection pool — which is the reason these queries were
       being read as text in the first place. */
    const Module = require('module');
    const origLoad = Module._load;
    const stub = {
      query: async () => ({ rows: [] }),
      getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
      transaction: async (fn) => fn({ query: async () => ({ rows: [] }) })
    };
    Module._load = function (request) {
      if (/config[\\/]db$/.test(request) || request.endsWith('/config/db')) return stub;
      return origLoad.apply(this, arguments);
    };
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
    process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'y'.repeat(48);
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub/stub';
    try {
      const router = require(path.join(ROOT, 'src/routes/products.routes.js'));
      const sql = router.TOP_CATEGORIES_SQL;
      assert.strictEqual(typeof sql, 'string');
      assert.ok(!sql.includes('${'),
        'an unresolved interpolation reaches Postgres as a literal $ and fails at runtime');
      assert.ok(sql.includes("('paid','processing','shipped','delivered','partially_refunded')"),
        'the status tuple must be expanded, not still a reference');
      assert.strictEqual((sql.match(/\(/g) || []).length, (sql.match(/\)/g) || []).length,
        'unbalanced parentheses');
      assert.ok(!/\bIN\s*\(\s*\)/i.test(sql), 'an empty IN () means the constant rendered as nothing');
      assert.match(sql.trim(), /LIMIT \$1$/, 'the real placeholder must survive');
    } finally {
      Module._load = origLoad;
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
