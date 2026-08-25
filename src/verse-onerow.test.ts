/**
 * ONE LIST — the fold, the placement, and the refusals that keep both honest.
 *
 * `npm run test:onerow`. Everything here is about flight `onerow`'s central claim: a community
 * confirmation is either part of a shop row or a row of its own, and never a second list.
 *
 * 🔴 EVERY CONTROL IN THIS FILE IS INLINE AND RUNS EVERY TIME, the shape `test:trade` uses. A
 * control kept in a scratch file rots the first time somebody edits the code it guards; one that
 * lives in the suite cannot. Each is marked CONTROL and says which regression it re-injects.
 *
 * 🔴 AND EVERY "MUST NOT" IS PRECEDED BY A "MUST". The most expensive false pass on this project
 * is an assertion satisfied by an empty set — `assert(!rows.some(bad))` is free when there are no
 * rows, and the bug being guarded against is frequently what empties them. So each block asserts
 * the set is non-empty FIRST.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPlacer, foldsOnto, fromJoinMap, fromShopLoc, fromShopPlacesFile, fromShopTerminals,
  mergePlacements, placerCoverage, type ShopPlacement,
} from "./shop-placement.js";
import { applyConfirmations } from "./verse-routes.js";
import type { ResolvedQuote, QuoteContext } from "./item-search.js";
import { orderByProximity, type LocationRecord, type TerminalIndex } from "./verse-proximity.js";

let passed = 0;
const ok = (cond: unknown, what: string, detail?: unknown): void => {
  assert.ok(cond, what + (detail === undefined ? "" : "  [" + String(detail) + "]"));
  passed++;
};
const eq = (a: unknown, b: unknown, what: string): void => {
  assert.deepEqual(a, b, what + "  [got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + "]");
  passed++;
};

/* ── Fixtures ────────────────────────────────────────────────────────────────────────────────── */

const HOUR = 3600;
const NOW = Math.floor(Date.now() / 1000);

const LEVSKI = "468d4102-a210-47b5-8bc3-084f791a173c";
const ORISON = "567f92d7-d34c-42fa-b57b-f1939d4c5f5b";
const SERAPHIM = "aaaaaaaa-0000-0000-0000-000000000001";

const LOCATIONS: Record<string, LocationRecord> = {
  // 🔑 "Nyx System", with the trailing word — that IS how `locations.json` writes it, and the
  // mismatch against UEX's "Nyx" is a real bug this suite pins. Do not "tidy" it.
  [LEVSKI]: { name: "Levski", system: "Nyx System", parentName: "Nyx", type: "Manmade" },
  [ORISON]: { name: "Orison", system: "Stanton System", parentName: "Crusader", type: "LandingZone" },
  [SERAPHIM]: { name: "Seraphim Station", system: "Stanton System", parentName: "Crusader", type: "Manmade" },
};

const TERMINALS = [
  { n: "Cargo Services - Levski", sys: "Nyx", body: "Nyx", place: "Levski" },
  { n: "Refinery Shop - Levski", sys: "Nyx", body: "Nyx", place: "Levski" },
  { n: "Ship Weapons - Crusader Showroom - Orison", sys: "Stanton", body: "Crusader", place: "Orison" },
  { n: "Live Fire Weapons - Seraphim", sys: "Stanton", body: "Crusader", place: "Seraphim Station" },
  { n: "Armor - Seraphim", sys: "Stanton", body: "Crusader", place: "Seraphim Station" },
];

const INDEX: TerminalIndex = {
  byTerminal: new Map([
    ["Cargo Services - Levski", LEVSKI],
    ["Refinery Shop - Levski", LEVSKI],
    ["Ship Weapons - Crusader Showroom - Orison", ORISON],
    ["Live Fire Weapons - Seraphim", SERAPHIM],
    ["Armor - Seraphim", SERAPHIM],
  ]),
  resolved: 5, total: 5, collisions: 0, ambiguous: 0,
};

