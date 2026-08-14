// Fabricator screen-capture loop (opt-in).
//
// On a low-frequency poll, and ONLY while Star Citizen is the FOREGROUND window
// (privacy: we never capture/OCR any other app), grab a full screenshot and ask the
// sidecar's /api/screen-read to OCR it. If the fabricator is showing an item we don't
// have a capture for yet, crop its render and save it locally; a later step uploads
// these to subliminal.gg. A tracked-mission read is logged for the picker wiring.
//
// This runs only in the Electron main process (needs desktopCapturer + nativeImage).

const { desktopCapturer, screen, nativeImage } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const POLL_MS = 3000;
// Ore scanning is a live feedback loop — you scan a rock and want to hear what it is NOW — so the
// loop speeds up while the scan HUD is actually on screen, then falls back. Sub, 2026-07-29:
// "while I'm scanning for ore I want it to be as fast as possible", but explicitly NOT at the
// fabricator, where rushing risks capturing a half-loaded render.
const FAST_MS = 900;
// How long a sighting of the scan HUD keeps the loop fast. Comfortably longer than the gap
// between scans, so a scanning session doesn't drop back to 3s between rocks.
const FAST_WINDOW_MS = 20000;
// The kiosk render fades in over ~1-2s. This is the wait the 3s tick was implicitly giving it.
const SETTLE_MS = 3000;

// Return the FOREGROUND window's process name AND its screen rectangle. The rect lets us capture
// the monitor the game is actually on (not a blind sources[0]) — critical on multi-monitor rigs.
const fgPs1 = path.join(os.tmpdir(), "sc-fgwin.ps1");
let fgPs1Written = false;
function writeFgPs1() {
  if (fgPs1Written) return;
  fs.writeFileSync(fgPs1, [
    'Add-Type @"',
    "using System;using System.Runtime.InteropServices;",
    "public class FGW{",
    ' [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();',
    ' [DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int pid);',
    " [StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left,Top,Right,Bottom;}",
    ' [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);',
    "}",
    '"@',
    "$h=[FGW]::GetForegroundWindow();$procId=0;[void][FGW]::GetWindowThreadProcessId($h,[ref]$procId)",
    "$r=New-Object FGW+RECT;[void][FGW]::GetWindowRect($h,[ref]$r)",
    "$n=try{(Get-Process -Id $procId -ErrorAction Stop).ProcessName}catch{''}",
    'Write-Output ("$n|$($r.Left)|$($r.Top)|$([int]($r.Right-$r.Left))|$([int]($r.Bottom-$r.Top))")',
  ].join("\n"));
  fgPs1Written = true;
}
// Prefer the long-lived watcher (foreground.cjs): it already knows the answer, so the common case
// costs nothing. The spawn below is now only the cold-start / helper-died fallback — it used to
// run on EVERY tick, i.e. ~20 PowerShell launches a minute for one HWND.
const fgWatch = require("./foreground.cjs");
function foregroundWindow() {
  if (fgWatch.ready()) return Promise.resolve(fgWatch.foreground());
  return new Promise((resolve) => {
    try { writeFgPs1(); } catch { return resolve({ name: "", rect: null }); }
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fgPs1], { windowsHide: true, timeout: 4000 }, (err, out) => {
      if (err) return resolve({ name: "", rect: null });
      const p = String(out).trim().split("|");
      const x = +p[1], y = +p[2], w = +p[3], hh = +p[4];
      resolve({ name: p[0] || "", rect: w > 0 && hh > 0 ? { x, y, width: w, height: hh } : null });
    });
  });
}

// Capture the display the GAME window is on (matched by display_id), at that monitor's full
// resolution → nativeImage. Falls back to the primary / sources[0] if the match fails.
async function captureGame(winRect) {
  const disp = winRect ? screen.getDisplayMatching(winRect) : screen.getPrimaryDisplay();
  const width = Math.round(disp.size.width * disp.scaleFactor);
  const height = Math.round(disp.size.height * disp.scaleFactor);
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  const src = sources.find((s) => s.display_id && String(s.display_id) === String(disp.id)) || sources[0];
  // `onPrimary` is reported because the calibration box is drawn over the PRIMARY display only —
  // the canvas is told nothing about any other one — so a game running elsewhere is being
  // calibrated against pixels nobody can see. Cheap here (we already resolved the display) and
  // impossible to work out downstream.
  return src ? { image: src.thumbnail, width, height, onPrimary: disp.id === screen.getPrimaryDisplay().id } : null;
}

// The kiosk's item render + name + category all live in the upper-right of the screen. Cropping to
// it before RapidOCR both (a) stops PP-OCR fusing the left material panel into the name and (b)
// speeds the read up. Fractions are of the captured GAME display (the fabricator is a fullscreen UI).
function rightPanelCrop(image, w, h) {
  const x = Math.round(w * 0.5);
  const cw = w - x, ch = Math.round(h * 0.72);
  return { img: image.crop({ x, y: 0, width: cw, height: ch }), w: cw, h: ch };
}

// The mining scan region, in pixels — deliberately duplicated from screen-read.ts's scanRegion()/
// DEFAULT_SCAN_REGION rather than imported: that module is TypeScript run via tsx in the sidecar
// process, and this file is plain CommonJS in the Electron main process with no build step wiring
// them together. Keep in sync if the default band or the validation rule ever changes there.
const DEFAULT_SCAN_REGION = { x: 0.5 - 0.17, y: 0.5 - 0.24, w: 0.34, h: 0.24 - 0.015 };
/** Tighten a scan region around the box the signature was last found in. Generous margins, and
 *  ALWAYS clamped inside the user's configured region — this narrows where we look, it never
 *  looks somewhere they didn't ask for. Extra room on the left because the scan-marker pin is
 *  drawn there and the glyph check needs it in frame. */
function tightenRegion(region, box) {
  const padL = Math.round(box.h * 6), padR = Math.round(box.h * 3), padY = Math.round(box.h * 2.5);
  const x = Math.max(region.x, box.x - padL);
  const y = Math.max(region.y, box.y - padY);
  const right = Math.min(region.x + region.width, box.x + box.w + padR);
  const bottom = Math.min(region.y + region.height, box.y + box.h + padY);
  const width = right - x, height = bottom - y;
  // A degenerate box (a bad lock, a zero-height bbox) must never produce an empty crop.
  if (width < 40 || height < 16) return region;
  return { x, y, width, height };
}

function scanRegionPixels(saved, w, h) {
  const f = saved
    && Number.isFinite(saved.x) && Number.isFinite(saved.y)
    && Number.isFinite(saved.w) && Number.isFinite(saved.h)
    && saved.w > 0.02 && saved.h > 0.01
    && saved.x >= 0 && saved.y >= 0 && saved.x + saved.w <= 1.001 && saved.y + saved.h <= 1.001
    ? saved : DEFAULT_SCAN_REGION;
  return {
    x: Math.round(f.x * w), y: Math.round(f.y * h),
    width: Math.round(f.w * w), height: Math.round(f.h * h),
  };
}

// RapidOCR (PP-OCR) reader — main-process only, ESM loaded lazily (model loads once, ~2s). Returns
// the same {text,x,y,w,h} line shape the sidecar classifier expects, from the PP-OCR {text,box}.
// 🔑 The models must be loaded from the UNPACKED copy. electron-builder's asarUnpack writes
// @gutenye to app.asar.unpacked, but it ALSO leaves a copy inside app.asar — and that is the one
// the module loader resolves, so ocr-models derives its paths (from import.meta.url) under
// `app.asar\`. Electron's patched fs would redirect those reads transparently, but onnxruntime-node
// opens them from NATIVE code, which bypasses the patch: "File doesn't exist" and OCR silently
// never starts. Unpackaged (dev) paths contain no app.asar, so this is a no-op there.
const ASAR_SEG = `app.asar${path.sep}`;
const unpackedModelPath = (p) => p.replace(ASAR_SEG, `app.asar.unpacked${path.sep}`);

