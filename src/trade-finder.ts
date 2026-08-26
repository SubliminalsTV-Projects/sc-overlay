/**
 * TRADE - TURNING A TABLE OF QUOTES INTO SOMETHING WORTH FLYING.
 *
 * Three questions, one engine, because they are the same question with different filters bolted
 * on (Sub asked for all three, 2026-08-19):
 *
 *   1. LOOKUP     "where can I buy Titanium, and where does it sell?"   -> `lookupCommodity`
 *   2. ROUTES     "I fly a Hull A out of Stanton, what should I carry?" -> `findRoutes`
 *   3. BACKHAUL   "I am already going to Pyro, what can I take?"        -> `findRoutes` with
 *                                                                          `toBody`/`toSystem` set
 *
 * 🔴 THE HONESTY RULES, WHICH ARE THE POINT OF THIS FILE AND NOT DECORATION ON IT.
 *
 * A. NEVER PRESENT ONE NUMBER AS "THE PRICE". A commodity has as many prices as it has terminals
 *    and they move. `lookupCommodity` therefore returns a RANGE with the terminal count behind it,
 *    never a mean standing alone. A specific ROUTE does have one buy and one sell number - but
 *    each is one crowd report of a given age, so it travels with that age attached.
 *
 * B. A ROUTE IS ONLY AS FRESH AS ITS STALEST HALF. `ageDays` is the OLDER of the two quotes. A
 *    day-old buy price paired with a three-week-old sell price is a three-week-old route, and
 *    averaging the two would hide exactly the half that is wrong.
 *
 * C. UNKNOWN IS NOT ZERO, AND IT IS NOT A LICENCE TO GUESS EITHER. When stock is unreported the
 *    finder still ranks the route - dropping it would throw away most of the bundled table - but
 *    it marks `scuBound: "unknown"` so the widget can say "stock not reported" instead of drawing
 *    a confident hold-filling number. `profit` on such a route is a CEILING, not an estimate.
 *
 * D. THE BOUND THAT BIT IS NAMED. "You can move 96 SCU" is not actionable; "the seller only has
 *    96 SCU on the shelf" is. `scuBound` says which of hold / stock / demand was the binding
 *    constraint, because that is what the player would change.
 *
 * 🔑 TRAVEL COST IS TIERED, NOT DISTANCE-BASED - and the reasoning is `hauling-route.ts`'s, hard
 * won: at quantum speeds a 239 km hop prices at 0.02 minutes, so a distance model rated a
 * five-stop run at ~5 minutes against a measured floor near 25 and systematically over-rated
 * spread-out work. The cost is dominated by getting up and down a gravity well.
 *
 * ⚠️ The same-body and cross-body figures below are COPIED from `hauling-route.ts`, where they
 * were measured off Sub's own logs. They are duplicated rather than imported because that module
 * keeps them private and reaching into it is not this flight's lane; if they are ever retuned,
 * both places must move. The CROSS-SYSTEM figure is NOT measured - see its own note.
 */
import type { TradeQuote, TradeSource } from "./trade-prices.js";

/* 🔑 IMPORTED NOW, NOT COPIED. The header above still describes the old arrangement and the
 * comment that used to sit here admitted it: "duplicated rather than imported because that module
 * keeps them private... if they are ever retuned, both places must move." They have now been
 * retuned, and a third consumer (the Verse Finder) wants them, so they live in `travel-model.ts`
 * and there is exactly one copy. */
import {
  LEG_SAME_BODY_MINUTES, LEG_CROSS_BODY_MINUTES, JUMP_MINUTES,
} from "./travel-model.js";

/**
 * ⚠️ STILL A FLAT FALLBACK, but no longer an invented one — and it is now the LAST resort rather
 * than the only answer.
 *
 * The old value was 25 minutes with a note saying it was not measured. It is now built from the
 * parts that were: the jump Sub settled at ~4 minutes, plus a cross-body leg at each end for
 * "get out to the gateway" and "cross the far system". That is the same decomposition
 * `travelMinutes()` performs properly when it has coordinates for both ends; this is what to
 * charge when it does not.
 *
 * 🔑 Prefer `travelMinutes()` wherever both places are placed — it routes through the real gateway
 * graph and knows that Stanton to Nyx is TWO jumps, which no flat number can express.
 */
const LEG_CROSS_SYSTEM_MINUTES = JUMP_MINUTES + LEG_CROSS_BODY_MINUTES * 2;
/** Landing, elevator, buying or selling, leaving. `hauling-route.ts`'s figure. */
const STOP_MINUTES = 4;

