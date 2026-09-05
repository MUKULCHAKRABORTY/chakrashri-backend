#!/usr/bin/env node
/**
 * THE SAME PROPERTY, SET TWICE, AND ONLY SOURCE ORDER DECIDING.
 *
 * This is where nearly every visual defect on this site has come from. The
 * product card carried three overlapping phone blocks — 560px, 380px and 480px,
 * written in that order — each re-declaring the card's type sizes. Because the
 * 480px block came LAST it beat both of the others at every width it matched,
 * which made the 380px block dead code and silently capped the product name at
 * .84rem on every phone. Raising the name in the card's own rule appeared to do
 * nothing, and the rule was correct; it was simply outranked.
 *
 * Nothing catches that. The CSS is valid, the tests pass, and the browser shows
 * a size nobody chose.
 *
 * WHAT THIS REPORTS. For a watched set of selectors — the product card and the
 * grids, which is where this keeps happening — every property declared by more
 * than one rule, with the media condition each declaration sits under, and which
 * one wins at a given width. A conflict is NOT automatically a bug: a base rule
 * plus one deliberate override is normal and healthy. What is a bug is
 *
 *   - two overrides for the same property in OVERLAPPING media ranges, where
 *     which one applies depends on the order they happen to be written in, and
 *   - a rule that can never win at any width, which is dead code pretending to
 *     be configuration.
 *
 * Those two are reported as failures; a plain base-plus-override is listed for
 * information and does not fail the build.
 *
 * Run: npm run css:conflicts
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* Takes paths so the detector itself can be tested: the only way to know this
   reports anything is to hand it a file with the original defect and watch it
   fail. See the self-check at the bottom. */
const FILES = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!FILES.length) FILES.push('index.html', 'admin.html');

/* The selectors worth watching. Widening this to every selector on the site
   produces hundreds of harmless base-plus-override pairs and nobody reads the
   output; these are the ones that have actually gone wrong. */
const WATCH = [
  '.p-card', '.p-body', '.p-name', '.p-cat', '.p-rating', '.p-material',
  '.p-score .cnt', '.p-rating .cnt', '.p-media',
  /* The card's bottom half, as it is drawn now. The names it used to carry —
     .p-price .now, .p-quickadd, .qa-add, .p-meta — were still listed here long
     after the markup stopped emitting them, which is the quiet way a guard
     stops guarding: it never fails, because it never matches anything. */
  '.p-pricerow', '.pr-now', '.pr-mrp', '.p-discount', '.p-cta',
  '.qa-cart', '.qa-cart-txt', '.qa-cart-ic',
  '.qa-step', '.qa-step-btn', '.qa-step-mid', '.qa-step-txt', '.qa-step-n',
  '.badge', '.p-wish', '.p-qview',
  '.product-grid', '#featuredGrid', '.footer-col', '.fc-body', '.fc-toggle',
  /* Added after the touch-target pass. A block written to override every
     component must come after every component, and three of these rules were
     written earlier in the file than the components they targeted, so at equal
     specificity the component won and the override silently did nothing. Same
     trap as the card's three phone blocks, in a different neighbourhood. */
  '.mobile-toggle', '.header-actions .ha-btn', '.logo', '.tab-btn',
  '.mobile-filter-btn', '.view-toggle button', '.pagination button',
  '.testi-nav button', '.footer-social a', '.footer-social button',
  '.breadcrumb a', '.breadcrumb-bar', '.qa-notify', '.footer-col ul'
];

/* Properties whose value is a size or a layout decision. A duplicated `color`
   is usually a theme; a duplicated `font-size` is usually a mistake. */
const WATCHED_PROPS = new Set([
  'font-size', 'line-height', 'letter-spacing', 'padding', 'margin',
  'margin-bottom', 'display', 'grid-template-columns', 'gap', 'width', 'height',
  'min-height', 'max-width', 'bottom', 'top', 'aspect-ratio'
]);

/** Every <style> block's contents, concatenated in document order. */
function styles(src) {
  const out = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out.join('\n');
}

