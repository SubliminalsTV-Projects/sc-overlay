#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${RUNNER_TEMP:-/tmp}"
WORK="$TMP/r31-alpha18-build/work"
PKG="$(find "$TMP" -type d -path '*/ArchVerse-Overlay-0.1.41-r31-alpha.18/app' -print | head -n1 || true)"

[[ -d "$WORK" ]] || { echo "[chat-security-audit] missing work tree" >&2; exit 2; }
[[ -n "$PKG" && -d "$PKG" ]] || { echo "[chat-security-audit] missing extracted package tree" >&2; exit 2; }

python3 - "$WORK" "$PKG" <<'PY'
from pathlib import Path
import sys
work=Path(sys.argv[1]); pkg=Path(sys.argv[2])

chat=(work/'src/chat.ts').read_text()
side=(work/'src/overlay-server.ts').read_text()
backend=(work/'chat-server/server.mjs').read_text()
html=(work/'overlay/chat.html').read_text()
pserver=(pkg/'server/server.mjs').read_text()
phtml=(pkg/'server/overlay/chat.html').read_text()

def guarded_segment(text: str, route: str, span: int = 900) -> bool:
    i=text.find(route)
    if i < 0:
        return False
    seg=text[i:i+span]
    return 'fromThisMachine' in seg and '403' in seg

checks = [
    ('client legacy location quarantine', 'LEGACY_UNATTESTED_CHAT_RE' in chat and 'if (!this.locationChannelsAllowed()) return;' in chat),
    ('client renderer restriction state', 'locationRestricted: !this.locationChannelsAllowed()' in chat),
    ('local GET chat loopback guard', 'Chat state is private to this machine.' in side),
    ('local SSE chat loopback guard', 'Chat state includes current shard/channel identifiers' in side),
    ('public health does not enumerate rooms', 'rooms: roomStats' not in backend and 'JSON.stringify({ ok: true })' in backend),
    ('site-mode client loc rejected', 'location_not_authorized' in backend),
    ('site-mode rooms from trusted auth only', 'id.channels ?? []' in backend),
    ('admin token authorization', 'adminAuthorized(req)' in backend and 'CHAT_ADMIN_TOKEN' in backend),
    ('chat UI security notice', 'id="securityNote"' in html and 'locationRestricted' in html),
    ('packaged GET chat loopback guard', guarded_segment(pserver, '/api/chat') and 'Chat state is private to this machine.' in pserver),
    ('packaged SSE chat loopback guard', guarded_segment(pserver, '/chat/events')),
    ('packaged sidecar location quarantine', 'chat.subliminal.gg' in pserver and 'locationRestricted' in pserver),
    ('packaged chat UI security notice', 'id="securityNote"' in phtml and 'locationRestricted' in phtml),
]
failed=[name for name,ok in checks if not ok]
for name,ok in checks:
    print(f"[chat-security-audit] {'PASS' if ok else 'FAIL'} {name}")
if failed:
    raise SystemExit('chat security audit failed: ' + ', '.join(failed))
print('[chat-security-audit] hardened local/private chat contracts PASS')
PY
