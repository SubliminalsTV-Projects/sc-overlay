#!/usr/bin/env bash
set -euo pipefail

RUN_TMP="${RUNNER_TEMP:-/tmp}"
TAR="$RUN_TMP/dist/ArchVerse-Overlay-0.1.41-r31-alpha.18-arch.tar.gz"
TMP="$RUN_TMP/alpha18-sidecar-smoke"
rm -rf "$TMP"
mkdir -p "$TMP/package" "$TMP/home" "$TMP/config"
[[ -f "$TAR" ]] || { echo '[sidecar-smoke] package tarball missing' >&2; exit 80; }
tar -xzf "$TAR" -C "$TMP/package"
PKG_ROOT="$(find "$TMP/package" -mindepth 1 -maxdepth 1 -type d | head -n1)"
SERVER="$PKG_ROOT/app/server/server.mjs"
[[ -f "$SERVER" ]] || { echo '[sidecar-smoke] packaged server.mjs missing' >&2; exit 81; }

PORT="$(python3 - <<'PY'
import socket
s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()
PY
)"
INSTANCE="alpha18-sidecar-smoke-$$"
LOG="$TMP/server.log"

HOME="$TMP/home" \
APPDATA="$TMP/home" \
SC_TRACKER_CONFIG_DIR="$TMP/config" \
APP_VERSION="0.1.41-r31-alpha.18" \
SC_INSTANCE="$INSTANCE" \
PORT="$PORT" \
node "$SERVER" >"$LOG" 2>&1 &
PID=$!
cleanup() {
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
}
trap cleanup EXIT

python3 - "$PORT" "$INSTANCE" "$LOG" <<'PY'
import json, sys, time, urllib.request
port=int(sys.argv[1]); instance=sys.argv[2]; log=sys.argv[3]
base=f'http://127.0.0.1:{port}'
last=None
for _ in range(100):
    try:
        with urllib.request.urlopen(base+'/api/instance', timeout=.5) as r:
            data=json.load(r)
        if data.get('instance') == instance:
            if data.get('version') != '0.1.41-r31-alpha.18':
                raise SystemExit(f"[sidecar-smoke] wrong version: {data}")
            break
        last=f'wrong instance payload: {data}'
    except Exception as e:
        last=repr(e); time.sleep(.05)
else:
    print('[sidecar-smoke] server never became ready:', last, file=sys.stderr)
    try: print(open(log).read()[-5000:], file=sys.stderr)
    except Exception: pass
    raise SystemExit(82)

for path in ('/api/missions','/missions.html'):
    with urllib.request.urlopen(base+path, timeout=2) as r:
        body=r.read()
        if r.status != 200 or not body:
            raise SystemExit(f'[sidecar-smoke] {path} returned status={r.status} bytes={len(body)}')
print('[sidecar-smoke] packaged server.mjs startup/endpoints PASS')
PY

# The server is expected to remain alive after the endpoint probes.
kill -0 "$PID" 2>/dev/null || { echo '[sidecar-smoke] server exited after startup probes' >&2; cat "$LOG" >&2; exit 83; }
