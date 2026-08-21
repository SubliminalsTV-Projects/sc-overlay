/**
 * The session scoreboard: one completion counted ONCE, and money that says where it came from.
 *
 * 🔴 TWO REAL BUGS, BOTH FOUND ON SUB'S OWN LOG (2026-08-21), both reported as "my aUEC per hour
 * is not going up".
 *
 * 1. EVERY COMPLETION WAS COUNTED TWICE. One finished contract emits several log signals a few
 *    milliseconds apart — measured on Combat Gauntlet Scenario #5:
 *      20:29:55.795  <MissionEnded> mission_state MISSION_STATE_COMPLETED   missionId 8ddc8dfb…
 *      20:29:55.795  <EndMission>   CompletionType[Complete]                missionId 8ddc8dfb…
 *      20:29:55.802  <SHUDEvent_OnNotification> "Contract Complete: …"      missionId 8ddc8dfb…
 *    The history deduped on an EXACT timestamp, so seven milliseconds was enough to make the same
 *    contract two entries. The contract count and the reputation on the idle scoreboard were
 *    therefore roughly double for as long as both signals have been parsed.
 *
 * 2. NO MONEY AT ALL, because the game stopped saying. `Awarded N aUEC` does not appear in a
 *    current log: measured zero occurrences of `Awarded `, `aUEC` or `UEC` across a 15.5 MB
 *    session file that contained 59 `Contract Complete` and 67 `Contract Accepted` — the control
 *    that proves the search worked. Money now falls back to the contract's listed payout and the
 *    view says so.
 *
 * Run with:  npx tsx src/session-earnings.test.ts
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionTracker } from "./missions.js";
import { parseMissionEvent } from "./missions-parser.js";
import type { LogEvent } from "./parser.js";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
}

const CL = "12479687";
const dir = mkdtempSync(join(tmpdir(), "earn-"));

/** A minimal dataset: two contracts with a LISTED payout, one of them modelled, and one that
 *  lists none at all. Enough to separate "counted", "counted but flagged" and "not counted". */
const MID = "aaaaaaaa-0000-0000-0000-00000000000a";
const MID2 = "bbbbbbbb-0000-0000-0000-00000000000b";
writeFileSync(join(dir, `blueprints.${CL}.json`), JSON.stringify({
  schema: "sc-blueprints/7",
  version: CL,
  changelist: CL,
  missions: {
    PAYS_FIXED: {
      title: "Fixed Payer", giver: "Testers", generatorClass: "T",
      payout: { min: 0, max: 50000, currency: "UEC" }, payoutCalculated: false,
      pools: {}, reputationGained: [], reputationLost: [],
    },
    PAYS_MODELLED: {
      title: "Modelled Payer", giver: "Testers", generatorClass: "T",
      payout: { min: 0, max: 90000, currency: "UEC" }, payoutCalculated: true,
      pools: {}, reputationGained: [], reputationLost: [],
    },
    PAYS_NOTHING: {
      title: "Free Work", giver: "Testers", generatorClass: "T",
      payout: null, pools: {}, reputationGained: [], reputationLost: [],
    },
    PAYS_MERITS: {
      title: "Prison Job", giver: "Testers", generatorClass: "T",
      payout: { min: 0, max: 7000, currency: "MER" }, payoutCalculated: false,
      pools: {}, reputationGained: [], reputationLost: [],
    },
  },
  index: [],
}));

/** Timestamps have to be NEAR NOW: the scoreboard counts contracts inside a 90-minute window and
 *  sums the session inside a 20-minute gap rule, so fixed calendar timestamps fall outside both
 *  and every assertion reads zero — which is how the first draft of this file failed against
 *  perfectly good code. Minutes-ago, formatted the way the log formats them. */
const ago = (mins: number, ms = 0): string =>
  new Date(Date.now() - mins * 60_000).toISOString().replace(/\.\d{3}Z$/, "." + String(ms).padStart(3, "0") + "Z");

/** ⚠️ The `<EventTag>` is a SEPARATE FIELD, not a prefix on the message — a first draft of this
 *  file baked it into `message` and every line parsed to null, which reads exactly like the code
 *  under test recording nothing. Same shape `event-track.test.ts` uses. */
const ev = (tag: string, message: string, ts: string): LogEvent =>
  ({ eventTag: tag, timestamp: ts, message }) as LogEvent;

function feed(t: MissionTracker, tag: string, msg: string, ts: string): void {
  const e = parseMissionEvent(ev(tag, msg, ts));
  if (e) t.apply(e);
}

/** The three signals one finished contract really emits, verbatim in shape from Sub's log. */
function completeOnce(t: MissionTracker, missionId: string, title: string, minsAgo: number, ms: [number, number]): void {
  const at = (off: number) => ago(minsAgo, off);
  feed(t, "MissionEnded", `Received MissionEnded push message for: mission_id ${missionId} - mission_state MISSION_STATE_COMPLETED [Team_GameServices][Missions]`, at(ms[0]));
  feed(t, "EndMission", `Ending mission for player. MissionId[${missionId}] Player[IMC-SubliminaL] PlayerId[868220631456] CompletionType[Complete] Reason[Mission Ended] [Team_MissionFeatures]`, at(ms[0]));
  feed(t, "SHUDEvent_OnNotification", `Added notification "Contract Complete: ${title}: " [228] to queue. New queue size: 1, MissionId: [${missionId}], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`, at(ms[1]));
}

const mk = () => {
  const t = new MissionTracker({ dataDir: dir });
  t.loadDataset(CL);
  return t;
};