/** One end of a route. */
export interface TradeEnd {
  terminal: string;
  terminalShort: string;
  place: string | null;
  body: string | null;
  system: string | null;
  price: number;
  /** SCU available to buy (buy end) or that the terminal will take (sell end). Null = unreported. */
  scu: number | null;
  maxContainerScu: number | null;
  /** Epoch seconds this quote was reported. Null for bundled quotes. */
  asOf: number | null;
}

export type ScuBound = "hold" | "stock" | "demand" | "unknown";

export interface TradeRoute {
  commodity: string;
  from: TradeEnd;
  to: TradeEnd;
  /** aUEC per SCU. The one figure that is always real. */
  marginPerScu: number;
  /** Percentage return on the capital tied up, per run. */
  marginPct: number;
  /** SCU this run can actually move, once hold, stock and demand are all considered. */
  moveScu: number;
  /** Which constraint bit. 🔑 "unknown" means stock/demand were unreported and `moveScu` is a
   *  CEILING derived from the hold alone - the widget must not draw it as a certainty. */
  scuBound: ScuBound;
  /** aUEC needed up front to fill `moveScu`. */
  capitalRequired: number;
  /** aUEC cleared on the run. Inherits the certainty of `scuBound`. */
  profit: number;
  /** Estimated round-leg minutes: buy stop + travel + sell stop. */
  minutes: number;
  profitPerHour: number;
  crossSystem: boolean;
  /** The OLDER of the two quotes, in days. Null when neither end carries a timestamp (bundled). */
  ageDays: number | null;
}

export interface FindRoutesOptions {
  /** Ship hold in SCU. Required - a route you cannot fill is a different route. */
  capacityScu: number;
  /** Cash on hand. Routes needing more are still returned but SCU-capped to what it buys. */
  budget?: number | null;
  /** Only routes starting in this system. */
  fromSystem?: string | null;
  /** Only routes starting on this body - "what can I buy without moving?" */
  fromBody?: string | null;
  /** Only routes ENDING here. This is the backhaul filter: you are already going there. */
  toSystem?: string | null;
  toBody?: string | null;
  /**
   * One commodity only.
   *
   * 🔑 EXACT (case-insensitive), for the same reason `lookupCommodity` is: a prefix match answers a
   * question about "Aluminum" with rows for "Aluminum (Ore)", which is a different thing at a
   * different price. The widget picks this off `/api/trade/names`, so it is never a typed guess.
   */
  commodity?: string | null;
  /** Buy at this terminal and nowhere else. Matches the long name OR the short one — every UI
   *  surface in this app shows the short form, so that is what a pick sends back. */
  fromTerminal?: string | null;
  /** Sell at this terminal and nowhere else. Same matching rule. */
  toTerminal?: string | null;
  /** Drop routes whose stock is unreported. Off by default: on the bundled table that would
   *  discard 87% of everything, which reads as "the feature is broken". */
  requireKnownStock?: boolean;
  /** Ignore quotes older than this. Null keeps everything (and the age is still rendered). */
  maxAgeDays?: number | null;
  /** How many to return. */
  limit?: number;
  /**
   * Which question the ranking answers. Defaults to `hour`, which is what this finder has always
   * done.
   *
   * 🔴 IT EXISTS BECAUSE ONE HARDCODED RANKING WAS BURYING THE BEST RUNS, and the cause is a
   * correlation nobody had measured. `moveScu` is capped by the reported stock, profit is
   * `margin x moveScu`, and `profitPerHour` follows — so a row's rank is proportional to a stock
   * figure that is a median 2.4 days old for a quantity that moves in minutes. Measured on the live
   * table: the top quartile by margin has a median shelf of 75 SCU against 738 for the bottom
   * quartile, so the unreliability concentrates precisely on the best deals. Waste at a 291% margin
   * with `stockScu: 1` ranks as one SCU of profit and is invisible.
   *
   * 🔑 THE FIGURES ARE NOT CHANGED — ONLY THE ORDER. Stock still caps `moveScu`, and it must:
   * `capitalRequired` and `profit` have to describe a purchase the player can actually make, and
   * un-capping them would advertise a 696 SCU run at a shelf holding one. What changes is that
   * `margin` and `scu` rank on stock-INDEPENDENT figures, so a scarce row can be found on its
   * merits and the player reads the stock caveat on the row itself.
   *
   * 🔑 `profit` is Sub's own gap: "if I could buy a whole load of a Hull C's cargo hold of bulk
   * stock and make 10% margin, that might be more money" — per-hour normalises exactly that away.
   *
   * ⚠️ The dedupe below runs AFTER this sort and keeps the first row per key, so changing the
   * ranking also changes which destination survives for each buy point. That is correct: the row
   * kept is the best one under the ranking the caller asked for.
   */
  sort?: TradeSort;
  /** Epoch ms, injected so tests are not time-dependent. */
  now?: number;
}

