#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1])
files = [
    root / "electron/main.cjs",
    root / "electron/capture.cjs",
    root / "electron/preload.cjs",
    root / "overlay/config.html",
    root / "overlay/missions.html",
]

def txt(lines): return "".join(lines)

def main_choice(n, ours, base, theirs):
    O, T = txt(ours), txt(theirs)
    if n == 1:
        return '''// Linux keeps the proven XWayland hard-click-through interaction contract.\nconst LINUX_HARD_CLICK_THROUGH = process.platform === "linux" && process.env.SCBT_FORCE_CLICK_THROUGH !== "0";\nconst INTERACTION_TIMEOUT_MS = 30000;\nconst HUD_URL = `http://127.0.0.1:${PORT}/missions.html`;\nconst CONFIG_URL = `http://127.0.0.1:${PORT}/config.html`;\nconst SETUP_URL = `http://127.0.0.1:${PORT}/setup.html`;\nconst INSTANCE_ID = require("node:crypto").randomUUID();\n'''
    if n == 2:
        return O + 'let chatVisible = false;\nlet configWidgetVisible = false;\n'
    if n in {3,4}:
        T = T.replace('env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", APP_VERSION, SC_INSTANCE: INSTANCE_ID },',
                      'env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", APP_VERSION, SC_INSTANCE: INSTANCE_ID, SC_TRACKER_CONFIG_DIR: CONFIG_DIR },')
        T = T.replace('env: { ...process.env, APP_VERSION, SC_DEV: "1", SC_INSTANCE: INSTANCE_ID },',
                      'env: { ...process.env, APP_VERSION, SC_DEV: "1", SC_INSTANCE: INSTANCE_ID, SC_TRACKER_CONFIG_DIR: CONFIG_DIR },')
        return T
    if n in {5,6}: return T
    if n == 7:
        return T + '''\n// Compatibility names used by the ArchVerse Linux interaction/window manager.\nfunction detectedVirtualDesktopBounds() {\n  if (process.platform === "linux") { const l = overlayWindows.detect(); return { ...l.desktop, source: l.source }; }\n  return { ...virtualDesktopBounds(), source: "electron" };\n}\nfunction centeredDefaultZone() {\n  if (process.platform === "linux") return overlayWindows.defaultZone();\n  const p = primaryBounds(); return { x: p.x, y: p.y, width: p.width, height: p.height };\n}\n'''
    if n == 8:
        # Alpha17's KScreen/XRandR refit first, then upstream's canvas-changed + diagnostics.
        return O + T
    if n == 9:
        # Upstream owns the renderer/window contract; Linux-specific BrowserWindow options and
        # BrowserWidgetController are injected below once the conflict-free function is assembled.
        return T
    if n == 10: return T
    if n == 11:
        return T + '    sendBrowserVisible?.();\n'
    if n == 12:
        return O + T
    if n == 13:
        return O + '''\n  // Preserve upstream focus notification for the renderer while Linux keeps its richer handoff.\n  overlay.on("focus", () => { try { overlay?.webContents.send("overlay:window-focus", true); } catch {} });\n  overlay.on("blur", () => { try { overlay?.webContents.send("overlay:window-focus", false); } catch {} });\n'''
    if n == 14: return O + T
    if n == 15: return O  # ArchVerse Linux interaction ownership replaces Windows cursor polling.
    if n == 16: return T
    if n == 17: return T + O
    if n == 18: return O + T
    if n == 19: return T
    if n == 20: return T
    if n in {21,22,23,24}: return T
    if n == 25:
        return '''  if (trayIsUsable()) tray.setToolTip(`SC Overlay — downloading update ${pct}%`);\n  updateDownload.percent = pct;\n'''
    if n == 26:
        return '''      { label: "Settings…", click: openSettingsSurface },\n      { label: "Run setup again…", click: openSetup },\n      ...(process.platform === "linux" ? [{ label: "Open config in browser…", click: openConfigInBrowser }] : []),\n      ...(process.platform === "win32" && cachedElevated === false\n'''
    if n == 27:
        return '''function appIconPath() {\n  const iconCandidates = [\n    path.join(ROOT, "server", "overlay", "tray-icon.png"),\n    path.join(process.resourcesPath, "server", "overlay", "tray-icon.png"),\n    path.join(process.resourcesPath, "app", "server", "overlay", "tray-icon.png"),\n    path.join(ROOT, "overlay", "tray-icon.png"),\n    path.join(ROOT, "build", "icon.png"),\n  ];\n  return iconCandidates.find((candidate) => fs.existsSync(candidate)) || "";\n}\n\nfunction createTray() {\n  const iconPath = appIconPath();\n  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();\n'''
    if n == 28: return T
    if n == 29: return O + T
    if n == 30:
        return '''    let notepadKey = "Alt+F3";\n    let interactKey = typeof registeredInteractKey === "string" ? registeredInteractKey : "F";\n    let moveKey = process.platform === "linux" ? "Shift+F6" : "Ctrl+Alt+M";\n    let fabClaimKey = "F4";\n'''
    if n == 31:
        return '''      if (process.platform !== "linux" && typeof c.interactHotkey === "string") interactKey = c.interactHotkey;\n      if (process.platform !== "linux" && typeof c.moveHotkey === "string") moveKey = c.moveHotkey;\n      if (typeof c.fabClaimHotkey === "string") fabClaimKey = c.fabClaimHotkey;\n      if (process.platform === "linux") { fHoverEnabled = true; holdMode = true; interactKey = "F"; moveKey = "Shift+F6"; }\n      else holdMode = c.holdToInteract === true;\n    } catch { /* defaults */ }\n    if (process.platform === "win32") foreground.want("hold", holdMode);\n'''
    if n == 32:
        return '''    registerNotepadHotkey(notepadKey);\n    if (interactKey !== registeredInteractKey) {\n      registerInteractHotkey(interactKey);\n      registeredInteractKey = interactKey;\n    }\n'''
    if n == 33:
        return '''    registerFabClaimHotkey(fabClaimKey);\n    if (process.platform === "linux") void postConfig({ interactHotkey: "F", holdToInteract: true, moveHotkey: "Shift+F6" });\n'''
    if n == 34:
        return '''      configDir: CONFIG_DIR,\n      devTools: !app.isPackaged,\n      onStatus: (s) => {\n        latestOcrStatus = { ...s, at: Number(s?.at) || Date.now() };\n        try { overlay?.webContents.send("overlay:ocr", latestOcrStatus); } catch {}\n        try { configWin?.webContents.send("ocr:status", latestOcrStatus); } catch {}\n      },\n'''
    if n == 35: return O + T
    if n == 36: return T + O
    if n == 37:
        # Alpha17 owns rich classified regions and physical click forwarding. Keep upstream modal
        # masking in the existing later modal handler via post-processing.
        return O
    if n == 38:
        return T
    if n == 39:
        # Keep upstream calibration + current mining semantics; restore the snapshot API used by
        # Alpha17 startup interaction classification.
        return T.replace('  ipcMain.on("app:set-mining",', '  ipcMain.handle("app:widget-states", () => widgetStatesSnapshot());\n  ipcMain.on("app:set-mining",', 1)
    if n == 40:
        return T + O
    return T

