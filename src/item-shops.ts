/**
 * VERSE FINDER - THE SHOP TABLE, AND WHERE EVERY NUMBER IN IT CAME FROM.
 *
 * The question is Sub's, verbatim: "hit a hotkey, type in the item that they're looking for, and
 * it'll tell them whether or not they can buy it in a shop in the game." Shops and terminals, so
 * this is about ITEMS - components, weapons, armour, gear - not the commodity market. Commodities
 * are `trade-prices.ts`, which is this module's sibling and its template.
 *
 * 🔴 THE UEX API KEY MUST NEVER SHIP IN THIS APP. It is a distributable desktop binary: a key
 * inside it is extractable, and then strangers spend our quota. So the app fetches an
 * UNAUTHENTICATED endpoint on subliminal.gg, which holds one key server-side and polls UEX on
 * everyone's behalf - the same shape `/api/sc/mission-payout` and `/api/sc/mission-feedback`
 * already use. The URL is config so that moving the poller is a settings change, not a rewrite.
 *
 * -- The source chain: live -> cache -> bundled, and it always SAYS which -------------------
 *
 * Identical policy to trade, for the identical reason: the user needs to know when they are
 * looking at the fallback. Silence is the failure mode.
 *
 *   "live"    a refresh landed this session.
 *   "cache"   a previous session's refresh, replayed off disk.
 *   "bundled" data/item-shops.json, which ships in the build. Works with no network at all.
 *
 * 🔑 UNLIKE TRADE, THE BUNDLED TIER IS NOT A DIFFERENT KIND OF DATA. `data/commodities.json` is a
 * separate snapshot with no timestamps and no demand; here the bundle is a captured copy of the
 * very same endpoint payload, so every quote keeps its real `asOf` in all three tiers. The only
 * thing that degrades with the fallback is how old the whole table is, which `fetchedAt` states.
 *
 * -- What this data can and cannot answer, measured 2026-08-20 over the whole dataset -------
 *
 *   2,791 buyable items - 461 live terminals - 23,656 quotes.
 *
 * 🔴 THERE IS NO STOCK FIELD, AND THIS IS THE ONE PLACE THE ITEM DATA IS WEAKER THAN THE
 * COMMODITY DATA. Not sparse - absent. Commodity rows carry `scu_buy`; item rows carry nothing
 * equivalent, at any endpoint. So this table says where a shop is and what it charges, and can
 * NEVER say whether the thing is on the shelf. A player can still fly out and find it empty, so
 * the widget says so up front rather than letting them discover it. There is no zero-vs-null
 * subtlety to get right here because there is no field at all.
 *
 * 🔴 THE STALENESS RULE INVERTS FROM TRADE, AND IT IS MEASURED RATHER THAN ASSUMED. Readings here
 * are a median 83 DAYS old against commodities' 2.6 days, which looks fatal until you ask whether
 * the number moves: over a month, 23,658 of 23,747 rows had `price_buy_min_month` equal to
 * `price_buy_max_month` - the price was never once observed to change. These are fixed shop
 * prices, not a market. So a stale reading is very probably still correct, and the honest line is
 * "shop prices barely move, but this reading is N days old" - never "live prices". Same UI as
 * trade, opposite reasoning; do not copy trade's justification across with it.
 *
 * 🔴 AND THERE IS STILL NO SUCH THING AS "THE PRICE". Of the 2,132 items sold in more than one
 * place, 1,447 (68%) cost different amounts at different shops - Venture Arms runs 557-592 aUEC
 * across 13 of them. Every quote is per-terminal by construction and nothing downstream may
 * collapse a set of them into one number.
 *
 * 🔑 `uuid` IS THE JOIN TO OUR OWN GAME DATA. UEX ships the game's item UUID, and
 * `blueprint-detail.latest.json` is keyed by the same one - 723 buyable items are also craftable
 * blueprints the app already tracks, with names agreeing character-for-character. That is what
 * lets the widget answer "buy it here, or craft it - you already own the blueprint".
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/** Bump when the wire shape changes. Mirrors `ITEM_SHOPS_SCHEMA` on the site. */
export const ITEM_SHOPS_SCHEMA = 1;

/** One shop that sells one item. Terminal is an INDEX into `ItemShopTable.terminals` - a terminal
 *  name repeats across ~50 rows and inlining it triples the payload for no gain. */
export interface ItemQuote {
  t: number;
  /** aUEC. Always positive; a row without a real buy price never reaches here. */
  p: number;
  /** Epoch SECONDS this price was last reported to UEX. Never null - UEX populates it on 100% of
   *  rows, and a quote whose age we cannot state has no business being rendered. */
  m: number;
}

