/**
 * HAULING PLAN — the join that turns live contract state into something a widget can draw.
 *
 * Three landed pieces have to meet here and nowhere else:
 *   `HaulingTracker`  what the LOG knows (contracts, legs, positions, progress, ship)
 *   `HaulingDataStore` what the DATACORE knows (ship grids, per-contract SCU bounds + box caps)
 *   the solver         `partitionScu` -> `packCargo` -> `planRun`, all pure and set-agnostic
 *
 * ── 🔴 THE RULE THIS MODULE EXISTS TO ENFORCE ──────────────────────────────────────────────
 *
 * **The dataset BOUNDS a contract's load. It does not tell you it.** Measured across all 4,769
 * orders in the shipped `hauling-orders.json`: 2,062 have `minScu == maxScu` and **2,707 (57%)
 * have `minScu < maxScu`**. Sub's own 2026-08-16 contract reads `maxContainerSize: 4, minScu: 7,
 * maxScu: 16` — a 9 SCU spread on a 16 SCU haul.
 *
 * The ONE thing that pins the real number is the log's `New Objective: Deliver 0/N SCU …` line,
 * and that line is **TRACKING-GATED** — the game emits it only for a contract the player has
 * TRACKED in mobiGlas. So tracking is not a nicety, it is the primary source of truth for most
 * contracts, and `ScuSource` below is the whole point of this file: every number the widget draws
 * carries where it came from, and a range never collapses into a fake exact figure.
 *
 * ── ⚠️ AND THE SOLVER GETS THE REAL BOX TABLE ─────────────────────────────────────────────
 *
 * `cargo-boxes.ts` was written before the box set was settled, so its DEFAULT_BOX_SET still flags
 * 24 and 32 as "contested" and hardcodes x-major footprints. Both were answered by the shipped
 * data: `hauling-orders.json` carries the canonical `boxes` table (1·2·4·8·16·24·32, y-major),
 * and `maxContainerSize` is **per contract** — 24 appears ONLY in `Hauling - Interstellar`, while
 * `Hauling - Planetary` uses 1, 4, 8, 16, 32. So the set comes off the dataset and the cap comes
 * off the contract; nothing here hardcodes a size.
 */
import { partitionScu, DEFAULT_BOX_SET, type BoxSpec, type Partition } from "./cargo-boxes.js";
import { packCargo, shipCapacityScu, type GridSpec, type PackItem, type PackResult } from "./cargo-pack.js";
import { planRun, type RouteContract, type RoutePlan, type RouteStop, type Vec3 } from "./hauling-route.js";
import type { HaulingView, HaulContract, HaulStopState } from "./hauling.js";
import type { BoxSize, HaulingDataStore, Ship } from "./hauling-data.js";

/** Where a load figure came from. Rendered as a badge — never dropped. */
export type ScuSource =
  /** The game enumerated every box (`OnItemRegistered`). Exact, and the ONLY exact manifest
   *  that exists — mission-item hauls only; Covalex SCU hauls log nothing. */
  | "manifest"
  /** The tracked contract's own Deliver line. Exact, from the game. */
  | "log"
  /** The player typed it in, because they can see it in mobiGlas and we cannot. */
  | "pinned"
  /** The dataset states one figure (`minScu == maxScu`). Exact, but from the datacore. */
  | "dataset"
  /** The dataset states a SPAN. 🔴 NOT a number — `scu` is the worst case, for fit checking. */
  | "range"
  /** Neither source says anything. `scu` is null and this contract cannot be planned. */
  | "unknown";

/** Stanton's four planets, by the code the contract key writes. Confirmed by Sub, 2026-08-17.
 *
 *  🔑 This exists because the DATASET cannot answer it. `Stanton4` carries two Planet records:
 *  "microTech" and "Green". Green is not a place in the game — it is microTech's internal name
 *  left in the files, and the data says so plainly once you look: microTech has 59 children
 *  (every moon and outpost), Green has ZERO. An orphan planet is a ghost record.
 *
 *  Kept to the four planets on purpose. It disambiguates; it is not a translation table, and a
 *  code absent from here degrades to no label rather than to a guess. */
/** Seconds to move ONE box, measured off Sub's own run: he loaded Silicon + Scrap into a C2 on
 *  2026-08-17 and it took twelve minutes. The app counted 29 boxes for that load (he counted 25),
 *  which brackets 24.8–28.8 s each.
 *
 *  🔴 This replaces a flat FOUR MINUTES per stop, which was the single worst number in the widget:
 *  it made a 1-box call and a 29-box call cost the same, so every estimate for a real load was out
 *  by a factor of six. Handling dominates a hauling run — his 239 km hop costs 0.02 minutes and
 *  the load at each end costs twelve.
 *
 *  ⚠️ One player, one ship, one run. It is a far better guess than a constant that ignored the
 *  cargo entirely, and it is still a guess — the honest fix is measuring it live per player, which
 *  the log can support (see the elevator/objective bracket in the handoff). */
const SECONDS_PER_BOX = 25;
/** Approach, park, and get to the kiosk — the part of a stop that is not touching boxes. */
const STOP_BASE_MINUTES = 1;

const CANON_PLANET: Record<string, string> = {
  stanton1: "hurston",
  stanton2: "crusader",
  stanton3: "arccorp",
  stanton4: "microtech",
};

export interface PlanOptions {
  /** Ship class or display name chosen by the player; overrides whatever the log saw. */
  ship?: string | null;
  /** The hull the app's OWN ship detector saw — the same signal that drives the manufacturer skin.
   *  🔑 It is a separate signal from `view.ship`, and it is the one that actually works: on
   *  2026-08-17 the skin correctly reported "Crusader C2 Hercules Starlifter" while this planner
   *  said no ship at all, because it only ever consulted the hauling tracker's own reading.
   *  Weaker than a manual pick and than the hauling log line, so it sits last in the chain. */
  detectedShip?: string | null;
  objective?: "auec-per-hour" | "fewest-stops";
  /** The locationId the player says they are AT, so the route starts from there.
   *
   *  🔑 Without this the optimiser has no origin and is free to open anywhere, which on a pair of
   *  mirrored contracts (A→B and B→A) means a coin flip. Sub hit exactly that: standing at the
   *  ArcCorp end with both a load to collect there and one to bring back, he was told to fly to
   *  Baijini EMPTY first — a wasted leg the model could not see, because an empty opening hop
   *  costs nothing it was measuring.
   *
   *  The player supplies it because the game does not: no player-position signal has been found in
   *  the log, only mission-marker coordinates. An unknown id is ignored rather than guessed at. */
  startAt?: string | null;
  /** missionId -> total SCU the player pinned by hand. Splits evenly across that contract's legs. */
  pins?: Record<string, number>;
  /** Mission ids the player has set aside. Listed but never planned — see where openLegs is built.
   *
   *  🔑 Distinct from ABANDONED, which the game reports itself (`CompletionType[Abandon]` and
   *  `MISSION_STATE_WITHDRAWN`) and which ends the contract outright. This is the gap before that:
   *  "I have decided not to do this one", which a player knows long before mobiGlas does. */
  hidden?: string[];
  travelSpeedMps?: number;
  stopMinutes?: number;
  /** What a contract key pays and what standing it moves, from the mission dataset — the log
   *  states neither until a contract completes, and never states reputation at all.
   *  Supplied by the caller (see MissionTracker.rewardsForKey) so this module stays dataset-free
   *  apart from the hauling store it already takes. Omit and the rate block is simply absent. */
  rewards?: (contractKey: string) => { payout: number | null; payoutModelled: boolean; rep: number } | null;
  /** locationId -> the name the PLAYER gave that place. Beats the "Site N" fallback and loses to a
   *  name the game itself stated, which is the only source that cannot be a typo. */
  placeNames?: Record<string, string>;
}

