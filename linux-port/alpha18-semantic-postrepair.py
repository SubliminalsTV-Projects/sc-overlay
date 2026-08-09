#!/usr/bin/env python3
from pathlib import Path
import re
import sys

if len(sys.argv) != 4:
    raise SystemExit("usage: alpha18-semantic-postrepair.py WORK_DIR UPSTREAM_DIR ALPHA17_APP_DIR")
work = Path(sys.argv[1])

# -----------------------------------------------------------------------------
# main.cjs — normalize lifecycle/runtime seams after semantic reconstruction.
# -----------------------------------------------------------------------------
main = work / "electron/main.cjs"
s = main.read_text()

# The old diff3 intermediate needed this final `});` to compensate for a missing close much earlier
# in the file. Semantic reconstruction now closes that earlier canvas-info handler correctly, so the
# compensating token becomes a real syntax error. Remove it at the exact app-lifecycle tail only.
tail_bad = '''  app.on("will-quit", () => { if (trayIsUsable()) tray.destroy(); tray=null;  });
  });
}
'''
tail_good = '''  app.on("will-quit", () => { if (trayIsUsable()) tray.destroy(); tray=null;  });
}
'''
if tail_bad in s:
    s = s.replace(tail_bad, tail_good, 1)
elif tail_good not in s:
    raise SystemExit("main postrepair: app lifecycle tail not recognized")

# Upstream's foreground watcher is a Windows helper. Alpha17 deliberately guarded it; on Linux the
# exact StarCitizen.exe/Gamescope session binder is the foreground/privacy authority instead.
fg_block = '''    foreground.onChange(() => {
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
'''
fg_guarded = '''    if (process.platform === "win32") {
      foreground.onChange(() => {
        applyMouse();
        try {
          if (overlay && !overlay.isDestroyed()) {
            overlay.webContents.send("overlay:game-focus", foreground.gameInFront());
          }
        } catch { /* window gone */ }
      });
    }
'''
if fg_block in s:
    s = s.replace(fg_block, fg_guarded, 1)
elif fg_guarded not in s:
    raise SystemExit("main postrepair: foreground watcher seam not recognized")

# 0.1.41 explicitly separates the Mining feature opt-in (miningAssistant) from whether its widget is
# currently open (miningOpen). Showing/hiding a widget must never silently enable/disable OCR.
s = s.replace('''  // 0.1.41 only runs mining capture while the assistant is armed; keep that flag authoritative.
  void postConfig({ miningAssistant: miningVisible });
''', '', 1)

# Runtime invariants discovered during Alpha18 field testing.
required = [
    'function sidecarLogStream()',
    'function setMiningVisible(',
    'function sendBindingChartVisible(',
    'function setBindingChartVisible(',
    'function toggleBindingChart(',
    'function toggleWebView(',
    'function restartAsAdmin()',
    'const restore = {',
]
for token in required:
    if token not in s:
        raise SystemExit(f"main postrepair: required runtime contract missing: {token}")
if 'fs.closeSync(fd);' in s:
    raise SystemExit("main postrepair: stale sidecar fd close survived")
if 'setArrangeAll(' in s:
    raise SystemExit("main postrepair: orphaned setArrangeAll call survived")
if 'void postConfig({ miningAssistant: miningVisible });' in s:
    raise SystemExit("main postrepair: widget visibility still mutates mining feature opt-in")
if s.count('ipcMain.handle("app:widget-states"') != 1:
    raise SystemExit("main postrepair: app:widget-states handler must be unique")
if s.count('ipcMain.handle("overlay:canvas-info"') != 1:
    raise SystemExit("main postrepair: overlay:canvas-info handler must be unique")
if s.count('ipcMain.handle("overlay:reset-layout"') != 1:
    raise SystemExit("main postrepair: overlay:reset-layout handler must be unique")

main.write_text(s)

# -----------------------------------------------------------------------------
# capture.cjs — ensure only the isolated RapidOCR implementation survives.
# -----------------------------------------------------------------------------
cap = work / "electron/capture.cjs"
c = cap.read_text()

# Semantic reconstruction replaces upstream's native RapidOCR block, but its actual function sits
# after the diagnostic-frame helper in 0.1.41. Remove that later declaration explicitly. In sloppy
# CommonJS a later function declaration silently wins, so leaving it is a runtime bug even though
# node --check succeeds.
direct_rapid = '''async function ocrRapidLines(imgPath) {
  const ocr = await getRapid();
  const res = await ocr.detect(imgPath);
  return (res || []).map((r) => {
    const xs = r.box.map((pt) => pt[0]), ys = r.box.map((pt) => pt[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { text: String(r.text || ""), x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  });
}

'''
if direct_rapid in c:
    c = c.replace(direct_rapid, '', 1)

# Cosmetic duplicated marker created when an end anchor was included in the replacement text.
c = c.replace('// ── Mining diagnostic frames// ── Mining diagnostic frames (opt-in, config.miningDebug) ────────────────────────────────────',
              '// ── Mining diagnostic frames (opt-in, config.miningDebug) ────────────────────────────────────', 1)

if c.count('async function ocrRapidLines(imgPath)') != 1:
    raise SystemExit(f"capture postrepair: expected one ocrRapidLines, found {c.count('async function ocrRapidLines(imgPath)')}")
if 'getRapid()' in c or 'let _rapid =' in c:
    raise SystemExit("capture postrepair: direct native RapidOCR implementation survived")
for token in [
    'createRapidOcrClient',
    'getStarCitizenSessionBinder',
    'detectScanModeRadarIcon',
    'function archVerseScanMode(',
    'function visualFingerprint(',
    'function fingerprintDistance(',
    'archScanModeRead.active',
]:
    if token not in c:
        raise SystemExit(f"capture postrepair: required Linux/mining contract missing: {token}")
if 'fgWatch.want(' in c:
    raise SystemExit("capture postrepair: upstream foreground watcher survived Linux reconstruction")

cap.write_text(c)

# -----------------------------------------------------------------------------
# preload.cjs — a duplicate API property silently overwrites the first one.
# -----------------------------------------------------------------------------
pre = work / "electron/preload.cjs"
p = pre.read_text()
if p.count('setTwitchChat:') != 1:
    raise SystemExit(f"preload postrepair: setTwitchChat property count is {p.count('setTwitchChat:')}, expected 1")
pre.write_text(p)

print("[alpha18-postrepair] runtime seam normalization PASS")
