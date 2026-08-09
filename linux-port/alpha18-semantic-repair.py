#!/usr/bin/env python3
from pathlib import Path
import re
import sys

if len(sys.argv) != 4:
    raise SystemExit("usage: alpha18-semantic-repair.py WORK_DIR UPSTREAM_DIR ALPHA17_APP_DIR")
work = Path(sys.argv[1])
up = Path(sys.argv[2])
a17 = Path(sys.argv[3])


def replace_between(text: str, start: str, end: str, replacement: str, *, include_end=False, label="section") -> str:
    i = text.find(start)
    if i < 0:
        raise SystemExit(f"{label}: start anchor missing: {start[:100]!r}")
    j = text.find(end, i + len(start))
    if j < 0:
        raise SystemExit(f"{label}: end anchor missing: {end[:100]!r}")
    if include_end:
        j += len(end)
    return text[:i] + replacement + text[j:]


def extract_between(text: str, start: str, end: str, *, include_end=False, label="section") -> str:
    i = text.find(start)
    if i < 0:
        raise SystemExit(f"{label}: source start missing: {start[:100]!r}")
    j = text.find(end, i + len(start))
    if j < 0:
        raise SystemExit(f"{label}: source end missing: {end[:100]!r}")
    if include_end:
        j += len(end)
    return text[i:j]


# -----------------------------------------------------------------------------
# MAIN PROCESS
# -----------------------------------------------------------------------------
main_path = work / "electron/main.cjs"
up_main = (up / "electron/main.cjs").read_text()
a17_main = (a17 / "electron/main.cjs").read_text()
s = main_path.read_text()

# 0.1.41 sidecar contract. A merge retained the call but dropped this helper and kept Alpha17's
# now-invalid close of an fd that 0.1.41 no longer declares locally.
sidecar_decl = 'let sidecarLogOpened = false;\n'
sidecar_helper = '''function sidecarLogStream() {
  try {
    fs.mkdirSync(path.dirname(SIDECAR_LOG), { recursive: true });
    const fd = fs.openSync(SIDECAR_LOG, sidecarLogOpened ? "a" : "w");
    sidecarLogOpened = true;
    return fd;
  } catch (e) {
    console.error("[electron] could not open the sidecar log:", String(e));
    return "ignore";
  }
}

'''
if 'function sidecarLogStream()' not in s:
    if sidecar_decl not in s:
        raise SystemExit("main: sidecarLogOpened anchor missing")
    s = s.replace(sidecar_decl, sidecar_decl + sidecar_helper, 1)
s = s.replace('    fs.closeSync(fd);\n', '')

# Replace the entire widget visibility/mutator seam with Alpha17's known-good Linux contract, then
# layer 0.1.41's new social Chat + Settings widget into that coherent block. This avoids partial
# function hunks (the source of the missing setMiningVisible/binding functions and stray `persist`).
a17_widgets = extract_between(
    a17_main,
    'function miningIsVisible()',
    'ipcMain.on("mining:hide", hideMining);',
    include_end=True,
    label="Alpha17 widget block",
)
# Snapshot now includes all 0.1.41 widgets.
a17_widgets = re.sub(
    r'return \{ mining: miningVisible, notepad: notepadVisible, browser: browserVisible, twitchChat: twitchChatVisible, scFeed: scFeedVisible, unlockAlert: unlockAlertVisible, party: partyVisible, battaglia: battagliaVisible, webView: webViewVisible, bindingChart: bindingChartVisible \};',
    'return { mining: miningVisible, notepad: notepadVisible, browser: browserVisible, twitchChat: twitchChatVisible, scFeed: scFeedVisible, unlockAlert: unlockAlertVisible, party: partyVisible, battaglia: battagliaVisible, chat: chatVisible, webView: webViewVisible, bindingChart: bindingChartVisible, config: configWidgetVisible };',
    a17_widgets,
    count=1,
)
chat_config = '''// Social Chat widget added upstream in 0.1.41.
function sendChatVisible(state) { try { overlay?.webContents.send("overlay:chat-visible", state); } catch {} }
function setChatVisible(on) {
  chatVisible = !!on;
  sendChatVisible({ on: chatVisible });
  void postConfig({ chatOpen: chatVisible });
  pushWidgetStates();
  refreshTray();
}
function toggleChat() { setChatVisible(!chatVisible); }

// Settings as a canvas widget. The standalone window remains the fallback if the canvas is off.
function sendConfigWidgetVisible(state) { try { overlay?.webContents.send("overlay:config-visible", state); } catch {} }
function setConfigWidgetVisible(on) {
  configWidgetVisible = !!on;
  sendConfigWidgetVisible({ on: configWidgetVisible });
  pushWidgetStates();
  refreshTray();
}
function openSettingsSurface() {
  if (overlayEnabled && overlay && !overlay.isDestroyed()) setConfigWidgetVisible(true);
  else openConfig();
}

'''
web_anchor = 'function sendWebViewVisible(state)'
if web_anchor not in a17_widgets:
    raise SystemExit("main: Alpha17 webview insertion anchor missing")
