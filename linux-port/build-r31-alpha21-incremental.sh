#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ALPHA18_ARCHIVE="${1:-${ALPHA18_ARCHIVE:-}}"
[[ -n "$ALPHA18_ARCHIVE" && -f "$ALPHA18_ARCHIVE" ]] || { echo "Alpha 18 archive missing: $ALPHA18_ARCHIVE" >&2; exit 2; }

VERSION="0.1.42-r31-alpha.21"
A20_VERSION="0.1.42-r31-alpha.20"
RUNNER="${RUNNER_TEMP:-/tmp}"
TMP_ROOT="$RUNNER/r31-alpha21-build"
A20_ROOT="$RUNNER/r31-alpha20-build/ArchVerse-Overlay-${A20_VERSION}"
OUT="$TMP_ROOT/ArchVerse-Overlay-${VERSION}"
DIST="$RUNNER/dist-alpha21"

rm -rf "$TMP_ROOT" "$DIST"
mkdir -p "$TMP_ROOT" "$DIST"

# Rebuild the exact Alpha 20 package path first, then layer only the two log-derived runtime fixes.
echo "[alpha21] rebuilding tested Alpha 20 baseline"
bash "$ROOT/linux-port/build-r31-alpha20-incremental.sh" "$ALPHA18_ARCHIVE"
[[ -s "$A20_ROOT/app/electron/capture.cjs" && -s "$A20_ROOT/app/server/overlay/archverse-resource-scanner.js" ]] || {
  echo "[alpha21] Alpha 20 working package was not produced" >&2
  exit 3
}

cp -a "$A20_ROOT" "$OUT"
python3 "$ROOT/linux-port/alpha21-runtime-log-fixes.py" "$OUT"

python3 - "$OUT/app/package.json" <<'PY'
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); d=json.loads(p.read_text())
d['version']='0.1.42-r31-alpha.21'
d['description']='Community Linux port of SubliminalsTV SC Overlay 0.1.42 — Alpha 20 Resource Scanner plus runtime log fixes'
p.write_text(json.dumps(d, indent=2)+'\n')
PY

python3 - "$OUT/app/server/overlay/changelog.json" <<'PY'
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); d=json.loads(p.read_text())
entry={
  'date':'2026-08-11T01:45:00Z',
  'notes':[
    {'kind':'fixed','label':'OCR watchdog overlap','text':'A slow Fabricator/Mining OCR tick is no longer force-unlocked while its async native/OCR work is still alive. Alpha 21 skips overlapping polls and lets only the original tick release the busy guard.'},
    {'kind':'fixed','label':'KDE Spectacle screenshot race','text':'Wayland screenshot capture now waits longer for a stable file and verifies that Electron can decode the PNG before accepting it, reducing false fallbacks caused by the portal returning before the file writer finishes.'},
    {'kind':'improved','label':'Alpha 20 behavior preserved','text':'Resource Scanner classification, salvage confirmation rules, per-widget text brightness/window transparency, F interaction, focus handoff, Scan Mode gating and upstream 0.1.42 security behavior are otherwise unchanged.'},
  ]
}
out={'0.1.42-r31-alpha.21':entry}
out.update(d)
p.write_text(json.dumps(out, indent=2)+'\n')
PY

python3 - "$OUT" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
for rel in ['install-cachyos.sh','doctor.sh','bin/sc-blueprint-tracker','README.md']:
    p=root/rel
    if not p.exists(): continue
    s=p.read_text(errors='replace')
    s=s.replace('0.1.42-r31-alpha.20','0.1.42-r31-alpha.21')
    s=s.replace('r31 alpha 20','r31 alpha 21').replace('r31 Alpha 20','r31 Alpha 21')
    s=s.replace('r31-alpha20','r31-alpha21')
    p.write_text(s)
PY

cat > "$OUT/README.md" <<'DOC'
# ArchVerse Overlay 0.1.42-r31 Alpha 21 — Log-Fix Field Test

