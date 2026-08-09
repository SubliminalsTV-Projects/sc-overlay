// Electron shell for the SC Overlay — a transparent, always-on-top,
// click-through in-game HUD plus a system tray, wrapping the existing local server.
//
// The server (src/overlay-server.ts) is unchanged: Electron just manages its
// lifecycle and points a frameless transparent BrowserWindow at the HUD it serves
// (http://localhost:8778/missions.html). OBS browser-source mode still works in
// parallel — the server serves both.
//
// Click-through is ON by default so the overlay never eats clicks meant for the
// desktop. Shift+F6 is the Linux move/resize workflow for every visible widget. Pressing F while
// hovering a classified widget opens a persistent interaction session so text entry does not require
// holding F. The native
// Linux build uses one transparent Overlay Manager BrowserWindow for Blueprint, Mining, Notepad,
// and browser shells.
// Requires SC in BORDERLESS WINDOWED — overlays can't draw over exclusive fullscreen.

// A terminal or `tee` can disappear while the GUI keeps running. Node treats a later console
// write to that closed pipe as an unhandled stream error unless the process owns an error
// listener. Ignore only the normal broken-pipe case; preserve fail-fast behavior for anything
// else so real stream failures are not hidden.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (error) => {
    if (error?.code === "EPIPE") return;
    setImmediate(() => { throw error; });
  });
}

// Prefix application-owned log lines with an ISO timestamp. Chromium, Mesa, and Wine may still
// write their own native diagnostics directly, but every ArchVerse state transition can now be
// correlated with benchmark phases and configuration saves.
for (const method of ["log", "warn", "error"]) {
  const original = console[method].bind(console);
  console[method] = (...args) => original(`[${new Date().toISOString()}]`, ...args);
}

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
// Linux keeps the proven XWayland hard-click-through interaction contract.
const LINUX_HARD_CLICK_THROUGH = process.platform === "linux" && process.env.SCBT_FORCE_CLICK_THROUGH !== "0";
const INTERACTION_TIMEOUT_MS = 30000;
const HUD_URL = `http://127.0.0.1:${PORT}/missions.html`;
const CONFIG_URL = `http://127.0.0.1:${PORT}/config.html`;
const SETUP_URL = `http://127.0.0.1:${PORT}/setup.html`;
const INSTANCE_ID = require("node:crypto").randomUUID();

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
let lastGlobalPointerSource = "";
let fHoverHeld = false;
let momentaryInteractionActive = false;
let overlayInteractionLatched = false;
let overlayInteractionClaimSource = "";
let fHoverOverWidget = false;
let fHoverSuppressedUntilRelease = false;
let fHoverEnabled = process.platform === "linux";
let fHoverPollTimer = null;
let fHoverMotionProbeScheduled = false;
let fHoverTarget = null;
let fHoverProbeSeq = 0;
let fHoverLastClassifiedSeq = 0;
let fHoverLastClassificationAt = 0;
let fHoverDirectProbeInFlight = false;
let overlayRegionSnapshotSignature = "";
let fHoverLinuxPointerSampleAt = 0;
let fHoverHookPointer = null;
let fHoverHookPointerSampleAt = 0;
let fHoverPointerPhase = "game";
let fHoverMissStartedAt = 0;
let fHoverHandoffAnchor = null;
let fHoverHandoffSeq = 0;
let fHoverHandoffWaitLogged = false;
let fHoverHostHookAuthoritative = false;
let stopMouseButtonWatch = null;
let syntheticMouseMoveScheduled = false;
let lastNativeMouseInput = null;
const forwardedMouseButtons = new Map();
const pendingMouseFallbacks = new Set();
const F_HOVER_HOST_SAMPLE_MS = 50;
const F_HOVER_FALLBACK_POLL_MS = 100;
const F_HOVER_LEAVE_GRACE_MS = 180;
const F_HOVER_HANDOFF_TOLERANCE_PX = 32;
const F_HOVER_HANDOFF_DELAYS_MS = [75, 175, 350];
const F_CLICK_NATIVE_GRACE_MS = 28;
let miningAutoArm = false;
let miningMoveMode = false;
let miningOnlyInteraction = false;
let chatVisible = false;
let configWidgetVisible = false;
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
  webView.webContents.on("before-mouse-event", (_event, mouse) => {
    noteNativeMouseInput("web-page", mouse, webViewBounds);
  });
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
  const out = sidecarLogStream();
  const stdio = out === "ignore" ? "ignore" : ["ignore", out, out];
  if (app.isPackaged) {
    // Prod: the esbuild-bundled server shipped as an extraResource, run by OUR OWN exe
    // with ELECTRON_RUN_AS_NODE (plain Node mode — no BrowserWindow, no second app).
    // It replaced a 112 MB bun-compiled standalone exe in 0.1.41: the machine already
    // ships a Node runtime inside Electron, so the sidecar borrows it instead of
    // carrying its own. cwd = the bundle's dir so assetDir finds overlay/ + data/.
    const serverJs = path.join(process.resourcesPath, "server", "server.mjs");
    // 🔑 `windowsHide` stays NOT optional here. The bun-era sidecar was a CONSOLE-subsystem
    // executable and 0.1.35 shipped a persistent terminal window on every desktop by omitting
    // it (emergency 0.1.36). Electron-run-as-node is GUI-subsystem so no console should appear
    // either way — but the flag costs nothing and this exact spawn is where the regression
    // lived, so it does not come off on an argument from subsystem flags.
    // Inject the authoritative app version — the bundled sidecar can't read package.json.
    server = spawn(process.execPath, [serverJs], {
      cwd: path.dirname(serverJs),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", APP_VERSION, SC_INSTANCE: INSTANCE_ID, SC_TRACKER_CONFIG_DIR: CONFIG_DIR },
      stdio,
      windowsHide: true,
    });
    fs.closeSync(fd);
  } else {
    // Dev: run the TS server via tsx. Same flag, same reason — `shell:true` means cmd.exe, which is
    // a console app too.
    // SC_DEV unlocks the dev-replay endpoint (simulate finishing a mission without playing —
    // see src/dev-replay.ts). It is set HERE and nowhere else, so the packaged spawn above can
    // never carry it: that endpoint writes to the real blueprint collection, which syncs.
    server = spawn("npx tsx src/overlay-server.ts", {
      cwd: ROOT,
      shell: true,
      env: { ...process.env, APP_VERSION, SC_DEV: "1", SC_INSTANCE: INSTANCE_ID, SC_TRACKER_CONFIG_DIR: CONFIG_DIR },
      stdio,
      windowsHide: true,
    });
  }
  server.on("error", (err) => { noteInSidecarLog(`server error: ${String(err)}`); server = null; });
  server.on("exit", (code, signal) => {
    if (app.isQuitting) return;
    // Everything the app can do depends on it, so bring it back rather than leaving a window
    // that looks healthy and answers nothing.
    if (serverRestarts >= 5) {
      noteInSidecarLog(`server exited (code ${code}, signal ${signal}) — 5 crashes, not restarting again`);
      console.error("[electron] server has crashed 5 times — not restarting it again");
      announceSidecar({ down: true, retrying: false });
      return;
    }
    const wait = Math.min(30000, 1000 * 2 ** serverRestarts);
    serverRestarts += 1;
    noteInSidecarLog(`server exited (code ${code}, signal ${signal}) — restarting in ${wait}ms (attempt ${serverRestarts})`);
    console.error(`[electron] server exited (code ${code}) — restarting in ${wait}ms, see ${SIDECAR_LOG}`);
    announceSidecar({ down: true, retrying: true });
    serverRestartTimer = setTimeout(() => { void respawnAndConfirm(); }, wait);
  });
}

/** Everything the app does happens in the sidecar; the overlay is only the display. So a dead
 *  sidecar is INVISIBLE — the HUD sits there looking perfectly normal and silently tracks
 *  nothing, and the natural read is "this app doesn't work" rather than "a background process
 *  needs restarting". Sub hit exactly that: after a squatter was cleared his app had already
 *  burned its five retries, and nothing on screen said so.
 *  🔑 State is PUSHED on every transition rather than polled, and re-pushed on canvas load, so a
 *  banner can never be left showing after recovery (or missed because the page wasn't up yet). */
let sidecarState = { down: false, retrying: false };
function announceSidecar(state) {
  sidecarState = state;
  try {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:sidecar-state", state);
  } catch { /* window went away mid-send */ }
}
async function respawnAndConfirm() {
  startServer();
  if (await waitForServer(60)) announceSidecar({ down: false, retrying: false });
}

/** Free the port BEFORE spawning, if a sidecar of ours is squatting on it.
 *
 *  Runs before startServer() on purpose. Killing from inside waitForServer would race the
 *  exit-handler's own respawn — our just-spawned child fails to bind, exits, and schedules a
 *  restart at the same moment we spawn another — and two sidecars fighting over one port is a
 *  worse bug than the one being fixed.
 *
 *  Nothing has been spawned yet when this runs, so ANY sidecar answering here is by definition
 *  not ours. Anything that doesn't look like our sidecar is left strictly alone: another program
 *  owning the port is the user's business, and killing it would be far worse than failing to start.
 */
function reclaimStalePort() {
  return new Promise((resolve) => {
    const done = () => resolve();
    const req = http.get(`http://localhost:${PORT}/api/instance`, (r) => {
      let body = "";
      r.on("data", (c) => { body += c; });
      r.on("end", () => {
        let who = null;
        try { who = JSON.parse(body); } catch { /* not our shape — leave it alone */ }
        if (!who || typeof who.pid !== "number") return done();
        noteInSidecarLog(
          `port ${PORT} was already held by a sidecar (pid ${who.pid}, version ${who.version || "?"}) ` +
          `before this launch spawned one — reclaiming it. Adopting it instead would have served ` +
          `that process's data: its changelog, its version, its datasets.`);
        console.error(`[electron] stale sidecar on :${PORT} (pid ${who.pid}) — reclaiming`);
        try { process.kill(who.pid); } catch { /* already gone, or not ours to kill */ }
        setTimeout(done, 400); // let the OS release the listener before we bind
      });
    });
    req.on("error", done);           // nothing there — the normal case
    req.setTimeout(1500, () => { req.destroy(); done(); });
  });
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
        .get(`http://localhost:${PORT}/api/instance`, (r) => {
          let body = "";
          r.on("data", (c) => { body += c; });
          r.on("end", () => {
            let who = null;
            try { who = JSON.parse(body); } catch { /* not our shape */ }
            if (who && who.instance === INSTANCE_ID) return resolve(true); // ours
            retry(); // someone else's — keep waiting for ours rather than trusting theirs
          });
        })
        .on("error", retry);
    };
    ping();
  });
}

function primaryBounds() {
  if (process.platform === "linux") return overlayWindows.primaryBounds();
  const b = screen.getPrimaryDisplay().bounds;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}
