/**
 * Self-check for marker-less mission resolution — mining/scan missions never emit a
 * CreateMarker, so the tracker resolves their pool from the accept TITLE. Covers the
 * exact case and the ambiguous case (a title mapping to variants with different pools →
 * union of pools + `ambiguous` flag). Run with:  npx tsx src/accept-resolve.test.ts
 * Exits non-zero on any failed case.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionTracker } from "./missions.js";
import type { MissionEvent } from "./missions-parser.js";

const CL = "99999999";
const bp = (name: string) => ({ blueprint: name, chance: 1, item: name.toLowerCase(), type: "Weapon", subType: null, classification: null });
const mission = (title: string, pools: Record<string, ReturnType<typeof bp>[]>, extra: Record<string, unknown> = {}) =>
  ({ title, generatorClass: "Test", missionKey: title, pools, ...extra });

// Fixture: one exact marker-less title, one ambiguous title (two variants, different
// pools), plus a ranked + rank-less mission from the same giver for rank inference.
const dataset = {
  schema: "sc-blueprint-pools/2", version: `9.9.0-LIVE.${CL}`, changelist: CL, missionCount: 5,
  missions: {
    Test_Alpha: mission("Alpha Job", { "pool-a": [bp("Item A1"), bp("Item A2")] }),
    Test_Beta_Low: mission("Beta Job", { "pool-b": [bp("Item B1")] }),
    Test_Beta_High: mission("Beta Job", { "pool-c": [bp("Item C1"), bp("Item C2")] }),
    Test_Ranked: mission("Ranked Job", { "pool-r": [bp("Item R1")] }, { giver: "Test Giver", rank: 2 }),
    Test_Intro: mission("Intro Job", { "pool-i": [bp("Item I1")] }, { giver: "Test Giver", rank: null }),
  },
};

const dir = mkdtempSync(join(tmpdir(), "acc-"));
writeFileSync(join(dir, "blueprints.latest.json"), JSON.stringify(dataset));

const t = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "acc-st-")) });
const accept = (missionId: string, title: string): MissionEvent => ({ kind: "accept", ts: "2026-07-16T00:00:00.000Z", missionId, title });
// COLD-START path: accept arrives BEFORE the dataset loads (log replays before the
// async fetch lands) — must be re-resolved when the dataset arrives.
t.apply(accept("m-alpha", "Alpha Job"));
// Trigger dataset load (family change → loadDataset → latest fixture → reresolveAccepts).
t.detectPatch("<2026> ProductVersion: 9.9 build_version[99999999] Changelist: 99999999");
// LIVE path: accept arrives AFTER the dataset is loaded — resolves immediately.
t.apply(accept("m-beta", "Beta Job"));

let failed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}`);
}

const v = t.view();
check("picker lists both marker-less missions", v.missions.length === 2);

t.selectMission("m-alpha");
const a = t.view();
const aItems = a.pools.flatMap((p) => p.blueprints.map((b) => b.name)).sort();
check("Alpha resolves exact (not ambiguous)", a.ambiguous === false || a.ambiguous === undefined);
check("Alpha shows its pool", JSON.stringify(aItems) === JSON.stringify(["Item A1", "Item A2"]));

t.selectMission("m-beta");
const b = t.view();
const bItems = b.pools.flatMap((p) => p.blueprints.map((x) => x.name)).sort();
check("Beta flagged ambiguous", b.ambiguous === true);
check("Beta shows UNION of both variant pools", JSON.stringify(bItems) === JSON.stringify(["Item B1", "Item C1", "Item C2"]));

// ---- rank inference ----
// A rank-less (intro) mission proves nothing about standing.
t.apply(accept("m-intro", "Intro Job"));
t.selectMission("m-intro");
check("rank-less mission infers no rank", t.view().inferredRank === null);
// Accepting a rank-2 mission proves standing >= 2 with that giver...
t.apply(accept("m-ranked", "Ranked Job"));
t.selectMission("m-ranked");
check("ranked mission infers rank 2", t.view().inferredRank === 2);
// ...and that standing carries to the giver's other missions.
t.selectMission("m-intro");
check("inferred rank carries across the giver's missions", t.view().inferredRank === 2);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
