/**
 * HaulingTracker tests. Every fixture below is a REAL line, copied verbatim out of Sub's
 * Game.log corpus (2025-07-31 → 2026-08-16) — including CIG's inconsistent spacing. They go in
 * at the LINE level, through the real parser, for the same reason dev-replay does: a regex
 * regression has to break the test, and injecting events directly would keep passing while the
 * game stopped working.
 */
import assert from "node:assert/strict";
import { parseLine } from "./parser.js";
import { parseMissionEvent, objectiveKeyOf, objectiveRoleOf } from "./missions-parser.js";
import { HaulingTracker, completionOf, scuOfItemClass, isHaulingContract } from "./hauling.js";

function feed(tracker: HaulingTracker, lines: string[]): void {
  for (const l of lines) {
    const ev = parseMissionEvent(parseLine(l));
    if (ev) tracker.apply(ev);
  }
}

// ── objectiveKeyOf: the join key ───────────────────────────────────────────────────────────
// 🔑 The same GoblinG leg, as CreateMarker wrote it and as the two ObjectiveUpserted pushes
// wrote it. The leading hash AND the second-to-last index both change; only the uuid and the
// final index survive. Matching on the raw id would have left every GoblinG delivery unticked.
assert.equal(objectiveKeyOf("d_2244305748_60f116f4-c02a-45b2-9ded-333747795124_-1_1"),
             objectiveKeyOf("d_2756183015_60f116f4-c02a-45b2-9ded-333747795124_0_1"),
             "GoblinG rewrites the hash and the middle index for the same leg");
assert.notEqual(objectiveKeyOf("d_2244305748_60f116f4-c02a-45b2-9ded-333747795124_-1_1"),
                objectiveKeyOf("d_2244305748_a789f57a-e12b-4bcd-8132-e0c03d84fc89_-1_0"),
                "different legs must not collapse together");
// Covalex/RedWind write the same token everywhere, so the key is a straight pass-through.
assert.equal(objectiveKeyOf("dropoff_c81e8cbe-d469-42db-8764-59023a64899e_0"),
             "c81e8cbe-d469-42db-8764-59023a64899e#0");
// A pickup and its drop-off share a leg key — they are the two ends of one leg, told apart by role.
assert.equal(objectiveKeyOf("pickup_4d907890-87c7-4d71-8484-85d8936d18d4_0"),
             objectiveKeyOf("dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0"));
assert.equal(objectiveRoleOf("pickup_4d907890-87c7-4d71-8484-85d8936d18d4_0"), "pickup");
assert.equal(objectiveRoleOf("d_2244305748_60f116f4-c02a-45b2-9ded-333747795124_-1_1"), "dropoff");
assert.equal(objectiveRoleOf("39fc3b41-bde1-ea62-6407-1eeef00723e1"), "other", "a bare uuid is a phase, not a leg");

// ── completionOf: one completion, two spellings, same millisecond ──────────────────────────
assert.equal(completionOf("MISSION_STATE_COMPLETED"), "Complete");
assert.equal(completionOf("COMPLETED"), "Complete");
assert.equal(completionOf("ABANDONED"), "Abandoned");
assert.equal(completionOf("MISSION_STATE_WITHDRAWN"), "Abandoned");
assert.equal(completionOf("FAILED"), "Failed");

assert.equal(scuOfItemClass("Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum"), 8);
assert.equal(scuOfItemClass("Carryable_TBO_FL_24SCU_Commodity_Metal_Tungsten"), 24);
assert.equal(scuOfItemClass("Carryable_TBO_InventoryContainer_2SCU_Pirate"), 2);
assert.equal(scuOfItemClass("FPS_Consumable_HardDrive_Delving_ASD_Black"), null);

// The org is in the GENERATOR for Covalex/RedWind but only in the CONTRACT for GoblinG.
assert.ok(isHaulingContract("Covalex_Hauling", "HaulCargo_AToB_Processed_Stims_Stanton3_SupplyGrade"));
assert.ok(isHaulingContract("GoblinG_Generator", "GoblinG_HaulCargo_L_Stanton2"));
assert.ok(!isHaulingContract("BountyHuntersGuild_KIllShip", "BountyHuntersGuild_Bounty_Pyro_VeryEasy"));

