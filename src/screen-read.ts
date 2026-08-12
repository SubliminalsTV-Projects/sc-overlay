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

import { execFile, spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assetDir } from "./paths.js";

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
/** A scanned mineable's signature number (exact-lookup happens in the tracker).
 *  `pin` is where the shell should look for the scan glyph that proves this number came from a
 *  real scan rather than being some other number the OCR happened to find near screen centre —
 *  see glyphSearchBox(). Windows OCR is text-only and cannot see the glyph itself, so the pixel
 *  check has to happen where the bitmap is (electron/capture.cjs). */
/** `text` is the number's OWN bbox in frame pixels. It travels back to the canvas so the "scan read
 *  area" outline can print what the OCR read at roughly the size the game drew it — which is the
 *  only way a player can see WHY a read came out wrong (a 5 read as an 8, a comma eaten). */
export interface MineableRead { kind: "mineable"; signature: number; raw: string; pin: Rect; text: Rect; }

/** The box to hunt the scan glyph in: immediately LEFT of the number, anchored on the number's
 *  own OCR bbox so it travels with it — head-tracking drift and resolution both stop mattering.
 *  Measured on a 3440×1440 frame (2026-07-24): pin 15×22px, number 37×13px, gap 11px, so the
 *  glyph sits within ~2.5 text-heights to the left and stands ~1.7× the text height. The box is
 *  generous on both axes because the pill is translucent and the number's bbox is only as tight
 *  as the OCR made it. */
export function glyphSearchBox(line: OcrLine, w: number, h: number): Rect {
  const th = Math.max(6, line.h);           // text height drives everything; never trust a 0
  // 3.0 rather than the 2.6 the measurements imply: at 2.6 the box lands one pixel short of the
  // pin's left edge (964 vs 963 on the measured frame), and the gap isn't guaranteed to stay
  // exactly 11px at other UI scales. The colour test is narrow enough that a wider box costs
  // nothing — the pin still fills ~29% of it.
  const boxW = Math.round(th * 3.0);
  const boxH = Math.round(th * 2.2);
  const x = Math.round(line.x - boxW - th * 0.15); // a hair of slack for a bbox that starts tight
  const y = Math.round(line.y + line.h / 2 - boxH / 2);
  // Clamp into the frame: a signature near the left edge would otherwise sample out of bounds.
  const cx = Math.max(0, Math.min(x, w - 1));
  const cy = Math.max(0, Math.min(y, h - 1));
  return { x: cx, y: cy, w: Math.max(1, Math.min(boxW, w - cx)), h: Math.max(1, Math.min(boxH, h - cy)) };
}
export interface NoneRead { kind: "none"; }
export type ScreenRead = FabricatorRead | MissionRead | RefineryRead | MineableRead | NoneRead;

/** Refined/ore material names the refinery yields — the vocabulary for reading a job's
 *  material label, so a mis-OCR'd column header can't be mistaken for it. */
const REFINERY_MATERIALS = new Set([
  "IRON", "ALUMINUM", "ALUMINIUM", "TITANIUM", "TUNGSTEN", "QUANTAINIUM", "GOLD", "CORUNDUM", "COPPER", "TIN",
  "QUARTZ", "HEPHAESTANITE", "LARANITE", "AGRICIUM", "BORASE", "BEXALITE", "TARANITE", "ASLARITE", "BERYL",
  "DIAMOND", "SILICON", "STILERON", "SAVRILIUM", "OURATITE", "RICCITE", "LINDINIUM", "TORITE", "ICE",
]);

/** Where on screen the signature number is hunted, as FRACTIONS of the frame (0–1) so one
 *  setting survives any resolution. Null anywhere means "use the default band". */
export interface ScanRegion { x: number; y: number; w: number; h: number; }

/** The default: the central-upper band the HUD puts the number in. These are the fractions the
 *  classifier used exclusively until 2026-07-29, kept as the reset target — and the canvas draws
 *  its outline from the SAME numbers, so the box can never claim a region that isn't read. */
export const DEFAULT_SCAN_REGION: ScanRegion = { x: 0.5 - 0.17, y: 0.5 - 0.24, w: 0.34, h: 0.24 - 0.015 };

