/**
 * TRADE - THE SIDECAR SURFACE, DELIBERATELY ALL IN ONE FILE.
 *
 * 🔴 `overlay-server.ts` IS BEING RESTRUCTURED BY ANOTHER FLIGHT AS THIS IS WRITTEN, so this
 * subsystem touches it in exactly ONE place: one import and one call. Every route, every piece of
 * state and every default lives here. Anything added to this feature later belongs in this file
 * too - the moment a second hook appears in the server, that promise is gone.
 *
 * Routes — read-only GETs, and exactly one write:
 *
 *   GET  /api/trade/status              where the prices came from and how old they are
 *   GET  /api/trade/names               commodity names that can be BOUGHT somewhere (autocomplete)
 *   GET  /api/trade/commodity?name=     one commodity: every terminal, as ranges
 *   GET  /api/trade/routes?...          buy-low/sell-high runs, ranked
 *   GET  /api/trade/journal             what you really bought and sold, with realised profit
 *   POST /api/trade/journal/forget?lot= 🔴 the one write — "that cargo is gone, stop listing it"
 *
 * 🔑 EVERY RESPONSE CARRIES `source` AND THE TABLE'S AGE, not just the ones about prices. Sub's
 * requirement was that the user knows when they are on the fallback, and a widget can only say so
 * on the screen the user is actually looking at.
 *
 * ⚠️ The GETs are unauthenticated like the rest of the widget API, which is LAN-reachable (OBS
 * browser sources on another PC). That is acceptable here because they spend no credential, write
 * nothing, and reveal nothing the player did not already publish - they read a public price table.
 * ⚠️ The journal is the exception to the "nothing private" half: it is the player's own trading
 * record. It stays a plain GET because it names no credential and no path on disk, which is the bar
 * `SENSITIVE_GET` sets - but if it ever grows a field of that kind, it belongs on that list.
 * 🔑 The one WRITE is covered by the gate this note used to ask for, and by a stronger one:
 * `overlay-server.ts` refuses every non-GET that is not from this machine AND every request
 * carrying a foreign `Origin`, before this file is called. See references/security.md.
 */
