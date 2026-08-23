/**
 * VERSE FINDER - THE SIDECAR SURFACE, DELIBERATELY ALL IN ONE FILE.
 *
 * 🔴 `overlay-server.ts` IS THE BUSIEST FILE IN THE REPO and four separate efforts have edited it.
 * So this subsystem touches it in exactly ONE place: one import and one call. Every route, every
 * piece of state and every default lives here, and anything added to this feature later belongs
 * in this file too - the moment a second hook appears in the server, that promise is gone. Same
 * discipline as `trade-routes.ts`, for the same reason.
 *
 * Routes, all GET, all read-only:
 *
 *   /api/verse/status          where the table came from, how old it is, and what it cannot say
 *   /api/verse/search?q=       ranked items, each with every shop that sells it
 *
 * -- WHAT "ITEM" MEANS HERE, WIDENED 2026-08-22 ----------------------------------------------
 *
 * One box, three sources, and the merge is what makes it one feature rather than three:
 *
 *   SHOP ITEMS   the site's table. Unchanged.
 *   SHIPS        rows in that same table, because Sub ruled a ship is not different from any other
 *                item - "people just need to know where it is and know how much it costs". Nothing
 *                in this file knows a ship from a magazine; a rental quote is labelled and that is
 *                the only difference the whole path carries.
 *   COMMODITIES  BORROWED from the trade subsystem via `deps.commodities`, adapted by
 *                `verse-commodities.ts`. Never a second store - see that dep's note.
 *
 * 🔑 THEY ARE SCORED BY ONE SCORER AND MERGED INTO ONE RANKED LIST. A player typing a name does not
 * know which of our tables the answer lives in, so ranking by source would make the order depend on
 * our storage rather than on what they typed.
 *
 * 🔴 AND A BLANK RESULT NOW SAYS WHICH KIND OF BLANK IT IS. `unpriced` names catalogued items no
 * shop sells (two thirds of the catalogue) and `sellOnly` names commodities you can only sell (36
 * of 122). Both are computed ONLY when the search found nothing, because that is the one moment
 * they are an answer rather than noise.
 *
 * 🔑 EVERY RESPONSE CARRIES `source` AND THE TABLE'S AGE. Sub's requirement is that the user knows
 * when they are on a fallback, and a widget can only say so on the screen they are looking at.
 *
 * ⚠️ These are GETs and they are unauthenticated like the rest of the widget API, which is
 * LAN-reachable (OBS browser sources on another PC). Acceptable here because nothing in this file
 * spends a credential, writes anything, or reveals anything the player did not already publish -
 * it reads a public shop table. If a WRITE is ever added it needs the loopback gate `/api/twitch/*`
 * uses. See references/security.md.
 */
import type { ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ItemShopStore, type ItemShopTable } from "./item-shops.js";
import { searchItems, searchUnpriced, provenance, type SearchHit, type ResolvedQuote, type ObservedQuote } from "./item-search.js";
import type { ObservedPriceStore } from "./observed-prices.js";
import { searchCommodities, sellOnlyMatches } from "./verse-commodities.js";
import type { TradeTable } from "./trade-prices.js";
import {
  buildTerminalIndex, orderByProximity, systemKey,
  type TerminalIndex, type LocationRecord, type ProximityOrder,
} from "./verse-proximity.js";
import { collectOriginSignals, originDepsFor, type SignalInputs } from "./origin-signals.js";
import { resolveOrigin, originSummary, type OriginVerdict } from "./player-origin.js";
import { deriveGateways, loadPlaces, type GatewayInfo, type Vec3 } from "./travel-model.js";
import { matchLocationToken } from "./hauling-locations.js";
import type { HaulingDataStore } from "./hauling-data.js";

/** How often the sidecar re-asks the endpoint.
 *
 *  🔑 Six hours, not the ten minutes trade uses, and the difference is measured rather than
 *  arbitrary: shop prices were never once observed to move over a month (23,658 of 23,747 rows),
 *  so a tighter poll would spend bandwidth re-fetching numbers that do not change. The widget must
 *  not advertise this interval either way - the honest figure is each quote's own age. */
