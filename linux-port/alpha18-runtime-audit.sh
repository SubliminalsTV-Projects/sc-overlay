#!/usr/bin/env bash
set -euo pipefail

TMP_ROOT="${RUNNER_TEMP:-/tmp}/r31-alpha18-build"
WORK="$TMP_ROOT/work"
TAR_ROOT="${RUNNER_TEMP:-/tmp}/dist"
TAR="$TAR_ROOT/ArchVerse-Overlay-0.1.41-r31-alpha.18-arch.tar.gz"
AUDIT_TMP="${RUNNER_TEMP:-/tmp}/alpha18-deep-audit"
PKG="$AUDIT_TMP/package"

[[ -d "$WORK/electron" ]] || { echo '[audit] generated work tree missing' >&2; exit 40; }
[[ -f "$TAR" ]] || { echo '[audit] generated package missing' >&2; exit 41; }
rm -rf "$AUDIT_TMP"
mkdir -p "$PKG"
tar -xzf "$TAR" -C "$PKG"
PKG_ROOT="$(find "$PKG" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[[ -n "$PKG_ROOT" && -d "$PKG_ROOT/app/electron" ]] || { echo '[audit] packaged app/electron missing' >&2; exit 42; }

check_syntax_tree() {
  local root="$1" label="$2"
  echo "[audit] syntax: $label"
  while IFS= read -r -d '' f; do node --check "$f"; done < <(find "$root/electron" -type f -name '*.cjs' -print0)
  if grep -R -n -E '^<<<<<<< |^\|\|\|\|\|\|\| |^=======|^>>>>>>> ' "$root/electron"; then
    echo "[audit] merge marker survived in $label" >&2
    exit 43
  fi
}
check_syntax_tree "$WORK" work
check_syntax_tree "$PKG_ROOT/app" package

# TypeScript's JavaScript checker is used here as a lexical/scope checker. We intentionally filter
# to error classes that indicate broken JavaScript contracts after a three-way merge: undefined
# identifiers, shorthand values with no binding, duplicate object properties/redeclarations, and
# use-before-declaration. Property-shape errors are ignored because these CommonJS files are not
# authored as typed JS and Electron is deliberately stubbed as `any` for this pass.
cat > "$AUDIT_TMP/globals.d.ts" <<'EOF'
declare var require: any;
declare var process: any;
declare var __dirname: string;
declare var __filename: string;
declare var module: any;
declare var exports: any;
declare var Buffer: any;
declare var global: any;
declare function setImmediate(callback: (...args:any[]) => void, ...args:any[]): any;
declare module "*";
EOF

js_scope_audit() {
  local root="$1" label="$2" out="$AUDIT_TMP/ts-${label}.txt"
  echo "[audit] lexical JS scope: $label"
  set +e
  (
    cd "$root"
    "$WORK/node_modules/.bin/tsc" \
      --allowJs --checkJs --noEmit --module commonjs --moduleResolution node --target ES2022 \
      --lib ES2022,DOM --skipLibCheck --noImplicitAny false --strict false \
      "$AUDIT_TMP/globals.d.ts" electron/*.cjs electron/linux/*.cjs
  ) >"$out" 2>&1
  set -e
  # TS1003 can be emitted by TypeScript's JSDoc parser for comments containing strings such as
  # '@225%'; it is not a JavaScript parser failure (node --check above is authoritative there).
  if grep -E 'error TS(2304|18004|1117|2451|2393|2448|2449|2454):' "$out"; then
    echo "[audit] lexical merge errors found in $label" >&2
    exit 44
  fi
}
js_scope_audit "$WORK" work
js_scope_audit "$PKG_ROOT/app" package

# A second ipcMain.handle for the same channel throws at runtime. Duplicate `on` handlers are not
# fatal to Electron but they double-fire actions and are almost always a conflict-splice regression.
python3 - "$WORK/electron/main.cjs" "$PKG_ROOT/app/electron/main.cjs" <<'PY'
from pathlib import Path
import re, sys
bad=False
for fn in sys.argv[1:]:
    s=Path(fn).read_text()
    hits={}
    for m in re.finditer(r'ipcMain\.(handle|on|once)\(\s*["\']([^"\']+)["\']', s):
        key=(m.group(1),m.group(2)); hits.setdefault(key,[]).append(s.count('\n',0,m.start())+1)
    dup={k:v for k,v in hits.items() if len(v)>1}
    if dup:
        bad=True
        print(f'[audit] duplicate ipc registrations in {fn}:', file=sys.stderr)
        for (kind,ch), lines in sorted(dup.items()): print(f'  {kind} {ch}: lines {lines}', file=sys.stderr)
if bad: raise SystemExit(45)
PY

# Every relative CommonJS dependency referenced by the packaged Electron shell must exist in the
# package. This catches a helper surviving a merge while its Linux-only file was forgotten.
python3 - "$PKG_ROOT/app/electron" <<'PY'
from pathlib import Path
import re, sys
root=Path(sys.argv[1]); bad=[]
for p in root.rglob('*.cjs'):
    s=p.read_text(errors='replace')
    for rel in re.findall(r'require\(\s*["\'](\.[^"\']+)["\']\s*\)', s):
        q=(p.parent/rel)
        choices=[q, Path(str(q)+'.cjs'), q/'index.cjs']
        if not any(x.exists() for x in choices): bad.append((p.relative_to(root),rel))
if bad:
    for p,rel in bad: print(f'[audit] missing relative require: {p} -> {rel}', file=sys.stderr)
    raise SystemExit(46)
PY

# Known high-risk merge seams. These are explicit because they have already caused field failures,
# and keeping them here turns each discovered class of regression into a permanent guardrail.
for root in "$WORK" "$PKG_ROOT/app"; do
  main="$root/electron/main.cjs"; cap="$root/electron/capture.cjs"; pre="$root/electron/preload.cjs"
  grep -q '^function sidecarLogStream()' "$main"
  grep -q 'const out = sidecarLogStream();' "$main"
  ! grep -q 'fs.closeSync(fd);' "$main"
  grep -q '^function setMiningVisible(' "$main"
  grep -q '^function sendBindingChartVisible(' "$main"
  grep -q '^function setBindingChartVisible(' "$main"
  grep -q '^function toggleBindingChart(' "$main"
  grep -q '^function toggleWebView(' "$main"
  grep -q '^function visualFingerprint(' "$cap"
  grep -q '^function fingerprintDistance(' "$cap"
  grep -q 'scan-mode-gate.cjs' "$cap"
  grep -q 'getStarCitizenSessionBinder' "$cap"
  # The old stray mining implementation must never again be spliced after ocrRapidLines' return.
  ! sed -n '/async function ocrRapidLines/,/^}/p' "$cap" | grep -q 'MINING_SIGNATURE_ROIS'
  node --check "$pre"
done

# Shell and installer syntax in the package is part of the release surface too.
while IFS= read -r -d '' f; do bash -n "$f"; done < <(find "$PKG_ROOT" -type f -name '*.sh' -print0)

echo '[audit] deep Alpha 18 merge/runtime audit PASS'
