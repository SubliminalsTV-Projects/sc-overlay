// Electron shell for the SC Blueprint Tracker — a transparent, always-on-top,
// click-through in-game HUD plus a system tray, wrapping the existing local server.
//
// The server (src/overlay-server.ts) is unchanged: Electron just manages its
// lifecycle and points a frameless transparent BrowserWindow at the HUD it serves
// (http://localhost:8778/missions.html). OBS browser-source mode still works in
// parallel — the server serves both.
//
// Click-through is ON by default so the overlay never eats clicks meant for the
// game; toggle "Interactive" (tray or Ctrl+Alt+B) to click the picker/buttons.
// Requires SC in BORDERLESS WINDOWED — overlays can't draw over exclusive fullscreen.

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, shell, ipcMain, dialog } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { autoUpdater } = require("electron-updater");
// Hotkeys go through a low-level keyboard hook (see hotkeys.cjs) instead of Electron's
// globalShortcut, so they fire while Star Citizen has focus (RegisterHotKey does not).
const hotkeys = require("./hotkeys.cjs");
const { startFabCapture } = require("./capture.cjs");

// GPU hardware acceleration is OFF by default: the HUD is a transparent, always-on-top
// window composited over a fullscreen Vulkan game (Star Citizen), and GPU-compositing it
// crashes AMD drivers (device-lost / TDR — overlay ON = CTD, OFF = fine). Software
// rendering is safe for a text HUD. Users with GPU headroom can turn it back on in
// settings (SC is CPU-bound, so this trades a little CPU either way). Read from the
// server's config.json here because it must run BEFORE app "ready".
function hwAccelEnabled() {
  try {
    const p = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "config.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).hwAccel === true;
  } catch {
    return false; // default OFF (crash-safe)
  }
}
// AMD compatibility mode (opt-in, restart-required). Even with hardware acceleration off, the
// transparent HUD is still GPU-COMPOSITED by Windows via DirectComposition + Multiplane Overlay
// (MPO) over the game's Vulkan swapchain — disableHardwareAcceleration stops GPU *rendering* of
// the page, not GPU *compositing* of the window. That DComp/MPO surface presenting over an AMD
// Vulkan present is the device-lost/TDR crash. This mode forces the window fully off the GPU
// compositing path (software compositing, no occlusion polling) AND loads the lite HUD skin
// (see AMD_COMPAT in createOverlay). See the AMD-tester crash log: STATUS_CRYENGINE_GPU_CRASH.
function amdCompatEnabled() {
  try {
    const p = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "config.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).amdCompat === true;
  } catch {
    return false;
  }
}
const AMD_COMPAT = amdCompatEnabled();
if (AMD_COMPAT) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
} else if (!hwAccelEnabled()) {
  app.disableHardwareAcceleration();
}

// Master overlay switch, persisted in its OWN file (the sidecar owns config.json and
// rewrites it on unrelated changes, which would clobber a flag stored there). Default ON.
function overlayStateFile() {
  return path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "overlay-state.json");
}
function readOverlayEnabled() {
  try {
    return JSON.parse(fs.readFileSync(overlayStateFile(), "utf8")).enabled !== false;
  } catch {
    return true; // default ON
  }
}
function writeOverlayEnabled(on) {
  try {
    fs.mkdirSync(path.dirname(overlayStateFile()), { recursive: true });
    fs.writeFileSync(overlayStateFile(), JSON.stringify({ enabled: on }));
  } catch (e) {
    console.error("[electron] overlay-state write failed", String(e));
  }
}

const ROOT = path.join(__dirname, "..");
// The app version from package.json (works packaged + in dev). app.getVersion() returns
// Electron's own version when launched on a script rather than a packaged app, so read the
// manifest directly and fall back only if that fails.
const APP_VERSION = (() => {
  try { const v = require(path.join(ROOT, "package.json")).version; if (v) return v; } catch { /* fall through */ }
  return app.getVersion();
})();
const PORT = 8778;
const HUD_URL = `http://localhost:${PORT}/missions.html`;
const CONFIG_URL = `http://localhost:${PORT}/config.html`;

