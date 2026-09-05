#!/usr/bin/env node
/**
 * LOCAL STOREFRONT PREVIEW
 *
 * Serves the repository root the way Netlify serves it, so the whole site can be
 * looked at in a real browser before anything is pushed.
 *
 * WHY THIS EXISTS RATHER THAN JUST OPENING index.html
 *
 * Opened as a file:// document the storefront cannot fetch anything — same-origin
 * rules block it — so catalog.json never loads, every grid renders its skeleton,
 * and what you are looking at is the loading state rather than the shop. Served
 * over http the snapshot is same-origin, hydrateCatalogFromCache() finds it, and
 * the page fills with the real catalogue with no API and no network at all.
 *
 * It also reproduces the two routing rules that only exist in production:
 *
 *   - a prerendered product page (product/<slug>/index.html) WINS over the SPA
 *     fallback, exactly as the last line of _redirects arranges;
 *   - every other unknown path falls back to index.html, so /shop and /puja and
 *     a deep link into a category all resolve instead of 404ing.
 *
 * Without those two, a local preview disagrees with the deployed site on
 * precisely the paths that are most worth checking.
 *
 * Read-only. It serves files and nothing else — no writes, no API, no database.
 *
 * Run: npm run preview          then open http://localhost:4173
 *      npm run preview -- 5000  to use a different port
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.argv[2] || process.env.PREVIEW_PORT || '4173', 10);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

/* Anything that escapes the repository root is refused rather than resolved.
   This only ever serves a developer's own machine, but a path traversal in a
   throwaway server is still a path traversal. */
function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const full = path.normalize(path.join(ROOT, clean));
  return full.startsWith(ROOT) ? full : null;
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // The snapshot and the markup both change while iterating; a cached copy
    // would show yesterday's design and waste an afternoon.
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* THE PREVIEW MUST NOT CALL THE LIVE API.

   index.html hard-codes window.__API_BASE__ to the Render service, so every page
   this server handed out went straight to production. Previewing a design change
   at eight widths across eight routes is 64 page loads, and each one fires a
   handful of requests — the live log filled with hundreds of cross-origin
   warnings from localhost, real queries ran against the real database, and any
   genuine error in there was pushed out of a limited retention window.

   The base is rewritten to this server instead, and /api/ answers 503 at once.
   The storefront already falls back to catalog.json when the API is unreachable,
   which is exactly the state a design preview wants: the real catalog, rendered
   from the snapshot, with nothing touching production.

   PREVIEW_API=live opts back in, for the rare case of wanting to check against
   the real service on purpose. */
const USE_LIVE_API = process.env.PREVIEW_API === 'live';

/* TWO SHAPES, BECAUSE THE TWO PAGES DIFFER.

   index.html and every prerendered product page ASSIGN the base:

       window.__API_BASE__ = "https://chakrashri-api.onrender.com";

   admin.html does not. It reads the global and falls back to the production URL
   if nothing set it:

       const API_BASE = window.__API_BASE__ || 'https://chakrashri-api.onrender.com';

   Rewriting only the assignment therefore left the admin console calling the
   live service from a local preview — the exact problem this was added to stop,
   surviving in the one page that talks to the database with staff credentials.

   So: replace the assignment where there is one, and where there is not, define
   the global before any script can read it. The definition goes immediately
   after <head> so it lands ahead of everything, and the replace is global in
   case a page ever grows a second assignment. */
function localiseApiBase(html) {
  if (USE_LIVE_API) return html;
  const local = 'http://localhost:' + PORT;
  /* No .test() before .replace(). A global regex carries lastIndex between
     calls, so testing first and replacing second is the classic way to make a
     match silently start halfway through the file. Doing the replace and
     comparing the result asks the same question with no state at all. */
  /* No backreference. Written through a generator, a backslash-one in a non-raw Python
     string is an OCTAL escape, and this line silently shipped an invisible
     U+0001 where the backreference belonged — the regex then matched nothing,
     every page fell through to the injection branch, and the original
     production assignment survived to overwrite the injected one. Spelling
     both quote styles out cannot be corrupted that way. */
  const ASSIGN = /window\.__API_BASE__\s*=\s*("[^"]*"|'[^']*')/g;
  const replaced = html.replace(ASSIGN, 'window.__API_BASE__ = "' + local + '"');
  if (replaced !== html) return replaced;
  return html.replace(/<head([^>]*)>/i,
    '<head$1><script>window.__API_BASE__ = "' + local + '";</script>');
}

const server = http.createServer((req, res) => {
  /* Answered before anything else, and answered fast: a preview that hangs
     waiting on a request that was never going to succeed is worse than one that
     is told immediately to use the snapshot. */
  if (!USE_LIVE_API && req.url.startsWith('/api/')) {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    return send(res, 503,
      JSON.stringify({ error: 'preview server: the API is deliberately not reachable here' }),
      TYPES['.json']);
  }

  const target = resolveSafe(req.url);
  if (!target) return send(res, 400, 'Bad path');

  let file = target;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }

  // A real file wins — including a prerendered product page, which is the whole
  // point of the ordering in _redirects.
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html') {
      return send(res, 200, localiseApiBase(fs.readFileSync(file, 'utf8')), TYPES['.html']);
    }
    return send(res, 200, fs.readFileSync(file), TYPES[ext] || 'application/octet-stream');
  }

  // Otherwise the SPA answers, so /shop, /puja and a deep link all resolve.
  const spa = path.join(ROOT, 'index.html');
  if (fs.existsSync(spa)) {
    return send(res, 200, localiseApiBase(fs.readFileSync(spa, 'utf8')), TYPES['.html']);
  }
  send(res, 404, 'Not found');
});

server.listen(PORT, () => {
  const snap = path.join(ROOT, 'catalog.json');
  let products = 'catalog.json missing — run `npm run snapshot`';
  try {
    const c = JSON.parse(fs.readFileSync(snap, 'utf8'));
    products = (c.products || []).length + ' products from the committed snapshot';
  } catch (e) { /* reported above */ }

  const prerendered = fs.existsSync(path.join(ROOT, 'product'))
    ? fs.readdirSync(path.join(ROOT, 'product')).length + ' prerendered product pages'
    : 'no prerendered pages — run `npm run prerender` to include them';

  console.log('');
  console.log('  Chakrashri storefront preview');
  console.log('  http://localhost:' + PORT);
  console.log('');
  console.log('    ' + products);
  console.log('    ' + prerendered);
  console.log('');
  console.log('  No API and no database are involved. The page hydrates from the');
  console.log('  snapshot, which is what a real visitor sees for the first 30-60');
  console.log('  seconds while the free-tier API wakes.');
  console.log('');
  console.log('  Ctrl+C to stop.');
  console.log('');
});
