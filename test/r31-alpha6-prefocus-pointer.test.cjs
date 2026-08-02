"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || process.cwd();
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const focus = fs.readFileSync(path.join(root, "electron/linux/focus-controller.cjs"), "utf8");

assert.match(focus, /xdotool", \["getmouselocation", "--shell"\]/);
assert.match(main, /function refreshFHoverPointer/);
assert.match(main, /preferLinux: true, reason: "F-down pre-focus"/);
assert.match(main, /preferLinux: true, reason: "F-down region refresh"/);
assert.match(main, /source = "xdotool-root"/);
assert.match(main, /const needs(?:Root|Game)Pointer = process\.platform === "linux"/);
assert.match(main, /now - fHoverLinuxPointerSampleAt >= 100/);
assert.match(
  main,
  /refreshFHoverPointer\(\{ preferLinux: true, reason: "F-down pre-focus" \}\);\s*updateFHoverHitFromRegions\(\);/,
);
assert.match(main, /overlayInteractionLatched = true/);
assert.match(main, /let moveKey = "Shift\+F6"/);

console.log("r31 alpha 6 pre-focus pointer test: passed");