let server = null;
let overlay = null;
let configWin = null;
let tray = null;
let hovering = false; // pointer is over the HUD (reported by the page)
let locked = false; // force click-through always (ignore hover), for uninterrupted play
let moveMode = false; // arrange mode: show the drag banner/handles (VISUAL only — interactivity stays hover-based)
let modalOpen = false; // a HUD modal (what's-new card / hub) is up — stay hover-interactive even if locked
let dragging = false; // an active drag/resize gesture on THIS window — force it interactive so it can't drop
// Mining Assistant window — mirrors the HUD's hover-to-click shell so it behaves identically
// (click-through until the pointer is over it, cog stays clickable).
let miningHovering = false; // pointer is over the mining window (reported by the page)
let miningMoveMode = false; // arrange mode for the mining window (visual only)
let miningModalOpen = false; // the mining cog menu is open — keep it clickable
let miningDragging = false; // an active drag/resize gesture on the mining window
let miningAutoSuppress = 0; // auto-show is suppressed until this timestamp (set on a manual hide)
let overlayEnabled = true; // master switch — false = HUD window destroyed, tracking still runs
let manualCheck = false; // true while a tray-triggered update check is in flight (gates dialogs)
// Background update download in flight: { version, percent, bps } — drives the live
// progress line in the tray menu + the tray tooltip. null when idle.
let updateDownload = null;

// ── server lifecycle ────────────────────────────────────────────────────────
function startServer() {
  if (app.isPackaged) {
    // Prod: the bun-compiled server binary shipped as an extraResource (no Node/tsx
    // on the user's machine). cwd = its dir so assetDir finds overlay/ + data/.
    const exe = path.join(process.resourcesPath, "server", "sc-overlay-server.exe");
    // Inject the authoritative app version — the bun sidecar can't read package.json.
    server = spawn(exe, { cwd: path.dirname(exe), env: { ...process.env, APP_VERSION }, stdio: "ignore" });
  } else {
    // Dev: run the TS server via tsx.
    server = spawn("npx tsx src/overlay-server.ts", {
      cwd: ROOT,
      shell: true,
      env: { ...process.env, APP_VERSION },
      stdio: "ignore",
    });
  }
  server.on("exit", (code) => {
    if (code && !app.isQuitting) console.error(`[electron] server exited (${code})`);
  });
}

function waitForServer(tries = 60) {
  return new Promise((resolve) => {
    const ping = () => {
      http
        .get(`http://localhost:${PORT}/api/missions`, (r) => {
          r.resume();
          resolve(true);
        })
        .on("error", () => {
          if (--tries <= 0) return resolve(false);
          setTimeout(ping, 250);
        });
    };
    ping();
  });
}

// The overlay is now a FULL-SCREEN transparent canvas that hosts free-floating widgets
// (the Blueprint panel, later Mining) — like Streamlabs/OBS. It covers the whole primary
// display (same precedent as bindingWin) so a widget's decorations (e.g. Drake's duct-tape
// corners) can hang into open canvas instead of being clipped by a panel-sized window, and
// so widgets can be dragged/scaled freely inside it. Per-widget position/size/visibility
// live in widgets.json (see below), NOT in a window-bounds file — the window itself is fixed
// full-screen. Click-through everywhere except the widget the pointer is over (see applyMouse).
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay(); // full display — the widget canvas
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    focusable: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "preload.cjs") },
  });
  // Float above borderless fullscreen games.
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Clear any cached copy + cache-bust the URL so UI changes always show up.
  const hudUrl = `${HUD_URL}?v=${Date.now()}${AMD_COMPAT ? "&lite=1" : ""}`;
  overlay.webContents.session.clearCache().finally(() => overlay.loadURL(hudUrl));
  applyMouse();
  overlay.on("closed", () => {
    overlay = null;
  });
}

// ── per-widget layout persistence (canvas model) ─────────────────────────────
// Each widget's {x, y, scale, visible} lives in userData/widgets.json (in %APPDATA%, so it
// survives updates — same directory class as the *-bounds.json files). The page reads it on
// load and writes it back (debounced) as the user drags/resizes in arrange mode.
function widgetsFile() {
  return path.join(app.getPath("userData"), "widgets.json");
}
let widgetCache = null;
let widgetSaveTimer = null;
function readWidgets() {
  if (widgetCache) return widgetCache;
  try { widgetCache = JSON.parse(fs.readFileSync(widgetsFile(), "utf8")) || {}; }
  catch { widgetCache = {}; }
  return widgetCache;
}
function saveWidget(id, layout) {
  if (!id || !layout || typeof layout !== "object") return;
  const all = readWidgets();
  all[id] = { ...(all[id] || {}), ...layout };
  clearTimeout(widgetSaveTimer);
  widgetSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(widgetsFile(), JSON.stringify(all)); }
    catch { /* non-fatal */ }
  }, 400);
}

