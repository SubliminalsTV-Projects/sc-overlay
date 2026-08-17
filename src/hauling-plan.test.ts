// The join between live contract state, the bundled datasets and the solver.
//
//   npx tsx src/hauling-plan.test.ts
//
// Driven end-to-end through the REAL pieces — HaulingTracker fed the dev-replay log lines, the
// real ships.json / hauling-orders.json off `data/` — because the bugs this file exists to catch
// live in the joins, not in any one function. Two of them are load-bearing:
//   • a contract whose dataset row is a RANGE must never be reported as an exact figure;
//   • the packer must be handed the CONTRACT's container cap and the DATASET's box table.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLine } from "./parser.js";
import { parseMissionEvent } from "./missions-parser.js";
import { HaulingTracker } from "./hauling.js";
import { HaulingDataStore } from "./hauling-data.js";
import { HAUL_SCENARIOS, haulReplayLines, type HaulScenario } from "./dev-replay.js";
import { boxSetFrom, buildHaulingPlan } from "./hauling-plan.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

const DATA_DIR = join(process.cwd(), "data");
const data = new HaulingDataStore(DATA_DIR);
const counts = data.counts();
check("datasets loaded", counts.ships > 0 && counts.contracts > 0, JSON.stringify(counts));

/** Run a set of dev-replay scenarios through the tracker and return its view. */
function viewOf(scenarios: HaulScenario[]) {
  const tracker = new HaulingTracker();
  let n = 0;
  for (const s of scenarios) {
    const missionId = `0000000${++n}-0000-4000-8000-00000000000${n}`;
    for (const line of haulReplayLines(s, missionId)) {
      const ev = parseMissionEvent(parseLine(line));
      if (ev) tracker.apply(ev);
    }
  }
  return tracker.view();
}
const byId = (id: string) => HAUL_SCENARIOS.filter((s) => s.id === id);

// ── the box table comes off the dataset, not the pre-verdict default ───────
const set = boxSetFrom(data.boxes());
check("box set is the shipped table, largest first",
  set.map((b) => b.scu).join() === "32,24,16,8,4,2,1", set.map((b) => b.scu).join());
check("🔑 footprints are the dataset's Y-MAJOR ones (32 = 2x8x2, not 8x2x2)",
  set[0].dims.join("x") === "2x8x2", set[0].dims.join("x"));
check("every shipped size is treated as confirmed — the 24-vs-32 dispute is settled data",
  set.every((b) => b.confidence === "confirmed"));

// ── a TRACKED contract: the log's number wins, and it is exact ─────────────
const tracked = buildHaulingPlan(viewOf(byId("haul-tracked")), data);
const t0 = tracked.contracts[0];
check("tracked contract is planned from the log", t0?.source === "log" && t0.exact === true, t0?.source);
check("tracked contract carries the log's 81 SCU", t0?.scu === 81, String(t0?.scu));
check("nothing is asked to be tracked", tracked.untracked.length === 0);
check("the C2 from the log is resolved to a real hull",
  tracked.ship?.className === "CRUS_Starlifter_C2" && tracked.ship.totalScu === 696 && tracked.ship.source === "log",
  JSON.stringify(tracked.ship && { c: tracked.ship.className, s: tracked.ship.totalScu }));
check("the C2 is TWO grids, 8x15x4 and 6x9x4 — not one pool of SCU",
  tracked.ship?.grids.length === 2 &&
  tracked.ship.grids[0].w === 8 && tracked.ship.grids[0].l === 15 && tracked.ship.grids[0].h === 4 &&
  tracked.ship.grids[1].w === 6 && tracked.ship.grids[1].l === 9 && tracked.ship.grids[1].h === 4);
// Its drop-off already completed in the scenario, so there is nothing left to fly or to pack.
check("a delivered leg leaves the route and the hold", tracked.trips.length === 0 && tracked.totals.scu === 0);
check("the payout the log reported is carried", tracked.totals.recentPayout === 56000, String(tracked.totals.recentPayout));

