/**
 * HAULING ADVISOR — "which contracts should I grab?"
 *
 * Ranks contract TYPES, not board rows. Nothing here reads the screen and nothing here reads the
 * contract manager: it scores the 441 real hauling contracts in the shipped datasets and hands
 * back an ordered list the player matches against the board BY ITS TITLE. That is possible
 * because the title the game prints is not decoration — it is the whole model, spelled out:
 *
 *     "Experienced Rank - Direct Medium Cargo Haul"
 *      └── rank tier      └ AToB   └ size band
 *
 * ── 🔑 THE HEADLINE, AND IT IS NOT WHAT WE WENT IN EXPECTING ───────────────────────────────
 *
 * **Reputation is a pure function of the RANK TIER in the title.** Across the 393 real contracts
 * in the three core families (Planetary, Stellar, Local) every tier awards exactly ONE value —
 * not a median, the only value in the set:
 *
 *     Rookie 50 · Junior 500 · Member 1000 · Experienced 2000 · Senior 4000 · Master 8000
 *
 * Route shape is NOT the discriminator. Holding rank and size fixed, direct-vs-multi moves
 * rep-per-box by 0.96x-1.33x in every well-populated cell. The rank tier moves it 20x at a fixed
 * size band (Rookie/Small 12.5 rep per box, Experienced/Small 250). So the advice is "climb the
 * tier ladder, then take the SMALLEST size band that tier offers" — smaller bands mean fewer
 * boxes for the same flat per-tier rep — and never "prefer multi-drop".
 *
 * ⚠️ This reverses the working assumption this flight was briefed on (that route shape was the
 * discriminator and AToB was the worst contract in the game). See `isStub` below for why the
 * earlier read came out that way — it is a data-hygiene artifact, not a disagreement about
 * arithmetic.
 *
 * ── ⚠️ `Hauling - Interstellar` IS A SEPARATE ECONOMY ─────────────────────────────────────
 *
 * 48 contracts, and the ONLY place the tier rule breaks. Its Rookie tier pays 50 OR 100, and its
 * Master tier pays 0 or 200 where every core Master pays 8000 — those are pure money contracts
 * with the rep switched off. The middle four tiers agree with core exactly. Anything reasoning
 * about rep must therefore scope to `missionType`, which is why `AdvisorContract` carries it and
 * why nothing here infers rep from the tier instead of reading it.
 *
 * ── 🔑 AND THE METRIC BRANCHES ON THE SHIP ────────────────────────────────────────────────
 *
 * `hauling-autoload.ts` has the two regimes. They do not agree about what a good contract is:
 * ranked by rep, the manual list is topped by 4-box "Experienced Rank - Small Cargo Haul" runs
 * (500 rep per box) and the auto list by 28-box "Master Rank - Medium Cargo Haul" runs (385 rep
 * per minute). Across the 427 rep-paying contracts the median one moves 35 places between the two
 * orderings, p90 is 85, worst case 152. A single ordering would be wrong for one of the two
 * players, so `rankContracts` takes the ship and picks.
 *
 * ── ⚠️ SOLO ESTIMATE, ON PURPOSE ──────────────────────────────────────────────────────────
 *
 * Handling time belongs in the score, and handling time depends on how the accepted set packs
 * together — which is circular, because packing depends on what you accepted. This module breaks
 * the circle by scoring every contract AS IF IT WERE THE ONLY ONE YOU TOOK. That is the right
 * number for the accept/skip decision at the board. `hauling-plan.ts` re-scores the accepted set
 * afterwards with the real packing, and its numbers supersede these. Do not read a figure out of
 * here and print it next to a planned run.
 */
import { AUTOLOAD_BASE_SECONDS, AUTOLOAD_SECONDS_BY_SCU, canAutoLoad } from "./hauling-autoload.js";

// ── The ladder ────────────────────────────────────────────────────────────────────────────

/** The seven rungs of the `Hauling` reputation scope, in ascending order. These names are the
 *  SAME STRINGS the contract titles use, which is the join that makes this module work. */
export type HaulingRankName =
  | "Trainee" | "Rookie" | "Junior" | "Member" | "Experienced" | "Senior" | "Master";

export interface HaulingRung {
  name: HaulingRankName;
  /** Standing at which this rung opens. */
  minRep: number;
}

