/**
 * TRADE - THE SIDECAR SURFACE, DELIBERATELY ALL IN ONE FILE.
 *
 * 🔴 `overlay-server.ts` IS BEING RESTRUCTURED BY ANOTHER FLIGHT AS THIS IS WRITTEN, so this
 * subsystem touches it in exactly ONE place: one import and one call. Every route, every piece of
 * state and every default lives here. Anything added to this feature later belongs in this file
 * too - the moment a second hook appears in the server, that promise is gone.
 *
 * Routes, all GET, all read-only:
 *
 *   /api/trade/status              where the prices came from and how old they are
 *   /api/trade/names               commodity names that can be BOUGHT somewhere (autocomplete)
 *   /api/trade/commodity?name=     one commodity: every terminal, as ranges
 *   /api/trade/routes?...          buy-low/sell-high runs, ranked
 *
 * 🔑 EVERY RESPONSE CARRIES `source` AND THE TABLE'S AGE, not just the ones about prices. Sub's
 * requirement was that the user knows when they are on the fallback, and a widget can only say so
 * on the screen the user is actually looking at.
 *
 * ⚠️ These are GETs and they are unauthenticated like the rest of the widget API, which is
 * LAN-reachable (OBS browser sources on another PC). That is acceptable here because nothing in
 * this file spends a credential, writes anything, or reveals anything the player did not already
 * publish - it reads a public price table. If a WRITE is ever added, it needs the loopback gate
 * that `/api/twitch/*` uses. See references/security.md.
 */
import type { ServerResponse } from "node:http";
import { TradePriceStore, type PlaceInfo, type BundledCommodity } from "./trade-prices.js";
import { findRoutes, lookupCommodity, tradableNames, buyableSystems } from "./trade-finder.js";

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
}

let store: TradePriceStore | null = null;
let timer: NodeJS.Timeout | null = null;

/** Build the store once, and start the refresh tick. Idempotent. */
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
  if (req.method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }

  const s = ensure(deps);
  const table = s.current();
  const p = qs(req.url ?? "/");

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