// ── 🔴 an UNTRACKED contract: bounded, never invented ──────────────────────
const untracked = buildHaulingPlan(viewOf(byId("haul-untracked")), data);
const u0 = untracked.contracts[0];
check("an untracked contract is listed for tracking",
  untracked.untracked.length === 1 && untracked.untracked[0].missionId === u0.missionId);
check("its source is never 'log'", u0?.source !== "log");
check("🔴 a ranged contract is not marked exact", u0?.source !== "range" || u0.exact === false);
check("a bounded contract reports both ends",
  u0?.source === "unknown" || (u0.minScu != null && u0.maxScu != null),
  `${u0?.source} ${u0?.minScu}-${u0?.maxScu}`);
check("the widget is told to go and track it",
  untracked.notes.some((n) => /track/i.test(n)) || u0?.source === "dataset" || u0?.source === "unknown",
  untracked.notes.join(" | "));

// The scenario's contract key is not one the dataset carries, which is itself a case to survive:
// a plan with an unknown load must degrade to "we cannot say" rather than to a guess.
if (u0?.source === "unknown") {
  check("an unknown load is excluded from the plan rather than guessed",
    u0.scu === null && u0.plannable === false && untracked.totals.unknownContracts === 1);
}

// ── a contract the DATASET does know, exercised through a pin ──────────────
// 🔑 Sub's own 2026-08-16 contract: `maxContainerSize: 4, minScu: 7, maxScu: 16` PER ORDER, two
// orders. It is the proof that the dataset bounds rather than states, so it is worth asserting
// against directly even though no scenario accepts it.
const SUBS_KEY = "HaulCargo_SingleToMulti2_Processed_ProcessedFood_Stanton3_SmallGrade";
const subs = data.contract(SUBS_KEY);
check("Sub's contract is a two-order range in the shipped data",
  subs?.orders.length === 2 && subs.orders[0].minScu === 7 && subs.orders[0].maxScu === 16 &&
  subs.orders[0].maxContainerSize === 4,
  JSON.stringify(subs?.orders[0]));
check("its family is Planetary, whose caps never include 24",
  subs?.missionType === "Hauling - Planetary", String(subs?.missionType));
check("maxBoxScu reads the contract's own cap, not a global one", data.maxBoxScu(SUBS_KEY) === 4);

// ── multi-leg: two drop-offs, one already delivered ────────────────────────
const multi = buildHaulingPlan(viewOf(byId("haul-multi")), data);
const m0 = multi.contracts[0];
check("both legs are modelled", m0?.legs.length === 2, String(m0?.legs.length));
check("the delivered leg is ticked and the other is not",
  m0?.legs.filter((l) => l.dropoffState === "completed").length === 1);
check("only the undelivered leg is still to be flown", multi.totals.scu === 6, String(multi.totals.scu));
check("the remaining leg produces a pickup and a drop-off",
  multi.trips.length === 1 && multi.trips[0].stops.length === 2, JSON.stringify(multi.trips[0]?.stops.map((s) => s.kind)));
check("the pickup comes before the drop-off",
  multi.trips[0]?.stops[0].kind === "pickup" && multi.trips[0].stops[1].kind === "dropoff");
check("a tracked drop-off is named from the log, an unnamed place is numbered honestly",
  multi.trips[0]?.stops[1].name === "Levski" && /^Site \d+$/.test(multi.trips[0].stops[0].name),
  multi.trips[0]?.stops.map((s) => s.name).join(" -> "));

// ── the whole board at once ────────────────────────────────────────────────
const all = buildHaulingPlan(viewOf(HAUL_SCENARIOS), data, { ship: "CRUS_Starlifter_C2" });
check("the manual ship pick is honoured and flagged as manual", all.ship?.source === "manual");
check("every scenario contract is present", all.contracts.length === HAUL_SCENARIOS.length, String(all.contracts.length));
check("the whole board fits a C2", all.pack?.fits === true, `${all.pack?.loadedScu}/${all.pack?.capacityScu}`);
check("what is packed equals what is left to move",
  all.pack != null && all.pack.loadedScu === all.totals.scu, `${all.pack?.loadedScu} vs ${all.totals.scu}`);