/**
 * Verbatim from the `Hauling` scope in `data/rep-scopes.json` (4.9.0-LIVE.12248363), minus the
 * "Not Eligible" rung at -1000 which no hauler is ever on.
 *
 * 🔑 THIS IS THE ACCESS GATE, and finding it settles an open question. The `rank` field on the
 * mission records is NOT the gate — it is null for 402 of 853 keys, 0 for most of the rest, and
 * it does not track the title's rank word (Master maps to 6, Rookie to both 1 and null). The
 * ladder does: every contract titled "<Rung> Rank - ..." awards the rep that rung is worth, and
 * the rungs are exactly these. Anything above the player's standing is not on their board.
 */
export const HAULING_LADDER: readonly HaulingRung[] = [
  { name: "Trainee", minRep: 0 },
  { name: "Rookie", minRep: 50 },
  { name: "Junior", minRep: 250 },
  { name: "Member", minRep: 5250 },
  { name: "Experienced", minRep: 27750 },
  { name: "Senior", minRep: 77750 },
  { name: "Master", minRep: 237750 },
];

/** The rung a standing sits on, and the one above it (null at the top). */
export function rungAt(rep: number): { current: HaulingRung; next: HaulingRung | null } {
  let i = 0;
  for (let j = 0; j < HAULING_LADDER.length; j++) if (rep >= HAULING_LADDER[j].minRep) i = j;
  return { current: HAULING_LADDER[i], next: HAULING_LADDER[i + 1] ?? null };
}

// ── Reading a board title ─────────────────────────────────────────────────────────────────

/** The size band in the title. Drives the container cap, and through it the box count. */
export type HaulSize = "Extra Small" | "Small" | "Medium" | "Large" | "Bulk";

export interface BoardTitle {
  rank: HaulingRankName | null;
  size: HaulSize | null;
  /** The word "Direct" — the title's own name for an A-to-B run with one drop-off. */
  direct: boolean;
}

const RANK_WORDS: readonly HaulingRankName[] =
  ["Trainee", "Rookie", "Junior", "Member", "Experienced", "Senior", "Master"];
/** Longest first: "Extra Small" must win before "Small" gets a chance at the same string. */
const SIZE_WORDS: readonly HaulSize[] = ["Extra Small", "Bulk", "Medium", "Large", "Small"];

/**
 * Decompose a contract title the way a player skims it.
 *
 * ⚠️ 26 of the 441 real contracts do NOT follow the pattern — they come from the four non-Covalex
 * givers (Dead Saints, Ling Family, Red Wind) and from Covalex's own one-off promos ("Opportunity
 * for Independent Cargo Hauler"). Those yield nulls, which is honest: their rep is read off the
 * dataset instead of inferred from a rung, and `rankContracts` never gates them.
 */
export function parseBoardTitle(title: string): BoardTitle {
  const t = title ?? "";
  return {
    rank: RANK_WORDS.find((r) => t.includes(r + " Rank")) ?? null,
    size: SIZE_WORDS.find((s) => t.includes(s + " Cargo")) ?? null,
    direct: /\bDirect\b/.test(t),
  };
}

// ── The route shape, off the contract key ─────────────────────────────────────────────────

/** Pickups and drop-offs, which is what the player counts on the board. */
export interface RouteShape {
  pickups: number;
  dropoffs: number;
  raw: string;
}

/**
 * `HaulCargo_SingleToMulti4_...` -> 1 pickup, 4 drop-offs.
 *
 * ⚠️ Read the SHAPE, never `orders.length` — an order is one commodity at one end, so a
 * SingleToMulti2 carrying two commodities has four orders and still only two drop-offs. Measured:
 * SingleToMulti2 has 2 orders 101 times and 4 orders 46 times, for the same two stops.
 * `orderCount` is the fallback for the two unnumbered shapes (`SingleToMulti`, `MultiToSingle`,
 * 13 contracts) where the key genuinely does not say.
 */
export function parseRouteShape(key: string, orderCount = 1): RouteShape {
  const raw = key.split("_")[1] ?? "";
  const single = /^SingleToMulti(\d*)$/.exec(raw);
  if (single) return { pickups: 1, dropoffs: Number(single[1]) || Math.max(1, orderCount), raw };
  const multi = /^Multi(\d*)ToSingle$/.exec(raw);
  if (multi) return { pickups: Number(multi[1]) || Math.max(1, orderCount), dropoffs: 1, raw };
  return { pickups: 1, dropoffs: 1, raw }; // AToB and anything unrecognised
}

