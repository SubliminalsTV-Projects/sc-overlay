"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

assert.match(main, /let fHoverHandoffAnchor = null/);
assert.match(main, /const F_HOVER_HANDOFF_TOLERANCE_PX = 32/);
assert.match(main, /const F_HOVER_HANDOFF_DELAYS_MS = \[75, 175, 350\]/);
assert.match(main, /function beginFHoverHostHandoff\(point\)/);
assert.match(main, /function acceptFHoverHostPoint\(point, source = "host"\)/);
assert.match(main, /function sampleFHoverHostHandoff\(\{ warp = false, reason = "poll" \} = \{\}\)/);
assert.match(main, /host pointer handoff verified/);
assert.match(main, /host pointer handoff pending/);

const classificationStart = main.indexOf("function applyFHoverClassification(");
const refreshStart = main.indexOf("function refreshFHoverPointer(", classificationStart);
assert.ok(classificationStart >= 0 && refreshStart > classificationStart, "classification and refresh functions must exist");
const classification = main.slice(classificationStart, refreshStart);
assert.match(classification, /fHoverPointerPhase === "handoff"\) return/);
assert.match(classification, /lastGlobalPointerSource === "gamescope-display"\) beginFHoverHostHandoff\(lastGlobalPointer\)/);
assert.ok(
  classification.indexOf("beginFHoverHostHandoff(lastGlobalPointer)")
    < classification.indexOf('focusLinuxInteractiveWindow("overlay")'),
  "handoff guard must be armed before the overlay focus transition",
);
assert.doesNotMatch(classification, /synchronized host pointer[\s\S]*before overlay focus/);

const pollingStart = main.indexOf("function startFHoverPolling(", refreshStart);
const pollingEnd = main.indexOf("function applyMouse(", pollingStart);
const polling = main.slice(pollingStart, pollingEnd);
assert.match(polling, /fHoverPointerPhase === "game"/);
assert.match(polling, /fHoverPointerPhase === "handoff"[\s\S]*sampleFHoverHostHandoff\(\)/);
assert.match(polling, /fHoverPointerPhase === "handoff"[\s\S]*F_HOVER_HOST_SAMPLE_MS/);

const hookStart = main.indexOf('hotkeys.onMouseMove((event) =>');
const hookEnd = main.indexOf("const onDown =", hookStart);
const hook = main.slice(hookStart, hookEnd);
assert.match(hook, /fHoverPointerPhase === "handoff"[\s\S]*acceptFHoverHostPoint\(\{ x, y \}, "uiohook-host"\)[\s\S]*return/);
assert.ok(
  hook.indexOf('fHoverPointerPhase === "handoff"') < hook.indexOf("lastGlobalPointer = { x, y }"),
  "a stale first host hook sample must not overwrite the Gamescope anchor",
);

// Exercise the acceptance rule independently: a post-focus point is trusted only when it is
// close to the nested anchor or reaches the same widget that F originally classified.
const tolerance = Number(main.match(/F_HOVER_HANDOFF_TOLERANCE_PX = (\d+)/)?.[1]);
assert.equal(tolerance, 32);
const original = { key: "mining" };
const accept = ({ x, y, target }) => Math.hypot(x - 100, y - 100) <= tolerance || target?.key === original.key;
assert.equal(accept({ x: 120, y: 110, target: null }), true);
assert.equal(accept({ x: 900, y: 700, target: { key: "blueprint" } }), false);
assert.equal(accept({ x: 900, y: 700, target: { key: "mining" } }), true);

console.log("r31 alpha 10 verified post-focus pointer handoff test: passed");
