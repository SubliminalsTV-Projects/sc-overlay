/**
 * HAULING ROUTE OPTIMISER — what order to run the accepted contracts.
 *
 * The player picks which contracts to accept; this only decides the order to fly them.
 *
 * 🔑 A LOCATION IS NOT A STOP. Sub's six real contracts today run in BOTH directions between
 * Baijini Point and Riker Memorial: four haul Baijini -> Riker, two haul Riker -> Baijini. Dedupe
 * those into one visit per location and the precedence constraints form a cycle — Baijini must
 * precede Riker and Riker must precede Baijini — and every route is "infeasible", which is nonsense
 * because you obviously just land at Baijini twice. So a stop here is a **(location, pickup|dropoff)
 * visit**, and a location may appear twice in a route. Two visits that end up adjacent cost nothing
 * extra and collapse back into one landing, which is exactly what happens in the game.
 *
 * Two hard constraints:
 *   - PRECEDENCE — a contract's drop-off cannot precede its pickup;
 *   - CAPACITY — the SCU held between a pickup and its drop-off must fit the ship. Load is a
 *     function of WHICH visits are done, not their order, so it is checkable per subset.
 *
 * Objective is time: with the accepted set fixed, payout is fixed, so maximising aUEC/hour is
 * exactly minimising total minutes. `fewest-stops` only bites when the load does NOT fit in one
 * trip and the run has to be split — then it decides which contracts ride together (see `planRun`).
 *
 * ⚠️ Distances come from marker XYZ, whose coordinate frame is still unverified (zone-local vs
 * system-global — a phase-1 question). Everything here takes the speed and the per-stop overhead as
 * options and accepts a `distance` override, so a wrong frame is a tuning change, not a rewrite.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface StopAction {
  contractId: string;
  kind: "pickup" | "dropoff";
  scu: number;
  commodity?: string;
}

/** One VISIT — see the 🔑 note. `locationId` is what actually costs travel time. */
export interface RouteStop {
  id: string;
  /** The place this visit happens. Defaults to `id`. Consecutive visits here collapse into one. */
  locationId?: string;
  name?: string;
  /** Marker XYZ, or null when the location has no position yet. */
  pos?: Vec3 | null;
  actions: StopAction[];
}

export interface RouteContract {
  id: string;
  payout: number;
  title?: string;
}

/** One commodity moving from A to B for a contract — the shape `buildStops` consumes. */
export interface HaulLeg {
  contractId: string;
  scu: number;
  fromLocation: string;
  toLocation: string;
  commodity?: string;
}

export interface RouteOptions {
  objective?: "auec-per-hour" | "fewest-stops";
  /** Metres per second used to turn XYZ distance into travel time. */
  travelSpeedMps?: number;
  /** Flat minutes burned at every stop — landing, elevator, loading, leaving. */
  stopMinutes?: number;
  /** Minutes charged for a leg where either end has no known position. */
  unknownLegMinutes?: number;
  /** Where the run starts. Omit and the first stop is free to be anywhere. */
  startPos?: Vec3 | null;
  /** Ship hold in SCU. Omit for no capacity constraint. */
  capacityScu?: number;
  distance?: (a: Vec3, b: Vec3) => number;
}

export interface RouteLeg {
  from: string | null;
  to: string;
  distanceM: number | null;
  minutes: number;
  /** SCU aboard on leaving `to`. */
  loadAfterScu: number;
}

export interface RoutePlan {
  /** Visit ids in order. */
  order: string[];
  legs: RouteLeg[];
  /** Actual landings — consecutive visits to one location count once. */
  stops: number;
  totalMinutes: number;
  totalDistanceM: number;
  payout: number;
  auecPerHour: number;
  /** Most SCU held at any point — what the ship actually has to be able to carry. */
  peakScu: number;
  contractIds: string[];
  method: "exact" | "heuristic";
}

export interface RunPlan {
  trips: RoutePlan[];
  /** Contracts no trip could carry — over capacity even on their own. */
  stranded: string[];
  totalMinutes: number;
  payout: number;
  auecPerHour: number;
}

const DEFAULTS = {
  objective: "auec-per-hour" as const,
  travelSpeedMps: 200_000,
  stopMinutes: 4,
  unknownLegMinutes: 6,
};

