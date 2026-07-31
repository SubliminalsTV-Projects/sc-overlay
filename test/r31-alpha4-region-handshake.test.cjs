"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = process.argv[2] || process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const main = read("electron/main.cjs");
const missions = read("overlay/missions.html");

test("shell actively requests regions before Settings has been opened", () => {
  assert.match(main, /function requestOverlayRegionSnapshot/);
  assert.match(main, /did-finish-load\+\$\{delay\}ms/);
  assert.match(main, /requestOverlayRegionSnapshot\("F-down"\)/);
  assert.match(main, /restored-after-config\+\$\{delay\}ms/);
  assert.match(main, /window\.__overlayReportRegions/);
});

test("reported geometry retains the developer widget classifications", () => {
  assert.match(missions, /window\.__overlayReportRegions = reportRegions/);
  assert.match(missions, /classification: "#panel"/);
  assert.match(missions, /classification: widget\.classList\.contains\("notifier"\) \? "\.widget\.notifier" : "\.widget"/);
  assert.match(missions, /key: "blueprint"/);
  assert.match(missions, /collectOverlayRegions/);
  assert.match(main, /classification: typeof r\.classification === "string"/);
  assert.match(main, /classified region snapshot count=/);
});

test("held-F classification does not require focusing the renderer first", () => {
  assert.match(main, /async function probeFHoverPointDirect/);
  assert.match(main, /window\.__overlayClassifyPoint/);
  assert.match(main, /direct-classified-region/);
  assert.match(main, /function overlayRegionAtPoint/);
  assert.match(main, /classified-region-fallback/);
  assert.match(missions, /matches = collectOverlayRegions\(\)\.filter/);
  assert.doesNotMatch(missions, /document\.elementsFromPoint\(x, y\)/);
});
