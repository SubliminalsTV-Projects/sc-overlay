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
  assert.equal(c.deliverSeen, true, "a Deliver line is the game stating the tonnage");
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
  assert.equal(v.contracts[0].deliverSeen, false);
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

// ── 🔴 The tracking signal: CObjectiveMarkerComponent's player data bank ────────────────────
//
// Every line below is verbatim from Sub's live 2026-08-17 session, in the order the game wrote
// them, including the interleaving of Remove and Add inside a single millisecond. Four Covalex
// contracts; he cycled tracking through them while the tower watched.
{
  const t = new HaulingTracker();
  const STIMS = "1bc24142-bd0f-44ba-9079-1a1527848aea";   // pickup/dropoff_4d907890-…
  const WASTE = "388616e7-68ba-4bb6-b0ba-2206eaa00cb4";   // pickup/dropoff_7000cb2b-…
  const CORUN = "e21a3aa6-6149-41c4-ae72-8c265dfaf4ee";   // pickup/dropoff_5ddfa24e-…
  const mk = (mid: string, obj: string, entity: number) =>
    `<2026-08-17T00:17:27.013Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [${mid}], generator name [Covalex_Hauling], contract [HaulCargo_AToB_Processed_Stims_Stanton3_SupplyGrade], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [${obj}], markerEntityId [${entity}], zoneHostId [758378849484], position [x: -771960.562500, y: -321347.218750, z: -359509.343750] [Team_MissionFeatures][Missions]`;
  feed(t, [
    mk(STIMS, "dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0", 1869),
    mk(STIMS, "pickup_4d907890-87c7-4d71-8484-85d8936d18d4_0", 1870),
    mk(WASTE, "dropoff_7000cb2b-feea-41ab-84b2-d87e988283a3_0", 1871),
    mk(WASTE, "pickup_7000cb2b-feea-41ab-84b2-d87e988283a3_0", 1872),
    mk(CORUN, "pickup_5ddfa24e-a99a-4615-9174-d097b5ad5b7f_0", 1873),
    mk(CORUN, "dropoff_5ddfa24e-a99a-4615-9174-d097b5ad5b7f_0", 1874),
  ]);
  assert.equal(t.view().trackedMissionId, null, "markers alone say nothing about what is tracked");

  // Spawn-in: the bank state is replayed. Corundum is the tracked one; the other two are cleared.
  feed(t, [
    `<2026-08-17T00:17:29.569Z> [Notice] <CObjectiveMarkerComponent::RemoveFromPlayerDataBank> MissionObjectiveMarker_1869[1869] - Removed from DataBank of Player: IMC-SubliminaL[204772220757], missionId[${STIMS}], objectiveId[dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0] [Team_MissionFeatures][Missions]`,
    `<2026-08-17T00:17:29.569Z> [Notice] <CObjectiveMarkerComponent::RemoveFromPlayerDataBank> MissionObjectiveMarker_1871[1871] - Removed from DataBank of Player: IMC-SubliminaL[204772220757], missionId[${WASTE}], objectiveId[dropoff_7000cb2b-feea-41ab-84b2-d87e988283a3_0] [Team_MissionFeatures][Missions]`,
    `<2026-08-17T00:17:29.569Z> [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> MissionObjectiveMarker_1873[1873] - Added to DataBank of Player: IMC-SubliminaL[204772220757] - ZonePos: x: -771960.562500, y: -321347.218750, z: -359509.343750, missionId[${CORUN}], objectiveId[pickup_5ddfa24e-a99a-4615-9174-d097b5ad5b7f_0] [Team_MissionFeatures][Missions]`,
    `<2026-08-17T00:17:29.569Z> [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> MissionObjectiveMarker_1874[1874] - Added to DataBank of Player: IMC-SubliminaL[204772220757] - ZonePos: x: -748272.078090, y: -103662.326450, z: -263812.173494, missionId[${CORUN}], objectiveId[dropoff_5ddfa24e-a99a-4615-9174-d097b5ad5b7f_0] [Team_MissionFeatures][Missions]`,
  ]);
  assert.equal(t.view().trackedMissionId, CORUN, "the mission whose markers went into the bank");
  assert.equal(t.view().contracts.find((c) => c.missionId === CORUN)!.trackedNow, true);
  assert.equal(t.view().contracts.find((c) => c.missionId === STIMS)!.trackedNow, false);

  // 🔑 A swap, in the game's own order: the NEW mission's Add lands FIRST, before the old
  // mission's Removes. A scalar "Remove clears it" would blank the flag that was just set.
  feed(t, [
    `<2026-08-17T00:18:20.247Z> [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> MissionObjectiveMarker_1871[1871] - Added to DataBank of Player: IMC-SubliminaL[204772220757] - ZonePos: x: -771960.562500, y: -321347.218750, z: -359509.343750, missionId[${WASTE}], objectiveId[dropoff_7000cb2b-feea-41ab-84b2-d87e988283a3_0] [Team_MissionFeatures][Missions]`,
    `<2026-08-17T00:18:20.247Z> [Notice] <CObjectiveMarkerComponent::RemoveFromPlayerDataBank> MissionObjectiveMarker_1874[1874] - Removed from DataBank of Player: IMC-SubliminaL[204772220757], missionId[${CORUN}], objectiveId[dropoff_5ddfa24e-a99a-4615-9174-d097b5ad5b7f_0] [Team_MissionFeatures][Missions]`,
    `<2026-08-17T00:18:20.247Z> [Notice] <CObjectiveMarkerComponent::RemoveFromPlayerDataBank> MissionObjectiveMarker_1873[1873] - Removed from DataBank of Player: IMC-SubliminaL[204772220757], missionId[${CORUN}], objectiveId[pickup_5ddfa24e-a99a-4615-9174-d097b5ad5b7f_0] [Team_MissionFeatures][Missions]`,
    `<2026-08-17T00:18:20.247Z> [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> MissionObjectiveMarker_1872[1872] - Added to DataBank of Player: IMC-SubliminaL[204772220757] - ZonePos: x: -748272.078090, y: -103662.326450, z: -263812.173494, missionId[${WASTE}], objectiveId[pickup_7000cb2b-feea-41ab-84b2-d87e988283a3_0] [Team_MissionFeatures][Missions]`,
  ]);
  assert.equal(t.view().trackedMissionId, WASTE, "tracking is exclusive — the last Add wins");
  assert.equal(t.view().contracts.filter((c) => c.trackedNow).length, 1,
    "at most one contract can be tracked at a time");

  // ⚠️ A stray Remove for a mission that is NOT tracked — markers streaming out, seen for real in
  // the 2026-08-16 session. It must retire nothing but its own objective.
  feed(t, [
    `<2026-08-17T00:18:30.000Z> [Notice] <CObjectiveMarkerComponent::RemoveFromPlayerDataBank> MissionObjectiveMarker_1869[1869] - Removed from DataBank of Player: IMC-SubliminaL[204772220757], missionId[${STIMS}], objectiveId[dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0] [Team_MissionFeatures][Missions]`,
  ]);
  assert.equal(t.view().trackedMissionId, WASTE, "a stray Remove must not untrack the live one");

  // Untracking for real: the tracked mission's own objectives leave the bank with no Add behind.
  feed(t, [
    `<2026-08-17T00:18:40.000Z> [Notice] <CObjectiveMarkerComponent::RemoveFromPlayerDataBank> MissionObjectiveMarker_1871[1871] - Removed from DataBank of Player: IMC-SubliminaL[204772220757], missionId[${WASTE}], objectiveId[dropoff_7000cb2b-feea-41ab-84b2-d87e988283a3_0] [Team_MissionFeatures][Missions]`,
    `<2026-08-17T00:18:40.000Z> [Notice] <CObjectiveMarkerComponent::RemoveFromPlayerDataBank> MissionObjectiveMarker_1872[1872] - Removed from DataBank of Player: IMC-SubliminaL[204772220757], missionId[${WASTE}], objectiveId[pickup_7000cb2b-feea-41ab-84b2-d87e988283a3_0] [Team_MissionFeatures][Missions]`,
  ]);
  assert.equal(t.view().trackedMissionId, null, "untracking everything is a state the log can say");

  // 🔴 And the whole point: tracked, and STILL no tonnage. The game states the figure at objective
  // assignment and re-tracking does not replay it — eight track cycles in Sub's live log produced
  // zero Deliver lines. The two flags must be independently observable or the widget cannot tell
  // "go and track this" from "there is nothing left for you to do here".
  feed(t, [
    `<2026-08-17T00:18:50.000Z> [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> MissionObjectiveMarker_1869[1869] - Added to DataBank of Player: IMC-SubliminaL[204772220757] - ZonePos: x: -771960.562500, y: -321347.218750, z: -359509.343750, missionId[${STIMS}], objectiveId[dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0] [Team_MissionFeatures][Missions]`,
  ]);
  const stims = t.view().contracts.find((c) => c.missionId === STIMS)!;
  assert.equal(stims.trackedNow, true);
  assert.equal(stims.deliverSeen, false, "tracked is not the same fact as tonnage-known");
  assert.deepEqual(t.view().untracked, [STIMS, WASTE, CORUN],
    "every contract still lacks a stated tonnage, tracked or not");
}

