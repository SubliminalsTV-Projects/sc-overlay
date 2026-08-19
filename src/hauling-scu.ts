/**
 * HAULING — WHAT A CONTRACT ACTUALLY WEIGHS, AND HOW SURE WE ARE.
 *
 * 🔴 The dataset BOUNDS a contract's load. It does not tell you it. 2,707 of the 4,769 shipped
 * orders (57%) have `minScu < maxScu`, so every figure the widget draws has to carry where it came
 * from and a range must never collapse into a fake exact number. `ScuSource` and the precedence in
 * `resolveScu` ARE that policy; nothing else in the app is allowed to invent a tonnage.
 *
 * Lifted verbatim out of hauling-plan.ts (2026-08-19), which was doing this job alongside three
 * others. `ScuSource` is still re-exported from there, so no call site moved.
 */
import type { HaulingDataStore } from "./hauling-data.js";

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
  /** ARITHMETIC. The contract total is known and every other pickup has been pinned, so this one
   *  is the remainder — exact, and never asked about. On a two-pickup contract this is why the
   *  player types one number instead of two. */
  | "derived"
  /** Neither source says anything. `scu` is null and this contract cannot be planned. */
  | "unknown";

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
export function commodityFor(data: HaulingDataStore, contractKey: string, index: number, legCount: number): string | null {
  const orders = data.contract(contractKey)?.orders ?? [];
  if (!orders.length) return null;
  if (orders.length === legCount) return orders[index]?.commodity ?? null;
  const names = [...new Set(orders.map((o) => o.commodity).filter((c): c is string => !!c))];
  return names.length === 1 ? names[0] : null;
}

export function boundsFor(data: HaulingDataStore, contractKey: string, index: number, legCount: number): Bounds {
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
export function resolveScu(logNeed: number | null, pinned: number | null, b: Bounds): {
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
/* `derived` sits just below `pinned`: it is exact arithmetic, but it is only as good as the figure
   the player pinned to produce it, so it must not out-rank that figure. */
const WEAKNESS: Record<ScuSource, number> = { manifest: 0, log: 1, pinned: 2, derived: 3, dataset: 4, range: 5, unknown: 6 };
export function weakest(sources: ScuSource[]): ScuSource {
  // No seed — seeding with a source that is not in the list floors the result at that source's
  // strength, which is how a contract with an exact manifest came back labelled "log".
  return sources.length ? sources.reduce((a, b) => (WEAKNESS[b] > WEAKNESS[a] ? b : a)) : "unknown";
}
