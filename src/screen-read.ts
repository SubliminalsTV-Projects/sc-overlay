// Screen OCR reader — pulls structured meaning out of a Star Citizen screenshot.
//
// Two jobs, both driven by Windows' built-in OCR (Windows.Media.Ocr — no bundled
// model, no npm dep, matches this repo's zero-runtime-dep rule):
//   1. Fabricator kiosk  -> which item is on screen (+ where its render is), so the
//      app can crop + upload a real in-game image for the blueprint catalog.
//   2. Tracked-mission marker -> the mission title the player has PINNED in-game,
//      which the game.log cannot tell us (it sees every accepted mission equally).
//
// The layout is located by ANCHOR TEXT + relative geometry, never fixed pixels, so it
// survives 16:9 / 21:9 / UI-scale differences between players. If OCR yields nothing
// usable the caller falls back to the existing log-based behaviour.

import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface OcrLine { text: string; x: number; y: number; w: number; h: number; }
export interface OcrResult { w: number; h: number; lines: OcrLine[]; }

export interface Rect { x: number; y: number; w: number; h: number; }

export interface FabricatorRead {
  kind: "fabricator";
  nameRaw: string;          // OCR'd item name, e.g. `FRESNEL "ICEBOX" ENERGY LMG`
  name: string | null;      // resolved catalog name, if matched
  item: string | null;      // resolved catalog item UUID, if matched
  match: "exact" | "fuzzy" | "none";
  crop: Rect;               // render region to capture, in screenshot pixels
}
export interface MissionRead { kind: "mission"; titleRaw: string; }
/** One active refinery job read off the Refinement Center's PROCESSING panel. */
export interface RefineryJobRead {
  order: number;            // work-order slot (1,2,3… left-to-right) — the STABLE identity
  remainingSec: number;     // parsed from "TIME REMAINING 41m 35s"
  remainingRaw: string;     // "41m 35s"
  material: string | null;  // yielded material label (a multi-material order shows its top yield)
  yieldScu: number | null;  // yield in cSCU, e.g. 898.65
}
export interface RefineryRead {
  kind: "refinery";
  station: string | null;   // "LEVSKI"
  jobs: RefineryJobRead[];   // the PROCESSING order(s) currently on screen
}
/** A scanned mineable's signature number (exact-lookup happens in the tracker). */
export interface MineableRead { kind: "mineable"; signature: number; raw: string; }
export interface NoneRead { kind: "none"; }
export type ScreenRead = FabricatorRead | MissionRead | RefineryRead | MineableRead | NoneRead;

/** Refined/ore material names the refinery yields — the vocabulary for reading a job's
 *  material label, so a mis-OCR'd column header can't be mistaken for it. */
const REFINERY_MATERIALS = new Set([
  "IRON", "ALUMINUM", "ALUMINIUM", "TITANIUM", "TUNGSTEN", "QUANTAINIUM", "GOLD", "CORUNDUM", "COPPER", "TIN",
  "QUARTZ", "HEPHAESTANITE", "LARANITE", "AGRICIUM", "BORASE", "BEXALITE", "TARANITE", "ASLARITE", "BERYL",
  "DIAMOND", "SILICON", "STILERON", "SAVRILIUM", "OURATITE", "RICCITE", "LINDINIUM", "TORITE", "ICE",
]);

/** Pull the scan signature number out of a HUD line. The value is comma-grouped thousands
 *  ("2,000" / "3,170" / "25,800") preceded by a diamond/pin icon the OCR renders as stray
 *  junk (a lone digit, dots) SEPARATED from the number — so anchoring on the comma group
 *  isolates the real value. Normalizes the usual o->0 / l->1 OCR slips. Returns null when
 *  no grouped number is present (e.g. the comma dropped — a later poll re-reads it). */
export function parseSignature(text: string): number | null {
  const t = text.replace(/[oO]/g, "0").replace(/[lI|]/g, "1");
  const g = /(\d{1,2})[.,](\d{3})(?!\d)/.exec(t); // "3,170" / "25,800"
  if (g) {
    const v = Number(g[1] + g[2]);
    return v >= 1000 && v <= 30000 ? v : null;
  }
  // Fallback: OCR dropped the comma ("2 2000"). Take a lone 4–5 digit run, word-boundaried
  // so the separated icon-junk digit isn't glued on. Capped at 30000 (max signature 25800
  // + margin) so an icon-merged "33170" is rejected rather than mis-read.
  const runs = t.match(/(?<!\d)\d{4,5}(?!\d)/g);
  if (runs && runs.length) {
    const v = Number(runs[runs.length - 1]);
    return v >= 1000 && v <= 30000 ? v : null;
  }
  return null;
}

