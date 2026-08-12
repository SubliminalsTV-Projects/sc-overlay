/**
 * Dev replay — simulate finishing a mission without playing one.
 *
 * Every UI that fires on a mission ending (the report card, the crowdsourcing questions, the
 * Unlock Alerts widget) is otherwise only reachable by actually flying out and doing a contract,
 * which made a one-line CSS change cost twenty minutes of Star Citizen. This feeds real log LINES
 * through the real parser into the live tracker instead.
 *
 * 🔑 It replays raw log lines, NOT synthesised MissionEvents. The line shapes below were copied
 * out of Sub's own `Game.log` (2026-07-30) verbatim, placeholders aside — including the DOUBLE
 * space in `"Contract Accepted:  <title>"`, which is really in CIG's string. Going in at the line
 * level means a parser regression breaks the simulation too, which is the point; injecting
 * events directly would happily keep passing while the real game stopped working.
 *
 * 🔑 The blueprint a scenario "receives" is chosen at run time from what the player ALREADY OWNS
 * in that mission's pool (`ownedPoolBlueprint`). A receipt takes the same path as a real one, so
 * it mutates the real collection and SiteSync pushes that with `replace:true` — re-receiving an
 * owned blueprint is a no-op against a set, inventing one writes a lie to the website. If the
 * player owns nothing in the pool, the scenario runs WITHOUT a drop and says so.
 */

export interface ReplayScenario {
  id: string;
  label: string;
  /** What it's for — printed by the CLI so the list is self-explanatory. */
  note: string;
  contractKey: string;
  generator: string;
  title: string;
  /** Minutes of "mission duration" to fake, so the report's time stat is realistic. */
  durationMin: number;
  /** Whether the run ends in a blueprint drop. */
  drop: boolean;
  /** "completed" walks the normal path; "abandoned" must produce NO card at all. */
  outcome: "completed" | "abandoned";
  /** aUEC to award, or null for a mission whose reward is calculated at runtime. */
  aUEC: number | null;
}

/** Scenarios built from the missions Sub actually ran on 2026-07-30. */
export const SCENARIOS: ReplayScenario[] = [
  {
    id: "hh-fps-drop",
    label: "HeadHunters FPS — asteroid base, blueprint drops",
    note: "The everyday case. Auto-classified as on-foot combat, so the report STATES the combat type instead of asking.",
    contractKey: "HH_Pyro_RegionA_Rank0_VE_1AsteroidBase_Criminals_EliminateSpecific",
    generator: "HeadHunters_Mercenary_FPS",
    title: "Deep space hit",
    durationMin: 12,
    drop: true,
    outcome: "completed",
    aUEC: null,
  },
  {
    id: "hh-outpost",
    label: "HeadHunters FPS — derelict outpost, no drop",
    note: "A completion with no blueprint, so the report has to look right with the tiles absent.",
    contractKey: "HH_Pyro_RegionC_DerelictOutpost_EliminateAll",
    generator: "HeadHunters_Mercenary_FPS",
    title: "Reputation Management",
    durationMin: 31,
    drop: false,
    outcome: "completed",
    aUEC: null,
  },
  {
    id: "survey",
    label: "Battaglia — UNCLASSIFIED, asks the combat question",
    note: "🔑 The only way to see the crowdsourcing dropdown. Every HeadHunters contract is auto-classified, so a normal session never shows it. 10-blueprint pool.",
    contractKey: "Battaglia_DataDownload",
    generator: "Battaglia_Generator",
    title: "Moraine Data Retrieval",
    durationMin: 18,
    drop: true,
    outcome: "completed",
    aUEC: 9000,
  },
  {
    id: "bounty",
    label: "Bounty Hunter — ship kill, no drop, no payout line",
    note: "Sub's real 2026-08-10 run, copied out of Game.log. Auto-classified, so the combat question is STATED not asked — and with no blueprint and no aUEC the card has to look right with BOTH missing. The sparsest report the app can produce.",
    // Straight off the CreateMarker line. ⚠️ `KIllShip` is CIG's own typo (capital I) and is what
    // the classifier matches on — correcting it here would silently stop this auto-classifying.
    contractKey: "BountyHuntersGuild_Bounty_Pyro_VeryEasy",
    generator: "BountyHuntersGuild_KIllShip",
    // ⚠️ The TRAILING SPACE is real: the game logs "...Minimal Support) : " and acceptTitle's
    // `(.+?):\s*"` captures it. Same reason the double space above is kept — do not tidy it.
    title: "Verified Bounty: Hachiro Fiorini | Very Low-Risk Target (Single Seater Craft, Minimal Support) ",
    durationMin: 4.73, // accepted 20:57:14.266 → complete 21:01:58.136 = 283.9s, so the card reads 4:44
    drop: false,
    // 🔑 null, not 0. Nothing in the log awarded aUEC for this contract — bounty payouts are
    // calculated at runtime — and the report omits the stat rather than showing a zero.
    aUEC: null,
    outcome: "completed",
  },
  {
    id: "abandoned",
    label: "Abandoned mission — must show NOTHING",
    note: "Regression check, not a demo. An abandon shows no report at all (Sub, 2026-07-30): there is no reward to summarise and nothing worth asking about a contract you walked away from.",
    contractKey: "HH_Pyro_RegionC_DerelictOutpost_EliminateAll",
    generator: "HeadHunters_Mercenary_FPS",
    title: "Reputation Management",
    durationMin: 4,
    drop: false,
    outcome: "abandoned",
    aUEC: null,
  },
];

