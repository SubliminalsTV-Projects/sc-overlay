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

/* ── Hauling ────────────────────────────────────────────────────────────────────────────────
 *
 * Separate scenarios, separate builder. The set above drives the mission REPORT CARD and is
 * shaped for it (one contract, one blueprint, one payout); a hauling run is a different animal —
 * several legs, positions, per-destination progress, and a manifest.
 *
 * 🔑 Two INDEPENDENT knobs, because the game treats them as independent and an earlier design
 * assumed they were the same thing:
 *
 *   `tonnageStated`  emit the "New Objective: Deliver 0/N SCU …" line. The game emits it on
 *                    objective ASSIGNMENT — a fresh accept, a spawn-in, a drop-off changing
 *                    state — and **never again**, whatever the player does.
 *   `mobiglas`       emit the objective data-bank Adds, i.e. the contract is selected in mobiGlas.
 *
 * All four combinations are real, and the interesting one is `haul-tracked-silent`: tracked, and
 * still no tonnage. That is Sub's live 2026-08-17 board — he tracked four contracts, watched a
 * prompt tell him to track them, and nothing changed, because tracking is not what emits the
 * figure. The widget has to say something different in that state, so the scenario exists to
 * make it look at.
 */

interface HaulLeg {
  /** Where the boxes are picked up and dropped, as marker positions. Real Stanton/Pyro
   *  coordinates from the corpus, so distances between legs are plausible. */
  pickup: [number, number, number];
  dropoff: [number, number, number];
  destination: string;
  commodity: string | null;
  need: number;
  unit: "scu" | "boxes";
  /** Whether this leg gets an ObjectiveUpserted COMPLETED before the run ends. */
  delivered: boolean;
}

export interface HaulScenario {
  id: string;
  label: string;
  note: string;
  contractKey: string;
  generator: string;
  title: string;
  /** Did the game ever state the tonnage? False means no Deliver lines at all. */
  tonnageStated: boolean;
  /** Is it the contract selected in mobiGlas? Emits the data-bank Add lines. Independent of
   *  `tonnageStated` — tracking does not produce a Deliver line. Defaults to false. */
  mobiglas?: boolean;
  legs: HaulLeg[];
  /** Entity classes of the individual boxes, for mission-item hauls. Empty for SCU hauls,
   *  which log no manifest anywhere — see hauling.ts. */
  items: string[];
  /** Ship to be sitting in, at model level. Null = on foot. */
  ship: string | null;
  durationMin: number;
  /** null = the run is still live when the scenario ends (nothing completes). */
  aUEC: number | null;
}

