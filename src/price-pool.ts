/**
 * THE COMMUNITY PRICE POOL — what OTHER PLAYERS have actually paid, not what a survey says.
 *
 * `observed-prices.ts` holds the receipts read out of THIS machine's `game.log`. This holds
 * everybody's, fetched from `subliminal.gg/api/sc/observed-prices`, and the two are shown as one
 * list because a player does not care whose eyes were on the terminal — only how recently.
 *
 * ── 🔑 THE WIN IS NOT A BETTER PRICE. IT IS A FRESHER CONFIRMATION OF THE SAME PRICE ─────────
 *
 * Sub, on why this exists:
 *
 *   "I just really don't like the app saying that something is three months stale, for no reason
 *    other than people don't want to update the price because they know it won't change. I want
 *    to have an app that can verify a price within a matter of days if we have enough people
 *    using it."
 *
 * The numbers behind that, measured rather than assumed: shop prices in Star Citizen are
 * effectively static — 99.6% of the 23,747 rows in the shipped table were never once observed to
 * move over a month — while UEX's own quotes run **p25 36 days, median 83, p90 93**. That gap is
 * not error. It is nobody having looked. So this subsystem is NOT built to find discrepancies; it
 * is built so that when one player walks past a terminal, everybody else's copy of that number
 * quietly turns "83 days" into "2 minutes" — the same figure, far more trustworthy.
 *
 * Every design call below follows from that: the age ladder resolves in SECONDS, the contributor
 * count travels with every quote, and a row is never merged into a UEX row it might not be.
 *
 * ── 🔴 THE APP ONLY READS. NOTHING SENDS ────────────────────────────────────────────────────
 *
 * There is no upload path in this file and there must not be one added casually. The pool was
 * seeded server-side from the OPT-IN shared logs (`site.bp_shared_logs`, 900 rows / 57
 * contributors), and wiring a client upload is a separate flight with its own consent surface.
 * That keeps the blast radius at zero while the display is proven.
 *
 * ── 🔴 A POOLED QUOTE SITS BESIDE A UEX ROW AND NEVER CLAIMS TO BE ONE ──────────────────────
 *
 * The game calls a terminal `SCShop_CommEx_TDD_Orison`; UEX calls it "TDD - Trade and Development
 * Division - Orison". **0 of 75** game shop tokens match a UEX terminal name, and no string
 * comparison bridges them. A learned token→place map has been tried and poisoned 5 of 27 pairings,
 * because `SCShop_Cargo_Office` exists at 13 different stations — so an ambiguous token stays
 * ambiguous. `placeOfTerminal` is the single seam a hand-curated map would drop into later; today
 * it returns null for everything and the widget groups the observations on their own.
 *
 * ── 🔴 ONLY WHAT WAS OBSERVED IS SHOWN ──────────────────────────────────────────────────────
 *
 * The feed marks a commodity SELL `publishable: false`, because a sell states no unit price and
 * the log's cargo figure is the container's CAPACITY rather than its contents — `total / volume`
 * is a floor running a median 21% under the truth. Those rows are fetched and counted (so the
 * widget can say how much evidence exists) and never rendered as a price. There is no estimator
 * in this app and this file must not become the place one appears.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Which catalogue an id belongs to. Never look one up in the other's namespace. */
export type PoolKind = "item" | "commodity";

/** How much independent evidence a quote rests on. n=1 still publishes — Sub's standing ruling,
 *  because a hard corroboration gate publishes nothing at the volume this app runs at. */
export type PoolConfidence = "seen-once" | "corroborated" | "confirmed";