a17_widgets = a17_widgets.replace(web_anchor, chat_config + web_anchor, 1)

# Make the Linux mining mutator understand both our Alpha17 options and upstream's {manual:true}
# call sites, and keep 0.1.41's capture-loop arm state synchronized with visibility.
old_mining = extract_between(
    a17_widgets,
    'function setMiningVisible(',
    'function createMining()',
    label="Alpha17 setMiningVisible",
)
new_mining = '''function setMiningVisible(on, { persist = true, suppressAuto = false, manual = false } = {}) {
  miningVisible = !!on;
  if (miningVisible && !overlayEnabled) setOverlayEnabled(true);
  if (!miningVisible) {
    miningMoveMode = false;
    miningOnlyInteraction = false;
    if (suppressAuto || manual) miningAutoSuppress = Date.now() + 90000;
    try { overlay?.webContents.send("overlay:mining-move-mode", false); } catch {}
    try { overlay?.webContents.send("overlay:mining-only-interaction", false); } catch {}
    if (interactiveTarget === "mining") setInteractiveTarget(null, "Mining hidden");
  }
  sendEmbeddedMiningVisible({ on: miningVisible, arm: miningAutoArm, transient: false });
  // 0.1.41 only runs mining capture while the assistant is armed; keep that flag authoritative.
  void postConfig({ miningAssistant: miningVisible });
  pushWidgetStates();
  if (persist) void postConfig({ miningOpen: miningVisible });
  refreshTray();
}
'''
a17_widgets = a17_widgets.replace(old_mining, new_mining, 1)

s = replace_between(
    s,
    'function miningIsVisible()',
    'ipcMain.on("mining:hide", hideMining);',
    a17_widgets,
    include_end=True,
    label="main widget seam",
)

# Settings window: preserve Alpha17's Linux suspend/resume contract, but retain the 0.1.41 window
# sizing/UI below it. The merge lost only the `restore` declaration and hide calls.
open_config_anchor = '''function openConfig() {
  if (configWin) { configWin.show(); configWin.focus(); return; }
'''
restore_block = '''function openConfig() {
  if (configWin && !configWin.isDestroyed()) { configWin.show(); configWin.focus(); try { configWin.moveTop(); } catch {} return; }
  const restore = {
    overlay: process.platform === "linux" && !!(overlay && !overlay.isDestroyed() && overlay.isVisible()),
    binding: process.platform === "linux" && !!(bindingWin && !bindingWin.isDestroyed() && bindingWin.isVisible()),
  };
  if (restore.overlay) {
    browserController?.suspendHidden();
    overlayWindows.suspendCanvasWindow("Overlay Manager", overlay);
  }
  if (restore.binding) bindingWin.hide();
'''
if open_config_anchor not in s:
    raise SystemExit("main: openConfig anchor missing")