export const HAUL_SCENARIOS: HaulScenario[] = [
  {
    id: "haul-tracked",
    label: "Covalex — tracked, single leg, 81 SCU of Stims",
    note: "The happy path. Sub's real 2026-08-16 contract: everything known, delivered, paid.",
    contractKey: "HaulCargo_AToB_Processed_Stims_Stanton3_SupplyGrade",
    generator: "Covalex_Hauling",
    title: "Rookie Rank - Direct Medium Cargo Haul",
    tonnageStated: true,
    legs: [{
      pickup: [-748272.078090, -103662.326450, -263812.173494],
      dropoff: [-771960.562500, -321347.218750, -359509.343750],
      destination: "Baijini Point", commodity: "Stims", need: 81, unit: "scu", delivered: true,
    }],
    items: [], ship: "CRUS_Starlifter_C2", durationMin: 44, aUEC: 56000,
  },
  {
    id: "haul-untracked",
    label: "Covalex — accepted but NOT tracked (no tonnage)",
    note: "🔑 The case the widget exists to handle. The contract is fully known except how much cargo it is, because the player never tracked it in mobiGlas. Must show the please-track prompt, never a guessed number.",
    contractKey: "HaulCargo_AToB_Waste_Mixed_ScrapWaste_Stanton3_SupplyGrade",
    generator: "Covalex_Hauling",
    title: "Rookie Rank - Direct Medium Cargo Haul",
    tonnageStated: false,
    legs: [{
      pickup: [-748272.078090, -103662.326450, -263812.173494],
      dropoff: [-771960.562500, -321347.218750, -359509.343750],
      destination: "Baijini Point", commodity: "Scrap", need: 64, unit: "scu", delivered: false,
    }],
    items: [], ship: "CRUS_Starlifter_C2", durationMin: 3, aUEC: null,
  },
  {
    id: "haul-tracked-silent",
    label: "Covalex — TRACKED in mobiGlas, and still no tonnage",
    note: "🔴 Sub's live 2026-08-17 board, and the state the old prompt got wrong. The contract is selected in mobiGlas — the data bank says so — and the game has still never stated its tonnage, because the Deliver line fires at objective assignment and re-tracking does not replay it. The widget must NOT tell him to track this one; there is nothing left for him to do but type the figure in.",
    contractKey: "HaulCargo_AToB_RefinedOre_Tin_Stanton3_SupplyGrade",
    generator: "Covalex_Hauling",
    title: "Junior Rank - Direct Medium Cargo Haul",
    tonnageStated: false,
    mobiglas: true,
    legs: [{
      pickup: [-748272.078090, -103662.326450, -263812.173494],
      dropoff: [-771960.562500, -321347.218750, -359509.343750],
      destination: "Baijini Point", commodity: "Tin", need: 48, unit: "scu", delivered: false,
    }],
    items: [], ship: "CRUS_Starlifter_C2", durationMin: 6, aUEC: null,
  },
  {
    id: "haul-multi",
    label: "Two legs, two commodities, one delivered",
    note: "Real pair from 2026-08-02 — the SAME objective uuid with indices _0 and _1. Checks that ticking one leg does not tick the other, and that the capacity bar sums both.",
    contractKey: "HaulCargo_MultiToSingle_Stanton1",
    generator: "Covalex_Hauling",
    title: "Junior Rank - Multi Cargo Haul",
    tonnageStated: true,
    legs: [
      {
        pickup: [373539.798854, -262716.041903, -269591.417313],
        dropoff: [383115.366423, -245829.717381, -272467.223889],
        destination: "Levski", commodity: "Recycled Material Composite", need: 10, unit: "scu", delivered: true,
      },
      {
        pickup: [-748272.078090, -103662.326450, -263812.173494],
        dropoff: [383115.366423, -245829.717381, -272467.223889],
        destination: "Levski", commodity: "Construction Materials", need: 6, unit: "scu", delivered: false,
      },
    ],
    items: [], ship: "RSI_Constellation_Taurus", durationMin: 26, aUEC: null,
  },
  {
    id: "haul-items",
    label: "Mission-item haul — EXACT manifest (9 boxes)",
    note: "The only hauling family whose box breakdown is logged (OnItemRegistered). Sub's 2026-08-05 recover-cargo: the Deliver line said 9 Cargo Boxes and exactly 9 items registered — which is the ground truth the box-partition model gets fitted against.",
    contractKey: "HH_Pyro_VeryEasy_RecoverCargo",
    generator: "HeadHunters_RecoverCargo",
    title: "Cargo Recovery",
    tonnageStated: true,
    legs: [{
      pickup: [373539.798854, -262716.041903, -269591.417313],
      dropoff: [383115.366423, -245829.717381, -272467.223889],
      destination: "Gaslight at the L2 Lagrange of Pyro V", commodity: null, need: 9, unit: "boxes", delivered: false,
    }],
    // Greedy-largest-first against an 8 SCU cap, which is Sub's partition hypothesis: this is a
    // fixture of what he EXPECTS, so a future calibration pass that disproves it fails here first.
    items: [
      "Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum", "Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum",
      "Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum", "Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum",
      "Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum", "Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum",
      "Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum", "Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum",
      "Carryable_TBO_FL_1SCU_Commodity_Metal_Aluminum",
    ],
    ship: "DRAK_Cutlass_Black", durationMin: 18, aUEC: null,
  },
];

/**
 * Build the log lines for a hauling scenario. Same rule as `replayLines`: real line shapes,
 * copied out of Game.log, so a parser regression breaks the simulation too.
 *
 * `objUuid` is the objective TEMPLATE id and is deliberately shared by every leg, with the leg
 * index as the suffix — that is exactly how the game writes it, and it is the case a naive
 * "objectiveId is unique" assumption gets wrong.
 */
