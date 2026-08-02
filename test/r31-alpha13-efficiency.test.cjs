"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || path.resolve(__dirname, "..");
const sourceLayout = fs.existsSync(path.join(root, "electron/main.cjs"));
const read = (sourceFile, packagedFile) => fs.readFileSync(path.join(root, sourceLayout ? sourceFile : packagedFile), "utf8");
const capture = read("electron/capture.cjs", "app/electron/capture.cjs");
const main = read("electron/main.cjs", "app/electron/main.cjs");
const missions = read("overlay/missions.html", "app/server/overlay/missions.html");
const config = read("overlay/config.html", "app/server/overlay/config.html");
const server = read("src/overlay-server.ts", "app/server/sc-overlay-server.mjs");

// Native OCR work is completion-scheduled and unchanged visual stages are cached.
assert.match(capture, /completion-scheduled OCR loop armed/);
assert.match(capture, /finally \{ scheduleNext\(Math\.max\(250, rate\)\); \}/);
assert.doesNotMatch(capture, /setInterval\(tick,/);
assert.match(capture, /function shouldRunVisualStage\(/);
assert.match(capture, /visualFingerprint\(shot/);
assert.match(capture, /skippedStages\.push\("generic-unchanged"\)/);
assert.match(capture, /stageTimings: \{ \.\.\.timings \}/);

// The successful capture backend is remembered and Mining does not arm generic OCR.
assert.match(capture, /preferredCaptureBackend/);
assert.match(capture, /capture backend cached for this session/);
assert.match(capture, /const genericFingerprint = \(fab \|\| miss\)/);
assert.match(capture, /if \(mining\) \{/);

// Normal pointer/layout changes are event-driven; slow polling remains only as a handoff fallback.
assert.match(main, /function scheduleFHoverMotionProbe\(\)/);
assert.match(main, /F_HOVER_FALLBACK_POLL_MS = 100/);
assert.match(main, /if \(overlayInteractionLatched\)[\s\S]{0,300}showInteractionCursor\(lastGlobalPointer\)/);
assert.doesNotMatch(missions, /setInterval\(reportRegions, 100\)/);
assert.match(missions, /new MutationObserver\(/);
assert.match(missions, /new ResizeObserver\(/);
assert.match(missions, /requestAnimationFrame\(/);

// OCR is opt-in and profiles expose a plain-language setup/status surface.
assert.match(server, /fabCapture: false,[\s\S]*missionOcr: false,[\s\S]*miningAssistant: false,[\s\S]*screenReaderProfile: "lightweight"/);
assert.match(config, /applyScreenProfile\('lightweight'\)/);
assert.match(config, /applyScreenProfile\('balanced'\)/);
assert.match(config, /applyScreenProfile\('mining'\)/);
assert.match(config, /id="ocrLiveStatus"/);
assert.doesNotMatch(main, /postConfig\(\{ miningAssistant: miningVisible \}\)/);

// Alpha 12's ownership contract remains explicit: F-up over a widget latches, stops idle probing,
// and only Escape or a genuine external focus transfer releases it.
const upStart = main.indexOf('const onUp = (source = "uiohook") =>');
const upEnd = main.indexOf("const down =", upStart);
const onUp = main.slice(upStart, upEnd);
assert.match(onUp, /overlayInteractionLatched = true;[\s\S]*stopFHoverPolling\(\);[\s\S]*remains interactive/);
assert.match(main, /endFocusLatchedInteraction\("Escape"/);
assert.match(main, /external window clicked|Star Citizen clicked/);

console.log("r31 alpha 13 efficiency, profiles, and interaction contract test: passed");
