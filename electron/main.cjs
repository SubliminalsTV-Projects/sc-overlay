// Electron shell for the SC Overlay — a transparent, always-on-top,
// click-through in-game HUD plus a system tray, wrapping the existing local server.
//
// The server (src/overlay-server.ts) is unchanged: Electron just manages its
// lifecycle and points a frameless transparent BrowserWindow at the HUD it serves
// (http://localhost:8778/missions.html). OBS browser-source mode still works in
// parallel — the server serves both.
//
// Click-through is ON by default so the overlay never eats clicks meant for the
// desktop. The upstream Ctrl+Alt+M arrange command is the single move/resize workflow for every
// visible widget. Held-F interaction remains globally available for normal widget controls. The native
// Linux build uses one transparent Overlay Manager BrowserWindow for Blueprint, Mining, Notepad,
// and browser shells.
// Requires SC in BORDERLESS WINDOWED — overlays can't draw over exclusive fullscreen.

const { app, BrowserWindow, WebContentsView, session, Tray, Menu, nativeImage, screen, shell, ipcMain, dialog } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
let autoUpdater = null;
if (process.platform === "win32") {
  try { ({ autoUpdater } = require("electron-updater")); } catch (e) { console.error("[updater] unavailable:", String(e)); }
}

// CachyOS/KDE defaults to Wayland, but this overlay and uiohook backend are most reliable
// through XWayland. Star Citizen under Wine also normally uses XWayland, so force Electron
// onto the same X11 display unless the user explicitly opts into native Wayland.
if (process.platform === "linux" && process.env.SC_TRACKER_NATIVE_WAYLAND !== "1") {
  app.commandLine.appendSwitch("ozone-platform", "x11");
}
app.setName("SC Blueprint Tracker"); // Keep existing KDE WM class and userData path for seamless upgrades.

const CONFIG_DIR = process.env.SC_TRACKER_CONFIG_DIR || (process.platform === "win32"
  ? path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker")
  : path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || ".", ".config"), "sc-blueprint-tracker"));
process.env.SC_TRACKER_CONFIG_DIR = CONFIG_DIR;
const UPDATES_SUPPORTED = process.platform === "win32" && !!autoUpdater;
// Hotkeys go through a low-level keyboard hook (see hotkeys.cjs) instead of Electron's
// globalShortcut, so they fire while Star Citizen has focus (RegisterHotKey does not).
const hotkeys = require("./hotkeys.cjs");
const { startFabCapture } = require("./capture.cjs");
const foreground = process.platform === "win32" ? require("./foreground.cjs") : {
  onChange() {}, want() {}, ready() { return false; }, gameInFront() { return false; }, stop() {},
};
const { OverlayWindowManager } = require("./window-manager.cjs");
const { BrowserWidgetController, DEFAULT_BROWSER_URL } = require("./browser-widget.cjs");
const { startEvdevHoldKey } = require("./linux/evdev-hold-key.cjs");
const overlayWindows = new OverlayWindowManager({ BrowserWindow, screen, app, env: process.env, logger: console });

// GPU hardware acceleration is OFF by default: the HUD is a transparent, always-on-top
// window composited over a fullscreen Vulkan game (Star Citizen), and GPU-compositing it
// crashes AMD drivers (device-lost / TDR — overlay ON = CTD, OFF = fine). Software
// rendering is safe for a text HUD. Users with GPU headroom can turn it back on in
// settings (SC is CPU-bound, so this trades a little CPU either way). Read from the
// server's config.json here because it must run BEFORE app "ready".
function hwAccelEnabled() {
  try {
    const p = path.join(CONFIG_DIR, "config.json");
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
    const p = path.join(CONFIG_DIR, "config.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).amdCompat === true;
  } catch {
    return false;
  }
}
const AMD_COMPAT = process.platform === "win32" && amdCompatEnabled();
if (AMD_COMPAT) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
} else if (process.platform === "win32" && !hwAccelEnabled()) {
  app.disableHardwareAcceleration();
}

// Master overlay switch, persisted in its OWN file (the sidecar owns config.json and
// rewrites it on unrelated changes, which would clobber a flag stored there). Default ON.
function overlayStateFile() {
  return path.join(CONFIG_DIR, "overlay-state.json");
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

// The browser widget owns a separate state file because the sidecar rewrites config.json.
// Cookies and logins live in Electron's persistent `sc-overlay-browser` session partition.
function browserStateFile() { return path.join(CONFIG_DIR, "browser-state.json"); }
function readBrowserState() {
  try {
    const s = JSON.parse(fs.readFileSync(browserStateFile(), "utf8"));
    return {
      browserVisible: s.browserVisible === true,
      chatVisible: s.chatVisible === true,
      url: typeof s.url === "string" && s.url ? s.url : DEFAULT_BROWSER_URL,
      channel: typeof s.channel === "string" ? s.channel : "",
    };
  } catch {
    return { browserVisible: false, chatVisible: false, url: DEFAULT_BROWSER_URL, channel: "" };
  }
}
let browserStateWriteTimer = null;
function writeBrowserState(state) {
  clearTimeout(browserStateWriteTimer);
  browserStateWriteTimer = setTimeout(() => {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(browserStateFile(), JSON.stringify({
        browserVisible: !!state.browserVisible,
        chatVisible: !!state.chatVisible,
        url: state.url || DEFAULT_BROWSER_URL,
        channel: state.channel || "",
      }, null, 2));
    } catch (e) { console.error("[browser] state write failed", String(e)); }
  }, 250);
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

// The Linux canvas geometry is owned by electron/window-manager.cjs. It discovers the
// KDE monitor layout (KScreen first, then XRandR/Electron), creates one native Overlay
// Manager window, and exposes one canvas-local coordinate system to every widget.

// KDE Wayland + XWayland can leave a transparent full-screen Electron window in the
// input path even when it looks transparent. Default Linux builds to a hard, whole-window
// click-through mode. The tray/Control+Alt+L can temporarily unlock it for interaction.
const LINUX_HARD_CLICK_THROUGH = process.platform === "linux" && process.env.SCBT_FORCE_CLICK_THROUGH !== "0";
const INTERACTION_TIMEOUT_MS = 30000;
const HUD_URL = `http://127.0.0.1:${PORT}/missions.html`;
const CONFIG_URL = `http://127.0.0.1:${PORT}/config.html`;

let server = null;
let overlay = null;
let configWin = null;
let setupWin = null;
let overlayLoaded = false; // canvas page has finished loading (its IPC listeners exist)
let tray = null;
let hovering = false; // pointer is over the HUD (reported by the page)
let locked = LINUX_HARD_CLICK_THROUGH; // Blueprint canvas lock state
let interactiveTarget = null; // Linux hard mode: null | "overlay" | "mining"
let holdInteract = false; // configurable hold-to-interact key is currently down
let holdMode = false; // opt-in hold-to-interact behavior from config
let unifiedInteractionActive = false; // retained internally for compatibility with older saved sessions
let notepadVisible = false; // in-canvas Blueprint-window notepad widget
let notepadEditing = false; // notepad typing mode keeps the Blueprint canvas focused
let notepadFocusPending = false; // defer focus until a held interact key is released
let moveMode = false; // arrange mode: show the drag banner/handles (VISUAL only — interactivity stays hover-based)
let modalOpen = false; // a HUD modal (what's-new card / hub) is up — stay hover-interactive even if locked
let dragging = false; // an active drag/resize gesture on THIS window — force it interactive so it can't drop
// Upstream 0.1.36 widget states, plus Linux native interaction state.
let miningVisible = false;
let twitchChatVisible = false;
let scFeedVisible = false;
let unlockAlertVisible = true;
let partyVisible = false;
let battagliaVisible = false;
let webViewVisible = false;
let bindingChartVisible = false;
let miningArm = false;
let browserVisible = false;
let browserRuntimeState = { url: DEFAULT_BROWSER_URL, channel: "", title: "Browser" };
let browserController = null;
let overlayRegions = [];
let lastGlobalPointer = null;
let fHoverHeld = false;
let momentaryInteractionActive = false;
let overlayInteractionLatched = false;
let overlayInteractionClaimSource = "";
let fHoverOverWidget = false;
let fHoverSuppressedUntilRelease = false;
let fHoverEnabled = process.platform === "linux";
let fHoverPollTimer = null;
let miningAutoArm = false;
let miningMoveMode = false;
let miningOnlyInteraction = false;
let miningAutoSuppress = 0; // auto-show is suppressed until this timestamp (set on a manual hide)
let overlayEnabled = true; // master switch — false = HUD window destroyed, tracking still runs
let manualCheck = false; // true while a tray-triggered update check is in flight (gates dialogs)
// Background update download in flight: { version, percent, bps } — drives the live
// progress line in the tray menu + the tray tooltip. null when idle.
let updateDownload = null;
let relockTimer = null; // Linux safety: automatically restore click-through after temporary interaction

// ── the Web Page widget's actual web page ───────────────────────────────────
// It used to be an iframe, which meant it could only show sites willing to be framed — and the
// site a Star Citizen player most wants pinned over the game, robertsspaceindustries.com, is not
// one of them. Stripping X-Frame-Options isn't enough either: measured 2026-07-29, RSI delivers
// 710KB of HTML into a frame and then renders NOTHING (it busts frames client-side), while the
// same URL top-level in the same session paints the real site.
//
// So the page lives in a WebContentsView owned by main, where it IS top-level. The widget's
// chrome (URL bar, quick chips, header, resize handle) stays in the renderer, and the renderer
// tells us the rectangle to fill — a hole it leaves in its own layout.
//
// A view is an axis-aligned native rectangle painted ABOVE all page content, which is why this
// widget doesn't tilt (noAngle in the registry) and why the view must be HIDDEN whenever
// something needs to draw over it: arrange mode, an open modal, or a group tab-switch.
let webView = null;
let webViewBounds = { x: 0, y: 0, width: 0, height: 0 };
let webViewWanted = false;   // the renderer wants it visible
let webViewMasked = false;   // ...but something is drawing over it right now
let webViewPainted = false;  // what the two above actually resolved to
let webViewHover = false;    // is the cursor over the view right now

function ensureWebView() {
  if (webView || !overlay) return webView;
  const { WebContentsView } = require("electron");
  webView = new WebContentsView({
    webPreferences: {
      // Someone else's website: no preload, no node, and its own jar so third-party cookies
      // never mix with the app's session.
      partition: "persist:webwidget",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Target=_blank and window.open must not spawn a second frameless always-on-top window over
  // the game — send those to the real browser instead.
  webView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  // Keep the widget's chrome honest about what it's showing.
  const report = () => {
    try {
      overlay?.webContents.send("webview:state", {
        url: webView.webContents.getURL(),
        title: webView.webContents.getTitle(),
        loading: webView.webContents.isLoading(),
        canGoBack: webView.webContents.navigationHistory.canGoBack(),
      });
    } catch { /* overlay went away */ }
  };
  webView.webContents.on("did-stop-loading", report);
  webView.webContents.on("did-navigate", report);
  webView.webContents.on("did-navigate-in-page", report);
  webView.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    try { overlay?.webContents.send("webview:state", { url, failed: `${desc} (${code})` }); } catch { /* gone */ }
  });
  overlay.contentView.addChildView(webView);
  applyWebViewBounds();
  return webView;
}

/** Painted only when the renderer wants it AND nothing is drawing over it. Zero-size bounds is
 *  how a view is hidden — setVisible exists, but a 0×0 rect also stops it eating the cursor. */
function applyWebViewBounds() {
  if (!webView) return;
  const on = webViewWanted && !webViewMasked && overlayEnabled;
  webView.setVisible(on);
  webView.setBounds(on ? webViewBounds : { x: 0, y: 0, width: 0, height: 0 });
  // Echo what we actually did. Nothing inside a hidden view can report this — it keeps its last
  // size and visibility state — so the shell is the only honest source, and the widget needs it
  // to know whether the page it thinks it's showing is on screen at all.
  webViewPainted = on;
  try {
    overlay?.webContents.send("webview:painted", { painted: on, wanted: webViewWanted, masked: webViewMasked, bounds: webViewBounds });
  } catch { /* overlay went away */ }
}

function destroyWebView() {
  if (!webView) return;
  try { overlay?.contentView.removeChildView(webView); } catch { /* window already gone */ }
  try { webView.webContents.close(); } catch { /* already closed */ }
  webView = null;
}

/** The view is a NATIVE surface painted above ALL page content, so anything the canvas draws in
 *  the same place loses to it — silently, since the DOM element is present and healthy, just
 *  invisible. Every reason to cover it is tracked separately and OR-ed, because they overlap:
 *  leaving arrange while a widget's settings are still open must not un-mask it.
 *    arrange  — you are positioning widgets, not reading a web page
 *    modal    — the what's-new card and friends must be readable and closeable
 *    chrome   — a widget's settings popover, the cog hub: canvas DOM over the view's rectangle.
 *               This is the one that was missing: the Web Page widget's own ⚙ opened BEHIND the
 *               site, so there was no way to reach it. */
let maskArrange = false, maskModal = false, maskChrome = false;
function recomputeWebViewMask() {
  const next = maskArrange || maskModal || maskChrome;
  if (next === webViewMasked) return;
  webViewMasked = next;
  applyWebViewBounds();
}

// ── server lifecycle ────────────────────────────────────────────────────────
// Linux uses the unpacked JavaScript sidecar; Windows keeps the packaged executable path.
const SIDECAR_LOG = path.join(CONFIG_DIR, "sidecar.log");
let sidecarLogOpened = false;
let serverRestarts = 0;
let serverRestartTimer = null;
function noteInSidecarLog(line) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.appendFileSync(SIDECAR_LOG, `\n[electron ${new Date().toISOString()}] ${line}\n`); } catch {}
}
function resolveServerDir() {
  const candidates = [path.join(ROOT, "server"), path.join(process.resourcesPath, "server"), path.join(process.resourcesPath, "app", "server")];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "sc-overlay-server.mjs"))) || null;
}
function startServer() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (process.platform === "win32" && app.isPackaged) {
    const exe = path.join(process.resourcesPath, "server", "sc-overlay-server.exe");
    const fd = fs.openSync(SIDECAR_LOG, sidecarLogOpened ? "a" : "w");
    sidecarLogOpened = true;
    server = spawn(exe, { cwd: path.dirname(exe), env: { ...process.env, APP_VERSION }, stdio: ["ignore", fd, fd], windowsHide: true });
    fs.closeSync(fd);
  } else if (process.platform === "linux") {
    const serverDir = resolveServerDir();
    if (!serverDir) { noteInSidecarLog(`sidecar files not found under ${ROOT}`); return false; }
    const script = path.join(serverDir, "sc-overlay-server.mjs");
    const fd = fs.openSync(SIDECAR_LOG, sidecarLogOpened ? "a" : "w");
    sidecarLogOpened = true;
    server = spawn(process.env.SC_TRACKER_NODE_BIN || "node", [script], {
      cwd: serverDir,
      env: { ...process.env, APP_VERSION, SC_TRACKER_CONFIG_DIR: CONFIG_DIR },
      stdio: ["ignore", fd, fd],
    });
    fs.closeSync(fd);
  } else {
    const fd = fs.openSync(SIDECAR_LOG, sidecarLogOpened ? "a" : "w");
    sidecarLogOpened = true;
    server = spawn("npx tsx src/overlay-server.ts", { cwd: ROOT, shell: true, env: { ...process.env, APP_VERSION }, stdio: ["ignore", fd, fd], windowsHide: true });
    fs.closeSync(fd);
  }
  server.on("error", (err) => { noteInSidecarLog(`server error: ${String(err)}`); server = null; });
  server.on("exit", (code, signal) => {
    if (app.isQuitting) return;
    if (serverRestarts >= 5) { noteInSidecarLog(`server exited (${code}/${signal}); restart limit reached`); return; }
    const wait = Math.min(30000, 1000 * 2 ** serverRestarts++);
    noteInSidecarLog(`server exited (${code}/${signal}); restarting in ${wait}ms`);
    serverRestartTimer = setTimeout(startServer, wait);  });
  return true;
}

