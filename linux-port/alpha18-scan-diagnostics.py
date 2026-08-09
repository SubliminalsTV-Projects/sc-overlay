#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 4:
    raise SystemExit("usage: alpha18-scan-diagnostics.py WORK_DIR UPSTREAM_DIR ALPHA17_APP_DIR")
work = Path(sys.argv[1])
cap = work / "electron/capture.cjs"
s = cap.read_text()

# Put every capture diagnostic under the canonical per-user config directory on Linux. The old
# upstream fallback wrote to /tmp when APPDATA was absent, which made evidence disappear between
# sessions and was especially unhelpful for intermittent Scan Mode false positives.
old_dir = 'const DEBUG_FRAME_DIR = path.join(process.env.APPDATA || os.tmpdir(), "sc-blueprint-tracker", "debug-frames");'
new_dir = 'const DEBUG_FRAME_DIR = path.join(process.env.SC_TRACKER_CONFIG_DIR || process.env.APPDATA || path.join(process.env.HOME || os.tmpdir(), "sc-blueprint-tracker"), "debug-frames");'
if old_dir in s:
    s = s.replace(old_dir, new_dir, 1)
elif new_dir not in s:
    raise SystemExit("scan diagnostics: DEBUG_FRAME_DIR anchor missing")

# Replace the terse state-only logger with a diagnostic fingerprint logger. A score can change from
# a true control to a false lookalike while `active` stays false, so logging only active/inactive hid
# the information needed to tune the structural detector.
old_gate = '''let _lastArchVerseScanMode = null;
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
new_gate = '''let _lastArchVerseScanDiagnostic = "";
function scanModeDiagnosticKey(r) {
  const roi = r?.roi || {};
  const roiKey = [roi.x, roi.y, roi.w, roi.h].map((v) => Number.isFinite(v) ? Number(v).toFixed(4) : "-").join(",");
  return [r?.active ? 1 : 0, r?.confidence || 0, r?.referenceAngle || 0, r?.templateScore || 0,
    r?.iconRecall || 0, r?.labelRecall || 0, r?.haloDensity || 0, r?.rejectionReason || "accepted", roiKey].join("|");
}
function archVerseScanMode(image, width, height) {
  const normalizedWidth = 960;
  const normalizedHeight = Math.max(240, Math.round(normalizedWidth * height / width));
  const normalized = image.resize({ width: normalizedWidth, height: normalizedHeight, quality: "good" });
  const r = detectScanModeRadarIcon(normalized.toBitmap(), normalizedWidth, normalizedHeight);
  const key = scanModeDiagnosticKey(r);
  if (key !== _lastArchVerseScanDiagnostic) {
    _lastArchVerseScanDiagnostic = key;
    const roi = r?.roi || {};
    const roiKey = [roi.x, roi.y, roi.w, roi.h].map((v) => Number.isFinite(v) ? Number(v).toFixed(4) : "-").join(",");
    console.log(`[mining-scan-mode] ${r.active ? "active (radar icon)" : "inactive"}` +
      ` confidence=${r.confidence || 0}` +
      ` method=${r.method || "structure"}` +
      ` score=${r.templateScore || 0}` +
      ` icon=${r.iconRecall || 0}` +
      ` label=${r.labelRecall || 0}` +
      ` halo=${r.haloDensity || 0}` +
      `${r.rejectionReason ? ` rejected=${r.rejectionReason}` : ""}` +
      `${roiKey !== "-,-,-,-" ? ` roi=${roiKey}` : ""}`);
  }
  return r;
}
'''
if old_gate in s:
    s = s.replace(old_gate, new_gate, 1)
elif 'function scanModeDiagnosticKey(' not in s:
    raise SystemExit("scan diagnostics: archVerseScanMode logger anchor missing")

# Bounded exact/context snapshots are intentionally separate from signature-crop diagnostics. They
# preserve the pixels that made the gate decision and a wider surrounding HUD field. Slots are
# overwritten in a fixed ring, so enabling diagnostics cannot grow disk use without bound.
insert_anchor = '''function saveDebugFrame(magnified, raw) {
  fs.mkdirSync(DEBUG_FRAME_DIR, { recursive: true });
  const n = String(++debugFrameSeq).padStart(4, "0");
  fs.writeFileSync(path.join(DEBUG_FRAME_DIR, `crop-${n}-magnified.png`), magnified.toPNG());
  fs.writeFileSync(path.join(DEBUG_FRAME_DIR, `crop-${n}-raw.png`), raw.toPNG());
  // Prune oldest by name — the sequence is monotonic, so lexical order IS chronological.
  const files = fs.readdirSync(DEBUG_FRAME_DIR).filter((f) => f.endsWith(".png")).sort();
  while (files.length > DEBUG_FRAME_MAX * 2) {
    try { fs.unlinkSync(path.join(DEBUG_FRAME_DIR, files.shift())); } catch { /* raced */ }
  }
}
'''
addition = insert_anchor + '''
const SCAN_MODE_DEBUG_RECENT_LIMIT = 8;
const SCAN_MODE_DEBUG_REFRESH_MS = 15000;
let scanModeDebugSequence = 0;
let lastSavedScanModeDiagnostic = "";
let lastSavedScanModeAt = 0;
function saveScanModeDebugFrame(shot, read, trigger) {
  try {
    const roi = read?.roi || {};
    if (![roi.x, roi.y, roi.w, roi.h].every(Number.isFinite)) return false;
    const size = shot.getSize();
    const box = {
      x: Math.max(0, Math.min(size.width - 1, Math.floor(size.width * roi.x))),
      y: Math.max(0, Math.min(size.height - 1, Math.floor(size.height * roi.y))),
      width: Math.max(1, Math.round(size.width * roi.w)),
      height: Math.max(1, Math.round(size.height * roi.h)),
    };
    box.width = Math.min(box.width, size.width - box.x);
    box.height = Math.min(box.height, size.height - box.y);
    const marginX = Math.max(box.width * 2, Math.round(size.width * 0.02));
    const marginY = Math.max(box.height, Math.round(size.height * 0.02));
    const cx = Math.max(0, box.x - marginX);
    const cy = Math.max(0, box.y - marginY);
    const context = {
      x: cx, y: cy,
      width: Math.min(size.width, box.x + box.width + marginX) - cx,
      height: Math.min(size.height, box.y + box.height + marginY) - cy,
    };
    fs.mkdirSync(DEBUG_FRAME_DIR, { recursive: true });
    const slot = String(scanModeDebugSequence++ % SCAN_MODE_DEBUG_RECENT_LIMIT).padStart(2, "0");
    const exact = shot.crop(box).resize({ width: Math.min(480, Math.max(120, box.width * 4)), quality: "best" });
    const around = shot.crop(context).resize({ width: Math.min(960, Math.max(360, context.width * 2)), quality: "best" });
    const exactPng = exact.toPNG();
    const contextPng = around.toPNG();
    fs.writeFileSync(path.join(DEBUG_FRAME_DIR, `scan-mode-match-${slot}.png`), exactPng);
    fs.writeFileSync(path.join(DEBUG_FRAME_DIR, `scan-mode-context-${slot}.png`), contextPng);
    fs.writeFileSync(path.join(DEBUG_FRAME_DIR, "latest-scan-mode-match.png"), exactPng);
    fs.writeFileSync(path.join(DEBUG_FRAME_DIR, "latest-scan-mode-context.png"), contextPng);
    const payload = { at: new Date().toISOString(), trigger, read, box, context };
    fs.writeFileSync(path.join(DEBUG_FRAME_DIR, `scan-mode-read-${slot}.json`), JSON.stringify(payload, null, 2) + "\\n");
    fs.writeFileSync(path.join(DEBUG_FRAME_DIR, "latest-scan-mode-read.json"), JSON.stringify(payload, null, 2) + "\\n");
    console.log(`[mining-scan-mode] diagnostic slot=${slot} saved (${trigger})`);
    return true;
  } catch (error) {
    console.warn("[mining-scan-mode] unable to save diagnostic frame:", error?.message || error);
    return false;
  }
}
'''
if insert_anchor in s and 'function saveScanModeDebugFrame(' not in s:
    s = s.replace(insert_anchor, addition, 1)
elif 'function saveScanModeDebugFrame(' not in s:
    raise SystemExit("scan diagnostics: debug-frame insertion anchor missing")

# Save on a changed structural match and refresh active evidence every 15 seconds. This is opt-in in
# normal use via miningDebug or SCBT_MINING_DEBUG=1, but the richer text log above is always cheap.
old_read = '''      if (mining) {
        try { archScanModeRead = archVerseScanMode(shot, cap.width, cap.height); }
        catch (e) { console.warn("[mining-scan-mode] detector failed:", e?.message || e); }
      }