s = s.replace(open_config_anchor, restore_block, 1)

# Windows-only admin relaunch was another partial-function splice. Take the current 0.1.41 function
# wholesale; it understands the Electron-as-Node sidecar and has its helper/logger declarations.
up_restart = extract_between(up_main, 'function restartAsAdmin() {', '\nfunction postApi(p)', label="upstream restartAsAdmin")
s = replace_between(s, 'function restartAsAdmin() {', '\nfunction postApi(p)', up_restart, label="merged restartAsAdmin")

# The first canvas-info handler is the Linux calibrated one we want, but its closing `});` was
# swallowed by a neighboring conflict. Restore it before registering the next handler.
canvas_close_bad = '''      scale: z,
    };
  ipcMain.handle("app:set-hold-mode",'''
canvas_close_good = '''      scale: z,
    };
  });
  ipcMain.handle("app:set-hold-mode",'''
if canvas_close_bad not in s:
    raise SystemExit("main: canvas-info close seam missing")
s = s.replace(canvas_close_bad, canvas_close_good, 1)

# Global arrange already has a single Linux-aware setMoveMode() owner. The orphaned setArrangeAll
# calls came from a half-merged upstream helper and would throw on the first arrange gesture.
s = s.replace('maskArrange = true; recomputeWebViewMask(); setArrangeAll(true); setMoveMode(true); reapplyOverlayInputShape();',
              'maskArrange = true; recomputeWebViewMask(); setMoveMode(true); reapplyOverlayInputShape();')
s = s.replace('maskArrange = false; recomputeWebViewMask(); setArrangeAll(false); setMoveMode(false); reapplyOverlayInputShape();',
              'maskArrange = false; recomputeWebViewMask(); setMoveMode(false); reapplyOverlayInputShape();')

# Keep the calibrated Linux reset/canvas handlers above; remove the later upstream duplicates.
s = s.replace('  ipcMain.handle("overlay:reset-layout", async () => { await resetWidgetLayout(); return true; });\n', '')
s = s.replace('  ipcMain.handle("overlay:canvas-info", () => overlayWindows.canvasInfo());\n', '')

# One app:widget-states handler only. The snapshot function is the union of Linux + 0.1.41 widgets.
s = re.sub(
    r'^\s*ipcMain\.handle\("app:widget-states", \(\) => \(\{ mining:.*?\}\)\);\n',
    '', s, count=1, flags=re.M,
)

# Preserve Alpha17 compatibility aliases that do not exist in upstream, but delete the compact
# duplicate listeners/handlers accidentally appended after the full 0.1.41 block.
duplicate_patterns = [
    r'^\s*ipcMain\.on\("app:set-twitchchat", \(_e,on\)=>setTwitchChatVisible\(!!on\)\);\n',
    r'^\s*ipcMain\.on\("app:set-scfeed", \(_e,on\)=>setScFeedVisible\(!!on\)\);\n',
    r'^\s*ipcMain\.on\("app:set-unlockalert", \(_e,on\)=>setUnlockAlertVisible\(!!on\)\);\n',
    r'^\s*ipcMain\.on\("app:set-party", \(_e,on\)=>setPartyVisible\(!!on\)\);\n',
    r'^\s*ipcMain\.on\("app:set-battaglia", \(_e,on\)=>setBattagliaVisible\(!!on\)\);\n',
    r'^\s*ipcMain\.on\("app:set-webview", \(_e,on\)=>setWebViewVisible\(!!on\)\);\n',
    r'^\s*ipcMain\.on\("app:set-bindingchart", \(_e,on\)=>setBindingChartVisible\(!!on\)\);\n',
    r'^\s*ipcMain\.handle\("scfeed:pick-tone", async\(\)=>\{.*?\}\);\n',
    r'^\s*ipcMain\.handle\("scfeed:clear-tone", async\(\)=>\{.*?\}\);\n',
    r'^\s*ipcMain\.handle\("app:metrics",\(\)=>\{.*?\}\);\n',
    r'^\s*ipcMain\.on\("app:open-data-folder",\(_e,which\)=>\{.*?\}\);\n',
]
for pat in duplicate_patterns:
    s = re.sub(pat, '', s, count=1, flags=re.M)