/** `hour` = aUEC per hour (default). `profit` = the whole trip's take. `margin` = percentage.
 *  `scu` = aUEC per SCU carried. The last two are independent of the stock reading. */
export type TradeSort = "hour" | "profit" | "margin" | "scu";

export interface CommodityQuoteSummary {
  /** Terminals quoting this side. */
  terminals: number;
  low: number;
  high: number;
  /** 🔑 Present BESIDE low/high, never instead of them. */
  median: number;
  /** Age of the freshest and stalest quote on this side, in days. Null when untimestamped. */
  freshestDays: number | null;
  stalestDays: number | null;
}

export interface CommodityLookup {
  commodity: string;
  buy: CommodityQuoteSummary | null;
  sell: CommodityQuoteSummary | null;
  /** Every terminal, so the widget can list them. Buy side first, cheapest first. */
  buyAt: TradeEnd[];
  sellAt: TradeEnd[];
  source: TradeSource;
}

const DAY_MS = 86_400_000;

function ageDays(asOf: number | null, now: number): number | null {
  if (!asOf) return null;
  return Math.max(0, (now - asOf * 1000) / DAY_MS);
}

function endOf(q: TradeQuote, side: "buy" | "sell", now: number): TradeEnd {
  return {
    terminal: q.terminal,
    terminalShort: q.terminalShort,
    place: q.place,
    body: q.body,
    system: q.system,
    price: (side === "buy" ? q.buy : q.sell) as number,
    scu: side === "buy" ? q.stockScu : q.demandScu,
    maxContainerScu: q.maxContainerScu,
    asOf: q.asOf,
  };
}

/** Minutes for one buy-stop + hop + sell-stop. */
export function legMinutes(a: TradeEnd, b: TradeEnd): number {
  const travel =
    a.system && b.system && a.system !== b.system ? LEG_CROSS_SYSTEM_MINUTES
    : a.body && b.body && a.body === b.body ? LEG_SAME_BODY_MINUTES
    : LEG_CROSS_BODY_MINUTES;
  return travel + STOP_MINUTES * 2;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

function summarise(ends: TradeEnd[], now: number): CommodityQuoteSummary | null {
  if (!ends.length) return null;
  const prices = ends.map((e) => e.price);
  const ages = ends.map((e) => ageDays(e.asOf, now)).filter((a): a is number => a !== null);
  return {
    terminals: ends.length,
    low: Math.min(...prices),
    high: Math.max(...prices),
    median: median(prices),
    freshestDays: ages.length ? Math.min(...ages) : null,
    stalestDays: ages.length ? Math.max(...ages) : null,
  };
}

/**
 * Every terminal that buys or sells one commodity, as ranges rather than a number.
 *
 * 🔑 Name matching is EXACT (case-insensitive) on purpose. A prefix match here would answer a
 * question about "Aluminum" with rows for "Aluminum (Ore)", which is a different thing that sells
 * at a different price - the same class of mistake `/api/commodity-price` had to be repaired for.
 */
export function lookupCommodity(
  quotes: readonly TradeQuote[],
  name: string,
  source: TradeSource,
  now: number = Date.now(),
): CommodityLookup | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const mine = quotes.filter((q) => q.commodity.toLowerCase() === want);
  if (!mine.length) return null;
  const buyAt = mine.filter((q) => q.buy !== null).map((q) => endOf(q, "buy", now)).sort((a, b) => a.price - b.price);
  const sellAt = mine.filter((q) => q.sell !== null).map((q) => endOf(q, "sell", now)).sort((a, b) => b.price - a.price);
  return {
    commodity: mine[0].commodity,
    buy: summarise(buyAt, now),
    sell: summarise(sellAt, now),
    buyAt,
    sellAt,
    source,
  };
}

/** Every commodity name in the table that can be bought somewhere, for an autocomplete. */
export function tradableNames(quotes: readonly TradeQuote[]): string[] {
  const s = new Set<string>();
  for (const q of quotes) if (q.buy !== null) s.add(q.commodity);
  return [...s].sort((a, b) => a.localeCompare(b));
}

