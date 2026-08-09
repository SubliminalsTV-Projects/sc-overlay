#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/linux-port/build-r31-alpha18.sh"
BACKUP="${RUNNER_TEMP:-/tmp}/alpha18-base-before-config-contract.sh"
cp "$BASE" "$BACKUP"
trap 'cp "$BACKUP" "$BASE" 2>/dev/null || true' EXIT

# build-r31-alpha18.sh takes upstream 0.1.41's server source and then applies the Linux config-root /
# immutable-hotkey patch. Settings/API profile normalization must run AFTER that patch. Insert it at
# the unique start of the following changelog step; this avoids embedding a shell heredoc terminator
# inside another heredoc while still guaranteeing the server patch has already completed.
python3 - "$BASE" <<'PYFIX'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
anchor='python3 - "$WORK_DIR/overlay/changelog.json" "$A17/app/server/overlay/changelog.json" <<\'PY\''
insert='python3 "$ROOT/linux-port/alpha18-config-contract-fixes.py" "$WORK_DIR"\n\n' + anchor
if anchor not in s:
    raise SystemExit('final-audit wrapper: changelog anchor missing')
p.write_text(s.replace(anchor, insert, 1))
PYFIX

bash "$ROOT/linux-port/build-r31-alpha18-ci.sh" "$@"
