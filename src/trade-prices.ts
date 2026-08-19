/**
 * TRADE - THE PRICE TABLE, AND WHERE EVERY NUMBER IN IT CAME FROM.
 *
 * Phase 2 of hauling is commodity trading: buy cheap at one terminal, haul it, sell dear at
 * another. That needs per-terminal buy and sell prices, and this module is the only place that
 * decides where they come from.
 *
 * 🔴 THE STANDING CONSTRAINT: THERE IS NO SUCH THING AS "THE PRICE OF TITANIUM". Prices are
 * per-terminal and they move. Every quote here therefore carries its OWN `asOf`, and nothing
 * downstream may collapse a set of quotes into one number without also carrying the spread. A UI
 * that implies false precision here is worse than no UI (Sub, repeatedly).
 *
 * -- The source chain: live -> cache -> bundled, and it always SAYS which --------------------
 *
 * `source` is on every table this module hands out, because Sub's requirement was explicit: the
 * user needs to know when they are looking at the fallback. Silence is the failure mode.
 *
 *   "live"    a refresh landed this session. Rows carry real `asOf` timestamps.
 *   "cache"   a previous session's refresh, replayed off disk. Still real timestamps, older.
 *   "bundled" data/commodities.json, which ships in the build. Works with no network at all, and
 *             carries NO per-quote timestamps and almost no stock - see the honesty notes below.
 *
 * 🔴 THE API KEY MUST NEVER SHIP IN THIS APP. It is a distributable desktop binary: a key inside
 * it is extractable, and then strangers spend our quota. So the app fetches an UNAUTHENTICATED
 * endpoint on subliminal.gg, which holds one key server-side and polls UEX on everyone's behalf -
 * the same shape `/api/sc/mission-payout` and `/api/sc/mission-feedback` already use. The URL is
 * config so that moving the poller is a settings change rather than a rewrite.
 *
 * -- What live buys us, measured 2026-08-19 against the real API -----------------------------
 *
 * `GET /2.0/commodities_prices_all` is 2,593 rows / 1.07 MB in ONE call, 0.69s. Against the
 * bundled snapshot it wins on exactly three things, and it is worth being precise about which:
 *
 *   - STOCK. 701 of 711 live buy rows carry `scu_buy`. In the bundle, stock is known for 13% of
 *     routes. This is the real prize - a margin you cannot buy any of is not a trade.
 *   - DEMAND. `scu_sell` / `scu_sell_stock`. The bundled row shape has no demand field at all.
 *   - AGE. `date_modified` per row. The bundle has no timestamps anywhere.
 *
 * It does NOT buy more commodities: 87 buyable live vs 90 bundled, 135 terminals vs 133.
 *
 * 🔑 AND IT IS NOT "LIVE PRICES", WHICH IS WHY `asOf` IS MANDATORY RATHER THAN DECORATION.
 * UEX is crowd-sourced and says so. Measured over all 2,593 rows: median age 2.6 DAYS, p25 0.8d,
 * 753 rows under 24h, p90 10.2d, max 523d. So polling every few minutes keeps OUR copy minutes
 * behind UEX while UEX sits a median 2.6 days behind the verse. The number that actually tells a
 * player whether to trust a quote is the row's own age, not the refresh interval - so we render
 * the row's age and never advertise the interval.
 *
 * 🔑 `price_buy` IS THE CURRENT REPORTED PRICE. The averaging visible in UEX's docs lives in
 * SEPARATE columns (`price_buy_avg`, `_week`, `_month`); it is not folded into the plain field.
 * An earlier reading of the docs concluded the opposite and it was wrong.
 *
 * ⚠️ `is_available_live` IS 1 ON ONLY 114 OF 135 PRICED TERMINALS. Twenty-one terminals carry
 * prices in the data and do not exist in the running game. Routing a player to one is a wasted
 * trip that looks exactly like the app being wrong, so they are dropped - and counted, because a
 * silent filter is how a data problem becomes invisible.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/** One commodity at one terminal. Every field the source cannot answer is `null` - never 0.
 *  🔴 The distinction is load-bearing: `stockScu: 0` means "we know, and there is none", while
 *  `null` means "nobody has reported it". Rendering the second as the first invents a fact. */