/** Parse an SC duration string ("41m 35s", "14h 53m", "1 h 5 m") to seconds, or null.
 *  Normalizes the digit/letter OCR slips FIRST — the hours digit right before "h" is
 *  routinely mangled into a look-alike letter (11h->"Ilh", 9h->"gh", 8h->"Bh"). Only h/m/s
 *  are valid letters in a duration, so mapping the rest back to their digit is safe.
 *  (S is left alone — it's the seconds unit; a "5h" mis-OCR is rare and would collide.) */
export function parseDuration(text: string): number | null {
  const t = text
    .replace(/[Il|]/g, "1").replace(/[ODo]/g, "0").replace(/[Zz]/g, "2")
    .replace(/[gq]/g, "9").replace(/B/g, "8");
  const h = /(\d+)\s*h/i.exec(t)?.[1];
  const m = /(\d+)\s*m(?![a-z])/i.exec(t)?.[1];
  const s = /(\d+)\s*s(?![a-z])/i.exec(t)?.[1];
  if (h == null && m == null && s == null) return null;
  return (Number(h ?? 0) * 3600) + (Number(m ?? 0) * 60) + Number(s ?? 0);
}

// ---- Windows OCR bridge (WinRT via PowerShell) --------------------------------

const BACKTICK = String.fromCharCode(96);
const OCR_PS1 = [
  `param([string]$Path)`,
  `Add-Type -AssemblyName System.Runtime.WindowsRuntime`,
  `$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${BACKTICK}1' } | Select-Object -First 1`,
  `function Await($op,$t){ $m=$asTask.MakeGenericMethod($t); $tk=$m.Invoke($null,@($op)); $tk.Wait(); $tk.Result }`,
  `[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null`,
  `[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null`,
  `[Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null`,
  `$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])`,
  `$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])`,
  `$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])`,
  `$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])`,
  `$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()`,
  `if (-not $engine) { '{"w":0,"h":0,"lines":[]}'; exit }`,
  `$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])`,
  `$lines = foreach($ln in $result.Lines){`,
  `  $xs=@();$ys=@();$xe=@();$ye=@()`,
  `  foreach($w in $ln.Words){ $b=$w.BoundingRect; $xs+=[double]$b.X; $ys+=[double]$b.Y; $xe+=[double]($b.X+$b.Width); $ye+=[double]($b.Y+$b.Height) }`,
  `  $x0=($xs|Measure-Object -Minimum).Minimum; $y0=($ys|Measure-Object -Minimum).Minimum`,
  `  $x1=($xe|Measure-Object -Maximum).Maximum; $y1=($ye|Measure-Object -Maximum).Maximum`,
  `  [pscustomobject]@{ text=$ln.Text; x=[int]$x0; y=[int]$y0; w=[int]($x1-$x0); h=[int]($y1-$y0) }`,
  `}`,
  `@{ w=[int]$decoder.PixelWidth; h=[int]$decoder.PixelHeight; lines=$lines } | ConvertTo-Json -Depth 5 -Compress`,
].join("\n");

let ps1Path: string | null = null;
function ocrScriptPath(): string {
  if (!ps1Path) {
    ps1Path = join(tmpdir(), "sc-tracker-ocr.ps1");
    writeFileSync(ps1Path, OCR_PS1, "utf8");
  }
  return ps1Path;
}

/** Run Windows OCR over an image file, returning lines with bounding boxes. */
export function ocrImage(imagePath: string): Promise<OcrResult> {
  // WinRT StorageFile.GetFileFromPathAsync needs an absolute, backslash-separated path.
  const winPath = resolve(imagePath).replace(/\//g, "\\");
  return new Promise((done) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ocrScriptPath(), "-Path", winPath],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) { done({ w: 0, h: 0, lines: [] }); return; }
        try {
          // ConvertTo-Json can leave a raw control char inside a string (an OCR'd glyph
          // decoded to one) which strict JSON.parse rejects — scrub 0x00-0x1F first.
          const cleaned = stdout.replace(new RegExp("[\u0000-\u001F]", "g"), " ");
          const start = cleaned.indexOf("{");
          const parsed = start >= 0 ? (JSON.parse(cleaned.slice(start)) as OcrResult) : null;
          done(parsed && Array.isArray(parsed.lines) ? parsed : { w: 0, h: 0, lines: [] });
        } catch { done({ w: 0, h: 0, lines: [] }); }
      },
    );
  });
}

