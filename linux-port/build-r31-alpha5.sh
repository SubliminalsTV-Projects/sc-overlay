#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP_ROOT="${RUNNER_TEMP:-/tmp}/r31-alpha17-build"
LINUX_DIR="$TMP_ROOT/linux"
CORE_DIR="$TMP_ROOT/core"
BASE_DIR="$TMP_ROOT/base"
CONFLICT_DIR="$TMP_ROOT/conflicts"
OUT="$TMP_ROOT/ArchVerse-Overlay-0.1.36-r31-alpha.17"
DIST="$ROOT/dist"
BASE=5b70715f0958f01ab5d0b79124760c016c9410cd

rm -rf "$TMP_ROOT" "$DIST"
mkdir -p "$LINUX_DIR" "$CORE_DIR" "$BASE_DIR" "$CONFLICT_DIR" "$DIST"

python3 - <<'PY'
from pathlib import Path
import base64
import glob
import re

def decode_parts(pattern: str, output: str) -> None:
    parts = sorted(glob.glob(pattern))
    if not parts:
        raise SystemExit(f"No payload chunks matched: {pattern}")
    encoded = "".join(Path(part).read_text(encoding="utf-8") for part in parts)
    encoded = re.sub(r"[^A-Za-z0-9+/=]", "", encoded)
    encoded += "=" * (-len(encoded) % 4)
    decoded = base64.b64decode(encoded, validate=False)
    Path(output).write_bytes(decoded)
    print(f"Decoded {len(parts)} parts from {pattern}: {len(decoded)} bytes")

decode_parts("linux-port/payload/part-*", "/tmp/r31-alpha17-linux.tar.gz")
decode_parts("linux-port/core/part-*", "/tmp/r31-alpha17-core.tar.gz")
PY

gzip -t /tmp/r31-alpha17-linux.tar.gz
gzip -t /tmp/r31-alpha17-core.tar.gz
tar --no-same-owner -xzf /tmp/r31-alpha17-linux.tar.gz -C "$LINUX_DIR"
tar --no-same-owner -xzf /tmp/r31-alpha17-core.tar.gz -C "$CORE_DIR"
test -s "$LINUX_DIR/electron/window-manager.cjs"
test -s "$LINUX_DIR/electron/linux/star-citizen-session.cjs"
test -s "$CORE_DIR/electron/main.cjs"

merge_one() {
  local file="$1"
  mkdir -p "$BASE_DIR/$(dirname "$file")"
  if git cat-file -e "$BASE:$file" 2>/dev/null && [[ -f "$file" ]]; then
    git show "$BASE:$file" > "$BASE_DIR/$file"
    set +e
    git merge-file -p "$file" "$BASE_DIR/$file" "$CORE_DIR/$file" > "$file.merged"
    local rc=$?
    set -e
    mv "$file.merged" "$file"
    if (( rc > 0 )); then
      cp "$file" "$CONFLICT_DIR/$(basename "$file").conflict"
      echo "Merge conflict in $file" >&2
    elif (( rc < 0 )); then
      echo "Merge failure in $file" >&2
      exit 2
    fi
  else
    cp -a "$CORE_DIR/$file" "$file"
  fi
}

for file in electron/config-preload.cjs electron/mining-preload.cjs; do
  merge_one "$file"
done

cp -a "$CORE_DIR/electron/browser-widget.cjs" electron/browser-widget.cjs
cp -a "$LINUX_DIR/electron/linux" electron/
cp -a "$LINUX_DIR/electron/hotkeys.cjs" electron/hotkeys.cjs
cp -a "$LINUX_DIR/electron/window-manager.cjs" electron/window-manager.cjs
cp -a "$LINUX_DIR/electron/rapidocr-client.cjs" electron/rapidocr-client.cjs
cp -a "$LINUX_DIR/electron/rapidocr-worker.cjs" electron/rapidocr-worker.cjs

if compgen -G "$CONFLICT_DIR/*" >/dev/null; then
  grep -R -n '^<<<<<<<\|^=======\|^>>>>>>>' "$CONFLICT_DIR" >&2 || true
  exit 1
fi

for patch in \
  linux-port/r31-alpha2-hover-pid.patch \
  linux-port/r31-alpha3-dom-widget-hit.patch; do
  git apply --check "$patch"
  git apply "$patch"
done

