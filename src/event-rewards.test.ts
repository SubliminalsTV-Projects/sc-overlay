/**
 * Self-filling event rewards: tier-crossing detection, receipt correlation, and the rules that
 * stop a guess becoming a fact.
 *
 * 🔑 FIXTURES ONLY. `data/events.json` is a live research artefact — its `contracts`, `rewards`,
 * `tiers` and `total` change as they are measured in game, and reading any of them into a
 * MECHANISM test makes that test go red for a reason that has nothing to do with the mechanism.
 * That has already happened twice in `event-track.test.ts` (on `contracts`, then on `rewards`
 * when the S-38 was confirmed). Nothing here opens the shipped file.
 *
 * Run with:  npx tsx src/event-rewards.test.ts
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionTracker } from "./missions.js";
import { parseMissionEvent } from "./missions-parser.js";
import {
  tiersCrossed, receiptForCrossing, candidateForTier, isPromptDue, shouldAsk, reportBody,
  RECEIPT_WINDOW_MS, PROMPT_DWELL_MS, type RewardPrompt,
} from "./event-rewards.js";
import type { LogEvent } from "./parser.js";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? "  [" + detail + "]" : ""}`);
}

// ── Pure rules ──────────────────────────────────────────────────────────────────────────────

const TIERS = [15, 25, 43, 57, 80, 100];

// Positive first: every "crosses nothing" case below is satisfied for free by a function that
// has stopped detecting anything at all.
check("a crossing IS detected", JSON.stringify(tiersCrossed(10, 20, TIERS)) === "[15]", JSON.stringify(tiersCrossed(10, 20, TIERS)));
check("landing exactly ON a tier counts as crossing it", JSON.stringify(tiersCrossed(10, 15, TIERS)) === "[15]");
check("one big contract can cross TWO tiers, and both are returned",
  JSON.stringify(tiersCrossed(10, 44, TIERS)) === "[15,25,43]", JSON.stringify(tiersCrossed(10, 44, TIERS)));
check("no movement crosses nothing", tiersCrossed(20, 20, TIERS).length === 0);
check("moving inside a band crosses nothing", tiersCrossed(16, 24, TIERS).length === 0);
check("going backwards crosses nothing", tiersCrossed(30, 20, TIERS).length === 0);
// 🔴 The one that stops a returning player being asked about every tier they cleared last week:
// a fresh session has no previous reading, and treating that as 0 would "cross" all of them.
check("a null previous percentage crosses nothing", tiersCrossed(null, 90, TIERS).length === 0, JSON.stringify(tiersCrossed(null, 90, TIERS)));
check("a null new percentage crosses nothing", tiersCrossed(10, null, TIERS).length === 0);

// ── Receipt correlation ─────────────────────────────────────────────────────────────────────

const T = 1_000_000;
const receipts = [
  { name: "BEFORE THE CROSSING", atMs: T - 500 },
  { name: "S-38 SecondWind Pistol", atMs: T + 383 },   // the measured 383 ms gap
  { name: "MUCH LATER", atMs: T + 60_000 },
];
check("the receipt 383ms after the crossing is the one claimed",
  receiptForCrossing(T, receipts)?.name === "S-38 SecondWind Pistol", String(receiptForCrossing(T, receipts)?.name));
// ⚠️ Only ever looks FORWARD — a blueprint that arrived first belongs to whatever came before.
check("a receipt BEFORE the crossing is never claimed",
  receiptForCrossing(T, [{ name: "BEFORE THE CROSSING", atMs: T - 500 }]) === null);
check("a receipt outside the window is not claimed",
  receiptForCrossing(T, [{ name: "MUCH LATER", atMs: T + 60_000 }]) === null);
check("nothing to claim yields null", receiptForCrossing(T, []) === null);
check("the EARLIEST qualifying receipt wins",
  receiptForCrossing(T, [{ name: "second", atMs: T + 900 }, { name: "first", atMs: T + 100 }])?.name === "first");

// ── Candidates ──────────────────────────────────────────────────────────────────────────────

const CANDS = [{ tier: 25, name: "FBL-8a (Modified) armor set" }, { tier: 43, name: "P4-AR rifle", confirmed: true }];
check("an unconfirmed candidate is offered for its tier",
  candidateForTier(CANDS, 25) === "FBL-8a (Modified) armor set", String(candidateForTier(CANDS, 25)));
check("a candidate already marked confirmed is not offered as a guess", candidateForTier(CANDS, 43) === null);
check("a tier with no candidate yields null", candidateForTier(CANDS, 80) === null);
check("no candidate list at all yields null", candidateForTier(undefined, 25) === null);

// ── Ask-or-not ──────────────────────────────────────────────────────────────────────────────

check("a tier with NO measured reward is asked about", shouldAsk(25, [15]));
// 🔑 Nothing to learn at 15% — asking anyway turns a one-time contribution into a recurring
// interruption for every player who ever crosses it.
check("a tier whose reward is already measured is NOT asked about", !shouldAsk(15, [15]));

// ── Dwell ───────────────────────────────────────────────────────────────────────────────────

const prompt = (over: Partial<RewardPrompt> = {}): RewardPrompt => ({
  id: "e:25", eventId: "e", eventLabel: "E", tier: 25,
  crossedAt: "2026-08-22T00:00:00Z", crossedAtMs: T,
  observed: null, candidate: null, answer: null, reported: false, ...over,
});
const opens = T + RECEIPT_WINDOW_MS;
check("a prompt IS due once the correlation window closes", isPromptDue(prompt(), opens));
check("...and stays due through the two-minute dwell", isPromptDue(prompt(), opens + PROMPT_DWELL_MS - 1));
check("a prompt is NOT due before the correlation window closes", !isPromptDue(prompt(), opens - 1), String(RECEIPT_WINDOW_MS));
check("a prompt expires after the dwell", !isPromptDue(prompt(), opens + PROMPT_DWELL_MS));
check("an answered prompt is never due", !isPromptDue(prompt({ answer: { name: "x", source: "confirmed", at: "" } }), opens));
check("a reported prompt is never due", !isPromptDue(prompt({ reported: true }), opens));
check("the dwell really is Sub's two minutes", PROMPT_DWELL_MS === 120_000, String(PROMPT_DWELL_MS));

// ── The report body ─────────────────────────────────────────────────────────────────────────

check("an unanswered prompt reports nothing", reportBody(prompt()) === null);
{
  const b = reportBody(prompt({ observed: "S-38", candidate: "S-38", answer: { name: "S-38", source: "confirmed", at: "t" } }))!;
  check("a confirmation reports agreed=true", b.agreed === true);
  check("...and carries BOTH what was observed and what was guessed", b.observed === "S-38" && b.candidate === "S-38");
}
{
  // 🔑 The higher-value signal: the candidate list is WRONG, and that is a discovery.
  const b = reportBody(prompt({ observed: "REAL THING", candidate: "WRONG GUESS", answer: { name: "REAL THING", source: "corrected", at: "t" } }))!;
  check("a correction does NOT report agreement", b.agreed === false);
  check("...and preserves the guess it disagreed with", b.candidate === "WRONG GUESS" && b.name === "REAL THING");
}
{
  // "I crossed the tier and got nothing" is a real answer no amount of waiting would establish.
  const b = reportBody(prompt({ answer: { name: null, source: "none", at: "t" } }))!;
  check("a 'nothing received' answer is still reported", b !== null && b.name === null && b.source === "none");
}

// ── End to end through the real tracker ─────────────────────────────────────────────────────
// Log lines are the REAL notification shapes, copied from Sub's 4.10 PTU log — a synthetic line
// the parser rejects would make every assertion below vacuous.

const ev = (message: string, ts: string): LogEvent =>
  ({ eventTag: "SHUDEvent_OnNotification", timestamp: ts, message }) as LogEvent;
const notif = (subject: string, id: number, missionId: string) =>
  `Added notification "${subject}" [${id}] to queue. New queue size: 1, MissionId: [${missionId}], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`;
const ZERO = "00000000-0000-0000-0000-000000000000";

function fixtureTracker(dirPrefix: string, events: unknown, version: string) {
  const CL = "12473311";
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
  writeFileSync(join(dir, "events.json"), JSON.stringify({ events }));
  const m = (title: string, key: string) => ({ title, generatorClass: "TheBackpocket", missionKey: key, pools: {} });
  writeFileSync(join(dir, "blueprints.latest.json"), JSON.stringify({
    schema: "sc-blueprint-pools/2", version: `${version}.${CL}`, changelist: CL, missionCount: 2,
    missions: { FX_Small: m("Fixture: Small", "FX_Small"), FX_Big: m("Fixture: Big", "FX_Big") },
  }));
  const t = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), dirPrefix + "st-")) });
  t.detectPatch(`<2026> ProductVersion: ${version.split("-")[0].replace("4.10.0", "4.10")} Changelist: ${CL}`);
  return t;
}

/** Accept -> complete -> journal entry, the way the log does it. */
function runContract(t: MissionTracker, key: string, missionId: string, iso: string, id: number) {
  t.apply({
    kind: "marker", ts: iso, missionId, contract: key + "_0", contractKey: key,
    generator: "TheBackpocket", contractDefId: "071fd78d-ae7f-452d-b39a-98bfb9804c8c",
    objectiveId: "pickup_x_0", markerEntityId: "2548", pos: null,
  });
  t.apply(parseMissionEvent(ev(notif(`Contract Complete: Fixture: ${key}: `, id, missionId), iso))!);
  t.apply(parseMissionEvent(ev(notif("Journal Entry Added: Fixture Relief: ", id + 1, ZERO), iso))!);
}

