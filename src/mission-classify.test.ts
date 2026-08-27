/**
 * Self-check for the mission combat/activity classifier.
 * Run with:  npx tsx src/mission-classify.test.ts
 * Exits non-zero on any failed case.
 *
 * Half of this runs against the REAL shipped dataset rather than fixtures. That's deliberate:
 * the value of this classifier is a coverage number (how many missions never have to ask the
 * player), and a fixture can't regress that. If a patch adds a generator class, the coverage
 * assertion moves and someone has to look at it — which is the point.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyMission, needsCombatSurvey } from "./mission-classify.js";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// --- the labelled pair that motivates the whole feature -----------------------------------
check("HeadHunters_Mercenary_FPS -> fps",
  classifyMission({ generatorClass: "HeadHunters_Mercenary_FPS", missionType: "Mercenary" }).combat, "fps");
check("HeadHunters_Mercenary_Ship -> ship",
  classifyMission({ generatorClass: "HeadHunters_Mercenary_Ship", missionType: "Mercenary" }).combat, "ship");

// --- the CIG typo: KIllShip (capital I) sits beside KillShip -------------------------------
check("BountyHuntersGuild_KIllShip -> ship",
  classifyMission({ generatorClass: "BountyHuntersGuild_KIllShip" }).combat, "ship");
check("InterSec_KillShip -> ship",
  classifyMission({ generatorClass: "InterSec_KillShip" }).combat, "ship");

// --- FPSMining is on foot but is NOT combat ------------------------------------------------
check("Shubin_..._FPSMining -> none/mining",
  classifyMission({ generatorClass: "Shubin_ResourceGathering_FPSMining" }),
  { combat: "none", activity: "mining", source: "generator" });

// --- the generator wins over missionType ---------------------------------------------------
check("generator beats missionType",
  classifyMission({ generatorClass: "HeadHunters_Mercenary_FPS", missionType: "Hauling" }).source, "generator");

// --- deliberately NOT classified: these sound derivable and aren't ---------------------------
for (const g of ["HeadHunters_Patrol", "FoxwellEnforcement_Ambush", "InterSec_StationAssault",
                 "EckhartSecurity_KillNPC", "CitizensForProsperity_DestroyItems",
                 "HeadHunters_DefendEntitiesAndEscort", "HockrowAgency_FacilityDelve"]) {
  check(`${g} stays unknown (asks the player)`, needsCombatSurvey({ generatorClass: g, missionType: "Mercenary" }), true);
}

// --- missionType fallback -------------------------------------------------------------------
check("Hauling - Planetary -> none via missionType",
  classifyMission({ missionType: "Hauling - Planetary" }), { combat: "none", activity: "hauling", source: "missionType" });
check("Mercenary with no generator -> unknown",
  classifyMission({ missionType: "Mercenary" }).combat, null);
check("Bounty Hunter with no generator -> unknown",
  classifyMission({ missionType: "Bounty Hunter" }).combat, null);
check("empty input -> unknown", classifyMission({}).combat, null);

// --- coverage over the REAL dataset ----------------------------------------------------------
type Row = { generatorClass?: string; missionType?: string };
const dataPath = join(import.meta.dirname, "..", "data", "blueprints.latest.json");
const missions: Row[] = Object.values(JSON.parse(readFileSync(dataPath, "utf8")).missions);

let byGenerator = 0, byType = 0, unknown = 0;
const profile: Record<string, number> = {};
for (const m of missions) {
  const c = classifyMission(m);
  if (c.source === "generator") byGenerator++;
  else if (c.source === "missionType") byType++;
  else unknown++;
  if (c.combat) profile[c.combat] = (profile[c.combat] ?? 0) + 1;
}

// 🔑 These are LOWER than a first pass suggests, on purpose. Folding the 51 `_Patrol` missions
// into "ship" would push generator coverage to 940 — but a patrol can be flown or walked, so
// they go to the player instead. Coverage is the thing to resist optimising here.
// ⚠️ REBASELINED 2026-08-13, and only after checking the move was honest. `203c989` refreshed the
// bundled dataset from 2,763 missions to 4,075 (the app was a patch behind) and left these
// expectations behind, so the suite sat red for weeks — which is the failure mode it exists to
// prevent, just aimed at us. Every count grew roughly in proportion and derived coverage went
// 40.7% → 56.2%, i.e. the classifier got BETTER on a bigger dataset rather than starting to
// guess; the band check below is the real guard and it passes comfortably. The old numbers, for
// anyone comparing: 2763 / 893 / 746 / 1124 / 127 / 159 / 1353.
//
// ⚠️ REBASELINED AGAIN 2026-08-27 for 4.10 LIVE (`c01e789` landed 12519617; the counts above were
// 4.9's 12344265). This time the move was accounted for mission-by-mission before a single number
// was touched, because the whole point of these assertions is that a human looks:
//
//   4,075 -> 4,096 is NOT "+21 added". It is +30 ADDED and -9 REMOVED.
//   NOT ONE mission present in both patches changed its classification — re-bucketed = 0 — so
//   nothing was silently relabelled and the classifier itself did not move.
//
//   ship  260 -> 272 (+12)  exactly the 12 new FoxwellEnforcement_*_DefendShipNamed_* records
//                           (Nyx/Pyro/Stanton x E/M/H, plus 3 _NearLocation), every one of them
//                           generator `FoxwellEnforcement_DefendShip` -> ship. Same 12 are the
//                           whole of the generatorClass +12: 1264 -> 1276.
//   fps   136 -> 136 ( 0)   NOT suspicious, and this asymmetry was the thing worth checking.
//                           None of the 30 new missions is FPS combat, so the correct delta is 0.
//   type 1027 -> 1030 (+3)  a NET of +12 in / -9 out: CIG reshaped the Refueling family by ship
//                           size (Hydrogen_1L_Rank2 -> Hydrogen_1M_1L_Rank2, Both_2S_1M -> ...),
//                           79 -> 82 keys. Both sides classify none/missionType, hence...
//   none 1895 -> 1898 (+3)  ...the same +12/-9 net here.
//   unk  1784 -> 1790 (+6)  3x BattagliaStory, SOO2_Intro, TheCollector_SuperHeavyCombat, and one
//                           new Eckhart bounty location (Greycat Lobby — a genuinely new record;
//                           its two same-title siblings are both still present, so not a rename).
//
// 🔑 old + added - removed == new for ALL SIX counters, exactly, with no residue. That
// reconciliation is what licenses editing these numbers; a leftover of even 1 would mean something
// moved that the added/removed sets do not explain, and the right response then is to go and find
// it rather than to write down what the run happened to print.
check("dataset size", missions.length, 4096);
check("classified by generatorClass", byGenerator, 1276);
check("classified by missionType", byType, 1030);
check("needs the player to answer", unknown, 1790);
check("fps count", profile.fps, 136);
check("ship count", profile.ship, 272);
check("no-combat count", profile.none, 1898);
check("every mission accounted for", byGenerator + byType + unknown, missions.length);

// A wrong auto-label is worse than none, so guard the ceiling: if a future edit pushes coverage
// way up, it probably started guessing. 61% is the honest number today.
const covered = (byGenerator + byType) / missions.length;
check("coverage in the honest band (55-70%)", covered > 0.55 && covered < 0.70, true);

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}  —  ${(covered * 100).toFixed(1)}% derived, ${unknown} missions ask the player`);
process.exit(failed === 0 ? 0 : 1);
