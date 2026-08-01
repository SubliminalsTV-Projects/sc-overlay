"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

const pollingStart = main.indexOf("function startFHoverPolling(");
const pollingEnd = main.indexOf("function applyMouse(", pollingStart);
assert.ok(pollingStart >= 0 && pollingEnd > pollingStart, "F-hover polling function must exist");
const polling = main.slice(pollingStart, pollingEnd);

const latchStart = polling.indexOf("if (overlayInteractionLatched) {");
const latchEnd = polling.indexOf("if (lastGlobalPointer && overlay", latchStart);
assert.ok(latchStart >= 0 && latchEnd > latchStart, "latched polling branch must exist");
const latch = polling.slice(latchStart, latchEnd);

assert.match(latch, /const target = overlayRegionAtPoint\(lastGlobalPointer\)/);
assert.match(latch, /fHoverTarget = target[\s\S]*fHoverOverWidget = true/);
assert.match(latch, /coordinate misses never[\s\S]*revoke it/);
assert.doesNotMatch(latch, /pointer left classified widget/);
assert.doesNotMatch(latch, /endFocusLatchedInteraction\(/);
assert.doesNotMatch(latch, /stopFHoverPolling\(\)/);
assert.doesNotMatch(latch, /F_HOVER_LEAVE_GRACE_MS/);

const escapeStart = main.indexOf("function lockAllOverlayWindowsFromEscape(");
const escapeEnd = main.indexOf("function ", escapeStart + 10);
const escape = main.slice(escapeStart, escapeEnd);
assert.match(escape, /endFocusLatchedInteraction\("Escape"/);

const blurStart = main.indexOf("function handleOverlayFocusLost(");
const blurEnd = main.indexOf("function registerInteractHotkey(", blurStart);
const blur = main.slice(blurStart, blurEnd);
assert.match(blur, /external window clicked|Star Citizen clicked/);
assert.match(blur, /endFocusLatchedInteraction\(reason/);

// Alpha 11 dropped ownership after a timed coordinate miss. Alpha 12 treats ownership as an
// explicit state: any number or duration of pointer misses leave it active until an exit event.
let latched = true;
const coordinateMiss = () => latched;
assert.equal(coordinateMiss(), true);
assert.equal(coordinateMiss(), true);
latched = false; // Escape or a real native focus transfer.
assert.equal(coordinateMiss(), false);

console.log("r31 alpha 12 explicit interaction ownership test: passed");
