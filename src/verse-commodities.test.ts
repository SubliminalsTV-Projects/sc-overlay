/**
 * COMMODITIES IN THE VERSE FINDER.  `npm run test:versecommodities`
 *
 * 🔑 A HAND-BUILT TABLE, NOT THE SHIPPED ONE, and that is the point of this file rather than a
 * shortcut in it. The rules under test are about SHAPES the real data holds in proportions nobody
 * controls — a commodity that is only sold to you, a row that is both a buy and a sell at the same
 * terminal, a quote with no timestamp. Pinning them to whatever UEX reported today would make
 * every assertion here depend on the weather. Each fixture below exists because a specific rule
 * would otherwise be untestable, and the real-world count that makes it worth having is named.
 *
 * The end-to-end wiring — that a commodity really reaches the widget through the route — is
 * `verse-routes.test.ts` and the `verse finder: ships, commodities...` widget suite. This file is
 * only about the adapter's rules.
 */
import { searchCommodities, sellOnlyMatches } from "./verse-commodities.js";
import type { TradeQuote, TradeTable } from "./trade-prices.js";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, detail = "") => {
  if (c) { pass++; console.log(`ok    ${name}${detail ? "  [" + detail + "]" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`); }
};

const HOUR = 3600;
const NOW = Math.floor(Date.now() / 1000);

function q(p: Partial<TradeQuote> & { commodity: string; terminal: string }): TradeQuote {
  return {
    commodity: p.commodity,
    terminal: p.terminal,
    terminalShort: p.terminalShort ?? p.terminal,
    system: p.system ?? "Stanton",
    body: p.body ?? "ArcCorp",
    place: p.place ?? p.terminal,
    buy: p.buy ?? null,
    sell: p.sell ?? null,
    stockScu: p.stockScu ?? null,
    demandScu: p.demandScu ?? null,
    maxContainerScu: p.maxContainerScu ?? null,
    // 🔴 `"asOf" in p`, NOT `p.asOf ?? default` — and this cost a real assertion before it was
    // spotted. `??` falls through on null, so a fixture deliberately written `asOf: null` to
    // exercise the undated-quote rule silently got a fresh timestamp and the test reported the
    // code failing to drop it. The fixture was wrong, not the code. It is the same `??`-over-a-
    // null trap that once deleted four fifths of the trade route table, arriving through a test
    // helper this time — which is the more dangerous door, because a broken fixture accuses
    // working code.
    asOf: "asOf" in p ? (p.asOf as number | null) : NOW - HOUR,
  };
}

function table(quotes: TradeQuote[]): TradeTable {
  return { quotes, source: "cache", fetchedAt: Date.now(), version: null, droppedOffline: 0, lastError: null };
}

/* ── The fixture ───────────────────────────────────────────────────────────────────────────── */

const T = table([
  // Bought AND sold at one terminal. 🔴 This is the row that broke the first draft: the buy and
  // sell branches were written as if/else, which silently discarded the buy side of every terminal
  // that also buys the commodity back — most of the interesting ones.
  q({ commodity: "Laranite", terminal: "Admin - ARC-L1", buy: 7400, sell: 8100, stockScu: 592 }),
  q({ commodity: "Laranite", terminal: "ArcCorp Mining Area 056", buy: 7047, stockScu: 330 }),
  q({ commodity: "Laranite", terminal: "TDD - Area 18", sell: 8500, demandScu: 1289 }),
  // Sell-only. 36 of 122 commodities really are this, so it is not an edge case — it is where a
  // third of the commodity catalogue lands.
  q({ commodity: "Borase", terminal: "TDD - Area 18", sell: 32000, demandScu: 900 }),
  q({ commodity: "Borase", terminal: "Admin - HUR-L1", sell: 31000 }),
  // A buy quote with no timestamp. The BUNDLED commodity snapshot carries none at all, and a row
  // whose age cannot be stated must not sit beside ones whose age can — the age chip would read as
  // "fresh" for the one row that is unknowable.
  q({ commodity: "Titanium", terminal: "Baijini Point", buy: 400, asOf: null }),
  q({ commodity: "Titanium", terminal: "Port Olisar", buy: 380, stockScu: 100 }),
  // A zero is "we know there is none", never a price. Same trap as the `??`-over-a-sparse-zero bug
  // that once deleted four fifths of the trade route table.
  q({ commodity: "Quartz", terminal: "Levski", buy: 0, sell: 0 }),
]);

/* ── 1. A commodity is findable, and carries what only a commodity can ─────────────────────── */