/** One pooled quote, as the site serves it. */
export interface PoolQuote {
  kind: PoolKind;
  /** `itemClassGUID` or `resourceGUID`, lowercased. */
  id: string;
  /** The game's own shop token. See the header — it does NOT join to a UEX terminal. */
  terminal: string;
  side: "buy" | "sell";
  /** Median unit price across the observations behind this quote. */
  unitPrice: number;
  low: number;
  high: number;
  /** Observations. NOT people. */
  samples: number;
  /** Distinct accounts — what `confidence` is computed from, because one person shopping twenty
   *  times is twenty receipts and one witness. */
  contributors: number;
  /** ISO timestamp of the most recent observation: the LATEST CONFIRMATION. */
  latest: string;
  /** 🔴 SECONDS. The entire feature is turning "83 days" into "2 minutes", and a ladder that
   *  bottoms out at a day throws away the only part that is new. */
  ageSeconds: number;
  /**
   * 🔴 THE ABSOLUTE MOMENT, EPOCH SECONDS — and every consumer must age off THIS, never off
   * `ageSeconds`.
   *
   * `ageSeconds` was measured on the SERVER at the moment it answered, and this store keeps a
   * payload for up to fifteen minutes and a disk cache indefinitely. Deriving a timestamp as
   * `now - ageSeconds` therefore makes every quote appear exactly as fresh as it was when it was
   * fetched, forever — a cache from yesterday would still be claiming its quotes were minutes
   * old. Caught in the sandbox: a receipt whose real age was 2h14m rendered as 2h12m and would
   * have kept rendering that as the cache aged.
   *
   * Recomputed from `latest` on adopt AND on load, so `ageSeconds` is only ever a convenience
   * that agrees with it.
   */
  atSeconds: number;
  confidence: PoolConfidence;
  singleContributor: boolean;
  derived: boolean;
  /** May this be shown as a price? False for a derived commodity sell. */
  publishable: boolean;
  /** True when no running app has ever confirmed this pair — every observation came out of the
   *  historical backfill. Carried so the widget could distinguish them; it deliberately does
   *  not, because to a reader "somebody checked this 3 days ago" is the same fact either way. */
  historicalOnly: boolean;
}

interface PoolPayload {
  schema?: number;
  fetchedAt?: number;
  policy?: { confirmAt?: number };
  quotes?: unknown;
}

/** What this build understands. 🔴 A payload whose schema is BEHIND ours is REFUSED: an older
 *  table is still a well-formed table, and adopting one would silently drop whatever the newer
 *  schema added while reporting a successful refresh. A NEWER schema is fine — unknown fields are
 *  ignored. Same rule `ItemShopStore` already enforces, and for the same reason. */
export const POOL_SCHEMA = 1;

/** How often the sidecar re-asks.
 *
 *  🔑 Fifteen minutes, NOT the six hours the UEX item table uses, and the difference is the whole
 *  point rather than a tuning preference: that table moves on the order of months, and this one
 *  moves the moment somebody walks past a terminal. Polling it as slowly as UEX would cap the
 *  freshness this feature exists to deliver at six hours. */
const REFRESH_MS = 15 * 60 * 1000;

/** Default endpoint. `SC_POOL_URL` overrides it — point it at a local site dev server to exercise
 *  the live path, or set it to the empty string to run deliberately offline. */
export const DEFAULT_POOL_URL = "https://subliminal.gg/api/sc/observed-prices";

const STATE_FILE = "price-pool.json";

export function poolUrl(explicit?: string | null): string | null {
  if (explicit !== undefined) return explicit;
  const env = process.env.SC_POOL_URL;
  if (env !== undefined) return env.trim() || null;
  return DEFAULT_POOL_URL;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Coerce one wire quote, or drop it. Every field is defaulted individually so a field added by a
 *  later site build cannot make an older app throw away the whole payload. */
function toQuote(raw: unknown): PoolQuote | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim().toLowerCase() : "";
  const terminal = typeof r.terminal === "string" ? r.terminal.trim() : "";
  const unitPrice = num(r.unitPrice);
  if (!id || !terminal || unitPrice === null || unitPrice <= 0) return null;
  const contributors = Math.max(1, Math.round(num(r.contributors) ?? 1));
  const latest = typeof r.latest === "string" ? r.latest : "";
  const parsed = Date.parse(latest);
  // 🔴 NO `latest`, NO QUOTE. Falling back to "now" would stamp an unknown-age reading as the
  // freshest thing in the widget, which is the one lie this feature cannot afford to tell — the
  // same reasoning `verse-commodities.ts` uses to drop an undated commodity quote outright.
  if (!Number.isFinite(parsed)) return null;
  return {
    kind: r.kind === "commodity" ? "commodity" : "item",
    id,
    terminal,
    side: r.side === "sell" ? "sell" : "buy",
    unitPrice,
    low: num(r.low) ?? unitPrice,
    high: num(r.high) ?? unitPrice,
    samples: Math.max(1, Math.round(num(r.samples) ?? 1)),
    contributors,
    latest,
    ageSeconds: Math.max(0, Math.round(num(r.ageSeconds) ?? 0)),
    atSeconds: Math.round(parsed / 1000),
    confidence:
      r.confidence === "confirmed" || r.confidence === "corroborated" ? r.confidence : "seen-once",
    singleContributor: r.singleContributor !== false && contributors <= 1,
    derived: r.derived === true,
    // 🔴 DEFAULTS TO FALSE, i.e. "do not show this as a price", when the field is absent.
    // A payload that has never heard of the rule must not be read as permission to ignore it.
    publishable: r.publishable === true,
    historicalOnly: r.historicalOnly === true,
  };
}

