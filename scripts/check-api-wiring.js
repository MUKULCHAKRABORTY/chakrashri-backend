#!/usr/bin/env node
/**
 * DOES EVERY API CALL THE STOREFRONT MAKES REACH A ROUTE THAT EXISTS?
 *
 * WHY THIS EXISTS
 *
 * The two frontends (index.html, admin.html) are single files with no build
 * step and no imports, so nothing has ever connected the string
 * `'/api/admin/low-stock'` typed in a fetch() to the Express route that is
 * supposed to answer it. The two sides are joined by a string literal and
 * nothing else. Rename a route, drop a mount, change `/api/engage` to
 * `/api/engagement`, and the frontend keeps compiling, keeps rendering, keeps
 * passing every existing test — and the feature returns 404 to a customer.
 *
 * That failure is silent in exactly the wrong way: `apiFetch` catches the
 * error and shows a friendly "could not load" message, which is
 * indistinguishable from the free-tier instance still waking up. Nobody
 * investigates a cold start.
 *
 * WHAT IT PROVES
 *
 *   1. Every `/api/...` literal in either frontend resolves to a route that is
 *      actually mounted on the real Express app — the same app src/server.js
 *      exports, with its real routers, mounted at their real prefixes.
 *   2. It resolves for the METHOD the frontend uses. A path that exists as GET
 *      and is called with POST is a 404 to the customer just the same.
 *   3. Nothing is asserted from a hand-written list. The frontend side is read
 *      out of the HTML; the backend side is walked out of Express's own router
 *      stack. A route added, renamed or removed tomorrow is picked up with no
 *      edit to this file.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not send a request, touch a database, or check what a route returns —
 * test/http.test.js does that. This answers the narrower question that nothing
 * else asks: is the wire connected at both ends.
 *
 * Run: npm run check:api
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* The app is required, not spawned, so the router stack can be walked directly.
   Same require.cache technique test/http.test.js uses: config/db.js is replaced
   before server.js is loaded, so no Postgres connection is ever attempted. */
function loadApp() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';                       // ask the OS for an ephemeral port
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'wiring_check_secret_not_used';
  process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy';
  process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret';
  process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'dummy_webhook_secret';

  const dbConfigPath = require.resolve('../src/config/db.js');
  require.cache[dbConfigPath] = {
    id: dbConfigPath,
    filename: dbConfigPath,
    loaded: true,
    exports: {
      query: async () => ({ rows: [], rowCount: 0 }),
      getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
      pool: { end: async () => {}, on() {} }
    }
  };

  const app = require('../src/server.js');
  return app;
}

/* Express keeps its mounted routers in `_router.stack`. Each layer is either a
   route (a path with methods on it) or a sub-router mounted under a prefix,
   whose own prefix survives only as the regexp Express compiled from it. So the
   prefix is recovered from that regexp — this is the one part that depends on
   Express internals, and it is asserted below: if the walk finds no routes at
   all, that is reported as a failure rather than as a clean run. */
function layerPrefix(layer) {
  if (layer.regexp && layer.regexp.fast_slash) return '';
  const src = String(layer.regexp);
  //  /^\/api\/products\/?(?=\/|$)/i   ->   /api/products
  const m = src.match(/^\/\^((?:\\\/|[^\\^$?])*)/);
  if (!m) return null;
  return m[1].replace(/\\\//g, '/').replace(/\/$/, '');
}

function collectRoutes(app) {
  const found = [];
  const stack = (app._router && app._router.stack) || (app.router && app.router.stack) || [];

  function walk(layers, prefix) {
    for (const layer of layers) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
        found.push({ path: prefix + layer.route.path, methods: methods.map((m) => m.toUpperCase()) });
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const own = layerPrefix(layer);
        if (own === null) continue;
        walk(layer.handle.stack, prefix + own);
      }
    }
  }
  walk(stack, '');
  return found;
}

/* An Express path becomes a matcher. A `:param` on EITHER side is a wildcard,
   which is the part that has to be right: the route may be the specific side
   (`/bookings/puja/:id` answering a call to `/bookings/' + type + '/' + id`),
   or the call may be (`/products/' + id` reaching `/products/:id`). Treating
   only the route's params as wildcards reports the first shape as broken.

   Trailing slashes are ignored on both sides, because Express's default
   strict:false treats `/x` and `/x/` as the same route. */
function toMatcher(routePath) {
  const trimmed = routePath.replace(/\/+$/, '') || '/';
  const parts = trimmed.split('/').filter(Boolean);
  return (candidate) => {
    const c = (candidate.replace(/\/+$/, '') || '/').split('/').filter(Boolean);
    if (c.length !== parts.length) return false;
    return parts.every((p, i) => p.startsWith(':') || c[i].startsWith(':') || p === c[i]);
  };
}

