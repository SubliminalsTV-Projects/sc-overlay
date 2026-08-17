/**
 * Live state for hauling contracts, built from the mission event stream.
 *
 * ── What the log actually gives us ─────────────────────────────────────────────────────────
 *
 * `CLocalMissionPhaseMarker::CreateMarker` is the ONLY reliable accept signal for hauling. It
 * fires once per objective — a pickup marker and a drop-off marker per leg — and every line
 * carries the contract key, the generator and an XYZ position. Measured across 479 backup logs:
 * 2,299 of 2,299 CreateMarker lines parse completely. Everything else here is optional detail
 * layered on top of it.
 *
 * 🔴 TWO DIFFERENT THINGS USED TO SHARE THE WORD "TRACKED", AND CONFLATING THEM SHIPPED A PROMPT
 * THAT COULD NOT COME TRUE. They are now two fields, and the distinction is the point of this file:
 *
 *   `deliverSeen`  the game has told us the tonnage — the "New Objective: Deliver 0/N SCU of <C>
 *                  to <D>" line arrived. It fires on objective ASSIGNMENT: a fresh accept, a
 *                  spawn-in re-emission, or a drop-off changing state.
 *   `trackedNow`   the contract is the one currently selected in mobiGlas, read live from
 *                  `CObjectiveMarkerComponent::Add/RemoveFromPlayerDataBank`.
 *
 * 🔑 **Re-tracking does NOT replay the Deliver line.** Earlier research called that line
 * "tracking-gated" and the widget therefore told the player to track a contract to learn its
 * tonnage. Sub did exactly that, four contracts, and nothing happened — because the game had
 * already assigned those objectives and will not restate them. Settled on his live 2026-08-17
 * log: eight track/untrack cycles across four contracts in three minutes, **zero** Deliver lines,
 * while every one of those tracks emitted a clean data-bank Remove/Add pair.
 *
 * So the widget may say "track it and the figure lands at the next assignment", and it must NOT
 * say "track it to see the tonnage" to a contract that is already tracked. `trackedNow` is what
 * makes that distinction possible; before it existed the app could not tell the two states apart
 * and said the actionable thing to everybody.
 *
 * ── What it does NOT give us ───────────────────────────────────────────────────────────────
 *
 * • Live progress is per-DESTINATION, not per-box: `ObjectiveUpserted …
 *   MISSION_OBJECTIVE_STATE_COMPLETED` fires when a whole drop-off is satisfied, and nothing
 *   fires per box in between.
 *   ⚠️ Earlier research said "the delivery counter NEVER ticks" because all 480 of Sub's logs
 *   showed `0/N`. **That is wrong** — it was an artifact of him always tracking a contract at
 *   accept, when the progress really is zero. A shared log from another player carries
 *   `Deliver 3/5 SCU …`, emitted 5ms after its CreateMarker on a spawn-in re-emission. The
 *   numerator is real; see `HaulStop.delivered`. It is only ever observed at a (re)track, so it
 *   is a checkpoint, not a live feed.
 * • Box breakdowns for SCU hauls are not logged at all. `SMarkerHandler_Hauling::OnItemRegistered`
 *   enumerates every box, but only for mission-ITEM hauls (Hockrow delve, Battaglia, HeadHunters
 *   recover-cargo). Covalex, RedWind and GoblinG emit nothing — verified across the whole corpus.
 *   Those manifests are the solver's problem to predict; this module only reports what it knows.
 *
 * ⛔ Partial turn-in is deliberately NOT modelled. Sub's ruling: a box turned in short is gone and
 * unrecoverable, so what was actually delivered doesn't change any decision the widget makes. If
 * it ever matters, a manual "N SCU lost" input is the cheap answer.
 */
import { EventEmitter } from "node:events";
import { objectiveKeyOf, objectiveRoleOf, type MissionEvent } from "./missions-parser.js";
import { parseBoardTitle, type BoardTitle } from "./hauling-advisor.js";

