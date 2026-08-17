/**
 * Domain extractor for mission + blueprint events, layered on top of the generic
 * `parseLine()` LogEvent. Feed it the watcher's "event" stream; it returns a typed
 * MissionEvent for the lines we care about, or null for everything else.
 *
 * Verified line shapes (4.8.2-LIVE.12061511, real session):
 *
 *  accept (friendly title + missionId):
 *   <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Jorrit Dossier:
 *     Updated Security Data: " [9] to queue. ... MissionId: [a4056f99-...], ObjectiveId: []
 *
 *  marker (the tracked objective's contract — THE pool key):
 *   <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker:
 *     missionId [df613f6d-...], generator name [HockrowAgency_FacilityDelve],
 *     contract [Hockrow_FacilityDelve_P2M2-Stanton4_Repeat_0],
 *     contractDefinitionId[f1f509b8-...], objectiveId [8a4e2b57-...], markerEntityId [82332], ...
 *
 *  active objective change (which objective is currently tracked):
 *   <CMissionLogEntry::UpdateActiveObjective> ...   (shape confirmed by missions-dump)
 *
 *  blueprint received:
 *   <SHUDEvent_OnNotification> Added notification "Received Blueprint: Geist Armor Arms
 *     Whiteout: " [148] to queue. ... MissionId: [...], ObjectiveId: []
 *
 *  end:
 *   <MissionEnded> Received MissionEnded push message for: mission_id df613f6d-... -
 *     mission_state MISSION_STATE_COMPLETED
 */
import type { LogEvent } from "./parser.js";

