/**
 * PROXIMITY ORDERING, AGAINST THE REAL SHIPPED TABLES.  `npm run test:proximity`
 *
 * Everything here runs on `data/item-shops.json`, `data/locations.json` and
 * `data/locations-xyz.latest.json` as committed — not on fixtures — because the claims being made
 * are about THAT data ("all 461 terminals resolve", "the two Nyx Gateways are told apart"), and a
 * fixture would let those claims stay true while the shipped data quietly stopped supporting them.
 *
 * 🔑 Where a rule needs both sides populated to be tested at all, the counts are printed in the
 * assertion detail so the pairing is visible rather than asserted on faith.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTerminalIndex, orderByProximity, containmentOf, stripSystemSuffix, matchKey, systemKey,
  type LocationRecord, type ProximityDeps,
} from "./verse-proximity.js";
import { deriveGateways, loadPlaces, type Vec3 } from "./travel-model.js";
import type { OriginVerdict } from "./player-origin.js";
import type { ResolvedQuote } from "./item-search.js";
import type { ShopTerminal } from "./item-shops.js";

const DATA = join(process.cwd(), "data");
let pass = 0, fail = 0;
const ok = (c: boolean, name: string, detail = "") => {
  if (c) { pass++; console.log(`ok    ${name}${detail ? "  [" + detail + "]" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`); }
};

const shops = JSON.parse(readFileSync(join(DATA, "item-shops.json"), "utf8")) as
  { terminals: ShopTerminal[] };
const locJson = JSON.parse(readFileSync(join(DATA, "locations.json"), "utf8")) as
  { locations: Record<string, LocationRecord & { type?: string }> };
const locations = locJson.locations;
const places = loadPlaces(DATA);
const gateways = deriveGateways(locations as never, places);

const posOf = (id: string): Vec3 | null =>
  places[id] ? { x: places[id].pos[0], y: places[id].pos[1], z: places[id].pos[2] } : null;
const systemOf = (id: string): string | null => {
  const s = systemKey(locations[id]?.system);
  return s || null;
};
const travel = { gateways, posOf, systemOf };
const index = buildTerminalIndex(shops.terminals, locations);

const idOfPlace = (name: string, sys: string): string => {
  for (const [id, v] of Object.entries(locations)) {
    if ((v.name ?? "").toLowerCase() === name.toLowerCase() && systemKey(v.system) === sys) return id;
  }
  throw new Error("fixture place not found: " + name + " @ " + sys);
};

// ── 1. The join, on the real table ────────────────────────────────────────────────────────────
// 🔑 POSITIVE FIRST. "Nothing failed to resolve" is satisfied for free by an empty index, and the
// bug most likely to produce one is exactly a broken index. Assert it is populated, then that it
// is complete.
ok(index.total === shops.terminals.length, "the index saw every terminal", `${index.total}`);
ok(index.resolved > 400, "...and resolved a real number of them", `${index.resolved}/${index.total}`);
ok(index.resolved === index.total, "...in fact all of them", `${index.resolved}/${index.total}`);
ok(index.collisions === 0, "...with no terminal name appearing twice", `${index.collisions}`);
ok(index.ambiguous === 0, "...and none refused for an ambiguous place name", `${index.ambiguous}`);
ok(matchKey("Area 18") === matchKey("Area18"),
   "the match key closes the UEX/starmap spacing gap", matchKey("Area 18"));

// Every resolved place must actually HAVE coordinates, or the ordering silently degrades to
// containment for shops we believed we could route to.
{
  const missing = [...index.byTerminal.values()].filter((id) => !places[id]);
  ok(missing.length === 0, "every resolved terminal has coordinates",
     `${index.byTerminal.size - missing.length}/${index.byTerminal.size}`);
}

// ── 2. 🔴 THE GATEWAY DISAMBIGUATION — the assertion this module exists for ───────────────────
// "Nyx Gateway" is a real place in BOTH Stanton and Pyro. Matching on name alone resolves one of
// them to the wrong system: a wrong answer that looks exactly like a right one.
// 🔑 Both sides are populated — this is checked below before the rule is asserted, so the test
// cannot pass merely because one of the two does not exist.
{
  const nyxGwIds = Object.entries(locations)
    .filter(([, v]) => (v.name ?? "").toLowerCase() === "nyx gateway")
    .map(([id, v]) => ({ id, sys: systemKey(v.system) }));
  ok(nyxGwIds.length >= 2, "the ambiguous name really is ambiguous in the data",
     nyxGwIds.map((x) => x.sys).join(" + "));

  const inStanton = nyxGwIds.find((x) => x.sys === "stanton");
  const inPyro = nyxGwIds.find((x) => x.sys === "pyro");
  ok(!!inStanton && !!inPyro, "...in both Stanton and Pyro");

  const stantonTerm = shops.terminals.find(
    (t) => systemKey(t.sys) === "stanton" && matchKey(t.place) === matchKey("Nyx Gateway"));
  const pyroTerm = shops.terminals.find(
    (t) => systemKey(t.sys) === "pyro" && matchKey(t.place) === matchKey("Nyx Gateway"));
  ok(!!stantonTerm && !!pyroTerm, "...and the shop table has a terminal at each",
     `${stantonTerm?.n ?? "-"} | ${pyroTerm?.n ?? "-"}`);

  if (stantonTerm && pyroTerm && inStanton && inPyro) {
    ok(index.byTerminal.get(stantonTerm.n) === inStanton.id,
       "a Stanton 'Nyx Gateway' shop resolves to the STANTON one");
    ok(index.byTerminal.get(pyroTerm.n) === inPyro.id,
       "...and a Pyro one to the PYRO one");
    ok(index.byTerminal.get(stantonTerm.n) !== index.byTerminal.get(pyroTerm.n),
       "...which are not the same place");
  }
}

ok(stripSystemSuffix("Nyx Gateway (Stanton)") === "nyx gateway", "the parenthesised system is stripped");
ok(stripSystemSuffix("CenterMass - IO North Tower") === "centermass - io north tower",
   "...and a name with no parenthetical is left alone");

// ── 3. Ordering ───────────────────────────────────────────────────────────────────────────────

const AREA18 = idOfPlace("Area18", "stanton");
const LORVILLE = idOfPlace("Lorville", "stanton");
const NEW_BABBAGE = idOfPlace("New Babbage", "stanton");
const ARCCORP = idOfPlace("ArcCorp", "stanton");

/** Quotes at named real terminals, so every row routes through the real index. */
const termAt = (placeName: string, sys: string): ShopTerminal | undefined =>
  shops.terminals.find((t) => matchKey(t.place) === matchKey(placeName) && systemKey(t.sys) === sys);