function applyMouse() {
  if (!overlay) return;
  // The overlay is a full-screen canvas STACKED with the mining canvas, so it must stay
  // click-through except where its own widget is — otherwise (as full-screen interactive) it
  // would block the other window entirely. This is true even in arrange mode: interactivity
  // stays hover-based so clicks route to whichever widget is under the cursor, regardless of
  // which window is on top. Exceptions that force interactive: an active drag on THIS window
  // (so a gesture can't drop), or an open modal (hub / what's-new — clickable even when locked).
  // forward:true keeps mousemove flowing so the page can detect enter/leave even while ignored.
  const interactive = dragging || modalOpen || (hovering && !locked);
  overlay.setIgnoreMouseEvents(!interactive, { forward: true });
}

// ── binding-chart PNG overlay ─────────────────────────────────────────────────
// A separate full-screen, transparent, always-click-through window that shows a
// user-chosen PNG (e.g. a joystick binding chart), toggled by a global hotkey. It's
// reference-only, so it never takes focus or eats clicks.
let bindingWin = null;
function createBinding() {
  const { bounds } = screen.getPrimaryDisplay(); // full display, covers the whole screen
  bindingWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, fullscreenable: false, focusable: false, show: false,
    webPreferences: { contextIsolation: true },
  });
  bindingWin.setAlwaysOnTop(true, "screen-saver");
  bindingWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bindingWin.setIgnoreMouseEvents(true, { forward: true }); // always click-through
  bindingWin.loadURL(`http://localhost:${PORT}/binding.html`);
  bindingWin.on("closed", () => { bindingWin = null; });
}
function toggleBinding() {
  if (!bindingWin) createBinding();
  if (bindingWin.isVisible()) { bindingWin.hide(); return; }
  // Bump the page hash so it re-fetches the image (picks up a changed PNG), then show
  // WITHOUT stealing focus from the game.
  bindingWin.webContents.executeJavaScript(`location.hash = "s" + Date.now();`).catch(() => {});
  bindingWin.showInactive();
}

// Patch the sidecar config over HTTP (the config lives in the sidecar process).
async function postConfig(patch) {
  try {
    await fetch(`http://localhost:${PORT}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
  } catch { /* sidecar not up yet — non-fatal */ }
}

// ── Mining Assistant window ───────────────────────────────────────────────────
// A second full-screen transparent canvas (same model as the overlay) hosting the Mining
// Assistant as its own free-floating, independently-scalable widget — so it can be dragged
// and corner-resized like the Blueprint panel, without a panel-sized window clipping it or
// anchoring it. Click-through everywhere except over the widget; the two canvases stack and
// each becomes interactive only over its own widget. Hidden (not destroyed) on hide so
// countdowns + state persist. Its position/size live in widgets.json (keyed "mining").
let miningWin = null;
function createMining() {
  const { bounds } = screen.getPrimaryDisplay(); // full display — the widget canvas
  miningWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, fullscreenable: false, focusable: true, show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "mining-preload.cjs"), autoplayPolicy: "no-user-gesture-required" },
  });
  miningWin.setAlwaysOnTop(true, "screen-saver");
  miningWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  miningWin.loadURL(`http://localhost:${PORT}/mining.html?v=${Date.now()}${AMD_COMPAT ? "&lite=1" : ""}`);
  applyMiningMouse();
  miningWin.on("close", (e) => { e.preventDefault(); hideMining(); });
}
// Same hover-based rule as the HUD's applyMouse (this window has no lock): click-through
// except over its own widget, an active drag, or an open cog menu — so it never blocks the
// stacked HUD canvas. NOT forced interactive by arrange mode (that was the click-blocking bug).
function applyMiningMouse() {
  if (!miningWin) return;
  miningWin.setIgnoreMouseEvents(!(miningDragging || miningModalOpen || miningHovering), { forward: true });
}
// Reposition mode for the mining window (grab handle / "Done" in the page). Hover-toggling
// is suspended so the window can't slip out from under the cursor mid-drag.
function setMiningMoveMode(on) {
  miningMoveMode = on;
  applyMiningMouse();
  if (on && miningWin) miningWin.focus();
  miningWin?.webContents.send("mining:move-mode", on);
}
// Hiding via tray/hotkey/close suppresses the auto-show pop-up briefly, so it doesn't
// immediately re-appear on the next scan/refinery read the player didn't ask to see.
function hideMining() {
  if (!miningWin) return;
  miningMoveMode = false;
  miningAutoSuppress = Date.now() + 90000;
  miningWin.hide();
}
function toggleMining() {
  if (!miningWin) createMining();
  if (miningWin.isVisible()) { hideMining(); return; }
  miningWin.showInactive(); // never steal focus from the game
  applyMiningMouse();
}
ipcMain.on("mining:hide", hideMining);

// Live-rebindable global shortcut for the binding-chart overlay — swap it WITHOUT a restart.
// Returns {ok:true} or {ok:false,error} so the config window can warn (invalid combo, or the
// combo is already claimed by another app).
// Live-rebindable global shortcut for showing/hiding the overlay HUD. Same shape as
// registerBindingHotkey so the config window can warn on an invalid / in-use combo.
let overlayAccel = null;
function registerOverlayHotkey(accel) {
  if (overlayAccel) hotkeys.unregister(overlayAccel);
  overlayAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleShow);
  if (r.ok) overlayAccel = accel;
  return r;
}

let bindingAccel = null;
function registerBindingHotkey(accel) {
  if (bindingAccel) hotkeys.unregister(bindingAccel);
  bindingAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleBinding);
  if (r.ok) bindingAccel = accel;
  return r;
}

