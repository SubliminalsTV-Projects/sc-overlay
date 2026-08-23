/**
 * OBSERVED PRICES — WHAT THE PLAYER ACTUALLY PAID, AS OPPOSED TO WHAT A SURVEY SAYS.
 *
 * Every price the Verse Finder shows today comes from UEX: a crowd-sourced survey where somebody
 * typed a number in. This store holds RECEIPTS instead — the game telling its own server what the
 * player just paid — and they are better data in the one way that matters here.
 *
 * ── WHY THIS EXISTS, MEASURED ────────────────────────────────────────────────────────────────
 *
 * Age of every quote in the shipped item table (24,288 quotes, measured 2026-08-23):
 *
 *   min 0 days · MEDIAN 86 · p90 96 · max 145
 *
 * An observation is seconds old. That is the entire feature: Sub bought a drink for 7 aUEC and
 * expected the Verse Finder to move, and it could not, because nothing in the app had ever read
 * an item purchase.
 *
 * ── 🔴 ONE STORE, TWO SOURCES — AND THAT IS DELIBERATE ───────────────────────────────────────
 *
 * The Verse Finder searches ITEMS (`item-shops.ts`, keyed by the game's `itemClassGUID`) and
 * COMMODITIES (`verse-commodities.ts`, keyed by `resourceGUID`) from the same box, and Sub does
 * not distinguish them — his ruling on ships applies just as well here: people just need to know
 * where it is and what it costs. So both land in one store with a `kind` discriminator rather
 * than in two parallel stores that would inevitably drift in their freshness rules, their caps and
 * their wire shapes.
 *
 * The two feeds are genuinely different upstream and that is fine:
 *   · items       — `item-shop-log.ts`, confirmed on an explicit `result[Success]`
 *   · commodities — `trade-log.ts`, confirmed by the ABSENCE of a refusal
 * Both arrive here already judged. This file never decides whether a transaction happened.
 *
 * ── 🔴 ONLY CONFIRMED TRANSACTIONS MAY ENTER. `null` COUNTS AS REFUSED ───────────────────────
 *
 * `add()` takes `confirmed` and drops anything that is not exactly `true`. A price nobody paid is
 * not a price, and the commodity side has already shipped the counter-example: three refused sales
 * booked as **428,872 aUEC of profit that never existed**.
 *
 * 🔑 The guard is HERE rather than only at the call sites, because "we just don't pass those in"
 * is a distinction that survives exactly until the next person writes a feed. A caller that
 * forgets the gate gets an empty store, loudly, instead of a poisoned one silently.
 *
 * ── 🔴 OBSERVATIONS ARE STORED INDIVIDUALLY, NEVER AVERAGED ──────────────────────────────────
 *
 * The same reasoning the site's price pool records: a dial that decides which observations to
 * trust can only ever be turned if the rows it was applied to still exist. Folding them into a
 * running mean destroys that permanently, and it also destroys the thing this data is uniquely
 * good at — a shop price genuinely drifts (`behr_lmg` at Pyro RStop went 520 -> 522 between
 * sessions), and a mean hides the drift that a timestamped list shows.
 *
 * ── STATE FILE ───────────────────────────────────────────────────────────────────────────────
 *
 * 🔴 `STATE_VERSION` IS A DATA-DESTRUCTION SWITCH ON THIS PROJECT, NOT A SCHEMA LABEL. Every
 * state reader here follows `if (j?.v !== VERSION) return empty()`, so bumping it because a field
 * was added silently deletes the file of every user who has one. This file therefore reads
 * FORWARD: any recognisable row set is adopted and missing fields are defaulted on read. The
 * version moves only for something that genuinely cannot be read forward, which an additive change
 * never is.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Which catalogue the `id` belongs to. Items and commodities are keyed by different UUIDs from
 *  different datasets and must never be looked up in each other's namespace. */
export type ObservedKind = "item" | "commodity";