const quoteFor = (t: ShopTerminal, price: number): ResolvedQuote =>
  ({ terminal: t.n, system: t.sys, body: t.body, place: t.place, price, asOf: 1780000000 });

// 🔑 Look terminals up by the module's OWN match key, not by a hand-typed literal. UEX writes
// "Area 18" and the starmap "Area18"; a literal here would silently find nothing and every
// assertion below would die on an undefined rather than fail by name.
const tA18 = termAt("Area18", "stanton");
const tLor = termAt("Lorville", "stanton");
const tNB = termAt("New Babbage", "stanton");
ok(!!tA18 && !!tLor && !!tNB, "fixture terminals exist in the real table",
   [tA18?.n ?? "(no Area18)", tLor?.n ?? "(no Lorville)", tNB?.n ?? "(no New Babbage)"].join(" | "));
if (!tA18 || !tLor || !tNB) {
  console.log("FAILED — cannot continue without the fixture terminals");
  process.exit(1);
}

// Deliberately in a price order that CONTRADICTS the distance order, so a test that merely
// preserved input order, or sorted by price, cannot pass.
const quotes: ResolvedQuote[] = [
  quoteFor(tNB, 100),   // farthest, cheapest
  quoteFor(tLor, 200),
  quoteFor(tA18, 300),  // nearest, dearest
];