/** Generators whose contracts are cargo hauls. Matched case-insensitively as a SUBSTRING of the
 *  generator name or the contract key, because CIG names them inconsistently: the org is in the
 *  generator for Covalex/RedWind ("Covalex_Hauling") but only in the contract for GoblinG
 *  ("GoblinG_Generator" / "GoblinG_HaulCargo_L_Stanton2"). Counts across the 479-log corpus:
 *  GoblinG 322, Covalex 41, RedWind 2. */
const HAUL_MARKERS = ["haul", "cargo"];

/** How long an ended contract stays in the view, so the widget can show the run that just
 *  finished (and its payout, which lands ~40–140ms AFTER the mission ends). */
const KEEP_ENDED_MS = 10 * 60_000;
/** Widest gap allowed between an `EndMission Complete` and its "Awarded N aUEC" notification.
 *  Measured across every completed hauling contract in the corpus: +39ms to +138ms. The window
 *  is deliberately far wider than that, and both directions, because dev-replay emits the award
 *  BEFORE the completion and a real payout should never be dropped over a few hundred ms. */
const PAYOUT_WINDOW_MS = 3_000;

export type HaulStopRole = "pickup" | "dropoff" | "other";
export type HaulStopState = "pending" | "inprogress" | "completed" | "failed";

export interface HaulStop {
  /** `objectiveKeyOf()` of the raw id — stable across the three spellings the game uses for
   *  the same leg. Unique within a mission, NOT globally. */
  key: string;
  /** The id exactly as CreateMarker wrote it. */
  objectiveId: string;
  role: HaulStopRole;
  /** Leg index within the contract, from the objective id's trailing number. */
  index: number;
  pos: { x: number; y: number; z: number } | null;
  markerEntityId: string | null;
  /** Everything below is only known once the player TRACKS the contract. */
  destination: string | null;
  commodity: string | null;
  /** SCU when `unit === "scu"`, otherwise a box or item count. */
  need: number | null;
  /**
   * How much of `need` the game says is already delivered.
   *
   * 🔑 Earlier research concluded "the delivery counter NEVER ticks" — every `N/M` in Sub's 480
   * logs had N=0. That was an artifact of Sub always tracking a contract at accept, when the
   * progress genuinely IS zero. A shared log from punk_hiji (2026-08-05) carries
   * `Deliver 3/5 SCU of Recycled Material Composite to Levski` emitted 5ms after its CreateMarker
   * — a spawn-in re-emission of an already-part-delivered contract. So the number is real, and
   * throwing it away loses the one signal that says how much is still in the hold.
   *
   * ⛔ This is NOT partial-turn-in modelling, which Sub ruled out: that is about a contract handed
   * in short at the END. This is in-flight progress on an open contract.
   */
  delivered: number | null;
  unit: "scu" | "boxes" | "items" | null;
  state: HaulStopState;
  completedAt: number | null;
}

export interface HaulItem {
  entityId: string;
  itemClass: string;
  /** SCU parsed out of the class name ("Carryable_TBO_FL_8SCU_Commodity_Metal_Aluminum" → 8),
   *  or null for a class that doesn't state one (most FPS mission items). */
  scu: number | null;
  /** Normalized key of the drop-off this box belongs to, so a manifest can be shown per stop. */
  dropoffKey: string | null;
  /** False once the entity streams out. Kept rather than deleted: a box that unregisters on a
   *  server hop and re-registers seconds later is the same box, and the churn is not progress. */
  present: boolean;
}

