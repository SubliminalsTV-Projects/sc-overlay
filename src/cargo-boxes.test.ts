// The box set and the SCU -> boxes partition model.
//
//   npx tsx src/cargo-boxes.test.ts

import {
  DEFAULT_BOX_SET,
  boxesUpTo,
  expandPartition,
  formatPartition,
  partitionBoxCount,
  partitionScu,
  partitionScuTotal,
  type BoxSpec,
} from "./cargo-boxes.js";
import { SIX_CONTRACTS } from "./hauling-fixtures.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

// ── Sub's worked example ───────────────────────────────────────────────────
// "81 SCU with an 8 SCU max = ten 8 SCU boxes + one 1 SCU box." If this line ever fails, the
// greedy-largest-first hypothesis has been replaced and the widget's manifests moved with it.
const stims = partitionScu(81, 8);
check("81 SCU @ 8 = ten 8s and a 1", formatPartition(stims) === "10x8 · 1x1", formatPartition(stims));
check("the partition accounts for every SCU", partitionScuTotal(stims) === 81 && stims.remainderScu === 0);
check("eleven physical boxes", partitionBoxCount(stims) === 11 && expandPartition(stims).length === 11);
check("expanded largest first", expandPartition(stims)[0].scu === 8 && expandPartition(stims)[10].scu === 1);

// ── the other five real contracts ──────────────────────────────────────────
const real = SIX_CONTRACTS.flatMap((c) => c.legs.map((l) => ({ c, l })));
const allExact = real.every(({ c, l }) => {
  const p = partitionScu(l.scu, c.maxContainerScu);
  return partitionScuTotal(p) === l.scu && p.remainderScu === 0;
});
check("every real contract leg partitions exactly", allExact);

check("93 SCU @ 8 (Silicon)", formatPartition(partitionScu(93, 8)) === "11x8 · 1x4 · 1x1");
check("25 SCU @ 4 (Pressurized Ice)", formatPartition(partitionScu(25, 4)) === "6x4 · 1x1");
check("9 SCU @ 4 (Processed Food)", formatPartition(partitionScu(9, 4)) === "2x4 · 1x1");
// A 1 SCU cap has exactly one answer, which makes it the cleanest possible check of the cap.
check("8 SCU @ 1 (Aluminium) is eight singles", formatPartition(partitionScu(8, 1)) === "8x1");

// ── the cap is respected ───────────────────────────────────────────────────
check("boxesUpTo(8) stops at 8", boxesUpTo(8).every((b) => b.scu <= 8) && boxesUpTo(8)[0].scu === 8);
check("boxesUpTo returns largest first", boxesUpTo(32).map((b) => b.scu).join() === "32,24,16,8,4,2,1");
check("no partition ever exceeds its cap", [1, 2, 4, 8, 16, 24, 32].every((cap) =>
  Array.from({ length: 200 }, (_, i) => i + 1).every((total) =>
    partitionScu(total, cap).boxes.every((b) => b.scu <= cap))));

// ── 🔴 the contested sizes drop in and out without touching anything else ──
// This is the whole point of parameterising: `foundations` is resolving 24-vs-32 against the
// datacore, and whichever way it lands, only the table changes.
const CONFIRMED_ONLY = DEFAULT_BOX_SET.filter((b) => b.confidence === "confirmed");
check("the default table flags exactly 24 and 32 as contested",
  DEFAULT_BOX_SET.filter((b) => b.confidence === "contested").map((b) => b.scu).join() === "24,32");
check("48 SCU @ 32 with the contested sizes is two boxes",
  formatPartition(partitionScu(48, 32)) === "1x32 · 1x16");
check("48 SCU @ 32 without them is three",
  formatPartition(partitionScu(48, 32, CONFIRMED_ONLY)) === "3x16");

const NO_SINGLES: BoxSpec[] = DEFAULT_BOX_SET.filter((b) => b.scu >= 2);
check("a set with no 1 SCU box reports the shortfall rather than lying",
  partitionScu(81, 8, NO_SINGLES).remainderScu === 1);

// ── is greedy even distinguishable from optimal? ───────────────────────────
// 🔑 A finding worth carrying to the `parser` flight. Over every total 1..200 and every cap, the
// greedy split uses the SAME NUMBER OF BOXES as the true minimum — this box table is canonical, so
// counting boxes in a log can never falsify the hypothesis. Only the actual SIZE LIST can. If this
// check starts failing after `foundations` changes the table, we have gained a cheap experiment.
const minBoxes = (total: number, sizes: number[]): number => {
  const dp = new Array<number>(total + 1).fill(Number.POSITIVE_INFINITY);
  dp[0] = 0;
  for (let t = 1; t <= total; t++) for (const s of sizes) if (s <= t) dp[t] = Math.min(dp[t], dp[t - s] + 1);
  return dp[total];
};
const divergences: string[] = [];
for (const cap of [1, 2, 4, 8, 16, 24, 32]) {
  const sizes = boxesUpTo(cap).map((b) => b.scu);
  for (let total = 1; total <= 200; total++) {
    const greedy = partitionBoxCount(partitionScu(total, cap));
    if (greedy !== minBoxes(total, sizes)) divergences.push(`${total}@${cap}`);
  }
}
check("greedy is box-count-optimal everywhere, so box COUNT cannot falsify the hypothesis",
  divergences.length === 0, divergences.slice(0, 5).join(" ") || "checked 1400 total/cap pairs");

// ── degenerate inputs ──────────────────────────────────────────────────────
check("zero SCU is an empty partition", partitionScu(0, 8).boxes.length === 0);
check("a cap below the smallest box yields nothing and admits it",
  partitionScu(10, 0).boxes.length === 0 && partitionScu(10, 0).remainderScu === 10);

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