/** Above this many visits, exact enumeration stops being cheap and we fall back to a heuristic. */
const EXACT_STOP_LIMIT = 14;

/** Minutes charged per SCU held, per leg. Deliberately tiny: a 400 SCU hold costs 0.4 min a leg,
 *  enough to order drop-offs before pickups at the same landing and to stop the solver dragging a
 *  full hold around a loop, and far too small to reorder a route that has a real reason to be in
 *  its order. Travel between stops is ~0.02 min, so without a term like this the objective is flat
 *  and the returned order is whichever was built first. */
const CARRY_PENALTY_MIN_PER_SCU = 0.001;

function euclidean(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function delta(stop: RouteStop): number {
  return stop.actions.reduce((sum, a) => sum + (a.kind === "pickup" ? a.scu : -a.scu), 0);
}

const locOf = (s: RouteStop): string => s.locationId ?? s.id;

/**
 * Turn per-commodity haul legs into the visit list the optimiser wants: one pickup visit and one
 * drop-off visit per location, each carrying every action that happens there.
 */
export function buildStops(legs: readonly HaulLeg[], posOf: (locationId: string) => Vec3 | null = () => null): RouteStop[] {
  const stops = new Map<string, RouteStop>();
  const visit = (locationId: string, kind: "pickup" | "dropoff"): RouteStop => {
    const id = `${locationId}:${kind}`;
    let s = stops.get(id);
    if (!s) {
      s = { id, locationId, name: locationId, pos: posOf(locationId), actions: [] };
      stops.set(id, s);
    }
    return s;
  };
  for (const leg of legs) {
    visit(leg.fromLocation, "pickup").actions.push({
      contractId: leg.contractId,
      kind: "pickup",
      scu: leg.scu,
      commodity: leg.commodity,
    });
    visit(leg.toLocation, "dropoff").actions.push({
      contractId: leg.contractId,
      kind: "dropoff",
      scu: leg.scu,
      commodity: leg.commodity,
    });
  }
  return [...stops.values()];
}

/** Drop the actions of contracts not in `keep`, then drop visits left with nothing to do. */
export function stopsFor(stops: readonly RouteStop[], keep: ReadonlySet<string>): RouteStop[] {
  return stops
    .map((s) => ({ ...s, actions: s.actions.filter((a) => keep.has(a.contractId)) }))
    .filter((s) => s.actions.length > 0);
}

// ── the ordering problem ───────────────────────────────────────────────────

interface Solved {
  order: number[];
  minutes: number;
  method: "exact" | "heuristic";
}

interface Ctx {
  stops: readonly RouteStop[];
  n: number;
  /** Bitmask of visits that must happen before visit i. */
  before: number[];
  deltas: number[];
  capacity: number;
  legMinutes: (from: number | null, to: number) => number;
  /** Visits at the place the player is standing, and therefore the only legal FIRST visits.
   *
   *  🔴 This is a CONSTRAINT, not a preference, and it has to be — pricing cannot express it.
   *  Default travel is 200,000 m/s against a 4-minute stop, so Sub's 239 km Riker→Baijini hop
   *  costs 0.02 minutes, half a percent of one stop. Every ordering therefore scores the same and
   *  the solver returns whichever it built first, which is how he was told to fly to Baijini empty
   *  while standing on the load he needed. An origin expressed as cost is invisible at that scale;
   *  expressed as "you cannot start where you are not", it always holds.
   *
   *  Empty when the player said nothing, or said somewhere this route does not visit — in which
   *  case every precedence-free visit is a legal opening, exactly as before. */
  startIdxs: number[];
}

function buildCtx(stops: readonly RouteStop[], opts: RouteOptions): Ctx {
  const n = stops.length;
  const speed = opts.travelSpeedMps ?? DEFAULTS.travelSpeedMps;
  const stopMin = opts.stopMinutes ?? DEFAULTS.stopMinutes;
  const unknown = opts.unknownLegMinutes ?? DEFAULTS.unknownLegMinutes;
  const dist = opts.distance ?? euclidean;

  const before = new Array<number>(n).fill(0);
  const pickupMask = new Map<string, number>();
  stops.forEach((s, i) => {
    for (const a of s.actions) {
      if (a.kind === "pickup") pickupMask.set(a.contractId, (pickupMask.get(a.contractId) ?? 0) | (1 << i));
    }
  });
  stops.forEach((s, i) => {
    for (const a of s.actions) {
      if (a.kind === "dropoff") before[i] |= (pickupMask.get(a.contractId) ?? 0) & ~(1 << i);
    }
  });

  // Visits at the player's own position. Only precedence-free ones count: a drop-off whose pickup
  // has not happened cannot open a route no matter where the player is standing.
  const sp = opts.startPos ?? null;
  const startIdxs: number[] = [];
  if (sp) {
    stops.forEach((s, i) => {
      const p = s.pos;
      if (p && p.x === sp.x && p.y === sp.y && p.z === sp.z && before[i] === 0) startIdxs.push(i);
    });
  }

  return {
    stops,
    n,
    before,
    startIdxs,
    deltas: stops.map(delta),
    capacity: opts.capacityScu ?? Number.POSITIVE_INFINITY,
    legMinutes: (from, to) => {
      // Already standing there: the second visit is the same landing, so it is free.
      if (from !== null && locOf(stops[from]) === locOf(stops[to])) return 0;
      const a = from === null ? (opts.startPos ?? null) : (stops[from].pos ?? null);
      const b = stops[to].pos ?? null;
      if (from === null && a === null) return stopMin;
      if (!a || !b) return unknown + stopMin;
      return dist(a, b) / speed / 60 + stopMin;
    },
  };
}

/** Load aboard once `mask` has been visited — order-independent, so it caches cleanly. */
function loadAfter(ctx: Ctx, mask: number): number {
  let load = 0;
  for (let i = 0; i < ctx.n; i++) if (mask & (1 << i)) load += ctx.deltas[i];
  return load;
}

/** Held-Karp over visit subsets, refusing states that break precedence or overflow the hold. */
function solveExact(ctx: Ctx): Solved | null {
  const full = (1 << ctx.n) - 1;
  const cost = new Float64Array((full + 1) * ctx.n).fill(Number.POSITIVE_INFINITY);
  const prev = new Int32Array((full + 1) * ctx.n).fill(-1);

  const loads = new Float64Array(full + 1);
  for (let m = 1; m <= full; m++) loads[m] = loadAfter(ctx, m);

  // The player's own position, when they gave one and this route visits it, is the ONLY legal
  // opening — see Ctx.startIdxs for why this cannot be left to the cost function.
  const openings = ctx.startIdxs.length ? ctx.startIdxs : null;
  for (let i = 0; i < ctx.n; i++) {
    if (ctx.before[i] !== 0) continue;
    if (openings && !openings.includes(i)) continue;
    const m = 1 << i;
    if (loads[m] > ctx.capacity) continue;
    cost[m * ctx.n + i] = ctx.legMinutes(null, i);
  }

  for (let mask = 1; mask <= full; mask++) {
    for (let last = 0; last < ctx.n; last++) {
      if (!(mask & (1 << last))) continue;
      const here = cost[mask * ctx.n + last];
      if (here === Number.POSITIVE_INFINITY) continue;
      for (let next = 0; next < ctx.n; next++) {
        const bit = 1 << next;
        if (mask & bit) continue;
        if ((ctx.before[next] & mask) !== ctx.before[next]) continue;
        const nmask = mask | bit;
        if (loads[nmask] > ctx.capacity) continue;
        // 🔴 CARRYING COSTS SOMETHING. Travel is ~free in this model (200,000 m/s against a
        // 4-minute stop), so without this the solver is indifferent to WHEN a drop-off happens and
        // will cheerfully route a full hold through the whole loop to unload at the last stop.
        // Sub sat at Riker holding 101 SCU of Stims bound for Baijini, was sent to Baijini to LOAD
        // at step 1, and told to drop the Stims there at step 5 — the same place, four stops later.
        // A hauler unloads what they are carrying the moment they are standing where it goes.
        // Scaled so it breaks ties and orders drop-offs early without ever outweighing a real stop.
        const cand = here + ctx.legMinutes(last, next) + loads[nmask] * CARRY_PENALTY_MIN_PER_SCU;
        const at = nmask * ctx.n + next;
        if (cand < cost[at]) {
          cost[at] = cand;
          prev[at] = last;
        }
      }
    }
  }

  let bestLast = -1;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ctx.n; i++) {
    const c = cost[full * ctx.n + i];
    if (c < best) {
      best = c;
      bestLast = i;
    }
  }
  if (bestLast < 0) return null;

  const order: number[] = [];
  let mask = full;
  let last = bestLast;
  while (last >= 0) {
    order.push(last);
    const p = prev[mask * ctx.n + last];
    mask &= ~(1 << last);
    last = p;
  }
  order.reverse();
  return { order, minutes: best, method: "exact" };
}