// Live-rebindable hotkey for showing/hiding the Mining Assistant window. Same shape as the
// overlay/binding registrations so the config window can warn on an invalid / in-use combo.
let miningAccel = null;
function registerMiningHotkey(accel) {
  if (miningAccel) hotkeys.unregister(miningAccel);
  miningAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleMining);
  if (r.ok) miningAccel = accel;
  return r;
}

// ── actions ─────────────────────────────────────────────────────────────────
function toggleLock() {
  locked = !locked;
  applyMouse();
  refreshTray();
}

// Reposition mode: whole panel becomes a drag surface (banner + Done in the page),
// hover-toggling suspended so the window can't slip out from under the cursor.
function setMoveMode(on) {
  moveMode = on;
  applyMouse();
  if (on && overlay) overlay.focus();
  overlay?.webContents.send("overlay:move-mode", on);
  refreshTray();
}
// Global arrange: one cohesive overlay app, so entering "arrange" puts EVERY visible widget
// (Blueprint canvas + Mining canvas) into move/resize at once, and either window's "Done"
// exits for all. Triggered by any widget's grip, the global cog's Arrange button, the tray,
// or Ctrl+Alt+M.
let arrangeAll = false;
function setArrangeAll(on) {
  arrangeAll = on;
  setMoveMode(on); // Blueprint widget (also refreshes the tray)
  if (miningWin && !miningWin.isDestroyed() && miningWin.isVisible()) setMiningMoveMode(on);
  else miningMoveMode = false;
}
function toggleMove() {
  setArrangeAll(!arrangeAll);
}

// Master overlay switch (persisted). OFF fully DESTROYS the transparent always-on-top HUD
// window — not just hides it — so it can't composite over the game (the AMD device-lost /
// TDR trigger), while the sidecar server + game.log watcher keep running so blueprint
// tracking + sync are unaffected. This is both the crash workaround and the "is it the
// overlay?" diagnostic. Reflected live in the tray + any open config window.
function setOverlayEnabled(on) {
  overlayEnabled = on;
  writeOverlayEnabled(on);
  if (on) {
    if (!overlay) createOverlay();
  } else {
    moveMode = false;
    if (overlay) {
      overlay.destroy();
      overlay = null;
    }
  }
  configWin?.webContents.send("overlay:enabled-changed", on);
  refreshTray();
}
function toggleShow() {
  setOverlayEnabled(!overlayEnabled);
}

function openConfig() {
  if (configWin) { configWin.show(); configWin.focus(); return; }
  configWin = new BrowserWindow({
    width: 780,
    height: 820,
    title: "SC Blueprint Tracker — Config",
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "config-preload.cjs") },
  });
  // The overlays float at the highest ("screen-saver") always-on-top level so they clear a
  // fullscreen game. Put the settings window at the SAME level so it's never buried under the
  // binding-chart / HUD overlay — otherwise you can't get back to settings once one is up.
  configWin.setAlwaysOnTop(true, "screen-saver");
  configWin.loadURL(`${CONFIG_URL}?v=${Date.now()}`);
  configWin.on("closed", () => {
    configWin = null;
  });
}