// Hand a RapidOCR startup failure to the sidecar, which already owns the "screen reading isn't
// working" banner. Best-effort and fire-and-forget: this runs during a failure, and a second
// failure reporting the first one is not worth taking the capture loop down over.
// ⚠️ `port` is a parameter of startFabCapture, not a module value — reaching for it from here
// would throw a ReferenceError at exactly the moment something has already gone wrong. Recorded
// on the way in instead.
let sidecarPort = null;
let lastRapidReport = null;
function reportRapidFailure(reason) {
  if (reason === lastRapidReport) return;   // once per state, not once per tick
  lastRapidReport = reason;
  if (!sidecarPort) return;
  fetch(`http://localhost:${sidecarPort}/api/ocr/rapid-failure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => { /* sidecar not up yet; the next attempt reports it */ });
}

let _rapid = null;
function getRapid() {
  if (!_rapid) {
    _rapid = (async () => {
      const [{ default: Ocr }, { default: defaultModels }] = await Promise.all([
        import("@gutenye/ocr-node"),
        import("@gutenye/ocr-models/node"),
      ]);
      const models = {
        detectionPath: unpackedModelPath(defaultModels.detectionPath),
        recognitionPath: unpackedModelPath(defaultModels.recognitionPath),
        dictionaryPath: unpackedModelPath(defaultModels.dictionaryPath),
      };
      // Say WHICH file is missing — an unreadable model otherwise surfaces as "the widget just
      // never calls anything out", which is a much longer trip to the cause.
      const missing = Object.entries(models).filter(([, p]) => !fs.existsSync(p));
      for (const [k, p] of missing) console.error(`[fab-capture] RapidOCR ${k} missing on disk: ${p}`);
      try {
        const ocr = await Ocr.create({ models });
        reportRapidFailure("");   // clear a failure a previous launch reported
        return ocr;
      } catch (e) {
        // 🔴 TELL THE USER. This is the 0.1.42 bug's whole shape: the engine refused to start, the
        // scanner went quiet, and nothing anywhere said so — the app's OCR health check only ever
        // tested the OTHER engine, so every diagnostic read healthy while the feature was dead.
        const why = missing.length
          ? `an OCR model file is missing from this install (${missing[0][0]})`
          : String((e && e.message) || e).slice(0, 200);
        reportRapidFailure(`Text recognition could not start — ${why}. Mining call-outs and the `
          + `contract scanner will not work until this is fixed.`);
        throw e;
      }
    })();
  }
  return _rapid;
}
// ── Mining diagnostic frames (opt-in, config.miningDebug) ────────────────────────────────────
// Writes the magnified bitmap the OCR actually receives, plus the raw crop, into the per-user dir
// so the sidecar can serve them over HTTP. Deliberately NOT next to the binary (Program Files is
// read-only) and deliberately capped: this is a debugging aid someone will forget to switch off.
const DEBUG_FRAME_DIR = path.join(process.env.APPDATA || os.tmpdir(), "sc-blueprint-tracker", "debug-frames");
const DEBUG_FRAME_MAX = 12; // ~a minute of scanning; oldest pruned first
let debugFrameSeq = 0;
function saveDebugFrame(magnified, raw) {
  fs.mkdirSync(DEBUG_FRAME_DIR, { recursive: true });
  const n = String(++debugFrameSeq).padStart(4, "0");
  fs.writeFileSync(path.join(DEBUG_FRAME_DIR, `crop-${n}-magnified.png`), magnified.toPNG());
  fs.writeFileSync(path.join(DEBUG_FRAME_DIR, `crop-${n}-raw.png`), raw.toPNG());
  // Prune oldest by name — the sequence is monotonic, so lexical order IS chronological.
  const files = fs.readdirSync(DEBUG_FRAME_DIR).filter((f) => f.endsWith(".png")).sort();
  while (files.length > DEBUG_FRAME_MAX * 2) {
    try { fs.unlinkSync(path.join(DEBUG_FRAME_DIR, files.shift())); } catch { /* raced */ }
  }
}

async function ocrRapidLines(imgPath) {
  const ocr = await getRapid();
  const res = await ocr.detect(imgPath);
  return (res || []).map((r) => {
    const xs = r.box.map((pt) => pt[0]), ys = r.box.map((pt) => pt[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { text: String(r.text || ""), x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  });
}

// Is an item actually rendered in the crop, or did we catch the fabricator mid-load (just the
// teal background)? We test for STRUCTURE, not brightness. The 3D preview streams in when an
// item is selected; an empty kiosk is a smooth teal gradient with almost no hard edges, whereas
// ANY real render — including the DARK schematics quantum drives + some ship components show,
// which never "light up" — has silhouette/detail edges. (Brightness alone wrongly rejected those
// dark items: they add almost no bright pixels, so the gate sat on "waiting for render" forever.)
// Count pixels bordering a hard luminance step in either direction; a smooth gradient stays near
// zero (measured: empty kiosk ~0%), a lit item is several %, a dark schematic is still clearly
// above the floor. The settle poll already covers fade-in timing, so this only guards emptiness.
function hasRender(image) {
  const bmp = image.getBitmap();          // BGRA, 4 bytes/pixel
  const { width: w, height: h } = image.getSize();
  const total = w * h;
  if (total < 4 || w < 2 || h < 2) return false;
  const lumAt = (x, y) => { const i = (y * w + x) * 4; return 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2]; };
  let edges = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = lumAt(x, y);
      const gx = x + 1 < w ? Math.abs(l - lumAt(x + 1, y)) : 0;
      const gy = y + 1 < h ? Math.abs(l - lumAt(x, y + 1)) : 0;
      if (gx > 24 || gy > 24) edges++;
    }
  }
  return edges / total > 0.001;
}

// Did a real SCAN produce this number, or did the OCR just find a comma-grouped number floating
// near screen centre? A genuine mining signature is drawn beside a map-pin glyph; nothing else on
// the HUD pairs that glyph with a number. Windows OCR is text-only and can't see icons, so this is
// the only way to tell — and it's the difference between "Debris" meaning something and the widget
// calling out numbers the player never scanned.
//
// Measured on Sub's 3440×1440 frame (2026-07-24): pin 15×22px, mean RGB (190,200,113).
// 🔑 Colour ALONE cannot do it: G−R is +10 on the pin but −5 on the SCANNING label. What separates
// them is BLUE — the pin is a desaturated yellow-green (B≈133) while the HUD's yellow is B≈25–43.
// Restricting the test to a box beside a number is what makes the colour test safe.
// ⚠ The pill is TRANSLUCENT, so what shows through varies with the backdrop. The thresholds are
// deliberately loose and every read logs its measurements, so real scans can tighten them.
// Which way to err: a MISSED glyph costs almost nothing — a signature that resolves to a known
// ore is applied regardless, so ore detection can't break — it only means a real piece of debris
// goes unannounced. A FALSE glyph puts "Debris" back in the player's ear for a number they never
// scanned, which is the whole complaint. So the band is drawn to be sure, not to be generous...
// except that the pill is translucent, and a pin blended halfway into dark space is a REAL scan
// (measured 50% blend: 99,105,64). minB/minG sit just under that, still far above the HUD yellow
// (B 25–43) that has to stay out.
// 🔑 NO ABSOLUTE COLOUR. The pin's colour is the SHIP'S HUD colour, and that changes with the
// ship the player is flying (Sub, 2026-08-03) — so the old yellow-green band, tuned to one frame
// from one ship, could only ever work for that ship. Every other HUD read `confirmed: false`,
// which silently made pure debris un-announceable: debris has no rock-table match, so the glyph
// is the ONLY evidence it has, and a glyph that never confirms means no debris call-out ever.
// That is the "2,000 and 6,000 are never called out" report, and it was never about those values.
//
// 🔴 THE "SAME COLOUR AS THE NUMBER" INVARIANT WAS ITSELF WRONG, not just mistuned (Rytharr,
// 2026-08-07). A real capture showed the pin rendering GOLD (chroma ~0.42/0.38/0.20) beside a
// WHITE number (chroma ~0.33/0.34/0.33) on the same frame — chromaDist between them was 0.297,
// past the 0.22 threshold that assumed they'd match. That pin could never be found, at any
// brightness, because the reference it was being compared against was never its own colour to
// begin with. And the colour still can't be hardcoded — it demonstrably varies ship to ship.
//
// The invariant that actually holds: THE PIN IS THE ONLY COLOURFUL THING IN THIS BOX. Measured off
// that same real capture — the translucent pill background and the (apparently always neutral)
// number text both sit under 0.1 saturation; real pin ink measured 0.3–0.7 regardless of its hue.
// So instead of matching a specific colour, ask whether a pixel is colourful AT ALL (its
// saturation — how far its RGB sits from grey/white/black) rather than which colour it is. That
// works for a yellow HUD, a blue one, a gold one, a white one, and any future one, without ever
// needing to know in advance what "the pin's colour" is.
const GLYPH = {
  /** Fraction of the search box that must be pin-coloured ink. The pin is ~15×22 in a ~34×29
   *  box (~33%), so this stays generous for a heavily blended one. */
  minFraction: 0.04,
  /** How much of the largest bright BLOB must fill its own bounding box. A pin is close to solid
   *  (measured ~0.6-0.8); glyph strokes of HUD text fill maybe 0.3 of theirs, and a diffuse
   *  gradient far less. This is what stops bright-but-not-pin-shaped things counting. */
  minFill: 0.45,
  /** How far from square that blob may be. The pin is ~15x22 (aspect 1.5); a word, a HUD rule or
   *  a rock edge is far longer than it is tall. 3.0 leaves room for a partly-occluded pin. */
  maxAspect: 3.0,
  /** A hit must also be BRIGHT — at least this fraction of the NUMBER's own ink luminance — so
   *  near-black compression noise (which can read as spuriously "saturated" at tiny RGB values)
   *  doesn't count just for having an unstable colour ratio. Deliberately a fraction of the ink and
   *  NOT a step above the sampled background: a tight OCR bbox can be almost pure ink, making
   *  background ~= ink, and a floor derived from that gap then demands the pin be as bright as the
   *  number — which a translucent pin never is. 0.35 clears a pin blended 50% into space (measured
   *  ~52% of ink) with margin. */
  minLumRatio: 0.35,
  /** Below this the text sample is too dim/flat to trust as a reference (the number itself was
   *  probably not in the box we were handed) — see the fallback in findScanGlyph. */
  minInkLum: 40,
};

/** How far a pixel sits from the grey/white/black axis — 0 for any shade of grey, up toward 1 for
 *  a fully saturated colour. Colour-FAMILY agnostic on purpose: this asks "is it colourful" rather
 *  than "which colour is it", which is what lets one threshold cover a gold pin, a cyan one, a red
 *  one, whatever a given ship's HUD happens to use. */
function saturation(r, g, b) {
  const mx = Math.max(r, g, b);
  return mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
}

/** Sample a rect and derive its INK: the colour of the bright minority (glyph strokes) rather
 *  than the dark majority (background). Percentile, not a fixed threshold, so it self-scales to
 *  whatever the HUD's brightness is. */
function sampleInk(bmp, w, x0, y0, x1, y1) {
  const lums = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      lums.push(0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2]);
    }
  }
  if (!lums.length) return null;
  const sorted = lums.slice().sort((a, b) => a - b);
  // Top quartile = the strokes. Text is a minority of its own bounding box, so a mean over the
  // whole box would return the BACKGROUND and every comparison after it would be meaningless.
  const cut = sorted[Math.floor(sorted.length * 0.75)];
  const bg = sorted[Math.floor(sorted.length * 0.25)];
  let n = 0, sr = 0, sg = 0, sb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const l = 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2];
      if (l >= cut) { n++; sr += bmp[i + 2]; sg += bmp[i + 1]; sb += bmp[i]; }
    }
  }
  if (!n) return null;
  const mean = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  return { mean, lum: cut, bg };
}

/** Sample the box beside the signature number and decide whether the scan glyph is in it.
 *  Returns the measurements too — they go in the log so the thresholds can be tuned from real
 *  scans rather than guessed at a second time. */
function findScanGlyph(image, rect, textRect) {
  const { width: w, height: h } = image.getSize();
  const clamp = (r) => {
    const x0 = Math.max(0, Math.min(Math.round(r.x), w - 1));
    const y0 = Math.max(0, Math.min(Math.round(r.y), h - 1));
    return [x0, y0, Math.max(x0, Math.min(Math.round(r.x + r.w), w)), Math.max(y0, Math.min(Math.round(r.y + r.h), h))];
  };
  const [x0, y0, x1, y1] = clamp(rect);
  const total = (x1 - x0) * (y1 - y0);
  if (total <= 0) return { seen: false, fraction: 0, total: 0, mean: null, ref: null, why: "empty search box" };
  const bmp = image.getBitmap(); // BGRA, 4 bytes/pixel

  // The reference is the NUMBER's own ink luminance, purely as a BRIGHTNESS anchor — not its
  // colour (see the note above on why that assumption was wrong). Without a usable text rect
  // there is nothing to calibrate brightness against, so this refuses rather than guessing.
  const ink = textRect ? sampleInk(bmp, w, ...clamp(textRect)) : null;
  if (!ink || ink.lum < GLYPH.minInkLum) {
    return { seen: false, fraction: 0, total, mean: null, ref: null,
             why: ink ? `text ink too dim to calibrate (lum ${Math.round(ink.lum)})` : "no text rect to calibrate from" };
  }
  // A hit must be COLOURFUL (unlike the achromatic pill and the neutral number text) and bright
  // relative to the number's own luminance — saturation alone would accept near-black compression
  // noise, whose colour ratio is unstable at tiny RGB values.
  const lumFloor = ink.lum * GLYPH.minLumRatio;
  const bw = x1 - x0, bh = y1 - y0;
  const on = new Uint8Array(bw * bh);
  let hits = 0, sr = 0, sg = 0, sb = 0, hr = 0, hg = 0, hb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      sr += r; sg += g; sb += b;
      const lum = 0.114 * b + 0.587 * g + 0.299 * r;
      // 🔑 BRIGHTNESS ONLY — no colour term of any kind. Every previous version keyed on colour
      // and every one of them broke on a HUD it wasn't measured against: first an absolute
      // yellow-green band (worked for exactly one ship), then hue matched to the number (a real
      // capture had a GOLD pin beside a WHITE number, chromaDist 0.297 vs a 0.22 threshold), then
      // saturation (which cannot see a white pin — its own test asserts that, and Sub's HUD renders
      // the pin near-white). Manufacturer skins recolour this freely, so any colour constant is a
      // constant that isn't. What does NOT change is that the pin is a solid bright mark sitting
      // beside a number of known brightness — so threshold on brightness and settle it by SHAPE.
      if (lum >= lumFloor) {
        on[(y - y0) * bw + (x - x0)] = 1;
        hits++; hr += r; hg += g; hb += b;
      }
    }
  }
  // Largest 4-connected blob of bright pixels. Brightness alone is not enough on its own — HUD
  // lettering, a lit rock edge and a starfield all clear the floor. The pin is distinguished by
  // being ONE CONTIGUOUS MARK: text scatters into many small components, a gradient spreads thinly
  // across the whole box, and neither forms a single blob of the pin's size and squareness.
  const blob = largestBlob(on, bw, bh);
  const fraction = blob.size / total;
  const fill = blob.w && blob.h ? blob.size / (blob.w * blob.h) : 0;
  const aspect = blob.w && blob.h ? Math.max(blob.w / blob.h, blob.h / blob.w) : 99;
  const seen = fraction >= GLYPH.minFraction && fill >= GLYPH.minFill && aspect <= GLYPH.maxAspect;
  return {
    seen,
    fraction: Math.round(fraction * 1000) / 1000,
    total,
    mean: [Math.round(sr / total), Math.round(sg / total), Math.round(sb / total)],
    hitMean: hits ? [Math.round(hr / hits), Math.round(hg / hits), Math.round(hb / hits)] : null,
    // Every number the decision used, so a HUD that still fails is diagnosable from a user's
    // report without guessing — this is what the old absolute thresholds could never tell us.
    ref: { mean: ink.mean, lum: Math.round(ink.lum), bg: Math.round(ink.bg), lumFloor: Math.round(lumFloor) },
    blob: { w: blob.w, h: blob.h, size: blob.size, fill: Math.round(fill * 100) / 100, aspect: Math.round(aspect * 100) / 100 },
    why: seen
      ? `blob ${blob.w}x${blob.h} (${blob.size}px, fill ${fill.toFixed(2)}, aspect ${aspect.toFixed(2)}) in ${total}px box`
      : `no pin-shaped blob: largest ${blob.w}x${blob.h} ${blob.size}px, fraction ${fraction.toFixed(3)}` +
        `, fill ${fill.toFixed(2)}, aspect ${aspect.toFixed(2)} (need >=${GLYPH.minFraction}, >=${GLYPH.minFill}, <=${GLYPH.maxAspect})`,
  };
}

/** Largest 4-connected component of set pixels, with its bounding box. Iterative flood fill —
 *  a recursive one blows the stack on a large bright region, which is exactly the pathological
 *  input here (a white flash, a lit rock filling the box). */
function largestBlob(on, bw, bh) {
  const seen = new Uint8Array(bw * bh);
  const stack = new Int32Array(bw * bh);
  let best = { size: 0, w: 0, h: 0 };
  for (let start = 0; start < on.length; start++) {
    if (!on[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let size = 0, minX = bw, maxX = -1, minY = bh, maxY = -1;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % bw, y = (p / bw) | 0;
      size++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && on[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x + 1 < bw && on[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && on[p - bw] && !seen[p - bw]) { seen[p - bw] = 1; stack[sp++] = p - bw; }
      if (y + 1 < bh && on[p + bw] && !seen[p + bw]) { seen[p + bw] = 1; stack[sp++] = p + bw; }
    }
    if (size > best.size) best = { size, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
  return best;
}

const SITE = "https://subliminal.gg";

// Crop tight around the SUBJECT and re-centre on it, on BOTH axes. The kiosk shows the item
// floating on a smooth teal glow with a faint backdrop grid. The old approach kept the item's
// extent by colour-distance from the corner background — but the glow ALSO differs from the
// corners, so for a small, dark item (e.g. fuel components) it locked onto the glow and left the
// item tiny + off-centre. Instead we locate the item by its EDGES: a real 3D render has hard
// silhouette/detail edges, while the glow is smooth and the grid is low-contrast. We take the
// dominant contiguous edge cluster's bounding box on x and y and crop to it with a small margin.
function centerTighten(image, margin = 40) {
  const { width: w, height: h } = image.getSize();
  if (w < 40 || h < 40) return image;
  const bmp = image.getBitmap(); // BGRA
  const lumAt = (x, y) => { const i = (y * w + x) * 4; return 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2]; };
  const T = 28; // edge threshold: above the faint backdrop grid (~10-15), at/below item silhouette
  const colE = new Int32Array(w), rowE = new Int32Array(h);
  let totalE = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = lumAt(x, y);
      const gx = x + 1 < w ? Math.abs(l - lumAt(x + 1, y)) : 0;
      const gy = y + 1 < h ? Math.abs(l - lumAt(x, y + 1)) : 0;
      if (gx > T || gy > T) { colE[x]++; rowE[y]++; totalE++; }
    }
  }
  if (totalE < 50) return image; // no discernible subject — leave the anchor crop as-is
  // Dominant contiguous run in an edge-count projection (bridging small gaps), so a stray UI
  // sliver or grid speck loses to the item cluster. `span` is the perpendicular dimension.
  const domRun = (arr, n, span) => {
    const floor = Math.max(2, Math.round(0.008 * span)); // a line needs this many edge px to count
    const maxGap = Math.max(6, Math.round(n * 0.06));
    let bestL = -1, bestR = -1, bestSum = 0, i = 0;
    while (i < n) {
      if (arr[i] < floor) { i++; continue; }
      let segL = i, segR = i, sum = 0, gap = 0;
      while (i < n && gap <= maxGap) {
        if (arr[i] >= floor) { segR = i; sum += arr[i]; gap = 0; } else { gap++; }
        i++;
      }
      if (sum > bestSum) { bestSum = sum; bestL = segL; bestR = segR; }
    }
    return [bestL, bestR];
  };
  let [xL, xR] = domRun(colE, w, h);
  let [yT, yB] = domRun(rowE, h, w);
  if (xL < 0 || yT < 0) return image;
  // The edge cluster nails the item's HIGH-contrast (bright) parts but can miss a dark, low-contrast
  // region — a helmet's black visor, black-finish armor — that blends into the dark teal backdrop,
  // clipping it off. Grow the box outward to re-absorb any attached NON-TEAL "content": the kiosk
  // background and its glow are teal (green+blue clearly above red), whereas the item — red, grey or
  // near-black — is not. Growth only EXTENDS the box (never tightens), so it can NEVER introduce a
  // new clip; and a teal gap stops it, so it won't jump to a separated glyph (the X-close, stat text).
  const isItem = (x, y) => { const i = (y * w + x) * 4; const B = bmp[i], G = bmp[i + 1], R = bmp[i + 2]; return R + 12 >= Math.min(G, B); };
  const colItem = (x, t, b) => { let c = 0; for (let y = t; y <= b; y++) if (isItem(x, y)) c++; return c / (b - t + 1); };
  const rowItem = (y, l, r) => { let c = 0; for (let x = l; x <= r; x++) if (isItem(x, y)) c++; return c / (r - l + 1); };
  const FL = 0.06; // an adjacent line needs at least this fraction of item pixels to keep growing
  while (xL > 0 && colItem(xL - 1, yT, yB) > FL) xL--;
  while (xR < w - 1 && colItem(xR + 1, yT, yB) > FL) xR++;
  while (yT > 0 && rowItem(yT - 1, xL, xR) > FL) yT--;
  while (yB < h - 1 && rowItem(yB + 1, xL, xR) > FL) yB++;
  const nl = Math.max(0, xL - margin), nr = Math.min(w, xR + 1 + margin);
  const nt = Math.max(0, yT - margin), nb = Math.min(h, yB + 1 + margin);
  const nw = nr - nl, nh = nb - nt;
  if (nw >= 24 && nh >= 24 && (nw < w || nh < h)) return image.crop({ x: nl, y: nt, width: nw, height: nh });
  return image;
}

function readConfig(configDir) {
  try { return JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8")); }
  catch { return {}; }
}

/** Start the opt-in capture loop. `configDir` = the %APPDATA%/sc-blueprint-tracker dir.
 *  `onStatus(s)` (optional) reports OCR activity to the overlay: {state} for
 *  off/idle/watching/settling, {state:"mission",title},
 *  {state:"captured",name,uploaded,queued} (uploaded:true = confirmed on the site; queued:true =
 *  saved locally + retrying, NOT done yet), {state:"shared",name,pending} (a queued upload finally
 *  landed on the site), {state:"have",name} (recognized, but the site already has the image —
 *  skipped), {state:"render",name,stuck} (recognized, waiting for the 3D render — stuck:true once
 *  it's clear the render won't load, e.g. quantum drives / ship components that show no lit model),
 *  or {state:"unresolved",nameRaw} (in the kiosk but the item couldn't be identified). */
function startFabCapture({ port, configDir, onStatus, devTools = false }) {
  sidecarPort = port;   // so an OCR failure reported from module scope knows where to send it
  const captureDir = path.join(configDir, "fab-captures");
  const shotsDir = path.join(configDir, "fab-shots"); // full uncropped frames (mineable)
  // 🔑 TWO alternating names, never one. Writing the full frame to a single fixed path collided
  // with the sidecar's warm OCR worker still holding the PREVIOUS tick's file open: measured
  // 2026-08-08, exactly 25 of 50 mining ticks threw "UNKNOWN: unknown error, open …\sc-fab-shot.png"
  // after blocking ~1s on the open. Half of all ticks produced no read at all, which read as "the
  // scanner just sits there" rather than as an error, because this process has no console.
  // Six of them, rotated. Two was NOT enough — measured after that change, 14 of 33 full-glance
  // ticks still threw on BOTH names, so the worker holds a file well past the following tick.
  // Six slots at ~1-4s a tick means a name is reused minutes later, and the count stays bounded
  // (no unlink to fail, no temp dir to fill).
  const tmpShots = Array.from({ length: 6 }, (_, i) => path.join(os.tmpdir(), `sc-fab-shot-${i}.png`));
  let tmpShotIdx = 0;
  const tmpPanel = path.join(os.tmpdir(), "sc-fab-panel.png"); // upper-right crop fed to RapidOCR
  const tmpMiningCrop = path.join(os.tmpdir(), "sc-mining-crop.png"); // scan-region crop fed to RapidOCR
  const tmpContractCrop = path.join(os.tmpdir(), "sc-contract-crop.png"); // offers-panel crop fed to RapidOCR
  let busy = false;
  let busyAt = 0;             // when the current tick set busy (watchdog against a wedged loop)
  const TICK_WATCHDOG_MS = 15000; // if a tick has "held" busy this long, it hung — force re-arm
  const FETCH_TIMEOUT_MS = 8000;  // any single request must give up so it can't latch the loop
  const DRAIN_MS = 6000;          // how often the retry-upload loop drains captured-but-unshared items
  let lastContext = "";
  // Context = the steady on-screen state (off/idle/watching/fabricator); reported only on change,
  // drives the overlay diamond (fabricator -> gold). Events (settling/captured/mission) are discrete
  // and fire every time without disturbing the context.
  const emitContext = (state) => { if (state !== lastContext) { lastContext = state; onStatus?.({ state }); } };
  const emitEvent = (s) => { onStatus?.(s); };
  let lastMission = "";       // last mission title sent (throttle screen-read posts)
  let lastUnresolved = "";    // last unreadable kiosk item flagged (throttle the "can't read" note)
  let unresolvedTries = 0;    // consecutive polls a kiosk was on screen but unreadable
  let lastHave = "";          // last already-on-site item flagged (throttle the "already have" note)
  let lastRenderWait = "";    // last item stuck waiting on its render (throttle the "waiting" note)
  let renderTries = 0;        // consecutive polls the current item failed the render check
  let renderStuck = false;    // we've already told the user this item's render won't load
  let pendingItem = null;     // item seen earlier, awaiting its settle window before capture
  let pendingAt = 0;          // when we FIRST saw it — the settle is a duration, not a poll count
  let fastUntil = 0;          // poll fast until this time (set while the scan HUD is on screen)
  let lastTickMs = 0;         // how long the last poll actually took — the fast rate tunes off it
  let rate = POLL_MS;         // the interval currently armed, so we only re-arm on a real change
  // Where the signature was last actually found, in FULL-FRAME pixels. The configured scan region
  // is a coarse "look roughly here" band — Sub's is 1170x324, of which the number occupies about
  // 400x40 dead centre; the rest is POWER MANAGEMENT / SHLD / MISL / SCM / distances, which cost
  // 16x their area to magnify and supply the stray numbers that get mistaken for signatures (a real
  // read of "6666" came from unrelated cockpit HUD). Once a real signature has been located, crop
  // to THAT instead. Falls back to the configured region the moment the lock goes stale, so losing
  // the number always recovers on its own.
  let sigBox = null, sigBoxAt = 0;
  const SIG_LOCK_MS = 12000;  // a lock older than this is not trusted — the HUD may have moved
  const tickStages = [];      // per-tick stage timings, drained by the heartbeat below
  const TICK_STAGES_MAX = 40; // ~2 minutes of mining ticks; a rolling window, never a transcript
  let lastHeartbeatAt = 0;    // diagnostic liveness ping while an intermittent mining-loop hang
  const HEARTBEAT_MS = 15000; // is still being tracked down — see the comment at the call site.
  //                             Safe to remove once that's understood; harmless (one small POST
  //                             every ~15s) to leave in until then.
  // Unreadable kiosk panels already sent for diagnosis, keyed by the raw text OCR did manage —
  // which is what distinguishes one failure from the same one seen again a second later. Session
  // only, and capped: this is a diagnostic sample, not a feed.
  const unreadSent = new Set();
  let unreadDisabled = false;   // set when the site answers 404 — the route is not deployed
  const UNREAD_MAX = 5;
  const uploaded = new Set(); // items pushed to the site this session
  const pendingUploads = new Map(); // item UUID -> display name|null: captured locally but NOT yet
  //                                   confirmed on the site; the drain loop retries until it lands
  let drainBusy = false;      // guard for the independent upload-drain loop
  let seededPending = false;  // have we reconciled the local capture folder vs the site's have-list?
  let remoteHave = null;      // set of items the site already has (dedup)
  let remoteHaveAt = 0;       // when remoteHave was last fetched
  // If the site rejects the sync token (401), pause upload retries until the token changes.
  let blockedToken = "";
  let authNotifiedToken = "";
  const REMOTE_TTL_MS = 3 * 60_000; // re-fetch the site's have-list this often

  const clearTokenBlockIfChanged = (token) => {
    if (blockedToken && token && token !== blockedToken) {
      blockedToken = "";
      authNotifiedToken = "";
    }
  };

  // What does the site already have? Skip capturing those. Re-fetched every REMOTE_TTL_MS so a
  // server-side delete/replace (or a failed upload) becomes capturable again WITHOUT restarting.
  async function ensureRemoteHave() {
    if (remoteHave && Date.now() - remoteHaveAt < REMOTE_TTL_MS) return remoteHave;
    try {
      const r = await fetch(`${SITE}/api/sc/fab-needed`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const j = await r.json();
      remoteHave = new Set(Array.isArray(j.have) ? j.have : []);
      remoteHaveAt = Date.now();
      // Forget session-uploads the server no longer has (deleted or upload failed) so they retry.
      for (const it of uploaded) if (!remoteHave.has(it)) uploaded.delete(it);
    } catch { if (!remoteHave) remoteHave = new Set(); }
    return remoteHave;
  }

  async function upload(item, jpeg, token) {
    try {
      const r = await fetch(`${SITE}/api/sc/fab-image?item=${encodeURIComponent(item)}`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", Authorization: `Bearer ${token}` },
        body: jpeg,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (r.ok) { uploaded.add(item); remoteHave?.add(item); return "ok"; }
      if (r.status === 401) {
        blockedToken = token;
        if (authNotifiedToken !== token) {
          authNotifiedToken = token;
          emitEvent({ state: "auth", reason: "invalid_token" });
        }
        console.error(`[fab-capture] upload ${item} -> HTTP 401 (invalid sync token)`);
        return "auth";
      }
      console.error(`[fab-capture] upload ${item} -> HTTP ${r.status}`);
    } catch (e) { console.error("[fab-capture] upload error:", e && e.message); }
    return "retry";
  }

  async function tick() {
    const cfg = readConfig(configDir);
    clearTokenBlockIfChanged(cfg.syncToken || "");
    // Two independent opt-ins share one screen-read: image capture and pinned-mission OCR.
    // Either one arms the loop; each read is then gated by its own flag below.
    const fab = cfg.fabCapture === true;
    const miss = cfg.missionOcr === true;
    // Offer to tick blueprints the kiosk shows that we have no record of. Its own opt-in,
    // and enough on its own to justify arming the loop — it needs no upload and no token.
    const claim = cfg.fabClaim === true;
    // The Mining Assistant (refinery timers + signature scanner) also reads the screen;
    // refinery/mineable reads are routed to its tracker server-side in /api/screen-read.
    // 🔑 The opt-in alone is NOT enough — the widget also has to be able to use the answer.
    // This used to read the screen whenever `miningAssistant` was ticked, so a closed scanner
    // kept OCRing every tick forever, which is work nobody asked for and nobody could see.
    // Same rule as the widgets themselves: an invisible widget does no work beyond whatever is
    // needed to un-hide itself — hence `miningAutoShow`, which is exactly that exception: with
    // auto-show armed the scanner is closed ON PURPOSE and needs the read to pop itself open.
    const mining = cfg.miningAssistant === true
      && (cfg.miningOpen === true || cfg.miningAutoShow === true);
    // The foreground watcher is only worth running while something here is armed — with all three
    // opt-ins off this loop does nothing but re-read a config file every 3s, and shouldn't be
    // keeping a helper process alive to do it.
    // The contract-board payout scanner. Its own opt-in, and enough on its own to arm the
    // loop: it needs no upload path of its own (the sidecar queues and flushes) and it
    // reads the SAME full-frame OCR every other consumer here already takes — the parsing
    // happens server-side in /api/screen-read, so nothing extra is captured for it.
    // Requires a calibrated panel; without one the parser cannot separate the columns and
    // arming the loop would burn OCR for nothing.
    const payout = cfg.payoutScan === true && !!cfg.contractRegion;
    fgWatch.want("ocr", fab || miss || mining || claim || payout);
    if (!fab && !miss && !mining && !claim && !payout) { emitContext("off"); return; }
    // Watchdog: a single hung await (e.g. a fetch to the sidecar while it's restarting during an
    // auto-update) must never latch the loop forever. If a prior tick has held `busy` well past
    // any real tick, treat it as wedged and re-arm — otherwise the overlay freezes on its last
    // message ("Reading the fabricator…") until the app restarts.
    if (busy) {
      if (Date.now() - busyAt < TICK_WATCHDOG_MS) return;
      console.warn("[fab-capture] tick watchdog: a prior tick hung — re-arming the loop");
      busy = false;
    }
    const tFg = Date.now();
    const fg = await foregroundWindow();
    if (!/^StarCitizen$/i.test(fg.name)) { emitContext("idle"); return; } // only ever look at SC
    busy = true;
    busyAt = Date.now();
    // Per-stage timings for THIS tick. The loop self-tunes off the tick's total cost
    // (floor = lastTickMs * 1.5), so when a tick is slow the "fast" rate stops being fast — which
    // means knowing WHICH stage is expensive decides whether that is fixable. Filled in as the
    // tick proceeds and flushed with the heartbeat, so measuring costs no extra round-trips.
    const stage = { foreground: Date.now() - tFg };
    // A diagnostic liveness ping, for an intermittent mining-loop hang that isn't root-caused yet.
    // sidecar.log carries no per-line timestamps otherwise, which made a real hang indistinguishable
    // from "not at the scanner". Fire-and-forget so a slow/dead sidecar can never add latency to the
    // real tick. If this stops appearing in sidecar.log, the tick loop itself is wedged (a
    // `busy=true` never cleared, since this sits AFTER that point but before anything that could
    // hang) — if it keeps appearing while mining reads still don't, the freeze is downstream instead.
    if (mining && Date.now() - lastHeartbeatAt > HEARTBEAT_MS) {
      lastHeartbeatAt = Date.now();
      fetch(`http://localhost:${port}/api/heartbeat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate, lastTickMs, fastUntil: fastUntil - Date.now(), ticks: tickStages.splice(0) }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }).catch(() => {});
    }
    try {
      const have = fab ? await ensureRemoteHave() : null; // dedup set only needed for capture
      const t0 = Date.now();
      const cap = await captureGame(fg.rect); // the monitor the GAME is on, not a blind sources[0]
      const shot = cap && cap.image;
      if (!shot) return;
      stage.capture = Date.now() - t0;
      stage.frame = `${cap.width}x${cap.height}`;
      // 🔑 SKIP THE WHOLE-FRAME PASS WHILE ACTIVELY SCANNING. Measured 2026-08-08: encoding the
      // 3440x1440 PNG costs 1,104ms and the Windows OCR over it another 227ms — 1.33s of every
      // 4.6s tick — and for mining it produces nothing but wrong numbers (1922, 8401, 6001, 2006
      // in one session; zero correct reads, while the RapidOCR crop got every one right). It is
      // still the only thing that finds the fabricator kiosk and the pinned mission, so it is
      // skipped rather than removed, and only while a live signature lock says we are at a rock —
      // you cannot be at a kiosk and scanning an asteroid at the same time. The lock expires, so
      // a tick that finds nothing pays the full glance again and everything re-detects normally.
      const locked = mining && sigBox && Date.now() - sigBoxAt < SIG_LOCK_MS;
      let read = { kind: "none" };
      if (!locked) {
        // 🔑 Its OWN try. The two passes must not share fate: a throw here used to abort the whole
        // tick before the mining crop ever ran, so acquiring a NEW rock needed a full glance that
        // both cost 4.5s and failed ~42% of the time — measured expected time-to-first-read ~7.8s,
        // which is exactly the "it took a while to grab that one" report. The glance is a bonus
        // (kiosk + pinned mission); mining must not depend on it succeeding.
        try {
          // Measured separately from the capture on purpose: PNG-encoding a 5MP frame is a real
          // cost that reads as "the screen grab is slow" when the two are timed together.
          const t1 = Date.now();
          const tmpShot = tmpShots[tmpShotIdx = (tmpShotIdx + 1) % tmpShots.length];
          fs.writeFileSync(tmpShot, shot.toPNG());
          stage.pngFull = Date.now() - t1;
          // Pass 1 — Windows OCR on the full game frame: the cheap "where am I" glance. It detects
          // the kiosk and serves the mission reads (which work fine on it today).
          const t2 = Date.now();
          const resp = await fetch(`http://localhost:${port}/api/screen-read`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: tmpShot }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          read = await resp.json();
          stage.winOcr = Date.now() - t2;
        } catch (e) {
          stage.glanceError = String((e && e.message) || e).slice(0, 200);
        }
      } else {
        stage.skippedFullFrame = true;
      }
      // ── Contract board: RapidOCR the offers panel ────────────────────────
      // 🔴 WINDOWS OCR IS NOT GOOD ENOUGH FOR THIS PANEL (Sub, 2026-08-11: "Windows OCR is
      // boo-boo"). The first live run proved it on rows that were otherwise perfect: it
      // returned "UNG FAMILY HAULING" for Ling Family Hauling, "ROUGH B READY" for
      // Rough & Ready, "59m SSS" for a 59m 55s timer, and silently dropped a "1M" payout
      // glyph altogether. The giver line is only ~12px tall, which is exactly where that
      // engine falls apart — the same finding the mining scanner already documents (0%
      // correct signatures on Windows OCR, every one right on the RapidOCR crop).
      //
      // So the board gets the dual-engine treatment the fabricator already uses: crop to
      // the calibrated panel, magnify, and re-read with PP-OCR. 2x, not 4x — RapidOCR's
      // cost scales with AREA, and the mining work measured a 4x crop at 6MP costing
      // ~2.9s a tick, which is more than the whole budget for a background scan.
      if (payout && cfg.contractRegion) {
        try {
          const cr = cfg.contractRegion;
          const size = shot.getSize();
          const region = {
            x: Math.round(cr.x * size.width),
            y: Math.round(cr.y * size.height),
            width: Math.round(cr.w * size.width),
            height: Math.round(cr.h * size.height),
          };
          if (region.width > 40 && region.height > 40) {
            const CONTRACT_OCR_SCALE = 2;
            const panelCrop = shot.crop(region);
            const bigPanel = panelCrop.resize({
              width: region.width * CONTRACT_OCR_SCALE,
              height: region.height * CONTRACT_OCR_SCALE,
              quality: "best",
            });
            fs.writeFileSync(tmpContractCrop, bigPanel.toPNG());
            const t5 = Date.now();
            // Back to the CROP's own pixel space before anything downstream sees them —
            // the sidecar treats the crop as the whole panel, so no frame offset applies.
            const lines = (await ocrRapidLines(tmpContractCrop)).map((l) => ({
              text: l.text,
              x: l.x / CONTRACT_OCR_SCALE, y: l.y / CONTRACT_OCR_SCALE,
              w: l.w / CONTRACT_OCR_SCALE, h: l.h / CONTRACT_OCR_SCALE,
            }));
            stage.contractOcr = Date.now() - t5;
            await fetch(`http://localhost:${port}/api/screen-read`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ lines, w: region.width, h: region.height, contractCrop: true,
                onPrimary: cap.onPrimary !== false }),
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
          }
        } catch (e) {
          // Its OWN try, like the glance: a scanning failure must never take down the
          // fabricator/mission read this tick also serves.
          stage.contractError = String((e && e.message) || e).slice(0, 200);
        }
      }

      let renderSrc = shot; // where the item render is cropped FROM (full frame, or the panel below)
      // Pass 2 — dual-engine: once pass 1 says we're at a kiosk, re-read the item NAME with RapidOCR
      // on the upper-right crop. It's far better at the stylized name tokens Windows OCR mangles
      // ("MH1"->"MI-II", "Tier"->"Tie@"). Only runs in a kiosk (rare), so no cost during play.
      if (read.kind === "fabricator" && fab && cfg.rapidOcr !== false) {
        try {
          const panel = rightPanelCrop(shot, cap.width, cap.height);
          fs.writeFileSync(tmpPanel, panel.img.toPNG());
          const lines = await ocrRapidLines(tmpPanel);
          const r2 = await fetch(`http://localhost:${port}/api/screen-read`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lines, w: panel.w, h: panel.h }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          const rr = await r2.json();
          if (rr.kind === "fabricator" && rr.item) { read = rr; renderSrc = panel.img; } // rr.crop is panel-relative
        } catch (e) { console.warn("[fab-capture] RapidOCR re-read failed, using Windows OCR:", e && e.message); }
      }
      // Pass 3 — same dual-engine idea, for the mining signature: once pass 1 says the scanner is
      // up (its own HUD text, or a signature already parsed), re-read JUST the configured scan
      // region with RapidOCR. Windows OCR mangles this number often enough that most scans never
      // produced a candidate to classify at all (Rytharr, 2026-08-07) — the same class of problem
      // Pass 2 already exists to solve for the kiosk. Cropped tight to the region rather than the
      // whole frame, so it's cheap even at the fast poll rate while actively scanning.
      // 🔑 NO Pass-1 PRECONDITION ANY MORE. This gate used to require `read.scanHud` or a Pass-1
      // signature — both of which come from the whole-frame Windows OCR, i.e. the pass that is now
      // skipped while locked and that fails outright ~42% of the time otherwise. Gating the ONLY
      // trustworthy mining reader behind the least trustworthy one is backwards: RapidOCR got every
      // signature right in a measured session while Windows OCR got none. If mining is armed, look.
      if (mining && cfg.rapidOcr !== false) {
        try {
          const full = scanRegionPixels(cfg.scanRegion, cap.width, cap.height);
          // Narrow to where the number actually was, when we know. Clamped inside `full`, so this
          // only ever shrinks the search — it can never look outside what the user configured.
          const region = locked ? tightenRegion(full, sigBox) : full;
          const crop = shot.crop(region);
          // Magnify BEFORE OCR-ing, not for the player — this crop never touches the screen, it
          // only feeds the OCR engine. The signature text is ~19px tall in the raw crop; both OCR
          // engines are tuned on normal document-scale text and read small, thin HUD digits far
          // less reliably than the same shapes several times larger (6-vs-8 confusion especially —
          // the difference is a closed vs. open loop that gets much easier to resolve once it's not
          // a handful of pixels). MINING_OCR_SCALE stays local to this crop; nothing else changes.
          // 🔑 Magnification is spent where it pays. Locked, the crop is ~167x60, so 4x is only
          // 0.16MP and the extra detail is nearly free — worth having, since 6-vs-8 is a closed-vs-
          // open loop that needs the pixels. UNLOCKED, the crop is the whole configured band
          // (1170x324 on Sub's setup) and 4x makes it 6.07MP — larger in area than the full screen
          // it was meant to be cheaper than, at ~2.9s a tick. 2x keeps acquisition legible at a
          // quarter of the cost; once a signature is found the lock hands us the tight crop and the
          // detail comes back.
          const MINING_OCR_SCALE = locked ? 4 : 2;
          const t3 = Date.now();
          const big = crop.resize({
            width: region.width * MINING_OCR_SCALE,
            height: region.height * MINING_OCR_SCALE,
            quality: "best",
          });
          fs.writeFileSync(tmpMiningCrop, big.toPNG());
          // 🔑 The magnified pixel COUNT is the number that matters — RapidOCR is PP-OCR, a
          // detection net whose cost scales with area, so 4x linear is 16x the work. Recorded so
          // the scale factor can be chosen by measurement instead of by feel.
          stage.cropPrep = Date.now() - t3;
          stage.cropPx = `${region.width * MINING_OCR_SCALE}x${region.height * MINING_OCR_SCALE}`;
          stage.scale = MINING_OCR_SCALE;
          stage.region = `${region.width}x${region.height}@${region.x},${region.y}`;
          // Opt-in capture of the EXACT bitmap the OCR was handed. Reading the parsed text tells
          // you what the engine decided; only the image tells you what it was looking at — whether
          // the number was even in the crop, how much unrelated HUD came with it, and whether the
          // magnification is helping or just costing. Kept to a small rolling set of files.
          if (devTools && cfg.miningDebug === true) { try { saveDebugFrame(big, crop); } catch { /* best effort */ } }
          const t4 = Date.now();
          const lines = (await ocrRapidLines(tmpMiningCrop)).map((l) => ({
            text: l.text,
            x: l.x / MINING_OCR_SCALE, y: l.y / MINING_OCR_SCALE,
            w: l.w / MINING_OCR_SCALE, h: l.h / MINING_OCR_SCALE,
          })); // back to the ORIGINAL crop's pixel space before anything downstream sees them
          stage.rapidOcr = Date.now() - t4;
          const r3 = await fetch(`http://localhost:${port}/api/screen-read`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lines, w: region.width, h: region.height, miningCrop: true }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          const rr3 = await r3.json();
          // rr3's pin/text are CROP-relative (the sidecar has no idea where in the full frame this
          // crop came from) — translate back to full-frame pixels before anything downstream uses
          // them against `shot`, which is the uncropped bitmap.
          if (rr3.kind === "mineable" && typeof rr3.signature === "number" && rr3.pin && rr3.text) {
            const shift = (r) => ({ x: r.x + region.x, y: r.y + region.y, w: r.w, h: r.h });
            read = { ...read, kind: "mineable", signature: rr3.signature, raw: rr3.raw,
              pin: shift(rr3.pin), text: shift(rr3.text) };
            // Re-arm the lock from where the number REALLY is. Refreshed on every hit, so a HUD
            // that drifts (head movement, resolution change) is tracked rather than lost.
            sigBox = shift(rr3.text);
            sigBoxAt = Date.now();
          } else if (locked) {
            // Locked but the tight crop found nothing — drop the lock so the NEXT tick searches the
            // full region again. Without this a single bad lock could keep re-cropping empty space
            // and the scanner would go quiet until the timeout, every time.
            sigBox = null;
          }
        } catch (e) { console.warn("[fab-capture] mining RapidOCR re-read failed, using Windows OCR:", e && e.message); }
      }
      // Cadence. Scanning ore is a live feedback loop: you shoot a rock and want to hear what it
      // is immediately, so while the scan HUD is on screen the loop runs at FAST_MS. Everything
      // else — and the fabricator ABOVE ALL — stays at the slow rate, because rushing a kiosk
      // risks grabbing a render mid-fade. A kiosk frame cancels fast mode outright.
      if (read.kind === "fabricator") fastUntil = 0;
      // 🔑 A PARSED SIGNATURE IS THE PROOF, not the HUD's wording. Fast mode used to arm only on
      // read.scanHud — an OCR text match for "scanning / ready to scan / strong / moderate /
      // weak". That is the mining scanner's vocabulary, and the line it comes from is USER
      // CONFIGURABLE: a player can restyle that HUD element or switch it off entirely, and head
      // position can carry it out of frame (Sub, in a Vulture, 2026-08-03 — the loop sat at 3s
      // while he was actively scanning). Same mistake as the absolute glyph colour: keying on
      // something that varies per player when a universal signal is right there.
      //
      // The signature number and its pin are the universal part — same place, same shape, in
      // every ship; only the colour changes. So a frame that yielded a signature IS a frame where
      // the player is scanning, whatever the HUD says or doesn't. scanHud is KEPT as an
      // additional trigger because it fires on "ready to scan", i.e. slightly BEFORE the first
      // number exists — useful when it happens to be there, never required.
      else if (mining && (read.scanHud || typeof read.signature === "number")) fastUntil = Date.now() + FAST_WINDOW_MS;
      // Self-tuning, because this runs over a RUNNING GAME and a fixed rate is a guess about
      // someone else's PC. A tick costs a screen grab plus an OCR (~230ms on Sub's machine with
      // the warm worker, but a slower box could be several times that). Never let the loop occupy
      // more than about two thirds of the time — on a fast machine that lands on FAST_MS, on a
      // slow one it backs off by itself instead of stealing frames from the game.
      const floor = Math.max(FAST_MS, Math.round(lastTickMs * 1.5));
      const want = Date.now() < fastUntil ? floor : POLL_MS;
      if (want !== rate) {
        rate = want;
        clearInterval(timer);
        timer = setInterval(tick, rate);
        timer.unref?.();
        console.log(`[fab-capture] poll ${rate}ms${rate === FAST_MS ? " (scanning)" : ""}`);
      }

      // A mining signature: the sidecar deliberately does NOT act on it until we've checked the
      // frame for the scan glyph beside the number — it has the OCR but not the pixels.
      if (read.kind === "mineable" && typeof read.signature === "number" && read.pin) {
        const glyph = findScanGlyph(shot, read.pin, read.text);
        try {
          // The measurements go WITH the verdict so the SIDECAR logs them. This process is a
          // detached GUI app — its stdout goes nowhere, so logging here wrote the numbers into
          // the void, which is exactly what happened to the ones asked for to tune the
          // thresholds. sidecar.log is the file a user can actually read and send.
          await fetch(`http://localhost:${port}/api/mining/scan`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signature: read.signature,
              confirmed: glyph.seen,
              // `ref` (the number's own calibration ink/lum/floor) was computed by findScanGlyph but
              // never forwarded — the sidecar's log line already knows how to print it, so a miss
              // could never be told apart from "wrong hue" vs "not bright enough" without it.
              glyph: { fraction: glyph.fraction, total: glyph.total, mean: glyph.mean, hitMean: glyph.hitMean, ref: glyph.ref },
              // For the "scan read area" outline: the text the OCR actually saw, and where/how big
              // it was. Sent as the raw frame rect plus the frame size, because only this process
              // knows the captured frame's dimensions — the sidecar turns it into fractions.
              raw: read.raw,
              text: read.text,
              // The poll rate RIDES ALONG rather than getting its own channel or its own log
              // line. capture.cjs runs in the detached GUI process, whose stdout goes nowhere —
              // the "[fab-capture] poll 900ms" line below has never reached a file anyone can
              // read, which is why "it feels slower in this ship" could not be checked. Now every
              // scan says what cadence it was polling at, in sidecar.log, next to its verdict.
              pollMs: rate,
              scanHud: read.scanHud === true,
              frame: { w: shot.getSize().width, h: shot.getSize().height },
            }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
        } catch (e) { console.warn("[mining] scan post failed:", e && e.message); }
      }
      // A kiosk on screen -> "fabricator" context (gold diamond) even if image capture is off;
      // anything else while watching -> "watching".
      emitContext(read.kind === "fabricator" ? "fabricator" : "watching");
      if (read.kind !== "fabricator") { lastUnresolved = ""; unresolvedTries = 0; lastHave = ""; lastRenderWait = ""; } // left the kiosk
      if (read.kind === "fabricator" && read.item) {
        lastUnresolved = ""; unresolvedTries = 0;
        // Claim prompt: the kiosk only lists blueprints you OWN, so a blueprint here that the
        // tracker has no record of is ownership the log never reported (a receipt that predates
        // the install, or one whose logbackup has rotated away). Offer to tick it.
        // 🔑 Deliberately BEFORE the `!fab` return: this is its own opt-in and needs neither an
        // upload nor a sync token, so it must work with image capture switched off.
        if (claim) {
          try {
            await fetch(`http://localhost:${port}/api/fab/seen`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ item: read.item, items: read.items || [], name: read.name || "" }),
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
          } catch (e) { console.warn("[fab-claim] seen post failed:", e && e.message); }
        }
        if (!fab) { pendingItem = null; return; } // image capture disabled — ignore kiosk frames
        const item = read.item; // canonical UUID — settle key + local file name
        // One display name can map to several distinct same-named items (e.g. the 3 sizes of
        // "Cinch Scraper Module"); the log/kiosk can't say which, so they share one image.
        // Capture as long as ANY sibling still lacks it, and upload to every missing one.
        const targets = Array.isArray(read.items) && read.items.length ? read.items : [item];
        const missing = targets.filter((t) => !uploaded.has(t) && !have.has(t));
        // Dedup: every sibling already covered (uploaded this session or the site has it).
        // Surface it once so the user sees it was recognized but there's nothing to capture.
        if (missing.length === 0) {
          pendingItem = null;
          if (item !== lastHave) { lastHave = item; emitEvent({ state: "have", name: read.name }); }
          return;
        }
        // Settle: the kiosk's 3D render fades in over ~1-2s, so a first-glimpse capture
        // can come out half-loaded / see-through. Require the item to still be on screen
        // SETTLE_MS later before capturing, giving the render time to finish.
        // 🔑 Measured in TIME, not in polls. It used to be "still there a poll later", which
        // silently meant ~3s only because the loop ticked every 3s — the moment the loop speeds
        // up for ore scanning, a poll-based settle would start grabbing kiosk renders mid-fade.
        // Sub's rule: going faster for mining must not change anything at the terminal.
        if (pendingItem !== item) {
          pendingItem = item;
          pendingAt = Date.now();
          renderTries = 0; renderStuck = false; // fresh item — reset the render-stuck tracking
          emitEvent({ state: "settling", name: read.name });
          console.log(`[fab-capture] ${read.name}: waiting for render to settle`);
          return;
        }
        // Still inside the settle window (a fast mining cadence can bring us back here in <1s).
        if (Date.now() - pendingAt < SETTLE_MS) return;
        const c = read.crop;
        // Crop the render from whichever frame produced `read` — the panel crop (RapidOCR path,
        // its crop is panel-relative) or the full frame (Windows OCR path).
        const cropped = centerTighten(renderSrc.crop({ x: c.x, y: c.y, width: c.w, height: c.h }));
        if (!hasRender(cropped)) {
          renderTries++;
          // Some items (quantum drives + certain ship components) show a dark schematic in the
          // kiosk, not a lit 3D model, so the render check never passes — the loop would otherwise
          // sit on "waiting for render…" forever. After several polls, report it as STUCK so the
          // widget can tell the user this item can't be captured, instead of looking like it's loading.
          const stuck = renderTries >= 4;
          if (item !== lastRenderWait) { lastRenderWait = item; emitEvent({ state: "render", name: read.name, stuck: false }); }
          if (stuck && !renderStuck) { renderStuck = true; emitEvent({ state: "render", name: read.name, stuck: true }); }
          console.log(`[fab-capture] ${read.name}: render not loaded (try ${renderTries})${stuck ? " — giving up: no capturable render" : ", will retry"}`);
          return; // keep pendingItem so the next poll retries
        }
        lastRenderWait = ""; renderTries = 0; renderStuck = false;
        // Opaque teal kiosk background -> JPEG (small, fits the ingest cap).
        const jpeg = cropped.toJPEG(82);
        fs.mkdirSync(captureDir, { recursive: true });
        fs.writeFileSync(path.join(captureDir, `${item}.jpg`), jpeg);
        // Keep the FULL uncropped frame too — it carries the materials list, stats,
        // fabrication time + recipe we may mine later. One per item.
        fs.mkdirSync(shotsDir, { recursive: true });
        fs.writeFileSync(path.join(shotsDir, `${item}.jpg`), shot.toJPEG(85));
        let uploadedOk = false;
        let authFail = false;
        if (cfg.syncToken) {
          if (blockedToken && cfg.syncToken === blockedToken) {
            authFail = true;
            if (authNotifiedToken !== cfg.syncToken) {
              authNotifiedToken = cfg.syncToken;
              emitEvent({ state: "auth", reason: "invalid_token" });
            }
            // Token is known bad; queue locally and wait for a re-link rather than hammering.
            missing.forEach((t) => pendingUploads.set(t, read.name));
          } else {
            // Share the one capture across every sibling that still lacks it (name collision).
            const oks = await Promise.all(missing.map((t) => upload(t, jpeg, cfg.syncToken)));
            uploadedOk = oks.every((v) => v === "ok");
            authFail = oks.some((v) => v === "auth");
            // Any sibling whose upload didn't land: keep the local JPEG and QUEUE it. The drain loop
            // retries from disk until the server has it, so a transient failure (or a wedge) can't
            // leave a captured item silently unshared — and the user isn't told "done" when it isn't.
            missing.forEach((t, i) => { if (oks[i] !== "ok") pendingUploads.set(t, read.name); });
          }
          const label = missing.length > 1 ? `${read.name} (${missing.length} sizes)` : `${read.name} (${item})`;
          if (authFail) console.log(`[fab-capture] sync token invalid — queued locally until relink (${label})`);
          else console.log(`[fab-capture] ${uploadedOk ? "uploaded" : "upload failed — queued for retry"} ${label}`);
        } else {
          console.log(`[fab-capture] saved ${read.name} (${item}) — no sync token, not uploaded`);
        }
        // uploaded:true  => confirmed on the site. queued:true => saved + retrying (NOT done yet).
        emitEvent({ state: "captured", name: read.name, uploaded: uploadedOk, queued: !uploadedOk && !!cfg.syncToken });
        if (authFail) emitEvent({ state: "auth", reason: "invalid_token" });
      } else if (read.kind === "fabricator" && fab) {
        // In the kiosk with image capture on, but the item name didn't resolve to a known
        // blueprint (still rendering in, or an item not in our dataset) — so there's nothing
        // to tag a capture with. Surface it once per item so the user knows why no picture
        // was taken, rather than the loop failing silently.
        pendingItem = null;
        unresolvedTries++;
        const raw = (read.nameRaw || "").trim();
        // Require the unreadable state to persist a poll before warning, so a kiosk that's just
        // mid-load (the name/render still fading in) doesn't flash a false "couldn't read".
        if (unresolvedTries >= 2 && raw !== lastUnresolved) {
          lastUnresolved = raw;
          emitEvent({ state: "unresolved", nameRaw: raw });
          console.log(`[fab-capture] kiosk item not identified${raw ? `: "${raw}"` : ""}`);
        }
        // 🔑 A FAILED READ IS THE ONLY EVIDENCE OF WHY IT FAILED, and today it is thrown away —
        // so every "it doesn't capture my items" report has to be re-lived over someone's stream
        // instead of read off a frame. Send the panel we could not parse, so the failure can be
        // diagnosed from the picture that caused it.
        //
        // Three deliberate limits, because this is the app uploading a picture of the screen:
        //  · the RIGHT PANEL crop only, never the frame — that is the surface OCR read, and it
        //    leaves the rest of the screen (chat, org names, whoever else is standing there) out
        //    of it entirely.
        //  · the SAME opt-ins as an ordinary capture — image capture ON plus a sync token. Nobody
        //    who has not already agreed to contribute captures sends anything.
        //  · rate-limited hard: one per distinct unreadable text, capped per session. A player
        //    standing at a kiosk would otherwise post one every three seconds.
        if (unresolvedTries >= 3 && cfg.syncToken && !blockedToken && !unreadDisabled
            && unreadSent.size < UNREAD_MAX && !unreadSent.has(raw)) {
          unreadSent.add(raw);
          try {
            const panel = rightPanelCrop(shot, cap.width, cap.height);
            const jpeg = panel.img.toJPEG(72);
            const r = await fetch(`${SITE}/api/sc/fab-unread?raw=${encodeURIComponent(raw.slice(0, 120))}`, {
              method: "POST",
              headers: { "Content-Type": "image/jpeg", Authorization: `Bearer ${cfg.syncToken}` },
              body: jpeg,
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            // 🔑 A 404 means the site route is not deployed yet — so STOP for the session rather
            // than posting a screenshot per unreadable panel to an endpoint that cannot store it.
            // Inert either way, but sending an image nobody receives is not free, and shipping the
            // client ahead of its backend is exactly the state this release is in.
            if (r.status === 404) { unreadSent.clear(); unreadDisabled = true; }
            if (!r.ok) console.log(`[fab-capture] unread frame -> HTTP ${r.status} (not stored)`);
          } catch (e) { console.warn("[fab-capture] unread frame upload failed:", e && e.message); }
        }
      } else if (read.kind === "mission" && miss && read.titleRaw && read.titleRaw !== lastMission) {
        // Tell the tracker which mission is pinned in-game (ground truth the log lacks).
        lastMission = read.titleRaw;
        emitEvent({ state: "mission", title: read.titleRaw });
        try {
          await fetch(`http://localhost:${port}/api/missions/screen`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: read.titleRaw }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
        } catch { /* best effort */ }
      }
    } catch (e) {
      console.error("[fab-capture] tick error:", e && e.message);
      // 🔑 Carried on the tick record, not just console.error'd. This process is a detached GUI
      // child with no stdout, so a throw here is INVISIBLE — which is exactly how half of a
      // measured run came back with only the `capture` stage filled in and no explanation
      // (Sub, 2026-08-08). A stage that stops recording is a symptom; the message is the cause.
      stage.error = String((e && e.message) || e).slice(0, 300);
    } finally {
      lastTickMs = Date.now() - busyAt;
      // Buffered, not posted per tick — a round-trip inside the very loop being measured would
      // change the number it is trying to report. The heartbeat drains this.
      if (mining) {
        tickStages.push({ total: lastTickMs, ...stage });
        if (tickStages.length > TICK_STAGES_MAX) tickStages.shift();
      }
      busy = false;
    }
  }

  // Independent upload-drain loop. Uploads captured-but-unconfirmed items from their saved local
  // JPEGs until the server actually has them — decoupled from the screen-read tick and its busy
  // flag, so it drains even while the user is off the kiosk (no re-scan needed). On the FIRST pass
  // it reconciles the whole fab-captures folder against the site's have-list, so captures stranded
  // by a past failure/wedge self-heal on the next launch instead of being silently lost.
  async function drainPending() {
    const cfg = readConfig(configDir);
    clearTokenBlockIfChanged(cfg.syncToken || "");
    if (cfg.fabCapture !== true || !cfg.syncToken) return; // needs opt-in + a token to upload
    if (blockedToken && cfg.syncToken === blockedToken) return; // known bad token; wait for re-link
    if (drainBusy) return;
    drainBusy = true;
    try {
      const have = await ensureRemoteHave();
      if (!seededPending) {
        seededPending = true;
        try {
          for (const f of fs.readdirSync(captureDir)) {
            if (!f.endsWith(".jpg")) continue;
            const it = f.slice(0, -4);
            if (!have.has(it) && !uploaded.has(it) && !pendingUploads.has(it)) pendingUploads.set(it, null);
          }
        } catch { /* no captures dir yet */ }
        if (pendingUploads.size) console.log(`[fab-capture] reconcile: ${pendingUploads.size} local capture(s) not on the server — uploading`);
      }
      for (const [it, name] of [...pendingUploads]) {
        if (have.has(it) || uploaded.has(it)) { pendingUploads.delete(it); continue; } // already there
        let jpeg;
        try { jpeg = fs.readFileSync(path.join(captureDir, `${it}.jpg`)); }
        catch { pendingUploads.delete(it); continue; } // local file gone — nothing to retry
        const st = await upload(it, jpeg, cfg.syncToken);
        if (st === "ok") {
          pendingUploads.delete(it);
          emitEvent({ state: "shared", name, pending: pendingUploads.size });
          console.log(`[fab-capture] retry uploaded ${name || it} (${pendingUploads.size} still pending)`);
        } else if (st === "auth") {
          return; // token invalid: stop retry churn until token changes
        }
      }
    } catch (e) {
      console.error("[fab-capture] drain error:", e && e.message);
    } finally {
      drainBusy = false;
    }
  }

  let timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  const drainTimer = setInterval(drainPending, DRAIN_MS);
  drainTimer.unref?.();
  console.log("[fab-capture] loop armed (opt-in via config.fabCapture)");
  return () => { clearInterval(timer); clearInterval(drainTimer); };
}

module.exports = { startFabCapture, centerTighten, findScanGlyph, GLYPH };
