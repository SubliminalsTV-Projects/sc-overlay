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
check("dataset size", missions.length, 2763);
check("classified by generatorClass", byGenerator, 893);
check("classified by missionType", byType, 746);
check("needs the player to answer", unknown, 1124);
check("fps count", profile.fps, 127);
check("ship count", profile.ship, 159);
check("no-combat count", profile.none, 1353);
check("every mission accounted for", byGenerator + byType + unknown, missions.length);

// A wrong auto-label is worse than none, so guard the ceiling: if a future edit pushes coverage
// way up, it probably started guessing. 61% is the honest number today.
const covered = (byGenerator + byType) / missions.length;
check("coverage in the honest band (55-70%)", covered > 0.55 && covered < 0.70, true);

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}  —  ${(covered * 100).toFixed(1)}% derived, ${unknown} missions ask the player`);
process.exit(failed === 0 ? 0 : 1);
