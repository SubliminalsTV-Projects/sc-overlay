// The payout scanner's bookkeeping: dedup, queue, and flush to subliminal.gg.
//
// The reading is done by contract-list.ts; the matching by contract-match.ts. This is what
// sits between them and the network, and its whole job is to not send rubbish.
//
// Sub drives it as a MODE, not a hotkey ("I'd rather just tell you to turn it on and then
// I'll tell you when to turn it off"), because collecting these means flying to another
// system for a different board. So it has to survive being left on for hours across
// travel, disconnects and shard changes without either spamming duplicates or quietly
// stopping.

import { readFileSync, writeFileSync } from "node:fs";
import type { ContractRow } from "./contract-list.js";
import { decideSystem } from "./contract-match.js";
import type { ContractMatcher, MatchOutcome } from "./contract-match.js";

export interface PayoutObservation {
  contractKey: string;
  amount: number;
  currency: "UEC";
  source: "ocr";
  observedAt: string;
  changelist: string;
  /** How the contract was identified. `unique` = the board row resolved to exactly one
   *  contract. `title-group` = it resolved to several same-titled variants and the price
   *  was applied to all of them, on the rule below. Sent so the site can weight or
   *  separate them later; nothing depends on it today. */
  attribution: "unique" | "title-group";
  /** How many variants shared this observation (1 when unique). */
  variants: number;
}

/** 🔑 SAME TITLE MEANS SAME PRICE. Sub, after scanning his whole board: "we have a lot of
 *  that, so if it has that title, then that's the price... the only missions that seem to
 *  be genuinely different with the same title are the Pyro ones with a different mission
 *  pool based on where you're located, and the price you get paid is the same."
 *
 *  That is domain knowledge no amount of dataset analysis would have produced, and it
 *  turns the biggest limitation of this feature into a non-issue. Same-titled variants
 *  differ in reward POOL and LOCATION — which is what cost him a week on Deep space hit,
 *  and why the blueprint tracker must never merge them — but they do NOT differ in aUEC.
 *  So a price read off one of them is a price for all of them.
 *
 *  ⚠️ Bounded anyway. Above this many variants the title has stopped identifying a
 *  contract at all: 148 dataset entries share "Trainee Rank Small Cargo Haul", and hauling
 *  is the one category whose pay plausibly scales with the run rather than the title. A
 *  group that large records nothing and says so, rather than writing one number 148 times.
 */
const TITLE_GROUP_CAP = 12;

export interface ScanTally {
  /** Rows the OCR produced, ever, this session. */
  seen: number;
  /** Rows that matched a contract and carried a price. */
  recorded: number;
  /** Already had this exact price for this contract — the board hasn't changed. */
  duplicate: number;
  /** Matched several contracts; nothing recorded, on purpose. */
  ambiguous: number;
  /** No dataset contract at all. These are the interesting ones — see `unknownTitles`. */
  unknown: number;
  /** Row showed a FEE where the reward goes, so its payout is still unknown. */
  feeOnly: number;
  /** Row had no readable price (an items-only reward, or OCR dropped the glyph). */
  noPrice: number;
  /** Distinct unmatched titles, with their giver. Capped; the point is to notice a
   *  PATTERN of misses, and 200 of them is already the pattern. */
  unknownTitles: string[];
  queued: number;
  flushed: number;
  lastFlushError: string | null;
  /** 🔑 The last few rows exactly as parsed, served over HTTP. Added the moment the first
   *  live run reported "6 rows seen, 0 with a price": the tally says WHAT happened and is
   *  useless for WHY, sidecar.log is not readable from every environment that needs to
   *  debug this, and a diagnostic nobody can retrieve is the same as no diagnostic. */
  lastRows: { category: string | null; title: string; giver: string | null; amount: number | null; kind: string | null }[];
}

/** One row's fate, with the reason. Sub, going into a scanning session: "I'm kind of
 *  going IN blind." He was — everything above is a COUNTER, and a counter cannot tell you
 *  whether the thing is working or merely running. This is the per-row story the live
 *  dashboard renders. */
export interface ScanEvent {
  at: number;
  title: string;
  giver: string | null;
  category: string | null;
  amount: number | null;
  kind: AmountKindLike;
  outcome: "recorded" | "duplicate" | "ambiguous" | "unknown" | "fee" | "no-price";
  /** Human-readable why: the contract it matched, or what stopped it. */
  detail: string;
}
type AmountKindLike = "payout" | "fee" | null;

const MAX_UNKNOWN = 200;
/** One flush cannot legitimately carry more than a few boards' worth. */
const MAX_BATCH = 200;

