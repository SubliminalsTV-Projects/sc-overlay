#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ALPHA17_ARCHIVE="${1:-${ALPHA17_ARCHIVE:-}}"
if [[ -z "$ALPHA17_ARCHIVE" || ! -f "$ALPHA17_ARCHIVE" ]]; then
  echo "Alpha 17 archive not found: $ALPHA17_ARCHIVE" >&2
  exit 2
fi

VERSION="0.1.41-r31-alpha.18"
TMP_ROOT="${RUNNER_TEMP:-/tmp}/r31-alpha18-build"
BASE_DIR="$TMP_ROOT/upstream-0.1.36"
UP_DIR="$TMP_ROOT/upstream-0.1.41"
WORK_DIR="$TMP_ROOT/work"
A17_EXTRACT="$TMP_ROOT/alpha17"
OUT="$TMP_ROOT/ArchVerse-Overlay-${VERSION}"
DIST="$ROOT/dist"

rm -rf "$TMP_ROOT" "$DIST"
mkdir -p "$TMP_ROOT" "$A17_EXTRACT" "$DIST"

echo "[alpha18] fetching exact upstream merge bases"
git clone --quiet --depth 1 --branch v0.1.36 https://github.com/SubliminalsTV-Projects/sc-overlay.git "$BASE_DIR"
git clone --quiet --depth 1 --branch v0.1.41 https://github.com/SubliminalsTV-Projects/sc-overlay.git "$UP_DIR"
cp -a "$UP_DIR" "$WORK_DIR"
rm -rf "$WORK_DIR/.git"

tar --no-same-owner -xzf "$ALPHA17_ARCHIVE" -C "$A17_EXTRACT"
A17="$(find "$A17_EXTRACT" -mindepth 1 -maxdepth 1 -type d | head -n1)"
test -n "$A17"
test -s "$A17/app/electron/main.cjs"
test -s "$A17/app/server/overlay/missions.html"

CONFLICTS="$TMP_ROOT/conflicts.txt"
: > "$CONFLICTS"

merge_one() {
  local ours="$1" base="$2" theirs="$3" out="$4" label="$5"
  mkdir -p "$(dirname "$out")"
  if [[ ! -f "$base" ]]; then
    cp -a "$ours" "$out"
    echo "[alpha18] carry Linux-only $label"
    return 0
  fi
  if cmp -s "$ours" "$base"; then
    return 0
  fi
  if cmp -s "$theirs" "$base"; then
    cp -a "$ours" "$out"
    echo "[alpha18] carry Alpha17-only $label"
    return 0
  fi
  set +e
  git merge-file -p --diff3 -L "ArchVerse Alpha17" -L "upstream 0.1.36" -L "upstream 0.1.41" \
    "$ours" "$base" "$theirs" > "$out.merge"
  rc=$?
  set -e
  mv "$out.merge" "$out"
  if (( rc > 0 )); then
    echo "$label" >> "$CONFLICTS"
    echo "[alpha18] conflict: $label" >&2
  elif (( rc < 0 )); then
    echo "merge-file failed for $label" >&2
    exit 3
  else
    echo "[alpha18] merged $label"
  fi
}