const PLACEMENTS: ShopPlacement[] = [
  // Sub's own case: the curated map names the kiosk but only at place level, and the log replay
  // can place it and not name it. Merged, that is a place-level name plus a starmap id.
  { token: "SCShop_Levski_CargoOffice_ITEM", terminal: "Cargo Services - Levski", precision: "place-level", kind: "item", placeId: LEVSKI, place: "Levski", tier: "place" },
  { token: "SCShop_Levski_Refinery_Store", terminal: "Refinery Shop - Levski", precision: "exact", kind: "item", placeId: LEVSKI, place: "Levski", tier: "place" },
  // Placed, never named — the case brief item 3 is about.
  { token: "SCShop_CrusaderShowroomWeaponry_Orison", terminal: null, precision: null, kind: null, placeId: ORISON, place: "Orison", tier: "place" },
  // The 11x case: Seraphim really does hold two kiosks 36 vs 396 aUEC apart.
  { token: "SCShop_Seraphim_SomeKiosk", terminal: "Live Fire Weapons - Seraphim", precision: "place-level", kind: "item", placeId: SERAPHIM, place: "Seraphim Station", tier: "place" },
];

const PLACER = buildPlacer(PLACEMENTS);

/** A pool that answers with whatever the test hands it, in the shape `VerseDeps.pool` wants. */
function poolOf(rows: {
  terminal: string; unitPrice: number; agoSeconds: number; contributors?: number;
  samples?: number; side?: "buy" | "sell"; publishable?: boolean;
}[]) {
  const quotes = rows.map((r) => ({
    kind: "item" as const,
    id: "item-uuid",
    terminal: r.terminal,
    side: r.side ?? ("buy" as const),
    unitPrice: r.unitPrice,
    low: r.unitPrice,
    high: r.unitPrice,
    samples: r.samples ?? 1,
    contributors: r.contributors ?? 1,
    latest: new Date((NOW - r.agoSeconds) * 1000).toISOString(),
    ageSeconds: r.agoSeconds,
    atSeconds: NOW - r.agoSeconds,
    confidence: "seen-once" as const,
    singleContributor: (r.contributors ?? 1) <= 1,
    derived: false,
    publishable: r.publishable !== false,
    historicalOnly: true,
  }));
  return () => ({
    forId: () => quotes,
    confirmThreshold: () => 3,
    status: () => ({ quotes: quotes.length, entries: 1, source: "live", fetchedAt: null, lastError: null, url: null, confirmAt: 3 }),
  });
}

const CTX: QuoteContext = { name: "CRUZ Lux", uuid: "item-uuid", kind: "item" };

const quote = (terminal: string, price: number, daysOld: number): ResolvedQuote => {
  const t = TERMINALS.find((x) => x.n === terminal)!;
  return { terminal, system: t.sys, body: t.body, place: t.place, price, asOf: NOW - daysOld * 86400 };
};

function run(quotes: ResolvedQuote[], pool: ReturnType<typeof poolOf>, placer = PLACER) {
  return applyConfirmations(quotes, CTX, { dataDir: "", userDir: "", pool } as never, placer, TERMINALS, LOCATIONS, INDEX);
}

/* ── 1. `foldsOnto` — the rule the 22.3% measurement bought ──────────────────────────────────── */

eq(foldsOnto("exact", 7, 7), "price", "an exact placement folds the price");
eq(foldsOnto("exact", 42, 7), "price",
  "an exact placement folds the price even when it DISAGREES — that is Sub's ruling that ours wins");
eq(foldsOnto("place-level", 7, 7), "age",
  "a place-level placement whose price agrees may refresh the age");
eq(foldsOnto("place-level", 396, 36), null,
  "a place-level placement whose price disagrees folds NOTHING — the Seraphim 11x case");

// 🔴 CONTROL: the shipped bug this rule exists to prevent is `place-level` behaving like `exact`.
// Model the alternative and assert it really would put the wrong number on the row.
{
  const wrong = (p: string, obs: number, row: number) => "price" as const; // the regression
  ok(wrong("place-level", 396, 36) === "price" && foldsOnto("place-level", 396, 36) === null,
    "CONTROL: treating place-level as exact would fold 396 onto a 36 aUEC row; the real rule refuses");
}

/* ── 2. Merging two sources ──────────────────────────────────────────────────────────────────── */

