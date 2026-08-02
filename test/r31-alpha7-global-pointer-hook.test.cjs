"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || process.cwd();
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const hotkeys = fs.readFileSync(path.join(root, "electron/hotkeys.cjs"), "utf8");

assert.match(hotkeys, /uio\.on\("mousemove", onMousemove\)/);
assert.match(hotkeys, /function onMouseMove\(cb\)/);
assert.match(hotkeys, /module\.exports = \{[^}]*onMouseMove[^}]*\}/);

assert.match(main, /let fHoverHookPointer = null/);
assert.match(main, /let fHoverHookPointerSampleAt = 0/);
assert.match(main, /stopPointerWatch = hotkeys\.onMouseMove\(\(event\) => \{/);
assert.match(main, /fHoverHookPointer = \{ x, y \}/);
assert.match(main, /lastGlobalPointer = \{ x, y \}/);
assert.match(
  main,
  /fHoverHookPointer && Date\.now\(\) - fHoverHookPointerSampleAt <= 250\) \{\s*point = \{ \.\.\.fHoverHookPointer \};\s*source = "uiohook-global";\s*\} else \{\s*point = overlayWindows\.pointerLocation\?\.\(\) \|\| null;\s*if \(point\) source = "xdotool-root";/,
);
assert.match(main, /source === "uiohook-global" && fHoverHookPointerSampleAt/);
assert.match(main, /refreshFHoverPointer\(\{ preferLinux: true, reason: "F-down pre-focus" \}\)/);
assert.match(main, /let moveKey = "Shift\+F6"/);

console.log("r31 alpha 7 global pointer hook test: passed");