// ── A tracked Covalex contract, accept → delivery → payout ─────────────────────────────────
// Real lines: mission 275d8ca8 (2026-08-16, Stims 81 SCU) with the completion/payout pair
// grafted on from mission 0c17926b, which really did pay 56,000 aUEC 39ms after ending.
{
  const t = new HaulingTracker();
  feed(t, [
    `<2026-08-16T15:18:28.982Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [275d8ca8-c591-4147-9058-e052d6a22d7e], generator name [Covalex_Hauling], contract [HaulCargo_AToB_Processed_Stims_Stanton3_SupplyGrade], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0], markerEntityId [12897], zoneHostId [742554712000], position [x: -771960.562500, y: -321347.218750, z: -359509.343750] [Team_MissionFeatures][Missions]`,
    `<2026-08-16T15:18:28.982Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [275d8ca8-c591-4147-9058-e052d6a22d7e], generator name [Covalex_Hauling], contract [HaulCargo_AToB_Processed_Stims_Stanton3_SupplyGrade], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [pickup_4d907890-87c7-4d71-8484-85d8936d18d4_0], markerEntityId [12898], zoneHostId [742554712000], position [x: -748272.078090, y: -103662.326450, z: -263812.173494] [Team_MissionFeatures][Missions]`,
    `<2026-08-16T15:18:28.985Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Rookie Rank - Direct Medium Cargo Haul: " [46] to queue. New queue size: 1, MissionId: [275d8ca8-c591-4147-9058-e052d6a22d7e], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
    `<2026-08-16T15:18:28.985Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/81 SCU of Stims to Baijini Point: " [47] to queue. New queue size: 2, MissionId: [275d8ca8-c591-4147-9058-e052d6a22d7e], ObjectiveId: [dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0] [Team_CoreGameplayFeatures][Missions][Comms]`,
  ]);
  const c = t.view().contracts[0];
  assert.ok(c, "CreateMarker alone must admit the contract");
  assert.equal(c.title, "Rookie Rank - Direct Medium Cargo Haul");
  assert.equal(c.tracked, true, "a Deliver line means the player tracked it");
  assert.equal(c.totalScu, 81);
  assert.equal(c.stops.length, 2, "one pickup + one drop-off");
  const drop = c.stops.find((s) => s.role === "dropoff")!;
  assert.equal(drop.commodity, "Stims");
  assert.equal(drop.destination, "Baijini Point", "the destination must not swallow the trailing colon");
  assert.equal(drop.unit, "scu");
  assert.equal(drop.delivered, 0, "tracked at accept — nothing delivered yet");
  assert.equal(drop.state, "pending");
  assert.deepEqual(drop.pos, { x: -771960.5625, y: -321347.21875, z: -359509.34375 });
  // The pickup carries a DIFFERENT position — that pair is the leg the router measures.
  assert.notEqual(c.stops.find((s) => s.role === "pickup")!.pos!.x, drop.pos!.x);

  // Delivery, then the two end lines the game emits together, then the award 39ms later.
  feed(t, [
    `<2026-08-16T16:02:11.000Z> [Notice] <ObjectiveUpserted> Received ObjectiveUpserted push message for: mission_id 275d8ca8-c591-4147-9058-e052d6a22d7e - objective_id dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0 - state MISSION_OBJECTIVE_STATE_COMPLETED - created 0 - flags=ShowInLog| [Team_GameServices][Missions]`,
    `<2026-08-16T16:02:11.050Z> [Notice] <MissionEnded> Received MissionEnded push message for: mission_id 275d8ca8-c591-4147-9058-e052d6a22d7e - mission_state MISSION_STATE_COMPLETED [Team_GameServices][Missions]`,
    `<2026-08-16T16:02:11.050Z> [Notice] <EndMission> Ending mission for player. MissionId[275d8ca8-c591-4147-9058-e052d6a22d7e] Player[IMC-SubliminaL] PlayerId[204772220757] CompletionType[Complete] Reason[Mission Ended] [Team_MissionFeatures][Missions]`,
    `<2026-08-16T16:02:11.089Z> [Notice] <SHUDEvent_OnNotification> Added notification "Awarded 56000 aUEC: " [59] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
  ]);
  const done = t.view().contracts[0];
  assert.equal(done.stops.find((s) => s.role === "dropoff")!.state, "completed");
  assert.equal(done.completion, "Complete", "MISSION_STATE_COMPLETED and CompletionType[Complete] are the same end");
  assert.equal(done.payout, 56000, "the award's own MissionId is all-zeros — it joins by time");
}

// 🔴 A completion emits TWO end events in the same millisecond. If both queue a payout claim,
// the second one steals the NEXT contract's award. Pin it: one award, one contract paid.
{
  const t = new HaulingTracker();
  const mk = (id: string, key: string, at: string) =>
    `<${at}> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [${id}], generator name [Covalex_Hauling], contract [${key}], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0], markerEntityId [1], zoneHostId [2], position [x: 1.0, y: 2.0, z: 3.0] [Team_MissionFeatures][Missions]`;
  const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
  feed(t, [
    mk(A, "HaulCargo_AToB_One", "2026-08-16T15:00:00.000Z"),
    mk(B, "HaulCargo_AToB_Two", "2026-08-16T15:00:01.000Z"),
    `<2026-08-16T15:10:00.000Z> [Notice] <MissionEnded> Received MissionEnded push message for: mission_id ${A} - mission_state MISSION_STATE_COMPLETED [Team_GameServices][Missions]`,
    `<2026-08-16T15:10:00.000Z> [Notice] <EndMission> Ending mission for player. MissionId[${A}] Player[IMC-SubliminaL] PlayerId[204772220757] CompletionType[Complete] Reason[Mission Ended] [Team_MissionFeatures][Missions]`,
    `<2026-08-16T15:10:00.040Z> [Notice] <SHUDEvent_OnNotification> Added notification "Awarded 50250 aUEC: " [59] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
    `<2026-08-16T15:10:00.500Z> [Notice] <SHUDEvent_OnNotification> Added notification "Awarded 38000 aUEC: " [60] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
  ]);
  const [a, b] = t.view().contracts;
  assert.equal(a.payout, 50250, "the nearest award goes to the contract that just ended");
  assert.equal(b.payout, null, "a second award must NOT be handed to a contract that never ended");
}

// ── The tracking gate ──────────────────────────────────────────────────────────────────────
// 🔑 The point of the whole module. An untracked contract is fully known EXCEPT its tonnage,
// and the widget's job is to ask the player to track it — not to hide the gap.
{
  const t = new HaulingTracker();
  feed(t, [
    `<2026-08-16T15:18:51.005Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [1d999cf2-b491-4cb0-bdb4-9f5d2f05bf98], generator name [Covalex_Hauling], contract [HaulCargo_AToB_Waste_Mixed_ScrapWaste_Stanton3_SupplyGrade], contractDefinitionId[1595c72c-4a1b-4b33-84ee-a975547b353f], objectiveId [dropoff_9a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9_0], markerEntityId [12905], zoneHostId [742554712000], position [x: -771960.5, y: -321347.2, z: -359509.3] [Team_MissionFeatures][Missions]`,
    `<2026-08-16T15:18:51.009Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Rookie Rank - Direct Medium Cargo Haul: " [48] to queue. New queue size: 1, MissionId: [1d999cf2-b491-4cb0-bdb4-9f5d2f05bf98], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
  ]);
  const v = t.view();
  assert.equal(v.contracts.length, 1, "an untracked contract is still a known contract");
  assert.equal(v.contracts[0].tracked, false);
  assert.equal(v.contracts[0].totalScu, null, "no Deliver line means no tonnage — never a guess");
  assert.deepEqual(v.untracked, ["1d999cf2-b491-4cb0-bdb4-9f5d2f05bf98"], "it belongs on the please-track list");
}