// ── run-as-administrator (for in-game hotkeys) ────────────────────────────────
// Star Citizen runs elevated (Easy Anti-Cheat), and Windows UIPI won't let a normal-privilege
// app's low-level keyboard hook see keystrokes while an elevated window is focused. So the
// hotkeys only work in-game if THIS app is elevated too. We don't force it (no UAC nag for
// casual users) — the config window offers an opt-in "Restart as administrator".
let cachedElevated = null; // null=unknown, true/false once checked (doesn't change per run)
function checkElevated() {
  return new Promise((resolve) => {
    if (cachedElevated !== null) return resolve(cachedElevated);
    if (process.platform !== "win32") { cachedElevated = false; return resolve(false); }
    try {
      const { execFile } = require("node:child_process");
      execFile("powershell", ["-NoProfile", "-Command",
        "[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)"],
        { windowsHide: true, timeout: 4000 }, (err, stdout) => {
          cachedElevated = !err && /true/i.test(String(stdout));
          resolve(cachedElevated);
        });
    } catch { cachedElevated = false; resolve(false); }
  });
}
// Relaunch the app elevated via ShellExecute "runas" (UAC prompt), then quit this instance so
// the elevated one can take the single-instance lock + the sidecar port. Detached PowerShell
// so the elevation survives our exit.
function restartAsAdmin() {
  try {
    const exe = process.execPath;
    const args = app.isPackaged ? [] : [path.join(__dirname, "main.cjs")]; // dev: pass the entry script (absolute)
    // 🔑 -WorkingDirectory must be a REAL directory. ROOT is `<install>\resources\app.asar`
    // when packaged (a FILE, not a dir) → Start-Process fails ("directory name is invalid")
    // and the elevated instance never launches. Use the exe's own dir when packaged.
    const wd = app.isPackaged ? path.dirname(exe) : ROOT;
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const argList = args.length ? ` -ArgumentList @(${args.map(q).join(",")})` : "";
    // Detached helper owns the handoff: wait for THIS instance to fully exit, then sweep any
    // leftover sidecar, THEN launch elevated. Without the wait, the new instance races the dying
    // old one and bounces off the single-instance lock / held :8778 — leaving nothing running and
    // orphaned processes to kill by hand. (Name sweep covers the packaged sidecar; dev's tsx child
    // is handled by before-quit's server.kill.)
    const ps = [
      `Wait-Process -Id ${process.pid} -Timeout 10 -ErrorAction SilentlyContinue`,
      `Get-Process -Name 'sc-overlay-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
      `Start-Process -FilePath ${q(exe)}${argList} -WorkingDirectory ${q(wd)} -Verb RunAs`,
    ].join("; ");
    spawn("powershell", ["-NoProfile", "-Command", ps], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    app.isQuitting = true;
    setTimeout(() => app.quit(), 300); // begin our own shutdown; the helper waits for us to exit
  } catch (e) {
    console.error("[restart-as-admin]", String(e));
  }
}

function postApi(p) {
  const req = http.request({ host: "localhost", port: PORT, path: p, method: "POST" }, (r) => r.resume());
  req.on("error", () => {});
  req.end();
}
function verifyFromLogs() {
  postApi("/api/missions/verify");
}
function refreshMissions() {
  // Re-read the log and drop stale missions (e.g. after a server change).
  postApi("/api/missions/refresh");
}

// Auto-update via electron-updater. Feed URL comes from the `publish` config
// (subliminal.gg proxies the private GitHub release). Silent background download,
// then a prompt to restart. No-op in dev (unpackaged).
function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  // Force a full streamed download instead of a block-differential one. The differential path
  // emits NO download-progress events (so the tray sits at 0% the whole time), and because our
  // installer isn't block-aligned across builds it re-downloads nearly the full file anyway via
  // hundreds of slow ranged requests. A single full download is faster here and drives the tray %.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.on("update-downloaded", (info) => {
    updateDownload = null;
    refreshTray();
    if (tray) tray.setToolTip("SC Blueprint Tracker");
    dialog
      .showMessageBox({
        type: "info",
        title: "Update ready",
        message: `SC Blueprint Tracker ${info.version} is ready to install.`,
        detail: "Restart now to update?",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r) => {
        if (r.response === 0) {
          app.isQuitting = true;
          autoUpdater.quitAndInstall();
        }
      });
  });
  // Manual checks (tray "Check for updates") get feedback; the automatic launch +
  // 3-hourly checks stay silent (manualCheck gates the extra dialogs).
  autoUpdater.on("update-available", (info) => {
    // Start the tray progress readout for BOTH auto and manual checks.
    updateDownload = { version: info.version, percent: 0, bps: 0 };
    refreshTray();
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox({
      type: "info", title: "Update available",
      message: `SC Blueprint Tracker ${info.version} is available.`,
      detail: "Downloading in the background — the tray menu shows live progress, and you'll be prompted to restart when it's ready.",
      buttons: ["OK"],
    });
  });
  // Live download progress → tray menu line + tray tooltip. Menu rebuilds are
  // throttled to whole-percent changes (an open menu is a snapshot; the next
  // open shows the current number).
  autoUpdater.on("download-progress", (p) => {
    if (!updateDownload) updateDownload = { version: "", percent: 0, bps: 0 };
    const pct = Math.floor(p.percent);
    updateDownload.bps = p.bytesPerSecond;
    if (tray) tray.setToolTip(`SC Blueprint Tracker — downloading update ${pct}%`);
    if (pct !== updateDownload.percent) {
      updateDownload.percent = pct;
      refreshTray();
    }
  });
  autoUpdater.on("update-not-available", () => {
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox({
      type: "info", title: "No updates",
      message: `You're on the latest version (${app.getVersion()}).`,
      buttons: ["OK"],
    });
  });
  autoUpdater.on("error", (e) => {
    console.error("[updater]", String(e));
    updateDownload = null;
    refreshTray();
    if (tray) tray.setToolTip("SC Blueprint Tracker");
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox({
      type: "error", title: "Update check failed",
      message: "Couldn't check for updates right now.", detail: String(e),
      buttons: ["OK"],
    });
  });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 3 * 60 * 60 * 1000);
}

