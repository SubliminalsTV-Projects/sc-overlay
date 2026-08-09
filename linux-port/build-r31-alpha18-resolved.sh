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
repls = {
'''    if n == 12:\n        return O + T''': '''    if n == 12:\n        return T''',
'''    if n == 17: return T + O''': '''    if n == 17: return T + "}\\n" + O''',
'''    if n == 18: return O + T''': '''    if n == 18: return O + "}\\n" + T''',
}
for old,new in repls.items():
    if old not in s: raise SystemExit(f'resolver seam patch anchor missing: {old!r}')
    s=s.replace(old,new,1)

old="else: raise SystemExit('main: overlay registration anchor missing')"
new='''else:\n    anchor2 = '  });\\n  // Clear any cached copy'\n    insert2 = ''' + '"""' + '''  });\n  if (process.platform === \\"linux\\") {\n    overlayWindows.register(\\"Overlay Manager\\", overlay);\n    overlayWindows.pin(overlay);\n    browserController?.destroy();\n    browserController = new BrowserWidgetController({\n      WebContentsView, session, logger: console,\n      onInteractionClaim: (source) => claimFocusLatchedInteraction(`embedded-${source}`),\n      onNativeMouse: (source, mouse, b) => noteNativeMouseInput(`embedded-${source}`, mouse, b),\n      state: {\n        browserVisible, chatVisible: twitchChatVisible, url: browserRuntimeState.url, channel: browserRuntimeState.channel,\n        onState: (state) => {\n          browserRuntimeState = { ...browserRuntimeState, ...state }; browserVisible = !!state.browserVisible;\n          twitchChatVisible = !!state.chatVisible; writeBrowserState(state);\n          try { overlay?.webContents.send(\\"browser:state\\", state); } catch {}\n          pushWidgetStates();\n        },\n      },\n    });\n    browserController.attach(overlay);\n  }\n  // Clear any cached copy''' + '"""' + '''\n    if anchor2 in s: s=s.replace(anchor2, insert2, 1)\n    else: raise SystemExit('main: overlay registration anchor missing')'''
if old not in s: raise SystemExit('resolver fallback patch anchor missing')
s=s.replace(old,new,1)

# Two partial three-way hunks ended one line before their function close. Close the functions at
# the merge seam, not at EOF, so all later 0.1.41 handlers remain top-level.
needle='''    if (server) { server.kill(); server=null; }\n  });\n  app.on("will-quit", () => { if (trayIsUsable()) tray.destroy(); tray=null;  });\n}\n'''
replacement='''    if (server) { server.kill(); server=null; }\n  });\n  app.on("will-quit", () => { if (trayIsUsable()) tray.destroy(); tray=null;  });\n  });\n}\n'''
anchor='main.write_text(s)'
patch=f'''_ready_needle = {needle!r}\n_ready_replacement = {replacement!r}\nif _ready_needle in s:\n    s = s.replace(_ready_needle, _ready_replacement, 1)\nelse:\n    raise SystemExit("main: app-ready close anchor missing")\nmain.write_text(s)'''
if anchor not in s: raise SystemExit('resolver main-write anchor missing')
s=s.replace(anchor, patch, 1)

# Alpha17 already performs the active-Star-Citizen foreground/session gate immediately before the
# upstream hunk. Taking 0.1.41 conflict 6 literally would declare `fg` a second time. Keep the
# richer first gate and use its measured timing for 0.1.41's per-stage diagnostics.
cap_anchor='cap.write_text(s)'
cap_patch=r'''_dup_fg = ''' + repr('''    const tFg = Date.now();
    const fg = await foregroundWindow();
    if (!/^StarCitizen$/i.test(fg.name)) { emitContext("idle"); return; } // only ever look at SC
    busy = true;
    busyAt = Date.now();
    // Per-stage timings for THIS tick. The loop self-tunes off the tick's total cost
    // (floor = lastTickMs * 1.5), so when a tick is slow the "fast" rate stops being fast — which
    // means knowing WHICH stage is expensive decides whether that is fixable. Filled in as the
    // tick proceeds and flushed with the heartbeat, so measuring costs no extra round-trips.
    const stage = { foreground: Date.now() - tFg };
''') + r'''
_fg_once = ''' + repr('''    busy = true;
    busyAt = Date.now();
    // Per-stage timings for THIS tick. Alpha17's foreground/session gate above is the authoritative
    // Linux gate; retain 0.1.41's timing telemetry without a second foreground lookup.
    const stage = { foreground: timings.foreground ?? 0 };
''') + r'''
if _dup_fg in s:
    s = s.replace(_dup_fg, _fg_once, 1)
else:
    raise SystemExit("capture: duplicate foreground seam missing")
cap.write_text(s)'''
if cap_anchor not in s: raise SystemExit('resolver capture-write anchor missing')
s=s.replace(cap_anchor, cap_patch, 1)
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
p.write_text(s)
PY
exec bash "$TMP/build.sh" "$@"
