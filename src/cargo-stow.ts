/**
 * CARGO STOWAGE — where every box goes, and in what order to lift it.
 *
 * `cargo-pack.ts` answers "does it fit". This answers "where does it go and what do I load first",
 * which is a different question with a different objective, which is why it is a different file.
 *
 * ── 🔑 THE OBJECTIVE, AND IT IS THE WHOLE TRICK ────────────────────────────────────────────────
 *
 * **Do not minimise space used.** A packer that minimises space sardine-packs, and sardine-packing
 * three small missions into a C2 with 690 SCU of slack is the exact thing Sub does not want: boxes
 * crammed together for no reason, so that reaching the first drop-off means moving the other two.
 *
 * **Minimise HANDLING instead.** Score a layout by how many boxes have to be lifted out of the way
 * to reach the boxes you need at each stop, walked in route order (`simulateUnload`). Both of the
 * behaviours Sub asked for then fall out of ONE objective, with no threshold to tune and no mode to
 * explain:
 *
 *   • **Three small missions in a C2.** Burying anything costs real seconds and there is enormous
 *     slack, so the separated layouts score zero and win — each mission gets its own clear band,
 *     with a cell of air between them.
 *   • **A nearly-full load.** Separation stops fitting, burial becomes unavoidable everywhere, and
 *     the score collapses to dense LIFO which accepts some shuffling because there is no
 *     alternative.
 *
 * And the widget can always say WHY, because the winner knows which it was: `handling.verdict` is
 * "spread" or "tight" and `handling.reason` is the sentence.
 *
 * ── HARD CONSTRAINTS THAT ARE NOT NEGOTIABLE ──────────────────────────────────────────────────
 *
 *   **Boxes are mission-bound.** A box from mission A cannot satisfy mission B's drop-off, even for
 *   the identical commodity going to a different place. There is no consolidation, ever. Three
 *   aluminium contracts to three destinations are three separate stacks, and `group` (mission +
 *   drop-off) is never merged with another.
 *
 *   **LIFO by route order.** The last drop-off loads deepest, the first sits by the ramp. Get this
 *   backwards and every stop becomes unload-shuffle-repack, which is what players mean when they
 *   call cargo Tetris a chore.
 *
 *   **The freight elevator lifts BY MISSION.** This helps enormously — boxes from two missions never
 *   interleave in one lift, so the load order is a clean two-level sort: outer is which mission
 *   (reverse route order), inner is which drop-off within that mission (reverse order of its own
 *   stops). See `buildLifts`.
 *
 *   **Auto-load ships need no plan at all.** `canAutoLoad()` decides; we return early and say so.
 *
 * ── 🔴 THE ELEVATOR CANNOT NAME A MISSION ─────────────────────────────────────────────────────
 *
 * The freight elevator UI does not label missions and does not show the contract name. The player
 * identifies a mission BY LOOKING AT ITS CONTENTS and cross-referencing what they accepted. That
 * headache is most of why this widget exists, so every entry in the load order carries a
 * human-matchable fingerprint — "Processed Food — 10x 8 SCU + 1x 1 SCU" (`signature`).
 *
 * ⚠️ Two missions CAN share a signature. That is detected (`signatureClashes`, `ambiguous`) and
 * said out loud, rather than emitting an instruction the player physically cannot follow.
 *
 * Pure functions only. Nothing here reads a file, watches a log, or renders anything.
 */
import { canAutoLoad } from "./hauling-autoload.js";
import { packCargo, gridCapacityScu, shipCapacityScu, type GridSpec, type PackItem } from "./cargo-pack.js";

// ── the interface contract with `stowview` ─────────────────────────────────
//
// stowview renders exactly this and computes nothing itself. Cell coordinates throughout:
// 1 cell = 1.25 m = 1 SCU, x = across the grid, y = depth from the grid's access edge (y = 0 is
// nearest the ramp), z = height. `dx/dy/dz` are the footprint AS PLACED — the packer yaws boxes,
// so a 32 SCU box may be 2x8 or 8x2 and the renderer must not re-derive it from `scu`.

export interface StowPlacement {
  boxId: string;
  missionId: string;
  destination: string | null;
  /** Mission + drop-off. The colour key: one contiguous stack per group. */
  group: string;
  commodity: string | null;
  /** Index into `StowPlan.grids`, not a name — names repeat across hulls. */
  gridIndex: number;
  x: number;
  y: number;
  z: number;
  scu: number;
  dx: number;
  dy: number;
  dz: number;
  /** Which lift this box rides, 1-based. Matches `LoadStep.step`. */
  loadStep: number;
}

/** One trip up the freight elevator. One lift = one mission; see the header. */
export interface LoadStep {
  step: number;
  missionId: string;
  title: string | null;
  /** 🔴 How the player finds this mission on an elevator that will not name it. */
  signature: string;
  commodities: string[];
  boxes: { scu: number; count: number }[];
  boxCount: number;
  scu: number;
  /** ⚠️ Another mission's contents look identical on the elevator. */
  ambiguous: boolean;
  ambiguousWith: string[];
  /** False when the look-alikes are consecutive lifts — then the ORDER does not matter, only
   *  remembering which stack you took. True when they are separated and must be told apart. */
  orderMatters: boolean;
  /** This mission's drop-offs, deepest-loaded first. */
  destinations: { group: string; destination: string | null; commodity: string | null; scu: number; boxIds: string[] }[];
  boxIds: string[];
}

export interface StowGridView {
  index: number;
  name: string;
  w: number;
  l: number;
  h: number;
  capacityScu: number;
  usedScu: number;
}