export class PayoutScanner {
  readonly tally: ScanTally = {
    seen: 0, recorded: 0, duplicate: 0, ambiguous: 0, unknown: 0,
    feeOnly: 0, noPrice: 0, unknownTitles: [], queued: 0, flushed: 0, lastFlushError: null, lastRows: [],
  };
  /** contractKey -> the prices already recorded for it this session. */
  private seenPrices = new Map<string, Set<number>>();
  private queue: PayoutObservation[] = [];
  private unknownSet = new Set<string>();
  /** Rolling per-row feed for the live dashboard. Newest first. */
  private eventRing: ScanEvent[] = [];
  /** When the last capture arrived, so the page can say "reading" vs "nothing on screen". */
  lastCaptureAt = 0;
  /** Rows in the most recent capture — 0 means the panel wasn't visible or wasn't parsed. */
  lastCaptureRows = 0;
  /** System deduced from the board when the log couldn't say. Surfaced so the page can
   *  show it as deduced rather than as fact.
   *
   *  🔴 STICKY FOR THE SESSION, and it was not before — which is what made the whole deduction
   *  useless in practice. It used to be reassigned on EVERY capture, `null` included, from that
   *  one screenful's rows. A board showing nothing but REFUELING casts zero votes (every refuel
   *  contract exists in all three systems), so the answer was null far more often than not, and
   *  a Pyro deduced from one screenful was thrown away by the next. Measured on Sub's
   *  2026-08-12 sweep: the system was NEVER known, and all 8 ambiguous rows were refuel
   *  contracts that would have resolved with it — 19 same-titled variants collapse to 6 once
   *  you know it is Pyro, comfortably under the 12-variant cap.
   *
   *  🔑 It never downgrades to null, because you cannot leave a system without a long quantum
   *  trip. A momentary lack of evidence is not evidence of having moved. */
  inferredSystem: string | null = null;
  /** Votes accumulated across the whole sweep, not one screenful. In memory only: a restart
   *  genuinely might be on the other side of a jump, and re-earning the deduction costs one
   *  system-specific contract scrolling past. */
  private systemVotes = new Map<string, number>();

  events(limit = 60): ScanEvent[] {
    return this.eventRing.slice(0, limit);
  }

  private note(e: ScanEvent): void {
    this.eventRing.unshift(e);
    if (this.eventRing.length > 300) this.eventRing.length = 300;
  }

  /** 🔴 THE QUEUE IS PERSISTED, AND IT WAS NOT AT FIRST. On the feature's first real
   *  session Sub swept his entire contract board while the parser was still being fixed;
   *  every fix meant restarting the app, and each restart silently threw away everything
   *  gathered so far, because the queue lived only in memory. He finished the night with
   *  nothing to show for it. An app that CAN restart mid-sweep — for an update, a crash,
   *  a developer — must not treat its unsent work as disposable. */
  constructor(
    private matcher: ContractMatcher,
    private changelist: string,
    private queuePath?: string,
  ) {
    if (!queuePath) return;
    try {
      const saved = JSON.parse(readFileSync(queuePath, "utf8")) as PayoutObservation[];
      if (Array.isArray(saved)) {
        this.queue = saved;
        this.tally.queued = saved.length;
        // Re-seed the dedup from what's already waiting, or a restart re-queues every
        // row the moment the same board is read again.
        for (const o of saved) {
          const set = this.seenPrices.get(o.contractKey) ?? new Set<number>();
          set.add(o.amount);
          this.seenPrices.set(o.contractKey, set);
        }
      }
    } catch {
      /* no queue yet, or it was unreadable — start clean rather than refusing to run */
    }
  }

  private persist(): void {
    if (!this.queuePath) return;
    try {
      writeFileSync(this.queuePath, JSON.stringify(this.queue));
    } catch {
      /* a failed write must never break a scan; the in-memory queue still works */
    }
  }

