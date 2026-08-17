// The layered bin-packer: do these boxes physically fit this ship's grids, and where.
//
//   npx tsx src/cargo-pack.test.ts

import { expandPartition, partitionScu, type BoxSpec } from "./cargo-boxes.js";
import {
  gridCapacityScu,
  itemsFromBoxes,
  packCargo,
  shipCapacityScu,
  type GridSpec,
  type PackItem,
  type PackResult,
  type Placement,
} from "./cargo-pack.js";
import { A2_GRIDS, C2_GRIDS, KNOWN_SHIP_SCU, SIX_CONTRACTS } from "./hauling-fixtures.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

/** Every placement in bounds, no two boxes sharing a cell. The invariant everything else rests on. */
function conflicts(grids: readonly GridSpec[], result: PackResult): string[] {
  const bad: string[] = [];
  const cells = new Map<string, string>();
  for (const p of result.placements) {
    const g = grids.find((x) => x.name === p.grid);
    if (!g) {
      bad.push(`${p.item}: unknown grid ${p.grid}`);
      continue;
    }
    if (p.x < 0 || p.y < 0 || p.z < 0 || p.x + p.dx > g.w || p.y + p.dy > g.l || p.z + p.dz > g.h) {
      bad.push(`${p.item}: out of bounds at ${p.x},${p.y},${p.z} +${p.dx}x${p.dy}x${p.dz} in ${g.name}`);
      continue;
    }
    if (p.dx * p.dy * p.dz !== p.scu) bad.push(`${p.item}: ${p.dx}x${p.dy}x${p.dz} is not ${p.scu} SCU`);
    for (let x = p.x; x < p.x + p.dx; x++)
      for (let y = p.y; y < p.y + p.dy; y++)
        for (let z = p.z; z < p.z + p.dz; z++) {
          const key = `${p.grid}|${x},${y},${z}`;
          const owner = cells.get(key);
          if (owner) bad.push(`${p.item} overlaps ${owner} at ${key}`);
          else cells.set(key, p.item);
        }
  }
  return bad;
}

const itemsFor = (id: string, scu: number, cap: number, group = id): PackItem[] =>
  itemsFromBoxes(expandPartition(partitionScu(scu, cap)), group, id);

// ── capacity arithmetic ────────────────────────────────────────────────────
check("a grid's SCU rating is its cell count", gridCapacityScu(C2_GRIDS[0]) === 480 && gridCapacityScu(C2_GRIDS[1]) === 216);
check("C2 = 8x15x4 + 6x9x4 = 696", shipCapacityScu(C2_GRIDS) === KNOWN_SHIP_SCU.C2);

// ── the whole real board on a C2 ───────────────────────────────────────────
// Every leg of Sub's six contracts at once: 320 SCU, 8 drop-off groups, container caps of 1, 4 and 8.
const board: PackItem[] = SIX_CONTRACTS.flatMap((c) =>
  c.legs.flatMap((l) => itemsFor(`${c.id}-${l.commodity}`, l.scu, c.maxContainerScu, l.to)),
);
const packed = packCargo(C2_GRIDS, board);
check("the full 320 SCU board fits a C2", packed.fits, `${packed.unplaced.length} unplaced`);
check("every SCU of it is accounted for", packed.loadedScu === 320, `${packed.loadedScu}`);
check("no overlaps and nothing out of bounds", conflicts(C2_GRIDS, packed).length === 0,
  conflicts(C2_GRIDS, packed).slice(0, 3).join(" | "));
check("nothing stands taller than the 2-cell cap", packed.placements.every((p) => p.dz <= 2));
check("per-grid usage sums to the load",
  packed.byGrid.reduce((s, g) => s + g.usedScu, 0) === packed.loadedScu);

// ── a box occupies what it is, and nothing more ────────────────────────────
// ⚠️ These three used to assert that 1-high boxes were PAIRED into 2-high units, four footprints
// for eight boxes. That was a workaround for level-band packing, where a level took the height of
// its tallest box and a lone 1-high box wasted the 2-high slot it sat in. With real per-cell
// occupancy there are no levels and nothing to waste, so the mechanism is gone — and asserting it
// would pin an implementation detail rather than the property anyone cares about.
const alu = packCargo(C2_GRIDS, itemsFor("c3", 8, 1));
check("eight 1 SCU boxes cost exactly eight cells",
  alu.fits && alu.placements.reduce((s, p) => s + p.dx * p.dy * p.dz, 0) === 8,
  String(alu.placements.reduce((s, p) => s + p.dx * p.dy * p.dz, 0)));