# Start from upstream 0.1.41 and three-way only files Alpha17 actually changed. This keeps every
# new upstream file (Chat, setup wizard, current sidecar, tests, data logic) automatically.
while IFS= read -r ours; do
  rel="${ours#"$A17/app/"}"
  [[ "$rel" == package.json ]] && continue
  [[ "$rel" == server/* ]] && continue
  base="$BASE_DIR/$rel"
  theirs="$UP_DIR/$rel"
  out="$WORK_DIR/$rel"
  if [[ -f "$theirs" || ! -f "$base" ]]; then
    merge_one "$ours" "$base" "$theirs" "$out" "$rel"
  fi
done < <(find "$A17/app/electron" -type f -print)

while IFS= read -r ours; do
  rel="${ours#"$A17/app/server/overlay/"}"
  [[ "$rel" == changelog.json ]] && continue
  base="$BASE_DIR/overlay/$rel"
  theirs="$UP_DIR/overlay/$rel"
  out="$WORK_DIR/overlay/$rel"
  if [[ -f "$theirs" || ! -f "$base" ]]; then
    merge_one "$ours" "$base" "$theirs" "$out" "overlay/$rel"
  fi
done < <(find "$A17/app/server/overlay" -maxdepth 1 -type f -print)

cp -a "$A17/app/electron/scan-mode-gate.cjs" "$WORK_DIR/electron/scan-mode-gate.cjs"
cp -a "$A17/app/electron/linux" "$WORK_DIR/electron/"

if [[ -s "$CONFLICTS" ]]; then
  echo "[alpha18] unresolved three-way conflicts:" >&2
  cat "$CONFLICTS" >&2
  echo "[alpha18] markers:" >&2
  grep -R -n '^<<<<<<<\|^|||||||\|^=======\|^>>>>>>>' "$WORK_DIR/electron" "$WORK_DIR/overlay" >&2 || true
  exit 10
fi

# Preserve the Linux configuration contract while taking the 0.1.41 server wholesale.
python3 - "$WORK_DIR/src/overlay-server.ts" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
old = 'const userDir = join(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");'
new = '''const legacyUserDir = join(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");
// ArchVerse Linux launcher can pin a canonical config root regardless of Electron/XDG wrappers.
const userDir = process.env.SC_TRACKER_CONFIG_DIR || legacyUserDir;'''
if old not in s:
    raise SystemExit('userDir anchor missing')
s = s.replace(old, new, 1)

needle = '  /** Mining Assistant: arms the capture loop to read the Refinement Center (job timers)\n'
if 'screenReaderProfile:' not in s:
    insert = '  /** ArchVerse Linux screen-reader budget. */\n  screenReaderProfile: "lightweight" | "full";\n'
    s = s.replace(needle, insert + needle, 1)
    s = s.replace('  miningAssistant: false,\n', '  miningAssistant: false,\n  screenReaderProfile: "lightweight",\n', 1)

anchor = 'let config: Config = loadConfig();'
linux_force = '''let config: Config = loadConfig();
if (process.platform === "linux") {
  config.interactHotkey = "F";
  config.holdToInteract = true;
  config.moveHotkey = "Shift+F6";
  if (!config.screenReaderProfile) config.screenReaderProfile = "lightweight";
}'''
if anchor not in s:
    raise SystemExit('config load anchor missing')
s = s.replace(anchor, linux_force, 1)

post_old = '''    if (typeof body.interactHotkey === "string") config.interactHotkey = body.interactHotkey.trim();
    if (typeof body.holdToInteract === "boolean") config.holdToInteract = body.holdToInteract;
    if (typeof body.moveHotkey === "string") config.moveHotkey = body.moveHotkey.trim();'''
post_new = '''    if (typeof body.interactHotkey === "string") config.interactHotkey = body.interactHotkey.trim();
    if (typeof body.holdToInteract === "boolean") config.holdToInteract = body.holdToInteract;
    if (typeof body.moveHotkey === "string") config.moveHotkey = body.moveHotkey.trim();
    if (process.platform === "linux") {
      config.interactHotkey = "F";
      config.holdToInteract = true;
      config.moveHotkey = "Shift+F6";
      config.screenReaderProfile = "lightweight";
    }'''
if post_old not in s:
    raise SystemExit('POST hotkey anchor missing')
s = s.replace(post_old, post_new, 1)
p.write_text(s)
PY

python3 - "$WORK_DIR/overlay/changelog.json" "$A17/app/server/overlay/changelog.json" <<'PY'
from pathlib import Path
import json, sys
up = json.loads(Path(sys.argv[1]).read_text())
a17 = json.loads(Path(sys.argv[2]).read_text())
custom = {k:v for k,v in a17.items() if '-r31-alpha.' in k}
entry = {
  "date": "2026-08-08T00:00:00Z",
  "notes": [
    {"kind":"new","label":"Upstream 0.1.41 integrated","text":"Includes every upstream change through SC Overlay 0.1.41: the 0.1.40 mining pipeline rebuild, mission fixes, current settings/setup work, social Chat, and the 0.1.41 sidecar/package optimizations."},
    {"kind":"improved","label":"Linux port kept intact","text":"ArchVerse keeps Alpha 17's F interaction, physical pointer forwarding, Gamescope/KDE focus handling, bounded OCR budget, structural Scan Mode gate, and OpenGL-with-software-fallback launcher behavior."},
    {"kind":"improved","label":"Upstream server now runs as Electron Node","text":"The Linux package follows 0.1.41's bundled server.mjs model under Electron's Node runtime instead of carrying the older standalone sidecar shape."},
    {"kind":"fixed","label":"Alpha 17 Scan Mode regression coverage retained","text":"The labeled on/off Scan Mode structure fixtures and false-positive rejection logic remain part of Alpha 18 while the mining reader underneath is updated to upstream 0.1.40/0.1.41."}
  ]
}
out = {"0.1.41-r31-alpha.18": entry}
out.update(up)
for k,v in custom.items():
    if k not in out:
        out[k]=v
Path(sys.argv[1]).write_text(json.dumps(out, indent=2)+"\n")
PY

python3 - "$WORK_DIR/package.json" <<'PY'
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); d=json.loads(p.read_text())
d['version']='0.1.41-r31-alpha.18'
d['productName']='ArchVerse Overlay'
d['description']='ArchVerse Overlay — community Linux port of SubliminalsTV SC Overlay 0.1.41.'
p.write_text(json.dumps(d,indent=2)+"\n")
PY

cd "$WORK_DIR"
if grep -R -n '^<<<<<<<\|^|||||||\|^=======\|^>>>>>>>' electron overlay src; then exit 11; fi
node --check electron/main.cjs
node --check electron/capture.cjs
node --check electron/preload.cjs
node --check electron/hotkeys.cjs
node --check electron/window-manager.cjs
node --check electron/linux/star-citizen-session.cjs
node --check electron/rapidocr-client.cjs
node --check electron/rapidocr-worker.cjs
node --check electron/scan-mode-gate.cjs

grep -q 'scan-mode-gate.cjs' electron/capture.cjs
grep -q 'process.platform === "linux"' electron/main.cjs
grep -q 'SC_TRACKER_CONFIG_DIR' src/overlay-server.ts
grep -q 'wss://chat.subliminal.gg/ws' src/overlay-server.ts
grep -q 'server.mjs' tools/build-server.mjs

NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
node --import tsx --test src/*.test.ts
npm run build:server

mkdir -p "$OUT/app" "$OUT/bin" "$OUT/docs" "$OUT/tests"
cp -a electron "$OUT/app/"
cp -a build/server "$OUT/app/server"
mkdir -p "$OUT/app/build"
cp -a build/icon.png "$OUT/app/build/icon.png"

node - "$OUT/app/package.json" <<'NODE'
const fs = require('node:fs');
const src = require('./package.json');
const deps = {};
for (const name of ['@gutenye/ocr-node','electron-updater','uiohook-napi','koffi']) {
  if (src.dependencies?.[name]) deps[name] = src.dependencies[name];
}
fs.writeFileSync(process.argv[2], JSON.stringify({
  name:'archverse-overlay', version:'0.1.41-r31-alpha.18',
  description:'Community Linux port of SubliminalsTV SC Overlay 0.1.41',
  main:'electron/main.cjs', type:'module', dependencies:deps,
}, null, 2) + '\n');
NODE

(
  cd "$OUT/app"
  NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm install --omit=dev --no-audit --no-fund --package-lock=true
  rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin node_modules/onnxruntime-node/bin/napi-v6/win32 \
    node_modules/onnxruntime-node/bin/napi-v6/linux/arm64 node_modules/uiohook-napi/prebuilds/darwin-arm64 \
    node_modules/uiohook-napi/prebuilds/darwin-x64 node_modules/uiohook-napi/prebuilds/linux-arm64 \
    node_modules/uiohook-napi/prebuilds/linux-loong64 node_modules/uiohook-napi/prebuilds/win32-arm64 \
    node_modules/uiohook-napi/prebuilds/win32-x64 2>/dev/null || true
)

cp -a "$A17/bin/." "$OUT/bin/"
for f in install-cachyos.sh uninstall-cachyos.sh doctor.sh install-input-access.sh; do
  [[ -f "$A17/$f" ]] && cp -a "$A17/$f" "$OUT/$f"
done
[[ -f "$A17/LICENSE.md" ]] && cp -a "$A17/LICENSE.md" "$OUT/LICENSE.md" || cp -a LICENSE.md "$OUT/LICENSE.md"
[[ -f "$A17/FORK-NOTICE.md" ]] && cp -a "$A17/FORK-NOTICE.md" "$OUT/FORK-NOTICE.md" || true
[[ -d "$A17/docs" ]] && cp -a "$A17/docs/." "$OUT/docs/"
[[ -d "$A17/tests" ]] && cp -a "$A17/tests/." "$OUT/tests/"

python3 - "$OUT" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
for rel in ['install-cachyos.sh','doctor.sh','bin/sc-blueprint-tracker']:
    p=root/rel
    if not p.exists(): continue
    s=p.read_text().replace('0.1.36-r31-alpha.17','0.1.41-r31-alpha.18').replace('r31 alpha 17','r31 alpha 18').replace('r31-alpha17','r31-alpha18')
    p.write_text(s)
PY

cat > "$OUT/README.md" <<'DOC'
# ArchVerse Overlay 0.1.41-r31 Alpha 18

Community Arch/CachyOS Linux port of SubliminalsTV SC Overlay, rebased from ArchVerse r31 Alpha 17 onto upstream 0.1.41.

## Upstream included
- All upstream changes through 0.1.41, including the 0.1.40 mining scanner overhaul.
- Social Chat with Global / Server / Shard channels and verified RSI identity gate.
- Current mission/reputation/log verification fixes and first-run/settings work.
- Upstream 0.1.41 sidecar redesign: `server.mjs` runs under Electron's Node runtime.
- Current package/data optimizations and 0.1.41 tray/unlock-alert fixes.

## Linux behavior preserved
- F is the mandatory widget interaction entry key; transparent canvas stays click-through to Star Citizen.
- Alpha 17 physical pointer forwarding and KDE/Gamescope focus handoff remain in place.
- Shift+F6 remains the Linux arrange hotkey.
- Exact StarCitizen.exe session binding, Gamescope/Spectacle capture fallback, and bounded OCR resources remain.
- Alpha 17 structural Scan Mode detection and its false-positive fixtures remain; mining analysis/signature OCR stays gated outside Scan Mode.
- OpenGL remains the default renderer with one-shot software Safe Mode fallback.

## Install
```bash
./install-cachyos.sh --clean-install
```
Do not add `--reset-layout` if you want to preserve an existing widget layout.

This is a prerelease. Keep Alpha 17 available as the immediate rollback point while testing.
DOC

cat > "$OUT/verify-alpha.sh" <<'SH2'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for f in app/electron/main.cjs app/electron/capture.cjs app/electron/scan-mode-gate.cjs \
  app/electron/linux/star-citizen-session.cjs app/server/server.mjs app/server/overlay/chat.html \
  app/server/overlay/setup.html install-cachyos.sh bin/sc-blueprint-tracker; do
  [[ -s "$root/$f" ]] || { echo "missing $f" >&2; exit 1; }
done
find "$root/app/electron" -type f \( -name '*.cjs' -o -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
grep -q 'scan-mode-gate.cjs' "$root/app/electron/capture.cjs"
grep -q '0.1.41-r31-alpha.18' "$root/app/package.json"
grep -q 'wss://chat.subliminal.gg/ws' "$root/app/server/server.mjs"
bash -n "$root/install-cachyos.sh" "$root/bin/sc-blueprint-tracker" "$root/doctor.sh"
echo 'r31 alpha 18 static verification passed.'
SH2
chmod +x "$OUT"/*.sh "$OUT/bin/sc-blueprint-tracker"
"$OUT/verify-alpha.sh"

cd "$TMP_ROOT"
tar -czf "$DIST/ArchVerse-Overlay-${VERSION}-arch.tar.gz" "$(basename "$OUT")"
zip -qr "$DIST/ArchVerse-Overlay-${VERSION}-arch.zip" "$(basename "$OUT")"
cd "$DIST"
sha256sum "ArchVerse-Overlay-${VERSION}-arch.tar.gz" "ArchVerse-Overlay-${VERSION}-arch.zip" > SHA256SUMS
cat SHA256SUMS