export interface TradeQuote {
  commodity: string;
  /** Long form, e.g. "Admin - Baijini Point" - matches the bundled snapshot's terminal names on
   *  133 of 135 terminals, which is what lets the two sources share one place map. */
  terminal: string;
  /** Short form a player reads on the board, e.g. "Baijini Point". */
  terminalShort: string;
  system: string | null;
  /** The body this terminal sits on. THE TIER KEY for travel cost - see `hauling-route.ts`,
   *  whose measured model is same-body vs cross-body minutes, not distance. */
  body: string | null;
  /** Where a player would say they are: station, city or outpost name. */
  place: string | null;
  buy: number | null;
  sell: number | null;
  /** SCU on the shelf to buy. */
  stockScu: number | null;
  /** SCU the terminal will take off you. */
  demandScu: number | null;
  /** Largest box this terminal handles, in SCU. 0 means it takes no containers at all. */
  maxContainerScu: number | null;
  /** Epoch seconds this quote was last reported. `null` for bundled rows, which carry none. */
  asOf: number | null;
}

export type TradeSource = "live" | "cache" | "bundled";

export interface TradeTable {
  quotes: TradeQuote[];
  source: TradeSource;
  /** Epoch ms this table was obtained. Null for bundled, which has no fetch of its own. */
  fetchedAt: number | null;
  /** The snapshot version string, for bundled. */
  version: string | null;
  /** Terminals dropped because the game does not currently have them. Surfaced, never silent. */
  droppedOffline: number;
  /** Set when the last refresh attempt failed, so the widget can say WHY it is on a fallback
   *  rather than only that it is. */
  lastError: string | null;
}

/** The bundled snapshot's per-terminal row. */
export interface BundledPrice { terminal?: string | null; location?: string | null; buy?: number | null; sell?: number | null; stock?: number | null }
export interface BundledCommodity { name?: string | null; kind?: string | null; prices?: BundledPrice[] }

/** What the remote endpoint is expected to serve. Deliberately a THIN passthrough of UEX's own
 *  shape plus a terminal table, so the site can proxy without inventing a schema. */
interface RemotePriceRow {
  id_terminal?: number; commodity_name?: string | null; terminal_name?: string | null;
  price_buy?: number | null; price_sell?: number | null;
  scu_buy?: number | null; scu_sell?: number | null; scu_sell_stock?: number | null;
  date_modified?: number | null;
}
interface RemoteTerminalRow {
  id?: number; name?: string | null; nickname?: string | null; displayname?: string | null;
  star_system_name?: string | null; planet_name?: string | null; moon_name?: string | null;
  space_station_name?: string | null; city_name?: string | null; outpost_name?: string | null;
  orbit_name?: string | null; is_available_live?: number | boolean | null;
  max_container_size?: number | null;
}
interface RemotePayload { prices?: RemotePriceRow[]; terminals?: RemoteTerminalRow[]; fetchedAt?: number | null }

/** A place, as locations.json describes one. */
export interface PlaceInfo { name: string | null; parentName: string | null; system: string | null; type: string | null }

export interface TradePriceOptions {
  /** Where the bundled datasets live. */
  dataDir: string;
  /** Writable dir for the refresh cache. */
  stateDir: string;
  /** Endpoint serving `{prices, terminals}`. Null/empty disables refreshing entirely, which is a
   *  legitimate configuration and must behave like a clean offline install, not like an error. */
  url?: string | null;
  /** Reads the bundled commodities map. Injected so this store does not re-parse the 608 KB
   *  snapshot that `MiningEconomyStore` has already parsed. */
  bundled: () => Record<string, BundledCommodity>;
  /** location uuid -> place, from locations.json. */
  places: () => Map<string, PlaceInfo>;
  fetchImpl?: typeof fetch;
}

const CACHE_FILE = "trade-prices.json";

/** A place name a player would recognise, most specific first. Station and city beat the body:
 *  "Baijini Point" is where you dock, "ArcCorp" is the planet it orbits. */
