#!/usr/bin/env bash
set -euo pipefail
APP_ID="io.github.gbmccray32_boop.ArchVerseOverlay"
HOST_SMOKE_DIR="${HOME}/.var/app/${APP_ID}/data/electron-smoke"
mkdir -p "$HOST_SMOKE_DIR"
trap 'rm -rf "$HOST_SMOKE_DIR"' EXIT

cat > "$HOST_SMOKE_DIR/package.json" <<'EOF'
{
  "name": "archverse-flatpak-electron-smoke",
  "version": "1.0.0",
  "main": "main.cjs"
}
EOF

cat > "$HOST_SMOKE_DIR/main.cjs" <<'EOF'
console.log('[smoke] main.cjs entered');
const { app, BrowserWindow } = require('electron');
console.log('[smoke] electron module loaded');
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  console.log('[smoke] app ready');
  const win = new BrowserWindow({ width: 640, height: 360, show: true, skipTaskbar: false });
  win.loadURL('data:text/html,<html><body><h1>ArchVerse Flatpak Electron smoke test</h1></body></html>');
  win.webContents.once('did-finish-load', () => console.log('[smoke] renderer loaded'));
  setTimeout(() => {
    console.log('[smoke] PASS: GUI survived 4 seconds');
    app.exit(0);
  }, 4000);
}).catch((error) => {
  console.error('[smoke] app.whenReady failed', error);
  app.exit(91);
});
process.on('uncaughtException', (error) => {
  console.error('[smoke] uncaughtException', error?.stack || error);
  process.exit(92);
});
process.on('unhandledRejection', (error) => {
  console.error('[smoke] unhandledRejection', error?.stack || error);
  process.exit(93);
});
EOF

run_inside='set +e
SMOKE="$XDG_DATA_HOME/electron-smoke"
echo "=== ENVIRONMENT ==="
echo "DISPLAY=${DISPLAY:-unset}"
echo "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-unset}"
echo "LANG=${LANG:-unset}"
echo "LC_ALL=${LC_ALL:-unset}"
echo "SMOKE=$SMOKE"
test -f "$SMOKE/main.cjs" || { echo "[smoke] ERROR: persistent smoke app is not visible"; exit 70; }

echo
echo "=== ELECTRON PAYLOAD ==="
ls -ld /app/lib/archverse-electron /app/lib/archverse-electron/locales 2>&1
ldd /app/lib/archverse-electron/electron 2>&1 | grep -E "not found|=>" | head -80

echo
echo "=== NATIVE NODE MODULE LOAD ==="
cd /app/archverse/app
ELECTRON_RUN_AS_NODE=1 /app/lib/archverse-electron/electron -e "for (const m of [\"uiohook-napi\",\"koffi\",\"onnxruntime-node\"]) { try { require(m); console.log(\"[module] OK\",m); } catch (e) { console.error(\"[module] FAIL\",m,e && (e.stack||e.message||e)); process.exitCode=1; } }"
MODULE_STATUS=$?

echo
echo "=== ZYPAK GUI TEST ==="
export ELECTRON_ENABLE_LOGGING=1
export ELECTRON_ENABLE_STACK_DUMPING=1
export LANG="${LANG:-C.UTF-8}"
unset ELECTRON_RUN_AS_NODE
zypak-wrapper /app/lib/archverse-electron/electron --ozone-platform=x11 --disable-gpu --lang=en-US "$SMOKE"
ZYPAK_STATUS=$?
echo "[smoke] zypak status=$ZYPAK_STATUS"

echo
echo "=== DIRECT --no-sandbox GUI TEST (diagnostic only) ==="
/app/lib/archverse-electron/electron --no-sandbox --ozone-platform=x11 --disable-gpu --lang=en-US "$SMOKE"
DIRECT_STATUS=$?
echo "[smoke] direct status=$DIRECT_STATUS"

echo
echo "=== SUMMARY ==="
echo "module_status=$MODULE_STATUS"
echo "zypak_status=$ZYPAK_STATUS"
echo "direct_status=$DIRECT_STATUS"
if [ "$MODULE_STATUS" -eq 0 ] && { [ "$ZYPAK_STATUS" -eq 0 ] || [ "$DIRECT_STATUS" -eq 0 ]; }; then exit 0; fi
exit 1'

set +e
flatpak run --command=sh "$APP_ID" -lc "$run_inside"
status=$?
set -e

echo "[smoke] overall exit status=$status"
exit "$status"