/** Wait for OUR sidecar — not merely for something to answer on the port.
 *
 *  🔑 This used to ping /api/missions and treat any reply as success, which meant a leftover
 *  sidecar owning :8778 was silently ADOPTED. It is not hypothetical: a freshly installed 0.1.37
 *  served 0.1.36 patch notes for an hour because an orphan from an earlier run still held the
 *  port, and nothing anywhere said so — it presents as "the update didn't take".
 *
 *  A squatter that echoes a DIFFERENT instance id is one of ours gone stray (its parent died, or
 *  it belongs to another build), so we end it and let our own bind. Anything that does NOT look
 *  like our sidecar is left strictly alone — some other program owning the port is the user's
 *  business, and killing it would be far worse than failing to start. */
function waitForServer(tries = 60) {
  return new Promise((resolve) => {
    const retry = () => {
      if (--tries <= 0) return resolve(false);
      setTimeout(ping, 250);
    };
    const ping = () => {
      http
        .get(`http://127.0.0.1:${PORT}/api/missions`, (r) => {
          r.resume();
          resolve(true);
        })
        .on("error", retry);
    };
    ping();
  });
}

function primaryBounds() { return overlayWindows.primaryBounds(); }
function detectedVirtualDesktopBounds() {
  const layout = overlayWindows.detect();
  return { ...layout.desktop, source: layout.source };
}
function fullDisplayBounds() { return overlayWindows.canvasBounds(); }
function centeredDefaultZone() { return overlayWindows.defaultZone(); }
function refitCanvasWindows() {
  overlayWindows.refitAll({ refresh: true });
  try { if (bindingWin && !bindingWin.isDestroyed()) bindingWin.setBounds(primaryBounds()); } catch {}
}

// The overlay is now a FULL-SCREEN transparent canvas that hosts free-floating widgets
// (the Blueprint panel, later Mining) — like Streamlabs/OBS. It covers the whole primary
// display (same precedent as bindingWin) so a widget's decorations (e.g. Drake's duct-tape
// corners) can hang into open canvas instead of being clipped by a panel-sized window, and
// so widgets can be dragged/scaled freely inside it. Per-widget position/size/visibility
// live in widgets.json (see below), NOT in a window-bounds file — the window itself is fixed
// full-screen. Hard click-through is disabled only during explicit interaction modes (see applyMouse).
function pinOverlayWindow(win) { overlayWindows.pin(win); }