console.log("🔴 one completion, several signals — counted ONCE");
{
  const t = mk();
  feed(t, "CreateMarker", `Creating marker for mission ${MID} with contract PAYS_FIXED`, ago(9));
  completeOnce(t, MID, "Fixed Payer", 5, [795, 802]);
  const e = t.view().earnings;
  // POSITIVE FIRST: without this, "not 2" is satisfied by a history that recorded nothing at all.
  check("the completion was recorded", e.missions >= 1, "missions=" + e.missions);
  check("...exactly once, not once per log signal", e.missions === 1, "missions=" + e.missions);
  check("...and its money is counted once", e.aUECTotal === 50000, String(e.aUECTotal));
}

console.log("\n🔴 two DIFFERENT contracts in the same millisecond stay two");
{
  // The event-track work measured this happening for real, and a window-only dedupe would
  // silently merge them — losing a completion is the same class of bug in the other direction.
  const t = mk();
  feed(t, "CreateMarker", `Creating marker for mission ${MID} with contract PAYS_FIXED`, ago(9));
  feed(t, "CreateMarker", `Creating marker for mission ${MID2} with contract PAYS_MODELLED`, ago(9));
  completeOnce(t, MID, "Fixed Payer", 5, [981, 981]);
  completeOnce(t, MID2, "Modelled Payer", 5, [981, 981]);
  const e = t.view().earnings;
  check("both are present", e.missions >= 2, "missions=" + e.missions);
  check("...and neither swallowed the other", e.missions === 2, "missions=" + e.missions);
  check("both payouts counted", e.aUECTotal === 50000 + 90000, String(e.aUECTotal));
}

console.log("\n🔴 money says where it came from");
{
  const t = mk();
  feed(t, "CreateMarker", `Creating marker for mission ${MID} with contract PAYS_MODELLED`, ago(9));
  completeOnce(t, MID, "Modelled Payer", 5, [100, 107]);
  const e = t.view().earnings;
  check("a modelled payout still produces a figure", e.aUECTotal === 90000, String(e.aUECTotal));
  check("...flagged as an ESTIMATE, not a logged award", e.aUECEstimated === true);
  check("...and specifically as MODELLED", e.aUECModelled === true);
  check("...and it says how many contracts it covers", e.aUECFrom === 1, String(e.aUECFrom));
}
{
  const t = mk();
  feed(t, "CreateMarker", `Creating marker for mission ${MID} with contract PAYS_FIXED`, ago(9));
  completeOnce(t, MID, "Fixed Payer", 5, [100, 107]);
  const e = t.view().earnings;
  check("a payout read from the game files is NOT flagged as modelled", e.aUECModelled === false);
  check("...but is still an estimate, because the game logged no award", e.aUECEstimated === true);
}

console.log("\ncontracts that pay nothing, and currencies that are not money");
{
  const t = mk();
  feed(t, "CreateMarker", `Creating marker for mission ${MID} with contract PAYS_NOTHING`, ago(9));
  completeOnce(t, MID, "Free Work", 5, [100, 107]);
  const e = t.view().earnings;
  check("the completion still counts as a contract", e.missions === 1, String(e.missions));
  check("...but contributes no money", e.aUECTotal === null, String(e.aUECTotal));
  check("...and is excluded from the coverage count", e.aUECFrom === 0, String(e.aUECFrom));
}
{
  // 🔴 MER is prison MERITS, not money. Summing it into an aUEC total would invent income.
  const t = mk();
  feed(t, "CreateMarker", `Creating marker for mission ${MID} with contract PAYS_MERITS`, ago(9));
  completeOnce(t, MID, "Prison Job", 5, [100, 107]);
  const e = t.view().earnings;
  check("a merits payout is recorded as a contract", e.missions === 1, String(e.missions));
  check("...and NEVER counted as aUEC", e.aUECTotal === null, String(e.aUECTotal));
}

console.log("\n🔴 history ALREADY doubled on disk is repaired on load");
{
  // The insert-side dedupe only stops NEW duplicates. Every completion recorded before it existed
  // sits on disk twice and is restored verbatim, so without a repair the scoreboard stays wrong
  // for every existing user — and the fix looks like it did not work, which is exactly how this
  // presented while it was being diagnosed on Sub's machine.
  const base = Date.now() - 5 * 60_000;
  const iso = (off: number) => new Date(base + off).toISOString();
  const doubled = [
    // The `end` signals carry no title; the contractComplete a few ms later does.
    { missionId: MID, title: null, aUEC: null, at: iso(0) },
    { missionId: MID, title: "Fixed Payer", aUEC: null, at: iso(3) },
    { missionId: MID2, title: null, aUEC: null, at: iso(1) },
    { missionId: MID2, title: "Modelled Payer", aUEC: null, at: iso(4) },
  ];
  // The tracker restores from `<stateDir>/collected.json`.
  const sdir = mkdtempSync(join(tmpdir(), "earn-state-"));
  writeFileSync(join(sdir, "collected.json"), JSON.stringify({ missionHistory: doubled }));
  const t2 = new MissionTracker({ dataDir: dir, stateDir: sdir });
  t2.loadDataset(CL);
  const e = t2.view().earnings;
  check("the restored completions are present", e.missions >= 2, "missions=" + e.missions);
  check("...collapsed to one entry each, not four", e.missions === 2, "missions=" + e.missions);
  check("...and the TITLED signal survived the merge", e.aUECTotal === 50000 + 90000, String(e.aUECTotal));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