export interface StowHandling {
  /** Boxes that must be lifted aside and put back across the whole run. The objective. */
  moves: number;
  perStop: { group: string; destination: string | null; moves: number }[];
  /** "spread" = nothing is buried · "tight" = burial was unavoidable. */
  verdict: "spread" | "tight";
  reason: string;
  slackScu: number;
  /** Which candidate layout won. Diagnostic — the widget need not show it. */
  strategy: string;
  /** Every candidate that was tried, and what it scored. Diagnostic. */
  considered: { strategy: string; moves: number | null; reach: number | null; rejected: string | null }[];
}

export interface StowPlan {
  /** True when the ship auto-loads. Everything below is empty and the widget must not draw a
   *  stowage diagram — the game does the work and the player never sees the inside of the hold. */
  autoLoad: boolean;
  placements: StowPlacement[];
  loadOrder: LoadStep[];
  grids: StowGridView[];
  /** Boxes with nowhere to go. Empty iff `fits`. */
  unplaced: { boxId: string; missionId: string; group: string; scu: number }[];
  fits: boolean;
  loadedScu: number;
  capacityScu: number;
  handling: StowHandling;
  signatureClashes: { signature: string; missionIds: string[] }[];
  notes: string[];
}

// ── inputs ─────────────────────────────────────────────────────────────────

export interface StowBox {
  scu: number;
  /** [x, y, z] in cells as the box rests. Straight off the dataset's `boxes` table. */
  dims: readonly [number, number, number];
}

/** One drop-off's worth of cargo. `group` must be globally unique — mission + drop-off key. */
export interface StowLeg {
  group: string;
  missionId: string;
  destination: string | null;
  commodity: string | null;
  boxes: readonly StowBox[];
}

export interface StowOptions {
  /** Class name, for the auto-load check. Omit and the ship is assumed to load by hand. */
  shipClass?: string | null;
  shipName?: string | null;
  missionTitles?: Record<string, string | null>;
  /** Cells of clear air left between stacks when there is room for it. 0 disables. */
  gap?: number;
}

// ── geometry ───────────────────────────────────────────────────────────────

/** Every real cargo grid caps box height at 2 cells, so a grid is a stack of 2-cell LEVELS. */
const LEVEL_H = 2;

/**
 * ⚠️ A box wants something under it — it is tractored in and set down, not hung. Whether the grid
 * will actually hold one in mid-air is not something we can settle from the data, so this is a
 * RANKED PENALTY rather than a hard rejection: a layout that rests on something always beats an
 * identical one that does not, but if the only layouts that fit have a box floating, the player
 * gets a plan and a note instead of nothing.
 *
 * 🔑 It also turned out to be the thing that made the existing packer unbuildable at high fill:
 * `packCargo` lays out each level independently, so the upper level's shelves rarely line up with
 * the lower level's and boxes end up over thin air. `settle` fixes that by dropping everything as
 * far as it will go, which is both what gravity would do and strictly cheaper to reach.
 */
const FLOATING_IS_A_PROBLEM = true;

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

/**
 * The boxes that must be lifted out of the way before `n` can leave the hold.
 *
 * Two ways to be in the way, and only two, because the hold is never more than two levels deep:
 *
 *   1. **Resting above it.** Anything over `n`'s footprint comes off first, no exceptions.
 *   2. **In the forward corridor.** `n` leaves by travelling toward the access edge (-y). Anything
 *      occupying that corridor at `n`'s own height is in the way — UNLESS `n` can be lifted to a
 *      clear height first and flown over, which is why the corridor is evaluated at every height
 *      the box could rise to and the cheapest one wins. (Rising is free once rule 1 has cleared the
 *      column above it.)
 *
 * This deliberately does not model the tractor beam's arc or the player's aim. It is a consistent
 * relative score for comparing layouts, not a simulator — and consistency is the only property the
 * comparison actually needs.
 */
function blockersOf(n: StowPlacement, present: readonly StowPlacement[], grid: GridSpec): StowPlacement[] {
  const same = present.filter((p) => p !== n && p.gridIndex === n.gridIndex);
  const above = same.filter(
    (p) =>
      overlaps(p.x, p.x + p.dx, n.x, n.x + n.dx) &&
      overlaps(p.y, p.y + p.dy, n.y, n.y + n.dy) &&
      p.z >= n.z + n.dz,
  );
  const aboveSet = new Set(above);

  let cheapest: StowPlacement[] | null = null;
  for (let z = n.z; z + n.dz <= grid.h; z++) {
    const corridor = same.filter(
      (p) =>
        !aboveSet.has(p) &&
        overlaps(p.x, p.x + p.dx, n.x, n.x + n.dx) &&
        p.y + p.dy <= n.y &&
        overlaps(p.z, p.z + p.dz, z, z + n.dz),
    );
    if (!cheapest || corridor.length < cheapest.length) cheapest = corridor;
    if (corridor.length === 0) break;
  }
  return [...above, ...(cheapest ?? [])];
}

/**
 * Walk the run in route order and count every box that has to be shifted. THE OBJECTIVE.
 *
 * Two rules make the number mean what it says:
 *   - a blocker belonging to the stop being unloaded is FREE — it was coming out anyway;
 *   - a blocker is charged ONCE per stop, because you set it aside and put it back once, not once
 *     per box you dug past it.
 * Boxes from earlier stops are already gone, which is why `present` shrinks as the run goes on.
 */
