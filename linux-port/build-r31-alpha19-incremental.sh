#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ALPHA18_ARCHIVE="${1:-${ALPHA18_ARCHIVE:-}}"
[[ -n "$ALPHA18_ARCHIVE" && -f "$ALPHA18_ARCHIVE" ]] || { echo "Alpha 18 archive missing: $ALPHA18_ARCHIVE" >&2; exit 2; }

VERSION="0.1.42-r31-alpha.19"
TMP_ROOT="${RUNNER_TEMP:-/tmp}/r31-alpha19-build"
A18_UNPACK="$TMP_ROOT/a18-package"
A18_WORK="$TMP_ROOT/a18-working-source"
BASE="$TMP_ROOT/upstream-0.1.41"
UP="$TMP_ROOT/upstream-0.1.42"
WORK="$TMP_ROOT/work"
OUT="$TMP_ROOT/ArchVerse-Overlay-${VERSION}"
DIST="${RUNNER_TEMP:-/tmp}/dist"
CONFLICTS="$TMP_ROOT/conflicts.txt"

rm -rf "$TMP_ROOT" "$DIST"
mkdir -p "$TMP_ROOT" "$A18_UNPACK" "$A18_WORK" "$DIST"

# ---------------------------------------------------------------------------
# 1. Start from the actual ArchVerse Alpha 18 package, not Alpha 17.
# ---------------------------------------------------------------------------
echo "[alpha19] extracting ArchVerse 0.1.41-r31 Alpha 18 baseline"
tar -xzf "$ALPHA18_ARCHIVE" -C "$A18_UNPACK"
A18_PKG="$(find "$A18_UNPACK" -mindepth 1 -maxdepth 1 -type d -name 'ArchVerse-Overlay-0.1.41-r31-alpha.18*' -print | head -n1)"
[[ -n "$A18_PKG" && -s "$A18_PKG/app/electron/main.cjs" ]] || { echo '[alpha19] Alpha18 package tree missing' >&2; exit 3; }

# The public Alpha 18 archive predates the two field fixes that made the user's installed copy the
# known-good baseline: unpacked system-Electron sidecar selection and the transparent-canvas/modal
# focus handoff. Reapply exactly those known-good runtime fixes before the 0.1.42 delta is merged.
cp -a "$A18_PKG/app/electron" "$A18_WORK/electron"
cp -a "$A18_PKG/app/server/overlay" "$A18_WORK/overlay"
cp -a "$A18_PKG/app/package.json" "$A18_WORK/package.json"
python3 "$ROOT/linux-port/alpha18-field-runtime-fixes.py" "$A18_WORK" "$A18_WORK" "$A18_WORK"
node --check "$A18_WORK/electron/main.cjs"
echo "[alpha19] corrected working Alpha18 baseline ready"

# ---------------------------------------------------------------------------
# 2. Apply ONLY the developer's immediate 0.1.41 -> 0.1.42 delta.
# ---------------------------------------------------------------------------
echo "[alpha19] fetching upstream 0.1.41 and 0.1.42"
git clone --quiet --depth 1 --branch v0.1.41 https://github.com/SubliminalsTV-Projects/sc-overlay.git "$BASE"
git clone --quiet --depth 1 --branch v0.1.42 https://github.com/SubliminalsTV-Projects/sc-overlay.git "$UP"
cp -a "$UP" "$WORK"
rm -rf "$WORK/.git"
: > "$CONFLICTS"

merge_one() {
  local ours="$1" base="$2" theirs="$3" out="$4" label="$5"
  mkdir -p "$(dirname "$out")"
  if [[ ! -f "$base" ]]; then
    cp -a "$ours" "$out"
    echo "[alpha19] carry Linux-only $label"
    return
  fi
  if cmp -s "$ours" "$base"; then return; fi
  if [[ ! -f "$theirs" ]]; then
    echo "$label (upstream deleted, ArchVerse modified)" >> "$CONFLICTS"
    return
  fi
  if cmp -s "$theirs" "$base"; then
    cp -a "$ours" "$out"
    echo "[alpha19] carry ArchVerse-only $label"
    return
  fi
  set +e
  git merge-file -p --diff3 -L 'ArchVerse audited Alpha18' -L 'upstream 0.1.41' -L 'upstream 0.1.42' \
    "$ours" "$base" "$theirs" > "$out.merge"
  rc=$?
  set -e
  mv "$out.merge" "$out"
  if (( rc > 0 )); then
    echo "$label" >> "$CONFLICTS"
    echo "[alpha19] semantic review required: $label" >&2
  elif (( rc < 0 )); then
    echo "[alpha19] merge-file failed: $label" >&2
    exit 4
  else
    echo "[alpha19] clean incremental merge $label"
  fi
}

