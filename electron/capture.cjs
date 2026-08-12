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
const { getStarCitizenSessionBinder } = require("./linux/star-citizen-session.cjs");
const { createRapidOcrClient } = require("./rapidocr-client.cjs");

const scSession = getStarCitizenSessionBinder();

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

// RapidOCR is isolated in a disposable Node child process. A native sharp/libvips
// assertion can abort that worker, but not Electron or the overlay. The client also
// serializes requests, enforces a hard timeout, and disables RapidOCR for the rest of
// the session after a worker crash; Tesseract continues automatically.
const rapidOcrClient = createRapidOcrClient({ logger: console });
process.once("exit", () => rapidOcrClient.close());

// Return the foreground window process name AND its screen rectangle. On Linux/XWayland,
// query the active X11 window so the privacy gate still guarantees that screenshots are taken
// only while Star Citizen itself is focused.
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
function cleanX11Field(value) {
  const text = String(value || "").trim();
  return /^(?:\(?null\)?|WM_CLASS:\s*not found\.?|[^:]+:\s*not found\.?)$/i.test(text) ? "" : text;
}

// Bind each launch to the exact StarCitizen.exe -> Gamescope ancestor chain. This prevents a
// stale Gamescope process (or the RSI launcher) from arming OCR and avoids hard-coding a PID that
// changes every launch. KWin may still expose an anonymous XWayland root while the real Gamescope
// surface is active; that fallback is accepted only while this exact bound process tree is alive.
function classifyLinuxForeground(values, {
  session = scSession.current(),
  processName = null,
  belongsToSession = (pid) => scSession.belongsToSession(pid, session),
} = {}) {
  const pid = String(values?.PID || "").trim();
  const title = cleanX11Field(values?.TITLE);
  const className = cleanX11Field(values?.CLASS);
  let resolvedProcess = String(processName || "");
  if (!resolvedProcess && /^\d+$/.test(pid)) {
    try { resolvedProcess = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch {}
  }
  const blob = `${title} ${className} ${resolvedProcess}`.trim();
  const boundPid = !!session && /^\d+$/.test(pid) && belongsToSession(Number(pid));
  const gameIdentity = /Star\s*Citizen|StarCitizen(?:\.exe)?|StarCitizen[/\\]LIVE/i.test(blob);
  const gamescopeIdentity = /gamescope(?:-wl)?/i.test(blob);
  const directGame = !!session && (
    (boundPid && (/^StarCitizen(?:\.exe)?$/i.test(resolvedProcess) || gamescopeIdentity || gameIdentity)) ||
    (!pid && gamescopeIdentity && gameIdentity)
  );
  const anonymousXwaylandRoot = !!session && !pid && !blob;
  const x = Number(values?.X), y = Number(values?.Y), w = Number(values?.WIDTH), h = Number(values?.HEIGHT);
  const rect = Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
  const sessionInfo = session ? {
    gamePid: session.gamePid,
    gamescopePid: session.gamescopePid,
    launcherPid: session.launcherPid || null,
  } : null;

  if (directGame) return { name: "StarCitizen", title, className, rect, gate: "pid-bound-active-window", session: sessionInfo };
  if (anonymousXwaylandRoot) {
    // Null deliberately selects the configured primary monitor rather than the 6360x2560 XWayland
    // root. A named browser/terminal/overlay surface never reaches this branch.
    return { name: "StarCitizen", title, className, rect: null, gate: "pid-bound-anonymous-wayland", session: sessionInfo };
  }
  return { name: resolvedProcess, title, className, rect, gate: session ? "not-bound-game-surface" : "no-bound-game-session", session: sessionInfo };
}

function foregroundWindow() {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      try { writeFgPs1(); } catch { return resolve({ name: "", rect: null, gate: "unavailable" }); }
      execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fgPs1], { windowsHide: true, timeout: 4000 }, (err, out) => {
        if (err) return resolve({ name: "", rect: null, gate: "unavailable" });
        const p = String(out).trim().split("|");
        const x = +p[1], y = +p[2], w = +p[3], h = +p[4];
        resolve({ name: p[0] || "", rect: w > 0 && h > 0 ? { x, y, width: w, height: h } : null, gate: "win32-active-window" });
      });
    });
  }

  const session = scSession.current();
  if (!session) return Promise.resolve({ name: "", rect: null, gate: "no-bound-game-session", session: null });
  return new Promise((resolve) => {
    const script = [
      'wid=$(xdotool getactivewindow 2>/dev/null || true)',
      'pid=""; title=""; class=""',
      'if [ -n "$wid" ]; then pid=$(xdotool getwindowpid "$wid" 2>/dev/null || true); title=$(xdotool getwindowname "$wid" 2>/dev/null | tr "\\n" " " || true); class=$(xprop -id "$wid" WM_CLASS 2>/dev/null | tr "\\n" " " || true); fi',
      'printf "PID=%s\\nTITLE=%s\\nCLASS=%s\\n" "$pid" "$title" "$class"',
      'if [ -n "$wid" ]; then xdotool getwindowgeometry --shell "$wid" 2>/dev/null || true; fi',
    ].join('; ');
    execFile("sh", ["-lc", script], { timeout: 2500 }, (_err, out) => {
      const values = {};
      for (const line of String(out || "").split(/\r?\n/)) {
        const m = line.match(/^([A-Z]+)=(.*)$/);
        if (m) values[m[1]] = m[2];
      }
      resolve(classifyLinuxForeground(values, { session }));
    });
  });
}

