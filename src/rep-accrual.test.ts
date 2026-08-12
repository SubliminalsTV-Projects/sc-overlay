/**
 * Self-check for EXACTLY-ONCE reputation accrual.
 * Run with:  npx tsx src/rep-accrual.test.ts
 *
 * One completed mission raises THREE completion signals — measured on Sub's real 4.9 logs
 * (2026-08-03): 244 COMPLETED `end` events and 122 `contractComplete` for 122 missions, so the
 * game logs MissionEnded AND EndMission (both parse to `kind: "end"`) plus the notification.
 * Accrual used to be gated on `this.completion`, a single slot that expires after 30s, so any
 * interleaving — and Sub runs several contracts at once — let a repeat through. `repWitnessed` is
 * PERSISTED while that slot is in-memory, so every leak was permanent and they compounded: his
 * Battaglia standing read 144,200 (Prestige 3) against 24,700 (Prestige 1) from the same logs.
 *
 * These assertions pin the invariant that makes the ladder trustworthy: the SAME mission credits
 * once no matter how many signals it raises, in any order, across restarts — while genuinely
 * different completions of the same repeatable contract each count.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionTracker } from "./missions.js";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const dataDir = join(import.meta.dirname, "..", "data");
// A real repeatable Battaglia contract, so it resolves through the real rep-title index rather
// than a fixture that could drift away from the dataset.
const TITLE = "Ship In Distress";
const GIVER = "Recco Battaglia";

const sum = (t: MissionTracker): number =>
  t.repDiagnostics().givers.find((g) => g.giver === GIVER)?.sum ?? 0;
const credited = (t: MissionTracker): number => t.repDiagnostics().creditedCompletions;

/** A tracker on a throwaway profile, already on a live 4.9 session. */
function fresh(stateDir: string): MissionTracker {
  const t = new MissionTracker({ dataDir, stateDir });
  t.detectPatch("<2026-08-03T00:00:00.000Z> ProductVersion: 4.9.188.23497");
  t.detectPatch(`<2026-08-03T00:00:00.000Z>    [Cmdline* ] --envtag='PUB'`);
  return t;
}
/** The three signals one real completion raises, in the order the game logs them. `ts` is NOW so
 *  each lands inside the freshness window that gates a real-time completion. */
function completeOnce(t: MissionTracker, missionId: string): void {
  const ts = () => new Date().toISOString();
  t.apply({ kind: "accept", ts: ts(), missionId, title: TITLE } as never);
  t.apply({ kind: "contractComplete", ts: ts(), missionId, title: TITLE } as never);
  t.apply({ kind: "end", ts: ts(), missionId, state: "COMPLETED" } as never);
  t.apply({ kind: "end", ts: ts(), missionId, state: "COMPLETED" } as never);
}

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

