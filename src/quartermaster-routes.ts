/**
 * Quartermaster helper routes: item-name autocomplete, station list, station price
 * lookup, and SP Viewer fit fetch/price — every route the widget needs beyond the
 * plain store CRUD (which lives in overlay-server.ts next to the party routes).
 *
 * Own file for the same reason trade-routes.ts and verse-routes.ts have one: the
 * QM widget's data joins are nobody else's business, and a second consumer can
 * never grow into a fork of them by accident.
 *
 * 🔴 THE SIDE CAR DOES THE NETWORK, NEVER THE PAGE. The fit fetch hits SP Viewer's
 * API from here for the same three reasons the UEX proxy exists: one place to cache,
 * one place to time out, and no CORS/credential behaviour dependent on the user's
 * browser. The page only ever talks to us.
 *
 * All GETs here are PUBLIC-safe (names, stations, prices — the same data the Verse
 * Finder already serves); the fit POST is loopback-gated by the server's own
 * non-GET rule before it reaches us.
 */

import LZString from "lz-string";
import { searchItems, searchUnpriced, type SearchHit } from "./item-search.js";
import type { ItemShopTable, ShopItem } from "./item-shops.js";
import type { TradeTable } from "./trade-prices.js";
import type { Commodity } from "./mining-economy.js";

/** A station-level place, as a player says it. Derived from BOTH terminal tables so a
 *  kiosk station and an item-shop station list the same way. */
export interface QmPlace {
  /** Station/city/outpost name, e.g. "Port Tressler". */
  name: string;
  /** Disambiguator when two stations share a name, e.g. "Stanton · Hurston". */
  system: string | null;
  /** True when at least one commodity kiosk sits here (fuel/ammunition purchasable). */
  kiosk: boolean;
}

/** One autocomplete hit for the Stock item name field. */
export interface QmNameHit {
  name: string;
  /** "Commodity" for kiosk goods, else the shop category, else "Uncategorised". */
  category: string;
  /** Preferred unit for this thing: SCU for kiosk commodities, units otherwise. */
  unit: "SCU" | "units";
  /** Commodity uuid when this is a kiosk good — stored on the item so capture chips
   *  auto-join by uuid. Null for shop items (they join by nothing today). */
  commodityUuid: string | null;
  /** Cheapest known buy price, for the Supply modal's prefill. Null when unpriced. */
  price: number | null;
}

/* ── station list ───────────────────────────────────────────────────────────── */

/**
 * Station-level places, cached per table pair. Rebuilt when either table object is
 * swapped by a background refresh — keyed by identity, the same trick
 * verse-routes.ts uses for its terminal index.
 */
let placesCache: { key: string; places: QmPlace[] } | null = null;

/** Collapse a terminal name to its station: "Admin - Port Tressler" → "Port Tressler",
 *  "TDD - Trade and Development Division - Commons - Lorville" → "Lorville" (last part
 *  wins — TDD names carry the station last). Bare names pass through unchanged. */
function stationOf(terminalName: string): string {
  const parts = terminalName.split(" - ").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? terminalName;
}

export function qmPlaces(shops: ItemShopTable, trade: TradeTable | null): QmPlace[] {
  const key = `${shops.fetchedAt ?? "x"}:${shops.terminals.length}:${trade ? trade.fetchedAt ?? "x" : "none"}`;
  if (placesCache && placesCache.key === key) return placesCache.places;
  const map = new Map<string, QmPlace>();
  const add = (name: string, system: string | null, kiosk: boolean) => {
    if (!name) return;
    const p = map.get(name);
    if (p) { if (kiosk) p.kiosk = true; if (!p.system && system) p.system = system; return; }
    map.set(name, { name, system, kiosk });
  };
  // 🔑 THE NAME'S LAST SEGMENT IS THE STATION, NOT the `place` field: a shop terminal's
  // `place` is often the DISTRICT inside the station ("Green Imperial Housing Exchange"
  // for a shop AT GrimHEX, measured in the real table), so listing by `place` would
  // offer a district nobody would call the station. The derived station is what a
  // player says; the district stays an alias in terminalAtStation.
  for (const t of shops.terminals) add(stationOf(t.n), t.sys, false);
  if (trade) {
    for (const q of trade.quotes) add(q.place || stationOf(q.terminal), q.system, true);
  }
  const places = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  placesCache = { key, places };
  return places;
}