const verdict = (over: Partial<OriginVerdict>): OriginVerdict => ({
  tier: "place", id: AREA18, label: "Area18", at: Date.now(), ageMin: 1,
  from: "test", howToImprove: "", stale: false, ...over,
});
const deps = (o: OriginVerdict): ProximityDeps => ({ index, locations, travel, origin: o });

// -- unknown origin: order LEFT ALONE, and it says so
{
  const r = orderByProximity(quotes, deps(verdict({ tier: "unknown", id: null })));
  ok(r.basis === "none", "an unknown origin does not sort by distance", r.basis);
  ok(r.quotes.map((q) => q.price).join(",") === "100,200,300",
     "...and leaves the incoming order untouched", r.quotes.map((q) => q.price).join(","));
  ok(r.quotes.every((q) => q.minutes === null), "...and offers no minutes");
  ok(/where you are/i.test(r.note), "...and says why", r.note);
}

// -- a fresh place fix: real minutes, nearest first
{
  const r = orderByProximity(quotes, deps(verdict({})));
  ok(r.basis === "travel-time", "a fresh place fix sorts by travel time", r.basis);
  const first = r.quotes[0];
  ok(first.terminal === tA18.n, "...nearest first, beating the cheaper far shop",
     r.quotes.map((q) => `${q.place}:${q.minutes?.toFixed(1)}m`).join(" < "));
  ok(r.quotes.every((q) => q.minutes !== null), "...every row carries minutes");
  const mins = r.quotes.map((q) => q.minutes!);
  ok(mins[0] <= mins[1] && mins[1] <= mins[2], "...and they ascend", mins.map((m) => m.toFixed(1)).join(" <= "));
  ok(first.containment === "same-place", "...and the origin's own shop reads same-place", String(first.containment));
}

// -- 🔴 STALE DOWNGRADES TO CONTAINMENT. Minutes from a fix we have already decided not to trust
// would be precision we do not have.
{
  const r = orderByProximity(quotes, deps(verdict({ stale: true, ageMin: 90 })));
  ok(r.basis === "containment", "a stale fix falls back to containment", r.basis);
  ok(r.quotes.every((q) => q.minutes === null), "...and states no minutes at all");
  ok(r.quotes[0].terminal === tA18.n, "...but still puts your own location first");
  ok(/last place we saw you/i.test(r.note), "...and says it is a last-known", r.note);
}

// -- a system-level fix is coarse by nature
{
  const r = orderByProximity(quotes, deps(verdict({ tier: "system", id: AREA18, stale: false })));
  ok(r.basis === "containment", "a system-level fix orders by containment", r.basis);
}

// -- 🔑 AN UNROUTABLE SHOP SORTS LAST, NOT FIRST. A missing number is not a zero.
{
  const bogus: ResolvedQuote = {
    terminal: "Nowhere Shop", system: "Stanton", body: null, place: "Nowhere", price: 1,
  asOf: 1780000000 };
  const r = orderByProximity([bogus, ...quotes], deps(verdict({})));
  ok(r.basis === "travel-time", "an unroutable row does not collapse the ordering", r.basis);
  ok(r.quotes[r.quotes.length - 1].terminal === "Nowhere Shop",
     "...and the unroutable shop sorts LAST despite being cheapest",
     r.quotes.map((q) => q.terminal.slice(0, 14)).join(" < "));
  ok(r.quotes[0].terminal === tA18.n, "...while the nearest still leads");
}

// ── 4. Containment, directly ──────────────────────────────────────────────────────────────────
// 🔑 Driven on the function rather than only through the sort, so the rule is checked in isolation
// as well as in situ.
{
  ok(containmentOf(AREA18, "place", AREA18, locations) === "same-place", "a place contains itself");
  ok(containmentOf(AREA18, "place", ARCCORP, locations) !== "elsewhere",
     "Area18 and its own planet are related", containmentOf(AREA18, "place", ARCCORP, locations));
  ok(containmentOf(AREA18, "place", LORVILLE, locations) === "same-system",
     "two Stanton landing zones are same-system",
     containmentOf(AREA18, "place", LORVILLE, locations));
  ok(containmentOf(AREA18, "place", null, locations) === "elsewhere",
     "an unresolvable shop is 'elsewhere', never same-anything");

  const pyroPlace = Object.entries(locations).find(([id, v]) =>
    systemKey(v.system) === "pyro" && !!places[id])?.[0];
  ok(!!pyroPlace, "a Pyro place exists to compare against", pyroPlace ?? "none");
  if (pyroPlace) {
    ok(containmentOf(AREA18, "place", pyroPlace, locations) === "elsewhere",
       "a shop in another system is 'elsewhere'",
       `${locations[pyroPlace].name}`);
  }
}

