// The scan session's TWO disk properties, which are in tension and were traded off wrongly once.
//
//   npx tsx src/payout-mode.test.ts
//
// 🔴 WHY THIS EXISTS. `electron/capture.cjs` learns the mode by reading config.json off disk every
// tick (`readConfig`), so the flag has to be IN the file. But the mode must also never survive a
// launch, because it reads the player's screen. `c8c2aca` satisfied the second by stripping the
// field on save — which quietly made the first impossible: `payout` at capture.cjs:616 was
// permanently false, the contract-region crop never ran, and the dashboard read "no board on
// screen" forever while every server-side surface still reported the mode as ON. Nothing threw,
// no test went red, and the scanner was dead for a whole release.
//
// So both halves are asserted here, together, against the REAL sidecar writing a REAL config —
// a unit test over the pure scanner cannot see either of them.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

const PORT = 8791;                       // not 8778: that is the user's real app
const BASE = `http://localhost:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "payout-mode-"));
const configPath = join(home, "sc-blueprint-tracker", "config.json");
const REGION = { x: 0.175, y: 0.135, w: 0.19, h: 0.7 };

/** Exactly what electron/capture.cjs does — same read, same parse, same fallback. Deliberately a
 *  copy of `readConfig` rather than a shared import: the point is to prove the FILE is enough for
 *  a separate process that has no access to the server's memory. */
const readConfigLikeCapture = () => {
  try { return JSON.parse(readFileSync(configPath, "utf8")); } catch { return {}; }
};
/** The literal gate at capture.cjs:616. If this is false the scanner is off, whatever the API says. */
const captureWouldScan = (cfg: Record<string, unknown>) =>
  cfg.payoutScan === true && !!cfg.contractRegion;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let child: ChildProcess | null = null;
async function boot(): Promise<void> {
  child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/overlay-server.ts"], {
    env: { ...process.env, APPDATA: home, HOME: home, PORT: String(PORT), SC_NO_SYNC: "1" },
    stdio: "ignore",
    windowsHide: true,   // every child process here gets this — see the rule in SKILL.md
  });
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/api/instance`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("sidecar never came up on " + PORT);
}
async function kill(): Promise<void> {
  if (!child) return;
  child.kill();
  child = null;
  await sleep(1500);
}
const scanState = async () => (await fetch(`${BASE}/api/payout-scan`, { cache: "no-store" })).json();
const post = (body: unknown) =>
  fetch(`${BASE}/api/payout-scan`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

try {
  await boot();

  // ── 1. Arming has to reach the FILE, because that is the only channel capture.cjs has ──
  await post({ region: REGION });
  await post({ on: true });
  await sleep(400);                       // saveConfig is async
  check("the API reports the mode armed", (await scanState()).on === true);
  const armed = readConfigLikeCapture();
  check("...and it is written to config.json, not just held in memory",
    armed.payoutScan === true, `payoutScan=${JSON.stringify(armed.payoutScan)}`);
  check("...the calibrated region is there too", !!armed.contractRegion);
  check("...so the capture loop's own gate opens", captureWouldScan(armed),
    "cfg.payoutScan === true && !!cfg.contractRegion");

  // ── 2. Disarming has to reach the file just as surely, or scanning outlives the switch ──
  await post({ on: false });
  await sleep(400);
  check("stopping disarms the file", readConfigLikeCapture().payoutScan === false);
  check("...so the capture loop's gate closes", !captureWouldScan(readConfigLikeCapture()));

  // ── 3. And it must NOT survive a restart. This is the whole reason it is a session ──
  await post({ on: true });
  await sleep(400);
  check("armed again, ready to be killed mid-sweep", captureWouldScan(readConfigLikeCapture()));
  await kill();
  check("the file still says armed while nothing is running — a crash leaves it this way",
    readConfigLikeCapture().payoutScan === true);

  await boot();
  await sleep(600);                       // the startup disarm is a fire-and-forget save
  check("a relaunch comes back DISARMED", (await scanState()).on === false);
  check("...and rewrites the file, so the capture loop cannot arm from a stale flag",
    readConfigLikeCapture().payoutScan === false,
    `payoutScan=${JSON.stringify(readConfigLikeCapture().payoutScan)}`);
  check("...while KEEPING the calibrated region, which is a measurement and not consent",
    !!readConfigLikeCapture().contractRegion);
} finally {
  await kill();
  if (existsSync(home)) { try { rmSync(home, { recursive: true, force: true }); } catch { /* windows lock */ } }
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
