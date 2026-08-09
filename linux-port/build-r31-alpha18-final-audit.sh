#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/linux-port/build-r31-alpha18.sh"
REPAIR="$ROOT/linux-port/alpha18-config-contract-fixes.py"
BACKUP="${RUNNER_TEMP:-/tmp}/alpha18-base-before-config-contract.sh"
cp "$BASE" "$BACKUP"
trap 'cp "$BACKUP" "$BASE" 2>/dev/null || true' EXIT

# build-r31-alpha18.sh takes upstream 0.1.41's server source and then applies the Linux config-root /
# immutable-hotkey patch. Settings/API profile normalization must run AFTER that patch. Insert it at
# the unique start of the following changelog step. Use the absolute repository path to the repair
# script because the audited builder is intentionally copied through temporary wrapper directories.
python3 - "$BASE" "$REPAIR" <<'PYFIX'
from pathlib import Path
import shlex, sys
p=Path(sys.argv[1]); repair=Path(sys.argv[2]).resolve(); s=p.read_text()
anchor='python3 - "$WORK_DIR/overlay/changelog.json" "$A17/app/server/overlay/changelog.json" <<\'PY\''
insert=f'python3 {shlex.quote(str(repair))} "$WORK_DIR"\n\n' + anchor
if anchor not in s:
    raise SystemExit('final-audit wrapper: changelog anchor missing')
p.write_text(s.replace(anchor, insert, 1))
PYFIX

bash "$ROOT/linux-port/build-r31-alpha18-ci.sh" "$@"
