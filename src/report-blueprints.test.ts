/**
 * Which blueprints land on a mission's completion card.
 *
 * Sub, 2026-08-09: "I just got a single blueprint, but for whatever reason it shows two images
 * in the widget and it shows one for the M8A that I unlocked previously. It seems like when I do
 * missions in rapid succession, it might just merge the images."
 *
 * He was right. The window opened at the completed mission's ACCEPT time, so a blueprint awarded
 * by an EARLIER mission that finished part-way through this one fell inside it. Running several
 * contracts at once is the normal way to play, so this was not an edge case.
 *
 * Run with:  npx tsx src/report-blueprints.test.ts
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionTracker } from "./missions.js";
import type { MissionEvent } from "./missions-parser.js";

const CL = "99999999";
const bp = (name: string) => ({ blueprint: name, chance: 1, item: name.toLowerCase(), type: "Weapon", subType: null, classification: null });
const dataset = {
  schema: "sc-blueprint-pools/2", version: `9.9.0-LIVE.${CL}`, changelist: CL, missionCount: 2,
  missions: {
    Test_One: { title: "First Job", generatorClass: "Test", missionKey: "Test_One", pools: { "pool-1": [bp("M8A Rifle")] } },
    Test_Two: { title: "Second Job", generatorClass: "Test", missionKey: "Test_Two", pools: { "pool-2": [bp("CQ7 Rifle")] } },
  },
};

let failed = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail === undefined ? "" : `   [${JSON.stringify(detail)}]`}`);
};

/** A fresh tracker. Each scenario gets its own — completion state is per-session by design. */
function tracker() {
  const dir = mkdtempSync(join(tmpdir(), "rep-"));
  writeFileSync(join(dir, "blueprints.latest.json"), JSON.stringify(dataset));
  const t = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "rep-st-")) });
  t.detectPatch("<2026> ProductVersion: 9.9 build_version[99999999] Changelist: 99999999 [Team_GameServices][Login] Environment: PUB");
  return t;
}

// The card is only built for a completion the app read recently (COMPLETION_FRESH_MS = 90s), so
// every timestamp here is relative to now. `s` = seconds ago.
const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const accept = (missionId: string, title: string, s: number): MissionEvent =>
  ({ kind: "accept", ts: at(s), missionId, title });
const complete = (missionId: string, s: number): MissionEvent =>
  ({ kind: "end", ts: at(s), missionId, state: "COMPLETED" });
const received = (name: string, s: number): MissionEvent =>
  ({ kind: "blueprintReceived", ts: at(s), name, missionId: "00000000-0000-0000-0000-000000000000" });

const tiles = (t: ReturnType<typeof tracker>) => (t.view().completion?.blueprints ?? []).map((b) => b.name).sort();

// ── the reported bug ────────────────────────────────────────────────────────
// Two overlapping contracts. The first pays out an M8A; the second, finishing 20s later,
// pays out a CQ7. The second card must show ONE tile.
{
  const t = tracker();
  t.apply(accept("m-1", "First Job", 300));
  t.apply(accept("m-2", "Second Job", 240));   // accepted while the first is still running
  t.apply(complete("m-1", 40));
  t.apply(received("M8A Rifle", 39));          // the receipt lands ~1s after its completion
  check("the first mission's card shows only its own blueprint",
        JSON.stringify(tiles(t)) === JSON.stringify(["M8A Rifle"]), tiles(t));

  t.apply(complete("m-2", 20));
  t.apply(received("CQ7 Rifle", 19));
  check("🔴 the second card does NOT inherit the first mission's blueprint",
        JSON.stringify(tiles(t)) === JSON.stringify(["CQ7 Rifle"]), tiles(t));
}

// ── one mission, two blueprints, is still two ───────────────────────────────
// The fix must not throw away a genuine double drop — that would trade one wrong count for
// another.
{
  const t = tracker();
  t.apply(accept("m-1", "First Job", 120));
  t.apply(complete("m-1", 30));
  t.apply(received("M8A Rifle", 29));
  t.apply(received("CQ7 Rifle", 28));
  check("a mission that really dropped two shows both",
        JSON.stringify(tiles(t)) === JSON.stringify(["CQ7 Rifle", "M8A Rifle"]), tiles(t));
}

// ── a receipt from before the mission was accepted ──────────────────────────
{
  const t = tracker();
  t.apply(received("M8A Rifle", 300));         // long before this contract existed
  t.apply(accept("m-2", "Second Job", 120));
  t.apply(complete("m-2", 20));
  t.apply(received("CQ7 Rifle", 19));
  check("a blueprint received before the accept is not on the card",
        JSON.stringify(tiles(t)) === JSON.stringify(["CQ7 Rifle"]), tiles(t));
}

// ── no accept seen (the app attached mid-session) ───────────────────────────
// The floor used to be -Infinity here, which matched every receipt the startup replay had
// ever loaded — the whole collection on one card.
{
  const t = tracker();
  t.apply(received("M8A Rifle", 3600));        // replayed from an old log
  t.apply(complete("m-2", 20));                // no accept was ever seen for m-2
  t.apply(received("CQ7 Rifle", 19));
  check("with no accept seen, an ancient receipt is not attributed",
        JSON.stringify(tiles(t)) === JSON.stringify(["CQ7 Rifle"]), tiles(t));
}

// ── completions closer together than the reward window ──────────────────────
// There is genuinely no evidence saying which mission paid out: the log never attributes a
// blueprint to a mission (every receipt carries an all-zeros MissionId). Showing nothing is
// the honest answer, and the same principle as declining to guess a split pool.
{
  const t = tracker();
  t.apply(accept("m-1", "First Job", 300));
  t.apply(accept("m-2", "Second Job", 240));
  t.apply(complete("m-1", 32));
  t.apply(received("M8A Rifle", 31));
  t.apply(complete("m-2", 30));                // 2s later — inside REWARD_WINDOW_MS
  check("back-to-back completions do not guess",
        JSON.stringify(tiles(t)) === JSON.stringify([]), tiles(t));
}

console.log(failed ? `\n${failed} FAILED` : "\nreport blueprint attribution: ok");
process.exit(failed ? 1 : 0);
