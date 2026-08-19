/**
 * TRADE - WHAT YOU ACTUALLY DID, AS OPPOSED TO WHAT THE BOARD SUGGESTED.
 *
 * The Runs tab is a forecast off crowd-reported prices. This is the opposite: a record of real
 * purchases and real sales, read out of `game.log`, where every figure is something the game
 * itself stated. Sub asked for it after closing a round trip by hand and wanting to see it:
 * *"I did successfully sell some of that processed food. I'm going to want to see that somewhere
 * in a log. I want to know how much profit I made, how much time it took."*
 *
 * -- 🔴 THE RULE THAT SHAPES EVERYTHING HERE ------------------------------------------------
 *
 * A SALE IS ONLY PROFIT IF WE SAW THE PURCHASE. Profit is revenue minus cost basis, and the cost
 * basis lives in a buy line that may never have been in any log we read - the player may have
 * bought before installing the app, or in a session whose log has rotated away. So a sale with no
 * matching purchase is reported as REVENUE, in its own list, and is never folded into a profit
 * total. Inventing a cost basis would produce a number that looks authoritative and is fiction.
 *
 * That is the same family as the merged-mission-pool disaster: a confidently wrong figure is far
 * worse than an admittedly incomplete one.
 *
 * -- Matching --------------------------------------------------------------------------------
 *
 * FIFO by `resourceGUID`, and PARTIAL fills are the normal case rather than an edge one. Sub's own
 * capture is exactly that: he bought 2 SCU of Processed Food (one auto-loaded, one to the freight
 * elevator) and sold 1. That has to become one closed run of 1 SCU and one open position of 1 SCU,
 * not a whole-lot match and not a discarded remainder.
 *
 * 🔑 FIFO rather than average cost, because the two purchases can have different prices and the
 * player experiences them as separate lots - "the one I bought at Area 18" is a thing they
 * remember. Average cost would smear a good buy into a bad one and make the journal disagree with
 * their memory of the run.
 *
 * ⚠️ `autoLoading` is NOT part of the match. Whether cargo went to the hold or the freight
 * elevator changes how you collect it, never what it cost - matching on it would strand a lot that
 * was bought to the elevator and sold off the ship, which is the ordinary way to run one.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { CommodityPurchase } from "./trade-log.js";

/** One purchase still holding cargo, or the remainder of one. */
export interface OpenLot {
  resourceGuid: string;
  commodity: string | null;
  scu: number;
  pricePerScu: number;
  shopName: string | null;
  at: string;
  atMs: number;
  autoLoaded: boolean | null;
}

/** A buy matched to a sell: the whole point of the file. */
export interface ClosedRun {
  commodity: string | null;
  resourceGuid: string;
  scu: number;
  buyPricePerScu: number;
  sellPricePerScu: number;
  cost: number;
  revenue: number;
  profit: number;
  marginPct: number;
  buyShop: string | null;
  sellShop: string | null;
  boughtAt: string;
  soldAt: string;
  /** Wall-clock minutes between buying and selling THIS lot. */
  minutes: number;
  /** Null when the two events share a timestamp, rather than a fabricated infinity. */
  profitPerHour: number | null;
}

/** A sale we cannot price, because the purchase was never seen. Revenue only - see the file head. */
export interface UnmatchedSale {
  commodity: string | null;
  resourceGuid: string;
  scu: number;
  sellPricePerScu: number;
  revenue: number;
  sellShop: string | null;
  soldAt: string;
}

export interface JournalTotals {
  runs: number;
  scu: number;
  cost: number;
  revenue: number;
  profit: number;
  /** Summed per-lot elapsed time. ⚠️ NOT wall clock: two lots carried on one flight both count
   *  their own span, so this over-states time when a run carried several commodities. Reported as
   *  "time in cargo", never as "time played". */
  minutes: number;
  profitPerHour: number | null;
  /** Revenue from sales whose purchase was never seen. Deliberately OUTSIDE `profit`. */
  unpricedRevenue: number;
  unpricedSales: number;
}

export interface JournalView {
  runs: ClosedRun[];
  open: OpenLot[];
  unmatched: UnmatchedSale[];
  today: JournalTotals;
  allTime: JournalTotals;
}

interface JournalState {
  v: number;
  open: OpenLot[];
  runs: ClosedRun[];
  unmatched: UnmatchedSale[];
  /** Log timestamps already folded in, so a re-seed of the same file cannot double-count. */
  seen: string[];
}

const STATE_VERSION = 1;
const FILE = "trade-journal.json";
/** Keep the journal bounded. A player who trades every night for a year should not grow an
 *  unbounded file, and nothing in the UI looks past a few hundred runs. */
const MAX_RUNS = 500;
const MAX_SEEN = 4000;

const empty = (): JournalState => ({ v: STATE_VERSION, open: [], runs: [], unmatched: [], seen: [] });

function totals(runs: readonly ClosedRun[], unmatched: readonly UnmatchedSale[]): JournalTotals {
  let scu = 0, cost = 0, revenue = 0, profit = 0, minutes = 0;
  for (const r of runs) { scu += r.scu; cost += r.cost; revenue += r.revenue; profit += r.profit; minutes += r.minutes; }
  return {
    runs: runs.length,
    scu, cost, revenue, profit, minutes,
    // 🔑 Null rather than Infinity when no time elapsed - a rate over zero minutes is not a rate.
    profitPerHour: minutes > 0 ? profit / (minutes / 60) : null,
    unpricedRevenue: unmatched.reduce((a, u) => a + u.revenue, 0),
    unpricedSales: unmatched.length,
  };
}