export interface ObservedPrice {
  kind: ObservedKind;
  /** `itemClassGUID` (items) or `resourceGUID` (commodities), lowercased. Joins with no name
   *  matching at all — the one clean join in either subsystem. */
  id: string;
  /** The game's own shop token, e.g. `SCShop_Levski_CargoOffice_ITEM`. THE terminal identity.
   *
   *  ⚠️ It does NOT join to UEX's terminal names — measured, 0 of 47 log shop names match a
   *  terminal name in the shipped table, because the game writes a prefab token
   *  (`SCShop_PizzaBar_Food_RestStop`) and UEX writes a human name ("Kel-To - Aspire Grand - New
   *  Babbage"). So an observation is shown BESIDE the survey quotes and never claims to be one of
   *  them. Solving that join is what would let an observation override a specific UEX row. */
  terminal: string;
  /** 🔴 THE PRICE OF ONE — per item, or per SCU for a commodity. Never a stack total: for items
   *  `client_price` is the total and 26.7% of purchases are qty > 1. */
  unitPrice: number;
  quantity: number;
  /** What the whole transaction cost. */
  total: number;
  /** Epoch ms, off the LOG LINE's own timestamp — never `Date.now()`, so a replayed rotated log
   *  dates its observations correctly instead of stamping them all with the moment of replay. */
  at: number;
  /** `buy` throughout for items (no item sell verb exists anywhere in 533 logs); either for
   *  commodities. A sell price and a buy price are not interchangeable. */
  side: "buy" | "sell";
  /** The game's internal item name. Diagnosis only — it is not a display name and the widget must
   *  never show it. */
  token: string | null;
  /** Star system, when the session knows it. */
  system: string | null;
}

/** What `add()` accepts. `confirmed` is required rather than optional so a caller cannot omit it
 *  and have the row default into the store. */
export interface ObservationInput extends Omit<ObservedPrice, "at"> {
  at: number | string;
  confirmed: boolean | null;
}

interface StateFile {
  v?: number;
  rows?: unknown;
}

/** Bumped only for a change that cannot be read forward. See the header. */
const STATE_VERSION = 1;
const STATE_FILE = "observed-prices.json";

/** Per (kind,id,terminal). Enough to see drift; small enough that a player who buys ammunition
 *  every session cannot crowd out everything else. */
const MAX_PER_KEY = 12;
/** Global row cap, oldest dropped first. */
const MAX_ROWS = 4000;

/** 🔑 `JSON.stringify` of the parts, never a delimiter-joined string. The commodity pool put a
 *  literal NUL byte into a source file building a composite key by hand, and `grep` then reported
 *  the file as binary and searched nothing. No delimiter question, no escape at all. */