// ── The normalised contract row ───────────────────────────────────────────────────────────

/** One commodity line, as `data/hauling-orders.json` stores it. */
export interface AdvisorOrder {
  maxContainerSize?: number;
  minScu?: number;
  maxScu?: number;
}
/** The slice of `data/blueprints.latest.json` `missions` this module reads. */
export interface AdvisorMission {
  title?: string | null;
  giver?: string | null;
  missionType?: string | null;
  generatorClass?: string | null;
  payout?: { min?: number; max?: number } | null;
  reputationGained?: { amount?: number }[] | null;
}

export interface AdvisorContract {
  key: string;
  title: string;
  giver: string | null;
  missionType: string | null;
  rank: HaulingRankName | null;
  size: HaulSize | null;
  shape: RouteShape;
  /** Reputation the whole contract awards. 0 is REAL for Master Large/Bulk — those pay money. */
  rep: number;
  /** Fixed aUEC payout, before the 5-20% standing bonus. */
  payout: number;
  /** 🔴 A SPAN, not a number — 2,081 of 2,106 orders have `minScu < maxScu`. Everything
   *  downstream carries both ends rather than inventing a midpoint the game never promised. */
  scuLo: number;
  scuHi: number;
  /** Boxes at each end of the SCU span, greedy largest-first under the cap.
   *  ⚠️ NOT ordered — greedy partitioning is not monotone in total SCU. At a 4 SCU cap, 7 SCU is
   *  three boxes (4+2+1) and 8 SCU is two (4+4), so `boxesAtScuLo` can EXCEED `boxesAtScuHi`.
   *  One of the 441 real contracts hits this today. Use `boxesMax` for anything that has to be
   *  safe, and never assume lo <= hi. */
  boxesAtScuLo: number;
  boxesAtScuHi: number;
  /** Worst case of the two — the number the player has to be willing to move. */
  boxesMax: number;
  /** Largest container this contract will hand you, across its orders. */
  maxContainerScu: number;
}

/** Box sizes the game ships, largest first. Mirrors the `boxes` table in hauling-orders.json. */
const BOX_SCU = [32, 24, 16, 8, 4, 2, 1] as const;

/** Greedy largest-first split of `scu` under `cap`, returning box count and auto-load seconds.
 *  ⚠️ Greedy-largest-first is still Sub's hypothesis, not a confirmed engine rule. The ORDERING
 *  this module produces is robust to it being slightly off; the absolute box counts are not. */
function splitScu(scu: number, cap: number): { boxes: number; seconds: number } {
  let left = Math.max(0, Math.floor(scu)), boxes = 0, seconds = 0;
  for (const s of BOX_SCU) {
    if (s > cap) continue;
    const n = Math.floor(left / s);
    if (!n) continue;
    boxes += n;
    seconds += n * AUTOLOAD_SECONDS_BY_SCU[s];
    left -= n * s;
  }
  return { boxes, seconds };
}

/**
 * 🔑 THE STUB FILTER, and it is the reason this module's numbers differ from the brief's.
 *
 * 412 of the 853 `HaulCargo` keys are not contracts. They carry no `generatorClass` AND no
 * `maxContainerSize` on any order, 1-4 SCU, and a flat 10,000 aUEC payout; 153 of them have the
 * literal string TEMPLATE in the key. They are generator scaffolding and never reach a board.
 *
 * They also all carry `reputationGained: 500`. Averaged in, they drag a rung's rep-per-box toward
 * "500 rep for one 1-SCU box" — which is what made shape look like the discriminator, because the
 * stubs are not spread evenly across shapes. Drop them and the shape effect collapses to ~1x,
 * exposing the rung effect underneath.
 *
 * ⚠️ BOTH signals are required, because each alone is wrong on real rows. Filtering on
 * `generatorClass` alone drops `HaulCargo_AToB_RefinedOre_Laranite_Stanton1` — a genuine
 * "Member Rank - Direct Small Cargo Haul" with 14-32 SCU at a 4 SCU cap that simply has no
 * generator set. Filtering on the cap alone drops the two Dead Saints trial hauls, which are
 * real 1 SCU contracts. The intersection is right on all 853.
 */
