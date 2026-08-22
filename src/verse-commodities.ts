/**
 * VERSE FINDER - COMMODITIES, ADAPTED INTO SEARCH HITS.
 *
 * 🔴 THE DATA WAS ALREADY ON THE PLAYER'S MACHINE AND THE WIDGET REFUSED TO LOOK AT IT.
 * `trade-prices.ts` has been keeping `%APPDATA%/sc-blueprint-tracker/trade-prices.json` current for
 * the Trade widget - 2,572 quotes over 122 commodities as measured on Sub's own install - while
 * typing "Laranite" into the Verse Finder produced the same blank as a typo. The exclusion was
 * deliberate and its reasoning was sound (`item-shops.ts` is about shop ITEMS, and a commodity is a
 * genuinely different kind of row); it was simply being applied to the wrong thing. The DATA stays
 * separate. The QUESTION does not: "where is it and what does it cost" is one question and it
 * deserves one box.
 *
 * -- WHY SEARCH THEM HERE RATHER THAN POINT AT THE TRADE WIDGET -----------------------------
 *
 * Both were on the table. Search-here wins on what a player is doing at the moment they type:
 *
 *   · THE TWO WIDGETS ANSWER DIFFERENT QUESTIONS. Trade ranks round TRIPS by profit per hour and
 *     needs to know your ship - it is a planning tool you open before you undock. The Verse Finder
 *     answers a lookup: where is this, what does it cost. A player who is already flying and wants
 *     to know where Laranite is cheap is asking the second question, not the first.
 *   · A POINTER COSTS THE THING THE WIDGET IS FOR. Sub's whole framing is "hit a hotkey, type in
 *     the item". Answering with "open another widget and type it again" spends the hotkey, the
 *     typing and the player's attention to deliver a redirect - over a game, mid-flight.
 *   · IT CANNOT DRIFT. There is one commodity table in the process. Both widgets read it, so they
 *     can never disagree about a price, which is the same reasoning that keeps the dealer join on
 *     the site rather than in the app.
 *
 * 🔑 SELLING IS STILL THE TRADE WIDGET'S JOB, and that boundary is where the honest split falls.
 * This module surfaces BUY quotes only, because the widget's question is where to buy. But 36 of
 * the 122 commodities have no buy quote at all - they are things you sell - and returning nothing
 * for those would rebuild the exact blank this flight is fixing. So `sellOnlyMatches()` names them
 * and the widget says what they are and where the ranking lives. A count of sell terminals is a
 * fact; "sell it here for the most" is a route calculation and belongs to Trade.
 *
 * -- MEASURED ON THE LIVE CACHE, 2026-08-22 --------------------------------------------------
 *
 *   122 commodities · 690 buy rows · 1,882 sell rows · 0 rows with neither.
 *   86 commodities have a buy quote; 113 have a sell quote; 36 are sell-ONLY.
 *   `asOf` is populated on 2,572 of 2,572 rows. Median age 5.7 days.
 *   `stockScu` is known on 680 of the 690 buy rows (98.6%).
 *
 * 🔑 STOCK IS THE ONE THING COMMODITIES HAVE THAT ITEMS DO NOT. `item-shops.ts` says at length that
 * there is no stock field for items at any endpoint, and the widget tells the player so. Here there
 * IS one, on 98.6% of buy rows, and hiding it to keep the two row types looking identical would be
 * throwing away the most decision-shaped number on the screen: a price you cannot buy any of is not
 * a price. So a commodity row carries it and an item row does not, and that difference is real.
 */
import type { TradeQuote, TradeTable } from "./trade-prices.js";
import type { ResolvedQuote, SearchHit } from "./item-search.js";
import { scoreItem, tokenize } from "./item-search.js";
import type { ShopItem } from "./item-shops.js";

/** What the widget shows as the category of a commodity row. It rides the name, exactly as an
 *  item's category does, so "Laranite – Commodity" reads the same way as "Burst – Quantum Drives"
 *  and no separate visual treatment is needed to tell a player what they are looking at. */
const COMMODITY_CATEGORY = "Commodity";
const COMMODITY_SECTION = "Commodities";

/** Score a commodity with the SAME function items are scored with.
 *
 *  🔑 Not a second scorer. Every trap `item-search.ts` documents - the punctuation-stripping
 *  false-match, exact-beats-prefix-beats-token, the initials band - applies to a commodity name
 *  just as much, and a copy here would be free to drift from the one that was measured. The
 *  adapter is a synthetic `ShopItem`, which is cheap and keeps one implementation. */
function asShopItem(name: string): ShopItem {
  return { n: name, co: null, c: COMMODITY_CATEGORY, s: COMMODITY_SECTION, z: null, u: null, q: [] };
}

interface Grouped {
  name: string;
  buys: TradeQuote[];
  sellPlaces: number;
}

