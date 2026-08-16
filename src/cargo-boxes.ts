/**
 * CARGO BOX SET + the SCU -> boxes partition model.
 *
 * A hauling contract tells you a TOTAL ("Deliver 0/81 SCU of Stims") and a cap ("At most the
 * containers will be 8 SCU in size"), never the actual box breakdown — the engine partitions
 * server-side and logs nothing for Covalex SCU hauls. Everything here turns that pair back into
 * a list of physical boxes so the packer has something to place.
 *
 * 🔴 THE BOX SET IS THE CONTESTED INPUT. Research found 24 SCU (2x2x6) common in mission data and
 * 32 SCU absent; Sub's source insists 32 is real. The `foundations` flight is enumerating the
 * datacore for the real answer. That is why every entry point here takes the set as a PARAMETER
 * and DEFAULT_BOX_SET carries a per-size confidence flag — when the answer lands, one table
 * changes and nothing else does.
 *
 * 🔑 Two geometry facts that shape all of this:
 *   - every real cargo grid caps box height at 2 cells (`maxPermittedItemSize.z` = 2.5 m), so a
 *     16/24/32 SCU box ALWAYS lies flat and `dims` below records it lying flat;
 *   - 1 cell = 1.25 m = 1 SCU, so a grid's cell count IS its SCU rating.
 */

/** How sure we are the size exists in the live game. See the 🔴 note above. */
export type BoxConfidence = "confirmed" | "contested";

export interface BoxSpec {
  scu: number;
  /** [x, y, z] in CELLS, as the box rests on a grid floor. z is height. */
  dims: readonly [number, number, number];
  confidence: BoxConfidence;
}

/**
 * The working box table. Sizes below 16 SCU are the ones that appear across every source that
 * has ever been checked; 24 and 32 are the pair under dispute and are flagged accordingly.
 *
 * Callers that want only the settled sizes can filter on `confidence`; callers that want to try
 * the other answer can pass their own array. Nothing downstream hardcodes a size.
 */
export const DEFAULT_BOX_SET: readonly BoxSpec[] = [
  { scu: 1, dims: [1, 1, 1], confidence: "confirmed" },
  { scu: 2, dims: [2, 1, 1], confidence: "confirmed" },
  { scu: 4, dims: [2, 2, 1], confidence: "confirmed" },
  { scu: 8, dims: [2, 2, 2], confidence: "confirmed" },
  { scu: 16, dims: [4, 2, 2], confidence: "confirmed" },
  { scu: 24, dims: [6, 2, 2], confidence: "contested" },
  { scu: 32, dims: [8, 2, 2], confidence: "contested" },
];

export interface BoxCount {
  scu: number;
  count: number;
  spec: BoxSpec;
}

export interface Partition {
  boxes: BoxCount[];
  /** SCU the box set could not express. Non-zero only if the set has no 1 SCU box. */
  remainderScu: number;
}

/** The subset of `set` a contract with this container cap is allowed to use, largest first. */
export function boxesUpTo(maxContainerScu: number, set: readonly BoxSpec[] = DEFAULT_BOX_SET): BoxSpec[] {
  return set.filter((b) => b.scu <= maxContainerScu).sort((a, b) => b.scu - a.scu);
}

/**
 * Split a contract total into boxes, GREEDY LARGEST-FIRST.
 *
 * ⚠️ This is Sub's hypothesis about what the engine does, not a confirmed rule: "it fills with the
 * largest box allowed for that contract type, then remainders". His worked example — 81 SCU with an
 * 8 SCU cap = ten 8s plus one 1 — is what this reproduces. Ground truth has to come from a log that
 * enumerates boxes (mission-item hauls do; Covalex SCU hauls do not), which is the `parser`
 * flight's territory. Until then the widget must treat a partition as provisional and editable.
 */
export function partitionScu(
  totalScu: number,
  maxContainerScu: number,
  set: readonly BoxSpec[] = DEFAULT_BOX_SET,
): Partition {
  const boxes: BoxCount[] = [];
  let left = Math.max(0, Math.floor(totalScu));
  for (const spec of boxesUpTo(maxContainerScu, set)) {
    const count = Math.floor(left / spec.scu);
    if (count > 0) {
      boxes.push({ scu: spec.scu, count, spec });
      left -= count * spec.scu;
    }
  }
  return { boxes, remainderScu: left };
}

/** One entry per physical box, largest first — the packer's input order. */
export function expandPartition(partition: Partition): BoxSpec[] {
  const out: BoxSpec[] = [];
  for (const b of partition.boxes) for (let i = 0; i < b.count; i++) out.push(b.spec);
  return out;
}

/** Total SCU a partition actually accounts for (excludes `remainderScu`). */
export function partitionScuTotal(partition: Partition): number {
  return partition.boxes.reduce((sum, b) => sum + b.scu * b.count, 0);
}

/** Total box COUNT — the number the widget shows as chips, e.g. "8x10 · 1x1" -> 11. */
export function partitionBoxCount(partition: Partition): number {
  return partition.boxes.reduce((sum, b) => sum + b.count, 0);
}

/** Compact human form of a partition: `10x8 · 1x1`. Empty string for an empty partition. */
export function formatPartition(partition: Partition): string {
  return partition.boxes.map((b) => `${b.count}x${b.scu}`).join(" · ");
}