/* WHAT COUNTS AS AN API CALL IN THE FRONTEND.

   A CALL SITE, not a string that happens to start with /api. That distinction
   is the whole accuracy of this check. index.html holds API_WAIT_COPY — a table
   of eighteen /api PREFIXES used to pick the "Confirming your payment…" copy
   while a request is in flight. Those are prefixes on purpose (`/api/auth/`,
   `/api/engage/`), they are not paths, and treating them as calls reported nine
   perfectly healthy endpoints as broken on the first run of this script.

   So a literal only counts when it is the FIRST ARGUMENT OF A CALL: the text
   immediately before it is `someFunction(`. An entry in an array literal, a
   value in an object, or a comparison is not a call and is skipped.

   The path expression is then read forward through the whole argument, because
   the frontends build URLs three ways and all three have to be understood:

     apiFetch('/api/products')                       a plain literal
     apiFetch('/api/products/' + id)                 a literal that continues
     api('/api/bookings/' + type + '/' + id)         several continuations
     api(`/api/bookings/${type}/${id}/status`)       a template literal

   Anything that is not a literal — an identifier, a call, a template hole —
   contributes a `:param` placeholder, because its value cannot be known
   statically and the route it reaches has a parameter in that position.

   A path literal does not have to be the whole first argument. Two calls in
   index.html reach for `fetch` directly and build the URL as
   `fetch(API_BASE + '/api/support/chat', …)`, so an optional prefix expression
   is allowed between the paren and the literal. Missing those two hid the AI
   chat endpoint and the version poll from this check entirely — a blind spot
   in a wiring check is worse than no wiring check, because it reads as proof. */
