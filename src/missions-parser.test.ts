import assert from "node:assert/strict";
import { parseMissionEvent, regionOfShard } from "./missions-parser.js";
import { parseLine, type LogEvent } from "./parser.js";

function event(message: string): LogEvent {
  return { eventTag: "SHUDEvent_OnNotification", timestamp: "2026-07-22T00:00:00.000Z", message } as LogEvent;
}

const acceptMessage = 'Added notification "Contract Accepted: <EM4>[N Rep] [BP]*</EM4>Jorrit Dossier: Updated Security Data: " [9] to queue. MissionId: [11111111-2222-3333-4444-555555555555]';
const completeMessage = 'Added notification "Contract Complete: <EM4>[BP]*</EM4>Rescue Run: Final Checkpoint: " [9] to queue. MissionId: [11111111-2222-3333-4444-555555555555]';

const accept = parseMissionEvent(event(acceptMessage));
assert(accept?.kind === "accept", "accept event should parse");
assert.equal(accept?.title, "Jorrit Dossier: Updated Security Data", "accept title should strip markup and badges");

const complete = parseMissionEvent(event(completeMessage));
assert(complete?.kind === "contractComplete", "complete event should parse");
assert.equal(complete?.title, "Rescue Run: Final Checkpoint", "complete title should strip markup and badges");

// A REAL line from a user's shared log (johnrgoudy, 0.1.36, 2026-08-03), copied verbatim.
// The fixtures above use "[N Rep]" — the PLACEHOLDER form — and the old stripper anchored on
// that literal, so the live game's substituted number survived: the title keyed as
// "SHIP IN DISTRESS 300 REP" instead of "SHIP IN DISTRESS", missed the rep-title index, and
// accrueFromTitle silently skipped it. He ground Battaglia contracts with his standing pinned
// at zero. Note the DOUBLE SPACE after the colon and the title-before-markup order — both
// differ from the fixtures above, which is why this is kept verbatim rather than tidied.
const realBattagliaAccept = 'Added notification "Contract Accepted:  Ship In Distress <EM4>[300 Rep] [BP]*</EM4>: " [4] to queue. New queue size: 1, MissionId: [a6d6b4e1-07cb-4076-9a82-0bcd1b8b373e], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';
const realAccept = parseMissionEvent(event(realBattagliaAccept));
assert(realAccept?.kind === "accept", "real Battaglia accept should parse");
assert.equal(realAccept?.title, "Ship In Distress",
  "a numeric rep badge must be stripped — it is what kept Battaglia standing at zero");

// The badge is a bracket containing Rep/BP as a word, whatever precedes it. Pinning the shapes
// rather than one sample, since the game has already changed this text once.
for (const badge of ["[300 Rep]", "[Rep]", "[N Rep]", "[1,200 Rep]", "[BP]", "[BP]*"]) {
  const line = `Added notification "Contract Accepted: Ship In Distress <EM4>${badge}</EM4>: " [4] to queue. MissionId: [11111111-2222-3333-4444-555555555555]`;
  const ev = parseMissionEvent(event(line));
  assert(ev?.kind === "accept", `badge ${badge} should still parse as an accept`);
  assert.equal(ev.title, "Ship In Distress", `badge ${badge} should be stripped`);
}

// ── Language packs rewrite the notification WRAPPER, not just the payload ───
// Measured 2026-08-14 against the real global.ini of all three packs, diffed against the
// vanilla 4.9.0 file extracted from Data.p4k. ExoAE and Remix2 redefine
//   crafting_hud_notification_received_blueprint = <EM4>Received Blueprint: %s [BP]</EM4>
// which puts markup IN FRONT of the words the old regex anchored on ('"Received Blueprint:'),
// so it could never match and those users recorded ZERO blueprints — no error, no warning,
// just an empty collection. This is the assertion that would have caught it.
//
// The engine renders "<localized string>: <body>" with an empty body, hence the trailing ": ".
const bpFormats: [string, string][] = [
  ["vanilla", "Received Blueprint: %s"],
  ["ExoAE", "<EM4>Received Blueprint: %s [BP]</EM4>"],
  ["Remix2", "<EM4>Received Blueprint: %s [BP]</EM4>"],
  ["Remix", "Received Blueprint: %s"],
];
for (const [pack, fmt] of bpFormats) {
  const line = `Added notification "${fmt.replace("%s", "Monde Arms")}: " [75] to queue. New queue size: 2, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: []`;
  const ev = parseMissionEvent(event(line));
  assert(ev?.kind === "blueprintReceived", `${pack}: a blueprint receipt must parse`);
  assert.equal(ev.name, "Monde Arms", `${pack}: the pack's decorations must not ride into the name`);
}

