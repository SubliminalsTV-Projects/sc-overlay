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
    // Mirrors the REAL "Kill the king" shape that made this necessary: one title, two
    // variants, DIFFERENT pools, told apart only by where they send you. Both list the
    // system ("Pyro") so a match on that alone must NOT be enough to pick one.
    Test_RegionA_Alpha: mission("Region Job", { "pool-ra": [bp("Item RA1"), bp("Item RA2")] },
      { places: ["Pyro", "Rustville"], objective: ["Rustville"] }),
    Test_RegionC_Charlie: mission("Region Job", { "pool-rc": [bp("Item RC1")] },
      { places: ["Pyro", "Pyro V", "Gaslight"], objective: null }),
    // Decoy pair for the substring trap: the real dataset has 16 keys containing
    // "Regional" and 20 containing "RegionLink", so an unanchored includes("regiona")
    // would match "Regional" and resolve to an unrelated variant.
    Test_RegionalDepot_X: mission("Decoy Job", { "pool-dx": [bp("Item DX1")] }, { places: ["Nyx"] }),
    Test_RegionB_Bravo: mission("Decoy Job", { "pool-db": [bp("Item DB1"), bp("Item DB2")] }, { places: ["Bloom"] }),
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

// ---- variant narrowing by objective place (the "dead pool" bug) ----
// Without this, a same-title pair with different pools shows the UNION, so the player is
// told they have items left to win in a pool they may already have finished. Sub farmed
// RegionC "Kill the king" (8/8 owned) for a week while the app showed a merged 14/18.
const objective = (missionId: string, text: string): MissionEvent =>
  ({ kind: "newObjective", ts: "2026-08-07T22:06:37.000Z", missionId, text });
const namesOf = (view: ReturnType<typeof t.view>) =>
  view.pools.flatMap((p) => p.blueprints.map((x) => x.name)).sort();

t.apply(accept("m-region", "Region Job"));
t.selectMission("m-region");
check("Region Job starts ambiguous (union of both pools)", t.view().ambiguous === true &&
  JSON.stringify(namesOf(t.view())) === JSON.stringify(["Item RA1", "Item RA2", "Item RC1"]));

// The system name alone is shared by both variants → must stay ambiguous, not guess.
t.apply(objective("m-region", "Go to Pyro"));
check("a place BOTH variants share does not resolve it", t.view().ambiguous === true);

// The real log text: "Pyro 5a" must match the dataset's "Pyro V" (Arabic+moon-letter vs
// Roman), and beat the shared "Pyro" on specificity.
t.apply(objective("m-region", "Go to Pyro 5a Abandoned Outpost"));
const rc = t.view();
check("'Pyro 5a' narrows to the RegionC variant", rc.ambiguous === false || rc.ambiguous === undefined);
check("narrowed view shows ONLY that variant's pool", JSON.stringify(namesOf(rc)) === JSON.stringify(["Item RC1"]));
check("narrowed contract key is the RegionC one", rc.contractKey === "Test_RegionC_Charlie");

// Second mission, same title, narrowed the other way by a named outpost.
t.apply(accept("m-region2", "Region Job"));
t.apply(objective("m-region2", "Go to Rustville and clear it out"));
t.selectMission("m-region2");
check("'Rustville' narrows to the RegionA variant",
  JSON.stringify(namesOf(t.view())) === JSON.stringify(["Item RA1", "Item RA2"]));

// An objective naming nothing we know must leave the merge intact rather than pick one.
t.apply(accept("m-region3", "Region Job"));
t.apply(objective("m-region3", "Go to Somewhere Unmapped"));
t.selectMission("m-region3");
check("an unknown place leaves it ambiguous", t.view().ambiguous === true);

// ---- variant narrowing by ROUTE REGION (the second, stronger signal) ----
// The routing line names the region outright, so it resolves cases the objective text
// cannot — 2026-08-09's "Deep space hit" objective was a bare "Go to Asteroid Base".
const route = (region: string): MissionEvent =>
  ({ kind: "routeRegion", ts: "2026-08-09T16:43:35.000Z", region, start: "Bloom" });

// m-region3 is still ambiguous (its objective matched nothing) — the route fixes it.
t.apply(route("C"));
t.selectMission("m-region3");
const byRoute = t.view();
check("route region narrows what the objective text could not",
  byRoute.contractKey === "Test_RegionC_Charlie" && JSON.stringify(namesOf(byRoute)) === JSON.stringify(["Item RC1"]));

// A region no variant carries must change nothing.
t.apply(accept("m-region4", "Region Job"));
t.apply(route("Z"));
t.selectMission("m-region4");
check("an unknown region leaves it ambiguous", t.view().ambiguous === true);

// 🔑 The route line has no MissionId. With TWO ambiguous missions that could both take
// this region, guessing would be a coin flip — so it must decline.
t.apply(accept("m-region5", "Region Job"));
t.apply(route("A"));
t.selectMission("m-region4");
const amb4 = t.view().ambiguous;
t.selectMission("m-region5");
const amb5 = t.view().ambiguous;
check("two ambiguous candidates → route declines to guess", amb4 === true && amb5 === true);

// 🔑 "Regional" must NOT satisfy region "A" — the token has to be boundary-anchored.
// Unanchored, this resolves to Test_RegionalDepot_X and shows the wrong pool entirely.
const t2 = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "acc-st2-")) });
t2.detectPatch("<2026> ProductVersion: 9.9 build_version[99999999] Changelist: 99999999");
t2.apply(accept("m-decoy", "Decoy Job"));
t2.apply(route("A"));
t2.selectMission("m-decoy");
check("'Regional' does not satisfy region A", t2.view().ambiguous === true);
// …while the genuine RegionB token still resolves that same pair.
t2.apply(route("B"));
check("region B still resolves the decoy pair", t2.view().contractKey === "Test_RegionB_Bravo");

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
