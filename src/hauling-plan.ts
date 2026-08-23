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
import { canAutoLoad, rankAutoLoads } from "./hauling-autoload.js";
import { boundsFor, commodityFor, resolveScu, weakest, type ScuSource } from "./hauling-scu.js";
import { CANON_PLANET, matchLocationToken, posKey } from "./hauling-locations.js";
import { buildRates } from "./hauling-rates.js";
import type { CommodityBuy } from "./hauling-buys.js";

/**
 * The location-id namespace commodity stops live in.
 *
 * 🔴 CONTRACT STOPS ARE KEYED BY MARKER COORDINATES (`posKey`, "@x,y,z") and a commodity terminal
 * has no marker — it comes from the price table, which knows names and bodies and no coordinates
 * at all. Two id namespaces in one route is the trap `references/travel.md` records as making every
 * precise fix look self-contradictory, so this prefix exists to make the split VISIBLE rather than
 * accidental: an id starting with it can never collide with a marker key, and anything that reads
 * a position from one is asking the wrong question.
 *
 * The two namespaces are reconciled by NAME, through the same `canonById` merge the contract stops
 * already use for two markers at one spaceport — see where buy names are seeded into it.
 */
const BUY_LOC = "buy:";
/** The route group id for a picked buy. Prefixed for the same reason as the location id. */
const buyGroup = (id: string): string => "buyleg:" + id;

/** Re-exported so nothing that already reads a plan's provenance has to learn a new module.
 *  The policy itself lives in hauling-scu.ts. */
export type { ScuSource };

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
  /** Where the player is, when the caller has better evidence than `view.atLocation` alone — it
   *  binds the game's numeric location ids to readable tokens, which this module cannot do because
   *  the binding has to persist. See haulingWhereAmI in overlay-server. */
  atLocation?: { token: string; at: number } | null;
  /**
   * The player's position in the PLANET-FIXED frame, read off the debug overlay on demand.
   *
   * 🔑 This is the same coordinate space every mission marker uses, so it needs no name join at
   * all — it snaps to the nearest stop by distance. That makes it the strongest position signal
   * available: the terminal tokens say which SITE you last touched, this says where you ARE.
   */
  atPos?: { x: number; y: number; z: number; at: number } | null;
  /** How near a marker a read must land to count as that place, in metres. */
  snapMetres?: number;
  /**
   * Commodity runs the player picked in the Commodities tab, to be SEQUENCED into the same route
   * as the contracts. See `hauling-buys.ts` for the two rules that govern them.
   *
   * 🔴 THEY ARE NOT RANKED AGAINST THE CONTRACTS, here or anywhere. Route sequences what was
   * already chosen; the choosing happened in two separate tabs against two separate yardsticks,
   * which is Sub's explicit design ("you'll do the contracts and then you'll pick up commodities as
   * more of an opportunistic approach"). Nothing in this file gives a buy a payout, so nothing can
   * accidentally start weighing one against the other.
   *
   * 🔴 A BUY WITH NO `scu` YET IS ROUTED AS NO LOAD. That is not a zero: `hauling-route.ts` reports
   * `unknownScu` for any trip carrying one, and this module passes that on so the widget can say
   * the hold figures are a floor rather than a measurement.
   */
  buys?: readonly CommodityBuy[];
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
  /** Which pickup of a multi-pickup contract this leg is, and how many there are. Absent for the
   *  ordinary one-pickup case. See the MORE PICKUPS THAN DROP-OFFS note. */
  pickupIndex?: number;
  pickupCount?: number;
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
  /** The PLACE. `id` is the node ("<place>:pickup"), so anything remembering something about where
   *  the player is standing — a name they gave it — must key on this, not on `id`. */
  locationId: string;
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
  /**
   * 🔴 TRUE WHEN THIS TRIP CARRIES A COMMODITY BUY THE PLAYER HAS NOT MADE YET, which makes
   * `peakScu` and every stop's `loadAfterScu` a FLOOR rather than a figure. A widget that prints
   * either without saying so is telling the player their hold is emptier than it will be.
   * Always false for a contract-only run: a contract states its tonnage or is excluded outright.
   */
  unknownScu: boolean;
  method: "exact" | "heuristic";
}

