#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${RUNNER_TEMP:-/tmp}/alpha18-audited-wrapper"
mkdir -p "$TMP"
cp "$ROOT/linux-port/build-r31-alpha18-resolved.sh" "$TMP/build.sh"

# The resolved builder computes ROOT from its own path. Because this audit wrapper executes a
# temporary copy, pin ROOT back to the checked-out repository and point its semantic repair hook at
# the 0.1.42-aware reconstruction+normalization chain. The underlying packaging/test logic remains
# unchanged and publication stays outside this wrapper.
python3 - "$TMP/build.sh" "$ROOT" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); root=sys.argv[2]
s=p.read_text()
root_line='ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"'
if root_line not in s:
    raise SystemExit('audited wrapper: ROOT anchor missing')
s=s.replace(root_line, f'ROOT={root!r}', 1)
old='REPAIR="$ROOT/linux-port/alpha18-semantic-repair.py"'
new='REPAIR="$ROOT/linux-port/alpha19-semantic-chain.py"'
if old not in s:
    raise SystemExit('audited wrapper: semantic repair anchor missing')
s=s.replace(old,new,1)
p.write_text(s)
PY

exec bash "$TMP/build.sh" "$@"