const stamp = (ms: number): string => new Date(ms).toISOString();

/** Build the log lines for a scenario, timestamped so the run ENDS now (the completion card is
 *  gated on freshness — a completion older than 90s is treated as history and shows nothing). */
export function replayLines(s: ReplayScenario, missionId: string, blueprint: string | null, now = Date.now()): string[] {
  const start = now - s.durationMin * 60_000;
  const lines: string[] = [];

  lines.push(
    `<${stamp(start)}> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  ${s.title}: " [900] to queue. New queue size: 1, MissionId: [${missionId}], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
  );
  // The marker is what carries the contract key + generator — without it the mission never
  // resolves to a dataset entry, and with no contract key the report can't file feedback.
  lines.push(
    `<${stamp(start + 1_000)}> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [${missionId}], generator name [${s.generator}], contract [${s.contractKey}], contractDefinitionId[00000000-0000-0000-0000-000000000001], objectiveId [00000000-0000-0000-0000-000000000002], markerEntityId [901], zoneHostId [729382559964], position [x: 56351.105603, y: -170807.690263, z: 267615.989791] [Team_MissionFeatures][Missions]`,
  );

  if (s.outcome === "abandoned") {
    lines.push(
      `<${stamp(now)}> [Notice] <MissionEnded> Mission ended: missionId [${missionId}] CompletionType[Abandon] Reason[Player left] [Team_MissionFeatures][Missions]`,
    );
    return lines;
  }

  if (s.aUEC != null) {
    lines.push(
      `<${stamp(now - 200)}> [Notice] <SHUDEvent_OnNotification> Added notification "Awarded ${s.aUEC} aUEC: " [902] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
    );
  }
  lines.push(
    `<${stamp(now)}> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Complete: ${s.title}: " [903] to queue. New queue size: 1, MissionId: [${missionId}], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
  );
  // 🔑 The drop lands ~0.5s AFTER the completion, exactly as the game does it. That gap is not
  // cosmetic: it is what made the report render with an empty blueprint list and never update
  // (fixed 2026-07-30). Any replay that emitted them together would stop catching that class of
  // bug entirely, so the delay is part of the fixture.
  if (blueprint) {
    lines.push(
      `<${stamp(now + 500)}> [Notice] <SHUDEvent_OnNotification> Added notification "Received Blueprint: ${blueprint}: " [904] to queue. New queue size: 2, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
    );
  }
  return lines;
}

/** A throwaway mission id per run, so replaying the same scenario twice is two distinct
 *  completions rather than one the tracker de-duplicates and ignores. */
export function replayMissionId(seq: number): string {
  const n = seq.toString(16).padStart(12, "0");
  return `dead0000-0000-4000-8000-${n}`;
}