{
  const m = mergePlacements([
    { token: "T", terminal: "Refinery Shop - Levski", precision: "place-level", kind: "item", placeId: null, place: null, tier: null },
    { token: "T", terminal: "Refinery Shop - Levski", precision: "exact", kind: "item", placeId: LEVSKI, place: "Levski", tier: "place" },
  ])!;
  eq(m.precision, "exact", "two sources agreeing on a name take the stronger precision");
  eq(m.placeId, LEVSKI, "and the place from whichever source had one");
}
{
  const m = mergePlacements([
    { token: "T", terminal: "Cargo Services - Levski", precision: "exact", kind: "item", placeId: LEVSKI, place: "Levski", tier: "place" },
    { token: "T", terminal: "Refinery Shop - Levski", precision: "exact", kind: "item", placeId: LEVSKI, place: "Levski", tier: "place" },
  ])!;
  eq(m.terminal, null, "two sources naming DIFFERENT terminals resolves to neither");
  eq(m.placeId, LEVSKI, "but they still agree about the station, so the place survives");
}
// Two sources naming different STATIONS and nothing else leaves a statement with nothing in it,
// which is not a placement at all — so the token is unknown rather than placed at one of them.
eq(mergePlacements([
  { token: "T", terminal: null, precision: null, kind: null, placeId: LEVSKI, place: "Levski", tier: "place" },
  { token: "T", terminal: null, precision: null, kind: null, placeId: ORISON, place: "Orison", tier: "place" },
]), null, "two sources naming different STATIONS places it nowhere");
eq(mergePlacements([{ token: "T", terminal: null, precision: null, kind: null, placeId: null, place: null, tier: null }]), null,
  "a statement that states nothing is not a placement");

/* ── 3. The adapters read the real source shapes ─────────────────────────────────────────────── */

{
  const rows = fromJoinMap({
    conf: [
      ["SCShop_A", 9, "Cargo Services - Levski", "item", "place-level"],
      ["SCShop_B", 9, "Levski", "commodity", "exact"],
      ["SCShop_C", 9, "Whatever", "item", "brand-new-tag-from-a-later-build"],
    ],
    unconf: [["SCShop_D", 9, "place ok, 2 stores match", ["X", "Y"]]],
  });
  eq(rows.length, 3, "every `conf` row becomes a statement");
  eq(rows.find((r) => r.token === "SCShop_B")!.kind, "commodity", "the terminal namespace travels");
  eq(rows.find((r) => r.token === "SCShop_C")!.precision, "place-level",
    "an unrecognised precision tag degrades to the CAUTIOUS reading, never to the one that can move a price");
  ok(!rows.some((r) => r.token === "SCShop_D"),
    "and an `unconf` row states nothing — an ambiguous token stays ambiguous");
}
{
  const rows = fromShopLoc({
    reports: [
      { token: "SCShop_E", verdict: "terminal", terminal: "Refinery Shop - Levski", places: [{ id: LEVSKI, name: "Levski" }] },
      { token: "SCShop_F", verdict: "place", terminal: null, places: [{ id: ORISON, name: "Orison" }] },
      { token: "SCShop_G", verdict: "place-dependent", terminal: null, places: [{ id: LEVSKI }, { id: ORISON }] },
      { token: "SCShop_H", verdict: "unresolved", terminal: null, places: [] },
      { token: "SCShop_I", verdict: "place", terminal: null, places: [{ id: LEVSKI }, { id: ORISON }] },
    ],
  });
  ok(rows.length > 0, "the replay produces statements at all", rows.length);
  eq(rows.find((r) => r.token === "SCShop_E")!.precision, "exact", "a `terminal` verdict is exact");
  eq(rows.find((r) => r.token === "SCShop_F")!.terminal, null, "a `place` verdict names no terminal");
  eq(rows.find((r) => r.token === "SCShop_F")!.placeId, ORISON, "but does place it");
  ok(!rows.some((r) => r.token === "SCShop_G"), "`place-dependent` places NOTHING — the 13-station token");
  ok(!rows.some((r) => r.token === "SCShop_H"), "and `unresolved` states nothing");
  ok(!rows.some((r) => r.token === "SCShop_I"),
    "a `place` verdict carrying TWO places is the ambiguous case in the confident verdict's clothes");
}
{
  const rows = fromShopPlacesFile({
    schema: 1,
    shops: {
      SCShop_J: { terminal: "Cargo Services - Levski", precision: "exact", kind: "item", placeId: LEVSKI, place: "Levski", tier: "place" },
      SCShop_K: { placeId: ORISON, place: "Orison" },
      SCShop_L: {},
    },
  });
  eq(rows.length, 2, "the shipped file round-trips, and a row stating nothing is skipped");
  const cov = placerCoverage(rows);
  eq(cov, { tokens: 2, named: 1, exact: 1, placed: 2 }, "coverage counts named and placed separately");
}

/* ── 4. Sub's own case, end to end ───────────────────────────────────────────────────────────── */

