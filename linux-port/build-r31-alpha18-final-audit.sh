#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/linux-port/build-r31-alpha18.sh"
BACKUP="${RUNNER_TEMP:-/tmp}/alpha18-base-before-config-contract.sh"
cp "$BASE" "$BACKUP"
trap 'cp "$BACKUP" "$BASE" 2>/dev/null || true' EXIT

# build-r31-alpha18.sh deliberately takes upstream 0.1.41's server source wholesale and then applies
# the Linux config-root/hotkey patch. The Settings/API profile normalization must run AFTER that
# patch, otherwise the older Linux patch would re-introduce the lightweight-only POST behavior.
python3 - "$BASE" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
needle='''p.write_text(s)
PY

python3 - "$WORK_DIR/overlay/changelog.json" "$A17/app/server/overlay/changelog.json" <<'PY'
'''
replacement='''p.write_text(s)
PY

python3 "$ROOT/linux-port/alpha18-config-contract-fixes.py" "$WORK_DIR"

python3 - "$WORK_DIR/overlay/changelog.json" "$A17/app/server/overlay/changelog.json" <<'PY'
'''
if needle not in s:
    raise SystemExit('final-audit wrapper: post-server config repair insertion anchor missing')
p.write_text(s.replace(needle,replacement,1))
PY

bash "$ROOT/linux-port/build-r31-alpha18-ci.sh" "$@"
