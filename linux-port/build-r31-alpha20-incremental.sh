#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ALPHA18_ARCHIVE="${1:-${ALPHA18_ARCHIVE:-}}"
[[ -n "$ALPHA18_ARCHIVE" && -f "$ALPHA18_ARCHIVE" ]] || { echo "Alpha 18 archive missing: $ALPHA18_ARCHIVE" >&2; exit 2; }

VERSION="0.1.42-r31-alpha.20"
A19_VERSION="0.1.42-r31-alpha.19"
RUNNER="${RUNNER_TEMP:-/tmp}"
TMP_ROOT="$RUNNER/r31-alpha20-build"
A19_ROOT="$RUNNER/r31-alpha19-build/ArchVerse-Overlay-${A19_VERSION}"
OUT="$TMP_ROOT/ArchVerse-Overlay-${VERSION}"
DIST="$RUNNER/dist-alpha20"

rm -rf "$TMP_ROOT" "$DIST"
mkdir -p "$TMP_ROOT" "$DIST"

# ---------------------------------------------------------------------------
# 1. Rebuild the known Alpha 19 runtime from the same Alpha 18 release baseline.
#    This deliberately reuses the already-audited Linux merge/capture/input path.
# ---------------------------------------------------------------------------
echo "[alpha20] rebuilding Alpha 19 baseline"
bash "$ROOT/linux-port/build-r31-alpha19-incremental.sh" "$ALPHA18_ARCHIVE"
[[ -s "$A19_ROOT/app/electron/main.cjs" && -s "$A19_ROOT/app/server/overlay/mining.html" ]] || {
  echo "[alpha20] Alpha 19 working package was not produced" >&2
  exit 3
}

# The source-level ArchVerse smoke test validates the build-time injector and the
# positive-confirmation salvage invariant before we touch the packaged runtime.
cd "$ROOT"
node tools/archverse-alpha20-smoke-test.mjs

# ---------------------------------------------------------------------------
# 2. Clone the exact Alpha 19 package tree and layer Alpha 20's UI-only changes.
#    No Electron/input/capture files are replaced in this step.
# ---------------------------------------------------------------------------
cp -a "$A19_ROOT" "$OUT"
cp -a "$ROOT/overlay/archverse-resource-scanner.js" "$OUT/app/server/overlay/"
cp -a "$ROOT/overlay/archverse-widget-appearance.js" "$OUT/app/server/overlay/"

node - "$OUT/app/server" <<'NODE'
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const serverDir = process.argv[2];
(async () => {
  const mod = await import(pathToFileURL(path.resolve('tools/archverse-overlay-patches.mjs')).href);
  mod.applyArchVerseOverlayPatches(serverDir);
})().catch((e) => { console.error(e); process.exit(1); });
NODE

# ---------------------------------------------------------------------------
# 3. Alpha 20 identity + changelog. Existing user config/layout keys stay unchanged.
# ---------------------------------------------------------------------------
python3 - "$OUT/app/package.json" <<'PY'
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); d=json.loads(p.read_text())
d['version']='0.1.42-r31-alpha.20'
d['description']='Community Linux port of SubliminalsTV SC Overlay 0.1.42 — Resource Scanner field test'
p.write_text(json.dumps(d, indent=2)+'\n')
PY

python3 - "$OUT/app/server/overlay/changelog.json" <<'PY'
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); d=json.loads(p.read_text())
entry={
  'date':'2026-08-10T23:20:00Z',
  'notes':[
    {'kind':'improved','label':'Resource Scanner','text':'Renames the user-facing Mining Scanner and expands the readout to mineral, hand-gem, harvestable/shared-resource and salvage-candidate classes without changing internal mining keys or saved layout.'},
    {'kind':'fixed','label':'No signature-only debris claim','text':'A multiple-of-2,000 signature is only an unconfirmed salvage candidate. The overlay can say Salvageable debris only after an explicit positive salvage confirmation.'},
    {'kind':'new','label':'Independent widget readability controls','text':'Every canvas widget gets Text brightness (25–200%) and Window transparency (0–100%) controls. The panel can fade while text remains bright.'},
    {'kind':'improved','label':'Alpha 19 Linux runtime preserved','text':'F interaction, scan-mode gating, capture, Gamescope/KDE behavior, security routing and the Alpha 19 Linux sidecar contract are carried forward unchanged.'},
  ]
}
out={'0.1.42-r31-alpha.20':entry}
out.update(d)
p.write_text(json.dumps(out, indent=2)+'\n')
PY

python3 - "$OUT" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
for rel in ['install-cachyos.sh','doctor.sh','bin/sc-blueprint-tracker']:
    p=root/rel
    if not p.exists(): continue
    s=p.read_text(errors='replace')
    s=s.replace('0.1.42-r31-alpha.19','0.1.42-r31-alpha.20')
    s=s.replace('r31 alpha 19','r31 alpha 20').replace('r31 Alpha 19','r31 Alpha 20')
    s=s.replace('r31-alpha19','r31-alpha20')
    p.write_text(s)
PY