/** Resolve a (possibly absent or nonsense) saved region to real pixels. A region that has been
 *  dragged off-frame or collapsed to nothing would silently stop all scanning, so anything
 *  unusable falls back to the default rather than being honoured. */
export function scanRegion(saved: ScanRegion | null | undefined, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const f = saved
    && Number.isFinite(saved.x) && Number.isFinite(saved.y)
    && Number.isFinite(saved.w) && Number.isFinite(saved.h)
    && saved.w > 0.02 && saved.h > 0.01
    && saved.x >= 0 && saved.y >= 0 && saved.x + saved.w <= 1.001 && saved.y + saved.h <= 1.001
    ? saved : DEFAULT_SCAN_REGION;
  return { x: f.x * w, y: f.y * h, w: f.w * w, h: f.h * h };
}

/** The mining scan HUD's own words. Exported as a test because the CAPTURE LOOP needs to know
 *  the player is at the scanner even on frames where no signature parsed — that is what tells it
 *  to poll fast (a scan is a live feedback loop) instead of idling at the slow rate. */
const SCAN_HUD = /scanning|ready to scan|\bstrong\b|\bmoderate\b|\bweak\b/i;
export function hasScanHud(ocr: OcrResult): boolean {
  return SCAN_HUD.test(ocr.lines.map((l) => l.text).join(" | "));
}

/** Pull the scan signature number out of a HUD line. The value is comma-grouped thousands
 *  ("2,000" / "3,170" / "25,800") preceded by a diamond/pin icon the OCR renders as stray
 *  junk (a lone digit, dots) SEPARATED from the number — so anchoring on the comma group
 *  isolates the real value. Normalizes the usual o->0 / l->1 OCR slips. Returns null when
 *  no grouped number is present (e.g. the comma dropped — a later poll re-reads it). */
