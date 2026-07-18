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

const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, screen, shell, ipcMain, dialog } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { autoUpdater } = require("electron-updater");
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
let moveMode = false; // reposition mode: fully interactive + drag banner, hover suspended
let modalOpen = false; // a HUD modal (what's-new card) is up — stay hover-interactive even if locked
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

// ── overlay window ──────────────────────────────────────────────────────────
function boundsFile() {
  return path.join(app.getPath("userData"), "overlay-bounds.json");
}
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    // Only restore if it lands on a connected display (avoids off-screen windows).
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x >= a.x - 50 && b.y >= a.y - 50 && b.x < a.x + a.width && b.y < a.y + a.height;
    });
    if (onScreen && b.width && b.height) return b;
  } catch {
    /* none saved */
  }
  return null;
}
let saveTimer = null;
function saveBounds() {
  if (!overlay) return;
  clearTimeout(saveTimer);
  const b = overlay.getBounds();
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(boundsFile(), JSON.stringify(b));
    } catch {
      /* non-fatal */
    }
  }, 400);
}

function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 400;
  const h = 760;
  const saved = loadBounds();
  overlay = new BrowserWindow({
    width: saved?.width ?? w,
    height: saved?.height ?? h,
    x: saved?.x ?? workArea.x + workArea.width - w - 24,
    y: saved?.y ?? workArea.y + 40,
    frame: false,
    transparent: true,
    resizable: true,
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
  overlay.on("moved", saveBounds);
  overlay.on("resize", saveBounds);
  overlay.on("closed", () => {
    overlay = null;
  });
}

function applyMouse() {
  if (!overlay) return;
  // Move mode = fully interactive (so a drag can't be dropped by hover-toggling).
  // Otherwise click-through unless the pointer is over the HUD (and not locked). A
  // modal (what's-new card) overrides lock so it can always be closed.
  // forward:true keeps mousemove flowing so the page can detect enter/leave.
  overlay.setIgnoreMouseEvents(moveMode ? false : (locked && !modalOpen) ? true : !hovering, { forward: true });
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

// ── Mining Assistant window ───────────────────────────────────────────────────
// A separate, INTERACTIVE always-on-top tool window (signature scanner + refinery
// timers). Unlike the HUD it takes focus and clicks (target picker, remove buttons),
// and the ✕ hides it rather than destroying it so countdowns + state persist.
let miningWin = null;
function createMining() {
  const { workArea } = screen.getPrimaryDisplay();
  miningWin = new BrowserWindow({
    width: 360, height: 600,
    x: workArea.x + workArea.width - 384, y: workArea.y + 60,
    frame: false, transparent: true, resizable: true, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, fullscreenable: false, focusable: true, show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "mining-preload.cjs"), autoplayPolicy: "no-user-gesture-required" },
  });
  miningWin.setAlwaysOnTop(true, "screen-saver");
  miningWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  miningWin.loadURL(`http://localhost:${PORT}/mining.html?v=${Date.now()}`);
  miningWin.on("close", (e) => { e.preventDefault(); miningWin.hide(); });
}
function toggleMining() {
  if (!miningWin) createMining();
  if (miningWin.isVisible()) { miningWin.hide(); return; }
  miningWin.show();
}
ipcMain.on("mining:hide", () => { if (miningWin) miningWin.hide(); });

// Live-rebindable global shortcut for the binding-chart overlay — swap it WITHOUT a restart.
// Returns {ok:true} or {ok:false,error} so the config window can warn (invalid combo, or the
// combo is already claimed by another app).
// Live-rebindable global shortcut for showing/hiding the overlay HUD. Same shape as
// registerBindingHotkey so the config window can warn on an invalid / in-use combo.
let overlayAccel = null;
function registerOverlayHotkey(accel) {
  try {
    if (overlayAccel) globalShortcut.unregister(overlayAccel);
  } catch {
    /* ignore */
  }
  overlayAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  try {
    if (globalShortcut.register(accel, toggleShow)) {
      overlayAccel = accel;
      return { ok: true };
    }
    return { ok: false, error: "in_use" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

let bindingAccel = null;
function registerBindingHotkey(accel) {
  try {
    if (bindingAccel) globalShortcut.unregister(bindingAccel);
  } catch {
    /* ignore */
  }
  bindingAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  try {
    if (globalShortcut.register(accel, toggleBinding)) {
      bindingAccel = accel;
      return { ok: true };
    }
    return { ok: false, error: "in_use" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
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
function toggleMove() {
  setMoveMode(!moveMode);
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
  if (configWin) return configWin.focus();
  configWin = new BrowserWindow({
    width: 780,
    height: 820,
    title: "SC Blueprint Tracker — Config",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "config-preload.cjs") },
  });
  configWin.loadURL(`${CONFIG_URL}?v=${Date.now()}`);
  configWin.on("closed", () => {
    configWin = null;
  });
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
            { label: moveMode ? "Done moving" : "Move overlay…", click: toggleMove },
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
      { label: "Refresh missions (re-read log)", click: refreshMissions },
      { label: "Verify from logs", click: verifyFromLogs },
      { label: "Open config…", click: openConfig },
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
    globalShortcut.register("Control+Alt+L", toggleLock); // lock/unlock click-through
    globalShortcut.register("Control+Alt+M", toggleMove); // move/reposition mode
    // Configurable global hotkeys (live-rebindable from the config window), read from the
    // persisted config: overlay show/hide (default F3) + binding-chart PNG (default Alt+F3).
    let overlayKey = "F3";
    let bindKey = "Alt+F3";
    try {
      const p = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "config.json");
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      if (c.overlayHotkey) overlayKey = c.overlayHotkey;
      if (c.bindingHotkey) bindKey = c.bindingHotkey;
    } catch { /* defaults */ }
    registerOverlayHotkey(overlayKey);
    registerBindingHotkey(bindKey);
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

  // Config window's "Show in-game overlay" toggle (crash workaround). Owned here, not by
  // the sidecar config, so destroy/create is immediate.
  ipcMain.handle("app:version", () => app.getVersion());
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

  // The HUD page reports hover enter/leave → become clickable only while hovered.
  ipcMain.on("overlay:hover", (_e, on) => {
    hovering = !!on;
    applyMouse();
  });
  // A HUD modal (what's-new card) opened/closed → keep it clickable even under lock.
  ipcMain.on("overlay:modal", (_e, on) => {
    modalOpen = !!on;
    applyMouse();
  });
  // The cog's "Open settings…" opens the full config window.
  ipcMain.on("overlay:open-settings", () => openConfig());
  // The live-on-Twitch diamond opens the stream in the default browser (https only).
  ipcMain.on("overlay:open-url", (_e, url) => {
    if (typeof url === "string" && /^https:\/\//i.test(url)) shell.openExternal(url);
  });
  // The page's grab handle enters move mode; the "Done" button leaves it.
  ipcMain.on("overlay:begin-move", () => {
    if (!moveMode) setMoveMode(true);
  });
  ipcMain.on("overlay:end-move", () => {
    if (moveMode) setMoveMode(false);
  });

  // Tray app — keep running when the overlay window is closed.
  app.on("window-all-closed", (e) => {
    e.preventDefault?.();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    globalShortcut.unregisterAll();
    if (server) server.kill();
    if (tray) tray.destroy();
  });
}