export interface PlannedLeg {
  /** `objectiveKeyOf()` — pickup and drop-off of the same leg SHARE this and differ by role. */
  key: string;
  index: number;
  /** Globally unique across contracts; the packer's group id and the layout's colour key. */
  group: string;
  commodity: string | null;
  destination: string | null;
  unit: "scu" | "boxes" | "items" | null;
  /** The figure to plan with. Null only when `source === "unknown"`. */
  scu: number | null;
  min: number | null;
  max: number | null;
  source: ScuSource;
  /** False for `range` — the widget must print `min–max`, never `scu`. */
  exact: boolean;
  maxContainerScu: number | null;
  /** "dataset" = the contract declares a cap · "assumed" = no cap known, largest box used. */
  capSource: "dataset" | "assumed";
  /** Boxes to carry. ⚠️ PROVISIONAL when `boxSource === "partition"` — see partitionScu. */
  boxes: { scu: number; count: number }[];
  boxLabel: string;
  boxCount: number;
  /** "manifest" = the game listed the boxes · "partition" = we split the SCU total ourselves ·
   *  "none" = neither, so there is nothing to lay out. */
  boxSource: "manifest" | "partition" | "none";
  pickupState: HaulStopState;
  dropoffState: HaulStopState;
  delivered: number | null;
  fromLocation: string | null;
  toLocation: string | null;
}

export interface PlannedContract {
  missionId: string;
  title: string | null;
  contractKey: string;
  generator: string;
  /** From the dataset — the log never names the org or the family. */
  giver: string | null;
  missionType: string | null;
  /** The game has stated this contract's tonnage. ⚠️ NOT "the player tracked it" — see
   *  `HaulContract` in hauling.ts; conflating the two is what shipped a dead prompt. */
  deliverSeen: boolean;
  /** Selected in mobiGlas right now, live from the objective data bank. */
  trackedNow: boolean;
  /** Rank tier + size band read off the title ("Rookie" · "Extra Small"). Known at accept. */
  board: { rank: string | null; size: string | null; direct: boolean } | null;
  ended: boolean;
  completion: string | null;
  payout: number | null;
  legs: PlannedLeg[];
  /** Contract totals, rolled up from the legs. `source` is the WEAKEST of them. */
  scu: number | null;
  minScu: number | null;
  maxScu: number | null;
  source: ScuSource;
  exact: boolean;
  /** Enough is known to route and pack this one. */
  plannable: boolean;
  /** The player set this one aside. Still listed so it can be restored; never planned. */
  hidden: boolean;
}

export interface PlanStop {
  id: string;
  name: string;
  kind: "pickup" | "dropoff";
  /** Minutes to get here from the previous stop, including the flat per-stop overhead. */
  minutes: number;
  /** SCU aboard on leaving. Includes cargo already loaded before the plan was made. */
  loadAfterScu: number;
  /** Estimated minutes spent AT this stop: approach plus one lift per box. See SECONDS_PER_BOX. */
  handlingMinutes: number;
  /** True when the previous stop is the same place — one landing, two jobs. */
  sameSpot: boolean;
  /** ⚠️ `kind` is PER ACTION: one landing can unload and load, so the stop's own kind cannot
   *  describe every chip on it. */
  actions: { missionId: string; title: string | null; commodity: string | null; scu: number | null; group: string; kind: "pickup" | "dropoff" }[];
}

export interface PlanTrip {
  stops: PlanStop[];
  landings: number;
  /** Travel + handling. ⚠️ Handling dominates: travel between Sub's stops is ~0.02 min, the load
   *  at each end is ~12. A total that counted only flying was wrong by more than an order. */
  totalMinutes: number;
  travelMinutes: number;
  handlingMinutes: number;
  peakScu: number;
  method: "exact" | "heuristic";
}

export interface PlanGrid extends GridSpec {
  capacityScu: number;
  usedScu: number;
}

export interface HaulingPlan {
  updatedAt: number;
  ship: {
    className: string;
    displayName: string | null;
    totalScu: number;
    grids: PlanGrid[];
    /** "log" = the hauling log line named it · "manual" = the player picked · "detected" = the
     *  app's own ship detector (the skin's signal) resolved it · "none" = no ship known.
     *  🔑 "detected" is NOT "log": they are separate signals that disagreed on 2026-08-17, and
     *  reporting one as the other is how the next reader draws the wrong conclusion. */
    source: "log" | "manual" | "detected" | "none";
  } | null;
  contracts: PlannedContract[];
  /**
   * Live contracts whose tonnage the game has never stated, in mission order.
   *
   * 🔴 This is NOT "contracts to go and track". `trackedNow` splits it into the two states the
   * old prompt collapsed into one: a contract that is NOT tracked may still learn its figure at
   * the next assignment, while one that IS tracked has already asked and the game will not answer
   * again this session — for that one the only route to a number is the player typing it in.
   */
  untracked: { missionId: string; title: string | null; minScu: number | null; maxScu: number | null; trackedNow: boolean }[];
  /** The contract selected in mobiGlas right now, or null when none is. */
  trackedMissionId: string | null;
  trips: PlanTrip[];
  /** Contracts no single trip can carry — over capacity even alone. */
  stranded: string[];
  /** Every place any leg touches, keyed by location id — the route's own names, plus the places
   *  it deliberately does not visit, so the layout legend and the unrouted list can say where. */
  locationNames: Record<string, string>;
  /**
   * Places still wearing a "Site N" — the rows the naming box offers.
   *
   * 🔑 Only a TRACKED drop-off is ever named by the game (the Deliver line's "… to <D>"), so a
   * pickup site, or any leg the player never tracked, has no name at all and never will. This is
   * the list of things the player can answer, with the role each place plays so a row can say
   * "picking up from" instead of making them work out which Site is which.
   */
  unnamedPlaces: {
    locationId: string;
    /** "Site 3" for an un-named place, or the name you gave it. */
    label: string;
    /** The name YOU gave, or null when this place has none yet. Pre-fills the box so a wrong
     *  answer can be corrected or cleared — naming used to be one-way. */
    yours: string | null;
    role: "pickup" | "dropoff" | "both";
    commodity: string | null;
  }[];
  /** Pickups the game has already completed — cargo aboard, not yet delivered. NOT routed (there
   *  is nowhere to fly), but shown greyed ahead of the live steps so a contract reads
   *  start-to-finish instead of the list opening mid-sentence. */
  completedPickups: { group: string; missionId: string; title: string | null; locationId: string | null; scu: number | null; commodity: string | null }[];
  /** What the player asked for as an origin, and what it resolved to. Reported because "I set a
   *  start and the order did not change" has two very different causes — an ignored option, or an
   *  optimiser that genuinely sees no better order — and guessing between them costs a session. */
  startResolved: { asked: string | null; resolved: string | null };
  /** Legs that have to be carried but could not be put in a route, each with the reason. Never
   *  silently dropped: a route missing legs would look complete and be wrong. */
  unrouted: { group: string; missionId: string; title: string | null; scu: number | null; destination: string | null; toLocation: string | null; reason: string }[];
  /** Placements are only produced when a ship is known. */
  pack: PackResult | null;
  /** SCU already aboard: legs whose pickup completed but whose drop-off has not. */
  aboardScu: number;
  /**
   * What the run is earning, per hour, in both currencies the player cares about.
   *
   * 🔑 TWO RATES, NEVER BLENDED. `actual` is measured — real awards off the log against real
   * elapsed time — and is null until something has actually finished, because a rate computed from
   * an empty numerator is not a small rate, it is no rate. `projected` is what the board ahead is
   * worth against this planner's own estimated run time, and is therefore only ever as good as
   * that estimate. Sub asked for the real figure "projected if we don't actually have enough
   * data", so the widget shows `actual` when it exists and falls back to `projected`, saying which.
   *
   * ⚠️ `payoutModelled` is true when ANY contract counted here has a fitted rather than a read
   * payout. Rare on hauling (38 of 853 keys) and never silent.
   */
  rates: {
    actual: { auecPerHour: number; repPerHour: number; minutes: number; auec: number; rep: number; contracts: number } | null;
    projected: { auecPerHour: number; repPerHour: number; minutes: number; auec: number; rep: number } | null;
    payoutModelled: boolean;
  };
  totals: {
    /** SCU still to move across every live, plannable contract. */
    scu: number;
    capacityScu: number | null;
    liveContracts: number;
    /** Contracts excluded from the plan because their load is unknown. */
    unknownContracts: number;
    /** Sum of the payouts of contracts that completed in the last ten minutes. Real, from the log. */
    recentPayout: number;
    totalMinutes: number;
  };
  /** Non-fatal reasons the plan is thinner than it could be, for the widget to surface verbatim. */
  notes: string[];
}