export function parseSignature(text: string): number | null {
  // 🔑 The o->0 / l->1 rescue below turns LETTERS into digits, so a word made only of those
  // letters becomes a number: "IIOO" read as 1,100 and "IOOI" as 1,001 — phantom signatures off
  // ordinary HUD text, announced as debris the player never scanned. A real signature always has
  // at least one genuine digit surviving, so require one before rescuing anything.
  if (!/\d/.test(text)) return null;
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

/** Pick the best signature-shaped candidate out of a set of lines already known to be "the
 *  region" — either the scan-region-filtered subset of a full-frame read, or the entirety of a
 *  tight crop taken OF that region (see the mining RapidOCR re-read in capture.cjs, which crops
 *  to the configured scan region before OCR-ing it specifically because Windows OCR mangles this
 *  small, translucent-backgrounded, stylized text — the same reason the fabricator kiosk gets a
 *  RapidOCR second pass). Closest-to-centre wins, same as before this was extracted. */
export function bestSignatureLine(lines: OcrLine[], centerX: number): { l: OcrLine; sig: number } | null {
  const cands = lines
    .map((l) => ({ l, sig: parseSignature(l.text) }))
    .filter((c): c is { l: OcrLine; sig: number } => c.sig != null);
  if (!cands.length) return null;
  cands.sort((a, b) => Math.abs(a.l.x - centerX) - Math.abs(b.l.x - centerX));
  return cands[0];
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

/** One powershell per read — kept as the FALLBACK for when the warm worker can't be spawned or
 *  has just died. Correct but slow: it pays process startup + WinRT loading + engine creation
 *  every time (897ms median vs the worker's 234ms). */
function ocrImageOneShot(imagePath: string): Promise<OcrResult> {
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

/** ConvertTo-Json can leave a raw control char inside a string (an OCR'd glyph decoded to one)
 *  which strict JSON.parse rejects. `sanitizeJson` below strips them the same way the one-shot
 *  path does, without this file having to repeat that literal character class. */
function parseOcrJson(text: string): OcrResult {
  try {
    let cleaned = "";
    for (const ch of text) cleaned += ch.charCodeAt(0) < 32 ? " " : ch;
    const start = cleaned.indexOf("{");
    const parsed = start >= 0 ? (JSON.parse(cleaned.slice(start)) as OcrResult) : null;
    return parsed && Array.isArray(parsed.lines) ? parsed : { w: 0, h: 0, lines: [] };
  } catch { return { w: 0, h: 0, lines: [] }; }
}

// ── The warm OCR worker ───────────────────────────────────────────────────────
// Windows OCR itself is quick; STARTING it is not. Until 2026-07-29 every read spawned its own
// powershell, paying process startup, `Add-Type`, three WinRT type loads and a fresh OcrEngine —
// each and every time. Measured on Sub's machine, same image, same engine:
//
//     one powershell per read   897ms median
//     one kept warm             234ms median   (568ms startup, paid once)
//
// That 663ms was most of the delay between scanning a rock and hearing the call-out. So the
// process is kept alive and fed image paths on stdin. Spawned lazily — nothing starts until
// something actually reads the screen, and every OCR opt-in is off by default — and if it dies
// the next call falls back to a one-shot read and respawns.
const OCR_LINES = OCR_PS1.split("\n");
const OCR_SETUP = OCR_LINES.filter((l) => !l.startsWith("param(") && !l.startsWith("$file =") && !l.startsWith("$stream =")
  && !l.startsWith("$decoder =") && !l.startsWith("$bitmap =") && !l.startsWith("$result =")
  && !l.startsWith("$lines =") && !l.startsWith("@{ w=") && !l.startsWith("  ") && l !== "}");
const OCR_BODY = OCR_LINES.filter((l) => l.startsWith("$file =") || l.startsWith("$stream =")
  || l.startsWith("$decoder =") || l.startsWith("$bitmap =") || l.startsWith("$result =")
  || l.startsWith("$lines =") || l.startsWith("  ") || l === "}" || l.startsWith("@{ w="));

const OCR_WORKER_PS1 = [
  ...OCR_SETUP,
  `Write-Output "OCR-READY"`,
  `while ($true) {`,
  `  $Path = [Console]::In.ReadLine()`,
  `  if ($null -eq $Path -or $Path -eq 'QUIT') { break }`,
  `  try {`,
  ...OCR_BODY.map((l) => "    " + l),
  `    $stream.Dispose()`,
  `  } catch { Write-Output '{"w":0,"h":0,"lines":[]}' }`,
  `}`,
].join("\n");

let worker: ReturnType<typeof spawn> | null = null;
let workerBuf = "";
/** Answered in order — one image at a time, which is all the callers ever ask for. */
const workerQueue: ((r: OcrResult) => void)[] = [];

function killOcrWorker(): void {
  const w = worker;
  worker = null;
  workerBuf = "";
  try { w?.kill(); } catch { /* already gone */ }
  // Nothing may be left hanging: a pending read that never settles latches the capture loop.
  while (workerQueue.length) workerQueue.shift()?.({ w: 0, h: 0, lines: [] });
}

/** Why Windows OCR isn't answering — the evidence, kept because it used to be thrown away.
 *
 *  🔑 Every failure here used to be silent: a worker that could not spawn, or was killed the
 *  instant it did, resolved its pending reads as `{w:0,h:0,lines:[]}` — the SAME value a frame
 *  with no text on it produces. So a machine where OCR was blocked outright looked identical to
 *  one that was simply pointed at empty sky, in the log and in diagnostics alike, and a real user
 *  report ("his OCR just isn't working") had nothing to go on (2026-08-11).
 *
 *  These three tell the causes apart, which is the whole point — see ocrSelfTest():
 *    spawnError        Windows refused to START powershell. EPERM/EACCES is the security-software
 *                      signature; ENOENT means it genuinely isn't on PATH.
 *    exitedBeforeReady it started and died before printing its banner — i.e. something killed it.
 *    everReady         it has answered at least once this session, so the pipe itself is fine and
 *                      an empty read points at Windows OCR (a missing language pack) instead. */
const ocrSignal = {
  spawnError: null as string | null,
  exitedBeforeReady: false,
  lastExitCode: null as number | null,
  everReady: false,
};

function noteOcrFailure(what: string): void {
  // Logged from the SIDECAR on purpose: the shell is a detached GUI process whose stdout goes
  // nowhere, and sidecar.log is the file a user can actually find and send.
  console.error("[ocr] " + what);
}

function ensureOcrWorker(): ReturnType<typeof spawn> | null {
  if (worker) return worker;
  try {
    const p = join(tmpdir(), "sc-tracker-ocr-worker.ps1");
    writeFileSync(p, OCR_WORKER_PS1, "utf8");
    const w = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", p], { windowsHide: true });
    worker = w;
    let ready = false;   // per-worker: an exit before this is the "something killed it" signature
    w.stdout?.setEncoding("utf8");
    w.stdout?.on("data", (chunk: string) => {
      workerBuf += chunk;
      let i: number;
      while ((i = workerBuf.indexOf("\n")) >= 0) {
        const line = workerBuf.slice(0, i).trim();
        workerBuf = workerBuf.slice(i + 1);
        if (line === "OCR-READY") { ready = true; ocrSignal.everReady = true; continue; }  // the banner, not a result
        if (!line) continue;
        workerQueue.shift()?.(parseOcrJson(line));
      }
    });
    w.on("exit", (code) => {
      if (worker !== w) return;
      ocrSignal.lastExitCode = code ?? null;
      ocrSignal.exitedBeforeReady = !ready;
      // A worker that reached READY and later exits is an ordinary death; the next read respawns
      // it. One that never got there is the interesting case, so only that one is worth a line.
      if (!ready) noteOcrFailure(`the OCR helper exited (code ${code}) before it was ready - something on this PC may be stopping it from running`);
      killOcrWorker();
    });
    w.on("error", (err: NodeJS.ErrnoException) => {
      if (worker !== w) return;
      ocrSignal.spawnError = err?.code || String(err?.message || err);
      noteOcrFailure(`could not start the OCR helper: ${ocrSignal.spawnError}`);
      killOcrWorker();
    });
    return w;
  } catch (e) {
    ocrSignal.spawnError = (e as NodeJS.ErrnoException)?.code || String(e);
    noteOcrFailure(`could not start the OCR helper: ${ocrSignal.spawnError}`);
    killOcrWorker();
    return null;
  }
}

// ── The self-test ─────────────────────────────────────────────────────────────
// 🔑 An empty OCR result is AMBIGUOUS, and that ambiguity is the whole reason a broken engine
// could never be reported. A screenshot of the game legitimately contains no text plenty of the
// time, so "no lines" cannot be alerted on. Reading an image WE ship, whose contents we already
// know, removes the ambiguity: nothing coming back from this file means the engine is broken,
// full stop. Nothing is displayed and nothing is captured - it is a file on disk handed to the
// same ocrImage() the capture loop uses.
//
// ⚠️ This proves the OCR ENGINE link only. The chain is
//     foreground detection -> screen capture -> OCR engine -> classify
// and a self-test can pass while capture or the foreground watcher is the thing being blocked.
// Don't let a green self-test be read as "screen reading works".
const SELFTEST_IMAGE = join(assetDir(import.meta.url, "overlay"), "ocr-selftest.png");
/** Keep in sync with tools/make-ocr-selftest.ps1, which draws these into the image. */
const OCR_SELFTEST_WORDS = ["SC", "OVERLAY", "OCR", "SELF", "TEST", "12345"];

export interface OcrHealth {
  /** The engine answered with text. This is the one that decides whether to warn anybody. */
  ok: boolean;
  /** ...and what came back resembles what we know is in the image. A true `ok` with a false
   *  `matched` is a working engine reading badly - worth reporting, never worth an alert. */
  matched: boolean;
  lines: number;
  text: string;
  ranAt: string;
  ms: number;
  /** Plain words for a human, chosen from the failure signature. Null when ok. */
  reason: string | null;
  signal: { spawnError: string | null; exitedBeforeReady: boolean; lastExitCode: number | null; everReady: boolean };
}

/** 🔑 The point of keeping the signals: these causes need DIFFERENT fixes from the user, and
 *  "OCR isn't working" cost a real support thread precisely because they were indistinguishable.
 *  Deliberately worded as "something on this PC" rather than naming antivirus - we can prove the
 *  engine is broken, we cannot prove what broke it, and talking someone into disabling their
 *  protection over what turns out to be a missing language pack is a bad trade. */
function selfTestReason(): string {
  if (ocrSignal.spawnError === "ENOENT") return "Windows PowerShell could not be found on this PC, and Windows OCR is reached through it.";
  if (ocrSignal.spawnError) return `Windows refused to start the OCR helper (${ocrSignal.spawnError}). Security software blocking it is the usual cause.`;
  if (ocrSignal.exitedBeforeReady) return "The OCR helper started and was shut down again before it could answer. Security software doing that is the usual cause.";
  if (ocrSignal.everReady) return "The OCR helper is running but read no text at all, which usually means Windows' own OCR is unavailable - most often a missing language pack.";
  return "The OCR helper did not answer.";
}

/** Ask the engine a question we already know the answer to. */
export async function ocrSelfTest(): Promise<OcrHealth> {
  const ranAt = new Date().toISOString();
  const signal = { ...ocrSignal };
  if (!existsSync(SELFTEST_IMAGE)) {
    // Not the user's problem and not worth alerting on - it means a packaging mistake, so say so
    // plainly rather than letting a missing asset masquerade as broken OCR on their machine.
    return { ok: false, matched: false, lines: 0, text: "", ranAt, ms: 0,
      reason: "The self-test image is missing from this install (packaging problem, not your PC).", signal };
  }
  const started = Date.now();
  const r = await ocrImage(SELFTEST_IMAGE);
  const ms = Date.now() - started;
  const text = r.lines.map((l) => l.text).join(" ").trim();
  const norm = text.toUpperCase().replace(/[^A-Z0-9]+/g, " ");
  const found = OCR_SELFTEST_WORDS.filter((word) => norm.includes(word)).length;
  const ok = r.lines.length > 0;
  const health: OcrHealth = {
    ok,
    // Half is deliberately generous: this is a liveness check, not an accuracy one, and holding it
    // to a perfect read would start warning people whose OCR works fine.
    matched: found >= Math.ceil(OCR_SELFTEST_WORDS.length / 2),
    lines: r.lines.length,
    text: text.slice(0, 200),
    ranAt,
    ms,
    reason: ok ? null : selfTestReason(),
    signal: { ...ocrSignal },
  };
  if (!ok) noteOcrFailure(`self-test FAILED after ${ms}ms - ${health.reason}`);
  else if (!health.matched) noteOcrFailure(`self-test read text but not the expected words (got "${health.text}") - the engine works, its accuracy on this PC may not`);
  return health;
}

/** Run Windows OCR over an image file, returning lines with bounding boxes. */
export function ocrImage(imagePath: string): Promise<OcrResult> {
  const w = ensureOcrWorker();
  if (!w?.stdin) return ocrImageOneShot(imagePath);   // couldn't start one — take the slow road
  const winPath = resolve(imagePath).replace(/\//g, "\\");
  return new Promise((done) => {
    let settled = false;
    const finish = (r: OcrResult) => { if (!settled) { settled = true; done(r); } };
    workerQueue.push(finish);
    try { w.stdin?.write(winPath + "\n"); } catch { finish({ w: 0, h: 0, lines: [] }); return; }
    // A wedged worker must never latch the capture loop. Give up well inside that loop's own
    // 15s watchdog, drop the worker, and let the next call start a fresh one.
    setTimeout(() => {
      if (settled) return;
      const at = workerQueue.indexOf(finish);
      if (at >= 0) workerQueue.splice(at, 1);
      killOcrWorker();
      finish({ w: 0, h: 0, lines: [] });
    }, 8000);
  });
}

/** Shut the worker down. Safe when it was never started. */
export function stopOcrWorker(): void {
  try { worker?.stdin?.write("QUIT\n"); } catch { /* dead already */ }
  killOcrWorker();
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

/** Drop the kiosk's size/grade prefix — "IND/2/B BroadSpec" -> "BroadSpec".
 *
 *  The Fabrication Kiosk prints a manufacturer/size/grade tag ahead of the item name; the
 *  DATASET never does. Measured against the shipped catalog: **0 of 1572 names carry this
 *  shape**, so stripping it can't damage a real name, and leaving it on was fatal — the tag's
 *  tokens dominate the whole-word overlap ("IND 2 B BROADSPEC" vs "BROADSPEC" scores 0.25
 *  against a 0.6 floor), so `IND/2/B BROADSPEC` resolved to NOTHING and the capture reported
 *  "couldn't identify this item". That is punkhiji's report: radars and components that would
 *  never capture, while the same items captured fine for players whose kiosk showed no tag.
 *
 *  🔑 Stripping is enough on its own — the base name then hits the EXACT pass, which also
 *  settles the variants ("BroadSpec" vs "BroadSpec-Go"/"-Max" differ once normalised, so there
 *  is no ambiguity to resolve and no need to consult the category breadcrumb). */
export function stripSizeGrade(raw: string): string {
  return raw.replace(/^[A-Za-z]{2,6}\/\d\/[A-Za-z0-9]{1,3}\s+/, "");
}

/** Resolve an OCR'd name to a catalog item: exact-normalized, then whole-word overlap,
 *  then a character-bigram fallback for glitched tags — both tie-safe (an ambiguous read
 *  returns none, never a guess) and variant-aware (picks S1/S2/S3 by the OCR's digits). */
export function resolveName(
  raw: string,
  catalog: CatalogEntry[],
): { name: string | null; item: string | null; match: "exact" | "fuzzy" | "none" } {
  const n = normName(stripSizeGrade(raw));
  if (!n) return { name: null, item: null, match: "none" };
  // OCR routinely confuses 0<->O (a size-0 "S0 Helix" reads as "SO HELIX") and 1<->I/| (the
  // QuantumDrive "XL-1" reads as "XL-I", "S1" as "SI"). Fold each digit to its look-alike letter
  // for the exact pass only, so short coded names still match — the fuzzy/size-digit logic below
  // is untouched. Verified collision-free against the live catalog (no two items fold alike).
  const fold = (s: string) => s.replace(/0/g, "O").replace(/[1|]/g, "I");
  const nf = fold(n);
  for (const e of catalog) {
    const en = normName(e.name);
    if (en === n || fold(en) === nf) return { name: e.name, item: e.item, match: "exact" };
  }

  const looseFold = (s: string) => {
    const folded = s
      .replace(/[0]/g, "O")
      .replace(/[1|]/g, "I")
      .replace(/\bSO\b/g, "S0")
      .replace(/\bIO\b/g, "I0")
      .replace(/\bSI\b/g, "S1")
      .replace(/\bII\b/g, "I1");
    return folded.replace(/\bS([OI])\b/g, "S0").replace(/\b([A-Z])([OI])\b/g, "$10");
  };
  const lf = looseFold(n);
  for (const e of catalog) {
    const en = normName(e.name);
    if (looseFold(en) === lf) return { name: e.name, item: e.item, match: "exact" };
  }

  const shortTokenLoose = (s: string) => {
    const parts = s.split(" ").filter(Boolean);
    return parts.some((p) => /^S[0O]$/i.test(p) || /^S[1I]$/i.test(p) || /^X[Ll]?[- ]?[1I]$/i.test(p));
  };
  if (shortTokenLoose(n)) {
    for (const e of catalog) {
      const en = normName(e.name);
      if (shortTokenLoose(en)) {
        const a = n.replace(/[^A-Z0-9]/g, "");
        const b = en.replace(/[^A-Z0-9]/g, "");
        if (a === b || a.replace(/[0]/g, "O").replace(/[1|]/g, "I") === b.replace(/[0]/g, "O").replace(/[1|]/g, "I")) {
          return { name: e.name, item: e.item, match: "exact" };
        }
      }
    }
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
 *  edit ("Tie@"/"Tler" -> Tier) without letting a long word-filled line fuzzy-match it. Used for a
 *  SEPARATE fragment sharing the category row (Windows OCR splits "· Tier" off on its own). */
const tierish = (t: string) => { const a = anchorNorm(t); return a.length <= 6 && fuzzySubstringDistance(a, "TIER") <= 1; };
/** A "Tier" token embedded ANYWHERE in a line — PP-OCR groups the whole "<Category> … · Tier <T>"
 *  into one long line, so accept it there too. Safe to leave unbounded because it's only tested on
 *  lines that already start with a category word (CATEGORY_LINE). */
const catHasTier = (t: string) => fuzzySubstringDistance(anchorNorm(t), "TIER") <= 1;
/** PP-OCR can glue the far-right "Fabrication Time" column onto the name row ("TS-2 Fabrication
 *  Time:") — drop that label (and anything after it) so the name resolves cleanly. */
const stripName = (raw: string) => raw.replace(/\s*fabrication\s*time.*$/i, "").replace(/\s+/g, " ").trim();

/** Turn an OCR result into a structured read: fabricator item, tracked mission, or nothing. */
export function classifyScreen(
  ocr: OcrResult,
  catalog: CatalogEntry[],
  opts?: { scanRegion?: ScanRegion | null },
): ScreenRead {
  const lines = ocr.lines;
  if (!lines.length) return { kind: "none" };
  const joined = lines.map((l) => l.text).join(" ");

  // Kiosk gate: the full-frame title "FABRICATION KIOSK", OR (crop-first path) the right panel's
  // "Fabrication Time" / FABRICATE — both fuzzy-match "FABRICATION". A stray "fabrication" without
  // the kiosk layout still fails to yield a category+name below, so it can't false-classify an item.
  if (fuzzyHas(joined, "FABRICATION", 2)) {
    // The item name is the line(s) directly above the "<Category> ... Tier" line,
    // sharing its left edge. The render sits above the name, in the kiosk's right half.
    // "· Tier" can be OCR-split onto a separate fragment at the same row (a wide "·" gap),
    // so accept "Tier" on the category line itself OR on any fragment sharing its y.
    const cat = lines.find(
      (l) =>
        CATEGORY_LINE.test(l.text) &&
        (catHasTier(l.text) ||
          lines.some((o) => o !== l && Math.abs(o.y - l.y) < 20 && tierish(o.text))),
    );
    const title = lines.find((l) => fuzzyHas(l.text, FAB_ANCHOR_NORM, 3));
    const close = lines.find((l) => /(?:^|\s)close$/i.test(l.text));
    const top = title ? title.y + 50 : Math.round(ocr.h * 0.1);
    if (cat) {
      // The name is the left-aligned line(s) directly above the category. Distance is relative to
      // the category's own text height (a few line-heights) so it survives multi-line names AND
      // any capture/upscale resolution — a fixed pixel gap breaks on both.
      const nameGap = Math.max(130, cat.h * 8);
      const nameLines = lines
        .filter((l) => Math.abs(l.x - cat.x) < 60 && cat.y - l.y > 0 && cat.y - l.y < nameGap)
        .sort((a, b) => a.y - b.y);
      if (nameLines.length) {
        // Strip PER LINE (not the joined string) — PP-OCR glues "Fabrication Time" onto the first
        // name line, and stripping to end-of-string would eat the later name lines after it.
        const nameRaw = nameLines.map((l) => stripName(l.text)).filter((t) => t).join(" ");
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
  if (SCAN_HUD.test(joined)) {
    // Where to look for the number. Default is the central-upper band the HUD puts it in; a
    // player can move/resize it (Mining Scanner → "Show the scan read area", then drag), which is
    // the only way to cope with a HUD that doesn't sit where we assume — a different aspect
    // ratio, a UI scale, or the whole thing on a second monitor.
    const r = scanRegion(opts?.scanRegion, ocr.w, ocr.h);
    const inBox = lines.filter((l) => l.y > r.y && l.y < r.y + r.h && l.x > r.x && l.x < r.x + r.w);
    const best = bestSignatureLine(inBox, r.x + r.w / 2);
    if (best) {
      return {
        kind: "mineable",
        signature: best.sig,
        raw: best.l.text.trim(),
        pin: glyphSearchBox(best.l, ocr.w, ocr.h),
        text: { x: best.l.x, y: best.l.y, w: best.l.w, h: best.l.h },
      };
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