export type MissionEvent =
  | { kind: "accept"; ts: string | null; missionId: string; title: string | null }
  | {
      kind: "marker";
      ts: string | null;
      missionId: string;
      /** Raw contract name from the log, e.g. "Hockrow_..._Repeat_0". */
      contract: string;
      /** Contract with the runtime "_<n>" instance suffix stripped — the dataset key. */
      contractKey: string;
      generator: string;
      contractDefId: string;
      objectiveId: string;
      /** Entity id of the marker itself. Null only if CIG ever drops the field. */
      markerEntityId: string | null;
      /** World position of the objective. Measured across all 479 backup logs: every one of
       *  2,299 CreateMarker lines carries a full x/y/z, so this is effectively never null —
       *  it is the only distance signal the log gives for route planning. */
      pos: { x: number; y: number; z: number } | null;
    }
  | { kind: "activeObjective"; ts: string | null; missionId: string | null; objectiveId: string | null }
  /** The objective TEXT from a "New Objective" notification ("Go to Pyro 5a Abandoned
   *  Outpost"). Carries the place name, which is the only log-side signal that
   *  distinguishes same-title mission variants drawing from DIFFERENT reward pools. */
  | { kind: "newObjective"; ts: string | null; missionId: string | null; text: string }
  /** Navigation routing to a region-scoped encounter set: "Projected Start Location is
   *  Bloom for route to destination RegionB_1base_ab_pyro_final_set_encounter".
   *  `region` is the raw token ("B") that appears in the debug_name HH_Pyro_RegionB_…,
   *  which makes it a DIRECT variant discriminator — no name matching needed.
   *  ⚠️ Carries NO MissionId, so it can only be correlated against an active mission. */
  | { kind: "routeRegion"; ts: string | null; region: string; start: string | null }
  | { kind: "end"; ts: string | null; missionId: string; state: string }
  /** "Contract Complete: <title>" notification — carries the friendly title + the
   *  real missionId (unlike the MissionEnded push, which has no title). */
  | { kind: "contractComplete"; ts: string | null; missionId: string | null; title: string | null }
  /** "Awarded <N> aUEC" notification. Its OWN missionId is null (all-zeros) in the
   *  log, so callers correlate it to the completion that fired just before by time. */
  | { kind: "reward"; ts: string | null; amount: number }
  | { kind: "blueprintReceived"; ts: string | null; name: string; missionId: string | null }
  /**
   * A hauling contract's delivery objective, off the "New Objective: Deliver 0/N …" notification.
   *
   * 🔴 **This fires on objective ASSIGNMENT, not on track — and re-tracking never replays it.**
   * Earlier research called it "tracking-gated" and concluded the widget could ask the player to
   * track a contract to learn its tonnage. **That is wrong, and it is the bug this event's
   * doc comment exists to stop coming back.** Settled on Sub's live 2026-08-17 session: four
   * hauling contracts, ONE Deliver line (fired at spawn-in for the contract that was already
   * tracked), and then eight deliberate track/untrack cycles across all four contracts over three
   * minutes producing **zero** further Deliver lines. So the widget may say "track it and the
   * figure arrives at the next assignment" — it may NOT say "track it to see the tonnage now",
   * which is a prompt the game will not answer.
   *
   * The assignments that DO emit it: a fresh accept (within ~1 s of `Contract Accepted`), a
   * spawn-in re-emission (which carries live progress, hence `have`), and a drop-off changing
   * state. See `trackedMarker` for the signal that actually reports tracking.
   */
  | {
      kind: "haulObjective";
      ts: string | null;
      missionId: string | null;
      /** The `dropoff_<uuid>_<n>` token, identical to the CreateMarker objectiveId — which
       *  makes this an EXACT join, with no timestamp-proximity guessing. */
      objectiveId: string | null;
      /** Delivered so far. Always 0 in all 479 logs: the counter never ticks (see
       *  `objectiveState` for the only progress signal that does). */
      have: number;
      need: number;
      /** "scu" → `need` is SCU of `commodity`. "boxes" → `need` is a box count.
       *  "items" → `need` is a count of the named mission item (e.g. "TH-01 Propulsor"). */
      unit: "scu" | "boxes" | "items";
      /** Commodity ("Processed Food") or item name; null for the bare "Cargo Boxes" form. */
      commodity: string | null;
      destination: string;
    }
  /**
   * An objective marker entering or leaving the player's data bank — i.e. **the player TRACKED
   * or untracked a contract in mobiGlas.** This is the live tracking signal, and it was in the
   * log the whole time under a name that reads like marker plumbing:
   *
   *   <CObjectiveMarkerComponent::AddToPlayerDataBank> MissionObjectiveMarker_1873[1873]
   *     - Added to DataBank of Player: IMC-SubliminaL[204772220757]
   *     - ZonePos: x: -771960.562500, y: -321347.218750, z: -359509.343750,
   *       missionId[e21a3aa6-…], objectiveId[pickup_5ddfa24e-…_0]
   *   <CObjectiveMarkerComponent::RemoveFromPlayerDataBank> MissionObjectiveMarker_1869[1869]
   *     - Removed from DataBank of Player: …, missionId[1bc24142-…], objectiveId[dropoff_4d9…_0]
   *
   * 🔑 **Tracking is EXCLUSIVE and it fires on EVERY track**, unlike the Deliver line (see
   * `haulObjective`). Measured on Sub's live 2026-08-17 session: he cycled four hauling contracts
   * eight times over three minutes and every single track emitted a clean Remove/Add pair.
   *
   * 🔴 **But this event is NOT hauling-only, and for combat missions it is pure noise.** Across
   * Sub's 481 backup logs it fires **177,853** times; the volume is `HeadHunters_Mercenary_*` and
   * `CitizensForProsperity_*` markers streaming in and out, which re-add the SAME objective
   * hundreds of times a session (one log: 1,509 Adds for one FPS contract). Those carry a BARE
   * uuid objectiveId, not the `pickup_`/`dropoff_`/`d_` tokens hauling writes. So a consumer must
   * scope this to missions it already knows about — `HaulingTracker` does, by ignoring any
   * missionId that never produced a hauling `CreateMarker`.
   *
   * ⚠️ A Remove also fires for missions that are NOT tracked (markers streaming out): in one real
   * session `Remove 388616e7` arrived while `1bc24142` was the tracked contract. So a Remove may
   * only ever retire the objective it names — never assume it means "untracked".
   *
   * `pos` is byte-identical to the `CreateMarker` position for the same marker entity (26 of 26 on
   * the live log), and unlike CreateMarker this line carries NO `zoneHostId`, so it is strictly
   * the weaker of the two for distance. It is kept only as a backfill for a marker whose
   * CreateMarker fell outside the window we read.
   */
  | {
      kind: "trackedMarker";
      ts: string | null;
      missionId: string;
      objectiveId: string;
      /** From `MissionObjectiveMarker_<n>[<n>]` — the same id CreateMarker calls markerEntityId. */
      markerEntityId: string | null;
      /** True for AddToPlayerDataBank, false for RemoveFromPlayerDataBank. */
      added: boolean;
      /** Only on an Add; the Remove line states no position. */
      pos: { x: number; y: number; z: number } | null;
    }
  /** Server-pushed objective state ("… - objective_id <id> - state MISSION_OBJECTIVE_STATE_…").
   *  The ONLY per-destination progress signal in the log — the SCU counter itself never moves. */
  | {
      kind: "objectiveState";
      ts: string | null;
      missionId: string;
      objectiveId: string;
      /** The trailing word: "INPROGRESS" | "COMPLETED" | … */
      state: string;
      /** `created 1` — the objective appeared just now rather than merely changing. */
      created: boolean;
    }
  /** A hauling mission ITEM streamed in or out. Mission-item hauls (Hockrow delve, Battaglia,
   *  HeadHunters recover-cargo) enumerate every box class here, which is the only place the log
   *  ever states an exact manifest. ⚠️ Covalex/RedWind/GoblinG SCU hauls emit NOTHING here —
   *  verified across all 479 logs — so their manifests stay a prediction. */
  | {
      kind: "haulItem";
      ts: string | null;
      missionId: string;
      entityId: string;
      /** Entity class with the trailing `_<entityId>` stripped. Null on unregister, which
       *  names only the entity id — hence the entityId→class cache in HaulingTracker. */
      itemClass: string | null;
      pickupObjectiveId: string | null;
      dropoffObjectiveId: string | null;
      registered: boolean;
    }
  /** Control token for a vehicle, filtered to `Local client node` — i.e. OUR seat, not a
   *  passenger's or an NPC's. Gives the ship at MODEL level ("CRUS_Starlifter_C2"), which the
   *  existing skin system cannot: that one only ever learns the manufacturer. */
  | {
      kind: "vehicleControl";
      ts: string | null;
      /** The local player's entity id this session. Also appears as `PlayerId[…]` on EndMission. */
      nodeId: string;
      action: "request" | "grant" | "release";
      /** Raw tag, e.g. "CRUS_Starlifter_C2_766969713219". */
      vehicle: string;
      entityId: string;
      /** `vehicle` with the trailing `_<entityId>` removed: "CRUS_Starlifter_C2". */
      model: string;
    }
  /**
   * A freight-elevator platform moved — the only signal in the log that says whether cargo is
   * going ONTO the pad or coming OFF it.
   *
   * 🔴 THIS IS WHY "aboard" WAS A LIE. The game completes a pickup objective the instant it
   * releases the cargo to the elevator, not when it reaches the ship. Measured on Sub's own run,
   * 2026-08-17:
   *
   *   20:50:02  FillUnstowRequest      he presses the kiosk
   *   20:50:05  pickup → COMPLETED     the widget claimed "aboard" here
   *   20:50:16  RaisingPlatform        the boxes have not left the floor yet
   *
   * Eleven seconds before the platform even starts rising, and minutes before any of it is
   * tractored in. So `down` is OFFLOADING and `up` is LOADING.
   *
   * 🔑 It fires at OUTPOSTS too (`LoadingPlatformManager_FreightElevator_HT_Outpost`, and the bare
   * `LoadingPlatformManager` at exterior pads), which is what makes it usable where the "Hangar
   * Request Completed" notification never comes — Samson & Son's has no ATC at all.
   *
   * ⚠️ SHIP elevators are excluded. `LoadingPlatformManager_ShipElevator_*` is the hangar lift that
   * raises and lowers SHIPS; it cycles constantly as traffic comes and goes, including other
   * people's, and says nothing about cargo.
   */
  | {
      kind: "cargoPlatform";
      ts: string | null;
      /** "down" = cargo sent to storage (offloading) · "up" = cargo brought out (loading). */
      direction: "down" | "up";
      /** The manager's own tag, e.g. "LoadingPlatformManager_FreightElevator_HT_Outpost". */
      platform: string;
    }
  /** The player pressed a freight-elevator kiosk. Unambiguously OUR action, unlike a platform
   *  moving, which is why it is worth having separately: it brackets a real load. */
  | { kind: "cargoKiosk"; ts: string | null; terminal: string }
  /** Entered/re-entered the persistent universe (login / server change) — the
   *  previous shard's tracked-mission selection no longer applies. */
  | { kind: "sessionStart"; ts: string | null }
  /** Left the game — quit to menu, disconnect, or full client exit. Mission state
   *  is per-connection, so the overlay should stop showing the old shard's missions. */
  | { kind: "sessionEnd"; ts: string | null }
  /** A party member's map marker streamed in/out. This is the ONLY live party signal the log
   *  gives — it tells you HOW MANY people are in your party (and nearby), never who. */
  | { kind: "partyMarker"; ts: string | null; markerId: string; entityId: string; present: boolean }
  /** A party member's marker detaching names the player it belonged to. It's the one thing that
   *  ties a marker to a HANDLE — but it only fires when they despawn, so names arrive late (or
   *  not at all). Harvested purely to offer name suggestions for the manual party roster. */
  | { kind: "partyMemberName"; ts: string | null; markerId: string; name: string }
  /** Joined (or moved to) a PU shard. `shard` is the full matchmaking id
   *  ("pub_use1b_12326004_040"): env _ region/AZ _ cluster _ instance. Null = left the PU
   *  (the frontend runs on the sentinel "local_shard", which is not a place people meet).
   *  Drives the chat channels: region = segment 2, shard = the whole id. */
  | { kind: "shard"; ts: string | null; shard: string | null;
      /** "<ip>:<port>" of the DGS from the Join PU line — the finest-grained "who is
       *  actually near me" signal the log carries. Null on Update Shard Id (that line
       *  names no endpoint) and when leaving the PU. NEVER used raw as a channel key:
       *  see the hash in chat.ts. */
      dgs?: string | null };