  /** Feed one capture's rows. Everything it decides is visible in `tally` and
   *  `events()`; nothing is returned, because the caller acts on neither. */
  ingest(rows: ContractRow[], system: string | null): void {
    // 🔑 If the log hasn't said where we are, ask the BOARD. A contract board only offers
    // contracts for the system you're in, so the rows themselves are evidence — and the
    // log's terrain report only fires about every ten minutes, which for a scanning
    // session means "unknown" almost always. Measured worth on one real capture: three of
    // eight otherwise-ambiguous rows resolved once the system was known.
    // Accumulate this screenful's votes into the session's, then re-decide. Deliberately NOT
    // `inferSystem(rows)`, which judges one capture in isolation and is why this never fired.
    for (const [s, n] of this.matcher.systemVotes(rows)) {
      this.systemVotes.set(s, (this.systemVotes.get(s) ?? 0) + n);
    }
    const deduced = decideSystem(this.systemVotes);
    if (deduced) this.inferredSystem = deduced;   // never back to null — see the field's note
    const sys = system ?? this.inferredSystem;
    const now = Date.now();
    this.lastCaptureAt = now;
    this.lastCaptureRows = rows.length;
    if (rows.length) {
      this.tally.lastRows = rows.slice(-8).map((r) => ({
        category: r.category, title: r.title, giver: r.giver, amount: r.amount, kind: r.kind,
      }));
    }
    const ev = (row: ContractRow, outcome: ScanEvent["outcome"], detail: string) =>
      this.note({
        at: now, title: row.title, giver: row.giver, category: row.category,
        amount: row.amount, kind: row.kind, outcome, detail,
      });

    for (const row of rows) {
      this.tally.seen++;

      // A fee row is a COST. Its reward is still unknown, and recording the fee as a
      // payout would be the single worst thing this feature could do.
      if (row.kind === "fee") {
        this.tally.feeOnly++;
        ev(row, "fee", "shows a fee, not a reward — payout still unknown");
        continue;
      }
      // No price is a legitimate outcome, not an error: some contracts pay only in items
      // delivered to your hangar (Sub's "Very Hungry"), and OCR sometimes drops a short
      // glyph like "1M" entirely.
      if (row.amount == null) {
        this.tally.noPrice++;
        ev(row, "no-price", "no price on the row (items-only reward, or OCR missed it)");
        continue;
      }

      const out: MatchOutcome = this.matcher.match(row, sys);
      if (out.status === "ambiguous") {
        if (out.candidates.length > TITLE_GROUP_CAP) {
          this.tally.ambiguous++;
          ev(row, "ambiguous", `${out.candidates.length} contracts share this title — too many to attribute`);
          continue;
        }
        // Same title, same price. Record it against every variant.
        const wrote = this.record(row, out.candidates, "title-group", ev);
        if (!wrote) {
          this.tally.duplicate++;
          ev(row, "duplicate", `already have ${row.amount.toLocaleString("en-US")} for all ${out.candidates.length} variants`);
        }
        continue;
      }
      if (out.status === "unknown") {
        this.tally.unknown++;
        ev(row, "unknown", "no contract in the dataset matches this title");
        // Worth keeping even though nothing is recorded: ~70 contracts have titles our
        // extraction never resolved, and the board is the only place the real name is
        // visible. Every unknown here is a candidate fix for the DATASET.
        const label = `${row.title}${row.giver ? ` — ${row.giver}` : ""}`;
        if (!this.unknownSet.has(label) && this.unknownSet.size < MAX_UNKNOWN) {
          this.unknownSet.add(label);
          this.tally.unknownTitles.push(label);
        }
        continue;
      }

      const wroteOne = this.record(row, [out.debugName], "unique", ev, out.via);
      if (!wroteOne) {
        this.tally.duplicate++;
        ev(row, "duplicate", `already recorded ${row.amount.toLocaleString("en-US")} for ${out.debugName}`);
      }
    }
  }

  /** Queue one price against one or more contracts. Returns false when every one of them
   *  already had this exact price.
   *
   *  🔑 Dedup on (contract, PRICE), not on contract alone. The board is re-read every few
   *  seconds while the panel is open, so keying on the contract alone would queue one
   *  sitting hundreds of times and drown the median in a single player's repeats. But the
   *  same contract at a DIFFERENT price is a real second observation, and that spread is
   *  the thing worth having. */
  private record(
    row: ContractRow,
    keys: string[],
    attribution: PayoutObservation["attribution"],
    ev: (row: ContractRow, outcome: ScanEvent["outcome"], detail: string) => void,
    via?: string,
  ): boolean {
    const amount = row.amount as number;
    const at = new Date().toISOString();
    let wrote = 0;
    for (const key of keys) {
      const prices = this.seenPrices.get(key) ?? new Set<number>();
      if (prices.has(amount)) continue;
      prices.add(amount);
      this.seenPrices.set(key, prices);
      this.queue.push({
        contractKey: key,
        amount,
        currency: "UEC",
        source: "ocr",
        observedAt: at,
        changelist: this.changelist,
        attribution,
        variants: keys.length,
      });
      wrote++;
    }
    if (!wrote) return false;
    this.persist();
    this.tally.recorded++;
    this.tally.queued = this.queue.length;
    ev(
      row,
      "recorded",
      keys.length === 1
        ? `→ ${keys[0]}${via === "system" ? " (resolved by system)" : ""}`
        : `→ ${wrote} variants of this title (same title, same price)`,
    );
    return true;
  }

  /** Push what's queued. The queue is only cleared on a confirmed 2xx — a failed flush
   *  keeps everything so a dropped connection mid-sweep costs nothing. */
  async flush(post: (obs: PayoutObservation[]) => Promise<boolean>): Promise<number> {
    if (!this.queue.length) return 0;
    const batch = this.queue.slice(0, MAX_BATCH);
    let ok = false;
    try {
      ok = await post(batch);
    } catch (e) {
      this.tally.lastFlushError = e instanceof Error ? e.message : String(e);
      return 0;
    }
    if (!ok) {
      this.tally.lastFlushError = "server rejected the batch";
      return 0;
    }
    this.queue = this.queue.slice(batch.length);
    this.persist();
    this.tally.queued = this.queue.length;
    this.tally.flushed += batch.length;
    this.tally.lastFlushError = null;
    return batch.length;
  }

  pending(): number {
    return this.queue.length;
  }
}