// ── The three Deliver payload forms ────────────────────────────────────────────────────────
{
  const forms: [string, string, number, string, string | null][] = [
    ["Deliver 0/20 SCU of Processed Food to Sunset Mesa", "scu", 20, "Sunset Mesa", "Processed Food"],
    ["Deliver 0/9 Cargo Boxes to Gaslight at the L2 Lagrange of Pyro V", "boxes", 9, "Gaslight at the L2 Lagrange of Pyro V", null],
    ["Deliver 0/10 TH-01 Propulsor to August Dunlow Spaceport", "items", 10, "August Dunlow Spaceport", "TH-01 Propulsor"],
    // The destination contains " on " and a lower-case article — the non-greedy split must not
    // stop early or eat it.
    ["Deliver 0/85 SCU of Scrap to a Salvage Yard on Wala", "scu", 85, "a Salvage Yard on Wala", "Scrap"],
  ];
  for (const [text, unit, need, dest, commodity] of forms) {
    const ev = parseMissionEvent(parseLine(
      `<2026-08-16T00:00:00.000Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: ${text}: " [1] to queue. New queue size: 1, MissionId: [11111111-2222-3333-4444-555555555555], ObjectiveId: [dropoff_9a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9_0] [Team_CoreGameplayFeatures][Missions][Comms]`));
    assert.ok(ev?.kind === "haulObjective", `"${text}" should parse as a haul objective`);
    assert.equal(ev.unit, unit, text);
    assert.equal(ev.need, need, text);
    assert.equal(ev.destination, dest, text);
    assert.equal(ev.commodity, commodity, text);
  }
  // No count at all → a mission-ITEM haul. It carries no tonnage, so it must stay a plain
  // newObjective rather than being forced into the hauling shape with invented numbers.
  const item = parseMissionEvent(parseLine(
    `<2026-07-21T18:05:42.600Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver Black Box To Levski: " [66] to queue. New queue size: 3, MissionId: [3f85edc5-fa23-45bc-b1dd-fb1dcfe719cd], ObjectiveId: [dropoff_a20f8296-db01-48ab-8ddd-5ff0b15433f4_0] [Team_CoreGameplayFeatures][Missions][Comms]`));
  assert.equal(item?.kind, "newObjective", "a countless Deliver is an item haul, not a tonnage haul");
}

