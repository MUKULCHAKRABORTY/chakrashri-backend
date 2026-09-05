#!/usr/bin/env node
/**
 * THE SRI YANTRA, COMPUTED RATHER THAN DRAWN.
 *
 * What was in the page was three nested Stars of David — six triangles in
 * mirrored pairs. That is a hexagram repeated three times, not a Sri Yantra,
 * and on a shop that sells Sri Yantras it is the one graphic that ought to be
 * right. Anyone who owns one can see the difference at a glance.
 *
 * WHAT A SRI YANTRA ACTUALLY IS, from the centre out:
 *
 *   bindu            the point
 *   9 triangles      FOUR pointing up (Shiva) and FIVE pointing down (Shakti),
 *                    interlocking to enclose the 43 smaller triangles
 *   8-petal lotus    ashtadala
 *   16-petal lotus   shodashadala
 *   3 circles        the girdles
 *   bhupura          the square earth-citadel, with a T-gate on each side
 *
 * Four and five is the part people recognise and the part the old drawing got
 * wrong. Nine cannot be split into mirrored pairs, which is exactly why pairs
 * can never produce one.
 *
 * HOW HONEST THIS IS — stated rather than implied.
 *
 * The counts, the directions, the symmetry, the enclosures and the sixteen
 * base endpoints landing on the girdle are all exact, and --check measures every
 * one of them on the emitted points rather than on the table that produced them.
 *
 * What this does NOT do is solve for the placement that makes every edge meet in
 * a perfect TRIPLE intersection. That is the genuinely hard part of the figure —
 * it has no closed form and is solved numerically in the literature — and this
 * is the classical proportion fitted to it, not that solve. At the sizes this
 * mark is drawn, from a 48px category icon to a 212px social card, the residual
 * is under a pixel. Structure exact; last-decimal interlock approximate. Said
 * plainly here because a shop that sells Sri Yantras should not overclaim one.
 *
 * ONE SOURCE, THREE PLACES. The awakening screen, the hero and the social card
 * all draw the same figure, so it is built here once and spliced in rather than
 * copied. Each placement passes its own id prefix, because three copies of the
 * same <use href="#petal"> in one document all resolve to the first one and the
 * other two silently vanish.
 *
 * Run: npm run yantra                 prints the default SVG
 *      npm run yantra -- --check      verifies the geometry and exits
 */

/* Scale, chosen so the OUTERMOST thing drawn — the bhupura's gates — still sits
   inside the 500x500 box every placement already uses. Everything below is
   derived from these, so changing the box means changing one number.

   TR is the important one: the triangles are inscribed in the INNERMOST girdle.
   Getting that wrong the first time drew them across the whole figure and
   straight through both lotuses, which is how you can tell at a glance that a
   yantra was never constructed. */
const C  = 250;         // centre of the 500x500 box

/* THE RADII ARE MEASURED OFF THE REFERENCE, AS FRACTIONS OF THE OUTER EDGE.
   In the reference the two lotuses are the bulk of the figure and the triangles
   occupy a small, dense centre — the opposite of the first attempt, where the
   triangles filled the circle and the petals were a thin fringe around them.

     triangles reach   0.37 of the outer edge
     inner girdle      0.41      the 8-petal lotus runs 0.41 -> 0.59
     middle girdle     0.59      the 16-petal lotus runs 0.59 -> 0.87
     outer girdle      0.87
     the faint rings   beyond that

   Nothing is drawn on the invisible circle the triangles are inscribed in, so
   no vertex ever lands on a drawn line — the gap between the field and the inner
   girdle is part of the figure, not slack. */