// Tray "Check for updates" — kicks a check with visible feedback. In dev (unpackaged)
// there's no updater, so just say so.
function checkForUpdatesManual() {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: "info", title: "Check for updates",
      message: "Updates are only available in the installed app.",
      buttons: ["OK"],
    });
    return;
  }
  manualCheck = true;
  autoUpdater.checkForUpdates().catch((e) => {
    manualCheck = false;
    console.error("[updater]", String(e));
  });
}

// ── tray ────────────────────────────────────────────────────────────────────
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show in-game overlay",
        type: "checkbox",
        checked: overlayEnabled,
        click: () => setOverlayEnabled(!overlayEnabled),
      },
      ...(overlayEnabled
        ? [
            { label: moveMode ? "Done arranging" : "Arrange widgets…", click: toggleMove },
            {
              label: "Lock (always click-through)",
              type: "checkbox",
              checked: locked,
              click: toggleLock,
            },
          ]
        : [{ label: "Overlay off — tracking still running", enabled: false }]),
      { type: "separator" },
      { label: "Mining Assistant", click: toggleMining },
      {
        label: "Binding chart overlay",
        type: "checkbox",
        checked: !!(bindingWin && bindingWin.isVisible()),
        click: () => { toggleBinding(); refreshTray(); },
      },
      { label: "Refresh missions (re-read log)", click: refreshMissions },
      { label: "Verify from logs", click: verifyFromLogs },
      { label: "Open config…", click: openConfig },
      ...(cachedElevated === false
        ? [{ label: "Restart as administrator (for in-game hotkeys)", click: restartAsAdmin }]
        : []),
      { type: "separator" },
      ...(updateDownload
        ? [{
            label: `Downloading ${updateDownload.version ? "v" + updateDownload.version : "update"} — ${updateDownload.percent}%` +
              (updateDownload.bps ? ` (${(updateDownload.bps / 1048576).toFixed(1)} MB/s)` : ""),
            enabled: false,
          }]
        : [{ label: "Check for updates…", click: checkForUpdatesManual }]),
      { label: `Version ${app.getVersion()}`, enabled: false },
      {
        label: "View source on GitHub",
        click: () => shell.openExternal("https://github.com/SubliminalsTV-Projects/sc-loadout-overlay"),
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

function createTray() {
  // The asar only packs electron/**, so overlay/ isn't inside it — in the packaged
  // app the icon ships with the sidecar under resources/server/overlay/. Resolve
  // there when packaged, else from the repo (dev). (Was ROOT/overlay → blank tray.)
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "server", "overlay", "tray-icon.png")
    : path.join(ROOT, "overlay", "tray-icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip("SC Blueprint Tracker");
  tray.on("click", toggleShow);
  refreshTray();
}

// ── app lifecycle ─────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (overlay) {
      overlay.show();
      refreshTray();
    }
  });

  app.whenReady().then(async () => {
    startServer();
    const up = await waitForServer();
    if (!up) console.error("[electron] server did not come up on :" + PORT);
    overlayEnabled = readOverlayEnabled();
    if (overlayEnabled) createOverlay();
    createTray();
    setupUpdater();
    hotkeys.register("Control+Alt+L", toggleLock); // lock/unlock click-through
    hotkeys.register("Control+Alt+M", toggleMove); // move/reposition mode
    // Configurable global hotkeys (live-rebindable from the config window), read from the
    // persisted config: overlay show/hide (default F3) + binding-chart PNG (default Alt+F3).
    let overlayKey = "F3";
    let bindKey = "Alt+F3";
    let miningKey = "Shift+F3";
    try {
      const p = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "config.json");
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      if (c.overlayHotkey) overlayKey = c.overlayHotkey;
      if (c.bindingHotkey) bindKey = c.bindingHotkey;
      if (c.miningHotkey) miningKey = c.miningHotkey;
    } catch { /* defaults */ }
    registerOverlayHotkey(overlayKey);
    registerBindingHotkey(bindKey);
    registerMiningHotkey(miningKey);
    // Learn our elevation state (async) so the tray can offer "Restart as administrator" when
    // we're NOT elevated — the state hotkeys-over-a-focused-game depend on.
    checkElevated().then(() => refreshTray());
    // Auto-show: pre-create the (hidden) Mining Assistant window so it's listening on the
    // event stream and can pop itself when the scanner/refinery screen is detected.
    try {
      const p = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "config.json");
      if (JSON.parse(fs.readFileSync(p, "utf8")).miningAutoShow === true) createMining();
    } catch { /* default off */ }
    // Opt-in fabricator screen-capture loop (config.fabCapture). No-op until enabled.
    startFabCapture({
      port: PORT,
      configDir: path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker"),
      onStatus: (s) => { try { overlay?.webContents.send("overlay:ocr", s); } catch { /* window gone */ } },
    });
  });

  // Native PNG picker for the config window (renderers can't open OS dialogs).
  ipcMain.handle("pick-png", async () => {
    const r = await dialog.showOpenDialog(configWin ?? undefined, {
      title: "Choose a PNG to overlay",
      filters: [{ name: "PNG image", extensions: ["png"] }],
      properties: ["openFile"],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  // Mining Assistant: custom alert-tone WAV picker + show (for auto-pop-up). The chosen
  // path is persisted server-side (config.miningTone) so the sidecar can serve it.
  ipcMain.handle("mining:pick-tone", async () => {
    const r = await dialog.showOpenDialog(miningWin ?? undefined, {
      title: "Choose an alert-tone WAV",
      filters: [{ name: "WAV audio", extensions: ["wav"] }],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths.length) return false;
    await postConfig({ miningTone: r.filePaths[0] });
    return true;
  });
  ipcMain.handle("mining:clear-tone", async () => { await postConfig({ miningTone: "" }); return true; });
  // Auto-show from the page (a new scan / refinery read). Gated by the suppress window so a
  // manual hide keeps it out of the way for a bit. Never steals focus from the game.
  ipcMain.on("mining:show", () => {
    if (Date.now() < miningAutoSuppress) return;
    if (!miningWin) createMining();
    if (!miningWin.isVisible()) { miningWin.showInactive(); applyMiningMouse(); }
  });

  // Config window's "Show in-game overlay" toggle (crash workaround). Owned here, not by
  // the sidecar config, so destroy/create is immediate.
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:is-elevated", () => checkElevated());
  ipcMain.handle("app:restart-as-admin", () => { restartAsAdmin(); return true; });
  ipcMain.handle("overlay:get-enabled", () => overlayEnabled);
  ipcMain.handle("overlay:set-enabled", (_e, on) => {
    setOverlayEnabled(!!on);
    return overlayEnabled;
  });

  // Native FILE picker for the game.log path — an open-FILE dialog (not a folder), filtered
  // to .log, so users select the actual game.log rather than the directory it lives in.
  ipcMain.handle("pick-log", async (_e, current) => {
    const r = await dialog.showOpenDialog(configWin ?? undefined, {
      title: "Select your game.log file",
      defaultPath: typeof current === "string" && current ? current : undefined,
      filters: [
        { name: "Star Citizen log (game.log)", extensions: ["log"] },
        { name: "All files", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  // Live-apply a captured hotkey (config window), no restart. Persistence is handled
  // separately by the config save; these just (re)register the global shortcut.
  ipcMain.handle("set-overlay-hotkey", (_e, accel) =>
    registerOverlayHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-binding-hotkey", (_e, accel) =>
    registerBindingHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-mining-hotkey", (_e, accel) =>
    registerMiningHotkey(typeof accel === "string" ? accel : ""));

  // The HUD page reports hover enter/leave → become clickable only while hovered.
  ipcMain.on("overlay:hover", (_e, on) => {
    hovering = !!on;
    applyMouse();
  });
  // A HUD modal (what's-new card / hub) opened/closed → keep it clickable even under lock.
  ipcMain.on("overlay:modal", (_e, on) => {
    modalOpen = !!on;
    applyMouse();
  });
  // An active drag/resize gesture on the HUD widget → force this window interactive for the
  // gesture so a fast pointer can't slip off the widget and drop the drag (the window is
  // otherwise click-through except over the widget, so the stacked mining canvas isn't blocked).
  ipcMain.on("overlay:drag-lock", (_e, on) => {
    dragging = !!on;
    applyMouse();
  });
  // The cog's "Open settings…" opens the full config window.
  ipcMain.on("overlay:open-settings", () => openConfig());
  // The live-on-Twitch diamond opens the stream in the default browser (https only).
  ipcMain.on("overlay:open-url", (_e, url) => {
    if (typeof url === "string" && /^https:\/\//i.test(url)) shell.openExternal(url);
  });
  // Any widget's grab handle (or the global cog's Arrange button) enters GLOBAL arrange —
  // all visible widgets become movable; either "Done" exits for all.
  ipcMain.on("overlay:begin-move", () => setArrangeAll(true));
  ipcMain.on("overlay:end-move", () => setArrangeAll(false));
  // Per-widget layout (canvas model): the page fetches saved widget layouts on load and
  // saves them back as the user drags/resizes. Scale is now a property of each widget inside
  // the full-screen canvas, not a resize of the overlay window (which is fixed full-screen).
  ipcMain.handle("overlay:get-widgets", () => readWidgets());
  ipcMain.on("overlay:save-widget", (_e, id, layout) => saveWidget(id, layout));

  // ── global widget on/off (from the in-overlay hub) ──────────────────────────
  // Only the Mining Assistant is a hub toggle — the Blueprint widget hides in-page (it's in
  // the shell window's own DOM) and the Binding chart is hotkey-only (never kept on). Widget
  // state feeds the hub checkbox; a change is pushed back so it stays in sync with the tray.
  function miningVisible() { return !!(miningWin && !miningWin.isDestroyed() && miningWin.isVisible()); }
  function pushWidgetStates() {
    try { overlay?.webContents.send("overlay:widget-states", { mining: miningVisible() }); } catch { /* window gone */ }
  }
  ipcMain.handle("app:widget-states", () => ({ mining: miningVisible() }));
  ipcMain.on("app:set-mining", (_e, on) => {
    if (on) { if (!miningWin) createMining(); if (!miningWin.isVisible()) { miningAutoSuppress = 0; miningWin.showInactive(); applyMiningMouse(); } }
    else hideMining();
    pushWidgetStates();
  });

  // Mining Assistant window: same hover-to-click + move-mode + cog-modal bridge as the HUD.
  ipcMain.on("mining:hover", (_e, on) => {
    miningHovering = !!on;
    applyMiningMouse();
  });
  ipcMain.on("mining:modal", (_e, on) => {
    miningModalOpen = !!on;
    applyMiningMouse();
  });
  ipcMain.on("mining:drag-lock", (_e, on) => {
    miningDragging = !!on;
    applyMiningMouse();
  });
  // Mining's cog was clicked → summon the global cog in the shell (HUD) window.
  ipcMain.on("mining:summon-cog", () => { try { overlay?.webContents.send("overlay:summon-cog"); } catch { /* shell gone */ } });
  // Mining's grip/Done also drives GLOBAL arrange (one cohesive overlay).
  ipcMain.on("mining:begin-move", () => setArrangeAll(true));
  ipcMain.on("mining:end-move", () => setArrangeAll(false));

  // Tray app — keep running when the overlay window is closed.
  app.on("window-all-closed", (e) => {
    e.preventDefault?.();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    hotkeys.unregisterAll();
    if (server) server.kill();
    if (tray) tray.destroy();
  });
}
