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
    req=urllib.request.Request(
        base+path,
        data=data,
        headers={'Content-Type':'application/json'} if data else {},
        method='POST' if data else 'GET',
    )
    with urllib.request.urlopen(req, timeout=2) as r:
        return json.loads(r.read())

def assert_linux_controls(obj, where):
    for key,want in [('interactHotkey','F'),('holdToInteract',True),('moveHotkey','Shift+F6')]:
        if obj.get(key) != want:
            raise SystemExit(f'[config-e2e] {where} {key}={obj.get(key)!r}, expected {want!r}')

def assert_screen_reading(reply, *, fab, mission, mining, profile, where):
    state=reply.get('screenReading')
    if not isinstance(state, dict):
        raise SystemExit(f'[config-e2e] {where} omitted screenReading applied-state: {reply!r}')
    want={
        'fabCapture': fab,
        'missionOcr': mission,
        'miningAssistant': mining,
        'profile': profile,
    }
    for key,value in want.items():
        if state.get(key) != value:
            raise SystemExit(f'[config-e2e] {where} screenReading.{key}={state.get(key)!r}, expected {value!r}')

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
assert_linux_controls(cfg, 'startup')
if cfg.get('legacySentinel') == 'wrong-path':
    raise SystemExit('[config-e2e] stale HOME config was adopted instead of canonical config')

# Try to defeat the immutable Linux interaction controls while selecting the Mining reader profile.
# The sidecar must repair F/hold/Shift+F6, derive profile="mining" from the actual reader booleans,
# return the applied screen-reader state that config.html verifies, persist it, and allow the local
# bounded mining-debug opt-in in a packaged Linux build.
mining_reply=request('/api/config', {
    'interactHotkey':'Q',
    'holdToInteract':False,
    'moveHotkey':'Alt+M',
    'screenReaderProfile':'bogus-client-value',
    'fabCapture':False,
    'missionOcr':False,
    'miningAssistant':True,
    'miningDebug':True,
})
assert_screen_reading(mining_reply, fab=False, mission=False, mining=True, profile='mining', where='mining POST')
cfg=request('/api/config')
assert_linux_controls(cfg, 'mining GET')
for key,want in [
    ('fabCapture',False),('missionOcr',False),('miningAssistant',True),
    ('screenReaderProfile','mining'),('miningDebug',True),
]:
    if cfg.get(key) != want:
        raise SystemExit(f'[config-e2e] mining GET {key}={cfg.get(key)!r}, expected {want!r}')

# Exercise a second non-default profile so a future merge cannot merely hard-code "mining" or
# "lightweight" and still pass. Balanced means mission OCR only.
balanced_reply=request('/api/config', {
    'interactHotkey':'Z',
    'holdToInteract':False,
    'moveHotkey':'Ctrl+M',
    'fabCapture':False,
    'missionOcr':True,
    'miningAssistant':False,
    'miningDebug':True,
})
assert_screen_reading(balanced_reply, fab=False, mission=True, mining=False, profile='balanced', where='balanced POST')
cfg=request('/api/config')
assert_linux_controls(cfg, 'balanced GET')
for key,want in [
    ('fabCapture',False),('missionOcr',True),('miningAssistant',False),
    ('screenReaderProfile','balanced'),('miningDebug',True),
]:
    if cfg.get(key) != want:
        raise SystemExit(f'[config-e2e] balanced GET {key}={cfg.get(key)!r}, expected {want!r}')

# Verify the final applied state made it to the canonical disk file, not only the HTTP response.
for _ in range(20):
    if expected.exists(): break
    time.sleep(.05)
if not expected.exists(): raise SystemExit('[config-e2e] canonical config.json was not written')
disk=json.loads(expected.read_text())
assert_linux_controls(disk, 'disk')
for key,want in [
    ('fabCapture',False),('missionOcr',True),('miningAssistant',False),
    ('screenReaderProfile','balanced'),('miningDebug',True),
]:
    if disk.get(key) != want:
        raise SystemExit(f'[config-e2e] disk {key}={disk.get(key)!r}, expected {want!r}')

print('[config-e2e] canonical path + immutable Linux controls + Settings applied-state/profile round trip PASS')
PY

kill -0 "$PID" 2>/dev/null || { echo '[config-e2e] server exited during config test' >&2; cat "$LOG" >&2; exit 113; }
