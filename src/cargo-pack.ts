/**
 * CARGO BIN-PACKER — where does each box physically go on this ship's grids.
 *
 * 🔴 NOTHING FLOATS. A box rests on the floor, or every cell of its footprint rests on a box below.
 * That is the whole rule, and it is why this tracks real per-cell occupancy.
 *
 * ⚠️ It used to be SHELF PACKING in level bands — fill a z band, close it, start the next on top —
 * and that model was wrong in three ways at once, all of which Sub hit in one evening on 2026-08-17:
 *
 *   • It never asked what was UNDER a box, so a level laid on a partly-filled one left boxes
 *     hanging in mid-air. "I can't put a box in a floating position... this is a space sim, not an
 *     arcade game."
 *   • A closed level could never be revisited, so it refused 52 SCU of boxes while 278 SCU of the
 *     hold stood empty — a hold 40% free reporting "does not fit".
 *   • Groups were ordered along y while stacking happened along z with nothing reconciling them, so
 *     the load order contradicted the picture: a box told to load FIRST sat on one loaded later.
 *
 * Boxes are placed individually, biggest first, at the first position that can hold them, chosen by
 * (y, z, x) — nearest the ramp, then lowest, then across. The hold fills as a supported wall from
 * the door backwards, small boxes settle into the gaps left on top, and groups packed in unload
 * order still come out nearest the door with no shelf bookkeeping at all.
 *
 * Box height is capped at 2 cells by every real grid (`maxPermittedItemSize.z` = 2.5 m), so stacks
 * stay shallow; that is a property of the data, not an assumption the algorithm needs.
 *
 * A ship is SEVERAL GRIDS with different dimensions, not one pool of SCU — a C2 is 8x15x4 plus
 * 6x9x4, and a box that fits the first may not fit the second. Grids are filled in the order given.
 *
 * Pure functions only: grids come in as plain specs (from `data/ships.json` once the `foundations`
 * flight lands it), boxes come in as plain items. Nothing here reads a file or knows about a ship.
 */
import type { BoxSpec } from "./cargo-boxes.js";

/** One cargo grid, in CELLS (1 cell = 1.25 m = 1 SCU). x = width, y = length, z = height. */
export interface GridSpec {
  name: string;
  w: number;
  l: number;
  h: number;
  /** Per-axis `maxPermittedItemSize` in cells, when the grid states one. z is ~always 2. */
  maxBox?: { x: number; y: number; z: number };
}

export interface PackItem {
  id: string;
  scu: number;
  /** [x, y, z] in cells as the box rests. Yaw rotation (x<->y) is the only re-orientation. */
  dims: readonly [number, number, number];
  /** Drop-off key. Boxes sharing one are kept contiguous so a stop unloads in one go. */
  group?: string;
}

export interface Placement {
  grid: string;
  item: string;
  group: string | null;
  scu: number;
  /** Lower-near-left corner of the box, in cells from the grid origin. */
  x: number;
  y: number;
  z: number;
  /** Footprint and height AS PLACED — dx/dy are swapped from `dims` when the box was yawed. */
  dx: number;
  dy: number;
  dz: number;
}

export interface GridUsage {
  grid: string;
  usedScu: number;
  capacityScu: number;
}

export interface PackResult {
  placements: Placement[];
  /** Boxes that did not fit anywhere. Empty iff `fits`. */
  unplaced: PackItem[];
  fits: boolean;
  loadedScu: number;
  capacityScu: number;
  byGrid: GridUsage[];
}

export interface PackOptions {
  /**
   * Drop-off keys in UNLOAD order — first out of the ramp first. Groups are packed in this order,
   * each starting a fresh shelf, so the first stop's boxes end up nearest the grid entrance.
   * Groups not listed are packed last, in first-seen order.
   */
  groupOrder?: string[];
}

/** A grid's SCU rating is just its cell count — 1 cell = 1 SCU. */
export function gridCapacityScu(g: GridSpec): number {
  return g.w * g.l * g.h;
}

/** Total hold of a ship. C2 = 8*15*4 + 6*9*4 = 696. */
export function shipCapacityScu(grids: readonly GridSpec[]): number {
  return grids.reduce((sum, g) => sum + gridCapacityScu(g), 0);
}

/** Turn a partition's box specs into packable items, tagged with their drop-off. */
export function itemsFromBoxes(boxes: readonly BoxSpec[], group: string, idPrefix = group): PackItem[] {
  return boxes.map((b, i) => ({ id: `${idPrefix}#${i}`, scu: b.scu, dims: b.dims, group }));
}

// ── internals ──────────────────────────────────────────────────────────────
//
// ⚠️ There is no "unit" type any more. Identical flat boxes from one drop-off used to be PAIRED
// into a 2-high unit before packing, because a level took the height of its tallest box and a lone
// 1-high box wasted the slot it sat in. With per-cell occupancy there are no levels and nothing to
// waste — a box occupies exactly what it is, and stacking is simply what happens when one lands on
// another. The pairing only made larger, more awkward shapes to place.

/** Yaw is the only rotation — a 24 SCU box on its end would break the 2-cell height cap anyway. */
function orientations(dims: [number, number, number]): Array<[number, number, number]> {
  const [a, b, c] = dims;
  return a === b ? [[a, b, c]] : [[a, b, c], [b, a, c]];
}