function keyOf(kind: ObservedKind, id: string, terminal: string): string {
  return JSON.stringify([kind, id.toLowerCase(), terminal]);
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * The store. One instance per sidecar, owned by `overlay-server.ts` and handed to the Verse
 * Finder read-only — the same borrow pattern `verse-routes.ts` already uses for the commodity
 * table, so two subsystems can never quote different observations for the same purchase.
 */
export class ObservedPriceStore {
  private rows: ObservedPrice[] = [];
  private readonly file: string;
  private dirty = false;

  constructor(stateDir: string) {
    this.file = join(stateDir, STATE_FILE);
    this.load();
  }

  /**
   * Record one transaction.
   *
   * 🔴 Returns false and stores NOTHING unless `confirmed === true`. `null` counts as refused —
   * see the header. Also rejects a non-positive price: a rental is logged at `client_price[0]`
   * and a zero is not a price.
   */
  add(o: ObservationInput): boolean {
    if (o.confirmed !== true) return false;
    const unitPrice = num(o.unitPrice);
    if (unitPrice === null || unitPrice <= 0) return false;
    const id = (o.id || "").trim().toLowerCase();
    const terminal = (o.terminal || "").trim();
    if (!id || !terminal) return false;

    const atMs = typeof o.at === "number" ? o.at : Date.parse(String(o.at));
    if (!Number.isFinite(atMs)) return false;

    const row: ObservedPrice = {
      kind: o.kind === "commodity" ? "commodity" : "item",
      id,
      terminal,
      unitPrice,
      quantity: num(o.quantity) ?? 1,
      total: num(o.total) ?? unitPrice,
      at: atMs,
      side: o.side === "sell" ? "sell" : "buy",
      token: o.token ?? null,
      system: o.system ?? null,
    };

    // Idempotent per (key, timestamp, price): the startup seed and the live watcher legitimately
    // read overlapping bytes at the handover, and a re-flushed queue must not turn one purchase
    // into two data points.
    const k = keyOf(row.kind, row.id, row.terminal);
    if (this.rows.some((r) => r.at === row.at && keyOf(r.kind, r.id, r.terminal) === k && r.unitPrice === row.unitPrice)) {
      return false;
    }

    this.rows.push(row);
    this.trim(k);
    this.dirty = true;
    return true;
  }

  /**
   * Every observation for one catalogue entry, NEWEST FIRST.
   *
   * 🔑 Returns rows rather than a single number on purpose: the same item genuinely costs
   * different amounts at different shops (68% of multi-shop items vary, measured on the UEX side),
   * so "the price" does not exist and a caller that wants one has to say which shop it means.
   */
  forId(kind: ObservedKind, id: string): ObservedPrice[] {
    const want = (id || "").trim().toLowerCase();
    if (!want) return [];
    return this.rows
      .filter((r) => r.kind === kind && r.id === want)
      .sort((a, b) => b.at - a.at);
  }

  /** The newest observation per TERMINAL for one catalogue entry, newest terminal first. What the
   *  widget draws: one row per shop the player has actually bought at. */
  latestPerTerminal(kind: ObservedKind, id: string, side: "buy" | "sell" = "buy"): ObservedPrice[] {
    const seen = new Set<string>();
    const out: ObservedPrice[] = [];
    for (const r of this.forId(kind, id)) {
      if (r.side !== side) continue;
      if (seen.has(r.terminal)) continue;
      seen.add(r.terminal);
      out.push(r);
    }
    return out;
  }

  /** How many observations are held, for diagnostics and for the widget's empty state. */
  count(): number {
    return this.rows.length;
  }

  /** The newest observation of any kind, for "last seen a purchase" in diagnostics. */
  newestAt(): number | null {
    let best: number | null = null;
    for (const r of this.rows) if (best === null || r.at > best) best = r.at;
    return best;
  }

  save(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ v: STATE_VERSION, rows: this.rows }), "utf8");
      this.dirty = false;
    } catch (err) {
      // A store that cannot persist is still useful for this session. Losing observations is
      // regrettable; taking the sidecar down over it is worse.
      console.log(`[observed] save failed: ${(err as Error).message}`);
    }
  }

  /** 🔴 READS FORWARD. Anything with a usable row array is adopted whatever `v` says, and every
   *  field is defaulted individually — so adding a field in a later build cannot delete a
   *  player's history. Only a genuinely unreadable file yields an empty store. */
  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const j = JSON.parse(readFileSync(this.file, "utf8")) as StateFile;
      if (!j || !Array.isArray(j.rows)) return;
      for (const raw of j.rows) {
        const r = (raw ?? {}) as Record<string, unknown>;
        const unitPrice = num(r.unitPrice);
        const at = num(r.at);
        const id = typeof r.id === "string" ? r.id.toLowerCase() : "";
        const terminal = typeof r.terminal === "string" ? r.terminal : "";
        if (unitPrice === null || unitPrice <= 0 || at === null || !id || !terminal) continue;
        this.rows.push({
          kind: r.kind === "commodity" ? "commodity" : "item",
          id,
          terminal,
          unitPrice,
          quantity: num(r.quantity) ?? 1,
          total: num(r.total) ?? unitPrice,
          at,
          side: r.side === "sell" ? "sell" : "buy",
          token: typeof r.token === "string" ? r.token : null,
          system: typeof r.system === "string" ? r.system : null,
        });
      }
    } catch (err) {
      console.log(`[observed] state unreadable, starting empty: ${(err as Error).message}`);
      this.rows = [];
    }
  }

  /** Keep the per-key and global caps. Oldest goes first in both. */
  private trim(k: string): void {
    const mine = this.rows.filter((r) => keyOf(r.kind, r.id, r.terminal) === k);
    if (mine.length > MAX_PER_KEY) {
      const drop = new Set(
        mine.sort((a, b) => a.at - b.at).slice(0, mine.length - MAX_PER_KEY),
      );
      this.rows = this.rows.filter((r) => !drop.has(r));
    }
    if (this.rows.length > MAX_ROWS) {
      this.rows.sort((a, b) => a.at - b.at);
      this.rows = this.rows.slice(this.rows.length - MAX_ROWS);
    }
  }
}
