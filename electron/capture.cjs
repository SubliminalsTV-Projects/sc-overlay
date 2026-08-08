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
  return src ? { image: src.thumbnail, width, height } : null;
}

// The kiosk's item render + name + category all live in the upper-right of the screen. Cropping to
// it before RapidOCR both (a) stops PP-OCR fusing the left material panel into the name and (b)
// speeds the read up. Fractions are of the captured GAME display (the fabricator is a fullscreen UI).
function rightPanelCrop(image, w, h) {
  const x = Math.round(w * 0.5);
  const cw = w - x, ch = Math.round(h * 0.72);
  return { img: image.crop({ x, y: 0, width: cw, height: ch }), w: cw, h: ch };
}

// RapidOCR (PP-OCR) reader — main-process only, ESM loaded lazily (model loads once, ~2s). Returns
// the same {text,x,y,w,h} line shape the sidecar classifier expects, from the PP-OCR {text,box}.
let _rapid = null;
function getRapid() {
  if (!_rapid) _rapid = import("@gutenye/ocr-node").then((m) => m.default.create());
  return _rapid;
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
  /** Saturation floor — (max−min)/max of a pixel's RGB — for it to count as pin ink rather than
   *  the achromatic pill background or the (measured: near-white) number text. 0.18 sits with
   *  clear margin above both real measured cases (white number ≈0.02–0.05, dark pill background
   *  ≈0.05 once luminance noise at near-black is excluded by the floor below) and clear margin
   *  below real pin ink (≈0.3+ even blended 50% into space or a lit rock). */
  minSaturation: 0.18,
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
  let hits = 0, sr = 0, sg = 0, sb = 0, hr = 0, hg = 0, hb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      sr += r; sg += g; sb += b;
      const lum = 0.114 * b + 0.587 * g + 0.299 * r;
      if (lum >= lumFloor && saturation(r, g, b) >= GLYPH.minSaturation) {
        hits++; hr += r; hg += g; hb += b;
      }
    }
  }
  const fraction = hits / total;
  return {
    seen: fraction >= GLYPH.minFraction,
    fraction: Math.round(fraction * 1000) / 1000,
    total,
    mean: [Math.round(sr / total), Math.round(sg / total), Math.round(sb / total)],
    hitMean: hits ? [Math.round(hr / hits), Math.round(hg / hits), Math.round(hb / hits)] : null,
    // Logged so a HUD that still fails can be diagnosed from a user's sidecar.log without
    // guessing — this is what the old absolute thresholds could never tell us.
    ref: { mean: ink.mean, lum: Math.round(ink.lum), bg: Math.round(ink.bg), lumFloor: Math.round(lumFloor) },
    why: `${hits}/${total} px were bright + saturated enough to count as pin ink`,
  };
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
function startFabCapture({ port, configDir, onStatus }) {
  const captureDir = path.join(configDir, "fab-captures");
  const shotsDir = path.join(configDir, "fab-shots"); // full uncropped frames (mineable)
  const tmpShot = path.join(os.tmpdir(), "sc-fab-shot.png");
  const tmpPanel = path.join(os.tmpdir(), "sc-fab-panel.png"); // upper-right crop fed to RapidOCR
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
    fgWatch.want("ocr", fab || miss || mining || claim);
    if (!fab && !miss && !mining && !claim) { emitContext("off"); return; }
    // Watchdog: a single hung await (e.g. a fetch to the sidecar while it's restarting during an
    // auto-update) must never latch the loop forever. If a prior tick has held `busy` well past
    // any real tick, treat it as wedged and re-arm — otherwise the overlay freezes on its last
    // message ("Reading the fabricator…") until the app restarts.
    if (busy) {
      if (Date.now() - busyAt < TICK_WATCHDOG_MS) return;
      console.warn("[fab-capture] tick watchdog: a prior tick hung — re-arming the loop");
      busy = false;
    }
    const fg = await foregroundWindow();
    if (!/^StarCitizen$/i.test(fg.name)) { emitContext("idle"); return; } // only ever look at SC
    busy = true;
    busyAt = Date.now();
    try {
      const have = fab ? await ensureRemoteHave() : null; // dedup set only needed for capture
      const cap = await captureGame(fg.rect); // the monitor the GAME is on, not a blind sources[0]
      const shot = cap && cap.image;
      if (!shot) return;
      fs.writeFileSync(tmpShot, shot.toPNG());
      // Pass 1 — Windows OCR on the full game frame: the cheap "where am I" glance. It detects the
      // kiosk and serves the mission / mining reads (which work fine on it today).
      const resp = await fetch(`http://localhost:${port}/api/screen-read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tmpShot }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      let read = await resp.json();
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
    } finally {
      lastTickMs = Date.now() - busyAt;
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
