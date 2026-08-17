/**
 * Dev tool: replay game.logs through the HaulingTracker.
 *
 *   npm run hauling-replay                       # every log in the default LIVE channel
 *   npm run hauling-replay -- "C:/.../Game.log"  # one file, printed in full
 *
 * With no argument it sweeps the whole backup corpus and prints a summary instead: how many
 * hauling contracts were seen, how many the player TRACKED (the Deliver-line gate), which stops
 * completed, how many payouts correlated. That aggregate is the actual regression check — the
 * numbers should not move unless CIG changes a line shape.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseLine } from "./parser.js";
import { parseMissionEvent } from "./missions-parser.js";
import { HaulingTracker, type HaulContract } from "./hauling.js";
import { collectLogPaths } from "./log-paths.js";

const DEFAULT_LOG = "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/Game.log";

function replay(path: string): HaulContract[] {
  const tracker = new HaulingTracker();
  // Ended contracts are pruned from the view after ten minutes of LOG time — right for a live
  // widget, wrong for a corpus sweep — so mirror every contract out as it changes.
  // 🔑 Overwrite on EVERY change rather than snapshotting once when `endedAt` appears. The
  // payout lands ~40ms AFTER the mission ends, so a snapshot taken at the end event freezes the
  // contract one field short and the whole sweep reports 0% payout correlation.
  const mirror = new Map<string, HaulContract>();
  tracker.on("change", () => {
    for (const c of tracker.view().contracts) mirror.set(c.missionId, structuredClone(c));
  });
  for (const line of readFileSync(path, "latin1").split(/\r?\n/)) {
    if (!line) continue;
    const ev = parseMissionEvent(parseLine(line));
    if (ev) tracker.apply(ev);
  }
  return [...mirror.values()];
}

function describe(c: HaulContract): string {
  const drops = c.stops.filter((s) => s.role === "dropoff");
  const done = drops.filter((s) => s.state === "completed").length;
  const cargo = c.deliverSeen
    ? drops.map((s) => (s.need == null ? "?" : `${s.need}${s.unit === "scu" ? " SCU" : s.unit === "boxes" ? " box" : "×"} ${s.commodity ?? ""} → ${s.destination ?? "?"}`)).join(" · ")
    : "(no Deliver line — the game never stated the tonnage)";
  return `  ${c.missionId.slice(0, 8)}  ${(c.completion ?? "live").padEnd(10)} `
    + `${String(c.payout ?? "").padStart(7)}  drops ${done}/${drops.length}  items ${c.items.length}  ${c.contractKey}\n`
    + `            ${cargo}`;
}

const arg = process.argv[2];
if (arg) {
  const contracts = replay(arg);
  console.log(`${arg}\n${contracts.length} hauling contracts\n`);
  for (const c of contracts) console.log(describe(c));
  process.exit(0);
}

// ── Corpus sweep ───────────────────────────────────────────────────────────────────────────
const paths = collectLogPaths(DEFAULT_LOG).filter((p) => {
  try { return statSync(p).isFile(); } catch { return false; }
});
console.log(`sweeping ${paths.length} logs under ${dirname(DEFAULT_LOG)}\n`);

let total = 0, tracked = 0, ended = 0, completed = 0, paid = 0, withItems = 0, withPos = 0, dropsDone = 0, dropsAll = 0;
// 🔑 How many sessions END with a contract selected in mobiGlas, off the objective data bank.
// This is the tracking signal the app was blind to until 2026-08-17, and it is counted per LOG
// because tracking is exclusive — at most one contract per session can be the tracked one.
let sessionsTracking = 0, sessionsWithHauls = 0;
const generators = new Map<string, number>();
const units = new Map<string, number>();
const examples: string[] = [];

for (const p of paths) {
  let contracts: HaulContract[];
  try { contracts = replay(p); } catch (err) { console.log(`  !! ${p}: ${(err as Error).message}`); continue; }
  if (contracts.length) sessionsWithHauls++;
  for (const c of contracts) {
    total++;
    generators.set(c.generator, (generators.get(c.generator) ?? 0) + 1);
    if (c.deliverSeen) { tracked++; if (examples.length < 12) examples.push(describe(c)); }
    if (c.endedAt != null) ended++;
    if (c.completion === "Complete") { completed++; if (c.payout != null) paid++; }
    if (c.items.length) withItems++;
    if (c.stops.some((s) => s.pos)) withPos++;
    if (c.trackedNow) sessionsTracking++;
    for (const s of c.stops) {
      if (s.unit) units.set(s.unit, (units.get(s.unit) ?? 0) + 1);
      if (s.role !== "dropoff") continue;
      dropsAll++;
      if (s.state === "completed") dropsDone++;
    }
  }
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
console.log(`hauling contracts seen ........ ${total}`);
console.log(`  TONNAGE STATED (Deliver line) ${tracked}  (${pct(tracked, total)})   <- fires at objective assignment, NOT on track`);
console.log(`  TRACKED IN MOBIGLAS at EOF .. ${sessionsTracking}  of ${sessionsWithHauls} hauling sessions`);
console.log(`  with a marker position ...... ${withPos}  (${pct(withPos, total)})`);
console.log(`  with an exact item manifest . ${withItems}  (${pct(withItems, total)})`);
console.log(`  ended ....................... ${ended}`);
console.log(`    completed ................. ${completed}`);
console.log(`      payout correlated ....... ${paid}  (${pct(paid, completed)})`);
console.log(`drop-off stops ................ ${dropsAll}, completed ${dropsDone}  (${pct(dropsDone, dropsAll)})`);
console.log(`\ngenerators:`);
for (const [g, n] of [...generators].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${g}`);
console.log(`\nobjective units: ${[...units].map(([u, n]) => `${u}=${n}`).join(" ") || "(none)"}`);
console.log(`\ntracked examples:`);
for (const e of examples) console.log(e);