/** A commodity run the player picked, as the route sees it. */
export interface PlannedBuy {
  id: string;
  /** The route group id, so the widget can find this buy's actions on a stop. Null when the run
   *  could not be routed at all. */
  group: string | null;
  commodity: string;
  resourceGuid: string | null;
  from: { terminal: string; body: string | null; system: string | null; locationId: string | null };
  to: { terminal: string; body: string | null; system: string | null; locationId: string | null };
  /** The quote the player picked it off, aUEC/SCU. A forecast off crowd-reported prices — shown so
   *  the row says what it was, never fed to the solver and never presented as a takings figure. */
  buyPrice: number | null;
  sellPrice: number | null;
  /** 🔴 NULL until the log has seen the purchase. Not a guess, not a zero, and not something the
   *  player is asked for. See hauling-buys.ts. */
  scu: number | null;
  boughtAt: string | null;
  shopName: string | null;
  /** In the route. False carries a `reason`. */
  routed: boolean;
  reason: string | null;
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
   * Commodity runs the player picked in the Commodities tab, sequenced into the same route as the
   * contracts — never ranked against them. Empty for a player who has picked none, which keeps a
   * contract-only board byte-identical to what it was before this existed.
   */
  buys: PlannedBuy[];
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
  completedPickups: {
    group: string; missionId: string; title: string | null; locationId: string | null;
    scu: number | null; commodity: string | null;
    /** 🔴 "onPad" = the game released it to the freight lift and you are STILL THERE, so it is not
     *  in the ship yet. "aboard" = you have since moved, so it came with you. A completed pickup
     *  objective means the former, not the latter — see where this is decided. */
    where?: "onPad" | "aboard";
  }[];
  /** What the player asked for as an origin, and what it resolved to. Reported because "I set a
   *  start and the order did not change" has two very different causes — an ignored option, or an
   *  optimiser that genuinely sees no better order — and guessing between them costs a session. */
  startResolved: {
    asked: string | null;
    resolved: string | null;
    /** The place the LOG put the player, independent of any manual pick — null when the game's
     *  token matched nothing on this board, or matched ambiguously. */
    detected: string | null;
    /** "coordinates" (the debug overlay, exact) or "terminal" (the last inventory you opened). */
    detectedBy?: "coordinates" | "terminal" | null;
    /** Distance from the snapped marker, when it came from coordinates. */
    detectedMetres?: number | null;
    /** The game's own id, e.g. "Stanton3b_ArcCorp_Area045". Shown when it did NOT resolve, so a
     *  failed join is diagnosable instead of just being silence. */
    detectedToken: string | null;
    detectedAt: number | null;
  };
  /** Legs that have to be carried but could not be put in a route, each with the reason. Never
   *  silently dropped: a route missing legs would look complete and be wrong. */
  unrouted: { group: string; missionId: string; title: string | null; scu: number | null; destination: string | null; toLocation: string | null; reason: string }[];
  /** Placements are only produced when a ship is known. */
  pack: PackResult | null;
  /** SCU already aboard: legs whose pickup completed but whose drop-off has not. */
  aboardScu: number;
  /** Of `aboardScu`, how much is still sitting on the freight lift where you collected it. */
  onPadScu: number;
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
  /**
   * Whether the station's arm will actually load THIS board, not just whether the hull could.
   * `hull` is the ship's capability; `eligible` counts the live contracts whose rank qualifies.
   * See AUTOLOAD_MIN_RANK — the rank rule is reported by a player, not read from the data.
   */
  autoLoad: { hull: boolean; eligible: number; live: number };
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
export function gridsOf(ship: Ship): GridSpec[] {
  return ship.grids.map((g, i) => ({
    name: g.port ?? `grid ${i + 1}`,
    w: g.w,
    l: g.l,
    h: g.h,
    maxBox: g.maxBox ?? undefined,
  }));
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
    const legsRaw: PlannedLeg[] = dropoffs.map((drop, i) => {
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
      /* 🔴 A SIBLING ORDER'S CAP BEATS THE BIGGEST BOX IN THE GAME. When THIS order declares no
         maxContainerSize the guess used to jump straight to `largestBox` (32). That is right when
         the contract is silent, but wrong when the contract already told us a size on another
         order. 4.10's ORS_MA_HaulingMedium is exactly that shape:
           Iron              minScu 1   maxContainerSize undefined
           Medical Supplies  minScu 96  maxContainerSize 8
         The Iron leg took 32, so a 96 SCU load partitioned to 3x32 — and a Hull B cargo grid is
         2x8x2 = EXACTLY 32 SCU, so each box filled a whole grid on its own. Sub: "every single one
         of these cargo grids is full, but I only have 100 and something SCU on board."
         ⚠️ `capSource` below is deliberately NOT upgraded to "dataset" for this case. The number
         came from the dataset but NOT from this order, so it is still an assumption about this
         leg — a better-informed one. Relabelling it would trade a display bug for a provenance
         lie, which is the worse of the two. */
      const cap = b.cap ?? data.maxBoxScu(c.contractKey) ?? (r.scu != null ? largestBox : null);
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
    /**
     * 🔴 MORE PICKUPS THAN DROP-OFFS: EVERY ONE IS A PLACE YOU HAVE TO GO.
     *
     * Legs are built one per DROP-OFF, which is right for `SingleToMulti*` (most of the board) and
     * silently wrong for `MultiNToSingle`. Sub's Junior Small Cargo Haul is
     * `HaulCargo_Multi2ToSingle_Waste_Mixed_ScrapWaste_Stanton3_SmallGrade`: two pickup objectives,
     * one drop-off. One leg came out, so ONE pickup reached the route and the second was discarded
     * — he was routed to Shubin SAL-5 and never told about the other half of his load.
     *
     * The game is explicit about both: `pickup_<id>_0` and `pickup_<id>_1`, distinct positions, and
     * the shape is in the contract key. So the leg is split into one per pickup, sharing the
     * drop-off.
     *
     * ⛔ AND THE SPLIT IS NOT INVENTED. Nothing states how much comes from each pickup — the log
     * gives one total for the contract and the dataset gives only the order pool. So each pickup
     * carries a RANGE, not a fabricated share: showing "3 SCU" at each end of a 6 SCU contract
     * would be a guess printed as fact on a screen he makes decisions from. Pin one and the rest
     * is arithmetic — with two pickups he types one number, ever.
     */
    const legs: PlannedLeg[] = (() => {
      if (dropoffs.length !== 1 || pickups.length < 2 || legsRaw.length !== 1) return legsRaw;
      const base = legsRaw[0];
      const n = pickups.length;
      const total = base.exact && base.scu != null ? base.scu : null;
      const pinAt = (j: number) => opts.pins?.[`${c.missionId}#p${j}`] ?? null;
      const pinnedSum = pickups.reduce((sum, _, j) => sum + (pinAt(j) ?? 0), 0);
      const unpinned = pickups.filter((_, j) => pinAt(j) == null).length;
      return pickups.map((pu, j) => {
        const group = `${base.group}#p${j}`;
        const from = posKey(pu.pos) ?? `${group}:from`;
        const region = regionOfKey(c.contractKey);
        if (region && from) regionByLoc.set(from, region);
        const pinned = pinAt(j);
        // The last unpinned pickup is DERIVED, not asked about — that is the whole point.
        const inferred = pinned == null && unpinned === 1 && total != null ? total - pinnedSum : null;
        const known = pinned ?? inferred;
        const r = known != null
          ? { scu: known, min: known, max: known,
              source: (pinned != null ? "pinned" : "derived") satisfies ScuSource as ScuSource, exact: true }
          /* Bounded by what must be true: at least 1 SCU here, and no more than the total less one
             for every other pickup.
             🔴 BUT `scu` IS THE EVEN SHARE, NOT THE PER-PICKUP WORST CASE. Everywhere else `scu`
             carries the worst case so "does it fit" is answered safely — here that breaks a
             stronger invariant: the legs must sum to the contract total. Two pickups of a 6 SCU
             contract each claiming their worst case is 5 makes the contract 10 SCU, and the packer
             would reserve a hold half again too big. The total is KNOWN and cannot be exceeded, so
             the planning figure is the share and the honest spread stays in min/max, which is what
             the widget prints. */
          : total != null
            ? (() => {
                const share = Math.floor(total / n) + (j < total % n ? 1 : 0);
                return { scu: share, min: 1, max: total - (n - 1),
                         source: "range" satisfies ScuSource as ScuSource, exact: false };
              })()
            : { scu: null, min: null, max: null, source: "unknown" satisfies ScuSource as ScuSource, exact: false };
        return {
          ...base,
          group,
          ...r,
          // The drop-off tonnage belongs to the contract, not to this pickup, so a split leg never
          // claims to be carrying the whole load.
          pickupState: pu.state ?? "pending",
          fromLocation: from,
          pickupIndex: j,
          pickupCount: n,
        };
      });
    })();

    const sources = legs.map((l) => l.source);
    const total = legs.every((l) => l.scu != null) ? legs.reduce((s, l) => s + (l.scu ?? 0), 0) : null;
    /** The contract total when this is a multi-pickup split and the total is genuinely known —
     *  see the note on minScu. Null for every ordinary contract. */
    const splitTotal = legs.length > 1 && legs[0].pickupCount != null && total != null ? total : null;
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
      /* 🔴 A SPLIT CONTRACT'S BOUNDS ARE NOT THE SUM OF ITS PICKUPS' BOUNDS. On a 6 SCU contract
         split across two pickups each honestly bounded 1-5, summing gives 2-10 — and the widget
         would print "2–10 SCU" for a load the player has already pinned at 6. The per-pickup spread
         is real and belongs on the pickup rows; the CONTRACT total is pinned down, so it is stated
         exactly. Only the split case is special-cased; every other contract sums as before. */
      minScu: splitTotal != null ? splitTotal
        : legs.every((l) => l.min != null) ? legs.reduce((s, l) => s + (l.min ?? 0), 0) : null,
      maxScu: splitTotal != null ? splitTotal
        : legs.every((l) => l.max != null) ? legs.reduce((s, l) => s + (l.max ?? 0), 0) : null,
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
  /**
   * 🔴 TWO IDS, ONE PLACE — and it made the router plan two stops at the same spaceport.
   *
   * `posKey` rounds a marker to the kilometre, so two markers for the SAME terminal can land on
   * opposite sides of a rounding boundary and become different location ids. Measured on Sub's own
   * PTU board (2026-08-19): both Orison Relief contracts drop at August Dunlow Spaceport, and their
   * markers keyed as `@5297,-873,5280` and `@5297,-872,5281`. The router therefore built a stop for
   * each and produced pickup → drop → pickup → drop, flying back and forth across the system for
   * what is one landing.
   *
   * 🔑 THE NAME IS THE EVIDENCE, and it is the player's own. If two ids carry the same name — from
   * the game's own drop-off destination, or typed into the naming box — they are the same place and
   * the player has said so. That is a far safer merge signal than proximity: two outposts a
   * kilometre apart are genuinely different places, and merging them by distance would route
   * someone to the wrong one. Absent a name, nothing is merged.
   *
   * The canonical id is the lowest-sorting one, so the choice cannot depend on iteration order.
   *
   * 🔴 AND IT IS WHAT MAKES A COMMODITY BUY "ON THE WAY" RATHER THAN A SIXTH LANDING. A picked buy's
   * terminal is named by the price table and a contract's drop-off is named by the game's own
   * Deliver line; where those agree, the same rule that merged two markers at one spaceport merges
   * the buy onto the landing the player was already making. That is the whole meaning of
   * "opportunistic" — buy where you are already going.
   *
   * ⚠️ A MARKER ID MUST WIN THE CANONICAL SLOT, so the sort is by namespace FIRST and id second
   * rather than by id alone. A buy id carries no coordinates, so if it won, `posByLoc` would miss
   * for that place and the origin snap — which matches the player's read position against marker
   * XYZ — would silently stop resolving there. Today a marker key happens to sort before `buy:`
   * anyway; relying on where '@' falls in ASCII is not a decision, it is a coincidence that a
   * renamed prefix would quietly reverse. With no buys the key is constant and the order is
   * byte-for-byte what it was.
   */
  const canonById = (() => {
    const firstForName = new Map<string, string>();
    const canon = new Map<string, string>();
    const named = new Map<string, string>();
    for (const [id, n] of nameByLoc) if (n?.trim()) named.set(id, n.trim());
    for (const [id, n] of Object.entries(opts.placeNames ?? {})) if (n?.trim() && !named.has(id)) named.set(id, n.trim());
    for (const b of opts.buys ?? []) {
      for (const end of [b.from, b.to]) {
        const t = end.terminal.trim();
        if (t) named.set(BUY_LOC + t.toLowerCase(), t);
      }
    }
    const rank = (id: string) => (id.startsWith(BUY_LOC) ? "1" : "0") + id;
    for (const id of [...named.keys()].sort((a, z) => (rank(a) < rank(z) ? -1 : rank(a) > rank(z) ? 1 : 0))) {
      const key = named.get(id)!.toLowerCase();
      const first = firstForName.get(key);
      if (first) canon.set(id, first);
      else firstForName.set(key, id);
    }
    return canon;
  })();
  /** The id every stop, position and region lookup should use. */
  const canonLoc = (id: string): string => canonById.get(id) ?? id;

  /**
   * 🔴 A CONTRACT WHOSE KEY CARRIES NO REGION LEFT THE OPTIMISER BLIND.
   *
   * `regionByLoc` is populated from the contract key (`..._Stanton3_...`), which works for the
   * generated hauling families and not at all for hand-authored ones: Sub's `ORS_MA_HaulingSmall`
   * and `ORS_MA_HaulingMedium` carry no region token. With no region, `regionOf` returns null for
   * every stop, every leg is charged the flat cross-body rate, EVERY ORDERING TIES, and the
   * optimiser picks an arbitrary one — which is exactly what "it isn't optimising" looks like.
   *
   * 🔑 So fall back to the NAME. A place we can name can usually be found in locations.json, and
   * that row knows its parent body — "New Babbage" is on microTech whether or not the contract key
   * ever said so. Only exact, unambiguous name matches are used: a name matching two rows tells us
   * nothing, and guessing the body is the confidently-wrong failure this file avoids elsewhere.
   */
  const bodyByName = (() => {
    const m = new Map<string, string | null>();
    for (const l of Object.values(data.locations())) {
      const n = (l.name ?? "").trim().toLowerCase();
      if (!n) continue;
      const body = (l.parentName ?? "").trim() || null;
      // Ambiguous names resolve to nothing rather than to the first row that happened to win.
      m.set(n, m.has(n) && m.get(n) !== body ? null : body);
    }
    return m;
  })();
  for (const [id, n] of [...nameByLoc, ...Object.entries(opts.placeNames ?? {})]) {
    const loc = canonLoc(id);
    if (regionByLoc.has(loc)) continue;
    const body = bodyByName.get((n ?? "").trim().toLowerCase());
    if (body) regionByLoc.set(loc, body.toLowerCase());
  }

  const stopById = new Map<string, RouteStop>();
  const visit = (rawLocationId: string, kind: "pickup" | "dropoff"): RouteStop => {
    const locationId = canonLoc(rawLocationId);
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
  const completedPickups: { group: string; missionId: string; title: string | null; locationId: string | null; scu: number | null; commodity: string | null; where?: "onPad" | "aboard" }[] = [];
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

  /* ── the commodity buys the player picked ─────────────────────────────────
   *
   * 🔴 THEY GO THROUGH THE SAME `visit()` AND THE SAME SOLVER as a contract leg, and that is the
   * whole design: `hauling-route.ts` was already cargo-agnostic (`HaulLeg` has always carried an
   * optional `commodity` and `contractId` has always been a grouping key rather than a mission
   * reference), so this needed no second solver and there must never be one. A commodity buy is a
   * pickup at the shop and a drop-off at the buyer, with precedence between them — structurally
   * identical to a haul.
   *
   * 🔴 `scu: undefined` UNTIL THE LOG SAYS. Not zero. See hauling-buys.ts for Sub's ruling and
   * hauling-route.ts for what an absent quantity does to the load model (nothing, and it says so).
   *
   * ⚠️ A pick missing either end is REPORTED, never silently dropped — same rule as an unroutable
   * contract leg. A route quietly missing a leg looks complete and is wrong.
   */
  const buyPlaces = new Map<string, string>();
  const routedBuys = new Set<string>();
  const buyNotes: { id: string; reason: string }[] = [];
  for (const b of opts.buys ?? []) {
    const rawFrom = b.from.terminal.trim();
    const rawTo = b.to.terminal.trim();
    if (!rawFrom || !rawTo) {
      buyNotes.push({ id: b.id, reason: "this run does not name both ends, so there is nothing to route between" });
      continue;
    }
    const fromId = canonLoc(BUY_LOC + rawFrom.toLowerCase());
    const toId = canonLoc(BUY_LOC + rawTo.toLowerCase());
    if (fromId === toId) {
      // Buying and selling at one terminal is not a run. It can only come from two names that the
      // canonical merge decided were the same place, and routing it would emit a pickup and a
      // drop-off on one node — a leg that travels nowhere and still charges handling.
      buyNotes.push({ id: b.id, reason: "both ends of this run resolve to the same place" });
      continue;
    }
    buyPlaces.set(fromId, rawFrom);
    buyPlaces.set(toId, rawTo);
    // 🔑 The body is what the TIERED travel model prices a leg from, and the price table knows it
    // for a terminal even though it knows no coordinates. Without it every buy leg would be charged
    // the flat cross-body rate and every ordering involving one would tie — which is exactly the
    // "it isn't optimising" failure the contract side already hit through a different door.
    // A contract's own reading wins: it came off the contract key or a dataset row, and this is a
    // fallback for a place the contract side never saw.
    if (b.from.body && !regionByLoc.has(fromId)) regionByLoc.set(fromId, b.from.body.trim().toLowerCase());
    if (b.to.body && !regionByLoc.has(toId)) regionByLoc.set(toId, b.to.body.trim().toLowerCase());
    const group = buyGroup(b.id);
    // `scu` is only ever passed when the log has stated it. `?? undefined` rather than `?? 0`:
    // zero is a measurement and this is the absence of one.
    const scu = b.scu !== null && b.scu > 0 ? b.scu : undefined;
    visit(fromId, "pickup").actions.push({ contractId: group, kind: "pickup", scu, commodity: b.commodity || undefined });
    visit(toId, "dropoff").actions.push({ contractId: group, kind: "dropoff", scu, commodity: b.commodity || undefined });
    routedBuys.add(b.id);
  }

  /* 🔴 EVERY GROUP GETS `payout: 0`, CONTRACTS INCLUDED — and it was already so before buys
     existed. That is what stops the solver ranking a commodity run against a contract: with no
     payout on either side the objective is pure time, which is the only currency the two share.
     See PlanOptions.buys for why a shared profit-per-hour figure was considered and rejected. */
  const routeContracts: RouteContract[] = [...routeGroups, ...[...routedBuys].map(buyGroup)]
    .map((id) => ({ id, payout: 0 }));
  const stops = [...stopById.values()];
  // 🔑 The hold that is still FREE. Cargo already aboard cannot be unloaded to make room for a
  // pickup, so planning against the full rating would happily overfill a part-loaded ship.
  const freeCapacity = capacityScu != null ? Math.max(0, capacityScu - aboardScu) : undefined;
  // Where the player says they are. Only a place the route already touches can be an origin — an
  // id we have no coordinates for would silently become "anywhere", which is the bug, not the fix.
  /* 🔴 THE ORIGIN IS DETECTED NOW, not asked for. `RequestLocationInventory` names the player and
     the place they last opened an inventory at, which a hauler does at every stop — so the router
     finally has the origin it was designed around. A manual pick still wins: it is a deliberate
     statement, and the detected one is a LAST-seen that can lag by a stop. */
  // ⚠️ Built from the maps that exist HERE — `locationNames` is not assembled until after the
  // trips are solved, and the origin has to be known before them.
  const knownNames = new Map<string, string>(nameByLoc);
  for (const [id, n] of Object.entries(opts.placeNames ?? {})) if (n.trim() && !knownNames.has(id)) knownNames.set(id, n.trim());
  // The caller's reading wins when it has one: only it can resolve the game's numeric location ids,
  // because that binding is learned over time and has to be persisted.
  const where = opts.atLocation ?? view.atLocation;
  const byToken = where ? matchLocationToken(where.token, knownNames, data) : null;
  /* 🔴 A COORDINATE BEATS A TOKEN. The debug overlay's CamPos is in the planet-fixed frame — the
     same one the mission markers are in — so it does not need matching by name at all, only by
     distance. It is also the only signal that says where you ARE rather than which terminal you
     last touched, so when both exist and the coordinate is the fresher one, it wins. */
  let byPos: string | null = null;
  let byPosMetres: number | null = null;
  if (opts.atPos) {
    const snap = opts.snapMetres ?? 12_000;
    for (const [id, p] of posByLoc) {
      if (!p) continue;
      const d = Math.hypot(p.x - opts.atPos.x, p.y - opts.atPos.y, p.z - opts.atPos.z);
      if (d <= snap && (byPosMetres == null || d < byPosMetres)) { byPos = id; byPosMetres = d; }
    }
  }
  const posIsFresher = !!opts.atPos && (!where || opts.atPos.at >= where.at);
  const seen = (posIsFresher && byPos) || byToken || byPos;
  const startId = opts.startAt || seen;
  // Only a place the route already touches can be an origin — an id we have no coordinates for
  // would silently become "anywhere", which is the bug, not the fix.
  const startPos = startId ? posByLoc.get(startId) ?? null : null;
  // Reported so a wrong route can be told apart from an ignored origin. "I asked for X and the
  // order did not change" has two very different causes, and guessing between them wastes a
  // session — as it did on 2026-08-17.
  const startResolved = {
    asked: opts.startAt ?? null,
    resolved: posKey(startPos),
    /** What the LOG said, independently of what the player picked — so the widget can show it and
     *  a mis-detection is visible rather than silently steering the route. */
    detected: seen,
    detectedToken: where?.token ?? null,
    detectedAt: where?.at ?? null,
    /** How the position was established, so a surprising origin is diagnosable rather than magic. */
    detectedBy: ((posIsFresher && byPos) ? "coordinates" : byToken ? "terminal" : byPos ? "coordinates" : null) as "coordinates" | "terminal" | null,
    /** Metres from the marker the coordinate snapped to. Null unless it came from a coordinate. */
    detectedMetres: (posIsFresher && byPos) || (!byToken && byPos) ? byPosMetres : null,
  };

  /**
   * 🔴 A COMPLETED PICKUP DOES NOT MEAN "ABOARD". The game finishes the objective the instant it
   * releases the cargo to the freight lift. Measured on Sub's own run, 2026-08-17:
   *
   *   20:50:02  kiosk pressed
   *   20:50:05  pickup -> COMPLETED     the widget said "aboard" HERE
   *   20:50:16  RaisingPlatform         the boxes have not left the floor yet
   *
   * Eleven seconds before the platform even starts to rise, and minutes before any of it is
   * tractored in. He put it plainly: "I have silicon and tin saying on board, but in actuality all
   * I did was just pull it up the freight elevator."
   *
   * 🔑 So the honest test is WHERE YOU ARE, which the log now answers. Still standing where you
   * collected it → it is on the pad. Somewhere else → it came with you, so it is aboard. Nothing
   * in the log ever states the tractor-beam move itself, and inventing a moment for it would be
   * the same mistake in a new place.
   *
   * ⚠️ Position unknown falls back to "aboard" — the old behaviour. Claiming "on the pad" without
   * knowing where the player is would strand cargo on a floor they left an hour ago.
   */
  for (const cp of completedPickups) {
    const here = seen != null && cp.locationId != null && cp.locationId === seen;
    cp.where = here ? "onPad" : "aboard";
  }
  const onPadScu = completedPickups
    .filter((cp) => cp.where === "onPad")
    .reduce((n, cp) => n + (cp.scu ?? 0), 0);
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
        // 🔴 Travel is TIERED off the body each stop sits on, not derived from marker XYZ. The
        // distance model priced a 239 km hop at 0.02 min, so "est. run" charged ~5 minutes of
        // travel for a five-stop run whose measured floor is near 25 — and the rank tab's
        // projected rep/hour inherited that, understating time-to-rank whenever nothing had
        // completed yet. Constants and their measurement live in hauling-route.ts.
        regionOf: (locationId) => regionByLoc.get(locationId) ?? null,
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
    // 🔑 A COMMODITY TERMINAL ALREADY HAS A NAME, so it must never fall through to "Site N" and
    // must never be offered in the naming box: the player picked that run BY that name, and asking
    // them what to call a place they just chose off a list would be the widget forgetting something
    // it was told. Below the game's own Deliver line, which still cannot be a typo, and above the
    // player's hand-typed answer for the same reason a stated name outranks one.
    const term = buyPlaces.get(locationId);
    if (term) return term;
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
  // A commodity terminal's own name, for any buy place the contract side never named. `??=` so a
  // place the GAME named keeps that name — the two agree on where you are going, and the game's
  // wording is the one the player will see on their mobiGlas.
  for (const [id, name] of buyPlaces) locationNames[id] ??= name;
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
  /* 🔴 A COMMODITY YOU HAVE ACTUALLY BOUGHT IS CARGO, AND STOW HAS TO KNOW ABOUT IT. Sub's whole
     reason for letting the log fill the tonnage in: "we'll know how much they bought and then it'll
     override it" — and the thing it overrides is what the Stow tab plans against. A hold diagram
     that draws the contract cargo and silently omits 96 SCU of Titanium is worse than no diagram.
     🔑 IT NEEDS NO PARTITIONER. `partitionScu` exists because the game states a contract's tonnage
     and not its manifest, and its output is flagged PROVISIONAL for that reason. A purchase line
     states BOTH — `boxSize` and `unitAmount` — so these boxes are read, not derived.
     ⚠️ Only a bought buy, and only while it is still the current hold's problem. An unbought pick
     has no tonnage and therefore no boxes, which is the correct amount of nothing to draw. */
  for (const b of opts.buys ?? []) {
    if (!routedBuys.has(b.id)) continue;
    if (b.scu === null || !(b.scu > 0)) continue;
    const group = buyGroup(b.id);
    const per = b.boxScu !== null && b.boxScu > 0 ? b.boxScu : null;
    const count = b.boxCount !== null && b.boxCount > 0 ? Math.round(b.boxCount) : null;
    if (per === null || count === null) {
      // The tonnage is known and the manifest is not — the one case where a purchase tells us less
      // than usual. Counted and said, never quietly absent from the drawing.
      undrawable += 1;
      continue;
    }
    const spec = boxSet.find((s) => s.scu === per);
    if (!spec) { undrawable += count; continue; }
    for (let i = 0; i < count; i++) items.push({ id: `${group}#${i}`, scu: spec.scu, dims: spec.dims, group });
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
  /* 🔴 ONE NUMBER PER LANDING, NOT PER ACTION. `seq++` used to sit inside the ACTION loop, so three
     commodities collected at the SAME stop got three different pickup numbers (Silicon 0, Tin 1,
     Scrap 2). The sort below then saw `pa !== pb`, fired the COLLECTION rule on what is physically
     a tie, and never reached the DELIVERY rule at all — the one that actually decides this case.
     Sorted descending, that put whichever commodity happened to be listed last at the door: Scrap,
     which drops LAST, with the Silicon and Tin he unloads FIRST buried behind it.

     Sub caught it on his own board, 2026-08-18: "it has scrap right near the door… what should be
     nearest the door would be the silicon and tin." Exactly the failure the delivery rule exists to
     prevent, and the comment below already described the answer it was not reaching.

     A LANDING is the unit that matters: you cannot collect one commodity "before" another when both
     come up the same lift on the same visit. */
  const pickupAt = new Map<string, number>();
  const dropAt = new Map<string, number>();
  let seq = 0;
  for (const trip of trips) {
    for (const s of trip.stops) {
      const at = seq++;
      for (const a of s.actions) {
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
    /* 🔴 REBUILT FROM AN EXPLICIT FIELD LIST, like every other row this endpoint returns — and
       that is a known trap in this file rather than a style choice: `minutes` / `repPerHour` /
       `moneyPerHour` were once added to a scored object, spread with `...r`, and still arrived
       undefined because a later step mapped to a hand-written literal. Anything added to
       `CommodityBuy` that the widget must see has to be added HERE too. */
    buys: (opts.buys ?? []).map((b): PlannedBuy => {
      const routed = routedBuys.has(b.id);
      const fromId = b.from.terminal.trim() ? canonLoc(BUY_LOC + b.from.terminal.trim().toLowerCase()) : null;
      const toId = b.to.terminal.trim() ? canonLoc(BUY_LOC + b.to.terminal.trim().toLowerCase()) : null;
      return {
        id: b.id,
        group: routed ? buyGroup(b.id) : null,
        commodity: b.commodity,
        resourceGuid: b.resourceGuid,
        from: { ...b.from, locationId: routed ? fromId : null },
        to: { ...b.to, locationId: routed ? toId : null },
        buyPrice: b.buyPrice,
        sellPrice: b.sellPrice,
        scu: b.scu,
        boughtAt: b.boughtAt,
        shopName: b.shopName,
        routed,
        reason: routed ? null : buyNotes.find((n) => n.id === b.id)?.reason ?? "this run could not be routed",
      };
    }),
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
    onPadScu,
    rates,
    /* 🔴 THE HULL IS ONLY HALF THE QUESTION. The stow tab claimed "Hull A loads itself" for every
       contract on Sub's board; he caught it — automated loading is a property of the CONTRACT as
       well as the ship. So the widget gets both numbers and can say which of the two is missing
       instead of asserting a capability the player will not get. */
    autoLoad: (() => {
      const live = contracts.filter((c) => !c.ended && !c.hidden);
      return {
        hull: canAutoLoad(hull?.className),
        eligible: live.filter((c) => rankAutoLoads(c.board?.rank ?? null)).length,
        live: live.length,
      };
    })(),
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
      /** The PLACE, as distinct from `id`, which is the node ("<place>:pickup"). Anything that
       *  remembers something about where you are standing — a name you gave it, for instance —
       *  must key on this. */
      locationId,
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
          // 🔑 `undefined` -> `null` at the boundary. The solver spells "nobody has said how much"
          // as an absent field; every view type in this file spells it `null`. One convention each
          // side, converted in the one place they meet. Contract actions always carry a number, so
          // this is a no-op for them.
          scu: a.scu ?? null,
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
    // Straight through from the solver. `aboardScu` is a measured figure, so adding it does not
    // make an uncertain peak certain and cannot make a certain one uncertain.
    unknownScu: trip.unknownScu,
    method: trip.method,
  };
}
