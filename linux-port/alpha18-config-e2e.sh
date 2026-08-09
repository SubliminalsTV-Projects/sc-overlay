#!/usr/bin/env bash
set -euo pipefail

RUN_TMP="${RUNNER_TEMP:-/tmp}"
TAR="$RUN_TMP/dist/ArchVerse-Overlay-0.1.41-r31-alpha.18-arch.tar.gz"
TMP="$RUN_TMP/alpha18-config-e2e"
rm -rf "$TMP"
mkdir -p "$TMP/package" "$TMP/home/sc-blueprint-tracker" "$TMP/canonical"
[[ -f "$TAR" ]] || { echo '[config-e2e] package tarball missing' >&2; exit 110; }
tar -xzf "$TAR" -C "$TMP/package"
PKG="$(find "$TMP/package" -mindepth 1 -maxdepth 1 -type d | head -n1)"
SERVER="$PKG/app/server/server.mjs"
[[ -f "$SERVER" ]] || { echo '[config-e2e] packaged server.mjs missing' >&2; exit 111; }

# Put an intentionally conflicting config in the old HOME-based location. The 0.1.41 Linux port's
# authoritative path is SC_TRACKER_CONFIG_DIR; a stale legacy file must not silently win merely
# because it exists.
cat > "$TMP/home/sc-blueprint-tracker/config.json" <<'JSON'
{"interactHotkey":"Q","holdToInteract":false,"moveHotkey":"Alt+M","miningDebug":false,"legacySentinel":"wrong-path"}
JSON

PORT="$(python3 - <<'PY'
import socket
s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()
PY
)"
INSTANCE="alpha18-config-e2e-$$"
LOG="$TMP/server.log"
HOME="$TMP/home" APPDATA="$TMP/home" SC_TRACKER_CONFIG_DIR="$TMP/canonical" \
APP_VERSION="0.1.41-r31-alpha.18" SC_INSTANCE="$INSTANCE" PORT="$PORT" \
node "$SERVER" >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT

python3 - "$PORT" "$INSTANCE" "$TMP/canonical" "$LOG" <<'PY'
from pathlib import Path
import json, sys, time, urllib.request
port=int(sys.argv[1]); instance=sys.argv[2]; canonical=Path(sys.argv[3]).resolve(); log=sys.argv[4]
base=f'http://127.0.0.1:{port}'

def request(path, body=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(base+path, data=data, headers={'Content-Type':'application/json'} if data else {}, method='POST' if data else 'GET')
    with urllib.request.urlopen(req, timeout=2) as r:
        return json.loads(r.read())

last=None
for _ in range(100):
    try:
        who=request('/api/instance')
        if who.get('instance') == instance: break
        last=who
    except Exception as e:
        last=repr(e); time.sleep(.05)
else:
    print('[config-e2e] server never became ready:', last, file=sys.stderr)
    try: print(Path(log).read_text()[-4000:], file=sys.stderr)
    except Exception: pass
    raise SystemExit(112)

diag=request('/api/diagnostics')
expected=(canonical/'config.json').resolve()
actual=Path(diag.get('data',{}).get('configPath','')).resolve()
if actual != expected:
    raise SystemExit(f'[config-e2e] wrong config path: got {actual}, expected {expected}')
if Path(diag.get('data',{}).get('userDir','')).resolve() != canonical:
    raise SystemExit(f'[config-e2e] wrong userDir: {diag.get("data",{}).get("userDir")}')

cfg=request('/api/config')
for key,want in [('interactHotkey','F'),('holdToInteract',True),('moveHotkey','Shift+F6')]:
    if cfg.get(key) != want: raise SystemExit(f'[config-e2e] startup {key}={cfg.get(key)!r}, expected {want!r}')
if cfg.get('legacySentinel') == 'wrong-path':
    raise SystemExit('[config-e2e] stale HOME config was adopted instead of canonical config')

# Try to defeat the Linux contract through the public settings API. The sidecar must repair these
# values before save, and packaged Linux must also accept the explicit bounded mining-debug opt-in.
request('/api/config', {
    'interactHotkey':'Q',
    'holdToInteract':False,
    'moveHotkey':'Alt+M',
    'screenReaderProfile':'anything-else',
    'miningDebug':True,
})
cfg=request('/api/config')
for key,want in [('interactHotkey','F'),('holdToInteract',True),('moveHotkey','Shift+F6'),('screenReaderProfile','lightweight'),('miningDebug',True)]:
    if cfg.get(key) != want: raise SystemExit(f'[config-e2e] repaired {key}={cfg.get(key)!r}, expected {want!r}')

# Verify the persisted file, not only the HTTP response.
for _ in range(20):
    if expected.exists(): break
    time.sleep(.05)
if not expected.exists(): raise SystemExit('[config-e2e] canonical config.json was not written')
disk=json.loads(expected.read_text())
for key,want in [('interactHotkey','F'),('holdToInteract',True),('moveHotkey','Shift+F6'),('screenReaderProfile','lightweight'),('miningDebug',True)]:
    if disk.get(key) != want: raise SystemExit(f'[config-e2e] disk {key}={disk.get(key)!r}, expected {want!r}')
print('[config-e2e] canonical path + mandatory Linux controls + miningDebug persistence PASS')
PY

kill -0 "$PID" 2>/dev/null || { echo '[config-e2e] server exited during config test' >&2; cat "$LOG" >&2; exit 113; }
