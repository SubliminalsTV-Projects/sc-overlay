// The route optimiser: what order to run the accepted contracts.
//
//   npx tsx src/hauling-route.test.ts

import {
  buildStops,
  planRoute,
  planRun,
  stopsFor,
  type HaulLeg,
  type RouteContract,
  type RoutePlan,
  type RouteStop,
} from "./hauling-route.js";
import {
  BAIJINI,
  KNOWN_SHIP_SCU,
  RIKER,
  SAL2,
  SAL5,
  SIX_CONTRACTS,
  haulLegs,
  posOf,
  routeContracts,
  totalFixtureScu,
} from "./hauling-fixtures.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

const stops = buildStops(haulLegs(), posOf);
const contracts = routeContracts();
const locOf = (visitId: string) => visitId.slice(0, visitId.lastIndexOf(":"));

/** No drop-off before its pickup, and the hold never goes negative or over capacity. */
function violations(plan: RoutePlan, all: readonly RouteStop[], capacity = Number.POSITIVE_INFINITY): string[] {
  const bad: string[] = [];
  const picked = new Set<string>();
  let load = 0;
  for (const id of plan.order) {
    const stop = all.find((s) => s.id === id)!;
    for (const a of stop.actions) {
      if (a.kind === "dropoff" && !picked.has(a.contractId)) bad.push(`${a.contractId} dropped at ${id} before pickup`);
      if (a.kind === "dropoff") load -= a.scu;
    }
    for (const a of stop.actions) {
      if (a.kind === "pickup") {
        picked.add(a.contractId);
        load += a.scu;
      }
    }
    if (load < 0) bad.push(`negative hold (${load}) after ${id}`);
    if (load > capacity) bad.push(`hold ${load} over capacity ${capacity} after ${id}`);
  }
  if (load !== 0) bad.push(`ended holding ${load} SCU`);
  return bad;
}

// ── 🔑 the bug the real board found ────────────────────────────────────────
// Four contracts run Baijini -> Riker and two run Riker -> Baijini. Dedupe stops by LOCATION and
// the precedence graph is a cycle, so no route exists — which is absurd, you just land twice.
check("six contracts, four locations, six visits", stops.length === 6, `${stops.length}`);
const both = planRoute(stops, contracts);
check("the both-ways board is routable at all", both !== null);

const plan = both!;
check("precedence and the hold both hold up", violations(plan, stops).length === 0,
  violations(plan, stops).join(" | "));
check("one location is genuinely visited twice",
  plan.order.filter((id) => locOf(id) === BAIJINI).length === 2 || plan.order.filter((id) => locOf(id) === RIKER).length === 2,
  plan.order.join(" -> "));
check("solved exactly, not by fallback", plan.method === "exact");

// ── adjacent visits to one place are one landing ───────────────────────────
check("six visits collapse to five landings", plan.stops === 5, `${plan.stops} landings from ${plan.order.length} visits`);
const freeLegs = plan.legs.filter((l) => l.minutes === 0);
check("the collapsed pair costs no time", freeLegs.length === 1 && freeLegs[0].distanceM === 0);

// ── the optimiser picked a sane shape ──────────────────────────────────────
// The two Lyria facilities are 12 million metres out and half a million apart, so they must end up
// next to each other — visiting one, coming back, and going out again is the mistake to catch.
const lyria = plan.order.map((id, i) => ({ i, loc: locOf(id) })).filter((s) => s.loc === SAL5 || s.loc === SAL2);
check("the two Lyria drop-offs are consecutive", Math.abs(lyria[0].i - lyria[1].i) === 1,
  plan.order.map(locOf).join(" -> "));
check("everything is delivered", plan.contractIds.length === 6 && plan.payout === 334_500, `${plan.payout}`);
check("aUEC/hour is payout over elapsed", Math.abs(plan.auecPerHour - plan.payout / (plan.totalMinutes / 60)) < 1e-6);

// ── you never hold anything like the total ─────────────────────────────────
// 320 SCU move, but the route the optimiser picks — start at Riker with the two return hauls,
// empty out at Baijini, reload there, run back — never holds more than 170 at once. Which is why
// this board fits an A2 (216 SCU), a ship less than a third the size of the total freight.
const inA2 = planRoute(stops, contracts, { capacityScu: KNOWN_SHIP_SCU.A2 });
check("the whole board fits an A2", inA2 !== null && inA2.peakScu === 170, `peak ${inA2?.peakScu}`);
check("...and the hold never breaks the A2 limit",
  inA2 !== null && violations(inA2, stops, KNOWN_SHIP_SCU.A2).length === 0);
check("320 SCU move in total but only 170 are ever aboard at once",
  totalFixtureScu() === 320 && inA2!.peakScu === 170);

// ── splitting a run that will not fit ──────────────────────────────────────
const tight = planRun(stops, contracts, { capacityScu: 100 });
check("a 100 SCU hold splits the board into trips", tight.trips.length > 1, `${tight.trips.length} trips`);
check("...carrying everything between them",
  new Set(tight.trips.flatMap((t) => t.contractIds)).size === 6 && tight.stranded.length === 0);
check("...each trip legal on its own", tight.trips.every((t) => t.peakScu <= 100));
check("...and the run total is the sum of its trips",
  Math.abs(tight.payout - 334_500) < 1e-6 && tight.trips.every((t) => t.totalMinutes > 0));

// A hold too small for a single contract cannot ever carry it, and the plan says so plainly
// rather than looping or quietly dropping it.
const tiny = planRun(stops, contracts, { capacityScu: 50 });
check("contracts bigger than the whole hold are reported stranded",
  tiny.stranded.sort().join() === "c4,c5,c6", tiny.stranded.join());