def capture_choice(n, ours, base, theirs):
    # 0.1.40/0.1.41's mining pipeline is authoritative. The Alpha17 structural Scan Mode gate is
    # injected around it after conflict resolution so it gates rather than replaces the new OCR.
    return txt(theirs)

def preload_choice(n, ours, base, theirs):
    O, T = txt(ours), txt(theirs)
    if n == 1: return O + T
    if n in {2,3}: return T
    if n == 4:
        return '''  onBindingChartReload: (cb) => ipcRenderer.on("overlay:bindingchart-reload", () => cb()),\n  widgetStates: () => ipcRenderer.invoke("app:widget-states"),\n  canvasCalibration: (cal) => ipcRenderer.invoke("app:canvas-calibration", cal),\n'''
    return T

def config_choice(n, ours, base, theirs):
    O, T = txt(ours), txt(theirs)
    if n == 1: return O + T
    if n == 2:
        return '''  ["syncEnabled", "shareLogs", "fabCapture", "fabClaim", "missionOcr", "miningAssistant", "miningAutoShow", "autoSwitch", "hwAccel", "amdCompat", "revertThemeOnFoot"]\n    .forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener("change", () => { renderScreenProfile(); save(); }); });\n'''
    if n == 3: return O + T
    return T

def missions_choice(n, ours, base, theirs):
    O, T = txt(ours), txt(theirs)
    if n == 1: return T
    if n == 2:
        O = O.replace('#whatsnew, #arrangeScrim .ab,', '#whatsnew, #setupNudge.show, #svcDown.show, #arrangeScrim .ab, #arrangeScrim .nudge,')
        return O
    return T