// ⚠️ The data bank is NOT hauling-only. Across Sub's 481 backup logs it fires 177,853 times, and
// the volume is combat contracts whose markers stream in and out — one session logged 1,509 Adds
// for a single HeadHunters FPS contract, all carrying a BARE uuid objectiveId. A tracker that let
// those through would push an SSE frame and re-solve the plan per line, for a mission it never
// draws.
{
  const t = new HaulingTracker();
  feed(t, [
    `<2026-08-13T09:26:45.000Z> [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> MissionObjectiveMarker_204[204] - Added to DataBank of Player: IMC-SubliminaL[204772220757] - ZonePos: x: 1.0, y: 2.0, z: 3.0, missionId[4fe9ab33-ae6f-b345-aacf-82251adb1c4e], objectiveId[39fc3b41-bde1-ea62-6407-1eeef00723e1] [Team_MissionFeatures][Missions]`,
  ]);
  assert.equal(t.view().contracts.length, 0, "a combat mission never becomes a hauling contract");
  assert.equal(t.view().trackedMissionId, null, "and it never claims to be the tracked haul");
}

// 🔴 A MULTI-DROP CONTRACT LOSES ONE OBJECTIVE FROM THE BANK AND IS STILL TRACKED. This is the
// case that decides the whole design, and it is not rare: swept across all 481 backup logs, a
// Remove names the currently-tracked mission while leaving it partially in the bank **422 times**.
// The obvious scalar rule ("a Remove for the tracked mission untracks it") reports every one of
// those as an untrack, so the widget would flash "go and track this" at a contract the player is
// looking at — the same wrong prompt, one layer down. Real GoblinG shape: two drop-off legs of one
// contract, whose ids differ only in the leading hash and the final index.
{
  const t = new HaulingTracker();
  const MID = "6af30ddb-1a2f-4a55-9d0e-8f5b0e0a1c11";
  const D0 = "d_2920218645_a789f57a-e12b-4bcd-8132-e0c03d84fc89_-1_0";
  const D1 = "d_2360646142_a789f57a-e12b-4bcd-8132-e0c03d84fc89_-1_1";
  const mk = (obj: string, entity: number) =>
    `<2025-08-02T04:00:00.000Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [${MID}], generator name [GoblinG_Generator], contract [GoblinG_HaulCargo_L_Stanton2], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [${obj}], markerEntityId [${entity}], zoneHostId [1], position [x: 1.0, y: 2.0, z: 3.0] [Team_MissionFeatures][Missions]`;
  const bank = (verb: "Add" | "Remove", obj: string, entity: number) => verb === "Add"
    ? `<2025-08-02T04:03:00.000Z> [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> MissionObjectiveMarker_${entity}[${entity}] - Added to DataBank of Player: IMC-SubliminaL[204772220757] - ZonePos: x: 1.0, y: 2.0, z: 3.0, missionId[${MID}], objectiveId[${obj}] [Team_MissionFeatures][Missions]`
    : `<2025-08-02T04:03:32.215Z> [Notice] <CObjectiveMarkerComponent::RemoveFromPlayerDataBank> MissionObjectiveMarker_${entity}[${entity}] - Removed from DataBank of Player: IMC-SubliminaL[204772220757], missionId[${MID}], objectiveId[${obj}] [Team_MissionFeatures][Missions]`;
  feed(t, [mk(D0, 10), mk(D1, 11), bank("Add", D0, 10), bank("Add", D1, 11)]);
  assert.equal(t.view().trackedMissionId, MID);
  feed(t, [bank("Remove", D0, 10)]);
  assert.equal(t.view().trackedMissionId, MID,
    "one leg leaving the bank does not untrack a multi-drop contract");
  feed(t, [bank("Remove", D1, 11)]);
  assert.equal(t.view().trackedMissionId, null, "the last one out does");
}