{
  const quotes = [
    quote("Cargo Services - Levski", 7, 26),
    quote("Refinery Shop - Levski", 7, 99),
  ];
  const { quotes: rows, unplaced } = run(quotes, poolOf([
    { terminal: "SCShop_Levski_CargoOffice_ITEM", unitPrice: 7, agoSeconds: 5 * HOUR, contributors: 2, samples: 2 },
    { terminal: "SCShop_Levski_Refinery_Store", unitPrice: 7, agoSeconds: 32 * 86400, contributors: 4, samples: 5 },
  ]));

  const confirmed = rows.filter((r) => r.confirmed);
  ok(confirmed.length === 2, "BOTH Levski rows carry a confirmation", confirmed.length);
  eq(rows.length, 2, "and NO extra row was created — this is one list, not two");

  const cargo = rows.find((r) => r.terminal === "Cargo Services - Levski")!;
  ok(cargo.confirmed!.asOf > NOW - 6 * HOUR,
    "Cargo Services now reads hours old, not 26 days — Sub's acceptance case");
  eq(cargo.confirmed!.setPrice, false, "and the place-level fold did NOT move the number");
  eq(cargo.price, 7, "which is still UEX's 7 aUEC");
  eq(cargo.confirmed!.contributors, 2, "the contributor count travels for the tooltip");

  const refinery = rows.find((r) => r.terminal === "Refinery Shop - Levski")!;
  eq(refinery.confirmed!.setPrice, true, "the exact fold DID supply the price");
  ok(refinery.confirmed!.asOf > refinery.asOf,
    "and it is newer than UEX's own reading, which is why it was applied");
  eq(unplaced, 0, "nothing was left unplaced here");
}

// 🔴 CONTROL: this is the two-row rendering, re-injected. With no placement for the Cargo Office
// token, the confirmation cannot fold and becomes a SECOND row at Levski quoting the same 7 aUEC —
// which is exactly the duplicate Sub rejected. The assertion above must be the thing that stops it.
{
  const quotes = [quote("Cargo Services - Levski", 7, 26)];
  const blind = buildPlacer(PLACEMENTS.filter((p) => p.token !== "SCShop_Levski_CargoOffice_ITEM"));
  const { quotes: rows, unplaced } = run(quotes, poolOf([
    { terminal: "SCShop_Levski_CargoOffice_ITEM", unitPrice: 7, agoSeconds: 5 * HOUR },
  ]), blind);
  eq(rows.length, 1, "CONTROL: with no placement the row is not duplicated — it is dropped instead");
  eq(unplaced, 1, "CONTROL: and counted, never silently swallowed");
  ok(!rows[0].confirmed, "CONTROL: and the surviving row makes no claim it cannot support");
}

/* ── 5. Placed, not named — brief item 3 ─────────────────────────────────────────────────────── */

{
  const quotes = [quote("Ship Weapons - Crusader Showroom - Orison", 128145, 22)];
  const { quotes: rows, unplaced } = run(quotes, poolOf([
    { terminal: "SCShop_CrusaderShowroomWeaponry_Orison", unitPrice: 128145, agoSeconds: 18 * 86400 },
  ]));
  const added = rows.filter((r) => r.observedOnly);
  ok(added.length === 1, "a confirmation we can place but not name becomes a row of its own", added.length);
  eq(added[0].place, "Orison", "IN the right place group");
  eq(added[0].system, "Stanton",
    "and describing its system in UEX's words — 'Stanton', not the starmap's 'Stanton System', "
    + "or it forms an identical-looking group of its own");
  eq(added[0].placeId, ORISON, "carrying the id `orderByProximity` sorts it by");
  eq(added[0].terminal, "SCShop_CrusaderShowroomWeaponry_Orison",
    "under the game's own name, which the widget tidies for reading");
  ok(!added[0].confirmed!.precision,
    "and NO precision — there is no UEX terminal under it for a precision to be about");
  eq(unplaced, 0, "it is placed, so it is not counted as unplaceable");
}

/* ── 6. The refusals ─────────────────────────────────────────────────────────────────────────── */

