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
 * 🔑 The "New Objective: Deliver 0/N SCU of <C> to <D>" line — the one that names the tonnage,
 * the commodity and the destination — is **TRACKING-GATED**. The game emits it only for a
 * contract the player has TRACKED in mobiGlas. Sub's 2026-08-16 session is the proof: seven
 * hauling contracts accepted, seven CreateMarker bursts, two Deliver lines — and he had tracked
 * exactly two. Earlier research recorded this as "fires unreliably (2 of 8)" and treated it as
 * data loss; it is not. It is a user action we can ask for.
 *
 * That is why `HaulContract.tracked` exists and why `untracked()` is part of the public view: the
 * widget's job is to show the player which contracts still need tracking, not to paper over a
 * gap. Once tracked, the numbers are exact and come straight from the game.
 *
 * ── What it does NOT give us ───────────────────────────────────────────────────────────────
 *
 * • Progress is per-DROP-OFF, not per-box — but it is better than "completed / not completed".
 *   ⚠️ Earlier research said "the delivery counter NEVER ticks" because all 480 of Sub's logs
 *   showed `0/N`. **That is wrong**, and so was the first correction to it. Cryojenikx's 152-log
 *   corpus settles what actually emits a `Deliver` line (90 of them):
 *
 *     56  at accept, within 1s of "Contract Accepted"   ← the tracking gate
 *     17  standalone                                     ← a manual TRACK, mid-run
 *     10  within 0.5s of a drop-off ObjectiveUpserted COMPLETED
 *      7  within 0.5s of a drop-off ObjectiveUpserted INPROGRESS   ← a PARTIAL delivery
 *
 *   **Every non-zero numerator in the corpus came from that last group.** A drop-off that goes
 *   INPROGRESS means boxes were handed over but the leg is not finished, and the game re-announces
 *   the objective ~3ms later with the running total: `Deliver 48/81 SCU of Scrap …`.
 *   So partial progress arrives on its own for a contract actively being delivered — no tracking
 *   needed. Tracking only matters for learning the tonnage BEFORE the first drop.
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
   * logs had N=0, because he always tracks at accept, when progress genuinely IS zero. It does
   * tick. The clearest case, from Cryojenikx's corpus (mission `922ce48a`, 2026-06-28): the
   * drop-off went `INPROGRESS` at 23:07:34.277 and `Deliver 48/81 SCU of Scrap` landed 3ms later,
   * then the leg COMPLETED at 23:10:59 and paid 73,000 aUEC in full. Partial deliveries are
   * announced, and this is the only number that says how much is still in the hold.
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
  acceptedAt: number | null;
  /** True once a Deliver objective line has been seen — i.e. the player tracked it in mobiGlas.
   *  The widget turns this into a checklist: untracked contracts have no tonnage yet. */
  tracked: boolean;
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
  /** Mission ids of live contracts with no Deliver line yet — the "please track these" list. */
  untracked: string[];
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
        if (c) {
          if (ev.title) c.title = ev.title;
          c.acceptedAt ??= ts(ev.ts);
          this.touch(ev.ts);
        }
        break;
      }
      case "haulObjective":
        this.onDeliverObjective(ev);
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
        this.contracts.clear();
        this.itemClasses.clear();
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
        generator: ev.generator, contractDefId: ev.contractDefId, title: null,
        acceptedAt: ts(ev.ts), tracked: false, stops: [], items: [], totalScu: null,
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
        state: "pending", completedAt: null,
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
    c.tracked = true;
    const key = ev.objectiveId ? objectiveKeyOf(ev.objectiveId) : null;
    // Fall back to the sole drop-off when the notification carried no objective id: a
    // single-destination contract has exactly one, so there is nothing to guess between.
    const drops = c.stops.filter((s) => s.role === "dropoff");
    const stop = key ? drops.find((s) => s.key === key) : drops.length === 1 ? drops[0] : undefined;
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
    if (first && c.completion === "Complete") this.claimPayout(c);
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
      if (c) c.payout = ev.amount;
      this.awaitingPayout = this.awaitingPayout.filter((p) => p !== best);
      this.touch(ev.ts);
      return;
    }
    this.looseRewards.push({ amount: ev.amount, at });
    this.looseRewards = this.looseRewards.filter((r) => at - r.at <= PAYOUT_WINDOW_MS);
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
    this.prune();
    this.emit("change");
  }

  private prune(): void {
    const now = this.lastAt || Date.now();
    for (const [id, c] of this.contracts) {
      if (c.endedAt != null && now - c.endedAt > KEEP_ENDED_MS) this.contracts.delete(id);
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
      untracked: contracts.filter((c) => !c.tracked && c.endedAt == null).map((c) => c.missionId),
    };
  }
}