check("no box is placed outside its grid", (all.pack?.placements ?? []).every((p) => {
  const g = all.ship?.grids.find((x) => x.name === p.grid);
  return !!g && p.x >= 0 && p.y >= 0 && p.z >= 0 && p.x + p.dx <= g.w && p.y + p.dy <= g.l && p.z + p.dz <= g.h;
}));
check("no two boxes overlap", (() => {
  const ps = all.pack?.placements ?? [];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i], b = ps[j];
    if (a.grid !== b.grid) continue;
    if (a.x < b.x + b.dx && b.x < a.x + a.dx && a.y < b.y + b.dy && b.y < a.y + a.dy && a.z < b.z + b.dz && b.z < a.z + a.dz) return false;
  }
  return true;
})());
check("grid usage sums to what was loaded",
  (all.ship?.grids ?? []).reduce((s, g) => s + g.usedScu, 0) === (all.pack?.loadedScu ?? -1));

// ── the container cap is enforced PER CONTRACT ─────────────────────────────
// The mission-item scenario's key is `HH_Pyro_VeryEasy_RecoverCargo`; whatever cap the dataset
// carries for a contract, no box in that contract's manifest may exceed it. Checked across every
// planned leg rather than for one fixture, so a future scenario is covered for free.
check("no leg's boxes exceed that leg's own container cap",
  all.contracts.every((c) => c.legs.every((l) => l.maxContainerScu == null || l.boxes.every((b) => b.scu <= l.maxContainerScu!))));
check("a leg with a known load partitions to exactly that load",
  all.contracts.every((c) => c.legs.every((l) =>
    l.scu == null || l.boxes.reduce((s, b) => s + b.scu * b.count, 0) === l.scu)));
check("where the cap was not declared, the plan says so rather than pretending",
  all.contracts.every((c) => c.legs.every((l) => l.capSource === "dataset" || l.capSource === "assumed")));

// ── a pin overrides a range, and only a range ──────────────────────────────
const pinned = buildHaulingPlan(viewOf(byId("haul-untracked")), data, {
  pins: { [u0.missionId]: 40 },
});
check("a pinned load is used and labelled 'pinned'",
  pinned.contracts[0]?.scu === 40 && pinned.contracts[0].source === "pinned" && pinned.contracts[0].exact === true,
  `${pinned.contracts[0]?.scu} ${pinned.contracts[0]?.source}`);
const pinnedTracked = buildHaulingPlan(viewOf(byId("haul-tracked")), data, {
  pins: { [t0.missionId]: 999 },
});
check("🔑 a pin never overrides the game's own number", pinnedTracked.contracts[0]?.scu === 81);

// ── cargo already in the hold ──────────────────────────────────────────────
// Its pickup objective has COMPLETED, so there is nothing left to fly to for it — but the drop-off
// still has to happen. An earlier cut dropped the whole leg from the route the moment its pickup
// ticked, which quietly deleted a delivery the player still owed.
{
  const v = viewOf(byId("haul-multi"));
  const open = v.contracts[0].stops.filter((s) => s.state !== "completed");
  const drop = open.find((s) => s.role === "dropoff")!;
  const pick = open.find((s) => s.role === "pickup" && s.key === drop.key)!;
  pick.state = "completed";
  const p = buildHaulingPlan(v, data, { ship: "CRUS_Starlifter_C2" });
  check("cargo aboard is counted as aboard", p.aboardScu === 6, String(p.aboardScu));
  check("its pickup is not routed again but its drop-off still is",
    p.trips.length === 1 && p.trips[0].stops.length === 1 && p.trips[0].stops[0].kind === "dropoff",
    JSON.stringify(p.trips[0]?.stops.map((s) => s.kind)));
  check("🔑 the hold reading still counts what is already aboard",
    p.trips[0]?.stops[0].loadAfterScu === 0, String(p.trips[0]?.stops[0].loadAfterScu));
  check("it is still packed — it is cargo either way", p.pack?.loadedScu === 6, String(p.pack?.loadedScu));
  check("nothing is reported unrouted", p.unrouted.length === 0, JSON.stringify(p.unrouted));
}