/* ── price at a station ─────────────────────────────────────────────────────── */

/** Terminal belongs to the station when EITHER form matches: the station derived from
 *  its name, or its `place` field. `place` is often the district inside the station
 *  ("Green Imperial Housing Exchange" at GrimHEX), so it cannot be the only gate —
 *  but it is the right alias when the station IS the place ("Lorville" at Lorville). */
function terminalAtStation(terminal: string, place: string | null, station: string): boolean {
  if (place && place === station) return true;
  return stationOf(terminal) === station;
}

export interface QmPriceQuote {
  price: number;
  /** Which terminal exactly, for the hint's "from X" line. */
  terminal: string;
  /** Epoch seconds of UEX's last report, for the "as of" line. Null when the bundled
   *  snapshot carries no date. */
  asOf: number | null;
  source: "commodity" | "item";
}

/** Cheapest buy at the named station for a commodity uuid, or for an item by uuid/name.
 *  Rentals are excluded on the item side (k:"rent"), per the rule that keeps a hire
 *  price from ever masquerading as a sale price. Returns null when nothing at that
 *  station sells it — refuse rather than fall back to another station's price.
 *
 *  🔑 THE COMMODITY MATCH IS BY NAME, NOT JUST "ANY ROW AT THE STATION": the trade table
 *  is name-keyed, so the caller hands in the commodity's name alongside the uuid and
 *  a row only counts when BOTH the station and the commodity match. Without the name
 *  gate, hydrogen at a station with no hydrogen would quote the station's Laranite. */
