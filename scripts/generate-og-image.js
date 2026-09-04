/**
 * Renders the site's social share card to og-cover.png (1200x630).
 *
 * WHY THIS EXISTS
 * The site had NO og:image at all. Every non-product page shared to WhatsApp,
 * Facebook, X or Slack as a bare grey link — and those four are where a shop
 * like this actually gets passed around.
 *
 * There is no image asset in the repository to point at, and every product
 * photo is hotlinked from a third-party CDN, so using one as the site-wide
 * default would break the day that CDN changes a path. SVG is not an option
 * either: Facebook, WhatsApp and X all refuse it.
 *
 * WHY IT LIFTS THE CHAKRA OUT OF index.html
 * The mandala on this card is not a copy. It is READ from the awakening screen
 * in index.html at generation time — the same twelve-petal Sri Yantra a visitor
 * sees while the site wakes. Copying it here would mean two drawings that agree
 * today and drift the first time either is touched; lifting it means the card
 * cannot show anything other than what the site shows. The palette is read the
 * same way, out of the stylesheet's own custom properties.
 *
 * Run: npm run og:image
 */
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('\n[og-image] playwright is not installed.');
  console.error('           npm install   then   npx playwright install chromium\n');
  process.exit(1);
}

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'og-cover.png');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function cssVar(name, fallback) {
  const m = index.match(new RegExp('--' + name + ':\\s*([^;]+);'));
  return m ? m[1].trim() : fallback;
}
const INK = cssVar('ink', '#2B0A12');
const GOLD = cssVar('gold', '#C9A227');
const GOLD_LT = cssVar('gold-lt', '#E8D48B');
const IVORY = cssVar('ivory', '#FDF8F0');

/**
 * The awakening screen's chakra, lifted verbatim.
 *
 * Fails loudly rather than falling back to a drawing of its own: a card that
 * silently shows a different mandala from the site is worse than no card,
 * because nobody would ever notice it happened.
 */
function extractChakra() {
  const start = index.indexOf('<svg viewBox="0 0 500 500" aria-hidden="true">');
  if (start < 0) {
    throw new Error(
      'Could not find the awakening chakra in index.html.\n' +
      '       This card is generated FROM that markup on purpose, so a copy here\n' +
      '       cannot drift from the site. If the awakening screen was restyled,\n' +
      '       update the marker in extractChakra() to match.'
    );
  }
  const end = index.indexOf('</svg>', start);
  let svg = index.slice(start, end + '</svg>'.length);

  // The site animates it; a still frame must not inherit a mid-rotation
  // transform or a half-faded bindu, so the animation hooks are dropped.
  svg = svg.replace(/class="awaken-spin"/g, '').replace(/class="awaken-bindu"/g, '');
  // Sized and centred by the card's own CSS.
  svg = svg.replace('<svg viewBox="0 0 500 500" aria-hidden="true">', '<svg viewBox="0 0 500 500" class="chakra">');
  return svg;
}

const CHAKRA = extractChakra();

const CARD = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Poppins:wght@400;500&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{width:1200px;height:630px;background:${INK};color:${IVORY};
       font-family:Poppins,system-ui,sans-serif;display:flex;align-items:center;
       justify-content:center;position:relative;overflow:hidden;}
  /* A soft gold bloom behind the mandala, so the card is not a flat rectangle. */
  .glow{position:absolute;width:820px;height:820px;border-radius:50%;top:-190px;
        background:radial-gradient(circle, rgba(201,162,39,.22) 0%, rgba(201,162,39,0) 62%);}
  .frame{position:absolute;inset:30px;border:2px solid rgba(201,162,39,.38);border-radius:14px;}
  .c{position:absolute;width:48px;height:48px;border:3px solid ${GOLD};}
  .tl{top:30px;left:30px;border-right:0;border-bottom:0;border-radius:14px 0 0 0;}
  .tr{top:30px;right:30px;border-left:0;border-bottom:0;border-radius:0 14px 0 0;}
  .bl{bottom:30px;left:30px;border-right:0;border-top:0;border-radius:0 0 0 14px;}
  .br{bottom:30px;right:30px;border-left:0;border-top:0;border-radius:0 0 14px 0;}
  .inner{position:relative;text-align:center;padding:0 80px;display:flex;
         flex-direction:column;align-items:center;}
  /* The chakra sits ABOVE the wordmark and is the largest thing on the card. */
  .chakra{width:212px;height:212px;display:block;margin-bottom:22px;overflow:visible;}
  .word{font-family:Cinzel,Georgia,serif;font-weight:700;font-size:88px;
        letter-spacing:.055em;color:${GOLD_LT};line-height:1;
        text-shadow:0 2px 26px rgba(201,162,39,.30);}
  .rule{width:150px;height:2px;background:${GOLD};margin:22px auto 20px;opacity:.85;}
  .tag{font-size:25px;letter-spacing:.015em;color:rgba(253,248,240,.9);line-height:1.4;}
  .foot{position:absolute;bottom:56px;left:0;right:0;text-align:center;
        font-size:17px;letter-spacing:.17em;text-transform:uppercase;color:rgba(232,212,139,.7);}
</style></head><body>
  <div class="glow"></div>
  <div class="frame"></div>
  <div class="c tl"></div><div class="c tr"></div><div class="c bl"></div><div class="c br"></div>
  <div class="inner">
    ${CHAKRA}
    <div class="word">CHAKRASHRI</div>
    <div class="rule"></div>
    <div class="tag">Sacred, Authentic, Pure &amp; Trustworthy</div>
  </div>
  <div class="foot">Sacred objects · Puja &amp; astrology · Across India</div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  // deviceScaleFactor 1: the card is authored at the exact 1200x630 every
  // platform crops to, so scaling it up would only inflate the file.
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(CARD, { waitUntil: 'load' });
  // A card screenshotted mid font-swap renders the wordmark in a fallback serif
  // and looks nothing like the site.
  try { await page.evaluate(() => document.fonts.ready); } catch { /* older engines */ }
  await page.waitForTimeout(700);
  await page.screenshot({ path: OUT, type: 'png' });
  await browser.close();

  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`[og-image] Wrote og-cover.png (1200x630, ${kb}KB) — chakra lifted from index.html.`);
  if (kb > 300) {
    console.log('[og-image] NOTE: over 300KB — some scrapers give up on very large images.');
  }
})();
