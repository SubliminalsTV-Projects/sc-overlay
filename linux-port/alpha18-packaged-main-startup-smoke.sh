#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/linux-port/alpha18-main-startup-smoke.sh"
TMP="${RUNNER_TEMP:-/tmp}/alpha18-packaged-startup-wrapper"
rm -rf "$TMP"
mkdir -p "$TMP"
cp "$BASE" "$TMP/smoke.sh"

# The original harness tested both the unbundled work tree and packaged app while advertising a
# packaged-runtime contract. The work tree intentionally has no ROOT/server/server.mjs yet, so that
# first invocation can only exercise the developer path and produced a misleading uncaught warning.
# Keep this test precise: app.isPackaged=true is validated only against the package that contains the
# bundled server. The real Arch system-Electron/app.isPackaged=false case has its own separate gate.
python3 - "$TMP/smoke.sh" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
old='''node "$TMP/main-smoke.cjs" "$WORK/electron/main.cjs"
node "$TMP/main-smoke.cjs" "$PKG_ROOT/app/electron/main.cjs"

echo '[startup-smoke] generated tree + packaged main-process startup PASS'
'''
new='''node "$TMP/main-smoke.cjs" "$PKG_ROOT/app/electron/main.cjs"

echo '[packaged-startup-smoke] app.isPackaged=true packaged main-process startup PASS'
'''
if old not in s:
    raise SystemExit('packaged-startup: invocation tail missing')
p.write_text(s.replace(old,new,1))
PY

exec bash "$TMP/smoke.sh"