for patch in \
  linux-port/r31-alpha4-main-handshake.patch \
  linux-port/r31-alpha4-renderer-regions.patch \
  linux-port/r31-alpha5-latched-cursor-shiftf6.patch \
  linux-port/r31-alpha6-prefocus-pointer.patch \
  linux-port/r31-alpha7-global-pointer-hook.patch \
  linux-port/r31-alpha8-gamescope-pointer.patch \
  linux-port/r31-alpha9-stable-interaction.patch \
  linux-port/r31-alpha10-verified-handoff.patch \
  linux-port/r31-alpha11-idle-pointer-pin.patch \
  linux-port/r31-alpha12-explicit-interaction-ownership.patch \
  linux-port/r31-alpha13-efficiency.patch \
  linux-port/r31-alpha14-resource-budget.patch \
  linux-port/r31-alpha15-scan-f-interaction.patch \
  linux-port/r31-alpha16-radar-click-forwarding.patch; do
  git apply --recount --check "$patch"
  git apply --recount "$patch"
done

# This generated patch has exact hunk counts and includes a new compact fixture file. Applying it
# without --recount preserves Git's /dev/null new-file semantics.
git apply --check linux-port/r31-alpha17-scan-structure.patch
git apply linux-port/r31-alpha17-scan-structure.patch

python3 - <<'PY'
from pathlib import Path
import json
pkg = Path("package.json")
data = json.loads(pkg.read_text())
data["version"] = "0.1.36-r31-alpha.17"
data["productName"] = "ArchVerse Overlay"
pkg.write_text(json.dumps(data, indent=2) + "\n")
PY

if grep -R -n '^<<<<<<<\|^=======\|^>>>>>>>' electron overlay; then exit 1; fi
node --check electron/main.cjs
node --check electron/capture.cjs
node --check electron/preload.cjs
node --check electron/hotkeys.cjs
node --check electron/window-manager.cjs
node --check electron/linux/star-citizen-session.cjs
node --check electron/rapidocr-client.cjs
node --check electron/rapidocr-worker.cjs
node --check electron/scan-mode-gate.cjs
node --test test/r31-alpha*.test.cjs

