/**
 * HAULING — aUEC AND REPUTATION PER HOUR.
 *
 * Lifted verbatim out of hauling-plan.ts (2026-08-19). The plan's own types come back in as
 * TYPE-only imports, which are erased, so there is no runtime cycle between the two files.
 */
import type { HaulingView } from "./hauling.js";
import type { HaulingPlan, PlannedContract } from "./hauling-plan.js";

/**
 * aUEC and reputation per hour — measured where it can be, projected where it cannot.
 *
 * 🔴 THE TWO NUMBERS COME FROM DIFFERENT PLACES AND MUST NOT BE AVERAGED TOGETHER.
 *   - aUEC EARNED is real: the game logs `Awarded N aUEC` and the tracker has already paired each
 *     award with the completion it belongs to.
 *   - REPUTATION is never logged in any form — searching a live session finds only the name of the
 *     gRPC service. It comes from the dataset, keyed by contract, where 839 of the 853 `HaulCargo`
 *     keys carry it and it is read from the game files rather than fitted.
 *   - aUEC AHEAD is dataset too, and that one is fitted for 38 of the 853 keys, which is why
 *     `payoutModelled` exists. Checked against Sub's own finished contract on 2026-08-17 the
 *     dataset said 62,000 and the log's award was 62,000.
 *
 * Elapsed time is the LOG's clock, not the wall clock, so an app reading a stale file cannot claim
 * a rate for time that has not happened.
 */
export function buildRates(
  view: HaulingView,
  liveContracts: readonly PlannedContract[],
  plannedMinutes: number,
  rewards?: (contractKey: string) => { payout: number | null; payoutModelled: boolean; rep: number } | null,
): HaulingPlan["rates"] {
  let modelled = false;
  const lookup = (key: string) => {
    const r = rewards?.(key) ?? null;
    if (r?.payoutModelled) modelled = true;
    return r;
  };

  // ── measured ───────────────────────────────────────────────────────────────
  let actual: HaulingPlan["rates"]["actual"] = null;
  /* 🔴 ACTIVE time, not wall time. This read `updatedAt - runStartedAt`, so every hour the player
     was asleep, at work, or simply not hauling divided into the same numerator. Sub came back
     after ELEVEN HOURS away and his rates had collapsed — and a wall-clock rate never recovers,
     it only falls. See HaulingTracker.accrueActive: intervals count only while a contract is open
     and only when the log did not go quiet. */
  const elapsedMin = view.activeMs / 60_000;
  // 🔑 A minute of elapsed time is the floor. Two contracts completing in the same second is a
  // real thing (Sub delivers a mixed hold in one lift), and dividing by ~0 would report millions
  // of aUEC an hour — a number that is arithmetically correct and a lie about the run.
  if (view.finished.length && elapsedMin >= 1) {
    const auec = view.finished.reduce((s, f) => s + (f.payout ?? 0), 0);
    const rep = view.finished.reduce((s, f) => s + (lookup(f.contractKey)?.rep ?? 0), 0);
    actual = {
      auec, rep, minutes: elapsedMin, contracts: view.finished.length,
      auecPerHour: auec / (elapsedMin / 60),
      repPerHour: rep / (elapsedMin / 60),
    };
  }

  // ── projected ──────────────────────────────────────────────────────────────
  // Only what is actually going to be flown: a contract the player set aside, or one whose load is
  // unknown, is not in the route and must not be in the rate the route is judged by.
  let projected: HaulingPlan["rates"]["projected"] = null;
  const ahead = liveContracts.filter((c) => c.plannable && !c.hidden);
  if (ahead.length && plannedMinutes > 0) {
    let auec = 0, rep = 0;
    for (const c of ahead) {
      const r = lookup(c.contractKey);
      auec += r?.payout ?? 0;
      rep += r?.rep ?? 0;
    }
    projected = {
      auec, rep, minutes: plannedMinutes,
      auecPerHour: auec / (plannedMinutes / 60),
      repPerHour: rep / (plannedMinutes / 60),
    };
  }

  return { actual, projected, payoutModelled: modelled };
}
