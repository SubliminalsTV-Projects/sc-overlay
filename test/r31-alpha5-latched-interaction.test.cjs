"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || process.cwd();
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");

// F becomes an entry gate: releasing it over a classified widget leaves a scoped session active.
assert.match(main, /overlayInteractionLatched = true;[\s\S]{0,700}remains interactive/);
assert.match(main, /overlayInteractionLatched \|\| \(fHoverHeld && fHoverOverWidget\)/);
assert.match(main, /if \(overlayInteractionLatched \|\| notepadEditing/);
assert.match(main, /(?:pointer left classified widget|coordinate misses never[\s\S]*revoke it)/);
assert.match(main, /(?:Text fields deliberately retain the latch while typing|actual native focus transfer\/click outside)/);

// A dedicated focusless, click-through cursor window must render above the Overlay Manager and
// its native WebContentsViews while the game software cursor remains underneath.
assert.match(main, /function ensureInteractionCursorWindow\(\)/);
assert.match(main, /focusable: false, skipTaskbar: true, alwaysOnTop: true/);
assert.match(main, /win\.setIgnoreMouseEvents\(true\)/);
assert.match(main, /win\.setAlwaysOnTop\(true, "screen-saver"\)/);
assert.match(main, /function showInteractionCursor\(globalPoint = lastGlobalPointer\)/);
assert.match(main, /F_HOVER_FALLBACK_POLL_MS = 100/);
assert.match(main, /setInterval\(tick, F_HOVER_FALLBACK_POLL_MS\)/);
assert.match(main, /scheduleFHoverMotionProbe\(\)/);
assert.match(main, /destroyInteractionCursor\(\)/);

// Linux arrange mode is fixed to Shift+F6 and persisted so the config UI reflects reality.
assert.match(main, /let moveKey = "Shift\+F6";/);
assert.match(main, /process\.platform !== "linux" && typeof c\.moveHotkey === "string"/);
assert.match(main, /postConfig\(\{ moveHotkey: "Shift\+F6" \}\)/);

console.log("r31 alpha 5 latched interaction, cursor, and Shift+F6 test: passed");
