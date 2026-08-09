#!/usr/bin/env bash
set -euo pipefail

RUN_TMP="${RUNNER_TEMP:-/tmp}"
WORK="$RUN_TMP/r31-alpha18-build/work"
A17_PARENT="$RUN_TMP/r31-alpha18-build/alpha17"
A17="$(find "$A17_PARENT" -mindepth 1 -maxdepth 1 -type d | head -n1)"
TAR="$RUN_TMP/dist/ArchVerse-Overlay-0.1.41-r31-alpha.18-arch.tar.gz"
TMP="$RUN_TMP/alpha18-linux-contract-audit"
rm -rf "$TMP"
mkdir -p "$TMP/tests" "$TMP/package"

[[ -d "$WORK/electron" ]] || { echo '[linux-contract] generated work tree missing' >&2; exit 100; }
[[ -d "$A17/tests" ]] || { echo '[linux-contract] released Alpha17 tests missing' >&2; exit 101; }
[[ -f "$TAR" ]] || { echo '[linux-contract] generated package missing' >&2; exit 102; }
tar -xzf "$TAR" -C "$TMP/package"
PKG="$(find "$TMP/package" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[[ -f "$PKG/app/electron/main.cjs" ]] || { echo '[linux-contract] packaged app missing' >&2; exit 103; }

# Re-run the Alpha17 tests whose behavioral contracts remain directly applicable to 0.1.41. They
# are copied under the generated source tree so tests that resolve `../electron` from __dirname test
# the candidate, not the baseline archive they came from.
for name in \
  r31-alpha2-session-binding.test.cjs \
  r31-alpha4-region-handshake.test.cjs \
  r31-alpha9-stable-interaction.test.cjs \
  r31-alpha10-verified-handoff.test.cjs \
  r31-alpha11-idle-pointer-pin.test.cjs \
  r31-alpha12-explicit-ownership.test.cjs \
  r31-alpha16-radar-and-click-forwarding.test.cjs; do
  cp "$A17/tests/$name" "$TMP/tests/$name"
done

# Alpha2 resolves ../electron from its own location; put that one inside WORK/tests for execution.
mkdir -p "$WORK/tests-linux-contract"
cp "$TMP/tests/r31-alpha2-session-binding.test.cjs" "$WORK/tests-linux-contract/"
node --test "$WORK/tests-linux-contract/r31-alpha2-session-binding.test.cjs"
for name in \
  r31-alpha4-region-handshake.test.cjs \
  r31-alpha9-stable-interaction.test.cjs \
  r31-alpha10-verified-handoff.test.cjs \
  r31-alpha11-idle-pointer-pin.test.cjs \
  r31-alpha12-explicit-ownership.test.cjs \
  r31-alpha16-radar-and-click-forwarding.test.cjs; do
  node "$TMP/tests/$name" "$WORK"
done
rm -rf "$WORK/tests-linux-contract"

# The Alpha17 Scan Mode test contains the exact four labeled fixtures captured during calibration.
# Keep those fixture pixels verbatim, but update only the diagnostics-source assertions to the new
# bounded PNG ring names used by Alpha18. This lets the actual detector regression corpus survive
# an upstream architecture change without freezing us to obsolete diagnostic implementation text.
python3 - "$A17/tests/r31-alpha17-scan-structure.test.cjs" "$TMP/tests/scan-structure-current.cjs" <<'PY'
from pathlib import Path
import sys
src=Path(sys.argv[1]).read_text()
a=src.index('// Diagnostics retain the exact match')
b=src.index('const WIDTH = 960;', a)
new=r'''// Alpha18 keeps the same structural metrics and restores a bounded packaged diagnostic ring.
assert.match(captureSource, /scan-mode-context-\$\{slot\}\.png/);
assert.match(captureSource, /scan-mode-match-change/);
assert.match(captureSource, /scan-mode-active-refresh/);
assert.match(captureSource, /r\?\.iconRecall|r\.iconRecall/);
assert.match(captureSource, /r\?\.labelRecall|r\.labelRecall/);
assert.match(captureSource, /r\?\.haloDensity|r\.haloDensity/);
assert.match(captureSource, /rejectionReason/);
assert.match(captureSource, /SC_TRACKER_CONFIG_DIR/);

'''
Path(sys.argv[2]).write_text(src[:a]+new+src[b:])
PY
node "$TMP/tests/scan-structure-current.cjs" "$WORK"
node "$TMP/tests/scan-structure-current.cjs" "$PKG"