// ── inputs ─────────────────────────────────────────────────────────────────

/**
 * The canonical box table, straight off `hauling-orders.json`.
 *
 * 🔑 The dataset's footprints are Y-MAJOR (`32 → {x:2, y:8}`) while `DEFAULT_BOX_SET` wrote them
 * X-major. That is not cosmetic: `ships.json` grids carry ASYMMETRIC `maxBox` caps — the C2's
 * small grid is `{x:6, y:8}` — so a box's axes decide whether it is legal there. The packer yaws
 * boxes itself (`orientations`), so feeding it the dataset's own orientation is both correct and
 * the only version that matches the caps it is checked against.
 */
export function boxSetFrom(boxes: Record<string, BoxSize>): readonly BoxSpec[] {
  const set = Object.values(boxes ?? {})
    .filter((b) => b && b.scu > 0)
    .map((b): BoxSpec => ({ scu: b.scu, dims: [b.x, b.y, b.z], confidence: "confirmed" }))
    .sort((a, b) => b.scu - a.scu);
  // An app running without the dataset still packs — with the pre-verdict table, which is right
  // for every size below 16 and only guesses the footprints of the two big ones.
  return set.length ? set : DEFAULT_BOX_SET;
}

/** ships.json grids -> the packer's shape. Identical fields; the name is the hardpoint. */
function gridsOf(ship: Ship): GridSpec[] {
  return ship.grids.map((g, i) => ({
    name: g.port ?? `grid ${i + 1}`,
    w: g.w,
    l: g.l,
    h: g.h,
    maxBox: g.maxBox ?? undefined,
  }));
}

/** Position -> a stable location id. Rounded to the kilometre so a marker re-emitted on spawn-in
 *  with a few metres of drift is still the same place. */
function posKey(p: Vec3 | null | undefined): string | null {
  if (!p) return null;
  return `@${Math.round(p.x / 1000)},${Math.round(p.y / 1000)},${Math.round(p.z / 1000)}`;
}

// ── resolving what a contract actually weighs ──────────────────────────────

interface Bounds {
  min: number | null;
  max: number | null;
  cap: number | null;
}

/**
 * Per-leg bounds from the dataset.
 *
 * 🔑 A contract's `orders` array is PER DESTINATION — `SingleToMulti2` carries two orders, one per
 * drop-off — so order[i] lines up with leg i whenever the counts match. When they do not (a
 * re-used template, or legs the log has not all emitted yet) fall back to the whole contract's
 * span and its widest cap, which over-states rather than invents.
 */
/** What a leg is carrying, from the datacore. Same index rule as `boundsFor`: orders line up with
 *  legs only when there are equally many, otherwise the contract has to speak with one voice — and
 *  a mixed-commodity contract has no single answer, so it gives none rather than naming the first.
 *
 *  🔑 This is knowable at ACCEPT, unlike the tonnage. The commodity is fixed by the contract; only
 *  how much of it is rolled per instance. So the widget can say WHAT before it can say HOW MUCH. */
function commodityFor(data: HaulingDataStore, contractKey: string, index: number, legCount: number): string | null {
  const orders = data.contract(contractKey)?.orders ?? [];
  if (!orders.length) return null;
  if (orders.length === legCount) return orders[index]?.commodity ?? null;
  const names = [...new Set(orders.map((o) => o.commodity).filter((c): c is string => !!c))];
  return names.length === 1 ? names[0] : null;
}

function boundsFor(data: HaulingDataStore, contractKey: string, index: number, legCount: number): Bounds {
  const contract = data.contract(contractKey);
  const orders = contract?.orders ?? [];
  if (!orders.length) return { min: null, max: null, cap: null };
  const o = orders.length === legCount ? orders[index] : null;
  if (o) {
    const min = o.minScu ?? o.minAmount ?? null;
    const max = o.maxScu ?? o.maxAmount ?? min;
    return { min, max, cap: o.maxContainerSize ?? null };
  }
  const mins = orders.map((x) => x.minScu ?? x.minAmount).filter((n): n is number => n != null);
  const maxs = orders.map((x) => x.maxScu ?? x.maxAmount ?? x.minScu).filter((n): n is number => n != null);
  return {
    min: mins.length ? Math.min(...mins) : null,
    max: maxs.length ? Math.max(...maxs) : null,
    cap: data.maxBoxScu(contractKey),
  };
}

/** The load to plan with, and where it came from. The precedence IS the honesty policy. */
function resolveScu(logNeed: number | null, pinned: number | null, b: Bounds): {
  scu: number | null; min: number | null; max: number | null; source: ScuSource; exact: boolean;
} {
  // The game's own number for a tracked contract beats everything. (A manifest beats even this,
  // but it is resolved before we get here — it is a box list, not a total.)
  if (logNeed != null) return { scu: logNeed, min: logNeed, max: logNeed, source: "log", exact: true };
  // Then what the player read off their own mobiGlas.
  if (pinned != null) return { scu: pinned, min: pinned, max: pinned, source: "pinned", exact: true };
  if (b.min == null && b.max == null) return { scu: null, min: null, max: null, source: "unknown", exact: false };
  const min = b.min ?? b.max!;
  const max = b.max ?? b.min!;
  if (min === max) return { scu: min, min, max, source: "dataset", exact: true };
  // 🔴 A RANGE. `scu` is the WORST CASE, so "does it fit" is answered safely — but `exact` is
  // false and the widget must print `min–max`. Never let this number stand alone.
  return { scu: max, min, max, source: "range", exact: false };
}

/** The weakest claim among a contract's legs decides how the contract as a whole is labelled. */
const WEAKNESS: Record<ScuSource, number> = { manifest: 0, log: 1, pinned: 2, dataset: 3, range: 4, unknown: 5 };
function weakest(sources: ScuSource[]): ScuSource {
  // No seed — seeding with a source that is not in the list floors the result at that source's
  // strength, which is how a contract with an exact manifest came back labelled "log".
  return sources.length ? sources.reduce((a, b) => (WEAKNESS[b] > WEAKNESS[a] ? b : a)) : "unknown";
}

// ── the build ──────────────────────────────────────────────────────────────