# Electron is the Linux port's platform layer. Merge only when both ArchVerse Alpha 18 and the
# developer changed the same immediate 0.1.41 code.
while IFS= read -r ours; do
  rel="${ours#"$A18_WORK/"}"
  [[ "$rel" == electron/* ]] || continue
  merge_one "$ours" "$BASE/$rel" "$UP/$rel" "$WORK/$rel" "$rel"
done < <(find "$A18_WORK/electron" -type f -print | sort)

# Renderer customizations carry forward. Chat and changelog are upstream-authoritative in 0.1.42
# so the developer's security/room changes are tried as released, without our prior location-room
# quarantine layer.
while IFS= read -r ours; do
  rel="${ours#"$A18_WORK/"}"
  [[ "$rel" == overlay/* ]] || continue
  case "$rel" in
    overlay/chat.html|overlay/changelog.json) continue ;;
  esac
  merge_one "$ours" "$BASE/$rel" "$UP/$rel" "$WORK/$rel" "$rel"
done < <(find "$A18_WORK/overlay" -maxdepth 1 -type f -print | sort)

# The incremental merge has five known semantic overlaps (four main.cjs, one Settings block).
# Resolve those explicitly; any different/new conflict remains a hard stop.
if [[ -s "$CONFLICTS" ]]; then
  python3 "$ROOT/linux-port/alpha19-incremental-resolve.py" "$WORK"
fi
if grep -R -n '^<<<<<<<\|^|||||||\|^=======\|^>>>>>>>' "$WORK/electron" "$WORK/overlay"; then
  echo '[alpha19] unresolved merge markers remain' >&2
  exit 10
fi
: > "$CONFLICTS"

# ---------------------------------------------------------------------------
# 3. Reapply only Linux platform contracts. 0.1.42 security/chat remains developer-authored.
# ---------------------------------------------------------------------------
# Alpha 19 field testing established that the only sidecar compatibility change needed here is
# honoring Electron's SC_TRACKER_CONFIG_DIR. Keep upstream 0.1.42 routing/security untouched.
python3 "$ROOT/linux-port/alpha19-linux-sidecar-compat.py" "$WORK"

# Version/identity. Do not rewrite upstream's dependency graph.
python3 - "$WORK/package.json" <<'PY'
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); d=json.loads(p.read_text())
d['version']='0.1.42-r31-alpha.19'
d['productName']='ArchVerse Overlay'
d['description']='ArchVerse Overlay — community Linux port of SubliminalsTV SC Overlay 0.1.42.'
p.write_text(json.dumps(d, indent=2)+'\n')
PY

python3 - "$WORK/overlay/changelog.json" <<'PY'
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); d=json.loads(p.read_text())
entry={
  'date':'2026-08-10T00:00:00Z',
  'notes':[
    {'kind':'fixed','label':'Upstream 0.1.42 security update','text':'Uses the developer\'s 0.1.42 sidecar and Chat security changes as released, including local-route/origin protections and the rewritten Chat security model.'},
    {'kind':'improved','label':'Direct Alpha 18 baseline','text':'Alpha 19 starts from the latest working ArchVerse 0.1.41 Alpha 18 package plus its two proven field fixes, then applies only upstream 0.1.41→0.1.42.'},
    {'kind':'improved','label':'Linux runtime retained','text':'Keeps F interaction, transparent-canvas release, startup-modal focus restore, unpacked bundled sidecar selection, Gamescope/KDE handling, exact SC session binding, Linux OCR isolation and the structural Scan Mode gate.'},
  ]
}
out={'0.1.42-r31-alpha.19':entry}
out.update(d)
p.write_text(json.dumps(out, indent=2)+'\n')
PY

# ---------------------------------------------------------------------------
# 4. Basic build validation + the developer's own test suite.
# No ArchVerse security-regression suite is run for this field-test candidate.
# ---------------------------------------------------------------------------
cd "$WORK"
find electron -type f \( -name '*.cjs' -o -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check

grep -q 'process.platform === "linux"' electron/main.cjs
grep -q 'scan-mode-gate.cjs' electron/capture.cjs
grep -q 'SC_TRACKER_CONFIG_DIR' src/overlay-server.ts
grep -q 'Cross-origin requests are not accepted.' src/overlay-server.ts

NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm --prefix chat-server ci --ignore-scripts --no-audit --no-fund
node chat-server/server.test.mjs
node --import tsx --test src/*.test.ts
npm run build:server

# ---------------------------------------------------------------------------
# 5. Build Linux package from the exact Alpha 18 runtime/installer skeleton.
# ---------------------------------------------------------------------------
cp -a "$A18_PKG" "$OUT"
rm -rf "$OUT/app/electron" "$OUT/app/server"
cp -a "$WORK/electron" "$OUT/app/"
cp -a "$WORK/build/server" "$OUT/app/server"

python3 - "$OUT/app/package.json" <<'PY'
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); d=json.loads(p.read_text())
d['version']='0.1.42-r31-alpha.19'
d['description']='Community Linux port of SubliminalsTV SC Overlay 0.1.42'
p.write_text(json.dumps(d,indent=2)+'\n')
PY

python3 - "$OUT" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
for rel in ['install-cachyos.sh','doctor.sh','bin/sc-blueprint-tracker','README.md']:
    p=root/rel
    if not p.exists(): continue
    s=p.read_text(errors='replace')
    s=s.replace('0.1.41-r31-alpha.18','0.1.42-r31-alpha.19').replace('r31 alpha 18','r31 alpha 19').replace('r31-alpha18','r31-alpha19')
    p.write_text(s)
PY

cat > "$OUT/README.md" <<'DOC'
# ArchVerse Overlay 0.1.42-r31 Alpha 19 — Field Test

Community Arch/CachyOS Linux port of SubliminalsTV SC Overlay 0.1.42.

This candidate starts directly from the latest working ArchVerse Alpha 18 runtime and applies only the developer's upstream 0.1.41 → 0.1.42 delta.

## 0.1.42 security behavior
The developer's 0.1.42 security implementation is retained as released for this field test. ArchVerse does not add its previously researched Chat location-room quarantine in this build.

## Linux behavior retained
- F widget interaction and transparent-canvas focus release.
- Shift+F6 arrange mode and hard click-through.
- Startup modal restores the previous external window.
- Unpacked system-Electron installs select bundled server.mjs.
- Exact StarCitizen.exe session binding and Gamescope/KDE handling.
- Linux capture, isolated RapidOCR and structural Scan Mode gating.

Install with:
```bash
./install-cachyos.sh --clean-install
```
DOC

cat > "$OUT/verify-alpha.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for f in app/electron/main.cjs app/electron/capture.cjs app/electron/scan-mode-gate.cjs \
  app/electron/linux/star-citizen-session.cjs app/server/server.mjs app/server/overlay/chat.html \
  app/server/overlay/setup.html install-cachyos.sh bin/sc-blueprint-tracker; do
  [[ -s "$root/$f" ]] || { echo "missing $f" >&2; exit 1; }
done
find "$root/app/electron" -type f \( -name '*.cjs' -o -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
grep -q '0.1.42-r31-alpha.19' "$root/app/package.json"
grep -q 'Cross-origin requests are not accepted.' "$root/app/server/server.mjs"
grep -q 'scan-mode-gate.cjs' "$root/app/electron/capture.cjs"
bash -n "$root/install-cachyos.sh" "$root/bin/sc-blueprint-tracker" "$root/doctor.sh"
echo 'r31 Alpha 19 field-test package verification passed.'
SH
chmod +x "$OUT/verify-alpha.sh" "$OUT"/*.sh "$OUT/bin/sc-blueprint-tracker"
"$OUT/verify-alpha.sh"

cd "$TMP_ROOT"
tar -czf "$DIST/ArchVerse-Overlay-${VERSION}-arch.tar.gz" "$(basename "$OUT")"
zip -qr "$DIST/ArchVerse-Overlay-${VERSION}-arch.zip" "$(basename "$OUT")"
cd "$DIST"
sha256sum "ArchVerse-Overlay-${VERSION}-arch.tar.gz" "ArchVerse-Overlay-${VERSION}-arch.zip" > SHA256SUMS
cat SHA256SUMS

echo '[alpha19] developer-security field-test build complete'
