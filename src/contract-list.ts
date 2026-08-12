// Reading the mobiGlas Contract Manager's OFFERS list.
//
// Why this exists: for the ~1,000 contracts the game marks CalculatedReward, the aUEC
// payout is computed server-side at accept time. It is not in the datacore (those rows
// carry reward="0"), there is no reward curve anywhere in the records, and the
// "Awarded N aUEC" line this app used to parse out of game.log is no longer emitted.
// Reading the board is the only way left to learn what a contract pays.
//
// 🔑 THE LIST ROUNDS AND THAT IS FINE. The board shows "63k", not 63,412 — Sub's call
// (2026-08-11): "the end user is not going to care about that extra $500." Exact figures
// would mean clicking into every contract, which nobody will do at scale. So values are
// tagged `rounded` and the site's median-plus-range display carries the imprecision
// honestly rather than pretending to a precision we don't have.
//
// 🔑 SOME ROWS SHOW A FEE, NOT A REWARD ("Fee:13500"). 101 contracts charge to accept and
// 87 of them have no fixed payout, so they are over-represented here — and read naively a
// COST becomes a REWARD, which is the worst possible error for this dataset. A fee row
// therefore yields kind:"fee" and NO payout, and its reward stays unknown.
//
// Structure, measured off a real 3440x1440 capture (tools/ocr-probe.mts over
// ScreenShot-2026-08-11_18-45-30-82C.jpg) rather than eyeballed:
//   category header   h≈21   left column, with a count in the right column
//   title line(s)     h≈15-18 left column, ONE or TWO lines (never three)
//   giver             h≈12-13 left column, directly under the title
//   amount            h≈16-18 right column, vertically centred on the row
// Text height is what separates a title from a giver; horizontal position is what
// separates either from the amount.
//
// ⚠️ THE PANEL IS DRAWN IN PERSPECTIVE, so the left edge DRIFTS down the list (x=728 at
// the top, x=684 at the bottom of the same capture). Nothing here may key off an absolute
// x, and a fixed left margin would silently drop the lower rows.

import type { OcrLine, OcrResult } from "./screen-read.js";

export type AmountKind = "payout" | "fee";

export interface ContractRow {
  /** The category the row sits under ("MERCENARY") — the mission TYPE, and one of the
   *  three keys used to match a row back to the dataset. Null above the first header. */
  category: string | null;
  /** Title as displayed: uppercased, with the game's placeholders already filled in. */
  title: string;
  /** The blue line under the title ("CITIZENS FOR PROSPERITY"). */
  giver: string | null;
  amount: number | null;
  kind: AmountKind | null;
  /** True when the amount came from a "63k"-style abbreviation, i.e. +/-500. */
  rounded: boolean;
  /** Vertical centre of the row in the captured frame. Used to dedup across scrolls and
   *  to order rows; never persisted. */
  y: number;
}

/** Text-height bands. Expressed as FRACTIONS OF THE FRAME HEIGHT so they survive a
 *  different resolution — the measured capture was 1440 tall, where a giver line is
 *  ~12px and a title ~16px. */
const GIVER_MAX_H = 13.5 / 1440;
const TITLE_MAX_H = 19 / 1440;

/** How far the left column's start may drift, as a fraction of the PANEL's width. The
 *  perspective skew moves it ~63px across a ~536px-wide panel in the reference capture,
 *  so 12% covers it with room while still excluding the amount column. */
const LEFT_COL_TOL = 0.12;

/** The offers panel within the captured frame, in pixels. */
export interface PanelRect { x: number; y: number; w: number; h: number }

/** "63k" -> 63000, "1.5k" -> 1500, "Fee:13500" -> 13500. Returns null for anything that
 *  isn't a money value, which is most of the HUD. */
/** Turn the letters OCR substitutes for digits back into digits, but ONLY inside something
 *  that is already numeric.
 *
 *  🔑 THE GUARD IS THE WHOLE DESIGN: at least one genuine digit must already be present.
 *  Without it this converts WORDS into numbers — the mining scanner learned that when "IIOO"
 *  parsed as 1,100 — and the amount column would start inventing payouts out of stray text.
 *  With it, "4lk" becomes "41k" (a real 41,000 that Sub's 2026-08-12 sweep threw away twice
 *  as no-price, while "4lk" stayed glued to the title and broke the match too) and "SLUGGERS"
 *  is left alone because it carries no digit to anchor on.
 *
 *  Safe HERE in a way it would not be elsewhere on screen, because this column is known to be
 *  money by POSITION — right of the half-panel split — rather than guessed at from content.
 *  Deliberately only the substitutions actually observed plus their obvious twins; the
 *  signature repair's rule applies just as much here — do not add pairs without measuring,
 *  since each one widens the chance of turning a misread into a wrong-but-plausible number. */