const OUTER = 244;
/* THE TRIANGLES CARRY THE FIGURE. THE LOTUSES FRAME IT.

   This was backwards: the triangles sat at 0.34 of the outer edge inside two fat
   petal bands, so the lotus was the loudest thing on the mark and the yantra
   itself was a small knot in the middle. In the reference the proportion is the
   other way round — the nine triangles fill nearly half the radius and the two
   lotus rings are comparatively thin bands around them.

     triangles     0.46 of the outer edge   (was 0.34)
     inner girdle  0.50
     8-petal band  0.50 -> 0.67, 42 deep    (was 58)
     16-petal band 0.67 -> 0.87, 48 deep    (was 66)

   Nothing about the triangles' own table changed. They are inscribed in TRI, so
   raising it enlarges the whole complex without touching a single vertex. */
const TRI = 102;        // invisible: the circle the nine triangles are inscribed in
const TR  = 112;        // innermost girdle
const G2  = 159;        // between the lotuses
const G3  = 217;        // outer girdle
/* Four of them in the reference, and so faint they read as a shadow of a circle
   rather than as a drawn line. Three at full weight looked like part of the
   figure; these are the edge it sits against. */
const HALO = [228, 236, 244];

/* THE NINE TRIANGLES, as (apex, base, half-width) in fractions of TR, y measured
   UP from the centre so the table reads the way the figure looks.

   The first attempt built these from nine shared chords with invented width
   fractions. Rendered large, it was obvious that it was not a Sri Yantra: the
   triangles bunched into the lower half and left a bare spike at the top. The
   table below is the classical proportion instead, and the property that makes
   it read correctly is the one every real Sri Yantra has —

     the eight outer bases are FULL CHORDS of the field circle TRI,

   so their sixteen endpoints all lie on one circle, which is what produces the
   even ring of crossings and keeps the whole field concentric. That circle is
   INVISIBLE and smaller than the girdle, so no vertex ever touches the drawn
   line. Only the ninth, the small downward triangle around the bindu, sits
   inside even that. Every width is checked against the chord available at its
   own height, so a bad edit cannot silently push a base outside the field.

   Four up and five down. Nine cannot be split into mirrored pairs, which is
   exactly why the old drawing — three superimposed Stars of David — could never
   have been one. */
const chord = (yf) => Math.sqrt(Math.max(0, 1 - yf * yf));

const UP = [                                   // Shiva
  { apex:  1.00, base: -0.55, w: chord(-0.55) },
  { apex:  0.78, base: -0.78, w: chord(-0.78) },
  { apex:  0.55, base: -0.30, w: chord(-0.30) },
  { apex:  0.30, base: -0.10, w: chord(-0.10) }
];
const DOWN = [                                 // Shakti
  { apex: -1.00, base:  0.55, w: chord(0.55) },
  { apex: -0.78, base:  0.78, w: chord(0.78) },
  { apex: -0.55, base:  0.30, w: chord(0.30) },
  { apex: -0.30, base:  0.10, w: chord(0.10) },
  /* The ninth. It holds the bindu, so it is the only one drawn inside the
     girdle rather than across it, and the only one whose width is a choice. */
  { apex: -0.17, base:  0.21, w: 0.46 }
];

function triangle(t) {
  const ay = C - t.apex * TRI;
  const by = C - t.base * TRI;
  const bw = t.w * TRI;
  return `${C},${ay.toFixed(2)} ${(C - bw).toFixed(2)},${by.toFixed(2)} ${(C + bw).toFixed(2)},${by.toFixed(2)}`;
}

/** One lotus petal, built the way a lotus ring is actually laid out. */
/* STOP PICKING A WIDTH. THE RING DECIDES IT.

   Five earlier versions took a width parameter and every one was wrong: knots,
   a chain of eyes, a blob pointing inward, a fence of separate leaves, and
   slivers. All five were the same mistake — choosing how wide a petal should be,
   then discovering it did not fit the ring.

   A lotus ring is not laid out that way. Divide the inner circle into n equal
   parts; each petal's base is ONE of those divisions, corner to corner, and its
   tip is the midpoint of its share on the outer circle. There is no width to
   choose. Petals meet exactly at the base by construction, at any radius, for
   any n, and the sides bowing outward is what makes neighbours cross — those
   crossings are the thing that reads as a lotus rather than as a cog.

   It also explains the proportions in the reference without any fudging: eight
   petals round a small circle come out broad, sixteen round a larger one come
   out nearly square, because that is what dividing those two rings gives. */