const UUID = "[0-9a-fA-F-]{36}";

/** Strip the runtime instance suffix ("_0", "_12") so it matches the dataset debug_name. */
export function contractKeyOf(contract: string): string {
  return contract.replace(/_\d+$/, "");
}

/**
 * A stable identity for one leg of a mission, derived from an objectiveId.
 *
 * 🔑 The same leg is written THREE different ways depending on the source and the mission
 * family, so the raw id cannot be used as a join key:
 *
 *   CreateMarker (Covalex/RedWind)  dropoff_4d907890-…-85d8936d18d4_0
 *   CreateMarker (GoblinG)          d_2244305748_60f116f4-…-333747795124_-1_1
 *   ObjectiveUpserted (same GoblinG leg, later)
 *                                   d_2756183015_60f116f4-…-333747795124_0_1
 *
 * The leading hash and the second-to-last number BOTH change between the in-progress and the
 * completed push for the same objective (measured: mission 7f058d9b, 2025-08-04), so the only
 * durable parts are the uuid and the FINAL index. That pair is the key.
 *
 * ⚠️ The uuid is a contract-DEFINITION template id, not per-mission: `dropoff_246aa48e-…_0`
 * appears verbatim across dozens of unrelated missionIds and months apart. Always scope this
 * key by missionId — never treat it as globally unique.
 */
