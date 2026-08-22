/**
 * Keep `data/events.json` FRESH from subliminal.gg, so a discovery made during a live event
 * reaches every player without shipping a new binary.
 *
 * ── Why this is not `fetchIfMissing` ────────────────────────────────────────────────────────
 *
 * `MissionTracker.fetchIfMissing()` already pulls datasets from `remoteBaseUrl`, and the obvious
 * move is to add `events.json` to that list. It would be wrong, and quietly so.
 *
 * `blueprints.<changelist>.json` is **changelist-keyed and immutable**: build 12473311's pools are
 * build 12473311's pools forever, so "fetch it once if it is absent" is complete. `events.json` is
 * changelist-**independent and mutable** — it changes precisely when somebody measures a point
 * value or wins a tier reward, which is the entire reason it exists. Fetch-if-missing would pull
 * it once, on the first launch after an event started, and then never see another correction.
 *
 * So this module is about FRESHNESS, not presence: a conditional GET (`If-None-Match` /
 * `If-Modified-Since`) on a timer, with the shipped copy as the floor.
 *
 * ── The source chain: live -> cache -> bundled, and it always SAYS which ─────────────────────
 *
 * Same honesty discipline as `src/trade-prices.ts`, and for the same reason: Sub's standing
 * requirement is that a player can tell when they are looking at a fallback.
 *
 *   "live"     a refresh landed this session.
 *   "cache"    a previous session's refresh, replayed off disk. Works with no network.
 *   "bundled"  `data/events.json` as shipped in the build. Works with no network AND before any
 *              fetch has ever succeeded, which is what makes the whole thing offline-safe.
 *
 * ── 🔴 THE SEEDING TRAP, which decides where the cache lives ────────────────────────────────
 *
 * `seedDataDir()` in `overlay-server.ts` copies **every** bundled `.json` over the writable data
 * dir on **every start**. So a fetched `events.json` written into `dataDir` is destroyed by the
 * next launch. That is why the durable copy lives in `userDir` (which is never seeded) and
 * `dataDir/events.json` is treated as a derived WORKING copy that this module rewrites after
 * seeding has run. The tracker's existing read path is then untouched — it still just reads
 * `dataDir/events.json`, and that file simply holds the best copy we have.
 *
 * ── 🔴 WHY A `revision`, RATHER THAN "REMOTE ALWAYS WINS" ────────────────────────────────────
 *
 * Remote-authoritative is tempting and is wrong in a case that really happens: Sub measures a
 * reward, edits `data/events.json` in the APP repo, and ships a release. The site copy is now
 * OLDER than the bundle, and a remote-always-wins client would fetch it and DELETE the discovery
 * it just shipped with. `revision` is a single integer that makes the comparison decidable, and
 * the adopt rule is strict (`remote > effective`) so the failure direction is "no update reaches
 * players, and the app says it is on `bundled`" — visible — rather than a silent regression.
 *
 * `npm run sync:events` copies the app repo's file to the site and bumps the integer, so the
 * bump is not something anyone has to remember.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where the events currently in effect came from. Never inferred by a caller — this module is
 *  the only thing that knows, and every surface that renders event data must be able to say it. */
export type EventsSource = "live" | "cache" | "bundled";

export interface EventFeedState {
  source: EventsSource;
  /** The `revision` of the copy in effect. 0 for a file that declares none. */
  revision: number;
  /** Epoch ms the copy in effect was downloaded. Null for `bundled`, which has no fetch. */
  fetchedAt: number | null;
  /** Epoch ms of the last refresh ATTEMPT, successful or not. Null before the first attempt.
   *  Distinct from `fetchedAt` on purpose: "checked 2 minutes ago, unchanged" and "last saw the
   *  server 3 days ago" are different answers and a player deserves to tell them apart. */
  checkedAt: number | null;
  /** Set when the last refresh attempt failed, so a surface can say WHY it is on a fallback
   *  rather than leaving the player to guess between "offline" and "nothing new". */
  lastError: string | null;
}

/** The cache file's shape. The conditional-request validators are stored WITH the body, because
 *  an ETag without the body it validates is worse than no ETag: a 304 would then confirm a copy
 *  we do not have. */