/* IS THE STYLESHEET THE SHAPE ITS AUTHOR THINKS IT IS?
 *
 * THE DEFECT THIS EXISTS FOR, WHICH HAPPENED. An edit removed the CONTENTS of
 * an `@media (max-width:560px)` block and left the opening line behind. CSS has
 * no way to complain: the browser kept consuming rules into that block until
 * the next stray `}`, so three hundred lines of card styles — the whole rating
 * row, the price row, the new button — silently became phone-only. On a desktop
 * the page rendered with those rules absent and NOTHING reported it:
 *
 *   - check:syntax parses JavaScript, not CSS;
 *   - the conflict scan below reads declarations, and a declaration inside the
 *     wrong media query is still a well-formed declaration;
 *   - the contrast and responsive suites measure the page as rendered, and the
 *     page as rendered was a different, entirely valid-looking design.
 *
 * It was found by measuring one element and asking why its width was 209px.
 * That is not a way to find things.
 *
 * TWO CHECKS, AND THE SECOND ONE IS THE INTERESTING ONE.
 *
 *   1. BRACES BALANCE. Necessary, and on its own not sufficient: the stray `}`
 *      that ended the runaway block also balanced the file, which is precisely
 *      why the defect survived.
 *
 *   2. INDENTATION AGREES WITH NESTING. Every rule inside a conditional block
 *      in this stylesheet is indented; every top-level rule starts at column
 *      zero. That is not a style rule anybody wrote down, it is just how the
 *      file has always been written — and it makes the defect self-announcing,
 *      because the swallowed rules kept the indentation they had when they were
 *      top-level. A rule at column zero that the braces say is inside a media
 *      query is a block that was never closed. Nothing else produces it.
 *
 * Deliberate nesting is untouched: a reduced-motion override written inside a
 * width block is indented, so it reads as what it is.
 *
 * Comments and strings are skipped, because a brace inside either is not a
 * brace — `content:'}'` is real CSS and this must not read it as one.
 */
function structure(css, file) {
  const problems = [];
  const stack = [];                 // { head, line } for each open block
  let i = 0, line = 1, col = 0;

  const at = () => 'line ' + line;

  while (i < css.length) {
    const ch = css[i];

    if (css.startsWith('/*', i)) {
      const e = css.indexOf('*/', i);
      const seg = css.slice(i, e < 0 ? css.length : e + 2);
      const nl = (seg.match(/\n/g) || []).length;
      line += nl;
      col = nl ? seg.length - seg.lastIndexOf('\n') - 1 : col + seg.length;
      i = e < 0 ? css.length : e + 2;
      continue;
    }
    if (ch === '\n') { line++; col = 0; i++; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) { if (css[j] === '\\') j++; j++; }
      col += (j + 1) - i;
      i = j + 1;
      continue;
    }

    if (ch === '{') {
      /* The head is the text since the last block boundary; its indentation is
         the column of its first non-space character. */
      const from = Math.max(css.lastIndexOf('}', i), css.lastIndexOf('{', i - 1)) + 1;
      const raw = css.slice(from, i);
      const lastNl = raw.lastIndexOf('\n');
      const headLine = lastNl < 0 ? raw : raw.slice(lastNl + 1);
      const indent = headLine.length - headLine.replace(/^[ \t]*/, '').length;
      const head = raw.replace(/\s+/g, ' ').trim().slice(0, 70);

      const inConditional = stack.some((o) => /^@(media|supports|container)\b/.test(o.head));
      const isKeyframeStep = stack.some((o) => /^@(-\w+-)?keyframes\b/.test(o.head));
      if (inConditional && !isKeyframeStep && indent === 0 && head) {
        problems.push(at() + ': "' + head + '" starts at column zero, but the braces put it '
          + 'inside ' + stack[stack.length - 1].head + ' (opened on line '
          + stack[stack.length - 1].line + '). A block above it was never closed.');
      }
      stack.push({ head: head, line: line });
      col++; i++;
      continue;
    }
    if (ch === '}') {
      if (!stack.length) {
        problems.push(at() + ': a closing brace with nothing open');
      } else {
        stack.pop();
      }
      col++; i++;
      continue;
    }
    col++; i++;
  }

  if (stack.length) {
    const last = stack[stack.length - 1];
    problems.push('the stylesheet ends with ' + stack.length + ' block(s) still open; '
      + 'the last was "' + last.head + '" opened on line ' + last.line);
  }

  if (problems.length) {
    console.log('\n' + file + ' — STRUCTURE');
    problems.slice(0, 12).forEach((p) => console.log('  BROKEN    ' + p));
    if (problems.length > 12) console.log('  BROKEN    ...and ' + (problems.length - 12) + ' more');
    console.log('\n  A block that does not close does not fail. It silently moves every rule');
    console.log('  after it into itself, and the page renders as a different design.\n');
    return false;
  }
  return true;
}

/**
 * Walks the CSS and yields { selector, prop, value, media, index }.
 * Deliberately a scanner rather than a parser: it tracks @media nesting depth
 * and ignores everything else, which is enough for flat authored CSS and cannot
 * be wrong in a way that invents conflicts.
 */