{
  // A fixture event with a KNOWN reward at 15 and a candidate at 25 — one tier must not ask and
  // the other must.
  const t = fixtureTracker("evrw-", [{
    id: "fx", log: "Fixture Relief", label: "Fixture Relief", status: "current",
    contractPrefixes: ["FX_"], total: 1000, tiers: [15, 25, 50],
    contracts: { FX_Small: 100, FX_Big: 160 },
    rewards: [{ tier: 15, name: "KNOWN AT FIFTEEN", item: null }],
    rewardCandidates: [{ tier: 25, name: "GUESSED AT TWENTYFIVE" }],
  }], "4.10.0-LIVE");
  t.detectPatch("<2026> Environment: PUB");

  // 100 points = 10%. Crosses nothing.
  runContract(t, "FX_Small", "11111111-1111-1111-1111-111111111111", "2026-08-22T00:00:00.000Z", 10);
  check("(setup) the fixture event loaded and priced", (t.eventProgress("fx")?.points ?? 0) === 100, String(t.eventProgress("fx")?.points));
  check("10% raises no prompt", t.eventRewardPrompts(Date.parse("2026-08-22T00:01:00Z")).length === 0);

  // +160 = 260 points = 26%. Crosses 15 AND 25.
  const crossIso = "2026-08-22T00:00:30.000Z";
  runContract(t, "FX_Big", "22222222-2222-2222-2222-222222222222", crossIso, 20);
  check("(setup) the second contribution priced too", (t.eventProgress("fx")?.points ?? 0) === 260, String(t.eventProgress("fx")?.points));
  const crossMs = Date.parse(crossIso);
  const due = t.eventRewardPrompts(crossMs + RECEIPT_WINDOW_MS + 10);
  check("crossing an UNKNOWN tier raises a prompt", due.length === 1, String(due.length));
  // 🔴 15 is already measured; only 25 is worth asking about, and only one card may be up at once.
  check("...and it is the tier with no measured reward (25, not 15)", due[0]?.tier === 25, String(due[0]?.tier));
  check("...carrying the unconfirmed candidate as the thing being ASKED about",
    due[0]?.candidate === "GUESSED AT TWENTYFIVE", String(due[0]?.candidate));
  check("...and no observation, because no blueprint arrived", due[0]?.observed === null, String(due[0]?.observed));

  const answered = t.answerRewardPrompt(due[0].id, "  WHAT I ACTUALLY GOT  ", "typed");
  check("answering trims and stores the name", answered?.answer?.name === "WHAT I ACTUALLY GOT", String(answered?.answer?.name));
  check("an answered prompt stops being due", t.eventRewardPrompts(crossMs + RECEIPT_WINDOW_MS + 20).length === 0);
  check("answering the same prompt twice is refused", t.answerRewardPrompt(due[0].id, "second try", "typed") === null);
  const pending = t.unreportedRewardAnswers();
  check("the answer is queued for the site", pending.length === 1 && pending[0].tier === 25, String(pending.length));
  t.markRewardAnswerReported(due[0].id);
  check("...and drains once reported", t.unreportedRewardAnswers().length === 0);
}

