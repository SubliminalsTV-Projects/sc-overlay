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
 *
 * -- 🔴 WRITING A LOT OFF, AND WHY IT HAS TO BE MANUAL -----------------------------------------
 *
 * An open lot closes when a sale consumes it. Cargo that is DESTROYED never produces a sale, so it
 * sits in "still holding" forever. Sub flew a loaded ship into a wall on purpose to see what would
 * happen, and the loot has been listed ever since: *"it's just stuck in there now."*
 *
 * The obvious hope is to close it automatically, and it was chased before this was built. It does
 * not work, and the measurements are worth keeping so nobody spends the session again:
 *
 *   - A commodity lot's only identity is its `resourceGUID`. Swept over the whole 480-log corpus,
 *     that uuid appears on exactly TWO line families: the buy/sell request itself, and
 *     `CreateHaulingObjectiveHandler` (which describes a contract, not your cargo). It is never on
 *     an inventory line, an entity line, or a destruction line. Bought commodity boxes have no
 *     entity identity in the log at all.
 *   - `<Vehicle Destruction>` names the hull, the zone, the driver and the cause. It never names
 *     the contents, so even a clean "your ship exploded" signal cannot say what was in it.
 *   - The freight elevator's `EntityId[…] is not present` error looks like the answer and is not:
 *     all five phantom ids in the 2026-08-22 session are personal inventory (a Wikelo favour, an
 *     item dragged to the ground, an inventory container). See `missions-parser.ts`.
 *
 * 👉 So the player is the only witness, and `forget()` is the cure rather than a fallback.
 *
 * 🔑 IT MOVES THE LOT, IT DOES NOT DELETE IT. The money left the player's account whatever
 * happened to the boxes, so a profit total that simply forgot the cost would be optimistic - the
 * same failure as inventing a cost basis, wearing the other sign. A written-off lot keeps its
 * price and shop, is reported separately, and is DELIBERATELY OUTSIDE `JournalTotals` - structurally
 * outside, not merely excluded by a filter someone can later "fix". That is the same shape as
 * `unmatched` sales, which are revenue and never profit.
 *
 * ⚠️ Whole lots only. Partial loss would need the player to tell us how much survived, and nothing
 * in the log could ever check the answer.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { CommodityPurchase } from "./trade-log.js";
import { auditJournal, describeAudit, type AuditReport } from "./trade-journal-audit.js";