function declarations(css) {
  const out = [];
  const stack = [];
  let i = 0, order = 0;
  while (i < css.length) {
    // Skip comments outright, so a selector mentioned in prose is never read.
    if (css.startsWith('/*', i)) { const e = css.indexOf('*/', i); i = e < 0 ? css.length : e + 2; continue; }
    const brace = css.indexOf('{', i);
    if (brace < 0) break;
    const head = css.slice(i, brace).replace(/\s+/g, ' ').trim();
    if (head.startsWith('@media') || head.startsWith('@supports')) {
      stack.push(head.replace(/^@\w+\s*/, ''));
      i = brace + 1;
      continue;
    }
    if (head.startsWith('@')) {                       // keyframes, property, font-face
      let depth = 1, j = brace + 1;
      while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
      i = j;
      continue;
    }
    const close = css.indexOf('}', brace);
    if (close < 0) break;
    const body = css.slice(brace + 1, close);
    const media = stack.join(' and ') || '(all widths)';
    for (const sel of head.split(',').map((s) => s.trim()).filter(Boolean)) {
      for (const decl of body.split(';')) {
        const c = decl.indexOf(':');
        if (c < 0) continue;
        const prop = decl.slice(0, c).trim();
        const value = decl.slice(c + 1).trim();
        if (!prop || prop.startsWith('/*')) continue;
        out.push({ sel, prop, value, media, order: order++ });
      }
    }
    i = close + 1;
    // Close any @media whose brace we have now passed.
    while (stack.length) {
      const next = css.indexOf('{', i), end = css.indexOf('}', i);
      if (end >= 0 && (next < 0 || end < next)) { stack.pop(); i = end + 1; } else break;
    }
  }
  return out;
}

/** Parses "(max-width:560px)" / "(min-width:768px) and (max-width:900px)". */
function range(media) {
  if (media === '(all widths)') return { min: 0, max: Infinity };
  const min = media.match(/min-width:\s*(\d+)px/);
  const max = media.match(/max-width:\s*(\d+)px/);
  if (!min && !max) return null;                        // print, reduced-motion, hover…
  return { min: min ? Number(min[1]) : 0, max: max ? Number(max[1]) : Infinity };
}

const overlaps = (a, b) => a.min <= b.max && b.min <= a.max;

let problems = 0, noted = 0, broken = 0;
for (const file of FILES) {
  const css = styles(fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8'));
  /* BEFORE anything else. A stylesheet whose blocks do not close is not a
     stylesheet with a conflict in it — it is a different stylesheet, and every
     conclusion drawn from scanning it would be about rules that are not where
     they appear to be. */
  if (!structure(css, file)) { broken++; continue; }
  const decls = declarations(css).filter((d) => WATCH.includes(d.sel) && WATCHED_PROPS.has(d.prop));
  const byKey = new Map();
  for (const d of decls) {
    const k = d.sel + ' :: ' + d.prop;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(d);
  }
  const lines = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const ranged = list.map((d) => ({ ...d, r: range(d.media) })).filter((d) => d.r);
    /* A DESCENDING max-width CASCADE IS CORRECT, AND MUST NOT BE FLAGGED.

       560px then 380px then 300px is the ordinary way to write this: each
       narrower rule is written later, so it wins where it applies and leaves the
       wider ones alone below it. Reporting that as a conflict buries the real
       one in noise.

       The defect is the reverse — a WIDER max-width written AFTER a narrower
       one. That is what happened here: 560px, then 380px, then 480px. The 480px
       rule matched everything the 380px rule matched and was written after it,
       so the 380px block became dead code and every phone silently took the
       480px sizes. Valid CSS, passing tests, and a size nobody chose. */
    const clashes = [];
    const capped = ranged.filter((d) => d.media !== '(all widths)' && d.r.min === 0);
    for (let a = 0; a < capped.length; a++) {
      for (let b = a + 1; b < capped.length; b++) {
        const first = capped[a], later = capped[b];        // b is written later
        if (later.r.max >= first.r.max) clashes.push([first, later]);
      }
    }
    // Bands with a min-width must not overlap each other at all: two rules
    // claiming the same width is exactly the ambiguity bounded bands exist to
    // remove.
    const banded = ranged.filter((d) => d.r.min > 0);
    for (let a = 0; a < banded.length; a++) {
      for (let b = a + 1; b < banded.length; b++) {
        if (overlaps(banded[a].r, banded[b].r)) clashes.push([banded[a], banded[b]]);
      }
    }
    // A rule that can never win: a later declaration covers all of its range.
    const dead = ranged.filter((d) => d.media !== '(all widths)' && ranged.some((o) =>
      o.order > d.order && o.r.min <= d.r.min && o.r.max >= d.r.max));

    if (clashes.length || dead.length) {
      problems++;
      lines.push('  CONFLICT  ' + key);
      for (const d of ranged) lines.push('              ' + d.media.padEnd(46) + d.value);
      for (const [A, B] of clashes) {
        lines.push('            ' + B.media + ' is written AFTER ' + A.media +
                   ' and covers it, so "' + B.value + '" wins on source order alone');
      }
      for (const d of dead) lines.push('            DEAD: ' + d.media + ' can never win; a later rule covers all of it');
    } else {
      noted++;
      lines.push('  ok        ' + key + '   (' + list.length + ' declarations, one base + overrides)');
    }
  }
  console.log('\n' + file + '\n' + (lines.length ? lines.join('\n') : '  nothing watched is declared twice'));
}

console.log('\n  ' + noted + ' base-plus-override pair(s), which are fine');
console.log('  ' + problems + ' conflict(s) where source order decides, or dead rules');
console.log('  ' + broken + ' stylesheet(s) whose blocks do not close\n');
process.exit(problems || broken ? 1 : 0);