const REFRESH_MS = 6 * 60 * 60 * 1000;

/** Default endpoint. Until the site route is deployed the fetch fails and the store sits on the
 *  bundled snapshot, which is the designed behaviour rather than a broken state.
 *
 *  🔑 `SC_VERSE_URL` overrides it - point it at a local site dev server to exercise the live path.
 *  Set it to the empty string to run deliberately offline on the bundle. */
export const DEFAULT_VERSE_URL = "https://subliminal.gg/api/sc/item-prices";

function configuredUrl(explicit: string | null | undefined): string | null {
  if (explicit !== undefined) return explicit;
  const env = process.env.SC_VERSE_URL;
  if (env !== undefined) return env.trim() || null;
  return DEFAULT_VERSE_URL;
}

/** What this file needs from the mission tracker, declared structurally so it stays a read-only
 *  borrow rather than a dependency on the tracker's shape. */
interface TrackerLike {
  /** Item UUIDs the dataset knows under this blueprint name. Empty when it is not a blueprint. */
  itemUuidsForName(name: string): string[];
  /** Whether the player's collection already holds it. */
  isAlreadyOwned(blueprintName: string): boolean;
}

export interface VerseDeps {
  dataDir: string;
  userDir: string;
  /** Endpoint override. `null` disables refreshing, which is a supported configuration. */
  url?: string | null;
  /** The mission tracker, for the craft cross-link. Optional: without it the widget simply never
   *  mentions crafting, which is a smaller loss than the route failing. */
  tracker?: TrackerLike;
  /**
   * Where the session currently thinks the player is. Optional throughout: without it the widget
   * orders by price and says plainly that it does not know where you are, which is the same
   * honest state a player who has just launched the app is in anyway.
   */
  locationSignals?: () => SignalInputs;
  /** Hauling reference data, used ONLY to resolve the game's own location tokens (`RR_ARC_LEO`).
   *  Optional: without it a token that is not literally a place name simply does not resolve. */
  haulingData?: HaulingDataStore;
  /**
   * The commodity price table, borrowed READ-ONLY from the trade subsystem.
   *
   * 🔴 A BORROW, NOT A SECOND STORE. `trade-routes.ts` owns the refresh clock, the disk cache and
   * the journal; this file must never build its own, or the Verse Finder and the Trade widget could
   * quote different prices for the same commodity at the same moment - the in-app version of the
   * exact drift the site-side join exists to prevent.
   *
   * Optional like everything else here: without it the widget simply never mentions commodities,
   * which is a smaller loss than the search failing.
   */
  commodities?: () => TradeTable | null;
  /**
   * Observed prices — what this player actually paid, read out of `game.log`.
   *
   * 🔴 A BORROW, NOT A SECOND STORE, exactly like `commodities` above. `price-feed.ts` owns the
   * confirmation gates and the state file; this widget only reads. Building a second store here
   * would mean a second answer to "did that purchase go through", and the Verse Finder and the
   * Ledger could then disagree about a trade the player made once.
   *
   * Optional like everything else here: without it the widget simply never mentions receipts,
   * which is the state every player is in before they buy anything anyway.
   */
  observed?: () => ObservedPriceStore | null;
  /**
   * A commodity's display name -> its `resourceGUID`.
   *
   * 🔴 THIS EXISTS BECAUSE A COMMODITY HIT CARRIES NO UUID AND AN OBSERVATION IS KEYED BY ONE.
   * `verse-commodities.ts` builds its rows from the UEX trade table, which is keyed by NAME and has
   * never known the game's UUID (`uuid: null`, deliberately). The purchase line, meanwhile, states
   * `resourceGUID` and nothing else. So the one place these two halves can meet is the name, and it
   * is resolved through the app's OWN `commodities.json` rather than by string-matching the two
   * tables against each other.
   *
   * ⚠️ IT IS THE ONE NAME MATCH IN THIS FEATURE, AND IT IS DELIBERATELY NARROW. Everywhere else the
   * join is the game's own UUID with no matching at all. Here the two sides are UEX's name and
   * CIG's name for the same commodity; they agree today on every commodity Sub has traded, but
   * they come from different publishers and could drift. A miss costs one receipt not being shown,
   * never a wrong price against the wrong commodity — the lookup either resolves to the right UUID
   * or to nothing.
   */
  commodityUuid?: (name: string) => string | null;
}

