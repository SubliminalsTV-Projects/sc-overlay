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
export interface NoneRead { kind: "none"; }
export type ScreenRead = FabricatorRead | MissionRead | NoneRead;

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

export function normName(s: string): string {
  return s
    .toUpperCase()
    .replace(/[→*]/g, " ")            // arrow artifacts
    .replace(/[“”•'`.,\-()"]/g, " ") // quotes + punctuation
    .replace(/\s+/g, " ")
    .trim();
}

export interface CatalogEntry { name: string; item: string; }

/** Load the name->UUID index from the bundled/seeded blueprints.latest.json. */
export function loadCatalog(dataDir: string): CatalogEntry[] {
  const p = join(dataDir, "blueprints.latest.json");
  if (!existsSync(p)) return [];
  const ds = JSON.parse(readFileSync(p, "utf8")) as { index?: CatalogEntry[] };
  return ds.index ?? [];
}

/** Resolve an OCR'd name to a catalog item: exact-normalized first, then a
 *  Jaccard token-overlap fallback (guards against an OCR letter glitch). */
export function resolveName(
  raw: string,
  catalog: CatalogEntry[],
): { name: string | null; item: string | null; match: "exact" | "fuzzy" | "none" } {
  const n = normName(raw);
  if (!n) return { name: null, item: null, match: "none" };
  for (const e of catalog) if (normName(e.name) === n) return { name: e.name, item: e.item, match: "exact" };
  const nt = new Set(n.split(" "));
  let best: CatalogEntry | null = null, bestScore = 0;
  for (const e of catalog) {
    const kt = new Set(normName(e.name).split(" "));
    const inter = [...nt].filter((t) => kt.has(t)).length;
    const uni = new Set([...nt, ...kt]).size;
    const score = uni ? inter / uni : 0;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 0.6 && best
    ? { name: best.name, item: best.item, match: "fuzzy" }
    : { name: null, item: null, match: "none" };
}

// ---- Layout extraction --------------------------------------------------------

const FAB_ANCHOR = /FABRICATION KIOSK/i;
const CATEGORY_LINE = /^\s*(Armor|Weapons|Vehicles|Clothing|Utility|Ammo|Sustenance|Container|Other)\b/i;

/** Turn an OCR result into a structured read: fabricator item, tracked mission, or nothing. */
export function classifyScreen(ocr: OcrResult, catalog: CatalogEntry[]): ScreenRead {
  const lines = ocr.lines;
  if (!lines.length) return { kind: "none" };
  const joined = lines.map((l) => l.text).join(" ");

  if (FAB_ANCHOR.test(joined)) {
    // The item name is the line(s) directly above the "<Category> ... Tier" line,
    // sharing its left edge. The render sits above the name, in the kiosk's right half.
    // "· Tier" can be OCR-split onto a separate fragment at the same row (a wide "·" gap),
    // so accept "Tier" on the category line itself OR on any fragment sharing its y.
    const cat = lines.find(
      (l) =>
        CATEGORY_LINE.test(l.text) &&
        (/Tier/i.test(l.text) ||
          lines.some((o) => o !== l && Math.abs(o.y - l.y) < 20 && /Tier/i.test(o.text))),
    );
    if (cat) {
      const nameLines = lines
        .filter((l) => Math.abs(l.x - cat.x) < 60 && cat.y - l.y > 0 && cat.y - l.y < 130)
        .sort((a, b) => a.y - b.y);
      if (nameLines.length) {
        const nameRaw = nameLines.map((l) => l.text).join(" ");
        const { name, item, match } = resolveName(nameRaw, catalog);
        const title = lines.find((l) => FAB_ANCHOR.test(l.text));
        const close = lines.find((l) => /(?:^|\s)close$/i.test(l.text));
        const top = title ? title.y + 50 : Math.round(ocr.h * 0.1);
        const nameTop = Math.min(...nameLines.map((l) => l.y));
        const left = cat.x - 40;
        const right = close ? close.x + close.w : cat.x + 800;
        const crop: Rect = { x: Math.max(0, left), y: Math.max(0, top), w: Math.max(0, right - left), h: Math.max(0, nameTop - 15 - top) };
        return { kind: "fabricator", nameRaw, name, item, match, crop };
      }
    }
  }

  // Tracked-mission marker: the objective line ("Go to <place>") anchors the panel;
  // the mission title is the line(s) directly above it, sharing its left edge.
  const goto = lines.find((l) => /\bgo to\b/i.test(l.text));
  if (goto) {
    const titleLines = lines
      .filter((l) => Math.abs(l.x - goto.x) < 120 && goto.y - l.y > 0 && goto.y - l.y < 110)
      .sort((a, b) => a.y - b.y);
    if (titleLines.length) return { kind: "mission", titleRaw: titleLines.map((l) => l.text).join(" ") };
  }

  return { kind: "none" };
}

/** Convenience: OCR an image file and classify it in one call. */
export async function readScreenshot(imagePath: string, catalog: CatalogEntry[]): Promise<ScreenRead> {
  return classifyScreen(await ocrImage(imagePath), catalog);
}