# The source build only needs TypeScript/esbuild. Skipping package lifecycle scripts avoids
# downloading an unused Electron binary; production native/runtime scripts run in OUT/app below.
NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
node --import tsx --test src/*.test.ts
npm run build:server
node test/alpha14-config-e2e.cjs "$ROOT"

mkdir -p "$OUT/app" "$OUT/bin" "$OUT/docs"
cp -a electron "$OUT/app/"
cp -a build/server "$OUT/app/"
mkdir -p "$OUT/app/build"
cp -a build/icon.png "$OUT/app/build/icon.png"

node - "$OUT/app/package.json" <<'NODE'
const fs = require("node:fs");
const out = process.argv[2];
const src = require("./package.json");
fs.writeFileSync(out, JSON.stringify({
  name: "archverse-overlay",
  version: "0.1.36-r31-alpha.17",
  description: "Community Linux port of SC Overlay",
  main: "electron/main.cjs",
  type: "module",
  dependencies: {
    "@gutenye/ocr-node": src.dependencies["@gutenye/ocr-node"],
    "electron-updater": src.dependencies["electron-updater"],
    "uiohook-napi": src.dependencies["uiohook-napi"],
  },
}, null, 2) + "\n");
NODE

# Ship the exact production runtime resolved during CI. Installation should be file-copy work,
# not a lengthy, failure-prone npm download on a player's gaming machine.
(
  cd "$OUT/app"
  NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm install --omit=dev --no-audit --no-fund --package-lock=true
  # This is an x86_64 Arch/CachyOS artifact. npm's ONNX/uiohook packages include every desktop
  # platform and architecture, so discard the unreachable binaries before compression.
  rm -rf \
    node_modules/onnxruntime-node/bin/napi-v6/darwin \
    node_modules/onnxruntime-node/bin/napi-v6/win32 \
    node_modules/onnxruntime-node/bin/napi-v6/linux/arm64 \
    node_modules/uiohook-napi/prebuilds/darwin-arm64 \
    node_modules/uiohook-napi/prebuilds/darwin-x64 \
    node_modules/uiohook-napi/prebuilds/linux-arm64 \
    node_modules/uiohook-napi/prebuilds/linux-loong64 \
    node_modules/uiohook-napi/prebuilds/win32-arm64 \
    node_modules/uiohook-napi/prebuilds/win32-x64
  if [[ "${NPM_CONFIG_IGNORE_SCRIPTS:-false}" != "true" ]]; then
    node -e "import('@gutenye/ocr-node')"
    node -e "require.resolve('uiohook-napi')"
  fi
)

cp -a "$LINUX_DIR/sc-blueprint-tracker" "$OUT/bin/sc-blueprint-tracker"
cp -a "$LINUX_DIR/install-cachyos.sh" "$OUT/install-cachyos.sh"
cp -a "$LINUX_DIR/uninstall-cachyos.sh" "$OUT/uninstall-cachyos.sh"
cp -a "$LINUX_DIR/doctor.sh" "$OUT/doctor.sh"
cp -a "$LINUX_DIR/install-input-access.sh" "$OUT/install-input-access.sh"
cp -a LICENSE.md "$OUT/LICENSE.md"
[[ -f FORK-NOTICE.md ]] && cp FORK-NOTICE.md "$OUT/FORK-NOTICE.md" || true
cp LINUX-PORT-PLAN.md "$OUT/docs/"
cp docs/R31-INPUT-DESIGN.md "$OUT/docs/"
mkdir -p "$OUT/tests"
cp test/r31-alpha*.test.cjs "$OUT/tests/"
cp test/alpha14-config-e2e.cjs "$OUT/tests/"

python3 - "$OUT/install-cachyos.sh" "$OUT/doctor.sh" "$OUT/bin/sc-blueprint-tracker" <<'PY'
from pathlib import Path
import sys

installer = Path(sys.argv[1])
text = installer.read_text()
text = text.replace("0.1.33-r30.2-rapidocr-worker-isolation", "0.1.36-r31-alpha.17")
old_defaults = """data.holdToInteract = true;
data.missionOcr = true;
data.miningAssistant = true;"""
new_defaults = """if (typeof data.holdToInteract !== 'boolean') data.holdToInteract = true;
if (typeof data.interactHotkey !== 'string') data.interactHotkey = 'F';
if (typeof data.moveHotkey !== 'string') data.moveHotkey = 'Shift+F6';
if (typeof data.missionOcr !== 'boolean') data.missionOcr = false;
if (typeof data.miningAssistant !== 'boolean') data.miningAssistant = false;
if (typeof data.fabCapture !== 'boolean') data.fabCapture = false;
if (typeof data.screenReaderProfile !== 'string') data.screenReaderProfile = 'lightweight';"""
if old_defaults not in text:
    raise SystemExit("installer OCR defaults were not found")
text = text.replace(old_defaults, new_defaults, 1)
text = text.replace("packages=(electron42 nodejs npm ", "packages=(electron42 nodejs ")
text = text.replace("for cmd in node npm tesseract", "for cmd in node tesseract")
runtime_start = text.index("RAPID_OCR_READY=0")
runtime_end = text.index("\nfor file in ", runtime_start)
runtime_check = """RAPID_OCR_READY=0
printf 'Checking the bundled Linux RapidOCR runtime...\\n'
if (cd "$INSTALL_DIR/app" && node -e "import('@gutenye/ocr-node').then(() => process.exit(0)).catch(() => process.exit(1))"); then
  RAPID_OCR_READY=1
  printf 'RapidOCR runtime ready.\\n'
else
  printf 'Warning: bundled RapidOCR could not be imported; Tesseract fallback will be used.\\n' >&2
fi
"""
text = text[:runtime_start] + runtime_check + text[runtime_end:]
text = text.replace("Hold F + click", "Press F while the pointer is over a classified widget")
text = text.replace(
    "  Press F while the pointer is over a classified widget = interact with widget controls from any focused window\n"
    "  Ctrl+Alt+M     = move/arrange all visible widgets (upstream workflow)",
    "  F              = enter interaction while the pointer is over a widget\n"
    "  Shift+F6       = move/arrange all visible widgets",
)
text = text.replace("archverse-overlay-r30.2.log", "archverse-overlay-r31-alpha17.log")
text = text.replace("r30.2", "r31 alpha 17")
installer.write_text(text)

doctor = Path(sys.argv[2])
doctor.write_text(doctor.read_text().replace(
    "0.1.33-r30 diagnostics", "0.1.36-r31 alpha 17 diagnostics"))

launcher = Path(sys.argv[3])
launcher_text = launcher.read_text()
old_mode = 'RENDER_MODE="${SC_TRACKER_RENDER_MODE:-software}"'
if old_mode not in launcher_text:
    raise SystemExit("launcher renderer default was not found")
launcher_text = launcher_text.replace(
    old_mode,
    'AUTO_RENDER_MODE=0\n'
    'if [[ -z "${SC_TRACKER_RENDER_MODE:-}" ]]; then AUTO_RENDER_MODE=1; fi\n'
    'RENDER_MODE="${SC_TRACKER_RENDER_MODE:-opengl}"',
    1,
)
launcher_text = launcher_text.replace(
    'export VIPS_CONCURRENCY="${VIPS_CONCURRENCY:-1}"\nexport MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"',
    'export VIPS_CONCURRENCY="${VIPS_CONCURRENCY:-1}"\n'
    'export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"\n'
    'export SC_TRACKER_OCR_THREADS="${SC_TRACKER_OCR_THREADS:-2}"\n'
    'export SC_TRACKER_RAPIDOCR_MAX_QUEUE="${SC_TRACKER_RAPIDOCR_MAX_QUEUE:-2}"\n'
    'export OMP_THREAD_LIMIT="${OMP_THREAD_LIMIT:-1}"\n'
    'export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"\n'
    'export MAGICK_THREAD_LIMIT="${MAGICK_THREAD_LIMIT:-1}"',
    1,
)
launcher_text = launcher_text.replace(
    "# Default to Mesa llvmpipe so the transparent windows can paint reliably. This\n"
    "# affects only SC Blueprint Tracker, not Star Citizen or the rest of the desktop.",
    "# Prefer hardware OpenGL: Alpha 13 measurements reduced Electron rendering CPU by about\n"
    "# 60%. Set SC_TRACKER_RENDER_MODE=software for the retained llvmpipe Safe Mode.",
    1,
)
old_exec = 'printf \'[launcher] renderer mode: %s\\n\' "$RENDER_MODE" >&2\nexec "$ELECTRON_BIN" "${electron_flags[@]}" "$APP_DIR" "$@"'
new_exec = '''printf '[launcher] renderer mode: %s\\n' "$RENDER_MODE" >&2
if [[ "$AUTO_RENDER_MODE" == "1" && "$RENDER_MODE" == "opengl" ]]; then
  set +e
  "$ELECTRON_BIN" "${electron_flags[@]}" "$APP_DIR" "$@"
  renderer_status=$?
  set -e
  if (( renderer_status != 0 )); then
    printf '[launcher] OpenGL exited with status %s; retrying once in software Safe Mode.\\n' "$renderer_status" >&2
    export SC_TRACKER_RENDER_MODE=software
    exec "$SELF" "$@"
  fi
  exit 0
fi
exec "$ELECTRON_BIN" "${electron_flags[@]}" "$APP_DIR" "$@"'''
if old_exec not in launcher_text:
    raise SystemExit("launcher exec block was not found")
launcher_text = launcher_text.replace(old_exec, new_exec, 1)
launcher.write_text(launcher_text)
PY

cat > "$OUT/README.md" <<'DOC'
# ArchVerse Overlay 0.1.36-r31 alpha 17

Arch/CachyOS Scan Mode structure calibration on top of Alpha 16's interaction and resource fixes.

Input behavior:
- Before first focus, the interaction pointer follows Star Citizen's nested Gamescope/XWayland cursor.
- After a widget is entered, the overlay focuses first and verifies the host pointer before changing coordinate sources.
- While that handoff is pending, stale host samples cannot cancel the initial widget latch.
- After compositor motion is verified, that point remains authoritative while the mouse is idle.
- After F is released, coordinate misses cannot revoke interaction ownership; Escape or an external click ends it.
- Move the pointer over a classified overlay widget and press F once.
- F is mandatory on Linux and cannot be disabled by migrated settings or the interaction controls.
- Releasing F leaves that widget interactive, so Twitch Chat, Journal, Web Page forms, and other text inputs can be used normally.
- The session remains interactive across coordinate misses until Escape is pressed or another window takes focus.
- The old second-cursor window is gone; only the compositor/game pointer is visible.
- Physical mouse move/down/up is forwarded into the correct overlay surface when KDE/Gamescope does not deliver a correctly positioned native event.
- Correct native button events are accepted first, so a working input route never double-toggles a control.
- F over empty transparent canvas leaves Star Citizen focused.
- Shift+F6 enters or exits arrange mode for all widgets.
- Right Alt and Ctrl+Alt+M are not used by the Linux build.

Screen reader behavior:
- Uses strict StarCitizen.exe -> Gamescope validation when that ancestry exists.
- Falls back to the exact StarCitizen.exe PID and /proc start time when Wine detaches.
- Lightweight is the fresh-install default; mission, mining, and fabricator reading are explicit opt-ins.
- OCR stages run only after the previous cycle finishes and skip visually unchanged HUD regions.
- The successful capture backend is cached for the session.
- Settings shows the current capture method, processing time, and skipped-stage count.
- Settings and the OCR loop now read the same canonical config file; Alpha 13's legacy file is migrated and backed up once.
- RapidOCR is limited to two ONNX threads; Tesseract and ImageMagick are limited to one thread each.
- A position- and scale-tolerant in-memory search detects the shared radar control across ships.
- The normalized search field comes from paired, explicitly outlined Scan Mode on/off desktop frames.
- Candidates must contain the cone/icon and separated angle label and be isolated from surrounding bright structure.
- Ship type, Prospector HUD color, ping state, target text, and OCR are not Scan Mode inputs.
- Scan Mode gating does not launch RapidOCR; Analysis and Signature OCR stay dormant outside it.
- OCR diagnostics retain eight recent full frames plus enlarged exact/context match crops and structural scores.
- OpenGL is the Linux default; `SC_TRACKER_RENDER_MODE=software` remains the Safe Mode.

This is an alpha. Keep the previous working archive available for rollback.

Install:
    ./install-cachyos.sh --clean-install

Launch with logging:
    sc-blueprint-tracker 2>&1 | tee ~/archverse-overlay-r31-alpha17.log
DOC

cat > "$OUT/verify-alpha.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for f in \
  app/electron/main.cjs \
  app/electron/capture.cjs \
  app/electron/window-manager.cjs \
  app/electron/linux/star-citizen-session.cjs \
  app/electron/rapidocr-client.cjs \
  app/electron/rapidocr-worker.cjs \
  app/electron/scan-mode-gate.cjs \
  app/server/sc-overlay-server.mjs \
  app/node_modules/uiohook-napi/package.json \
  app/node_modules/@gutenye/ocr-node/package.json \
  app/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node \
  app/node_modules/uiohook-napi/prebuilds/linux-x64/uiohook-napi.node \
  install-cachyos.sh \
  bin/sc-blueprint-tracker; do
  [[ -s "$root/$f" ]] || { echo "missing $f" >&2; exit 1; }
done
find "$root/app/electron" -type f \( -name '*.cjs' -o -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
grep -q 'let registeredInteractKey = "F"' "$root/app/electron/main.cjs"
! grep -q 'let registeredInteractKey = "RightAlt"' "$root/app/electron/main.cjs"
grep -q 'let moveKey = "Shift+F6"' "$root/app/electron/main.cjs"
grep -q 'overlayInteractionLatched = true' "$root/app/electron/main.cjs"
! grep -q 'function ensureInteractionCursorWindow' "$root/app/electron/main.cjs"
! grep -q 'INTERACTION_CURSOR_HTML' "$root/app/electron/main.cjs"
grep -q 'stopMouseButtonWatch = hotkeys.onMouseButton' "$root/app/electron/main.cjs"
grep -q 'F_CLICK_NATIVE_GRACE_MS = 28' "$root/app/electron/main.cjs"
grep -q 'scheduleForwardedMouseButton' "$root/app/electron/main.cjs"
grep -q 'nativeMouseReachedTarget' "$root/app/electron/main.cjs"
grep -q 'dispatchInteractionMouse' "$root/app/electron/main.cjs"
grep -q 'requestOverlayRegionSnapshot' "$root/app/electron/main.cjs"
grep -q 'function refreshFHoverPointer' "$root/app/electron/main.cjs"
grep -q 'xdotool-root' "$root/app/electron/main.cjs"
grep -q 'F-down pre-focus' "$root/app/electron/main.cjs"
grep -q 'fHoverHookPointer = { x, y }' "$root/app/electron/main.cjs"
grep -q 'uiohook-global' "$root/app/electron/main.cjs"
grep -q 'stopPointerWatch = hotkeys.onMouseMove' "$root/app/electron/main.cjs"
grep -q 'gamescope-display' "$root/app/electron/main.cjs"
grep -q 'moveHostPointer' "$root/app/electron/main.cjs"
grep -q 'getdisplaygeometry' "$root/app/electron/linux/focus-controller.cjs"
grep -q 'gamescopePointerLocation' "$root/app/electron/window-manager.cjs"
grep -q 'preferHost: true' "$root/app/electron/main.cjs"
grep -q 'F_HOVER_LEAVE_GRACE_MS' "$root/app/electron/main.cjs"
grep -q 'error?.code === "EPIPE"' "$root/app/electron/main.cjs"
grep -q 'beginFHoverHostHandoff' "$root/app/electron/main.cjs"
grep -q 'host pointer handoff verified' "$root/app/electron/main.cjs"
grep -q 'uiohook-host-pinned' "$root/app/electron/main.cjs"
grep -q 'coordinate misses never' "$root/app/electron/main.cjs"
! grep -q 'pointer left classified widget' "$root/app/electron/main.cjs"
grep -q 'completion-scheduled OCR loop armed' "$root/app/electron/capture.cjs"
grep -q 'capture backend cached for this session' "$root/app/electron/capture.cjs"
grep -q 'screenReaderProfile' "$root/app/server/sc-overlay-server.mjs"
grep -q 'process.env.SC_TRACKER_CONFIG_DIR' "$root/app/server/sc-overlay-server.mjs"
grep -q 'radar-icon-structure-search' "$root/app/electron/scan-mode-gate.cjs"
grep -q 'missing-angle-label' "$root/app/electron/scan-mode-gate.cjs"
grep -q 'match-not-isolated' "$root/app/electron/scan-mode-gate.cjs"
grep -q 'match-context-${recentSlot}.jpg' "$root/app/electron/capture.cjs"
grep -q 'SCAN_MODE_RADAR_SEARCH_ROI' "$root/app/electron/capture.cjs"
grep -q 'RADAR_REFERENCE_BITS' "$root/app/electron/scan-mode-gate.cjs"
! grep -qi 'prospector' "$root/app/electron/scan-mode-gate.cjs"
! grep -q 'prospector-hud-color' "$root/app/electron/capture.cjs"
grep -q 'fHoverEnabled = true' "$root/app/electron/main.cjs"
grep -q 'intraOpNumThreads: OCR_THREADS' "$root/app/electron/rapidocr-worker.cjs"
grep -q 'SC_TRACKER_OCR_THREADS:-2' "$root/bin/sc-blueprint-tracker"
grep -q 'SC_TRACKER_RENDER_MODE:-opengl' "$root/bin/sc-blueprint-tracker"
grep -q 'retrying once in software Safe Mode' "$root/bin/sc-blueprint-tracker"
grep -q 'new MutationObserver' "$root/app/server/overlay/missions.html"
! grep -q 'setInterval(reportRegions, 100)' "$root/app/server/overlay/missions.html"
! grep -q 'data.missionOcr = true' "$root/install-cachyos.sh"
grep -q 'window.__overlayReportRegions' "$root/app/server/overlay/missions.html"
grep -q 'directly (Wine detached from Gamescope ancestry)' "$root/app/electron/linux/star-citizen-session.cjs"
bash -n "$root/install-cachyos.sh" "$root/bin/sc-blueprint-tracker" "$root/doctor.sh"
node "$root/tests/r31-alpha13-efficiency.test.cjs" "$root"
node "$root/tests/r31-alpha14-resource-budget.test.cjs" "$root"
node "$root/tests/r31-alpha15-interaction-diagnostics.test.cjs" "$root"
node "$root/tests/r31-alpha16-radar-and-click-forwarding.test.cjs" "$root"
node "$root/tests/r31-alpha17-scan-structure.test.cjs" "$root"
node "$root/tests/alpha14-config-e2e.cjs" "$root"
echo 'r31 alpha 17 static and end-to-end verification passed.'
SH

chmod +x "$OUT"/*.sh "$OUT/bin/sc-blueprint-tracker"
"$OUT/verify-alpha.sh"

tar -czf "$DIST/ArchVerse-Overlay-0.1.36-r31-alpha.17-arch.tar.gz" -C "$TMP_ROOT" "$(basename "$OUT")"
(
  cd "$TMP_ROOT"
  zip -qr "$DIST/ArchVerse-Overlay-0.1.36-r31-alpha.17-arch.zip" "$(basename "$OUT")"
)
(
  cd "$DIST"
  sha256sum ArchVerse-Overlay-0.1.36-r31-alpha.17-arch.tar.gz ArchVerse-Overlay-0.1.36-r31-alpha.17-arch.zip > SHA256SUMS
)

echo "Alpha 17 package created in $DIST"
