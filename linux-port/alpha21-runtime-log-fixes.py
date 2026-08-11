#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: alpha21-runtime-log-fixes.py PACKAGE_OR_WORK_ROOT')
root = Path(sys.argv[1])
paths = [root/'app/electron/capture.cjs', root/'electron/capture.cjs']
p = next((x for x in paths if x.exists()), None)
if not p:
    raise SystemExit('capture.cjs not found under package/work root')
s = p.read_text()

old_wait = '''async function waitForCaptureFile(filePath, timeoutMs = 2500) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (fs.statSync(filePath).size > 0) return true;
    } catch {}
    await delay(100);
  }
  return false;
}
'''
new_wait = '''async function waitForCaptureFile(filePath, timeoutMs = 6000) {
  const until = Date.now() + timeoutMs;
  let lastSize = -1;
  let stablePolls = 0;
  while (Date.now() < until) {
    try {
      const size = fs.statSync(filePath).size;
      if (size > 0) {
        if (size === lastSize) stablePolls += 1;
        else { lastSize = size; stablePolls = 0; }
        // KDE's screenshot portal can return before the PNG writer is fully closed. Require the
        // size to stop changing, then prove Electron can decode it before accepting the frame.
        if (stablePolls >= 1) {
          const image = nativeImage.createFromPath(filePath);
          if (image && !image.isEmpty()) return image;
        }
      }
    } catch {}
    await delay(100);
  }
  return null;
}
'''
if old_wait not in s:
    raise SystemExit('Spectacle waitForCaptureFile anchor changed')
s = s.replace(old_wait, new_wait, 1)

old_spectacle = '''  if (!(await waitForCaptureFile(spectacleCapturePath))) {
    throw new Error("Spectacle returned before a screenshot file became available");
  }
  const full = nativeImage.createFromPath(spectacleCapturePath);
  if (!full || full.isEmpty()) throw new Error("Spectacle created no usable screenshot");
'''
new_spectacle = '''  const full = await waitForCaptureFile(spectacleCapturePath);
  if (!full || full.isEmpty()) {
    throw new Error("Spectacle returned before a complete decodable screenshot became available");
  }
'''
if old_spectacle not in s:
    raise SystemExit('Spectacle decode anchor changed')
s = s.replace(old_spectacle, new_spectacle, 1)

old_consts = '''  let busy = false;
  let busyAt = 0;             // when the current tick set busy (watchdog against a wedged loop)
  const TICK_WATCHDOG_MS = 15000; // if a tick has "held" busy this long, it hung — force re-arm
'''
new_consts = '''  let busy = false;
  let busyAt = 0;             // when the current tick set busy (watchdog against a wedged loop)
  let lastSlowTickLogAt = 0;  // throttle diagnostics while one native/OCR cycle is still draining
  const TICK_WATCHDOG_MS = 15000; // report a slow tick, but never overlap its native image/OCR work
'''
if old_consts not in s:
    raise SystemExit('watchdog constant anchor changed')
s = s.replace(old_consts, new_consts, 1)

old_watchdog = '''    // Watchdog: a single hung await (e.g. a fetch to the sidecar while it's restarting during an
    // auto-update) must never latch the loop forever. If a prior tick has held `busy` well past
    // any real tick, treat it as wedged and re-arm — otherwise the overlay freezes on its last
    // message ("Reading the fabricator…") until the app restarts.
    if (busy) {
      if (Date.now() - busyAt < TICK_WATCHDOG_MS) return;
      console.warn("[fab-capture] tick watchdog: a prior tick hung — re-arming the loop");
      busy = false;
    }
'''
new_watchdog = '''    // Never start a second capture/OCR cycle while the first still owns native image objects.
    // Clearing `busy` from a watchdog leaves the first async tick alive and can overlap
    // RapidOCR/sharp/libvips work. Report a slow cycle and skip this interval instead; the
    // original tick's finally block is the only place allowed to unlock the loop.
    if (busy) {
      const elapsed = Date.now() - busyAt;
      if (elapsed >= TICK_WATCHDOG_MS && Date.now() - lastSlowTickLogAt >= TICK_WATCHDOG_MS) {
        lastSlowTickLogAt = Date.now();
        console.warn(`[fab-capture] prior OCR tick still running after ${Math.round(elapsed / 1000)}s; skipping overlap (RapidOCR queue=${rapidOcrClient.queueDepth()})`);
      }
      return;
    }
'''
if old_watchdog not in s:
    raise SystemExit('watchdog logic anchor changed')
s = s.replace(old_watchdog, new_watchdog, 1)

marker = '''      if (mining) {
        tickStages.push({ total: lastTickMs, ...stage });
        if (tickStages.length > TICK_STAGES_MAX) tickStages.shift();
      }
      busy = false;
    }
  }
'''
replacement = '''      if (mining) {
        tickStages.push({ total: lastTickMs, ...stage });
        if (tickStages.length > TICK_STAGES_MAX) tickStages.shift();
      }
      busy = false;
      lastSlowTickLogAt = 0;
    }
  }
'''
if marker not in s:
    raise SystemExit('watchdog finally anchor changed')
s = s.replace(marker, replacement, 1)

p.write_text(s)
print('[alpha21-log-fixes] safe OCR watchdog + robust Spectacle file readiness applied')