// The union of every display = the whole virtual desktop. Its origin can be NEGATIVE when a
// monitor sits left/above the primary (e.g. x:-1080). The overlay canvas spans this so a widget
// can be dragged across monitors; the page renders widgets at their PRIMARY-relative position +
// the primary's offset within the canvas (overlay:canvas-info → px/py), so existing layouts stay
// put on the primary and only a deliberate drag carries a widget onto another display.
//
// 🔴 THE UNION MUST BE TAKEN IN *PHYSICAL* PIXELS, NOT IN THE REPORTED DIP BOUNDS. On Windows each
// display's `bounds` is expressed in ITS OWN DIP — divided by ITS OWN scaleFactor — so on a
// mixed-DPI desktop the reported rectangles are in different units and their union is a number
// that describes no coordinate system at all. Measured on Sub's rig at 200% (2026-08-03): a
// 3440×1440 primary reports 1720×720 while a 1080×1920 secondary at 100% reports its true size,
// giving a "desktop" of 2800×1924 against a real one of 4520×2644. setBounds was then handed that
// nonsense and Windows put the window somewhere else entirely — asked x=-1080, got x=-540 — so the
// canvas was laid out for a window that did not exist. The dotted outline landed BELOW the bottom
// of his monitor, which is the "at 175% and up the whole overlay just disappears" report.
//
// 🔑 The error scales with the primary's scaleFactor, which is why 100–150% looked fine and 175%+
// did not: at 100% every display's DIP *is* its physical size and the old union was accidentally
// correct. Uniform-DPI desktops are unaffected by this change for the same reason — with one scale
// factor everywhere, unioning-then-converting and converting-then-unioning are the same operation.
//
// So: rebuild each display's physical rect (`bounds * its own scaleFactor` — the inverse of the
// per-display conversion Electron applied), union THOSE, and hand the result to
// screen.screenToDipRect() to get back the single DIP rect setBounds actually wants.
function physicalDesktopBounds() {
  const all = screen.getAllDisplays();
  const rects = all.map((d) => {
    const sf = d.scaleFactor || 1;
    return {
      x: Math.round(d.bounds.x * sf), y: Math.round(d.bounds.y * sf),
      right: Math.round((d.bounds.x + d.bounds.width) * sf),
      bottom: Math.round((d.bounds.y + d.bounds.height) * sf),
    };
  });
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.right));
  const maxY = Math.max(...rects.map((r) => r.bottom));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
