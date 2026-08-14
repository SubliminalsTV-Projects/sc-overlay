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

console.log("missions-parser tests passed");
