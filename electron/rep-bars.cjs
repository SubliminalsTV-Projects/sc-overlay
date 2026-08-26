// Reading the 4.10 REP page's progress bars out of a bitmap.
//
// `src/rep-page.ts` works out WHICH ladder is on screen and hands back a search box per rank
// card; this is the other half, and it lives here for the same reason the mining scan-glyph
// check does: Windows OCR is text-only and cannot see a colour, so the one place that can
// answer "which rank am I" is wherever the frame's pixels are. In the app that is capture.cjs;
// offline it is tools/rep-probe.mts. Both require this file, so there is one implementation.
//
// 🔑 NOTHING HERE IS AN ABSOLUTE COLOUR BAND. Every threshold is derived from the card's own
// fill, measured in the same box, on the same frame — the lesson the mining glyph check had to
// learn twice. What IS absolute is the sign of one comparison (green has more green than blue,
// the grey track has more blue than green), which is a fact about which of two chrome colours
// this is rather than about how bright anybody's screen happens to be.
//
// Measured over two real 3440x1440 stills (2026-08-26), 13 cards:
//   card fill        luminance 61-72
//   grey/locked bar  peak 83-94    lit rgb(64-68, 86-94, 106-118)   G-B is NEGATIVE (-21)
//   green/reached    peak 216-218  lit rgb(128-134, 248-253, 208)   G-B is POSITIVE (+44)
// So the two are separated 7x on brightness-above-fill and by the SIGN of G-B. Requiring both
// means a single washed-out frame cannot promote a grey bar, and a dim monitor cannot demote a
// green one.

/** How much greener than bluer a lit bar must be to count as the "reached" green rather than
 *  the grey track. Measured gap is +44 against -21, so 15 sits in open space with room on both
 *  sides; it is not a tuned value and should not be nudged without re-measuring both cases. */
const GREEN_OVER_BLUE = 15;
/** ...and it must also be decisively brighter than the card it sits on. Measured 3.2x for green
 *  (216 over a 68 fill) against 1.3x for grey (88 over 68). */
const BRIGHT_OVER_FILL = 2.0;
/** A run narrower than this is not a progress bar — it is an icon edge or a stray highlight.
 *  The real bars measured 169-175px on a 3440-wide frame; scaled by frame width so this means
 *  the same thing at any resolution. */
const MIN_BAR_FRAC = 0.012;

const lum = (p) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;

/**
 * Read one card's progress bar.
 *
 * `px(x, y)` returns `{r,g,b}` for a pixel of the FULL frame. `box` is `RepCardBox.bar`, in
 * full-frame pixels.
 *
 * The bar's real extent is FOUND, never assumed: it is the widest contiguous run, anywhere in
 * the box, of pixels brighter than the card's own fill. That matters because the fill fraction
 * is a ratio against that extent — assume the width and a bar drawn one pixel wider or a box
 * clipped one pixel short silently changes the percentage. It also means the box may be
 * generous without cost, which is what lets it be anchored on the label rather than measured.
 */
function readBar(px, box, frameW) {
  const x0 = box.x, x1 = box.x + box.w - 1;
  const y0 = box.y, y1 = box.y + box.h - 1;
  if (x1 <= x0 || y1 <= y0) return { found: false, reached: false, fill: 0, why: "empty box" };

  // The card's own fill: the median of the box's bottom row, which sits in the gap between the
  // bar and the label and so is card and nothing else.
  const quiet = [];
  for (let x = x0; x <= x1; x++) quiet.push(lum(px(x, y1)));
  quiet.sort((a, b) => a - b);
  const cardLum = quiet[quiet.length >> 1];
  const cut = cardLum + 12;

  let best = { y: -1, s: 0, n: 0 };
  for (let y = y0; y <= y1; y++) {
    let s = -1;
    for (let x = x0; x <= x1 + 1; x++) {
      const on = x <= x1 && lum(px(x, y)) > cut;
      if (on && s < 0) s = x;
      else if (!on && s >= 0) { if (x - s > best.n) best = { y, s, n: x - s }; s = -1; }
    }
  }
  if (best.n < Math.round(frameW * MIN_BAR_FRAC)) {
    return { found: false, reached: false, fill: 0, why: `no bar (widest run ${best.n}px, card ${cardLum.toFixed(0)})` };
  }

  let peak = 0;
  for (let x = best.s; x < best.s + best.n; x++) peak = Math.max(peak, lum(px(x, best.y)));
  // "Lit" is halfway from this card's fill to this bar's own peak — relative on both ends, so a
  // bar that is dim overall is still measured against itself.
  const litCut = cardLum + (peak - cardLum) * 0.5;
  let lit = 0, sg = 0, sb = 0;
  for (let x = best.s; x < best.s + best.n; x++) {
    const p = px(x, best.y);
    if (lum(p) > litCut) { lit++; sg += p.g; sb += p.b; }
  }
  const greenOverBlue = lit ? (sg - sb) / lit : 0;
  const brightness = cardLum > 0 ? peak / cardLum : 0;
  const reached = greenOverBlue > GREEN_OVER_BLUE && brightness > BRIGHT_OVER_FILL;
  return {
    found: true,
    reached,
    fill: lit / best.n,
    // Every number the verdict rests on, so a wrong answer can be read rather than guessed at.
    why: `bar y=${best.y} x=${best.s} w=${best.n} lit=${lit} peak=${peak.toFixed(0)} ` +
         `card=${cardLum.toFixed(0)} bright=${brightness.toFixed(2)}x g-b=${greenOverBlue.toFixed(0)}`,
  };
}

/** Read every card's bar. `cards` is `RepLayout.cards`; the result is `RepBarRead[]`, ready for
 *  `repRankFromBars`, with the diagnostic string carried alongside. */
function readBars(px, cards, frameW) {
  return cards.map((c) => {
    const r = readBar(px, c.bar, frameW);
    return { rank: c.rank, found: r.found, reached: r.reached, fill: r.fill, why: r.why };
  });
}

/** Wrap an Electron nativeImage as the pixel accessor `readBar` wants. The bitmap is BGRA. */
function pixelsOf(nativeImg) {
  const { width } = nativeImg.getSize();
  const buf = nativeImg.toBitmap();
  return (x, y) => {
    const i = (y * width + x) * 4;
    return { b: buf[i], g: buf[i + 1], r: buf[i + 2] };
  };
}

module.exports = { readBar, readBars, pixelsOf, GREEN_OVER_BLUE, BRIGHT_OVER_FILL };
