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

/** "pub_use1b_12326004_040" → "use1b" (the region/AZ — what players call "the server").
 *  Null for the frontend sentinel or anything that doesn't look like a shard id. */
export function regionOfShard(shard: string | null): string | null {
  if (!shard || shard === "local_shard") return null;
  const seg = shard.split("_");
  return seg.length >= 3 ? seg[1] : null;
}

function normalizeMissionTitle(title: string | null): string | null {
  if (!title) return null;
  return title
    .replace(/<[^>]+>/g, "")
    // Mission-board tags. 🔑 Match ANY bracket containing "Rep"/"BP" as a word, not a fixed list
    // of prefixes. The old form was `[(?:BP|N Rep|Rep|BP\*)…]`, which anchored on the literal
    // "N Rep" — a PLACEHOLDER. The live game substitutes the real number, so a Battaglia contract
    // arrives as "Ship In Distress <EM4>[300 Rep] [BP]*</EM4>" and "[300 Rep]" survived the strip.
    // The leftover rode into the title key ("SHIP IN DISTRESS 300 REP" vs the dataset's "SHIP IN
    // DISTRESS"), missed the rep-title index, and accrueFromTitle skips what it can't resolve —
    // so the player ground Battaglia contracts and watched their standing sit at zero, with
    // nothing anywhere reporting a problem (johnrgoudy, 0.1.36, 2026-08-03).
    // 🔑 Not every player sees these tags: a second user's log has the SAME contract with no
    // markup at all, so this cannot be reproduced by playing the mission — only from a log.
    // Verified against the dataset: 0 of 761 real mission titles are altered by this.
    .replace(/\[[^\]]*\b(?:Rep|BP)\b[^\]]*\]/gi, "")
    .replace(/\s*\*\s*/g, " ")
    .replace(/^[*•\s]+|[*•\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const RE = {
  acceptTitle: /Added notification "Contract Accepted:\s*(.+?):\s*"/,
  completeTitle: /Added notification "Contract Complete:\s*(.+?):\s*"/,
  // "New Objective: Go to Pyro 5a Abandoned Outpost: " — the objective TEXT, which is the
  // only thing in the log that names WHERE a mission sends you. Same MissionId as the
  // accept. This is what tells same-title variants apart (see narrowByPlace in missions.ts).
  newObjective: /Added notification "New Objective:\s*(.+?):\s*"/,
  // "…Projected Start Location is Bloom for route to destination RegionB_1base_ab_pyro…"
  // The destination's Region token is the variant letter itself. Start location is
  // captured too because it is the only log line that names where the player IS.
  routeRegion: /Projected Start Location is\s+(.+?)\s+for route to destination\s+Region([A-Za-z0-9]+)/,
  reward: /Added notification "Awarded\s+([\d,]+)\s+aUEC/,
  blueprint: /Added notification "Received Blueprint:\s*(.+?):\s*"/,
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
      const bp = m.match(RE.blueprint);
      if (bp) {
        const mid = m.match(RE.missionIdField);
        return { kind: "blueprintReceived", ts: e.timestamp, name: bp[1].trim(), missionId: mid?.[1] ?? null };
      }
      const acc = m.match(RE.acceptTitle);
      if (acc) {
        const mid = m.match(RE.missionIdField);
        const title = normalizeMissionTitle(acc[1]);
        if (mid) return { kind: "accept", ts: e.timestamp, missionId: mid[1], title };
      }
      const cc = m.match(RE.completeTitle);
      if (cc) {
        const mid = m.match(RE.missionIdField);
        const title = normalizeMissionTitle(cc[1]);
        return { kind: "contractComplete", ts: e.timestamp, missionId: mid?.[1] ?? null, title };
      }
      // Must come AFTER accept/complete: those notifications are distinct strings, but
      // keeping the order explicit means a future "New Objective Complete:"-style line
      // cannot start shadowing the accept branch.
      const no = m.match(RE.newObjective);
      if (no) {
        const mid = m.match(RE.missionIdField);
        return { kind: "newObjective", ts: e.timestamp, missionId: mid?.[1] ?? null, text: no[1].trim() };
      }
      const rw = m.match(RE.reward);
      if (rw) {
        return { kind: "reward", ts: e.timestamp, amount: parseInt(rw[1].replace(/,/g, ""), 10) };
      }
      return null;
    }

    case "CLocalMissionPhaseMarker::CreateMarker": {
      const mid = m.match(RE.mkMissionId);
      const con = m.match(RE.mkContract);
      if (!mid || !con) return null;
      return {
        kind: "marker",
        ts: e.timestamp,
        missionId: mid[1],
        contract: con[1],
        contractKey: contractKeyOf(con[1]),
        generator: m.match(RE.mkGenerator)?.[1] ?? "",
        contractDefId: m.match(RE.mkContractDef)?.[1] ?? "",
        objectiveId: m.match(RE.mkObjective)?.[1] ?? "",
      };
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