import type { ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { TradePriceStore, type PlaceInfo, type BundledCommodity, type TradeTable } from "./trade-prices.js";
import { findRoutes, lookupCommodity, tradableNames, buyableSystems } from "./trade-finder.js";
import { TradeJournal } from "./trade-journal.js";
import { TradeConfirmations, TRADE_LOG_MARKER, type CommodityPurchase } from "./trade-log.js";

/** How often the sidecar re-asks the endpoint. The endpoint itself is what polls UEX; this is
 *  only how fast our copy of ITS copy turns over, so it does not need to be aggressive.
 *  🔑 The widget must not advertise this number - the honest figure is each quote's own age. */
const REFRESH_MS = 10 * 60 * 1000;

/** Default endpoint. Serving this is a site-repo job; until it exists the fetch fails and the
 *  store sits on the bundled snapshot, which is exactly the designed behaviour rather than a
 *  broken state.
 *
 *  🔑 `SC_TRADE_URL` overrides it, which is how the live path was exercised before the site
 *  endpoint existed at all - point it at a file server holding a real UEX payload. Set it to the
 *  empty string to run deliberately offline on the bundled snapshot. */
export const DEFAULT_TRADE_URL = "https://subliminal.gg/api/sc/commodity-prices";

function configuredUrl(explicit: string | null | undefined): string | null {
  if (explicit !== undefined) return explicit;
  const env = process.env.SC_TRADE_URL;
  if (env !== undefined) return env.trim() || null;
  return DEFAULT_TRADE_URL;
}

interface HaulingLike {
  locations(): Record<string, { name?: string | null; parentName?: string | null; system?: string | null; type?: string | null }>;
  ship(classOrName: string): { totalScu: number; displayName: string | null } | null;
}
interface EconomyLike { commodities(): Record<string, unknown> }

export interface TradeDeps {
  dataDir: string;
  userDir: string;
  economy: EconomyLike;
  haulingData: HaulingLike;
  /** Endpoint override. `null` disables refreshing, which is a supported configuration. */
  url?: string | null;
  /** What system the player is in, when the log has said. Used only to DEFAULT the filter -- the
   *  widget always sends an explicit choice, so a wrong guess here can never silently filter. */
  system?: () => string | null;
  /** The configured game.log path, used to find `logbackups/` for the journal catch-up. */
  logPath?: () => string | null;
}

let store: TradePriceStore | null = null;
let timer: NodeJS.Timeout | null = null;
let journal: TradeJournal | null = null;

/**
 * 🔴 ONE CONFIRMER FOR THE WHOLE LIVE STREAM, AND IT MUST NOT BE FLUSHED.
 *
 * `overlay-server.ts` feeds this the rotated-log seed, then the current log's seed, then the
 * watcher's tail — one continuous, in-order stream. A held request therefore hands over from the
 * seed to the watcher inside its own window, which is the seam a fresh instance (or a `flush()`)
 * would break: the seed would commit a request whose refusal is in the very next bytes.
 */
const liveConfirm = new TradeConfirmations();

/**
 * Feed one raw log line to the trade subsystem. Besides the route handler this is the ONLY thing
 * `overlay-server.ts` calls, and it is deliberately shaped to drop into both the live watcher and
 * the rotated-log seed with no other change.
 *
 * 🔴 A LINE MAY BOOK A PURCHASE FROM AN EARLIER LINE, AND USUALLY THAT IS WHAT HAPPENS. The log
 * records REQUESTS; the server refuses some of them on a separate line up to 565 ms later, so
 * nothing is booked until the window has passed in silence. See `TradeConfirmations`.
 *
 * ⚠️ EVERY line has to arrive here, including the ones that are not commodity lines — they are the
 * clock. Narrowing the call site to "interesting" lines would strand held purchases until the next
 * trade.
 *
 * 🔑 Still safe on every line of the log: one `indexOf` for all but a handful per session.
 */
export function tradeLogLine(line: string, deps: TradeDeps): void {
  const confirmed = liveConfirm.line(line);
  // The overwhelmingly common case: nothing came due, and no journal is touched.
  if (!confirmed.length) return;
  const j = ensureJournal(deps);
  let changed = false;
  for (const p of confirmed) if (j.apply(p)) changed = true;
  if (changed) j.save();
}

/** How far back the one-time catch-up looks. A day, because "what did I do today" is the question
 *  the journal answers and anything older is not what the player opened it for. */
const BACKFILL_HOURS = 24;
/** Hard cap on files read, so a folder with hundreds of backups cannot stall startup. */
const BACKFILL_FILES = 12;
let backfilled = false;

/**
 * 🔑 THE SEED ONLY REPLAYS THE NEWEST ROTATED LOG, AND A TRADING SESSION SPANS SEVERAL.
 *
 * `seedFromRotatedLog()` takes exactly one backup, which is right for mission state — that is
 * idempotent and restated constantly. A purchase is neither: it appears once, in whichever file
 * happened to be open, and Sub's own round trip landed the buy in the 11:09 backup and the sell in
 * the 12:48 one. With only the newest file replayed, the journal came up empty for a trade he had
 * just made, which reads as the feature being broken.
 *
 * So this walks the last day of backups ONCE per process, OLDEST FIRST — the order matters,
 * because FIFO matching needs a buy to be seen before the sell that closes it.
 *
 * ⚠️ Bounded on both axes (a 24h window and 12 files) so it can never become a startup stall, and
 * safe to run beside the normal seed because `TradeJournal.apply` is idempotent per log line.
 */
function backfillFromBackups(deps: TradeDeps, j: TradeJournal): void {
  if (backfilled) return;
  backfilled = true;
  const logPath = deps.logPath?.();
  if (!logPath) return;
  try {
    const dir = join(dirname(logPath), "logbackups");
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - BACKFILL_HOURS * 3600_000;
    const files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".log"))
      .map((f) => join(dir, f))
      .map((p) => ({ p, at: statSync(p).mtimeMs }))
      .filter((f) => f.at >= cutoff)
      .sort((a, b) => a.at - b.at)      // oldest first: a buy must precede its sell
      .slice(-BACKFILL_FILES);
    let found = 0;
    for (const f of files) {
      // 🔴 A FRESH CONFIRMER PER FILE, FLUSHED AT THE END. Each of these is a COMPLETE session:
      // a request with no refusal after it in the same file is a request that went through, and
      // there are no further bytes that could change that. The opposite handling — one shared
      // confirmer — is what the LIVE stream needs, for the opposite reason.
      const confirm = new TradeConfirmations();
      const apply = (ps: readonly CommodityPurchase[]): void => {
        for (const p of ps) if (j.apply(p)) found++;
      };
      for (const line of readFileSync(f.p, "utf8").split(/\r?\n/)) {
        // Cheap prefilter: the marker is a fixed substring, so most lines cost one indexOf.
        // 🔴 IT COVERS THE WHOLE COMPONENT, NOT JUST `::Send`. Narrowed to the requests, this loop
        // would never see a single refusal and would re-book every failed sale on the next launch
        // — the exact bug, arriving through the back door. `TRADE_LOG_MARKER` is exported so the
        // two cannot drift.
        if (!line.includes(TRADE_LOG_MARKER)) continue;
        apply(confirm.line(line));
      }
      apply(confirm.flush());
    }
    if (found) {
      j.save();
      console.log(`[trade] journal caught up: ${found} purchases/sales from ${files.length} recent log(s)`);
    }
  } catch (e) {
    console.log(`[trade] journal catch-up skipped: ${(e as Error).message}`);
  }
}