// ── Multi-leg: one mission, two commodities, two drop-off indices ──────────────────────────
// Real pair from 2026-08-02. Note the SAME uuid with indices _0 and _1 — the index is what
// separates the legs, and both go to the same place.
{
  const t = new HaulingTracker();
  const mk = (obj: string, x: number) =>
    `<2026-08-02T02:55:42.000Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [cbeb9a6b-19fc-47e1-8b75-e098a15daca2], generator name [Covalex_Hauling], contract [HaulCargo_MultiToSingle_Stanton1], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [${obj}], markerEntityId [1], zoneHostId [2], position [x: ${x}.0, y: 2.0, z: 3.0] [Team_MissionFeatures][Missions]`;
  const note = (n: number, c: string, i: number) =>
    `<2026-08-02T02:55:42.177Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/${n} SCU of ${c} to Levski: " [38] to queue. New queue size: 1, MissionId: [cbeb9a6b-19fc-47e1-8b75-e098a15daca2], ObjectiveId: [dropoff_246aa48e-a4d0-4669-be1f-8d4d029b34ef_${i}] [Team_CoreGameplayFeatures][Missions][Comms]`;
  feed(t, [
    mk("dropoff_246aa48e-a4d0-4669-be1f-8d4d029b34ef_0", 10),
    mk("dropoff_246aa48e-a4d0-4669-be1f-8d4d029b34ef_1", 20),
    note(10, "Recycled Material Composite", 0),
    note(6, "Construction Materials", 1),
  ]);
  const c = t.view().contracts[0];
  assert.equal(c.stops.length, 2, "the trailing index separates two legs sharing one uuid");
  assert.equal(c.totalScu, 16, "totalScu sums the legs");
  assert.equal(c.stops[0].commodity, "Recycled Material Composite");
  assert.equal(c.stops[1].commodity, "Construction Materials");

  // Completing leg 1 must not tick leg 0.
  feed(t, [`<2026-08-02T03:30:00.000Z> [Notice] <ObjectiveUpserted> Received ObjectiveUpserted push message for: mission_id cbeb9a6b-19fc-47e1-8b75-e098a15daca2 - objective_id dropoff_246aa48e-a4d0-4669-be1f-8d4d029b34ef_1 - state MISSION_OBJECTIVE_STATE_COMPLETED - created 0 - flags=ShowInLog| [Team_GameServices][Missions]`]);
  const after = t.view().contracts[0];
  assert.equal(after.stops[0].state, "pending");
  assert.equal(after.stops[1].state, "completed");
  // …and a late INPROGRESS push must not un-tick it.
  feed(t, [`<2026-08-02T03:31:00.000Z> [Notice] <ObjectiveUpserted> Received ObjectiveUpserted push message for: mission_id cbeb9a6b-19fc-47e1-8b75-e098a15daca2 - objective_id dropoff_246aa48e-a4d0-4669-be1f-8d4d029b34ef_1 - state MISSION_OBJECTIVE_STATE_INPROGRESS - created 0 - flags=ShowInLog| [Team_GameServices][Missions]`]);
  assert.equal(t.view().contracts[0].stops[1].state, "completed", "completion is terminal — server churn must not undo a delivery");
}