# Add the two Linux/Alpha17 compatibility aliases exactly once next to the canonical Twitch handler.
alias_anchor = '  ipcMain.on("app:set-twitchchat", (_e, on) => setTwitchChatVisible(!!on));\n'
if alias_anchor not in s:
    raise SystemExit("main: canonical twitch IPC anchor missing")
alias_extra = '''  ipcMain.on("app:set-twitch-chat", (_e, on) => setTwitchChatVisible(!!on));
  ipcMain.on("app:set-browser", (_e, on) => setBrowserVisible(!!on));
'''
# Remove any surviving compact alias first so this stays idempotent.
s = re.sub(r'^\s*ipcMain\.on\("app:set-twitch-chat".*?\n', '', s, flags=re.M)
s = re.sub(r'^\s*ipcMain\.on\("app:set-browser".*?\n', '', s, flags=re.M)
s = s.replace(alias_anchor, alias_anchor + alias_extra, 1)

# Data folders belong under the canonical config root on Linux, not an independently reconstructed
# HOME/APPDATA path.
s = s.replace('const dir = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", sub);',
              'const dir = path.join(CONFIG_DIR, sub);')

main_path.write_text(s)


# -----------------------------------------------------------------------------
# PRELOAD
# -----------------------------------------------------------------------------
pre_path = work / "electron/preload.cjs"
p = pre_path.read_text()
# The Alpha17 and upstream names were both merged under the same JS object property. Keep the
# upstream channel; main registers its Alpha17 spelling as an alias too.
first = '  setTwitchChat: (on) => ipcRenderer.send("app:set-twitch-chat", !!on),\n'
if first in p:
    p = p.replace(first, '', 1)
pre_path.write_text(p)


# -----------------------------------------------------------------------------
# CAPTURE PROCESS
# -----------------------------------------------------------------------------
# This file changed too substantially on BOTH sides for line-level merging to be safe. Reconstruct
# it from upstream 0.1.41 (authoritative mining engine), then deliberately graft the Linux runtime
# contracts that Alpha17 proved in-game.
up_cap = (up / "electron/capture.cjs").read_text()
a17_cap = (a17 / "electron/capture.cjs").read_text()
c = up_cap

# Linux exact-session binding + isolated RapidOCR worker + structural Scan Mode detector.
imports_anchor = 'const os = require("node:os");\n'
imports = '''const os = require("node:os");
const { getStarCitizenSessionBinder } = require("./linux/star-citizen-session.cjs");
const { createRapidOcrClient } = require("./rapidocr-client.cjs");
const { detectScanModeRadarIcon } = require("./scan-mode-gate.cjs");

const scSession = getStarCitizenSessionBinder();
const rapidOcrClient = createRapidOcrClient({ logger: console });
process.once("exit", () => rapidOcrClient.close());
'''
if imports_anchor not in c:
    raise SystemExit("capture: os import anchor missing")
c = c.replace(imports_anchor, imports, 1)

# Replace Windows-only foreground + desktop capture with Alpha17's exact StarCitizen.exe/Gamescope
# session gate and KDE Wayland capture backend. The segment is extracted from the released Alpha17
# artifact at build time, so we cannot silently drift from the version the user actually tested.
fg_start = 'const fgPs1 = path.join(os.tmpdir(), "sc-fgwin.ps1");'
kiosk_marker = '// The kiosk\'s item render + name + category all live in the upper-right of the screen.'
a17_fg = extract_between(a17_cap, fg_start, kiosk_marker, label="Alpha17 foreground/capture")
c = replace_between(c, fg_start, kiosk_marker, a17_fg, label="upstream foreground/capture")