// ⚠️ itemsFor(id, SCU, CAP) — a total and a per-box cap, not a count and a size. So this is 24 SCU
// as six 4 SCU boxes, and 24 cells is the whole of it.
const flat4 = packCargo(C2_GRIDS, itemsFor("ice", 24, 4));
check("4 SCU boxes waste nothing either",
  flat4.fits && flat4.placements.reduce((s, p) => s + p.dx * p.dy * p.dz, 0) === 24,
  String(flat4.placements.reduce((s, p) => s + p.dx * p.dy * p.dz, 0)));

// ── 🔴 GRAVITY. Nothing floats. ────────────────────────────────────────────
// Sub, looking at the isometric view: "I can't put a box in a floating position. There has to be a
// box under it... this is a space sim, not an arcade game." The old engine placed a level on top of
// a PARTLY filled one, so a box could hang over the gap below it — correct in the diagram, and
// impossible to build in the ship.
function floatingIn(result: ReturnType<typeof packCargo>): number {
  const byGrid = new Map<string, Set<string>>();
  for (const p of result.placements) {
    let s = byGrid.get(p.grid);
    if (!s) { s = new Set(); byGrid.set(p.grid, s); }
    for (let X = p.x; X < p.x + p.dx; X++) for (let Y = p.y; Y < p.y + p.dy; Y++) for (let Z = p.z; Z < p.z + p.dz; Z++) s.add(`${X},${Y},${Z}`);
  }
  let floating = 0;
  for (const p of result.placements) {
    if (p.z === 0) continue;
    const occ = byGrid.get(p.grid)!;
    for (let X = p.x; X < p.x + p.dx; X++) for (let Y = p.y; Y < p.y + p.dy; Y++) {
      if (!occ.has(`${X},${Y},${p.z - 1}`)) { floating++; return floating; }
    }
  }
  return floating;
}
// A deliberately awkward mix: big flats, tall pairs and singles together, which is what produced
// the overhangs before.
const gravityMix = packCargo(C2_GRIDS, [
  ...itemsFor("a", 20, 8, "FIRST"),
  ...itemsFor("b", 30, 1, "SECOND"),
  ...itemsFor("c", 12, 4, "THIRD"),
  ...itemsFor("d", 6, 16, "FOURTH"),
]);
check("🔴 no box is left hanging in the air", floatingIn(gravityMix) === 0,
  `${floatingIn(gravityMix)} unsupported`);
check("...nor in the uniform packs", floatingIn(alu) === 0 && floatingIn(flat4) === 0);

// ── a one-level ship ───────────────────────────────────────────────────────
// The A2 holds the same 216 SCU as the C2's small grid in a completely different shape: 6x18x2.
// Only 2 cells high, so there is a single level and no stacking above it — the case where the
// level logic has nowhere to go when a shelf fills up.
check("A2 = one 6x18x2 grid = 216 SCU", shipCapacityScu(A2_GRIDS) === KNOWN_SHIP_SCU.A2);
// 170 SCU is the most the six contracts ever have aboard at once (see hauling-route.test.ts), so
// this is the pack that decides whether Sub could actually fly that board in an A2.
const a2Peak = packCargo(A2_GRIDS, [
  ...itemsFor("waste", 44, 8, "BAIJINI"),
  ...itemsFor("scrap", 45, 8, "BAIJINI"),
  ...itemsFor("stims", 81, 8, "BAIJINI"),
]);
check("the six contracts' 170 SCU peak load fits an A2", a2Peak.fits, `${a2Peak.unplaced.length} unplaced`);
check("...legally", conflicts(A2_GRIDS, a2Peak).length === 0, conflicts(A2_GRIDS, a2Peak).slice(0, 3).join(" | "));
check("...within the single level", a2Peak.placements.every((p) => p.z + p.dz <= 2));

