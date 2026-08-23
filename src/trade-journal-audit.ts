/**
 * IS THE JOURNAL THE APP WROTE TO ITSELF STILL INTERNALLY CONSISTENT?
 *
 * A different question from `measure:tradeconfirm`, and the difference is the whole reason this
 * file exists. That tool reads `game.log` and answers "did the parser read the GAME correctly?" -
 * it stayed green throughout the 2026-08-23 incident, correctly, because nothing in the logs was
 * wrong. This one never opens a log. It asks whether `trade-journal.json` still agrees with itself.
 *
 * -- 🔴 THE RULE ------------------------------------------------------------------------------
 *
 * Every `seen` key of kind `sell` must have something behind it: a booked run, or an unmatched
 * row. Every key of kind `buy` must have an open lot, a written-off lot, or a run that names it as
 * the buy end. A key with nothing behind it means the journal has lost rows while keeping the keys
 * that suppress them, and `apply()` returns false on a key it has already seen - so those
 * transactions are skipped at THIS launch and at every future one. Permanently.
 *
 * -- 🔑 WHAT AN ORPHANED KEY PROVES, AND WHAT IT DOES NOT --------------------------------------
 *
 * It proves DEDUPE. It can never mean "the confirmation gate refused it."
 *
 * `TradeJournal.apply()` tests `p.confirmed !== true` and returns BEFORE it pushes anything to
 * `seen`, so a gate refusal cannot leave a key behind - there is no ordering of events that
 * produces one. On 2026-08-23 that distinction was got backwards: rows had been repaired out of
 * Sub's journal while `seen` kept their keys, three real sells went invisible, and it read like
 * the app refusing good trades. It was not the gate. It was the repair.
 *
 * The two diagnoses demand opposite responses - delete the file, versus go and fix the gate - so
 * a report that only says "the number looks slightly off" is worse than useless here.
 *
 * -- 🔴 THIS FILE REPORTS. IT DOES NOT REPAIR. --------------------------------------------------
 *
 * There is exactly one safe repair for a drifted journal and it is DELETING THE WHOLE FILE.
 * Editing rows out is what caused the original problem: the key survives the edit, so the
 * transaction is destroyed at every future launch rather than restored. Dropping the orphaned KEYS
 * instead is just as wrong in the other direction - the sidecar replays rotated logs at startup,
 * so an unkeyed sale is re-booked and the player is credited twice.
 *
 * So there is no partial cure, and this module deliberately exports no function that writes.
 * Same family as `log-share.ts` on permanent verdict lists: a set you write a name into forever may
 * hold only verdicts that can never be reconsidered.
 *
 * -- ⚠️ THE ONE THING THAT IS NOT DRIFT --------------------------------------------------------
 *
 * `runs` and `writtenOff` are bounded at `MAX_RUNS` while `seen` holds `MAX_SEEN` keys, so a heavy
 * trader legitimately reaches a state where an old key's row was trimmed away by design. Those keys
 * are SKIPPED and COUNTED, never reported as drift - see `boundedOutKeys`. An audit that cried wolf
 * on a healthy file would be switched off, and then it would be worth nothing on the day it matters.
 */

/** Bounds copied from `trade-journal.ts`. Pinned by an assertion in the test rather than by hope -
 *  importing them would make this module depend on the one it audits. */
export const AUDIT_MAX_RUNS = 500;
export const AUDIT_MAX_SEEN = 4000;

/** One `seen` key, taken apart. Mirrors `seenKey()` in `trade-journal.ts`. */
export interface SeenKeyParts {
  /** The whole key, verbatim, so a report can name exactly what is in the file. */
  key: string;
  at: string;
  kind: string;
  /** `""` when the purchase had no shop name - that is what the key stores, not "null". */
  shopName: string;
  resourceGuid: string;
  total: string;
}

/** A key with no transaction behind it. */
export interface OrphanKey extends SeenKeyParts {
  /** What we looked for and did not find, in words, so a report explains itself. */
  wanted: string;
}

