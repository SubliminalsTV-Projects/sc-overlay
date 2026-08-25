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
import {
  searchItems, searchUnpriced, provenance,
  type SearchHit, type ResolvedQuote, type QuoteContext, type QuoteConfirmation,
} from "./item-search.js";
import {
  buildPlacer, foldsOnto, fromShopPlacesFile, fromShopTerminals, placerCoverage,
  type ShopPlacement, type ShopPlacer,
} from "./shop-placement.js";
import type { ObservedPriceStore } from "./observed-prices.js";
import type { PoolQuote } from "./price-pool.js";
import { searchCommodities, sellOnlyMatches } from "./verse-commodities.js";
import type { TradeTable } from "./trade-prices.js";
import {
  buildTerminalIndex, orderByProximity, reserveTierRows, systemKey,
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
   * The COMMUNITY price pool — what everybody else has paid, fetched from the site.
   *
   * 🔴 A BORROW like the two above, and the reason it is a separate dependency from `observed` is
   * that the two answer different questions and only one of them can be wrong about you. Your own
   * receipt is a fact about you at n=1; a pooled quote is a median over strangers and carries a
   * contributor count. Merging the STORES would lose that distinction; merging the ROWS at render
   * time, which is what `observedFor` does, keeps it.
   *
   * Optional: without it the widget shows only this player's own receipts, which is exactly the
   * state the feature was in before the pool existed.
   */
  pool?: () => {
    forId(kind: "item" | "commodity", id: string): PoolQuote[];
    confirmThreshold(): number;
    /** Reported on `/api/verse/status` so a diagnostics report can tell an EMPTY pool apart from
     *  an unreachable one. On screen those look identical and they want opposite responses. */
    status(): { quotes: number; entries: number; source: string; fetchedAt: number | null; lastError: string | null; url: string | null; confirmAt: number };
  } | null;
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

/* ── The shop-token → place lookup ───────────────────────────────────────────────────────────── */

/**
 * Built once from BOTH shipped placement files, merged per token by `mergePlacements`.
 *
 *   `data/shop-terminals.json`  flight `shoploc`'s log replay — 83 tokens, read in its own schema.
 *   `data/shop-places.json`     the hand-curated join map, normalised.
 *
 * 🔑 BOTH ARE READ AT RUNTIME RATHER THAN PRE-MERGED INTO ONE FILE, which is what makes `shoploc`'s
 * next pass free: dropping in a newer `shop-terminals.json` improves every fold and every placement
 * with no regeneration step and no code change. Pre-merging would have made this app's copy a
 * snapshot that silently goes stale, and the two files come from different efforts on different
 * clocks.
 *
 * 🔴 A MISSING FILE IS A SUPPORTED STATE, not an error — either of them, or both. Without them
 * nothing folds and nothing is placed, every confirmation counts as unplaced, and the widget draws
 * the survey exactly as it did before the pool existed. Same rule every other optional piece of
 * this feature follows: somebody typing an item name must always get their answer.
 */
let placerCache: { placer: ShopPlacer; parts: ShopPlacement[] } | null = null;

function readPlacements(dataDir: string, file: string, adapt: (doc: unknown) => ShopPlacement[]): ShopPlacement[] {
  try {
    return adapt(JSON.parse(readFileSync(join(dataDir, file), "utf8")));
  } catch {
    return [];
  }
}

function shopPlacer(dataDir: string): { placer: ShopPlacer; parts: ShopPlacement[] } {
  if (placerCache) return placerCache;
  const parts = [
    ...readPlacements(dataDir, "shop-terminals.json", fromShopTerminals),
    ...readPlacements(dataDir, "shop-places.json", fromShopPlacesFile),
  ];
  placerCache = { placer: buildPlacer(parts), parts };
  return placerCache;
}

function terminalIndex(table: ItemShopTable, locations: Record<string, LocationRecord>): TerminalIndex {
  if (termIndex && termIndex.forTerminals === table.terminals) return termIndex.index;
  const index = buildTerminalIndex(table.terminals, locations);
  termIndex = { forTerminals: table.terminals, index };
  return index;
}

/** The verdict, a ready-made orderer, and the two tables a confirmation needs to place itself.
 *  Null when we cannot say anything useful about where the player is. */
function proximity(deps: VerseDeps, table: ItemShopTable): {
  origin: OriginVerdict;
  order: (q: ResolvedQuote[]) => ProximityOrder;
  locations: Record<string, LocationRecord>;
  index: TerminalIndex;
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
    locations: c.locations,
    index,
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
    // Which terminal inside the station, when a terminal is what placed the player. Never a
    // smaller place — see `OriginSignal.detail`; the widget shows it and nothing measures from it.
    detail: origin.detail,
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
/* ── Community confirmations: ONE list, not two ──────────────────────────────────────────────── */

/**
 * 🔴 THE REWORK, 2026-08-24 (flight `onerow`). THE OLD DESIGN WAS A SECOND LIST AND IT HAD TO STOP
 * BEING ONE.
 *
 * `poolfill` shipped community prices as a `SEEN IN GAME` block drawn above the shop list. The DATA
 * was right and the presentation was not. Sub, looking at it:
 *
 *   "The only thing that I wanted to change with the UI is simply instead of Cargo Services at
 *    Levski saying 25 days old, it would simply say four hours ago... Instead, it tells me 25 days
 *    ago 7 aUEC and also 7 aUEC four hours ago. It's just too much."
 *
 *   "The other locations that I'm showing, I don't know where those would be. It's useless
 *    information to the viewer."
 *
 *   "The ones that we can't merge with UEX because they use different names, just put those in
 *    line with everything else, but still have it sorted by distance."
 *
 * So there is ONE list now, ordered by proximity, and a confirmation reaches it one of three ways:
 *
 *   FOLD    the token is known to BE a terminal UEX prices. The confirmation lands ON that row —
 *           it is a fresher answer to the question that row already asks, not a second row.
 *   PLACE   the token cannot be tied to a terminal but CAN be tied to a station. It becomes a row
 *           of its own, positioned by that station and sorted with everything else. Sub's objection
 *           was that those shops "could be anywhere"; placed and sorted they are not.
 *   NEITHER counted and never named. See `unplacedConfirmations`.
 *
 * 🔑 THIS ALL HAPPENS INSIDE THE ORDERING HOOK, BEFORE THE CAP. Folding afterwards would order the
 * survey rows by distance and then staple confirmations on by some other rule, which is the two-
 * lists design wearing one list's clothes. `reserveTierRows` also has to see the placed rows or a
 * far-system confirmation is exactly the row the cap deletes.
 */
interface Confirmation {
  /** The game's own shop token. */
  token: string;
  price: number;
  /** Epoch seconds — the freshest confirmation behind this figure, ours or the pool's. */
  asOf: number;
  contributors: number;
  samples: number;
  mine: boolean;
  /** 🔴 A commodity has a buy price AND a sell price at one terminal and they are not
   *  interchangeable, so a sell may never fold onto a buy row. Items never carry this. */
  side: "buy" | "sell";
}

/**
 * Every confirmation for one catalogue entry, this player's and the community's, merged per shop.
 *
 * 🔑 MERGED BY TOKEN, NEVER CONCATENATED. The player's own purchase is very often also IN the pool
 * — they were one of the 57 shared-log contributors — so appending the two lists would print the
 * same shop twice with the same number and read as two independent confirmations of a price one
 * person checked once.
 *
 * 🔑 THE AGE IS THE NEWER OF THE TWO. A local receipt from five minutes ago genuinely is a fresher
 * confirmation than a pooled median whose newest sample is three days old, and taking the pool's
 * regardless would throw away the freshest evidence in the app — the one thing this feature exists
 * to surface.
 */
function confirmationsFor(ctx: QuoteContext, deps: VerseDeps): Confirmation[] {
  const store = deps.observed?.();
  const pool = deps.pool?.();
  if (!store && !pool) return [];
  const kind = ctx.kind;
  // An ITEM row carries the game's UUID outright. A COMMODITY row never does — see
  // `commodityUuid` — so it is resolved from the name through our own dataset.
  const id = kind === "commodity" ? ctx.uuid ?? deps.commodityUuid?.(ctx.name) ?? null : ctx.uuid;
  if (!id) return [];

  const byShop = new Map<string, Confirmation>();
  const key = (token: string, side: "buy" | "sell") => JSON.stringify([token, side]);

  for (const q of pool?.forId(kind, id) ?? []) {
    // 🔴 A DERIVED COMMODITY SELL IS NOT A PRICE. The site marks it `publishable: false` because
    // the log states the container's CAPACITY rather than its contents, so total/volume is a floor
    // running a median 21% under the truth. Only what was observed may be shown.
    if (!q.publishable) continue;
    if (kind !== "commodity" && q.side === "sell") continue;
    byShop.set(key(q.terminal, q.side), {
      token: q.terminal,
      price: q.unitPrice,
      // 🔴 THE QUOTE'S OWN ABSOLUTE MOMENT, never `now - ageSeconds`. That figure was measured on
      // the site's clock when it answered and this store keeps a payload for a quarter of an hour,
      // so subtracting it from `now` would make every quote read exactly as fresh as it was when
      // fetched, forever.
      asOf: q.atSeconds,
      contributors: q.contributors,
      samples: q.samples,
      mine: false,
      side: q.side,
    });
  }

  const localRows = store
    ? [
        ...store.latestPerTerminal(kind, id, "buy"),
        ...(kind === "commodity" ? store.latestPerTerminal(kind, id, "sell") : []),
      ]
    : [];
  for (const r of localRows) {
    const k = key(r.terminal, r.side);
    const seconds = Math.round(r.at / 1000);
    const existing = byShop.get(k);
    if (existing) {
      existing.mine = true;
      if (seconds > existing.asOf) {
        // The local receipt is the freshest evidence, so it is also the price to show — a median
        // that predates it would be quoting an older reading than the app has in hand.
        existing.asOf = seconds;
        existing.price = r.unitPrice;
      }
      continue;
    }
    byShop.set(k, {
      token: r.terminal,
      price: r.unitPrice,
      asOf: seconds,
      contributors: 1,
      samples: 1,
      mine: true,
      side: r.side,
    });
  }
  // Freshest first, so that when two confirmations compete for one row the newer one is applied.
  return [...byShop.values()].sort((a, b) => b.asOf - a.asOf);
}

/** Where the surveyed shops for one item live, so a confirmation can find its row in one lookup
 *  instead of a scan per confirmation. */
function indexByTerminal(quotes: ResolvedQuote[]): Map<string, ResolvedQuote> {
  const m = new Map<string, ResolvedQuote>();
  for (const q of quotes) if (!m.has(q.terminal)) m.set(q.terminal, q);
  return m;
}

/**
 * 🔴 A PLACED ROW MUST DESCRIBE ITS LOCATION IN UEX'S WORDS, NOT THE STARMAP'S — the widget groups
 * by `place` + `system` and the two tables spell one of those differently.
 *
 * `locations.json` says **"Stanton System"** where every UEX terminal says **"Stanton"**. Take the
 * starmap's spelling and a community row at Orison forms a group of its OWN, sitting beside the
 * surveyed Orison group with an identical heading — the duplicate-shop reading this whole rework
 * exists to remove, produced by a trailing word. So whenever any surveyed terminal shares the
 * place, its vocabulary is copied verbatim and the starmap is only the fallback.
 *
 * ⚠️ Built from the terminal index rather than by matching names, because that index is the one
 * thing that already resolved terminal → place and refused the ambiguous ones.
 */
let vocabCache: { forIndex: TerminalIndex; map: Map<string, { place: string | null; body: string | null; sys: string | null }> } | null = null;

function placeVocab(
  index: TerminalIndex,
  terminals: readonly { n: string; sys: string | null; body: string | null; place: string | null }[],
): Map<string, { place: string | null; body: string | null; sys: string | null }> {
  if (vocabCache && vocabCache.forIndex === index) return vocabCache.map;
  const byName = new Map(terminals.map((t) => [t.n, t]));
  const map = new Map<string, { place: string | null; body: string | null; sys: string | null }>();
  for (const [name, placeId] of index.byTerminal) {
    if (map.has(placeId)) continue;
    const t = byName.get(name);
    if (t) map.set(placeId, { place: t.place, body: t.body, sys: t.sys });
  }
  vocabCache = { forIndex: index, map };
  return map;
}

/**
 * Fold what we can onto the survey rows, turn what we can place into rows of its own, and count
 * the rest.
 *
 * 🔴 A CONFIRMATION OLDER THAN THE ROW IT LANDS ON IS DROPPED IN SILENCE, and that is the rule that
 * keeps this one list. `asOf` on a row means LAST CONFIRMED; if UEX's own survey reading is newer
 * than our observation, then UEX's reading IS the latest confirmation and there is nothing to add.
 * Rendering the older one beside it would be the "7 aUEC twice" Sub rejected, argued from the other
 * direction. It is rare — the pool's median observation is 26 days against UEX's 83 — and it is
 * counted as HANDLED rather than unplaced, because it is genuinely about that row.
 */
export function applyConfirmations(
  quotes: ResolvedQuote[],
  ctx: QuoteContext,
  deps: VerseDeps,
  placer: ShopPlacer,
  terminals: readonly { n: string; sys: string | null; body: string | null; place: string | null }[],
  /** ⚠️ BOTH OPTIONAL, because a build with no `locations-xyz` must still FOLD. Folding a
   *  confirmation onto a terminal row needs no geography at all — only placing does — so a missing
   *  starmap costs the placed rows and leaves the freshness win intact. */
  locations?: Record<string, LocationRecord>,
  index?: TerminalIndex,
): { quotes: ResolvedQuote[]; unplaced: number } {
  const confirmations = confirmationsFor(ctx, deps);
  if (!confirmations.length) return { quotes, unplaced: 0 };

  const rows = quotes.slice();
  const byTerminal = indexByTerminal(rows);
  const termInfo = new Map(terminals.map((t) => [t.n, t]));
  const vocab = index ? placeVocab(index, terminals) : undefined;
  let unplaced = 0;

  for (const c of confirmations) {
    const placement = placer(c.token);
    const named = placement?.terminal && placement.kind === ctx.kind ? placement.terminal : null;

    // ── FOLD ────────────────────────────────────────────────────────────────────────────────
    // 🔴 A SELL NEVER FOLDS. Every surveyed row in this widget is a BUY price, so folding a sell
    // onto one would say a shop sells the commodity for what it pays you for it.
    const target = named && c.side === "buy" ? byTerminal.get(named) : undefined;
    if (target && placement) {
      // 🔴 THE MAP IS MANY-TO-ONE, SO TWO TOKENS CAN COMPETE FOR ONE ROW — `shoploc`'s
      // `usage.notInjective`: `SCShop_Levski_Refinery_Store` and `SCShop_Levski_Refinery_OreSales`
      // both resolve to *Refinery Shop - Levski*, because the game splits the item counter from the
      // ore desk and UEX does not. Confirmations arrive newest-first, so without this guard the
      // SECOND (older) one folded straight over the first: `target.asOf` is UEX's date and never
      // moves, so both cleared the test below and the row ended up showing the STALER of the two.
      // 🔑 Freshest wins and the two are NOT merged. They are different shops with one UEX row
      // between them, so adding their contributor counts would present two shops' witnesses as
      // consensus about one — the same mistake as counting receipts instead of people.
      if (target.confirmed && c.asOf <= target.confirmed.asOf) continue;
      if (c.asOf <= target.asOf) continue;
      const mode = foldsOnto(placement.precision ?? "place-level", c.price, target.price);
      if (mode) {
        const confirmed: QuoteConfirmation = {
          asOf: c.asOf,
          contributors: c.contributors,
          samples: c.samples,
          mine: c.mine,
          precision: placement.precision ?? "place-level",
          token: c.token,
          setPrice: mode === "price",
        };
        // 🔴 OURS WINS — Sub was explicit ("No, I do not want the UEX number to stay"). But ONLY
        // for an `exact` placement: `foldsOnto` returns "age" for a place-level one, where moving
        // the number would be attributing a purchase to a kiosk we cannot identify. `asOf` itself
        // is left alone so the row keeps UEX's own reading date; the widget renders
        // `confirmed.asOf` and the tooltip can then state both.
        if (mode === "price") target.price = c.price;
        target.confirmed = confirmed;
        continue;
      }
      // A place-level confirmation whose price disagrees with the row falls through to PLACE
      // below — which is the honest home for "somebody paid a different number at this station
      // and we cannot say at which kiosk".
    }

    // ── PLACE ───────────────────────────────────────────────────────────────────────────────
    // A named terminal places itself through the terminal index; otherwise the placement's own
    // starmap id is used. Either way the row carries `placeId`, which is what lets
    // `orderByProximity` sort it beside the surveyed shops rather than after them.
    const t = named ? termInfo.get(named) : undefined;
    const placeId = (named ? index?.byTerminal.get(named) : null) ?? placement?.placeId ?? null;
    if (!placeId) { unplaced++; continue; }
    const loc = locations?.[placeId];
    // UEX's words first, the starmap's only as a fallback — see `placeVocab`.
    const v = index ? vocab?.get(placeId) : undefined;
    rows.push({
      // The best name anyone has for this shop. When nothing named it, the game's own token
      // travels and the widget tidies it for reading — under a heading that says where it is,
      // which is the half that was missing.
      terminal: named || c.token,
      system: t?.sys ?? v?.sys ?? loc?.system ?? null,
      body: t?.body ?? v?.body ?? loc?.parentName ?? null,
      place: t?.place ?? v?.place ?? loc?.name ?? null,
      price: c.price,
      asOf: c.asOf,
      placeId,
      observedOnly: true,
      confirmed: {
        asOf: c.asOf,
        contributors: c.contributors,
        samples: c.samples,
        mine: c.mine,
        // ⚠️ NO `precision`. There is no UEX terminal under this row for a precision to be about —
        // see `QuoteConfirmation.precision`. `setPrice` is true because the row simply IS the
        // observation: its price is the observed one and nothing was overridden.
        token: c.token,
        setPrice: true,
        ...(c.side === "sell" ? { side: "sell" as const } : {}),
      },
    });
  }

  return { quotes: rows, unplaced };
}

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
    json(res, 200, {
      ...provenance(table),
      origin: px ? originPayload(px.origin) : null,
      // 🔑 The pool reports separately from the survey table because it fails separately. An empty
      // pool and an unreachable one look identical on screen and want opposite responses — the
      // first is "nobody has bought this yet", the second is "we cannot tell you". `status()`
      // carries `source` and `lastError` so a diagnostics report can say which.
      pool: deps.pool?.()?.status?.() ?? null,
      // 🔑 How many shop tokens we can name and how many we can merely place. Reported because
      // "no confirmation showed up" has three completely different causes — nobody has bought it,
      // the pool is unreachable, or the placement file is missing — and on screen all three look
      // like an ordinary survey row. `named` vs `exact` is the half worth reading: only `exact`
      // may move a price onto a row.
      places: placerCoverage(shopPlacer(deps.dataDir).parts),
    });
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
    const { placer } = shopPlacer(deps.dataDir);
    // How many confirmations for each hit we could neither fold nor place. Keyed by the same
    // name+kind the hook is handed, because a commodity and an item can share a name.
    const unplacedBy = new Map<string, number>();
    const ctxKey = (c: QuoteContext) => JSON.stringify([c.kind, c.name]);

    // 🔴 THE CAP IS APPLIED HERE, INSIDE THE ORDERER, AND `reserveTierRows` IS WHY. Ordering puts
    // the out-of-system shops last by design; a plain `slice` then deletes every one of them the
    // moment an item has enough nearby shops to fill the cap, which is the exclusion Sub reported
    // ("it can only show me what is available in this system"). `reserveTierRows` keeps each tier's
    // best row past the cap, and nothing downstream may re-slice — see `searchItems`' hook doc.
    //
    // 🔴 AND CONFIRMATIONS ARE FOLDED IN *BEFORE* THE ORDERING, which is what makes this one list.
    // A placed confirmation is an ordinary row by the time `orderByProximity` sees it, so it is
    // ranked by the same rule as every surveyed shop and rescued by the same tier reservation.
    const orderQuotes = (quotes: ResolvedQuote[], cap: number, ctx: QuoteContext) => {
      const applied = applyConfirmations(
        quotes, ctx, deps, placer, table.terminals, px?.locations, px?.index,
      );
      if (applied.unplaced) unplacedBy.set(ctxKey(ctx), applied.unplaced);
      if (!px) {
        // No starmap: cheapest first, which is the order the rows already arrive in. A placed row
        // still belongs in the list, so it is sorted in by price rather than dropped.
        return applied.quotes.slice().sort((a, b) => a.price - b.price).slice(0, cap);
      }
      const r = px.order(applied.quotes);
      order = r;
      return reserveTierRows(r.quotes, cap);
    };

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
      results: hits.map((h) => ({
        ...h,
        craft: craftInfo(h, deps.tracker),
        // 🔴 A COUNT, NEVER A NAME. Sub on the old block's rows: *"The other locations that I'm
        // showing, I don't know where those would be. It's useless information to the viewer."*
        // What he rejected was a NAME the reader cannot place — `SCShop_Drlct_Stmnt_SM` sitting in
        // a block of its own. A count is not a location, and dropping the evidence in silence
        // would break this codebase's standing rule that a discarded thing is said rather than
        // swallowed. It rides the notes line the card already draws, so in most cards it costs no
        // new line at all.
        unplacedConfirmations: unplacedBy.get(JSON.stringify([h.kind === "commodity" ? "commodity" : "item", h.name])) ?? 0,
      })),
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