// Capture the display the GAME window is on (matched by display_id), at that monitor's full
// resolution → nativeImage. KDE Wayland frequently gives Electron an empty/KMS-denied thumbnail;
// the v2 calibration proved Spectacle can capture this exact desktop reliably, so r24 uses it as
// the primary Wayland backend and retains desktopCapturer as the X11/fallback backend.
const spectacleCapturePath = path.join(os.tmpdir(), `sc-overlay-spectacle-${process.pid}.png`);
const HOST_SESSION_TYPE = String(process.env.SC_TRACKER_HOST_XDG_SESSION_TYPE || process.env.XDG_SESSION_TYPE || "").toLowerCase();
const HOST_WAYLAND_DISPLAY = String(process.env.SC_TRACKER_HOST_WAYLAND_DISPLAY || process.env.WAYLAND_DISPLAY || "");
const HOST_IS_WAYLAND = process.platform === "linux" && (HOST_SESSION_TYPE === "wayland" || !!HOST_WAYLAND_DISPLAY);
let lastBackendWarning = "";

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message || err).trim();
        const wrapped = new Error(detail || String(err));
        wrapped.code = err.code;
        return reject(wrapped);
      }
      resolve({ stdout, stderr });
    });
  });
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function captureWarning(message) {
  const text = String(message || "").trim();
  if (!text || text === lastBackendWarning) return;
  lastBackendWarning = text;
  console.warn(`[screen-read] capture backend fallback: ${text}`);
}
function spectacleEnvironment() {
  const env = { ...process.env };
  const copy = (dst, src) => {
    const value = process.env[src];
    if (value) env[dst] = value;
  };
  copy("WAYLAND_DISPLAY", "SC_TRACKER_HOST_WAYLAND_DISPLAY");
  copy("DISPLAY", "SC_TRACKER_HOST_DISPLAY");
  copy("XDG_RUNTIME_DIR", "SC_TRACKER_HOST_XDG_RUNTIME_DIR");
  copy("DBUS_SESSION_BUS_ADDRESS", "SC_TRACKER_HOST_DBUS_SESSION_BUS_ADDRESS");
  if (HOST_IS_WAYLAND) {
    env.XDG_SESSION_TYPE = "wayland";
    env.QT_QPA_PLATFORM = "wayland";
  }
  // These variables are intentionally applied to Electron's software renderer, but inheriting
  // them into a Qt screenshot process can prevent Spectacle from connecting to KWin/Wayland.
  delete env.GDK_BACKEND;
  delete env.ELECTRON_OZONE_PLATFORM_HINT;
  delete env.LIBGL_ALWAYS_SOFTWARE;
  delete env.MESA_LOADER_DRIVER_OVERRIDE;
  delete env.ANGLE_DEFAULT_PLATFORM;
  return env;
}
async function waitForCaptureFile(filePath, timeoutMs = 2500) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (fs.statSync(filePath).size > 0) return true;
    } catch {}
    await delay(100);
  }
  return false;
}
async function captureWithSpectacle(disp) {
  try { fs.unlinkSync(spectacleCapturePath); } catch {}
  await runFile("spectacle", ["-b", "-n", "-o", spectacleCapturePath], {
    timeout: 20_000,
    env: spectacleEnvironment(),
  });
  if (!(await waitForCaptureFile(spectacleCapturePath))) {
    throw new Error("Spectacle returned before a screenshot file became available");
  }
  const full = nativeImage.createFromPath(spectacleCapturePath);
  if (!full || full.isEmpty()) throw new Error("Spectacle created no usable screenshot");

  const displays = screen.getAllDisplays();
  const left = Math.min(...displays.map((d) => d.bounds.x));
  const top = Math.min(...displays.map((d) => d.bounds.y));
  const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const virtualW = Math.max(1, right - left), virtualH = Math.max(1, bottom - top);
  const size = full.getSize();
  const sx = size.width / virtualW, sy = size.height / virtualH;
  const crop = {
    x: Math.max(0, Math.round((disp.bounds.x - left) * sx)),
    y: Math.max(0, Math.round((disp.bounds.y - top) * sy)),
    width: Math.max(8, Math.round(disp.bounds.width * sx)),
    height: Math.max(8, Math.round(disp.bounds.height * sy)),
  };
  crop.width = Math.min(crop.width, size.width - crop.x);
  crop.height = Math.min(crop.height, size.height - crop.y);
  if (crop.width < 8 || crop.height < 8) {
    throw new Error(`Spectacle monitor crop invalid: ${JSON.stringify(crop)} from ${size.width}x${size.height}`);
  }
  const image = full.crop(crop);
  const outSize = image.getSize();
  lastBackendWarning = "";
  return {
    image,
    width: outSize.width,
    height: outSize.height,
    method: "spectacle-wayland",
    sourceName: "KDE Spectacle full-desktop crop",
    sourceSize: size,
  };
}
async function captureWithGamescopeWindow(disp) {
  const canvasW = Math.max(640, Number(process.env.SC_OVERLAY_CANVAS_WIDTH) || 6360);
  const canvasH = Math.max(360, Number(process.env.SC_OVERLAY_CANVAS_HEIGHT) || 2160);
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: canvasW, height: canvasH },
    fetchWindowIcons: false,
  });
  const candidates = sources.filter((source) => {
    const name = String(source.name || "").trim();
    return !source.thumbnail.isEmpty() && (/gamescope/i.test(name) || /^Star\s*Citizen$/i.test(name));
  });
  if (!candidates.length) {
    const names = sources.slice(0, 8).map((source) => source.name || "(unnamed)").join(", ");
    throw new Error(`no Gamescope/Star Citizen window source${names ? `; visible sources: ${names}` : ""}`);
  }
  candidates.sort((a, b) => {
    const rank = (source) => {
      const name = String(source.name || "");
      if (/gamescope/i.test(name) && /star\s*citizen/i.test(name)) return 3;
      if (/^Star\s*Citizen$/i.test(name.trim())) return 2;
      if (/gamescope/i.test(name)) return 1;
      return 0;
    };
    const aGame = rank(a), bGame = rank(b);
    if (aGame !== bGame) return bGame - aGame;
    const as = a.thumbnail.getSize(), bs = b.thumbnail.getSize();
    return (bs.width * bs.height) - (as.width * as.height);
  });
  const source = candidates[0];
  const full = source.thumbnail;
  const size = full.getSize();
  const displays = screen.getAllDisplays();
  const left = Math.min(...displays.map((d) => d.bounds.x));
  const top = Math.min(...displays.map((d) => d.bounds.y));
  const xScale = size.width / canvasW;
  const yScale = size.height / canvasH;
  const crop = {
    x: Math.max(0, Math.round((disp.bounds.x - left) * xScale)),
    y: Math.max(0, Math.round((disp.bounds.y - top) * yScale)),
    width: Math.max(8, Math.round(disp.bounds.width * xScale)),
    height: Math.max(8, Math.round(Math.min(disp.bounds.height, canvasH) * yScale)),
  };
  crop.width = Math.min(crop.width, size.width - crop.x);
  crop.height = Math.min(crop.height, size.height - crop.y);
  if (crop.width < 8 || crop.height < 8) {
    throw new Error(`Gamescope window crop invalid: ${JSON.stringify(crop)} from ${size.width}x${size.height}`);
  }
  const image = full.crop(crop);
  const outSize = image.getSize();
  return {
    image,
    width: outSize.width,
    height: outSize.height,
    method: "electron-gamescope-window",
    sourceName: source.name || "gamescope",
    sourceSize: size,
  };
}
async function captureWithElectron(disp) {
  const width = Math.round(disp.size.width * disp.scaleFactor);
  const height = Math.round(disp.size.height * disp.scaleFactor);
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  const exact = sources.find((source) => source.display_id && String(source.display_id) === String(disp.id));
  const orderedDisplays = screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const displayIndex = Math.max(0, orderedDisplays.findIndex((candidate) => String(candidate.id) === String(disp.id)));
  const byOrdinal = sources.find((source) =>
    new RegExp(`(?:screen|display)\\s*${displayIndex + 1}\\b`, "i").test(String(source.name || "")));
  const source = exact || byOrdinal || sources[displayIndex] || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("desktopCapturer returned no usable screen source");
  const size = source.thumbnail.getSize();
  return {
    image: source.thumbnail,
    width: size.width || width,
    height: size.height || height,
    method: exact ? "electron-display-id" : "electron-screen-fallback",
    sourceName: source.name || "(unnamed screen)",
    sourceId: source.display_id || "",
    sourceInventory: sources.map((item) => `${item.name || "(unnamed)"}#${item.display_id || "no-id"}`).join(", "),
  };
}
async function captureGame(winRect) {
  const disp = winRect ? screen.getDisplayMatching(winRect) : screen.getPrimaryDisplay();
  const errors = [];

  // The Electron shell is intentionally XWayland, but the desktop itself is KDE Wayland. Prefer a
  // clean Gamescope window when the portal exposes it; otherwise restore the original Wayland/DBus
  // environment for Spectacle. Only then fall back to Electron's screen list.
  if (HOST_IS_WAYLAND) {
    try { return await captureWithGamescopeWindow(disp); }
    catch (e) { errors.push(`Gamescope window: ${e?.message || e}`); }
    try { return await captureWithSpectacle(disp); }
    catch (e) { errors.push(`Spectacle: ${e?.message || e}`); }
  }
  try {
    const result = await captureWithElectron(disp);
    if (errors.length) captureWarning(errors.join("; "));
    return result;
  } catch (e) {
    errors.push(`Electron screen: ${e?.message || e}`);
  }
  if (process.platform === "linux" && !HOST_IS_WAYLAND) {
    try { return await captureWithSpectacle(disp); }
    catch (e) { errors.push(`Spectacle: ${e?.message || e}`); }
  }
  throw new Error(errors.join("; ") || "no screen-capture backend succeeded");
}

// The kiosk's item render + name + category all live in the upper-right of the screen. Cropping to
// it before RapidOCR both (a) stops PP-OCR fusing the left material panel into the name and (b)
// speeds the read up. Fractions are of the captured GAME display (the fabricator is a fullscreen UI).
function rightPanelCrop(image, w, h) {
  const x = Math.round(w * 0.5);
  const cw = w - x, ch = Math.round(h * 0.72);
  return { img: image.crop({ x, y: 0, width: cw, height: ch }), w: cw, h: ch };
}

// Dedicated Mining RESULTS-panel OCR. The completed rock analysis is a small HUD block to the
// right of the reticle, so full-screen OCR is both slower and much noisier (chat, MFDs, missions).
// Coordinates are normalized against the captured GAME display and therefore scale from the
// 2048x1152 calibration sample to 3840x2160 and other 16:9 resolutions.
const MINING_ROIS = Object.freeze({
  panel:       { x: 0.625, y: 0.390, w: 0.170, h: 0.275, scale: 3.2 },
  composition: { x: 0.640, y: 0.530, w: 0.150, h: 0.105, scale: 4.0 },
  stats:       { x: 0.688, y: 0.455, w: 0.070, h: 0.075, scale: 6.0 },
});
// A ping/scan signature is much smaller than the completed RESULTS panel. Full-screen Tesseract
// routinely misses it, so r29 uses two overlapping play-field crops, RapidOCR candidates, and a high-contrast numeric
// pass over the focused crop. The threshold pass is important because the gray signature badge can
// disappear into the asteroid field during sparse-text segmentation even while the digits remain
// plainly visible to a person.
const MINING_SIGNATURE_ROIS = Object.freeze({
  focus: { x: 0.285, y: 0.235, w: 0.430, h: 0.390, scale: 3.8 },
  wide:  { x: 0.175, y: 0.245, w: 0.650, h: 0.440, scale: 2.6 },
});

