#!/usr/bin/env node
/**
 * PRODUCTION CONFIG AND SECRETS REVIEW
 *
 * Answers "is this configured to run in production, and is anything weak, stale
 * or missing?" — the question no test suite asks, because every suite runs
 * against a .env that is correct on this machine by definition.
 *
 * THREE THINGS IT CHECKS
 *
 *   1. COVERAGE. Every environment variable the code reads WITHOUT a fallback is
 *      mandatory. If it is absent from render.yaml the service boots misconfigured,
 *      and the symptom is a runtime failure on whichever path happens to read it
 *      first — often weeks later, on the one code path nobody exercises.
 *
 *   2. STRENGTH. A short JWT secret or a 12-character job token is not a
 *      configuration preference, it is a way in. Checked by LENGTH and CHARACTER
 *      CLASS only.
 *
 *   3. STALENESS. A test-mode payment key, a localhost URL, or a placeholder left
 *      from the example file will authenticate happily and take no real money.
 *
 * IT NEVER PRINTS A SECRET. Values are reduced to a length and a shape before
 * anything reaches the terminal, so the output is safe to paste into a ticket.
 *
 * Run: npm run check:config
 *      npm run check:config -- --production   (applies the stricter live rules)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STRICT = process.argv.includes('--production');

// ---------------------------------------------------------------------------
// Reading, without ever holding a value longer than it takes to measure it
// ---------------------------------------------------------------------------
function parseEnvFile(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/^["']|["']$/g, '');
    out.set(m[1], v);
  }
  return out;
}

/** A description of a secret that is safe to print. */
function shape(v) {
  if (v === undefined) return 'absent';
  if (v === '') return 'empty';
  const classes = [
    /[a-z]/.test(v) && 'lower', /[A-Z]/.test(v) && 'upper',
    /[0-9]/.test(v) && 'digit', /[^A-Za-z0-9]/.test(v) && 'symbol'
  ].filter(Boolean).length;
  return v.length + ' chars, ' + classes + '/4 character classes';
}

const PLACEHOLDER = /^(changeme|change_me|your[-_ ]?|xxx+|todo|placeholder|secret|password|test|example|<.*>)/i;

// ---------------------------------------------------------------------------
// What the code actually needs
// ---------------------------------------------------------------------------
/** Env vars read WITHOUT a `||` fallback anywhere are mandatory. */
function requiredVars() {
  const withFallback = new Set();
  const all = new Set();
  for (const dir of ['src', 'scripts']) {
    for (const file of walk(path.join(ROOT, dir))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) all.add(m[1]);
      // `process.env.X || 'default'`, `?? x`, or a ternary all mean it is optional.
      for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)\s*(\|\||\?\?|\?|===|!==|==|!=)/g)) {
        withFallback.add(m[1]);
      }
    }
  }
  return { all, mandatory: [...all].filter((k) => !withFallback.has(k)).sort() };
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    // Never scan THIS file. It contains `process.env.X` inside a comment
    // explaining the pattern, and reading itself made the tool report a
    // variable that exists nowhere — a checker's first job is not to lie.
    else if (e.name.endsWith('.js') && p !== __filename) acc.push(p);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
/* Strength is ENTROPY, not character count.

   A 15-character secret drawn from all four character classes is stronger than
   a 32-character lowercase one, and a rule written in characters says the
   opposite. Judging by length alone made this tool fail a 98-bit webhook secret
   for being one character under an arbitrary sixteen — a false alarm, and a
   checker that cries wolf is one that gets switched off.

   `minBits` is the estimate below. `minChars` appears only where the CODE
   itself enforces a length, which is a fact rather than a heuristic.

   JWT_REFRESH_SECRET is deliberately absent: nothing in src/ or scripts/ reads
   it. It was in this list from habit, and the tool duly reported a missing
   secret that no code path wants. */
