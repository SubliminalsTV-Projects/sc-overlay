#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${RUNNER_TEMP:-/tmp}/alpha18-audit-wrapper"
mkdir -p "$TMP"
cp "$ROOT/linux-port/alpha18-runtime-audit.sh" "$TMP/audit.sh"

# Patch the audit harness itself before running it. With `set -u`, Bash expands the RHS of every
# assignment in a single `local` command before later names in that same command are initialized.
# Therefore `local root="$1" label="$2" out="...${label}..."` trips on an unbound `label` even
# though the app under test is fine. Declare these locals separately.
python3 - "$TMP/audit.sh" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
local_bad='''  local root="$1" label="$2" out="$AUDIT_TMP/ts-${label}.txt"
'''
local_good='''  local root="$1"
  local label="$2"
  local out="$AUDIT_TMP/ts-${label}.txt"
'''
if local_bad not in s:
    raise SystemExit('audit wrapper: js_scope_audit local declaration anchor missing')
s=s.replace(local_bad, local_good, 1)

# `miningOpen` persistence is correct inside setMiningVisible(); the bad Alpha18 splice was a
# `persist` reference inside setWebViewVisible(). Remove the over-broad grep and replace it with a
# function-scoped assertion so the audit checks the bug without rejecting valid mining state.
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

bash "$TMP/audit.sh" "$@"
bash "$ROOT/linux-port/alpha18-chat-security-audit.sh"