interface CacheFile {
  etag?: string | null;
  lastModified?: string | null;
  fetchedAt?: number;
  body?: unknown;
}

export interface EventFeedOpts {
  /** The shipped file. Read-only, and the floor of the source chain. */
  bundledPath: string;
  /** `dataDir/events.json` — the derived working copy the tracker reads. Rewritten by this
   *  module, and re-clobbered by `seedDataDir()` on every start (which is fine and expected). */
  workingPath: string;
  /** The durable fetched copy, in `userDir`, which seeding never touches. */
  cachePath: string;
  /** Endpoint serving the events file. Empty/undefined disables refreshing entirely — which is a
   *  supported configuration, not a broken one (the app still works off the bundle). */
  url?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** How often to re-check. A conditional GET that 304s is a few hundred bytes, and the workflow
 *  this exists for is a LIVE event where Sub wants a correction to land "like real time". */
export const EVENT_REFRESH_MS = 30 * 60_000;

/** `revision` is the ordering key. A file that declares none reads as 0, so any published copy
 *  with `"revision": 1` outranks a bundle from before this mechanism existed. */
function revisionOf(body: unknown): number {
  const r = (body as { revision?: unknown } | null)?.revision;
  return typeof r === "number" && Number.isFinite(r) ? r : 0;
}

/**
 * Is this parsed body usable as an events file?
 *
 * 🔑 Deliberately the SAME bar `MissionTracker.loadEvents()` applies (`events` array; each entry
 * carrying a string `id` and a string `log`), because anything looser lets us adopt a file the
 * tracker will then silently discard — we would report "live" while running on nothing. It does
 * NOT validate tiers/rewards/contracts: those are research fields that are legitimately empty,
 * and refusing a file for having an empty `rewards` would refuse the normal case.
 */
export function isUsableEventsFile(body: unknown): boolean {
  const list = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(list)) return false;
  return list.every(
    (e) =>
      !!e &&
      typeof (e as { id?: unknown }).id === "string" &&
      typeof (e as { log?: unknown }).log === "string" &&
      (e as { log: string }).log.trim() !== "",
  );
}

export class EventFeed {
  private opts: EventFeedOpts;
  private state: EventFeedState = { source: "bundled", revision: 0, fetchedAt: null, checkedAt: null, lastError: null };
  private cache: CacheFile | null = null;
  /** In-flight refresh, so a timer tick and a manual `?refresh=1` cannot double-fetch. */
  private refreshing: Promise<boolean> | null = null;

  constructor(opts: EventFeedOpts) {
    this.opts = opts;
  }

  /** The provenance of the copy currently in effect. */
  status(): EventFeedState {
    return { ...this.state };
  }

  /**
   * Decide what the working copy should be, with no network. Call this AFTER `seedDataDir()`
   * and BEFORE the tracker is constructed, so its very first read already sees the right file.
   *
   * Returns true when the working file was rewritten (i.e. the cache beat the bundle).
   */
  start(): boolean {
    this.cache = this.readCache();
    const bundledRev = revisionOf(this.readJson(this.opts.bundledPath));
    const cached = this.cache?.body;

    if (cached && isUsableEventsFile(cached) && revisionOf(cached) > bundledRev) {
      this.state = {
        source: "cache",
        revision: revisionOf(cached),
        fetchedAt: typeof this.cache?.fetchedAt === "number" ? this.cache.fetchedAt : null,
        checkedAt: null,
        lastError: null,
      };
      return this.writeWorking(cached);
    }

    // The bundle wins — and the working copy is already the bundle, because seeding just ran.
    this.state = { source: "bundled", revision: bundledRev, fetchedAt: null, checkedAt: null, lastError: null };
    return false;
  }

  /**
   * Conditionally re-fetch. Never throws and never leaves the app worse off: every failure path
   * is a no-op against whatever copy is already in effect.
   *
   * Returns true when the working file CHANGED, which is the caller's cue to `reloadEvents()`.
   */
  async refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const url = this.opts.url;
    if (!url) return false;
    const now = this.opts.now ?? Date.now;
    const doFetch = this.opts.fetchImpl ?? fetch;

