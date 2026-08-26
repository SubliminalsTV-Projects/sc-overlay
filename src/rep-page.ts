// The 4.10 mobiGlas REP page — turning a screenshot of it into "which rank am I, with whom".
//
// 4.10 gave reputation its own page, and unlike everything else the app reads off the screen
// this one is set LARGE: Windows OCR reads every rank name on it correctly, so none of the
// RapidOCR machinery the Contract Manager needed applies here. Measured on two real 3440x1440
// PTU stills (2026-08-26) — see references/rep-scan.md for the numbers.
//
// 🔴 THE PAGE STATES YOUR RANK IN COLOUR, NOT IN TEXT. Every rank is drawn as a card with a
// progress bar above its name; the bar is bright green up to the rank you hold and grey after
// it. There is no number anywhere on the page and no word that says where you are. So this
// module does the half that text can do — WHICH ladder is on screen, and WHERE each card's bar
// is — and hands the bar boxes to whoever holds the bitmap to have their pixels read. Exactly
// the split the mining scanner already uses for its scan glyph (`glyphSearchBox`).
//
// The other half of the design is that nothing here is located by pixel coordinates. The page
// is found by ANCHOR TEXT and by VOCABULARY WE ALREADY SHIP: the faction heading is the largest
// text on screen, the section header is a rep scope's own display name, and the rank cards are
// found by looking for the rank names that scope's ladder says must be there. A layout that
// does not match a ladder we know is refused rather than guessed at — see `RepRefusal`.

import type { OcrLine, OcrResult, Rect } from "./screen-read.js";

/** One rank ladder as `data/rep-scopes.json` ships it. */
export interface RepScope {
  /** Nullable to match the dataset: a scope with no display name simply can never be matched to
   *  a section header, which is the safe direction — it declines rather than joining on "". */
  displayName: string | null;
  ranks: { minRep: number; name: string }[];
}
export type RepScopes = Record<string, RepScope>;

/** A rank card located on screen: its name, and the box to read its progress bar out of. */
export interface RepCardBox {
  /** Index into the scope's ladder — by construction, not by reading the card's position. */
  rank: number;
  name: string;
  /** The card's own label box, for diagnostics and for drawing a read-out over the game. */
  label: Rect;
  /** Where to hunt this card's progress bar. See `barSearchBox` for how it is derived. */
  bar: Rect;
}

/** What the TEXT of the page yields, before anyone has looked at a single pixel. */
export interface RepLayout {
  /** The faction heading, verbatim from OCR (upper case, as the game draws it). */
  factionRaw: string;
  /** The standing word under the heading ("NEUTRAL"). This is the player's FactionReputation
   *  standing and has nothing to do with the section's ladder — kept for diagnostics only, and
   *  deliberately never written anywhere. */
  standingRaw: string | null;
  /** The section header, verbatim ("BOUNTY HUNTING"). */
  sectionRaw: string;
  /** The scope key this page resolved to, e.g. `BountyHunter_BountyHuntersGuild`. */
  scope: string;
  /** The dataset giver spelling the faction heading resolved to, when it resolved to exactly
   *  one. Null when the caller supplied no giver list, or when the heading matched none. */
  giver: string | null;
  cards: RepCardBox[];
}

/** Why a page could not be read. Every one of these is a REFUSAL, not a degraded answer: the
 *  scan overwrites the stored floor, so a page we are not sure about must produce nothing. */
export type RepRefusal =
  | "no-heading"          // nothing on screen looks like a faction heading
  | "heading-not-decisive" // two lines are the same size; we cannot tell which is the heading
  | "no-section"          // no line below the heading names a rep scope we ship
  | "no-scope"            // the section named a scope, but no candidate ladder matched the cards
  | "scope-ambiguous"     // two ladders matched equally well and nothing separates them
  | "cards-incomplete";   // the ladder's ranks are not all on screen (a scrolled/partial section)

export interface RepLayoutResult {
  layout: RepLayout | null;
  refusal: RepRefusal | null;
  /** Every candidate considered and how it scored, so a refusal can be explained rather than
   *  just reported. This is what a diagnostics dump prints. */
  tried: { scope: string; matched: number; of: number }[];
}