function createOverlay() {
  overlayWindows.logLayout();
  overlay = overlayWindows.createCanvasWindow("Overlay Manager", {
    preload: path.join(__dirname, "preload.cjs"),
    webPreferences: { autoplayPolicy: "no-user-gesture-required" },
  });
  browserController?.destroy();
  browserController = new BrowserWidgetController({
    WebContentsView,
    session,
    logger: console,
    onInteractionClaim: (source) => claimFocusLatchedInteraction(`embedded-${source}`),
    state: {
      browserVisible,
      chatVisible: twitchChatVisible,
      url: browserRuntimeState.url,
      channel: browserRuntimeState.channel,
      onState: (state) => {
        browserRuntimeState = { ...browserRuntimeState, ...state };
        browserVisible = !!state.browserVisible;
        twitchChatVisible = !!state.chatVisible;
        writeBrowserState(state);
        try { overlay?.webContents.send("browser:state", state); } catch {}
        pushWidgetStates();
      },
    },
  });
  browserController.attach(overlay);
  overlay.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`[electron] overlay did-fail-load ${code} ${description}: ${url}`);
  });
  // Clear any cached copy + cache-bust the URL so UI changes always show up.
  const hudUrl = `${HUD_URL}?v=${Date.now()}${AMD_COMPAT ? "&lite=1" : ""}`;
  overlay.webContents.session.clearCache().finally(() => overlay?.loadURL(hudUrl));
  overlay.webContents.on("did-finish-load", () => {
    try { overlay.setBounds(bounds); } catch {}
    sendEmbeddedMiningVisible({ on: miningVisible, arm: miningAutoArm || miningArm, transient: false });
    sendNotepadVisible({ on: notepadVisible });
    sendTwitchChatVisible?.({ on: twitchChatVisible });
    sendScFeedVisible?.({ on: scFeedVisible });
    sendUnlockAlertVisible?.({ on: unlockAlertVisible });
    sendPartyVisible?.({ on: partyVisible });
    sendBattagliaVisible?.({ on: battagliaVisible });
    sendWebViewVisible?.({ on: webViewVisible });
    sendBindingChartVisible?.({ on: bindingChartVisible });
    sendBrowserVisible();
    pushWidgetStates();
    overlayWindows.showCanvasWindow("Overlay Manager", overlay, { inactive: true });
    reapplyOverlayInputShape();
    try { overlay.moveTop(); } catch {}
    if (interactiveTarget === "overlay") focusLinuxInteractiveWindow("overlay");
  });  applyMouse();
  overlay.webContents.on("before-input-event", (_event, input) => {
    if (LINUX_HARD_CLICK_THROUGH && (interactiveTarget || overlayInteractionLatched) && input.type === "keyDown" && input.key === "Escape") {
      lockAllOverlayWindowsFromEscape();
    }
  });
  // Holding F merely arms widget rectangles. The actual click focuses this native window; use
  // that focus transition as a second, compositor-level latch signal in case the renderer's
  // pointerdown event is consumed by click-to-focus policy.
  overlay.on("focus", () => {
    if (momentaryInteractionActive && !overlayInteractionLatched && !unifiedInteractionActive) {
      claimFocusLatchedInteraction("Overlay Manager focus");
    }
  });
  overlay.on("blur", handleOverlayFocusLost);
  overlay.on("closed", () => {
    browserController?.destroy();
    browserController = null;
    overlay = null;
    notepadEditing = false;
    notepadFocusPending = false;
    overlayInteractionLatched = false;
    overlayInteractionClaimSource = "";
    momentaryInteractionActive = false;
    fHoverHeld = false;
    modalOpen = false;
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

// Recover widgets that were dragged off-screen or left on a disconnected monitor.
// All widgets share one native canvas; reload the Overlay Manager once.
async function resetWidgetLayout() {
  clearTimeout(widgetSaveTimer);
  widgetCache = {};
  try { fs.unlinkSync(widgetsFile()); } catch { /* already absent */ }
  try { await postConfig({ overlayScale: 100 }); } catch { /* sidecar unavailable */ }
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.reload(); } catch {}
}

function setWindowPassthrough(win, passthrough) {
  overlayWindows.setPassthrough(win, passthrough);
}
function setWindowInteractiveRegions(win, rects) {
  overlayWindows.setInteractiveRegions(win, rects);
}
function clearWindowInteractiveRegions(win, options) {
  overlayWindows.clearInteractiveRegions(win, options);
}
function captureLinuxActiveWindow() {
  overlayWindows.captureActiveWindow();
}
function focusLinuxInteractiveWindow(_targetKind) {
  if (process.platform !== "linux") return;
  const target = overlay && !overlay.isDestroyed() && overlay.isVisible() ? overlay : null;
  if (target) overlayWindows.focusWindow(target);
}
function restoreLinuxPreviousWindow() {
  overlayWindows.restorePreviousWindow();
}

function pointIsInsideOverlayRegion(globalPoint) {
  if (!globalPoint || !overlayRegions.length) return false;
  const canvas = fullDisplayBounds();
  const x = Number(globalPoint.x) - canvas.x;
  const y = Number(globalPoint.y) - canvas.y;
  return overlayRegions.some((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
}
function updateFHoverHit() {
  const next = !!(fHoverHeld && !fHoverSuppressedUntilRelease && pointIsInsideOverlayRegion(lastGlobalPointer));
  if (next === fHoverOverWidget) return;
  fHoverOverWidget = next;
  applyMouse();
  if (next) {
    // KWin/XWayland may not deliver the first click to an unfocused toolbar window. Focus the
    // shared canvas as soon as the held-F pointer enters a widget so its controls respond.
    focusLinuxInteractiveWindow("overlay");
    console.log(`[f-hover] pointer entered widget; overlay interactive (regions=${overlayRegions.length})`);
  } else {
    console.log("[f-hover] pointer left widgets; click-through restored");
  }
  try { overlay?.webContents.send("overlay:f-hover", { held: fHoverHeld, overWidget: fHoverOverWidget }); } catch {}
}
function stopFHoverPolling() {
  if (fHoverPollTimer) clearInterval(fHoverPollTimer);
  fHoverPollTimer = null;
}
function startFHoverPolling() {
  stopFHoverPolling();
  const tick = () => {
    if (!fHoverHeld) return;
    try {
      const p = screen.getCursorScreenPoint();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) lastGlobalPointer = { x: p.x, y: p.y };
    } catch {
      lastGlobalPointer = overlayWindows.pointerLocation() || lastGlobalPointer;
    }
    updateFHoverHit();
  };
  tick();
  fHoverPollTimer = setInterval(tick, 32);
}
function applyMouse() {
  if (!overlay) return;
  const interactive = LINUX_HARD_CLICK_THROUGH
    ? unifiedInteractionActive || interactiveTarget !== null || holdInteract || dragging || moveMode || modalOpen || notepadEditing || momentaryInteractionActive || overlayInteractionLatched
    : unifiedInteractionActive || interactiveTarget !== null || dragging || modalOpen || notepadEditing || holdInteract || momentaryInteractionActive || overlayInteractionLatched || (hovering && !locked);
  setWindowPassthrough(overlay, !interactive);
}
function reapplyOverlayInputShape() { applyMouse(); setTimeout(applyMouse, 50); setTimeout(applyMouse, 500); }
let bindingWin = null;
function createBinding() {
  const bounds = primaryBounds();
  bindingWin = new BrowserWindow({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, frame:false, transparent:true, resizable:false, movable:false, skipTaskbar:true, type:process.platform === "linux" ? "toolbar" : undefined, alwaysOnTop:true, hasShadow:false, fullscreenable:false, focusable:false, show:false, webPreferences:{contextIsolation:true} });
  pinOverlayWindow(bindingWin); bindingWin.setIgnoreMouseEvents(true, {forward:true});
  bindingWin.loadURL(`http://127.0.0.1:${PORT}/binding.html`); bindingWin.on("closed", () => { bindingWin = null; });
}
function toggleBinding() { if (!bindingWin) createBinding(); if (bindingWin.isVisible()) { bindingWin.hide(); return; } bindingWin.webContents.executeJavaScript(`location.hash="s"+Date.now()`).catch(()=>{}); bindingWin.showInactive();}

// Patch the sidecar config over HTTP (the config lives in the sidecar process).
async function postJson(route, body) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
  } catch { /* sidecar not up yet — non-fatal */ }
}
function miningIsVisible() { return miningVisible; }
function sendNotepadVisible(state) {
  try { overlay?.webContents.send("overlay:notepad-visible", state); } catch {}
}
function sendEmbeddedMiningVisible(state) {
  try { overlay?.webContents.send("overlay:mining-visible", state); } catch {}}
function sendBrowserVisible() {
  const state = {
    browserVisible,
    chatVisible: twitchChatVisible,
    ...browserRuntimeState,
  };
  try { overlay?.webContents.send("browser:state", state); } catch {}
  browserController?.setBrowserVisible(browserVisible);
  browserController?.setChatVisible(twitchChatVisible);
}
function widgetStatesSnapshot() {
  return { mining: miningVisible, notepad: notepadVisible, browser: browserVisible, twitchChat: twitchChatVisible, scFeed: scFeedVisible, unlockAlert: unlockAlertVisible, party: partyVisible, battaglia: battagliaVisible, webView: webViewVisible, bindingChart: bindingChartVisible };
}
function pushWidgetStates() {
  try { overlay?.webContents.send("overlay:widget-states", widgetStatesSnapshot()); } catch {}
}
function setNotepadVisible(on, { persist = true } = {}) {
  notepadVisible = !!on;
  if (notepadVisible && !overlayEnabled) setOverlayEnabled(true);
  if (!notepadVisible && notepadEditing) {
    notepadEditing = false;
    notepadFocusPending = false;
    try { overlay?.webContents.executeJavaScript('document.getElementById("notepadFrame")?.contentWindow?.__notepadExitTyping?.()'); } catch {}
    applyMouse();
  }
  sendNotepadVisible({ on: notepadVisible });
  pushWidgetStates();
  if (persist) void postConfig({ notepadOpen: notepadVisible });
  refreshTray();
}
function toggleNotepad() { setNotepadVisible(!notepadVisible); }

function setBrowserVisible(on) {
  browserVisible = !!on;
  if (browserVisible && !overlayEnabled) setOverlayEnabled(true);
  browserController?.setBrowserVisible(browserVisible);
  sendBrowserVisible();
  writeBrowserState({ ...browserRuntimeState, browserVisible, chatVisible: twitchChatVisible });
  pushWidgetStates();
  refreshTray();
}
function toggleBrowser() { setBrowserVisible(!browserVisible); }
function sendTwitchChatVisible(state) { try { overlay?.webContents.send("overlay:twitchchat-visible", state); } catch {} }
function setTwitchChatVisible(on) {
  twitchChatVisible = !!on;
  if (twitchChatVisible && !overlayEnabled) setOverlayEnabled(true);
  browserController?.setChatVisible(twitchChatVisible);
  sendTwitchChatVisible({ on: twitchChatVisible });
  sendBrowserVisible();
  writeBrowserState({ ...browserRuntimeState, browserVisible, chatVisible: twitchChatVisible });
  pushWidgetStates();
  refreshTray();
}
function toggleTwitchChat() { setTwitchChatVisible(!twitchChatVisible); }
// SC Feed news notifier.
function sendScFeedVisible(state) { try { overlay?.webContents.send("overlay:scfeed-visible", state); } catch {} }
function setScFeedVisible(on) { scFeedVisible=!!on; sendScFeedVisible({on:scFeedVisible}); postConfig({scFeedOpen:scFeedVisible}); pushWidgetStates(); refreshTray(); }
function toggleScFeed(){ setScFeedVisible(!scFeedVisible); }
function sendUnlockAlertVisible(state){ try { overlay?.webContents.send("overlay:unlockalert-visible", state); } catch {} }
function setUnlockAlertVisible(on){ unlockAlertVisible=!!on; sendUnlockAlertVisible({on:unlockAlertVisible}); postConfig({unlockAlertOpen:unlockAlertVisible}); pushWidgetStates(); refreshTray(); }
function toggleUnlockAlert(){ setUnlockAlertVisible(!unlockAlertVisible); }
function sendPartyVisible(state){ try { overlay?.webContents.send("overlay:party-visible", state); } catch {} }
function setPartyVisible(on){ partyVisible=!!on; sendPartyVisible({on:partyVisible}); postConfig({partyOpen:partyVisible}); pushWidgetStates(); refreshTray(); }
function toggleParty(){ setPartyVisible(!partyVisible); }
function sendBattagliaVisible(state){ try { overlay?.webContents.send("overlay:battaglia-visible", state); } catch {} }
function setBattagliaVisible(on){ battagliaVisible=!!on; sendBattagliaVisible({on:battagliaVisible}); postConfig({battagliaOpen:battagliaVisible}); pushWidgetStates(); refreshTray(); }
function toggleBattaglia(){ setBattagliaVisible(!battagliaVisible); }
function sendWebViewVisible(state){ try { overlay?.webContents.send("overlay:webview-visible", state); } catch {} }
function setWebViewVisible(on){ webViewVisible=!!on; sendWebViewVisible({on:webViewVisible}); postConfig({webViewOpen:webViewVisible}); pushWidgetStates(); refreshTray(); }
function toggleWebView(){ setWebViewVisible(!webViewVisible); }
function sendBindingChartVisible(state){ try { overlay?.webContents.send("overlay:bindingchart-visible", state); } catch {} }
function setBindingChartVisible(on){ bindingChartVisible=!!on; if(bindingChartVisible){ try{overlay?.webContents.send("overlay:bindingchart-reload");}catch{} } sendBindingChartVisible({on:bindingChartVisible}); postConfig({bindingChartOpen:bindingChartVisible}); pushWidgetStates(); refreshTray(); }
function toggleBindingChart(){ setBindingChartVisible(!bindingChartVisible); }

