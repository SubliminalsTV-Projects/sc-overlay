#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${RUNNER_TEMP:-/tmp}/alpha18-probe"
BASE="$TMP/base"; UP="$TMP/up"; WORK="$TMP/work"
rm -rf "$TMP"; mkdir -p "$TMP"
git clone --quiet --depth 1 --branch v0.1.36 https://github.com/SubliminalsTV-Projects/sc-overlay.git "$BASE"
git clone --quiet --depth 1 --branch v0.1.41 https://github.com/SubliminalsTV-Projects/sc-overlay.git "$UP"
cp -a "$UP" "$WORK"; rm -rf "$WORK/.git"

fail=0
for rel in electron/main.cjs electron/capture.cjs electron/preload.cjs electron/config-preload.cjs electron/mining-preload.cjs; do
  [[ -f "$ROOT/$rel" ]] || continue
  set +e
  git merge-file -p --diff3 -L 'ArchVerse alpha1' -L 'upstream 0.1.36' -L 'upstream 0.1.41' \
    "$ROOT/$rel" "$BASE/$rel" "$UP/$rel" > "$WORK/$rel.merge"
  rc=$?
  set -e
  mv "$WORK/$rel.merge" "$WORK/$rel"
  echo "ALPHA1_MERGE $rel rc=$rc markers=$(grep -c '^<<<<<<<' "$WORK/$rel" || true)"
  (( rc > 0 )) && fail=1
 done

# Carry Linux-only modules used by the alpha1 shell.
for rel in electron/linux electron/hotkeys.cjs electron/window-manager.cjs electron/browser-widget.cjs electron/rapidocr-client.cjs electron/rapidocr-worker.cjs; do
  [[ -e "$ROOT/$rel" ]] && cp -a "$ROOT/$rel" "$WORK/electron/"
done

if (( fail )); then
  echo 'ALPHA1 conflicts remain; incremental patches not attempted.'
  grep -R -n '^<<<<<<<\|^|||||||\|^=======\|^>>>>>>>' "$WORK/electron" | head -n 160 || true
  exit 20
fi

cd "$WORK"
for patch in \
  r31-alpha2-hover-pid.patch r31-alpha3-dom-widget-hit.patch r31-alpha4-main-handshake.patch \
  r31-alpha4-renderer-regions.patch r31-alpha5-latched-cursor-shiftf6.patch r31-alpha6-prefocus-pointer.patch \
  r31-alpha7-global-pointer-hook.patch r31-alpha8-gamescope-pointer.patch r31-alpha9-stable-interaction.patch \
  r31-alpha10-verified-handoff.patch r31-alpha11-idle-pointer-pin.patch r31-alpha12-explicit-interaction-ownership.patch \
  r31-alpha13-efficiency.patch r31-alpha14-resource-budget.patch r31-alpha15-scan-f-interaction.patch \
  r31-alpha16-radar-click-forwarding.patch r31-alpha17-scan-structure.patch; do
  echo "PATCH $patch"
  set +e
  git apply --recount --check "$ROOT/linux-port/$patch"
  rc=$?
  set -e
  echo "PATCH_CHECK $patch rc=$rc"
  if (( rc != 0 )); then exit 21; fi
  git apply --recount "$ROOT/linux-port/$patch"
done
node --check electron/main.cjs
node --check electron/capture.cjs
node --check electron/preload.cjs
echo 'INCREMENTAL_REBASE_PROBE_OK'
