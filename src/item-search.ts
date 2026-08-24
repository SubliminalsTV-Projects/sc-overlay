/**
 * VERSE FINDER - MATCHING WHAT A PLAYER TYPES TO WHAT UEX CALLS THE THING.
 *
 * Pure functions over the shop table, kept out of `item-shops.ts` (which owns provenance) and out
 * of the route file (which owns the wire) because this is the part with real behaviour to test.
 *
 * Three problems, all measured against the live catalogue on 2026-08-20, and each one is why a
 * particular rule below exists rather than the obvious simpler thing.
 *
 * 🔴 1. PUNCTUATION-STRIPPED SUBSTRING MATCHING FALSE-MATCHES ACROSS WORD BOUNDARIES.
 * The normaliser this codebase already uses elsewhere - `lower().replace(/[^a-z0-9]+/g,"")` - is
 * correct for JOINING two known names and actively wrong for free-text search, because it fuses
 * the whole name into one run. Searching `Atlas` then matches *Pulse "GreyCAT LASer" Pistol*:
 * "greycatlaserpistol" genuinely contains "atlas". So nothing here ever flattens a name to a
 * single string. Everything matches against TOKENS, and a substring may only ever be found
 * INSIDE one token, never straddling two.
 *
 * ⚠️ 2. ATTACHMENTS SWAMP EVERY WEAPON SEARCH. `P4-AR` returns *P4-AR Magazine (40 Cap)* before
 * the rifle, and `Gallant` returns *Gallant Rifle Battery* - 170 attachment items carry 4,403
 * price rows, the biggest category by row count in the dataset. The fix is deliberately NOT a
 * category blacklist: magazines are real things players shop for, and a hardcoded demotion would
 * be wrong the moment someone actually wants one. Instead an EXACT or WHOLE-PREFIX match outranks
 * a token match, and ties break on the SHORTER name - which puts "P4-AR" above "P4-AR Magazine
 * (40 Cap)" by construction, for every weapon in the game and any that CIG adds later.
 *
 * ⚠️ 3. SHIP COMPONENTS ARE BARE ONE-WORD NAMES. The quantum drive is `name: "Burst"`, with
 * `ArcCorp` and size `1` in separate fields. A player types "ArcCorp Burst" or just "behring". So
 * the manufacturer is part of the haystack - but a company-only hit scores below a name hit, or
 * typing a manufacturer buries the item you named underneath its 137 stablemates.
 *
 * 🔑 THE INITIALS RULE IS BORROWED FROM THE MISSION LOOKUP, WHERE IT WAS MEASURED. That feature
 * found a plain subsequence match ("are the letters present in order") filled six of eight slots
 * with noise, while word INITIALS are what people actually type - `dsh` -> "Deep space hit". Same
 * rule here, same reason.
 */
import type { ItemShopTable, ShopItem, ShopTerminal, ItemQuote } from "./item-shops.js";

/** Split a name into the words a person would say. Digits and letters part company on purpose:
 *  "P4-AR" becomes ["p4","ar"] so typing `P4` or `AR` both reach it, and "FR-76" becomes
 *  ["fr","76"]. Anything non-alphanumeric is a boundary, which is exactly what stops a match from
 *  straddling two words. */