function setMiningVisible(on, { persist = true, suppressAuto = false } = {}) {
  miningVisible = !!on;
  if (miningVisible && !overlayEnabled) setOverlayEnabled(true);
  if (!miningVisible) {
    miningMoveMode = false;
    miningOnlyInteraction = false;
    if (suppressAuto) miningAutoSuppress = Date.now() + 90000;
    try { overlay?.webContents.send("overlay:mining-move-mode", false); } catch {}
    try { overlay?.webContents.send("overlay:mining-only-interaction", false); } catch {}
    if (interactiveTarget === "mining") setInteractiveTarget(null, "Mining hidden");  }
  sendEmbeddedMiningVisible({ on: miningVisible, arm: miningAutoArm, transient: false });
  pushWidgetStates();
  if (persist) void postConfig({ miningOpen: miningVisible });
  refreshTray();
}
function createMining() { setMiningVisible(true); } // compatibility for existing call sites
function showMiningInactive() { setMiningVisible(true); }
function hideMining() { setMiningVisible(false, { suppressAuto: true }); }
function toggleMining() { setMiningVisible(!miningVisible, { suppressAuto: miningVisible }); }
function applyMiningMouse() { applyMouse(); }
function setMiningMoveMode(on) {
  miningMoveMode = !!on;
  if (miningMoveMode) beginMiningOnlyInteractionFor30Seconds({ arrange: true });
  else if (interactiveTarget === "mining") setInteractiveTarget(null, "mining arrange complete");
  try { overlay?.webContents.send("overlay:mining-move-mode", miningMoveMode); } catch {}
  refreshTray();
}
ipcMain.on("mining:hide", hideMining);

// Live-rebindable global shortcut for the binding-chart overlay — swap it WITHOUT a restart.
// Returns {ok:true} or {ok:false,error} so the config window can warn (invalid combo, or the
// combo is already claimed by another app).
// Live-rebindable global shortcut for showing/hiding the overlay HUD. Same shape as
// registerBindingHotkey so the config window can warn on an invalid / in-use combo.
// ── Unfocused opacity ───────────────────────────────────────────────────────
// The overlay fades while you're playing and comes back to full the moment you switch TO it
// (Alt-Tab / clicking it), so reading it is always one focus away rather than a settings trip.
// 🔑 Window opacity, not a CSS filter: the canvas is a transparent always-on-top window over
// the game, and a CSS opacity on its body would fade widgets against each other rather than
// against what's behind the window.
// 🔑 Never fade while ARRANGING — you cannot place what you cannot see — and never below the
// 0.2 clamp the settings enforce, or the overlay becomes a thing you can't find to fix.
// 🔑 The fade is PER WIDGET, so it lives in the canvas as CSS — one window opacity cannot say
// "fade the chat widget but not the tracker", which is what Sub asked for (2026-08-09). All the
// shell owns now is the OVERRIDE: a hotkey that forces every widget back to full, and arrange
// mode, which must never be faded. The canvas applies both by toggling `html.no-dim`.
function applyOverlayOpacity() {
  if (!overlay || overlay.isDestroyed()) return;
  const off = opacityOverride || moveMode;
  try {
    overlay.webContents.send("overlay:dim-override", off);
    lastOpacityApplied = { override: opacityOverride, moveMode, sentNoDim: off };
  } catch { /* window going away */ }
}
let lastOpacityApplied = null;
function setUnfocusedOpacity(v) {
  const n = Number(v);
  const next = Number.isFinite(n) ? Math.max(0.2, Math.min(1, n)) : 1;
  const changed = next !== unfocusedOpacity;
  unfocusedOpacity = next;
  // Live preview while the slider moves: the saved value reaches the canvas on the next prefs
  // broadcast, but a transparency is judged by watching it change, so push it straight through.
  try { overlay?.webContents.send("overlay:dim-global", unfocusedOpacity); } catch { /* no window */ }
  applyOverlayOpacity();
  // Republish the diagnostic when the SETTING changes (not on every hover tick) — otherwise
  // /api/overlay-geometry reports whatever was true at the last canvas refit, which is exactly
  // the stale answer that makes "did it apply?" unanswerable from outside.
  if (changed) reportGeometry();
}
function toggleOpacityOverride() {
  opacityOverride = !opacityOverride;
  applyOverlayOpacity();
}
let opacityAccel = null;
function registerOpacityHotkey(accel) {
  if (opacityAccel) hotkeys.unregister(opacityAccel);
  opacityAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleOpacityOverride);
  if (r.ok) opacityAccel = accel;
  return r;
}

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
  const r = hotkeys.register(accel, toggleBindingChart);
  if (r.ok) bindingAccel = accel;
  return r;
}

// Live-rebindable hotkey for showing/hiding the Mining Assistant window. Same shape as the
// overlay/binding registrations so the config window can warn on an invalid / in-use combo.
let webViewAccel = null;
function registerWebViewHotkey(accel) {
  if (webViewAccel) hotkeys.unregister(webViewAccel);
  webViewAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleWebView);
  if (r.ok) webViewAccel = accel;
  return r;
}

let miningAccel = null;
function registerMiningHotkey(accel) {
  if (miningAccel) hotkeys.unregister(miningAccel);
  miningAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleMining);
  if (r.ok) miningAccel = accel;
  return r;
}
let interactAccel = null;
let evdevInteractController = null;
let stopPointerWatch = null;

function endFocusLatchedInteraction(reason = "external focus", { suppressHeldKey = true } = {}) {
  if (!overlayInteractionLatched && !momentaryInteractionActive) return;

  overlayInteractionLatched = false;
  overlayInteractionClaimSource = "";
  momentaryInteractionActive = false;
  fHoverOverWidget = false;
  if (suppressHeldKey && fHoverHeld) fHoverSuppressedUntilRelease = true;

  // End any keyboard-editing/drag mode that belonged to the overlay. The user's external click
  // already chose the next focus target, so do not programmatically restore another window.
  moveMode = false;
  miningMoveMode = false;
  miningOnlyInteraction = false;
  notepadEditing = false;
  notepadFocusPending = false;
  interactiveTarget = null;
  locked = true;
  try { overlay?.webContents.send("overlay:move-mode", false); } catch {}
  try { overlay?.webContents.send("overlay:mining-move-mode", false); } catch {}
  try { overlay?.webContents.send("overlay:mining-only-interaction", false); } catch {}
  try { overlay?.webContents.send("overlay:f-hover", { held: fHoverHeld, overWidget: false, latched: false }); } catch {}
  try { overlay?.webContents.executeJavaScript('document.getElementById("notepadFrame")?.contentWindow?.__notepadExitTyping?.()'); } catch {}

  applyMouse();
  reapplyOverlayInputShape();
  refreshTray();
  console.log(`[focus-latch] overlay interaction released (${reason}); external window keeps focus`);
}

function releaseFocusLatchToGame(reason = "transparent canvas clicked") {
  // A mouse press must never cancel the held-F gate. This matters on the single full-canvas
  // Linux window because compositor click-to-focus and iframe/native-view clicks can briefly be
  // reported as transparent-canvas presses. Keep input armed until the physical F key is released.
  if (fHoverHeld) {
    console.log(`[focus-latch] ${reason} ignored while ${interactAccel || "RightAlt"} is held`);
    return;
  }
  const hadInteraction = overlayInteractionLatched || momentaryInteractionActive;
  endFocusLatchedInteraction(reason, { suppressHeldKey: true });
  if (hadInteraction) setTimeout(restoreLinuxPreviousWindow, 30);
}

function claimFocusLatchedInteraction(source = "widget") {
  if (unifiedInteractionActive || overlayInteractionLatched) return;
  if (!momentaryInteractionActive && !fHoverHeld) return;

  overlayInteractionLatched = true;
  overlayInteractionClaimSource = String(source || "widget");
  momentaryInteractionActive = false;
  locked = false;
  fHoverOverWidget = true;
  applyMouse();
  reapplyOverlayInputShape();
  focusLinuxInteractiveWindow("overlay");
  try { overlay?.webContents.send("overlay:f-hover", { held: fHoverHeld, overWidget: true, latched: true }); } catch {}
  refreshTray();
  console.log(`[focus-latch] ${overlayInteractionClaimSource} clicked; overlay owns keyboard/mouse until an external window is clicked`);
}

function handleOverlayFocusLost() {
  // F is a global physical-key gate on Linux. Do not let a compositor focus transition, an
  // embedded WebContentsView click, or another application's focus cancel it while F is down.
  if (fHoverHeld || momentaryInteractionActive || !overlayInteractionLatched || unifiedInteractionActive) return;
  setTimeout(() => {
    if (fHoverHeld || momentaryInteractionActive || !overlayInteractionLatched || unifiedInteractionActive) return;
    if (overlay && !overlay.isDestroyed() && overlay.isFocused()) return;
    const active = overlayWindows.activeWindowDetails?.();
    // Child WebContentsViews remain inside the same native Overlay Manager window. A native blur
    // therefore means the user clicked Star Citizen, another application, or the desktop.
    if (active && overlayWindows.isOwnOverlayWindow?.(active)) return;
    const reason = overlayWindows.isStarCitizenDirectlyActive?.()
      ? "Star Citizen clicked"
      : `external window clicked${active?.title ? `: ${active.title}` : ""}`;
    endFocusLatchedInteraction(reason, { suppressHeldKey: true });
  }, 80);
}

