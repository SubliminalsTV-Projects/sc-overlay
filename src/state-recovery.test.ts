/**
 * State-file recovery: ONE MALFORMED FIELD MUST NOT DESTROY THE OTHERS.
 *
 * 🔴 THE BUG THIS EXISTS FOR (found 2026-08-27, flight `orisonfix`). `loadState()` was a single
 * `try` whose catch was an empty block commented "first run". Any throw part-way through
 * abandoned every remaining assignment, leaving those properties at their constructor defaults —
 * and the next `saveState()` then wrote those defaults to disk. Nothing logged, nothing failed,
 * and the data was gone permanently.
 *
 * `missionHistory` is assigned 12th of 15 via `dedupeHistory()`, which throws on a non-array or
 * an array holding `null` (it does `[...rows].sort()` and then reads `r.at`). So one bad history
 * silently took `missionHistory`, `eventContributions`, `rewardPrompts` AND `askedTiers` with it.
 *
 * 🔑 TWO INDEPENDENT PROPERTIES ARE UNDER TEST AND BOTH NEED THEIR OWN ASSERTIONS:
 *   1. ISOLATION  — a field that throws must not stop the fields after it loading.
 *   2. PRESERVATION — a field we could not read must be written back BYTE-FOR-BYTE, never
 *      replaced with an empty default. Isolation alone still loses the bad field's contents on
 *      the next save, which is most of the damage.
 *
 * ⚠️ Every tracker here passes `stateDir` EXPLICITLY. The constructor takes an options object,
 * and a positional argument falls through to `%APPDATA%/sc-blueprint-tracker` — i.e. the real
 * profile. That is not hypothetical: a suite did exactly that on 2026-08-26 and overwrote Sub's
 * live reputation state.
 *
 * Run with:  npx tsx src/state-recovery.test.ts
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionTracker } from "./missions.js";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? "  [" + detail + "]" : ""}`);
}

const dataDir = "data";

/** A state file with everything healthy, as a baseline to mutate. */
const healthy = () => ({
  observed: ["Some Blueprint", "Another Blueprint"],
  observedAt: { "Some Blueprint": "2026-08-01T00:00:00.000Z" },
  overrides: {}, guaranteedOwned: [], fabOwned: [],
  inferredRank: { "Bounty Hunters Guild": 2 },
  repWitnessed: { "Bounty Hunters Guild": 600 },
  repAccruedMissionIds: [], repScanned: {},
  completedTitles: {}, completedKeys: {},
  missionHistory: [{ at: "2026-08-01T00:00:00.000Z", title: "A mission", missionId: "m1" }],
  eventContributions: {
    "Orison Relief": [
      { key: "ORS_MA_HaulingMedium", title: null, at: "2026-08-22T00:27:46.316Z", points: 6000, env: "PTU" },
    ],
  },
  rewardPrompts: [],
  askedTiers: { "orison-relief": [15] },
});

function load(state: Record<string, unknown>) {
  const stateDir = mkdtempSync(join(tmpdir(), "sr-"));
  writeFileSync(join(stateDir, "collected.json"), JSON.stringify(state, null, 2));
  const t = new MissionTracker({ dataDir, stateDir }) as unknown as {
    observed: Set<string>;
    missionHistory: unknown[];
    eventContributions: Map<string, unknown[]>;
    askedTiers: Map<string, number[]>;
    saveState: () => void;
  };
  return { t, stateDir, read: () => JSON.parse(readFileSync(join(stateDir, "collected.json"), "utf8")) };
}

// ---- 1. Control: a healthy file round-trips, so the assertions below mean something ------------
{
  const { t, read } = load(healthy());
  check("(control) a healthy file loads every field",
    t.observed.size === 2 && t.missionHistory.length === 1
      && t.eventContributions.size === 1 && t.askedTiers.size === 1,
    `observed=${t.observed.size} hist=${t.missionHistory.length} contrib=${t.eventContributions.size} asked=${t.askedTiers.size}`);
  t.saveState();
  const after = read();
  check("(control) ...and a save preserves them",
    Object.keys(after.eventContributions).length === 1 && after.missionHistory.length === 1,
    JSON.stringify(Object.keys(after.eventContributions)));
}

// ---- 2. 🔴 A THROWING FIELD MUST NOT TAKE THE FIELDS AFTER IT -----------------------------------
//
// Both shapes below really do make `dedupeHistory` throw; they are the two the probe found.
for (const [label, bad] of [
  ["a bare object where an array belongs", { nope: 1 } as unknown],
  ["an array holding a null entry", [null] as unknown],
] as const) {
  const state = healthy();
  (state as Record<string, unknown>).missionHistory = bad;
  const { t } = load(state);

  // Positive first, and sourced from a field BEFORE the throwing one — this vouches that the file
  // was read at all, so "the later fields survived" cannot pass because nothing was ever loaded.
  check(`[${label}] the fields BEFORE the bad one still load`,
    t.observed.size === 2, String(t.observed.size));
  check(`🔴 [${label}] eventContributions survives the throw`,
    t.eventContributions.size === 1, String(t.eventContributions.size));
  check(`🔴 [${label}] askedTiers survives too`,
    t.askedTiers.size === 1, String(t.askedTiers.size));
}

// ---- 3. 🔴 AN UNREADABLE FIELD IS PRESERVED, NOT OVERWRITTEN ------------------------------------
//
// This is the half that actually stops the data loss. Isolation keeps the OTHER fields; only
// preservation keeps the bad field's own contents, so a later build that can parse it still
// finds something there.
{
  const state = healthy();
  const original = [null, { at: "2026-08-02T00:00:00.000Z", title: "kept" }];
  (state as Record<string, unknown>).missionHistory = original;
  const { t, read } = load(state);
  check("(setup) the bad field really did fail to load",
    t.missionHistory.length === 0, String(t.missionHistory.length));
  t.saveState();
  const after = read();
  check("🔴 the unreadable field is written back UNCHANGED, not emptied",
    JSON.stringify(after.missionHistory) === JSON.stringify(original),
    JSON.stringify(after.missionHistory));
  check("...while the healthy fields are saved normally",
    Object.keys(after.eventContributions).length === 1
      && Object.keys(after.askedTiers).length === 1,
    JSON.stringify(after.askedTiers));
}

// ---- 4. A genuinely absent or unparseable FILE is still a first run -----------------------------
//
// The distinction the old single catch could not make: an unreadable FILE means there is nothing
// to lose (defaults are correct); an unreadable FIELD inside a readable file is damage.
{
  const stateDir = mkdtempSync(join(tmpdir(), "sr-none-"));
  const t = new MissionTracker({ dataDir, stateDir }) as unknown as { observed: Set<string> };
  check("no state file at all = first run, no crash", t.observed.size === 0, String(t.observed.size));

  const badDir = mkdtempSync(join(tmpdir(), "sr-bad-"));
  writeFileSync(join(badDir, "collected.json"), "{ this is not json");
  const t2 = new MissionTracker({ dataDir, stateDir: badDir }) as unknown as { observed: Set<string> };
  check("a file that is not JSON = first run, no crash", t2.observed.size === 0, String(t2.observed.size));
}

console.log(failed ? `\nFAILED (${failed})` : "\nstate-recovery tests passed");
process.exit(failed ? 1 : 0);