'''
new_read = '''      if (mining) {
        try {
          archScanModeRead = archVerseScanMode(shot, cap.width, cap.height);
          const scanDebugEnabled = cfg.miningDebug === true || process.env.SCBT_MINING_DEBUG === "1";
          if (scanDebugEnabled) {
            const diagnosticFingerprint = scanModeDiagnosticKey(archScanModeRead);
            const diagnosticChanged = diagnosticFingerprint !== lastSavedScanModeDiagnostic;
            const activeRefreshDue = archScanModeRead.active
              && Date.now() - lastSavedScanModeAt >= SCAN_MODE_DEBUG_REFRESH_MS;
            if (diagnosticChanged || activeRefreshDue) {
              const trigger = diagnosticChanged ? "scan-mode-match-change" : "scan-mode-active-refresh";
              if (saveScanModeDebugFrame(shot, archScanModeRead, trigger)) {
                lastSavedScanModeDiagnostic = diagnosticFingerprint;
                lastSavedScanModeAt = Date.now();
              }
            }
          }
        } catch (e) { console.warn("[mining-scan-mode] detector failed:", e?.message || e); }
      }
'''
if old_read in s:
    s = s.replace(old_read, new_read, 1)
elif 'scan-mode-match-change' not in s:
    raise SystemExit("scan diagnostics: mining gate call anchor missing")

# Upstream restricted diagnostic crops to dev builds. On Linux this feature is explicitly opt-in,
# local, and bounded, so a packaged build must be able to collect evidence too.
s = s.replace('if (devTools && cfg.miningDebug === true) { try { saveDebugFrame(big, crop); } catch { /* best effort */ } }',
              'if (cfg.miningDebug === true || process.env.SCBT_MINING_DEBUG === "1") { try { saveDebugFrame(big, crop); } catch { /* best effort */ } }', 1)

cap.write_text(s)

# The sidecar owns persisted config and its local debug-frame browser endpoint. Let Linux packaged
# builds opt into miningDebug; Windows production keeps the developer-only restriction. The frame
# endpoint remains localhost-only through fromThisMachine(req).
server = work / "src/overlay-server.ts"
ss = server.read_text()
old_cfg = 'if (typeof body.miningDebug === "boolean") config.miningDebug = body.miningDebug && process.env.SC_DEV === "1";'
new_cfg = 'if (typeof body.miningDebug === "boolean") config.miningDebug = body.miningDebug && (process.env.SC_DEV === "1" || process.platform === "linux");'
if old_cfg in ss:
    ss = ss.replace(old_cfg, new_cfg, 1)
elif new_cfg not in ss:
    raise SystemExit("scan diagnostics: miningDebug config anchor missing")
old_guard = 'if (process.env.SC_DEV !== "1" || !fromThisMachine(req)) {'
new_guard = 'if ((process.env.SC_DEV !== "1" && process.platform !== "linux") || !fromThisMachine(req)) {'
# Restrict replacement to the mining debug-frame endpoint, not any unrelated dev endpoint.
pos = ss.find('url.startsWith("/api/mining/debug-frame")')
if pos < 0:
    raise SystemExit("scan diagnostics: debug-frame endpoint missing")
guard_pos = ss.find(old_guard, pos)
if guard_pos >= 0:
    ss = ss[:guard_pos] + new_guard + ss[guard_pos + len(old_guard):]
elif ss.find(new_guard, pos, pos + 800) < 0:
    raise SystemExit("scan diagnostics: debug-frame guard anchor missing")
server.write_text(ss)

print("[alpha18-scan-diagnostics] persistent bounded Linux Scan Mode diagnostics PASS")