function ensureJournal(deps: TradeDeps): TradeJournal {
  if (journal) return journal;
  // resourceGUID -> name, straight off the bundled commodity map, which is keyed by the very same
  // uuid the log writes. The one clean join in this subsystem.
  const names = new Map<string, string>();
  try {
    for (const [uuid, c] of Object.entries(deps.economy.commodities() as Record<string, BundledCommodity>)) {
      const n = (c?.name ?? "").trim();
      if (n) names.set(uuid.toLowerCase(), n);
    }
  } catch { /* no dataset: the journal still records, just without names */ }
  journal = new TradeJournal(deps.userDir, (g) => names.get(g.toLowerCase()) ?? null);
  backfillFromBackups(deps, journal);
  return journal;
}

/** Build the store once, and start the refresh tick. Idempotent. */
/**
 * The current commodity table, for a READ-ONLY borrower outside this subsystem.
 *
 * 🔴 THE ONLY REASON THIS IS EXPORTED. The Verse Finder searches commodities (see
 * `verse-commodities.ts`), and there must be exactly ONE commodity store in the process: two would
 * refresh on two clocks and the two widgets could quote different prices for the same commodity at
 * the same moment. This hands out the table `tradeRoutes` is already serving, so they cannot.
 *
 * ⚠️ It will CREATE the store on first call, including arming the refresh timer — the same thing
 * any `/api/trade/*` request already does, so a player who never opens Trade but does search for
 * Laranite gets a store rather than nothing. Never widen this into a mutating accessor; the
 * subsystem's state stays owned here.
 */
export function tradeTable(deps: TradeDeps): TradeTable {
  return ensure(deps).current();
}