function registerInteractHotkey(accel) {
  if (interactAccel) hotkeys.unregister(interactAccel);
  interactAccel = null;
  if (stopPointerWatch) { stopPointerWatch(); stopPointerWatch = null; }
  stopFHoverPolling();
  if (evdevInteractController) { try { evdevInteractController.stop(); } catch {} evdevInteractController = null; }
  if (!accel || typeof accel !== "string") return { ok: true };

  const onDown = (source = "uiohook") => {
    if (notepadEditing || !fHoverEnabled || unifiedInteractionActive || overlayInteractionLatched || fHoverSuppressedUntilRelease || fHoverHeld) return;
    console.log(`[focus-latch] ${accel} key-down received via ${source}`);
    // The interaction key is intentionally focus-independent. It must work while Star Citizen,
    // the overlay, the desktop, or another application owns focus; evdev/uIOhook supplies the
    // physical key state outside Electron's focused renderer.
    fHoverHeld = true;
    browserController?.setInteractionKeyHeld(true);
    if (!overlayEnabled) setOverlayEnabled(true);
    if (!overlay) createOverlay();
    if (!overlay || overlay.isDestroyed()) return;
    const activate = () => {
      if (!overlay || overlay.isDestroyed() || !fHoverHeld || momentaryInteractionActive || overlayInteractionLatched) return;
      captureLinuxActiveWindow();
      momentaryInteractionActive = true;
      overlayInteractionLatched = false;
      overlayInteractionClaimSource = "";
      fHoverOverWidget = false;
      fHoverSuppressedUntilRelease = false;
      interactiveTarget = null;
      locked = true;
      sendEmbeddedMiningVisible({ on: miningVisible, arm: miningAutoArm, transient: false });
      sendNotepadVisible({ on: notepadVisible, transient: false });
      try { overlay.webContents.send("overlay:mining-only-interaction", false); } catch {}
      try { overlay.webContents.send("overlay:move-mode", false); } catch {}
      try { overlay.webContents.send("overlay:unified-interaction", false); } catch {}
      try { overlay.webContents.send("overlay:f-hover", { held: true, overWidget: false, latched: false }); } catch {}
      applyMouse();
      reapplyOverlayInputShape();
      refreshTray();
      console.log(`[focus-latch] ${accel} held; focus-independent overlay interaction armed`);
    };
    if (overlay.webContents.isLoadingMainFrame()) overlay.webContents.once("did-finish-load", activate);
    else activate();
  };

  const onUp = (source = "uiohook") => {
    if (!fHoverHeld && !momentaryInteractionActive && !fHoverSuppressedUntilRelease) return;
    fHoverHeld = false;
    browserController?.setInteractionKeyHeld(false);
    if (fHoverSuppressedUntilRelease) {
      fHoverSuppressedUntilRelease = false;
      momentaryInteractionActive = false;
      if (!overlayInteractionLatched) { locked = true; applyMouse(); reapplyOverlayInputShape(); }
      console.log(`[focus-latch] ${accel} released via ${source}; held-key suppression cleared`);
      return;
    }
    if (overlayInteractionLatched) {
      momentaryInteractionActive = false;
      applyMouse();
      try { overlay?.webContents.send("overlay:f-hover", { held: false, overWidget: true, latched: true }); } catch {}
      console.log(`[focus-latch] ${accel} released via ${source} after widget click; overlay remains focused until Star Citizen is clicked`);
      return;
    }
    momentaryInteractionActive = false;
    fHoverOverWidget = false;
    locked = true;
    applyMouse();
    reapplyOverlayInputShape();
    try { overlay?.webContents.send("overlay:f-hover", { held: false, overWidget: false, latched: false }); } catch {}
    refreshTray();
    console.log(`[focus-latch] ${accel} released via ${source} without a widget click; overlay returned to click-through`);
  };

  const r = hotkeys.registerHold(accel, () => onDown("uiohook"), () => onUp("uiohook"));
  if (process.platform === "linux") {
    evdevInteractController = startEvdevHoldKey({ accelerator: accel, onDown: () => onDown("evdev"), onUp: () => onUp("evdev") });
  }
  if (r.ok) interactAccel = accel;
  else console.warn(`[focus-latch] uIOhook could not register ${accel}: ${r.error || "unknown"}; evdev fallback will be used when available`);
  return (r.ok || evdevInteractController?.supported) ? { ok: true } : r;
}

let moveAccel = null;
function registerMoveHotkey(accel) {
  if (moveAccel) hotkeys.unregister(moveAccel);
  moveAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleMove);
  if (r.ok) moveAccel = accel;
  return r;
}

// Confirms a fabricator claim prompt. Goes straight to the SIDECAR rather than into the widget:
// the sidecar owns the prompt (including its 30s expiry), and its broadcast is what clears the
// card — so a hotkey press and a button click travel the exact same path and can't disagree.
// A press with no prompt live is a harmless no-op the server answers with why:"expired".
let fabClaimAccel = null;
function registerFabClaimHotkey(accel) {
  if (fabClaimAccel) hotkeys.unregister(fabClaimAccel);
  fabClaimAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, () => postApi("/api/fab/claim?accept=1"));
  if (r.ok) fabClaimAccel = accel;
  return r;
}

// ── actions ─────────────────────────────────────────────────────────────────
// Legacy unified-interaction support is retained only to close old sessions cleanly. New Linux
// sessions use the upstream Ctrl+Alt+M arrange mode plus held-F interaction; there is no dedicated
// Shift+F5/F6 interaction path.
function beginUnifiedInteractionToggle() {
  if (app.isQuitting) return;
  if (overlayInteractionLatched || momentaryInteractionActive) {
    endFocusLatchedInteraction("legacy unified interaction lock", { suppressHeldKey: true });
    return;
  }
  if (unifiedInteractionActive) {
    endUnifiedInteraction("legacy unified interaction toggle");
    return;
  }

  const activate = () => {
    if (!overlay || overlay.isDestroyed()) return;
    unifiedInteractionActive = true;
    clearTimeout(relockTimer);
    relockTimer = null;
    if (!interactiveTarget) captureLinuxActiveWindow();

    sendEmbeddedMiningVisible({ on: miningVisible, arm: miningAutoArm, transient: false });
    sendNotepadVisible({ on: notepadVisible, transient: false });

    moveMode = false;
    miningOnlyInteraction = false;
    interactiveTarget = "overlay";
    locked = false;
    try { overlay.webContents.send("overlay:mining-only-interaction", false); } catch {}
    try { overlay.webContents.send("overlay:move-mode", false); } catch {}
    try { overlay.webContents.send("overlay:unified-interaction", false); } catch {}
    applyMouse();
    overlayWindows.focusWindow(overlay);
    refreshTray();
    console.log("[electron] legacy unified interaction activated");
  };

  if (!overlayEnabled) setOverlayEnabled(true);
  if (!overlay) createOverlay();
  if (!overlay || overlay.isDestroyed()) return;
  if (overlay.webContents.isLoadingMainFrame()) overlay.webContents.once("did-finish-load", activate);
  else activate();
}

function endUnifiedInteraction(reason = "manual", { restoreFocus = true } = {}) {
  if (!unifiedInteractionActive) return;

  unifiedInteractionActive = false;
  clearTimeout(relockTimer);
  relockTimer = null;
  moveMode = false;
  try { overlay?.webContents.send("overlay:move-mode", false); } catch {}
  try { overlay?.webContents.send("overlay:unified-interaction", false); } catch {}
  sendEmbeddedMiningVisible({ on: miningVisible, arm: miningAutoArm, transient: false });

  interactiveTarget = null;
  miningOnlyInteraction = false;
  locked = true;
  try { overlay?.webContents.send("overlay:mining-only-interaction", false); } catch {}
  applyMouse();

  if (restoreFocus) setTimeout(restoreLinuxPreviousWindow, 40);
  refreshTray();
  console.log(`[electron] unified overlay interaction ended (${reason}); all overlays locked and previous focus restored`);
}

function setInteractiveTarget(target, reason = "manual") {
  const previous = interactiveTarget;
  if (target && previous == null) captureLinuxActiveWindow();

  interactiveTarget = target;
  locked = target !== "overlay";
  if (!target && notepadEditing) {
    notepadEditing = false;
    notepadFocusPending = false;
    try { overlay?.webContents.executeJavaScript('document.getElementById("notepadFrame")?.contentWindow?.__notepadExitTyping?.()'); } catch {}
  }

  clearTimeout(relockTimer);
  relockTimer = null;
  if (target) {
    relockTimer = setTimeout(() => setInteractiveTarget(null, "30-second timeout"), INTERACTION_TIMEOUT_MS);
  }

  miningOnlyInteraction = target === "mining";
  try { overlay?.webContents.send("overlay:mining-only-interaction", miningOnlyInteraction); } catch {}
  applyMouse();

  if (!target && previous === "mining" && miningMoveMode) {
    miningMoveMode = false;
    try { overlay?.webContents.send("overlay:mining-move-mode", false); } catch {}
  }
  if (target) focusLinuxInteractiveWindow(target);
  else if (previous) setTimeout(restoreLinuxPreviousWindow, 30);

  refreshTray();
  if (target === "overlay") {
    console.log("[electron] Blueprint overlay interaction enabled and focused for 30 seconds; Mining remains click-through");
  } else if (target === "mining") {
    console.log("[electron] Mining Assistant interaction enabled and focused for 30 seconds; Blueprint remains click-through");
  } else {
    console.log(`[electron] overlay windows locked: clicks pass through (${reason})`);
  }
}

function setLocked(on, reason = "manual") {
  if (LINUX_HARD_CLICK_THROUGH) {
    if (on) {
      if (unifiedInteractionActive) endUnifiedInteraction(reason);
      else if (interactiveTarget === "overlay") setInteractiveTarget(null, reason);
      else { locked = true; applyMouse(); refreshTray(); }
    } else {
      setInteractiveTarget("overlay", reason);
    }
    return;
  }
  const wasLocked = locked;
  locked = !!on;
  applyMouse();
  if (process.platform === "linux") {
    if (!locked) focusLinuxInteractiveWindow("overlay");
    else if (!wasLocked) setTimeout(restoreLinuxPreviousWindow, 30);
  }
  refreshTray();
}
function toggleLock() { setLocked(!locked); }

function setMiningLocked(on, reason = "manual") {
  if (!on) beginMiningOnlyInteractionFor30Seconds();
  else if (interactiveTarget === "mining") setInteractiveTarget(null, reason);
}
function toggleMiningLock() {
  setMiningLocked(interactiveTarget === "mining", interactiveTarget === "mining" ? "manual" : "tray");
}

// Mining-specific arrange support is used by the tray entry. Global move/resize uses the
// upstream Ctrl+Alt+M arrange mode and does not require a separate interaction shortcut.
function beginMiningOnlyInteractionFor30Seconds({ arrange = false } = {}) {
  if (unifiedInteractionActive) endUnifiedInteraction("switching to Mining-only interaction", { restoreFocus: false });
  miningAutoSuppress = 0;
  setMiningVisible(true);
  miningMoveMode = !!arrange;
  try { overlay?.webContents.send("overlay:mining-move-mode", miningMoveMode); } catch {}
  setInteractiveTarget("mining", arrange ? "Mining arrange" : "Mining interaction");
}
function lockAllOverlayWindowsFromEscape() {
  if (fHoverHeld || momentaryInteractionActive || overlayInteractionLatched) {
    fHoverSuppressedUntilRelease = !!fHoverHeld;
    endFocusLatchedInteraction("Escape", { suppressHeldKey: true });
  }
  if (unifiedInteractionActive) {
    endUnifiedInteraction("Escape");
    return;
  }
  if (interactiveTarget) setInteractiveTarget(null, "Escape");
  else {
    locked = true;
    applyMouse();
    reapplyOverlayInputShape();
  }
}