export interface AuditReport {
  /** False when there is drift. An empty journal is `true` - see `keysAudited` before reading it. */
  ok: boolean;
  /** 🔑 HOW MANY KEYS THIS REPORT ACTUALLY CHECKED. `ok` on zero keys certifies nothing, and any
   *  caller treating a green audit as evidence has to read this first. */
  keysAudited: number;
  keysTotal: number;
  sellKeys: number;
  buyKeys: number;
  orphans: OrphanKey[];
  /** Keys skipped because `runs`/`writtenOff` is at its bound and the row could legitimately have
   *  been trimmed. Never silent: a count that is not zero belongs in whatever this report prints. */
  boundedOutKeys: number;
  /** Keys whose shape `parseSeenKey` did not recognise. Reported, never counted as drift - an
   *  unreadable key is a claim about this parser, not about the journal. */
  unreadableKeys: string[];
  rows: { runs: number; unmatched: number; open: number; writtenOff: number };
}

/** Only the fields the audit reads. Structural on purpose: `trade-journal.ts` imports this module,
 *  so this module must not import it back. */
export interface AuditableJournal {
  seen?: readonly string[];
  runs?: readonly { resourceGuid: string; soldAt: string; boughtAt: string; sellShop: string | null; buyShop: string | null }[];
  unmatched?: readonly { resourceGuid: string; soldAt: string; sellShop: string | null }[];
  open?: readonly { resourceGuid: string; at: string; shopName: string | null }[];
  writtenOff?: readonly { resourceGuid: string; at: string; shopName: string | null }[];
}

/**
 * Take a `seen` key apart.
 *
 * 🔴 THE ONLY ACCEPTED SHAPE IS FIVE FIELDS: `at|kind|shop|guid|total`. Anything else is reported
 * as unreadable rather than guessed at. The legacy six-field shape (which carried `scu`) is
 * migrated away by `migrateSeen()` on read, so seeing one here means a hand-edited file - and
 * guessing which field is which would let this audit accuse a healthy journal.
 */
export function parseSeenKey(key: string): SeenKeyParts | null {
  const parts = key.split("|");
  if (parts.length !== 5) return null;
  const [at, kind, shopName, resourceGuid, total] = parts;
  if (!at || !kind || !resourceGuid) return null;
  return { key, at, kind, shopName, resourceGuid, total };
}

/** What the key stores for an absent shop. */
const shopOf = (s: string | null | undefined): string => s ?? "";
/** An evidence handle. The three fields a key and a row have in common. */
const evidenceOf = (at: string, shop: string | null | undefined, guid: string): string =>
  [at, shopOf(shop), guid].join("|");

const parseMs = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Check a journal against itself. Pure, allocates a few sets, and never touches the disk.
 *
 * 🔑 IT TAKES THE STATE, NOT THE VIEW. `view()` sorts and rolls up; drift is a property of what was
 * persisted, so auditing the rollup would put a second transformation between the file and the
 * verdict for no gain.
 */
