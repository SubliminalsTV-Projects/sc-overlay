#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export ARCHVERSE_REPO_ROOT="$ROOT"
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
if old not in s:
    raise SystemExit('conflict gate anchor not found')
s=s.replace(old,new,1)
check='node --check electron/main.cjs'
diag='''if ! node --check electron/main.cjs; then
  echo "[alpha18] resolved main.cjs syntax context:" >&2
  nl -ba electron/main.cjs | sed -n '3150,3235p' >&2
  if [[ -n "${ARCHVERSE_REPO_ROOT:-}" && -d "$ARCHVERSE_REPO_ROOT/.git" ]]; then
    snapshot="${RUNNER_TEMP:-/tmp}/alpha18-resolved-main.cjs"
    cp electron/main.cjs "$snapshot"
    (
      cd "$ARCHVERSE_REPO_ROOT"
      git fetch origin integration/upstream-0.1.41-arch-r31-alpha18
      git checkout -B alpha18-debug-save origin/integration/upstream-0.1.41-arch-r31-alpha18
      cp "$snapshot" linux-port/debug-alpha18-resolved-main.cjs
      git config user.name 'github-actions[bot]'
      git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
      git add linux-port/debug-alpha18-resolved-main.cjs
      git commit -m '[skip ci] debug: save resolved alpha18 main syntax snapshot' || true
      git push origin HEAD:integration/upstream-0.1.41-arch-r31-alpha18
    ) || true
  fi
  exit 12
fi'''
if check not in s: raise SystemExit('main node-check anchor missing')
s=s.replace(check,diag,1)
p.write_text(s)
PY
exec bash "$TMP/build.sh" "$@"