// ── 🔴 A Deliver line for a leg the game gave no marker for ─────────────────────────────────
// Sub's live board, 2026-08-17. One contract, TWO drop-off legs to the same place, and a
// CreateMarker for only the first. The second leg's tonnage was being discarded, so the contract
// reported 51 SCU when it carries 101 — a number he was about to load a ship against.
{
  const t = new HaulingTracker();
  const MID = "388616e7-68ba-4bb6-b0ba-2206eaa00cb4";
  const OBJ = "7000cb2b-feea-41ab-84b2-d87e988283a3";
  feed(t, [
    `<2026-08-17T01:00:00.000Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [${MID}], generator name [Covalex_Hauling], contract [HaulCargo_AToB_Waste_Mixed_ScrapWaste_Stanton3_SupplyGrade], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [dropoff_${OBJ}_0], markerEntityId [1871], zoneHostId [758378849484], position [x: -771960.562500, y: -321347.218750, z: -359509.343750] [Team_MissionFeatures][Missions]`,
    `<2026-08-17T01:00:00.100Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/51 SCU of Waste to Baijini Point: " [4] to queue. New queue size: 5, MissionId: [${MID}], ObjectiveId: [dropoff_${OBJ}_0] [Team_CoreGameplayFeatures][Missions][Comms]`,
    `<2026-08-17T01:00:00.200Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/50 SCU of Scrap to Baijini Point: " [5] to queue. New queue size: 6, MissionId: [${MID}], ObjectiveId: [dropoff_${OBJ}_1] [Team_CoreGameplayFeatures][Missions][Comms]`,
  ]);
  const c = t.view().contracts[0];
  assert.equal(c.totalScu, 101, "both legs count — a missing marker must not cost a leg");
  const drops = c.stops.filter((s) => s.role === "dropoff");
  assert.equal(drops.length, 2);
  assert.deepEqual(drops.map((s) => [s.index, s.need, s.commodity]), [[0, 51, "Waste"], [1, 50, "Scrap"]]);
  assert.equal(drops[1].pos, null, "the marker-less leg has no position, and that is all it loses");
  assert.equal(drops[0].pos?.x, -771960.5625, "the leg that DID have a marker keeps its position");
}