export function isStub(m: AdvisorMission, orders: AdvisorOrder[] = []): boolean {
  return !m.generatorClass && !orders.some((o) => o.maxContainerSize != null);
}

/** Normalise the two shipped datasets into rankable rows, stubs already dropped. */
export function buildContracts(
  missions: Record<string, AdvisorMission>,
  orders: Record<string, { orders?: AdvisorOrder[] } | undefined>,
): AdvisorContract[] {
  const out: AdvisorContract[] = [];
  for (const [key, m] of Object.entries(missions)) {
    if (!key.startsWith("HaulCargo")) continue;
    const os = orders[key]?.orders ?? [];
    if (!os.length || isStub(m, os)) continue;
    const t = parseBoardTitle(m.title ?? "");
    let scuLo = 0, scuHi = 0, boxesAtScuLo = 0, boxesAtScuHi = 0, cap = 0;
    for (const o of os) {
      const c = o.maxContainerSize ?? 1;
      const lo = o.minScu ?? 0;
      const hi = Math.max(lo, o.maxScu ?? lo);
      scuLo += lo; scuHi += hi;
      boxesAtScuLo += splitScu(lo, c).boxes;
      boxesAtScuHi += splitScu(hi, c).boxes;
      cap = Math.max(cap, c);
    }
    out.push({
      key,
      title: m.title ?? "",
      giver: m.giver ?? null,
      missionType: m.missionType ?? null,
      rank: t.rank,
      size: t.size,
      shape: parseRouteShape(key, os.length),
      rep: (m.reputationGained ?? []).reduce((s, r) => s + (r.amount ?? 0), 0),
      payout: m.payout?.min ?? 0,
      scuLo, scuHi, boxesAtScuLo, boxesAtScuHi,
      boxesMax: Math.max(boxesAtScuLo, boxesAtScuHi),
      maxContainerScu: cap || 1,
    });
  }
  return out;
}

// ── Effort: the thing the two regimes disagree about ──────────────────────────────────────

export type Regime = "auto" | "manual";

export interface Effort {
  regime: Regime;
  /** Physical boxes to move, at the pessimistic end of the SCU span. */
  boxes: number;
  /** Total loading seconds — auto regime only. Null under manual, where no timing is published
   *  and pretending otherwise would put a fabricated number in front of the player. */
  seconds: number | null;
  /** What the score divides by. Seconds under auto, box count under manual — the two are NOT
   *  comparable across regimes, which is fine because a player is only ever in one of them. */
  cost: number;
  /** Load and unload events: one per pickup, one per drop-off. */
  stops: number;
}

export function regimeFor(shipClass: string | null | undefined): Regime {
  return canAutoLoad(shipClass) ? "auto" : "manual";
}

/**
 * What this contract costs to physically move, alone.
 *
 * **Auto**: `AUTOLOAD_BASE_SECONDS` is charged PER LOAD AND PER UNLOAD, so a 4-drop contract pays
 * it five times (one pickup + four drop-offs) — 600s of flat overhead before a single box moves.
 * That is the real reason multi-drop is expensive for an auto-loading hull, and it is invisible
 * if you only count boxes.
 *
 * **Manual**: box COUNT, unweighted. Sub, 2026-08-16: "six 1 SCU boxes is about the same work as
 * six 32 SCU boxes." Deliberately no seconds — the tractor-beam grind has no published timing and
 * a made-up constant would propagate into every figure downstream.
 *
 * Both price the WORST END of the SCU span — and worst end, not high end, because the greedy
 * partition is not monotone (see `boxesAtScuLo`). A contract you cannot fit or cannot face is the
 * one that costs you the run, so the pessimistic figure is the decision-relevant one.
 */
export function handlingEffort(c: AdvisorContract, regime: Regime): Effort {
  const stops = c.shape.pickups + c.shape.dropoffs;
  const boxes = c.boxesMax;
  if (regime === "manual") {
    return { regime, boxes, seconds: null, cost: Math.max(1, boxes), stops };
  }
  // Per-box seconds are charged twice — once loading, once unloading — and the flat base once
  // per stop, so a 4-drop run pays it five times before a single box moves.
  const perBox = Math.max(splitScu(c.scuLo, c.maxContainerScu).seconds,
                          splitScu(c.scuHi, c.maxContainerScu).seconds);
  const seconds = stops * AUTOLOAD_BASE_SECONDS + 2 * perBox;
  return { regime, boxes, seconds, cost: Math.max(1, seconds), stops };
}

