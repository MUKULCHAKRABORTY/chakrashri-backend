#!/usr/bin/env node
/**
 * INVISIBLE CHARACTERS THAT A GENERATOR PUT THERE.
 *
 * A regex backreference written as backslash-one through a NON-RAW Python string
 * is an octal escape: it produces U+0001, not a backslash and a one. That shipped
 * in scripts/preview-server.js and was invisible to everything that looked at it.
 * `sed` printed nothing where it sat, `grep` matched around it, the file parsed
 * cleanly, and the regex simply never matched. The symptom surfaced three layers
 * away, as a page serving two conflicting API bases.
 *
 * Anything written by a script rather than typed can carry one of these, so this
 * looks for the whole class rather than that one instance:
 *
 *   C0 controls      anything below U+0020 that is not tab, newline or CR
 *   DEL              U+007F
 *   C1 controls      U+0080..U+009F, which no source file has a use for
 *   zero-width       U+200B..U+200D and U+FEFF, which hide inside identifiers
 *   bidi overrides   U+202A..U+202E and U+2066..U+2069 — these make source READ
 *                    differently from how it RUNS, which is the whole basis of
 *                    the "Trojan Source" class of attack
 *
 * A byte-order mark at offset 0 is legitimate and is not reported.
 *
 * Run: npm run check:chars
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.claude']);
const EXTS = new Set(['.js', '.json', '.html', '.css', '.md', '.yml', '.yaml', '.sql', '.txt']);

const BAD = [
  { name: 'C0 control', test: (c) => c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d },
  { name: 'DEL', test: (c) => c === 0x7f },
  { name: 'C1 control', test: (c) => c >= 0x80 && c <= 0x9f },
  { name: 'zero-width', test: (c) => c === 0x200b || c === 0x200c || c === 0x200d || c === 0xfeff },
  { name: 'bidi override', test: (c) => (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) }
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTS.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/* Built from code points, never written as a literal character class. Spelled
   out, this file would contain the very characters it exists to find and would
   report itself on every run — and a checker that always fails is a checker
   everybody learns to ignore. */
function safeContext(text, at) {
  return [...text.slice(Math.max(0, at - 30), at + 30)]
    .map((ch) => {
      const c = ch.codePointAt(0);
      if (c === 0x0a || c === 0x0d || c === 0x09) return ' ';
      return BAD.some((b) => b.test(c)) ? '<?>' : ch;
    })
    .join('');
}

let findings = 0;
const files = walk(ROOT, []);
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  let line = 1, col = 1;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === 0x0a) { line++; col = 1; continue; }
    if (code === 0xfeff && i === 0) { col++; continue; }
    const hit = BAD.find((b) => b.test(code));
    if (hit) {
      findings++;
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      console.log('  ' + rel + ':' + line + ':' + col +
        '  U+' + code.toString(16).toUpperCase().padStart(4, '0') + ' ' + hit.name);
      console.log('      ...' + safeContext(text, i) + '...');
    }
    col++;
  }
}

console.log('\n  ' + files.length + ' text file(s) scanned');
console.log('  ' + (findings ? '>> ' + findings + ' invisible character(s) found\n'
                              : 'no stray control, zero-width or bidi characters\n'));
process.exit(findings ? 1 : 0);