// Reposition mode: whole panel becomes a drag surface (banner + Done in the page),
// hover-toggling suspended so the window can't slip out from under the cursor.
function setMoveMode(on) {
  // Ctrl+Alt+M uses the upstream global arrange banner and Done button for all widgets.
  moveMode = on;
  if (LINUX_HARD_CLICK_THROUGH) {
    if (unifiedInteractionActive || overlayInteractionLatched) applyMouse();
    else setLocked(!on, on ? "arrange mode" : "arrange complete");
  } else applyMouse();
  if (on && overlay) overlay.focus();
  overlay?.webContents.send("overlay:move-mode", on);
  applyOverlayOpacity(); // arranging is always full-opacity — you can't place what you can't see
  refreshTray();
}
// Blueprint, Mining, and Notepad share the native Overlay Manager canvas; each retains
// independent DOM geometry and arrange handles.
function toggleMove() { setMoveMode(!moveMode); }
function toggleMiningMove() {
  if (!miningVisible) setMiningVisible(true);
  setMiningMoveMode(!miningMoveMode);
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
  // Settings also runs as a canvas WIDGET, whose copy of the master-switch checkbox needs the
  // same signal. Only meaningful when turning ON — switching off destroys the canvas, and the
  // widget with it, so there is nothing left to tell. 🔑 That is also why the tray keeps this
  // toggle: turning the overlay off from inside the overlay is a one-way trip otherwise.
  if (on) overlay?.webContents.send("overlay:enabled-changed", on);
  refreshTray();
}
function toggleShow() {
  setOverlayEnabled(!overlayEnabled);
}

function openConfigInBrowser() {
  shell.openExternal(`${CONFIG_URL}?v=${Date.now()}`)
    .catch((e) => console.error("[electron] external config open failed:", String(e)));
}

function openConfig() {
  if (configWin && !configWin.isDestroyed()) {
    configWin.show();
    configWin.focus();
    try { configWin.moveTop(); } catch {}
    return;
  }

  // KWin can keep a full-screen transparent always-on-top overlay above a normal settings
  // window even when both are Electron windows. Temporarily hide visible overlay canvases on
  // Linux while settings are open, then restore them when settings closes.
  const restore = {
    overlay: process.platform === "linux" && !!(overlay && !overlay.isDestroyed() && overlay.isVisible()),
    binding: process.platform === "linux" && !!(bindingWin && !bindingWin.isDestroyed() && bindingWin.isVisible()),
  };
  if (restore.overlay) {
    browserController?.suspendHidden();
    overlayWindows.suspendCanvasWindow("Overlay Manager", overlay);
  }
  if (restore.binding) bindingWin.hide();

  configWin = new BrowserWindow({
    width: 780,
    height: 820,
    minWidth: 680,
    minHeight: 620,
    show: false,
    center: true,
    title: "SC Blueprint Tracker — Config",
    autoHideMenuBar: true,
    backgroundColor: "#171a1f",
    alwaysOnTop: process.platform !== "linux",
    skipTaskbar: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "config-preload.cjs") },
  });
  if (process.platform !== "linux") configWin.setAlwaysOnTop(true, "screen-saver");

  const restoreOverlays = () => {
    if (restore.overlay && overlayEnabled && overlay && !overlay.isDestroyed()) {
      overlayWindows.resumeCanvasWindow("Overlay Manager", overlay, {
        inactive: true,
        reason: "restored-after-config",
      });
      // Hiding/unhiding an X11 window can also reset its input region. Restore the
      // locked click-through state after the geometry has been reasserted.
      reapplyOverlayInputShape();
      browserController?.resume();
      sendBrowserVisible();
      pushWidgetStates();
    }
    if (restore.binding && bindingWin && !bindingWin.isDestroyed()) bindingWin.showInactive();
  };

  let fallbackOpened = false;
  const openFallback = (reason) => {
    if (fallbackOpened) return;
    fallbackOpened = true;
    console.error(`[electron] config window fallback: ${reason}`);
    openConfigInBrowser();
  };

  const showTimer = setTimeout(() => {
    if (!configWin || configWin.isDestroyed()) return;
    if (!configWin.isVisible()) openFallback("window did not become visible within 5 seconds");
  }, 5000);

  configWin.once("ready-to-show", () => {
    if (!configWin || configWin.isDestroyed()) return;
    configWin.center();
    configWin.show();
    configWin.focus();
    try { configWin.moveTop(); } catch {}
    console.log("[electron] config window shown");
  });
  configWin.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`[electron] config did-fail-load ${code} ${description}: ${url}`);
    openFallback(`load failed: ${description}`);
  });
  configWin.loadURL(`${CONFIG_URL}?v=${Date.now()}`)
    .catch((e) => {
      console.error("[electron] config load failed:", String(e));
      openFallback(String(e));
    });
  configWin.on("closed", () => {
    clearTimeout(showTimer);
    configWin = null;
    restoreOverlays();
  });
}

// ── first-run setup wizard ────────────────────────────────────────────────────
// Same window treatment as Settings (screen-scaled, screen-saver always-on-top) so it can't
// be buried under the HUD. Slightly wider than Settings because it's a rail + pane layout.
function openSetup() {
  if (setupWin) { setupWin.show(); setupWin.focus(); return; }
  // 🔑 The PRIMARY display, not the cursor's. Following the cursor is the usual desktop default,
  // but it assumes a window that belongs anywhere — and this one does not. Everything this app
  // does is primary-anchored: the overlay canvas, widget positions (stored primary-relative), the
  // game itself, and the Settings WIDGET the wizard's step 3 opens. A wizard that appears on the
  // second monitor and then sends you to the first is worse than one that starts where the app
  // lives. It also makes the size DETERMINISTIC — cursor-following is why the wizard came up at
  // 1.33x or 1.78x depending on where the mouse happened to be.
  const disp = screen.getPrimaryDisplay();
  // Same basis as the page's own zoom (see setup.html): the SHORTER edge, against 1440. Using
  // height alone asked for a 1602px-wide window on a 1080-wide portrait monitor, which then got
  // clamped to the work area — so the content was zoomed AND cramped at the same time.
  const scale = Math.max(1, Math.min(2, Math.min(disp.size.width, disp.size.height) / 1440));
  const width = Math.min(disp.workArea.width - 40, Math.round(900 * scale));
  const height = Math.min(disp.workArea.height - 40, Math.round(640 * scale));
  const x = Math.round(disp.workArea.x + (disp.workArea.width - width) / 2);
  const y = Math.round(disp.workArea.y + (disp.workArea.height - height) / 2);
  setupWin = new BrowserWindow({
    x, y, width, height,
    title: "SC Overlay — Setup",
    icon: appIconPath(),
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "setup-preload.cjs") },
  });
  setupWin.setAlwaysOnTop(true, "screen-saver");
  setupWin.loadURL(`${SETUP_URL}?v=${Date.now()}`);
  setupWin.on("closed", () => { setupWin = null; });
}

/** Open the wizard on a FIRST run, or drop the one-time banner on an existing user who never
 *  finished setup. The distinction matters: the wizard takes over the screen, and doing that
 *  to someone who has been running the app for months reads as the update breaking something.
 *  🔑 Asks the SIDECAR rather than deciding here — `freshInstall` is judged there, before
 *  anything can write a config, and the shell has no equivalent signal of its own. */