/** Local-day bucket, so "today" means what the player's clock says rather than UTC. */
function isToday(iso: string, now: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export class TradeJournal {
  private state: JournalState;
  private path: string;
  private nameOf: (guid: string) => string | null;
  private dirty = false;

  constructor(stateDir: string, nameOf: (guid: string) => string | null) {
    this.path = join(stateDir, FILE);
    this.nameOf = nameOf;
    this.state = this.read();
  }

  private read(): JournalState {
    try {
      const j = JSON.parse(readFileSync(this.path, "utf8")) as Partial<JournalState>;
      if (j?.v !== STATE_VERSION) return empty();
      return {
        v: STATE_VERSION,
        open: Array.isArray(j.open) ? j.open : [],
        runs: Array.isArray(j.runs) ? j.runs : [],
        unmatched: Array.isArray(j.unmatched) ? j.unmatched : [],
        seen: Array.isArray(j.seen) ? j.seen : [],
      };
    } catch {
      // A missing or corrupt file means "nothing recorded yet", never "repair me".
      return empty();
    }
  }

  save(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.state));
      this.dirty = false;
    } catch { /* a read-only profile must not take the feature down */ }
  }

  /**
   * Fold one parsed purchase in. Returns true when it changed anything.
   *
   * 🔑 IDEMPOTENT BY LOG TIMESTAMP + SHOP + GUID. The sidecar reads the current log AND replays the
   * newest rotated one at startup, and a player who restarts the app twice would otherwise book the
   * same sale three times. The key has to include more than the timestamp: the game writes two
   * purchases in the same millisecond often enough to matter.
   */
  apply(p: CommodityPurchase): boolean {
    if (!p.resourceGuid || !p.scu || p.scu <= 0) return false;
    const key = [p.at, p.kind, p.shopName ?? "", p.resourceGuid, p.scu, p.total ?? ""].join("|");
    if (this.state.seen.includes(key)) return false;
    this.state.seen.push(key);
    if (this.state.seen.length > MAX_SEEN) this.state.seen.splice(0, this.state.seen.length - MAX_SEEN);
    this.dirty = true;

    const name = this.nameOf(p.resourceGuid);
    const atMs = Date.parse(p.at) || 0;

    if (p.kind === "buy") {
      this.state.open.push({
        resourceGuid: p.resourceGuid,
        commodity: name,
        scu: p.scu,
        pricePerScu: p.pricePerScu ?? 0,
        shopName: p.shopName,
        at: p.at,
        atMs,
        autoLoaded: p.autoLoaded,
      });
      return true;
    }

    // A sale: consume the oldest matching lots first, splitting the last one if it over-covers.
    let remaining = p.scu;
    const sellPrice = p.pricePerScu ?? 0;
    while (remaining > 0) {
      const idx = this.state.open.findIndex((l) => l.resourceGuid === p.resourceGuid && l.scu > 0);
      if (idx < 0) break;
      const lot = this.state.open[idx];
      const take = Math.min(lot.scu, remaining);
      const cost = lot.pricePerScu * take;
      const revenue = sellPrice * take;
      const minutes = Math.max(0, (atMs - lot.atMs) / 60000);
      this.state.runs.push({
        commodity: lot.commodity ?? name,
        resourceGuid: p.resourceGuid,
        scu: take,
        buyPricePerScu: lot.pricePerScu,
        sellPricePerScu: sellPrice,
        cost,
        revenue,
        profit: revenue - cost,
        marginPct: lot.pricePerScu > 0 ? ((sellPrice - lot.pricePerScu) / lot.pricePerScu) * 100 : 0,
        buyShop: lot.shopName,
        sellShop: p.shopName,
        boughtAt: lot.at,
        soldAt: p.at,
        minutes,
        profitPerHour: minutes > 0 ? (revenue - cost) / (minutes / 60) : null,
      });
      lot.scu -= take;
      remaining -= take;
      if (lot.scu <= 0) this.state.open.splice(idx, 1);
    }

    // 🔴 Whatever is left had no purchase on file. Revenue, never profit.
    if (remaining > 0) {
      this.state.unmatched.push({
        commodity: name,
        resourceGuid: p.resourceGuid,
        scu: remaining,
        sellPricePerScu: sellPrice,
        revenue: sellPrice * remaining,
        sellShop: p.shopName,
        soldAt: p.at,
      });
    }
    if (this.state.runs.length > MAX_RUNS) this.state.runs.splice(0, this.state.runs.length - MAX_RUNS);
    return true;
  }

  /** Newest first, plus rollups. */
  view(now: Date = new Date()): JournalView {
    const runs = [...this.state.runs].sort((a, b) => Date.parse(b.soldAt) - Date.parse(a.soldAt));
    const unmatched = [...this.state.unmatched].sort((a, b) => Date.parse(b.soldAt) - Date.parse(a.soldAt));
    const todayRuns = runs.filter((r) => isToday(r.soldAt, now));
    const todayUnmatched = unmatched.filter((u) => isToday(u.soldAt, now));
    return {
      runs,
      open: [...this.state.open].sort((a, b) => b.atMs - a.atMs),
      unmatched,
      today: totals(todayRuns, todayUnmatched),
      allTime: totals(runs, unmatched),
    };
  }

  /** Wipe everything. The player's own record, so they get to clear it. */
  reset(): void {
    this.state = empty();
    this.dirty = true;
    this.save();
  }
}