function simulateUnload(
  placements: readonly StowPlacement[],
  grids: readonly GridSpec[],
  routeOrder: readonly string[],
): { moves: number; perStop: { group: string; destination: string | null; moves: number }[] } {
  const present = new Set(placements);
  const perStop: { group: string; destination: string | null; moves: number }[] = [];
  let moves = 0;

  for (const group of routeOrder) {
    const need = new Set(placements.filter((p) => p.group === group && present.has(p)));
    if (need.size === 0) continue;
    const charged = new Set<StowPlacement>();
    while (need.size > 0) {
      const here = [...present];
      let pick: StowPlacement | null = null;
      let pickBlockers: StowPlacement[] = [];
      // Least-blocked first: pulling the easy one often frees the next for nothing.
      for (const n of need) {
        const b = blockersOf(n, here, grids[n.gridIndex]).filter((x) => !need.has(x));
        const cost = b.filter((x) => !charged.has(x)).length;
        if (!pick || cost < pickBlockers.filter((x) => !charged.has(x)).length) {
          pick = n;
          pickBlockers = b;
        }
      }
      for (const b of pickBlockers) {
        if (charged.has(b)) continue;
        charged.add(b);
        moves++;
      }
      present.delete(pick!);
      need.delete(pick!);
    }
    perStop.push({
      group,
      destination: placements.find((p) => p.group === group)?.destination ?? null,
      moves: charged.size,
    });
  }
  return { moves, perStop };
}

/** Sum of how far every box is from the ramp and off the floor. The tie-break between two
 *  zero-handling layouts: same number of moves, less walking. */
function reachOf(placements: readonly StowPlacement[]): number {
  return placements.reduce((sum, p) => sum + p.y + p.dy + p.z, 0);
}

const cellKey = (gridIndex: number, x: number, y: number, z: number): string => `${gridIndex}|${x},${y},${z}`;

function occupancy(placements: readonly StowPlacement[]): Map<string, StowPlacement> {
  const filled = new Map<string, StowPlacement>();
  for (const p of placements)
    for (let x = p.x; x < p.x + p.dx; x++)
      for (let y = p.y; y < p.y + p.dy; y++)
        for (let z = p.z; z < p.z + p.dz; z++) filled.set(cellKey(p.gridIndex, x, y, z), p);
  return filled;
}

/**
 * Drop every box as far as it will go. Gravity, applied after the fact.
 *
 * This is what makes a dense layout buildable: `packCargo` fills level 1 without reference to where
 * level 0's shelves ended, so its upper boxes routinely hang over gaps. Settling costs nothing —
 * a box can only move down into space that was already empty — and every metric improves, because
 * a lower box is both better supported and closer to hand.
 */
function settle(placements: StowPlacement[]): StowPlacement[] {
  const occupied = new Set<string>();
  for (const p of [...placements].sort((a, b) => a.z - b.z)) {
    let z = p.z;
    while (z > 0) {
      let clear = true;
      for (let x = p.x; x < p.x + p.dx && clear; x++)
        for (let y = p.y; y < p.y + p.dy && clear; y++)
          if (occupied.has(cellKey(p.gridIndex, x, y, z - 1))) clear = false;
      if (!clear) break;
      z--;
    }
    p.z = z;
    for (let x = p.x; x < p.x + p.dx; x++)
      for (let y = p.y; y < p.y + p.dy; y++)
        for (let zz = z; zz < z + p.dz; zz++) occupied.add(cellKey(p.gridIndex, x, y, zz));
  }
  return placements;
}

/** Boxes resting on nothing at all. Partial overhang is fine — the grid snaps and holds it. */
function floating(placements: readonly StowPlacement[]): number {
  if (!FLOATING_IS_A_PROBLEM) return 0;
  const filled = occupancy(placements);
  let bad = 0;
  for (const p of placements) {
    if (p.z === 0) continue;
    let held = false;
    for (let x = p.x; x < p.x + p.dx && !held; x++)
      for (let y = p.y; y < p.y + p.dy && !held; y++)
        if (filled.has(cellKey(p.gridIndex, x, y, p.z - 1))) held = true;
    if (!held) bad++;
  }
  return bad;
}

/** Boxes that ended up off the floor. Reaching over the top of a stack is real work even when
 *  nothing has to be MOVED, so a layout that stays flat beats one that builds upwards — and this
 *  is the term that stops "leave air between the stacks" from buying that air with a second level. */
function stackedCount(placements: readonly StowPlacement[]): number {
  return placements.filter((p) => p.z > 0).length;
}

/**
 * Faces where one mission's cargo touches another's. Zero means every stack has clear air around
 * it — which is what "spread out, you have room" looks like from the tractor beam's point of view.
 *
 * Ranked BELOW handling and ABOVE walking distance, so it only ever decides between layouts that
 * bury nothing. There is no threshold and no mode: when the hold is full, no layout can leave air
 * between stacks, every candidate scores badly here, and the term quietly stops mattering.
 */