function placeOf(t: RemoteTerminalRow): string | null {
  return t.space_station_name || t.city_name || t.outpost_name || t.moon_name || t.planet_name || t.orbit_name || null;
}
/** The TIER key for travel cost. Deliberately the BODY, not the place: `hauling-route.ts` measured
 *  that the cost is dominated by getting up and down a gravity well, so two outposts on Wala are
 *  one tier while Wala -> Hurston is another. Moon before planet, because a moon IS the well. */
function bodyOf(t: RemoteTerminalRow): string | null {
  return t.moon_name || t.planet_name || t.space_station_name || t.orbit_name || t.star_system_name || null;
}

/** Positive numbers, with a real zero preserved and everything else null.
 *  🔑 `0` and `null` mean different things here (see TradeQuote) so they must not collapse. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
/** A price of 0 means "does not trade here", not "free" - UEX writes 0 in the column it is not
 *  using. So prices, unlike stock, drop their zero. */
function price(v: unknown): number | null {
  const n = num(v);
  return n && n > 0 ? n : null;
}

export class TradePriceStore {
  private opts: TradePriceOptions;
  private table: TradeTable;
  private refreshing: Promise<TradeTable> | null = null;

  constructor(opts: TradePriceOptions) {
    this.opts = opts;
    // Start from the best thing available with no network: a previous session's cache if it is
    // readable, else the bundle. Never start empty - the widget must render on its first frame.
    this.table = this.readCache() ?? this.fromBundled();
  }

  /** The current table. Synchronous and always populated. */
  current(): TradeTable { return this.table; }

  /** True when a refresh would be worth attempting. */
  canRefresh(): boolean { return !!(this.opts.url ?? "").trim(); }