let store: ItemShopStore | null = null;
let timer: NodeJS.Timeout | null = null;

function ensure(deps: VerseDeps): ItemShopStore {
  if (store) return store;
  store = new ItemShopStore({
    dataDir: deps.dataDir,
    stateDir: deps.userDir,
    url: configuredUrl(deps.url),
  });
  if (store.canRefresh() && !timer) {
    // One refresh now so a session that starts online is current, then on the slow tick.
    void store.refresh();
    timer = setInterval(() => { void store?.refresh(); }, REFRESH_MS);
    // Never hold the process open for a price table.
    timer.unref?.();
  }
  return store;
}

/* ── Proximity: where the player is, and how far each shop is from there ─────────────────────── */

/**
 * All of this is built ONCE and cached, because it is derived from files that do not change while
 * the app runs. The terminal index is the exception: it is rebuilt when the shop TABLE changes
 * (a live refresh swaps it), which is why it is keyed on the terminals array itself.
 *
 * 🔴 EVERY PIECE IS OPTIONAL. A build with no `locations-xyz`, a session with no location signal,
 * a table whose terminals do not resolve — each degrades to a coarser ordering that says what it
 * is, and none of them may fail the search. Somebody typing an item name must always get their
 * answer; where they are is an enhancement to it, never a precondition.
 */
interface ProxCache {
  locations: Record<string, LocationRecord>;
  gateways: GatewayInfo[];
  posOf: (id: string) => Vec3 | null;
  systemOf: (id: string) => string | null;
  names: Map<string, string>;
}
let prox: ProxCache | null = null;
let termIndex: { forTerminals: unknown; index: TerminalIndex } | null = null;

function proxCache(dataDir: string): ProxCache | null {
  if (prox) return prox;
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "locations.json"), "utf8")) as
      { locations?: Record<string, LocationRecord> };
    const locations = raw.locations ?? {};
    if (!Object.keys(locations).length) return null;
    const places = loadPlaces(dataDir);
    const names = new Map<string, string>();
    for (const [id, rec] of Object.entries(locations)) if (rec?.name) names.set(id, rec.name);
    prox = {
      locations,
      gateways: deriveGateways(locations as never, places),
      posOf: (id) => (places[id]
        ? { x: places[id].pos[0], y: places[id].pos[1], z: places[id].pos[2] } : null),
      // 🔑 travel-model wants a system TOKEN here (it compares them to build the gateway path),
      // unlike `originDepsFor`'s systemOf which returns a star id for the containment check. Two
      // different questions that happen to share a name; do not merge them.
      systemOf: (id) => systemKey(locations[id]?.system) || null,
      names,
    };
    return prox;
  } catch {
    // A build without the location data must still answer searches.
    return null;
  }
}

function terminalIndex(table: ItemShopTable, locations: Record<string, LocationRecord>): TerminalIndex {
  if (termIndex && termIndex.forTerminals === table.terminals) return termIndex.index;
  const index = buildTerminalIndex(table.terminals, locations);
  termIndex = { forTerminals: table.terminals, index };
  return index;
}

/** The verdict plus a ready-made orderer, or null when we cannot say anything useful. */
function proximity(deps: VerseDeps, table: ItemShopTable): {
  origin: OriginVerdict;
  order: (q: ResolvedQuote[]) => ProximityOrder;
} | null {
  const c = proxCache(deps.dataDir);
  if (!c) return null;
  const inputs = deps.locationSignals?.() ?? {};
  const signals = collectOriginSignals(inputs, {
    locations: c.locations,
    // The game's own tokens, through the resolver that already knows them. Pointed at the STARMAP
    // names so it returns starmap ids — the namespace everything downstream is keyed by.
    resolveToken: deps.haulingData
      ? (t) => matchLocationToken(t, c.names, deps.haulingData!)
      : undefined,
  });
  const origin = resolveOrigin(signals, originDepsFor(c.locations));
  const index = terminalIndex(table, c.locations);
  return {
    origin,
    order: (q) => orderByProximity(q, {
      index, locations: c.locations,
      travel: { gateways: c.gateways, posOf: c.posOf, systemOf: c.systemOf },
      origin,
    }),
  };
}