/** Fold the flat quote list into one entry per commodity. */
function groupByCommodity(quotes: TradeQuote[]): Map<string, Grouped> {
  const by = new Map<string, Grouped>();
  for (const q of quotes) {
    const name = (q.commodity || "").trim();
    if (!name) continue;
    let g = by.get(name);
    if (!g) { g = { name, buys: [], sellPlaces: 0 }; by.set(name, g); }
    // 🔴 A row can carry BOTH a buy and a sell price at the same terminal, so these are not
    // exclusive branches. Writing them as if/else would silently drop the buy side of every
    // terminal that also buys the commodity back - which is most of the interesting ones.
    if (typeof q.buy === "number" && q.buy > 0) g.buys.push(q);
    if (typeof q.sell === "number" && q.sell > 0) g.sellPlaces++;
  }
  return by;
}

function toResolved(q: TradeQuote): ResolvedQuote | null {
  // ⚠️ `asOf` is not optional here even though the TYPE allows null: the bundled commodity snapshot
  // carries no timestamps at all, and a quote whose age cannot be stated must not be rendered
  // beside ones whose age can - the age colour would read as "fresh" for the one row that is
  // unknowable. Dropping it is the same call `normalise()` makes for an unrenderable item quote.
  if (typeof q.asOf !== "number" || q.asOf <= 0) return null;
  if (typeof q.buy !== "number" || q.buy <= 0) return null;
  return {
    terminal: q.terminal,
    system: q.system,
    body: q.body,
    place: q.place,
    price: q.buy,
    asOf: q.asOf,
    stockScu: typeof q.stockScu === "number" && q.stockScu >= 0 ? q.stockScu : null,
  };
}

export interface CommoditySearchOptions {
  limit?: number;
  quotesPerItem?: number;
  /** Same hook, same reason, as `searchItems`: order BEFORE the truncation, or you are ordering the
   *  cheapest few rather than all of them. */
  orderQuotes?: (quotes: ResolvedQuote[]) => ResolvedQuote[];
}

/**
 * Commodities you can BUY somewhere, ranked against the query.
 *
 * Returns `SearchHit`s so the route can merge them with item hits and sort one list by score -
 * a commodity and an item compete on the same scale rather than being two stapled-together
 * sections, which is what makes one search box honest.
 */
export function searchCommodities(
  table: TradeTable | null | undefined,
  query: string,
  opts: CommoditySearchOptions = {},
): SearchHit[] {
  if (!table || !Array.isArray(table.quotes) || !table.quotes.length) return [];
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const qJoined = qTokens.join("");
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const perItem = Math.max(1, Math.min(opts.quotesPerItem ?? 8, 50));

  const scored: { g: Grouped; score: number }[] = [];
  for (const g of groupByCommodity(table.quotes).values()) {
    if (!g.buys.length) continue; // sell-only — `sellOnlyMatches` answers for these instead
    const score = scoreItem(asShopItem(g.name), qTokens, qJoined);
    if (score > 0) scored.push({ g, score });
  }
  scored.sort((a, b) =>
    b.score - a.score ||
    a.g.name.length - b.g.name.length ||
    a.g.name.localeCompare(b.g.name));

  const out: SearchHit[] = [];
  for (const { g, score } of scored.slice(0, limit)) {
    const quotes = g.buys.map(toResolved).filter((q): q is ResolvedQuote => !!q);
    if (!quotes.length) continue;
    quotes.sort((a, b) => a.price - b.price || b.asOf - a.asOf);
    let low = quotes[0].price, high = quotes[0].price;
    for (const q of quotes) { if (q.price < low) low = q.price; if (q.price > high) high = q.price; }
    out.push({
      name: g.name,
      company: null,
      category: COMMODITY_CATEGORY,
      section: COMMODITY_SECTION,
      size: null,
      uuid: null,
      kind: "commodity",
      shopCount: quotes.length,
      quotes: (opts.orderQuotes ? opts.orderQuotes(quotes) : quotes).slice(0, perItem),
      low,
      high,
      rentLow: null,
      rentHigh: null,
      sellPlaces: g.sellPlaces,
      score,
    });
  }
  return out;
}

/** A commodity you can only SELL — named, so the widget can say what it is instead of a blank.
 *  `sellPlaces` is a count of terminals and nothing more; where to sell it for the most is a route
 *  calculation and stays in the Trade widget. */
export interface SellOnlyMatch {
  name: string;
  sellPlaces: number;
  score: number;
}

/** Commodities matching the query that no terminal is reported to SELL to a player. 36 of 122
 *  today, so this is not an edge case — it is nearly a third of the commodity catalogue. */
export function sellOnlyMatches(
  table: TradeTable | null | undefined,
  query: string,
  limit = 5,
): SellOnlyMatch[] {
  if (!table || !Array.isArray(table.quotes) || !table.quotes.length) return [];
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const qJoined = qTokens.join("");
  const out: SellOnlyMatch[] = [];
  for (const g of groupByCommodity(table.quotes).values()) {
    if (g.buys.length || !g.sellPlaces) continue;
    const score = scoreItem(asShopItem(g.name), qTokens, qJoined);
    if (score > 0) out.push({ name: g.name, sellPlaces: g.sellPlaces, score });
  }
  out.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return out.slice(0, Math.max(1, limit));
}
