/**
 * CARGO BIN-PACKER — where does each box physically go on this ship's grids.
 *
 * 🔑 This is NOT a general 3D packer, and deliberately so. Every real cargo grid caps box height at
 * 2 cells (`maxPermittedItemSize.z` = 2.5 m), so nothing is ever more than 2 cells tall and big
 * boxes always lie flat. That collapses the problem to LAYERED 2D: fill a level, move up, repeat.
 * A 4-cell-high grid is two levels of 2-high boxes, and that is as deep as the stack ever gets.
 *
 * The algorithm is shelf packing (first-fit-decreasing-height) inside each level:
 *   level (z band)  ->  shelf (y band, depth set by its first box)  ->  boxes laid across x.
 * Which is also how a human loads a freight elevator: rows of boxes front to back. Layouts come
 * out legible rather than merely dense, and at these sizes (a C2 holds ~40 boxes) greedy is fine.
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
// A "unit" is what the packer actually places. Usually one box. But a box only 1 cell tall wastes
// the top half of a 2-high level if placed alone, and in the game you simply stack a second one on
// it — so identical flat boxes from the SAME drop-off are paired into one 2-high unit up front and
// split back into two placements at the end. Without this, a contract capped at 1 SCU (Sub has
// one: 8 SCU of Aluminium, eight 1x1x1 boxes) would burn twice the grid it needs.

interface Unit {
  dims: [number, number, number];
  group: string | null;
  /** Members bottom-up; > 1 only for a stacked pair. */
  members: PackItem[];
}

interface Cursor {
  z: number;
  levelH: number;
  y: number;
  shelfD: number;
  x: number;
}

const MAX_STACK_H = 2;

function stackFlat(items: PackItem[]): Unit[] {
  const units: Unit[] = [];
  const pending = new Map<string, PackItem>();
  for (const it of items) {
    const [dx, dy, dz] = it.dims;
    const group = it.group ?? null;
    if (dz * 2 > MAX_STACK_H) {
      units.push({ dims: [dx, dy, dz], group, members: [it] });
      continue;
    }
    const key = `${group}|${dx}x${dy}x${dz}`;
    const waiting = pending.get(key);
    if (waiting) {
      pending.delete(key);
      units.push({ dims: [dx, dy, dz * 2], group, members: [waiting, it] });
    } else {
      pending.set(key, it);
    }
  }
  // Odd ones out stand alone and keep their true height.
  for (const it of pending.values()) {
    units.push({ dims: [it.dims[0], it.dims[1], it.dims[2]], group: it.group ?? null, members: [it] });
  }
  return units;
}

/** Yaw is the only rotation — a 24 SCU box on its end would break the 2-cell height cap anyway. */
function orientations(dims: [number, number, number]): Array<[number, number, number]> {
  const [a, b, c] = dims;
  return a === b ? [[a, b, c]] : [[a, b, c], [b, a, c]];
}

function tryPlace(g: GridSpec, u: Unit, c: Cursor): [number, number, number] | null {
  const cap = g.maxBox;
  let best: [number, number, number] | null = null;
  for (const [dx, dy, dz] of orientations(u.dims)) {
    if (cap && (dx > cap.x || dy > cap.y || dz > cap.z)) continue;
    if (dz > g.h - c.z) continue;
    if (c.levelH > 0 && dz > c.levelH) continue;
    if (dy > g.l - c.y) continue;
    if (c.shelfD > 0 && dy > c.shelfD) continue;
    if (dx > g.w - c.x) continue;
    // Shallow shelves waste less: an 8x2 box laid across an 8-wide grid leaves a 2-deep shelf,
    // the same box stood along y leaves an 8-deep one that the next row can rarely refill.
    if (!best || dy < best[1] || (dy === best[1] && dx > best[0])) best = [dx, dy, dz];
  }
  return best;
}

function closeShelf(c: Cursor): void {
  c.y += c.shelfD;
  c.shelfD = 0;
  c.x = 0;
}

function closeLevel(c: Cursor): void {
  closeShelf(c);
  c.z += c.levelH;
  c.levelH = 0;
  c.y = 0;
}

/** Biggest, tallest, longest first — classic FFDH ordering. */
function sortUnits(units: Unit[]): Unit[] {
  return [...units].sort((p, q) => {
    const [px, py, pz] = p.dims;
    const [qx, qy, qz] = q.dims;
    return qz - pz || Math.max(qx, qy) - Math.max(px, py) || qx * qy - px * py;
  });
}

// ── the packer ─────────────────────────────────────────────────────────────

export function packCargo(
  grids: readonly GridSpec[],
  items: readonly PackItem[],
  opts: PackOptions = {},
): PackResult {
  const units = stackFlat([...items]);

  // Group order decides unload order; ungrouped boxes ride at the back.
  const seen: string[] = [];
  for (const u of units) {
    const key = u.group ?? "";
    if (!seen.includes(key)) seen.push(key);
  }
  const wanted = opts.groupOrder ?? [];
  const groupKeys = [
    ...wanted.filter((k) => seen.includes(k)),
    ...seen.filter((k) => !wanted.includes(k)),
  ];

  const queue: Unit[] = [];
  for (const key of groupKeys) queue.push(...sortUnits(units.filter((u) => (u.group ?? "") === key)));

  const placements: Placement[] = [];
  const usedByGrid = new Map<string, number>();
  let remaining = queue;

  for (const g of grids) {
    if (remaining.length === 0) break;
    const c: Cursor = { z: 0, levelH: 0, y: 0, shelfD: 0, x: 0 };
    const leftovers: Unit[] = [];
    let lastGroup: string | null | undefined;

    for (const u of remaining) {
      // A new drop-off starts a new shelf, so each stop's boxes sit in one contiguous band.
      if (lastGroup !== undefined && u.group !== lastGroup && c.shelfD > 0) closeShelf(c);
      lastGroup = u.group;

      let fit = tryPlace(g, u, c);
      if (!fit && c.shelfD > 0) {
        closeShelf(c);
        fit = tryPlace(g, u, c);
      }
      if (!fit && c.levelH > 0) {
        closeLevel(c);
        fit = tryPlace(g, u, c);
      }
      if (!fit) {
        leftovers.push(u);
        continue;
      }

      const [dx, dy, dz] = fit;
      if (c.shelfD === 0) c.shelfD = dy;
      if (c.levelH === 0) c.levelH = dz;
      let z = c.z;
      for (const m of u.members) {
        placements.push({
          grid: g.name,
          item: m.id,
          group: m.group ?? null,
          scu: m.scu,
          x: c.x,
          y: c.y,
          z,
          dx,
          dy,
          dz: m.dims[2],
        });
        z += m.dims[2];
      }
      usedByGrid.set(g.name, (usedByGrid.get(g.name) ?? 0) + u.members.reduce((s, m) => s + m.scu, 0));
      c.x += dx;
    }
    remaining = leftovers;
  }

  const unplaced = remaining.flatMap((u) => u.members);
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