// ── Ranking ───────────────────────────────────────────────────────────────────────────────

export type AdvisorGoal = "rep" | "money";

export interface RankOptions {
  /** Ship class or display name. Picks the regime; unknown/absent means manual. */
  ship?: string | null;
  /** Current `Hauling` standing. Contracts above the player's rung are marked locked. */
  rep?: number | null;
  goal?: AdvisorGoal;
  /** Keep locked contracts in the output (ranked, flagged) instead of dropping them.
   *  Default true — seeing what the next rung unlocks is half the point of the list. */
  includeLocked?: boolean;
  /** Restrict to one mission type ("Hauling - Planetary"), as the board groups them. */
  missionType?: string | null;
}

export interface ScoredContract {
  contract: AdvisorContract;
  effort: Effort;
  /** Reputation per unit of cost. Units are rep/second (auto) or rep/box (manual). */
  repRate: number;
  /** aUEC per unit of cost, same units caveat. */
  moneyRate: number;
  /** Whichever of the two the goal selected — the sort key. */
  score: number;
  /** True when the contract's rung is above the player's standing. */
  locked: boolean;
}

/**
 * Rank contract types for this player and this ship.
 *
 * Sorted by the goal's rate, unlocked before locked. Ties break on fewer stops, then on fewer
 * boxes — between two contracts that pay the same per unit of work, the shorter one wins, which
 * is the preference every hauler actually has.
 */
export function rankContracts(contracts: AdvisorContract[], opts: RankOptions = {}): ScoredContract[] {
  const regime = regimeFor(opts.ship);
  const goal: AdvisorGoal = opts.goal ?? "rep";
  const standing = opts.rep ?? null;
  const reach = standing == null ? null : rungAt(standing).current;
  const reachIdx = reach ? HAULING_LADDER.findIndex((r) => r.name === reach.name) : null;

  const rows: ScoredContract[] = [];
  for (const c of contracts) {
    if (opts.missionType && c.missionType !== opts.missionType) continue;
    const effort = handlingEffort(c, regime);
    const repRate = c.rep / effort.cost;
    const moneyRate = c.payout / effort.cost;
    // An unparseable title has no rung, so it cannot be gated — treat it as open.
    const idx = c.rank ? HAULING_LADDER.findIndex((r) => r.name === c.rank) : -1;
    const locked = reachIdx != null && idx >= 0 && idx > reachIdx;
    if (locked && opts.includeLocked === false) continue;
    rows.push({ contract: c, effort, repRate, moneyRate, score: goal === "rep" ? repRate : moneyRate, locked });
  }

  rows.sort((a, b) =>
    Number(a.locked) - Number(b.locked) ||
    b.score - a.score ||
    a.effort.stops - b.effort.stops ||
    a.effort.boxes - b.effort.boxes ||
    a.contract.key.localeCompare(b.contract.key));
  return rows;
}

// ── The derived number a hauler actually wants ────────────────────────────────────────────

export interface ClimbEstimate {
  from: HaulingRung;
  to: HaulingRung | null;
  repNeeded: number;
  /** Runs of this contract to reach the next rung. Null when it awards no rep. */
  runs: number | null;
  /** Loading seconds those runs cost — auto regime only, null under manual. */
  seconds: number | null;
  /** Boxes those runs cost. The manual regime's honest unit. */
  boxes: number | null;
}

/**
 * "How many of these to the next rung?" — the question that turns a rate into a plan.
 *
 * Counts only the loading work it can defend. Travel, quantum and the walk to the elevator are
 * all absent, so `seconds` is a FLOOR on the real time, never an estimate of it.
 */
export function climbToNextRung(
  contract: AdvisorContract,
  currentRep: number,
  regime: Regime,
): ClimbEstimate {
  const { current, next } = rungAt(currentRep);
  const repNeeded = next ? Math.max(0, next.minRep - currentRep) : 0;
  if (!next || contract.rep <= 0) {
    return { from: current, to: next, repNeeded, runs: null, seconds: null, boxes: null };
  }
  const runs = Math.ceil(repNeeded / contract.rep);
  const effort = handlingEffort(contract, regime);
  return {
    from: current, to: next, repNeeded, runs,
    seconds: effort.seconds == null ? null : runs * effort.seconds,
    boxes: runs * effort.boxes,
  };
}