export interface ShopItem {
  /** UEX item name. Components are named BARE ("Burst" is a quantum drive), which is why `co`
   *  carries most of the searchable identity for them. */
  n: string;
  /** Manufacturer, where UEX knows one. */
  co: string | null;
  /** Category, e.g. "Quantum Drives". */
  c: string;
  /** Section, e.g. "Systems". */
  s: string;
  /** Component size ("1".."4"), where UEX knows one. */
  z: string | null;
  /** The game's item UUID, lowercased. Null where UEX has none. See the join note above. */
  u: string | null;
  /** Every shop that sells it, cheapest first. Never empty. */
  q: ItemQuote[];
}

export interface ShopTerminal {
  n: string;
  sys: string | null;
  body: string | null;
  place: string | null;
}

export type ShopSource = "live" | "cache" | "bundled";

export interface ItemShopTable {
  items: ShopItem[];
  terminals: ShopTerminal[];
  source: ShopSource;
  /** Epoch ms this table was obtained. Null when we have nothing to say. */
  fetchedAt: number | null;
  /** Rows dropped because the terminal is not in the running game. Surfaced, never silent -
   *  routing a player to a terminal that no longer exists looks exactly like the app being wrong. */
  droppedOffline: number;
  /** Items UEX lists that nobody has reported a shop for. The honest denominator: "we don't know
   *  of a shop" is the COMMON answer (roughly two thirds of the catalogue) and the UI has to tell
   *  it apart from "no such item". */
  catalogueOnly: number;
  /** Set when the last refresh failed, so the widget can say WHY it is on a fallback rather than
   *  only that it is. */
  lastError: string | null;
}

/** What the remote endpoint serves. A thin passthrough of the site's own shape. */
interface RemotePayload {
  schema?: number;
  items?: ShopItem[];
  terminals?: ShopTerminal[];
  fetchedAt?: number | null;
  droppedOffline?: number;
  catalogueOnly?: number;
}

export interface ItemShopOptions {
  /** Where the bundled datasets live. */
  dataDir: string;
  /** Writable dir for the refresh cache. */
  stateDir: string;
  /** Endpoint serving the table. Null/empty disables refreshing entirely, which is a legitimate
   *  configuration and must behave like a clean offline install, not like an error. */
  url?: string | null;
  fetchImpl?: typeof fetch;
}

const CACHE_FILE = "item-shops.json";
const BUNDLED_FILE = "item-shops.json";

function emptyTable(source: ShopSource): ItemShopTable {
  return { items: [], terminals: [], source, fetchedAt: null, droppedOffline: 0, catalogueOnly: 0, lastError: null };
}

/** Structural validation of a payload from anywhere - network, cache or bundle.
 *
 *  🔑 It checks the SHAPE rather than trusting the source, because all three tiers deserialise the
 *  same JSON and a half-written cache file is exactly as damaging as a bad response. A table that
 *  fails this is discarded whole; there is no partial-accept path, because an item whose quotes
 *  reference terminals that are not there would render a price with no place. */
function normalise(body: RemotePayload | null | undefined): { items: ShopItem[]; terminals: ShopTerminal[] } | null {
  if (!body || !Array.isArray(body.items) || !Array.isArray(body.terminals)) return null;
  const terminals: ShopTerminal[] = [];
  for (const t of body.terminals) {
    const n = typeof t?.n === "string" ? t.n.trim() : "";
    if (!n) return null; // an unnamed terminal cannot be shown as a place, so the table is bad
    terminals.push({
      n,
      sys: typeof t.sys === "string" && t.sys ? t.sys : null,
      body: typeof t.body === "string" && t.body ? t.body : null,
      place: typeof t.place === "string" && t.place ? t.place : null,
    });
  }
  const items: ShopItem[] = [];
  for (const it of body.items) {
    const n = typeof it?.n === "string" ? it.n.trim() : "";
    if (!n || !Array.isArray(it.q)) continue;
    const q: ItemQuote[] = [];
    for (const raw of it.q) {
      const t = typeof raw?.t === "number" ? raw.t : -1;
      const p = typeof raw?.p === "number" ? raw.p : 0;
      const m = typeof raw?.m === "number" ? raw.m : 0;
      // A quote pointing at a terminal we do not have is unrenderable - it would be a price with
      // no place, which is the one thing this widget must never show.
      if (t < 0 || t >= terminals.length || p <= 0 || m <= 0) continue;
      q.push({ t, p, m });
    }
    if (!q.length) continue;
    q.sort((a, b) => a.p - b.p || b.m - a.m);
    items.push({
      n,
      co: typeof it.co === "string" && it.co ? it.co : null,
      c: typeof it.c === "string" && it.c ? it.c : "Unknown",
      s: typeof it.s === "string" && it.s ? it.s : "Unknown",
      z: typeof it.z === "string" && it.z ? it.z : null,
      u: typeof it.u === "string" && it.u ? it.u.toLowerCase() : null,
      q,
    });
  }
  if (!items.length) return null;
  return { items, terminals };
}