# Current architecture assertions: preserve semantics even when upstream changes the literal source
# shape. These are deliberately about user-visible Linux contracts, not implementation trivia.
cat > "$TMP/current-contract.cjs" <<'NODE'
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const source = fs.existsSync(path.join(root,"electron/main.cjs"));
const read=(a,b)=>fs.readFileSync(path.join(root, source?a:b),"utf8");
const main=read("electron/main.cjs","app/electron/main.cjs");
const cap=read("electron/capture.cjs","app/electron/capture.cjs");
const client=read("electron/rapidocr-client.cjs","app/electron/rapidocr-client.cjs");
const worker=read("electron/rapidocr-worker.cjs","app/electron/rapidocr-worker.cjs");
const gate=read("electron/scan-mode-gate.cjs","app/electron/scan-mode-gate.cjs");
const configPage=read("overlay/config.html","app/server/overlay/config.html");

// Mandatory Linux interaction controls are platform-owned, not inherited from an upstream config.
assert.match(main, /process\.platform === "linux" \? "Shift\+F6" : "Ctrl\+Alt\+M"/);
assert.match(main, /process\.platform === "linux"\) \{ fHoverEnabled = true; holdMode = true; interactKey = "F"; moveKey = "Shift\+F6"; \}/);
assert.match(main, /registerInteractHotkey\(registeredInteractKey\)/);
assert.match(main, /interaction gate \$\{registeredInteractKey\} registered before overlay creation/);
assert.match(main, /LINUX_HARD_CLICK_THROUGH/);
assert.match(main, /overlayWindows\.register\("Overlay Manager", overlay\)/);
assert.match(main, /overlayWindows\.pin\(overlay\)/);

// Settings must visibly present the same immutable Linux controls the shell and sidecar enforce.
// It may not pretend Shift+F6 is editable and then silently repair a different value on save.
assert.match(configPage, /setHotkeyDisplay\("interact", "F"\)/);
assert.match(configPage, /document\.getElementById\("interactHotkeyBtn"\)\.disabled = true/);
assert.match(configPage, /setHotkeyDisplay\("move", "Shift\+F6"\)/);
assert.match(configPage, /document\.getElementById\("moveHotkeyBtn"\)\.disabled = true/);
assert.match(configPage, /document\.getElementById\("moveHotkeyClear"\)\.style\.display = "none"/);
assert.match(configPage, /which === "move"[\s\S]{0,120}"Shift\+F6"/);
assert.match(configPage, /which === "interact" \|\| which === "move"/);

// OCR isolation and resource budgets: no native RapidOCR model is loaded in Electron itself.
assert.match(cap, /createRapidOcrClient/);
assert.doesNotMatch(cap, /getRapid\(\)/);
assert.match(client, /SC_TRACKER_OCR_THREADS: process\.env\.SC_TRACKER_OCR_THREADS \|\| "2"/);
assert.match(client, /OMP_THREAD_LIMIT: process\.env\.OMP_THREAD_LIMIT \|\| "1"/);
assert.match(client, /VIPS_CONCURRENCY: process\.env\.VIPS_CONCURRENCY \|\| "1"/);
assert.match(client, /RapidOCR latest-frame queue is full/);
assert.match(worker, /intraOpNumThreads: OCR_THREADS/);
assert.match(worker, /interOpNumThreads: 1/);
assert.match(worker, /executionMode: "sequential"/);
assert.match(worker, /setPriority\(0, 10\)/);

// Mining work is structurally gated. When Scan Mode is off, the mining-only whole-frame pass,
// signature lock and RapidOCR signature path are all dormant.
assert.match(gate, /radar-icon-structure-search/);
assert.match(cap, /const locked = mining && archScanModeRead\.active && sigBox/);
assert.match(cap, /const needGeneric = fab \|\| miss \|\| claim \|\| \(mining && archScanModeRead\.active\)/);
assert.match(cap, /if \(mining && archScanModeRead\.active && cfg\.rapidOcr !== false\)/);
assert.match(cap, /if \(!archScanModeRead\.active\) \{ sigBox = null; sigBoxAt = 0; \}/);
assert.doesNotMatch(cap, /fgWatch\.want\(/);

// Diagnostics are useful in packaged Linux too and remain bounded/persistent.
assert.match(cap, /scan-mode-match-change/);
assert.match(cap, /scan-mode-active-refresh/);
assert.match(cap, /SCAN_MODE_DEBUG_RECENT_LIMIT = 8/);
assert.match(cap, /latest-scan-mode-context\.png/);
assert.match(cap, /SC_TRACKER_CONFIG_DIR/);

console.log(`Alpha18 current Linux contract PASS (${source?"work":"package"})`);
NODE
node "$TMP/current-contract.cjs" "$WORK"
node "$TMP/current-contract.cjs" "$PKG"

echo '[linux-contract] Alpha17 proven contracts + current Linux invariants PASS'