export function buildHaulingPlan(view: HaulingView, data: HaulingDataStore, opts: PlanOptions = {}): HaulingPlan {
  const notes: string[] = [];
  const hiddenIds = new Set(opts.hidden ?? []);
  const boxSet = boxSetFrom(data.boxes());
  const largestBox = boxSet.reduce((m, b) => Math.max(m, b.scu), 0);

  // ── ship ────────────────────────────────────────────────────────────────
  const picked = opts.ship?.trim() ? data.ship(opts.ship.trim()) : null;
  const fromLog = !picked && view.ship ? data.ship(view.ship.model) : null;
  // Last resort: the app's own ship detector (the one the skin uses). data.ship() matches a
  // display name as well as a class, and that detector reports display names, so this resolves.
  const fromDetector = !picked && !fromLog && opts.detectedShip?.trim()
    ? data.ship(opts.detectedShip.trim())
    : null;
  const hull = picked ?? fromLog ?? fromDetector;
  if (opts.ship?.trim() && !picked) notes.push(`"${opts.ship.trim()}" is not a hull in ships.json.`);
  if (!hull && view.ship) notes.push(`The log says you are flying ${view.ship.model}, which ships.json does not carry.`);
  const grids = hull ? gridsOf(hull) : [];
  const capacityScu = hull ? shipCapacityScu(grids) : null;

  // ── contracts ───────────────────────────────────────────────────────────
  const contracts: PlannedContract[] = [];
  const legByGroup = new Map<string, { c: HaulContract; leg: PlannedLeg }>();
  /** locationId -> the best name we have for it, learned from tracked drop-offs. */
  const nameByLoc = new Map<string, string>();
  /** locationId -> the body the contract runs on, for places the game never named. */
  const regionByLoc = new Map<string, string>();
  /** The contract key carries the region: `HaulCargo_AToB_Processed_Stims_Stanton3_SupplyGrade`.
   *  `Stanton3` is an alias locations.json already resolves — to ArcCorp — so a place the game
   *  never named can still say which world it is on. That is the difference between "Site 1" and
   *  "Site 1 · ArcCorp" for a player deciding whether it is even the planet they are standing on.
   *
   *  ⚠️ Codes also match asteroids and stations, hence the Planet filter — and `Stanton4` matches
   *  TWO planets, so the dataset cannot disambiguate it alone. Naming the wrong world is worse
   *  than naming none, because the label reads as fact. Hence CANON below, and silence for
   *  anything it does not cover. */
  const regionCache = new Map<string, string | null>();
  const regionOfKey = (contractKey: string | null | undefined): string | null => {
    if (!contractKey) return null;
    const m = /(Stanton\d+)/i.exec(contractKey);
    if (!m) return null;
    const code = m[1].toLowerCase();
    const cached = regionCache.get(code);
    if (cached !== undefined) return cached;
    const planets = data.byCode(code).filter((l) => l.type === "Planet");
    // Pick by name where Stanton is known, so an ambiguous code still resolves; otherwise only a
    // lone match is safe. Matching by name means the string we PRINT is still the dataset's own
    // spelling ("microTech"), so this table decides WHICH record, never what it is called.
    const canon = CANON_PLANET[code];
    const chosen = canon ? planets.find((l) => l.name?.toLowerCase() === canon) : undefined;
    const name = chosen?.name ?? (planets.length === 1 ? planets[0].name : null) ?? null;
    regionCache.set(code, name);
    return name;
  };

  for (const c of view.contracts) {
    const info = data.contract(c.contractKey);
    const dropoffs = c.stops.filter((s) => s.role === "dropoff").sort((a, b) => a.index - b.index);
    const pinTotal = opts.pins?.[c.missionId];
    // A pin is a CONTRACT total (it is what the mobiGlas shows), so spread it across the legs.
    // Integer split with the remainder on the first leg, so the parts still sum to the pin.
    const pinPer = pinTotal != null && dropoffs.length
      ? dropoffs.map((_, i) => Math.floor(pinTotal / dropoffs.length) + (i < pinTotal % dropoffs.length ? 1 : 0))
      : null;

    /**
     * 🔴 ONE PICKUP CAN SERVE EVERY LEG — and for `SingleToMultiN`, which is most of the board, it
     * always does.
     *
     * The game emits ONE pickup marker per contract and N drop-off markers, keyed `…#0` … `…#N`.
     * Matching a pickup by `key === drop.key` therefore finds one only for leg #0, and legs #1..#N
     * come back with no origin at all — they fall out of the route as "the log carries no pickup
     * marker for this leg".
     *
     * Sub, live, 2026-08-17, holding two `SingleToMulti4` contracts: the widget told him to collect
     * **2 SCU of Stims** when the contract is 10 SCU across four drops, and six of his eight legs
     * were listed as unroutable. He said it plainly — "it's so far off on what I'm supposed to pick
     * up I don't even know where to begin."
     *
     * 🔑 The key match stays FIRST, and the fallback is gated on the CONTRACT KEY's shape token,
     * not on "only one pickup happens to be present".
     *
     * ⚠️ That distinction is load-bearing and the test suite caught me getting it wrong. A
     * `MultiToSingle` genuinely has one pickup PER LEG, and one of Sub's live contracts on
     * 2026-08-16 carried a drop-off whose pickup marker the log never emitted. Falling back to
     * "the only pickup left" there does not recover a leg — it sends him to the wrong place, which
     * is worse than the honest "this leg has no pickup marker" the widget prints today. Only
     * `SingleToMulti*` promises, by name, that there is exactly one pickup for the whole contract.
     */
    const oneSharedPickup = /^SingleToMulti/i.test(c.contractKey.split("_")[1] ?? "");
    const pickups = c.stops.filter((s) => s.role === "pickup");
    const legs: PlannedLeg[] = dropoffs.map((drop, i) => {
      const pickup = c.stops.find((s) => s.key === drop.key && s.role === "pickup")
        ?? (oneSharedPickup && pickups.length === 1 ? pickups[0] : null);
      const b = boundsFor(data, c.contractKey, i, dropoffs.length);
      // 🔑 AN EXACT MANIFEST BEATS EVERY ESTIMATE. Mission-item hauls (recover-cargo and friends)
      // enumerate every box in the log with its SCU in the class name, so for those there is
      // nothing to model: count the boxes and sum them. This is also the only place a `boxes`-unit
      // objective becomes an SCU figure — "Deliver 0/9 Cargo Boxes" is a COUNT, and treating that
      // 9 as 9 SCU would under-report a 65 SCU load by a factor of seven.
      const manifest = c.items.filter((it) => it.dropoffKey === drop.key && it.present && it.scu != null);
      const r = manifest.length
        ? (() => {
            const total = manifest.reduce((s, it) => s + (it.scu ?? 0), 0);
            return { scu: total, min: total, max: total, source: "manifest" as ScuSource, exact: true };
          })()
        // A boxes/items objective states a COUNT, not a tonnage — so it is not an SCU input.
        : resolveScu(drop.unit === "scu" ? drop.need : null, pinPer ? pinPer[i] : null, b);
      // No declared cap means the game may hand you any size, so plan for the largest that exists
      // — an over-large box is the case that fails to fit, which is the safe direction to guess in.
      const cap = b.cap ?? (r.scu != null ? largestBox : null);
      const partition: Partition | null = !manifest.length && r.scu != null && cap != null
        ? partitionScu(r.scu, cap, boxSet)
        : null;
      const counted = new Map<number, number>();
      for (const it of manifest) counted.set(it.scu!, (counted.get(it.scu!) ?? 0) + 1);
      const boxes = manifest.length
        ? [...counted].sort((x, y) => y[0] - x[0]).map(([scu, count]) => ({ scu, count }))
        : partition ? partition.boxes.map((x) => ({ scu: x.scu, count: x.count })) : [];
      const group = `${c.missionId}#${drop.key}`;
      const from = posKey(pickup?.pos) ?? (pickup ? `${group}:from` : null);
      const to = posKey(drop.pos) ?? `${group}:to`;
      if (drop.destination && to) nameByLoc.set(to, drop.destination);
      // Both ends of a haul sit in the region its key names, so the pickup — which the game NEVER
      // names — gets the same body as the drop-off. Recorded for both; nameByLoc still wins where
      // the game gave a real name.
      const region = regionOfKey(c.contractKey);
      if (region) {
        if (from) regionByLoc.set(from, region);
        if (to) regionByLoc.set(to, region);
      }
      return {
        key: drop.key,
        index: drop.index,
        group,
        // 🔑 The LOG only names a commodity on a Deliver line, which fires when the game assigns
        // the objective — so an untracked contract showed a bare tonnage and Sub had no idea what
        // three of his five loads even were. The DATASET has known all along: the contract key is
        // in every CreateMarker line from the moment of accept, and it maps straight to a
        // commodity. All five of his contracts resolve — Stims, Silicon, Tin, Waste, Scrap.
        // The log still wins where it spoke; this only fills the silence.
        commodity: drop.commodity ?? commodityFor(data, c.contractKey, i, dropoffs.length),
        destination: drop.destination,
        unit: drop.unit,
        ...r,
        maxContainerScu: cap,
        capSource: b.cap != null ? "dataset" : "assumed",
        boxes,
        // 🔴 "12x8" reads as a BOX DIMENSION, and Sub read it that way: "what is 12 by 8? We don't
        // have any boxes that are 12 by 8." It meant twelve 8 SCU boxes. A player knows what an
        // 8 SCU box is — it has exactly one shape — so name the size and drop the geometry.
        // The unit goes on the LAST entry only, so a list stays short without becoming ambiguous.
        boxLabel: boxes.map((x, i) => `${x.count} × ${x.scu}${i === boxes.length - 1 ? " SCU" : ""}`).join(" · "),
        // The game's own box count when it stated one ("Deliver 0/9 Cargo Boxes"), so an
        // un-manifested item haul still shows how many boxes are coming.
        boxCount: boxes.length ? boxes.reduce((s, x) => s + x.count, 0)
          : drop.unit === "boxes" || drop.unit === "items" ? drop.need ?? 0 : 0,
        boxSource: manifest.length ? "manifest" : partition ? "partition" : "none",
        pickupState: pickup?.state ?? "pending",
        dropoffState: drop.state,
        delivered: drop.delivered,
        fromLocation: from,
        toLocation: to,
      };
    });

    const sources = legs.map((l) => l.source);
    const total = legs.every((l) => l.scu != null) ? legs.reduce((s, l) => s + (l.scu ?? 0), 0) : null;
    const src = legs.length ? weakest(sources) : "unknown";
    const planned: PlannedContract = {
      missionId: c.missionId,
      title: c.title,
      contractKey: c.contractKey,
      generator: c.generator,
      giver: info?.giver ?? null,
      missionType: info?.missionType ?? null,
      deliverSeen: c.deliverSeen,
      trackedNow: c.trackedNow,
      board: c.board,
      ended: c.endedAt != null,
      completion: c.completion,
      payout: c.payout,
      legs,
      scu: total,
      minScu: legs.every((l) => l.min != null) ? legs.reduce((s, l) => s + (l.min ?? 0), 0) : null,
      maxScu: legs.every((l) => l.max != null) ? legs.reduce((s, l) => s + (l.max ?? 0), 0) : null,
      source: src,
      exact: src === "manifest" || src === "log" || src === "pinned" || src === "dataset",
      plannable: total != null && c.endedAt == null,
      hidden: hiddenIds.has(c.missionId),
    };
    contracts.push(planned);
    for (const leg of legs) legByGroup.set(leg.group, { c, leg });
  }

  // ── what is still to be flown ───────────────────────────────────────────
  // A leg whose drop-off has completed is done and gone. A leg whose PICKUP completed is already
  // in the hold: it still has to be packed and delivered, but there is nothing left to fly TO for
  // its pickup, so it contributes no visit — only load. That is `aboardScu`.
  // 🔴 A CONTRACT THE PLAYER HAS SET ASIDE IS NOT PART OF THE RUN. The game already removes an
  // ABANDONED contract for us (`CompletionType[Abandon]` / `MISSION_STATE_WITHDRAWN` both end it),
  // but a player often decides to skip one long before they get round to abandoning it in mobiGlas
  // — and until they do, it drags the route and the hold around with it.
  // Hidden contracts stay in `contracts` flagged, so the widget can list and restore them; they are
  // simply not part of anything that plans.
  const openLegs = contracts
    .filter((c) => c.plannable && !c.hidden)
    .flatMap((c) => c.legs.filter((l) => l.dropoffState !== "completed" && l.scu != null).map((leg) => ({ c, leg })));
  const aboardScu = openLegs
    .filter(({ leg }) => leg.pickupState === "completed")
    .reduce((s, { leg }) => s + (leg.scu ?? 0), 0);

  // Positions come from the marker that named the location, so the map is built from the legs
  // rather than a dataset — locations.json has no coordinates and its markerXyz table is empty.
  const posByLoc = new Map<string, Vec3>();
  for (const c of view.contracts) {
    for (const s of c.stops) {
      const k = posKey(s.pos);
      if (k && s.pos && !posByLoc.has(k)) posByLoc.set(k, s.pos);
    }
  }

  /**
   * Build the visits by hand rather than through `buildStops`, because that helper assumes every
   * leg is a pickup AND a drop-off — and two real cases are not:
   *
   *  • **Cargo already in the hold.** Its pickup objective has COMPLETED, so there is nothing left
   *    to fly to for it; the drop-off still has to happen. Emitting the pickup visit anyway would
   *    route the player back to a warehouse they have already emptied.
   *  • **A leg the log gave no pickup marker for.** It happens — one of Sub's own live contracts
   *    has a drop-off marker with no matching pickup. Its drop-off is still a place you must go.
   *
   * A drop-off with no pickup simply has no precedence constraint, which is correct: the optimiser
   * is free to put it anywhere. Its load goes NEGATIVE in the raw model, and that is deliberate —
   * see `freeCapacity` and `loadAfterScu`, where `aboardScu` is added back to make both exact.
   */
  const stopById = new Map<string, RouteStop>();
  const visit = (locationId: string, kind: "pickup" | "dropoff"): RouteStop => {
    const id = `${locationId}:${kind}`;
    let s = stopById.get(id);
    if (!s) {
      s = { id, locationId, name: locationId, pos: posByLoc.get(locationId) ?? null, actions: [] };
      stopById.set(id, s);
    }
    return s;
  };
  /** Legs that must be carried but cannot be put in a route — reported, never dropped. */
  const unrouted: { group: string; missionId: string; title: string | null; scu: number | null; destination: string | null; toLocation: string | null; reason: string }[] = [];
  const routeGroups = new Set<string>();
  /** Drop-offs, held back until every pickup node exists — see where they are pushed. */
  const pendingDrops: { leg: PlannedLeg; stillToLoad: boolean }[] = [];
  /** Pickups the game has already completed: display-only, never routed. */
  const completedPickups: { group: string; missionId: string; title: string | null; locationId: string | null; scu: number | null; commodity: string | null }[] = [];
  for (const { c, leg } of openLegs) {
    if (!leg.toLocation) {
      unrouted.push({ group: leg.group, missionId: c.missionId, title: c.title, scu: leg.scu, destination: leg.destination, toLocation: leg.toLocation, reason: "the log has not placed this drop-off yet" });
      continue;
    }
    const stillToLoad = leg.pickupState !== "completed";
    if (stillToLoad && !leg.fromLocation) {
      unrouted.push({ group: leg.group, missionId: c.missionId, title: c.title, scu: leg.scu, destination: leg.destination, toLocation: leg.toLocation, reason: "the log carries no pickup marker for this leg — check mobiGlas for where to load it" });
      continue;
    }
    if (stillToLoad) {
      visit(leg.fromLocation!, "pickup").actions.push({ contractId: leg.group, kind: "pickup", scu: leg.scu ?? 0, commodity: leg.commodity ?? undefined });
    } else {
      // 🔴 A DONE PICKUP IS STILL PART OF THE STORY. It is not a place to fly to — the cargo is
      // already aboard — so it stays out of the router. But dropping it from the DISPLAY made the
      // list open mid-sentence: Sub, holding Stims he had just loaded at Riker, saw a route that
      // began at Baijini and could not see that the app knew about the leg at all.
      // Shown greyed, ahead of the live steps, so the contract reads start-to-finish and the
      // interim state (collected, not yet delivered) is visible rather than inferred.
      completedPickups.push({
        group: leg.group,
        missionId: c.missionId,
        title: c.title,
        locationId: leg.fromLocation,
        scu: leg.scu,
        commodity: leg.commodity ?? null,
      });
    }
    // 🔴 CARGO ALREADY IN THE HOLD HAS NOWHERE TO WAIT. Its pickup is done, so its drop-off has no
    // prerequisite — the moment the player is standing at that place, it comes off. Keeping it on a
    // separate `:dropoff` node let the solver schedule a SECOND visit to a place it had already
    // sent him to: Sub sat at Riker holding 101 SCU for Baijini, was routed to Baijini at step 1 to
    // LOAD, and told to drop the Stims at step 5 — same place, four stops later, hauling them
    // around the whole loop for nothing.
    // Folding it onto the pickup node at that location makes it ONE landing: arrive, unload what
    // you brought, load what you came for. Safe because a prerequisite-free drop-off adds no
    // precedence, so the merged node keeps the pickup's (a pickup never has any). ⚠️ Only ever for
    // an already-loaded leg — merging a leg still awaiting its pickup would create the classic
    // A→B/B→A deadlock, where each location must precede the other.
    // ⚠️ DEFERRED to a second pass. Whether this drop-off can join a pickup at the same place
    // depends on a node that a LATER leg may not have created yet — deciding it inline made the
    // merge depend on contract order, so it silently did nothing when the aboard leg happened to
    // be first, which is exactly the case it exists for.
    pendingDrops.push({ leg, stillToLoad });
    routeGroups.add(leg.group);
  }

  // Second pass: every pickup node now exists, so an already-loaded leg can be folded onto the
  // landing the player is going to make anyway.
  for (const { leg, stillToLoad } of pendingDrops) {
    const node = !stillToLoad && stopById.has(`${leg.toLocation}:pickup`)
      ? visit(leg.toLocation!, "pickup")
      : visit(leg.toLocation!, "dropoff");
    node.actions.push({ contractId: leg.group, kind: "dropoff", scu: leg.scu ?? 0, commodity: leg.commodity ?? undefined });
  }

  const routeContracts: RouteContract[] = [...routeGroups].map((id) => ({ id, payout: 0 }));
  const stops = [...stopById.values()];
  // 🔑 The hold that is still FREE. Cargo already aboard cannot be unloaded to make room for a
  // pickup, so planning against the full rating would happily overfill a part-loaded ship.
  const freeCapacity = capacityScu != null ? Math.max(0, capacityScu - aboardScu) : undefined;
  // Where the player says they are. Only a place the route already touches can be an origin — an
  // id we have no coordinates for would silently become "anywhere", which is the bug, not the fix.
  const startPos = opts.startAt ? posByLoc.get(opts.startAt) ?? null : null;
  // Reported so a wrong route can be told apart from an ignored origin. "I asked for X and the
  // order did not change" has two very different causes, and guessing between them wastes a
  // session — as it did on 2026-08-17.
  const startResolved = { asked: opts.startAt ?? null, resolved: posKey(startPos) };
  const run = stops.length
    ? planRun(stops, routeContracts, {
        objective: opts.objective ?? "auec-per-hour",
        capacityScu: freeCapacity,
        travelSpeedMps: opts.travelSpeedMps,
        // ⚠️ ZERO, deliberately. The solver's flat per-stop allowance is now modelled properly as
        // handling (one lift per box — see SECONDS_PER_BOX), and leaving both in counted every stop
        // twice: Sub's board reported 12 minutes of "travel" for 0.2 minutes of actual flying.
        // The route's own total is pure travel; handling is added on top in toTrip.
        stopMinutes: opts.stopMinutes ?? 0,
        startPos,
      })
    : { trips: [], stranded: [], totalMinutes: 0, payout: 0, auecPerHour: 0 };

  // ── name the visits ─────────────────────────────────────────────────────
  // Only a TRACKED drop-off carries a real place name (the Deliver line's "… to <D>"), and marker
  // XYZ resolves to nothing — locations.json ships no coordinates and its markerXyz table is
  // empty. So an unnamed place is numbered in the order it first appears.
  //
  // 🔑 The number is per LOCATION and the label is neutral. Labelling it by the visit's role gave
  // "Drop-off at Pickup 1" the moment a place was used for both, which is the normal case: Sub's
  // board runs Baijini -> Riker and Riker -> Baijini at the same time.
  const fallback = new Map<string, string>();
  /** Places still wearing a "Site N" — what the widget offers the player to name. */
  const unnamed = new Map<string, string>();
  const byPlayer = opts.placeNames ?? {};
  const nameOf = (locationId: string): string => {
    const known = nameByLoc.get(locationId);
    if (known) return known;
    // 🔑 The player's own answer outranks the numbered fallback and is outranked by the game's own
    // Deliver line — that one cannot be a typo, and re-asking about a place the game has since
    // named would be the widget forgetting something it was told.
    const mine = byPlayer[locationId]?.trim();
    if (mine) return mine;
    let label = fallback.get(locationId);
    if (!label) {
      // ⛔ NO REGION SUFFIX. This briefly read "Site 1 · ArcCorp", taken from the contract key's
      // `Stanton3` token — and it was WRONG. A contract's region is not the body a given stop sits
      // on: that stop is Samson & Son's Salvage Center, on WALA, a moon you quantum to. Sub read
      // "ArcCorp" as "somewhere I can drive to" and it would have cost him a trip.
      // 🔑 The key bounds where a contract operates; only the stop itself knows where it is. An
      // honest "Site 1" invites the question. A confident wrong planet answers it falsely.
      label = `Site ${fallback.size + 1}`;
      fallback.set(locationId, label);
      unnamed.set(locationId, label);
    }
    return label;
  };

  const trips: PlanTrip[] = run.trips.map((trip) => toTrip(trip, stops, legByGroup, nameOf, aboardScu));
  // Name every place any leg touches, not only the ones a trip visits — the layout legend and the
  // unrouted list both point at places that are deliberately absent from the route, and "drop-off"
  // is not a place. Named AFTER the trips so the route gets the low numbers, in flying order.
  for (const { leg } of openLegs) {
    if (leg.fromLocation) nameOf(leg.fromLocation);
    if (leg.toLocation) nameOf(leg.toLocation);
  }
  const locationNames: Record<string, string> = {};
  for (const [id, name] of nameByLoc) locationNames[id] = name;
  for (const [id, name] of Object.entries(byPlayer)) if (name.trim()) locationNames[id] ??= name.trim();
  for (const [id, name] of fallback) locationNames[id] ??= name;
  // What the naming box offers. Role comes from how the legs actually use the place, so the row
  // can say "picking up from" rather than making the player work out which Site is which.
  const roleOf = new Map<string, "pickup" | "dropoff" | "both">();
  const noteRole = (id: string | null, role: "pickup" | "dropoff") => {
    if (!id) return;
    const had = roleOf.get(id);
    roleOf.set(id, !had || had === role ? role : "both");
  };
  const cargoAt = new Map<string, string>();
  for (const { leg } of openLegs) {
    noteRole(leg.fromLocation, "pickup");
    noteRole(leg.toLocation, "dropoff");
    if (leg.commodity) {
      if (leg.fromLocation) cargoAt.set(leg.fromLocation, leg.commodity);
      if (leg.toLocation) cargoAt.set(leg.toLocation, leg.commodity);
    }
  }
  /**
   * 🔴 A NAME YOU GAVE MUST STAY EDITABLE. Naming was one-way: the moment a place got a name it
   * dropped out of this list, the row disappeared, and there was no way to correct or clear it.
   * Sub named five different Corundum sites "Everus Harbor" — the rows were indistinguishable
   * before the SingleToMulti fix let them say which one you LOAD at — and then asked, reasonably,
   * "how do I undo that".
   *
   * So the list carries both: places with no name yet, and places YOU named, pre-filled and
   * clearable. A place the GAME named is not offered — that name is authoritative and re-asking
   * about it would invite exactly the kind of wrong answer this is here to fix.
   */
  const namable = [...unnamed].map(([locationId, label]) => ({
    locationId, label, yours: null as string | null,
    role: roleOf.get(locationId) ?? ("dropoff" as const),
    commodity: cargoAt.get(locationId) ?? null,
  }));
  for (const [locationId, given] of Object.entries(byPlayer)) {
    const name = given.trim();
    // Skip anything the game has since named itself, and anything not on this board.
    if (!name || nameByLoc.has(locationId) || !roleOf.has(locationId)) continue;
    namable.push({
      locationId, label: name, yours: name,
      role: roleOf.get(locationId) ?? ("dropoff" as const),
      commodity: cargoAt.get(locationId) ?? null,
    });
  }
  const unnamedPlaces = namable;
  for (const u of unrouted) u.destination ??= u.toLocation ? locationNames[u.toLocation] ?? null : null;

  // 🔑 `planRun` gives up quietly: when no trip can be formed for what is left in the pool it
  // breaks out of its loop, and those contracts appear in neither `trips` nor `stranded`. A route
  // that is missing legs while claiming to be the route is the worst thing this widget could do,
  // so anything that went in and did not come out is reported.
  const routed = new Set(trips.flatMap((t) => t.stops.flatMap((s) => s.actions.map((a) => a.group))));
  for (const { c, leg } of openLegs) {
    if (!routeGroups.has(leg.group) || routed.has(leg.group)) continue;
    unrouted.push({
      group: leg.group, missionId: c.missionId, title: c.title, scu: leg.scu, destination: leg.destination,
      toLocation: leg.toLocation, reason: "no trip could be planned that carries this leg",
    });
  }

  // ── layout ──────────────────────────────────────────────────────────────
  // 🔴 THE HOLD IS A MOMENT, NOT A TRIP. This used to pack every undelivered leg at once, on the
  // theory that the layout answers "where does it all go". It does not: Sub is carrying Stims he
  // will have handed over before he ever touches the Waste, so a diagram containing both describes
  // a hold that never exists. In his words — "showing me how to load the ship if I picked up
  // everything doesn't really help me, because the stems will be gone by the time I pick up those
  // other things."
  //
  // So the layout is the CURRENT hold: legs collected and not yet delivered. It advances on its own
  // as the game completes objectives, which is the same signal the route already reads.
  //
  // When the hold is empty there is nothing to draw and the player is usually standing at a
  // warehouse about to load — so it looks ahead to the next pickup instead and says so, rather
  // than showing a blank grid at the exact moment the answer is wanted.
  const aboardLegs = openLegs.filter(({ leg }) => leg.pickupState === "completed");
  const nextPickupGroups = new Set<string>();
  outer: for (const trip of trips) {
    for (const s of trip.stops) {
      const picks = s.actions.filter((a) => a.kind === "pickup");
      if (!picks.length) continue;
      for (const a of picks) nextPickupGroups.add(a.group);
      break outer;   // only the FIRST loading stop — the one being flown to
    }
  }
  const layoutLegs = aboardLegs.length
    ? aboardLegs
    : openLegs.filter(({ leg }) => nextPickupGroups.has(leg.group));
  const layoutIsNext = !aboardLegs.length && layoutLegs.length > 0;

  const items: PackItem[] = [];
  let undrawable = 0;
  for (const { leg } of layoutLegs) {
    let n = 0;
    for (const b of leg.boxes) {
      // A manifest can name a size the box table does not carry (the fractional 1/8, 1/4 and 1/2
      // SCU classes in the engine's enum, for one). It cannot be drawn without a footprint, so it
      // is counted and reported rather than quietly missing from the layout.
      const spec = boxSet.find((s) => s.scu === b.scu);
      if (!spec) { undrawable += b.count; continue; }
      for (let i = 0; i < b.count; i++) items.push({ id: `${leg.group}#${n++}`, scu: spec.scu, dims: spec.dims, group: leg.group });
    }
  }
  if (undrawable) notes.push(`${undrawable} boxes are a size the box table has no footprint for, so they are missing from the layout.`);
  // 🔴 YOU CANNOT LOAD WHAT YOU HAVE NOT COLLECTED. This was the drop-off order alone, which reads
  // the hold correctly (first drop nearest the ramp) but told Sub to load his Waste FIRST — cargo
  // he picks up at the fifth stop, on a moon he has not flown to yet. A stow order that opens with
  // a box you do not have is not an instruction, it is a puzzle.
  //
  // So: collection order first, and only then depth. Everything gathered at the first pickup is
  // loaded before anything gathered at the second, and WITHIN one pickup the load dropped LAST
  // goes in deepest — which is the ramp rule, now applied where it actually holds.
  const pickupAt = new Map<string, number>();
  const dropAt = new Map<string, number>();
  let seq = 0;
  for (const trip of trips) {
    for (const s of trip.stops) {
      for (const a of s.actions) {
        const at = seq++;
        if (a.kind === "pickup") { if (!pickupAt.has(a.group)) pickupAt.set(a.group, at); }
        else if (!dropAt.has(a.group)) dropAt.set(a.group, at);
      }
    }
  }
  // Cargo already aboard was collected before the route begins, so it is deepest of all — it went
  // in first and everything loaded since sits on top of it.
  /* 🔴 THIS IS UNLOAD ORDER, AND THE DISTINCTION COST SUB A RUN.
     `packCargo` fills from the door outward, so groupOrder[0] is the load that ends up NEAREST THE
     DOOR — the one coming off FIRST. Feeding it load order instead put his Scrap at the ramp and
     his Silicon behind it, and Scrap drops LAST: he unloaded at Riker, handed over the wrong
     cargo, and had to dig for the right one. "So it told me to do it backwards."

     Two rules, and the physical one wins:
       1. COLLECTION. You load through the door, so whatever you collect LAST necessarily sits
          nearest it. Cargo picked up later cannot be buried under cargo picked up earlier — hence
          pickup order DESCENDING. Cargo already aboard was collected before everything, so it is
          deepest of all.
       2. DELIVERY. Within one collection stop the choice is free, so the load dropped FIRST goes
          nearest the door — drop order ASCENDING.

     Sub's board: both collected at the same stop, so rule 2 decides, and Silicon (dropped at Riker,
     first) belongs at the ramp with Scrap (Wala, second) behind it. */
  const groupOrder = [...new Set([...pickupAt.keys(), ...dropAt.keys()])].sort((a, b) => {
    const pa = pickupAt.get(a) ?? -1, pb = pickupAt.get(b) ?? -1;
    if (pa !== pb) return pb - pa;                                    // collected later → nearer the door
    return (dropAt.get(a) ?? 0) - (dropAt.get(b) ?? 0);               // dropped first → nearer the door
  });
  const pack = hull ? packCargo(grids, items, { groupOrder }) : null;

  if (!hull) notes.push("Pick the ship you are flying to see where the boxes go.");
  if (layoutIsNext) notes.push("Your hold is empty — this is what to load at your next pickup.");
  if (pack && !pack.fits) notes.push(`${pack.unplaced.length} boxes do not fit — this is more than one trip.`);
  const rangeCount = contracts.filter((c) => !c.ended && c.source === "range").length;
  if (rangeCount) {
    // ⚠️ This used to end "Track them in mobiGlas to pin the real load." That is the same false
    // advice the widget's prompt carried until 4c195d2: the Deliver line fires on objective
    // ASSIGNMENT, and re-tracking never replays it, so tracking cannot pin anything. Typing the
    // figure in is the only action left to the player.
    notes.push(`${rangeCount} contract${rangeCount > 1 ? "s" : ""} planned at the TOP of the dataset's range. Type the real load in to pin ${rangeCount > 1 ? "them" : "it"}.`);
  }

  const liveContracts = contracts.filter((c) => !c.ended);
  const rates = buildRates(view, liveContracts, trips.reduce((n, t) => n + t.totalMinutes, 0), opts.rewards);
  return {
    updatedAt: view.updatedAt,
    ship: hull
      ? {
          className: hull.className,
          displayName: hull.displayName,
          totalScu: hull.totalScu,
          grids: grids.map((g) => ({
            ...g,
            capacityScu: g.w * g.l * g.h,
            usedScu: pack?.byGrid.find((u) => u.grid === g.name)?.usedScu ?? 0,
          })),
          // ⚠️ This was `picked ? "manual" : "log"`, which stamped ANY non-manual hull as "log".
          // On 2026-08-17 that told Sub the log had named his C2 while view.ship was null — the
          // app asserting a provenance it did not have, and he reasonably believed it.
          source: picked ? "manual" : fromLog ? "log" : "detected",
        }
      : null,
    contracts,
    untracked: liveContracts
      .filter((c) => !c.deliverSeen)
      .map((c) => ({ missionId: c.missionId, title: c.title, minScu: c.minScu, maxScu: c.maxScu, trackedNow: c.trackedNow })),
    trackedMissionId: view.trackedMissionId,
    trips,
    stranded: run.stranded,
    locationNames,
    unnamedPlaces,
    completedPickups,
    startResolved,
    unrouted,
    pack,
    aboardScu,
    rates,
    totals: {
      scu: openLegs.reduce((s, { leg }) => s + (leg.scu ?? 0), 0),
      capacityScu,
      liveContracts: liveContracts.length,
      unknownContracts: liveContracts.filter((c) => c.scu == null).length,
      recentPayout: contracts.reduce((s, c) => s + (c.payout ?? 0), 0),
      // 🔴 Travel AND handling. This read `run.totalMinutes` — the router's own figure, which is
      // flying time only. Since travel between Sub's stops is ~0.2 minutes, the widget's headline
      // "est. run" said 1m for every board he ever loaded, no matter how many boxes were on it.
      // The work is the boxes: the same run estimates 27 minutes once they are counted.
      totalMinutes: trips.reduce((n, t) => n + t.totalMinutes, 0),
    },
    notes,
  };
}