/** Nearest-feasible-neighbour then a precedence-safe 2-opt. Used past EXACT_STOP_LIMIT visits. */
function solveHeuristic(ctx: Ctx): Solved | null {
  const order: number[] = [];
  let mask = 0;
  let last: number | null = null;
  for (let step = 0; step < ctx.n; step++) {
    let pick = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ctx.n; i++) {
      if (mask & (1 << i)) continue;
      if ((ctx.before[i] & mask) !== ctx.before[i]) continue;
      if (loadAfter(ctx, mask | (1 << i)) > ctx.capacity) continue;
      const c = ctx.legMinutes(last, i);
      if (c < bestCost) {
        bestCost = c;
        pick = i;
      }
    }
    if (pick < 0) return null;
    order.push(pick);
    mask |= 1 << pick;
    last = pick;
  }

  const legal = (cand: number[]): boolean => {
    let m = 0;
    for (const i of cand) {
      if ((ctx.before[i] & m) !== ctx.before[i]) return false;
      m |= 1 << i;
      if (loadAfter(ctx, m) > ctx.capacity) return false;
    }
    return true;
  };
  const total = (cand: number[]): number =>
    cand.reduce((sum, s, i) => sum + ctx.legMinutes(i === 0 ? null : cand[i - 1], s), 0);

  let bestOrder = order;
  let bestTotal = total(order);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < ctx.n - 1 && !improved; i++) {
      for (let j = i + 1; j < ctx.n && !improved; j++) {
        const cand = [...bestOrder.slice(0, i), ...bestOrder.slice(i, j + 1).reverse(), ...bestOrder.slice(j + 1)];
        if (!legal(cand)) continue;
        const t = total(cand);
        if (t < bestTotal - 1e-9) {
          bestOrder = cand;
          bestTotal = t;
          improved = true;
        }
      }
    }
  }
  return { order: bestOrder, minutes: bestTotal, method: "heuristic" };
}