def resolve_file(p: Path):
    rel = str(p.relative_to(root))
    lines=p.read_text().splitlines(keepends=True); out=[]; i=0; n=0
    while i < len(lines):
        if not lines[i].startswith("<<<<<<< "):
            out.append(lines[i]); i += 1; continue
        n += 1; i += 1; ours=[]; base=[]; theirs=[]
        while i < len(lines) and not lines[i].startswith("||||||| "): ours.append(lines[i]); i += 1
        if i >= len(lines): raise SystemExit(f"{rel}: malformed conflict {n} missing base")
        i += 1
        while i < len(lines) and not lines[i].startswith("======="): base.append(lines[i]); i += 1
        if i >= len(lines): raise SystemExit(f"{rel}: malformed conflict {n} missing separator")
        i += 1
        while i < len(lines) and not lines[i].startswith(">>>>>>> "): theirs.append(lines[i]); i += 1
        if i >= len(lines): raise SystemExit(f"{rel}: malformed conflict {n} missing end")
        i += 1
        if rel == "electron/main.cjs": chosen=main_choice(n,ours,base,theirs)
        elif rel == "electron/capture.cjs": chosen=capture_choice(n,ours,base,theirs)
        elif rel == "electron/preload.cjs": chosen=preload_choice(n,ours,base,theirs)
        elif rel == "overlay/config.html": chosen=config_choice(n,ours,base,theirs)
        elif rel == "overlay/missions.html": chosen=missions_choice(n,ours,base,theirs)
        else: chosen=txt(theirs)
        out.append(chosen)
        print(f"[alpha18-resolve] {rel} conflict {n}: semantic")
    p.write_text("".join(out))
    return n

for p in files:
    if p.exists() and "<<<<<<< " in p.read_text(): resolve_file(p)

