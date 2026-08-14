#!/usr/bin/env bash
set -euo pipefail
APP_ID="io.github.gbmccray32_boop.ArchVerseOverlay"

tmpdir="$(mktemp -d)"
cleanup(){ rm -rf "$tmpdir"; }
trap cleanup EXIT

cat > "$tmpdir/package.json" <<'EOF'
{
  "name": "archverse-flatpak-electron-smoke",
  "version": "1.0.0",
  "main": "main.cjs"
}
EOF

cat > "$tmpdir/main.cjs" <<'EOF'
const { app, BrowserWindow } = require('electron');
console.log('[smoke] main.cjs loaded');
app.whenReady().then(() => {
  console.log('[smoke] app ready');
  const win = new BrowserWindow({ width: 640, height: 360, show: true });
  win.loadURL('data:text/html,<html><body><h1>ArchVerse Flatpak Electron smoke test</h1></body></html>');
  win.webContents.once('did-finish-load', () => console.log('[smoke] renderer loaded'));
  setTimeout(() => {
    console.log('[smoke] PASS: GUI survived 5 seconds');
    app.exit(0);
  }, 5000);
}).catch((error) => {
  console.error('[smoke] app.whenReady failed', error);
  app.exit(91);
});
process.on('uncaughtException', (error) => {
  console.error('[smoke] uncaughtException', error);
  process.exit(92);
});
process.on('unhandledRejection', (error) => {
  console.error('[smoke] unhandledRejection', error);
  process.exit(93);
});
EOF

# Copy the tiny app into a filesystem visible inside the Flatpak sandbox.
flatpak run --command=sh "$APP_ID" -lc 'rm -rf /tmp/archverse-electron-smoke && mkdir -p /tmp/archverse-electron-smoke'
flatpak run --command=sh --filesystem="$tmpdir:ro" "$APP_ID" -lc \
  "cp -a '$tmpdir/.' /tmp/archverse-electron-smoke/"

set +e
flatpak run --command=sh "$APP_ID" -lc '
  set -x
  export ELECTRON_ENABLE_LOGGING=1
  export ELECTRON_ENABLE_STACK_DUMPING=1
  unset ELECTRON_RUN_AS_NODE
  zypak-wrapper /app/lib/archverse-electron/electron \
    --ozone-platform=x11 \
    --disable-gpu \
    /tmp/archverse-electron-smoke
'
status=$?
set -e

echo "[smoke] exit status=$status"
exit "$status"