// ── The board title: rank tier and size band, known at accept ───────────────────────────────
// 🔑 Both were previously declared absent from the data after checking the contract KEY's grade
// suffix. They live in the TITLE, and they do not track the suffix: on this very board
// `…_SmallGrade` is titled "Extra Small" while `…_SupplyGrade` is titled "Medium".
{
  const t = new HaulingTracker();
  const MID = "e21a3aa6-6149-41c4-ae72-8c265dfaf4ee";
  feed(t, [
    `<2026-08-17T00:17:27.014Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [${MID}], generator name [Covalex_Hauling], contract [HaulCargo_AToB_RefinedOre_Corundum_Stanton3_SmallGrade], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [pickup_5ddfa24e-a99a-4615-9174-d097b5ad5b7f_0], markerEntityId [1873], zoneHostId [758378849484], position [x: -771960.562500, y: -321347.218750, z: -359509.343750] [Team_MissionFeatures][Missions]`,
    `<2026-08-17T00:17:27.099Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Rookie Rank - Direct Extra Small Cargo Haul: " [3] to queue. New queue size: 4, MissionId: [${MID}], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`,
  ]);
  const c = t.view().contracts[0];
  assert.deepEqual(c.board, { rank: "Rookie", size: "Extra Small", direct: true });
  assert.equal(c.contractKey.endsWith("SmallGrade"), true,
    "the key says SmallGrade while the board says Extra Small — the suffix is not the band");
}

console.log("hauling tests passed");