# ---- post-resolution Linux integration ---------------------------------------
main = root / "electron/main.cjs"
s = main.read_text()
# Current upstream window implementation, with Linux-specific native shape and KWin behavior.
s = s.replace('''  overlay = new BrowserWindow({\n    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,\n    icon: appIconPath(),\n    frame: false,\n    transparent: true,\n    resizable: false,\n    movable: false,''', '''  overlay = new BrowserWindow({\n    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,\n    icon: appIconPath(),\n    frame: false,\n    transparent: true,\n    backgroundColor: "#00000000",\n    show: false,\n    resizable: false,\n    movable: false,\n    minimizable: false,\n    maximizable: false,\n    type: process.platform === "linux" ? "toolbar" : undefined,''', 1)
s = s.replace('''    skipTaskbar: false,\n    alwaysOnTop: true,''', '''    skipTaskbar: process.platform === "linux",\n    alwaysOnTop: true,''', 1)
# Register the current upstream window with the Linux manager and restore Alpha17 native browser
# surfaces. This retains all 0.1.41 canvas logic while using the proven KScreen/XRandR manager.
anchor = '  overlay.setBounds(bounds);\n  // Clear any cached copy'
insert = '''  overlay.setBounds(bounds);\n  if (process.platform === "linux") {\n    overlayWindows.register("Overlay Manager", overlay);\n    overlayWindows.pin(overlay);\n    browserController?.destroy();\n    browserController = new BrowserWidgetController({\n      WebContentsView, session, logger: console,\n      onInteractionClaim: (source) => claimFocusLatchedInteraction(`embedded-${source}`),\n      onNativeMouse: (source, mouse, b) => noteNativeMouseInput(`embedded-${source}`, mouse, b),\n      state: {\n        browserVisible, chatVisible: twitchChatVisible, url: browserRuntimeState.url, channel: browserRuntimeState.channel,\n        onState: (state) => {\n          browserRuntimeState = { ...browserRuntimeState, ...state }; browserVisible = !!state.browserVisible;\n          twitchChatVisible = !!state.chatVisible; writeBrowserState(state);\n          try { overlay?.webContents.send("browser:state", state); } catch {}\n          pushWidgetStates();\n        },\n      },\n    });\n    browserController.attach(overlay);\n  }\n  // Clear any cached copy'''
if anchor in s: s=s.replace(anchor,insert,1)
else: raise SystemExit('main: overlay registration anchor missing')
# Preserve Linux's physical display source for all current canvas calculations.
s = s.replace('''function virtualDesktopBounds() {\n  const phys = physicalDesktopBounds();''', '''function virtualDesktopBounds() {\n  if (process.platform === "linux") return overlayWindows.canvasBounds();\n  const phys = physicalDesktopBounds();''', 1)
s = s.replace('''function primaryBounds() {\n  const b = screen.getPrimaryDisplay().bounds;''', '''function primaryBounds() {\n  if (process.platform === "linux") return overlayWindows.primaryBounds();\n  const b = screen.getPrimaryDisplay().bounds;''', 1)
# Current move-mask behavior + Alpha17 interaction ownership.
s = s.replace('''ipcMain.on("overlay:begin-move", () => { maskArrange = true; recomputeWebViewMask(); setArrangeAll(true); });\n  ipcMain.on("overlay:end-move", () => { maskArrange = false; recomputeWebViewMask(); setArrangeAll(false); });''', '''ipcMain.on("overlay:begin-move", () => { maskArrange = true; recomputeWebViewMask(); setArrangeAll(true); setMoveMode(true); reapplyOverlayInputShape(); });\n  ipcMain.on("overlay:end-move", () => { maskArrange = false; recomputeWebViewMask(); setArrangeAll(false); setMoveMode(false); reapplyOverlayInputShape(); });''', 1)
# Before creating the canvas, restore Alpha17's persistent browser state and register the Linux F
# gate early enough that the game can still own focus on first launch.
startup_anchor='''    overlayEnabled = readOverlayEnabled();\n    if (overlayEnabled) createOverlay();\n    reportGeometry();'''
startup_insert='''    overlayEnabled = readOverlayEnabled();\n    const savedBrowser = readBrowserState();\n    browserVisible = savedBrowser.browserVisible; twitchChatVisible = savedBrowser.chatVisible;\n    browserRuntimeState = { ...browserRuntimeState, url: savedBrowser.url, channel: savedBrowser.channel };\n    let registeredInteractKey = "F";\n    try {\n      const c = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8"));\n      if (process.platform !== "linux" && c.interactHotkey) registeredInteractKey = c.interactHotkey;\n      if (process.platform === "linux") fHoverEnabled = true;\n    } catch {}\n    const earlyInteractResult = registerInteractHotkey(registeredInteractKey);\n    if (earlyInteractResult?.ok) console.log(`[hotkeys] interaction gate ${registeredInteractKey} registered before overlay creation`);\n    if (overlayEnabled) createOverlay();\n    reportGeometry();'''
if startup_anchor in s: s=s.replace(startup_anchor,startup_insert,1)
else: raise SystemExit('main: startup anchor missing')
# Ensure did-finish-load both reveals/reasserts the Linux canvas and marks upstream readiness.
ready_anchor='''    pushWidgetStates();\n    overlayLoaded = true;'''
ready_insert='''    pushWidgetStates();\n    if (process.platform === "linux") {\n      overlayWindows.showCanvasWindow("Overlay Manager", overlay, { inactive: true });\n      reapplyOverlayInputShape();\n      for (const delay of [0, 100, 500, 1500]) setTimeout(() => { void requestOverlayRegionSnapshot(`did-finish-load+${delay}ms`); }, delay);\n      try { overlay.moveTop(); } catch {}\n    }\n    overlayLoaded = true;'''
if ready_anchor in s: s=s.replace(ready_anchor,ready_insert,1)
else: raise SystemExit('main: did-finish-load anchor missing')
# Current modal masking + Linux input-shape reassertion.
modal_anchor='''    modalOpen = !!on;\n    maskWebView(modalOpen);\n    applyMouse();\n    reapplyOverlayInputShape();'''
modal_repl='''    modalOpen = !!on;\n    maskModal = modalOpen;\n    recomputeWebViewMask();\n    applyMouse();\n    reapplyOverlayInputShape();'''
if modal_anchor in s: s=s.replace(modal_anchor,modal_repl,1)
main.write_text(s)