function toPlan(ctx: Ctx, solved: Solved, contracts: readonly RouteContract[], opts: RouteOptions): RoutePlan {
  const dist = opts.distance ?? euclidean;
  const legs: RouteLeg[] = [];
  let totalDistanceM = 0;
  let load = 0;
  let peakScu = 0;
  let landings = 0;
  const carried = new Set<string>();

  solved.order.forEach((idx, step) => {
    const stop = ctx.stops[idx];
    const fromIdx = step === 0 ? null : solved.order[step - 1];
    const sameSpot = fromIdx !== null && locOf(ctx.stops[fromIdx]) === locOf(stop);
    if (!sameSpot) landings++;
    const a = fromIdx === null ? (opts.startPos ?? null) : (ctx.stops[fromIdx].pos ?? null);
    const b = stop.pos ?? null;
    const d = sameSpot ? 0 : a && b ? dist(a, b) : null;
    if (d !== null) totalDistanceM += d;
    // Drop off before picking up — that is the order at an elevator, and it keeps the peak honest.
    for (const act of stop.actions) if (act.kind === "dropoff") load -= act.scu;
    for (const act of stop.actions) if (act.kind === "pickup") load += act.scu;
    for (const act of stop.actions) carried.add(act.contractId);
    peakScu = Math.max(peakScu, load);
    legs.push({
      from: fromIdx === null ? null : ctx.stops[fromIdx].id,
      to: stop.id,
      distanceM: d,
      minutes: ctx.legMinutes(fromIdx, idx),
      loadAfterScu: load,
    });
  });

  const done = contracts.filter((c) => carried.has(c.id));
  const payout = done.reduce((sum, c) => sum + c.payout, 0);
  return {
    order: solved.order.map((i) => ctx.stops[i].id),
    legs,
    stops: landings,
    totalMinutes: solved.minutes,
    totalDistanceM,
    payout,
    auecPerHour: solved.minutes > 0 ? payout / (solved.minutes / 60) : 0,
    peakScu,
    contractIds: done.map((c) => c.id),
    method: solved.method,
  };
}