function virtualDesktopBounds() {
  if (process.platform === "linux") return overlayWindows.canvasBounds();
  const phys = physicalDesktopBounds();
  // screenToDipRect is Windows-only; everywhere else (and on any build without it) the reported
  // bounds are already the one true coordinate system, so the old union is correct as written.
  if (typeof screen.screenToDipRect === "function") {
    try {
      const r = screen.screenToDipRect(null, phys);
      if (r && Number.isFinite(r.width) && r.width > 0 && r.height > 0) return r;
    } catch { /* fall through to the plain union */ }
  }
  const all = screen.getAllDisplays();
  const minX = Math.min(...all.map((d) => d.bounds.x));
  const minY = Math.min(...all.map((d) => d.bounds.y));
  const maxX = Math.max(...all.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...all.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
// The widget overlay spans the virtual desktop (multi-monitor). fullDisplayBounds() drives the
// overlay window + overlay:canvas-info. (The binding-chart PNG stays PRIMARY-only — it's a
// gameplay reference overlay, not a widget canvas — so it uses primaryBounds() directly.)
// User nudge for the canvas, in physical px. Read from config at startup and updated live by the
// arrange-mode nudge; 0,0 for everyone whose canvas already lines up.
let canvasOffset = { x: 0, y: 0 };
// The other half of the calibration: a uniform scale for the canvas coordinate space, applied by
// the page as CSS `zoom` on <html>. Changing the PRIMARY monitor's Windows scaling leaves the
// canvas both mis-placed AND mis-sized, and an offset alone can only fix the placement.
// 🔑 Measured, not assumed (Electron 43): CSS `zoom` on the root scales iframe CONTENT as well as
// the frame box — 100×40 inside a widget iframe renders 200×80 at zoom 2 — and
// getBoundingClientRect() returns zoom-ADJUSTED px, so the regions the page reports for cursor
// hit-testing are already in window coordinates and need no correction here. That is what rules
// out webContents.setZoomFactor(), whose zoom is per-ORIGIN and would drag the Settings window
// (same localhost origin) along with the canvas.
let canvasScale = 1;
/** The canvas's window rect: the UNION of the un-nudged virtual desktop and the nudged canvas.
 *
 *  🔑 The nudge moves the WINDOW, never the widget coordinates. Widget positions live in
 *  widgets.json in canvas space; if the nudge changed what that space MEANS, every existing
 *  layout would silently relocate. Translating the window leaves saved layouts untouched, and
 *  keeps the canvas spanning the whole virtual desktop — so dragging a widget onto another
 *  monitor still works, which is the thing a mixed-DPI user is most likely to want.
 *
 *  🔑 GROW, don't just translate. The first version moved the window without resizing it, so a
 *  nudge of -408,-199 walked the canvas OFF the right/bottom of the desktop and CLIPPED the edge
 *  it was pushed toward — a widget parked on the far monitor became unreachable. The window now
 *  spans everything the canvas could need: it starts at whichever is further left/up of the
 *  desktop origin and the nudged origin, and is wide/tall enough to still reach the desktop's far
 *  edge. The canvas content then sits at canvasContentShift() INSIDE that window.
 *
 *  Why a manual nudge at all: on a mixed-DPI desktop (Jman — 4K @225% primary beside two 1080p
 *  @100%) the canvas comes out the right SIZE but in the wrong PLACE. Sub reproduced it by
 *  setting one of his own monitors to 175%: "it shifts everything down and to the right". Rather
 *  than guess the DPI arithmetic and risk moving the canvas for everyone it currently suits, the
 *  user drags it into place against the dotted primary outline, like a console safe-area screen. */
function fullDisplayBounds() {
  const v = virtualDesktopBounds();
  const o = canvasOffset, z = canvasScale;
  // The window has to cover BOTH the whole desktop (so a widget can still be dragged to any
  // monitor) and wherever the scaled, nudged canvas content now reaches — hence the max/min pair
  // rather than a plain translate. At o=0,z=1 this is exactly virtualDesktopBounds().
  return {
    x: v.x + Math.min(0, o.x),
    y: v.y + Math.min(0, o.y),
    width: Math.round(Math.max(v.width, o.x + v.width * z) - Math.min(0, o.x)),
    height: Math.round(Math.max(v.height, o.y + v.height * z) - Math.min(0, o.y)),
  };
}
/** Where canvas coordinate 0,0 sits INSIDE the window, in client px.
 *  A negative nudge extends the window left/up and the content stays at 0; a positive nudge keeps
 *  the window origin and pushes the content in. Either way `windowOrigin + shift` lands on
 *  `virtualDesktopOrigin + offset`, which is the whole point. */
function canvasContentShift() {
  return { x: Math.max(0, canvasOffset.x), y: Math.max(0, canvasOffset.y) };
}
// Mirrors the sidecar's clamp (see canvasZoom in overlay-server.ts) — a hand-edited 0 would
// collapse the canvas to a dot with no visible control left to undo it.
function clampCanvasScale(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0.5, Math.min(3, Math.round(v * 100) / 100)) : 1;
}
// Re-fit every canvas window when the monitor layout changes (plugged/unplugged/rearranged) or
// the user nudges. 🔑 The PAGE has to be told as well: --prim-* and every widget's on-screen
// position are derived from overlay:canvas-info, which it fetches ONCE at load. Without this the
// window resized and the canvas inside it stayed laid out for the old monitor arrangement — which
// is what a Windows display-scaling change looks like from the user's side.

// Compatibility names used by the ArchVerse Linux interaction/window manager.
function detectedVirtualDesktopBounds() {
  if (process.platform === "linux") { const l = overlayWindows.detect(); return { ...l.desktop, source: l.source }; }
  return { ...virtualDesktopBounds(), source: "electron" };
}
function centeredDefaultZone() {
  if (process.platform === "linux") return overlayWindows.defaultZone();
  const p = primaryBounds(); return { x: p.x, y: p.y, width: p.width, height: p.height };
}
function refitCanvasWindows() {
  overlayWindows.refitAll({ refresh: true });
  try { if (bindingWin && !bindingWin.isDestroyed()) bindingWin.setBounds(primaryBounds()); } catch {}
  try {
    if (overlay && !overlay.isDestroyed()) {
      overlay.setBounds(fullDisplayBounds());
      overlay.webContents.send("overlay:canvas-changed");
    }
  } catch { /* ignore */ }
  reportGeometry();
}
// What the shell believes about the displays and where it actually put the window. Posted to the
// sidecar so it can be read back over HTTP and pasted from Copy diagnostics.
//
// 🔑 This exists because mixed-DPI is invisible from a machine whose monitors match, and every
// report of it ("it's offset", "the whole overlay vanished") is equally consistent with a window
// in the wrong PLACE and a canvas laid out at the wrong SCALE. `asked` vs `got` is the pair that
// separates them: if they differ, Windows moved or resized the window out from under us and no
// amount of canvas arithmetic will explain it.
// Logging it from here would go nowhere — this is a detached GUI process with no stdout.
function reportGeometry() {
  try {
    const v = virtualDesktopBounds();
    const asked = fullDisplayBounds();
    const prim = screen.getPrimaryDisplay();
    const shell = {
      displays: screen.getAllDisplays().map((d) => ({
        id: d.id, primary: d.id === prim.id, scaleFactor: d.scaleFactor, rotation: d.rotation,
        bounds: d.bounds, workArea: d.workArea, size: d.size,
      })),
      physicalDesktop: physicalDesktopBounds(),
      virtualDesktop: v,
      primary: prim.bounds,
      calibration: { x: canvasOffset.x, y: canvasOffset.y, scale: canvasScale, shift: canvasContentShift() },
      window: {
        asked,
        got: overlay && !overlay.isDestroyed() ? overlay.getBounds() : null,
        visible: overlay && !overlay.isDestroyed() ? overlay.isVisible() : null,
        enabled: overlayEnabled,
      },
    };
    void postJson("/api/overlay-geometry", { shell });
  } catch { /* diagnostics must never be the thing that breaks a refit */ }
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
  const bounds = fullDisplayBounds(); // spans all monitors
  overlayLoaded = false; // a fresh window has no listeners until its did-finish-load
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    icon: appIconPath(),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    type: process.platform === "linux" ? "toolbar" : undefined,
    // 🔑 `false` ON PURPOSE, and it is the only reason the overlay appears in Alt-Tab: that flag
    // hides a window from the taskbar, and Windows builds the Alt-Tab list from the same place.
    // Being switchable is the point — the overlay is click-through and Star Citizen recentres the
    // mouse while it has focus, so "Alt-Tab to the overlay" is how you take focus off the game and
    // use the widgets normally. `focusable: true` below was always set; only this was blocking it.
    skipTaskbar: process.platform === "linux",
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    focusable: true,
    // autoplayPolicy: the embedded Mining Assistant iframe plays alert tones / HAL voice via
    // Web Audio; allow it to sound without a prior user gesture (matches the old mining window).
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "preload.cjs"), autoplayPolicy: "no-user-gesture-required" },
  });
  if (process.platform === "linux") {
    overlayWindows.register("Overlay Manager", overlay);
    overlayWindows.pin(overlay);
    browserController?.destroy();
    browserController = new BrowserWidgetController({
      WebContentsView, session, logger: console,
      onInteractionClaim: (source) => claimFocusLatchedInteraction(`embedded-${source}`),
      onNativeMouse: (source, mouse, b) => noteNativeMouseInput(`embedded-${source}`, mouse, b),
      state: {
        browserVisible, chatVisible: twitchChatVisible, url: browserRuntimeState.url, channel: browserRuntimeState.channel,
        onState: (state) => {
          browserRuntimeState = { ...browserRuntimeState, ...state }; browserVisible = !!state.browserVisible;
          twitchChatVisible = !!state.chatVisible; writeBrowserState(state);
          try { overlay?.webContents.send("browser:state", state); } catch {}
          pushWidgetStates();
        },
      },
    });
    browserController.attach(overlay);
  }
  // Clear any cached copy + cache-bust the URL so UI changes always show up.
  const hudUrl = `${HUD_URL}?v=${Date.now()}${AMD_COMPAT ? "&lite=1" : ""}`;
  // 🔑 THE CANVAS MUST RETRY ITS OWN LOAD. This page is SERVED BY the sidecar, so any moment the
  // server isn't answering yet — a slow first start, a respawn, a machine under load — the load
  // fails and the window sits there transparent and EMPTY, forever. There is no error and nothing
  // to click: the user simply has no widgets. `waitForServer()` narrows the window but cannot
  // close it (it proves the server answered ONCE, not that this specific request will land), and
  // createOverlay also runs when waitForServer TIMED OUT, which is precisely when the load fails.
  //
  // The only reason this was survivable is that the overlay hotkey happens to DESTROY and RECREATE
  // the window, so mashing F3 eventually got a load in — which is exactly how Sub had been
  // working around it, and is not something a user could be expected to discover (2026-08-03).
  //
  // The Web Page widget has had a did-fail-load handler all along; the canvas, which matters far
  // more, had none and no .catch() on loadURL either.
  let hudTries = 0;
  const loadHud = () => {
    overlay?.loadURL(hudUrl).catch(() => scheduleHudRetry("loadURL rejected"));
  };
  const scheduleHudRetry = (why) => {
    if (!overlay || overlay.isDestroyed() || overlayLoaded) return;
    if (++hudTries > 20) {
      console.error(`[electron] canvas failed to load after ${hudTries} tries (${why}) — giving up`);
      return;
    }
    const wait = Math.min(3000, 250 * hudTries); // ramp to 3s; the sidecar's own respawn is slower
    console.error(`[electron] canvas load failed (${why}) — retry ${hudTries} in ${wait}ms`);
    setTimeout(loadHud, wait);
  };
  overlay.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    // -3 is ERR_ABORTED, which a superseding load fires on the one it replaced — retrying that
    // would fight the load that is already on its way.
    if (!isMainFrame || code === -3) return;
    scheduleHudRetry(`${desc} (${code})`);
  });
  overlay.webContents.session.clearCache().finally(loadHud);
  // Once the page is up, tell the renderer the mining widget's initial state: shown if the user
  // left it open last session, else armed-hidden if auto-show is on (so it can self-pop).
  overlay.webContents.on("did-finish-load", () => {
    try { overlay.setBounds(bounds); } catch { /* re-assert the full span past any creation-time clamp */ }
    // 🔑 `initial: true` marks this as REPLAYING saved state, not the user turning something on.
    // The renderer treats "turn this widget on" as "bring its tab to the front of its group" —
    // correct for a click, wrong here, because replaying nine widgets in order left whichever
    // member came last as the fronted tab and SAVED that over the user's choice. Without this
    // flag a stack can never remember which tab you were looking at.
    sendMiningVisible(miningVisible ? { on: true, initial: true } : { on: false, arm: miningArm, initial: true });
    sendNotepadVisible({ on: notepadVisible, initial: true });
    sendTwitchChatVisible({ on: twitchChatVisible, initial: true });
    sendScFeedVisible({ on: scFeedVisible, initial: true });
    sendUnlockAlertVisible({ on: unlockAlertVisible, initial: true });
    sendPartyVisible({ on: partyVisible, initial: true });
    sendBattagliaVisible({ on: battagliaVisible, initial: true });
    sendChatVisible({ on: chatVisible, initial: true });
    sendConfigWidgetVisible({ on: configWidgetVisible, initial: true });
    sendWebViewVisible({ on: webViewVisible, initial: true });
    sendBindingChartVisible({ on: bindingChartVisible, initial: true });
    sendBrowserVisible?.();
    pushWidgetStates();
    if (process.platform === "linux") {
      overlayWindows.showCanvasWindow("Overlay Manager", overlay, { inactive: true });
      reapplyOverlayInputShape();
      for (const delay of [0, 100, 500, 1500]) setTimeout(() => { void requestOverlayRegionSnapshot(`did-finish-load+${delay}ms`); }, delay);
      try { overlay.moveTop(); } catch {}
    }
    overlayLoaded = true;
    // Re-push, because a sidecar that died BEFORE this page existed would otherwise have shouted
    // into a window with no listener — and the banner would never appear at all.
    if (sidecarState.down) announceSidecar(sidecarState);
    flushSetupNudge();
  });
  overlay.webContents.on("before-mouse-event", (_event, mouse) => {
    noteNativeMouseInput("overlay", mouse);
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

  // Preserve upstream focus notification for the renderer while Linux keeps its richer handoff.
  overlay.on("focus", () => { try { overlay?.webContents.send("overlay:window-focus", true); } catch {} });
  overlay.on("blur", () => { try { overlay?.webContents.send("overlay:window-focus", false); } catch {} });
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
    releaseForwardedMouseButtons("overlay closed");
    overlayLoaded = false;
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

function overlayRegionAtPoint(globalPoint) {
  if (!globalPoint || !overlayRegions.length) return null;
  const canvas = fullDisplayBounds();
  const x = Number(globalPoint.x) - canvas.x;
  const y = Number(globalPoint.y) - canvas.y;
  const matches = overlayRegions.filter((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const priority = Number(b.priority || 0) - Number(a.priority || 0);
    if (priority) return priority;
    return (a.w * a.h) - (b.w * b.h);
  });
  return matches[0];
}

const INTERACTION_MOUSE_BUTTONS = Object.freeze({ 1: "left", 2: "right", 3: "middle" });

function mouseInputModifiers(event) {
  const modifiers = [];
  if (event?.altKey) modifiers.push("alt");
  if (event?.ctrlKey) modifiers.push("control");
  if (event?.metaKey) modifiers.push("meta");
  if (event?.shiftKey) modifiers.push("shift");
  return modifiers;
}

function canvasPointFromGlobal(globalPoint) {
  if (!globalPoint) return null;
  const canvas = fullDisplayBounds();
  const x = Number(globalPoint.x) - canvas.x;
  const y = Number(globalPoint.y) - canvas.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function interactionMouseDestination(canvasPoint) {
  if (!canvasPoint || !overlay || overlay.isDestroyed()) return null;
  const inside = (bounds) => bounds
    && canvasPoint.x >= bounds.x && canvasPoint.y >= bounds.y
    && canvasPoint.x < bounds.x + bounds.width && canvasPoint.y < bounds.y + bounds.height;
  if (webViewPainted && webView?.webContents && inside(webViewBounds)) {
    return { name: "web-page", webContents: webView.webContents, bounds: webViewBounds };
  }
  const embedded = browserController?.mouseDestinationAt?.(canvasPoint);
  if (embedded) return embedded;
  return {
    name: "overlay",
    webContents: overlay.webContents,
    bounds: { x: 0, y: 0, width: fullDisplayBounds().width, height: fullDisplayBounds().height },
  };
}

function dispatchInteractionMouse(destination, type, canvasPoint, button, event = {}) {
  if (!destination?.webContents || destination.webContents.isDestroyed?.()) return false;
  const bounds = destination.bounds || { x: 0, y: 0 };
  const x = Math.round(canvasPoint.x - Number(bounds.x || 0));
  const y = Math.round(canvasPoint.y - Number(bounds.y || 0));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const canvas = fullDisplayBounds();
  const input = {
    type,
    x,
    y,
    globalX: Math.round(canvasPoint.x + canvas.x),
    globalY: Math.round(canvasPoint.y + canvas.y),
    modifiers: mouseInputModifiers(event),
  };
  if (button) input.button = button;
  if (type === "mouseDown" || type === "mouseUp") {
    input.clickCount = Math.max(1, Math.round(Number(event?.clicks) || 1));
  }
  try {
    destination.webContents.sendInputEvent(input);
    return true;
  } catch (error) {
    console.warn(`[f-click] ${type} injection failed for ${destination.name}: ${String(error)}`);
    return false;
  }
}

function noteNativeMouseInput(source, mouse, bounds = { x: 0, y: 0 }) {
  if (mouse?.type !== "mouseDown" && mouse?.type !== "mouseUp") return;
  const button = String(mouse.button || "");
  const x = Number(bounds.x || 0) + Number(mouse.x);
  const y = Number(bounds.y || 0) + Number(mouse.y);
  if (!button || !Number.isFinite(x) || !Number.isFinite(y)) return;
  lastNativeMouseInput = { type: mouse.type, button, x, y, source, at: Date.now() };
}

function nativeMouseReachedTarget(type, button, canvasPoint, since) {
  const native = lastNativeMouseInput;
  if (!native || native.type !== type || native.button !== button || native.at < since - 40) return null;
  if (Math.hypot(native.x - canvasPoint.x, native.y - canvasPoint.y) > 8) return null;
  return native;
}

function globalPointForMouseEvent(event) {
  const eventPoint = { x: Number(event?.x), y: Number(event?.y) };
  if (Number.isFinite(eventPoint.x) && Number.isFinite(eventPoint.y)
      && (fHoverPointerPhase === "host" || !lastGlobalPointer)) return eventPoint;
  return lastGlobalPointer ? { ...lastGlobalPointer } : null;
}

function scheduleForwardedMouseButton(phase, event) {
  if (process.platform !== "linux") return;
  if (!overlayInteractionLatched && !(fHoverHeld && fHoverOverWidget)) return;
  const button = INTERACTION_MOUSE_BUTTONS[Number(event?.button)];
  if (!button) return;
  const globalPoint = globalPointForMouseEvent(event);
  const canvasPoint = canvasPointFromGlobal(globalPoint);
  if (!canvasPoint) return;
  const region = overlayRegionAtPoint(globalPoint);
  const existing = forwardedMouseButtons.get(button);
  if (phase === "down" && !region) {
    console.log(`[f-click] ${button} down ignored outside a classified widget at ${Math.round(globalPoint.x)},${Math.round(globalPoint.y)}`);
    return;
  }
  const destination = phase === "up" && existing?.destination
    ? existing.destination
    : interactionMouseDestination(canvasPoint);
  if (!destination) return;
  const type = phase === "down" ? "mouseDown" : "mouseUp";
  const startedAt = Date.now();
  const state = existing || { button, destination, canvasPoint, region, syntheticDown: false };
  state.canvasPoint = canvasPoint;
  state.region = region || state.region;
  if (phase === "down") forwardedMouseButtons.set(button, state);

  const token = { timer: null };
  token.timer = setTimeout(() => {
    pendingMouseFallbacks.delete(token);
    const native = nativeMouseReachedTarget(type, button, canvasPoint, startedAt);
    if (native) {
      console.log(`[f-click] ${button} ${phase} reached ${native.source} natively at ${Math.round(canvasPoint.x)},${Math.round(canvasPoint.y)}`);
      if (phase === "up") forwardedMouseButtons.delete(button);
      return;
    }
    if (phase === "down") dispatchInteractionMouse(destination, "mouseMove", canvasPoint, null, event);
    const sent = dispatchInteractionMouse(destination, type, canvasPoint, button, event);
    if (phase === "down" && sent) state.syntheticDown = true;
    if (phase === "up") forwardedMouseButtons.delete(button);
    const title = state.region?.title || state.region?.key || destination.name;
    console.log(`[f-click] ${button} ${phase} ${sent ? "forwarded" : "failed"} to ${title}` +
      ` at ${Math.round(canvasPoint.x)},${Math.round(canvasPoint.y)} (${destination.name})`);
  }, F_CLICK_NATIVE_GRACE_MS);
  pendingMouseFallbacks.add(token);
}

function scheduleForwardedMouseMove(event) {
  if (syntheticMouseMoveScheduled || process.platform !== "linux") return;
  if (!overlayInteractionLatched && !(fHoverHeld && fHoverOverWidget)) return;
  syntheticMouseMoveScheduled = true;
  setImmediate(() => {
    syntheticMouseMoveScheduled = false;
    if (!overlayInteractionLatched && !(fHoverHeld && fHoverOverWidget)) return;
    const canvasPoint = canvasPointFromGlobal(globalPointForMouseEvent(event));
    if (!canvasPoint) return;
    const pressed = forwardedMouseButtons.values().next().value;
    const destination = pressed?.destination || interactionMouseDestination(canvasPoint);
    if (destination) dispatchInteractionMouse(destination, "mouseMove", canvasPoint, pressed?.button || null, event);
  });
}

function releaseForwardedMouseButtons(reason = "interaction ended") {
  for (const token of pendingMouseFallbacks) clearTimeout(token.timer);
  pendingMouseFallbacks.clear();
  for (const state of forwardedMouseButtons.values()) {
    if (state.syntheticDown) {
      dispatchInteractionMouse(state.destination, "mouseUp", state.canvasPoint, state.button, { clicks: 1 });
    }
  }
  if (forwardedMouseButtons.size) console.log(`[f-click] cleared ${forwardedMouseButtons.size} pressed button(s): ${reason}`);
  forwardedMouseButtons.clear();
}

function sameFHoverTarget(a, b) {
  if (!a || !b) return false;
  const aKey = String(a.key || a.id || "widget");
  const bKey = String(b.key || b.id || "widget");
  return aKey === bKey;
}

function resetFHoverHostHandoff() {
  fHoverHandoffAnchor = null;
  fHoverHandoffWaitLogged = false;
  fHoverHandoffSeq += 1;
}

function acceptFHoverHostPoint(point, source = "host") {
  if (fHoverPointerPhase !== "handoff" || !fHoverHandoffAnchor || !point) return false;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const dx = x - Number(fHoverHandoffAnchor.x);
  const dy = y - Number(fHoverHandoffAnchor.y);
  const closeToAnchor = Math.hypot(dx, dy) <= F_HOVER_HANDOFF_TOLERANCE_PX;
  const candidateTarget = overlayRegionAtPoint({ x, y });
  if (!closeToAnchor && !sameFHoverTarget(candidateTarget, fHoverTarget)) return false;

  lastGlobalPointer = { x, y };
  lastGlobalPointerSource = source;
  fHoverPointerPhase = "host";
  fHoverHostHookAuthoritative = source.startsWith("uiohook");
  fHoverMissStartedAt = 0;
  resetFHoverHostHandoff();
  console.log(`[f-hover] host pointer handoff verified at ${x},${y} via ${source}`);
  return true;
}

function sampleFHoverHostHandoff({ warp = false, reason = "poll" } = {}) {
  if (process.platform !== "linux" || fHoverPointerPhase !== "handoff" || !fHoverHandoffAnchor) return false;
  const anchor = { ...fHoverHandoffAnchor };
  const moved = !warp || !!overlayWindows.moveHostPointer?.(anchor);
  const point = overlayWindows.pointerLocation?.() || null;
  if (point && acceptFHoverHostPoint(point, warp ? "xdotool-post-focus" : "xdotool-host")) return true;
  if (warp && !fHoverHandoffWaitLogged) {
    fHoverHandoffWaitLogged = true;
    const actual = point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
      ? `${Number(point.x)},${Number(point.y)}`
      : "unavailable";
    console.log(`[f-hover] host pointer handoff pending; requested ${anchor.x},${anchor.y}, host=${actual}, warp=${moved ? "accepted" : "failed"} (${reason})`);
  }
  return false;
}

function beginFHoverHostHandoff(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  fHoverPointerPhase = "handoff";
  fHoverHostHookAuthoritative = false;
  fHoverHandoffAnchor = { x, y };
  fHoverHandoffWaitLogged = false;
  const seq = ++fHoverHandoffSeq;
  console.log(`[f-hover] host pointer handoff armed at ${x},${y}; waiting for overlay focus`);
  for (const delay of F_HOVER_HANDOFF_DELAYS_MS) {
    setTimeout(() => {
      if (seq !== fHoverHandoffSeq || fHoverPointerPhase !== "handoff") return;
      sampleFHoverHostHandoff({ warp: true, reason: `post-focus+${delay}ms` });
    }, delay);
  }
  return true;
}

function requestOverlayRegionSnapshot(reason = "shell") {
  if (!overlay || overlay.isDestroyed() || overlay.webContents.isLoadingMainFrame()) return Promise.resolve(false);
  const why = JSON.stringify(String(reason));
  return overlay.webContents.executeJavaScript(
    `(() => { try { return window.__overlayReportRegions?.(true, ${why}) ?? false; } catch { return false; } })()`,
    true,
  ).then(() => true).catch((error) => {
    console.warn(`[f-hover] classified region snapshot request failed (${reason}): ${String(error)}`);
    return false;
  });
}

async function probeFHoverPointDirect(localPoint, seq) {
  if (fHoverDirectProbeInFlight || !fHoverHeld || !overlay || overlay.isDestroyed()) return;
  if (!localPoint || !Number.isFinite(localPoint.x) || !Number.isFinite(localPoint.y)) return;
  fHoverDirectProbeInFlight = true;
  try {
    const x = JSON.stringify(Number(localPoint.x));
    const y = JSON.stringify(Number(localPoint.y));
    const result = await overlay.webContents.executeJavaScript(
      `(() => { try { return window.__overlayClassifyPoint?.(${x}, ${y}) || { hit:false, classification:"renderer-not-ready" }; } catch { return { hit:false, classification:"renderer-error" }; } })()`,
      true,
    );
    if (!fHoverHeld || seq < fHoverLastClassifiedSeq) return;
    fHoverLastClassifiedSeq = seq;
    fHoverLastClassificationAt = Date.now();
    applyFHoverClassification(result?.hit === true, result, "direct-classified-region");
  } catch (error) {
    console.warn(`[f-hover] direct renderer classification failed: ${String(error)}`);
    updateFHoverHitFromRegions();
  } finally {
    fHoverDirectProbeInFlight = false;
  }
}
function applyFHoverClassification(next, target = null, source = "regions") {
  next = !!(fHoverHeld && !fHoverSuppressedUntilRelease && next);
  // The nested Gamescope point is authoritative until the host pointer has been verified after
  // focus. A stale host/uIOhook sample must not revoke the widget that F just entered.
  if (!next && fHoverOverWidget && fHoverPointerPhase === "handoff") return;
  if (!next && fHoverOverWidget) {
    const now = Date.now();
    if (!fHoverMissStartedAt) fHoverMissStartedAt = now;
    if (now - fHoverMissStartedAt < F_HOVER_LEAVE_GRACE_MS) return;
  } else if (next) {
    fHoverMissStartedAt = 0;
  }
  const nextKey = next ? String(target?.key || target?.id || "widget") : "";
  const prevKey = fHoverOverWidget ? String(fHoverTarget?.key || fHoverTarget?.id || "widget") : "";
  if (next === fHoverOverWidget && nextKey === prevKey) return;

  const wasOverWidget = fHoverOverWidget;
  fHoverOverWidget = next;
  fHoverTarget = next ? target : null;
  momentaryInteractionActive = next;
  overlayInteractionLatched = false;
  overlayInteractionClaimSource = "";
  locked = !next;
  applyMouse();
  reapplyOverlayInputShape();

  if (next) {
    // All visible overlay tools are DOM classifications inside one native Overlay Manager.
    // Focus only after the renderer confirms the pointer is inside #panel, .widget, or active
    // overlay chrome. This avoids guessing from stale geometry and keeps empty canvas harmless.
    if (process.platform === "linux" && fHoverPointerPhase !== "host") {
      // KDE Wayland can acknowledge an XWarpPointer request while Gamescope still owns focus but
      // leave the compositor cursor unchanged. Focus first, then retry and verify the host point
      // before allowing host/uIOhook coordinates to replace the nested Gamescope anchor.
      if (lastGlobalPointerSource === "gamescope-display") beginFHoverHostHandoff(lastGlobalPointer);
      else {
        fHoverPointerPhase = "host";
        resetFHoverHostHandoff();
      }
      fHoverLinuxPointerSampleAt = 0;
    }
    focusLinuxInteractiveWindow("overlay");
    const classification = target?.classification || "reported-region";
    const title = target?.title || nextKey;
    console.log(`[f-hover] entered ${classification} key=${nextKey} title=${title}; overlay focused (${source})`);
  } else {
    console.log(`[f-hover] left overlay widget classification; click-through restored (${source})`);
    if (wasOverWidget && !moveMode && !modalOpen && !notepadEditing && !dragging) {
      setTimeout(restoreLinuxPreviousWindow, 30);
    }
  }
  try {
    overlay?.webContents.send("overlay:f-hover", {
      held: fHoverHeld, overWidget: fHoverOverWidget, latched: false,
      key: nextKey || null, classification: target?.classification || null,
    });
  } catch {}
}

function updateFHoverHitFromRegions() {
  // Renderer DOM classification is authoritative. Geometry is retained only as a startup/failure
  // fallback when the renderer has not answered a point probe recently.
  if (Date.now() - fHoverLastClassificationAt < 250) return;
  const target = overlayRegionAtPoint(lastGlobalPointer);
  applyFHoverClassification(!!target, target, "classified-region-fallback");
}
function scheduleFHoverMotionProbe() {
  if (fHoverMotionProbeScheduled || !fHoverHeld || overlayInteractionLatched || fHoverPointerPhase !== "host") return;
  fHoverMotionProbeScheduled = true;
  setImmediate(() => {
    fHoverMotionProbeScheduled = false;
    if (!fHoverHeld || overlayInteractionLatched || fHoverPointerPhase !== "host") return;
    if (lastGlobalPointer && overlay && !overlay.isDestroyed()) {
      const canvas = fullDisplayBounds();
      const seq = ++fHoverProbeSeq;
      void probeFHoverPointDirect({
        x: Number(lastGlobalPointer.x) - canvas.x,
        y: Number(lastGlobalPointer.y) - canvas.y,
      }, seq);
    }
    updateFHoverHitFromRegions();
  });
}
function stopFHoverPolling() {
  if (fHoverPollTimer) clearInterval(fHoverPollTimer);
  fHoverPollTimer = null;
}

function refreshFHoverPointer({ preferLinux = false, preferHost = false, reason = "" } = {}) {
  let point = null;
  let source = "";

  // Gamescope owns a nested XWayland cursor while Star Citizen has focus. The host X root and
  // uIOhook pointer can remain frozen at the last Shift+F6 position, producing the two-cursor
  // symptom seen in Alpha 7. Query Star Citizen's own DISPLAY first, map that coordinate onto
  // the host overlay canvas, and retain only a fresh uIOhook sample as the desktop fallback.
  if (process.platform === "linux" && preferHost) {
    // After the overlay receives focus, use the host X root in the same physical-pixel space as
    // the 6360x2160 canvas. Electron screen coordinates can be scaled or rotated differently on
    // mixed-orientation KDE desktops and caused Alpha 8's enter/leave oscillation.
    // Once the compositor hook produces a verified post-focus motion event, keep that stream
    // authoritative even while the mouse is idle. KDE XWayland's root pointer can freeze or jump
    // back to the warp anchor after motion stops, which made Alpha 10 repeatedly drop the latch.
    if (fHoverHostHookAuthoritative && fHoverHookPointer) {
      point = { ...fHoverHookPointer };
      source = "uiohook-host-pinned";
    } else {
      point = overlayWindows.pointerLocation?.() || null;
      if (point) {
        source = "xdotool-host";
      } else if (fHoverHookPointer) {
        point = { ...fHoverHookPointer };
        source = "uiohook-host";
      }
    }
  } else if (process.platform === "linux" && preferLinux) {
    point = overlayWindows.gamescopePointerLocation?.() || null;
    if (point) {
      source = "gamescope-display";
    } else if (fHoverHookPointer && Date.now() - fHoverHookPointerSampleAt <= 250) {
      point = { ...fHoverHookPointer };
      source = "uiohook-global";
    } else {
      point = overlayWindows.pointerLocation?.() || null;
      if (point) source = "xdotool-root";
    }
  }

  if (!point) {
    try {
      const p = screen.getCursorScreenPoint();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        point = { x: p.x, y: p.y };
        source = "electron-screen";
      }
    } catch {}
  }

  if (!point && process.platform === "linux") {
    point = overlayWindows.pointerLocation?.() || null;
    if (point) source = "xdotool-fallback";
  }

  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    lastGlobalPointer = { x: Number(point.x), y: Number(point.y) };
    lastGlobalPointerSource = source || "unknown";
    const sampleAge = source === "uiohook-global" && fHoverHookPointerSampleAt
      ? ` age=${Math.max(0, Date.now() - fHoverHookPointerSampleAt)}ms`
      : "";
    if (reason) console.log(`[f-hover] pointer ${lastGlobalPointer.x},${lastGlobalPointer.y} via ${source || "unknown"}${sampleAge} (${reason})`);
    return true;
  }
  if (reason) console.warn(`[f-hover] pointer location unavailable (${reason})`);
  return false;
}
function startFHoverPolling() {
  stopFHoverPolling();
  const tick = () => {
    if (!fHoverHeld && !overlayInteractionLatched) return;
    const now = Date.now();
    const needsGamePointer = process.platform === "linux"
      && fHoverHeld
      && fHoverPointerPhase === "game";
    if (needsGamePointer) {
      // Keep sampling the compositor/root pointer until the very first widget hit. Throttle the
      // external xdotool query so an accidentally held F key cannot flood the Electron main loop.
      if (now - fHoverLinuxPointerSampleAt >= 100) {
        fHoverLinuxPointerSampleAt = now;
        refreshFHoverPointer({ preferLinux: true });
      }
    } else if (process.platform === "linux" && fHoverPointerPhase === "handoff") {
      // Keep classifying against the initial Gamescope anchor while polling for a verified host
      // point. This prevents the stale host cursor from tearing down the session during focus.
      if (now - fHoverLinuxPointerSampleAt >= F_HOVER_HOST_SAMPLE_MS) {
        fHoverLinuxPointerSampleAt = now;
        sampleFHoverHostHandoff();
      }
    } else if (process.platform === "linux") {
      // uIOhook handles normal pointer motion. This slower query is only a safety net for KDE /
      // Gamescope handoff and environments where the compositor hook temporarily goes quiet.
      if (now - fHoverLinuxPointerSampleAt >= F_HOVER_HOST_SAMPLE_MS) {
        fHoverLinuxPointerSampleAt = now;
        refreshFHoverPointer({ preferHost: true });
      }
    } else {
      refreshFHoverPointer();
    }

    if (overlayInteractionLatched) {
      const target = overlayRegionAtPoint(lastGlobalPointer);
      if (target) {
        fHoverMissStartedAt = 0;
        fHoverTarget = target;
        fHoverOverWidget = true;
        return;
      }
      // A host-coordinate miss cannot distinguish a real departure from KDE/Gamescope pointer
      // desynchronization. Once F has established widget ownership, coordinate misses never
      // revoke it. Escape or an actual native focus transfer/click outside the shaped widget
      // regions ends the session through the explicit release paths below.
      return;
    }

    if (lastGlobalPointer && overlay && !overlay.isDestroyed()) {
      const canvas = fullDisplayBounds();
      const seq = ++fHoverProbeSeq;
      void probeFHoverPointDirect({
        x: Number(lastGlobalPointer.x) - canvas.x,
        y: Number(lastGlobalPointer.y) - canvas.y,
      }, seq);
    }
    updateFHoverHitFromRegions();
  };
  tick();
  fHoverPollTimer = setInterval(tick, F_HOVER_FALLBACK_POLL_MS);
}
function applyMouse() {
  if (!overlay) return;
  const interactive = LINUX_HARD_CLICK_THROUGH
    ? unifiedInteractionActive || interactiveTarget !== null || dragging || moveMode || modalOpen || notepadEditing || overlayInteractionLatched || (fHoverHeld && fHoverOverWidget)
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
    await fetch(`http://localhost:${PORT}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { /* sidecar not up yet — non-fatal */ }
}
async function postConfig(patch) { return postJson("/api/config", patch); }

// ── Mining Assistant widget (in-canvas) ───────────────────────────────────────
// The Mining Assistant is now an iframe widget INSIDE the overlay canvas (see missions.html +
// mining.html?embedded=1), not its own window. The shell owns its VISIBILITY and drives it into
// the overlay renderer; the renderer shows/hides the widget and owns its layout, drag, and
// cursor hit-testing. setMiningVisible is the single mutator (keeps config + tray + hub in sync).
function sendMiningVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:mining-visible", state); }
  catch { /* renderer gone */ }
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
// Push widget on/off state to the in-overlay hub checkboxes (kept in sync with the tray).
function pushWidgetStates() {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:widget-states", { mining: miningVisible, notepad: notepadVisible, twitchChat: twitchChatVisible, scFeed: scFeedVisible, unlockAlert: unlockAlertVisible, party: partyVisible, battaglia: battagliaVisible, chat: chatVisible, webView: webViewVisible, bindingChart: bindingChartVisible, config: configWidgetVisible }); }
  catch { /* renderer gone */ }
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
// SC Feed news notifier — same shell-owned flag. "Visible" here means ARMED: the widget mounts
// and polls, but only paints when there's a new story (then fades itself out again).
function sendScFeedVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:scfeed-visible", state); }
  catch { /* renderer gone */ }
}
function setScFeedVisible(on) {
  scFeedVisible = !!on;
  sendScFeedVisible({ on: scFeedVisible });
  postConfig({ scFeedOpen: scFeedVisible }); // remember on/off for next launch
  pushWidgetStates();
  refreshTray();
}
function toggleScFeed() { setScFeedVisible(!scFeedVisible); }
// Blueprint-unlock notifier — armed like SC Feed: mounted and listening, but it only paints
// when a blueprint actually drops.
function sendUnlockAlertVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:unlockalert-visible", state); }
  catch { /* renderer gone */ }
}
function setUnlockAlertVisible(on) {
  unlockAlertVisible = !!on;
  sendUnlockAlertVisible({ on: unlockAlertVisible });
  postConfig({ unlockAlertOpen: unlockAlertVisible });
  pushWidgetStates();
  refreshTray();
}
function toggleUnlockAlert() { setUnlockAlertVisible(!unlockAlertVisible); }
// Party split widget — plain in-canvas iframe, same shell-owned visibility as the Notepad.
function sendPartyVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:party-visible", state); }
  catch { /* renderer gone */ }
}
function setPartyVisible(on) {
  partyVisible = !!on;
  sendPartyVisible({ on: partyVisible });
  postConfig({ partyOpen: partyVisible }); // remember open/closed for next launch
  pushWidgetStates();
  refreshTray();
}
function toggleParty() { setPartyVisible(!partyVisible); }
// Social Chat widget — plain in-canvas iframe, same shell-owned visibility as the Notepad.
// chatOpen doubles as the SIDECAR's connection gate: closed widget = no chat socket at all,
// so this postConfig is also what connects/disconnects chat (see chatConfigure, overlay-server).
function sendChatVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:chat-visible", state); }
  catch { /* renderer gone */ }
}
function setChatVisible(on) {
  chatVisible = !!on;
  sendChatVisible({ on: chatVisible });
  postConfig({ chatOpen: chatVisible }); // remember open/closed for next launch + gate the socket
  pushWidgetStates();
  refreshTray();
}
function toggleChat() { setChatVisible(!chatVisible); }
// Battaglia grind tracker - same shell-owned visibility as the widgets above. Retires when the
// giver does (4.10): drop this block, its config flag, and overlay/battaglia.html.
function sendBattagliaVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:battaglia-visible", state); }
  catch { /* renderer gone */ }
}
function setBattagliaVisible(on) {
  battagliaVisible = !!on;
  sendBattagliaVisible({ on: battagliaVisible });
  postConfig({ battagliaOpen: battagliaVisible }); // remember open/closed for next launch
  pushWidgetStates();
  refreshTray();
}
function toggleBattaglia() { setBattagliaVisible(!battagliaVisible); }

// Settings as a canvas widget — same shell-owned visibility contract as every widget above.
// The standalone settings WINDOW (openConfig) stays: the first-run wizard deep-links into it and
// must still work when the canvas is switched off or broken, which is exactly when someone needs
// to reach the AMD-compatibility and master-overlay switches.
function sendConfigWidgetVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:config-visible", state); }
  catch { /* window went away mid-send */ }
}
function setConfigWidgetVisible(on) {
  configWidgetVisible = !!on;
  sendConfigWidgetVisible({ on: configWidgetVisible });
  // Deliberately NOT persisted: Settings always starts closed. Its frame (position/size) is
  // remembered by widgets.json like every widget; only the open state is not.
  refreshTray();
}
/** THE way to open Settings, from the cog and the tray alike. Settings is not a widget you
 *  toggle in the widget list — it is a panel you open, which happens to be rendered as a widget
 *  so it can be placed, sized and skinned like everything else.
 *  🔑 The standalone WINDOW survives only as the fallback for a canvas that isn't there: with
 *  the overlay switched off or destroyed the widget cannot appear at all, and that is precisely
 *  when someone needs to reach the AMD-compatibility and master-overlay switches. Never the
 *  primary route, never a second thing to discover. */
function openSettingsSurface() {
  if (overlayEnabled && overlay && !overlay.isDestroyed()) setConfigWidgetVisible(true);
  else openConfig();
}
// Web Page widget - any http(s) page the user pins to the canvas.
function sendWebViewVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:webview-visible", state); }
  catch { /* renderer gone */ }
}
function setWebViewVisible(on) {
  webViewVisible = !!on;
  sendWebViewVisible({ on: webViewVisible });
  postConfig({ webViewOpen: webViewVisible });
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

// Live-rebindable hotkey for the Journal widget. It was the one placeable widget with no way to
// reach it without the tray or the hub — Argante asked for this, and a scratchpad you have to
// alt-tab to open is a scratchpad you don't use mid-flight.
let notepadAccel = null;
function registerNotepadHotkey(accel) {
  if (notepadAccel) hotkeys.unregister(notepadAccel);
  notepadAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleNotepad);
  if (r.ok) notepadAccel = accel;
  return r;
}

// Live-rebindable hotkey for showing/hiding the Mining Assistant widget. Same shape as the
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
let interactAccel = null;
let evdevInteractController = null;
let stopPointerWatch = null;

function endFocusLatchedInteraction(reason = "external focus", { suppressHeldKey = true } = {}) {
  if (!overlayInteractionLatched && !momentaryInteractionActive) return;

  overlayInteractionLatched = false;
  overlayInteractionClaimSource = "";
  momentaryInteractionActive = false;
  fHoverOverWidget = false;
  fHoverTarget = null;
  fHoverPointerPhase = "game";
  fHoverHostHookAuthoritative = false;
  fHoverMissStartedAt = 0;
  resetFHoverHostHandoff();
  stopFHoverPolling();
  releaseForwardedMouseButtons(reason);
  browserController?.setInteractionKeyHeld(false);
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
    console.log(`[focus-latch] ${reason} ignored while ${interactAccel || "F"} is held`);
    return;
  }
  const hadInteraction = overlayInteractionLatched || momentaryInteractionActive;
  endFocusLatchedInteraction(reason, { suppressHeldKey: true });
  if (hadInteraction) setTimeout(restoreLinuxPreviousWindow, 30);
}

function claimFocusLatchedInteraction(source = "widget") {
  // The Linux F path establishes its own widget-shaped latch on key release. Renderer click
  // claims remain disabled there so they cannot widen ownership to the transparent canvas.
  if (process.platform === "linux" && fHoverEnabled) return;
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
  if (stopMouseButtonWatch) { stopMouseButtonWatch(); stopMouseButtonWatch = null; }
  releaseForwardedMouseButtons("interaction hotkey rebound");
  stopFHoverPolling();
  if (evdevInteractController) { try { evdevInteractController.stop(); } catch {} evdevInteractController = null; }
  if (!accel || typeof accel !== "string") return { ok: true };

  // Keep a focus-independent pointer sample warm before F is pressed. Alpha 6 queried xdotool
  // at key-down; that fixed Electron's stale pre-focus point but still made the first hit depend
  // on a just-in-time subprocess. The already-running uIOhook backend can provide the point as
  // the mouse moves over Star Citizen without ever focusing or unlocking the overlay.
  if (process.platform === "linux" && typeof hotkeys.onMouseMove === "function") {
    stopPointerWatch = hotkeys.onMouseMove((event) => {
      const x = Number(event?.x);
      const y = Number(event?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      fHoverHookPointer = { x, y };
      fHoverHookPointerSampleAt = Date.now();
      if (fHoverPointerPhase === "handoff") {
        // Cache every hook point, but promote it only when it reaches the original widget. The
        // first post-focus uIOhook event commonly contains the stale pre-Gamescope host point.
        acceptFHoverHostPoint({ x, y }, "uiohook-host");
        return;
      }
      if (fHoverPointerPhase === "host" && !fHoverHostHookAuthoritative) {
        fHoverHostHookAuthoritative = true;
        console.log("[f-hover] compositor mouse stream pinned for idle-safe widget interaction");
      }
      lastGlobalPointer = { x, y };
      lastGlobalPointerSource = "uiohook-global";
      if (overlayInteractionLatched) {
        // Once ownership is latched, drive Chromium from the same compositor-global stream that
        // classified the F entry point. KDE/Gamescope can otherwise draw one pointer while native
        // XWayland button events arrive at another coordinate.
        scheduleForwardedMouseMove(event);
        return;
      }
      scheduleFHoverMotionProbe();
    });
  }
  if (process.platform === "linux" && typeof hotkeys.onMouseButton === "function") {
    stopMouseButtonWatch = hotkeys.onMouseButton((phase, event) => {
      scheduleForwardedMouseButton(phase, event);
    });
  }

  const onDown = (source = "uiohook") => {
    // Once a widget session is latched, F belongs to the focused widget (chat, web forms, etc.)
    // instead of acting as another global toggle. Escape or an external click/focus transfer
    // ends the session; coordinate misses alone never do.
    if (overlayInteractionLatched || notepadEditing || !fHoverEnabled || unifiedInteractionActive || fHoverSuppressedUntilRelease || fHoverHeld) return;
    console.log(`[f-hover] ${accel} key-down received via ${source}`);
    fHoverHeld = true;
    browserController?.setInteractionKeyHeld(true);
    if (!overlayEnabled) setOverlayEnabled(true);
    if (!overlay) createOverlay();
    if (!overlay || overlay.isDestroyed()) return;

    // Capture the current owner, but do not focus or unlock the full transparent canvas. The
    // pointer poll below grants input only after it enters a visible widget rectangle.
    captureLinuxActiveWindow();
    momentaryInteractionActive = false;
    overlayInteractionLatched = false;
    overlayInteractionClaimSource = "";
    fHoverOverWidget = false;
    fHoverTarget = null;
    fHoverPointerPhase = "game";
    fHoverHostHookAuthoritative = false;
    fHoverMissStartedAt = 0;
    resetFHoverHostHandoff();
    fHoverProbeSeq = 0;
    fHoverLastClassifiedSeq = 0;
    fHoverLastClassificationAt = 0;
    fHoverLinuxPointerSampleAt = 0;
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

    // Prime from the cursor owned by Star Citizen's nested Gamescope/XWayland display before any
    // focus transition. Fresh uIOhook and host-root coordinates remain fallbacks outside Gamescope.
    refreshFHoverPointer({ preferLinux: true, reason: "F-down pre-focus" });
    updateFHoverHitFromRegions();
    void requestOverlayRegionSnapshot("F-down").then(() => {
      if (!fHoverHeld) return;
      refreshFHoverPointer({ preferLinux: true, reason: "F-down region refresh" });
      updateFHoverHitFromRegions();
    });
    startFHoverPolling();
    refreshTray();
    console.log(`[f-hover] ${accel} held; waiting for pointer to enter a widget`);
  };

  const onUp = (source = "uiohook") => {
    if (overlayInteractionLatched && !fHoverHeld) return; // duplicate uIOhook/evdev release
    if (!fHoverHeld && !momentaryInteractionActive && !fHoverOverWidget && !fHoverSuppressedUntilRelease) return;
    const hadWidgetFocus = fHoverOverWidget || momentaryInteractionActive;
    fHoverHeld = false;
    browserController?.setInteractionKeyHeld(false);
    fHoverSuppressedUntilRelease = false;
    momentaryInteractionActive = false;
    fHoverLastClassificationAt = 0;

    if (hadWidgetFocus && fHoverTarget) {
      // F is an entry gate, not a key that must remain held. Keep only the classified widget
      // interaction session alive so Twitch chat, Journal, Web Page forms, and other text inputs
      // continue receiving keyboard input after F is released.
      overlayInteractionLatched = true;
      overlayInteractionClaimSource = `F over ${fHoverTarget.key || "widget"}`;
      fHoverOverWidget = true;
      interactiveTarget = null;
      locked = false;
      applyMouse();
      reapplyOverlayInputShape();
      try {
        overlay?.webContents.send("overlay:f-hover", {
          held: false, overWidget: true, latched: true,
          key: fHoverTarget.key || null, classification: fHoverTarget.classification || null,
        });
      } catch {}
      stopFHoverPolling();
      refreshTray();
      console.log(`[focus-latch] ${accel} released via ${source}; ${fHoverTarget.title || fHoverTarget.key || "widget"} remains interactive`);
      return;
    }

    stopFHoverPolling();
    releaseForwardedMouseButtons("F released outside widget");
    overlayInteractionLatched = false;
    overlayInteractionClaimSource = "";
    fHoverOverWidget = false;
    fHoverTarget = null;
    fHoverPointerPhase = "game";
    fHoverHostHookAuthoritative = false;
    fHoverMissStartedAt = 0;
    resetFHoverHostHandoff();
    interactiveTarget = null;
    locked = true;
    applyMouse();
    reapplyOverlayInputShape();
    try { overlay?.webContents.send("overlay:f-hover", { held: false, overWidget: false, latched: false }); } catch {}
    if (!moveMode && !modalOpen && !notepadEditing && !dragging) setTimeout(restoreLinuxPreviousWindow, 30);
    refreshTray();
    console.log(`[f-hover] ${accel} released via ${source} outside a widget; click-through restored`);
  };

  const r = hotkeys.registerHold(accel, () => onDown("uiohook"), () => onUp("uiohook"));
  if (process.platform === "linux") {
    evdevInteractController = startEvdevHoldKey({ accelerator: accel, onDown: () => onDown("evdev"), onUp: () => onUp("evdev") });
  }
  if (r.ok) interactAccel = accel;
  else console.warn(`[f-hover] uIOhook could not register ${accel}: ${r.error || "unknown"}; evdev fallback will be used when available`);
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
// sessions use Shift+F6 arrange mode plus F-to-enter widget interaction; there is no dedicated
// Shift+F5 interaction path.
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
  if (configWin) { configWin.show(); configWin.focus(); return; }
  // Size the window to the display so it (and its auto-scaled content — config.html applies the
  // same screen.height/1080 zoom) is readable on a 4K TV instead of a tiny 780px box. Clamp to
  // the work area, and centre on the PRIMARY display for the same reasons as the wizard above —
  // not least that the wizard deep-links here, and the two arriving on different monitors would
  // be its own small bug.
  const disp = screen.getPrimaryDisplay();
  const scale = Math.max(1, Math.min(2.25, disp.size.height / 1080));
  const width = Math.min(disp.workArea.width - 40, Math.round(780 * scale));
  const height = Math.min(disp.workArea.height - 40, Math.round(860 * scale));
  const x = Math.round(disp.workArea.x + (disp.workArea.width - width) / 2);
  const y = Math.round(disp.workArea.y + (disp.workArea.height - height) / 2);
  configWin = new BrowserWindow({
    x, y, width, height,
    title: "SC Overlay — Config",
    icon: appIconPath(),
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
      for (const delay of [0, 150, 500]) {
        setTimeout(() => { void requestOverlayRegionSnapshot(`restored-after-config+${delay}ms`); }, delay);
      }
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
      `W 'old instance gone (or 10s timeout); sweeping leftover sidecar'`,
      // The sidecar is our own exe running server.mjs as node (0.1.41+); match the command line,
      // never the bare name — every overlay window is also named 'SC Overlay'. The old bun-exe
      // name sweep stays one more release: an orphan from 0.1.40 can survive into this update.
      `Get-Process -Name 'sc-overlay-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
      `Get-CimInstance Win32_Process -Filter "Name='SC Overlay.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      `try {`,
      `  W 'requesting elevated relaunch (UAC): ${exe.replace(/'/g, "''")}'`,
      `  Start-Process -FilePath ${q(exe)}${argList} -WorkingDirectory ${q(wd)} -Verb RunAs -ErrorAction Stop`,
      `  W 'elevated relaunch accepted'`,
      `} catch {`,
      `  W ('ELEVATION FAILED: ' + $_.Exception.Message)`,
      `}`,
    ].join("\r\n");
    const helperPath = path.join(app.getPath("temp"), "sc-overlay-elevate.ps1");
    fs.writeFileSync(helperPath, helper, "utf8");
    mlog(`spawning elevation helper (isPackaged=${app.isPackaged}, exe=${exe})`);
    spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", helperPath],
      { detached: true, stdio: "ignore", windowsHide: true }).unref();
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
  if (trayIsUsable()) tray.setToolTip(`SC Overlay — downloading update ${pct}%`);
  updateDownload.percent = pct;
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
      { label: "Settings…", click: openSettingsSurface },
      { label: "Run setup again…", click: openSetup },
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