/** Systems that actually have a terminal you can BUY at, so the filter never offers a choice that
 *  can only ever return nothing. Sorted by how many buy terminals each has, biggest first. */
export function buyableSystems(quotes: readonly TradeQuote[]): string[] {
  const n = new Map<string, number>();
  for (const q of quotes) if (q.buy !== null && q.system) n.set(q.system, (n.get(q.system) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

/**
 * Buy somewhere, sell somewhere else, ranked by what the run actually clears.
 *
 * 🔑 RANKED ON PROFIT PER HOUR, not margin per SCU. Margin per SCU is what every trade site shows
 * and it is the wrong headline for this widget: it rates a 132-SCU pile of Bexalite two systems
 * away above a full hold of Aluminum next door, and the second is the better evening. Per-hour
 * folds in the hold, the stock actually on the shelf, and the tiered travel cost together.
 */
export function findRoutes(
  quotes: readonly TradeQuote[],
  opts: FindRoutesOptions,
): TradeRoute[] {
  const now = opts.now ?? Date.now();
  const hold = Math.max(0, opts.capacityScu || 0);
  if (!hold) return [];
  const limit = opts.limit ?? 40;
  const maxAge = opts.maxAgeDays ?? null;

  const fresh = (q: TradeQuote): boolean => {
    if (maxAge === null) return true;
    const a = ageDays(q.asOf, now);
    // An untimestamped quote (bundled) cannot be excluded by an age filter without silently
    // emptying the whole bundled table. It is kept, and its null age is rendered as unknown.
    return a === null || a <= maxAge;
  };

  // 🔑 CASE-INSENSITIVE, because the two sources spell a system differently and the caller may be
  // passing either. UEX says "Stanton"; the app's own SystemWatcher derives "stanton" from body
  // codes like `stanton2a`. An exact compare silently filters everything out - which looks
  // identical to "there are no routes" and is the worst possible failure for a filter.
  const sameName = (a: string | null, b: string | null | undefined): boolean =>
    !b || (!!a && a.toLowerCase() === b.toLowerCase());

  /** A terminal filter matches EITHER name. The board renders `terminalShort`, so that is what a
   *  pick sends back — but an API caller holding the long form must not get a silent empty list,
   *  which is indistinguishable from "there are no routes". */
  const sameTerminal = (q: TradeQuote, want: string | null | undefined): boolean => {
    if (!want) return true;
    const w = want.trim().toLowerCase();
    return q.terminal.toLowerCase() === w || q.terminalShort.toLowerCase() === w;
  };
  const wantCommodity = opts.commodity ? opts.commodity.trim().toLowerCase() : null;

  const buys = new Map<string, TradeQuote[]>();
  const sells = new Map<string, TradeQuote[]>();
  for (const q of quotes) {
    if (!fresh(q)) continue;
    if (wantCommodity && q.commodity.toLowerCase() !== wantCommodity) continue;
    if (q.buy !== null && sameName(q.system, opts.fromSystem) && sameName(q.body, opts.fromBody)
        && sameTerminal(q, opts.fromTerminal)) {
      const arr = buys.get(q.commodity);
      if (arr) arr.push(q); else buys.set(q.commodity, [q]);
    }
    if (q.sell !== null && sameName(q.system, opts.toSystem) && sameName(q.body, opts.toBody)
        && sameTerminal(q, opts.toTerminal)) {
      const arr = sells.get(q.commodity);
      if (arr) arr.push(q); else sells.set(q.commodity, [q]);
    }
  }

  const out: TradeRoute[] = [];
  for (const [commodity, bs] of buys) {
    const ss = sells.get(commodity);
    if (!ss) continue;
    for (const b of bs) {
      if (opts.requireKnownStock && b.stockScu === null) continue;
      for (const s of ss) {
        if (s.terminal === b.terminal) continue;
        const marginPerScu = (s.sell as number) - (b.buy as number);
        if (marginPerScu <= 0) continue;

        const from = endOf(b, "buy", now);
        const to = endOf(s, "sell", now);

        // -- How much can actually move, and what stopped it -------------------
        // 🔑 Evaluated in the order a player hits them, so the NAMED bound is the one they would
        // act on. Budget is folded into the hold bound: running out of money reads as "you could
        // only fill this much of the hold", which is what it is.
        let moveScu = hold;
        let scuBound: ScuBound = "hold";
        if (opts.budget && opts.budget > 0) {
          const affordable = Math.floor(opts.budget / (b.buy as number));
          if (affordable < moveScu) { moveScu = affordable; scuBound = "hold"; }
        }
        if (b.stockScu !== null && b.stockScu < moveScu) { moveScu = b.stockScu; scuBound = "stock"; }
        if (s.demandScu !== null && s.demandScu < moveScu) { moveScu = s.demandScu; scuBound = "demand"; }
        // 🔴 Only claim a real bound when the numbers behind it were actually reported. With no
        // stock figure the hold is a ceiling we cannot stand behind, and saying so is the whole
        // difference between a recommendation and a guess.
        if (scuBound === "hold" && b.stockScu === null) scuBound = "unknown";
        if (moveScu <= 0) continue;

        const minutes = legMinutes(from, to);
        const profit = marginPerScu * moveScu;
        const ages = [ageDays(b.asOf, now), ageDays(s.asOf, now)].filter((a): a is number => a !== null);
        out.push({
          commodity,
          from,
          to,
          marginPerScu,
          marginPct: ((s.sell as number) - (b.buy as number)) / (b.buy as number) * 100,
          moveScu,
          scuBound,
          capitalRequired: (b.buy as number) * moveScu,
          profit,
          minutes,
          profitPerHour: profit / (minutes / 60),
          crossSystem: !!(from.system && to.system && from.system !== to.system),
          // Rule B: a route is as stale as its stalest half.
          ageDays: ages.length ? Math.max(...ages) : null,
        });
      }
    }
  }

  /* 🔑 ONE COMPARATOR, CHOSEN BY THE CALLER — see `sort` on the options for why this stopped being
     hardcoded. The tie-break falls through to profit per hour in every mode so two rows that draw
     on the chosen measure still come out in a stable, sensible order rather than in table order. */
  const rank = (r: TradeRoute): number => {
    switch (opts.sort) {
      case "profit": return r.profit;
      case "margin": return r.marginPct;
      case "scu": return r.marginPerScu;
      default: return r.profitPerHour;
    }
  };
  out.sort((a, b) => rank(b) - rank(a) || b.profitPerHour - a.profitPerHour);

  // 🔑 ONE ROW PER (commodity, buy terminal). Without this the list is 40 rows of Bexalite from
  // Bueno Ravine to forty different sell points, which is one decision wearing forty hats. The
  // sort above already put the best sell destination for each buy point first.
  //
  // 🔴 …UNLESS THE CALLER HAS ALREADY MADE THAT DECISION. With `fromTerminal` pinned there is
  // exactly one buy point, so the rule above collapses the whole answer to a SINGLE row — and the
  // question being asked at that moment is precisely "where can I take this", i.e. the forty hats
  // ARE the answer. So the key mirrors: one row per DESTINATION. The protection is unchanged in
  // shape, only in which end of the run it applies to.
  const dedupeOnDestination = !!opts.fromTerminal;
  const seen = new Set<string>();
  const perCommodity = new Map<string, number>();
  const deduped: TradeRoute[] = [];
  for (const r of out) {
    const k = r.commodity + "\u0000" + (dedupeOnDestination ? r.to.terminal : r.from.terminal);
    if (seen.has(k)) continue;
    /* 🔴 AT MOST TWO PLACES TO BUY THE SAME THING, or one commodity eats the board. The key above
       keeps one row per buy TERMINAL, which is right — where you buy changes the travel time — but
       a commodity sold in twenty places then occupies twenty rows differing in nothing else.
       Measured on the live table at a 696 SCU hold: the top 25 carried only 14 distinct commodities
       ranked by profit-per-hour (Construction Materials five times), and ranked by MARGIN it
       collapsed to seven, with Waste appearing NINETEEN times. That is the "the top 25 is really a
       top 8" Sub reported; the margin ranking made it acute rather than causing it.
       🔑 TWO, not one: the second row is the fallback when the first is out of stock or out of your
       way, which is the decision this board exists to support. A third adds no decision.
       ⚠️ NOT applied when a buy terminal is pinned. There the rows are DESTINATIONS for a single
       commodity and the long list IS the answer — capping it would hide most of the safe drop-offs,
       which is precisely the bug `dedupeOnDestination` exists to prevent. */
    if (!dedupeOnDestination) {
      const n = perCommodity.get(r.commodity) ?? 0;
      if (n >= MAX_ROWS_PER_COMMODITY) continue;
      perCommodity.set(r.commodity, n + 1);
    }
    seen.add(k);
    deduped.push(r);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

/** How many buy points for one commodity may share the board. See the dedupe loop for the
 *  measurement behind it. */
const MAX_ROWS_PER_COMMODITY = 2;