// ── per-grid dimensions are real constraints, not a pool of SCU ────────────
// The C2's small grid is 6 wide and 9 long. A 32 SCU box is 8x2x2, so it can only go in along Y.
const SMALL_ONLY: GridSpec[] = [C2_GRIDS[1]];
const big: BoxSpec = { scu: 32, dims: [8, 2, 2], confidence: "contested" };
const inSmall = packCargo(SMALL_ONLY, itemsFromBoxes([big], "x"));
check("a 32 SCU box fits the C2's small grid along Y only",
  inSmall.fits && inSmall.placements[0].dx === 2 && inSmall.placements[0].dy === 8,
  `${inSmall.placements[0]?.dx}x${inSmall.placements[0]?.dy}`);

// Nothing 10 cells long fits a 6x9 grid in any orientation, whatever the SCU total says.
const tooLong = packCargo(SMALL_ONLY, itemsFromBoxes([{ scu: 40, dims: [10, 2, 2], confidence: "contested" }], "y"));
check("a box longer than both grid axes is refused, not squeezed in", !tooLong.fits && tooLong.placements.length === 0);

// A grid whose maxBox is stricter than its dimensions is honoured.
const CAPPED: GridSpec[] = [{ name: "capped", w: 8, l: 15, h: 4, maxBox: { x: 4, y: 4, z: 2 } }];
check("maxPermittedItemSize wins over raw grid size",
  !packCargo(CAPPED, itemsFromBoxes([big], "z")).fits);

// ── drop-off grouping ──────────────────────────────────────────────────────
// Boxes for the first stop should sit nearest the entrance so they come off first.
const twoStops = [...itemsFor("far", 64, 8, "LAST"), ...itemsFor("near", 64, 8, "FIRST")];
const ordered = packCargo(C2_GRIDS, twoStops, { groupOrder: ["FIRST", "LAST"] });
const firstY = ordered.placements.filter((p) => p.group === "FIRST").map((p) => p.y);
const lastY = ordered.placements.filter((p) => p.group === "LAST").map((p) => p.y);
check("the first drop-off is packed nearest the grid entrance",
  Math.max(...firstY) <= Math.min(...lastY), `FIRST y<=${Math.max(...firstY)}, LAST y>=${Math.min(...lastY)}`);
const bands = ordered.placements.map((p) => p.group).filter((g, i, a) => g !== a[i - 1]);
check("each drop-off is one contiguous band, not scattered", bands.length === 2, bands.join(" -> "));
check("grouping did not cost us the fit", ordered.fits);

// ── overflow is reported, never silently dropped ───────────────────────────
const tooMuch = packCargo(C2_GRIDS, itemsFor("overflow", 720, 8));
check("720 SCU does not fit a 696 SCU C2", !tooMuch.fits);
check("...and the boxes that did not fit are handed back",
  tooMuch.unplaced.length > 0 && tooMuch.loadedScu <= shipCapacityScu(C2_GRIDS));
check("...with no overlaps among the ones that did", conflicts(C2_GRIDS, tooMuch).length === 0);

// ── how much of the hold the packer can actually reach ─────────────────────
// Not a correctness bound, a regression guard: a shelf packer leaves some waste and this records
// how much, so a future change that quietly makes layouts worse shows up here.
const density = (items: PackItem[]): number => {
  const r = packCargo(C2_GRIDS, items);
  return r.loadedScu / shipCapacityScu(C2_GRIDS);
};
const uniform8 = density(itemsFor("u8", 696, 8));
check("uniform 8 SCU boxes reach at least 90% of a C2", uniform8 >= 0.9, `${(uniform8 * 100).toFixed(1)}%`);
const uniform1 = density(itemsFor("u1", 696, 1));
check("uniform 1 SCU boxes reach at least 90% of a C2", uniform1 >= 0.9, `${(uniform1 * 100).toFixed(1)}%`);

// ── degenerate inputs ──────────────────────────────────────────────────────
check("no boxes is a trivially successful pack", packCargo(C2_GRIDS, []).fits);
check("no grids means nothing fits", !packCargo([], itemsFor("x", 8, 8)).fits);

const empty: Placement[] = packCargo(C2_GRIDS, []).placements;
check("...and produces no placements", empty.length === 0);

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