// Titles legitimately contain quotes, so the notification cannot be captured with "([^"]*)".
// Anchoring on the full `" [n] to queue.` terminator is what makes this safe — verified against
// 18,006 real notification lines, where every one of the 3,389 mission-relevant ones carries it.
const quoted = parseMissionEvent(event(
  'Added notification "Contract Accepted:  Terrorist Shigemori "Jester" Amsden to be Neutralized: " [4] to queue. MissionId: [11111111-2222-3333-4444-555555555555]'));
assert(quoted?.kind === "accept", "a title containing quotes must still parse");
assert.equal(quoted.title, 'Terrorist Shigemori "Jester" Amsden to be Neutralized',
  "inner quotes belong to the title and must survive intact");

// A pack decorating the OTHER notifications must not break them either.
const packObjective = parseMissionEvent(event(
  'Added notification "<EM4>New Objective: Go to Pyro 5a Abandoned Outpost [BP]</EM4>: " [7] to queue. MissionId: [11111111-2222-3333-4444-555555555555]'));
assert(packObjective?.kind === "newObjective", "a decorated objective must parse");
assert.equal(packObjective.text, "Go to Pyro 5a Abandoned Outpost",
  "the objective place name drives variant narrowing — decorations must not reach it");

// ── Shard events (drive the chat channels) ──────────────────────────────────
// Both lines are VERBATIM from Sub's live 4.9.0 Game.log (2026-08-08), through the real
// parseLine so the tag extraction is covered too.
const joinPu = parseMissionEvent(parseLine(
  "<2026-08-08T19:17:56.273Z> [Notice] <Join PU> address[136.70.101.224] port[64298] shard[pub_use1b_12326004_040] locationId[844429225164801] [Team_GameServices][GIM][Matchmaking]"));
assert(joinPu?.kind === "shard", "Join PU should parse as a shard event");
assert.equal(joinPu.shard, "pub_use1b_12326004_040", "Join PU should carry the full shard id");

const updateShard = parseMissionEvent(parseLine(
  "<2026-08-08T19:17:56.598Z> [Notice] <Update Shard Id> New Shard Id: pub_use1b_12326004_040. Old Shard Id [Team_OnlineTech][Telemetry][Services]"));
assert(updateShard?.kind === "shard", "Update Shard Id should parse as a shard event");
assert.equal(updateShard.shard, "pub_use1b_12326004_040", "trailing period must not ride into the id");

// The frontend runs on the sentinel "local_shard" — that is LEAVING the PU, not a place.
const toMenu = parseMissionEvent(parseLine(
  "<2026-08-08T19:15:43.229Z> [Notice] <Update Shard Id> New Shard Id: local_shard. Old Shard Id [Team_OnlineTech][Telemetry][Services]"));
assert(toMenu?.kind === "shard" && toMenu.shard === null, "local_shard must report as shard null");

// Region derivation: segment 2 of the id is the region/AZ ("the server" in player speak).
assert.equal(regionOfShard("pub_use1b_12326004_040"), "use1b");
assert.equal(regionOfShard("pub_usw2a_12326004_007"), "usw2a");
assert.equal(regionOfShard("local_shard"), null);
assert.equal(regionOfShard(null), null);

// ---- Journal Entry Added: the dynamic-event progress signal (4.10 / Siege of Orison) ----
// All four lines below are VERBATIM from Sub's own 4.10 PTU logs
// (`Game Build(12473311) 19 Aug 26 (15 56 29).log`, changelist 12473311). They are kept exactly
// as the engine wrote them — double spaces, trailing ": ", all-zeros MissionId and all — because
// every previous fixture in this file that was "tidied" hid a real bug.
const realOrisonComplete = 'Added notification "Contract Complete: Orison Relief: Medium Supply Haul: " [42] to queue. New queue size: 1, MissionId: [c48baebd-b6da-4537-86f1-1355c5e2d488], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';
const realOrisonJournal = 'Added notification "Journal Entry Added: Orison Relief: " [43] to queue. New queue size: 2, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';
const realJurisdictionJournal = 'Added notification "Journal Entry Added: Jurisdiction: Hurston Dynamics : " [9] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';

// 🔑 The event's contract title CONTAINS A COLON. The complete-title regex is lazy, so this is
// exactly the shape that could truncate to "Orison Relief" and silently key every event contract
// to one bogus title.
const orisonComplete = parseMissionEvent(event(realOrisonComplete));
assert(orisonComplete?.kind === "contractComplete", "the real Orison completion must parse");
assert.equal(orisonComplete?.title, "Orison Relief: Medium Supply Haul",
  "an event contract title keeps its internal colon — truncating it would merge all 13 ORS_ contracts");
assert.equal(orisonComplete?.missionId, "c48baebd-b6da-4537-86f1-1355c5e2d488");