console.log("\na commodity is a search hit like any other row");
{
  const hits = searchCommodities(T, "laranite");
  ok(hits.length === 1, "the query finds exactly the one commodity", `${hits.length}`);
  const h = hits[0];
  ok(!!h && h.kind === "commodity", "...marked as a commodity, so the widget can treat it as one", h?.kind);
  ok(!!h && h.category === "Commodity",
     "...with a category that rides the name, exactly as an item's does", h?.category);
  // Positive before negative: with zero quotes every claim about them is free.
  ok(h.quotes.length === 2, "🔴 both BUY terminals are returned", `${h.quotes.length}`);
  ok(h.quotes.every((x) => x.price > 0), "...every one of them priced");
  ok(h.quotes[0].price === 7047 && h.quotes[1].price === 7400,
     "...cheapest first", h.quotes.map((x) => x.price).join(","));
  ok(h.low === 7047 && h.high === 7400,
     "...and the spread spans them rather than collapsing to one number", `${h.low}-${h.high}`);
  ok(h.rentLow === null && h.rentHigh === null,
     "a commodity never claims a rental price, which is a vehicle-only idea");

  // 🔑 Stock is the one axis where this data beats the item table, so losing it is a real loss.
  const withStock = h.quotes.filter((x) => x.stockScu != null);
  ok(withStock.length === 2, "🔑 stock rides every quote that has it", `${withStock.length} of ${h.quotes.length}`);
  ok(withStock.some((x) => x.stockScu === 330) && withStock.some((x) => x.stockScu === 592),
     "...with the source's own figures, not a rollup",
     withStock.map((x) => x.stockScu).join(","));
}

/* ── 2. The both-buy-and-sell row ──────────────────────────────────────────────────────────── */

console.log("\na terminal that both sells and buys is counted on BOTH sides");
{
  const h = searchCommodities(T, "laranite")[0];
  // 🔴 The whole point: ARC-L1 has buy 7400 AND sell 8100. An if/else would drop one of them, and
  // whichever it dropped would look perfectly reasonable on screen.
  ok(h.quotes.some((x) => x.terminal === "Admin - ARC-L1"),
     "🔴 the buy side of a two-way terminal survives",
     h.quotes.map((x) => x.terminal).join(" | "));
  ok(h.sellPlaces === 2, "...and it is ALSO counted as somewhere you can sell", `${h.sellPlaces}`);
}

/* ── 3. Sell-only: named, never returned as a place to buy ─────────────────────────────────── */

console.log("\nsell-only commodities — the third of the catalogue you cannot buy");
{
  const hits = searchCommodities(T, "borase");
  ok(hits.length === 0, "🔴 a sell-only commodity is NOT offered as somewhere to buy", `${hits.length}`);
  // Paired positive: without this, "not returned" is satisfied by a broken search returning nothing
  // for everything, and the assertion above would pass forever.
  const named = sellOnlyMatches(T, "borase");
  ok(named.length === 1, "🔴 ...but it IS named, so the blank is not mistaken for a typo", `${named.length}`);
  ok(named[0]?.name === "Borase", "...by its real name", named[0]?.name);
  ok(named[0]?.sellPlaces === 2, "...with a COUNT of terminals, which is a fact we hold",
     `${named[0]?.sellPlaces}`);
  // Ranking where it is is a route calculation and belongs to the Trade widget — assert the
  // adapter does not smuggle a price out here.
  ok(!Object.keys(named[0] ?? {}).some((k) => /price|sell[A-Z]|best|profit/.test(k) && k !== "sellPlaces"),
     "...and NO sell price, because ranking where to sell is the Trade widget's job",
     Object.keys(named[0] ?? {}).join(","));

  const buyable = sellOnlyMatches(T, "laranite");
  ok(buyable.length === 0, "a commodity you CAN buy is not listed as sell-only", `${buyable.length}`);
}

/* ── 4. A quote we cannot date is dropped, not rendered ────────────────────────────────────── */

console.log("\nprovenance: a quote with no age has no business on screen");
{
  const h = searchCommodities(T, "titanium")[0];
  ok(!!h, "titanium is found at all", h ? "yes" : "no");
  ok(h.quotes.length === 1, "🔴 the undated quote is dropped", `${h.quotes.length} of 2 source rows`);
  ok(h.quotes[0].price === 380, "...and the one that survives is the dated one", `${h.quotes[0].price}`);
  ok(h.quotes.every((x) => x.asOf > 0), "...so every rendered quote can state its own age");
}

/* ── 5. Zero is not a price ────────────────────────────────────────────────────────────────── */

console.log("\na zero means 'none reported', never 'free'");
{
  ok(searchCommodities(T, "quartz").length === 0,
     "🔴 a commodity whose only row is 0/0 is not offered for sale");
  ok(sellOnlyMatches(T, "quartz").length === 0, "...nor named as sell-only, because it is not");
  // Positive control on the same fixture: prove the query itself CAN find things, or the two
  // assertions above are satisfied by a scorer that matches nothing at all.
  ok(searchCommodities(T, "titanium").length === 1,
     "...while the same search machinery still finds a real one");
}

/* ── 6. Degenerate inputs ──────────────────────────────────────────────────────────────────── */

console.log("\nnothing typed, and nothing to search");
{
  ok(searchCommodities(T, "").length === 0, "an empty query returns nothing, not everything");
  ok(searchCommodities(T, "   ").length === 0, "...nor does whitespace");
  ok(searchCommodities(null, "laranite").length === 0, "no table is not a crash");
  ok(searchCommodities(table([]), "laranite").length === 0, "an empty table is not a crash");
  ok(sellOnlyMatches(null, "borase").length === 0, "...and the same on the sell-only side");
  ok(searchCommodities(T, "zzqqxnothing").length === 0, "a typo finds nothing");
  ok(sellOnlyMatches(T, "zzqqxnothing").length === 0, "...on either side");
}

console.log(`\n${fail ? `FAILED (${fail})` : "all passed"}  ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