function ensure(deps: TradeDeps): TradePriceStore {
  if (store) return store;
  store = new TradePriceStore({
    dataDir: deps.dataDir,
    stateDir: deps.userDir,
    url: configuredUrl(deps.url),
    bundled: () => deps.economy.commodities() as Record<string, BundledCommodity>,
    places: () => {
      const m = new Map<string, PlaceInfo>();
      for (const [uuid, l] of Object.entries(deps.haulingData.locations())) {
        m.set(uuid, {
          name: l.name ?? null,
          parentName: l.parentName ?? null,
          system: l.system ?? null,
          type: l.type ?? null,
        });
      }
      return m;
    },
  });
  if (store.canRefresh() && !timer) {
    // Kick once now, then on a slow tick. `unref` so this never holds the process open.
    void store.refresh();
    timer = setInterval(() => { void store?.refresh(); }, REFRESH_MS);
    timer.unref?.();
  }
  return store;
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

/** The provenance block every response carries. */
function provenance(s: TradePriceStore, deps?: TradeDeps) {
  const t = s.current();
  return {
    source: t.source,
    fetchedAt: t.fetchedAt,
    /** The bundled snapshot's game version, when that is what is being served. */
    version: t.version,
    quotes: t.quotes.length,
    droppedOffline: t.droppedOffline,
    lastError: t.lastError,
    /** True when a refresh is even possible. False means "configured offline", which the widget
     *  must word differently from "we tried and failed". */
    canRefresh: s.canRefresh(),
    /** Systems with at least one BUY terminal, biggest first. The widget builds its filter from
     *  this rather than a hardcoded list, so a new system in a patch needs no code change - and
     *  it can never offer a choice that only ever returns nothing. */
    systems: buyableSystems(t.quotes),
    /** Where the log says the player is, or null. Only ever a DEFAULT for the filter. */
    here: deps?.system?.() ?? null,
  };
}

const qs = (u: string) => new URL(u, "http://x").searchParams;
const numParam = (p: URLSearchParams, k: string): number | null => {
  const raw = p.get(k);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};
const strParam = (p: URLSearchParams, k: string): string | null => {
  const v = (p.get(k) ?? "").trim();
  return v ? v : null;
};

/**
 * Handle a trade route. Returns true when it took the request, false to let the server's own
 * chain continue - which is what keeps the integration to a single line.
 */
export function tradeRoutes(
  url: string,
  req: { url?: string; method?: string },
  res: ServerResponse,
  deps: TradeDeps,
): boolean {
  if (!url.startsWith("/api/trade/")) return false;

  /**
   * 🔴 THE ONE WRITE IN THIS FILE - "that cargo is gone, stop listing it".
   *
   * Handled BEFORE the GET-only guard below, and it is the reason that guard is now a default
   * rather than a blanket rule. Read the file header: it says a write here "needs the loopback gate
   * that `/api/twitch/*` uses". It already has one, and a stronger one - `overlay-server.ts` refuses
   * every non-GET that is not from this machine, AND every request carrying a foreign `Origin`,
   * before `tradeRoutes` is ever called. So this route is loopback + same-origin by construction
   * and must not grow a second check that could drift from it.
   *
   * 🔑 THE LOT ID RIDES THE QUERY STRING, and the POST carries no body. `tradeRoutes` is handed a
   * `{ url, method }` shape rather than a real `IncomingMessage`, so reading a body would mean
   * widening the signature - i.e. a second hook into the server this file promises not to grow.
   * A synthetic local id is not personal data, so there is nothing here that a query string is the
   * wrong place for.
   */
  if (url === "/api/trade/journal/forget") {
    if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
    const id = strParam(qs(req.url ?? "/"), "lot");
    if (!id) { json(res, 400, { error: "lot_required" }); return true; }
    const gone = ensureJournal(deps).forget(id);
    // 🔑 `removed: false` is a 200, not a 404. The row is already off the list either way, which is
    // what the caller asked for, and a second click on a stale widget is not an error worth
    // colouring red. The flag is still reported so a caller CAN tell the two apart.
    json(res, 200, { removed: !!gone, lot: gone });
    return true;
  }

  if (req.method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }

  const s = ensure(deps);
  const table = s.current();
  const p = qs(req.url ?? "/");

  // What you actually did: real purchases and sales out of the log, with realised profit.
  if (url === "/api/trade/journal") {
    json(res, 200, ensureJournal(deps).view());
    return true;
  }

  if (url === "/api/trade/status") {
    json(res, 200, provenance(s, deps));
    return true;
  }

  if (url === "/api/trade/names") {
    json(res, 200, { names: tradableNames(table.quotes), ...provenance(s, deps) });
    return true;
  }

  if (url === "/api/trade/commodity") {
    const name = strParam(p, "name");
    if (!name) { json(res, 400, { error: "name_required" }); return true; }
    const hit = lookupCommodity(table.quotes, name, table.source);
    if (!hit) { json(res, 404, { error: "unknown_commodity", name, ...provenance(s, deps) }); return true; }
    json(res, 200, { ...hit, ...provenance(s, deps) });
    return true;
  }

  if (url === "/api/trade/routes") {
    // Capacity may be given outright or named by ship, because the widget knows the hull and the
    // player knows the hull, but neither reliably knows the number.
    let capacityScu = numParam(p, "capacity");
    let shipName: string | null = null;
    const ship = strParam(p, "ship");
    if (ship) {
      const hull = deps.haulingData.ship(ship);
      // 🔑 An unresolved hull gets its OWN error. Falling through to "capacity_required" would
      // blame the caller for omitting something it did send, and the real fault - a hull name we
      // do not carry - would never be visible.
      if (!hull && capacityScu === null) { json(res, 404, { error: "unknown_ship", ship, ...provenance(s, deps) }); return true; }
      if (hull) { capacityScu = capacityScu ?? hull.totalScu; shipName = hull.displayName ?? ship; }
    }
    if (!capacityScu || capacityScu <= 0) {
      // 🔑 No silent default. A made-up hold size silently changes every number on the screen,
      // and the widget has a real one to send.
      json(res, 400, { error: "capacity_required", ...provenance(s, deps) });
      return true;
    }
    const routes = findRoutes(table.quotes, {
      capacityScu,
      budget: numParam(p, "budget"),
      fromSystem: strParam(p, "fromSystem"),
      fromBody: strParam(p, "fromBody"),
      toSystem: strParam(p, "toSystem"),
      toBody: strParam(p, "toBody"),
      requireKnownStock: p.get("knownStock") === "1",
      maxAgeDays: numParam(p, "maxAgeDays"),
      limit: numParam(p, "limit") ?? 30,
    });
    json(res, 200, { routes, capacityScu, ship: shipName, ...provenance(s, deps) });
    return true;
  }

  json(res, 404, { error: "unknown_trade_route", url });
  return true;
}