export interface HaulContract {
  missionId: string;
  contract: string;
  contractKey: string;
  generator: string;
  contractDefId: string;
  title: string | null;
  /**
   * The contract's title decomposed the way the player reads it off the board —
   * "Rookie Rank - Direct Extra Small Cargo Haul" → rank `Rookie`, size `Extra Small`, direct.
   *
   * 🔑 Both halves are real and both were previously declared absent. An earlier read looked at
   * the contract KEY's grade suffix (`SmallGrade`/`SupplyGrade`/`BulkGrade`) and reported that
   * Sub's extra-small/small/medium model "doesn't exist in the data". It does — in the title, and
   * it does not track the grade suffix at all: on Sub's live board `…_Corundum_Stanton3_
   * SmallGrade` is titled "Extra Small" while `…_Stims_Stanton3_SupplyGrade` is titled "Medium".
   *
   * Null for the ~6% of contracts that do not follow the pattern (Dead Saints, Ling Family, Red
   * Wind promos). Arrives with the accept notification, so it is known the moment a contract is
   * taken — unlike the tonnage.
   */
  board: BoardTitle | null;
  acceptedAt: number | null;
  /** The game has stated this contract's tonnage: a "Deliver 0/N …" line arrived. ⚠️ NOT "the
   *  player tracked it" — see the header. Nothing the player does re-emits that line. */
  deliverSeen: boolean;
  /** This is the contract currently selected in mobiGlas, live from the objective data bank.
   *  Tracking is exclusive, so at most one live contract has this set. */
  trackedNow: boolean;
  stops: HaulStop[];
  /** Exact manifest, for mission-item hauls only. Empty for every SCU haul. */
  items: HaulItem[];
  /** Sum of the drop-off SCU across tracked legs, or null when nothing is tracked yet. */
  totalScu: number | null;
  endedAt: number | null;
  /** "Complete" | "Abandon" | "Fail" | "Deactivate" — the game's own CompletionType. */
  completion: string | null;
  payout: number | null;
}

export interface HaulShip {
  /** Model-level class, e.g. "CRUS_Starlifter_C2". */
  model: string;
  entityId: string;
  since: number;
}

export interface HaulingView {
  updatedAt: number;
  /** The local player's entity id this session, learned from the vehicle control lines. */
  playerNodeId: string | null;
  ship: HaulShip | null;
  contracts: HaulContract[];
  /** Mission ids of live contracts whose tonnage the game has never stated. ⚠️ This is NOT the
   *  same as "not tracked in mobiGlas" — a tracked contract can be in here, and that is exactly
   *  the case the old prompt handled wrongly. */
  untracked: string[];
  /** The contract selected in mobiGlas right now, or null when nothing hauling-related is. */
  trackedMissionId: string | null;
  /** When this run's clock started — the first hauling event the app saw. Null before any. */
  runStartedAt: number | null;
  /** Contracts that have FINISHED since the app started, oldest first. Deliberately NOT the ended
   *  entries of `contracts`, which are pruned after ten minutes — see the ledger note. */
  finished: { at: number; acceptedAt: number | null; missionId: string; contractKey: string; payout: number | null }[];
}