function contacts(placements: readonly StowPlacement[]): number {
  const filled = occupancy(placements);
  let touching = 0;
  for (const [key, owner] of filled) {
    const [g, xyz] = key.split("|");
    const [x, y, z] = xyz.split(",").map(Number);
    for (const [dx, dy, dz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
      const other = filled.get(cellKey(Number(g), x + dx, y + dy, z + dz));
      if (other && other.group !== owner.group) touching++;
    }
  }
  return touching;
}

/**
 * Can this layout actually be BUILT in the load order it prescribes?
 *
 * The same corridor rule that decides what blocks an unload decides what blocks a load — a box
 * cannot be flown to a slot that a box already aboard is standing in front of. Boxes within one
 * lift are ours to order (deepest first), so only ACROSS lifts does this bite. It bites hard on the
 * obvious layout: filling the hold front-to-back in route order puts the last drop-off on the upper
 * level, and the upper level is loaded first, with nothing underneath it yet.
 */
function loadBlocked(placements: readonly StowPlacement[], grids: readonly GridSpec[]): number {
  let bad = 0;
  for (const n of placements) {
    const earlier = placements.filter((p) => p.loadStep < n.loadStep);
    if (earlier.length === 0) continue;
    if (blockersOf(n, [...earlier, n], grids[n.gridIndex]).length > 0) bad++;
  }
  return bad;
}

// ── the lifts ──────────────────────────────────────────────────────────────

interface Lift {
  missionId: string;
  /** This mission's legs, deepest-loaded first (reverse of its own route order). */
  legs: StowLeg[];
}

/**
 * Route order in, elevator order out.
 *
 * A mission's place in the queue is set by its EARLIEST drop-off, because that is the one whose
 * boxes must end up nearest the ramp. Reverse that and you have the load order: the mission you
 * unload last goes in first and sits deepest.
 *
 * ⚠️ When two missions interleave in the route — A's stops are 1st and 3rd, B's is 2nd — no load
 * order can be perfect LIFO for both, because the elevator will not split a mission across lifts.
 * That is not fixed here and should not be: it shows up as handling cost, which is exactly the
 * signal the layout search needs to go and separate them in space instead.
 */
export function buildLifts(legsInRouteOrder: readonly StowLeg[]): Lift[] {
  const rank = new Map<string, number>();
  legsInRouteOrder.forEach((leg, i) => {
    if (!rank.has(leg.missionId)) rank.set(leg.missionId, i);
  });
  const missions = [...rank.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  // Reverse route order: last delivered, first loaded.
  return missions.reverse().map((missionId) => ({
    missionId,
    legs: legsInRouteOrder.filter((l) => l.missionId === missionId).slice().reverse(),
  }));
}

/** Every leg in LOAD order — the order the boxes physically go aboard. */
function legsInLoadOrder(lifts: readonly Lift[]): StowLeg[] {
  return lifts.flatMap((m) => m.legs);
}

// ── the box signature ──────────────────────────────────────────────────────

/**
 * 🔴 The fingerprint the player matches against the elevator, which will not name the mission.
 * Commodity first because that is the column they read; then the box breakdown, largest first,
 * because two contracts for the same commodity are told apart by their box configuration.
 */
export function boxSignature(commodities: readonly string[], boxes: readonly { scu: number; count: number }[]): string {
  const names = [...new Set(commodities.filter((c): c is string => !!c))];
  const head = names.length ? names.join(" + ") : "Unnamed cargo";
  const tail = [...boxes]
    .sort((a, b) => b.scu - a.scu)
    .map((b) => `${b.count}x ${b.scu} SCU`)
    .join(" + ");
  return tail ? `${head} — ${tail}` : head;
}

// ── candidate layouts ──────────────────────────────────────────────────────
//
// Each candidate is a whole-ship layout produced by one strategy. They are all scored by the same
// objective and the best one wins, so adding a strategy is additive and never changes the others.

interface Candidate {
  strategy: string;
  placements: StowPlacement[];
  unplacedIds: Set<string>;
}

function itemsOf(leg: StowLeg): PackItem[] {
  return leg.boxes.map((b, i) => ({ id: `${leg.group}#${i}`, scu: b.scu, dims: b.dims, group: leg.group }));
}

/** Run the layered packer over a sub-rectangle of a grid and translate the result back. */
function packInto(
  parent: GridSpec,
  gridIndex: number,
  origin: { x: number; y: number; z: number },
  box: { w: number; l: number; h: number },
  leg: StowLeg,
  loadStep: number,
): StowPlacement[] | null {
  if (box.w <= 0 || box.l <= 0 || box.h <= 0) return null;
  const r = packCargo([{ name: "region", w: box.w, l: box.l, h: box.h, maxBox: parent.maxBox }], itemsOf(leg));
  if (!r.fits) return null;
  return r.placements.map((p) => ({
    boxId: p.item,
    missionId: leg.missionId,
    destination: leg.destination,
    group: leg.group,
    commodity: leg.commodity,
    gridIndex,
    x: origin.x + p.x,
    y: origin.y + p.y,
    z: origin.z + p.z,
    scu: p.scu,
    dx: p.dx,
    dy: p.dy,
    dz: p.dz,
    loadStep,
  }));
}

interface Region {
  gridIndex: number;
  grid: GridSpec;
  z0: number;
  h: number;
  /** Cells consumed along the allocation axis so far. */
  used: number;
}

/** Grid x level, bottom level of every grid before the upper level of any of them.
 *  🔑 That order is the point: a second grid's floor is always cheaper to reach than the first
 *  grid's shelf, and the naive packer — which fills one grid to the ceiling before touching the
 *  next — gets this backwards every time. */
function regionsOf(grids: readonly GridSpec[], only?: number): Region[] {
  const out: Region[] = [];
  const levels = Math.max(...grids.map((g) => Math.ceil(g.h / LEVEL_H)), 1);
  for (let level = 0; level < levels; level++) {
    grids.forEach((grid, gridIndex) => {
      if (only != null && gridIndex !== only) return;
      const z0 = level * LEVEL_H;
      const h = Math.min(LEVEL_H, grid.h - z0);
      if (h > 0) out.push({ gridIndex, grid, z0, h, used: 0 });
    });
  }
  return out;
}

/**
 * SEPARATED layouts: every drop-off gets its own exclusive slab of hold, so nothing can bury
 * anything. Two axes to slice on, because which one wins depends on the shape of the cargo:
 *
 *   `bands` — full-width slices across the hold, allocated from the BACK forward. This is the shape
 *             LIFO wants, and it wastes almost nothing.
 *   `lanes` — full-length slices side by side, allocated from x = 0, all sitting at the front. Wins
 *             when there are several small missions and plenty of width: three 2-wide stacks by the
 *             ramp beats three bands strung out down a 15-deep hold.
 *
 * Groups are allocated in LOAD order and each band is anchored so the newest one is never behind an
 * older one, which makes the whole layout constructible by definition rather than by luck.
 *
 * Returns null the moment a group has nowhere exclusive to go — that is the honest signal that the
 * load is too full to separate, and the dense candidates take over.
 */
function separated(
  grids: readonly GridSpec[],
  lifts: readonly Lift[],
  axis: "bands" | "lanes",
  gap: number,
  onlyGrid?: (missionId: string) => number | undefined,
): StowPlacement[] | null {
  const shared = onlyGrid ? null : regionsOf(grids);
  const perMission = new Map<string, Region[]>();
  const placements: StowPlacement[] = [];

  lifts.forEach((lift, i) => {
    const step = i + 1;
    let regions = shared;
    if (!regions) {
      const g = onlyGrid!(lift.missionId);
      if (g == null) throw new Error("unassigned");
      if (!perMission.has(lift.missionId)) perMission.set(lift.missionId, regionsOf(grids, g));
      regions = perMission.get(lift.missionId)!;
    }
    for (const leg of lift.legs) {
      const scu = leg.boxes.reduce((s, b) => s + b.scu, 0);
      let done = false;
      for (const r of regions) {
        const span = axis === "bands" ? r.grid.l : r.grid.w;
        const avail = span - r.used;
        const cross = (axis === "bands" ? r.grid.w : r.grid.l) * r.h;
        // Nothing smaller than this can hold the cargo, so do not bother trying it.
        const lo = Math.max(1, Math.ceil(scu / Math.max(1, cross)));
        for (let size = lo; size <= avail; size++) {
          const box =
            axis === "bands"
              ? { w: r.grid.w, l: size, h: r.h }
              : { w: size, l: r.grid.l, h: r.h };
          const origin =
            axis === "bands"
              ? { x: 0, y: r.grid.l - r.used - size, z: r.z0 }
              : { x: r.used, y: 0, z: r.z0 };
          const got = packInto(r.grid, r.gridIndex, origin, box, leg, step);
          if (!got) continue;
          placements.push(...got);
          r.used += size + gap;
          done = true;
          break;
        }
        if (done) break;
      }
      if (!done) throw new Error("no room");
    }
  });
  return placements;
}

function trySeparated(
  grids: readonly GridSpec[],
  lifts: readonly Lift[],
  axis: "bands" | "lanes",
  gap: number,
  onlyGrid?: (missionId: string) => number | undefined,
): StowPlacement[] | null {
  try {
    return separated(grids, lifts, axis, gap, onlyGrid);
  } catch {
    return null;
  }
}

/**
 * DENSE: the layered packer over the real grids, one pass, groups kept contiguous. This is what
 * takes over when the load is too full to separate, so it has to get LIFO exactly right.
 *
 * 🔑 AND THE OBVIOUS WAY ROUND IS THE WRONG WAY ROUND. `packCargo` fills front-to-back and
 * bottom-to-top, so feeding it the load order puts the LAST drop-off by the ramp and the FIRST one
 * up on the shelf at the back — the first stop then costs a full excavation. Feeding it the route
 * order instead puts the first drop-off by the ramp but buries it under the shelf above, and cannot
 * be built at all (the shelf loads first, with nothing underneath it).
 *
 * `mirrorY` is the fix and it is one line: pack in LOAD order into a grid whose depth axis is
 * flipped, then flip the answer back. The last drop-off lands at the bottom of the back, each
 * earlier one lands in front of it, and the first drop-off ends up on top at the ramp — which is
 * both perfectly LIFO and constructible in that exact order. All three are generated and scored;
 * `loadBlocked` throws out whichever cannot be flown into place.
 */
function dense(
  strategy: string,
  grids: readonly GridSpec[],
  lifts: readonly Lift[],
  legs: readonly StowLeg[],
  order: readonly string[],
  mirrorY = false,
): Candidate {
  const stepOf = new Map<string, number>();
  const legOf = new Map<string, StowLeg>();
  lifts.forEach((lift, i) => {
    for (const leg of lift.legs) {
      stepOf.set(leg.group, i + 1);
      legOf.set(leg.group, leg);
    }
  });
  const items = legs.flatMap(itemsOf);
  const r = packCargo(grids, items, { groupOrder: [...order] });
  const indexOfGrid = new Map(grids.map((g, i) => [g.name, i]));
  const placements = r.placements.map((p): StowPlacement => {
    const leg = legOf.get(p.group ?? "")!;
    const gridIndex = indexOfGrid.get(p.grid) ?? 0;
    return {
      boxId: p.item,
      missionId: leg.missionId,
      destination: leg.destination,
      group: leg.group,
      commodity: leg.commodity,
      gridIndex,
      x: p.x,
      y: mirrorY ? grids[gridIndex].l - (p.y + p.dy) : p.y,
      z: p.z,
      scu: p.scu,
      dx: p.dx,
      dy: p.dy,
      dz: p.dz,
      loadStep: stepOf.get(leg.group) ?? 1,
    };
  });
  return { strategy, placements, unplacedIds: new Set(r.unplaced.map((u) => u.id)) };
}

// ── the plan ───────────────────────────────────────────────────────────────

/**
 * Build the stowage plan.
 *
 * `legs` must be in ROUTE ORDER — first drop-off first. That single ordering drives everything:
 * the lifts, the LIFO depth, and the order the handling simulation walks the run in.
 */
export function planStowage(
  grids: readonly GridSpec[],
  legs: readonly StowLeg[],
  opts: StowOptions = {},
): StowPlan {
  const notes: string[] = [];
  const capacityScu = shipCapacityScu(grids);
  const gridViews = (used: Map<number, number>): StowGridView[] =>
    grids.map((g, index) => ({
      index,
      name: g.name,
      w: g.w,
      l: g.l,
      h: g.h,
      capacityScu: gridCapacityScu(g),
      usedScu: used.get(index) ?? 0,
    }));

  // 🔑 An auto-loading ship needs no plan at all — the game loads it, the player never sees the
  // inside of the hold, and drawing a stowage diagram for it would be inventing a chore.
  if (canAutoLoad(opts.shipClass)) {
    return {
      autoLoad: true,
      placements: [],
      loadOrder: [],
      grids: gridViews(new Map()),
      unplaced: [],
      fits: true,
      loadedScu: 0,
      capacityScu,
      handling: {
        moves: 0,
        perStop: [],
        verdict: "spread",
        reason: `${opts.shipName ?? opts.shipClass} auto-loads — the game stows it for you, so there is nothing to lay out.`,
        slackScu: capacityScu,
        strategy: "auto-load",
        considered: [],
      },
      signatureClashes: [],
      notes: [],
    };
  }

  const carried = legs.filter((l) => l.boxes.length > 0);
  const lifts = buildLifts(carried);
  const routeOrder = carried.map((l) => l.group);
  const loadOrderLegs = legsInLoadOrder(lifts);
  const totalScu = carried.reduce((s, l) => s + l.boxes.reduce((t, b) => t + b.scu, 0), 0);

  if (!grids.length || !carried.length) {
    return {
      autoLoad: false,
      placements: [],
      loadOrder: buildLoadOrder(lifts, [], opts, notes),
      grids: gridViews(new Map()),
      unplaced: [],
      fits: carried.length === 0,
      loadedScu: 0,
      capacityScu,
      handling: {
        moves: 0,
        perStop: [],
        verdict: "spread",
        reason: !grids.length ? "No ship picked, so there is nowhere to put anything." : "Nothing to load.",
        slackScu: capacityScu,
        strategy: "none",
        considered: [],
      },
      signatureClashes: [],
      notes: grids.length ? notes : [...notes, "Pick the ship you are flying to see where the boxes go."],
    };
  }

  // ── candidates ──────────────────────────────────────────────────────────
  const gap = opts.gap ?? 1;
  const gridForMission = (() => {
    // One mission per grid, biggest mission into the biggest grid. Only offered when the hull has
    // grids to spare — a Hull C has sixteen and separates perfectly; an Ironclad Assault has two.
    if (grids.length < lifts.length) return null;
    const byScu = [...lifts]
      .map((m) => ({ id: m.missionId, scu: m.legs.reduce((s, l) => s + l.boxes.reduce((t, b) => t + b.scu, 0), 0) }))
      .sort((a, b) => b.scu - a.scu);
    const order = grids
      .map((g, i) => ({ i, cap: gridCapacityScu(g) }))
      .sort((a, b) => b.cap - a.cap);
    const map = new Map<string, number>();
    byScu.forEach((m, i) => map.set(m.id, order[i].i));
    return (missionId: string) => map.get(missionId);
  })();

  const built: Candidate[] = [];
  const add = (strategy: string, p: StowPlacement[] | null) => {
    if (p) built.push({ strategy, placements: p, unplacedIds: new Set() });
  };
  if (gridForMission) add("grid-per-mission", trySeparated(grids, lifts, "bands", 0, gridForMission));
  add("lanes-gap", trySeparated(grids, lifts, "lanes", gap));
  add("lanes", trySeparated(grids, lifts, "lanes", 0));
  add("bands-gap", trySeparated(grids, lifts, "bands", gap));
  add("bands", trySeparated(grids, lifts, "bands", 0));
  const loadGroups = loadOrderLegs.map((l) => l.group);
  built.push(dense("dense-route", grids, lifts, carried, routeOrder));
  built.push(dense("dense-load", grids, lifts, loadOrderLegs, loadGroups));
  built.push(dense("dense-lifo", grids, lifts, loadOrderLegs, loadGroups, true));

  // ── score ───────────────────────────────────────────────────────────────
  interface Scored {
    c: Candidate;
    moves: number;
    reach: number;
    air: number;
    stacked: number;
    touch: number;
    perStop: { group: string; destination: string | null; moves: number }[];
    rejected: string | null;
  }
  const scored: Scored[] = built.map((c) => {
    // Gravity first — everything below is measured on the layout the player would actually end up
    // with, not the one the shelf packer drew.
    settle(c.placements);
    const blocked = loadBlocked(c.placements, grids);
    const sim = simulateUnload(c.placements, grids, routeOrder);
    return {
      c,
      moves: sim.moves,
      reach: reachOf(c.placements),
      air: floating(c.placements),
      stacked: stackedCount(c.placements),
      touch: contacts(c.placements),
      perStop: sim.perStop,
      // The one genuinely impossible layout: a box that cannot be flown to its slot because
      // something already aboard is standing in the way. Not a preference — it cannot be built.
      rejected: blocked ? `${blocked} boxes cannot be flown into place in the load order` : null,
    };
  });

  const usable = scored.filter((s) => !s.rejected);
  const pool = usable.length ? usable : scored;
  const best = pool.reduce((a, b) => {
    // 🔑 THE ORDER OF THESE SIX LINES IS THE DESIGN. Space used appears nowhere in it — every
    // term is a statement about WORK, in decreasing order of how much of it the mistake costs.
    //   1. boxes left behind   — a plan that abandons cargo is not a plan
    //   2. boxes in mid-air    — a plan that may not be buildable is worse than one that is
    //   3. boxes to be shifted — THE OBJECTIVE: handling, walked in route order
    //   4. boxes off the floor — do not build upwards to buy elbow room
    //   5. stacks touching     — with all of that equal, leave air between missions
    //   6. distance to reach   — and keep it near the ramp
    const left = (s: Scored) => s.c.unplacedIds.size;
    if (left(b) !== left(a)) return left(b) < left(a) ? b : a;
    if (b.air !== a.air) return b.air < a.air ? b : a;
    if (b.moves !== a.moves) return b.moves < a.moves ? b : a;
    if (b.stacked !== a.stacked) return b.stacked < a.stacked ? b : a;
    if (b.touch !== a.touch) return b.touch < a.touch ? b : a;
    return b.reach < a.reach ? b : a;
  });
  if (!usable.length) notes.push("Every layout tried needs a box flown through another one — the least bad is shown.");
  if (best.air) notes.push(`${best.air} box${best.air === 1 ? " is" : "es are"} resting on nothing. If the grid will not hold it there, load that one last.`);

  const placements = best.c.placements;
  const usedByGrid = new Map<number, number>();
  for (const p of placements) usedByGrid.set(p.gridIndex, (usedByGrid.get(p.gridIndex) ?? 0) + p.scu);
  const loadedScu = placements.reduce((s, p) => s + p.scu, 0);
  const slackScu = capacityScu - loadedScu;

  const unplaced = [...best.c.unplacedIds].map((id) => {
    const leg = carried.find((l) => id.startsWith(`${l.group}#`));
    const i = Number(id.slice(id.lastIndexOf("#") + 1));
    return {
      boxId: id,
      missionId: leg?.missionId ?? "",
      group: leg?.group ?? "",
      scu: leg?.boxes[i]?.scu ?? 0,
    };
  });
  if (unplaced.length) notes.push(`${unplaced.length} boxes do not fit — this is more than one trip.`);
  if (totalScu > capacityScu) {
    notes.push(`${totalScu} SCU of cargo against ${capacityScu} SCU of hold.`);
  }

  const loadOrder = buildLoadOrder(lifts, placements, opts, notes);
  const clashes = clashesIn(loadOrder);

  // 🔑 A contract that delivers either side of another one cannot be stowed cleanly, however much
  // room there is: the elevator will not split a contract across two lifts, so one of the two has
  // to go in behind cargo it will be dug out from under. That is a different problem from a full
  // hold and the widget must not blame the wrong thing.
  const interleaved = [...new Set(carried.map((l) => l.missionId))].filter((id) => {
    const at = carried.map((l, i) => (l.missionId === id ? i : -1)).filter((i) => i >= 0);
    return at.length > 1 && at[at.length - 1] - at[0] + 1 > at.length;
  });
  const nameOf = (id: string) => opts.missionTitles?.[id] ?? id;

  const verdict: "spread" | "tight" = best.moves === 0 && !unplaced.length ? "spread" : "tight";
  const boxWord = `${best.moves} box${best.moves === 1 ? "" : "es"}`;
  const reason =
    // Over capacity trumps everything: a hold that cannot take the load is not "spread out",
    // whatever the layout of the part that fits looks like.
    unplaced.length
      ? `Over capacity — ${unplaced.length} box${unplaced.length === 1 ? "" : "es"} will not go aboard. This is more than one trip.`
      : best.moves === 0
      ? `Spread out — nothing is buried, and ${slackScu} SCU of hold is spare.`
      : interleaved.length
        ? `Packed tight — ${boxWord} get shifted on the way. ${interleaved.map(nameOf).join(" and ")} deliver${interleaved.length > 1 ? "" : "s"} either side of another contract, and the freight elevator will not split a contract across two lifts, so something has to go in behind.`
        : `Packed tight — ${boxWord} have to be shifted along the way. With ${slackScu} SCU spare there is nowhere to separate them.`;
  if (interleaved.length && best.moves > 0) {
    notes.push(`Re-ordering the route so ${interleaved.map(nameOf).join(" and ")} deliver${interleaved.length > 1 ? "" : "s"} back to back would remove most of the shuffling.`);
  }

  return {
    autoLoad: false,
    placements,
    loadOrder,
    grids: gridViews(usedByGrid),
    unplaced,
    fits: unplaced.length === 0,
    loadedScu,
    capacityScu,
    handling: {
      moves: best.moves,
      perStop: best.perStop,
      verdict,
      reason,
      slackScu,
      strategy: best.c.strategy,
      considered: scored.map((s) => ({
        strategy: s.c.strategy,
        moves: s.rejected ? null : s.moves,
        reach: s.rejected ? null : s.reach,
        rejected: s.rejected,
      })),
    },
    signatureClashes: clashes,
    notes,
  };
}

// ── the load list ──────────────────────────────────────────────────────────

function buildLoadOrder(
  lifts: readonly Lift[],
  placements: readonly StowPlacement[],
  opts: StowOptions,
  notes: string[],
): LoadStep[] {
  const steps: LoadStep[] = lifts.map((lift, i) => {
    const counted = new Map<number, number>();
    for (const leg of lift.legs) for (const b of leg.boxes) counted.set(b.scu, (counted.get(b.scu) ?? 0) + 1);
    const boxes = [...counted].sort((a, b) => b[0] - a[0]).map(([scu, count]) => ({ scu, count }));
    const commodities = lift.legs.map((l) => l.commodity).filter((c): c is string => !!c);
    const placedIn = (group: string) =>
      placements.filter((p) => p.group === group).map((p) => p.boxId);
    return {
      step: i + 1,
      missionId: lift.missionId,
      title: opts.missionTitles?.[lift.missionId] ?? null,
      signature: boxSignature(commodities, boxes),
      commodities: [...new Set(commodities)],
      boxes,
      boxCount: boxes.reduce((s, b) => s + b.count, 0),
      scu: lift.legs.reduce((s, l) => s + l.boxes.reduce((t, b) => t + b.scu, 0), 0),
      ambiguous: false,
      ambiguousWith: [],
      orderMatters: false,
      destinations: lift.legs.map((leg) => ({
        group: leg.group,
        destination: leg.destination,
        commodity: leg.commodity,
        scu: leg.boxes.reduce((s, b) => s + b.scu, 0),
        boxIds: placedIn(leg.group),
      })),
      boxIds: lift.legs.flatMap((leg) => placedIn(leg.group)),
    };
  });

  // 🔴 Two missions that look the same on the elevator. Say so — an instruction the player cannot
  // physically follow is worse than no instruction.
  const bySignature = new Map<string, LoadStep[]>();
  for (const s of steps) {
    if (!bySignature.has(s.signature)) bySignature.set(s.signature, []);
    bySignature.get(s.signature)!.push(s);
  }
  for (const [signature, group] of bySignature) {
    if (group.length < 2) continue;
    const consecutive = group.every((s, i) => i === 0 || s.step === group[i - 1].step + 1);
    for (const s of group) {
      s.ambiguous = true;
      s.ambiguousWith = group.filter((o) => o !== s).map((o) => o.missionId);
      s.orderMatters = !consecutive;
    }
    notes.push(
      consecutive
        ? `Two contracts look identical on the elevator (${signature}). They are lifted back to back, so the order does not matter — but note which stack is which, because a box will only satisfy the contract it came from.`
        : `⚠️ Two contracts look identical on the elevator (${signature}) and are NOT lifted back to back. Check the contract before you lift — a box only satisfies the contract it came from, and nothing on the elevator will tell you which is which.`,
    );
  }
  return steps;
}

// ── the adapter ────────────────────────────────────────────────────────────

/**
 * The one call the endpoint needs: a landed `HaulingPlan` in, a stowage plan out.
 *
 * Deliberately additive — it reads `buildHaulingPlan`'s output and changes nothing in it, so wiring
 * this up is a new field on a response rather than an edit to the plan builder that three other
 * flights are also standing in.
 *
 * 🔑 Route order comes from the TRIPS' drop-off order, not from the contract list. The contract
 * list is the order the player accepted things in; the trip is the order they will actually fly,
 * and that is the only order LIFO means anything against. Legs the route could not place fall to
 * the back, because a leg with no known destination cannot be laid out ahead of one that has one.
 */
export function stowFromPlan(plan: StowPlanSource, boxSet: readonly { scu: number; dims: readonly [number, number, number] }[], opts: StowOptions = {}): StowPlan {
  const dimsOf = new Map(boxSet.map((b) => [b.scu, b.dims]));
  const legByGroup = new Map<string, StowLeg>();
  const titles: Record<string, string | null> = { ...opts.missionTitles };

  for (const c of plan.contracts) {
    titles[c.missionId] ??= c.title;
    for (const l of c.legs) {
      if (l.dropoffState === "completed") continue;
      const boxes: StowBox[] = [];
      for (const b of l.boxes) {
        const dims = dimsOf.get(b.scu);
        // A size with no footprint cannot be drawn. `buildHaulingPlan` already counts and reports
        // these; dropping them here silently would double-report, so just leave them out.
        if (!dims) continue;
        for (let i = 0; i < b.count; i++) boxes.push({ scu: b.scu, dims });
      }
      legByGroup.set(l.group, {
        group: l.group,
        missionId: c.missionId,
        destination: l.destination ?? (l.toLocation ? plan.locationNames[l.toLocation] ?? null : null),
        commodity: l.commodity,
        boxes,
      });
    }
  }

  const ordered: StowLeg[] = [];
  for (const trip of plan.trips) {
    for (const stop of trip.stops) {
      if (stop.kind !== "dropoff") continue;
      for (const a of stop.actions) {
        const leg = legByGroup.get(a.group);
        if (leg && !ordered.includes(leg)) ordered.push(leg);
      }
    }
  }
  for (const leg of legByGroup.values()) if (!ordered.includes(leg)) ordered.push(leg);

  const grids: GridSpec[] = (plan.ship?.grids ?? []).map((g) => ({ name: g.name, w: g.w, l: g.l, h: g.h, maxBox: g.maxBox }));
  return planStowage(grids, ordered, {
    ...opts,
    shipClass: opts.shipClass ?? plan.ship?.className ?? null,
    shipName: opts.shipName ?? plan.ship?.displayName ?? null,
    missionTitles: titles,
  });
}

/** The slice of `HaulingPlan` this module reads. Structural, so it takes the real thing without
 *  importing it — which keeps `hauling-plan.ts` free of a dependency on the stowage brain. */
export interface StowPlanSource {
  ship: { className: string; displayName: string | null; grids: GridSpec[] } | null;
  contracts: {
    missionId: string;
    title: string | null;
    legs: {
      group: string;
      commodity: string | null;
      destination: string | null;
      toLocation: string | null;
      dropoffState: string;
      boxes: { scu: number; count: number }[];
    }[];
  }[];
  trips: { stops: { kind: "pickup" | "dropoff"; actions: { group: string }[] }[] }[];
  locationNames: Record<string, string>;
}

function clashesIn(steps: readonly LoadStep[]): { signature: string; missionIds: string[] }[] {
  const by = new Map<string, string[]>();
  for (const s of steps) {
    if (!by.has(s.signature)) by.set(s.signature, []);
    by.get(s.signature)!.push(s.missionId);
  }
  return [...by].filter(([, ids]) => ids.length > 1).map(([signature, missionIds]) => ({ signature, missionIds }));
}