{
  // The Seraphim 11x case, live: a place-level token whose price disagrees with the row.
  const quotes = [quote("Live Fire Weapons - Seraphim", 36, 90), quote("Armor - Seraphim", 396, 90)];
  const { quotes: rows } = run(quotes, poolOf([
    { terminal: "SCShop_Seraphim_SomeKiosk", unitPrice: 396, agoSeconds: HOUR },
  ]));
  const lfw = rows.find((r) => r.terminal === "Live Fire Weapons - Seraphim")!;
  eq(lfw.price, 36, "🔴 a place-level confirmation of 396 does NOT overwrite the 36 aUEC row");
  ok(!lfw.confirmed, "and does not refresh its age either — which kiosk it was is now the question");
  const added = rows.filter((r) => r.observedOnly);
  ok(added.length === 1, "it becomes a row of its own at the same station instead", added.length);
  eq(added[0].price, 396, "stating the number that was actually paid");
}
{
  // Older than the row it lands on.
  const quotes = [quote("Cargo Services - Levski", 7, 1)];
  const { quotes: rows, unplaced } = run(quotes, poolOf([
    { terminal: "SCShop_Levski_CargoOffice_ITEM", unitPrice: 7, agoSeconds: 40 * 86400 },
  ]));
  eq(rows.length, 1, "a confirmation OLDER than the row adds no row");
  ok(!rows[0].confirmed, "and no mark — UEX's own reading is the latest confirmation here");
  eq(unplaced, 0, "it is about that row, so it is handled rather than counted as unplaceable");
}
{
  // A derived commodity sell.
  const quotes = [quote("Cargo Services - Levski", 7, 26)];
  const { quotes: rows } = run(quotes, poolOf([
    { terminal: "SCShop_Levski_CargoOffice_ITEM", unitPrice: 999, agoSeconds: HOUR, publishable: false },
  ]));
  ok(!rows.some((r) => r.confirmed), "🔴 a quote the site marked unpublishable is never a price here");
  eq(rows.length, 1, "and never a row");
}
{
  // 🔴 AN ITEM SELL IS DROPPED BEFORE IT GETS HERE, and finding that out is why this block is a
  // COMMODITY. No item sell verb exists in 533 logs, so `confirmationsFor` refuses one outright —
  // the first draft of this test asserted the sell became a row and went red, correctly.
  const itemSell = run([quote("Cargo Services - Levski", 7, 26)], poolOf([
    { terminal: "SCShop_Levski_CargoOffice_ITEM", unitPrice: 3, agoSeconds: HOUR, side: "sell" },
  ]));
  eq(itemSell.quotes.length, 1, "an ITEM sell is refused before it can become anything");
  ok(!itemSell.quotes[0].confirmed, "and leaves the row it aimed at untouched");

  // A commodity sell is real, and must not fold onto a buy row.
  const cCtx: QuoteContext = { name: "Laranite", uuid: null, kind: "commodity" };
  const quotes = [quote("Cargo Services - Levski", 7, 26)];
  const { quotes: rows } = applyConfirmations(
    quotes, cCtx,
    {
      dataDir: "", userDir: "", commodityUuid: () => "item-uuid",
      pool: poolOf([{ terminal: "SCShop_Levski_CargoOffice_ITEM", unitPrice: 3, agoSeconds: HOUR, side: "sell" }]),
    } as never,
    PLACER, TERMINALS, LOCATIONS, INDEX,
  );
  const cargo = rows.find((r) => r.terminal === "Cargo Services - Levski" && !r.observedOnly)!;
  eq(cargo.price, 7, "a SELL never folds onto a buy row — that would say a shop sells it for what it pays");
  ok(!cargo.confirmed, "nor refreshes its age");
  const added = rows.filter((r) => r.observedOnly);
  ok(added.length === 1, "it is a row of its own", added.length);
  eq(added[0].confirmed!.side, "sell", "labelled as what the terminal PAID");
  eq(added[0].price, 3, "stating the figure the player actually got");
}

/* ── 7. Folding survives a build with no starmap ─────────────────────────────────────────────── */

{
  const quotes = [quote("Refinery Shop - Levski", 7, 99)];
  const { quotes: rows, unplaced } = applyConfirmations(
    quotes, CTX,
    { dataDir: "", userDir: "", pool: poolOf([{ terminal: "SCShop_Levski_Refinery_Store", unitPrice: 5, agoSeconds: HOUR }]) } as never,
    PLACER, TERMINALS,
    // 🔴 No locations, no terminal index — the state a build with no `locations-xyz` is in.
    undefined, undefined,
  );
  ok(rows[0].confirmed, "an exact fold still lands with no geography at all");
  eq(rows[0].price, 5, "including the price, because ours wins");
  eq(unplaced, 0, "and the placement's own starmap id still places what it can");
}

/* ── 8. One place, one run — the widget groups by CONSECUTIVE run ────────────────────────────── */