// ── Exact manifests, for mission-item hauls only ───────────────────────────────────────────
{
  const t = new HaulingTracker();
  feed(t, [
    `<2025-10-02T16:15:20.000Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [a361e282-fea7-4d32-9ac4-10106a30c953], generator name [HeadHunters_RecoverCargo], contract [HH_Pyro_VeryEasy_RecoverCargo], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [dropoff_858d7f1a-0e5c-4b4b-8c67-d7e39b063f1a_0_0], markerEntityId [1], zoneHostId [2], position [x: 1.0, y: 2.0, z: 3.0] [Team_MissionFeatures][Missions]`,
    `<2025-10-02T16:15:26.864Z> [Notice] <SMarkerHandler_Hauling::OnItemRegistered> Mission Item Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum_6419121662056 (6419121662056) registered with mission id a361e282-fea7-4d32-9ac4-10106a30c953, phase id 00000000-0000-0000-0000-000000000000, pickup objective id , drop off objective id dropoff_858d7f1a-0e5c-4b4b-8c67-d7e39b063f1a_0_0 [Team_MissionFeatures][Missions]`,
  ]);
  const c = t.view().contracts[0];
  assert.equal(c.items.length, 1);
  assert.equal(c.items[0].itemClass, "Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum", "the entity id suffix must be stripped");
  assert.equal(c.items[0].scu, 8);
  assert.equal(c.items[0].present, true);
  assert.equal(c.items[0].dropoffKey, objectiveKeyOf("dropoff_858d7f1a-0e5c-4b4b-8c67-d7e39b063f1a_0_0"));

  // The unregister line names ONLY the entity id — the class has to come from the cache.
  feed(t, [`<2025-10-02T16:19:32.723Z> [Notice] <SMarkerHandler_Hauling::OnItemUnregistered> Mission Item (6419121662056) unregistered with mission id a361e282-fea7-4d32-9ac4-10106a30c953 [Team_MissionFeatures][Missions]`]);
  const after = t.view().contracts[0];
  assert.equal(after.items.length, 1, "a streamed-out box is the same box, not a deletion");
  assert.equal(after.items[0].present, false);
  assert.equal(after.items[0].itemClass, "Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum", "class resolved from the entityId cache");
}