function appIconPath() {
  const iconCandidates = [
    path.join(ROOT, "server", "overlay", "tray-icon.png"),
    path.join(process.resourcesPath, "server", "overlay", "tray-icon.png"),
    path.join(process.resourcesPath, "app", "server", "overlay", "tray-icon.png"),
    path.join(ROOT, "overlay", "tray-icon.png"),
    path.join(ROOT, "build", "icon.png"),
  ];
  return iconCandidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function createTray() {
  const iconPath = appIconPath();
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
    // One helper answers "who's in front" for both the OCR gate and hold-to-interact — and only
    // runs while one of them actually wants it (see foreground.want). Alt-tabbing in or out of the
    // game changes whether the hold is required, so re-evaluate on every change rather than
    // waiting for something else to notice.
    foreground.onChange(() => {
      applyMouse();
      // The canvas needs the same answer for its own reason: a summoned cog / open hub should
      // time itself out once you're back in the GAME, since that's when it's forgotten about.
      // Pushed rather than polled — the page can't see the desktop, and this fires only on an
      // actual change of foreground window.
      try {
        if (overlay && !overlay.isDestroyed()) {
          overlay.webContents.send("overlay:game-focus", foreground.gameInFront());
        }
      } catch { /* window gone */ }
    });
    await reclaimStalePort();
    startServer();
    const up = await waitForServer();
    if (!up) {
      console.error("[electron] server did not come up on :" + PORT);
      // Nothing else can report this: the HUD page is SERVED BY the sidecar, so with it dead the
      // canvas never loads and there is no surface to draw a banner on. A native box is the only
      // thing left that the user will actually see.
      announceSidecar({ down: true, retrying: false });
      dialog.showErrorBox("SC Overlay — background service didn't start",
        "The part of SC Overlay that reads your game log and tracks blueprints could not start, " +
        "so nothing will be tracked.\n\nThis is usually another copy still running, or port " +
        PORT + " being in use.\n\nQuit SC Overlay from the tray and start it again. If it keeps " +
        "happening, Settings → Copy diagnostics says why, and the detail is in:\n" + SIDECAR_LOG);
    }
    overlayEnabled = readOverlayEnabled();
    const savedBrowser = readBrowserState();
    browserVisible = savedBrowser.browserVisible; twitchChatVisible = savedBrowser.chatVisible;
    browserRuntimeState = { ...browserRuntimeState, url: savedBrowser.url, channel: savedBrowser.channel };
    let registeredInteractKey = "F";
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8"));
      if (process.platform !== "linux" && c.interactHotkey) registeredInteractKey = c.interactHotkey;
      if (process.platform === "linux") fHoverEnabled = true;
    } catch {}
    const earlyInteractResult = registerInteractHotkey(registeredInteractKey);
    if (earlyInteractResult?.ok) console.log(`[hotkeys] interaction gate ${registeredInteractKey} registered before overlay creation`);
    if (overlayEnabled) createOverlay();
    reportGeometry(); // baseline for diagnostics, before any monitor change moves things around
    createTray();
    overlayWindows.installDisplayHooks();
    setupUpdater();
    hotkeys.register("Control+Alt+L", toggleLock); // legacy Blueprint lock/unlock

    // Linux uses Shift+F6 for the shared arrange workflow. F remains the normal widget-entry gate.

    // First run → wizard; existing user with unfinished setup → one dismissible banner. Runs
    // after createOverlay() because the banner is sent to the canvas, and only when the server
    // actually answered — the wizard reads every step's state from it.
    if (up) void maybeRunSetup();
    // Keep the canvas windows covering the whole virtual desktop when monitors change.
    screen.on("display-added", refitCanvasWindows);
    screen.on("display-removed", refitCanvasWindows);
    screen.on("display-metrics-changed", refitCanvasWindows);
    // Configurable global hotkeys (live-rebindable from the config window), read from the
    // persisted config: overlay show/hide (default F3) + binding-chart PNG (default Alt+F3).
    let overlayKey = "F3";
    let bindKey = "Ctrl+F3";
    let miningKey = "Shift+F3";
    let notepadKey = "Alt+F3";
    let interactKey = typeof registeredInteractKey === "string" ? registeredInteractKey : "F";
    let moveKey = process.platform === "linux" ? "Shift+F6" : "Ctrl+Alt+M";
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
      if (process.platform !== "linux" && typeof c.interactHotkey === "string") interactKey = c.interactHotkey;
      if (process.platform !== "linux" && typeof c.moveHotkey === "string") moveKey = c.moveHotkey;
      if (typeof c.fabClaimHotkey === "string") fabClaimKey = c.fabClaimHotkey;
      if (process.platform === "linux") { fHoverEnabled = true; holdMode = true; interactKey = "F"; moveKey = "Shift+F6"; }
      else holdMode = c.holdToInteract === true;
    } catch { /* defaults */ }
    if (process.platform === "win32") foreground.want("hold", holdMode);
    registerOverlayHotkey(overlayKey);
    registerBindingHotkey(bindKey);
    registerMiningHotkey(miningKey);
    registerNotepadHotkey(notepadKey);
    if (interactKey !== registeredInteractKey) {
      registerInteractHotkey(interactKey);
      registeredInteractKey = interactKey;
    }
    registerMoveHotkey(moveKey);
    registerFabClaimHotkey(fabClaimKey);
    if (process.platform === "linux") void postConfig({ interactHotkey: "F", holdToInteract: true, moveHotkey: "Shift+F6" });
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
    // Screen readers are explicit feature opt-ins. Showing or hiding the Mining widget must not
    // silently enable or disable OCR.
    let latestOcrStatus = { state: "off", reason: "starting", at: Date.now() };
    ipcMain.handle("app:ocr-status", () => latestOcrStatus);
    // Opt-in fabricator / mission / mining screen-capture loop. No-op until enabled.
    startFabCapture({
      port: PORT,
      configDir: CONFIG_DIR,
      devTools: !app.isPackaged,
      onStatus: (s) => {
        latestOcrStatus = { ...s, at: Number(s?.at) || Date.now() };
        try { overlay?.webContents.send("overlay:ocr", latestOcrStatus); } catch {}
        try { configWin?.webContents.send("ocr:status", latestOcrStatus); } catch {}
      },
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
  ipcMain.handle("set-notepad-hotkey", (_e, accel) =>
    registerNotepadHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-interact-hotkey", (_e, accel) =>
    registerInteractHotkey(process.platform === "linux" ? "F" : (typeof accel === "string" ? accel : "")));
  ipcMain.handle("set-move-hotkey", (_e, accel) =>
    registerMoveHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-fabclaim-hotkey", (_e, accel) =>
    registerFabClaimHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("overlay:reset-layout", () => { resetWidgetLayout(); return true; });
  // Primary display's offset + size within the full-desktop canvas, so the page can default a
  // new/reset widget onto the PRIMARY monitor (not a corner of a left/top secondary display).
  // 🔑 px/py carry the nudge's content shift, so ONE number moves everything: widget frames render
  // at `x + px` and every screen-anchored bit of chrome pins to --prim-*, which is also px/py. The
  // canvas coordinate space moves as a unit and the dotted outline stays a usable alignment target.
  // vw/vh are the WINDOW's size (grown by the nudge), not the desktop's — --prim-right measures in
  // from the window's right edge.
  // 🔑 Everything here is in CANVAS px — what the page writes into a CSS length — which the page's
  // `zoom: scale` then multiplies on the way to the screen. So pw/ph stay the primary's raw size
  // (it RENDERS scale× bigger, which is the point: the user grows it until the dotted outline sits
  // on their real monitor edges), while the window-relative shift and the window's own span are
  // real pixels and have to be divided by the scale to survive the multiply.
  ipcMain.handle("overlay:canvas-info", () => {
    const v = virtualDesktopBounds();
    const w = fullDisplayBounds();
    const s = canvasContentShift();
    const z = canvasScale;
    const p = screen.getPrimaryDisplay().bounds;
    return {
      px: p.x - v.x + s.x / z, py: p.y - v.y + s.y / z,
      pw: p.width, ph: p.height,
      vw: w.width / z, vh: w.height / z,
      scale: z,
    };
  ipcMain.handle("app:set-hold-mode", (_e, on) => {
    if (process.platform === "linux") {
      // The Windows setting remains configurable, but Linux hard click-through requires one
      // guaranteed way back into every widget. Ignore stale or live attempts to turn F off.
      fHoverEnabled = true;
      applyMouse();
      return true;
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
      ? rects.map((r) => ({
          x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h),
          key: typeof r.key === "string" ? r.key : "widget",
          title: typeof r.title === "string" ? r.title : (typeof r.key === "string" ? r.key : "widget"),
          classification: typeof r.classification === "string" ? r.classification : "reported-region",
          id: typeof r.id === "string" ? r.id : null,
          classes: Array.isArray(r.classes) ? r.classes.map(String) : [],
          priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 0,
        }))
          .filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 1 && r.h > 1)
      : [];
    const signature = JSON.stringify(overlayRegions.map((r) => [
      r.key, r.classification, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h),
    ]));
    if (signature !== overlayRegionSnapshotSignature) {
      overlayRegionSnapshotSignature = signature;
      const labels = [...new Set(overlayRegions.map((r) => `${r.classification}:${r.key}`))].join(", ");
      console.log(`[f-hover] classified region snapshot count=${overlayRegions.length}${labels ? ` [${labels}]` : ""}`);
    }
    if (fHoverHeld) updateFHoverHitFromRegions();
    else if (momentaryInteractionActive || overlayInteractionLatched) applyMouse();
  });
  ipcMain.on("overlay:point-classification", (_e, result) => {
    const seq = Number(result?.seq);
    if (!fHoverHeld || !Number.isFinite(seq) || seq < fHoverLastClassifiedSeq) return;
    fHoverLastClassifiedSeq = seq;
    fHoverLastClassificationAt = Date.now();
    applyFHoverClassification(result?.hit === true, result, "dom-classification");
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
    maskModal = modalOpen;
    recomputeWebViewMask();
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
  // Any widget's grab handle (or the global cog's Arrange button) enters GLOBAL arrange —
  // all visible widgets become movable; either "Done" exits for all.
  // Arrange draws drag banners and handles OVER the widgets; a native view would sit on top of
  // all of it, so it steps aside for the duration.
  ipcMain.on("overlay:begin-move", () => { maskArrange = true; recomputeWebViewMask(); setArrangeAll(true); setMoveMode(true); reapplyOverlayInputShape(); });
  ipcMain.on("overlay:end-move", () => { maskArrange = false; recomputeWebViewMask(); setArrangeAll(false); setMoveMode(false); reapplyOverlayInputShape(); });
  // Canvas chrome that has to be readable is open over the view (a widget's settings popover, the
  // cog hub). The renderer is the only thing that knows this — main cannot see the DOM.
  ipcMain.on("overlay:mask-view", (_e, on) => { maskChrome = !!on; recomputeWebViewMask(); });

  // ── the Web Page widget's view ──────────────────────────────────────────────
  // The renderer owns the widget's chrome and geometry and leaves a hole; these carry the hole's
  // rect, what to load in it, and whether it should be painted at all.
  ipcMain.on("webview:bounds", (_e, r) => {
    if (!r || typeof r.x !== "number") return;
    // Round: fractional bounds make a native view blurry against the game.
    webViewBounds = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) };
    applyWebViewBounds();
  });
  ipcMain.on("webview:show", (_e, on) => {
    webViewWanted = !!on;
    if (webViewWanted) ensureWebView();
    applyWebViewBounds();
  });
  ipcMain.on("webview:load", (_e, url) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    ensureWebView();
    webView?.webContents.loadURL(url).catch((e) => {
      try { overlay?.webContents.send("webview:state", { url, failed: String(e).split("\n")[0] }); } catch { /* gone */ }
    });
  });
  ipcMain.on("webview:reload", () => { try { webView?.webContents.reload(); } catch { /* none yet */ } });
  ipcMain.on("webview:back", () => {
    try { if (webView?.webContents.navigationHistory.canGoBack()) webView.webContents.navigationHistory.goBack(); } catch { /* none yet */ }
  });
  ipcMain.on("webview:close", () => { webViewWanted = false; destroyWebView(); });
  // Per-widget layout (canvas model): the page fetches saved widget layouts on load and
  // saves them back as the user drags/resizes. Scale is now a property of each widget inside
  // the full-screen canvas, not a resize of the overlay window (which is fixed full-screen).
  ipcMain.handle("overlay:get-widgets", () => readWidgets());
  ipcMain.on("overlay:save-widget", (_e, id, layout) => saveWidget(id, layout));
  ipcMain.handle("overlay:reset-layout", async () => { await resetWidgetLayout(); return true; });
  ipcMain.handle("overlay:canvas-info", () => overlayWindows.canvasInfo());

  // ── global widget on/off (from the in-overlay hub) ──────────────────────────
  // Only the Mining Assistant is a hub toggle — the Blueprint widget hides in-page and the
  // Binding chart is hotkey-only (never kept on). Both widgets now live in the one overlay
  // renderer, so mining is a shell-owned visibility flag (setMiningVisible) rather than a window.
  // (sendMiningVisible / pushWidgetStates / setMiningVisible are defined at module scope above.)
  // Live canvas calibration — the nudge and the scale together, since both re-fit the same window
  // and either one alone leaves a mixed-DPI canvas wrong. Applies immediately (refit) so the user
  // sees the dotted outline move and resize as they press, then persists via the sidecar — which
  // is the only writer of config.json. Called with no argument it just reports the current value,
  // which is how both surfaces (arrange mode and the Settings window) open showing the truth.
  ipcMain.handle("app:canvas-calibration", (_e, cal) => {
    if (cal && Number.isFinite(cal.x) && Number.isFinite(cal.y)) {
      const clamp = (n) => Math.max(-4000, Math.min(4000, Math.round(n)));
      canvasOffset = { x: clamp(cal.x), y: clamp(cal.y) };
      if (Number.isFinite(cal.scale)) canvasScale = clampCanvasScale(cal.scale);
      refitCanvasWindows();
      postConfig({ canvasOffsetX: canvasOffset.x, canvasOffsetY: canvasOffset.y, canvasScale });
    }
    return { x: canvasOffset.x, y: canvasOffset.y, scale: canvasScale };
  });
  ipcMain.handle("app:widget-states", () => ({ mining: miningVisible, notepad: notepadVisible, twitchChat: twitchChatVisible, scFeed: scFeedVisible, unlockAlert: unlockAlertVisible, party: partyVisible, battaglia: battagliaVisible, chat: chatVisible, webView: webViewVisible, bindingChart: bindingChartVisible, config: configWidgetVisible }));
  ipcMain.handle("app:widget-states", () => widgetStatesSnapshot());
  ipcMain.on("app:set-mining", (_e, on) => {
    if (on) { miningAutoSuppress = 0; setMiningVisible(true); }
    else setMiningVisible(false, { manual: true });
  });
  ipcMain.on("app:set-notepad", (_e, on) => setNotepadVisible(!!on));
  ipcMain.on("app:set-twitchchat", (_e, on) => setTwitchChatVisible(!!on));
  ipcMain.on("app:set-scfeed", (_e, on) => setScFeedVisible(!!on));
  ipcMain.on("app:set-unlockalert", (_e, on) => setUnlockAlertVisible(!!on));
  ipcMain.on("app:set-party", (_e, on) => setPartyVisible(!!on));
  ipcMain.on("app:set-battaglia", (_e, on) => setBattagliaVisible(!!on));
  ipcMain.on("app:set-chat", (_e, on) => setChatVisible(!!on));
  ipcMain.on("app:set-config", (_e, on) => setConfigWidgetVisible(!!on));
  // SC Feed alert tone picker, mirroring mining:pick-tone (renderers can't open OS dialogs).
  ipcMain.handle("scfeed:pick-tone", async () => {
    const r = await dialog.showOpenDialog(overlay ?? undefined, {
      title: "Choose an SC Feed alert WAV",
      filters: [{ name: "WAV audio", extensions: ["wav"] }],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths.length) return false;
    await postConfig({ scFeedTone: r.filePaths[0] });
    return true;
  });
  ipcMain.handle("scfeed:clear-tone", async () => { await postConfig({ scFeedTone: "" }); return true; });
  ipcMain.on("app:set-webview", (_e, on) => setWebViewVisible(!!on));
  ipcMain.on("app:set-bindingchart", (_e, on) => setBindingChartVisible(!!on));
  // Reveal one of our own data folders in Explorer (the Party widget's saved splits). Restricted
  // to a known allow-list of subfolders so a renderer can never ask the shell to open a path.
  // Performance readout: Electron's own per-process CPU + memory, so "how much is this costing
  // my PC" is answerable in the app instead of via Task Manager guesswork.
  ipcMain.handle("app:metrics", () => {
    const os = require("node:os");
    let cpu = 0, mem = 0;
    const rows = [];
    for (const m of app.getAppMetrics()) {
      const mb = Math.round((m.memory?.workingSetSize ?? 0) / 1024);
      // Electron reports CPU as a share of ONE core.
      const pc = m.cpu?.percentCPUUsage ?? 0;
      cpu += pc; mem += mb;
      rows.push({ type: m.type, mb, pc });
    }
    rows.sort((a, b) => b.mb - a.mb);
    const cores = os.cpus().length;
    return {
      totalMb: mem,
      // Share of the WHOLE cpu, which is what a player cares about.
      cpuPct: Math.round((cpu / cores) * 10) / 10,
      cores,
      // Total installed RAM, so every memory figure can be expressed as a share of the SYSTEM
      // rather than a share of our own usage (which says nothing about impact).
      systemMb: Math.round(os.totalmem() / 1048576),
      rows,
    };
  });
  ipcMain.on("app:open-data-folder", (_e, which) => {
    const dirs = { "party-sessions": "party-sessions", "fab-captures": "fab-captures" };
    const sub = dirs[String(which)];
    if (!sub) return;
    const dir = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", sub);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    shell.openPath(dir);
  });

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

<<<<<<< DEBUG_RESOLVED_ALPHA18
