#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ALPHA17_ARCHIVE="${1:-${ALPHA17_ARCHIVE:-}}"
[[ -n "$ALPHA17_ARCHIVE" && -f "$ALPHA17_ARCHIVE" ]] || { echo "Alpha 17 archive missing: $ALPHA17_ARCHIVE" >&2; exit 2; }

VERSION="0.1.42-r31-alpha.19"
A18_COMMIT="d49d55b01d326b16fbe9b78fea40cf98958b3269"
TMP_ROOT="${RUNNER_TEMP:-/tmp}/r31-alpha19-build"
A18_TMP="$TMP_ROOT/a18-runtime"
A18_REPO="$TMP_ROOT/a18-repo"
BASE="$TMP_ROOT/upstream-0.1.41"
UP="$TMP_ROOT/upstream-0.1.42"
WORK="$TMP_ROOT/work"
OUT="$TMP_ROOT/ArchVerse-Overlay-${VERSION}"
DIST="${RUNNER_TEMP:-/tmp}/dist"
CONFLICTS="$TMP_ROOT/conflicts.txt"

rm -rf "$TMP_ROOT" "$DIST"
mkdir -p "$TMP_ROOT" "$A18_TMP" "$DIST"

# ---------------------------------------------------------------------------
# 1. Rebuild the exact audited ArchVerse Alpha 18 baseline.
# ---------------------------------------------------------------------------
echo "[alpha19] rebuilding audited ArchVerse Alpha18 baseline $A18_COMMIT"
git clone --quiet https://github.com/gbmccray32-boop/sc-overlay-for-Arch-Linux.git "$A18_REPO"
(
  cd "$A18_REPO"
  git checkout --quiet "$A18_COMMIT"
  RUNNER_TEMP="$A18_TMP" NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" \
    bash linux-port/build-r31-alpha18-final-audit.sh "$ALPHA17_ARCHIVE"
)
A18_WORK="$A18_TMP/r31-alpha18-build/work"
A18_PKG="$A18_TMP/r31-alpha18-build/ArchVerse-Overlay-0.1.41-r31-alpha.18"
[[ -s "$A18_WORK/electron/main.cjs" ]] || { echo '[alpha19] audited Alpha18 work tree missing' >&2; exit 3; }
[[ -s "$A18_PKG/app/electron/main.cjs" ]] || { echo '[alpha19] audited Alpha18 package tree missing' >&2; exit 3; }

# ---------------------------------------------------------------------------
# 2. Rebase ONLY the developer's 0.1.41 -> 0.1.42 delta onto that audited result.
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