/** What the widget renders beside the eye. Kept whole rather than split across fields so the UI
 *  cannot assemble a claim we did not make. */
function originPayload(origin: OriginVerdict) {
  return {
    tier: origin.tier,
    label: origin.label,
    summary: originSummary(origin),
    ageMin: origin.ageMin,
    stale: origin.stale,
    from: origin.from,
    howToImprove: origin.howToImprove,
  };
}

/**
 * 🔑 THE CRAFT CROSS-LINK - the one thing this widget can do that no other SC tool can.
 *
 * UEX ships the game's item UUID and our blueprint dataset is keyed by the same one, so 723 of the
 * buyable items are also blueprints the app already tracks. That turns "where can I buy this" into
 * "buy it at X, or craft it - you already own the blueprint".
 *
 * ⚠️ THE UUID IS THE JOIN, NOT THE NAME. Names DO agree character-for-character today (measured),
 * but a name match alone would silently attach a blueprint to the wrong item the first time CIG
 * ships two things called the same thing - which the mission data has already proved it does. So
 * the name is only used to ASK the dataset, and the answer is accepted only when a returned UUID
 * equals the one UEX gave us. No uuid on either side means no claim.
 */
/**
 * What the player has actually paid for this, if anything.
 *
 * 🔑 THE JOIN IS THE GAME'S OWN UUID, so there is no name matching anywhere: `itemClassGUID` from
 * the purchase line IS `ShopItem.u`, and `resourceGUID` IS the key of `commodities.json`. Measured
 * 2026-08-23: 89 of the 128 distinct items in Sub's logs (69.5%) resolve to a Verse Finder row.
 * The rest are things UEX simply has no shop for — a receipt for one of those is still recorded,
 * it just has no row here to hang off yet.
 *
 * 🔴 THE KIND DECIDES THE NAMESPACE. Items and commodities are keyed by different UUIDs from
 * different datasets; looking one up in the other's namespace would silently return nothing
 * forever, which is indistinguishable from "you have never bought this".
 *
 * ⚠️ A SELL is only ever offered for a commodity, and only alongside its buy rows. An item cannot
 * be sold back at all (no sell verb exists in 533 logs), so an item row can never carry one.
 */
function observedFor(hit: SearchHit, deps: VerseDeps): ObservedQuote[] | undefined {
  const store = deps.observed?.();
  if (!store) return undefined;
  const kind = hit.kind === "commodity" ? "commodity" : "item";
  // An ITEM row carries the game's UUID outright. A COMMODITY row never does — see
  // `commodityUuid` — so it is resolved from the name through our own dataset.
  const id = kind === "commodity" ? hit.uuid ?? deps.commodityUuid?.(hit.name) ?? null : hit.uuid;
  if (!id) return undefined;
  const rows = [
    ...store.latestPerTerminal(kind, id, "buy"),
    // Commodities only — see above. Shown so a player who sold Laranite here can see what they
    // got, which the survey half of the widget cannot tell them at all.
    ...(kind === "commodity" ? store.latestPerTerminal(kind, id, "sell") : []),
  ];
  if (!rows.length) return undefined;
  return rows
    .sort((a, b) => b.at - a.at)
    .slice(0, OBSERVED_SHOWN)
    .map((r) => ({
      terminal: r.terminal,
      price: r.unitPrice,
      // Seconds, to match `ResolvedQuote.asOf` — the widget's age helpers are shared and a
      // milliseconds value would render as a date in 1970 without failing anything.
      asOf: Math.round(r.at / 1000),
      quantity: r.quantity,
      ...(r.side === "sell" ? { side: "sell" as const } : {}),
    }));
}