const SECRET_RULES = [
  { key: 'JWT_SECRET',              minBits: 128, why: 'signs every session; attackable offline once a token leaks' },
  { key: 'RAZORPAY_KEY_SECRET',     minBits: 80,  why: 'authenticates every call to the payment gateway',
    issued: true },
  { key: 'RAZORPAY_WEBHOOK_SECRET', minBits: 80,  why: 'the only thing separating a real webhook from a forged one' },
  { key: 'JOBS_TRIGGER_TOKEN',      minBits: 80,  minChars: 32,
    why: 'anyone holding it can run your scheduled jobs',
    charsWhy: 'the route itself treats anything under 32 characters as UNCONFIGURED and refuses every job' },
  { key: 'SMTP_PASS',               minBits: 60,  why: 'a compromised mail account sends as you', issued: true }
];

/** Rough entropy in bits, assuming the value was randomly generated. */
function bits(v) {
  const alphabet =
    (/[a-z]/.test(v) ? 26 : 0) + (/[A-Z]/.test(v) ? 26 : 0) +
    (/[0-9]/.test(v) ? 10 : 0) + (/[^A-Za-z0-9]/.test(v) ? 32 : 0);
  return alphabet ? Math.round(v.length * Math.log2(alphabet)) : 0;
}

const findings = { fail: [], warn: [], note: [] };
const add = (level, msg, detail) => findings[level].push({ msg, detail });

// ---------------------------------------------------------------------------
const env = parseEnvFile(path.join(ROOT, '.env'));
const example = parseEnvFile(path.join(ROOT, '.env.example'));
const renderSrc = fs.existsSync(path.join(ROOT, 'render.yaml'))
  ? fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8') : '';
const renderKeys = new Set([...renderSrc.matchAll(/^\s*-\s*key:\s*([A-Z_][A-Z0-9_]*)/gm)].map((m) => m[1]));

console.log('\nChakrashri production configuration review');
console.log(STRICT ? '  mode: PRODUCTION (strict)\n' : '  mode: local (pass --production for the live rules)\n');

// ---- 1. .env must never be committed ---------------------------------------
{
  const ignored = fs.existsSync(path.join(ROOT, '.gitignore'))
    && /^\.env\s*$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'));
  if (!ignored) add('fail', '.env is not listed in .gitignore', 'one careless `git add -A` publishes every secret');
  else add('note', '.env is gitignored');
}

// ---- 2. Coverage ------------------------------------------------------------
{
  const { all, mandatory } = requiredVars();
  // Vars only ever read by tests or tooling are not production configuration.
  const TOOLING = new Set(['TEST_DATABASE_URL', 'REQUIRE_BROWSER_TESTS', 'REQUIRE_DB_TESTS',
    'NETLIFY_BUILD_HOOK_URL', 'API_BASE', 'URL', 'KEEPALIVE_URL', 'ANTHROPIC_API_KEY']);
  const missingFromRender = mandatory.filter((k) => !TOOLING.has(k) && !renderKeys.has(k));
  if (missingFromRender.length) {
    add('fail', missingFromRender.length + ' mandatory var(s) absent from render.yaml',
      missingFromRender.join(', ') + ' — read with no fallback, so the service boots misconfigured');
  } else {
    add('note', 'every mandatory variable is declared in render.yaml');
  }

  const undocumented = [...all].filter((k) => !TOOLING.has(k) && !example.has(k)).sort();
  if (undocumented.length) {
    add('warn', undocumented.length + ' var(s) the code reads are not in .env.example',
      undocumented.join(', ') + ' — a fresh deploy has no way to know they exist');
  }
  console.log('  ' + all.size + ' variables read by the code, ' + mandatory.length + ' with no fallback\n');
}

