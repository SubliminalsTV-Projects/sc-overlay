"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const main = read("electron/main.cjs");
const preload = read("electron/preload.cjs");
const missions = read("overlay/missions.html");

// Native architecture: one toolbar canvas, not one native window per tool.
assert.match(main, /createCanvasWindow\("Overlay Manager"/);
assert.match(missions, /id="panel" class="empty"/);
assert.match(missions, /const cls = "widget"/);

// The actual developer classifications the renderer must recognize.
assert.match(missions, /key: "blueprint", local: true, title: "Mission & BP Tracker"/);
assert.match(missions, /key: "mining", page: "mining\.html", title: "Mining Scanner"/);
assert.match(missions, /key: "notepad", page: "notepad\.html", title: "Journal"/);
assert.match(missions, /key: "twitchChat", page: "twitchchat\.html", title: "Twitch Chat"/);
assert.match(missions, /key: "scFeed", page: "scfeed\.html", title: "SC Feed"/);
assert.match(missions, /classification: "#panel"/);
assert.match(missions, /classification: widget\.classList\.contains\("notifier"\) \? "\.widget\.notifier" : "\.widget"/);

// The current classifier derives the live rectangles from the DOM, including iframe wrappers,
// and probes that classified snapshot without requiring the click-through renderer to focus.
assert.match(preload, /overlay:probe-point/);
assert.match(preload, /overlay:point-classification/);
assert.match(missions, /const collectOverlayRegions = \(\) =>/);
assert.match(missions, /const matches = collectOverlayRegions\(\)\.filter/);
assert.match(missions, /el\.closest\?\.\("\.widget"\)/);
assert.match(main, /applyFHoverClassification/);
assert.match(main, /focusLinuxInteractiveWindow\("overlay"\)/);
assert.match(main, /dom-classification/);

console.log("r31 alpha 3 DOM widget classification test: passed");