// ── 5. Cross-system routing is reachable from a shop id ───────────────────────────────────────
// Not a re-test of travel-model: what is asserted is that THIS module's ids feed it successfully.
{
  const pyroTerm = shops.terminals.find((t) => systemKey(t.sys) === "pyro" && index.byTerminal.has(t.n));
  ok(!!pyroTerm, "there is a Pyro shop in the table", pyroTerm?.n ?? "none");
  if (pyroTerm) {
    const r = orderByProximity(
      [quoteFor(pyroTerm, 50), quoteFor(tA18, 999)],
      deps(verdict({ id: NEW_BABBAGE, label: "New Babbage" })),
    );
    ok(r.basis === "travel-time", "a cross-system pair still routes", r.basis);
    const pyroRow = r.quotes.find((q) => q.terminal === pyroTerm.n)!;
    const stantonRow = r.quotes.find((q) => q.terminal === tA18.n)!;
    ok(pyroRow.minutes !== null, "...and the Pyro shop gets a number", String(pyroRow.minutes?.toFixed(1)));
    ok(pyroRow.minutes! > stantonRow.minutes!,
       "...which is larger than the in-system one, as a jump must be",
       `${pyroRow.minutes!.toFixed(1)}m vs ${stantonRow.minutes!.toFixed(1)}m`);
    ok(pyroRow.travelBasis === "estimated",
       "...and is ESTIMATED, because the wormhole transit has never been measured",
       String(pyroRow.travelBasis));
    ok(stantonRow.travelBasis === "measured", "...while a purely in-system leg is measured");
  }
}

