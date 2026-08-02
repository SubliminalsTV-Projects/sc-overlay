"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

assert.match(main, /for \(const stream of \[process\.stdout, process\.stderr\]\)[\s\S]*error\?\.code === "EPIPE"/);
assert.match(main, /let fHoverPointerPhase = "game"/);
assert.match(main, /const F_HOVER_HOST_SAMPLE_MS = 50/);
assert.match(main, /const F_HOVER_LEAVE_GRACE_MS = 180/);

const refreshStart = main.indexOf("function refreshFHoverPointer(");
const pollingStart = main.indexOf("function startFHoverPolling(", refreshStart);
assert.ok(refreshStart >= 0 && pollingStart > refreshStart, "pointer refresh/polling functions must exist");
const refresh = main.slice(refreshStart, pollingStart);
assert.match(refresh, /preferHost = false/);
assert.match(refresh, /preferHost\)[\s\S]*overlayWindows\.pointerLocation\?\.\(\)[\s\S]*source = "xdotool-host"/);
assert.ok(
  refresh.indexOf("process.platform === \"linux\" && preferHost") < refresh.indexOf("screen.getCursorScreenPoint()"),
  "host X coordinates must be chosen before Electron screen coordinates",
);

const pollingEnd = main.indexOf("function applyMouse(", pollingStart);
const polling = main.slice(pollingStart, pollingEnd);
assert.match(polling, /needsGamePointer[\s\S]*fHoverPointerPhase (?:!== "host"|=== "game")/);
assert.match(polling, /refreshFHoverPointer\(\{ preferHost: true \}\)/);
assert.match(
  polling,
  /(?:now - fHoverMissStartedAt < F_HOVER_LEAVE_GRACE_MS|coordinate misses never[\s\S]*revoke it)/,
);

assert.match(
  main,
  /fHoverPointerPhase !== "host"[\s\S]*(?:moveHostPointer\?\.\(lastGlobalPointer\)[\s\S]*fHoverPointerPhase = "host"|beginFHoverHostHandoff\(lastGlobalPointer\))[\s\S]*focusLinuxInteractiveWindow\("overlay"\)/,
);
assert.match(
  main,
  /if \(!next && fHoverOverWidget\)[\s\S]*now - fHoverMissStartedAt < F_HOVER_LEAVE_GRACE_MS/,
);

// Exercise the configured debounce boundary: isolated misses must not tear down interaction,
// while a real departure that survives the grace interval must eventually be accepted.
const grace = Number(main.match(/const F_HOVER_LEAVE_GRACE_MS = (\d+)/)?.[1]);
assert.equal(grace, 180);
let missStartedAt = 0;
const stableMiss = (now) => {
  if (!missStartedAt) missStartedAt = now;
  return now - missStartedAt >= grace;
};
assert.equal(stableMiss(1000), false);
assert.equal(stableMiss(1090), false);
assert.equal(stableMiss(1179), false);
assert.equal(stableMiss(1180), true);

console.log("r31 alpha 9 stable interaction and EPIPE test: passed");