/** Receipts shown per item. A player who buys ammunition every session has dozens; the newest few
 *  are the answer to "what does this cost now", and the rest are history the widget does not have
 *  room to be honest about. */
const OBSERVED_SHOWN = 3;

function craftInfo(hit: SearchHit, tracker: TrackerLike | undefined): { craftable: true; owned: boolean } | null {
  if (!tracker || !hit.uuid) return null;
  let uuids: string[];
  try { uuids = tracker.itemUuidsForName(hit.name) ?? []; } catch { return null; }
  if (!uuids.some((u) => (u || "").toLowerCase() === hit.uuid)) return null;
  let owned = false;
  try { owned = tracker.isAlreadyOwned(hit.name); } catch { owned = false; }
  return { craftable: true, owned };
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(s);
}

function qs(u: string): URLSearchParams {
  const i = u.indexOf("?");
  return new URLSearchParams(i < 0 ? "" : u.slice(i + 1));
}

function intParam(p: URLSearchParams, k: string, dflt: number): number {
  const raw = p.get(k);
  if (raw === null) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

export function verseRoutes(
  url: string,
  req: { url?: string; method?: string },
  res: ServerResponse,
  deps: VerseDeps,
): boolean {
  if (!url.startsWith("/api/verse/")) return false;
  if (req.method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }

  const s = ensure(deps);
  const table = s.current();
  const p = qs(req.url ?? "/");

  if (url === "/api/verse/status") {
    const px = proximity(deps, table);
    json(res, 200, { ...provenance(table), origin: px ? originPayload(px.origin) : null });
    return true;
  }

  if (url === "/api/verse/search") {
    const q = (p.get("q") ?? "").trim();
    const px = proximity(deps, table);
    const limit = intParam(p, "limit", 20);
    const shops = intParam(p, "shops", 8);
    // 🔴 One ORDER per response, not per item. `basis` and `note` describe how well we know where
    // the player is, which is a property of the session — letting it vary row by row would invite
    // the UI to print a different confidence beside each shop for the same single reading.
    let order: ProximityOrder | null = null;
    const orderQuotes = px
      ? (quotes: ResolvedQuote[]) => { const r = px.order(quotes); order = r; return r.quotes; }
      : undefined;

    // 🔑 Commodities are scored by the SAME scorer and merged into ONE list, not appended as a
    // second section. A player typing a name does not know or care which of our two tables the
    // answer lives in, and stapling the two together would make the ranking depend on our storage
    // rather than on what they typed. `sort` is stable in V8, so equal scores keep item-then-
    // commodity order, which is only a tie-break and never a section.
    let commodityTable: TradeTable | null = null;
    try { commodityTable = deps.commodities?.() ?? null; } catch { commodityTable = null; }
    const hits = [
      ...searchItems(table, q, { limit, quotesPerItem: shops, orderQuotes }),
      ...searchCommodities(commodityTable, q, { limit, quotesPerItem: shops, orderQuotes }),
    ].sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, limit);

    // 🔴 WHAT TO SAY WHEN THERE IS NOTHING TO SELL YOU. Both of these exist so that a blank result
    // can state WHICH kind of blank it is — they are computed only when the search found nothing,
    // because that is the only moment they are an answer rather than noise.
    const nothing = q && !hits.length;
    json(res, 200, {
      query: q,
      results: hits.map((h) => ({ ...h, craft: craftInfo(h, deps.tracker), observed: observedFor(h, deps) })),
      unpriced: nothing ? searchUnpriced(table, q) : [],
      sellOnly: nothing ? sellOnlyMatches(commodityTable, q) : [],
      origin: px ? originPayload(px.origin) : null,
      // Null when nothing was ordered at all — an empty result set never ran the orderer, and
      // claiming a basis for zero rows would be a statement about data we never looked at.
      order: order ? { basis: (order as ProximityOrder).basis, note: (order as ProximityOrder).note } : null,
      ...provenance(table),
    });
    return true;
  }

  json(res, 404, { error: "unknown_verse_route" });
  return true;
}
