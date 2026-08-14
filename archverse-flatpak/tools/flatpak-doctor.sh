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
printf "Sandbox HOME: %s\\n" "${HOME:-missing}"
case "${HOME:-}" in
  */.var/app/${FLATPAK_ID:-io.github.gbmccray32_boop.ArchVerseOverlay})
    host_home="${HOME%/.var/app/${FLATPAK_ID:-io.github.gbmccray32_boop.ArchVerseOverlay}}" ;;
  *) host_home="/home/${USER:-$(id -un)}" ;;
esac
printf "Derived host HOME: %s\\n" "$host_home"
command -v xdotool >/dev/null && echo "xdotool: bundled" || exit 21
command -v xrandr >/dev/null && echo "xrandr: bundled" || exit 22
printf "Desktop geometry (xdotool): %s\\n" "$(xdotool getdisplaygeometry 2>/dev/null || echo unavailable)"
printf "Desktop root (xrandr): %s\\n" "$(xrandr --current 2>/dev/null | sed -n "s/^Screen [^:]*:.* current \\([0-9][0-9]*\\) x \\([0-9][0-9]*\\),.*/\\1x\\2/p" | head -1 || true)"
printf "DRI render nodes: %s\\n" "$(ls /dev/dri/renderD* 2>/dev/null | tr "\\n" " " || true)"

printf "Electron resource payload:\\n"
for p in \
  /app/lib/archverse-electron/locales/en-US.pak \
  /app/lib/archverse-electron/icudtl.dat \
  /app/lib/archverse-electron/resources.pak \
  /app/lib/archverse-electron/v8_context_snapshot.bin; do
  if [ -f "$p" ]; then printf "  OK %s\\n" "$p"; else printf "  MISSING %s\\n" "$p"; exit 27; fi
done

ELECTRON_RUN_AS_NODE=1 /app/lib/archverse-electron/electron -e "console.log(\"Electron-as-Node:\",process.versions.electron,process.version)"
zypak-wrapper /app/lib/archverse-electron/electron --version >/tmp/av-electron-version 2>&1 || { cat /tmp/av-electron-version; exit 26; }
printf "zypak Electron wrapper: %s\\n" "$(cat /tmp/av-electron-version | tail -1)"
node_test=/app/archverse/app/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node
[ -f "$node_test" ] && echo "ONNX native binding: bundled" || exit 23
[ -f /app/archverse/app/node_modules/uiohook-napi/prebuilds/linux-x64/uiohook-napi.node ] && echo "uiohook native binding: bundled" || exit 24
[ -f /app/archverse/app/node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_rec_infer.onnx ] && echo "RapidOCR model: bundled" || exit 25
printf "Host ~/Games visible: "
if [ -d "$host_home/Games" ]; then echo yes; else echo no; fi
if xdotool search --onlyvisible --name "Star Citizen" >/tmp/av-sc-windows 2>/dev/null; then
  echo "Star Citizen X11/XWayland window: found"
  while read -r wid; do
    [ -n "$wid" ] || continue
    printf "  window=%s title=%s class=%s pid=%s\\n" "$wid" "$(xdotool getwindowname "$wid" 2>/dev/null || true)" "$(xdotool getwindowclassname "$wid" 2>/dev/null || true)" "$(xdotool getwindowpid "$wid" 2>/dev/null || true)"
  done </tmp/av-sc-windows
else
  echo "Star Citizen X11/XWayland window: not currently visible"
fi
printf "Common game.log files:\\n"
find "$host_home/Games" /mnt /media /run/media -type f -name game.log -path "*StarCitizen*" -print 2>/dev/null | head -20 || true'

if flatpak run --command=sh "$APP_ID" -lc "$inside"; then
  ok "Bundled runtime, Electron resources, and host-path diagnostics passed inside the sandbox"
else
  bad "One or more sandbox diagnostics failed"
fi

printf '\nIf your Wine prefix is outside ~/Games, /mnt, /media, or /run/media, grant only that location read-only, for example:\n'
printf '  flatpak override --user --filesystem=/path/to/star-citizen:ro %s\n' "$APP_ID"
printf '\nExit status: %s\n' "$fail"
exit "$fail"