/** One purchase still holding cargo, or the remainder of one. */
export interface OpenLot {
  /** Stable handle for "remove this one". Assigned at creation and persisted; lots written by an
   *  older build are backfilled on read, so the id can never be a position in an array — removing
   *  a lot would renumber every one after it and the next click would hit the wrong row. */
  id: string;
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

/**
 * A sale we cannot price, because the purchase was never seen. Revenue only - see the file head.
 *
 * 🔴 `scu` AND `sellPricePerScu` ARE NULLABLE, AND NULL IS NOT "ZERO SCU". It means the game
 * stated no volume - a sale out of personal inventory, where SCU is the wrong unit rather than an
 * unknown one (see `trade-log.ts`'s "A SELL DOES NOT STATE A VOLUME"). `revenue` is exact in both
 * cases, because it comes from the log's own `amount`.
 *
 * ⚠️ **NULLABLE IS A WIDENING, SO `STATE_VERSION` DOES NOT MOVE.** A row written by an older build
 * carries numbers, which are still valid here and are read forward untouched. Bumping the version
 * would delete the player's entire journal - see `read()`.
 */
export interface UnmatchedSale {
  commodity: string | null;
  resourceGuid: string;
  scu: number | null;
  sellPricePerScu: number | null;
  revenue: number;
  sellShop: string | null;
  soldAt: string;
}

/** A lot the player says is gone. Keeps everything the open lot had, so the cost is still on the
 *  record and the removal is legible rather than a hole where a row used to be. */
export interface WrittenOffLot extends OpenLot {
  /** When the player wrote it off - not when they bought it. Both are kept. */
  forgottenAt: string;
  /** What it cost, restated so no reader has to re-derive it from a price and a quantity. */
  cost: number;
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
  /** 🔑 A TOP-LEVEL LIST, NOT A FIELD ON `JournalTotals`. Write-offs are the player's word rather
   *  than the log's, so keeping them out of the totals TYPE is what stops a later change folding
   *  them into profit by accident. */
  writtenOff: WrittenOffLot[];
  today: JournalTotals;
  allTime: JournalTotals;
  /**
   * Whether the persisted file still agrees with itself - see `trade-journal-audit.ts`. Computed
   * ONCE at load and carried, because drift can only ever arrive from the FILE: `apply()` pushes a
   * key and its row in the same breath, so nothing this process does can create it.
   *
   * 🔑 It is on the view so a surface can say it without re-deriving the rule. Nothing renders it
   * yet; the load-time line in `sidecar.log` is what makes it reach a person today.
   */
  audit: AuditReport;
}

export interface JournalState {
  v: number;
  open: OpenLot[];
  runs: ClosedRun[];
  unmatched: UnmatchedSale[];
  writtenOff: WrittenOffLot[];
  /**
   * Log timestamps already folded in, so a re-seed of the same file cannot double-count.
   *
   * 🔴 IT IS A PERMANENT VERDICT LIST, AND EDITING THE ROWS WITHOUT IT DESTROYS HISTORY FOREVER.
   * `apply()` returns false on a key it has seen, so a transaction whose ROW was removed by hand
   * while its key stayed here **will never be re-derived** — not at this launch, not at any future
   * one. It produces no run and no unmatched row: it is simply absent. That cost a wrong diagnosis
   * on 2026-08-23, when two real sales missing from a hand-repaired journal were read as the
   * confirmation gate over-refusing them.
   *
   * 🔑 THE SIGNATURE IS DIAGNOSTIC, AND IT POINTS THE OPPOSITE WAY TO THE OBVIOUS READING. A key
   * in here with nothing behind it CANNOT be the gate: `apply()` tests `confirmed` BEFORE it keys
   * anything, so a refused request never reaches this list at all. Key present + no row means
   * deduped, every time.
   *
   * 👉 **The only safe repair is deleting the whole file.** Same family as `log-share.ts`: a set you
   * write a name into forever may hold only verdicts that can never be reconsidered.
   */
  seen: string[];
  /** Source of `OpenLot.id`. Persisted so an id is never reused after a restart. */
  nextLotId: number;
}

const STATE_VERSION = 1;
const FILE = "trade-journal.json";
/** Keep the journal bounded. A player who trades every night for a year should not grow an
 *  unbounded file, and nothing in the UI looks past a few hundred runs. */
const MAX_RUNS = 500;
const MAX_SEEN = 4000;

const empty = (): JournalState => ({
  v: STATE_VERSION, open: [], runs: [], unmatched: [], writtenOff: [], seen: [], nextLotId: 1,
});

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

/** The idempotency key for one purchase line.
 *
 * 🔴 `scu` IS DELIBERATELY NOT IN HERE. It used to be, and that made the key depend on a figure
 * the parser can revise. When the sell-quantity misread was fixed (a sell's `quantity` is SCU,
 * not containers), every stored key for a box bigger than 1 SCU stopped matching, so those sales
 * looked unseen on the next launch and were booked a SECOND time. `total` already separates two
 * purchases in the same millisecond, which is what the key was widened for.
 *
 * ⚠️ `parseSeenKey()` in `trade-journal-audit.ts` takes this apart again. The two must agree on the
 * field ORDER and COUNT; they are held together by a round-trip assertion in `test:jaudit` rather
 * than by a shared constant, because the audit must not import the module it audits. */
export function seenKey(p: CommodityPurchase): string {
  return [p.at, p.kind, p.shopName ?? "", p.resourceGuid, p.total ?? ""].join("|");
}

/** Upgrade keys written before `scu` left the key, so an existing journal does not re-book its
 *  own history. Old shape: at|kind|shop|guid|scu|total. New: at|kind|shop|guid|total. */
function migrateSeen(seen: string[]): string[] {
  const out: string[] = [];
  for (const s of seen) {
    const parts = s.split("|");
    const k = parts.length === 6 ? [parts[0], parts[1], parts[2], parts[3], parts[5]].join("|") : s;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export class TradeJournal {
  private state: JournalState;
  private path: string;
  private nameOf: (guid: string) => string | null;
  private dirty = false;
  private auditReport: AuditReport;

  constructor(stateDir: string, nameOf: (guid: string) => string | null) {
    this.path = join(stateDir, FILE);
    this.nameOf = nameOf;
    this.state = this.read();
    this.auditReport = auditJournal(this.state);
    // 🔴 SAY IT WHERE A PERSON WILL SEE IT, ONCE, AND ONLY WHEN THERE IS SOMETHING TO SAY.
    // The 2026-08-23 misdiagnosis cost hours because the drift was silent and the symptom - sells
    // missing from the Ledger - is also exactly what an over-refusing gate would look like. This is
    // the sidecar, so `console.log` lands in `sidecar.log` and in a copied diagnostics report; the
    // shell's stdout goes nowhere. A clean journal stays quiet: a line every launch would be
    // scrolled past on the launch it mattered.
    if (!this.auditReport.ok) for (const l of describeAudit(this.auditReport).split("\n")) console.log(`[journal] ${l}`);
  }

  /** The load-time verdict. Cached rather than recomputed: `apply()` writes a key and its row
   *  together, so no sequence of calls on a live journal can introduce drift. */
  audit(): AuditReport {
    return this.auditReport;
  }

  /**
   * 🔴 `STATE_VERSION` STAYS 1, AND THAT IS DELIBERATE. `read()` returns `empty()` on a version
   * mismatch, so bumping it to add `id`/`writtenOff` would DESTROY the journal of every player who
   * already has one - Sub's own file holds a real closed run and four open lots. The two new
   * fields are additive and every older file is a valid newer one once they are defaulted, so the
   * repair is a backfill, not a migration. Bump the version only for a change that genuinely
   * cannot be read forward.
   */
  private read(): JournalState {
    try {
      const j = JSON.parse(readFileSync(this.path, "utf8")) as Partial<JournalState>;
      if (j?.v !== STATE_VERSION) return empty();
      const open = Array.isArray(j.open) ? j.open : [];
      const writtenOff = Array.isArray(j.writtenOff) ? j.writtenOff : [];
      let next = typeof j.nextLotId === "number" && j.nextLotId > 0 ? j.nextLotId : 1;
      // Lots written by a build that had no ids. Numbered here, once, and saved on the next write.
      for (const lot of [...open, ...writtenOff]) if (!lot.id) lot.id = `lot${next++}`;
      return {
        v: STATE_VERSION,
        open,
        runs: Array.isArray(j.runs) ? j.runs : [],
        unmatched: Array.isArray(j.unmatched) ? j.unmatched : [],
        writtenOff,
        seen: migrateSeen(Array.isArray(j.seen) ? j.seen : []),
        nextLotId: next,
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
   *
   * 🔴 ONLY A CONFIRMED PURCHASE IS BOOKED, AND `confirmed: null` IS REFUSED TOO.
   *
   * The log records what the client ASKED for. When the server refuses a sale the request line is
   * still there, identical to one that worked, and booking it puts money in the Ledger that the
   * player never earned - Sub's two refused Compboard sales on 2026-08-23 came to +428,872 aUEC of
   * fiction. `TradeConfirmations` in `trade-log.ts` is what settles the question; this method is
   * the second lock on the same door.
   *
   * 🔑 REFUSING `null` IS THE POINT, not an oversight. `parseTradeLine` leaves it null because one
   * line cannot know, so a caller that forgets the gate and hands raw parses straight here gets an
   * EMPTY journal - loud, immediate, and obviously wrong. Accepting null would make the same
   * mistake reproduce the original bug in silence, which is how it got here in the first place.
   */
  apply(p: CommodityPurchase): boolean {
    if (p.confirmed !== true) return false;
    if (!p.resourceGuid) return false;
    // 🔴 A BUY WITH NO VOLUME IS STILL REFUSED, AND A SELL WITH NO VOLUME IS NOT. A buy states its
    // quantity in cSCU outright, so an unreadable one is a malformed line and opening a lot for it
    // would put cargo in the hold that the player cannot be shown; a sell with no cargo-box
    // manifest is the ORDINARY case (54% of real sells) and dropping those would delete real money
    // from the Ledger. The two branches diverge here rather than at one guard for exactly that
    // reason - the old single `!p.scu` test could only ever do one of them.
    if (p.kind === "buy" && !p.volume.known) return false;
    const key = seenKey(p);
    if (this.state.seen.includes(key)) return false;
    this.state.seen.push(key);
    if (this.state.seen.length > MAX_SEEN) this.state.seen.splice(0, this.state.seen.length - MAX_SEEN);
    this.dirty = true;

    const name = this.nameOf(p.resourceGuid);
    const atMs = Date.parse(p.at) || 0;

    if (p.kind === "buy") {
      // Narrowed by the guard above; restated so the compiler can see it rather than asserted.
      if (!p.volume.known) return false;
      this.state.open.push({
        id: `lot${this.state.nextLotId++}`,
        resourceGuid: p.resourceGuid,
        commodity: name,
        scu: p.volume.scu,
        pricePerScu: p.unitPrice.known ? p.unitPrice.perScu : 0,
        shopName: p.shopName,
        at: p.at,
        atMs,
        autoLoaded: p.autoLoaded,
      });
      return true;
    }

    // 🔴 A SALE WITH NO STATED VOLUME CANNOT CLOSE A LOT, AND MUST NOT BE THROWN AWAY EITHER.
    //
    // FIFO needs to know how much came off a lot. When the game states no cargo-box manifest there
    // is no such figure - `quantity[1]` against a real 0.008 SCU was measured, a 125x error - so
    // consuming a lot by it would destroy a real holding and book a fictional cost basis against
    // real revenue. The money, though, is exact: `total` is what the player was paid.
    //
    // So it books as an UNMATCHED sale, which is the structure this file already has for "revenue
    // we cannot turn into profit", with the volume and the per-SCU price left NULL rather than
    // defaulted. Sub's ruling: record the observation, mark the unit unknown, show nothing.
    //
    // ⚠️ The cost of this, stated so nobody discovers it as a bug: a player who BOUGHT cargo and
    // then sells it back without a manifest keeps an open lot that nothing will close. That is the
    // same shape as destroyed cargo, and it has the same cure - the "forget" button. Closing it on
    // a guessed tonnage is what this change exists to stop.
    if (!p.volume.known) {
      this.state.unmatched.push({
        commodity: name,
        resourceGuid: p.resourceGuid,
        scu: null,
        sellPricePerScu: null,
        revenue: p.total ?? 0,
        sellShop: p.shopName,
        soldAt: p.at,
      });
      return true;
    }

    // A sale: consume the oldest matching lots first, splitting the last one if it over-covers.
    let remaining = p.volume.scu;
    const sellPrice = p.unitPrice.known ? p.unitPrice.perScu : 0;
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

  /**
   * The player says this lot is gone - destroyed, despawned, or simply never coming back. Moves it
   * out of `open` and onto the written-off record; returns the lot so a caller can report WHAT it
   * removed rather than only that something happened.
   *
   * 🔑 An unknown id is `null`, not a throw and not a silent success. Two clicks on the same row
   * must not book the loss twice, and the widget re-reads after each one, so "already gone" is an
   * ordinary outcome rather than an error.
   */
  forget(id: string, now: Date = new Date()): WrittenOffLot | null {
    const idx = this.state.open.findIndex((l) => l.id === id);
    if (idx < 0) return null;
    const [lot] = this.state.open.splice(idx, 1);
    const record: WrittenOffLot = {
      ...lot,
      forgottenAt: now.toISOString(),
      cost: lot.pricePerScu * lot.scu,
    };
    this.state.writtenOff.push(record);
    // Same bound as `runs`: a player who loses cargo every night must not grow an unbounded file.
    if (this.state.writtenOff.length > MAX_RUNS) {
      this.state.writtenOff.splice(0, this.state.writtenOff.length - MAX_RUNS);
    }
    this.dirty = true;
    this.save();
    return record;
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
      writtenOff: [...this.state.writtenOff].sort((a, b) => Date.parse(b.forgottenAt) - Date.parse(a.forgottenAt)),
      today: totals(todayRuns, todayUnmatched),
      allTime: totals(runs, unmatched),
      audit: this.auditReport,
    };
  }

  /** Wipe everything. The player's own record, so they get to clear it.
   *
   * 🔑 This is also the sanctioned cure for drift, and it is why the audit is re-run here rather
   * than left stale: clearing the journal clears `seen` with it, so the verdict really has changed. */
  reset(): void {
    this.state = empty();
    this.auditReport = auditJournal(this.state);
    this.dirty = true;
    this.save();
  }
}