/**
 * The pool, cached to disk and refreshed on a timer.
 *
 * 🔑 A BORROW, exactly like the commodity table: `overlay-server.ts` owns the one instance and the
 * Verse Finder reads it. Two stores would mean two refresh clocks and two answers to the same
 * question at the same moment.
 */
export class PricePoolStore {
  private byKey = new Map<string, PoolQuote[]>();
  private readonly file: string;
  private url: string | null;
  private timer: NodeJS.Timeout | null = null;
  private fetchedAt = 0;
  private lastError: string | null = null;
  private source: "live" | "cache" | "empty" = "empty";
  /** The threshold the SITE used to compute `confidence`, so the widget renders the label against
   *  the dial that actually produced it rather than one it hardcoded. */
  private confirmAt = 3;

  constructor(stateDir: string, url?: string | null) {
    this.file = join(stateDir, STATE_FILE);
    this.url = poolUrl(url);
    this.load();
  }

  /** Start the refresh clock. Safe to call twice; the first fetch is immediate so a player who
   *  opens the widget seconds after launch is not looking at yesterday's cache. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    // Never hold the process open for a price refresh.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Fetch once. Never throws: a pool that cannot be reached must degrade to the disk cache and
   * say so, not take a search request down with it.
   *
   * 🔴 AN EMPTY 200 IS A FAILURE, NOT AN EMPTY POOL. An upstream that is up with nothing to say
   * would otherwise replace a good cache with zero rows and report a successful refresh — the
   * worst outcome, because it looks healthy. The site's own commodity feed refuses the same shape
   * for the same reason.
   */
  async refresh(): Promise<boolean> {
    if (!this.url) return false;
    try {
      const res = await fetch(this.url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PoolPayload;
      const schema = num(body.schema) ?? 0;
      if (schema < POOL_SCHEMA) {
        throw new Error(`schema ${schema} is behind this build's ${POOL_SCHEMA}`);
      }
      if (!Array.isArray(body.quotes) || !body.quotes.length) {
        throw new Error("payload carried no quotes");
      }
      const quotes = body.quotes.map(toQuote).filter((q): q is PoolQuote => q !== null);
      if (!quotes.length) throw new Error("no quote in the payload was usable");
      this.adopt(quotes, num(body.policy?.confirmAt) ?? this.confirmAt);
      this.source = "live";
      this.fetchedAt = Date.now();
      this.lastError = null;
      this.save();
      return true;
    } catch (err) {
      this.lastError = (err as Error).message;
      // The disk copy stays exactly as it was. Reporting a failure and keeping good data is
      // strictly better than reporting success over nothing.
      return false;
    }
  }

  /** Every pooled quote for one catalogue entry, newest confirmation first. */
  forId(kind: PoolKind, id: string): PoolQuote[] {
    const want = (id || "").trim().toLowerCase();
    if (!want) return [];
    return (this.byKey.get(keyOf(kind, want)) ?? []).slice();
  }

  /** How many quotes are held, and where they came from — for `/api/diagnostics` and the widget's
   *  footer, which must be able to say "the pool is empty" differently from "the pool is down". */
  status() {
    let quotes = 0;
    for (const a of this.byKey.values()) quotes += a.length;
    return {
      quotes,
      entries: this.byKey.size,
      source: this.source,
      fetchedAt: this.fetchedAt || null,
      lastError: this.lastError,
      url: this.url,
      confirmAt: this.confirmAt,
    };
  }

  /** The site's corroboration threshold, so a label is rendered against the dial that made it. */
  confirmThreshold(): number {
    return this.confirmAt;
  }

  private adopt(quotes: PoolQuote[], confirmAt: number): void {
    const next = new Map<string, PoolQuote[]>();
    for (const q of quotes) {
      const k = keyOf(q.kind, q.id);
      let a = next.get(k);
      if (!a) next.set(k, (a = []));
      a.push(q);
    }
    // 🔴 RE-DERIVED FROM `atSeconds` RIGHT HERE, never taken from the wire. See `atSeconds`:
    // the server's figure was true when it answered and this store keeps the payload for a
    // quarter of an hour, so adopting it verbatim would make every quote read younger than it is.
    const nowSec = Math.round(Date.now() / 1000);
    for (const a of next.values()) {
      for (const q of a) q.ageSeconds = Math.max(0, nowSec - q.atSeconds);
      a.sort((x, y) => x.ageSeconds - y.ageSeconds);
    }
    this.byKey = next;
    this.confirmAt = Math.max(1, Math.round(confirmAt));
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const rows: PoolQuote[] = [];
      for (const a of this.byKey.values()) rows.push(...a);
      writeFileSync(
        this.file,
        JSON.stringify({ schema: POOL_SCHEMA, fetchedAt: this.fetchedAt, confirmAt: this.confirmAt, quotes: rows }),
        "utf8",
      );
    } catch (err) {
      console.log(`[pool] save failed: ${(err as Error).message}`);
    }
  }