// ── Text normalisation ────────────────────────────────────────────────────────
//
// OCR gives us upper case with the game's own letter-spacing, and the dataset gives us mixed
// case with punctuation ("Jr. Runner", "Rough & Ready"). Compare on a form that survives both.

/** Roman numerals come back with I/l/| swapped ("III" -> "Ill"), which matters because six
 *  ladders are nothing but `Rank I`..`Rank VI`. Same rule `screen-read.ts` applies to item names.
 *
 *  ⚠️ It has to run BEFORE the uppercasing, or the lowercase `l` it exists to repair has already
 *  become an `L` and nothing matches. That ordering is the whole of this function.
 *
 *  ⚠️ A token made only of these letters is normalised whether or not it was a numeral, so a real
 *  word like "Ill" would become "III". That is unavoidable without context and it is harmless
 *  here, because the vocabulary is closed: no rank name in `rep-scopes.json` is such a word, and
 *  the test asserts that against the shipped file rather than taking it on trust. */
function romanFix(tok: string): string {
  if (tok.length < 2 || !/^[ilvx|]+$/i.test(tok)) return tok.toUpperCase();
  return tok.replace(/[l|]/g, "I").toUpperCase();
}

export function normRep(s: string): string {
  return s
    .replace(/&/g, " and ")
    // The pipe survives the punctuation strip on purpose: it is one of the glyphs OCR returns
    // for a capital I, so romanFix has to still be able to see it. Anything left over after
    // that is dropped on the way out.
    .replace(/[^A-Za-z0-9|]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(romanFix)
    .join(" ")
    .replace(/\|/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Where a card's progress bar is ────────────────────────────────────────────

/**
 * The box to hunt a rank card's progress bar in: the band immediately ABOVE the card's first
 * label line, anchored on that line's own OCR bbox so it travels with the text — UI scale and
 * resolution both stop mattering, the same reasoning as `glyphSearchBox`.
 *
 * Measured on the two 3440x1440 stills: label height 14-15px, bar sitting 15-20px above the
 * label top and running 169-175px wide. In text-heights that is ~1.3h above and ~12h long. The
 * band is generous vertically (0.3h..3.2h above) because the bar's exact offset is not worth
 * betting on, and the run-finder that reads it locates the bar's REAL extent inside this box
 * rather than trusting the width — so being too wide costs nothing and being too narrow would
 * silently truncate the fill measurement.
 *
 * `nextCardX` clamps the right edge so the box can never reach into the neighbouring card,
 * whose own bar would otherwise be read as this one's. Callers pass the next located card's
 * label x; with only one card in a row we fall back to 16h, which is comfortably inside the
 * 22.6h column pitch that was measured.
 */
export function barSearchBox(line: OcrLine, frameW: number, frameH: number, nextCardX?: number): Rect {
  const th = Math.max(6, line.h);
  const x = Math.round(line.x - th * 1.5);
  const y = Math.round(line.y - th * 3.2);
  const right = nextCardX !== undefined
    ? Math.min(Math.round(nextCardX - th * 1.5), Math.round(line.x + th * 16))
    : Math.round(line.x + th * 16);
  const h = Math.round(th * 2.9);
  const cx = Math.max(0, Math.min(x, frameW - 1));
  const cy = Math.max(0, Math.min(y, frameH - 1));
  return {
    x: cx,
    y: cy,
    w: Math.max(1, Math.min(right - cx, frameW - cx)),
    h: Math.max(1, Math.min(h, frameH - cy)),
  };
}

// ── Reading the page ──────────────────────────────────────────────────────────

/** The faction heading is the largest text on the page, by a wide margin: 39-40px against 27px
 *  for the next largest (the search box) on both measured stills. Requiring it to be decisively
 *  larger rather than merely largest is what stops a page we are not looking at — or a frame
 *  caught mid-transition — producing a confident heading out of whatever happened to be tall. */
const HEADING_MARGIN = 1.25;

function findHeading(lines: OcrLine[]): { line: OcrLine; decisive: boolean } | null {
  const sorted = [...lines].filter((l) => l.text.trim().length >= 3).sort((a, b) => b.h - a.h);
  if (!sorted.length) return null;
  const top = sorted[0];
  // The runner-up must be meaningfully smaller. Lines that are part of the SAME heading (a
  // wrapped faction name) sit at the same height, so compare against the tallest line that is
  // not on the heading's own row.
  const other = sorted.find((l) => l !== top && Math.abs(l.y - top.y) > top.h * 0.8);
  return { line: top, decisive: !other || top.h >= other.h * HEADING_MARGIN };
}

/** Group OCR lines into card labels: runs of vertically consecutive lines sharing a left edge.
 *  A rank name wraps onto up to three lines ("PROBATIONARY" / "GUILD MEMBER"), and the reward
 *  text below it ("ADDITIONAL CONTRACTS") shares that left edge too — which is precisely why
 *  this does NOT try to decide where a name ends. It offers every prefix, and the LADDER picks. */
function stacksAt(lines: OcrLine[], startIdx: number, ordered: OcrLine[]): OcrLine[][] {
  const first = ordered[startIdx];
  const th = Math.max(6, first.h);
  const run = [first];
  for (let i = startIdx + 1; i < ordered.length; i++) {
    const l = ordered[i];
    if (Math.abs(l.x - first.x) > th * 1.2) continue;      // a different column
    const prev = run[run.length - 1];
    if (l.y <= prev.y) continue;
    if (l.y - prev.y > th * 2.6) break;                     // too far down to be the same block
    run.push(l);
    if (run.length >= 3) break;
  }
  return run.map((_, i) => run.slice(0, i + 1));
}

/**
 * Read a REP page out of a full-frame OCR result.
 *
 * `scopes` is `data/rep-scopes.json`'s `scopes` map. `giverScopes`, when supplied, maps a
 * dataset giver spelling to the scope keys that giver's missions actually award — the third
 * and strongest join. Supplying it is what separates the ladders that are character-identical
 * (`Courier` vs `Courier_TransportGuild`, `Security` vs `Security_MercenaryGuild`, and the four
 * `Mercenary` scopes); without it those pages resolve to `scope-ambiguous` and are refused.
 */
export function readRepPage(
  ocr: OcrResult,
  scopes: RepScopes,
  giverScopes?: Record<string, string[]>,
): RepLayoutResult {
  const tried: { scope: string; matched: number; of: number }[] = [];
  const head = findHeading(ocr.lines);
  if (!head) return { layout: null, refusal: "no-heading", tried };
  if (!head.decisive) return { layout: null, refusal: "heading-not-decisive", tried };

  const factionRaw = head.line.text.trim();
  const factionKey = normRep(factionRaw);

  // Which givers could this heading be? Case-insensitive, because the game sets the page in
  // capitals — which also collapses the dataset's two spellings of Citizens f/For Prosperity.
  const giverMatches = giverScopes
    ? Object.keys(giverScopes).filter((g) => normRep(g) === factionKey)
    : [];
  const giver = giverMatches.length === 1 ? giverMatches[0] : null;
  const giverScopeSet = giver ? new Set(giverScopes![giver]) : null;

  // Everything below the heading is the page's body. The left panel's faction list sits above
  // and to the left, and the bottom nav sits below the cards; both are excluded by the ladder
  // match rather than by a y-cutoff, because a cutoff is a pixel guess and this is not.
  const below = ocr.lines
    .filter((l) => l.y > head.line.y + head.line.h * 0.5 && l.x > head.line.x - head.line.h)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  // The section header names a scope we ship. Vocabulary, not geometry.
  const byDisplay = new Map<string, string[]>();
  for (const [key, s] of Object.entries(scopes)) {
    if (!s.displayName) continue;
    const k = normRep(s.displayName);
    if (!k) continue;
    const arr = byDisplay.get(k);
    if (arr) arr.push(key); else byDisplay.set(k, [key]);
  }
  const sectionLine = below.find((l) => byDisplay.has(normRep(l.text)));
  if (!sectionLine) return { layout: null, refusal: "no-section", tried };
  const sectionRaw = sectionLine.text.trim();

  // The standing word is whatever sits between the heading and the section header on the
  // heading's own left edge. Diagnostics only — it is the FactionReputation standing, a
  // different scope from the one this section is about, and conflating them is the two-
  // standings-at-once bug the widget already had once.
  const standing = below.find(
    (l) => l.y < sectionLine.y && Math.abs(l.x - head.line.x) <= head.line.h * 0.6,
  );

  const cardLines = below.filter((l) => l.y > sectionLine.y + sectionLine.h * 0.5);

  // Score every candidate ladder by how much of it is actually on screen, in order.
  let best: { key: string; cards: RepCardBox[] } | null = null;
  let bestMatched = -1;
  let bestTied = false;
  for (const key of byDisplay.get(normRep(sectionRaw))!) {
    if (giverScopeSet && !giverScopeSet.has(key)) continue;   // this giver never awards it
    const ranks = [...scopes[key].ranks].sort((a, b) => a.minRep - b.minRep);
    const found = locateLadder(ranks, cardLines, ocr);
    tried.push({ scope: key, matched: found.length, of: ranks.length });
    if (found.length > bestMatched) { bestMatched = found.length; best = { key, cards: found }; bestTied = false; }
    else if (found.length === bestMatched && found.length > 0) bestTied = true;
  }
  if (!best || bestMatched === 0) return { layout: null, refusal: "no-scope", tried };
  if (bestTied) return { layout: null, refusal: "scope-ambiguous", tried };

  // 🔴 EVERY rank has to be on screen. A section whose ladder is only partly visible is a
  // scrolled page, and reading a rank index off a partial ladder puts the player at the wrong
  // place on it — which, given the scan overwrites, is the failure this whole module exists to
  // avoid. Refuse and let them scroll.
  const wanted = scopes[best.key].ranks.length;
  if (best.cards.length !== wanted) return { layout: null, refusal: "cards-incomplete", tried };

  return {
    layout: {
      factionRaw,
      standingRaw: standing ? standing.text.trim() : null,
      sectionRaw,
      scope: best.key,
      giver,
      cards: best.cards,
    },
    refusal: null,
    tried,
  };
}

/** Find each of a ladder's ranks among the card lines, in ladder order. A rank may wrap over up
 *  to three OCR lines; the accumulated text has to equal the rank name exactly once normalised,
 *  so the reward text below a card can never be absorbed into its name. */
function locateLadder(
  ranks: { minRep: number; name: string }[],
  cardLines: OcrLine[],
  ocr: OcrResult,
): RepCardBox[] {
  const hits: { rank: number; name: string; first: OcrLine; label: Rect }[] = [];
  const used = new Set<OcrLine>();

  for (let r = 0; r < ranks.length; r++) {
    const want = normRep(ranks[r].name);
    let hit: { first: OcrLine; label: Rect } | null = null;
    for (let i = 0; i < cardLines.length && !hit; i++) {
      if (used.has(cardLines[i])) continue;
      for (const stack of stacksAt(cardLines, i, cardLines)) {
        if (stack.some((l) => used.has(l))) continue;
        if (normRep(stack.map((l) => l.text).join(" ")) !== want) continue;
        const x = Math.min(...stack.map((l) => l.x));
        const y = Math.min(...stack.map((l) => l.y));
        const x2 = Math.max(...stack.map((l) => l.x + l.w));
        const y2 = Math.max(...stack.map((l) => l.y + l.h));
        stack.forEach((l) => used.add(l));
        hit = { first: stack[0], label: { x, y, w: x2 - x, h: y2 - y } };
        break;
      }
    }
    if (hit) hits.push({ rank: r, name: ranks[r].name, ...hit });
  }

  // Clamp each bar box against the next card to the RIGHT on the same row, so one card's box
  // can never reach into its neighbour's bar. Derived from the cards we found rather than from
  // a column pitch we assumed.
  return hits.map((h) => {
    const rowMates = hits
      .filter((o) => o !== h && Math.abs(o.first.y - h.first.y) < h.first.h * 1.5 && o.first.x > h.first.x)
      .sort((a, b) => a.first.x - b.first.x);
    return {
      rank: h.rank,
      name: h.name,
      label: h.label,
      bar: barSearchBox(h.first, ocr.w, ocr.h, rowMates.length ? rowMates[0].first.x : undefined),
    };
  });
}

// ── Turning bar readings into a rank ──────────────────────────────────────────

/** What reading one card's bar box yielded. Produced wherever the bitmap is — `capture.cjs` in
 *  the app, the probe tool offline — never here. */
export interface RepBarRead {
  rank: number;
  /** The bar was found at all. A card whose bar could not be located is not the same as a card
   *  whose bar is empty, and the difference decides between a rank and a refusal. */
  found: boolean;
  /** True when this bar is the bright "reached" green rather than the grey locked track.
   *  Measured separation on the stills: peak luminance 216-218 green against 83-94 grey, over a
   *  card fill of 61-72. The test is made RELATIVE to the card's own fill by the reader, so it
   *  is not a fixed colour band — the mining glyph's lesson. */
  reached: boolean;
  /** Fraction of the bar that is lit, 0..1. Display only — see `repRankFromBars`. */
  fill: number;
}

export type RepRankRefusal =
  | "bars-unreadable"     // one or more cards' bars could not be found
  | "no-rank-reached"     // nothing is green: the page is not showing this player's progress
  | "rank-not-contiguous"; // green cards are not one unbroken run — not a ladder state

export interface RepRankResult {
  rank: number | null;
  /** The lit fraction of the current rank's own bar. Shown to the player, never stored. */
  progress: number | null;
  refusal: RepRankRefusal | null;
}

/**
 * Which rank is the player at, given every card's bar?
 *
 * The rule, measured on both stills: **the current rank is the highest-index card whose bar is
 * green.** Cards below it are green and full; cards above it are grey. Index 0 (`Not Eligible`)
 * is grey even for a player well past it, because it is the below-zero state rather than an
 * achievement — so the green run legitimately starts at 1, and this must not be read as a gap.
 *
 * 🔴 THE FILL FRACTION IS NOT CONVERTED INTO A REPUTATION NUMBER, and it would be easy and
 * wrong to do so. The bar is uncalibrated: nothing tells us it is linear across a rank's span,
 * or whether it clamps, and the two spans it was measured over (0->1 and 1->3000) are four
 * orders of magnitude apart. What the page states honestly is a RANK; the number that follows
 * is that rank's own floor, which is already exactly the quantity `giverTrack()` reconciles as
 * `rankFloor`. Interpolating would turn an observed fact into an estimate while looking like an
 * improvement.
 */
export function repRankFromBars(bars: RepBarRead[]): RepRankResult {
  if (!bars.length || bars.some((b) => !b.found)) {
    return { rank: null, progress: null, refusal: "bars-unreadable" };
  }
  const green = bars.filter((b) => b.reached).map((b) => b.rank).sort((a, b) => a - b);
  if (!green.length) return { rank: null, progress: null, refusal: "no-rank-reached" };
  for (let i = 1; i < green.length; i++) {
    if (green[i] !== green[i - 1] + 1) {
      return { rank: null, progress: null, refusal: "rank-not-contiguous" };
    }
  }
  const rank = green[green.length - 1];
  return { rank, progress: bars.find((b) => b.rank === rank)?.fill ?? null, refusal: null };
}

/** The reputation floor a scanned rank puts under the player: that rank's own `minRep`.
 *  Negative floors (`Not Eligible` ships at -1000, and -320000 for Emergency) are clamped to 0
 *  — they are the game's way of saying "locked", not a debt, and letting one through would
 *  drag a witnessed total DOWN below zero on a re-baseline. */
export function repFloorForRank(scope: RepScope, rank: number): number | null {
  const ranks = [...scope.ranks].sort((a, b) => a.minRep - b.minRep);
  const r = ranks[rank];
  if (!r) return null;
  return Math.max(0, r.minRep);
}