/**
 * 🔴 THE TIE IS THE BUG. Three shops, two places, ALL the same containment tier and ALL the same
 * price: the comparator separates none of them, so the incoming order stands — and once `onerow`
 * started appending community rows to the end of that array, a place split across the list became
 * routine. The renderer builds its groups from consecutive runs, so a split draws the heading
 * twice: ORISON · NEW BABBAGE · ORISON.
 */
{
  const ORDER_TERMS = [
    { n: "Ship Weapons - Crusader Showroom - Orison", sys: "Stanton", body: "Crusader", place: "Orison" },
    { n: "CenterMass - New Babbage", sys: "Stanton", body: "microTech", place: "New Babbage" },
    { n: "SCShop_CrusaderShowroomWeaponry_Orison", sys: "Stanton", body: "Crusader", place: "Orison" },
  ];
  const NB = "bbbbbbbb-0000-0000-0000-000000000002";
  const locs: Record<string, LocationRecord> = {
    ...LOCATIONS,
    [NB]: { name: "New Babbage", system: "Stanton System", parentName: "microTech", type: "LandingZone" },
  };
  const idx: TerminalIndex = {
    byTerminal: new Map([
      ["Ship Weapons - Crusader Showroom - Orison", ORISON],
      ["CenterMass - New Babbage", NB],
    ]),
    resolved: 2, total: 3, collisions: 0, ambiguous: 0,
  };
  const rows: ResolvedQuote[] = ORDER_TERMS.map((t, i) => ({
    terminal: t.n, system: t.sys, body: t.body, place: t.place, price: 128145, asOf: NOW - 20 * 86400,
    ...(i === 2 ? { placeId: ORISON, observedOnly: true as const } : {}),
  }));

  const order = orderByProximity(rows, {
    index: idx,
    locations: locs,
    travel: { gateways: [], posOf: () => null, systemOf: () => null },
    // A STALE place fix, so this is the containment basis — the one with real ties in it.
    origin: { tier: "place", id: LEVSKI, label: "Levski", ageMin: 400, stale: true, from: "test", detail: null, howToImprove: "" } as never,
  });

  const places = order.quotes.map((q) => q.place);
  ok(places.length === 3, "all three rows survive the ordering", JSON.stringify(places));
  // Positive first: the split this guards against has to be EXPRESSIBLE, or the check is free.
  ok(new Set(places).size === 2, "and they really do span two places", new Set(places).size);
  const runs = places.filter((p, i) => i === 0 || p !== places[i - 1]);
  eq(runs.length, new Set(places).size,
    "🔴 each place forms ONE consecutive run — a second run draws its heading twice in the widget");
  eq(places[0], "Orison", "and the place that led still leads; cohesion may not reorder places");
}

/* ── 9. A placed row is ranked by WHERE IT IS, not by having no terminal ─────────────────────── */

/**
 * 🔴 THIS BLOCK EXISTS BECAUSE A CONTROL CAME BACK GREEN. Section 8 groups on the place STRING, so
 * gutting `placeOf`'s `q.placeId ?? …` changed nothing there and the assertion looked like coverage
 * it was not. What `placeId` actually buys is the CONTAINMENT tier: without it a synthesized row
 * resolves to no place, `containmentOf` returns `elsewhere`, and a confirmation from the very shop
 * the player is standing in sorts below every survey row in the game. That is Sub's whole ask
 * ("still have it sorted by distance") failing silently on exactly the rows this flight added.
 */
{
  const rows: ResolvedQuote[] = [
    { terminal: "Ship Weapons - Crusader Showroom - Orison", system: "Stanton", body: "Crusader", place: "Orison", price: 100, asOf: NOW },
    { terminal: "SCShop_Levski_Something", system: "Nyx", body: "Nyx", place: "Levski", price: 900, asOf: NOW, placeId: LEVSKI, observedOnly: true },
  ];
  const order = orderByProximity(rows, {
    index: { byTerminal: new Map([["Ship Weapons - Crusader Showroom - Orison", ORISON]]), resolved: 1, total: 2, collisions: 0, ambiguous: 0 },
    locations: LOCATIONS,
    travel: { gateways: [], posOf: () => null, systemOf: () => null },
    // The player is standing AT Levski, where the placed confirmation is.
    origin: { tier: "place", id: LEVSKI, label: "Levski", ageMin: 400, stale: true, from: "test", detail: null, howToImprove: "" } as never,
  });
  const placed = order.quotes.find((q) => q.observedOnly)!;
  ok(placed, "the placed row survived the ordering");
  eq(placed.containment, "same-place",
    "🔴 a placed confirmation is ranked by WHERE IT IS — its own placeId, not the terminal index");
  eq(order.quotes[0].terminal, "SCShop_Levski_Something",
    "so it leads, ahead of a cheaper survey row in another system — which is the ordering Sub asked for");
}