// Scan Mode is identified from the fixed radar-cone control left of the reticle. The six supplied
// reference icons are the only valid cone angles Star Citizen displays: 2, 5, 11, 22, 45 and 90.
// This is intentionally a separate recognition result from signature OCR. A valid ore signature can
// update the widget, but target audio is permitted only when this detector confirms one of these
// radar icons on the SAME captured frame.
const SCAN_MODE_ANGLES = Object.freeze([2, 5, 11, 22, 45, 90]);
const SCAN_MODE_TEMPLATE_DIR = path.join(__dirname, "assets", "scan-mode");
// Fixed directly against the 3840x2160 primary display. The radar cone is always left of the
// reticle; this crop excludes the UNKNOWN/distance text to its right and most cockpit MFD numbers.
const SCAN_MODE_PRIMARY_ROI = Object.freeze({ name: "prospector-default", x: 0.455, y: 0.430, w: 0.075, h: 0.180, scale: 6.0 });
// Cockpit FOV and HUD anchoring move the cone control by several percent between ships. The
// Prospector remains the fast primary path; only after that crop fails do we probe a compact set
// of neighboring positions. This avoids a costly full-screen search while covering Mole, ROC,
// salvage, and general ship HUD layouts that place the scan control farther left or vertically.
const SCAN_MODE_FALLBACK_ROIS = Object.freeze([
  { name: "left-near",  x: 0.425, y: 0.430, w: 0.075, h: 0.180, scale: 6.0 },
  { name: "left-far",   x: 0.390, y: 0.430, w: 0.085, h: 0.185, scale: 6.0 },
  { name: "right-near", x: 0.485, y: 0.430, w: 0.075, h: 0.180, scale: 6.0 },
  { name: "upper",      x: 0.455, y: 0.385, w: 0.075, h: 0.180, scale: 6.0 },
  { name: "upper-left", x: 0.420, y: 0.385, w: 0.085, h: 0.185, scale: 6.0 },
  { name: "lower",      x: 0.455, y: 0.475, w: 0.075, h: 0.180, scale: 6.0 },
  { name: "lower-left", x: 0.420, y: 0.475, w: 0.085, h: 0.185, scale: 6.0 },
  { name: "wide-left",  x: 0.360, y: 0.405, w: 0.105, h: 0.210, scale: 5.5 },
]);
// Last-resort search area for ships whose HUD places the degree label outside every fixed anchor.
// RapidOCR proposes a few exact 2/5/11/22/45/90 text locations; template comparison still has to
// confirm the surrounding icon, so unrelated cockpit numbers cannot activate Scan Mode by text alone.
const SCAN_MODE_RAPID_SEARCH_ROI = Object.freeze({ name: "rapid-search-field", x: 0.260, y: 0.250, w: 0.500, h: 0.520, scale: 2.0 });
let scanModeTemplateCache = null;