{
  const dir = mkdtempSync(join(tmpdir(), "repaccrue-"));
  try {
    const t = fresh(dir);
    check("nothing credited on a fresh profile", sum(t), 0);
    completeOnce(t, A);
    const once = sum(t);
    check("one completion credits some rep", once > 0, true);
    check("...and counts as exactly one completion", credited(t), 1);
    // Re-firing every signal is what a shard hop / re-read of the same lines looks like.
    completeOnce(t, A);
    check("the SAME mission never credits twice", sum(t), once);
    check("...and the completion count does not move", credited(t), 1);
    // A different run of the same repeatable contract IS a second completion.
    completeOnce(t, B);
    check("a different mission of the same contract does credit", sum(t), once * 2);
    check("...and counts as two completions", credited(t), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 🔴 THE CASE THAT ACTUALLY LEAKED, and the reason the block above is not enough on its own: the
// old guard was `this.completion`, a SINGLE slot. Back-to-back repeats hit it and were absorbed,
// which is why a naive "fire the same mission twice" test passes against the broken code too. It
// only leaks when ANOTHER completion takes the slot in between — i.e. when you are running more
// than one contract at a time, which is Sub's normal way of playing. Two missions, signals
// interleaved: exactly two credits.
{
  const dir = mkdtempSync(join(tmpdir(), "repaccrue-"));
  try {
    const t = fresh(dir);
    const ts = () => new Date().toISOString();
    t.apply({ kind: "accept", ts: ts(), missionId: A, title: TITLE } as never);
    t.apply({ kind: "accept", ts: ts(), missionId: B, title: TITLE } as never);
    // A completes, B completes, then A's SECOND end event arrives — by which point B owns the
    // card slot, so the old guard could not recognise A as already counted.
    t.apply({ kind: "contractComplete", ts: ts(), missionId: A, title: TITLE } as never);
    t.apply({ kind: "contractComplete", ts: ts(), missionId: B, title: TITLE } as never);
    t.apply({ kind: "end", ts: ts(), missionId: A, state: "COMPLETED" } as never);
    t.apply({ kind: "end", ts: ts(), missionId: B, state: "COMPLETED" } as never);
    t.apply({ kind: "end", ts: ts(), missionId: A, state: "COMPLETED" } as never);
    t.apply({ kind: "end", ts: ts(), missionId: B, state: "COMPLETED" } as never);
    check("interleaved completions credit exactly twice", credited(t), 2);
    check("...and the rep matches two completions, not five", sum(t), 600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The leak was permanent because the guard was in memory and the total was on disk. Reloading the
// same profile must not let an already-counted mission through again.
{
  const dir = mkdtempSync(join(tmpdir(), "repaccrue-"));
  try {
    const first = fresh(dir);
    completeOnce(first, A);
    const before = sum(first);
    check("credited before the restart", before > 0, true);

    const after = fresh(dir); // same stateDir → loads the persisted state
    check("the total survives a restart", sum(after), before);
    check("...and so does the record of what was counted", credited(after), 1);
    completeOnce(after, A);
    check("a mission counted BEFORE the restart still cannot re-credit", sum(after), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A signal with no missionId cannot be deduped, so it must not be able to smuggle a credit in
// behind one that already counted.
{
  const dir = mkdtempSync(join(tmpdir(), "repaccrue-"));
  try {
    const t = fresh(dir);
    completeOnce(t, A);
    const once = sum(t);
    t.apply({ kind: "contractComplete", ts: new Date().toISOString(), missionId: null, title: TITLE } as never);
    check("an id-less completion signal adds nothing on its own", sum(t), once);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A completion the rep-title index cannot resolve YET must not be marked as spent, or it can never
// be credited afterwards. This is how the first version of the fix broke the recovery it exists to
// provide: running verifyFromLogs before a dataset was loaded "spent" 388 completions and credited
// nothing, which looks exactly like the fix not working.
{
  const dir = mkdtempSync(join(tmpdir(), "repaccrue-"));
  try {
    const t = new MissionTracker({ dataDir, stateDir: dir }); // deliberately NO detectPatch yet
    t.apply({ kind: "accept", ts: new Date().toISOString(), missionId: A, title: TITLE } as never);
    t.apply({ kind: "contractComplete", ts: new Date().toISOString(), missionId: A, title: TITLE } as never);
    check("nothing is credited without a dataset", sum(t), 0);
    // THE load-bearing assertion: unspent, so "Verify from logs" can still credit it later. (An
    // in-session retry is separately blocked by the 30s completion card, which is by design — the
    // documented recovery is the rebuild, not a re-fire.)
    check("...and the completion is NOT recorded as spent", credited(t), 0);
    // Once the dataset arrives — which happens the moment the patch is detected from the live log —
    // completions resolve normally again.
    t.detectPatch("<2026-08-03T00:00:00.000Z> ProductVersion: 4.9.188.23497");
    t.detectPatch(`<2026-08-03T00:00:00.000Z>    [Cmdline* ] --envtag='PUB'`);
    completeOnce(t, B);
    check("completions credit again once the index can resolve them", sum(t) > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