export function qmPriceAt(
  station: string,
  shops: ItemShopTable,
  trade: TradeTable | null,
  commodityUuid: string | null,
  commodityName: string | null,
  itemUuid: string | null,
  itemName: string | null,
): QmPriceQuote | null {
  // Commodity side first: the stock item stores the uuid the capture hook joins on, and
  // the name comes with it (the same economy row both of them were read from).
  if (commodityUuid && commodityName) {
    const lower = commodityName.toLowerCase();
    let best: QmPriceQuote | null = null;
    for (const q of trade?.quotes ?? []) {
      if (q.commodity.toLowerCase() !== lower) continue;
      if (!terminalAtStation(q.terminal, q.place, station)) continue;
      if (q.buy == null || q.buy <= 0) continue;
      if (!best || q.buy < best.price) {
        best = { price: q.buy, terminal: q.terminal, asOf: q.asOf, source: "commodity" };
      }
    }
    if (best) return best;
  }
  // Item side: uuid exact join first; then the name — exact, then a quote-stripped
  // comparison ("5CA Akura" must find "5CA 'Akura'"), then the shared scorer as the
  // last resort so a hand-typed near-miss still prices. All matches must still sell
  // AT THE STATION: a scorer hit is a name match, never a station fallback.
  const matched = new Set<ShopItem>();
  for (const it of shops.items) {
    if (itemUuid && it.u === itemUuid) { matched.add(it); continue; }
    if (!itemName) continue;
    const a = it.n.toLowerCase().replace(/[''"]/g, "");
    const b = itemName.toLowerCase().replace(/[''"]/g, "");
    if (a === b || a.replace(/[\s-]+/g, "") === b.replace(/[\s-]+/g, "")) matched.add(it);
  }
  if (!matched.size && itemName) {
    for (const h of searchItems(shops, itemName, { limit: 3, quotesPerItem: 1 })) {
      const it = shops.items.find((x) => x.n === h.name);
      if (it) matched.add(it);
    }
  }
  let best: QmPriceQuote | null = null;
  for (const it of matched) {
    for (const q of it.q) {
      if (q.k === "rent") continue; // 🔴 never quote a hire price as a sale price
      const term = shops.terminals[q.t];
      if (!term) continue;
      if (!terminalAtStation(term.n, term.place, station)) continue;
      if (!best || q.p < best.price) {
        best = { price: q.p, terminal: term.n, asOf: q.m ? q.m * 1000 : null, source: "item" };
      }
    }
  }
  return best;
}

/* ── item-name autocomplete ─────────────────────────────────────────────────── */

/** Capture-hook families get top billing: these are the things a hangar actually
 *  dispenses, and suggesting them first is the difference between autocomplete that
 *  helps and autocomplete that argues. */
const QM_FAMILIES = /^(hydrogen fuel|quantum fuel|ship ammunition|eva fuel|di-methyl fuel)/i;

export function qmItemNames(
  q: string,
  commodities: Record<string, Commodity>,
  shops: ItemShopTable,
  limit: number,
): QmNameHit[] {
  const query = q.trim();
  if (!query) return [];
  const lower = query.toLowerCase();
  const hits: QmNameHit[] = [];
  const seen = new Set<string>();
  // 1. Kiosk commodities — the capture families and anything else tradable. These are
  //    the rows a hangar's stock is actually made of.
  for (const [uuid, c] of Object.entries(commodities)) {
    const name = (c.name ?? "").trim();
    if (!name || name.includes("_")) continue; // internal placeholders, never suggestions
    if (!name.toLowerCase().includes(lower)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    hits.push({
      name,
      category: QM_FAMILIES.test(name) ? "Kiosk commodity" : "Commodity",
      unit: "SCU",
      commodityUuid: uuid,
      price: c.bestBuy,
    });
  }
  // 2. Priced shop items — same scorer the Verse Finder trusts, with a small cap so a
  //    commodity-dominant query still shows component results.
  const itemHits = searchItems(shops, query, { limit: Math.max(4, limit), quotesPerItem: 1 });
  for (const h of itemHits) {
    if (seen.has(h.name)) continue;
    seen.add(h.name);
    hits.push({
      name: h.name,
      category: h.category || "Shop item",
      unit: "units",
      commodityUuid: null,
      price: h.low,
    });
  }
  // 3. Unpriced-but-real catalogue names, so "no suggestion" can never be read as "no
  //    such thing" (the exact confusion searchUnpriced exists to prevent).
  if (hits.length < limit) {
    for (const h of searchUnpriced(shops, query, limit)) {
      if (seen.has(h.name)) continue;
      seen.add(h.name);
      hits.push({ name: h.name, category: h.category || "Uncategorised", unit: "units", commodityUuid: null, price: null });
    }
  }
  // Family rows first (the hangar's real stock), then alphabetical — a stable order so
  // typing feels deterministic rather than score-twitchy.
  hits.sort((a, b) => {
    const fam = (QM_FAMILIES.test(b.name) ? 1 : 0) - (QM_FAMILIES.test(a.name) ? 1 : 0);
    if (fam) return fam;
    return a.name.localeCompare(b.name);
  });
  return hits.slice(0, limit);
}

/* ── SP Viewer fit fetch + price ───────────────────────────────────────────── */

export interface QmFitComponent {
  /** Component name as SP Viewer's payload carried it. */
  name: string;
  /** Cheapest known non-rental price, or null when nothing sells it. */
  price: number | null;
}

export interface QmFitResult {
  ship: string | null;
  hullPrice: number | null;
  items: QmFitComponent[];
  /** Priced components + hull, when the hull priced. */
  total: number;
  unpricedCount: number;
  patch: string | null;
  build: string | null;
}

/** In-memory cache keyed by sharedid — a fit link pasted twice (Add then Manage, or a
 *  re-paste to refresh prices) must not re-fetch, and a fetch failure must not poison
 *  the cache. Capped, because a long evening of fit-tweaking should not grow it. */
const fitCache = new Map<string, QmFitResult>();
const FIT_CACHE_MAX = 24;
const FIT_TIMEOUT_MS = 8000;

/** Extract {ship, sharedid} from a pasted SP Viewer URL. Accepts the full performance
 *  link and a bare sharedid. Refuses everything else rather than guessing a fit out of
 *  an arbitrary URL. */
export function parseFitUrl(raw: string): { ship: string | null; sharedid: string } | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!/^(https?:$)/.test(u.protocol) || !/spviewer\.eu$/i.test(u.hostname)) return null;
    const ship = u.searchParams.get("ship");
    const sharedid = u.searchParams.get("loadout");
    if (!sharedid) return null;
    return { ship: ship || null, sharedid };
  } catch {
    // Not a URL. A bare token is only accepted when it looks like one of their ids:
    // alphanumerics, 6-64 chars (their generator is 8 random bytes, base36/hex-ish).
    if (/^[A-Za-z0-9_-]{6,64}$/.test(s)) return { ship: null, sharedid: s };
    return null;
  }
}

/** Walk a decoded loadout payload and collect component-name strings. 🔴 TOLERANT BY
 *  DESIGN: the payload's internal schema is theirs and unverifiable without a real
 *  shared link (their ids are unguessable), so rather than a brittle path map this
 *  collects every string that names something our price tables know. Anything it
 *  misses shows up as an unpriced component — visible, never silently dropped. */
function componentNamesOf(loadout: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") {
      const s = v.trim();
      // Plausible item name: 2-70 chars, not an internal token, not a sentence.
      if (s.length >= 2 && s.length <= 70 && !/^[a-z0-9_]+$/.test(s) && !/[{}]|::/.test(s) && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") { for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1); }
  };
  walk(loadout, 0);
  return out;
}

/** Price one component name against the shop table (exact name, then the search scorer
 *  for a near-miss), rentals excluded. Null when nothing sells it. */
function priceComponent(name: string, shops: ItemShopTable): number | null {
  const exact = shops.items.find((it) => it.n.toLowerCase() === name.toLowerCase());
  if (exact) {
    let best: number | null = null;
    for (const q of exact.q) { if (q.k !== "rent" && (best == null || q.p < best)) best = q.p; }
    if (best != null) return best;
  }
  // Near-miss through the shared scorer: SP Viewer names sometimes carry the
  // manufacturer prefix ours do not. First hit with a price wins.
  const hit: SearchHit | undefined = searchItems(shops, name, { limit: 3, quotesPerItem: 1 })[0];
  return hit?.low ?? null;
}

/** Hull price for a ship type from the dealer rows (category "Ships", section
 *  "Vehicles"), rentals excluded — the same table the Verse Finder quotes hulls from. */
function priceHull(spvClass: string | null, shipName: string | null, shops: ItemShopTable): number | null {
  const wanted = (spvClass ?? "").toLowerCase().replace(/_/g, " ");
  const displayName = (shipName ?? "").toLowerCase();
  let best: number | null = null;
  for (const it of shops.items) {
    if (it.c !== "Ships") continue;
    if (it.s !== "Vehicles" && it.s !== "Ships") continue;
    const name = it.n.toLowerCase();
    const match = wanted
      ? name === wanted || name.replace(/[_-]/g, " ") === wanted
      : displayName && (name === displayName || name.includes(displayName) || displayName.includes(name));
    if (!match) continue;
    for (const q of it.q) {
      if (q.k === "rent") continue; // 🔴 never quote a hire price as a sale price
      if (best == null || q.p < best) best = q.p;
    }
  }
  return best;
}

/** Fetch a shared fit, decompress it, price it. Never throws — a fit we cannot read is
 *  a sentence for the user, not a crash for the sidecar. */
export async function qmFetchFit(
  rawUrl: string,
  shops: ItemShopTable,
): Promise<{ ok: true; fit: QmFitResult } | { ok: false; error: string }> {
  const parsed = parseFitUrl(rawUrl);
  if (!parsed) return { ok: false, error: "That does not look like an SP Viewer fit link (it should be spviewer.eu/performance?ship=…&loadout=…)" };
  const cached = fitCache.get(parsed.sharedid);
  if (cached) return { ok: true, fit: cached };
  let body: unknown;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FIT_TIMEOUT_MS);
    try {
      const res = await fetch(`https://data.spviewer.eu/spvapi/loadouts?sharedid=${encodeURIComponent(parsed.sharedid)}`, {
        headers: { "X-Requested-From": "scspv-front-v1", Accept: "application/json" },
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => null)) as
        | { data?: { loadouts?: { build?: unknown; patch?: unknown; loadoutdata?: unknown; loadoutDataEncoded?: unknown } | Record<string, unknown> } }
        | null;
      if (!res.ok || !json) throw new Error(`HTTP ${res.status}`);
      const row = json.data?.loadouts ?? null;
      if (!row || typeof row !== "object") throw new Error("not found");
      body = row;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: `Could not fetch that fit from SP Viewer (${(e as Error).message}). Check the link, or type the value by hand.` };
  }
  const row = body as { build?: unknown; patch?: unknown; loadoutdata?: unknown; loadoutDataEncoded?: unknown };
  const compressed = row.loadoutdata ?? row.loadoutDataEncoded;
  let loadout: unknown = null;
  if (typeof compressed === "string" && compressed) {
    loadout = LZString.decompressFromEncodedURIComponent(compressed)
      ?? LZString.decompressFromBase64(compressed)
      ?? LZString.decompress(compressed);
  }
  if (!loadout || typeof loadout !== "object") {
    return { ok: false, error: "SP Viewer returned that fit in a form this build cannot read — prices are still typeable by hand." };
  }
  // Price every component name we recognise, hull included. Unpriced components stay
  // visible as null rows so the breakdown says what it could not price.
  const items: QmFitComponent[] = componentNamesOf(loadout).map((name) => ({ name, price: priceComponent(name, shops) }));
  const hullPrice = priceHull(parsed.ship, null, shops);
  const priced = items.filter((i) => i.price != null);
  const total = priced.reduce((t, i) => t + (i.price ?? 0), 0) + (hullPrice ?? 0);
  const fit: QmFitResult = {
    ship: parsed.ship,
    hullPrice,
    items,
    total: Math.round(total),
    unpricedCount: items.length - priced.length,
    patch: typeof row.patch === "string" ? row.patch : null,
    build: typeof row.build === "string" ? row.build : null,
  };
  fitCache.set(parsed.sharedid, fit);
  if (fitCache.size > FIT_CACHE_MAX) {
    const oldest = fitCache.keys().next().value;
    if (oldest) fitCache.delete(oldest);
  }
  return { ok: true, fit };
}

