#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP_ROOT="${RUNNER_TEMP:-/tmp}/r31-alpha5-build"
LINUX_DIR="$TMP_ROOT/linux"
CORE_DIR="$TMP_ROOT/core"
BASE_DIR="$TMP_ROOT/base"
CONFLICT_DIR="$TMP_ROOT/conflicts"
OUT="$TMP_ROOT/ArchVerse-Overlay-0.1.36-r31-alpha.5"
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

decode_parts("linux-port/payload/part-*", "/tmp/r31-alpha5-linux.tar.gz")
decode_parts("linux-port/core/part-*", "/tmp/r31-alpha5-core.tar.gz")
PY

gzip -t /tmp/r31-alpha5-linux.tar.gz
gzip -t /tmp/r31-alpha5-core.tar.gz
tar -xzf /tmp/r31-alpha5-linux.tar.gz -C "$LINUX_DIR"
tar -xzf /tmp/r31-alpha5-core.tar.gz -C "$CORE_DIR"
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
  linux-port/r31-alpha3-dom-widget-hit.patch \
  linux-port/r31-alpha4-main-handshake.patch \
  linux-port/r31-alpha4-renderer-regions.patch \
  linux-port/r31-alpha5-latched-cursor-shiftf6.patch; do
  git apply --recount --check "$patch"
  git apply --recount "$patch"
done

python3 - <<'PY'
from pathlib import Path
import json
pkg = Path("package.json")
data = json.loads(pkg.read_text())
data["version"] = "0.1.36-r31-alpha.5"
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
node --test \
  test/r31-alpha2-session-binding.test.cjs \
  test/r31-alpha4-region-handshake.test.cjs \
  test/r31-alpha5-latched-interaction.test.cjs

npm ci --no-audit --no-fund
npm run typecheck
npm run build:server

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
  version: "0.1.36-r31-alpha.5",
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

cp -a "$LINUX_DIR/sc-blueprint-tracker" "$OUT/bin/sc-blueprint-tracker"
cp -a "$LINUX_DIR/install-cachyos.sh" "$OUT/install-cachyos.sh"
cp -a "$LINUX_DIR/uninstall-cachyos.sh" "$OUT/uninstall-cachyos.sh"
cp -a "$LINUX_DIR/doctor.sh" "$OUT/doctor.sh"
cp -a "$LINUX_DIR/install-input-access.sh" "$OUT/install-input-access.sh"
cp -a LICENSE.md "$OUT/LICENSE.md"
[[ -f FORK-NOTICE.md ]] && cp FORK-NOTICE.md "$OUT/FORK-NOTICE.md" || true
cp LINUX-PORT-PLAN.md "$OUT/docs/"
cp docs/R31-INPUT-DESIGN.md "$OUT/docs/"

python3 - "$OUT/install-cachyos.sh" "$OUT/doctor.sh" <<'PY'
from pathlib import Path
import sys

installer = Path(sys.argv[1])
text = installer.read_text()
text = text.replace("0.1.33-r30.2-rapidocr-worker-isolation", "0.1.36-r31-alpha.5")
text = text.replace(
    "data.holdToInteract = true;",
    "data.holdToInteract = true;\ndata.interactHotkey = 'F';\ndata.moveHotkey = 'Shift+F6';",
)
text = text.replace("Hold F + click", "Press F while the pointer is over a classified widget")
text = text.replace("archverse-overlay-r30.2.log", "archverse-overlay-r31-alpha5.log")
text = text.replace("r30.2", "r31 alpha 5")
installer.write_text(text)

doctor = Path(sys.argv[2])
doctor.write_text(doctor.read_text().replace(
    "0.1.33-r30 diagnostics", "0.1.36-r31 alpha 5 diagnostics"))
PY

cat > "$OUT/README.md" <<'DOC'
# ArchVerse Overlay 0.1.36-r31 alpha 5

Arch/CachyOS test build for startup-safe widget interaction, persistent text-entry focus, and direct Star Citizen PID binding.

Input behavior:
- Move the pointer over a classified overlay widget and press F once.
- Releasing F leaves that widget interactive, so Twitch Chat, Journal, Web Page forms, and other text inputs can be used normally.
- The session ends when the pointer leaves every widget, Escape is pressed, or another window takes focus.
- A dedicated focusless cursor surface is rendered above the Overlay Manager and native WebContentsViews.
- F over empty transparent canvas leaves Star Citizen focused.
- Shift+F6 enters or exits arrange mode for all widgets.
- Right Alt and Ctrl+Alt+M are not used by the Linux build.

Screen reader behavior:
- Uses strict StarCitizen.exe -> Gamescope validation when that ancestry exists.
- Falls back to the exact StarCitizen.exe PID and /proc start time when Wine detaches.

This is an alpha. Keep the previous working archive available for rollback.

Install:
    ./install-cachyos.sh --clean-install

Launch with logging:
    sc-blueprint-tracker 2>&1 | tee ~/archverse-overlay-r31-alpha5.log
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
  app/server/sc-overlay-server.mjs \
  install-cachyos.sh \
  bin/sc-blueprint-tracker; do
  [[ -s "$root/$f" ]] || { echo "missing $f" >&2; exit 1; }
done
find "$root/app/electron" -type f \( -name '*.cjs' -o -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
grep -q 'let registeredInteractKey = "F"' "$root/app/electron/main.cjs"
! grep -q 'let registeredInteractKey = "RightAlt"' "$root/app/electron/main.cjs"
grep -q 'let moveKey = "Shift+F6"' "$root/app/electron/main.cjs"
grep -q 'overlayInteractionLatched = true' "$root/app/electron/main.cjs"
grep -q 'function ensureInteractionCursorWindow' "$root/app/electron/main.cjs"
grep -q 'win.setAlwaysOnTop(true, "screen-saver")' "$root/app/electron/main.cjs"
grep -q 'requestOverlayRegionSnapshot' "$root/app/electron/main.cjs"
grep -q 'window.__overlayReportRegions' "$root/app/server/overlay/missions.html"
grep -q 'directly (Wine detached from Gamescope ancestry)' "$root/app/electron/linux/star-citizen-session.cjs"
bash -n "$root/install-cachyos.sh" "$root/bin/sc-blueprint-tracker" "$root/doctor.sh"
echo 'r31 alpha 5 static verification passed.'
SH

chmod +x "$OUT"/*.sh "$OUT/bin/sc-blueprint-tracker"
"$OUT/verify-alpha.sh"

tar -czf "$DIST/ArchVerse-Overlay-0.1.36-r31-alpha.5-arch.tar.gz" -C "$TMP_ROOT" "$(basename "$OUT")"
(
  cd "$DIST"
  sha256sum ArchVerse-Overlay-0.1.36-r31-alpha.5-arch.tar.gz > ArchVerse-Overlay-0.1.36-r31-alpha.5-arch.tar.gz.sha256
)

echo "Alpha 5 package created in $DIST"