    const headers: Record<string, string> = {};
    // Only send validators for a body we actually still hold — see CacheFile.
    if (this.cache?.body) {
      if (this.cache.etag) headers["If-None-Match"] = this.cache.etag;
      if (this.cache.lastModified) headers["If-Modified-Since"] = this.cache.lastModified;
    }

    try {
      const res = await doFetch(url, { headers, cache: "no-store" });
      this.state.checkedAt = now();

      if (res.status === 304) {
        // Confirmed unchanged. Nothing to write, and no error — this is the healthy steady state.
        this.state.lastError = null;
        return false;
      }
      if (!res.ok) {
        this.state.lastError = `HTTP ${res.status}`;
        return false;
      }

      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Validate BEFORE caching — the same discipline as fetchIfMissing. A truncated body or an
        // HTML error page must never become the copy we replay next session.
        this.state.lastError = "remote events.json is not valid JSON";
        return false;
      }
      if (!isUsableEventsFile(body)) {
        this.state.lastError = "remote events.json has no usable events";
        return false;
      }

      const remoteRev = revisionOf(body);

      if (remoteRev <= this.state.revision) {
        // A remote that is not strictly newer is refused, and that is the point: an app release
        // can legitimately ship a HIGHER revision than the site is serving, and adopting the
        // older one would delete a discovery the build was cut for.
        //
        // 🔴 AND THE REFUSED BODY MUST NOT BE CACHED. The cache is not a scratch copy of "what
        // the server last said" — it is the durable copy of what is IN EFFECT, which is the only
        // reason an adopted correction survives `seedDataDir()` at the next launch. Writing a
        // refused body here destroys the adopted one, and the loss is invisible until the NEXT
        // restart, which is exactly how it was found: verified live against a real sidecar, where
        // a session that adopted revision 4 and then saw a stale revision 2 came back up on the
        // bundle with the discovery gone. Every unit assertion passed, because they all tested
        // within one session. The cost of not caching it is one full body per refresh while the
        // site is serving something older — a transient misconfiguration that should be visible.
        this.state.lastError = null;
        return false;
      }

      // Validators belong to the ADOPTED body, so a later 304 confirms the copy we actually hold.
      const etag = res.headers?.get?.("etag") ?? null;
      const lastModified = res.headers?.get?.("last-modified") ?? null;
      const fetchedAt = now();
      this.cache = { etag, lastModified, fetchedAt, body };
      this.writeCache(this.cache);

      this.state = {
        source: "live",
        revision: remoteRev,
        fetchedAt,
        checkedAt: this.state.checkedAt,
        lastError: null,
      };
      return this.writeWorking(body);
    } catch (e) {
      // Offline, DNS, timeout. Keep whatever is in effect and say why.
      this.state.checkedAt = now();
      this.state.lastError = String((e as Error)?.message ?? e);
      return false;
    }
  }

  // -- disk ---------------------------------------------------------------------------------

  private readJson(p: string): unknown {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }

  private readCache(): CacheFile | null {
    const j = this.readJson(this.opts.cachePath) as CacheFile | null;
    return j && typeof j === "object" ? j : null;
  }

  private writeCache(c: CacheFile): void {
    try {
      mkdirSync(dirname(this.opts.cachePath), { recursive: true });
      writeFileSync(this.opts.cachePath, JSON.stringify(c));
    } catch {
      /* a cache we cannot persist costs a re-fetch next session, nothing more */
    }
  }

  private writeWorking(body: unknown): boolean {
    try {
      mkdirSync(dirname(this.opts.workingPath), { recursive: true });
      const next = JSON.stringify(body, null, 2);
      // Skip a no-op write so a caller's "did it change?" answer stays honest across restarts.
      if (existsSync(this.opts.workingPath) && readFileSync(this.opts.workingPath, "utf8") === next) return false;
      writeFileSync(this.opts.workingPath, next);
      return true;
    } catch (e) {
      this.state.lastError = String((e as Error)?.message ?? e);
      return false;
    }
  }
}