export function rescueAmountDigits(raw: string): string {
  if (!/\d/.test(raw)) return raw;
  return raw.replace(/[lI|]/g, "1").replace(/[Oo]/g, "0");
}

export function parseAmount(raw: string): { amount: number; kind: AmountKind; rounded: boolean } | null {
  const t = raw.trim();

  // 🔴 THE EXPIRY TIMER LIVES IN THE SAME COLUMN AS THE MONEY, and the two are one
  // character apart: "1M" is a one-million payout, "5m 17s" is five minutes. Getting
  // this wrong turns a 24-minute countdown into a 24,000,000 aUEC contract, which would
  // poison the median for that mission permanently.
  //
  // 🔑 CASE IS NOT THE DISCRIMINATOR. It briefly was — "1M" is a million, "5m 17s" is
  // five minutes — but Sub is right that leaning on it is fragile: the game's menus are
  // set in capitals, OCR's idea of case at this size is unreliable, and nothing about the
  // MEANING of a number depends on the shape of its letters. What actually separates a
  // countdown from money is STRUCTURE: a duration carries an `s` or a second component,
  // money never does. So both are matched case-insensitively and time is rejected on its
  // shape alone.
  //
  // ⚠️ Residual, stated rather than hidden: a bare "5m" with no seconds part would read
  // as five million. Not once in the real captures — every countdown seen carried its
  // seconds ("27m 29s", "52m 8s", and the mangled "59m SSS") — but if the UI ever shows a
  // whole-minute countdown, this is the line that will be wrong.
  if (/s/i.test(t) && !/^fee/i.test(t)) return null;
  if (/\s/.test(t) && !/^fee/i.test(t)) return null;

  const r = rescueAmountDigits(t);

  // A fee is labelled outright, and the label is the ONLY thing distinguishing a cost
  // from a reward — the number itself looks identical.
  const fee = /^fee\s*[:.]?\s*([\d,.]+)\s*([km])?$/i.exec(r);
  const plain = /^([\d,.]+)\s*([km])?$/i.exec(r);
  const m = fee ?? plain;
  if (!m) return null;
  const digits = m[1].replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  let n = Number(digits);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] ?? "").toLowerCase();
  const rounded = suffix !== "";
  if (suffix === "k") n *= 1_000;
  if (suffix === "m") n *= 1_000_000;
  n = Math.round(n);
  // A bare 1- or 2-digit number is a category's row count or a rank badge, not money.
  // The smallest real fee in the datacore is 250.
  if (n < 100) return null;
  return { amount: n, kind: fee ? "fee" : "payout", rounded };
}

/** Category headers come back with the row's ICON glyph OCR'd as a stray character —
 *  real reads include "e SERVICE BEACONS", "5 HAND MINING", "15 SALVAGE" and
 *  "b, MERCENARY". The icon also inflates the line's height (up to 38px against a
 *  normal 21), which is harmless here but is why the height bands have headroom. */
export function cleanCategory(raw: string): string | null {
  const stripped = raw
    .trim()
    .replace(/^[^A-Za-z]*[A-Za-z]?[^A-Za-z]+/, "") // leading icon-glyph noise
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  // "e," and "u" are pure icon noise on their own line; a real category is a word.
  return /[A-Z]{3}/.test(stripped) ? stripped : null;
}

/** Uppercase, collapse whitespace, drop the punctuation the game and our dataset disagree
 *  about. Used on both sides of a title comparison so the match isn't defeated by an
 *  apostrophe ("YANG'S" vs "Yang’s" — a straight quote against a curly one). */