export function auditJournal(j: AuditableJournal): AuditReport {
  const seen = j.seen ?? [];
  const runs = j.runs ?? [];
  const unmatched = j.unmatched ?? [];
  const open = j.open ?? [];
  const writtenOff = j.writtenOff ?? [];

  // What a SELL key can point at: the runs it closed, and the remainder it could not price.
  const sellEvidence = new Set<string>();
  for (const r of runs) sellEvidence.add(evidenceOf(r.soldAt, r.sellShop, r.resourceGuid));
  for (const u of unmatched) sellEvidence.add(evidenceOf(u.soldAt, u.sellShop, u.resourceGuid));

  // What a BUY key can point at: cargo still held, cargo written off, or the buy end of a run that
  // has already closed. All three are ordinary outcomes; only "none of them" is drift.
  const buyEvidence = new Set<string>();
  for (const l of open) buyEvidence.add(evidenceOf(l.at, l.shopName, l.resourceGuid));
  for (const w of writtenOff) buyEvidence.add(evidenceOf(w.at, w.shopName, w.resourceGuid));
  for (const r of runs) buyEvidence.add(evidenceOf(r.boughtAt, r.buyShop, r.resourceGuid));

  /**
   * ⚠️ THE TRIM WATERMARK. Below this timestamp a missing row is indistinguishable from a row the
   * bound legitimately dropped, so those keys are not judged.
   *
   * `-Infinity` - judge everything - unless a bounded list is actually AT its bound. The bound
   * trims from the FRONT, which is insertion order, so this rests on insertion order tracking log
   * order: true while tailing, and true for the startup replay, which walks the rotated files
   * oldest-first. If that ever stops being true the watermark drops and the audit gets STRICTER,
   * which is the direction that surfaces a problem rather than hiding one.
   */
  let watermarkMs = -Infinity;
  if (runs.length >= AUDIT_MAX_RUNS || writtenOff.length >= AUDIT_MAX_RUNS) {
    watermarkMs = Infinity;
    for (const r of runs) watermarkMs = Math.min(watermarkMs, parseMs(r.boughtAt), parseMs(r.soldAt));
    for (const w of writtenOff) watermarkMs = Math.min(watermarkMs, parseMs(w.at));
    if (!Number.isFinite(watermarkMs)) watermarkMs = -Infinity;
  }

  const orphans: OrphanKey[] = [];
  const unreadableKeys: string[] = [];
  let keysAudited = 0, sellKeys = 0, buyKeys = 0, boundedOutKeys = 0;

  for (const key of seen) {
    const k = parseSeenKey(key);
    if (!k) { unreadableKeys.push(key); continue; }
    if (k.kind === "sell") sellKeys++;
    else if (k.kind === "buy") buyKeys++;
    else { unreadableKeys.push(key); continue; }

    if (parseMs(k.at) < watermarkMs) { boundedOutKeys++; continue; }

    keysAudited++;
    const handle = evidenceOf(k.at, k.shopName, k.resourceGuid);
    if (k.kind === "sell") {
      if (!sellEvidence.has(handle)) orphans.push({ ...k, wanted: "a closed run or an unmatched sale" });
    } else if (!buyEvidence.has(handle)) {
      orphans.push({ ...k, wanted: "an open lot, a written-off lot, or the buy end of a closed run" });
    }
  }

  return {
    ok: orphans.length === 0,
    keysAudited,
    keysTotal: seen.length,
    sellKeys,
    buyKeys,
    orphans,
    boundedOutKeys,
    unreadableKeys,
    rows: { runs: runs.length, unmatched: unmatched.length, open: open.length, writtenOff: writtenOff.length },
  };
}

/**
 * The report in words, for `sidecar.log` and for the audit tool.
 *
 * 🔴 IT NAMES THE ONLY SAFE REPAIR, AND THAT SENTENCE IS LOAD-BEARING. Whoever reads this line is
 * about to reach for a text editor, and hand-editing rows is exactly what produced the state being
 * reported. Saying "there is drift" without saying what to do about it invites the repair that
 * causes it.
 */
export function describeAudit(r: AuditReport): string {
  const bounded = r.boundedOutKeys > 0 ? ` ${r.boundedOutKeys} older key(s) not judged (rows bounded out).` : "";
  const unreadable = r.unreadableKeys.length > 0 ? ` ${r.unreadableKeys.length} key(s) in an unrecognised shape.` : "";
  if (r.keysAudited === 0) {
    return `journal audit: nothing to check - 0 of ${r.keysTotal} key(s) judged.${bounded}${unreadable}`;
  }
  if (r.ok) {
    return `journal audit: OK - ${r.keysAudited} key(s) judged (${r.sellKeys} sell, ${r.buyKeys} buy), ` +
      `all backed by a row.${bounded}${unreadable}`;
  }
  const sells = r.orphans.filter((o) => o.kind === "sell").length;
  const lines = [
    `🔴 journal audit: DRIFT - ${r.orphans.length} of ${r.keysAudited} key(s) have no transaction behind them ` +
      `(${sells} sell, ${r.orphans.length - sells} buy).${bounded}${unreadable}`,
    // The diagnosis, spelled out, because the obvious reading of this state is the wrong one.
    "These transactions are DEDUPED, not refused: apply() keys a purchase only after the confirmation",
    "gate has passed it, so a refusal can never leave a key. They are skipped at every future launch.",
    "👉 The only safe repair is DELETING trade-journal.json. Do not edit rows out of it and do not",
    "delete the keys: editing rows is what causes this, and dropping keys re-books the sales twice.",
  ];
  for (const o of r.orphans.slice(0, 10)) {
    lines.push(`   ${o.kind} ${o.at} ${o.shopName || "(no shop)"} ${o.resourceGuid} - wanted ${o.wanted}`);
  }
  if (r.orphans.length > 10) lines.push(`   ...and ${r.orphans.length - 10} more`);
  return lines.join("\n");
}
