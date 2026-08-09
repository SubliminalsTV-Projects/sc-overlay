#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${RUNNER_TEMP:-/tmp}/alpha18-audit-wrapper"
mkdir -p "$TMP"
cp "$ROOT/linux-port/alpha18-runtime-audit.sh" "$TMP/audit.sh"

# `miningOpen` persistence is correct inside setMiningVisible(); the bad Alpha18 splice was a
# `persist` reference inside setWebViewVisible(). Remove the over-broad grep and replace it with a
# function-scoped assertion so the audit checks the bug without rejecting valid mining state.
python3 - "$TMP/audit.sh" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
bad="  ! grep -q 'if (persist) void postConfig({ miningOpen: miningVisible });' \"$main\"\n"
if bad not in s:
    raise SystemExit('audit wrapper: obsolete mining persist assertion missing')
s=s.replace(bad, '', 1)
needle='''  [[ "$(grep -c 'ipcMain.handle("app:widget-states"' "$main")" -eq 1 ]]
'''
insert='''  python3 - "$main" <<'PYWEB'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
a=s.find('function setWebViewVisible(')
b=s.find('function toggleWebView(', a)
if a < 0 or b < 0: raise SystemExit('audit: Web Page visibility functions missing')
body=s[a:b]
if 'persist' in body or 'miningOpen' in body or 'miningVisible' in body:
    raise SystemExit('audit: Web Page setter contains mining/persist splice residue')
PYWEB
  [[ "$(grep -c 'ipcMain.handle("app:widget-states"' "$main")" -eq 1 ]]
'''
if needle not in s:
    raise SystemExit('audit wrapper: IPC invariant anchor missing')
s=s.replace(needle, insert, 1)
p.write_text(s)
PY

exec bash "$TMP/audit.sh" "$@"