# Mining: take 0.1.41 wholesale, then put Alpha17's structural detector in front of the expensive
# signature reader. No OCR, no ship/color/text dependency; a false detector result simply leaves
# the new upstream reader dormant until the radar control is structurally present.
cap = root / "electron/capture.cjs"
s = cap.read_text()
if 'detectScanModeRadarIcon' not in s:
    s=s.replace('const os = require("node:os");', 'const os = require("node:os");\nconst { detectScanModeRadarIcon } = require("./scan-mode-gate.cjs");',1)
helper='''\nlet _lastArchVerseScanMode = null;\nfunction archVerseScanMode(image, width, height) {\n  const normalizedWidth = 960;\n  const normalizedHeight = Math.max(240, Math.round(normalizedWidth * height / width));\n  const normalized = image.resize({ width: normalizedWidth, height: normalizedHeight, quality: "good" });\n  const r = detectScanModeRadarIcon(normalized.toBitmap(), normalizedWidth, normalizedHeight);\n  if (_lastArchVerseScanMode !== r.active) {\n    _lastArchVerseScanMode = r.active;\n    console.log(`[mining-scan-mode] ${r.active ? "active (radar icon)" : "inactive"} confidence=${r.confidence || 0} method=${r.method || "structure"} score=${r.templateScore || 0}${r.rejectionReason ? ` rejected=${r.rejectionReason}` : ""}`);\n  }\n  return r;\n}\n'''
if 'function archVerseScanMode' not in s:
    s=s.replace('// The kiosk\'s item render + name + category all live in the upper-right of the screen.', helper+'\n// The kiosk\'s item render + name + category all live in the upper-right of the screen.',1)
shot_anchor='''      const shot = cap && cap.image;\n      if (!shot) return;\n      stage.capture = Date.now() - t0;'''
shot_repl='''      const shot = cap && cap.image;\n      if (!shot) return;\n      let scanModeRead = { active: false, confidence: 0, method: "not-armed" };\n      if (mining && process.platform === "linux") {\n        try { scanModeRead = archVerseScanMode(shot, cap.width, cap.height); }\n        catch (e) { console.warn("[mining-scan-mode] detector failed:", e && e.message); }\n      } else if (mining) { scanModeRead = { active: true, confidence: 100, method: "upstream" }; }\n      if (!scanModeRead.active) { sigBox = null; sigBoxAt = 0; }\n      stage.scanMode = scanModeRead.active;\n      stage.capture = Date.now() - t0;'''
if shot_anchor in s: s=s.replace(shot_anchor,shot_repl,1)
else: raise SystemExit('capture: shot anchor missing')
s=s.replace('const locked = mining && sigBox && Date.now() - sigBoxAt < SIG_LOCK_MS;', 'const locked = mining && scanModeRead.active && sigBox && Date.now() - sigBoxAt < SIG_LOCK_MS;',1)
s=s.replace('if (mining && cfg.rapidOcr !== false) {', 'if (mining && scanModeRead.active && cfg.rapidOcr !== false) {',1)
s=s.replace('else if (mining && (read.scanHud || typeof read.signature === "number")) fastUntil = Date.now() + FAST_WINDOW_MS;', 'else if (mining && scanModeRead.active && (read.scanHud || typeof read.signature === "number")) fastUntil = Date.now() + FAST_WINDOW_MS;',1)
cap.write_text(s)

# Config page: Alpha17 live screen-reader status plus upstream fab-claim UI/state.
cfg = root / "overlay/config.html"
s=cfg.read_text()
if 'id="ocrLiveStatus"' in s and 'id="fabClaim"' not in s: raise SystemExit('config: fabClaim lost')
if 'id="miningAssistant"' in s and 'renderScreenProfile' not in s: raise SystemExit('config: screen profile lost')
cfg.write_text(s)