  /**
   * Fetch, normalise, cache and swap in. Never throws: a failed refresh leaves the previous table
   * in place and records `lastError` on it, because a trade widget that goes blank when the
   * network hiccups is worse than one showing month-old prices and saying so.
   *
   * 🔑 Concurrent callers share one in-flight request. The widget polls and the sidecar ticks;
   * without this they would double-fetch a 1 MB body.
   */
  async refresh(): Promise<TradeTable> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<TradeTable> {
    const url = (this.opts.url ?? "").trim();
    if (!url) {
      this.table = { ...this.table, lastError: null };
      return this.table;
    }
    try {
      const f = this.opts.fetchImpl ?? fetch;
      const r = await f(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const body = (await r.json()) as RemotePayload;
      const built = this.fromRemote(body);
      // 🔴 A SUCCESSFUL FETCH OF AN EMPTY BODY IS NOT A SUCCESS. An endpoint that is up but has
      // nothing to say (its own upstream poll failed, it is mid-deploy) would otherwise REPLACE a
      // perfectly good cache with zero quotes and report "live" - the worst of both, because it
      // looks healthy. Keep what we have and say why.
      if (!built.quotes.length) throw new Error("empty price payload");
      this.table = built;
      this.writeCache(built);
      return this.table;
    } catch (e) {
      this.table = { ...this.table, lastError: (e as Error)?.message || String(e) };
      return this.table;
    }
  }

  // -- Builders ---------------------------------------------------------------

  private fromRemote(body: RemotePayload): TradeTable {
    const terms = new Map<number, RemoteTerminalRow>();
    for (const t of body.terminals ?? []) if (typeof t.id === "number") terms.set(t.id, t);
    const quotes: TradeQuote[] = [];
    let droppedOffline = 0;
    for (const p of body.prices ?? []) {
      const t = typeof p.id_terminal === "number" ? terms.get(p.id_terminal) : undefined;
      // ⚠️ Drop terminals the game does not currently have. Counted, not silent.
      if (t && !(t.is_available_live === 1 || t.is_available_live === true)) { droppedOffline++; continue; }
      const buy = price(p.price_buy);
      const sell = price(p.price_sell);
      if (buy === null && sell === null) continue;
      const commodity = (p.commodity_name ?? "").trim();
      if (!commodity) continue;
      const long = (t?.name ?? p.terminal_name ?? "").trim();
      if (!long) continue;
      quotes.push({
        commodity,
        terminal: long,
        terminalShort: (t?.nickname || t?.displayname || p.terminal_name || long).trim(),
        system: t?.star_system_name?.trim() || null,
        body: t ? bodyOf(t) : null,
        place: t ? placeOf(t) : null,
        buy,
        sell,
        stockScu: num(p.scu_buy),
        // 🔑 Two different demand fields and they are not interchangeable: `scu_sell` is what has
        // been sold INTO the terminal, `scu_sell_stock` what it is holding. Prefer the first and
        // fall back, rather than adding them - that would double-count.
        demandScu: num(p.scu_sell) ?? num(p.scu_sell_stock),
        maxContainerScu: typeof t?.max_container_size === "number" ? t.max_container_size : null,
        asOf: typeof p.date_modified === "number" && p.date_modified > 0 ? p.date_modified : null,
      });
    }
    return {
      quotes,
      source: "live",
      fetchedAt: typeof body.fetchedAt === "number" ? body.fetchedAt : Date.now(),
      version: null,
      droppedOffline,
      lastError: null,
    };
  }

  /**
   * The offline floor. `data/commodities.json` is itself a UEX snapshot - its own header says so -
   * so this is the same data a patch cycle stale, not a different kind of data.
   *
   * ⚠️ Its row shape carries NO timestamps and NO demand, and stock on only a small minority of
   * rows. Those become `null`, and the widget renders "not reported" rather than a zero. The one
   * thing it has that live does not is a location UUID, which resolves against locations.json.
   */
  private fromBundled(): TradeTable {
    const quotes: TradeQuote[] = [];
    let version: string | null = null;
    try {
      const places = this.opts.places();
      const map = this.opts.bundled();
      for (const c of Object.values(map)) {
        const name = (c?.name ?? "").trim();
        // Internal identifiers (225 of the 738 records) are not commodities a player trades.
        if (!name || name.includes("_")) continue;
        for (const p of c.prices ?? []) {
          const buy = price(p.buy);
          const sell = price(p.sell);
          if (buy === null && sell === null) continue;
          const terminal = (p.terminal ?? "").trim();
          if (!terminal) continue;
          const loc = p.location ? places.get(p.location) : undefined;
          quotes.push({
            commodity: name,
            terminal,
            terminalShort: terminal,
            system: loc?.system ? loc.system.replace(/\s*System$/i, "") : null,
            body: loc?.parentName || loc?.name || null,
            place: loc?.name || null,
            buy, sell,
            stockScu: num(p.stock),
            demandScu: null,
            maxContainerScu: null,
            asOf: null,
          });
        }
      }
      version = this.readBundledVersion();
    } catch { /* a missing bundle yields an empty table, never a throw */ }
    return { quotes, source: "bundled", fetchedAt: null, version, droppedOffline: 0, lastError: null };
  }

  private readBundledVersion(): string | null {
    try {
      const raw = readFileSync(join(this.opts.dataDir, "commodities.json"), "utf8").slice(0, 400);
      const m = /"version"\s*:\s*"([^"]+)"/.exec(raw);
      return m ? m[1] : null;
    } catch { return null; }
  }

  // -- Disk cache -------------------------------------------------------------

  private cachePath(): string { return join(this.opts.stateDir, CACHE_FILE); }

  private readCache(): TradeTable | null {
    try {
      const p = this.cachePath();
      if (!existsSync(p)) return null;
      const j = JSON.parse(readFileSync(p, "utf8")) as { quotes?: TradeQuote[]; fetchedAt?: number; droppedOffline?: number };
      if (!Array.isArray(j.quotes) || !j.quotes.length) return null;
      return {
        quotes: j.quotes,
        source: "cache",
        fetchedAt: typeof j.fetchedAt === "number" ? j.fetchedAt : null,
        version: null,
        droppedOffline: typeof j.droppedOffline === "number" ? j.droppedOffline : 0,
        lastError: null,
      };
    } catch { return null; }
  }

  private writeCache(t: TradeTable): void {
    try {
      mkdirSync(dirname(this.cachePath()), { recursive: true });
      writeFileSync(this.cachePath(), JSON.stringify({ quotes: t.quotes, fetchedAt: t.fetchedAt, droppedOffline: t.droppedOffline }));
    } catch { /* a read-only profile must not take the feature down */ }
  }
}