/**
 * aUEC and reputation per hour — measured where it can be, projected where it cannot.
 *
 * 🔴 THE TWO NUMBERS COME FROM DIFFERENT PLACES AND MUST NOT BE AVERAGED TOGETHER.
 *   - aUEC EARNED is real: the game logs `Awarded N aUEC` and the tracker has already paired each
 *     award with the completion it belongs to.
 *   - REPUTATION is never logged in any form — searching a live session finds only the name of the
 *     gRPC service. It comes from the dataset, keyed by contract, where 839 of the 853 `HaulCargo`
 *     keys carry it and it is read from the game files rather than fitted.
 *   - aUEC AHEAD is dataset too, and that one is fitted for 38 of the 853 keys, which is why
 *     `payoutModelled` exists. Checked against Sub's own finished contract on 2026-08-17 the
 *     dataset said 62,000 and the log's award was 62,000.
 *
 * Elapsed time is the LOG's clock, not the wall clock, so an app reading a stale file cannot claim
 * a rate for time that has not happened.
 */
function buildRates(
  view: HaulingView,
  liveContracts: readonly PlannedContract[],
  plannedMinutes: number,
  rewards?: (contractKey: string) => { payout: number | null; payoutModelled: boolean; rep: number } | null,
): HaulingPlan["rates"] {
  let modelled = false;
  const lookup = (key: string) => {
    const r = rewards?.(key) ?? null;
    if (r?.payoutModelled) modelled = true;
    return r;
  };

  // ── measured ───────────────────────────────────────────────────────────────
  let actual: HaulingPlan["rates"]["actual"] = null;
  const elapsedMin = view.runStartedAt != null ? (view.updatedAt - view.runStartedAt) / 60_000 : 0;
  // 🔑 A minute of elapsed time is the floor. Two contracts completing in the same second is a
  // real thing (Sub delivers a mixed hold in one lift), and dividing by ~0 would report millions
  // of aUEC an hour — a number that is arithmetically correct and a lie about the run.
  if (view.finished.length && elapsedMin >= 1) {
    const auec = view.finished.reduce((s, f) => s + (f.payout ?? 0), 0);
    const rep = view.finished.reduce((s, f) => s + (lookup(f.contractKey)?.rep ?? 0), 0);
    actual = {
      auec, rep, minutes: elapsedMin, contracts: view.finished.length,
      auecPerHour: auec / (elapsedMin / 60),
      repPerHour: rep / (elapsedMin / 60),
    };
  }

  // ── projected ──────────────────────────────────────────────────────────────
  // Only what is actually going to be flown: a contract the player set aside, or one whose load is
  // unknown, is not in the route and must not be in the rate the route is judged by.
  let projected: HaulingPlan["rates"]["projected"] = null;
  const ahead = liveContracts.filter((c) => c.plannable && !c.hidden);
  if (ahead.length && plannedMinutes > 0) {
    let auec = 0, rep = 0;
    for (const c of ahead) {
      const r = lookup(c.contractKey);
      auec += r?.payout ?? 0;
      rep += r?.rep ?? 0;
    }
    projected = {
      auec, rep, minutes: plannedMinutes,
      auecPerHour: auec / (plannedMinutes / 60),
      repPerHour: rep / (plannedMinutes / 60),
    };
  }

  return { actual, projected, payoutModelled: modelled };
}

