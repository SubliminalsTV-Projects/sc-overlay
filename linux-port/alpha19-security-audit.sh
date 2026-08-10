#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${RUNNER_TEMP:-/tmp}"
WORK="$TMP/r31-alpha19-build/work"
PKG="$(find "$TMP" -type d -path '*/ArchVerse-Overlay-0.1.42-r31-alpha.19/app' -print | head -n1 || true)"

[[ -d "$WORK" ]] || { echo '[alpha19-security] missing reconstructed work tree' >&2; exit 2; }
[[ -n "$PKG" && -d "$PKG" ]] || { echo '[alpha19-security] missing packaged Alpha 19 app' >&2; exit 2; }

# The mature regression harnesses intentionally keep their Alpha18 temp-root name. Point that name
# at this candidate's tree instead of editing years-worth of path assumptions in every proven test.
rm -rf "$TMP/r31-alpha18-build"
ln -s "$TMP/r31-alpha19-build" "$TMP/r31-alpha18-build"

python3 - "$WORK" "$PKG" <<'PY'
from pathlib import Path
import sys
work=Path(sys.argv[1]); pkg=Path(sys.argv[2])
side=(work/'src/overlay-server.ts').read_text()
chat=(work/'src/chat.ts').read_text()
backend=(work/'chat-server/server.mjs').read_text()
pserver=(pkg/'server/server.mjs').read_text()

checks = [
  ('0.1.42 source version', '"version": "0.1.42-r31-alpha.19"' in (work/'package.json').read_text()),
  ('central mutating/sensitive network policy', 'const mutating = req.method !== "GET" && req.method !== "HEAD"' in side and 'SENSITIVE_GET' in side),
  ('cross-origin sensitive-route rejection', 'Cross-origin requests are not accepted.' in side and 'req.headers.origin' in side),
  ('static path containment', 'decodeURIComponent(p)' in side and 'const target = resolve(overlayDir' in side and 'target.startsWith(root)' in side),
  ('chat state LAN guard', '/api/chat' in side and '/chat/events' in side and 'fromThisMachine(req)' in side),
  ('chat websocket payload cap', 'maxPayload: 16 * 1024' in backend),
  ('chat dev-auth deploy guard', 'CHAT_ALLOW_DEV_AUTH' in backend and 'REFUSING TO START' in backend),
  ('chat access-attempt rate limit', 'ACT_N = 12' in backend and 'ACT_WINDOW_MS = 30_000' in backend),
  ('public health room-map removed', 'if (url === "/admin/health"' in backend and 'roomStats' in backend),
  ('room impersonation guard', 'reservedNames' in backend and 'name_reserved' in backend),
  ('ArchVerse location authorization quarantine', 'ARCHVERSE_UNATTESTED_LOCATION_RE' in chat and 'if (!this.locationChannelsAllowed()) return;' in chat),
  ('packaged sidecar contains origin rejection', 'Cross-origin requests are not accepted.' in pserver),
  ('packaged sidecar contains containment rejection', 'forbidden' in pserver),
]
failed=[name for name,ok in checks if not ok]
for name,ok in checks:
    print(f"[alpha19-security] {'PASS' if ok else 'FAIL'} {name}")
if failed:
    raise SystemExit('alpha19 security static audit failed: ' + ', '.join(failed))
PY

PORT=$((19000 + RANDOM % 15000))
CFG="$(mktemp -d)"
SERVER_LOG="$TMP/alpha19-sidecar-security.log"
PORT="$PORT" SC_TRACKER_CONFIG_DIR="$CFG" APP_VERSION="0.1.42-r31-alpha.19" \
  node "$PKG/server/server.mjs" >"$SERVER_LOG" 2>&1 &
SPID=$!
trap 'kill "$SPID" 2>/dev/null || true; wait "$SPID" 2>/dev/null || true; rm -rf "$CFG"' EXIT

ready=0
for _ in $(seq 1 80); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/instance" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  echo '[alpha19-security] sidecar failed to start' >&2
  cat "$SERVER_LOG" >&2 || true
  exit 3
fi

code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$@"; }

[[ "$(code "http://127.0.0.1:$PORT/missions.html")" == 200 ]] || { echo '[alpha19-security] missions.html loopback failed' >&2; exit 4; }
[[ "$(code "http://127.0.0.1:$PORT/..%2f..%2felectron%2fmain.cjs")" == 403 ]] || { echo '[alpha19-security] encoded traversal was not refused' >&2; exit 5; }
[[ "$(code -H 'Origin: https://evil.example' "http://127.0.0.1:$PORT/api/config")" == 403 ]] || { echo '[alpha19-security] evil-origin GET /api/config was not refused' >&2; exit 6; }
[[ "$(code -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' --data '{}' "http://127.0.0.1:$PORT/api/config")" == 403 ]] || { echo '[alpha19-security] evil-origin POST /api/config was not refused' >&2; exit 7; }
[[ "$(code "http://127.0.0.1:$PORT/api/config")" == 200 ]] || { echo '[alpha19-security] legitimate loopback config read failed' >&2; exit 8; }

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
if [[ -n "$LAN_IP" && "$LAN_IP" != 127.* ]]; then
  [[ "$(code "http://$LAN_IP:$PORT/missions.html")" == 200 ]] || { echo '[alpha19-security] read-only OBS surface was not preserved on LAN' >&2; exit 9; }
  [[ "$(code "http://$LAN_IP:$PORT/api/config")" == 403 ]] || { echo '[alpha19-security] LAN config read was not refused' >&2; exit 10; }
  [[ "$(code "http://$LAN_IP:$PORT/api/chat")" == 403 ]] || { echo '[alpha19-security] LAN chat state read was not refused' >&2; exit 11; }
  [[ "$(code "http://$LAN_IP:$PORT/chat/events")" == 403 ]] || { echo '[alpha19-security] LAN chat SSE read was not refused' >&2; exit 12; }
fi

kill "$SPID" 2>/dev/null || true
wait "$SPID" 2>/dev/null || true
trap - EXIT
rm -rf "$CFG"

echo '[alpha19-security] packaged sidecar path/origin/LAN security E2E PASS'