export class ItemShopStore {
  private opts: ItemShopOptions;
  private table: ItemShopTable;
  private refreshing: Promise<ItemShopTable> | null = null;

  constructor(opts: ItemShopOptions) {
    this.opts = opts;
    // Start from the best thing available with no network: a previous session's cache if it is
    // readable, else the bundle. Never start empty - the widget must answer on its first frame.
    this.table = this.readCache() ?? this.fromBundled();
  }

  /** The current table. Synchronous and always populated (possibly with zero items, if the build
   *  shipped without a bundle - which `source` and `items.length` together make legible). */
  current(): ItemShopTable { return this.table; }

  /** True when a refresh would be worth attempting. */
  canRefresh(): boolean { return !!(this.opts.url ?? "").trim(); }

  /**
   * Fetch, validate, cache and swap in. Never throws: a failed refresh leaves the previous table
   * in place and records `lastError`, because a finder that goes blank when the network hiccups is
   * worse than one showing month-old prices and saying so - especially for data that demonstrably
   * does not move.
   *
   * 🔑 Concurrent callers share one in-flight request, so the widget's poll and the sidecar's tick
   * cannot double-fetch a 1 MB body.
   */
  async refresh(): Promise<ItemShopTable> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<ItemShopTable> {
    const url = (this.opts.url ?? "").trim();
    if (!url) {
      this.table = { ...this.table, lastError: null };
      return this.table;
    }
    try {
      const f = this.opts.fetchImpl ?? fetch;
      const r = await f(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const body = (await r.json()) as RemotePayload;
      const built = normalise(body);
      // 🔴 A SUCCESSFUL FETCH OF AN EMPTY BODY IS NOT A SUCCESS. An endpoint that is up but has
      // nothing to say (its own upstream poll failed, it is mid-deploy) would otherwise REPLACE a
      // perfectly good cache with zero items and report "live" - the worst of both, because it
      // looks healthy. Keep what we have and say why.
      if (!built) throw new Error("empty or malformed item payload");
      this.table = {
        ...built,
        source: "live",
        fetchedAt: typeof body.fetchedAt === "number" ? body.fetchedAt : Date.now(),
        droppedOffline: typeof body.droppedOffline === "number" ? body.droppedOffline : 0,
        catalogueOnly: typeof body.catalogueOnly === "number" ? body.catalogueOnly : 0,
        lastError: null,
      };
      this.writeCache(this.table);
      return this.table;
    } catch (e) {
      this.table = { ...this.table, lastError: (e as Error)?.message || String(e) };
      return this.table;
    }
  }

  // -- Builders ---------------------------------------------------------------

  /** The offline floor: a captured copy of the endpoint's own payload, shipped in the build. */
  private fromBundled(): ItemShopTable {
    try {
      const raw = readFileSync(join(this.opts.dataDir, BUNDLED_FILE), "utf8");
      const body = JSON.parse(raw) as RemotePayload;
      const built = normalise(body);
      if (!built) return emptyTable("bundled");
      return {
        ...built,
        source: "bundled",
        fetchedAt: typeof body.fetchedAt === "number" ? body.fetchedAt : null,
        droppedOffline: typeof body.droppedOffline === "number" ? body.droppedOffline : 0,
        catalogueOnly: typeof body.catalogueOnly === "number" ? body.catalogueOnly : 0,
        lastError: null,
      };
    } catch {
      // A missing bundle yields an empty table, never a throw. The widget then says it has no
      // data rather than the sidecar failing to start.
      return emptyTable("bundled");
    }
  }

  // -- Disk cache -------------------------------------------------------------

  private cachePath(): string { return join(this.opts.stateDir, CACHE_FILE); }

  private readCache(): ItemShopTable | null {
    try {
      const p = this.cachePath();
      if (!existsSync(p)) return null;
      const body = JSON.parse(readFileSync(p, "utf8")) as RemotePayload;
      const built = normalise(body);
      if (!built) return null;
      return {
        ...built,
        source: "cache",
        fetchedAt: typeof body.fetchedAt === "number" ? body.fetchedAt : null,
        droppedOffline: typeof body.droppedOffline === "number" ? body.droppedOffline : 0,
        catalogueOnly: typeof body.catalogueOnly === "number" ? body.catalogueOnly : 0,
        lastError: null,
      };
    } catch { return null; }
  }

  private writeCache(t: ItemShopTable): void {
    try {
      mkdirSync(dirname(this.cachePath()), { recursive: true });
      writeFileSync(this.cachePath(), JSON.stringify({
        schema: ITEM_SHOPS_SCHEMA,
        items: t.items,
        terminals: t.terminals,
        fetchedAt: t.fetchedAt,
        droppedOffline: t.droppedOffline,
        catalogueOnly: t.catalogueOnly,
      }));
    } catch { /* a read-only profile must not take the feature down */ }
  }
}
