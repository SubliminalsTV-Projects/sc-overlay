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
  | { kind: "end"; ts: string | null; missionId: string; state: string }
  | { kind: "blueprintReceived"; ts: string | null; name: string; missionId: string | null };

const UUID = "[0-9a-fA-F-]{36}";

/** Strip the runtime instance suffix ("_0", "_12") so it matches the dataset debug_name. */
export function contractKeyOf(contract: string): string {
  return contract.replace(/_\d+$/, "");
}

const RE = {
  acceptTitle: /Added notification "Contract Accepted:\s*(.+?):\s*"/,
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
};

export function parseMissionEvent(e: LogEvent): MissionEvent | null {
  const tag = e.eventTag;
  const m = e.message;
  if (!tag) return null;

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
        if (mid) return { kind: "accept", ts: e.timestamp, missionId: mid[1], title: acc[1].trim() };
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

    default:
      return null;
  }
}