/**
 * Order every given visit into one trip. Returns null when no order satisfies precedence and
 * capacity — which is the signal that the run needs splitting; see `planRun`.
 */
export function planRoute(
  stops: readonly RouteStop[],
  contracts: readonly RouteContract[],
  opts: RouteOptions = {},
): RoutePlan | null {
  if (stops.length === 0) return null;
  const ctx = buildCtx(stops, opts);
  const solved = ctx.n <= EXACT_STOP_LIMIT ? solveExact(ctx) : solveHeuristic(ctx);
  return solved ? toPlan(ctx, solved, contracts, opts) : null;
}

/**
 * Plan the whole accepted set, splitting into trips when it does not fit in the hold at once.
 *
 * This is where the `fewest-stops` toggle earns its keep. Both objectives order a trip the same way
 * (minimum time), but they disagree about WHICH contracts share a trip:
 *   - `auec-per-hour` loads the densest payers first (aUEC per SCU), so the early trips earn most;
 *   - `fewest-stops` loads contracts that share locations with what is already aboard, so a trip
 *     visits as few places as possible even if it earns a little less.
 * When everything fits in one trip the toggle changes nothing, which is the common case.
 */
export function planRun(
  stops: readonly RouteStop[],
  contracts: readonly RouteContract[],
  opts: RouteOptions = {},
): RunPlan {
  const objective = opts.objective ?? DEFAULTS.objective;
  const whole = planRoute(stopsFor(stops, new Set(contracts.map((c) => c.id))), contracts, opts);
  if (whole) return summarise([whole], []);

  const scuOf = new Map<string, number>();
  const placesOf = new Map<string, Set<string>>();
  for (const s of stops) {
    for (const a of s.actions) {
      if (a.kind === "pickup") scuOf.set(a.contractId, (scuOf.get(a.contractId) ?? 0) + a.scu);
      if (!placesOf.has(a.contractId)) placesOf.set(a.contractId, new Set());
      placesOf.get(a.contractId)!.add(locOf(s));
    }
  }
  const density = (id: string): number => {
    const scu = scuOf.get(id) ?? 0;
    const payout = contracts.find((c) => c.id === id)?.payout ?? 0;
    return scu > 0 ? payout / scu : Number.POSITIVE_INFINITY;
  };

  const trips: RoutePlan[] = [];
  const stranded: string[] = [];
  let pool = contracts.map((c) => c.id);

  while (pool.length > 0) {
    const load: string[] = [];
    let plan: RoutePlan | null = null;
    let candidates = [...pool];

    while (candidates.length > 0) {
      const aboard = new Set(load.flatMap((l) => [...(placesOf.get(l) ?? [])]));
      const rank = (id: string): number => {
        if (objective !== "fewest-stops") return density(id);
        const places = placesOf.get(id) ?? new Set<string>();
        const overlap = [...places].filter((p) => aboard.has(p)).length;
        return overlap * 1e9 - places.size * 1e6 + density(id);
      };
      const pick = candidates.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      candidates = candidates.filter((c) => c !== pick);

      const attempt = planRoute(stopsFor(stops, new Set([...load, pick])), contracts, opts);
      if (attempt) {
        load.push(pick);
        plan = attempt;
      } else if (load.length === 0) {
        // Cannot be carried even alone — no later trip will change that.
        stranded.push(pick);
        pool = pool.filter((c) => c !== pick);
      }
    }

    if (!plan) break;
    trips.push(plan);
    pool = pool.filter((c) => !load.includes(c));
  }

  return summarise(trips, stranded);
}

function summarise(trips: RoutePlan[], stranded: string[]): RunPlan {
  const totalMinutes = trips.reduce((sum, t) => sum + t.totalMinutes, 0);
  const payout = trips.reduce((sum, t) => sum + t.payout, 0);
  return {
    trips,
    stranded,
    totalMinutes,
    payout,
    auecPerHour: totalMinutes > 0 ? payout / (totalMinutes / 60) : 0,
  };
}