export function objectiveKeyOf(objectiveId: string): string {
  const uuid = objectiveId.match(new RegExp(UUID))?.[0];
  if (!uuid) return objectiveId;
  const tail = objectiveId.slice(objectiveId.indexOf(uuid) + uuid.length).match(/(\d+)$/);
  return tail ? `${uuid}#${tail[1]}` : uuid;
}

/** Which end of a leg an objectiveId names. GoblinG's `d_` prefix is a delivery, so anything
 *  that isn't explicitly a pickup and carries an index is treated as a drop-off; a bare uuid
 *  (every non-hauling mission family) is "other" and is not a hauling stop. */
export function objectiveRoleOf(objectiveId: string): "pickup" | "dropoff" | "other" {
  if (/^pickup_/.test(objectiveId)) return "pickup";
  if (/^(dropoff|d)_/.test(objectiveId)) return "dropoff";
  return "other";
}

/** "pub_use1b_12326004_040" → "use1b" (the region/AZ — what players call "the server").
 *  Null for the frontend sentinel or anything that doesn't look like a shard id. */
export function regionOfShard(shard: string | null): string | null {
  if (!shard || shard === "local_shard") return null;
  const seg = shard.split("_");
  return seg.length >= 3 ? seg[1] : null;
}

/**
 * Remove the decorations a language pack wraps around game text: engine markup tags
 * (`<EM4>…</EM4>`) and mission-board tags (`[300 Rep]`, `[BP]`, a trailing `*`).
 *
 * 🔑 This is the ONLY thing standing between us and a total data loss for pack users, so it
 * runs on the whole notification rather than just the captured payload. ExoAE and Remix2
 * redefine `crafting_hud_notification_received_blueprint` as `<EM4>Received Blueprint: %s
 * [BP]</EM4>`, which moves markup IN FRONT of the words we anchor on — the old
 * `"Received Blueprint:` literal could never match, so those users recorded ZERO unlocks
 * with nothing anywhere reporting a problem. Verified against all three packs, 2026-08-14.
 *
 * Vanilla 4.9.0 global.ini contains no `[BP]`/`[N Rep]` markup at all (measured: 0 lines),
 * so on a stock install every rule here is a no-op.
 */