/* ── 10. `shoploc`'s shipped artifact, read in its own schema ────────────────────────────────── */

/**
 * Driven against the REAL `data/shop-terminals.json` rather than a fixture, because the whole point
 * of this adapter is that it agrees with a file another flight owns — a fixture would only ever
 * assert that I copied the schema into my own test correctly. If `shoploc` reshapes the file these
 * assertions are supposed to notice.
 */
{
  const doc = JSON.parse(readFileSync(join("data", "shop-terminals.json"), "utf8")) as {
    tokens: Record<string, { verdict: string; outcome: string; terminal: string | null;
      provisionalTerminal: string | null; location?: { tier?: string; id?: string } | null }>;
  };
  const rows = fromShopTerminals(doc);
  const by = new Map(rows.map((r) => [r.token, r]));
  const all = Object.entries(doc.tokens);

  ok(all.length > 50, "the shipped artifact has tokens in it at all", all.length);
  ok(rows.length > 40, "and the adapter accepted a real share of them", rows.length + " of " + all.length);

  // 🔴 `outcome: "placed"` NEVER NAMES A KIOSK — `usage.placedIsNotNamed`, asserted over every row
  // rather than one example, because one example is a claim about one row.
  const placedRows = all.filter(([, t]) => t.outcome === "placed").map(([k]) => k);
  ok(placedRows.length > 20, "the artifact really does hold placed-but-unnamed tokens", placedRows.length);
  ok(placedRows.every((k) => !by.get(k) || by.get(k)!.terminal === null),
     "🔴 not one of them names a terminal",
     placedRows.filter((k) => by.get(k)?.terminal).join(",") || "none named");

  // 🔴 `provisionalTerminal` IS NOT A BACK DOOR. The file says it is "not safe to attribute a price
  // with", and 14 tokens carry one — so if this ever leaks through, it leaks 14 times at once.
  const prov = all.filter(([, t]) => t.provisionalTerminal).map(([k]) => k);
  ok(prov.length > 0, "tokens carrying a provisionalTerminal exist to be ignored", prov.length);
  ok(prov.every((k) => {
       const r = by.get(k);
       return !r || r.terminal === null || doc.tokens[k].outcome === "named";
     }), "🔴 and a provisional name never becomes a placement's terminal",
     prov.filter((k) => by.get(k)?.terminal && doc.tokens[k].outcome !== "named").join(","));

  // 🔴 A place-dependent token is REFUSED ENTIRELY — prices vary per station for one prefab token
  // (Compboard 22.2% across five terminals) and the pool has already blended them into one median.
  const dep = all.filter(([, t]) => t.verdict === "place-dependent").map(([k]) => k);
  ok(dep.length > 0, "place-dependent tokens exist in the artifact", dep.length);
  ok(dep.every((k) => !by.has(k)),
     "🔴 and not one of them yields a placement, even the ones carrying a usable location.id",
     dep.filter((k) => by.has(k)).join(",") || "all refused");
  // Positive control on that refusal: some of them DO carry an id, so the rule is doing work.
  ok(dep.some((k) => !!doc.tokens[k].location?.id),
     "...and that is a real refusal — several of them carry a location.id we chose not to use",
     dep.filter((k) => doc.tokens[k].location?.id).length + " with an id");

  // A named token folds at `exact`, and its namespace comes from `soldBy`.
  const named = all.filter(([, t]) => t.outcome === "named").map(([k]) => k);
  ok(named.length > 5, "named tokens exist", named.length);
  ok(named.every((k) => by.get(k)?.precision === "exact"),
     "every named token folds at exact precision");
  const tdd = by.get("SCShop_CommEx_TDD_Orison");
  ok(tdd && tdd.kind === "commodity",
     "a commodity counter is tagged commodity, so it is never looked up in the item table",
     tdd ? tdd.kind : "(absent)");

  // The coarse tiers survive, because a star id still sorts.
  const coarse = rows.filter((r) => r.tier === "system" || r.tier === "body");
  ok(coarse.length > 0, "coarse-tier placements are kept, not dropped", coarse.length);
  ok(coarse.every((r) => r.terminal === null), "...and none of them names anything");
}

