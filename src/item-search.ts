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
}

export interface SearchHit {
  name: string;
  company: string | null;
  category: string;
  section: string;
  size: string | null;
  uuid: string | null;
  /** How many shops sell it. Stated separately because the wire truncates `quotes`. */
  shopCount: number;
  /** Cheapest first. */
  quotes: ResolvedQuote[];
  /** The cheapest and dearest price across ALL shops, not just the returned ones.
   *  🔴 Present even when they are equal, because "the price" does not exist - 68% of multi-shop
   *  items vary by shop, and a single number would be wrong for most of the catalogue. */
  low: number;
  high: number;
  score: number;
}

function resolve(q: ItemQuote, terminals: ShopTerminal[]): ResolvedQuote | null {
  const t = terminals[q.t];
  if (!t) return null;
  return { terminal: t.n, system: t.sys, body: t.body, place: t.place, price: q.p, asOf: q.m };
}

export interface SearchOptions {
  /** Max items to return. */
  limit?: number;
  /** Max shops per item on the wire. The full count still travels as `shopCount`, so a truncation
   *  can never read as "this is everywhere it is sold". */
  quotesPerItem?: number;
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
    let low = quotes[0].price, high = quotes[0].price;
    for (const q of quotes) { if (q.price < low) low = q.price; if (q.price > high) high = q.price; }
    out.push({
      name: item.n,
      company: item.co,
      category: item.c,
      section: item.s,
      size: item.z,
      uuid: item.u,
      shopCount: quotes.length,
      quotes: quotes.slice(0, perItem),
      low,
      high,
      score,
    });
  }
  return out;
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
     *  field in the source at all, so no client may ever render a shelf count. */
    hasStock: false,
  };
}