const ts = (s: string | null): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/** SCU stated by a box's entity class, if it states one. */
export function scuOfItemClass(itemClass: string): number | null {
  const m = itemClass.match(/_(\d+)SCU(?:_|$)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * One vocabulary for how a mission ended.
 *
 * ⚠️ A completion emits TWO end events with DIFFERENT spellings in the same millisecond:
 * `<MissionEnded> … mission_state MISSION_STATE_COMPLETED` and `<EndMission> …
 * CompletionType[Complete]`. Only one of those starts with "Complete", which is how an earlier
 * cut of this file reported 93 ended contracts and 0 completed ones — and so correlated 0
 * payouts. Every observed value is mapped explicitly; the corpus contains exactly these.
 */
export function completionOf(state: string): string {
  const s = state.replace(/^MISSION_STATE_/, "").toUpperCase();
  if (s.startsWith("COMPLET")) return "Complete";
  if (s.startsWith("ABANDON") || s === "WITHDRAWN") return "Abandoned";
  if (s.startsWith("FAIL")) return "Failed";
  if (s.startsWith("DEACTIVAT")) return "Deactivated";
  if (s === "EXPIRED") return "Expired";
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : "Ended";
}

/** Is this contract a cargo haul? Checked against generator AND contract key — see HAUL_MARKERS. */
export function isHaulingContract(generator: string, contractKey: string): boolean {
  const hay = `${generator} ${contractKey}`.toLowerCase();
  return HAUL_MARKERS.some((k) => hay.includes(k));
}

export class HaulingTracker extends EventEmitter {
  private contracts = new Map<string, HaulContract>();
  /** entityId → class, so an unregister (which names only the id) can still be resolved. */
  private itemClasses = new Map<string, string>();
  private playerNodeId: string | null = null;
  private ship: HaulShip | null = null;
  /**
   * missionId → the objective keys of that mission currently sitting in the player's data bank.
   *
   * 🔑 Held per OBJECTIVE rather than as a single "tracked mission" scalar, because a Remove
   * genuinely fires for missions that are not tracked — markers streaming out. On Sub's
   * 2026-08-16 session `Remove 388616e7` arrived while `1bc24142` was the tracked contract, and a
   * scalar that cleared on any matching Remove would have to guess which kind it was. A set
   * cannot: a stray Remove retires an objective that was never in the bank and changes nothing.
   */
  private bank = new Map<string, Set<string>>();
  private trackedMissionId: string | null = null;
  /** Objectives already completed in a PREVIOUS game session, kept across the reset so a
   *  re-created marker does not report finished work as still to do. See the sessionStart case.
   *
   *  🔴 KEYED BY MISSION **AND** OBJECTIVE. An objectiveId is NOT unique to a contract — it is a
   *  template/location id the game reuses freely: one drop-off id appears across 22 different
   *  missions in Sub's corpus, another across 15. Keying on it alone marked a brand-new Silicon
   *  contract as already collected because an older contract to the same place had been, and the
   *  widget told him he was carrying 87 SCU he had never picked up. */
  private doneObjectives = new Map<string, number | null>();
  /**
   * Every hauling contract that has FINISHED since the app started, oldest first — the ledger the
   * aUEC/hour figure is computed from.
   *
   * 🔴 IT CANNOT BE DERIVED FROM `contracts`. Those are pruned ten minutes after they end
   * (KEEP_ENDED_MS), so a rate read off them covers the last ten minutes and nothing else — it
   * would read high right after a delivery and collapse to zero aUEC/hour the moment Sub flew a
   * leg longer than the prune window, which is most of them.
   *
   * 🔑 It also SURVIVES `sessionStart`. A game restart does not un-earn what the run already paid,
   * exactly as a restart does not un-collect the cargo in the hold.
   */
  private ledger: { at: number; acceptedAt: number | null; missionId: string; contractKey: string; payout: number | null }[] = [];
  /** When this run's clock starts — the first hauling event the app ever saw. Set once and never
   *  cleared, for the same reason the ledger is not. */
  private runStartedAt: number | null = null;
  /** Completions still waiting for their "Awarded N aUEC" line, newest last. */
  private awaitingPayout: { missionId: string; at: number }[] = [];
  /** Rewards that arrived before their completion (dev-replay does this), newest last. */
  private looseRewards: { amount: number; at: number }[] = [];
  private lastAt = 0;

  apply(ev: MissionEvent): void {
    switch (ev.kind) {
      case "marker":
        this.onMarker(ev);
        break;
      case "accept": {
        const c = this.contracts.get(ev.missionId);
        // Only fills in detail — the accept notification alone never creates a contract, because
        // it cannot tell a haul from a bounty. CreateMarker is what admits one.
        // Safe to require the contract to exist already: measured across 48 accepts in 60 backup
        // logs, CreateMarker precedes the accept notification every time, with no exceptions.
        if (c) {
          if (ev.title) {
            c.title = ev.title;
            // The rank tier and size band the player sees on the board. Known at accept, which is
            // the whole value of it — the tonnage may never be stated at all.
            const b = parseBoardTitle(ev.title);
            c.board = b.rank || b.size ? b : null;
          }
          c.acceptedAt ??= ts(ev.ts);
          this.touch(ev.ts);
        }
        break;
      }
      case "haulObjective":
        this.onDeliverObjective(ev);
        break;
      case "trackedMarker":
        this.onTrackedMarker(ev);
        break;
      case "objectiveState":
        this.onObjectiveState(ev);
        break;
      case "haulItem":
        this.onItem(ev);
        break;
      case "vehicleControl":
        this.onVehicle(ev);
        break;
      case "end":
        this.onEnd(ev);
        break;
      case "reward":
        this.onReward(ev);
        break;
      // Back at the main menu: this shard's contracts no longer apply. Safe to drop because the
      // game re-emits CreateMarker for every accepted contract on spawn-in — which is exactly why
      // the mission tracker does NOT reset on the PU-side establish. Mirroring that here would
      // wipe the contracts that had just been restored.
      case "sessionStart":
        /* 🔴 REMEMBER WHAT WAS ALREADY DONE. Dropping the contracts is right — the game re-emits
           CreateMarker for every accepted one on spawn-in, so they come back. What does NOT come
           back is their PROGRESS: a re-created marker is always `pending`, and the objective's
           COMPLETED event was in the previous session's log.

           Sub, 2026-08-17, carrying 103 SCU of Scrap he had collected hours earlier: the widget
           told him to go and collect it. The game had logged the pickup complete and then rotated
           its log; the app re-read the board from scratch and called the leg untouched. A hauling
           contract lives on CIG's servers and survives a relaunch — only our picture of it did not.

           So the completed objectives are kept across the reset and re-applied when their marker
           reappears. Keyed by objectiveId, which is stable for the life of the contract. */
        for (const c of this.contracts.values()) {
          for (const s of c.stops) if (s.state === "completed") this.doneObjectives.set(`${c.missionId}|${s.objectiveId}`, s.completedAt);
        }
        this.contracts.clear();
        this.itemClasses.clear();
        this.bank.clear();
        this.trackedMissionId = null;
        this.ship = null;
        this.awaitingPayout = [];
        this.looseRewards = [];
        this.touch(ev.ts);
        break;
      default:
        break;
    }
  }

  private onMarker(ev: Extract<MissionEvent, { kind: "marker" }>): void {
    if (!isHaulingContract(ev.generator, ev.contractKey)) return;
    let c = this.contracts.get(ev.missionId);
    if (!c) {
      c = {
        missionId: ev.missionId, contract: ev.contract, contractKey: ev.contractKey,
        generator: ev.generator, contractDefId: ev.contractDefId, title: null, board: null,
        acceptedAt: ts(ev.ts), deliverSeen: false, trackedNow: ev.missionId === this.trackedMissionId,
        stops: [], items: [], totalScu: null,
        endedAt: null, completion: null, payout: null,
      };
      this.contracts.set(ev.missionId, c);
    }
    const role = objectiveRoleOf(ev.objectiveId);
    // A bare-uuid objective is a phase marker, not a leg — skip it rather than inventing a stop.
    if (role === "other") return;
    const key = objectiveKeyOf(ev.objectiveId);
    const existing = c.stops.find((s) => s.key === key && s.role === role);
    if (existing) {
      // Re-emitted on spawn-in after a relog. Refresh the position, keep any tracked detail.
      if (ev.pos) existing.pos = ev.pos;
      if (ev.markerEntityId) existing.markerEntityId = ev.markerEntityId;
    } else {
      c.stops.push({
        key, objectiveId: ev.objectiveId, role,
        index: parseInt(key.split("#")[1] ?? "0", 10) || 0,
        pos: ev.pos, markerEntityId: ev.markerEntityId,
        destination: null, commodity: null, need: null, delivered: null, unit: null,
        // A marker re-created after a relaunch is always "pending" — but if we watched this exact
        // objective complete before the session reset, it is not.
        state: this.doneObjectives.has(`${ev.missionId}|${ev.objectiveId}`) ? "completed" : "pending",
        completedAt: this.doneObjectives.get(`${ev.missionId}|${ev.objectiveId}`) ?? null,
      });
      c.stops.sort((a, b) => a.index - b.index || a.role.localeCompare(b.role));
    }
    this.touch(ev.ts);
  }

  /** The tracked contract's tonnage. Joins on the objectiveId, which the notification writes
   *  identically to CreateMarker — an exact match, no timestamp proximity involved. */
  private onDeliverObjective(ev: Extract<MissionEvent, { kind: "haulObjective" }>): void {
    if (!ev.missionId) return;
    const c = this.contracts.get(ev.missionId);
    if (!c) return;
    c.deliverSeen = true;
    const key = ev.objectiveId ? objectiveKeyOf(ev.objectiveId) : null;
    // Fall back to the sole drop-off when the notification carried no objective id: a
    // single-destination contract has exactly one, so there is nothing to guess between.
    const drops = c.stops.filter((s) => s.role === "dropoff");
    let stop = key ? drops.find((s) => s.key === key) : drops.length === 1 ? drops[0] : undefined;
    // 🔴 A DELIVER LINE FOR A LEG WITH NO MARKER MUST CREATE THE LEG, not be discarded.
    //
    // Found on Sub's live board, 2026-08-17: contract 388616e7
    // (`HaulCargo_AToB_Waste_Mixed_ScrapWaste_…`) carries TWO drop-off legs to the same place —
    // `dropoff_7000cb2b-…_0` = 51 SCU of Waste and `…_1` = 50 SCU of Scrap — and the game emitted
    // a CreateMarker only for `_0`. So `_1` had no stop to join to, its Deliver line was dropped
    // on the floor, and the contract reported **51 SCU instead of 101**. He was about to load a
    // ship against that number.
    //
    // 🔑 The Deliver line is authoritative that a leg EXISTS: it names the mission, the
    // objectiveId, the commodity and the tonnage. A marker adds a position and nothing else that
    // matters here, so a missing marker must cost the position, never the leg. `pos` stays null
    // and the router already handles a leg with no coordinates (flat distance estimate).
    if (!stop && key) {
      stop = {
        key, objectiveId: ev.objectiveId!, role: "dropoff",
        index: parseInt(key.split("#")[1] ?? "0", 10) || 0,
        pos: null, markerEntityId: null,
        destination: null, commodity: null, need: null, delivered: null, unit: null,
        state: "pending", completedAt: null,
      };
      c.stops.push(stop);
      c.stops.sort((a, b) => a.index - b.index || a.role.localeCompare(b.role));
    }
    if (stop) {
      stop.destination = ev.destination;
      stop.commodity = ev.commodity;
      stop.need = ev.need;
      stop.unit = ev.unit;
      // Monotonic: a spawn-in re-emission reports live progress, but a fresh accept of a
      // repeat contract reports 0 — and a stop that has already been delivered against must
      // not be walked backwards by a later notification for a different instance.
      stop.delivered = Math.max(stop.delivered ?? 0, ev.have);
    }
    this.recomputeTotal(c);
    this.touch(ev.ts);
  }

  /**
   * The player tracked or untracked something in mobiGlas.
   *
   * 🔴 **Scoped to contracts we already know**, and the early return is load-bearing rather than
   * defensive: this event is not hauling-only. Across Sub's 481 backup logs it fires 177,853
   * times, and the volume is combat contracts (`HeadHunters_Mercenary_*`,
   * `CitizensForProsperity_*`) whose objective markers stream in and out — one session logged
   * 1,509 Adds for a single FPS contract. Letting those through would emit an SSE push per line
   * and re-solve the whole plan each time, for a mission this widget does not draw.
   *
   * The state machine is deliberately tiny:
   *   Add     put the objective in that mission's bank set, and that mission becomes the tracked
   *           one. Last Add wins, which is correct even though a swap interleaves its Remove and
   *           Add lines inside one millisecond — the new mission's Add always lands, in either
   *           order, and the old mission's Remove can only ever empty the old mission's own set.
   *   Remove  drop that objective. A mission is untracked once its set is empty.
   */
  private onTrackedMarker(ev: Extract<MissionEvent, { kind: "trackedMarker" }>): void {
    const c = this.contracts.get(ev.missionId);
    if (!c) return;
    const key = objectiveKeyOf(ev.objectiveId);
    let set = this.bank.get(ev.missionId);
    if (ev.added) {
      if (!set) this.bank.set(ev.missionId, (set = new Set()));
      set.add(key);
      this.trackedMissionId = ev.missionId;
      // Backfill only. Measured on the live log: the ZonePos here is byte-identical to the
      // CreateMarker position for the same marker in 26 of 26 cases, and CreateMarker's is the
      // better one because it also carries the zoneHostId a distance needs. So this exists purely
      // for a marker whose CreateMarker fell outside the slice of log we read.
      if (ev.pos) {
        const role = objectiveRoleOf(ev.objectiveId);
        const stop = c.stops.find((s) => s.key === key && s.role === role);
        if (stop && !stop.pos) stop.pos = ev.pos;
      }
    } else if (set) {
      set.delete(key);
      if (!set.size) this.bank.delete(ev.missionId);
    }
    // Recomputed from the bank rather than assigned, so "nothing is tracked" is a state the log
    // can actually express — the player untracking everything must not leave a stale flag on.
    if (this.trackedMissionId && !this.bank.has(this.trackedMissionId)) this.trackedMissionId = null;
    for (const k of this.contracts.keys()) {
      const con = this.contracts.get(k)!;
      con.trackedNow = k === this.trackedMissionId;
    }
    this.touch(ev.ts);
  }

  private onObjectiveState(ev: Extract<MissionEvent, { kind: "objectiveState" }>): void {
    const c = this.contracts.get(ev.missionId);
    if (!c) return;
    const key = objectiveKeyOf(ev.objectiveId);
    const role = objectiveRoleOf(ev.objectiveId);
    // Matched on the normalized key alone: GoblinG rewrites both the leading hash and a middle
    // index between the in-progress and the completed push for the same leg, so the raw ids of
    // one objective genuinely differ from each other.
    const stops = c.stops.filter((s) => s.key === key && (role === "other" || s.role === role));
    if (!stops.length) return;
    const state: HaulStopState =
      ev.state === "COMPLETED" ? "completed" : ev.state === "FAILED" ? "failed" : "inprogress";
    for (const s of stops) {
      // Completion is terminal. A later INPROGRESS push for a finished leg is server churn, and
      // letting it win would un-tick a delivery the player has already made.
      if (s.state === "completed") continue;
      s.state = state;
      if (state === "completed") s.completedAt = ts(ev.ts);
    }
    this.touch(ev.ts);
  }

  private onItem(ev: Extract<MissionEvent, { kind: "haulItem" }>): void {
    const c = this.contracts.get(ev.missionId);
    if (ev.itemClass) this.itemClasses.set(ev.entityId, ev.itemClass);
    if (!c) return;
    const itemClass = ev.itemClass ?? this.itemClasses.get(ev.entityId);
    const existing = c.items.find((i) => i.entityId === ev.entityId);
    if (existing) {
      existing.present = ev.registered;
    } else if (itemClass) {
      c.items.push({
        entityId: ev.entityId, itemClass, scu: scuOfItemClass(itemClass),
        dropoffKey: ev.dropoffObjectiveId ? objectiveKeyOf(ev.dropoffObjectiveId) : null,
        present: ev.registered,
      });
    }
    this.touch(ev.ts);
  }

  private onVehicle(ev: Extract<MissionEvent, { kind: "vehicleControl" }>): void {
    this.playerNodeId = ev.nodeId;
    if (ev.action === "release") {
      // Only clear if it's the ship we think we're in — the game releases tokens for vehicles
      // we stepped out of long ago when they stream out.
      if (this.ship?.entityId === ev.entityId) this.ship = null;
    } else if (this.ship?.entityId !== ev.entityId) {
      this.ship = { model: ev.model, entityId: ev.entityId, since: ts(ev.ts) ?? Date.now() };
    }
    this.touch(ev.ts);
  }

  private onEnd(ev: Extract<MissionEvent, { kind: "end" }>): void {
    const c = this.contracts.get(ev.missionId);
    if (!c) return;
    const first = c.endedAt == null;
    c.endedAt ??= ts(ev.ts) ?? Date.now();
    c.completion = completionOf(ev.state);
    // 🔑 Only on the FIRST end event. A completion emits both `MissionEnded` and `EndMission` in
    // the same millisecond, so claiming on each would queue the same contract for payout twice —
    // and the second claim would then steal the next contract's award.
    if (first && c.completion === "Complete") {
      // Into the ledger BEFORE the payout is known — the award line arrives up to three seconds
      // later (PAYOUT_WINDOW_MS) and is written in afterwards by syncLedger. Recording the
      // completion immediately is what makes the rep side exact even when no award ever lands.
      // 🔑 acceptedAt rides along so a run's real DURATION is recoverable. Sub: "we have enough
      // information to figure out exactly how long it takes me to do a mission, because you know
      // when I grabbed it and when I turned it in." Exactly — and a measured duration beats the
      // modelled one, which counts only box handling.
      this.ledger.push({
        at: c.endedAt, acceptedAt: c.acceptedAt, missionId: c.missionId,
        contractKey: c.contractKey, payout: c.payout,
      });
      this.claimPayout(c);
      this.syncLedger(c);
    }
    this.touch(ev.ts);
  }

  private onReward(ev: Extract<MissionEvent, { kind: "reward" }>): void {
    const at = ts(ev.ts) ?? Date.now();
    // The award notification's own MissionId is all-zeros, so the only join is time. Give it to
    // the nearest completion inside the window that hasn't been paid yet.
    let best: { missionId: string; at: number } | null = null;
    for (const p of this.awaitingPayout) {
      if (Math.abs(p.at - at) > PAYOUT_WINDOW_MS) continue;
      if (!best || Math.abs(p.at - at) < Math.abs(best.at - at)) best = p;
    }
    if (best) {
      const c = this.contracts.get(best.missionId);
      if (c) { c.payout = ev.amount; this.syncLedger(c); }
      this.awaitingPayout = this.awaitingPayout.filter((p) => p !== best);
      this.touch(ev.ts);
      return;
    }
    this.looseRewards.push({ amount: ev.amount, at });
    this.looseRewards = this.looseRewards.filter((r) => at - r.at <= PAYOUT_WINDOW_MS);
  }

  /** Copy a contract's settled payout onto its ledger row. The row is written at completion, when
   *  the award line has usually not arrived yet. */
  private syncLedger(c: HaulContract): void {
    const row = this.ledger.find((r) => r.missionId === c.missionId);
    if (row && row.payout == null) row.payout = c.payout;
  }

  /** Pair a completion with a reward that already arrived, or queue it to wait for one. */
  private claimPayout(c: HaulContract): void {
    const at = c.endedAt ?? Date.now();
    let best: { amount: number; at: number } | null = null;
    for (const r of this.looseRewards) {
      if (Math.abs(r.at - at) > PAYOUT_WINDOW_MS) continue;
      if (!best || Math.abs(r.at - at) < Math.abs(best.at - at)) best = r;
    }
    if (best) {
      c.payout = best.amount;
      this.looseRewards = this.looseRewards.filter((r) => r !== best);
      return;
    }
    this.awaitingPayout.push({ missionId: c.missionId, at });
    this.awaitingPayout = this.awaitingPayout.filter((p) => at - p.at <= PAYOUT_WINDOW_MS);
  }

  private recomputeTotal(c: HaulContract): void {
    const scu = c.stops.filter((s) => s.role === "dropoff" && s.unit === "scu" && s.need != null);
    c.totalScu = scu.length ? scu.reduce((n, s) => n + (s.need ?? 0), 0) : null;
  }

  /** Advance the clock and announce a change. `lastAt` follows the LOG's clock, not the wall
   *  clock, so a seed read of an old file doesn't claim to be current. */
  private touch(evTs: string | null): void {
    this.lastAt = Math.max(this.lastAt, ts(evTs) ?? 0);
    // The run clock opens at the first hauling event and never restarts — see runStartedAt.
    if (this.runStartedAt == null && this.lastAt > 0) this.runStartedAt = this.lastAt;
    this.prune();
    this.emit("change");
  }

  private prune(): void {
    const now = this.lastAt || Date.now();
    for (const [id, c] of this.contracts) {
      if (c.endedAt != null && now - c.endedAt > KEEP_ENDED_MS) {
        this.contracts.delete(id);
        this.bank.delete(id);
        if (this.trackedMissionId === id) this.trackedMissionId = null;
      }
    }
  }

  view(): HaulingView {
    const contracts = [...this.contracts.values()]
      .sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0));
    return {
      updatedAt: this.lastAt,
      playerNodeId: this.playerNodeId,
      ship: this.ship,
      contracts,
      untracked: contracts.filter((c) => !c.deliverSeen && c.endedAt == null).map((c) => c.missionId),
      trackedMissionId: this.trackedMissionId,
      runStartedAt: this.runStartedAt,
      finished: [...this.ledger],
    };
  }
}
