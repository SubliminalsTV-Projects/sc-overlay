"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || path.resolve(__dirname, "..");
const focusPath = path.join(root, "electron/linux/focus-controller.cjs");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const manager = fs.readFileSync(path.join(root, "electron/window-manager.cjs"), "utf8");
const { LinuxFocusController, __test } = require(focusPath);

assert.deepEqual(
  __test.parseProcessEnvironment(Buffer.from("DISPLAY=:7\0XAUTHORITY=/tmp/gamescope.auth\0EMPTY=\0")),
  { DISPLAY: ":7", XAUTHORITY: "/tmp/gamescope.auth", EMPTY: "" },
);
assert.deepEqual(
  __test.parseNestedPointer("X=3180\nY=1080\nSCREEN=0\nWINDOW=1\n", "WIDTH=6360\nHEIGHT=2160\n"),
  { x: 3180, y: 1080, width: 6360, height: 2160 },
);
assert.deepEqual(
  __test.mapNestedPointerToCanvas(
    { x: 3180, y: 1080, width: 6360, height: 2160 },
    { x: -1080, y: 0, width: 6360, height: 2160 },
  ),
  { x: 2100, y: 1080 },
);

const commands = [];
const session = { id: "session-1", gamePid: 94321, launcherPid: 94316, reaperPid: null };
const controller = new LinuxFocusController({
  platform: "linux",
  logger: { log() {} },
  sessionBinder: { current: () => session },
  fileReader: (file) => {
    assert.equal(file, "/proc/94321/environ");
    return Buffer.from("DISPLAY=:7\0XAUTHORITY=/tmp/gamescope.auth\0XDG_RUNTIME_DIR=/run/user/1000\0");
  },
  commandRunner: (command, args, options) => {
    commands.push({ command, args, options });
    if (args[0] === "getdisplaygeometry") return "WIDTH=6360\nHEIGHT=2160\n";
    if (args[0] === "getmouselocation") return "X=4000\nY=900\nSCREEN=0\nWINDOW=1\n";
    if (args[0] === "mousemove") return "";
    throw new Error(`unexpected command: ${args.join(" ")}`);
  },
});

assert.deepEqual(controller.gamescopePointerLocation(), {
  x: 4000, y: 900, width: 6360, height: 2160, display: ":7", gamePid: 94321,
});
assert.equal(commands[0].options.env.DISPLAY, ":7");
assert.equal(commands[0].options.env.XAUTHORITY, "/tmp/gamescope.auth");
assert.equal(commands.filter(({ args }) => args[0] === "getdisplaygeometry").length, 1);
assert.equal(controller.gamescopePointerLocation().x, 4000);
assert.equal(commands.filter(({ args }) => args[0] === "getdisplaygeometry").length, 1, "nested geometry should be cached per game session");
assert.equal(controller.moveHostPointer({ x: 2100, y: 1080 }), true);
const move = commands.find(({ args }) => args[0] === "mousemove");
assert.deepEqual(move.args, ["mousemove", "--sync", "--", "2100", "1080"]);
assert.equal(move.options.env, process.env, "host warp must not reuse the nested Gamescope DISPLAY");

assert.match(manager, /gamescopePointerLocation\(\)[\s\S]*mapNestedPointerToCanvas\(nested, this\.canvasBounds\(\)\)/);
assert.match(manager, /moveHostPointer\(point\) \{ return this\.focus\.moveHostPointer\(point\); \}/);
assert.match(main, /point = overlayWindows\.gamescopePointerLocation\?\.\(\) \|\| null;[\s\S]*source = "gamescope-display";[\s\S]*Date\.now\(\) - fHoverHookPointerSampleAt <= 250/);
assert.match(
  main,
  /lastGlobalPointerSource === "gamescope-display"[\s\S]{0,500}(?:overlayWindows\.moveHostPointer\?\.\(lastGlobalPointer\)|beginFHoverHostHandoff\(lastGlobalPointer\))/,
);
assert.match(main, /let moveKey = "Shift\+F6"/);

console.log("r31 alpha 8 Gamescope pointer test: passed");