export function haulReplayLines(s: HaulScenario, missionId: string, now = Date.now()): string[] {
  const start = now - s.durationMin * 60_000;
  const objUuid = `${missionId.slice(0, 8)}-0000-4000-8000-000000000001`;
  const defId = `${missionId.slice(0, 8)}-0000-4000-8000-000000000002`;
  const nodeId = "204772220757";
  const lines: string[] = [];
  const pos = ([x, y, z]: [number, number, number]) => `position [x: ${x.toFixed(6)}, y: ${y.toFixed(6)}, z: ${z.toFixed(6)}]`;
  const marker = (at: number, objectiveId: string, entity: number, p: [number, number, number]) =>
    `<${stamp(at)}> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [${missionId}], generator name [${s.generator}], contract [${s.contractKey}], contractDefinitionId[${defId}], objectiveId [${objectiveId}], markerEntityId [${entity}], zoneHostId [742554712000], ${pos(p)} [Team_MissionFeatures][Missions]`;

  // 🔑 The markers come FIRST and carry the contract key — CreateMarker is the only reliable
  // hauling accept signal, and it fires whether or not the contract is tracked.
  s.legs.forEach((leg, i) => {
    lines.push(marker(start, `dropoff_${objUuid}_${i}`, 900 + i * 2, leg.dropoff));
    lines.push(marker(start, `pickup_${objUuid}_${i}`, 901 + i * 2, leg.pickup));
  });
  lines.push(
    `<${stamp(start + 3)}> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  ${s.title}: " [900] to queue. New queue size: 1, MissionId: [${missionId}], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
  );
  if (s.tonnageStated) {
    s.legs.forEach((leg, i) => {
      const what = leg.unit === "scu" ? `SCU of ${leg.commodity}` : "Cargo Boxes";
      lines.push(
        `<${stamp(start + 4)}> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/${leg.need} ${what} to ${leg.destination}: " [${901 + i}] to queue. New queue size: 2, MissionId: [${missionId}], ObjectiveId: [dropoff_${objUuid}_${i}] [Team_CoreGameplayFeatures][Missions][Comms]`,
      );
    });
  }
  // The player selecting this contract in mobiGlas. Copied verbatim from Sub's 2026-08-17 log,
  // including the "ZonePos:" spelling with bare x/y/z — CreateMarker's own position field is
  // bracketed and this one is not, which is why the parser carries two patterns.
  if (s.mobiglas) {
    s.legs.forEach((leg, i) => {
      const add = (at: number, objectiveId: string, entity: number, p: [number, number, number]) =>
        `<${stamp(at)}> [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> MissionObjectiveMarker_${entity}[${entity}] - Added to DataBank of Player: IMC-SubliminaL[${nodeId}] - ZonePos: x: ${p[0].toFixed(6)}, y: ${p[1].toFixed(6)}, z: ${p[2].toFixed(6)}, missionId[${missionId}], objectiveId[${objectiveId}] [Team_MissionFeatures][Missions]`;
      lines.push(add(start + 5, `pickup_${objUuid}_${i}`, 901 + i * 2, leg.pickup));
      lines.push(add(start + 5, `dropoff_${objUuid}_${i}`, 900 + i * 2, leg.dropoff));
    });
  }
  if (s.ship) {
    const shipEntity = "766969713219";
    lines.push(
      `<${stamp(start + 60_000)}> [Notice] <Vehicle Control Flow> CVehicleMovementBase::SetDriver: Local client node [${nodeId}] requesting control token for '${s.ship}_${shipEntity}' [${shipEntity}] [Team_CGP4][Vehicle]`,
    );
  }
  // Mission items stream in at the pickup. The class name carries the entity id as a suffix,
  // exactly as the game writes it.
  s.items.forEach((cls, i) => {
    const entity = `${6419121662056 + i}`;
    lines.push(
      `<${stamp(start + 120_000 + i * 40)}> [Notice] <SMarkerHandler_Hauling::OnItemRegistered> Mission Item ${cls}_${entity} (${entity}) registered with mission id ${missionId}, phase id 00000000-0000-0000-0000-000000000000, pickup objective id , drop off objective id dropoff_${objUuid}_0 [Team_MissionFeatures][Missions]`,
    );
  });
  s.legs.forEach((leg, i) => {
    if (!leg.delivered) return;
    lines.push(
      `<${stamp(now - 1_000)}> [Notice] <ObjectiveUpserted> Received ObjectiveUpserted push message for: mission_id ${missionId} - objective_id dropoff_${objUuid}_${i} - state MISSION_OBJECTIVE_STATE_COMPLETED - created 0 - flags=ShowInLog| [Team_GameServices][Missions]`,
    );
  });
  if (s.aUEC != null) {
    // Both end lines, in the same millisecond, exactly as the game emits them — then the award
    // 39ms later. That ordering is the fixture: it is what proves the payout correlation joins
    // once rather than twice (see HaulingTracker.onEnd).
    lines.push(
      `<${stamp(now)}> [Notice] <MissionEnded> Received MissionEnded push message for: mission_id ${missionId} - mission_state MISSION_STATE_COMPLETED [Team_GameServices][Missions]`,
      `<${stamp(now)}> [Notice] <EndMission> Ending mission for player. MissionId[${missionId}] Player[IMC-SubliminaL] PlayerId[${nodeId}] CompletionType[Complete] Reason[Mission Ended] [Team_MissionFeatures][Missions]`,
      `<${stamp(now + 39)}> [Notice] <SHUDEvent_OnNotification> Added notification "Awarded ${s.aUEC} aUEC: " [902] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
    );
  }
  return lines;
}