// ---- Name resolution ----------------------------------------------------------

// OCR renders roman numerals (III / IV / VI) with I↔l↔| swaps, e.g. "III" -> "Ill".
// Within a short, all-roman-confusable token, map those back to I so the numeral matches.
// Excludes the digit 1 (keeps "11-Series", "S1" intact) and single letters ("I"/"V"/"L").
function romanNorm(t: string): string {
  if (t.length < 2 || !/^[ILV|X]+$/.test(t)) return t;
  const m = t.replace(/[L|]/g, "I");
  return /^(?:I{2,3}|IV|VI{0,3}|IX)$/.test(m) ? m : t;
}

export function normName(s: string): string {
  return s
    .toUpperCase()
    .replace(/[→*]/g, " ")            // arrow artifacts
    .replace(/[“”•'`.,\-()"]/g, " ") // quotes + punctuation
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(romanNorm)
    .join(" ");
}

export interface CatalogEntry { name: string; item: string; }

/** Load the name->UUID index from the bundled/seeded blueprints.latest.json. */
export function loadCatalog(dataDir: string): CatalogEntry[] {
  const p = join(dataDir, "blueprints.latest.json");
  if (!existsSync(p)) return [];
  const ds = JSON.parse(readFileSync(p, "utf8")) as { index?: CatalogEntry[] };
  return ds.index ?? [];
}

// Character-bigram Dice coefficient — tolerant of OCR letter glitches inside a token
// (e.g. "(S2)" misread as "62)"), unlike whole-word overlap.
function bigrams(s: string): Map<string, number> {
  const t = s.replace(/ /g, "");
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    m.set(b, (m.get(b) || 0) + 1);
  }
  return m;
}
function dice(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0, total = 0;
  for (const v of a.values()) total += v;
  for (const [k, v] of b) {
    total += v;
    if (a.has(k)) inter += Math.min(v, a.get(k)!);
  }
  return total ? (2 * inter) / total : 0;
}

// OCR look-alikes for the size digit in a variant tag (a vertical-stroke "1" reads as
// "I"/"l"/"|"; a "0" as "O"; a "2" as "Z"). Used ONLY to break a size-variant near-tie the
// literal digits couldn't (e.g. "S1" misread "SI"), and only from short size-tag tokens.
const DIGIT_LOOKALIKE: Record<string, string> = { I: "1", L: "1", "|": "1", O: "0", Z: "2" };

/** Pick the winner from scored candidates (sorted desc). A clear top wins; a near-tie is
 *  disambiguated by the size digit (variants S1/S2/S3): first the digits the OCR literally
 *  saw, then — only if none settled it — OCR letter->digit look-alikes read from short
 *  size-tag tokens. An ambiguous read returns null; never guess between equal candidates. */
function pickBest(
  scored: { e: CatalogEntry; s: number }[],
  minScore: number,
  n: string,
): CatalogEntry | null {
  const top = scored[0];
  if (!top || top.s < minScore) return null;
  const near = scored.filter((x) => top.s - x.s < 0.04);
  if (near.length === 1) return top.e;
  const digitsOf = (name: string) => normName(name).match(/\d/g) || [];
  const winnow = (allowed: Set<string>) =>
    near.filter((x) => {
      const d = digitsOf(x.e.name);
      return d.length > 0 && d.every((dd) => allowed.has(dd));
    });
  // Tier 1 — the digits the OCR literally saw. A literal hit (or literal ambiguity) is final.
  const literal = new Set(n.match(/\d/g) || []);
  let picks = winnow(literal);
  if (picks.length) return picks.length === 1 ? picks[0].e : null;
  // Tier 2 — no literal digit settled it; fold in look-alikes, but harvest them only from
  // short (<=4 char) size-tag tokens so an "I"/"L" inside a word (LASER, MINING) can't
  // inject a phantom "1" and hijack a genuinely digit-less read.
  const fuzzy = new Set(literal);
  for (const tok of n.split(" "))
    if (tok.length <= 4)
      for (const ch of tok) if (DIGIT_LOOKALIKE[ch]) fuzzy.add(DIGIT_LOOKALIKE[ch]);
  picks = winnow(fuzzy);
  return picks.length === 1 ? picks[0].e : null;
}

/** Resolve an OCR'd name to a catalog item: exact-normalized, then whole-word overlap,
 *  then a character-bigram fallback for glitched tags — both tie-safe (an ambiguous read
 *  returns none, never a guess) and variant-aware (picks S1/S2/S3 by the OCR's digits). */
export function resolveName(
  raw: string,
  catalog: CatalogEntry[],
): { name: string | null; item: string | null; match: "exact" | "fuzzy" | "none" } {
  const n = normName(raw);
  if (!n) return { name: null, item: null, match: "none" };
  // OCR routinely confuses 0<->O (a size-0 "S0 Helix" reads as "SO HELIX"). Fold them together
  // for the exact pass only, so it still matches — the fuzzy/size-digit logic below is untouched.
  const fold = (s: string) => s.replace(/0/g, "O");
  const nf = fold(n);
  for (const e of catalog) {
    const en = normName(e.name);
    if (en === n || fold(en) === nf) return { name: e.name, item: e.item, match: "exact" };
  }

  const nt = new Set(n.split(" "));
  const jaccard = catalog
    .map((e) => {
      const kt = new Set(normName(e.name).split(" "));
      const inter = [...nt].filter((t) => kt.has(t)).length;
      const uni = new Set([...nt, ...kt]).size;
      return { e, s: uni ? inter / uni : 0 };
    })
    .sort((a, b) => b.s - a.s);
  let w = pickBest(jaccard, 0.6, n);
  if (w) return { name: w.name, item: w.item, match: "fuzzy" };

  // Character-bigram fallback for OCR glitches in short tags (e.g. "(S2)" -> "62)").
  const nb = bigrams(n);
  const diceScored = catalog
    .map((e) => ({ e, s: dice(nb, bigrams(normName(e.name))) }))
    .sort((a, b) => b.s - a.s);
  w = pickBest(diceScored, 0.7, n);
  return w ? { name: w.name, item: w.item, match: "fuzzy" } : { name: null, item: null, match: "none" };
}

// ---- Layout extraction --------------------------------------------------------

// OCR isn't character-perfect: the wide-tracked kiosk font drops or mangles a glyph, or splits
// a word ("FABRICATION" -> "FABRICA TION", "Tier" -> "Tie@"), especially at 4K / high UI-scale.
// So the STRUCTURAL anchors that decide "is this a kiosk / where's the item" are matched FUZZILY
// (a couple of edits of slack) rather than exactly — the same closest-match idea the item NAME
// resolver already uses. Without it a single bad glyph makes the whole screen go unrecognized and
// nothing scans, with no signal to the user.

/** Levenshtein distance of the best-matching substring of `hay` against `needle` (Sellers'
 *  approximate substring search — `needle` may align anywhere in `hay`). */
function fuzzySubstringDistance(hay: string, needle: string): number {
  const n = needle.length;
  if (!n) return 0;
  let prev = new Array<number>(hay.length + 1).fill(0); // empty needle matches at any offset (cost 0)
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(hay.length + 1);
    cur[0] = i;
    for (let j = 1; j <= hay.length; j++) {
      const cost = needle[i - 1] === hay[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
    }
    prev = cur;
  }
  return Math.min(...prev);
}
/** Reduce to comparable letters+digits only (an OCR glyph that became a space/'@'/'//' drops out). */
const anchorNorm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
/** Does `text` contain `needle` (already anchor-normalized) within `maxErr` edits? */
function fuzzyHas(text: string, needle: string, maxErr: number): boolean {
  return fuzzySubstringDistance(anchorNorm(text), needle) <= maxErr;
}

const FAB_ANCHOR_NORM = "FABRICATIONKIOSK";
const CATEGORY_LINE = /^\s*(Armor|Weapons|Vehicles|Clothing|Utility|Ammo|Sustenance|Container|Other)\b/i;
/** The "Tier" label beside the category — short, so bound the fragment length and allow one
 *  edit ("Tie@"/"Tler" -> Tier) without letting a long word-filled line fuzzy-match it. */
const tierish = (t: string) => { const a = anchorNorm(t); return a.length <= 6 && fuzzySubstringDistance(a, "TIER") <= 1; };

/** Turn an OCR result into a structured read: fabricator item, tracked mission, or nothing. */
export function classifyScreen(ocr: OcrResult, catalog: CatalogEntry[]): ScreenRead {
  const lines = ocr.lines;
  if (!lines.length) return { kind: "none" };
  const joined = lines.map((l) => l.text).join(" ");

  if (fuzzyHas(joined, FAB_ANCHOR_NORM, 2)) {
    // The item name is the line(s) directly above the "<Category> ... Tier" line,
    // sharing its left edge. The render sits above the name, in the kiosk's right half.
    // "· Tier" can be OCR-split onto a separate fragment at the same row (a wide "·" gap),
    // so accept "Tier" on the category line itself OR on any fragment sharing its y.
    const cat = lines.find(
      (l) =>
        CATEGORY_LINE.test(l.text) &&
        (tierish(l.text) ||
          lines.some((o) => o !== l && Math.abs(o.y - l.y) < 20 && tierish(o.text))),
    );
    const title = lines.find((l) => fuzzyHas(l.text, FAB_ANCHOR_NORM, 3));
    const close = lines.find((l) => /(?:^|\s)close$/i.test(l.text));
    const top = title ? title.y + 50 : Math.round(ocr.h * 0.1);
    if (cat) {
      const nameLines = lines
        .filter((l) => Math.abs(l.x - cat.x) < 60 && cat.y - l.y > 0 && cat.y - l.y < 130)
        .sort((a, b) => a.y - b.y);
      if (nameLines.length) {
        const nameRaw = nameLines.map((l) => l.text).join(" ");
        const { name, item, match } = resolveName(nameRaw, catalog);
        const nameTop = Math.min(...nameLines.map((l) => l.y));
        const left = cat.x - 40;
        const right = close ? close.x + close.w : cat.x + 800;
        const crop: Rect = { x: Math.max(0, left), y: Math.max(0, top), w: Math.max(0, right - left), h: Math.max(0, nameTop - 15 - top) };
        return { kind: "fabricator", nameRaw, name, item, match, crop };
      }
    }
    // The anchor says we're at a kiosk, but the item name couldn't be isolated (a mangled
    // category/Tier line, or the name still fading in). Return a fabricator read with no item
    // so the capture loop can tell the user "couldn't read this item" instead of silently
    // sitting on "Watching Star Citizen…". Crop is a best-effort right-half box (unused when
    // item is null, but keeps the shape honest).
    const rt = close ? close.x + close.w : Math.round(ocr.w * 0.92);
    const lf = Math.round(ocr.w * 0.58);
    const crop: Rect = { x: lf, y: Math.max(0, top), w: Math.max(0, rt - lf), h: Math.round(ocr.h * 0.5) };
    return { kind: "fabricator", nameRaw: "", name: null, item: null, match: "none", crop };
  }

  // Refinement Center: read each active PROCESSING order's "TIME REMAINING" countdown so
  // the tracker can alarm when a refine finishes. Only "TIME REMAINING" counts (a running
  // job) — a SETUP order's "PROCESSING TIME" is an estimate, not a countdown, so it's
  // excluded. Station is the header line left of the title; material/yield are best-effort
  // labels from the same panel column.
  if (/refinement\s+cent(?:er|re)/i.test(joined)) {
    const anchor = lines.find((l) => /refinement\s+cent(?:er|re)/i.test(l.text));
    const station = anchor
      ? lines.filter((l) => Math.abs(l.y - anchor.y) < 26 && l.x < anchor.x - 80).sort((a, b) => a.x - b.x).pop()?.text.trim() ?? null
      : null;
    const matchMaterial = (t: string) =>
      t.trim().toUpperCase().split(/[^A-Z]+/).find((w) => REFINERY_MATERIALS.has(w)) ?? null;
    const raw: (RefineryJobRead & { _x: number })[] = [];
    for (const tr of lines.filter((l) => /time\s+remaining/i.test(l.text))) {
      // The value is the leftmost same-row line to the right that actually PARSES as a
      // duration (skips the other panel's "TIME REMAINING" label + noise), kept within
      // this panel's width so a second job's timer can't be grabbed.
      const valLine = lines
        .filter((l) => Math.abs(l.y - tr.y) < 24 && l.x > tr.x && l.x - tr.x < 560 && parseDuration(l.text) != null)
        .sort((a, b) => a.x - b.x)[0];
      const sec = valLine ? parseDuration(valLine.text) : null;
      if (sec == null || sec <= 0) continue;
      // Material = the topmost YIELDED material in this panel (its primary product), matched
      // by word so "PRESSURIZED ICE" -> Ice; a fixed vocabulary keeps a garbled column
      // header ("QUALITY"->"OUAUTY") from winning.
      const matWord = lines
        .filter((l) => Math.abs(l.x - tr.x) < 380 && l.y < tr.y && matchMaterial(l.text))
        .sort((a, b) => a.y - b.y)
        .map((l) => matchMaterial(l.text))[0];
      const material = matWord ? matWord.charAt(0) + matWord.slice(1).toLowerCase() : null;
      const yl = lines.find(
        (l) => /^\d{1,4}\.\d+$/.test(l.text.trim()) && Math.abs(l.x - tr.x) < 420 && l.y < tr.y && l.y > tr.y - 150,
      );
      raw.push({ order: 0, remainingSec: sec, remainingRaw: valLine!.text.trim(), material, yieldScu: yl ? Number(yl.text) : null, _x: tr.x });
    }
    // Number the jobs by left-to-right panel position (Work Order 1, 2, …) — a stable
    // identity per station, so a multi-material order's varying label can't split it into
    // duplicates. All active orders show side-by-side, so position == work-order slot.
    raw.sort((a, b) => a._x - b._x).forEach((j, i) => (j.order = i + 1));
    const jobs: RefineryJobRead[] = raw.map(({ _x, ...j }) => j);
    if (jobs.length) return { kind: "refinery", station: station ?? null, jobs };
  }

  // Mining scanner: a scanned mineable/debris shows a signature number floating just above
  // screen-center (diamond/pin icon + comma-grouped value). No text labels it, so it's found
  // positionally — a signature-shaped number in the central-upper band — and only while the
  // scan HUD is up (guards against a stray centered number on some other screen). The tracker
  // maps it to a rock; a value not in the table is salvage debris.
  if (/scanning|ready to scan|\bstrong\b|\bmoderate\b|\bweak\b/i.test(joined)) {
    const cx = ocr.w / 2, cy = ocr.h / 2;
    const cands = lines
      .filter((l) => l.y > cy - 0.24 * ocr.h && l.y < cy - 0.015 * ocr.h && Math.abs(l.x - cx) < 0.17 * ocr.w)
      .map((l) => ({ l, sig: parseSignature(l.text) }))
      .filter((c): c is { l: OcrLine; sig: number } => c.sig != null);
    if (cands.length) {
      cands.sort((a, b) => Math.abs(a.l.x - cx) - Math.abs(b.l.x - cx));
      return { kind: "mineable", signature: cands[0].sig, raw: cands[0].l.text.trim() };
    }
  }

  // Tracked-mission read: an OBJECTIVE line anchors the panel; the mission TITLE is the
  // ALL-CAPS line(s) directly above it at the same left edge. SC objectives use many
  // phrasings ("Go to …", "Mine … 5/6", "Scan …", a progress counter), not just "Go to" —
  // the old "Go to"-only anchor silently failed on mining/scan/most missions. The title is
  // rendered in caps while objectives are sentence-case, which cleanly separates them (and
  // lets a verb-containing title like "ORE SCAN NEEDED" still be found). Section headers
  // ("PRIMARY OBJECTIVES") are excluded so they can't be mistaken for the title.
  const HEADER = /^\s*(primary|secondary|optional|bonus|side)?\s*objectives?\s*$/i;
  const OBJECTIVE =
    /\bgo to\b|\b\d+\s*\/\s*\d+\b|\b(mine|scan|extract|collect|retrieve|deliver|reach|travel|destroy|eliminate|defeat|investigate|defend|clear|hack|acquire|locate|escort|salvage|transport|kill|steal|recover|analyze|repair|refuel|hold|capture|activate|place|plant|download|upload|board|neutralize|assist|rescue)\b/i;
  const isUpper = (t: string) => {
    const L = t.replace(/[^A-Za-z]/g, "");
    return L.length >= 4 && L === L.toUpperCase();
  };
  // Topmost objective = the actively-tracked mission (SC lists it first). Objectives are
  // sentence-case, so exclude ALL-CAPS lines (those are titles/HUD headers).
  const obj = lines
    .filter((l) => OBJECTIVE.test(l.text) && !HEADER.test(l.text) && !isUpper(l.text))
    .sort((a, b) => a.y - b.y)[0];
  if (obj) {
    const titleLines = lines
      .filter(
        (l) =>
          isUpper(l.text) && !HEADER.test(l.text) && Math.abs(l.x - obj.x) < 150 && obj.y - l.y > 0 && obj.y - l.y < 95,
      )
      .sort((a, b) => a.y - b.y);
    if (titleLines.length) return { kind: "mission", titleRaw: titleLines.map((l) => l.text).join(" ") };
  }

  return { kind: "none" };
}

/** Convenience: OCR an image file and classify it in one call. */
export async function readScreenshot(imagePath: string, catalog: CatalogEntry[]): Promise<ScreenRead> {
  return classifyScreen(await ocrImage(imagePath), catalog);
}