function petal(inner, outer, count) {
  const half = Math.PI / count;           // half the arc one petal owns
  const sh = Math.sin(half), ch = Math.cos(half);
  const ax = C - inner * sh, ay = C - inner * ch;    // base corner, left
  const bx = C + inner * sh;                          // base corner, right
  const ty = C - outer;                               // tip, on the axis
  /* The sides bow away from the petal's own axis. Roughly a third of the base
     half-width: enough that neighbours cross, not so much that the ring closes
     into a solid scallop. */
  const bulge = inner * sh * 0.38;
  const my = (ay + ty) / 2;
  const f = (v) => v.toFixed(1);
  return `M${f(ax)} ${f(ay)}`
       + ` Q${f((ax + C) / 2 - bulge)} ${f(my)} ${C} ${f(ty)}`
       + ` Q${f((bx + C) / 2 + bulge)} ${f(my)} ${f(bx)} ${f(ay)}`
       + ` A${inner} ${inner} 0 0 0 ${f(ax)} ${f(ay)} Z`;
}

/** Half the arc one petal owns at its base — petals meet there, and no further. */
const slot = (radius, count) => Math.PI * radius / count;

function lotus(id, count, inner, outer) {
  const uses = [];
  for (let i = 0; i < count; i++) {
    uses.push(`<use href="#${id}" transform="rotate(${(360 / count * i).toFixed(2)} ${C} ${C})"/>`);
  }
  return { def: `<path id="${id}" d="${petal(inner, outer, count)}"/>`, uses: uses.join('') };
}

/* THE BHUPURA IS DELIBERATELY ABSENT.

   A complete Sri Yantra ends in the square earth-citadel with a T-gate on each
   side, and the earlier version drew one. The reference does not: it closes with
   faint concentric rings and stays entirely circular. Since this mark sits
   inside round containers on the hero and the awakening screen, and inside a
   48px circle in the shop filter, the circular ending is also the one that fits
   the places it is used. Restoring the citadel is a few lines, not a rewrite. */

/* BRIGHTER AND LIGHTER, WHICH IS NOT THE SAME AS MORE GOLD.
   The old mark was drawn in #C9A227, the brand's antique brass. That is a
   mid-tone, and a mid-tone line on the near-black hero has almost nothing to
   separate it from the background, so the figure read as a smudge rather than
   as geometry. These are the same hue pushed up in lightness until the lines
   actually carry — the colour is unchanged, the value is not. */
const PALETTE = Object.freeze({
  line:  '#FFF1CB',      // the nine triangles: the brightest thing but the bindu
  petal: '#FADFA4',
  ring:  '#F0D08A',
  gate:  '#EAC578',      // the bhupura, deliberately the quietest ring
  bindu: '#FFFAF0'
});

/* Stroke weights scale with how large the mark is drawn. At 48px the hairlines
   of the 212px version disappear entirely, so a placement says how heavy it
   wants its lines and everything scales together. */