const CALL_START = /(\w+)\s*\(\s*(?:[A-Za-z_$][\w$.]*\s*\+\s*)?(['"`])(\/api\/[^'"`]*)\2/g;

/* Reads the rest of a concatenated path expression, starting just after the
   first string literal, and returns { path, end }. Stops at the argument
   separator or the closing paren. */
function readPathExpression(src, from, prefix) {
  let i = from;
  let out = '';
  for (;;) {
    const rest = src.slice(i);
    const plus = rest.match(/^\s*\+\s*/);
    if (!plus) break;
    i += plus[0].length;
    const lit = src.slice(i).match(/^(['"`])([^'"`]*)\1/);
    if (lit) { out += lit[2]; i += lit[0].length; continue; }
    /* Not a literal: consume one operand — an identifier, a property chain, a
       call, or a parenthesised expression. */
    const operand = src.slice(i).match(/^[A-Za-z_$][\w$.]*(\([^()]*\))?|^\([^()]*\)/);
    if (!operand) break;
    i += operand[0].length;

    /* IT ONLY BECOMES A PATH SEGMENT IF THE LITERAL ENDED IN A SLASH.

       `'/api/products/' + id` is a segment. `'/api/admin/reviews' + qp`, where
       qp is a query string the caller assembled, is not — and appending one
       there invents `/api/admin/reviews:param`, a route that exists nowhere,
       which is exactly how this check reported the reviews screen broken on
       the day it was written.

       The remaining ambiguity is a variable that itself begins with a slash.
       Nothing here does that, and the honest reading of "no slash was written"
       is that no segment was added — under-reading one suffix is much cheaper
       than a false failure on every query-string call in the file, and the base
       path is still verified either way. */
    if (/\/$/.test(prefix + out)) out += ':param';
  }
  return { tail: out, end: i };
}

/* THE METHOD A WRAPPER PINS FOR ITS CALLERS.

   Not every request goes through apiFetch directly. `queuedPost(path, payload)`
   takes no options object at all — it pins `method: 'POST'` itself and hands
   that to apiFetch — so reading only the call site attributes GET to three real
   POST endpoints, which is how the contact form, the newsletter and the restock
   alert were all reported broken when they are fine.

   Rather than keep a list of wrapper names, the wrapper's own source is read:
   a function in this file whose body pins exactly one literal method is taken
   to send that method. A helper added later is understood with no edit here,
   and one that pins nothing keeps the honest GET default. */
function wrapperMethods(src) {
  const byName = new Map();
  const declRe = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let d;
  while ((d = declRe.exec(src))) {
    const name = d[1];
    const body = functionBody(src, d.index);
    if (!body) continue;

    /* A PASS-THROUGH IS NOT A PIN. admin.html's own `api()` reads
       `(opts.method || 'GET')` and forwards whatever its caller asked for, and
       further down its body it retries with a literal method. Reading that
       literal as the method `api()` always sends attributed POST to twenty
       admin screens that only ever read. A function that consults its caller's
       method decides nothing on its own, so it pins nothing. */
    if (/\bopts\s*\.\s*method\b|\boptions\s*\.\s*method\b|\.\.\.\s*opts\b/.test(body)) continue;

    const verbs = new Set();
    const mre = /(?:^|[{,\s])method\s*:\s*['"`]([A-Za-z]+)['"`]/g;
    let v;
    while ((v = mre.exec(body))) verbs.add(v[1].toUpperCase());
    if (verbs.size === 1) byName.set(name, [...verbs][0]);
  }
  return byName;
}

/* The source of one function, from its declaration to its matching closing
   brace. Bounded slices were the first attempt and they read past the end of
   short functions into the next one's fetch. */
function functionBody(src, declIndex) {
  const open = src.indexOf('{', declIndex);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(open, i + 1); }
  }
  return null;
}

function extractCalls(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const wrappers = wrapperMethods(src);
  const calls = new Map();                       // normalised path -> {file, methods:Set, raw:Set}

  let m;
  const re = new RegExp(CALL_START.source, 'g');
  while ((m = re.exec(src))) {
    const fn = m[1];
    /* `if`, `for`, `while`, `return`, `catch` and `switch` all read as a
       function name followed by a paren. None of them is a request. */
    if (/^(if|for|while|switch|catch|return|typeof)$/.test(fn)) continue;

    const raw = m[3];
    const litEnd = m.index + m[0].length;
    const { tail, end } = readPathExpression(src, litEnd, raw);

    let full = (raw + tail).replace(/\$\{[^}]*\}/g, ':param');
    full = full.split('?')[0].split('#')[0];
    full = full.replace(/\/+$/, '') || '/';
    /* `/api/products/' + id` produces `/api/products/:param`; a bare
       `/api/products/'` with nothing after it collapses to `/api/products` by
       the trailing-slash rule above, which is the same route either way. */

    /* Which method? Only what is written in THIS call's options object — the
       balanced `{...}` that follows the argument separator. Reading the nearest
       `method:` anywhere nearby, which the first version of this script did,
       attributes one call's PATCH to the three GETs around it. */
    let method = wrappers.get(fn) || 'GET';
    const afterArg = src.slice(end, end + 600);
    const optsMatch = afterArg.match(/^\s*,\s*\{/);
    if (optsMatch) {
      const objStart = end + optsMatch[0].length - 1;
      let depth = 0, objEnd = objStart;
      for (let i = objStart; i < src.length && i < objStart + 4000; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (!depth) { objEnd = i; break; } }
      }
      const obj = src.slice(objStart, objEnd + 1);
      const mm = obj.match(/(?:^|[{,\s])method\s*:\s*['"`]([A-Za-z]+)['"`]/);
      if (mm) method = mm[1];
      /* `method: someVariable` — the verb is chosen at runtime, so both of the
         verbs a create-or-update helper can send have to be accepted. */
      else if (/(?:^|[{,\s])method\s*:/.test(obj)) method = 'ANY';
    }
    method = method.toUpperCase();

    if (!calls.has(full)) calls.set(full, { file, methods: new Set(), raw: new Set() });
    calls.get(full).methods.add(method);
    calls.get(full).raw.add(fn + '(' + raw + '…)');
  }
  return calls;
}

/* Paths that are real, deliberate, and NOT Express routes on this app. Each one
   needs a reason — an allowlist with no justification is a hole, and the whole
   point of this check is that nobody can quietly add a dead endpoint. */
const NOT_APP_ROUTES = {
  '/api': 'the API base itself, used to build other URLs — never fetched alone',
  '/api/': 'same, written with a trailing slash'
};

function main() {
  const app = loadApp();
  const routes = collectRoutes(app);

  if (routes.length < 20) {
    console.error('[check:api] FAILED: only ' + routes.length + ' routes were found on the app.');
    console.error('            Express changed the shape of its router stack, and a check that');
    console.error('            walks nothing reports every frontend call as broken or as fine');
    console.error('            depending on which way it fails. Fix the walk, do not skip it.');
    process.exit(1);
  }

  const matchers = routes.map((r) => ({ ...r, match: toMatcher(r.path) }));

  const calls = new Map();
  for (const file of ['index.html', 'admin.html']) {
    for (const [p, info] of extractCalls(file)) {
      if (!calls.has(p)) calls.set(p, { files: new Set(), methods: new Set(), raw: new Set() });
      const entry = calls.get(p);
      entry.files.add(file);
      info.methods.forEach((x) => entry.methods.add(x));
      info.raw.forEach((x) => entry.raw.add(x));
    }
  }

  const missing = [];
  const wrongMethod = [];
  let checked = 0;

  for (const [p, info] of [...calls.entries()].sort()) {
    if (NOT_APP_ROUTES[p]) continue;
    checked++;
    const hits = matchers.filter((r) => r.match(p));
    if (!hits.length) {
      missing.push({ path: p, files: [...info.files].join(', ') });
      continue;
    }
    const served = new Set();
    hits.forEach((h) => h.methods.forEach((mm) => served.add(mm)));
    for (const method of info.methods) {
      /* HEAD is answered by GET, and OPTIONS by the CORS layer above the
         router, so neither needs its own declaration. ANY is a verb chosen at
         runtime — the path was already proven to exist, and which of its verbs
         fires is a question for test/http.test.js, not for a wiring check. */
      if (method === 'HEAD' || method === 'OPTIONS' || method === 'ANY') continue;
      if (!served.has(method) && !served.has('ALL')) {
        wrongMethod.push({ path: p, method, served: [...served].sort().join(', '), files: [...info.files].join(', ') });
      }
    }
  }

  /* The other direction: a mounted route nothing calls. Not a failure — the
     public API is allowed to be larger than this storefront uses, and jobs and
     webhooks are called by Render and Razorpay, not by a browser. Reported so
     that dead weight is at least visible.

     STRICTER THAN THE MATCH ABOVE, deliberately. For "does this call reach a
     route?" a `:param` on either side has to be a wildcard, or a real call is
     reported broken. Reused here it says the opposite of what is meant: the
     admin's `PUT /api/booking-services/' + id` becomes `/api/booking-services/
     :param`, which wildcards its way onto `GET /booking-services/practitioners`
     as well — and a practitioner screen that does not exist is then reported as
     called. So here a call's `:param` may only stand where the ROUTE has a
     parameter, and every literal segment must match exactly. That is what makes
     this list usable as an answer to "which endpoints has nobody built a screen
     for?", which is the only reason to print it. */
  const literallyCalled = (route) => {
    const rp = (route.path.replace(/\/+$/, '') || '/').split('/').filter(Boolean);
    return [...calls.keys()].some((p) => {
      const cp = (p.replace(/\/+$/, '') || '/').split('/').filter(Boolean);
      if (cp.length !== rp.length) return false;
      return rp.every((seg, i) => (seg.startsWith(':') ? true : seg === cp[i]));
    });
  };
  /* Three answers, not two, because two of them would each be wrong.

     `api('/api/bookings/' + type + '/' + id)` reads as `/bookings/:param/:param`
     and the routes it can reach are `/bookings/puja/:id` and
     `/bookings/astrology/:id` — a runtime value standing where the route has a
     literal. Judged strictly those two routes look abandoned; judged loosely,
     `/booking-services/:param` wildcards onto `/booking-services/practitioners`
     and a screen nobody has built looks live. Only "no call can reach this even
     wildcarding" is a fact, so that is the list that gets to be a list, and the
     ambiguous ones are named as ambiguous. */
  const uncalled = matchers.filter((r) => ![...calls.keys()].some((p) => r.match(p)));
  const maybe = matchers.filter((r) => !uncalled.includes(r) && !literallyCalled(r));

  console.log('\nAPI wiring — ' + routes.length + ' routes mounted, ' + checked + ' distinct call sites read from the two frontends\n');

  if (missing.length) {
    console.log('  BROKEN — the frontend calls a path no route answers:');
    missing.forEach((x) => console.log('    ' + x.path + '   (' + x.files + ')'));
    console.log('');
  }
  if (wrongMethod.length) {
    console.log('  BROKEN — the path exists but not for the method used:');
    wrongMethod.forEach((x) => console.log('    ' + x.method + ' ' + x.path + '   route serves: ' + x.served + '   (' + x.files + ')'));
    console.log('');
  }

  if (process.argv.includes('--verbose')) {
    if (uncalled.length) {
      console.log('  Mounted and NO call can reach it (webhooks, jobs, or API surface with no screen):');
      uncalled.forEach((r) => console.log('    ' + r.methods.join('/') + ' ' + r.path));
      console.log('');
    }
    if (maybe.length) {
      console.log('  Reached only through a runtime value, so whether it is used cannot be read statically:');
      maybe.forEach((r) => console.log('    ' + r.methods.join('/') + ' ' + r.path));
      console.log('');
    }
  }

  if (missing.length || wrongMethod.length) {
    console.error('  ' + (missing.length + wrongMethod.length) + ' call(s) do not reach a route. The feature behind each one is a 404.');
    process.exit(1);
  }

  console.log('  Every API path either frontend calls is mounted, and for the method it uses.');
  console.log('  ' + uncalled.length + ' mounted route(s) no call can reach, and ' + maybe.length +
    ' reached only through a runtime value (run with --verbose to list both).\n');

  /* The app was required, not spawned, but requiring it still opened a listener
     on an ephemeral port. Nothing else in this process needs it. */
  process.exit(0);
}

main();