function normalizedCrop(image, width, height, roi) {
  const x = Math.max(0, Math.min(width - 1, Math.round(width * roi.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(height * roi.y)));
  const w = Math.max(8, Math.min(width - x, Math.round(width * roi.w)));
  const h = Math.max(8, Math.min(height - y, Math.round(height * roi.h)));
  const cropped = image.crop({ x, y, width: w, height: h });
  const targetWidth = Math.min(1600, Math.max(w, Math.round(w * (roi.scale || 3))));
  return { img: cropped.resize({ width: targetWidth, quality: "best" }), x, y, w, h };
}

function ocrTesseractText(imgPath, { psm = 6, whitelist = "" } = {}) {
  return new Promise((resolve, reject) => {
    const args = [path.resolve(imgPath), "stdout", "-l", "eng", "--psm", String(psm),
      "-c", "preserve_interword_spaces=1"];
    if (whitelist) args.push("-c", `tessedit_char_whitelist=${whitelist}`);
    execFile("tesseract", args, { maxBuffer: 8 * 1024 * 1024, timeout: 8000 }, (err, stdout) => {
      if (err) return reject(new Error(`Mining Tesseract PSM ${psm} failed: ${err.message || err}`));
      resolve(String(stdout || "").trim());
    });
  });
}

async function preprocessHudImage(inputPath, outputPath) {
  try {
    await runFile("magick", [
      inputPath,
      "-colorspace", "Gray",
      "-auto-level",
      "-contrast-stretch", "1%x1%",
      "-sharpen", "0x1",
      "-strip",
      outputPath,
    ], { timeout: 10_000 });
    return outputPath;
  } catch {
    // ImageMagick is installed by the r29 installer, but retaining the unprocessed crop keeps the
    // reader functional if a user intentionally skips that dependency.
    return inputPath;
  }
}

async function preprocessSignatureThreshold(inputPath, outputPath) {
  try {
    // 70% was selected from the real 15,600 Torite diagnostic frame. It preserves the thin white
    // digits while suppressing most rocks, HUD lines, and the blue-space background. Keep this as a
    // separate pass rather than replacing grayscale: each catches signatures the other can miss.
    await runFile("magick", [
      inputPath,
      "-colorspace", "Gray",
      "-auto-level",
      "-threshold", "70%",
      "-strip",
      outputPath,
    ], { timeout: 10_000 });
    return outputPath;
  } catch {
    return null;
  }
}

function localNormalizedCrop(image, roi) {
  const size = image.getSize();
  const x = Math.max(0, Math.min(size.width - 1, Math.round(size.width * roi.x)));
  const y = Math.max(0, Math.min(size.height - 1, Math.round(size.height * roi.y)));
  const width = Math.max(8, Math.min(size.width - x, Math.round(size.width * roi.w)));
  const height = Math.max(8, Math.min(size.height - y, Math.round(size.height * roi.h)));
  return image.crop({ x, y, width, height });
}

async function prepareScanModeMask(inputPath, outputPath) {
  try {
    // Keep the colored radar cone plus its bright degree label while removing the dark space field.
    // Open removes isolated asteroid specks; Close reconnects the thin HUD strokes before trimming.
    await runFile("magick", [
      inputPath,
      "-colorspace", "sRGB",
      "-alpha", "off",
      "-fx", "(((g>0.30 && g>r*1.08 && g>b*0.90) || ((max(r,max(g,b))>0.50) && ((max(r,max(g,b))-min(r,min(g,b)))>0.08)) || min(r,min(g,b))>0.55) ? 1 : 0)",
      "-threshold", "50%",
      "-morphology", "Open", "Diamond:1",
      "-morphology", "Close", "Rectangle:1x1",
      "-trim", "+repage",
      "-resize", "96x128!",
      "-strip",
      outputPath,
    ], { timeout: 10_000 });
    return outputPath;
  } catch {
    return null;
  }
}

function compareScanModeMask(candidatePath, templatePath) {
  return new Promise((resolve) => {
    execFile("magick", ["compare", "-metric", "RMSE", candidatePath, templatePath, "null:"],
      { timeout: 6000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        // ImageMagick compare returns status 1 for a normal non-identical comparison.
        const text = `${stderr || ""} ${stdout || ""}`;
        const m = text.match(/\(([-+0-9.eE]+)\)/);
        const normalized = m ? Number(m[1]) : NaN;
        resolve(Number.isFinite(normalized) ? normalized : 1);
      });
  });
}

async function ensureScanModeTemplates() {
  if (scanModeTemplateCache) return scanModeTemplateCache;
  const rows = [];
  for (const angle of SCAN_MODE_ANGLES) {
    const source = path.join(SCAN_MODE_TEMPLATE_DIR, `${angle}.png`);
    const prepared = path.join(os.tmpdir(), `sc-scan-mode-template-${process.pid}-${angle}.png`);
    if (!fs.existsSync(source)) continue;
    if (!fs.existsSync(prepared)) await prepareScanModeMask(source, prepared);
    if (fs.existsSync(prepared)) rows.push({ angle, path: prepared });
  }
  scanModeTemplateCache = rows;
  return rows;
}

function parseScanModeAngle(text) {
  const compact = String(text || "").replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
  return SCAN_MODE_ANGLES.includes(Number(compact)) ? Number(compact) : null;
}

async function rapidScanModeSearchRois(image, width, height) {
  const search = normalizedCrop(image, width, height, SCAN_MODE_RAPID_SEARCH_ROI);
  const rawPath = path.join(os.tmpdir(), `sc-mining-scan-mode-${process.pid}-rapid-search.png`);
  fs.writeFileSync(rawPath, search.img.toPNG());
  const lines = await ocrRapidLinesOptional(rawPath);
  if (!lines.length) return [];

  const rendered = search.img.getSize();
  const sx = search.w / Math.max(1, rendered.width);
  const sy = search.h / Math.max(1, rendered.height);
  const proposals = [];
  for (const row of lines) {
    const angle = parseScanModeAngle(row.text);
    if (!angle) continue;
    const rw = Math.max(1, Number(row.w) || 1), rh = Math.max(1, Number(row.h) || 1);
    // A cone-angle label is a short HUD token. Reject large OCR regions such as an MFD paragraph.
    if (rw > rendered.width * 0.16 || rh > rendered.height * 0.16) continue;
    const cx = search.x + (Number(row.x) + rw / 2) * sx;
    const cy = search.y + (Number(row.y) + rh / 2) * sy;
    const roiW = Math.max(0.080, Math.min(0.115, (rw * sx / width) * 5.5));
    const roiH = Math.max(0.180, Math.min(0.230, (rh * sy / height) * 8.0));
    proposals.push({
      name: `rapid-hint-${angle}-${proposals.length + 1}`,
      hintedAngle: angle,
      x: Math.max(0, Math.min(1 - roiW, cx / width - roiW / 2)),
      y: Math.max(0, Math.min(1 - roiH, cy / height - roiH / 2)),
      w: roiW,
      h: roiH,
      scale: 6.0,
      score: Number(row.confidence) || 0,
    });
  }
  proposals.sort((a, b) => b.score - a.score);
  return proposals.slice(0, 6);
}

async function scoreScanModeCandidate(image, width, height, roi, index, templates) {
  const local = normalizedCrop(image, width, height, roi);
  const rawPath = path.join(os.tmpdir(), `sc-mining-scan-mode-${process.pid}-${index}-raw.png`);
  const maskPath = path.join(os.tmpdir(), `sc-mining-scan-mode-${process.pid}-${index}-mask.png`);
  fs.writeFileSync(rawPath, local.img.toPNG());
  const prepared = await prepareScanModeMask(rawPath, maskPath);
  if (!prepared) return null;

  const scored = await Promise.all(templates.map(async (template) => ({
    angle: template.angle,
    error: await compareScanModeMask(prepared, template.path),
  })));
  scored.sort((a, b) => a.error - b.error);
  const best = scored[0] || { angle: null, error: 1 };
  const second = scored[1] || { angle: null, error: 1 };
  return {
    name: roi.name || `candidate-${index}`,
    roi,
    rawPath,
    maskPath: prepared,
    best,
    second,
    matchMargin: Math.max(0, second.error - best.error),
  };
}

function scanModeTemplateConfident(candidate) {
  return !!candidate && candidate.best.error <= 0.40 && candidate.matchMargin >= 0.018;
}

async function readScanModeDegree(candidate) {
  if (!candidate) return { text: "", angle: null, engine: "none" };
  const [rapidLines, tesseractText] = await Promise.all([
    ocrRapidLinesOptional(candidate.rawPath),
    ocrTesseractText(candidate.maskPath, { psm: 11, whitelist: "0123456789" }).catch(() => ""),
  ]);
  const rapidText = rapidLines.map((row) => row.text).join(" ").trim();
  const rapidAngle = parseScanModeAngle(rapidText);
  const tesseractAngle = parseScanModeAngle(tesseractText);
  if (rapidAngle) return { text: rapidText, angle: rapidAngle, engine: "rapidocr" };
  if (tesseractAngle) return { text: String(tesseractText || "").trim(), angle: tesseractAngle, engine: "tesseract" };
  return { text: [rapidText, String(tesseractText || "").trim()].filter(Boolean).join(" | "), angle: null, engine: rapidText ? "rapidocr" : "tesseract" };
}

async function readMiningScanMode(image, width, height, tempPaths) {
  const templates = await ensureScanModeTemplates();
  if (!templates.length) return { kind: "scan-mode", active: false, angle: null, confidence: 0, method: "templates-missing" };

  const candidates = [];
  const primary = await scoreScanModeCandidate(image, width, height, SCAN_MODE_PRIMARY_ROI, 0, templates);
  if (primary) candidates.push(primary);

  // Keep the common Prospector path inexpensive. Only search neighboring HUD anchors when the
  // primary crop is not already a clear template match.
  if (!scanModeTemplateConfident(primary)) {
    for (let i = 0; i < SCAN_MODE_FALLBACK_ROIS.length; i++) {
      const candidate = await scoreScanModeCandidate(image, width, height, SCAN_MODE_FALLBACK_ROIS[i], i + 1, templates);
      if (candidate) candidates.push(candidate);
      if (scanModeTemplateConfident(candidate) && candidate.best.error <= 0.34) break;
    }
  }

  let searchHintCount = 0;
  if (!candidates.some(scanModeTemplateConfident)) {
    const hintedRois = await rapidScanModeSearchRois(image, width, height);
    searchHintCount = hintedRois.length;
    for (let i = 0; i < hintedRois.length; i++) {
      const candidate = await scoreScanModeCandidate(
        image, width, height, hintedRois[i], 100 + i, templates,
      );
      if (candidate) candidates.push(candidate);
      if (scanModeTemplateConfident(candidate) && candidate.best.angle === hintedRois[i].hintedAngle) break;
    }
  }

  candidates.sort((a, b) => a.best.error - b.best.error || b.matchMargin - a.matchMargin);
  const selected = candidates[0] || null;
  if (!selected) return { kind: "scan-mode", active: false, angle: null, confidence: 0, method: "mask-failed" };

  // Preserve the chosen candidate under the stable diagnostic filenames.
  try { fs.copyFileSync(selected.rawPath, tempPaths.scanModeRaw); } catch {}
  try { fs.copyFileSync(selected.maskPath, tempPaths.scanModeMask); } catch {}

  const degree = await readScanModeDegree(selected);
  const templateConfident = scanModeTemplateConfident(selected);
  const ocrConfirmed = !!degree.angle && selected.best.error <= 0.50 &&
    (selected.best.angle === degree.angle || selected.matchMargin >= 0.012);
  const active = templateConfident || ocrConfirmed;
  const angle = active ? (degree.angle || selected.best.angle) : null;
  return {
    kind: "scan-mode",
    active,
    angle,
    confidence: Math.max(0, Math.min(100, Math.round((1 - selected.best.error) * 100))),
    templateError: Number(selected.best.error.toFixed(4)),
    secondTemplateError: Number(selected.second.error.toFixed(4)),
    matchMargin: Number(selected.matchMargin.toFixed(4)),
    ocrText: degree.text,
    ocrEngine: degree.engine,
    method: ocrConfirmed
      ? `${selected.name.startsWith("rapid-hint-") ? "rapidocr-guided" : "multi-roi"}-template+${degree.engine}`
      : (selected.name === SCAN_MODE_PRIMARY_ROI.name
        ? "primary-template-match"
        : (selected.name.startsWith("rapid-hint-") ? "rapidocr-guided-template-match" : "multi-roi-template-match")),
    roi: selected.roi,
    roiName: selected.name,
    candidatesChecked: candidates.length,
    searchHintCount,
    candidateScores: candidates.slice(0, 4).map((candidate) => ({
      name: candidate.name,
      angle: candidate.best.angle,
      error: Number(candidate.best.error.toFixed(4)),
      margin: Number(candidate.matchMargin.toFixed(4)),
    })),
  };
}

// Tesseract can skip a tiny scanner badge when it sees the entire asteroid field as one page. r29
// first joins neighboring white digit strokes, asks ImageMagick for connected-component boxes, and
// OCRs each plausible short text row in isolation. This turns the supplied 15,600 badge from an
// empty full-crop result into a compact local read (typically 15,600, 15600, or 15400).
function parseSignatureComponentBoxes(verbose, imageWidth, imageHeight) {
  const boxes = [];
  for (const line of String(verbose || "").split(/\r?\n/)) {
    if (!/gray\(255\)|srgb\(255,255,255\)/i.test(line)) continue;
    const match = line.match(/^\s*\d+:\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\s+/);
    if (!match) continue;
    const w = Number(match[1]), h = Number(match[2]), x = Number(match[3]), y = Number(match[4]);
    if (![w, h, x, y].every(Number.isFinite)) continue;
    if (w < 45 || w > 190 || h < 14 || h > 62) continue;
    const aspect = w / Math.max(1, h);
    if (aspect < 1.35 || aspect > 10) continue;
    if (x < 0 || y < 0 || x + w > imageWidth || y + h > imageHeight) continue;
    // Prefer the central play field but keep off-centre markers too. Sorting only limits worst-case
    // OCR cost; it is not used as a recognition score by the server.
    const cx = x + w / 2, cy = y + h / 2;
    const centerDistance = Math.hypot(cx / imageWidth - 0.5, cy / imageHeight - 0.42);
    boxes.push({ x, y, w, h, centerDistance });
  }
  boxes.sort((a, b) => a.centerDistance - b.centerDistance || b.w - a.w);
  return boxes.slice(0, 18);
}

async function localizedSignatureReads(thresholdPath, imageWidth, imageHeight) {
  let result;
  try {
    result = await runFile("magick", [
      thresholdPath,
      "-morphology", "Close", "Rectangle:9x1",
      "-define", "connected-components:verbose=true",
      "-connected-components", "8",
      "null:",
    ], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return [];
  }
  const boxes = parseSignatureComponentBoxes(`${result.stdout || ""}\n${result.stderr || ""}`, imageWidth, imageHeight);
  const lines = [];
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const pad = 8;
    const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    const right = Math.min(imageWidth, box.x + box.w + pad);
    const bottom = Math.min(imageHeight, box.y + box.h + pad);
    const w = right - x, h = bottom - y;
    const candidatePath = path.join(os.tmpdir(), `sc-mining-signature-component-${process.pid}-${i}.png`);
    try {
      await runFile("magick", [
        thresholdPath,
        "-crop", `${w}x${h}+${x}+${y}`,
        "+repage",
        "-resize", "600%",
        "-morphology", "Close", "Rectangle:1x1",
        "-strip",
        candidatePath,
      ], { timeout: 8_000 });
      const lineSets = await Promise.all([
        ocrTesseractLines(candidatePath, { psm: 7, whitelist: "0123456789,." }).catch(() => []),
        ocrTesseractLines(candidatePath, { psm: 11, whitelist: "0123456789,." }).catch(() => []),
        ocrTesseractLines(candidatePath, { psm: 13, whitelist: "0123456789,." }).catch(() => []),
      ]);
      const seen = new Set();
      for (const row of lineSets.flat()) {
        const text = String(row?.text || "").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        lines.push({ text, x, y, w, h, confidence: Number(row?.confidence) || 0 });
      }
    } finally {
      try { fs.unlinkSync(candidatePath); } catch {}
    }
  }
  return lines;
}

async function readMiningAnalysis(image, width, height, tempPaths) {
  const panel = normalizedCrop(image, width, height, MINING_ROIS.panel);
  const composition = normalizedCrop(image, width, height, MINING_ROIS.composition);
  const stats = normalizedCrop(image, width, height, MINING_ROIS.stats);
  fs.writeFileSync(tempPaths.panelRaw, panel.img.toPNG());
  fs.writeFileSync(tempPaths.compositionRaw, composition.img.toPNG());
  fs.writeFileSync(tempPaths.statsRaw, stats.img.toPNG());
  // Preserve grayscale copies for diagnostics, but keep the production RESULTS-panel OCR on the
  // original HUD colors. The supplied Lindinium calibration frame showed that grayscale can erase
  // thin orange/white characters where the bright rock sits behind the text. Signature OCR remains
  // grayscale because those marker digits are isolated against the play field.
  await Promise.all([
    preprocessHudImage(tempPaths.panelRaw, tempPaths.panel),
    preprocessHudImage(tempPaths.compositionRaw, tempPaths.composition),
    preprocessHudImage(tempPaths.statsRaw, tempPaths.stats),
  ]);
  const [panelTextTess, sparseText, compositionTextTess, statsText, panelRapid, compositionRapid] = await Promise.all([
    ocrTesseractText(tempPaths.panelRaw, { psm: 6 }),
    ocrTesseractText(tempPaths.panelRaw, { psm: 11 }),
    ocrTesseractText(tempPaths.compositionRaw, { psm: 6 }),
    ocrTesseractText(tempPaths.statsRaw, { psm: 6, whitelist: "0123456789OQDILSZB|!,.%SCU" }),
    ocrRapidLinesOptional(tempPaths.panelRaw),
    ocrRapidLinesOptional(tempPaths.compositionRaw),
  ]);
  const rapidPanelText = panelRapid.map((row) => row.text).filter(Boolean).join("\n");
  const rapidCompositionText = compositionRapid.map((row) => row.text).filter(Boolean).join("\n");
  const panelText = [rapidPanelText, panelTextTess].filter(Boolean).join("\n");
  const compositionText = [rapidCompositionText, compositionTextTess].filter(Boolean).join("\n");
  return { panelText, sparseText, compositionText, statsText, roi: { panel, composition, stats }, ocrEngine: rapidPanelText ? "rapidocr+tesseract" : "tesseract" };
}

async function readMiningSignatures(image, width, height, tempPaths) {
  const reads = [];
  for (const [name, roi] of Object.entries(MINING_SIGNATURE_ROIS)) {
    const crop = normalizedCrop(image, width, height, roi);
    const rawPath = tempPaths[`${name}Raw`];
    const grayPath = tempPaths[name];
    fs.writeFileSync(rawPath, crop.img.toPNG());
    const ocrPath = await preprocessHudImage(rawPath, grayPath);
    const [lines, rapidLines] = await Promise.all([
      ocrTesseractLines(ocrPath, { psm: 11 }),
      ocrRapidLinesOptional(rawPath),
    ]);
    const cropSize = crop.img.getSize();
    reads.push({
      name,
      sourceGroup: name,
      markerLike: false,
      w: cropSize.width,
      h: cropSize.height,
      lines: Array.isArray(lines) ? lines : (lines.lines || []),
      rect: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
    });
    if (rapidLines.length) {
      reads.push({
        name: `${name}-rapidocr`,
        sourceGroup: name,
        markerLike: false,
        w: cropSize.width,
        h: cropSize.height,
        lines: rapidLines,
        rect: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
      });
    }

    // The focused crop gets one additional numeric-only pass. On the supplied diagnostic frame,
    // ordinary PSM 11 skipped a clearly visible 15,600 badge, while thresholded PSM 6 returned
    // "15.600". The server normalizes both comma and period grouping and corrects a fused pin icon.
    if (name === "focus") {
      const thresholdPath = tempPaths.focusThreshold;
      const prepared = await preprocessSignatureThreshold(ocrPath, thresholdPath);
      if (prepared) {
        const numeric = await ocrTesseractLines(prepared, {
          psm: 6,
          whitelist: "0123456789,.",
        });
        reads.push({
          name: "focus-threshold",
          sourceGroup: "focus",
          markerLike: true,
          w: cropSize.width,
          h: cropSize.height,
          lines: Array.isArray(numeric) ? numeric : (numeric.lines || []),
          rect: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
        });
        const rapidNumeric = await ocrRapidLinesOptional(prepared);
        if (rapidNumeric.length) {
          reads.push({
            name: "focus-threshold-rapidocr",
            sourceGroup: "focus",
            markerLike: true,
            w: cropSize.width,
            h: cropSize.height,
            lines: rapidNumeric,
            rect: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
          });
        }
        const localized = await localizedSignatureReads(prepared, cropSize.width, cropSize.height);
        reads.push({
          name: "focus-components",
          sourceGroup: "focus-components",
          markerLike: true,
          w: cropSize.width,
          h: cropSize.height,
          lines: localized,
          rect: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
        });
      }
    }
  }
  return { reads };
}

// RapidOCR (PP-OCR) is preferred for stylized text, but all native work runs in a
// disposable Node child process. The Electron main process receives only plain OCR results.
let _rapidWarningShown = false;
function ocrTesseractLines(imgPath, { psm = 11, whitelist = "" } = {}) {
  return new Promise((resolve, reject) => {
    const args = [path.resolve(imgPath), "stdout", "-l", "eng", "--psm", String(psm),
      "-c", "preserve_interword_spaces=1"];
    if (whitelist) args.push("-c", `tessedit_char_whitelist=${whitelist}`);
    args.push("tsv");
    execFile("tesseract", args,
      { maxBuffer: 16 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
        if (err) return reject(new Error(`Tesseract OCR failed: ${err.message || err}`));
        try {
          const groups = new Map();
          const rows = String(stdout || "").split(/\r?\n/);
          for (let i = 1; i < rows.length; i++) {
            if (!rows[i]) continue;
            const c = rows[i].split("\t");
            if (c.length < 12 || Number(c[0]) !== 5) continue;
            const text = c.slice(11).join("\t").trim();
            if (!text) continue;
            const left = Number(c[6]), top = Number(c[7]), width = Number(c[8]), height = Number(c[9]);
            const key = `${c[1]}:${c[2]}:${c[3]}:${c[4]}`;
            let g = groups.get(key);
            if (!g) {
              g = { words: [], confidences: [], x0: left, y0: top, x1: left + width, y1: top + height };
              groups.set(key, g);
            }
            g.words.push(text);
            const confidence = Number(c[10]);
            if (Number.isFinite(confidence) && confidence >= 0) g.confidences.push(confidence);
            g.x0 = Math.min(g.x0, left); g.y0 = Math.min(g.y0, top);
            g.x1 = Math.max(g.x1, left + width); g.y1 = Math.max(g.y1, top + height);
          }
          resolve([...groups.values()].map((g) => ({
            text: g.words.join(" "),
            x: g.x0,
            y: g.y0,
            w: g.x1 - g.x0,
            h: g.y1 - g.y0,
            confidence: g.confidences.length
              ? g.confidences.reduce((sum, value) => sum + value, 0) / g.confidences.length
              : 0,
          })).sort((a, b) => a.y - b.y || a.x - b.x));
        } catch (e) { reject(e); }
      });
  });
}
async function ocrRapidLines(imgPath) {
  const detected = await rapidOcrClient.detect(imgPath);
  const res = Array.isArray(detected) ? detected : (Array.isArray(detected?.texts) ? detected.texts : []);
  return res.map((r) => {
    const box = Array.isArray(r.box) ? r.box : [];
    const xs = box.map((pt) => Number(pt?.[0])).filter(Number.isFinite);
    const ys = box.map((pt) => Number(pt?.[1])).filter(Number.isFinite);
    const frame = r?.frame && typeof r.frame === "object" ? r.frame : null;
    const x = xs.length ? Math.min(...xs) : Number(frame?.left) || 0;
    const y = ys.length ? Math.min(...ys) : Number(frame?.top) || 0;
    return {
      text: String(r.text || ""),
      x,
      y,
      w: xs.length ? Math.max(...xs) - x : Number(frame?.width) || 0,
      h: ys.length ? Math.max(...ys) - y : Number(frame?.height) || 0,
      confidence: Number(r.score ?? r.confidence) || 0,
    };
  }).filter((row) => row.text.trim());
}
async function ocrRapidLinesOptional(imgPath) {
  try {
    return await ocrRapidLines(imgPath);
  } catch (error) {
    if (!_rapidWarningShown) {
      _rapidWarningShown = true;
      console.warn("[ocr] RapidOCR worker unavailable; continuing with Tesseract fallback:", error?.message || error);
    }
    return [];
  }
}

function captureErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  try { const text = JSON.stringify(error); if (text && text !== "{}") return text; } catch {}
  return String(error || "unknown screen-capture failure");
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
  const miningTemp = {
    panelRaw: path.join(os.tmpdir(), "sc-mining-results-panel-raw.png"),
    panel: path.join(os.tmpdir(), "sc-mining-results-panel-gray.png"),
    compositionRaw: path.join(os.tmpdir(), "sc-mining-results-composition-raw.png"),
    composition: path.join(os.tmpdir(), "sc-mining-results-composition-gray.png"),
    statsRaw: path.join(os.tmpdir(), "sc-mining-results-stats-raw.png"),
    stats: path.join(os.tmpdir(), "sc-mining-results-stats-gray.png"),
    focusRaw: path.join(os.tmpdir(), "sc-mining-signature-focus-raw.png"),
    focus: path.join(os.tmpdir(), "sc-mining-signature-focus-gray.png"),
    focusThreshold: path.join(os.tmpdir(), "sc-mining-signature-focus-threshold.png"),
    scanModeRaw: path.join(os.tmpdir(), "sc-mining-scan-mode-raw.png"),
    scanModeMask: path.join(os.tmpdir(), "sc-mining-scan-mode-mask.png"),
    wideRaw: path.join(os.tmpdir(), "sc-mining-signature-wide-raw.png"),
    wide: path.join(os.tmpdir(), "sc-mining-signature-wide-gray.png"),
  };
  const ocrDebugDir = path.join(configDir, "ocr-debug");
  let busy = false;
  let busyAt = 0;             // when the current tick set busy (watchdog against a wedged loop)
  const TICK_WATCHDOG_MS = 15000; // log a slow tick, but never overlap native OCR work
  let lastSlowTickLogAt = 0;
  const FETCH_TIMEOUT_MS = 8000;  // any single request must give up so it can't latch the loop
  const DRAIN_MS = 6000;          // how often the retry-upload loop drains captured-but-unshared items
  let lastContextKey = "";
  let scanCycle = 0;
  let lastGateLog = "";
  // Context = the steady screen-reader state. r24 includes the enabled feature flags, bound-session IDs, gate source,
  // and successful cycle count so both widgets can show an honest heartbeat instead of appearing
  // dormant. The key intentionally includes `cycle`, so a successful read refreshes the UI every
  // poll; idle/off messages are still deduplicated.
  const emitContext = (state, extra = {}) => {
    const payload = { state, ...extra };
    const key = JSON.stringify(payload);
    if (key !== lastContextKey) { lastContextKey = key; onStatus?.(payload); }
  };
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
  const uploaded = new Set(); // items pushed to the site this session
  const pendingUploads = new Map(); // item UUID -> display name|null: captured locally but NOT yet
  //                                   confirmed on the site; the drain loop retries until it lands
  let drainBusy = false;      // guard for the independent upload-drain loop
  let seededPending = false;  // have we reconciled the local capture folder vs the site's have-list?
  let remoteHave = null;      // set of items the site already has (dedup)
  let remoteHaveAt = 0;       // when remoteHave was last fetched
  const REMOTE_TTL_MS = 3 * 60_000; // re-fetch the site's have-list this often
  // A failed capture should not hammer KDE's capture stack every three seconds. The launcher
  // forces X11, but this cooldown also keeps manual/native-Wayland experiments readable.
  let nextCaptureAttemptAt = 0;
  let lastCaptureError = "";
  let lastMiningFingerprint = "";
  let lastSignatureFingerprint = "";
  let lastScanModeFingerprint = "";
  let lastCaptureDescription = "";
  let noMiningReadCycles = 0;


  function saveOcrDebug(shot, cap, genericRead, analysisRead, signatureRead, signatureOcr = null, scanModeRead = null) {
    try {
      fs.mkdirSync(ocrDebugDir, { recursive: true });
      fs.writeFileSync(path.join(ocrDebugDir, "latest-game-frame.jpg"), shot.toJPEG(82));
      for (const [source, name] of [
        [miningTemp.focusRaw, "latest-signature-focus-raw.png"],
        [miningTemp.focus, "latest-signature-focus-gray.png"],
        [miningTemp.focusThreshold, "latest-signature-focus-threshold.png"],
        [miningTemp.scanModeRaw, "latest-scan-mode-raw.png"],
        [miningTemp.scanModeMask, "latest-scan-mode-mask.png"],
        [miningTemp.wideRaw, "latest-signature-wide-raw.png"],
        [miningTemp.wide, "latest-signature-wide-gray.png"],
        [miningTemp.panelRaw, "latest-analysis-panel-raw.png"],
        [miningTemp.panel, "latest-analysis-panel-gray.png"],
      ]) {
        try { if (fs.existsSync(source)) fs.copyFileSync(source, path.join(ocrDebugDir, name)); } catch {}
      }
      fs.writeFileSync(path.join(ocrDebugDir, "latest-read.json"), JSON.stringify({
        at: new Date().toISOString(),
        capture: {
          method: cap.method,
          width: cap.width,
          height: cap.height,
          sourceName: cap.sourceName || null,
          sourceId: cap.sourceId || null,
          sourceInventory: cap.sourceInventory || null,
          sourceSize: cap.sourceSize || null,
        },
        genericRead,
        analysisRead,
        signatureRead,
        scanModeRead,
        signatureOcr: signatureOcr ? {
          reads: (signatureOcr.reads || []).map((read) => ({
            name: read.name,
            sourceGroup: read.sourceGroup || read.name,
            markerLike: !!read.markerLike,
            rect: read.rect || null,
            lines: (read.lines || []).map((line) => ({
              text: line.text,
              x: line.x,
              y: line.y,
              w: line.w,
              h: line.h,
              confidence: line.confidence ?? null,
            })),
          })),
        } : null,
      }, null, 2) + "\n");
    } catch (error) {
      console.warn("[screen-read] unable to write OCR diagnostics:", error?.message || error);
    }
  }

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
      if (r.ok) { uploaded.add(item); remoteHave?.add(item); return true; }
      console.error(`[fab-capture] upload ${item} -> HTTP ${r.status}`);
    } catch (e) { console.error("[fab-capture] upload error:", e && e.message); }
    return false;
  }

  async function tick() {
    const cfg = readConfig(configDir);
    // Two independent opt-ins share one screen-read: image capture and pinned-mission OCR.
    // Either one arms the loop; each read is then gated by its own flag below.
    const fab = cfg.fabCapture === true;
    const miss = cfg.missionOcr === true;
    // Offer to tick blueprints the kiosk shows that we have no record of. Its own opt-in,
    // and enough on its own to justify arming the loop — it needs no upload and no token.
    const claim = cfg.fabClaim === true;
    // The Mining Assistant (refinery timers + signature scanner) also reads the screen;
    // refinery/mineable reads are routed to its tracker server-side in /api/screen-read.
    const mining = cfg.miningAssistant === true;
    const features = { fabricator: fab, mission: miss, mining };
    if (!fab && !miss && !mining) { emitContext("off", { features, reason: "all-readers-disabled" }); return; }
    if (Date.now() < nextCaptureAttemptAt) {
      emitContext("idle", { features, reason: "capture-backoff", retryAt: nextCaptureAttemptAt });
      return;
    }
    // Never start a second capture/OCR cycle while the first still owns native image objects.
    // The old watchdog cleared `busy` after 15 seconds, leaving the first async tick alive and
    // allowing overlapping RapidOCR/sharp/libvips work. That can abort the whole Electron process.
    // A slow tick is now reported and skipped; its own finally block is the only place that unlocks.
    if (busy) {
      const elapsed = Date.now() - busyAt;
      if (elapsed >= TICK_WATCHDOG_MS && Date.now() - lastSlowTickLogAt >= TICK_WATCHDOG_MS) {
        lastSlowTickLogAt = Date.now();
        console.warn(`[fab-capture] prior OCR tick still running after ${Math.round(elapsed / 1000)}s; skipping overlap (RapidOCR queue=${rapidOcrClient.queueDepth()})`);
      }
      return;
    }
    const tFg = Date.now();
    const fg = await foregroundWindow();
    const boundSession = fg.session || scSession.summary();
    if (!/^StarCitizen(?:\.exe)?$/i.test(fg.name)) {
      emitContext("idle", { features, reason: "waiting-for-game", gate: fg.gate || "not-game", session: boundSession });
      const gateMessage = `paused:${fg.gate || "not-game"}:${fg.name || "anonymous"}`;
      if (gateMessage !== lastGateLog) {
        lastGateLog = gateMessage;
        console.log(`[screen-read] paused — Star Citizen is not the active surface (gate=${fg.gate || "not-game"}, active=${fg.name || "anonymous"})`);
      }
      return;
    } // only ever look at SC
    const gateMessage = `active:${fg.gate || "unknown"}`;
    if (gateMessage !== lastGateLog) {
      lastGateLog = gateMessage;
      console.log(`[screen-read] active via ${fg.gate || "foreground-window"}` +
        `${boundSession ? `; bound StarCitizen PID ${boundSession.gamePid} -> Gamescope PID ${boundSession.gamescopePid}` : ""}` +
        `; mining=${mining ? "on" : "off"}, mission=${miss ? "on" : "off"}, fabricator=${fab ? "on" : "off"}`);
    }
    busy = true;
    busyAt = Date.now();
    emitEvent({ state: "reading", features, cycle: scanCycle + 1, gate: fg.gate || "foreground-window", session: boundSession });
    try {
      const have = fab ? await ensureRemoteHave() : null; // dedup set only needed for capture
      const t0 = Date.now();
      const cap = await captureGame(fg.rect); // the monitor the GAME is on, not a blind sources[0]
      const shot = cap && cap.image;
      if (!shot) return;
      const captureDescription = `${cap.method || "unknown"}:${cap.width}x${cap.height}:${cap.sourceName || ""}:${cap.sourceId || ""}`;
      if (captureDescription !== lastCaptureDescription) {
        lastCaptureDescription = captureDescription;
        console.log(`[screen-read] capture source ${cap.method || "unknown"} ${cap.width}x${cap.height}` +
          `${cap.sourceName ? ` (${cap.sourceName})` : ""}` +
          `${cap.sourceId ? ` display_id=${cap.sourceId}` : ""}`);
        if (cap.sourceInventory && /fallback/.test(cap.method || "")) {
          console.log(`[screen-read] Electron screen inventory: ${cap.sourceInventory}`);
        }
      }
      fs.writeFileSync(tmpShot, shot.toPNG());
      // Pass 1 — Windows OCR on the full game frame: the cheap "where am I" glance. It detects the
      // kiosk and serves the mission / mining reads (which work fine on it today).
      const resp = await fetch(`http://127.0.0.1:${port}/api/screen-read`, {
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
          const r2 = await fetch(`http://127.0.0.1:${port}/api/screen-read`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lines, w: panel.w, h: panel.h }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          const rr = await r2.json();
          if (rr.kind === "fabricator" && rr.item) { read = rr; renderSrc = panel.img; } // rr.crop is panel-relative
        } catch (e) { console.warn("[fab-capture] secondary OCR re-read failed, using full-frame OCR:", e && e.message); }
      }
      // Completed mining scans and ping signatures have separate, tightly-cropped OCR paths.
      // They run independently of the generic classifier: cockpit text can occasionally resemble a
      // fabricator/refinery screen, and that false classification must never suppress Mining OCR.
      let analysisRead = { kind: "none" };
      let signatureRead = { kind: "none" };
      let signatureOcr = null;
      let scanModeRead = { kind: "scan-mode", active: false, angle: null, confidence: 0 };
      if (mining) {
        try {
          scanModeRead = await readMiningScanMode(shot, cap.width, cap.height, miningTemp);
          const scanModeResp = await fetch(`http://127.0.0.1:${port}/api/screen-read`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "mining-scan-mode", ...scanModeRead }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          await scanModeResp.json().catch(() => ({}));
          const scanFingerprint = `${scanModeRead.active ? 1 : 0}|${scanModeRead.angle || 0}|${scanModeRead.confidence || 0}`;
          if (scanFingerprint !== lastScanModeFingerprint) {
            lastScanModeFingerprint = scanFingerprint;
            console.log(`[mining-scan-mode] ${scanModeRead.active ? `active ${scanModeRead.angle || "?"}°` : "inactive"}` +
              ` confidence=${scanModeRead.confidence || 0}` +
              `${scanModeRead.ocrText ? ` ocr=${JSON.stringify(scanModeRead.ocrText)}` : ""}`);
          }
        } catch (e) {
          console.warn("[mining-scan-mode] detector failed:", e && e.message);
        }

        try {
          const miningOcr = await readMiningAnalysis(shot, cap.width, cap.height, miningTemp);
          const miningResp = await fetch(`http://127.0.0.1:${port}/api/screen-read`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "mining-analysis", ...miningOcr }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          analysisRead = await miningResp.json();
          if (analysisRead.kind === "mining-analysis") {
            const fingerprint = [analysisRead.target || "?", analysisRead.mass || "?",
              ...(analysisRead.composition || []).map((row) => `${row.material}:${row.percent ?? "?"}`)].join("|");
            if (fingerprint !== lastMiningFingerprint) {
              lastMiningFingerprint = fingerprint;
              console.log(`[mining-ocr] analysis candidate: ${analysisRead.target || "unknown"}` +
                `${analysisRead.mass ? `, mass ${analysisRead.mass}` : ""}` +
                `${analysisRead.composition?.length ? `, ${analysisRead.composition.length} composition row(s)` : ""}`);
            }
          }
        } catch (e) {
          console.warn("[mining-ocr] dedicated panel read failed:", e && e.message);
        }

        // The signature pass is independent of the generic classifier. It runs unless a completed
        // analysis was recognized on this frame, and the server confirms repeated non-target reads.
        if (analysisRead.kind !== "mining-analysis" && read.kind !== "mineable") {
          try {
            signatureOcr = await readMiningSignatures(shot, cap.width, cap.height, miningTemp);
            const signatureResp = await fetch(`http://127.0.0.1:${port}/api/screen-read`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mode: "mining-signature", scanMode: scanModeRead, ...signatureOcr }),
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            signatureRead = await signatureResp.json();
            if (signatureRead.kind === "mineable") {
              const fingerprint = `${signatureRead.signature}|${signatureRead.accepted ? "accepted" : `pending-${signatureRead.pendingCount || 0}`}`;
              if (fingerprint !== lastSignatureFingerprint) {
                lastSignatureFingerprint = fingerprint;
                console.log(`[mining-signature] ${signatureRead.accepted ? "accepted" : "candidate"}` +
                  ` ${Number(signatureRead.signature).toLocaleString()}` +
                  ` confidence=${signatureRead.confidence ?? "?"}` +
                  `${signatureRead.pendingCount ? ` confirmation=${signatureRead.pendingCount}/${signatureRead.required || 2}` : ""}` +
                  `${signatureRead.matches?.length ? ` matches=${signatureRead.matches.map((m) => m.name).join(",")}` : " matches=none"}` +
                  `${signatureRead.correction ? ` correction=${signatureRead.correction}` : ""}` +
                  `${signatureRead.raw ? ` raw=${JSON.stringify(signatureRead.raw)}` : ""}`);
              }
            }
          } catch (e) {
            console.warn("[mining-signature] dedicated signature read failed:", e && e.message);
          }
        }
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
      }      // A kiosk on screen -> "fabricator" context (gold diamond) even if image capture is off;
      // anything else while watching -> "watching". A successful cycle is surfaced every poll so
      // the Mission Tracker and Mining Assistant both show that OCR is alive even when nothing new
      // was recognized.
      scanCycle += 1;
      const miningKind = analysisRead.kind === "mining-analysis"
        ? "mining-analysis"
        : (signatureRead.kind === "mineable"
          ? (signatureRead.accepted ? "mineable" : "mineable-pending")
          : (read.kind === "mineable" ? "mineable" : "none"));
      if (miningKind === "none") noMiningReadCycles += 1;
      else noMiningReadCycles = 0;
      const effectiveKind = read.kind && read.kind !== "none" ? read.kind : miningKind;
      emitContext(read.kind === "fabricator" ? "fabricator" : "watching", {
        features,
        cycle: scanCycle,
        gate: fg.gate || "foreground-window",
        lastReadKind: effectiveKind || "none",
        miningReadKind: miningKind,
        signature: signatureRead.signature || null,
        signatureAccepted: signatureRead.accepted === true,
        signaturePendingCount: signatureRead.pendingCount || 0,
        signatureRequired: signatureRead.required || 0,
        scanModeActive: scanModeRead.active === true,
        scanModeAngle: scanModeRead.angle || null,
        scanModeConfidence: scanModeRead.confidence || 0,
        captureMethod: cap.method || "unknown",
        at: Date.now(),
        session: boundSession,
      });
      if (scanCycle === 1 || scanCycle % 10 === 0) {
        console.log(`[screen-read] cycle ${scanCycle} complete (kind=${effectiveKind || "none"}, gate=${fg.gate || "foreground-window"}, capture=${cap.method || "unknown"}, gamePid=${boundSession?.gamePid || "none"})`);
      }
      // Keep one bounded diagnostic set instead of accumulating screenshots. It is refreshed on the
      // first pass, whenever Mining recognizes something, and every tenth miss.
      if (scanCycle === 1 || miningKind !== "none" || noMiningReadCycles % 10 === 0) {
        saveOcrDebug(shot, cap, read, analysisRead, signatureRead, signatureOcr, scanModeRead);
      }
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
        if (cfg.syncToken) {
          // Share the one capture across every sibling that still lacks it (name collision).
          const oks = await Promise.all(missing.map((t) => upload(t, jpeg, cfg.syncToken)));
          uploadedOk = oks.every(Boolean);
          // Any sibling whose upload didn't land: keep the local JPEG and QUEUE it. The drain loop
          // retries from disk until the server has it, so a transient failure (or a wedge) can't
          // leave a captured item silently unshared — and the user isn't told "done" when it isn't.
          missing.forEach((t, i) => { if (!oks[i]) pendingUploads.set(t, read.name); });
          const label = missing.length > 1 ? `${read.name} (${missing.length} sizes)` : `${read.name} (${item})`;
          console.log(`[fab-capture] ${uploadedOk ? "uploaded" : "upload failed — queued for retry"} ${label}`);
        } else {
          console.log(`[fab-capture] saved ${read.name} (${item}) — no sync token, not uploaded`);
        }
        // uploaded:true  => confirmed on the site. queued:true => saved + retrying (NOT done yet).
        emitEvent({ state: "captured", name: read.name, uploaded: uploadedOk, queued: !uploadedOk && !!cfg.syncToken });
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
          await fetch(`http://127.0.0.1:${port}/api/missions/screen`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: read.titleRaw }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
        } catch { /* best effort */ }
      }
    } catch (e) {
      const message = captureErrorMessage(e);
      nextCaptureAttemptAt = Date.now() + 60_000;
      if (message !== lastCaptureError) {
        console.error(`[fab-capture] screen read failed: ${message}; retry paused for 60 seconds`);
        lastCaptureError = message;
      }
      emitEvent({ state: "capture-error", message, features, cycle: scanCycle, retryAt: nextCaptureAttemptAt });
    } finally {
      lastTickMs = Date.now() - busyAt;
      // Buffered, not posted per tick — a round-trip inside the very loop being measured would
      // change the number it is trying to report. The heartbeat drains this.
      if (mining) {
        tickStages.push({ total: lastTickMs, ...stage });
        if (tickStages.length > TICK_STAGES_MAX) tickStages.shift();
      }
      busy = false;
      lastSlowTickLogAt = 0;
    }
  }

  // Independent upload-drain loop. Uploads captured-but-unconfirmed items from their saved local
  // JPEGs until the server actually has them — decoupled from the screen-read tick and its busy
  // flag, so it drains even while the user is off the kiosk (no re-scan needed). On the FIRST pass
  // it reconciles the whole fab-captures folder against the site's have-list, so captures stranded
  // by a past failure/wedge self-heal on the next launch instead of being silently lost.
  async function drainPending() {
    const cfg = readConfig(configDir);
    if (cfg.fabCapture !== true || !cfg.syncToken) return; // needs opt-in + a token to upload
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
        if (await upload(it, jpeg, cfg.syncToken)) {
          pendingUploads.delete(it);
          emitEvent({ state: "shared", name, pending: pendingUploads.size });
          console.log(`[fab-capture] retry uploaded ${name || it} (${pendingUploads.size} still pending)`);
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
  console.log("[screen-read] continuous OCR loop armed (3-second poll; mission, mining, or fabricator opt-in)");
  return () => { clearInterval(timer); clearInterval(drainTimer); };
}

module.exports = { startFabCapture, centerTighten, findScanGlyph, GLYPH, __test: { classifyLinuxForeground, cleanX11Field } };