Alpha 21 is Alpha 20's Resource Scanner build with two conservative runtime fixes taken directly from the Alpha 20 field log.

## Fixed from the Alpha 20 log
- **No OCR watchdog overlap:** if a capture/OCR cycle runs longer than 15 seconds, the next poll is skipped instead of clearing the busy guard and starting a second native OCR cycle on top of the first.
- **More reliable Spectacle capture:** KDE/Wayland screenshot capture waits up to 6 seconds for a stable, decodable PNG before declaring the Spectacle backend unavailable.

## Intentionally unchanged
- Resource Scanner and its safe mineral/gem/harvestable/salvage-candidate wording.
- No signature-only "Salvageable debris" callout.
- Independent per-widget Text brightness and Window transparency controls.
- Held-F interaction, transparent-canvas focus release, Shift+F6 arrange mode and Gamescope/KDE pointer handling.
- Structural Scan Mode detector and OCR isolation.
- Upstream 0.1.42 routing/security behavior.

The Chromium messages `Frame latency is negative`, X11 atom-cache additions, the RADV conformance warning and the initial XKB helper warning are external diagnostics rather than ArchVerse faults, so Alpha 21 does not hide or work around them.

Install:
```bash
./install-cachyos.sh --clean-install
```

Do not add `--reset-layout` if you want to preserve the existing widget positions.
DOC

cat > "$OUT/verify-alpha.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for f in \
  app/electron/main.cjs \
  app/electron/capture.cjs \
  app/electron/rapidocr-client.cjs \
  app/electron/scan-mode-gate.cjs \
  app/server/server.mjs \
  app/server/overlay/mining.html \
  app/server/overlay/archverse-resource-scanner.js \
  app/server/overlay/archverse-widget-appearance.js \
  install-cachyos.sh \
  bin/sc-blueprint-tracker; do
  [[ -s "$root/$f" ]] || { echo "missing $f" >&2; exit 1; }
done

node --check "$root/app/electron/capture.cjs"
find "$root/app/electron" -type f \( -name '*.cjs' -o -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check

grep -q '0.1.42-r31-alpha.21' "$root/app/package.json"
grep -q 'Resource Scanner' "$root/app/server/overlay/mining.html"
grep -q 'salvageConfirmed === true' "$root/app/server/overlay/archverse-resource-scanner.js"
grep -q 'timeoutMs = 6000' "$root/app/electron/capture.cjs"
grep -q 'complete decodable screenshot' "$root/app/electron/capture.cjs"
grep -q 'prior OCR tick still running after' "$root/app/electron/capture.cjs"
grep -q 'skipping overlap' "$root/app/electron/capture.cjs"
! grep -q 'tick watchdog: a prior tick hung — re-arming the loop' "$root/app/electron/capture.cjs"
grep -q 'queueDepth' "$root/app/electron/rapidocr-client.cjs"
grep -q 'Cross-origin requests are not accepted.' "$root/app/server/server.mjs"
grep -q 'scan-mode-gate.cjs' "$root/app/electron/capture.cjs"
bash -n "$root/install-cachyos.sh" "$root/bin/sc-blueprint-tracker" "$root/doctor.sh"

echo 'r31 Alpha 21 log-fix package verification passed.'
SH

chmod +x "$OUT/verify-alpha.sh" "$OUT"/*.sh "$OUT/bin/sc-blueprint-tracker"
"$OUT/verify-alpha.sh"

cd "$TMP_ROOT"
tar -czf "$DIST/ArchVerse-Overlay-${VERSION}-arch.tar.gz" "$(basename "$OUT")"
zip -qr "$DIST/ArchVerse-Overlay-${VERSION}-arch.zip" "$(basename "$OUT")"
cd "$DIST"
sha256sum "ArchVerse-Overlay-${VERSION}-arch.tar.gz" "ArchVerse-Overlay-${VERSION}-arch.zip" > SHA256SUMS
sha256sum -c SHA256SUMS
cat SHA256SUMS

echo '[alpha21] log-fix field-test build complete'
