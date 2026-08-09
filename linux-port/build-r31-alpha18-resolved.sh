#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${RUNNER_TEMP:-/tmp}/alpha18-wrapper"
mkdir -p "$TMP"
cp "$ROOT/linux-port/build-r31-alpha18.sh" "$TMP/build.sh"
cp "$ROOT/linux-port/alpha18-resolve-conflicts.py" "$TMP/resolver.py"

python3 - "$TMP/resolver.py" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
old12='''    if n == 12:\n        return O + T'''
new12='''    if n == 12:\n        return T'''
if old12 not in s: raise SystemExit('resolver conflict12 patch anchor missing')
s=s.replace(old12,new12,1)

old="else: raise SystemExit('main: overlay registration anchor missing')"
new='''else:\n    anchor2 = '  });\\n  // Clear any cached copy'\n    insert2 = ''' + '"""' + '''  });\n  if (process.platform === \\"linux\\") {\n    overlayWindows.register(\\"Overlay Manager\\", overlay);\n    overlayWindows.pin(overlay);\n    browserController?.destroy();\n    browserController = new BrowserWidgetController({\n      WebContentsView, session, logger: console,\n      onInteractionClaim: (source) => claimFocusLatchedInteraction(`embedded-${source}`),\n      onNativeMouse: (source, mouse, b) => noteNativeMouseInput(`embedded-${source}`, mouse, b),\n      state: {\n        browserVisible, chatVisible: twitchChatVisible, url: browserRuntimeState.url, channel: browserRuntimeState.channel,\n        onState: (state) => {\n          browserRuntimeState = { ...browserRuntimeState, ...state }; browserVisible = !!state.browserVisible;\n          twitchChatVisible = !!state.chatVisible; writeBrowserState(state);\n          try { overlay?.webContents.send(\\"browser:state\\", state); } catch {}\n          pushWidgetStates();\n        },\n      },\n    });\n    browserController.attach(overlay);\n  }\n  // Clear any cached copy''' + '"""' + '''\n    if anchor2 in s: s=s.replace(anchor2, insert2, 1)\n    else: raise SystemExit('main: overlay registration anchor missing')'''
if old not in s: raise SystemExit('resolver fallback patch anchor missing')
s=s.replace(old,new,1)

needle='''    if (server) { server.kill(); server=null; }\n  });\n  app.on("will-quit", () => { if (trayIsUsable()) tray.destroy(); tray=null;  });\n}\n'''
replacement='''    if (server) { server.kill(); server=null; }\n  });\n  app.on("will-quit", () => { if (trayIsUsable()) tray.destroy(); tray=null;  });\n  });\n}\n'''
anchor='main.write_text(s)'
patch=f'''_ready_needle = {needle!r}\n_ready_replacement = {replacement!r}\nif _ready_needle in s:\n    s = s.replace(_ready_needle, _ready_replacement, 1)\nelse:\n    raise SystemExit("main: app-ready close anchor missing")\nmain.write_text(s)'''
if anchor not in s: raise SystemExit('resolver main-write anchor missing')
s=s.replace(anchor, patch, 1)
p.write_text(s)
PY

python3 - "$TMP/build.sh" "$TMP/resolver.py" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); resolver=sys.argv[2]
s=p.read_text()
old='''if [[ -s "$CONFLICTS" ]]; then
  echo "[alpha18] unresolved three-way conflicts:" >&2
  cat "$CONFLICTS" >&2
  echo "[alpha18] markers:" >&2
  grep -R -n '^<<<<<<<\\|^|||||||\\|^=======\\|^>>>>>>>' "$WORK_DIR/electron" "$WORK_DIR/overlay" >&2 || true
  exit 10
fi
'''
new=f'''if [[ -s "$CONFLICTS" ]]; then
  echo "[alpha18] resolving overlapping hunks with the Alpha18 semantic resolver"
  python3 "{resolver}" "$WORK_DIR"
  if grep -R -n '^<<<<<<<\\|^|||||||\\|^=======\\|^>>>>>>>' "$WORK_DIR/electron" "$WORK_DIR/overlay"; then
    exit 10
  fi
fi
'''
if old not in s: raise SystemExit('conflict gate anchor not found')
s=s.replace(old,new,1)
check='node --check electron/main.cjs'
diag='''if ! node --check electron/main.cjs; then
  echo "[alpha18] resolved main.cjs still has an EOF delimiter imbalance; probing suffixes" >&2
  cp electron/main.cjs /tmp/a18-main-base.cjs
  for spec in 'brace:}' 'paren:);' 'callback:});' 'bracket:];' 'brace2:}}' 'callback2:});});' 'callback_brace:});}' 'brace_callback:}});'; do
    name="${spec%%:*}"; suffix="${spec#*:}"
    cp /tmp/a18-main-base.cjs "/tmp/a18-$name.cjs"
    printf '\n%s\n' "$suffix" >> "/tmp/a18-$name.cjs"
    if node --check "/tmp/a18-$name.cjs" >/dev/null 2>&1; then
      echo "[alpha18-delim] suffix $name ($suffix) makes syntax valid" >&2
    else
      msg=$(node --check "/tmp/a18-$name.cjs" 2>&1 | tail -n 4 | tr '\n' ' ')
      echo "[alpha18-delim] $name => $msg" >&2
    fi
  done
  nl -ba electron/main.cjs | tail -n 140 >&2
  exit 12
fi'''
if check not in s: raise SystemExit('main node-check anchor missing')
s=s.replace(check,diag,1)
p.write_text(s)
PY
exec bash "$TMP/build.sh" "$@"
