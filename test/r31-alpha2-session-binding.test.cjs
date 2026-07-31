"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const { StarCitizenSessionBinder } = require(path.join(repoRoot, "electron", "linux", "star-citizen-session.cjs"));

function fakeBinder({ withGamescope }) {
  const logs = [];
  const binder = new StarCitizenSessionBinder({
    platform: "linux",
    logger: { log: (line) => logs.push(String(line)) },
  });
  const game = {
    pid: 4242,
    ppid: 4000,
    comm: "StarCitizen.exe",
    cmdline: "C:\\Games\\StarCitizen\\LIVE\\Bin64\\StarCitizen.exe\0",
    startTicks: 9001,
  };
  const parent = withGamescope
    ? { pid: 4000, ppid: 1, comm: "gamescope", cmdline: "/usr/bin/gamescope\0", startTicks: 700 }
    : { pid: 4000, ppid: 1, comm: "wineserver", cmdline: "wineserver\0", startTicks: 100 };
  const init = { pid: 1, ppid: null, comm: "systemd", cmdline: "/sbin/init\0", startTicks: 1 };
  const processes = new Map([[game.pid, game], [parent.pid, parent], [init.pid, init]]);

  binder.listPids = () => [...processes.keys()];
  binder.readProcess = (pid) => processes.get(Number(pid)) || null;
  binder.ancestors = (pid) => {
    const result = [];
    const seen = new Set();
    let current = processes.get(Number(pid));
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      result.push(current);
      current = current.ppid ? processes.get(current.ppid) : null;
    }
    return result;
  };
  return { binder, logs };
}

test("binds the exact StarCitizen PID even when Wine detached from Gamescope", () => {
  const { binder, logs } = fakeBinder({ withGamescope: false });
  const session = binder.current();
  assert.equal(session.gamePid, 4242);
  assert.equal(session.gamescopePid, null);
  assert.equal(binder.validate(session), true);
  assert.equal(binder.belongsToSession(4242, session), true);
  assert.match(logs.join("\n"), /bound StarCitizen\.exe PID 4242 directly/);
});

test("retains strict Gamescope validation when the ancestor exists", () => {
  const { binder } = fakeBinder({ withGamescope: true });
  const session = binder.current();
  assert.equal(session.gamePid, 4242);
  assert.equal(session.gamescopePid, 4000);
  assert.equal(binder.validate(session), true);
});

test("Linux interaction is fixed to hover-gated F with no RightAlt default", () => {
  const source = fs.readFileSync(path.join(repoRoot, "electron", "main.cjs"), "utf8");
  assert.match(source, /let registeredInteractKey = "F";/);
  assert.doesNotMatch(source, /let registeredInteractKey = "RightAlt";/);
  assert.match(source, /startFHoverPolling\(\);/);
  assert.match(source, /waiting for pointer to enter a widget/);
  assert.match(source, /process\.platform === "linux" && fHoverEnabled/);
});
