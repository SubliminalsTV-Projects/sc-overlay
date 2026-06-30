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

const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const PORT = 8778;
const HUD_URL = `http://localhost:${PORT}/missions.html`;
const CONFIG_URL = `http://localhost:${PORT}/config.html`;

let server = null;
let overlay = null;
let configWin = null;
let tray = null;
let clickThrough = true; // start non-interactive so the game gets clicks

// ── server lifecycle ────────────────────────────────────────────────────────
function startServer() {
  // Dev: run the TS server via tsx. (Packaging will swap this for a bundled binary.)
  server = spawn("npx tsx src/overlay-server.ts", {
    cwd: ROOT,
    shell: true,
    env: { ...process.env },
    stdio: "ignore",
  });
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
    webPreferences: { contextIsolation: true },
  });
  // Float above borderless fullscreen games.
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL(HUD_URL);
  applyClickThrough();
  overlay.on("moved", saveBounds);
  overlay.on("resize", saveBounds);
  overlay.on("closed", () => {
    overlay = null;
  });
}

function applyClickThrough() {
  if (!overlay) return;
  // forward:true still lets hover/scroll reach the page while clicks pass through.
  overlay.setIgnoreMouseEvents(clickThrough, { forward: true });
}

// ── actions ─────────────────────────────────────────────────────────────────
function toggleInteractive() {
  clickThrough = !clickThrough;
  applyClickThrough();
  if (!clickThrough && overlay) overlay.focus();
  refreshTray();
}

function toggleShow() {
  if (!overlay) return createOverlay();
  if (overlay.isVisible()) overlay.hide();
  else overlay.show();
  refreshTray();
}

function openConfig() {
  if (configWin) return configWin.focus();
  configWin = new BrowserWindow({
    width: 780,
    height: 820,
    title: "SC Blueprint Tracker — Config",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  configWin.loadURL(CONFIG_URL);
  configWin.on("closed", () => {
    configWin = null;
  });
}

function verifyFromLogs() {
  // Fire the same endpoint the HUD button uses.
  const req = http.request(
    { host: "localhost", port: PORT, path: "/api/missions/verify", method: "POST" },
    (r) => r.resume(),
  );
  req.on("error", () => {});
  req.end();
}

// ── tray ────────────────────────────────────────────────────────────────────
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: overlay && overlay.isVisible() ? "Hide overlay" : "Show overlay", click: toggleShow },
      {
        label: "Interactive (allow clicks)",
        type: "checkbox",
        checked: !clickThrough,
        click: toggleInteractive,
      },
      { type: "separator" },
      { label: "Verify from logs", click: verifyFromLogs },
      { label: "Open config…", click: openConfig },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, "overlay", "tray-icon.png"));
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
    createOverlay();
    createTray();
    globalShortcut.register("Control+Alt+B", toggleInteractive); // toggle click-through
    globalShortcut.register("Control+Alt+H", toggleShow); // show/hide
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