export function normalizeTitle(s: string | null | undefined): string {
  // The dataset carries a null title on a handful of contracts, and this is called across
  // all 2,763 of them to build the matcher — one null took the whole index down.
  if (!s) return "";
  return s
    .toUpperCase()
    .replace(/[‘’']/g, "")
    .replace(/[^A-Z0-9\[\] ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The category and giver names the dataset actually contains. Supplying these turns the
 *  parse from geometry-guessing into vocabulary matching — see parseContractList. */
export interface ContractVocab {
  categories: string[];
  givers: string[];
}

/** Strip a trailing money token off a line and hand back both halves.
 *
 *  🔴 REQUIRED FOR RAPIDOCR, WHICH FUSES THE COLUMNS. Windows OCR returns the title and
 *  the amount as separate lines, so they can be told apart by x. PP-OCR returns the whole
 *  visual row as ONE detection — "INTERESTED IN BUILDING A BETTER 103k" — and no amount
 *  of column geometry can separate what the engine has already joined. (The fabricator
 *  reader already notes PP-OCR fusing adjacent panels; same behaviour, different screen.) */
export function splitTrailingAmount(text: string): { head: string; money: ReturnType<typeof parseAmount> } {
  const t = text.trim();
  // Try progressively longer tails: "103k", "Fee:13500", "52m 8s" (rejected as a duration
  // by parseAmount, which is what keeps a timer out of the money slot).
  // The interior of the number tolerates the letters OCR swaps for digits (see
  // rescueAmountDigits) — without that this regex could not even REACH "PILOT IN DISTRESS 4lk",
  // so the 41,000 was lost AND "4lk" stayed in the title and broke the dataset match as well.
  // The tail must still START with a real digit: letting it begin with a letter would let the
  // "OF" in "SMALL SUPPLY OF RMC" volunteer as an amount before parseAmount could refuse it.
  const m = /^(.*?)[\s]+((?:fee\s*[:.]?\s*)?[\d][\dlIO|,.]*\s*[kKM]?)$/i.exec(t);
  if (m) {
    const money = parseAmount(m[2]);
    if (money) return { head: m[1].trim(), money };
  }
  return { head: t, money: null };
}

/** Strip a trailing 1–3 digit count, which is how a category header carries its size
 *  ("COLLECTION 2", "MERCENARY 24"). Only ever applied to a line already believed to be a
 *  category, so it cannot eat a real payout. */
function stripCount(text: string): string {
  return text.replace(/\s+\d{1,3}$/, "").trim();
}

/** Strip a trailing expiry countdown.
 *
 *  🔴 THE TIMER GETS FUSED INTO THE TITLE. PP-OCR returned "VERY HUNGRY 52m 8s" as one
 *  detection, and a standalone "27m 29s" on its own line got swept up as a second title
 *  line — either way the countdown ends up inside the text we try to match against the
 *  dataset, and nothing matches. parseAmount already refuses to read a duration as money
 *  (which is what stops 52m becoming 52 million); this is the other half, removing it
 *  from the words.
 *
 *  Tolerant of the mangling this size of text produces: "59m 55s" came back as
 *  "59m SSS". */
export function stripTrailingDuration(text: string): string {
  return text.replace(/\s*\b\d{1,3}\s*[mhMH]\s*[\dsS]{0,4}\s*$/, "").trim();
}

/** Split the OCR of a Contract Manager capture into rows.
 *
 *  🔑 VOCABULARY FIRST, GEOMETRY SECOND. When `vocab` is supplied, a line is a category
 *  because it IS one of the game's category names and a line is a giver because it IS one
 *  of the 65 known givers — not because its text happens to be 22px tall. Height bands
 *  worked for Windows OCR and fell apart on RapidOCR, where a title's second line
 *  ("FUTURe?", 17px) is indistinguishable from a giver ("WIKELO", 16px). The names are
 *  data we already have; inferring them from pixel heights was solving a problem we had
 *  the answer to.
 *
 *  Without `vocab` it falls back to the height/column heuristics, which is what the
 *  Windows-OCR fixtures exercise.
 *
 *  Deliberately tolerant: it returns what it could read and leaves fields null rather
 *  than dropping a row. A row with a title and no amount is still useful (it proves the
 *  contract is on the board); a row with an amount and no title is not, and is discarded. */
export function parseContractList(ocr: OcrResult, region?: PanelRect, vocab?: ContractVocab): ContractRow[] {
  if (vocab) return parseWithVocab(ocr, region, vocab, lastVocabCategory);
  const giverMaxH = GIVER_MAX_H * ocr.h;
  const titleMaxH = TITLE_MAX_H * ocr.h;

  // 🔑 The caller passes the calibrated offers panel, exactly like the Mining Scanner's
  // scan box. Without it there is no honest way to tell the left column from the rest of
  // the HUD: the bottom nav ("CONTRACTS", "WALLET") and the "ACCEPTED (0/10)" header are
  // ordinary text at ordinary heights, and letting them into the column maths pushed the
  // amount boundary out past the amounts themselves — every row parsed with a null price.
  const inRegion = region
    ? ocr.lines.filter(
        (l) =>
          l.x + l.w > region.x &&
          l.x < region.x + region.w &&
          l.y + l.h > region.y &&
          l.y < region.y + region.h,
      )
    : ocr.lines;
  const panel = inRegion.filter((l) => l.text.trim().length > 0);
  if (!panel.length) return [];

  const panelWidth = region ? region.w : Math.max(...panel.map((l) => l.x + l.w)) - Math.min(...panel.map((l) => l.x));
  const leftEdge = Math.min(...panel.map((l) => l.x));

  // The left column is everything starting near the panel's left edge; its widest line is
  // the title column's extent, and anything beyond that is the amount. Derived from the
  // COLUMN rather than from all text, so a wide stray elsewhere in the region can't move
  // the boundary.
  const leftCol = panel.filter((l) => l.x <= leftEdge + panelWidth * LEFT_COL_TOL);
  if (!leftCol.length) return [];
  const amountX = Math.max(...leftCol.map((l) => l.x + l.w));

  const sorted = [...panel].sort((a, b) => a.y - b.y);
  const rows: ContractRow[] = [];
  let category: string | null = null;
  let pending: { titles: OcrLine[]; giver: OcrLine | null } | null = null;

  const flush = () => {
    if (!pending || !pending.titles.length) {
      pending = null;
      return;
    }
    const titles = pending.titles;
    const top = titles[0].y;
    const bottom = (pending.giver ?? titles[titles.length - 1]);
    const yEnd = bottom.y + bottom.h;
    // The amount belongs to whichever row's vertical span contains its centre. Matching
    // by span rather than by nearest-line is what keeps a two-line title from stealing
    // the neighbour's number.
    // 🔑 The first right-column line in the band is NOT necessarily the money: a row can
    // carry an amount AND an expiry timer stacked under it, and some rows carry ONLY a
    // timer. So take the first that actually parses as money and let the rest fall away.
    let parsed: ReturnType<typeof parseAmount> = null;
    for (const l of sorted) {
      if (l.x <= amountX) continue;
      const c = l.y + l.h / 2;
      if (c < top - l.h || c > yEnd + l.h) continue;
      const p = parseAmount(l.text);
      if (p) { parsed = p; break; }
    }
    rows.push({
      category,
      title: titles.map((t) => t.text.trim()).join(" ").replace(/\s+/g, " "),
      giver: pending.giver ? pending.giver.text.trim() : null,
      amount: parsed ? parsed.amount : null,
      kind: parsed ? parsed.kind : null,
      rounded: parsed ? parsed.rounded : false,
      y: Math.round((top + yEnd) / 2),
    });
    pending = null;
  };

  for (const l of sorted) {
    if (l.x > amountX) continue; // right column: counts and amounts, handled per row
    const text = l.text.trim();
    if (!text) continue;

    if (l.h > titleMaxH) {
      // Category header — closes whatever row was open and renames the group. A line
      // that cleans to nothing was pure icon noise ("e,", "u") and must not become a
      // category, or every row after it is filed under a symbol.
      const name = cleanCategory(text);
      if (name) {
        flush();
        category = name;
      }
      continue;
    }
    if (l.h <= giverMaxH) {
      // Giver line. It terminates the row: the next title line starts a new one.
      if (pending) {
        pending.giver = l;
        flush();
      }
      continue;
    }
    // Title line. Two lines can belong to one title and the game never uses three, so a
    // third consecutive title line must be the next contract.
    //
    // 🔑 The GAP decides, not just the count. A row whose giver line the OCR missed
    // entirely (real case: "VERY HUNGRY" / WIKELO, where WIKELO never came back) has
    // nothing to close it, and without this the next contract's title would be glued on
    // as a second line. Wrapped lines sit ~22px apart; the next contract is ~75-100px
    // down, so 2.2x the line height separates them cleanly.
    if (pending && pending.titles.length) {
      const prev = pending.titles[pending.titles.length - 1];
      if (l.y - prev.y > prev.h * 2.2) flush();
    }
    if (pending && pending.titles.length >= 2) flush();
    if (!pending) pending = { titles: [], giver: null };
    pending.titles.push(l);
  }
  flush();
  return rows;
}

/** The vocabulary-driven parse. See parseContractList's header for why this exists. */
function parseWithVocab(ocr: OcrResult, region: PanelRect | undefined, vocab: ContractVocab, carried?: string | null): ContractRow[] {
  const inRegion = region
    ? ocr.lines.filter(
        (l) =>
          l.x + l.w > region.x && l.x < region.x + region.w &&
          l.y + l.h > region.y && l.y < region.y + region.h,
      )
    : ocr.lines;
  const lines = inRegion.filter((l) => l.text.trim()).sort((a, b) => a.y - b.y);
  if (!lines.length) return [];

  const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cats = vocab.categories.map((c) => ({ raw: c, key: squash(c) })).filter((c) => c.key);
  const givers = vocab.givers.map((g) => ({ raw: g, key: squash(g) })).filter((g) => g.key);

  /** Names come back with a character or two wrong at this size ("RAYARIINCORPORATED" is
   *  clean, but "UNG FAMILY HAULING" was not), so matching allows a small slip that scales
   *  with length — and requires a near-complete overlap, not a substring, so "HAULING"
   *  cannot claim "LING FAMILY HAULING". */
  const closest = (key: string, pool: { raw: string; key: string }[]): string | null => {
    if (!key) return null;
    let best: string | null = null;
    let bestD = Infinity;
    for (const p of pool) {
      if (Math.abs(p.key.length - key.length) > 3) continue;
      let d = 0;
      const n = Math.max(p.key.length, key.length);
      for (let i = 0; i < n; i++) if (p.key[i] !== key[i]) d++;
      // Positional mismatch is a cheap upper bound on edit distance and is enough here,
      // because these are the same string with a character misread rather than shifted.
      if (d < bestD) { bestD = d; best = p.raw; }
    }
    const tol = Math.max(1, Math.floor(key.length / 8));
    return bestD <= tol ? best : null;
  };

  // 🔴 DROP THE PANEL'S OWN CHROME ABOVE THE FIRST CATEGORY. Both real captures carry a
  // detection wedged at the very top of the calibrated region — "1:USERLOG ATFU OIBM" (h=11)
  // in the 2026-08-11 fixture, and in Sub's 2026-08-12 sweep the same thing read four
  // different ways ("1:USEN LOO", "1:USFR LOO", "I:USER LOO", "T:USEN LOG", h=9). It fuses
  // onto the first title of whichever category is expanded — "1:USFR LOO NEED A HITTER" —
  // and kills the match. Five rows lost in one sweep.
  //
  // ⚠️ NOT a height floor, which is the obvious fix and is WRONG. It was tried: this
  // fixture's Rayari giver is 12px against the artifact's 11px, one pixel apart, so any
  // threshold that removes the chrome also removes a real giver. That is the same wall the
  // header of this file already describes — height bands worked for Windows OCR and collapsed
  // on RapidOCR — and it is worth restating that the trap catches you again from a new angle.
  //
  // The invariant that DOES hold is structural: the board is a list of categories, so nothing
  // real precedes the first category header. Anchoring on the vocabulary is the same move the
  // rest of this parser already makes.
  //
  // 🔑 Only when a header is actually visible. Scrolled deep into one long category there may
  // be none in frame, and "drop everything above the first category" would then drop the
  // entire board — trading five lost rows for all of them.
  const firstCategoryY = lines.reduce<number | null>((acc, l) => {
    if (acc !== null) return acc;
    return closest(squash(stripCount(l.text)), cats) ? l.y : null;
  }, null);
  const body = firstCategoryY === null ? lines : lines.filter((l) => l.y + l.h / 2 >= firstCategoryY);

  const rows: ContractRow[] = [];
  // 🔑 Seeded from the PREVIOUS capture. Scrolling a long category takes its HEADER off
  // the top of the panel long before its contracts run out, so within one capture the
  // rows below have no header above them — and the category is still true until a
  // different one appears.
  let category: string | null = carried ?? null;
  let titles: string[] = [];
  let giver: string | null = null;
  let money: ReturnType<typeof parseAmount> = null;
  let top = 0;
  let bottom = 0;

  const flush = () => {
    if (titles.length) {
      rows.push({
        category,
        title: titles.join(" ").replace(/\s+/g, " ").trim(),
        giver,
        amount: money ? money.amount : null,
        kind: money ? money.kind : null,
        rounded: money ? money.rounded : false,
        y: Math.round((top + bottom) / 2),
      });
    }
    titles = [];
    giver = null;
    money = null;
  };

  // 🔑 THE AMOUNT COLUMN, BY POSITION. Sub, watching it glue prices onto titles: "there is
  // a limit to how wide the text for the mission can go, and a limit to how wide the
  // payout can go, and they'll never overlap." Exactly right, and it is the half the
  // vocabulary can't supply — PP-OCR sometimes fuses the price into the title line
  // ("YANG'S PLACE FROM OUTLAWS 63k") and sometimes leaves it as its own detection off to
  // the right ("27k" at x=561). The fused case was handled; the standalone case was being
  // appended as more title text, which is why almost nothing matched.
  //
  // Measured on the live 654-wide panel: titles start at x 39-101, amounts at 545-562.
  // Half the panel width separates them with enormous margin, and it is a FRACTION so the
  // perspective drift and any resolution change ride along.
  const panelX = region ? region.x : Math.min(...lines.map((l) => l.x));
  const panelW = region ? region.w : Math.max(...lines.map((l) => l.x + l.w)) - panelX;
  const amountColX = panelX + panelW * 0.5;

  for (const l of body) {
    const text = l.text.trim();

    // Right-hand column: a price, or a category's row count. Never words.
    if (l.x >= amountColX) {
      const m = parseAmount(text);
      if (m) money = m;
      continue;
    }

    // A category header may carry a count; a contract row may carry its price. Both are
    // fused onto the end of the line by PP-OCR, so both are peeled off before matching.
    const cat = closest(squash(stripCount(text)), cats);
    if (cat) {
      flush();
      category = cat.toUpperCase();
      continue;
    }
    const split = splitTrailingAmount(text);
    const gv = closest(squash(split.head), givers);
    if (gv) {
      // The giver is the last line of a row; it closes it.
      giver = gv;
      bottom = l.y + l.h;
      flush();
      continue;
    }
    // Anything else is title text — once the countdown is taken off it.
    const head = stripTrailingDuration(split.head);
    // A line that was ONLY a countdown ("27m 29s" on its own) is not title text and must
    // not be appended, or the row can never match the dataset.
    if (!head) {
      if (split.money) money = split.money;
      continue;
    }
    // 🔴 DO NOT DROP ROWS FOR HAVING NO CATEGORY. This used to be `if (!category) continue`,
    // to keep the panel's chrome ("1:USERLOG ATFU OIBM") out — and it silently broke the
    // moment Sub scrolled: the MERCENARY header leaves the top of the panel, every row
    // below it has no header above it in that capture, and the whole rest of the list was
    // discarded. It presented as "after the first eight or so missions it just stops
    // reading". The chrome is excluded further down instead, by requiring a row to have a
    // giver or a price — which the chrome has neither of.
    if (!titles.length) top = l.y;
    titles.push(head);
    bottom = l.y + l.h;
    if (split.money) money = split.money;
  }
  flush();
  // A contract row always has a KNOWN giver or a price. The panel's chrome has neither,
  // which is what keeps it out now that a missing category header no longer does.
  lastVocabCategory = category;
  return rows.filter((r) => r.title.length > 3 && (r.giver !== null || r.amount !== null));
}

/** The category the last vocabulary parse ended on.
 *
 *  🔑 Scrolling a long category takes its HEADER off the top of the panel long before its
 *  contracts run out — Sub, scrolling 25 Mercenary contracts: "Mercenary goes away and it
 *  seems like the app can then no longer determine where the mission belongs." So the
 *  header is remembered between captures and only replaced when a different one appears.
 *  Exported rather than held inside the parser so a caller reading two different panels
 *  could keep them apart if that ever becomes a thing. */
export let lastVocabCategory: string | null = null;
export function resetVocabCategory(): void {
  lastVocabCategory = null;
}