# 0.1.41 directly loads the native OCR model in Electron. Alpha17 intentionally moved that native
# work into a disposable child process so a libvips/onnx assertion cannot take the overlay down.
rapid_start = '// RapidOCR (PP-OCR) reader — main-process only'
rapid_end = '// ── Mining diagnostic frames'
rapid_worker = '''// RapidOCR is isolated in a disposable Node child process. The Electron main process receives
// only plain OCR results, preserving Alpha17's bounded-resource/crash-containment contract.
let _rapidWarningShown = false;
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
      text: String(r.text || ""), x, y,
      w: xs.length ? Math.max(...xs) - x : Number(frame?.width) || 0,
      h: ys.length ? Math.max(...ys) - y : Number(frame?.height) || 0,
      confidence: Number(r.score ?? r.confidence) || 0,
    };
  }).filter((row) => row.text.trim());
}
async function ocrRapidLinesOptional(imgPath) {
  try { return await ocrRapidLines(imgPath); }
  catch (error) {
    if (!_rapidWarningShown) {
      _rapidWarningShown = true;
      console.warn("[ocr] RapidOCR worker unavailable; continuing without RapidOCR for this read:", error?.message || error);
    }
    return [];
  }
}

'''
c = replace_between(c, rapid_start, rapid_end, rapid_worker + rapid_end, label="RapidOCR worker")

# Keep Alpha13's lightweight fingerprint primitives in the test surface. 0.1.41's scanner has its
# own lock/crop optimizations, so these are not forced into its algorithm; retaining the helpers
# prevents another missing-symbol regression while keeping future reuse available.
fp_helpers = '''// Lightweight visual fingerprint primitives retained from ArchVerse Alpha13.
function visualFingerprint(image, width, height, roi) {
  const x = Math.max(0, Math.min(width - 1, Math.round(width * roi.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(height * roi.y)));
  const w = Math.max(8, Math.min(width - x, Math.round(width * roi.w)));
  const h = Math.max(8, Math.min(height - y, Math.round(height * roi.h)));
  const bitmap = image.crop({ x, y, width: w, height: h }).resize({ width: 48, height: 27, quality: "fast" }).toBitmap();
  const out = new Uint8Array(Math.floor(bitmap.length / 4));
  for (let src = 0, dst = 0; src + 3 < bitmap.length; src += 4, dst += 1) {
    out[dst] = Math.round((bitmap[src] + bitmap[src + 1] + bitmap[src + 2]) / (3 * 16));
  }
  return out;
}
function fingerprintDistance(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return Infinity;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / (a.length * 15);
}

'''
fp_anchor = '// ── Mining diagnostic frames'
if fp_anchor not in c:
    raise SystemExit("capture: fingerprint insertion anchor missing")
c = c.replace(fp_anchor, fp_helpers + fp_anchor, 1)

# Structural Scan Mode gate: cheap pixels only, no OCR/text/ship colour. It runs immediately after
# capture. The expensive 0.1.41 mining crop is permitted only when this detector says Scan Mode is
# structurally present on the same frame.
scan_helper = '''let _lastArchVerseScanMode = null;
function archVerseScanMode(image, width, height) {
  const normalizedWidth = 960;
  const normalizedHeight = Math.max(240, Math.round(normalizedWidth * height / width));
  const normalized = image.resize({ width: normalizedWidth, height: normalizedHeight, quality: "good" });
  const r = detectScanModeRadarIcon(normalized.toBitmap(), normalizedWidth, normalizedHeight);
  if (_lastArchVerseScanMode !== r.active) {
    _lastArchVerseScanMode = r.active;
    console.log(`[mining-scan-mode] ${r.active ? "active (radar icon)" : "inactive"} confidence=${r.confidence || 0} method=${r.method || "structure"} score=${r.templateScore || 0}${r.rejectionReason ? ` rejected=${r.rejectionReason}` : ""}`);
  }
  return r;
}

'''
scan_anchor = '// ── Mining diagnostic frames'
c = c.replace(scan_anchor, scan_helper + scan_anchor, 1)

