/**
 * What do you actually DO in this mission?
 *
 * `missionType` in the dataset is the GIVER'S category, not the activity — a "Mercenary"
 * contract can be a bunker clear (pure FPS), a ship-wave defence (pure ship combat), or a
 * bunker you have to fight your way to. That distinction is the single most-asked thing the
 * blueprint pages can't answer, and it is why the completion report asks the player.
 *
 * But it does NOT have to ask about every mission. `generatorClass` — already in the dataset,
 * 55 distinct values — frequently states the answer outright: `HeadHunters_Mercenary_FPS` and
 * `HeadHunters_Mercenary_Ship` are a literal labelled pair. Measured against the live dataset
 * (2763 missions): 940 classify off the generator, another 741 off a non-combat `missionType`,
 * leaving 1082 (39%) that genuinely need a human. The report only asks about those 1082.
 *
 * 🔑 The rule for adding to these tables is CONFIDENCE, not coverage. A generator token earns a
 * mapping only when the token itself names the answer. `Patrol`, `Ambush`, `StationAssault`,
 * `KillNPC` and `DestroyItems` all SOUND classifiable and are deliberately left out — a patrol
 * could be flown or walked, and a wrong auto-label is worse than no label because nobody is ever
 * asked to correct it. Guessing here silently poisons the crowdsourced set.
 *
 * 🔑 `combat` means "what the mission REQUIRES", not "what might happen to you". A hauling run
 * is `none` even though pirates may jump you. Without that definition every answer is "it
 * depends" and the data means nothing.
 */

/** What kind of fighting the mission requires. `null` = not derivable, ask the player. */
export type CombatProfile = "fps" | "ship" | "mixed" | "none";

/** What the mission is fundamentally about, independent of whether it involves combat. */
export type MissionActivity =
  | "combat"
  | "hauling"
  | "delivery"
  | "mining"
  | "salvage"
  | "refuel"
  | "racing"
  | "investigation"
  | "retrieval"
  | "escort"
  | "maintenance";

export interface MissionClassification {
  combat: CombatProfile | null;
  activity: MissionActivity | null;
  /** Where the answer came from — drives how much the UI trusts it. */
  source: "generator" | "missionType" | null;
}

/** Generator-class SUFFIXES that name the activity outright. Matched against the trailing
 *  segment(s) of `generatorClass`, which is always `<Giver>_<...>_<Activity>`.
 *  ⚠️ `KIllShip` (capital I) is a real value in CIG's data, sitting beside `KillShip`. */
const GENERATOR_RULES: { re: RegExp; combat: CombatProfile; activity: MissionActivity }[] = [
  // On-foot combat — the token literally says FPS.
  { re: /_FPS$|_FPSKill$/, combat: "fps", activity: "combat" },
  // Hand mining. Named FPS because it's on foot, but it is NOT a combat mission.
  { re: /_FPSMining$/, combat: "none", activity: "mining" },
  // Ship combat — each of these names a ship as the subject of the verb.
  { re: /_Mercenary_Ship$/, combat: "ship", activity: "combat" },
  { re: /_KI?llShip$/i, combat: "ship", activity: "combat" },
  { re: /_DefendShip$/, combat: "ship", activity: "combat" },
  { re: /_ShipAmbush$/, combat: "ship", activity: "combat" },
  { re: /_ShipWaveAttack$/, combat: "ship", activity: "combat" },
  { re: /_EscortShips$/, combat: "ship", activity: "escort" },
  // Non-combat trades.
  { re: /_ShipMining$/, combat: "none", activity: "mining" },
  { re: /_ShipSalvage$/, combat: "none", activity: "salvage" },
  { re: /_Hauling$/, combat: "none", activity: "hauling" },
  { re: /_Courier$/, combat: "none", activity: "delivery" },
];

/** `missionType` values that are non-combat by definition. Mercenary / Bounty Hunter /
 *  Investigation / Priority / Search are deliberately ABSENT — those are exactly the ones
 *  worth asking about, and together they are most of the 1082 unknowns. */
const TYPE_RULES: Record<string, { combat: CombatProfile; activity: MissionActivity }> = {
  "Hauling": { combat: "none", activity: "hauling" },
  "Hauling - Local": { combat: "none", activity: "hauling" },
  "Hauling - Planetary": { combat: "none", activity: "hauling" },
  "Hauling - Stellar": { combat: "none", activity: "hauling" },
  "Hauling - Interstellar": { combat: "none", activity: "hauling" },
  "Delivery": { combat: "none", activity: "delivery" },
  "Courier": { combat: "none", activity: "delivery" },
  "Ship Mining": { combat: "none", activity: "mining" },
  "Hand Mining": { combat: "none", activity: "mining" },
  "Salvage": { combat: "none", activity: "salvage" },
  "Refueling": { combat: "none", activity: "refuel" },
  "Racing": { combat: "none", activity: "racing" },
  "Maintenance": { combat: "none", activity: "maintenance" },
  "Collection": { combat: "none", activity: "retrieval" },
  "Research": { combat: "none", activity: "investigation" },
};

/** Derive what we can from the game data. `combat: null` is the signal to ask the player. */
export function classifyMission(m: { generatorClass?: string | null; missionType?: string | null }): MissionClassification {
  const g = m.generatorClass ?? "";
  if (g) {
    for (const r of GENERATOR_RULES) {
      if (r.re.test(g)) return { combat: r.combat, activity: r.activity, source: "generator" };
    }
  }
  const t = m.missionType ? TYPE_RULES[m.missionType] : undefined;
  if (t) return { combat: t.combat, activity: t.activity, source: "missionType" };
  return { combat: null, activity: null, source: null };
}

/** Whether the completion report should ask the combat question for this mission. */
export function needsCombatSurvey(m: { generatorClass?: string | null; missionType?: string | null }): boolean {
  return classifyMission(m).combat === null;
}

/** Player-facing label for a derived profile. Kept here so the overlay and the site can't drift. */
export const COMBAT_LABEL: Record<CombatProfile, string> = {
  fps: "On-foot combat",
  ship: "Ship combat",
  mixed: "On-foot and ship combat",
  none: "No combat required",
};