/* ── route mount ────────────────────────────────────────────────────────────── */

export interface QmRouteDeps {
  /** The shop table, read at request time — a background refresh may swap it. */
  shops: () => ItemShopTable;
  /** The commodity quotes table, borrowed read-only from trade (same rule as the Verse
   *  Finder: one table, one refresh clock, never two). Null when trade has none. */
  trade: () => TradeTable | null;
  /** The commodity economy map (uuid → Commodity), for the names + uuid join. */
  commodities: () => Record<string, Commodity>;
}

/** Serve the four QM helper routes. Returns true when the request was handled. */
export function quartermasterRoutes(
  url: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  deps: QmRouteDeps,
): boolean {
  const p = new URL(req.url ?? "/", "http://localhost");

  if (url === "/api/quartermaster/item-names" && req.method === "GET") {
    const q = p.searchParams.get("q") ?? "";
    const limitRaw = Number(p.searchParams.get("limit") ?? 12);
    const limit = isFinite(limitRaw) ? Math.max(1, Math.min(24, Math.round(limitRaw))) : 12;
    const hits = qmItemNames(q, deps.commodities(), deps.shops(), limit);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ hits }));
    return true;
  }

  if (url === "/api/quartermaster/places" && req.method === "GET") {
    const places = qmPlaces(deps.shops(), deps.trade());
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ places }));
    return true;
  }

  if (url === "/api/quartermaster/price" && req.method === "GET") {
    const station = (p.searchParams.get("station") ?? "").trim();
    const commodityUuid = (p.searchParams.get("commodityUuid") ?? "").trim() || null;
    const commodityName = (p.searchParams.get("commodityName") ?? "").trim() || null;
    const itemUuid = (p.searchParams.get("itemUuid") ?? "").trim() || null;
    const itemName = (p.searchParams.get("itemName") ?? "").trim() || null;
    if (!station) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "station required" }));
      return true;
    }
    const quote = qmPriceAt(station, deps.shops(), deps.trade(), commodityUuid, commodityName, itemUuid, itemName);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ quote }));
    return true;
  }

  // Loopback-gated by the server's non-GET rule before it reaches here.
  if (url === "/api/quartermaster/fit" && req.method === "POST") {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        const fitUrl = typeof body.url === "string" ? body.url : "";
        const result = await qmFetchFit(fitUrl, deps.shops());
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.ok ? { fit: result.fit } : { error: result.error }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    })();
    return true;
  }

  return false;
}