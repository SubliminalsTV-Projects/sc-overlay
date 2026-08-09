#!/usr/bin/env bash
set -euo pipefail

RUN_TMP="${RUNNER_TEMP:-/tmp}"
WORK="$RUN_TMP/r31-alpha18-build/work"
TAR="$RUN_TMP/dist/ArchVerse-Overlay-0.1.41-r31-alpha.18-arch.tar.gz"
TMP="$RUN_TMP/alpha18-main-startup-smoke"
rm -rf "$TMP"
mkdir -p "$TMP/package"

[[ -f "$WORK/electron/main.cjs" ]] || { echo '[startup-smoke] generated main.cjs missing' >&2; exit 70; }
[[ -f "$TAR" ]] || { echo '[startup-smoke] package tarball missing' >&2; exit 71; }
tar -xzf "$TAR" -C "$TMP/package"
PKG_ROOT="$(find "$TMP/package" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[[ -n "$PKG_ROOT" && -f "$PKG_ROOT/app/electron/main.cjs" ]] || { echo '[startup-smoke] packaged main.cjs missing' >&2; exit 72; }

cat > "$TMP/main-smoke.cjs" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const EventEmitter = require('node:events');

const target = path.resolve(process.argv[2]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archverse-main-smoke-'));
fs.writeFileSync(path.join(tmp, 'overlay-state.json'), JSON.stringify({ enabled: true }));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  setupComplete: true,
  miningAssistant: false,
  miningOpen: false,
  browserOpen: false,
  twitchChatOpen: false,
}));
process.env.SC_TRACKER_CONFIG_DIR = tmp;
process.env.HOME = tmp;
process.env.XDG_CONFIG_HOME = tmp;
process.env.SC_TRACKER_HOST_XDG_SESSION_TYPE = 'x11';
process.env.DISPLAY = ':99';
// Electron supplies this. The smoke points it at a harmless temp root because child spawning is
// intercepted below; startServer still has to build the correct server.mjs path and env first.
process.resourcesPath = tmp;

const appEvents = new EventEmitter();
const app = Object.assign(appEvents, {
  isPackaged: true,
  isQuitting: false,
  commandLine: { appendSwitch() {} },
  setName() {},
  disableHardwareAcceleration() {},
  getVersion() { return '0.1.41-r31-alpha.18'; },
  getPath(name) { return name === 'exe' ? '/tmp/fake-electron' : tmp; },
  getAppMetrics() { return []; },
  requestSingleInstanceLock() { return true; },
  quit() { this.isQuitting = true; },
  whenReady() { return Promise.resolve(); },
});

class DummyWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.dead = false;
    this.visible = false;
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, {
      send() {},
      loadURL: async () => {},
      reload() {},
      openDevTools() {},
      setWindowOpenHandler() {},
      isLoadingMainFrame() { return false; },
      executeJavaScript: async () => true,
      session: { clearCache: async () => {}, clearStorageData: async () => {} },
      navigationHistory: { canGoBack() { return false; }, goBack() {} },
    });
    this.contentView = { addChildView() {}, removeChildView() {} };
  }
  isDestroyed() { return this.dead; }
  isVisible() { return this.visible; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  moveTop() {}
  setBounds() {}
  getBounds() { return { x: 0, y: 0, width: 1920, height: 1080 }; }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  setSkipTaskbar() {}
  loadURL() {
    // Exercise createOverlay's renderer-ready callback too, after its listeners are attached.
    setImmediate(() => this.webContents.emit('did-finish-load'));
    return Promise.resolve();
  }
  loadFile() { return Promise.resolve(); }
  close() { this.dead = true; }
  destroy() { this.dead = true; }
}
class DummyView {
  constructor() { this.webContents = new DummyWindow().webContents; }
  setBounds() {}
}
class DummyTray extends EventEmitter {
  constructor() { super(); this.dead = false; }
  setToolTip() {}
  setContextMenu() {}
  destroy() { this.dead = true; }
  isDestroyed() { return this.dead; }
}