function stripDecorations(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    // Match ANY bracket containing "Rep"/"BP" as a word, not a fixed list of prefixes. The
    // old form anchored on the literal "N Rep" — a PLACEHOLDER. The live game substitutes
    // the real number, so a Battaglia contract arrives as "Ship In Distress <EM4>[300 Rep]
    // [BP]*</EM4>" and "[300 Rep]" survived the strip. The leftover rode into the title key
    // ("SHIP IN DISTRESS 300 REP" vs the dataset's "SHIP IN DISTRESS"), missed the rep-title
    // index, and accrueFromTitle skips what it can't resolve — so the player ground Battaglia
    // contracts and watched their standing sit at zero (johnrgoudy, 0.1.36, 2026-08-03).
    // 🔑 That markup was never CIG's: it comes from the ExoAE/Remix2 packs, which is why a
    // second user's log had the same contract clean and it could not be reproduced by playing.
    // Verified against the dataset: 0 of 761 real mission titles are altered by this.
    .replace(/\[[^\]]*\b(?:Rep|BP)\b[^\]]*\]/gi, "")
    .replace(/\s*\*\s*/g, " ")
    .replace(/^[*•\s]+|[*•\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMissionTitle(title: string | null): string | null {
  if (!title) return null;
  return stripDecorations(title);
}

const RE = {
  // The notification's TEXT, taken as a whole so it can be cleaned before anything is matched
  // against it. 🔑 Anchored on the full `" [<n>] to queue.` terminator rather than the closing
  // quote, because titles legitimately contain quotes (`Terrorist Shigemori "Jester" Amsden`)
  // and a lazy `"([^"]*)"` truncates them mid-name.
  notification: /Added notification "([\s\S]*?)"\s*\[\d+\]\s*to queue\./,
  // The patterns below run against stripDecorations(notification), so they anchor at ^/$ —
  // "Contract Accepted:  <title>: " with the trailing ": " the engine appends for an empty body.
  acceptTitle: /^Contract Accepted:\s*(.+?):\s*$/,
  completeTitle: /^Contract Complete:\s*(.+?):\s*$/,
  // "New Objective: Go to Pyro 5a Abandoned Outpost: " — the objective TEXT, which is the
  // only thing in the log that names WHERE a mission sends you. Same MissionId as the
  // accept. This is what tells same-title variants apart (see narrowByPlace in missions.ts).
  newObjective: /^New Objective:\s*(.+?):\s*$/,
  // "…Projected Start Location is Bloom for route to destination RegionB_1base_ab_pyro…"
  // The destination's Region token is the variant letter itself. Start location is
  // captured too because it is the only log line that names where the player IS.
  routeRegion: /Projected Start Location is\s+(.+?)\s+for route to destination\s+Region([A-Za-z0-9]+)/,
  reward: /^Awarded\s+([\d,]+)\s+aUEC/,
  // "Deliver 0/20 SCU of Processed Food to Sunset Mesa" — matched against the DECORATION-STRIPPED
  // notification text, like everything else here. Three real payload forms share one shape, so
  // the middle is captured whole and classified afterwards (see haulUnit):
  //   "0/20 SCU of Processed Food"  ·  "0/9 Cargo Boxes"  ·  "0/10 TH-01 Propulsor"
  // 🔑 The count is required. The non-numeric "Deliver Black Box To Levski" form is a mission-ITEM
  // haul carrying no quantity at all; it stays a plain `newObjective` and gets its manifest from
  // OnItemRegistered instead. Note the capital "To" in that form — hence the [Tt] below, which
  // also has to be non-greedy so a destination like "a Salvage Yard on Wala" survives intact.
  deliverObjective: /^Deliver\s+(\d+)\s*\/\s*(\d+)\s+(.+?)\s+[Tt]o\s+(.+?)\s*:?\s*$/,
  // The notification's own ObjectiveId field. Not a UUID pattern: hauling writes
  // "dropoff_<uuid>_0" here, which is the exact token CreateMarker uses.
  objectiveIdField: /ObjectiveId:\s*\[([^\]]*)\]/,
  mkMarkerEntity: /markerEntityId\s*\[(\d+)\]/,
  mkPosition: /position\s*\[x:\s*([-\d.]+),\s*y:\s*([-\d.]+),\s*z:\s*([-\d.]+)\]/,
  // The data-bank lines name their marker in the message PREFIX rather than in a labelled field:
  // "MissionObjectiveMarker_1873[1873] - Added to DataBank of Player: …".
  bankMarkerEntity: /MissionObjectiveMarker_\d+\[(\d+)\]/,
  // Add only. Spelled "ZonePos:" with bare x/y/z and NO surrounding brackets, so it needs its own
  // pattern — `mkPosition` anchors on the bracketed `position [x: …]` form CreateMarker writes.
  bankPosition: /ZonePos:\s*x:\s*([-\d.]+),\s*y:\s*([-\d.]+),\s*z:\s*([-\d.]+)/,
  // "…for: mission_id <uuid> - objective_id <id> - state MISSION_OBJECTIVE_STATE_COMPLETED - created 0"
  upsert: new RegExp(`mission_id\\s+(${UUID})\\s*-\\s*objective_id\\s+(\\S+)\\s*-\\s*state\\s+MISSION_OBJECTIVE_STATE_(\\w+)(?:\\s*-\\s*created\\s+(\\d+))?`),
  // "Mission Item <class>_<entityId> (<entityId>) registered with mission id <uuid>, phase id
  //  <uuid>, pickup objective id , drop off objective id dropoff_<uuid>_0_0"
  // ⚠️ The pickup field is routinely EMPTY (a bare space before the comma), so it must be
  // matched as "anything but a comma", not as a token.
  itemRegistered: new RegExp(`Mission Item\\s+(\\S+)\\s+\\((\\d+)\\)\\s+registered with mission id\\s+(${UUID}),\\s*phase id\\s+\\S+,\\s*pickup objective id\\s*([^,]*),\\s*drop off objective id\\s*(\\S*)`),
  itemUnregistered: new RegExp(`Mission Item\\s+\\((\\d+)\\)\\s+unregistered with mission id\\s+(${UUID})`),
  // Three verbs across two engine call sites, one shape:
  //   CVehicleMovementBase::SetDriver   … requesting control token for 'X' [id]
  //   CVehicle::Initialize::<lambda_1>… … granted    control token for 'X' [id]
  //   CVehicleMovementBase::ClearDriver … releasing  control token for 'X' [id]
  // 🔑 "Local client node" is the filter that makes this OUR ship. Measured across 480 logs:
  // no log ever contains two distinct non-zero node ids, and the id matches the `PlayerId[…]`
  // the game prints on EndMission — so the phrase means what it says.
  vehicleToken: /Local client node\s*\[(\d+)\]\s*(requesting|granted|releasing)\s+control token for\s*'([^']+)'\s*\[(\d+)\]/,
  /* "[Loading Platform] Loading Platform Manager [<tag>] Platform state changed to <State>".
     The tag is bare at exterior pads (just "LoadingPlatformManager"), so the name class allows a
     plain word as well as the suffixed hangar/outpost forms. */
  platformState: /Loading Platform Manager \[([A-Za-z0-9_]+)\] Platform state changed to ([A-Za-z]+)/,
  /* "[FreightElevatorKioskUIProvider] <Terminal>[123] - Processed bindings into transfer request" */
  kioskTerminal: /\[FreightElevatorKioskUIProvider\]\s*([A-Za-z0-9_]+)\[/,
  blueprint: /^Received Blueprint:\s*(.+?):\s*$/,
  missionIdField: new RegExp(`MissionId:\\s*\\[(${UUID})\\]`),
  // CreateMarker fields (note: contractDefinitionId has NO space before its bracket)
  mkMissionId: new RegExp(`missionId\\s*\\[(${UUID})\\]`),
  mkGenerator: /generator name\s*\[([^\]]*)\]/,
  mkContract: /contract\s*\[([^\]]*)\]/,
  mkContractDef: new RegExp(`contractDefinitionId\\s*\\[(${UUID})\\]`),
  mkObjective: /objectiveId\s*\[([^\]]*)\]/,
  // MissionEnded push
  endMissionId: new RegExp(`mission_id\\s+(${UUID})`),
  endState: /mission_state\s+(\w+)/,
  // UpdateActiveObjective / EndMission generic id pulls
  anyMissionId: new RegExp(`[Mm]ission[_ ]?[Ii]d[:\\s]*\\[?(${UUID})\\]?`),
  anyObjectiveId: new RegExp(`[Oo]bjective[_ ]?[Ii]d[:\\s]*\\[?([0-9a-fA-F-]{8,})\\]?`),
  // Party markers: "Streamed in party marker id 4949777878066. TrackedEntityId: 201990706945"
  partyMarker: /party marker id\s+(\d+)\.\s*TrackedEntityId:\s*(\d+)/i,
  // The marker's detach line is the only place a party member's HANDLE appears:
  // "force detaching ENTITY ATTACHMENT id = <marker> name = "PartyMemberMarker_<marker>"
  //  to unblock removal of parent id = <entity> name = "<handle>""
  // 🔑 Anchor on "force detaching ENTITY ATTACHMENT". The same PartyMemberMarker_ id also shows up
  // in a "moving zone hosted child" line whose parent is a STREAMING ZONE, not the player — a
  // looser match harvests "StreamingSOC_hangar_lrgtop_001_orison" as a party member's name.
  partyMemberName: /force detaching ENTITY ATTACHMENT id\s*=\s*\d+\s*name\s*=\s*"PartyMemberMarker_(\d+)"[\s\S]*?parent id\s*=\s*\d+\s*name\s*=\s*"([^"]+)"/,
};