// ── 🔴 A receipt on the PTU must still be correlated ─────────────────────────────────────────
// `observed` is gated on a live environment because SiteSync pushes it with replace:true. The
// correlation buffer has no such path, and an event runs on the PTU FIRST — which is precisely
// when these blanks need filling. Gating it would make the whole feature do nothing for Sub.
{
  const t = fixtureTracker("evrwptu-", [{
    id: "fx", log: "Fixture Relief", label: "Fixture Relief", status: "current",
    contractPrefixes: ["FX_"], total: 1000, tiers: [25],
    contracts: { FX_Small: 100, FX_Big: 160 }, rewards: [], rewardCandidates: [],
  }], "4.10.0-PTU");
  t.detectPatch("<2026> Environment: PTU");

  runContract(t, "FX_Small", "44444444-4444-4444-4444-444444444444", "2026-08-22T00:00:00.000Z", 10);
  const crossIso = "2026-08-22T00:00:30.000Z";
  runContract(t, "FX_Big", "33333333-3333-3333-3333-333333333333", crossIso, 20);
  // ...and the blueprint 383 ms later, exactly the measured gap.
  t.apply(parseMissionEvent(ev(notif("Received Blueprint: PTU TIER REWARD: ", 22, ZERO), "2026-08-22T00:00:30.383Z"))!);

  // POSITIVE first: the prompt must exist at all, or every claim below is free.
  const due = t.eventRewardPrompts(Date.parse(crossIso) + RECEIPT_WINDOW_MS + 10);
  check("a PTU tier crossing still raises a prompt", due.length === 1, String(due.length));
  check("🔴 the PTU receipt IS correlated to the crossing",
    due[0]?.observed === "PTU TIER REWARD", String(due[0]?.observed));
  // ...while the thing the environment gate actually protects stays protected.
  // 🔑 POSITIVE CONTROL FIRST. `isAlreadyOwned` also answers false for a name that was never in
  // the game, so "the PTU receipt is not owned" is free unless something proves the check can say
  // yes at all. A live receipt in the same tracker is that proof.
  t.detectPatch("<2026> Environment: PUB");
  t.apply(parseMissionEvent(ev(notif("Received Blueprint: A LIVE RECEIPT: ", 30, ZERO), "2026-08-22T00:01:00.000Z"))!);
  check("(control) a LIVE receipt does reach the collection", t.isAlreadyOwned("A LIVE RECEIPT"));
  check("...and the PTU blueprint is still kept OUT of the synced collection",
    !t.isAlreadyOwned("PTU TIER REWARD"));
}

console.log(failed ? `\nFAILED (${failed})` : "\nAll event-reward assertions passed");
process.exit(failed ? 1 : 0);