const orisonJournal = parseMissionEvent(event(realOrisonJournal));
assert(orisonJournal?.kind === "journalEntry", "the event journal entry must parse");
assert.equal(orisonJournal?.subject, "Orison Relief", "the subject is the EVENT name, trimmed");
assert.equal(orisonJournal?.jurisdiction, false, "an event entry is not a jurisdiction entry");
// The all-zeros id is preserved rather than nulled: callers correlate by TIME, and recording what
// the log actually said is what lets a future reader tell "absent" from "zeroed".
assert.equal(orisonJournal?.missionId, "00000000-0000-0000-0000-000000000000");

// The noise form. It must still PARSE (so it can never be mistaken for an unknown line) while
// being flagged, because it does not follow a completion and is not event progress.
const jurisdictionJournal = parseMissionEvent(event(realJurisdictionJournal));
assert(jurisdictionJournal?.kind === "journalEntry", "a jurisdiction journal entry still parses");
assert.equal(jurisdictionJournal?.jurisdiction, true,
  "entering a jurisdiction must be flagged, or it reads as event progress and inflates the estimate");
assert.equal(jurisdictionJournal?.subject, "Jurisdiction: Hurston Dynamics",
  "the subject keeps its prefix — the flag classifies it, the string is not rewritten");

// 🔑 NON-EMPTY GUARD. The two assertions above are both about a parsed object; if the branch
// silently stopped matching, `subject` comparisons would fail — but a future refactor that made
// journalEntry unreachable would fail with a confusing "kind" error instead. State the positive.
assert(orisonJournal.subject.length > 0 && jurisdictionJournal.subject.length > 0,
  "both journal subjects must be non-empty — an empty subject matches every event name");

// ---------------------------------------------------------------------------------------------
// 🔴 `FillUnstowRequest` WRITES TWO DIFFERENT THINGS, AND WE READ BOTH AS A KIOSK PRESS.
//
// All four lines below are VERBATIM from Sub's own logs. The `SoftLock_Terminal_…` one is included
// because it LOOKS like the failure form and is not — it is a real kiosk class, so a fix that
// merely rejected odd-looking names would break 4 genuine presses to fix 41 fake ones.
//
// Counts behind this, measured over the 480-file corpus: 241 real presses, 41 `EntityId … is not
// present` errors, 4 `SoftLock_Terminal_…` presses. In the 2026-08-22 session 37 of 37 were the
// error form, so every `cargoKiosk` that session was fabricated.
const realKioskPress = '<2025-08-01T22:21:09.632Z> [Notice] <CEntityComponentFreightElevatorUIProvider::FillUnstowRequest> [FreightElevatorKioskUIProvider] FreightElevatorKiosk_FreightElevator_Util_HangarLarge[5260145885719] - Processed bindings into transfer request - Entities: 6, Location: 1752411604 - RequestId: 2, ItemBank: 0 [Team_CGP7][Cargo][Inventory]';
const realSoftLockPress = '<2026-08-17T18:51:41.305Z> [Notice] <CEntityComponentFreightElevatorUIProvider::FillUnstowRequest> [FreightElevatorKioskUIProvider] SoftLock_Terminal_Standard_LowTech_FreightElevatorKiosk_1_a[758375613929] - Processed bindings into transfer request - Entities: 0, Location: 1180994372 - RequestId: 5, ItemBank: 0 [Team_CoreGameplayFeatures][Cargo][Inventory]';
const realUnstowMissing = '<2026-08-22T22:01:42.574Z> [Error] <CEntityComponentFreightElevatorUIProvider::FillUnstowRequest> [FreightElevatorKioskUIProvider] EntityId[608068483514] is not present. [Team_CoreGameplayFeatures][Cargo][Inventory]';

const kioskPress = parseMissionEvent(parseLine(realKioskPress));
assert(kioskPress?.kind === "cargoKiosk", "a real kiosk press must still parse as cargoKiosk");
assert.equal(kioskPress.terminal, "FreightElevatorKiosk_FreightElevator_Util_HangarLarge",
  "the terminal is the kiosk's own name");

const softLockPress = parseMissionEvent(parseLine(realSoftLockPress));
assert(softLockPress?.kind === "cargoKiosk", "SoftLock_Terminal_… is a REAL kiosk class, not a failure");
assert.equal(softLockPress.terminal, "SoftLock_Terminal_Standard_LowTech_FreightElevatorKiosk_1_a");

const unstowMissing = parseMissionEvent(parseLine(realUnstowMissing));
// 🔑 Two assertions, and the FIRST is the one that catches the shipped bug: the old regex made
// this a cargoKiosk with terminal "EntityId". Asserting only "it is cargoUnstowMissing" would also
// pass on a build that returned null for it, which is a different and less useful outcome.
assert(unstowMissing?.kind !== "cargoKiosk",
  'the error form must NOT be a kiosk press — it used to parse as terminal "EntityId"');
assert(unstowMissing?.kind === "cargoUnstowMissing",
  "the error form has its own kind, so it is diagnosable rather than merely discarded");
assert.equal(unstowMissing.entityId, "608068483514", "the phantom entity id is carried verbatim");

console.log("missions-parser tests passed");
