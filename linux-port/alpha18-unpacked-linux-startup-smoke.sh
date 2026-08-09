#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/linux-port/alpha18-main-startup-smoke.sh"
TMP="${RUNNER_TEMP:-/tmp}/alpha18-unpacked-startup-wrapper"
rm -rf "$TMP"
mkdir -p "$TMP"
cp "$BASE" "$TMP/smoke.sh"

# The normal startup smoke models an electron-builder style installation. ArchVerse intentionally
# installs an unpacked app directory and launches it with CachyOS/Arch's system Electron, so
# app.isPackaged is FALSE in the real runtime. Reuse the same executed main-process harness but
# force that exact condition and run only the extracted production package target.
python3 - "$TMP/smoke.sh" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
old='''  isPackaged: true,
'''
new='''  // Arch/CachyOS production layout: unpacked app directory under system Electron.
  isPackaged: false,
'''
if old not in s:
    raise SystemExit('unpacked-startup: app.isPackaged harness anchor missing')
s=s.replace(old,new,1)
old_tail='''node "$TMP/main-smoke.cjs" "$WORK/electron/main.cjs"
node "$TMP/main-smoke.cjs" "$PKG_ROOT/app/electron/main.cjs"

echo '[startup-smoke] generated tree + packaged main-process startup PASS'
'''
new_tail='''node "$TMP/main-smoke.cjs" "$PKG_ROOT/app/electron/main.cjs"

echo '[unpacked-startup-smoke] app.isPackaged=false + bundled server.mjs production path PASS'
'''
if old_tail not in s:
    raise SystemExit('unpacked-startup: smoke invocation tail missing')
s=s.replace(old_tail,new_tail,1)
p.write_text(s)
PY

exec bash "$TMP/smoke.sh"