export function tokenize(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/** Score tiers. Spread widely so a lower tier can never out-total a higher one via tie-breaks. */
const EXACT = 10_000;
const NAME_PREFIX = 8_000;
const TOKENS_IN_ORDER = 6_000;
const TOKENS_ANY_ORDER = 4_500;
const INITIALS = 3_000;
const TOKEN_SUBSTRING = 2_000;
/** Query tokens split across the manufacturer AND the name - "anvil hawk" for Hawk by Anvil.
 *  This is how a player types a ship: maker first, model second, and neither half is a hit on
 *  its own. Below every name-only tier because part of what they typed is not this item's name,
 *  and above COMPANY_ONLY because they did name the item and not merely its maker. */
const MAKER_AND_NAME = 1_500;
/** A hit that only involves the manufacturer. Below every name tier on purpose - see trap 3. */
const COMPANY_ONLY = 1_000;

/** Does every query token prefix-match a distinct name token, left to right in order? */
function tokensInOrder(qt: string[], nt: string[]): boolean {
  let i = 0;
  for (const q of qt) {
    let found = -1;
    for (let j = i; j < nt.length; j++) {
      if (nt[j].startsWith(q)) { found = j; break; }
    }
    if (found < 0) return false;
    i = found + 1;
  }
  return true;
}

/** Does every query token prefix-match some name token, ignoring order and allowing reuse? */
function tokensAnyOrder(qt: string[], nt: string[]): boolean {
  return qt.every((q) => nt.some((n) => n.startsWith(q)));
}

/** Does every query token appear INSIDE some single name token? The weakest name tier, and the
 *  one that must never be allowed to span a word boundary - which it cannot, because it only ever
 *  looks within one token. */
function tokensSubstring(qt: string[], nt: string[]): boolean {
  return qt.every((q) => nt.some((n) => n.includes(q)));
}

/** First letters of the name's words, e.g. "Omnisky III Cannon" -> "oic". */
function initialsOf(nt: string[]): string {
  return nt.map((t) => t[0]).join("");
}

/**
 * Score one item against a tokenized query. Returns 0 for no match.
 *
 * 🔑 The tiers are tried best-first and the FIRST one that holds wins - a lower tier is not added
 * on top. Two items that match at the same tier are then separated by name length (shorter is a
 * closer answer to the same query) and finally alphabetically, so ordering is total and stable.
 */
export function scoreItem(item: ShopItem, qTokens: string[], qJoined: string): number {
  if (!qTokens.length) return 0;
  const nameTokens = tokenize(item.n);
  if (!nameTokens.length) return 0;

  // Exact: the query IS the name, word for word.
  if (nameTokens.length === qTokens.length && nameTokens.every((t, i) => t === qTokens[i])) return EXACT;

  // The name begins with what was typed, as whole words plus an optional partial last word.
  if (tokensInOrder(qTokens, nameTokens) && nameTokens[0].startsWith(qTokens[0])) {
    // Distinguish "starts with" from "contains in order" - the former is a much better answer.
    const leading = qTokens.every((q, i) => nameTokens[i]?.startsWith(q));
    if (leading) return NAME_PREFIX;
    return TOKENS_IN_ORDER;
  }
  if (tokensInOrder(qTokens, nameTokens)) return TOKENS_IN_ORDER;
  if (tokensAnyOrder(qTokens, nameTokens)) return TOKENS_ANY_ORDER;

  // Initials, single-word queries only: "oic" -> "Omnisky III Cannon". Two characters minimum,
  // because a single letter would match a third of the catalogue and mean nothing.
  if (qTokens.length === 1 && qJoined.length >= 2 && nameTokens.length >= 2) {
    if (initialsOf(nameTokens).startsWith(qJoined)) return INITIALS;
  }

  if (tokensSubstring(qTokens, nameTokens)) return TOKEN_SUBSTRING;

  // Manufacturer, last. Matching here alone means the player named a company, not this item.
  if (item.co) {
    const coTokens = tokenize(item.co);
    if (coTokens.length && (tokensAnyOrder(qTokens, coTokens) || tokensSubstring(qTokens, coTokens))) {
      return COMPANY_ONLY;
    }
    // "anvil hawk": one token is the maker, the rest are the name, and neither half matches on
    // its own. Scored against the UNION so this cannot fire unless every token is accounted for.
    if (tokensAnyOrder(qTokens, [...nameTokens, ...coTokens])) return MAKER_AND_NAME;
  }
  return 0;
}

/** One shop, resolved for display. Everything the honesty rules demand travels with it: which
 *  terminal, where, what it charges there, and how old that reading is. */
export interface ResolvedQuote {
  terminal: string;
  system: string | null;
  body: string | null;
  place: string | null;
  price: number;
  /** Epoch seconds. The caller renders an age from it; it is never omitted. */
  asOf: number;
  /** 🔴 A RENTAL, not a purchase. Absent on every shop item and on every commodity - only a vehicle
   *  dealer's rental rows carry it. The widget MUST label these: 344 of the 632 dealer rows are
   *  rentals, and an unlabelled one says a 100i costs 28,665 aUEC. */
  kind?: "rent";
  /** SCU on the shelf, commodities only. 🔑 Items have no stock field anywhere in the source (see
   *  `item-shops.ts`), so this is the one axis where the commodity data is genuinely richer and it
   *  would be a real loss to hide it for the sake of making the two row types look the same. */
  stockScu?: number | null;
}

/**
 * A price the player THEMSELVES paid, read out of `game.log`.
 *
 * 🔴 A SEPARATE ARRAY FROM `quotes`, NEVER CONCATENATED INTO IT — the same separation the site
 * keeps between a confirmed event reward and an unconfirmed candidate, and for the same reason.
 * A UEX quote is a survey answer somebody typed in; this is a receipt. They are different KINDS of
 * claim, and the one edit that would undo this whole feature is somebody merging the two arrays so
 * an observation sorts into the cheapest-first list as though a stranger had reported it.
 *
 * They also cannot be reconciled even in principle today: the game names a terminal
 * `SCShop_Orison_KelTo` and UEX names it "Kel-To - Aspire Grand - New Babbage", and **0 of 47 log
 * shop names match a terminal name in the shipped table**. Until that join is measured an
 * observation can sit beside the survey rows but must never claim to be one of them.
 */
export interface ObservedQuote {
  /** The game's own shop token. Not a display name — the widget says so. */
  terminal: string;
  /** aUEC for ONE. Items: `client_price / quantity`. Commodities: per SCU. */
  price: number;
  /** Epoch SECONDS, matching `ResolvedQuote.asOf` so the widget's existing age helpers work
   *  unchanged. Off the LOG LINE, not the moment of parsing. */
  asOf: number;
  /** How many were bought, so "7 aUEC" can show its working when the receipt was for 11. */
  quantity: number;
  /** 🔴 A commodity has a buy price AND a sell price at one terminal and they are not
   *  interchangeable. Absent on every item (no item sell verb exists in 533 logs). */
  side?: "sell";
}

export interface SearchHit {
  name: string;
  company: string | null;
  category: string;
  section: string;
  size: string | null;
  uuid: string | null;
  /** 🔴 What the player actually paid here, newest first, at most one row per shop. Absent when
   *  they have never bought this — which is the common case and must read as "no receipt", never
   *  as "free" or as a missing price. See `ObservedQuote`. */
  observed?: ObservedQuote[];
  /** What kind of row this is. Absent for a shop item or a vehicle, which are the same thing as far
   *  as this widget is concerned (Sub's ruling). `"commodity"` marks a row that came from the trade
   *  table instead, which is the only row type that can carry stock. */
  kind?: "commodity";
  /** How many shops sell it. Stated separately because the wire truncates `quotes`. */
  shopCount: number;
  /** Cheapest first. */
  quotes: ResolvedQuote[];
  /** The cheapest and dearest PURCHASE price across ALL shops, not just the returned ones.
   *  🔴 Present even when they are equal, because "the price" does not exist - 68% of multi-shop
   *  items vary by shop, and a single number would be wrong for most of the catalogue.
   *  🔴 Null when nothing here is for sale outright, which is why it is nullable at all: a spread
   *  computed across purchases AND rentals would run from a 28,665 aUEC hire to a 1,089,270 aUEC
   *  sale and be a true statement about nothing. */
  low: number | null;
  high: number | null;
  /** The same, over RENTAL quotes. Null whenever nothing here can be rented - which is everything
   *  except 49 vehicles. A separate pair rather than a flag on `low` because they are prices for
   *  two different transactions and the widget has to be able to print both. */
  rentLow: number | null;
  rentHigh: number | null;
  /** Terminals that will BUY this commodity from the player. Commodities only, and a count only -
   *  where to sell it for the most is a route calculation and belongs to the Trade widget. */
  sellPlaces?: number;
  score: number;
}

function resolve(q: ItemQuote, terminals: ShopTerminal[]): ResolvedQuote | null {
  const t = terminals[q.t];
  if (!t) return null;
  const out: ResolvedQuote = { terminal: t.n, system: t.sys, body: t.body, place: t.place, price: q.p, asOf: q.m };
  if (q.k === "rent") out.kind = "rent";
  return out;
}

export interface SearchOptions {
  /** Max items to return. */
  limit?: number;
  /** Max shops per item on the wire. The full count still travels as `shopCount`, so a truncation
   *  can never read as "this is everywhere it is sold". */
  quotesPerItem?: number;
  /**
   * Reorder an item's shops AND apply the cap.
   *
   * 🔴 THE HOOK IS HERE, AND NOT AT THE CALL SITE, PRECISELY BECAUSE OF THE TRUNCATION. Quotes
   * arrive cheapest-first and only `quotesPerItem` of them survive onto the wire, so a caller
   * sorting the RETURNED array would be sorting the eight cheapest — "the nearest of the cheapest"
   * is not "the nearest", and it is wrong exactly when it matters most: the median item has 4
   * shops, but the p90 has 19 and the maximum 159.
   *
   * 🔴 AND IT OWNS THE CAP, WHICH IS WHY `cap` IS PASSED IN. It used to return a full ordered list
   * that this function then sliced — and that slice is what deleted the far-system rows
   * `reserveTierRows` exists to rescue, because they sit at the end by construction. An orderer
   * that knows about tiers cannot honour them if something downstream re-slices its answer. So the
   * hook returns the FINAL list and this function does not touch it.
   *
   * Receives every resolvable shop; returns the ones to send, in order. Absent, the cheapest-first
   * order stands and the cap is a plain slice.
   */
  orderQuotes?: (quotes: ResolvedQuote[], cap: number) => ResolvedQuote[];
}

/**
 * Rank the whole table against a query.
 *
 * 🔑 Returns an empty array for an empty query rather than the whole catalogue - "everything" is
 * not an answer to "where can I buy", and 2,791 items would be a denial of service on the widget.
 */
export function searchItems(table: ItemShopTable, query: string, opts: SearchOptions = {}): SearchHit[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const perItem = Math.max(1, Math.min(opts.quotesPerItem ?? 8, 50));
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const qJoined = qTokens.join("");

  const scored: { item: ShopItem; score: number }[] = [];
  for (const item of table.items) {
    const score = scoreItem(item, qTokens, qJoined);
    if (score > 0) scored.push({ item, score });
  }

  scored.sort((a, b) =>
    b.score - a.score ||
    a.item.n.length - b.item.n.length ||
    a.item.n.localeCompare(b.item.n));

  const out: SearchHit[] = [];
  for (const { item, score } of scored.slice(0, limit)) {
    const quotes = item.q.map((q) => resolve(q, table.terminals)).filter((q): q is ResolvedQuote => !!q);
    if (!quotes.length) continue;
    // 🔴 TWO SPREADS, NEVER ONE. A rental and a purchase are prices for different transactions, so
    // a single min/max over both would run from the cheapest hire to the dearest sale and describe
    // no transaction anyone can make.
    const span = (rows: ResolvedQuote[]): [number, number] | [null, null] => {
      if (!rows.length) return [null, null];
      let lo = rows[0].price, hi = rows[0].price;
      for (const q of rows) { if (q.price < lo) lo = q.price; if (q.price > hi) hi = q.price; }
      return [lo, hi];
    };
    const [low, high] = span(quotes.filter((q) => q.kind !== "rent"));
    const [rentLow, rentHigh] = span(quotes.filter((q) => q.kind === "rent"));
    out.push({
      name: item.n,
      company: item.co,
      category: item.c,
      section: item.s,
      size: item.z,
      uuid: item.u,
      shopCount: quotes.length,
      // 🔴 The hook orders AND caps — do not re-slice its answer. See `orderQuotes`: the rows it
      // deliberately keeps past the cap are the far-system ones, and they are last by construction,
      // so a slice here is exactly the exclusion Sub reported.
      quotes: opts.orderQuotes ? opts.orderQuotes(quotes, perItem) : quotes.slice(0, perItem),
      low,
      high,
      rentLow,
      rentHigh,
      score,
    });
  }
  return out;
}

/** A catalogued item that no shop is reported to sell, matched against the query. */
export interface UnpricedHit {
  name: string;
  category: string;
  score: number;
}

/**
 * The items UEX knows about that nobody has priced, ranked against the same query.
 *
 * 🔴 THIS IS THE WHOLE OF FIX #3, AND IT NEEDED NO NEW DATA - only for the answer to stop being
 * thrown away. Two thirds of the catalogue (4,962 of 7,753) has no shop, so "we found nothing" was
 * overwhelmingly the WRONG reading of a blank result: the common truth is "this exists and nobody
 * has reported where to buy it", which is a completely different thing to tell a player than "no
 * such item". Armor›Full Set is where it bites hardest - 112 real armour sets, every one of them
 * something a person will type by name and, until now, be told nothing about.
 *
 * 🔑 Scored with `scoreItem` like everything else, through a synthetic `ShopItem`, so a name that
 * would have ranked first had it been priced still ranks first here. A second, looser matcher would
 * have made the hint fire on things the main search would not have found, which reads as the widget
 * disagreeing with itself.
 */
export function searchUnpriced(table: ItemShopTable, query: string, limit = 6): UnpricedHit[] {
  if (!table.unpriced?.length) return [];
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const qJoined = qTokens.join("");
  const hits: UnpricedHit[] = [];
  for (const u of table.unpriced) {
    const score = scoreItem({ n: u.n, co: null, c: u.c, s: "", z: null, u: null, q: [] }, qTokens, qJoined);
    if (score > 0) hits.push({ name: u.n, category: u.c, score });
  }
  hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return hits.slice(0, Math.max(1, limit));
}

/** Provenance every response carries, whatever it is about.
 *
 *  🔑 `source` and the table's age ride on EVERY response, not just the ones about prices - Sub's
 *  requirement is that the user knows when they are on a fallback, and a widget can only say so on
 *  the screen the user is actually looking at. */
export function provenance(table: ItemShopTable) {
  return {
    source: table.source,
    fetchedAt: table.fetchedAt,
    itemCount: table.items.length,
    terminalCount: table.terminals.length,
    droppedOffline: table.droppedOffline,
    catalogueOnly: table.catalogueOnly,
    lastError: table.lastError,
    /** 🔴 Stated as a capability flag rather than left for the UI to remember. There is no stock
     *  field in the ITEM source at all, so no client may render a shelf count on an item row.
     *  ⚠️ Commodity rows are the exception and carry `stockScu` per quote — the flag is about this
     *  table, not about every row the widget can draw, and the two must not be conflated. */
    hasStock: false,
    /** 🔴 Whether the table can NAME the items nobody sells, as opposed to only counting them.
     *  False on a schema-1 payload or an old bundle, and the UI must then fall back to the vaguer
     *  wording rather than claiming an item does not exist — an empty `unpriced` means "we cannot
     *  say", never "we checked and it is not there". */
    knowsUnpriced: table.unpriced.length > 0,
  };
}