/** One RoutePlan -> the stop list the widget draws, with names and per-stop actions. */
function toTrip(
  trip: RoutePlan,
  stops: readonly RouteStop[],
  legByGroup: Map<string, { c: HaulContract; leg: PlannedLeg }>,
  nameOf: (locationId: string) => string,
  aboardScu: number,
): PlanTrip {
  const byId = new Map(stops.map((s) => [s.id, s]));
  const out: PlanStop[] = trip.order.map((id, i) => {
    const stop = byId.get(id);
    const leg = trip.legs[i];
    // 🔴 What HAPPENS here, not which node this grew from. Once an already-loaded leg is folded
    // onto a pickup landing, the node id still ends ":pickup" while the stop's real job is to
    // unload first and then load. Sub read "1. pick up at Baijini" while sitting on 101 SCU bound
    // for Baijini, and the label was the only thing wrong — the plan underneath was right.
    // Drop-offs lead: that is the order at a freight elevator, and it is what the solver models.
    const acts = byId.get(id)?.actions ?? [];
    const kind: "pickup" | "dropoff" = acts.some((a) => a.kind === "dropoff") ? "dropoff" : "pickup";
    const locationId = stop?.locationId ?? id;
    return {
      id,
      name: nameOf(locationId),
      kind,
      minutes: leg?.minutes ?? 0,
      /* 🔴 THE STOP IS THE JOB. Every box at this stop is one lift, and a lift takes about
         SECONDS_PER_BOX. A stop that moves 29 boxes is not the same stop as one that moves 1, and
         a flat rate said it was. Base covers approach, park and reaching the kiosk. */
      handlingMinutes: STOP_BASE_MINUTES + (stop?.actions ?? [])
        .reduce((n, a) => n + (legByGroup.get(a.contractId)?.leg.boxCount ?? 0), 0) * SECONDS_PER_BOX / 60,
      // Cargo already in the hold rides along the whole trip, so it belongs in every reading.
      loadAfterScu: (leg?.loadAfterScu ?? 0) + aboardScu,
      sameSpot: (leg?.minutes ?? 1) === 0,
      actions: (stop?.actions ?? []).map((a) => {
        const found = legByGroup.get(a.contractId);
        return {
          missionId: found?.c.missionId ?? a.contractId,
          title: found?.c.title ?? null,
          commodity: a.commodity ?? null,
          scu: a.scu,
          group: a.contractId,
          // Per-action, because one stop can do both and the widget must be able to say which
          // chip is a load and which is a drop.
          kind: a.kind,
        };
      }),
    };
  });
  // The trip's own figure counts travel only. Handling is what a hauling run is actually made of,
  // so it is added here rather than left as a per-stop detail nobody sums.
  const handling = out.reduce((n, s) => n + s.handlingMinutes, 0);
  return {
    stops: out,
    landings: trip.stops,
    totalMinutes: trip.totalMinutes + handling,
    travelMinutes: trip.totalMinutes,
    handlingMinutes: handling,
    peakScu: trip.peakScu + aboardScu,
    method: trip.method,
  };
}
