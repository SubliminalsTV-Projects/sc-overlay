#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/linux-port/build-r31-alpha18.sh"
BACKUP="${RUNNER_TEMP:-/tmp}/alpha18-base-build-before-ci-retry.sh"
cp "$BASE" "$BACKUP"
trap 'cp "$BACKUP" "$BASE" 2>/dev/null || true' EXIT

# onnxruntime-node downloads its native runtime from Microsoft's CDN in an npm install script.
# A transient CDN timeout should not be reported as a source/merge regression. Retry only this
# packaging install; all compile/test/audit failures remain immediately fatal.
python3 - "$BASE" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
old='''  NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm install --omit=dev --no-audit --no-fund --package-lock=true
'''
new='''  native_install_ok=0
  for native_install_attempt in 1 2 3; do
    echo "[alpha18] packaged native dependency install attempt ${native_install_attempt}/3"
    if NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm install --omit=dev --no-audit --no-fund --package-lock=true; then
      native_install_ok=1
      break
    fi
    if [[ "$native_install_attempt" -lt 3 ]]; then
      sleep $((native_install_attempt * 5))
    fi
  done
  [[ "$native_install_ok" -eq 1 ]] || { echo "[alpha18] packaged native dependency install failed after 3 attempts" >&2; exit 20; }
'''
if old not in s:
    raise SystemExit('CI retry wrapper: package npm install anchor missing')
p.write_text(s.replace(old,new,1))
PY

exec bash "$ROOT/linux-port/build-r31-alpha18-audited.sh" "$@"