/* ── 11. Many-to-one: two tokens, one UEX row ────────────────────────────────────────────────── */

/**
 * 🔴 `usage.notInjective`. `SCShop_Levski_Refinery_Store` and `SCShop_Levski_Refinery_OreSales` both
 * resolve to *Refinery Shop - Levski* — the game splits the item counter from the ore desk and UEX
 * does not. Confirmations are applied newest-first, and without a guard the SECOND one folded over
 * the first, leaving the row showing the staler of the two while looking perfectly healthy.
 */
{
  const both: ShopPlacement[] = [
    { token: "SCShop_Levski_Refinery_Store", terminal: "Refinery Shop - Levski", precision: "exact", kind: "item", placeId: LEVSKI, place: "Levski", tier: "place" },
    { token: "SCShop_Levski_Refinery_OreSales", terminal: "Refinery Shop - Levski", precision: "exact", kind: "item", placeId: LEVSKI, place: "Levski", tier: "place" },
  ];
  const { quotes: rows } = run([quote("Refinery Shop - Levski", 100, 99)], poolOf([
    { terminal: "SCShop_Levski_Refinery_Store", unitPrice: 111, agoSeconds: 2 * HOUR, contributors: 3, samples: 3 },
    { terminal: "SCShop_Levski_Refinery_OreSales", unitPrice: 222, agoSeconds: 20 * 86400, contributors: 1, samples: 1 },
  ]), buildPlacer(both));

  eq(rows.length, 1, "two tokens naming one terminal produce ONE row, not two");
  const r = rows[0];
  ok(r.confirmed, "and it is confirmed");
  eq(r.price, 111, "🔴 by the FRESHEST of the two, not whichever was applied last");
  ok(r.confirmed!.asOf > NOW - 3 * HOUR, "its age is the fresh one's", r.confirmed!.token);
  eq(r.confirmed!.token, "SCShop_Levski_Refinery_Store", "and it names which shop that was");
  eq(r.confirmed!.contributors, 3,
     "🔑 the two are NOT merged — they are different shops with one UEX row between them, so adding "
     + "their witnesses would present two shops' evidence as consensus about one");
}

/* ── 12. Nothing here can read the player's position ─────────────────────────────────────────── */

/**
 * 🔴 A POOLED ROW MUST NEVER BE NAMED FROM THE LOCAL PLAYER'S LOCATION. `shoploc`'s
 * `usage.place-dependent` says such a token is "still resolvable AT RUNTIME — the app already knows
 * where the player is", and that is true only for THIS player's own new observations. A pooled row
 * stores the shop token, not the contributor's position, so resolving it here would attribute a
 * stranger's price to a station they were never at — the poisoning `shoploc` spent a flight
 * avoiding, reintroduced at render time.
 *
 * ⚠️ Asserted as an ABSENCE OF CAPABILITY rather than an absence of behaviour: the placer is the
 * only thing that turns a token into a place, and it is a pure function of the token. Feeding the
 * same confirmation through two placers that disagree about nothing except what they were BUILT
 * from must give the same answer whatever the session thinks.
 */
{
  const dep: ShopPlacement[] = [
    { token: "SCShop_Roaming", terminal: null, precision: null, kind: null, placeId: null, place: null, tier: null },
  ];
  const pool = poolOf([{ terminal: "SCShop_Roaming", unitPrice: 500, agoSeconds: HOUR }]);
  const a = run([quote("Cargo Services - Levski", 7, 26)], pool, buildPlacer(dep));
  // Same call, but with a locationSignals dep present and answering — if anything reached for the
  // player's position this is where it would show.
  const b = applyConfirmations(
    [quote("Cargo Services - Levski", 7, 26)], CTX,
    { dataDir: "", userDir: "", pool, locationSignals: () => ({ places: [{ id: LEVSKI, name: "Levski", at: Date.now() }] }) } as never,
    buildPlacer(dep), TERMINALS, LOCATIONS, INDEX,
  );
  eq(a.unplaced, 1, "a token nothing can place is counted as unplaced");
  eq(b.unplaced, a.unplaced, "🔴 and knowing where the player is does not change that");
  eq(b.quotes.length, a.quotes.length, "...nor does it conjure a row");
  ok(!b.quotes.some((q) => q.observedOnly), "...anywhere");
}

console.log(`verse one-row: all passed ${passed}/${passed}`);
