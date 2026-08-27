#!/usr/bin/env node
/**
 * Parses every JavaScript file in the project and fails loudly if any of them
 * is not valid.
 *
 * WHY A SCRIPT AND NOT A SHELL ONE-LINER
 * I checked syntax during this work with a shell loop that piped `node --check`
 * through `head`, which discarded the exit status. It printed "all checked" and
 * reported success while `scripts/release-expired-orders.js` was, at that
 * moment, unparseable — a cron job that would have crashed on its first run in
 * production. The verification was broken in a way that looked like it was
 * working, which is the worst kind.
 *
 * Two real bugs found by this check, both invisible in a diff:
 *   - `*&#47;10` (a cron expression) inside a block comment closes the comment
 *     early, so everything after it is parsed as code.
 *   - a backtick inside a SQL comment within a template literal ends the string.
 *
 * It also parses the inline scripts of index.html and admin.html, where a
 * closing script tag inside a string or comment silently truncates 140KB of
 * application code.
 *
 * Run: npm run check:syntax   (also part of `npm test`)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'coverage', 'dist', 'build']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function checkFile(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return (err.stderr ? err.stderr.toString() : err.message).split('\n').slice(0, 4).join('\n');
  }
}

function checkInlineHtml(file) {
  if (!fs.existsSync(file)) return null;
  const html = fs.readFileSync(file, 'utf8');
  const blocks = html.match(
    /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g
  ) || [];
  if (!blocks.length) return `${path.basename(file)}: no inline script blocks found at all`;

  const bodies = blocks.map((b) => b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
  const joined = bodies.join('\n;\n');
  const tmp = path.join(os.tmpdir(), `syntax-${path.basename(file)}-${process.pid}.js`);
  fs.writeFileSync(tmp, joined, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (err) {
    return (err.stderr ? err.stderr.toString() : err.message).split('\n').slice(0, 4).join('\n');
  } finally {
    fs.unlinkSync(tmp);
  }

  // A truncated block parses fine — it is just short. Guard on size too.
  const largest = Math.max(...bodies.map((b) => b.length));
  const minimum = path.basename(file) === 'index.html' ? 150000 : 60000;
  if (largest < minimum) {
    return `${path.basename(file)}: largest inline script is only ${largest} chars (expected >= ${minimum}). `
      + 'A closing script tag has probably crept into a string or comment and truncated it.';
  }
  return null;
}

const failures = [];

for (const file of walk(ROOT)) {
  const problem = checkFile(file);
  if (problem) failures.push(`${path.relative(ROOT, file)}\n${problem}`);
}

for (const html of ['index.html', 'admin.html']) {
  const problem = checkInlineHtml(path.join(ROOT, html));
  if (problem) failures.push(problem);
}

if (failures.length) {
  console.error(`\nSYNTAX CHECK FAILED — ${failures.length} file(s):\n`);
  failures.forEach((f) => console.error('  ' + f.replace(/\n/g, '\n  ') + '\n'));
  process.exit(1);
}

console.log('Syntax check passed: every .js file and both HTML inline scripts parse.');