// ---- 3. Secret strength -----------------------------------------------------
console.log('  Secrets (values never printed):');
for (const rule of SECRET_RULES) {
  const v = env.get(rule.key);
  if (v === undefined || v === '') {
    if (!rule.optional) add(STRICT ? 'fail' : 'warn', rule.key + ' is not set locally', rule.why);
    console.log('    ' + rule.key.padEnd(24) + 'absent');
    continue;
  }
  const b = bits(v);
  console.log('    ' + rule.key.padEnd(24) + shape(v) + ', ~' + b + ' bits');
  if (b < rule.minBits) {
    add(rule.issued ? 'warn' : 'fail',
      rule.key + ' carries about ' + b + ' bits of entropy (wants ' + rule.minBits + ')',
      rule.why + (rule.issued ? ' — issued by the provider, so regenerate it there rather than editing it' : ''));
  }
  // A length the CODE enforces is a fact, and is checked separately.
  if (rule.minChars && v.length < rule.minChars) {
    add('fail', rule.key + ' is ' + v.length + ' characters, under the ' + rule.minChars + ' the code demands',
      rule.charsWhy);
  }
  if (PLACEHOLDER.test(v)) {
    add('fail', rule.key + ' still looks like the placeholder from .env.example', rule.why);
  }
  if (example.get(rule.key) && example.get(rule.key) === v) {
    add('fail', rule.key + ' is byte-identical to the value in .env.example',
      'a published example value is not a secret');
  }
}

// ---- 4. Staleness: test-mode keys and local URLs ----------------------------
console.log('');
{
  const rzp = env.get('RAZORPAY_KEY_ID') || '';
  const mode = rzp.startsWith('rzp_live_') ? 'LIVE' : rzp.startsWith('rzp_test_') ? 'TEST' : 'unrecognised';
  console.log('  Razorpay key mode: ' + mode);
  if (STRICT && mode !== 'LIVE') {
    add('fail', 'Razorpay is in ' + mode + ' mode', 'a test key authenticates fine and takes no real money');
  } else if (mode === 'TEST') {
    add('note', 'Razorpay is in test mode, correct for a non-production environment');
  }

  for (const key of ['CLIENT_URL', 'SITE_ORIGIN', 'DATABASE_URL']) {
    const v = env.get(key) || '';
    if (!v) continue;
    if (/localhost|127\.0\.0\.1/.test(v)) {
      add(STRICT ? 'fail' : 'note', key + ' points at localhost', 'correct locally, fatal in production');
    }
    if (key.endsWith('URL') && /\/$/.test(v)) {
      add('warn', key + ' has a trailing slash', 'the CORS allow-list compares origins exactly');
    }
  }

  const db = env.get('DATABASE_URL') || '';
  if (db && !/sslmode=/.test(db)) {
    add('warn', 'DATABASE_URL declares no sslmode', 'the pool normalises it, but being explicit is what survives a driver upgrade');
  }
  if (db && /sslmode=(disable|prefer)/.test(db)) {
    add(STRICT ? 'fail' : 'warn', 'DATABASE_URL allows an unencrypted fallback',
      'sslmode=' + (db.match(/sslmode=(\w+)/) || [])[1] + ' permits plaintext');
  }
}

// ---- 5. Operational config that has bitten this project before -------------
{
  if (!env.get('ADMIN_ALERT_EMAIL') && !env.get('FROM_EMAIL')) {
    add('warn', 'no admin alert address is configured', 'nothing has anywhere to report a failure to');
  }
  const token = env.get('JOBS_TRIGGER_TOKEN') || '';
  if (token && token.length < 32) {
    add('fail', 'JOBS_TRIGGER_TOKEN is under 32 characters',
      'the route treats a short token as UNCONFIGURED and refuses every job — the scheduler silently stops');
  }
}

// ---------------------------------------------------------------------------
function section(title, list, marker) {
  if (!list.length) return;
  console.log('\n  ' + title);
  for (const f of list) {
    console.log('    ' + marker + ' ' + f.msg);
    if (f.detail) console.log('        ' + f.detail);
  }
}
section('MUST FIX', findings.fail, '[FAIL]');
section('WORTH FIXING', findings.warn, '[WARN]');
section('CONFIRMED', findings.note, '[ok]  ');

console.log('\n  ' + findings.fail.length + ' blocking, ' + findings.warn.length
  + ' advisory, ' + findings.note.length + ' confirmed.');
console.log(STRICT
  ? '  Strict mode: run this against the ACTUAL production values before go-live.\n'
  : '  This read your LOCAL .env. Production values live in the Render dashboard'
    + '\n  and must be reviewed there — see README "Go-live readiness".\n');

process.exit(findings.fail.length ? 1 : 0);