  /**
   * 🔴 READS FORWARD. Any file with a usable quote array is adopted whatever its schema says, and
   * every field is defaulted individually — because on this project a version check on a state
   * file is a DATA-DESTRUCTION SWITCH, not a schema label, and `if (j.v !== V) return empty()` has
   * silently deleted a user's file before.
   *
   * ⚠️ The stored `ageSeconds` is re-derived from `latest` on load. Leaving it as written would
   * make a day-old cache claim every quote was as fresh as when it was fetched — which is exactly
   * the lie this whole feature exists to stop telling.
   */
  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const j = JSON.parse(readFileSync(this.file, "utf8")) as PoolPayload & { confirmAt?: number };
      if (!j || !Array.isArray(j.quotes)) return;
      const quotes: PoolQuote[] = [];
      for (const raw of j.quotes) {
        const q = toQuote(raw);
        if (q) quotes.push(q);
      }
      if (!quotes.length) return;
      this.adopt(quotes, num(j.confirmAt) ?? this.confirmAt);
      this.fetchedAt = num(j.fetchedAt) ?? 0;
      this.source = "cache";
    } catch (err) {
      console.log(`[pool] cache unreadable, starting empty: ${(err as Error).message}`);
    }
  }
}

/** 🔑 `JSON.stringify` of the parts, never a delimiter-joined string. Terminal and catalogue
 *  tokens are game data and nothing guarantees they avoid whatever separator looked safe — and
 *  reaching for an exotic one is how a literal NUL byte ended up in a source file in this very
 *  subsystem, after which grep called it binary and searched nothing. */
function keyOf(kind: PoolKind, id: string): string {
  return JSON.stringify([kind, id]);
}

/**
 * 🔴 THE SEAM THE HAND-CURATED SHOP MAP DROPS INTO, AND IT DELIBERATELY ANSWERS NOTHING TODAY.
 *
 * Turning a game shop token into a UEX place is what would let an observation sit INSIDE the shop
 * list under Levski instead of in a group of its own. It cannot be derived: **0 of 75** tokens
 * match a terminal name, and a LEARNED map poisoned 5 of 27 pairings the one time it was tried,
 * because `SCShop_Cargo_Office` exists at 13 stations and a token that is ambiguous in the game
 * data has to stay ambiguous here.
 *
 * Sub is hand-curating one (`E:\tmp\shop-join-map.md`, 80 tokens). When it exists, this function
 * consults it and the widget's grouping needs no other change — that is why it is a function with
 * a null return rather than an `if` somewhere in the renderer.
 *
 * ⚠️ NEVER PERSIST A MAP THIS FUNCTION LEARNED FROM OBSERVATION. It must only ever read a
 * curated one.
 */
export function placeOfTerminal(_terminal: string): string | null {
  return null;
}
