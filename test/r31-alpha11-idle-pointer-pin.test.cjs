"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

assert.match(main, /let fHoverHostHookAuthoritative = false/);
assert.match(main, /fHoverHostHookAuthoritative = source\.startsWith\("uiohook"\)/);
assert.match(main, /compositor mouse stream pinned for idle-safe widget interaction/);

const refreshStart = main.indexOf("function refreshFHoverPointer(");
const pollingStart = main.indexOf("function startFHoverPolling(", refreshStart);
assert.ok(refreshStart >= 0 && pollingStart > refreshStart, "pointer refresh/polling functions must exist");
const refresh = main.slice(refreshStart, pollingStart);
assert.match(
  refresh,
  /fHoverHostHookAuthoritative && fHoverHookPointer\) \{\s*point = \{ \.\.\.fHoverHookPointer \};\s*source = "uiohook-host-pinned";/,
);
assert.ok(
  refresh.indexOf("fHoverHostHookAuthoritative && fHoverHookPointer")
    < refresh.indexOf("overlayWindows.pointerLocation?.()"),
  "a verified compositor mouse point must win before the XWayland root fallback",
);

const hookStart = main.indexOf("hotkeys.onMouseMove((event) =>");
const hookEnd = main.indexOf("const onDown =", hookStart);
const hook = main.slice(hookStart, hookEnd);
assert.match(
  hook,
  /fHoverPointerPhase === "host" && !fHoverHostHookAuthoritative[\s\S]*fHoverHostHookAuthoritative = true[\s\S]*lastGlobalPointer = \{ x, y \}/,
);
assert.ok(
  hook.indexOf("fHoverHostHookAuthoritative = true") < hook.indexOf("lastGlobalPointer = { x, y }"),
  "post-focus compositor movement must pin its coordinate source before publishing the point",
);

const resetCount = (main.match(/fHoverHostHookAuthoritative = false/g) || []).length;
assert.ok(resetCount >= 4, "idle-pointer authority must reset on handoff, exit, and new sessions");

// Reproduce Alpha 10's failure boundary: after one verified compositor movement, a stopped mouse
// must retain that point even if the XWayland root cursor later reports a different stale point.
const hookPoint = { x: 165, y: 1607 };
const staleXRoot = { x: 296, y: 462 };
const chooseHostPoint = ({ authoritative, hook, xroot }) => authoritative && hook ? hook : xroot;
assert.deepEqual(chooseHostPoint({ authoritative: true, hook: hookPoint, xroot: staleXRoot }), hookPoint);
assert.deepEqual(chooseHostPoint({ authoritative: true, hook: hookPoint, xroot: { x: 0, y: 0 } }), hookPoint);
assert.deepEqual(chooseHostPoint({ authoritative: false, hook: hookPoint, xroot: staleXRoot }), staleXRoot);

console.log("r31 alpha 11 idle-safe compositor pointer pin test: passed");
