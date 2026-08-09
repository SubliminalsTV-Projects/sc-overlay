#!/usr/bin/env bash
set -euo pipefail

RUN_TMP="${RUNNER_TEMP:-/tmp}"
WORK="$RUN_TMP/r31-alpha18-build/work"
TAR="$RUN_TMP/dist/ArchVerse-Overlay-0.1.41-r31-alpha.18-arch.tar.gz"
TMP="$RUN_TMP/alpha18-focus-release-smoke"
rm -rf "$TMP"
mkdir -p "$TMP/package"

[[ -f "$WORK/electron/main.cjs" ]] || { echo '[focus-release-smoke] generated main missing' >&2; exit 140; }
[[ -f "$TAR" ]] || { echo '[focus-release-smoke] package missing' >&2; exit 141; }
tar -xzf "$TAR" -C "$TMP/package"
PKG="$(find "$TMP/package" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[[ -f "$PKG/app/electron/main.cjs" ]] || { echo '[focus-release-smoke] packaged main missing' >&2; exit 142; }

cat > "$TMP/test.cjs" <<'NODE'
"use strict";
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const file = process.argv[2];
const source = fs.readFileSync(file, "utf8");

function between(a, b) {
  const i = source.indexOf(a);
  if (i < 0) throw new Error(`missing start anchor ${a}`);
  const j = source.indexOf(b, i + a.length);
  if (j < 0) throw new Error(`missing end anchor ${b}`);
  return source.slice(i, j);
}

// Execute the exact generated mouse-button function. The user's regression is this precise state:
// F has been released, widget interaction remains latched, and the next physical click lands on
// transparent canvas rather than a classified widget.
const fnSource = between(
  "function scheduleForwardedMouseButton(phase, event) {",
  "function scheduleForwardedMouseMove(event) {",
);
const calls = [];
const context = {
  process: { platform: "linux" },
  console: { log: (...a) => calls.push(["log", ...a]), warn: (...a) => calls.push(["warn", ...a]) },
  INTERACTION_MOUSE_BUTTONS: Object.freeze({ 1: "left", 2: "right", 3: "middle" }),
  overlayInteractionLatched: true,
  fHoverHeld: false,
  fHoverOverWidget: false,
  modalOpen: false,
  moveMode: false,
  notepadEditing: false,
  dragging: false,
  forwardedMouseButtons: new Map(),
  pendingMouseFallbacks: new Set(),
  F_CLICK_NATIVE_GRACE_MS: 28,
  globalPointForMouseEvent: (e) => ({ x: Number(e.x), y: Number(e.y) }),
  canvasPointFromGlobal: (p) => ({ ...p }),
  overlayRegionAtPoint: () => null,
  interactionMouseDestination: () => { throw new Error("empty-canvas release must not select an overlay destination"); },
  releaseFocusLatchToGame: (reason) => calls.push(["release", reason]),
  nativeMouseReachedTarget: () => null,
  dispatchInteractionMouse: () => { throw new Error("empty-canvas release must not inject a click"); },
  setTimeout,
};
vm.createContext(context);
vm.runInContext(fnSource, context, { filename: file + ":scheduleForwardedMouseButton" });

context.scheduleForwardedMouseButton("down", { button: 1, x: 3211, y: 578 });
assert.deepEqual(calls.filter((c) => c[0] === "release"), [["release", "transparent canvas clicked"]]);
assert.equal(context.forwardedMouseButtons.size, 0, "release click must not arm a synthetic overlay button");

// Held F is deliberately different: don't tear down the physical-key gate while the key is down.
calls.length = 0;
context.fHoverHeld = true;
context.scheduleForwardedMouseButton("down", { button: 1, x: 3211, y: 578 });
assert.equal(calls.some((c) => c[0] === "release"), false, "held F must not be cancelled by a canvas press");

// Startup modal: capture the external window before focus is stolen and restore it on close.
const modalStart = source.indexOf('ipcMain.on("overlay:modal"');
if (modalStart < 0) throw new Error("overlay:modal handler missing");
const modalSlice = source.slice(modalStart, modalStart + 2200);
const capture = modalSlice.indexOf('captureLinuxActiveWindow();');
const focus = modalSlice.indexOf('focusLinuxInteractiveWindow("overlay")');
const restore = modalSlice.indexOf('setTimeout(restoreLinuxPreviousWindow, 30);');
assert.ok(capture >= 0, "modal open does not capture prior Linux focus");
assert.ok(focus >= 0, "modal does not focus Overlay Manager");
assert.ok(capture < focus, "modal must capture external focus before focusing Overlay Manager");
assert.ok(restore > focus, "modal close does not restore prior external focus");

console.log(`[focus-release-smoke] PASS ${file}`);
NODE

node "$TMP/test.cjs" "$WORK/electron/main.cjs"
node "$TMP/test.cjs" "$PKG/app/electron/main.cjs"
echo '[focus-release-smoke] generated + packaged transparent-canvas/modal focus contracts PASS'