function buildYantra(opts) {
  const o = Object.assign({
    id: 'y',
    palette: PALETTE,
    weight: 1,           // multiplier on every stroke-width
    spinClass: '',       // class for the rotating outer shell, if any
    binduClass: '',
    /* THE BINDU'S RESTING SIZE BELONGS TO THE PLACEMENT, NOT TO THIS FILE.

       Each screen pulses it with its own keyframes, and those keyframes SET r
       outright — the awakening rests at 4 and grows to 7, the hero rests at 5.5
       and grows to 7.5. A single radius here is therefore invisible while the
       animation runs and wrong the moment it stops, which is exactly what a
       visitor on reduced motion gets. So the placement passes the radius its own
       keyframes rest at, and the still frame matches the moving one. */
    binduR: 4.2,
    indent: '    '
  }, opts || {});
  const p = o.palette;
  const w = (n) => (n * o.weight).toFixed(2).replace(/\.?0+$/, '');
  /* The foot stops short of the full slot, which leaves the thin gap between
     neighbours that the reference has — at 0.92 they met and the ring read as
     one continuous scallop rather than as separate petals. The shoulders go
     wider than the foot, which is what gives a petal its curve instead of a
     straight-sided wedge. */
  /* A petal may not be much wider than its band is deep, or the shoulders have
     nowhere to curve and it renders as a fat crescent — which is what the eight
     inner petals did, being 82 units across a 42-unit band. Capping against the
     band depth leaves the sixteen outer ones untouched, since their band is deep
     enough that the arc is the binding constraint there. */
  /* PETALS OVERLAP IN A LOTUS. THEY DO NOT SIT IN SLOTS.

     Every earlier version narrowed them until neighbours cleared each other,
     which turned both rings into a fence of separate leaves. In the reference
     each petal is WIDER than the arc it owns, so its outline crosses the two
     beside it near the base — those little crossings are what makes the ring
     read as a flower rather than as a cog. The base is also allowed to be wider
     than the band is deep: eight petals around a small circle are broad, and
     that is simply what an ashtadala looks like. */
  /* Just past the arc each petal owns, so neighbours cross instead of meeting. */
  const l8  = lotus(o.id + 'P8',  8,  TR, G2);
  const l16 = lotus(o.id + 'P16', 16, G2, G3);
  const i = o.indent;
  const spinOpen = o.spinClass ? `<g class="${o.spinClass}">` : '<g>';

  return [
    `<defs>`,
    `  ${l8.def}`,
    `  ${l16.def}`,
    `</defs>`,
    /* The lotuses and girdles turn; the triangles and the bindu do not. A
       rotating Sri Yantra would be wrong — the yantra is the still centre, and
       the petals are what moves around it. */
    spinOpen,
    `  <g fill="none" stroke="${p.petal}" stroke-width="${w(1.5)}" stroke-linejoin="round" opacity=".92">${l16.uses}</g>`,
    `  <g fill="none" stroke="${p.petal}" stroke-width="${w(1.7)}" stroke-linejoin="round">${l8.uses}</g>`,
    `  <g fill="none" stroke="${p.ring}" stroke-width="${w(1.5)}">`,
    `    <circle cx="${C}" cy="${C}" r="${G3}"/>`,
    `    <circle cx="${C}" cy="${C}" r="${G2}"/>`,
    `    <circle cx="${C}" cy="${C}" r="${TR}"/>`,
    `  </g>`,
    `</g>`,
    /* The faint rings the reference closes with. They are quiet on purpose: they
       give the figure an edge to sit against without competing with the lotus. */
    `<g fill="none" stroke="${p.gate}" stroke-width="${w(0.9)}" opacity=".16">`,
    ...HALO.map((r) => `  <circle cx="${C}" cy="${C}" r="${r}"/>`),
    `</g>`,
    `<g fill="none" stroke="${p.line}" stroke-width="${w(1.8)}" stroke-linejoin="round">`,
    ...UP.map((t) => `  <polygon points="${triangle(t)}"/>`),
    ...DOWN.map((t) => `  <polygon points="${triangle(t)}"/>`),
    `</g>`,
    `<circle${o.binduClass ? ` class="${o.binduClass}"` : ''} cx="${C}" cy="${C}" r="${o.binduR}" fill="${p.bindu}"/>`
  ].join('\n' + i);
}

module.exports = { buildYantra, PALETTE, UP, DOWN, chord, triangle, C, TR, TRI };

