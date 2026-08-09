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

needle='''    if (server) { server.kill(); server=null; }\n  });\n  app.on("will-quit", () => { if (trayIsUsable()) tray.destroy(); tray=null;  });\n}\n'''
replacement='''    if (server) { server.kill(); server=null; }\n  });\n  app.on("will-quit", () => { if (trayIsUsable()) tray.destroy(); tray=null;  });\n  });\n}\n'''
anchor='main.write_text(s)'
patch=f'''_ready_needle = {needle!r}\n_ready_replacement = {replacement!r}\nif _ready_needle in s:\n    s = s.replace(_ready_needle, _ready_replacement, 1)\nelse:\n    raise SystemExit("main: app-ready close anchor missing")\nmain.write_text(s)'''
if anchor not in s: raise SystemExit('resolver main-write anchor missing')
s=s.replace(anchor, patch, 1)

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

_early = 'let scanModeRead = { active: false, confidence: 0, method: "not-armed" };'
_late = 'let scanModeRead = { kind: "scan-mode", active: false, angle: null, confidence: 0 };'
start = s.find(_early)
end = s.find(_late, start + 1) if start >= 0 else -1
if start < 0 or end < 0:
    raise SystemExit("capture: scan-mode declaration seam missing")
segment = s[start:end].replace('scanModeRead', 'archScanModeRead')
s = s[:start] + segment + s[end:]

# Alpha 13 added a tiny luminance fingerprint to skip unchanged OCR regions. During the 0.1.41
# three-way merge, the later stage-cache code survived but this earlier helper-definition hunk was
# taken from upstream, leaving both names undefined. Restore the exact Alpha 13 implementation.
_fp_helpers = ''' + repr('''// A tiny, quantized luminance map is enough to tell whether a HUD region materially changed.
// It stays inside Electron/nativeImage (no PNG encode, ImageMagick, Tesseract, or child process).
function visualFingerprint(image, width, height, roi) {
  const x = Math.max(0, Math.min(width - 1, Math.round(width * roi.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(height * roi.y)));
  const w = Math.max(8, Math.min(width - x, Math.round(width * roi.w)));
  const h = Math.max(8, Math.min(height - y, Math.round(height * roi.h)));
  const bitmap = image.crop({ x, y, width: w, height: h })
    .resize({ width: 48, height: 27, quality: "fast" }).toBitmap();
  const out = new Uint8Array(Math.floor(bitmap.length / 4));
  for (let src = 0, dst = 0; src + 3 < bitmap.length; src += 4, dst += 1) {
    out[dst] = Math.round((bitmap[src] + bitmap[src + 1] + bitmap[src + 2]) / (3 * 16));
  }
  return out;
}

function fingerprintDistance(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return Infinity;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  // Fingerprint values are 4-bit luminance buckets. Normalize the mean delta to 0..1 so stage
  // thresholds are resolution-independent percentages rather than magic bucket counts.
  return total / (a.length * 15);
}

''') + r'''
if 'function visualFingerprint(' not in s or 'function fingerprintDistance(' not in s:
    _fp_anchor = '// RapidOCR (PP-OCR) reader — main-process only'
    if _fp_anchor not in s:
        raise SystemExit("capture: fingerprint helper insertion anchor missing")
    s = s.replace(_fp_anchor, _fp_helpers + _fp_anchor, 1)
if 'function visualFingerprint(' not in s or 'function fingerprintDistance(' not in s:
    raise SystemExit("capture: Alpha13 fingerprint helpers still missing after repair")
# Export both helpers in the test surface so module-load smoke checks catch either missing symbol.
s = s.replace(
    '__test: { classifyLinuxForeground, cleanX11Field, fingerprintDistance },',
    '__test: { classifyLinuxForeground, cleanX11Field, visualFingerprint, fingerprintDistance },',
    1,
)
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
# Syntax-only checks missed the original Alpha18 crash because an undefined identifier in an export
# is valid JavaScript until the module is evaluated. Assert the restored helper declarations too.
needle='''node --check electron/scan-mode-gate.cjs
'''
insert='''node --check electron/scan-mode-gate.cjs
grep -q '^function visualFingerprint(' electron/capture.cjs
grep -q '^function fingerprintDistance(' electron/capture.cjs
grep -q '__test: { classifyLinuxForeground, cleanX11Field, visualFingerprint, fingerprintDistance }' electron/capture.cjs
'''
if needle not in s: raise SystemExit('capture helper test anchor missing')
s=s.replace(needle,insert,1)
p.write_text(s)
PY

# Upstream's chat integration test launches chat-server/server.mjs directly. Its `ws` dependency
# lives in chat-server/package-lock.json rather than the root install, so install that tiny nested
# dependency set before the consolidated node:test sweep.
python3 - "$TMP/build.sh" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
old='''npm run typecheck
node --import tsx --test src/*.test.ts
npm run build:server'''
new='''npm run typecheck
NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TMP_ROOT/npm-cache}" npm --prefix chat-server ci --ignore-scripts --no-audit --no-fund
node --import tsx --test src/*.test.ts
npm run build:server'''
if old not in s: raise SystemExit('build: test block anchor missing')
p.write_text(s.replace(old,new,1))
PY

exec bash "$TMP/build.sh" "$@"