cat > "$OUT/README.md" <<'DOC'
# ArchVerse Overlay 0.1.42-r31 Alpha 20 — Resource Scanner Field Test

Community Arch/CachyOS Linux port of SubliminalsTV SC Overlay 0.1.42.

Alpha 20 keeps the Alpha 19 Linux runtime and adds the Resource Scanner plus independent per-widget readability controls.

## Resource Scanner
- User-facing Mining Scanner name is now **Resource Scanner**.
- Known ship-minable signatures continue to resolve to their mineral/cluster matches.
- RS 3,000 is presented as the hand-mineable gemstone class; the exact individual gem is not guessed from RS alone.
- RS 2,000 is treated as a shared resource contact because harvestables and salvage can overlap there.
- Other whole 2,000 multiples are shown only as **Salvage Candidate — Unconfirmed**.
- The overlay does **not** announce debris from signature alone. `Salvageable debris` requires a positive salvage-specific confirmation hook.

## Widget appearance
Every canvas widget gets two independent controls in its widget settings:
- **Text brightness:** 25%–200%.
- **Window transparency:** 0%–100%.

Window transparency fades the panel/background tokens rather than applying opacity to the whole iframe, so text can remain bright while the window glass becomes nearly invisible.

## Linux behavior retained from Alpha 19
- Hold **F** to interact with widgets without first entering arrange mode.
- Shift+F6 arrange mode and hard click-through behavior.
- Startup modal focus restore and transparent-canvas focus release.
- Exact StarCitizen.exe session binding and Gamescope/KDE handling.
- Linux capture, isolated RapidOCR and structural Scan Mode gating.
- Upstream 0.1.42 routing/security behavior with the Linux `SC_TRACKER_CONFIG_DIR` compatibility shim.

## Install
```bash
./install-cachyos.sh --clean-install
```

Do **not** add `--reset-layout` if you want to keep your existing widget positions.

Keep Alpha 19 available as the immediate rollback point during this field test.
DOC

# ---------------------------------------------------------------------------
# 4. Package-level verification.
# ---------------------------------------------------------------------------
cat > "$OUT/verify-alpha.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for f in \
  app/electron/main.cjs \
  app/electron/capture.cjs \
  app/electron/scan-mode-gate.cjs \
  app/electron/linux/star-citizen-session.cjs \
  app/server/server.mjs \
  app/server/overlay/missions.html \
  app/server/overlay/mining.html \
  app/server/overlay/config.html \
  app/server/overlay/archverse-resource-scanner.js \
  app/server/overlay/archverse-widget-appearance.js \
  install-cachyos.sh \
  bin/sc-blueprint-tracker; do
  [[ -s "$root/$f" ]] || { echo "missing $f" >&2; exit 1; }
done

node --check "$root/app/server/overlay/archverse-resource-scanner.js"
node --check "$root/app/server/overlay/archverse-widget-appearance.js"
find "$root/app/electron" -type f \( -name '*.cjs' -o -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check

grep -q '0.1.42-r31-alpha.20' "$root/app/package.json"
grep -q 'Resource Scanner' "$root/app/server/overlay/mining.html"
grep -q 'Resource Scanner' "$root/app/server/overlay/missions.html"
grep -q 'ARCHVERSE_RESOURCE_SCANNER_V1' "$root/app/server/overlay/mining.html"
grep -q 'ARCHVERSE_WIDGET_APPEARANCE_V1' "$root/app/server/overlay/missions.html"
grep -q 'salvageConfirmed === true' "$root/app/server/overlay/archverse-resource-scanner.js"
grep -q 'Text brightness' "$root/app/server/overlay/archverse-widget-appearance.js"
grep -q 'Window transparency' "$root/app/server/overlay/archverse-widget-appearance.js"
grep -q 'Cross-origin requests are not accepted.' "$root/app/server/server.mjs"
grep -q 'scan-mode-gate.cjs' "$root/app/electron/capture.cjs"
bash -n "$root/install-cachyos.sh" "$root/bin/sc-blueprint-tracker" "$root/doctor.sh"

echo 'r31 Alpha 20 Resource Scanner package verification passed.'
SH

chmod +x "$OUT/verify-alpha.sh" "$OUT"/*.sh "$OUT/bin/sc-blueprint-tracker"
"$OUT/verify-alpha.sh"

# ---------------------------------------------------------------------------
# 5. Reproducible test artifacts.
# ---------------------------------------------------------------------------
cd "$TMP_ROOT"
tar -czf "$DIST/ArchVerse-Overlay-${VERSION}-arch.tar.gz" "$(basename "$OUT")"
zip -qr "$DIST/ArchVerse-Overlay-${VERSION}-arch.zip" "$(basename "$OUT")"
cd "$DIST"
sha256sum "ArchVerse-Overlay-${VERSION}-arch.tar.gz" "ArchVerse-Overlay-${VERSION}-arch.zip" > SHA256SUMS
sha256sum -c SHA256SUMS
cat SHA256SUMS

echo '[alpha20] Resource Scanner field-test build complete'