/** Classify the middle of a "Deliver 0/N <middle> to <dest>" objective.
 *  "SCU of Processed Food" → scu + commodity · "Cargo Boxes" → boxes · anything else → a named
 *  mission item ("TH-01 Propulsor"), counted in units rather than SCU. */
function haulUnit(middle: string): { unit: "scu" | "boxes" | "items"; commodity: string | null } {
  const scu = middle.match(/^SCU\s+of\s+(.+)$/i);
  if (scu) return { unit: "scu", commodity: scu[1].trim() };
  if (/^Cargo\s+Box(?:es)?$/i.test(middle)) return { unit: "boxes", commodity: null };
  return { unit: "items", commodity: middle };
}

export function parseMissionEvent(e: LogEvent): MissionEvent | null {
  const tag = e.eventTag;
  const m = e.message;

  // The party-marker detach line is a "[net][bind]CEntity::…" line with NO <EventTag>, so it has
  // to be matched on the message before the tag switch (which bails on an untagged line).
  const pn = m.match(RE.partyMemberName);
  if (pn) return { kind: "partyMemberName", ts: e.timestamp, markerId: pn[1], name: pn[2] };

  if (!tag) return null;

  // "<Calculate Route>" — navigation, not a mission event, but its destination names the
  // REGION of the encounter set being routed to, which is the cleanest variant
  // discriminator in the whole log. Matched before the tag switch because the tag has a
  // space in it and does not belong in the mission-notification cases below.
  if (tag === "Calculate Route") {
    const rr = m.match(RE.routeRegion);
    if (!rr) return null;
    return { kind: "routeRegion", ts: e.timestamp, region: rr[2], start: rr[1].trim() || null };
  }

  // "<CPartyMarkerComponent RWES>" (streamed in) / "<CPartyMarkerComponent UFES>" (streamed out).
  if (tag.startsWith("CPartyMarkerComponent")) {
    const pm = m.match(RE.partyMarker);
    if (!pm) return null;
    return { kind: "partyMarker", ts: e.timestamp, markerId: pm[1], entityId: pm[2], present: /streamed in/i.test(m) };
  }

  switch (tag) {
    case "SHUDEvent_OnNotification": {
      // Clean the whole notification ONCE, then match. A language pack can put its markup in
      // front of the words we anchor on, so cleaning has to happen before the first match and
      // not on the captured payload afterwards.
      const note = m.match(RE.notification);
      if (!note) return null;
      const text = stripDecorations(note[1]);

      const bp = text.match(RE.blueprint);
      if (bp) {
        const mid = m.match(RE.missionIdField);
        return { kind: "blueprintReceived", ts: e.timestamp, name: bp[1].trim(), missionId: mid?.[1] ?? null };
      }
      const acc = text.match(RE.acceptTitle);
      if (acc) {
        const mid = m.match(RE.missionIdField);
        const title = normalizeMissionTitle(acc[1]);
        if (mid) return { kind: "accept", ts: e.timestamp, missionId: mid[1], title };
      }
      const cc = text.match(RE.completeTitle);
      if (cc) {
        const mid = m.match(RE.missionIdField);
        const title = normalizeMissionTitle(cc[1]);
        return { kind: "contractComplete", ts: e.timestamp, missionId: mid?.[1] ?? null, title };
      }
      // Must come AFTER accept/complete: those notifications are distinct strings, but
      // keeping the order explicit means a future "New Objective Complete:"-style line
      // cannot start shadowing the accept branch.
      const no = text.match(RE.newObjective);
      if (no) {
        const mid = m.match(RE.missionIdField);
        // A hauling delivery is a New Objective with a count in it. Emitted as its own event so
        // the hauling tracker gets the parsed SCU/commodity/destination — but ONLY when the whole
        // shape matches, so anything unexpected still arrives as a plain newObjective rather than
        // being swallowed.
        const dl = no[1].trim().match(RE.deliverObjective);
        if (dl) {
          return {
            kind: "haulObjective",
            ts: e.timestamp,
            missionId: mid?.[1] ?? null,
            objectiveId: m.match(RE.objectiveIdField)?.[1] || null,
            have: parseInt(dl[1], 10),
            need: parseInt(dl[2], 10),
            ...haulUnit(dl[3].trim()),
            destination: dl[4].trim(),
          };
        }
        return { kind: "newObjective", ts: e.timestamp, missionId: mid?.[1] ?? null, text: no[1].trim() };
      }
      const rw = text.match(RE.reward);
      if (rw) {
        return { kind: "reward", ts: e.timestamp, amount: parseInt(rw[1].replace(/,/g, ""), 10) };
      }
      return null;
    }

    case "CLocalMissionPhaseMarker::CreateMarker": {
      const mid = m.match(RE.mkMissionId);
      const con = m.match(RE.mkContract);
      if (!mid || !con) return null;
      const p = m.match(RE.mkPosition);
      return {
        kind: "marker",
        ts: e.timestamp,
        missionId: mid[1],
        contract: con[1],
        contractKey: contractKeyOf(con[1]),
        generator: m.match(RE.mkGenerator)?.[1] ?? "",
        contractDefId: m.match(RE.mkContractDef)?.[1] ?? "",
        objectiveId: m.match(RE.mkObjective)?.[1] ?? "",
        markerEntityId: m.match(RE.mkMarkerEntity)?.[1] ?? null,
        pos: p ? { x: parseFloat(p[1]), y: parseFloat(p[2]), z: parseFloat(p[3]) } : null,
      };
    }

    // 🔑 The only reliable hauling accept signal is the marker above — it fires for EVERY
    // accepted contract. The tags below fill in what the player's own actions reveal.

    // 🔑 THE TRACKING SIGNAL. Both spellings share one shape; only the Add carries a ZonePos.
    // ⚠️ High volume on combat missions (177,853 lines across 481 backup logs) — see the
    // `trackedMarker` doc comment. Consumers must scope it to missions they already know.
    case "CObjectiveMarkerComponent::AddToPlayerDataBank":
    case "CObjectiveMarkerComponent::RemoveFromPlayerDataBank": {
      const mid = m.match(RE.mkMissionId);
      const oid = m.match(RE.mkObjective);
      if (!mid || !oid) return null;
      const added = tag.endsWith("AddToPlayerDataBank");
      const p = added ? m.match(RE.bankPosition) : null;
      return {
        kind: "trackedMarker",
        ts: e.timestamp,
        missionId: mid[1],
        objectiveId: oid[1],
        markerEntityId: m.match(RE.bankMarkerEntity)?.[1] ?? null,
        added,
        pos: p ? { x: parseFloat(p[1]), y: parseFloat(p[2]), z: parseFloat(p[3]) } : null,
      };
    }

    case "ObjectiveUpserted": {
      const u = m.match(RE.upsert);
      if (!u) return null;
      return {
        kind: "objectiveState",
        ts: e.timestamp,
        missionId: u[1],
        objectiveId: u[2],
        state: u[3],
        created: u[4] === "1",
      };
    }

    case "SMarkerHandler_Hauling::OnItemRegistered": {
      const r = m.match(RE.itemRegistered);
      if (!r) return null;
      const entityId = r[2];
      // The class name carries the entity id as a suffix ("…_ASD_Black_6419121662056"); strip it
      // so two boxes of the same kind compare equal.
      const itemClass = r[1].endsWith(`_${entityId}`) ? r[1].slice(0, -(entityId.length + 1)) : r[1];
      return {
        kind: "haulItem", ts: e.timestamp, missionId: r[3], entityId, itemClass,
        pickupObjectiveId: r[4].trim() || null,
        dropoffObjectiveId: r[5].trim() || null,
        registered: true,
      };
    }

    // Names only the entity id — the class has to come from the registration cache.
    case "SMarkerHandler_Hauling::OnItemUnregistered": {
      const r = m.match(RE.itemUnregistered);
      if (!r) return null;
      return {
        kind: "haulItem", ts: e.timestamp, missionId: r[2], entityId: r[1], itemClass: null,
        pickupObjectiveId: null, dropoffObjectiveId: null, registered: false,
      };
    }

    case "Vehicle Control Flow": {
      const v = m.match(RE.vehicleToken);
      if (!v) return null;
      // Node 0 is the engine's "nobody" sentinel and appears in logs alongside the real id.
      if (v[1] === "0") return null;
      const vehicle = v[3], entityId = v[4];
      return {
        kind: "vehicleControl", ts: e.timestamp, nodeId: v[1],
        action: v[2] === "requesting" ? "request" : v[2] === "granted" ? "grant" : "release",
        vehicle, entityId,
        model: vehicle.endsWith(`_${entityId}`) ? vehicle.slice(0, -(entityId.length + 1)) : vehicle,
      };
    }

    /* Cargo going onto or off the freight-elevator pad — see the `cargoPlatform` note for why this
       is the signal that "aboard" was missing, and for the measured timings. */
    case "CSCLoadingPlatformManager::OnLoadingPlatformStateChanged": {
      const p = m.match(RE.platformState);
      if (!p) return null;
      const platform = p[1];
      // ⚠️ Ship elevators are hangar traffic, not cargo. Excluded — see the event's note.
      if (/ShipElevator/i.test(platform)) return null;
      const state = p[2];
      const direction = state === "LoweringPlatform" ? "down" : state === "RaisingPlatform" ? "up" : null;
      // Gate states (Opening/Closing, and the two Idles) say the doors moved, not which way the
      // cargo went. Only the two travel states carry direction, so only they are reported.
      if (!direction) return null;
      return { kind: "cargoPlatform", ts: e.timestamp, direction, platform };
    }

    case "CEntityComponentFreightElevatorUIProvider::FillUnstowRequest": {
      const t = m.match(RE.kioskTerminal);
      return t ? { kind: "cargoKiosk", ts: e.timestamp, terminal: t[1] } : null;
    }

    case "CMissionLogEntry::UpdateActiveObjective": {
      return {
        kind: "activeObjective",
        ts: e.timestamp,
        missionId: m.match(RE.anyMissionId)?.[1] ?? null,
        objectiveId: m.match(RE.anyObjectiveId)?.[1] ?? null,
      };
    }

    case "MissionEnded": {
      const mid = m.match(RE.endMissionId);
      if (!mid) return null;
      return { kind: "end", ts: e.timestamp, missionId: mid[1], state: m.match(RE.endState)?.[1] ?? "" };
    }

    // Fires on ANY mission end incl. ABANDON (which emits no MissionEnded+state).
    // Format: "Ending mission for player. MissionId[<uuid>] Player[...]
    //          CompletionType[Abandon] Reason[Player left]".
    // CompletionType is normalized onto the MissionEnded state vocabulary so the
    // tracker can tell an abandon from a completion from this line alone.
    case "EndMission": {
      const mid = m.match(new RegExp(`MissionId\\[(${UUID})\\]`));
      if (!mid) return null;
      const ct = (m.match(/CompletionType\[(\w+)\]/)?.[1] ?? "").toUpperCase();
      const state = ct.startsWith("ABANDON") ? "ABANDONED" : ct.startsWith("COMPLETE") ? "COMPLETED" : ct || "ENDED";
      return { kind: "end", ts: e.timestamp, missionId: mid[1], state };
    }

    // Matchmaking placed us on a PU shard: "<Join PU> address[…] port[…]
    // shard[pub_use1b_12326004_040] locationId[…]". The one line that names the shard at join
    // time (verified live 4.9.0, 2026-08-08).
    case "Join PU": {
      const sh = m.match(/shard\[([\w-]+)\]/);
      if (!sh) return null;
      // address + port is the DGS — the Dynamic Game Server actually running your area, and the
      // only thing on this line that two players in the same place share. Measured across 480
      // shared logs: 5–15 distinct ports per shard id, matching Sub's "six to ten DGSs, CIG
      // changes it per patch". The other candidates do NOT work: `locationId` was byte-identical
      // across two of his joins on different shards (it is his spawn point), and `id[uuid]` on
      // the sibling line belongs to exactly one player each (a client session id).
      const ep = m.match(/address\[([0-9a-fA-F.:]+)\]\s*port\[(\d+)\]/);
      return {
        kind: "shard", ts: e.timestamp,
        shard: sh[1] === "local_shard" ? null : sh[1],
        dgs: ep && sh[1] !== "local_shard" ? `${ep[1]}:${ep[2]}` : null,
      };
    }

    // Belt-and-braces for a mid-session move: "<Update Shard Id> New Shard Id:
    // pub_use1b_12326004_040. Old Shard Id". Returning to the menu updates to "local_shard",
    // which reports as shard null (left the PU).
    case "Update Shard Id": {
      const sh = m.match(/New Shard Id:\s*([\w-]+)/);
      if (!sh) return null;
      return { kind: "shard", ts: e.timestamp, shard: sh[1] === "local_shard" ? null : sh[1] };
    }

    // Context (re)established. map="megamap" = the persistent universe (ignore Arena
    // Commander / other modes). Only the FRONTEND establish (gamerules="SC_Frontend" —
    // you're at the main menu, prior missions are stale) counts as a session reset. The
    // PU establish (gamerules="SC_Default") fires ~2s AFTER the game re-emits your
    // accepted contracts on spawn-in, so resetting there wipes the missions that just
    // loaded — which broke every login and Alt-F4 relaunch for marker-less missions.
    case "Context Establisher Done": {
      if (!/map="?megamap"?/i.test(m)) return null;
      return /gamerules="?SC_Frontend"?/i.test(m) ? { kind: "sessionStart", ts: e.timestamp } : null;
    }

    // Left the PU shard — quit to menu, disconnect, or full client quit
    // ("<Channel Destroyed> map="megamap" ..."). A mid-session server hop destroys
    // the channel too, but the rejoin's Context Establisher Done resets state anyway.
    case "Channel Destroyed": {
      return /map="?megamap"?/i.test(m) ? { kind: "sessionEnd", ts: e.timestamp } : null;
    }

    // Hard client exit ("<SystemQuit> CSystem::Quit invoked ..."). Belt-and-braces
    // for a quit where the channel-destroyed line doesn't make it into the log.
    case "SystemQuit":
      return { kind: "sessionEnd", ts: e.timestamp };

    default:
      return null;
  }
}