/**
 * 🔴 THE HOLD IS CELLS, NOT BANDS — and nothing floats.
 *
 * The previous engine was shelf packing: fill a level (z band), close it, start the next on top.
 * It never asked what was UNDER a box, so it would place one over an empty part of the level below
 * — a box hanging in mid-air, which Sub rejected on sight: "this is a space sim, not an arcade
 * game." And because a closed level could never be revisited, it also refused 52 SCU of boxes while
 * 278 SCU of the hold stood empty, and produced load orders that contradicted their own stacking
 * (a box scheduled to load FIRST, resting on one loaded later).
 *
 * All three were the same defect. This tracks real occupancy per cell and enforces one rule:
 *
 *   a box sits on the floor, or every cell of its footprint rests on a box below.
 *
 * Position is chosen by (y, z, x) — nearest the ramp first, then lowest, then across. So the hold
 * fills as a wall from the door backwards, each box supported, and groups packed in unload order
 * come out nearest the door without any shelf bookkeeping.
 */
class Occupancy {
  private readonly cells: Uint8Array;
  constructor(readonly w: number, readonly l: number, readonly h: number) {
    this.cells = new Uint8Array(w * l * h);
  }
  private idx(x: number, y: number, z: number): number {
    return (z * this.l + y) * this.w + x;
  }
  free(x: number, y: number, z: number): boolean {
    return this.cells[this.idx(x, y, z)] === 0;
  }
  filled(x: number, y: number, z: number): boolean {
    return this.cells[this.idx(x, y, z)] === 1;
  }
  fill(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    for (let X = x; X < x + dx; X++) for (let Y = y; Y < y + dy; Y++) for (let Z = z; Z < z + dz; Z++) {
      this.cells[this.idx(X, Y, Z)] = 1;
    }
  }
  /** Room for this box here, AND something holding it up. */
  accepts(x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean {
    if (x + dx > this.w || y + dy > this.l || z + dz > this.h) return false;
    for (let X = x; X < x + dx; X++) for (let Y = y; Y < y + dy; Y++) for (let Z = z; Z < z + dz; Z++) {
      if (!this.free(X, Y, Z)) return false;
    }
    if (z === 0) return true;   // the floor holds anything
    // ⚠️ EVERY cell must be supported, not most. A box overhanging its neighbour by one cell is
    // still a box that falls over, and "mostly supported" is the kind of rule that looks fine in a
    // diagram and cannot be built in the ship.
    for (let X = x; X < x + dx; X++) for (let Y = y; Y < y + dy; Y++) {
      if (!this.filled(X, Y, z - 1)) return false;
    }
    return true;
  }
}

/** Lowest, nearest the ramp, leftmost — the first position that can actually hold the box. */
function findSpot(g: GridSpec, occ: Occupancy, dims: readonly [number, number, number]): { x: number; y: number; z: number; dx: number; dy: number; dz: number } | null {
  const cap = g.maxBox;
  let best: { x: number; y: number; z: number; dx: number; dy: number; dz: number } | null = null;
  for (const [dx, dy, dz] of orientations(dims as [number, number, number])) {
    if (cap && (dx > cap.x || dy > cap.y || dz > cap.z)) continue;
    for (let y = 0; y <= g.l - dy; y++) {
      for (let z = 0; z <= g.h - dz; z++) {
        for (let x = 0; x <= g.w - dx; x++) {
          if (!occ.accepts(x, y, z, dx, dy, dz)) continue;
          if (!best || y < best.y || (y === best.y && (z < best.z || (z === best.z && x < best.x)))) {
            best = { x, y, z, dx, dy, dz };
          }
          break;   // leftmost x at this (y,z) is the best x; no need to scan further
        }
      }
    }
  }
  return best;
}

// ── the packer ─────────────────────────────────────────────────────────────

export function packCargo(
  grids: readonly GridSpec[],
  items: readonly PackItem[],
  opts: PackOptions = {},
): PackResult {
  // Group order decides unload order; ungrouped boxes ride at the back.
  const seen: string[] = [];
  for (const it of items) {
    const key = it.group ?? "";
    if (!seen.includes(key)) seen.push(key);
  }
  const wanted = opts.groupOrder ?? [];
  const groupKeys = [
    ...wanted.filter((k) => seen.includes(k)),
    ...seen.filter((k) => !wanted.includes(k)),
  ];

  const queue: PackItem[] = [];
  for (const key of groupKeys) {
    // Biggest first — the classic decreasing order. Small boxes then settle into what is left,
    // including the gaps on top, which is exactly what the level-band engine could never go back
    // and do.
    queue.push(...items
      .filter((it) => (it.group ?? "") === key)
      .sort((a, b) => b.scu - a.scu || b.dims[0] * b.dims[1] - a.dims[0] * a.dims[1]));
  }

  const placements: Placement[] = [];
  const usedByGrid = new Map<string, number>();
  let remaining = queue;

  for (const g of grids) {
    if (remaining.length === 0) break;
    const occ = new Occupancy(g.w, g.l, g.h);
    const leftovers: PackItem[] = [];

    for (const it of remaining) {
      const spot = findSpot(g, occ, it.dims);
      if (!spot) { leftovers.push(it); continue; }
      occ.fill(spot.x, spot.y, spot.z, spot.dx, spot.dy, spot.dz);
      placements.push({
        grid: g.name,
        item: it.id,
        group: it.group ?? null,
        scu: it.scu,
        x: spot.x,
        y: spot.y,
        z: spot.z,
        dx: spot.dx,
        dy: spot.dy,
        dz: spot.dz,
      });
      usedByGrid.set(g.name, (usedByGrid.get(g.name) ?? 0) + it.scu);
    }
    remaining = leftovers;
  }

  const unplaced = remaining;
  return {
    placements,
    unplaced,
    fits: unplaced.length === 0,
    loadedScu: placements.reduce((sum, p) => sum + p.scu, 0),
    capacityScu: shipCapacityScu(grids),
    byGrid: grids.map((g) => ({
      grid: g.name,
      usedScu: usedByGrid.get(g.name) ?? 0,
      capacityScu: gridCapacityScu(g),
    })),
  };
}