# Electron is the Linux port's platform layer. Compare the audited Alpha18 result against the
# *immediate* upstream 0.1.41 base and merge only where both Alpha18 and 0.1.42 changed.
while IFS= read -r ours; do
  rel="${ours#"$A18_WORK/"}"
  [[ "$rel" == electron/* ]] || continue
  merge_one "$ours" "$BASE/$rel" "$UP/$rel" "$WORK/$rel" "$rel"
done < <(find "$A18_WORK/electron" -type f -print | sort)

# Renderer customizations carry forward, except Chat itself: 0.1.42's rewritten Chat UI is
# security-authoritative and replaces the temporary pre-0.1.42 quarantine UI wholesale.
while IFS= read -r ours; do
  rel="${ours#"$A18_WORK/"}"
  [[ "$rel" == overlay/* ]] || continue
  case "$rel" in
    overlay/chat.html|overlay/changelog.json) continue ;;
  esac
  merge_one "$ours" "$BASE/$rel" "$UP/$rel" "$WORK/$rel" "$rel"
done < <(find "$A18_WORK/overlay" -maxdepth 1 -type f -print | sort)

if [[ -s "$CONFLICTS" ]]; then
  echo "[alpha19] incremental 0.1.41 -> 0.1.42 conflicts require semantic resolution:" >&2
  cat "$CONFLICTS" >&2
  grep -R -n '^<<<<<<<\|^|||||||\|^=======\|^>>>>>>>' "$WORK/electron" "$WORK/overlay" >&2 || true
  exit 10
fi

# ---------------------------------------------------------------------------
# 3. Apply ArchVerse policies to upstream-authoritative 0.1.42 server/chat.
# ---------------------------------------------------------------------------
python3 "$ROOT/linux-port/alpha18-config-contract-fixes.py" "$WORK"
python3 "$ROOT/linux-port/alpha19-chat-location-policy.py" "$WORK"

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
    {'kind':'fixed','label':'Critical 0.1.42 security update','text':'Ports upstream 0.1.42 path-containment, loopback/mutating-route, sensitive-Origin, Chat privacy/rate-limit/payload, deployment-auth and room-impersonation protections.'},
    {'kind':'improved','label':'Incremental audited rebase','text':'Alpha 19 is rebased from the audited Alpha 18 result across only the upstream 0.1.41→0.1.42 delta instead of re-merging from the old 0.1.36 fork point.'},
    {'kind':'improved','label':'Linux contracts preserved','text':'Keeps F interaction, transparent-canvas release, startup-modal focus restore, unpacked bundled sidecar selection, Gamescope/KDE handling, exact SC session binding, Linux OCR isolation and the structural Scan Mode gate.'},
    {'kind':'security','label':'Location rooms remain quarantined','text':'Global/org/custom/private/DM Chat features are retained, but ArchVerse does not authorize production Region/Nearby membership from client-controlled game-log location while no trusted CIG location-attestation API exists.'},
  ]
}
out={'0.1.42-r31-alpha.19':entry}
out.update(d)
p.write_text(json.dumps(out, indent=2)+'\n')
PY

# ---------------------------------------------------------------------------
# 4. Validate source + every upstream test before packaging.
# ---------------------------------------------------------------------------
cd "$WORK"
if grep -R -n '^<<<<<<<\|^|||||||\|^=======\|^>>>>>>>' electron overlay src; then exit 11; fi
find electron -type f \( -name '*.cjs' -o -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check

grep -q 'process.platform === "linux"' electron/main.cjs
grep -q 'scan-mode-gate.cjs' electron/capture.cjs
grep -q 'SC_TRACKER_CONFIG_DIR' src/overlay-server.ts
grep -q 'Cross-origin requests are not accepted.' src/overlay-server.ts
grep -q 'ARCHVERSE_UNATTESTED_LOCATION_RE' src/chat.ts

NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm --prefix chat-server ci --ignore-scripts --no-audit --no-fund
node chat-server/server.test.mjs
node --import tsx --test src/*.test.ts
npm run build:server

# ---------------------------------------------------------------------------
# 5. Build the Linux package from the proven Alpha18 installer/runtime skeleton.
# Native Electron dependencies are unchanged between upstream 0.1.41 and 0.1.42, so reuse the
# audited Alpha18 Linux node_modules and replace only the application/server payload.
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

# Version strings in the Linux launcher/installer are informational but should identify the exact
# package a field log came from.
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
# ArchVerse Overlay 0.1.42-r31 Alpha 19 — Security Candidate

Community Arch/CachyOS Linux port of SubliminalsTV SC Overlay 0.1.42, incrementally rebased from the audited ArchVerse Alpha 18 runtime.

## Security update
- Upstream 0.1.42 port-8778 path traversal containment.
- Loopback-only mutating and sensitive sidecar routes while preserving read-only LAN widget/OBS surfaces.
- Cross-origin protection for sensitive localhost requests.
- Chat LAN privacy, 16 KiB WebSocket payload cap, access-attempt throttling, deployment auth guard and room-name impersonation protection.
- Upstream private rooms, invites, DMs and durable Chat changes are retained.
- ArchVerse keeps production automatic Region/Nearby membership disabled until room location can be independently attested server-side.

## Linux contracts retained
- F interaction and one-click transparent-canvas focus release.
- Shift+F6 arrange mode and hard click-through.
- Startup modal restores the previous external window.
- System-Electron/unpacked installs still select bundled server.mjs.
- Exact StarCitizen.exe session binding, Gamescope/Spectacle capture, isolated RapidOCR and structural Scan Mode gating remain.

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
echo 'r31 Alpha 19 package verification passed.'
SH
chmod +x "$OUT/verify-alpha.sh" "$OUT"/*.sh "$OUT/bin/sc-blueprint-tracker"
"$OUT/verify-alpha.sh"

cd "$TMP_ROOT"
tar -czf "$DIST/ArchVerse-Overlay-${VERSION}-arch.tar.gz" "$(basename "$OUT")"
zip -qr "$DIST/ArchVerse-Overlay-${VERSION}-arch.zip" "$(basename "$OUT")"
cd "$DIST"
sha256sum "ArchVerse-Overlay-${VERSION}-arch.tar.gz" "ArchVerse-Overlay-${VERSION}-arch.zip" > SHA256SUMS
cat SHA256SUMS

echo '[alpha19] incremental audited build complete'
