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
import { ItemShopStore } from "./item-shops.js";
import { searchItems, provenance, type SearchHit } from "./item-search.js";

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
    json(res, 200, provenance(table));
    return true;
  }

  if (url === "/api/verse/search") {
    const q = (p.get("q") ?? "").trim();
    const hits = searchItems(table, q, {
      limit: intParam(p, "limit", 20),
      quotesPerItem: intParam(p, "shops", 8),
    });
    json(res, 200, {
      query: q,
      results: hits.map((h) => ({ ...h, craft: craftInfo(h, deps.tracker) })),
      ...provenance(table),
    });
    return true;
  }

  json(res, 404, { error: "unknown_verse_route" });
  return true;
}