// ── 4. 🔴 SUB'S CASE — the ordering shipped INVERTED, and this is the shape of it ──────────────
//
// Reported live from his running app, 2026-08-22, docked at Seraphim Station:
//
//     Orison       (same planet, 830 km)   quoted 14.83 min
//     New Babbage  (another planet, 57,477 Mm)  quoted  4.09 min
//
// Both figures reproduce exactly from the shipped constants, so nothing was wrong with the join,
// the coordinates or the units — `inSystemMinutes` was simply not MONOTONE in distance. A hop
// under `QUANTUM_MIN_RANGE_M` is quoted at `CRUISE_SPEED_MPS` (1 km/s), which is 234,000x slower
// than the drive, so anything near enough to be under the floor sorts BELOW everything far enough
// to jump to. The floor was 20,000 km — Sub's own recollection, flagged as such in the source —
// and that band contains the shops on your own body, i.e. exactly the ones that must rank first.
//
// 🔑 The general property, which is what these assertions really pin: WITHIN ONE SYSTEM, A NEARER
// SHOP MUST NEVER QUOTE MORE MINUTES THAN A FARTHER ONE. Testing only Sub's two places would let
// the same inversion return one floor-value later.
{
  const SERAPHIM = idOfPlace("Seraphim Station", "stanton");
  const tOri = termAt("Orison", "stanton");
  const tSer = termAt("Seraphim Station", "stanton");
  // POSITIVE FIRST — every ordering claim below is free if these rows do not exist.
  ok(!!tOri && !!tNB && !!tSer, "the real table has shops at Orison, New Babbage and Seraphim",
     [tOri?.n ?? "(no Orison)", tNB?.n ?? "(no New Babbage)", tSer?.n ?? "(no Seraphim)"].join(" | "));

  if (tOri && tSer) {
    // The distances the ordering is judged against, straight from the shipped coordinates.
    const pS = posOf(SERAPHIM)!, pO = posOf(index.byTerminal.get(tOri.n)!)!, pN = posOf(NEW_BABBAGE)!;
    const dOri = Math.hypot(pS.x - pO.x, pS.y - pO.y, pS.z - pO.z);
    const dNB = Math.hypot(pS.x - pN.x, pS.y - pN.y, pS.z - pN.z);
    ok(dOri < dNB, "Orison really is nearer to Seraphim than New Babbage is",
       `${(dOri / 1e6).toFixed(1)} Mm vs ${(dNB / 1e6).toFixed(0)} Mm`);
    // 🔑 And it is nearer by four orders of magnitude, so no plausible model may invert it.
    ok(dNB / dOri > 1000, "...by more than a thousandfold", (dNB / dOri).toFixed(0) + "x");

    const from = verdict({ id: SERAPHIM, label: "Seraphim Station" });
    const r = orderByProximity(
      // Priced so that price-order and distance-order disagree: New Babbage is the cheapest.
      [quoteFor(tNB, 100), quoteFor(tOri, 300)], deps(from));
    ok(r.basis === "travel-time", "a fresh fix at Seraphim sorts by travel time", r.basis);
    ok(r.quotes[0].terminal === tOri.n,
       "🔴 Orison ranks nearer than New Babbage from Seraphim",
       r.quotes.map((q) => `${q.place}:${q.minutes?.toFixed(2)}m`).join(" < "));
    // 🔑 Named, not positional. Comparing quotes[0] to quotes[1] only re-checks that `sort` sorted
    // — it stays green with the places the wrong way round, which is the whole bug.
    const mOri = r.quotes.find((q) => q.terminal === tOri.n)?.minutes;
    const mNB = r.quotes.find((q) => q.terminal === tNB.n)?.minutes;
    ok(mOri != null && mNB != null && mOri < mNB,
       "...because ORISON's own quoted minutes are lower than NEW BABBAGE's",
       `Orison ${mOri?.toFixed(2)} vs New Babbage ${mNB?.toFixed(2)}`);
  }

  // -- THE GENERAL PROPERTY, swept over every shop in Stanton rather than the two Sub happened to
  // hit. Sorted by real distance, the quoted minutes must never go backwards.
  {
    const rows = [...index.byTerminal.entries()]
      .filter(([, pid]) => places[pid] && systemOf(pid) === "stanton")
      .map(([name, pid]) => {
        const p = posOf(pid)!, s = posOf(SERAPHIM)!;
        return { name, d: Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z), pid };
      })
      .filter((r) => r.d > 0)
      .sort((a, b) => a.d - b.d);
    ok(rows.length > 100, "the sweep has a real population to sweep", `${rows.length} Stanton shops`);
    const terms = new Map(shops.terminals.map((t) => [t.n, t]));
    const ordered = orderByProximity(
      rows.map((r, i) => quoteFor(terms.get(r.name)!, 1000 - i)), deps(verdict({ id: SERAPHIM, label: "Seraphim Station" })));
    const byName = new Map(ordered.quotes.map((q) => [q.terminal, q.minutes]));
    let worst: string | null = null, breaks = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = byName.get(rows[i - 1].name), b = byName.get(rows[i].name);
      if (a == null || b == null) continue;
      if (b < a - 1e-9) {
        breaks++;
        if (!worst) worst = `${rows[i - 1].name} @${(rows[i - 1].d / 1e6).toFixed(1)}Mm=${a.toFixed(2)}m`
          + ` then NEARER-BUT-SLOWER is impossible... ${rows[i].name} @${(rows[i].d / 1e6).toFixed(1)}Mm=${b.toFixed(2)}m`;
      }
    }
    ok(breaks === 0, "🔴 minutes never go DOWN as distance goes UP, across every Stanton shop",
       breaks === 0 ? `${rows.length} shops in ascending distance` : `${breaks} inversions, e.g. ${worst}`);
  }
}


console.log(`\n${fail ? `FAILED (${fail})` : "all passed"}  ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