const ipcHandles = new Set();
const ipcListeners = new Set();
const ipcMain = {
  handle(channel) {
    if (ipcHandles.has(channel)) throw new Error(`duplicate ipcMain.handle: ${channel}`);
    ipcHandles.add(channel);
  },
  on(channel) {
    if (ipcListeners.has(channel)) throw new Error(`duplicate ipcMain.on: ${channel}`);
    ipcListeners.add(channel);
  },
  once(channel) {
    if (ipcListeners.has(channel)) throw new Error(`duplicate ipcMain.once/on: ${channel}`);
    ipcListeners.add(channel);
  },
};
const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay() {
    return {
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      size: { width: 1920, height: 1080 },
      scaleFactor: 1,
    };
  },
  getAllDisplays() { return [this.getPrimaryDisplay()]; },
  getCursorScreenPoint() { return { x: 100, y: 100 }; },
  getDisplayNearestPoint() { return this.getPrimaryDisplay(); },
  getDisplayMatching() { return this.getPrimaryDisplay(); },
});
const electron = {
  app,
  BrowserWindow: DummyWindow,
  WebContentsView: DummyView,
  session: { defaultSession: {} },
  Tray: DummyTray,
  Menu: { buildFromTemplate(template) { return template; } },
  nativeImage: {
    createFromPath() { return { isEmpty() { return true; } }; },
    createEmpty() { return {}; },
  },
  screen,
  shell: { openExternal() {}, openPath() { return Promise.resolve(''); } },
  ipcMain,
  dialog: {
    showErrorBox() {},
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
};

let spawnedInstance = null;
let sidecarSpawnSeen = false;
class FakeChild extends EventEmitter {
  kill() { this.emit('exit', 0, null); }
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return electron;
  if (request === 'node:child_process') {
    const real = originalLoad(request, parent, isMain);
    return {
      ...real,
      spawn(command, args, options = {}) {
        if (options?.env?.ELECTRON_RUN_AS_NODE === '1') {
          sidecarSpawnSeen = true;
          spawnedInstance = options.env.SC_INSTANCE || null;
          if (!options.env.SC_TRACKER_CONFIG_DIR) throw new Error('sidecar spawn omitted SC_TRACKER_CONFIG_DIR');
          if (!Array.isArray(args) || !String(args[0] || '').endsWith('/server/server.mjs')) {
            throw new Error(`unexpected packaged sidecar argv: ${JSON.stringify(args)}`);
          }
        }
        return new FakeChild();
      },
    };
  }
  if (request === 'node:http') {
    return {
      get(url, callback) {
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.destroy = () => {};
        queueMicrotask(() => {
          // reclaimStalePort() runs before our child exists: emulate an unused port.
          if (!spawnedInstance) return req.emit('error', new Error('smoke: port unused before spawn'));
          const response = new EventEmitter();
          response.resume = () => {};
          callback(response);
          queueMicrotask(() => {
            response.emit('data', Buffer.from(JSON.stringify({
              instance: spawnedInstance,
              pid: 4321,
              version: '0.1.41-r31-alpha.18',
            })));
            response.emit('end');
          });
        });
        return req;
      },
    };
  }

  // Main-process startup is what this smoke is validating. These companion modules have their own
  // syntax/module checks; stub side effects that need a real X11 desktop, evdev device, or renderer.
  if (parent?.filename === target || parent?.filename?.endsWith('/electron/main.cjs')) {
    if (request === './hotkeys.cjs') return {
      register() { return { ok: true }; }, registerHold() { return { ok: true }; },
      unregister() {}, unregisterAll() {}, onMouseMove() {}, onMouseButton() {},
    };
    if (request === './capture.cjs') return {
      startFabCapture() { return { stop() {}, updateConfig() {}, status() { return {}; } }; },
    };
    if (request === './foreground.cjs') return {
      onChange() {}, want() {}, ready() { return false; }, gameInFront() { return false; }, stop() {},
    };
    if (request === './window-manager.cjs') return {
      OverlayWindowManager: class {
        primaryBounds() { return { x: 0, y: 0, width: 1920, height: 1080 }; }
        canvasBounds() { return { x: 0, y: 0, width: 1920, height: 1080 }; }
        defaultZone() { return { x: 0, y: 0, width: 1920, height: 1080 }; }
        detect() { return { desktop: this.canvasBounds(), primary: this.primaryBounds(), source: 'startup-smoke' }; }
        canvasInfo() { return { x: 0, y: 0, width: 1920, height: 1080, px: 0, py: 0, pw: 1920, ph: 1080, scale: 1 }; }
        logLayout() {} installDisplayHooks() {} refitAll() {} register() {} pin() {}
        setPassthrough() {} setInteractiveRegions() {} clearInteractiveRegions() {}
        showCanvasWindow() {} suspendCanvasWindow() {} resumeCanvasWindow() {}
        isOwnOverlayWindow() { return false; } activeWindowDetails() { return {}; }
        pointerLocation() { return { x: 0, y: 0 }; } gamescopePointerLocation() { return null; }
        moveHostPointer() {} focusWindow() {} restorePreviousWindow() {}
        isStarCitizenDirectlyActive() { return false; } captureActiveWindow() { return null; }
        createCanvasWindow() { return new DummyWindow(); }
      },
    };
    if (request === './browser-widget.cjs') return {
      DEFAULT_BROWSER_URL: 'https://example.invalid',
      BrowserWidgetController: class {
        constructor() { this.state = { browserVisible: false, chatVisible: false, url: 'https://example.invalid', channel: '' }; }
        attach() {} destroy() {} stop() {} suspendHidden() {} resumeHidden() {} resume() {}
        setMasked() {} setBounds() {} setBrowserBounds() {} setChatBounds() {}
        setBrowserVisible(v) { this.state.browserVisible = !!v; }
        setChatVisible(v) { this.state.chatVisible = !!v; }
        setInteractionKeyHeld() {} setChannel() {} navigate() {} reload() {} back() {} forward() {}
        mouseDestinationAt() { return null; }
      },
    };
    if (request === './linux/evdev-hold-key.cjs') return { startEvdevHoldKey() { return { stop() {} }; } };
  }
  return originalLoad(request, parent, isMain);
};

// Keep long UI retry/snapshot timers from holding the smoke open while preserving async ordering.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(Number(ms) || 0, 2), ...args);

let fatal = null;
process.on('uncaughtException', (error) => { fatal = error; console.error('[startup-smoke uncaught]', error?.stack || error); });
process.on('unhandledRejection', (error) => { fatal = error; console.error('[startup-smoke rejection]', error?.stack || error); });

require(target);
realSetTimeout(() => {
  if (fatal) process.exit(2);
  for (const channel of ['app:widget-states', 'overlay:canvas-info', 'overlay:reset-layout']) {
    if (!ipcHandles.has(channel)) throw new Error(`startup did not register ipcMain.handle(${channel})`);
  }
  if (!ipcListeners.has('app:set-mining')) throw new Error('startup did not register app:set-mining');
  if (!sidecarSpawnSeen || !spawnedInstance) throw new Error('packaged sidecar spawn contract was not exercised');
  if (!fs.existsSync(path.join(tmp, 'sidecar.log'))) throw new Error('sidecarLogStream did not create sidecar.log');
  console.log(`[startup-smoke] PASS ${path.basename(target)}; handles=${ipcHandles.size} listeners=${ipcListeners.size}`);
  process.exit(0);
}, 1000);
NODE

node "$TMP/main-smoke.cjs" "$WORK/electron/main.cjs"
node "$TMP/main-smoke.cjs" "$PKG_ROOT/app/electron/main.cjs"

echo '[startup-smoke] generated tree + packaged main-process startup PASS'