shot_old = '''      const shot = cap && cap.image;
      if (!shot) return;
      stage.capture = Date.now() - t0;'''
shot_new = '''      const shot = cap && cap.image;
      if (!shot) return;
      let archScanModeRead = { active: false, confidence: 0, method: "not-armed" };
      if (mining) {
        try { archScanModeRead = archVerseScanMode(shot, cap.width, cap.height); }
        catch (e) { console.warn("[mining-scan-mode] detector failed:", e?.message || e); }
      }
      if (!archScanModeRead.active) { sigBox = null; sigBoxAt = 0; }
      stage.scanMode = archScanModeRead.active;
      stage.capture = Date.now() - t0;'''
if shot_old not in c:
    raise SystemExit("capture: post-capture gate anchor missing")
c = c.replace(shot_old, shot_new, 1)

# No upstream foreground watcher on Linux: exact StarCitizen session binding above is the privacy
# gate. Removing this call also guarantees we never keep an unrelated helper alive just for OCR.
c = c.replace('    fgWatch.want("ocr", fab || miss || mining || claim);\n', '')

# Locked crop and all mining RapidOCR work are contingent on structural Scan Mode.
c = c.replace('const locked = mining && sigBox && Date.now() - sigBoxAt < SIG_LOCK_MS;',
              'const locked = mining && archScanModeRead.active && sigBox && Date.now() - sigBoxAt < SIG_LOCK_MS;', 1)

# Generic whole-frame OCR is still needed for missions/fabricator/claims. If mining is the ONLY
# armed feature and Scan Mode is off, do not OCR the screen at all; that is the Alpha17 promise that
# Mining Analysis/signature OCR stays dormant outside Scan Mode.
generic_old = '      let read = { kind: "none" };\n      if (!locked) {'
generic_new = '''      let read = { kind: "none" };
      const needGeneric = fab || miss || claim || (mining && archScanModeRead.active);
      if (!locked && needGeneric) {'''
if generic_old not in c:
    raise SystemExit("capture: generic OCR gate anchor missing")
c = c.replace(generic_old, generic_new, 1)

# When another feature legitimately needs the generic pass, never let a whole-frame mining false
# positive escape while structural Scan Mode is off.
read_json = '          read = await resp.json();\n          stage.winOcr = Date.now() - t2;'
read_json_new = '''          read = await resp.json();
          if (mining && !archScanModeRead.active && (read?.kind === "mineable" || typeof read?.signature === "number")) {
            read = { kind: "none" };
          }
          stage.winOcr = Date.now() - t2;'''
if read_json not in c:
    raise SystemExit("capture: generic read result anchor missing")
c = c.replace(read_json, read_json_new, 1)

c = c.replace('if (mining && cfg.rapidOcr !== false) {',
              'if (mining && archScanModeRead.active && cfg.rapidOcr !== false) {', 1)
c = c.replace('else if (mining && (read.scanHud || typeof read.signature === "number")) fastUntil = Date.now() + FAST_WINDOW_MS;',
              'else if (mining && archScanModeRead.active && (read.scanHud || typeof read.signature === "number")) fastUntil = Date.now() + FAST_WINDOW_MS;', 1)

# Export a tiny pure test surface. Requiring capture.cjs now evaluates every helper reference, which
# catches the exact startup regression that node --check could not.
exports_old = 'module.exports = { startFabCapture, centerTighten, findScanGlyph, GLYPH };'
exports_new = 'module.exports = { startFabCapture, centerTighten, findScanGlyph, GLYPH, __test: { classifyLinuxForeground, cleanX11Field, visualFingerprint, fingerprintDistance } };'
if exports_old not in c:
    raise SystemExit("capture: module.exports anchor missing")
c = c.replace(exports_old, exports_new, 1)

(work / "electron/capture.cjs").write_text(c)

print("[alpha18-repair] semantic reconstruction complete: main/preload/capture")