// ── Ship identity, at model level ──────────────────────────────────────────────────────────
{
  const t = new HaulingTracker();
  feed(t, [
    `<2026-08-16T14:20:00.000Z> [Notice] <Vehicle Control Flow> CVehicleMovementBase::SetDriver: Local client node [204772220757] requesting control token for 'CRUS_Starlifter_C2_766969713219' [766969713219] [Team_CGP4][Vehicle]`,
  ]);
  assert.equal(t.view().ship?.model, "CRUS_Starlifter_C2", "model level — the skin system only ever knows the manufacturer");
  assert.equal(t.view().playerNodeId, "204772220757");

  // Releasing a DIFFERENT vehicle (one that streamed out) must not clear the ship we're flying.
  feed(t, [`<2026-08-16T14:25:00.000Z> [Notice] <Vehicle Control Flow> CVehicleMovementBase::ClearDriver: Local client node [204772220757] releasing control token for 'MISC_Razor_EX_5246866009367' [5246866009367] [Team_CGP4][Vehicle]`]);
  assert.equal(t.view().ship?.model, "CRUS_Starlifter_C2");
  feed(t, [`<2026-08-16T14:38:13.335Z> [Notice] <Vehicle Control Flow> CVehicleMovementBase::ClearDriver: Local client node [204772220757] releasing control token for 'CRUS_Starlifter_C2_766969713219' [766969713219] [Team_CGP4][Vehicle]`]);
  assert.equal(t.view().ship, null, "getting out of the ship we were in does clear it");

  // Node 0 is the engine's "nobody" sentinel and appears alongside the real id.
  const zero = parseMissionEvent(parseLine(`<2026-08-16T14:39:00.000Z> [Notice] <Vehicle Control Flow> CVehicleMovementBase::ClearDriver: Local client node [0] releasing control token for 'CRUS_Starlifter_C2_766969713219' [766969713219] [Team_CGP4][Vehicle]`));
  assert.equal(zero, null, "node 0 is not a player");
}

// 🔑 A spawn-in re-emission reports LIVE progress, not 0. Real line from a shared log
// (punk_hiji, 2026-08-05): the Deliver notification landed 5ms after the CreateMarker and read
// "3/5", because the contract was already part-delivered when the player logged back in.
// This is what disproves the old "the counter never ticks" conclusion — that was an artifact of
// only ever tracking a contract at accept time.
{
  const t = new HaulingTracker();
  const MID = "5e8b8c9c-b313-47a1-9955-a63f1095aa51";
  feed(t, [
    `<2026-08-05T02:59:42.181Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [${MID}], generator name [Covalex_Hauling], contract [HaulCargo_AToB_Salvage_RMC_Stanton1], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [dropoff_246aa48e-a4d0-4669-be1f-8d4d029b34ef_0], markerEntityId [1], zoneHostId [2], position [x: 1.0, y: 2.0, z: 3.0] [Team_MissionFeatures][Missions]`,
    `<2026-08-05T02:59:42.186Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 3/5 SCU of Recycled Material Composite to Levski: " [86] to queue. New queue size: 2, MissionId: [${MID}], ObjectiveId: [dropoff_246aa48e-a4d0-4669-be1f-8d4d029b34ef_0] [Team_CoreGameplayFeatures][Missions][Comms]`,
  ]);
  const drop = t.view().contracts[0].stops.find((s) => s.role === "dropoff")!;
  assert.equal(drop.need, 5);
  assert.equal(drop.delivered, 3, "the numerator is real progress — do not discard it");

  // A later notification for a fresh instance of the same repeat contract reports 0. Progress
  // must not walk backwards.
  feed(t, [`<2026-08-05T03:10:00.000Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/5 SCU of Recycled Material Composite to Levski: " [90] to queue. New queue size: 1, MissionId: [${MID}], ObjectiveId: [dropoff_246aa48e-a4d0-4669-be1f-8d4d029b34ef_0] [Team_CoreGameplayFeatures][Missions][Comms]`]);
  assert.equal(t.view().contracts[0].stops.find((s) => s.role === "dropoff")!.delivered, 3,
    "delivered is monotonic");
}

console.log("hauling tests passed");