// ── a drop-off the log never gave a pickup marker for ──────────────────────
// 🔴 Real: one of Sub's live contracts on 2026-08-16 carries a drop-off marker with no matching
// pickup. It cannot be routed — but the widget must SAY so, not quietly leave it out of a route
// that still claims to be the route.
{
  const v = viewOf(byId("haul-multi"));
  const drop = v.contracts[0].stops.filter((s) => s.state !== "completed").find((s) => s.role === "dropoff")!;
  v.contracts[0].stops = v.contracts[0].stops.filter((s) => !(s.role === "pickup" && s.key === drop.key));
  const p = buildHaulingPlan(v, data, { ship: "CRUS_Starlifter_C2" });
  check("an unroutable leg is reported rather than dropped",
    p.unrouted.length === 1 && /pickup marker/.test(p.unrouted[0].reason),
    JSON.stringify(p.unrouted));
  check("it is still carried in the totals and the layout",
    p.totals.scu === 6 && p.pack?.loadedScu === 6);
}

// ── 🔑 a mission-item haul: the ONE family with an exact manifest ──────────
// "Deliver 0/9 Cargo Boxes" is a COUNT, not a tonnage. The nine boxes the log enumerates are
// eight 8 SCU and one 1 SCU = 65 SCU, so reading that 9 as SCU under-reports by a factor of seven.
const itemsPlan = buildHaulingPlan(viewOf(byId("haul-items")), data);
const i0 = itemsPlan.contracts[0];
check("an enumerated manifest is the source, and it is exact",
  i0?.source === "manifest" && i0.exact === true, i0?.source);
check("nine boxes summing to 65 SCU, not nine SCU",
  i0?.scu === 65 && i0.legs[0].boxCount === 9 && i0.legs[0].boxLabel === "8x8 · 1x1",
  `${i0?.scu} SCU / ${i0?.legs[0].boxCount} boxes / ${i0?.legs[0].boxLabel}`);
check("a manifest is not re-partitioned", i0?.legs[0].boxSource === "manifest");

// ── no ship: everything else still works ──────────────────────────────────
// `ship: ""` means "clear the override", so the log's ship still wins — the no-ship case is a
// view that never saw one (on foot, or a relog before climbing in).
const onFoot = viewOf(byId("haul-multi"));
onFoot.ship = null;
const noShip = buildHaulingPlan(onFoot, data);
check("without a ship there is a route but no layout",
  noShip.pack === null && noShip.ship === null && noShip.trips.length === 1 &&
  noShip.notes.some((n) => /Pick the ship/.test(n)), noShip.notes.join(" | "));
check("clearing the override falls back to the log's ship",
  buildHaulingPlan(viewOf(byId("haul-multi")), data, { ship: "" }).ship?.source === "log");

// ── degenerate input ───────────────────────────────────────────────────────
const empty = buildHaulingPlan(
  { updatedAt: 0, playerNodeId: null, ship: null, contracts: [], untracked: [], trackedMissionId: null },
  data,
);
check("an empty board is an empty plan, not a throw",
  empty.contracts.length === 0 && empty.trips.length === 0 && empty.totals.scu === 0);

// The bundle really is on disk where the server will look for it.
check("the shipped orders file is the schema this module reads",
  JSON.parse(readFileSync(join(DATA_DIR, "hauling-orders.json"), "utf8")).schema === "sc-hauling-orders/1");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