async function maybeRunSetup() {
  let s = null;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/setup`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) s = await r.json();
  } catch { /* sidecar not up yet — a wizard we can't populate is worse than none */ }
  if (!s || s.setupDone) return;
  if (s.freshInstall) { openSetup(); return; }
  // Existing user: nudge only, and only once. The canvas owns the banner; if the overlay is
  // switched off there's nowhere to show it, and it simply waits for a launch where there is.
  if (!s.nudgeDismissed) {
    const unresolved = Object.keys(s.steps).filter((k) => !s.steps[k].done && !s.steps[k].optional);
    if (unresolved.length) { pendingSetupNudge = { steps: unresolved.length }; flushSetupNudge(); }
  }
}

/** 🔑 The nudge is QUEUED, not sent directly. This runs during startup, racing the canvas's
 *  first load — a send that lands before the page's listener exists is dropped silently, which
 *  is the same trap the widget-visibility replay hit (hence the did-finish-load push above).
 *  So it's held here and flushed by whichever of the two finishes second.
 *  🔑 Gated on `overlayLoaded`, NOT on `overlay` being non-null: the window object exists the
 *  moment createOverlay() returns, long before its page has a listener, so testing the window
 *  would "deliver" the nudge into nothing and then clear the queue. */
let pendingSetupNudge = null;
function flushSetupNudge() {
  if (!pendingSetupNudge || !overlay || !overlayLoaded) return;
  overlay.webContents.send("overlay:setup-nudge", pendingSetupNudge);
  pendingSetupNudge = null;
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
    if (process.platform !== "win32") { cachedElevated = null; return resolve(null); }
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
  const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST" }, (r) => r.resume());
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
  if (!app.isPackaged || !UPDATES_SUPPORTED) return;
  autoUpdater.autoDownload = true;
  // Force a full streamed download instead of a block-differential one. The differential path
  // emits NO download-progress events (so the tray sits at 0% the whole time), and because our
  // installer isn't block-aligned across builds it re-downloads nearly the full file anyway via
  // hundreds of slow ranged requests. A single full download is faster here and drives the tray %.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.on("update-downloaded", (info) => {
    updateDownload = null;
    refreshTray();
    if (trayIsUsable()) tray.setToolTip("SC Overlay");
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
    if (trayIsUsable()) tray.setToolTip(`SC Blueprint Tracker — downloading update ${pct}%`);
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
    if (trayIsUsable()) tray.setToolTip("SC Overlay");
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
  if (!UPDATES_SUPPORTED) {
    shell.openExternal("https://github.com/SubliminalsTV-Projects/sc-loadout-overlay/releases");
    return;
  }
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
function trayIsUsable() {
  return !!(tray && !tray.isDestroyed());
}

function refreshTray() {
  // Tray callbacks, window close handlers, and updater events can race while
  // app.quit() is closing windows. Never touch a Tray after destroy().
  if (app.isQuitting || !trayIsUsable()) return;
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
            { label: moveMode ? "Done arranging widgets" : "Arrange widgets…  [Ctrl+Alt+M]", click: toggleMove },
            ...(!LINUX_HARD_CLICK_THROUGH
              ? [{
                  label: "Lock Blueprint Tracker (always click-through)",
                  type: "checkbox",
                  checked: locked,
                  click: toggleLock,
                }]
              : []),
          ]
        : [{ label: "Overlay off — tracking still running", enabled: false }]),
      { type: "separator" },
      // Upstream 0.1.36 widgets.
      { label: "Widgets", enabled: false },
      { label: "Mining Scanner", type: "checkbox", checked: miningVisible, click: toggleMining },
      { label: "Journal", type: "checkbox", checked: notepadVisible, click: toggleNotepad },
      { label: "Twitch Chat", type: "checkbox", checked: twitchChatVisible, click: toggleTwitchChat },
      { label: "SC Feed", type: "checkbox", checked: scFeedVisible, click: toggleScFeed },
      { label: "Unlock Alerts", type: "checkbox", checked: unlockAlertVisible, click: toggleUnlockAlert },
      { label: "Loot Split", type: "checkbox", checked: partyVisible, click: toggleParty },
      { label: "Event Tracker", type: "checkbox", checked: battagliaVisible, click: toggleBattaglia },
      { label: "Chat", type: "checkbox", checked: chatVisible, click: toggleChat },
      { label: "Web Page", type: "checkbox", checked: webViewVisible, click: toggleWebView },
      { label: "Infographic Viewer", type: "checkbox", checked: bindingChartVisible, click: toggleBindingChart },
      { type: "separator" },
      { label: "Tools", enabled: false },      { label: "Refresh missions (re-read log)", click: refreshMissions },
      { label: "Verify from logs", click: verifyFromLogs },
      { label: "Open config…", click: openConfig },
      ...(process.platform === "linux" ? [{ label: "Open config in browser…", click: openConfigInBrowser }] : []),
      ...(process.platform === "win32" && cachedElevated === false
        ? [{ label: "Restart as administrator (for in-game hotkeys)", click: restartAsAdmin }]
        : []),
      { type: "separator" },
      ...(updateDownload
        ? [{
            label: `Downloading ${updateDownload.version ? "v" + updateDownload.version : "update"} — ${updateDownload.percent}%` +
              (updateDownload.bps ? ` (${(updateDownload.bps / 1048576).toFixed(1)} MB/s)` : ""),
            enabled: false,
          }]
        : [{ label: process.platform === "linux" ? "Open release page…" : "Check for updates…", click: checkForUpdatesManual }]),
      { label: `Version ${APP_VERSION}`, enabled: false },
      {
        label: "Original upstream project",
        click: () => shell.openExternal("https://github.com/SubliminalsTV-Projects/sc-loadout-overlay"),
      },
      { type: "separator" },
      { label: "Quit", click: () => {
          app.isQuitting = true;
          app.quit();
        } },
    ]),
  );
}

function createTray() {
  // The asar only packs electron/**, so overlay/ isn't inside it — in the packaged
  // app the icon ships with the sidecar under resources/server/overlay/. Resolve
  // there when packaged, else from the repo (dev). (Was ROOT/overlay → blank tray.)
  const iconCandidates = [
    path.join(ROOT, "server", "overlay", "tray-icon.png"),
    path.join(process.resourcesPath, "server", "overlay", "tray-icon.png"),
    path.join(process.resourcesPath, "app", "server", "overlay", "tray-icon.png"),
    path.join(ROOT, "build", "icon.png"),
  ];
  const iconPath = iconCandidates.find((candidate) => fs.existsSync(candidate)) || "";
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("SC Overlay");
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
    if (process.platform === "win32") {
      foreground.onChange(() => {
        applyMouse();
        try { overlay?.webContents.send("overlay:game-focus", foreground.gameInFront()); } catch {}
      });
    }
    const serverStarted = startServer();
    const up = serverStarted ? await waitForServer() : false;
    if (!up) {
      console.error("[electron] server did not come up on :" + PORT);
      dialog.showErrorBox("SC Overlay server failed", `The local server could not start. See ${SIDECAR_LOG}`);
      createTray();
      return;
    }    overlayEnabled = readOverlayEnabled();
    const savedBrowser = readBrowserState();
    browserVisible = savedBrowser.browserVisible;
    twitchChatVisible = savedBrowser.chatVisible;
    browserRuntimeState = { ...browserRuntimeState, url: savedBrowser.url, channel: savedBrowser.channel };

    // Attach the held interaction key before creating the always-on-top Overlay Manager. This
    // ensures the low-level hook is already listening while Star Citizen still owns focus on the
    // very first launch; held-F is ready before the overlay window is created.
    let registeredInteractKey = "RightAlt";
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8"));
      if (c.interactHotkey) registeredInteractKey = c.interactHotkey;
      if (process.platform === "linux") fHoverEnabled = c.holdToInteract !== false;
    } catch { /* defaults */ }
    const earlyInteractResult = registerInteractHotkey(registeredInteractKey);
    if (earlyInteractResult.ok) console.log(`[hotkeys] interaction gate ${registeredInteractKey} registered before overlay creation`);
    else console.error(`[hotkeys] interaction gate ${registeredInteractKey} unavailable: ${earlyInteractResult.error || "unknown"}`);

    if (LINUX_HARD_CLICK_THROUGH) {
      console.log("[electron] Linux hard click-through mode active; one native canvas hosts Blueprint, Mining, and Notepad");
    }
    if (overlayEnabled && !overlay) createOverlay();
    createTray();
    overlayWindows.installDisplayHooks();
    setupUpdater();
    hotkeys.register("Control+Alt+L", toggleLock); // legacy Blueprint lock/unlock

    // The Linux-only Shift+F5/F6 shortcuts were removed. The original Ctrl+Alt+M arrange
    // command remains configurable below, and held-F remains the normal interaction gate.


    // Configurable global hotkeys (live-rebindable from the config window), read from the
    // persisted config: overlay show/hide (default F3) + binding-chart PNG (default Alt+F3).
    let overlayKey = "F3";
    let bindKey = "Ctrl+F3";
    let miningKey = "Shift+F3";
    let interactKey = registeredInteractKey;
    let moveKey = "Ctrl+Alt+M";
    let fabClaimKey = "F4";
    try {
      const p = path.join(CONFIG_DIR, "config.json");
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      if (typeof c.overlayHotkey === "string") overlayKey = c.overlayHotkey;
      if (typeof c.bindingHotkey === "string") bindKey = c.bindingHotkey;
      if (typeof c.webViewHotkey === "string") registerWebViewHotkey(c.webViewHotkey);
      if (typeof c.notepadHotkey === "string") notepadKey = c.notepadHotkey;
      if (Number.isFinite(c.canvasOffsetX) || Number.isFinite(c.canvasOffsetY)) {
        canvasOffset = { x: Number(c.canvasOffsetX) || 0, y: Number(c.canvasOffsetY) || 0 };
      }
      if (Number.isFinite(c.canvasScale)) canvasScale = clampCanvasScale(c.canvasScale);
      if (typeof c.miningHotkey === "string") miningKey = c.miningHotkey;
      if (typeof c.interactHotkey === "string") interactKey = c.interactHotkey;
      if (typeof c.moveHotkey === "string") moveKey = c.moveHotkey;
      if (process.platform === "linux") fHoverEnabled = c.holdToInteract !== false;
      else holdMode = c.holdToInteract === true;    } catch { /* defaults */ }
    registerOverlayHotkey(overlayKey);
    registerBindingHotkey(bindKey);
    registerMiningHotkey(miningKey);
    if (interactKey !== registeredInteractKey) {
      registerInteractHotkey(interactKey);
      registeredInteractKey = interactKey;
    }
    registerMoveHotkey(moveKey);
    registerFabClaimHotkey(fabClaimKey);
    // Learn our elevation state (async) so the tray can offer "Restart as administrator" when
    // we're NOT elevated — the state hotkeys-over-a-focused-game depend on.
    checkElevated().then(() => refreshTray());
    // Restore the embedded Mining and Notepad widget visibility on the single native canvas.
    try {
      const p = path.join(CONFIG_DIR, "config.json");
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      notepadVisible = c.notepadOpen === true;
      twitchChatVisible = c.twitchChatOpen === true;
      scFeedVisible = c.scFeedOpen === true;
      unlockAlertVisible = c.unlockAlertOpen !== false;
      partyVisible = c.partyOpen === true;
      battagliaVisible = c.battagliaOpen === true;
      chatVisible = c.chatOpen === true;
      webViewVisible = c.webViewOpen === true;
      bindingChartVisible = c.bindingChartOpen === true;
      miningVisible = c.miningOpen === true;
      miningAutoArm = c.miningAutoShow === true;
      miningArm = miningAutoArm;
      if (miningVisible) miningAutoSuppress = 0;
    } catch {}
    sendNotepadVisible({ on: notepadVisible });
    sendEmbeddedMiningVisible({ on: miningVisible, arm: miningAutoArm, transient: false });
    sendTwitchChatVisible({ on: twitchChatVisible });
    sendScFeedVisible({ on: scFeedVisible });
    sendUnlockAlertVisible({ on: unlockAlertVisible });
    sendPartyVisible({ on: partyVisible });
    sendBattagliaVisible({ on: battagliaVisible });
    sendWebViewVisible({ on: webViewVisible });
    sendBindingChartVisible({ on: bindingChartVisible });
    sendBrowserVisible();
    pushWidgetStates();
    postConfig({ miningAssistant: miningVisible });    // Opt-in fabricator screen-capture loop (config.fabCapture). No-op until enabled.
    startFabCapture({
      port: PORT,
      configDir: CONFIG_DIR,
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
    const r = await dialog.showOpenDialog(overlay ?? undefined, {
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
    if (!miningVisible) setMiningVisible(true);
  });

  // Config window's "Show in-game overlay" toggle (crash workaround). Owned here, not by
  // the sidecar config, so destroy/create is immediate.
  ipcMain.handle("app:version", () => APP_VERSION);
  ipcMain.handle("app:is-elevated", () => checkElevated());
  ipcMain.handle("app:platform", () => process.platform);
  ipcMain.handle("app:restart-as-admin", () => { if (process.platform === "win32") restartAsAdmin(); return process.platform === "win32"; });
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

  // ── setup wizard ────────────────────────────────────────────────────────────
  ipcMain.on("setup:open-settings", () => openSettingsSurface());
  // Re-validated here, not just in the preload: a renderer is never the authority on what the
  // shell is allowed to launch. https only, same rule as overlay:open-url.
  ipcMain.on("setup:open-external", (_e, url) => {
    if (typeof url === "string" && /^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
  });
  ipcMain.on("setup:close", () => setupWin?.close());
  // The nudge banner's "set it up" button, and its dismiss. Both come from the canvas.
  ipcMain.on("setup:open-wizard", () => openSetup());

  // "Try again" on the sidecar-down banner. Resets the strike count: those five attempts were
  // spent on whatever was wrong at the time, and the user pressing this is new information —
  // usually that they have just fixed it.
  ipcMain.on("app:retry-sidecar", () => {
    clearTimeout(serverRestartTimer);
    serverRestarts = 0;
    announceSidecar({ down: true, retrying: true });
    void (async () => {
      await reclaimStalePort(); // the usual reason a respawn fails: something else took the port
      await respawnAndConfirm();
    })();
  });

  // Live-apply a captured hotkey (config window), no restart. Persistence is handled
  // separately by the config save; these just (re)register the global shortcut.
  ipcMain.handle("set-overlay-hotkey", (_e, accel) =>
    registerOverlayHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-binding-hotkey", (_e, accel) =>
    registerBindingHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-webview-hotkey", (_e, accel) =>
    registerWebViewHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-mining-hotkey", (_e, accel) =>
    registerMiningHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-interact-hotkey", (_e, accel) =>
    registerInteractHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-move-hotkey", (_e, accel) =>
    registerMoveHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("app:set-hold-mode", (_e, on) => {
    if (process.platform === "linux") {
      fHoverEnabled = !!on;
      if (!fHoverEnabled) {
        fHoverHeld = false;
        momentaryInteractionActive = false;
        overlayInteractionLatched = false;
        overlayInteractionClaimSource = "";
        fHoverOverWidget = false;
        fHoverSuppressedUntilRelease = false;
        browserController?.setInteractionKeyHeld(false);
        if (!unifiedInteractionActive) {
          interactiveTarget = null;
          locked = true;
        }
      }
      applyMouse();
      return fHoverEnabled;
    }
    holdMode = !!on;
    if (!holdMode) holdInteract = false;
    applyMouse();
    return holdMode;
  });
  ipcMain.handle("app:want-foreground", (_e, on) => {
    if (process.platform !== "win32") return null;
    foreground.want("cog", !!on);
    return foreground.ready() ? foreground.gameInFront() : null;
  });
  ipcMain.on("overlay:hover", (_e, on) => { hovering = !!on; applyMouse(); });
  // The page reports the visible widget rectangles. During held-F gate/latch interaction these
  // rectangles become the native Linux window shape: widget clicks reach Electron while empty
  // transparent canvas remains click-through to Star Citizen.
  ipcMain.on("overlay:regions", (_e, rects) => {
    overlayRegions = Array.isArray(rects)
      ? rects.map((r) => ({ x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) }))
          .filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 1 && r.h > 1)
      : [];
    if (momentaryInteractionActive || overlayInteractionLatched) applyMouse();
  });
  ipcMain.on("overlay:claim-interaction", (_e, source) => claimFocusLatchedInteraction(source));
  ipcMain.on("overlay:release-interaction", (_e, reason) => releaseFocusLatchToGame(reason || "transparent canvas clicked"));
  ipcMain.on("browser:bounds", (_e, bounds) => browserController?.setBrowserBounds(bounds));
  ipcMain.on("browser:chat-bounds", (_e, bounds) => browserController?.setChatBounds(bounds));
  ipcMain.on("browser:navigate", (_e, value) => browserController?.navigate(value));
  ipcMain.on("browser:back", () => browserController?.back());
  ipcMain.on("browser:forward", () => browserController?.forward());
  ipcMain.on("browser:reload", () => browserController?.reload());
  ipcMain.on("browser:stop", () => browserController?.stop());
  ipcMain.on("browser:set-channel", (_e, channel) => browserController?.setChannel(channel));
  ipcMain.on("browser:set-visible", (_e, on) => setBrowserVisible(!!on));
  ipcMain.on("browser:set-chat-visible", (_e, on) => setTwitchChatVisible(!!on));
  ipcMain.handle("browser:state", () => browserController?.state() || {
    browserVisible, chatVisible: twitchChatVisible, ...browserRuntimeState,
  });
  ipcMain.on("overlay:notepad-editing", (_e, on) => {
    notepadEditing = !!on;
    if (notepadEditing) {
      if (LINUX_HARD_CLICK_THROUGH && !unifiedInteractionActive && !overlayInteractionLatched) setInteractiveTarget("overlay", "Notepad typing");
      applyMouse();
      focusLinuxInteractiveWindow("overlay");
      if (holdInteract) notepadFocusPending = true;
      else { try { overlay?.webContents.send("overlay:notepad-focus"); } catch {} }
    } else {
      notepadFocusPending = false;
      applyMouse();
    }
  });
  // A HUD modal (what's-new card / hub) opened/closed → keep it clickable even under lock.
  ipcMain.on("overlay:modal", (_e, on) => {
    modalOpen = !!on;
    maskWebView(modalOpen);
    applyMouse();
    reapplyOverlayInputShape();
    // Startup patch notes are a blocking agreement/acknowledgement surface. Make the native
    // canvas interactive and focused immediately so its checkbox and buttons work without first
    // entering Ctrl+Alt+M arrange mode or holding F.
    if (modalOpen) setTimeout(() => focusLinuxInteractiveWindow("overlay"), 0);
  });
  // An active drag/resize gesture on the HUD widget → force this window interactive for the
  // gesture so a fast pointer can't slip off the widget and drop the drag (the window is
  // otherwise click-through except over the widget, so the stacked mining canvas isn't blocked).
  ipcMain.on("overlay:drag-lock", (_e, on) => {
    dragging = !!on;
    // Star Citizen recentres the cursor while IT has focus, which yanks a drag out from under
    // you mid-gesture. We can't stop the game doing that — but it only does it while focused, so
    // taking focus for the duration of the gesture stops it. Entering arrange mode already does
    // this (setMoveMode); a corner-resize or a bar-drag outside arrange did not, which is where
    // it kept biting. Focus is not handed back: the user is mid-drag on the overlay, and the
    // notepad's typing mode has behaved this way since 0.1.33.
    if (dragging && overlay && !overlay.isDestroyed() && !overlay.isFocused()) overlay.focus();
    applyMouse();
  });
  // The cog's "Open settings…" opens the full config window.
  ipcMain.on("overlay:open-settings", () => openSettingsSurface());
  // The live-on-Twitch diamond opens the stream in the default browser (https only).
  ipcMain.on("overlay:open-url", (_e, url) => {
    if (typeof url === "string" && /^https:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.on("overlay:begin-move", () => { maskWebView(true); setMoveMode(true); });
  ipcMain.on("overlay:end-move", () => { maskWebView(false); setMoveMode(false); });
  ipcMain.on("webview:bounds", (_e, r) => { if (!r || typeof r.x !== "number") return; webViewBounds={x:Math.round(r.x),y:Math.round(r.y),width:Math.max(0,Math.round(r.width)),height:Math.max(0,Math.round(r.height))}; applyWebViewBounds(); });
  ipcMain.on("webview:show", (_e,on)=>{webViewWanted=!!on;if(webViewWanted)ensureWebView();applyWebViewBounds();});
  ipcMain.on("webview:load", (_e,url)=>{if(typeof url!=="string"||!/^https?:\/\//i.test(url))return;ensureWebView();webView?.webContents.loadURL(url).catch(()=>{});});
  ipcMain.on("webview:reload",()=>{try{webView?.webContents.reload();}catch{}});
  ipcMain.on("webview:back",()=>{try{if(webView?.webContents.navigationHistory.canGoBack())webView.webContents.navigationHistory.goBack();}catch{}});
  ipcMain.on("webview:close",()=>{webViewWanted=false;destroyWebView();});  // Per-widget layout (canvas model): the page fetches saved widget layouts on load and
  // saves them back as the user drags/resizes. Scale is now a property of each widget inside
  // the full-screen canvas, not a resize of the overlay window (which is fixed full-screen).
  ipcMain.handle("overlay:get-widgets", () => readWidgets());
  ipcMain.on("overlay:save-widget", (_e, id, layout) => saveWidget(id, layout));
  ipcMain.handle("overlay:reset-layout", async () => { await resetWidgetLayout(); return true; });
  ipcMain.handle("overlay:canvas-info", () => overlayWindows.canvasInfo());

  // ── global widget on/off (from the in-overlay hub) ──────────────────────────
  ipcMain.handle("app:widget-states", () => widgetStatesSnapshot());  ipcMain.on("app:set-mining", (_e, on) => {
    if (on) miningAutoSuppress = 0;
    setMiningVisible(!!on, { suppressAuto: !on });
  });
  ipcMain.on("app:set-notepad", (_e, on) => setNotepadVisible(!!on));
  ipcMain.on("app:set-twitchchat", (_e,on)=>setTwitchChatVisible(!!on));
  ipcMain.on("app:set-twitch-chat", (_e,on)=>setTwitchChatVisible(!!on));
  ipcMain.on("app:set-browser", (_e,on)=>setBrowserVisible(!!on));
  ipcMain.on("app:set-scfeed", (_e,on)=>setScFeedVisible(!!on));
  ipcMain.on("app:set-unlockalert", (_e,on)=>setUnlockAlertVisible(!!on));
  ipcMain.on("app:set-party", (_e,on)=>setPartyVisible(!!on));
  ipcMain.on("app:set-battaglia", (_e,on)=>setBattagliaVisible(!!on));
  ipcMain.on("app:set-webview", (_e,on)=>setWebViewVisible(!!on));
  ipcMain.on("app:set-bindingchart", (_e,on)=>setBindingChartVisible(!!on));
  ipcMain.handle("scfeed:pick-tone", async()=>{const r=await dialog.showOpenDialog(overlay??undefined,{title:"Choose an SC Feed alert WAV",filters:[{name:"WAV audio",extensions:["wav"]}],properties:["openFile"]});if(r.canceled||!r.filePaths.length)return false;await postConfig({scFeedTone:r.filePaths[0]});return true;});
  ipcMain.handle("scfeed:clear-tone", async()=>{await postConfig({scFeedTone:""});return true;});
  ipcMain.handle("app:metrics",()=>{const os=require("node:os");let cpu=0,mem=0;const rows=[];for(const m of app.getAppMetrics()){const mb=Math.round((m.memory?.workingSetSize??0)/1024);const pc=m.cpu?.percentCPUUsage??0;cpu+=pc;mem+=mb;rows.push({type:m.type,mb,pc});}return{totalMb:mem,cpuPct:Math.round((cpu/os.cpus().length)*10)/10,cores:os.cpus().length,systemMb:Math.round(os.totalmem()/1048576),rows};});
  ipcMain.on("app:open-data-folder",(_e,which)=>{const dirs={"party-sessions":"party-sessions","fab-captures":"fab-captures"};const sub=dirs[String(which)];if(!sub)return;const dir=path.join(CONFIG_DIR,sub);try{fs.mkdirSync(dir,{recursive:true});}catch{}shell.openPath(dir);});
  ipcMain.on("mining:hover",()=>{});
  ipcMain.on("mining:modal",(_e,on)=>{modalOpen=!!on;applyMouse();});
  ipcMain.on("mining:drag-lock",(_e,on)=>{dragging=!!on;applyMouse();});
  ipcMain.on("mining:summon-cog",()=>{try{overlay?.webContents.send("overlay:summon-cog");}catch{}});
  ipcMain.on("mining:begin-move",()=>setMiningMoveMode(true));
  ipcMain.on("mining:end-move",()=>setMiningMoveMode(false));
  // Tray app — keep running when the overlay window is closed.
  app.on("window-all-closed", (e) => {
    e.preventDefault?.();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    unifiedInteractionActive = false;
    overlayInteractionLatched = false;
    momentaryInteractionActive = false;
    fHoverHeld = false;
    hotkeys.unregisterAll();
    if (process.platform === "win32") foreground.stop();
    if (serverRestartTimer) clearTimeout(serverRestartTimer);
    if (evdevInteractController) { try { evdevInteractController.stop(); } catch {} evdevInteractController=null; }
    if (server) { server.kill(); server=null; }
  });
  app.on("will-quit", () => { if (trayIsUsable()) tray.destroy(); tray=null;  });
}
