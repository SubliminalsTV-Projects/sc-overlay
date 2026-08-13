#!/usr/bin/env bash
set -u
APP_ID="io.github.gbmccray32_boop.ArchVerseOverlay"
fail=0
ok(){ printf '[ OK ] %s\n' "$*"; }
warn(){ printf '[WARN] %s\n' "$*"; }
bad(){ printf '[FAIL] %s\n' "$*"; fail=1; }

command -v flatpak >/dev/null 2>&1 || { bad "Flatpak command is not installed"; exit 1; }
flatpak info "$APP_ID" >/dev/null 2>&1 || { bad "$APP_ID is not installed"; exit 1; }
ok "Flatpak app is installed"

printf '\n--- Flatpak info ---\n'
flatpak info "$APP_ID" | sed -n '1,40p'
printf '\n--- Permissions ---\n'
flatpak info --show-permissions "$APP_ID"

inside='set -eu
printf "Flatpak ID: %s\\n" "${FLATPAK_ID:-missing}"
command -v xdotool >/dev/null && echo "xdotool: bundled" || exit 21
command -v xrandr >/dev/null && echo "xrandr: bundled" || exit 22
ELECTRON_RUN_AS_NODE=1 /app/lib/archverse-electron/electron -e "console.log(\"Electron-as-Node:\",process.versions.electron,process.version)"
node_test=/app/archverse/app/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node
[ -f "$node_test" ] && echo "ONNX native binding: bundled" || exit 23
[ -f /app/archverse/app/node_modules/uiohook-napi/prebuilds/linux-x64/uiohook-napi.node ] && echo "uiohook native binding: bundled" || exit 24
[ -f /app/archverse/app/node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_rec_infer.onnx ] && echo "RapidOCR model: bundled" || exit 25
if xdotool search --onlyvisible --name "Star Citizen" >/tmp/av-sc-windows 2>/dev/null; then
  echo "Star Citizen X11/XWayland window: found"
  while read -r wid; do
    [ -n "$wid" ] || continue
    printf "  window=%s title=%s class=%s pid=%s\\n" "$wid" "$(xdotool getwindowname "$wid" 2>/dev/null || true)" "$(xdotool getwindowclassname "$wid" 2>/dev/null || true)" "$(xdotool getwindowpid "$wid" 2>/dev/null || true)"
  done </tmp/av-sc-windows
else
  echo "Star Citizen X11/XWayland window: not currently visible"
fi'

if flatpak run --command=sh "$APP_ID" -lc "$inside"; then
  ok "Bundled runtime dependencies are visible inside the sandbox"
else
  bad "One or more bundled runtime dependencies failed the sandbox check"
fi

printf '\n--- Common game.log locations visible to Flatpak ---\n'
flatpak run --command=sh "$APP_ID" -lc '
for p in "$HOME/Games/star-citizen/drive_c/Program Files/Roberts Space Industries/StarCitizen"/*/game.log "$HOME/Games/StarCitizen"/*/game.log; do
  [ -f "$p" ] && printf "%s\\n" "$p"
done
' 2>/dev/null || true

printf '\nIf your Wine prefix is outside ~/Games, /mnt, /media, or /run/media, grant only that location read-only, for example:\n'
printf '  flatpak override --user --filesystem=/path/to/star-citizen:ro %s\n' "$APP_ID"
printf '\nExit status: %s\n' "$fail"
exit "$fail"