check("...while the ones that do fit still get planned",
  new Set(tiny.trips.flatMap((t) => t.contractIds)).size === 3);

// ── the fewest-stops toggle ────────────────────────────────────────────────
// Both objectives order a trip by time; they only disagree about which contracts share one, so the
// toggle can only matter when the hold forces a split.
check("a run that fits in one trip ignores the toggle entirely",
  JSON.stringify(planRun(stops, contracts, { objective: "fewest-stops" }).trips[0].order)
  === JSON.stringify(planRun(stops, contracts, { objective: "auec-per-hour" }).trips[0].order));

const byValue = planRun(stops, contracts, { capacityScu: 120, objective: "auec-per-hour" });
const byStops = planRun(stops, contracts, { capacityScu: 120, objective: "fewest-stops" });
check("both objectives still deliver all six",
  new Set(byValue.trips.flatMap((t) => t.contractIds)).size === 6
  && new Set(byStops.trips.flatMap((t) => t.contractIds)).size === 6);
// 🔑 Worth knowing about Sub's own board: five of the six contracts run between the same two
// places, so there is no stop for the toggle to save and both objectives land the same plan.
check("on this board the two objectives coincide",
  byStops.trips[0].stops === byValue.trips[0].stops && byStops.trips[0].payout === byValue.trips[0].payout,
  `stops-first ${byStops.trips[0].stops}/${byStops.trips[0].payout}, value-first ${byValue.trips[0].stops}/${byValue.trips[0].payout}`);

// So the toggle gets its own board, where the choice is real: three 100 SCU contracts out of one
// depot into a 200 SCU hold. Two go to the same place, and the odd one out pays better.
const forkLegs: HaulLeg[] = [
  { contractId: "k1", scu: 100, fromLocation: "A", toLocation: "B" },
  { contractId: "k2", scu: 100, fromLocation: "A", toLocation: "C" },
  { contractId: "k3", scu: 100, fromLocation: "A", toLocation: "B" },
];
const forkContracts: RouteContract[] = [
  { id: "k1", payout: 300_000 },
  { id: "k2", payout: 200_000 },
  { id: "k3", payout: 100_000 },
];
const forkPos = (id: string) => ({ A: { x: 0, y: 0, z: 0 }, B: { x: 1e6, y: 0, z: 0 }, C: { x: 0, y: 9e6, z: 0 } })[id] ?? null;
const forkStops = buildStops(forkLegs, forkPos);
const forkValue = planRun(forkStops, forkContracts, { capacityScu: 200, objective: "auec-per-hour" });
const forkStopsPlan = planRun(forkStops, forkContracts, { capacityScu: 200, objective: "fewest-stops" });
check("value-first fills the first trip with the best payers",
  forkValue.trips[0].contractIds.sort().join() === "k1,k2", forkValue.trips[0].contractIds.join());
check("fewest-stops fills it with the shared destination instead",
  forkStopsPlan.trips[0].contractIds.sort().join() === "k1,k3", forkStopsPlan.trips[0].contractIds.join());
check("...which is the whole point: fewer landings on trip one",
  forkStopsPlan.trips[0].stops < forkValue.trips[0].stops,
  `${forkStopsPlan.trips[0].stops} vs ${forkValue.trips[0].stops}`);
check("...at a lower first-trip payout", forkStopsPlan.trips[0].payout < forkValue.trips[0].payout);

// ── positions we do not have yet ───────────────────────────────────────────
// Marker XYZ may be missing or in an unverified frame. An unknown leg costs a flat estimate and the
// route is still produced — degraded, never refused.
const blind = planRoute(buildStops(haulLegs()), contracts, { unknownLegMinutes: 6 });
check("a board with no positions at all still routes", blind !== null && blind.order.length === 6);
check("...and charges the flat estimate for the unknown legs",
  blind !== null && blind.totalDistanceM === 0 && blind.legs.every((l) => l.distanceM === null || l.distanceM === 0));

// ── subsetting ─────────────────────────────────────────────────────────────
const justC1 = stopsFor(stops, new Set(["c1"]));
check("filtering to one contract drops the visits it does not use", justC1.length === 3,
  justC1.map((s) => s.id).join(" "));
check("...and keeps only its actions", justC1.every((s) => s.actions.every((a) => a.contractId === "c1")));

// ── the heuristic path ─────────────────────────────────────────────────────
// Past 14 visits exact enumeration is dropped. The answer stops being provably optimal but must
// still be a legal route.
const many: HaulLeg[] = Array.from({ length: 8 }, (_, i) => ({
  contractId: `x${i}`,
  scu: 10,
  fromLocation: `depot${i}`,
  toLocation: `drop${i}`,
}));
const manyContracts: RouteContract[] = many.map((l) => ({ id: l.contractId, payout: 10_000 }));
const manyStops = buildStops(many, (id) => ({ x: id.length * 1_000_000, y: id.charCodeAt(id.length - 1) * 500_000, z: 0 }));
const wide = planRoute(manyStops, manyContracts);
check("a board past the exact limit falls back to the heuristic",
  manyStops.length > 14 && wide !== null && wide.method === "heuristic", `${manyStops.length} visits`);
check("...and the heuristic route is still legal", wide !== null && violations(wide, manyStops).length === 0,
  wide ? violations(wide, manyStops).join(" | ") : "no plan");

// ── degenerate inputs ──────────────────────────────────────────────────────
check("an empty board has no route", planRoute([], contracts) === null);
check("an empty board is an empty run", planRun([], contracts).trips.length === 0);

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