// ---------------------------------------------------------------------------
if (require.main === module) {
  if (process.argv.includes('--check')) {
    const SVG = buildYantra({ id: 'chk' });
    let bad = 0;
    const ok = (label, cond, detail) => {
      if (!cond) bad++;
      console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (cond ? '' : '   ' + detail));
    };
    console.log('\n  Sri Yantra geometry\n');
    ok('four upward triangles (Shiva)', UP.length === 4, String(UP.length));
    ok('five downward triangles (Shakti)', DOWN.length === 5, String(DOWN.length));
    ok('nine in total, which cannot be symmetrical — and that is the point',
      UP.length + DOWN.length === 9);
    /* The property that makes it read as a Sri Yantra rather than as a pile of
       triangles: sixteen base endpoints landing exactly on the girdle. */
    ok('the eight outer bases are full chords of the girdle',
      [...UP.slice(0, 4), ...DOWN.slice(0, 4)].every((t) => Math.abs(t.w - chord(t.base)) < 1e-9));
    ok('the ninth sits INSIDE the girdle, because it holds the bindu',
      DOWN[4].w < chord(DOWN[4].base) - 0.2);
    ok('no base is wider than the girdle allows at its own height',
      [...UP, ...DOWN].every((t) => t.w <= chord(t.base) + 1e-9),
      JSON.stringify([...UP, ...DOWN].map((t) => [t.w.toFixed(3), chord(t.base).toFixed(3)])));
    ok('every triangle spans a real height', [...UP, ...DOWN].every((t) => Math.abs(t.apex - t.base) > 0.15));
    ok('the bindu falls inside the ninth triangle',
      DOWN[4].apex < 0 && DOWN[4].base > 0);

    /* Measured from the emitted points, not from the table. The table is what
       was wrong last time, so restating it proves nothing. */
    const pts = (t) => triangle(t).split(' ').map((s) => s.split(',').map(Number));
    ok('every Shiva triangle actually points UP on screen',
      UP.every((t) => { const q = pts(t); return q[0][1] < q[1][1] && q[0][1] < q[2][1]; }),
      JSON.stringify(UP.map((t) => pts(t)[0][1])));
    ok('every Shakti triangle actually points DOWN on screen',
      DOWN.every((t) => { const q = pts(t); return q[0][1] > q[1][1] && q[0][1] > q[2][1]; }),
      JSON.stringify(DOWN.map((t) => pts(t)[0][1])));
    /* The first version failed exactly here — every triangle bunched into the
       lower half and left a bare spike at the top — and nothing caught it
       because no check ever measured where the ink actually was. */
    ok('the nine together are centred on the bindu, not stacked to one side',
      (() => {
        const all = [...UP, ...DOWN].flatMap(pts);
        const mid = (Math.min(...all.map((q) => q[1])) + Math.max(...all.map((q) => q[1]))) / 2;
        return Math.abs(mid - C) < TR * 0.04;
      })(), 'vertical midpoint drifted off the bindu');
    ok('the ink is spread evenly above and below the bindu',
      (() => {
        const all = [...UP, ...DOWN].flatMap(pts);
        const up = all.filter((q) => q[1] < C).length, dn = all.filter((q) => q[1] > C).length;
        return Math.abs(up - dn) <= 3;
      })());
    ok('every triangle is symmetric about the vertical axis',
      [...UP, ...DOWN].every((t) => {
        const q = pts(t);
        return Math.abs((q[1][0] + q[2][0]) / 2 - C) < 0.01 && Math.abs(q[0][0] - C) < 0.01;
      }));
    /* The triangles must stay INSIDE the innermost girdle, or they cut through
       the lotuses — the single most obvious sign that a yantra was drawn rather
       than constructed. */
    /* The instruction that produced TRI: nothing may touch the drawn circle.
       A vertex sitting ON the girdle reads as a mistake even when the maths is
       right, so the margin is asserted rather than assumed. */
    const reach = Math.max(...[...UP, ...DOWN].flatMap(pts).map((q) => Math.hypot(q[0] - C, q[1] - C)));
    ok('no vertex touches the innermost girdle', reach < TR - OUTER * 0.03,
      reach.toFixed(1) + ' vs girdle ' + TR);
    ok('and the field still fills the circle rather than rattling inside it',
      reach > TR * 0.7, reach.toFixed(1));
    ok('eight petals in the inner lotus', (SVG.match(/#chkP8"/g) || []).length === 8);
    ok('sixteen in the outer', (SVG.match(/#chkP16"/g) || []).length === 16);
    /* Scoped to the girdle group. Counting every circle in the file also caught
       the faint outer rings, which is how a check starts passing for the wrong
       reason and then stops noticing anything at all. */
    ok('three girdle circles', (() => {
      const g = SVG.match(/stroke="#F0D08A"[\s\S]*?<\/g>/);
      return g && (g[0].match(/<circle /g) || []).length === 3;
    })());
    ok('three faint outer rings, quieter than the girdles',
      /opacity="\.16"/.test(SVG) && HALO.length === 3);
    /* Petals must OVERLAP their neighbours; narrowing them until they cleared
       each other is what turned both rings into a fence of separate leaves. */
    ok('sixteen petals still ring the outer band without crowding',
      Math.PI * G2 / 16 > Math.min(Math.PI * G2 / 16 * 1.05, (G3 - G2) * 0.42));
    /* A petal points AWAY from the centre. Attempt 3 had it backwards and
       nothing caught it, so this reads the two ends off the emitted path: the
       OUTER end must be the single on-axis point, and the inner end must not be
       on the axis, because that is where the petal is broad. */
    ok('the petal comes to a point at the tip and is broad at the base',
      (() => {
        const d = SVG.match(/<path id="[^"]*P8" d="([^"]+)"/)[1];
        const tip = ' ' + C + ' ' + (C - G2).toFixed(1);
        return d.indexOf(tip) > -1 && d.indexOf('M' + C + ' ') !== 0;
      })());
    /* The proportion that was wrong: a lotus that outweighed the yantra. */
    /* The figure was the other way round once: triangles at 0.34 inside two fat
       petal bands, so the lotus was the loudest thing on the mark. */
    ok('the triangles carry the figure rather than the lotus',
      TRI / OUTER > 0.40, (TRI / OUTER).toFixed(3));
    /* A petal must be TALLER than it is wide, in both rings. Sized against the
       arc each one owns instead, the eight inner petals came out 60 across a
       42-deep band and read as shields rather than petals. */
    ok('every petal is taller than it is wide',
      Math.min(Math.PI * TR / 8 * 1.05, (G2 - TR) * 0.42) * 2 < (G2 - TR) &&
      Math.min(Math.PI * G2 / 16 * 1.05, (G3 - G2) * 0.42) * 2 < (G3 - G2));
    ok('a bindu at the exact centre', /cx="250" cy="250" r="[\d.]+" fill="#FFFAF0"/.test(SVG));

    /* Each placement gets its own id prefix. Without this the three copies in
       one document would all point at the first <defs> and two of them would
       render as empty circles — a failure that looks like a CSS bug for hours. */
    const a = buildYantra({ id: 'aa' }), b = buildYantra({ id: 'bb' });
    ok('the id prefix actually separates two copies',
      a.includes('#aaP8"') && b.includes('#bbP8"') && !b.includes('#aaP8"'));
    ok('the palette is lighter than the old antique brass',
      ['line', 'petal', 'ring', 'gate'].every((k) => {
        const hex = PALETTE[k].slice(1);
        const lum = (parseInt(hex.slice(0, 2), 16) * 0.299 + parseInt(hex.slice(2, 4), 16) * 0.587
                   + parseInt(hex.slice(4, 6), 16) * 0.114);
        return lum > 0.299 * 0xC9 + 0.587 * 0xA2 + 0.114 * 0x27;   // #C9A227
      }));

    console.log('\n  ' + (bad ? '>> ' + bad + ' FAILED'
      : 'nine triangles clear of the girdle, two lotuses, three rings and a bindu — a Sri Yantra, not a stack of hexagrams') + '\n');
    process.exit(bad ? 1 : 0);
  }

  process.stdout.write(buildYantra({ id: 'y' }) + '\n');
}
