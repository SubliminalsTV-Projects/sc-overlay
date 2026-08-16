/**
 * HAULING SOLVER FIXTURES — ground truth the solver tests are graded against.
 *
 * The six contracts are Sub's REAL accepted board on 2026-08-16 10:32, read off his own contract
 * screenshots. They are worth keeping verbatim because they happen to cover every awkward case at
 * once: a two-drop-off contract, a contract capped at 1 SCU, one capped at 4, three capped at 8,
 * two commodities to the same destination, and — the one that broke the first route model — traffic
 * running in BOTH directions between the same pair of locations.
 *
 * 🔑 The per-contract container cap is NOT in the objective line. It is in the DETAILS prose
 * ("At most the containers will be 4 SCU in size"), which is where the `parser` flight will have to
 * read it from if it ever wants it out of the mobiGlas rather than the datacore.
 *
 * ⚠️ POSITIONS ARE SYNTHETIC. Real marker XYZ exists in the log but its coordinate frame is still
 * unverified (phase 1). The numbers below only encode the relative truth the optimiser is being
 * tested on — Baijini is a short hop above Area18, and the two Lyria facilities are far away and
 * close to each other. Swap them for real marker XYZ when phase 1 lands; nothing else changes.
 */
import type { GridSpec } from "./cargo-pack.js";
import type { HaulLeg, RouteContract, Vec3 } from "./hauling-route.js";

// ── ships ──────────────────────────────────────────────────────────────────
// Cell dimensions from the datacore (`inventorycontainers/ships/*.xml`, interiorDimensions ÷ 1.25).
// The height cap is `maxPermittedItemSize.z` = 2.5 m = 2 cells and is the reason nothing ever
// stands more than two cells tall.

export const C2_GRIDS: GridSpec[] = [
  { name: "main", w: 8, l: 15, h: 4, maxBox: { x: 8, y: 15, z: 2 } },
  { name: "small", w: 6, l: 9, h: 4, maxBox: { x: 6, y: 9, z: 2 } },
];

/**
 * 🔑 The A2 is ONE grid, 6x18x2 — same 216 SCU as the C2's small grid, completely different shape,
 * and only 2 cells high so there is exactly ONE level to fill. Proof that a ship is a set of grids
 * with dimensions, not a pool of SCU.
 */
export const A2_GRIDS: GridSpec[] = [{ name: "main", w: 6, l: 18, h: 2, maxBox: { x: 6, y: 18, z: 2 } }];

/** Published totals the datacore agrees with. UEX says A2 = 234; the datacore's 216 wins. */
export const KNOWN_SHIP_SCU = { C2: 696, M2: 522, A2: 216 } as const;

// ── locations ──────────────────────────────────────────────────────────────

export const BAIJINI = "Baijini Point";
export const RIKER = "Riker Memorial Spaceport";
export const SAL5 = "Shubin Mining Facility SAL-5";
export const SAL2 = "Shubin Mining Facility SAL-2";

/** See the ⚠️ above — relative geometry only, in metres. */
const POSITIONS: Record<string, Vec3> = {
  [RIKER]: { x: 0, y: 0, z: 0 },
  [BAIJINI]: { x: 0, y: 0, z: 1_000_000 },
  [SAL5]: { x: 12_000_000, y: 0, z: 0 },
  [SAL2]: { x: 12_000_000, y: 500_000, z: 0 },
};

export const posOf = (locationId: string): Vec3 | null => POSITIONS[locationId] ?? null;

// ── the six contracts ──────────────────────────────────────────────────────

export interface HaulFixture {
  id: string;
  title: string;
  payout: number;
  /** "At most the containers will be N SCU in size", from the contract DETAILS prose. */
  maxContainerScu: number;
  legs: Array<{ commodity: string; scu: number; from: string; to: string }>;
}

export const SIX_CONTRACTS: HaulFixture[] = [
  {
    id: "c1",
    title: "Rookie Rank - Small Cargo Haul",
    payout: 55_000,
    maxContainerScu: 4,
    legs: [
      { commodity: "Processed Food", scu: 9, from: BAIJINI, to: SAL5 },
      { commodity: "Processed Food", scu: 15, from: BAIJINI, to: SAL2 },
    ],
  },
  {
    id: "c2",
    title: "Rookie Rank - Direct Small Cargo Haul",
    payout: 43_750,
    maxContainerScu: 4,
    legs: [{ commodity: "Pressurized Ice", scu: 25, from: BAIJINI, to: RIKER }],
  },
  {
    id: "c3",
    title: "Rookie Rank - Direct Extra Small Cargo Haul",
    payout: 50_250,
    maxContainerScu: 1,
    legs: [{ commodity: "Aluminum", scu: 8, from: BAIJINI, to: RIKER }],
  },
  {
    id: "c4",
    title: "Junior Rank - Direct Medium Cargo Haul",
    payout: 56_000,
    maxContainerScu: 8,
    legs: [{ commodity: "Silicon", scu: 93, from: BAIJINI, to: RIKER }],
  },
  {
    id: "c5",
    title: "Rookie Rank - Direct Medium Cargo Haul",
    payout: 53_000,
    maxContainerScu: 8,
    legs: [
      { commodity: "Waste", scu: 44, from: RIKER, to: BAIJINI },
      { commodity: "Scrap", scu: 45, from: RIKER, to: BAIJINI },
    ],
  },
  {
    id: "c6",
    title: "Rookie Rank - Direct Medium Cargo Haul",
    payout: 76_500,
    maxContainerScu: 8,
    legs: [{ commodity: "Stims", scu: 81, from: RIKER, to: BAIJINI }],
  },
];

export const routeContracts = (fixtures: readonly HaulFixture[] = SIX_CONTRACTS): RouteContract[] =>
  fixtures.map((f) => ({ id: f.id, payout: f.payout, title: f.title }));

export const haulLegs = (fixtures: readonly HaulFixture[] = SIX_CONTRACTS): HaulLeg[] =>
  fixtures.flatMap((f) =>
    f.legs.map((l) => ({
      contractId: f.id,
      scu: l.scu,
      fromLocation: l.from,
      toLocation: l.to,
      commodity: l.commodity,
    })),
  );

/** Every SCU the six contracts move: 320. */
export const totalFixtureScu = (fixtures: readonly HaulFixture[] = SIX_CONTRACTS): number =>
  fixtures.reduce((sum, f) => sum + f.legs.reduce((s, l) => s + l.scu, 0), 0);
