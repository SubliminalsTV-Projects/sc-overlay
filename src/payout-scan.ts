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

import type { ContractRow } from "./contract-list.js";
import type { ContractMatcher, MatchOutcome } from "./contract-match.js";

export interface PayoutObservation {
  contractKey: string;
  amount: number;
  currency: "UEC";
  source: "ocr";
  observedAt: string;
  changelist: string;
}

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
}

const MAX_UNKNOWN = 200;
/** One flush cannot legitimately carry more than a few boards' worth. */
const MAX_BATCH = 200;

export class PayoutScanner {
  readonly tally: ScanTally = {
    seen: 0, recorded: 0, duplicate: 0, ambiguous: 0, unknown: 0,
    feeOnly: 0, noPrice: 0, unknownTitles: [], queued: 0, flushed: 0, lastFlushError: null,
  };
  /** contractKey -> the prices already recorded for it this session. */
  private seenPrices = new Map<string, Set<number>>();
  private queue: PayoutObservation[] = [];
  private unknownSet = new Set<string>();

  constructor(
    private matcher: ContractMatcher,
    private changelist: string,
  ) {}

  /** Feed one capture's rows. Returns the observations newly queued. */
  ingest(rows: ContractRow[], system: string | null): PayoutObservation[] {
    const fresh: PayoutObservation[] = [];
    for (const row of rows) {
      this.tally.seen++;

      // A fee row is a COST. Its reward is still unknown, and recording the fee as a
      // payout would be the single worst thing this feature could do.
      if (row.kind === "fee") { this.tally.feeOnly++; continue; }
      // No price is a legitimate outcome, not an error: some contracts pay only in items
      // delivered to your hangar (Sub's "Very Hungry"), and OCR sometimes drops a short
      // glyph like "1M" entirely.
      if (row.amount == null) { this.tally.noPrice++; continue; }

      const out: MatchOutcome = this.matcher.match(row, system);
      if (out.status === "ambiguous") { this.tally.ambiguous++; continue; }
      if (out.status === "unknown") {
        this.tally.unknown++;
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

      // 🔑 Dedup on (contract, price), not on contract alone. The board is re-read every
      // few seconds while the panel is open, so without this one sitting session would
      // queue the same contract hundreds of times and drown the median in a single
      // player's repeats. But the SAME contract at a DIFFERENT price is a real second
      // observation — that spread is the thing worth capturing.
      const prices = this.seenPrices.get(out.debugName) ?? new Set<number>();
      if (prices.has(row.amount)) { this.tally.duplicate++; continue; }
      prices.add(row.amount);
      this.seenPrices.set(out.debugName, prices);

      const obs: PayoutObservation = {
        contractKey: out.debugName,
        amount: row.amount,
        currency: "UEC",
        source: "ocr",
        observedAt: new Date().toISOString(),
        changelist: this.changelist,
      };
      this.queue.push(obs);
      fresh.push(obs);
      this.tally.recorded++;
      this.tally.queued = this.queue.length;
    }
    return fresh;
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
    this.tally.queued = this.queue.length;
    this.tally.flushed += batch.length;
    this.tally.lastFlushError = null;
    return batch.length;
  }

  pending(): number {
    return this.queue.length;
  }
}
