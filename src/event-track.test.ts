/**
 * Dynamic-event tracking: event identification and contribution accumulation.
 *
 * 🔴 THE REGRESSION THIS EXISTS FOR. The shipped code identified an event mission with
 * `generator === "TheBackpocket"`. CIG uses that ONE generator for BOTH Return of XenoThreat
 * (5 `RoX_` contracts) and 4.10's Orison Relief (13 `ORS_`), so 10 of the 13 Orison Relief
 * contracts would have shown a player the XenoThreat reward ladder — wrong items, and a note
 * telling them to check "Journal → Return of XenoThreat" while running Siege of Orison.
 *
 * Run with:  npx tsx src/event-track.test.ts
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionTracker } from "./missions.js";
import { parseMissionEvent } from "./missions-parser.js";
import type { LogEvent } from "./parser.js";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? "  [" + detail + "]" : ""}`);
}

const CL = "12473311";
const dir = mkdtempSync(join(tmpdir(), "ev-"));

// The REAL events.json ships with the app — use it rather than a fixture, so this test fails if
// the shipped file is malformed or an event's prefixes are dropped.
const shipped = JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", "events.json"), "utf8"));

// 🔑 PRICING IS TESTED AGAINST A FIXTURE, NOT AGAINST THE SHIPPED VALUES. The shipped
// `contracts` map is a live research artefact — values are added and withdrawn as they are
// measured in game. An earlier version of this file asserted `points === 6000` straight off the
// shipped data, and withdrawing that (unverified) number turned SEVEN mechanism assertions red
// for a reason that had nothing to do with the mechanism. A test for "does pricing work" must
// own its own numbers; only the structural assertions read the real file.
const realEvents = JSON.stringify({
  ...shipped,
  events: shipped.events.map((e: { id: string }) =>
    e.id === "orison-relief"
      // Deliberately prices ONE contract and leaves the other unpriced, which is what makes the
      // priced/unpriced split observable at all.
      // 🔑 `rewards` is pinned EMPTY for the same reason `contracts` is pinned: both are live
      // research artefacts in the shipped file, discovered by playing. Reading either straight
      // off data/events.json makes a MECHANISM test fail the moment a measurement lands — which
      // is exactly what happened on 2026-08-22, when confirming the 15% reward (S-38
      // "SecondWind" Pistol) turned the unknown-vs-empty assertion red. The mechanism being
      // tested is "empty rewards report as UNKNOWN, not as none", and it needs its own data.
      ? { ...e, contracts: { ORS_MA_HaulingMedium: 6000 }, rewards: [] }
      : e),
});
writeFileSync(join(dir, "events.json"), realEvents);

// Minimal dataset carrying the real key/generator shape of both events.
const m = (title: string, gen: string, pools = {}) => ({ title, generatorClass: gen, missionKey: title, pools });
writeFileSync(join(dir, "blueprints.latest.json"), JSON.stringify({
  schema: "sc-blueprint-pools/2", version: `4.10.0-LIVE.${CL}`, changelist: CL, missionCount: 3,
  missions: {
    ORS_MA_HaulingMedium: m("Orison Relief: Medium Supply Haul", "TheBackpocket"),
    ORS_SA: m("Orison Relief: Strike Nine Tails Squad", "TheBackpocket"),
    RoX_SA: m("XenoThreat Strike", "TheBackpocket"),
  },
}));

const t = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "ev-st-")) });
t.detectPatch(`<2026> ProductVersion: 4.10 Changelist: ${CL}`);

// ---- 1. Event identification: the prefix decides, never the shared generator ----
const orison = t.eventForMission("ORS_MA_HaulingMedium", "TheBackpocket");
const orison2 = t.eventForMission("ORS_SA", "TheBackpocket");
const xeno = t.eventForMission("RoX_SA", "TheBackpocket");

check("an ORS_ contract resolves to Orison Relief", orison?.id === "orison-relief", String(orison?.id));
check("...and NOT to XenoThreat — the regression this file exists for", orison?.id !== "return-of-xenothreat");
check("a second ORS_ contract resolves the same way", orison2?.id === "orison-relief", String(orison2?.id));
check("a RoX_ contract still resolves to XenoThreat", xeno?.id === "return-of-xenothreat", String(xeno?.id));
check("the two events are actually different definitions", orison?.id !== xeno?.id);

// The shared generator alone must NOT pick a winner: two events claim it, so we decline.
check("an unknown key on the SHARED generator declines rather than guessing",
  t.eventForMission(null, "TheBackpocket") === null,
  "both events claim TheBackpocket, so a generator match cannot choose");
check("an unrelated mission is not an event at all",
  t.eventForMission("Adagio_Something", "Adagio_Generator") === null);

// Non-empty guard: every assertion above compares ids, and an events.json that failed to load
// would make them all `undefined === undefined`-ish. State outright that the file loaded.
check("events.json actually loaded (non-empty)", t.allEventProgress().length >= 2,
  `got ${t.allEventProgress().length} events`);

// ---- 2. The tiers really do differ between events — the argument for tiers being data ----
const oTiers = t.eventProgress("orison-relief")?.tiers.map((x) => x.pct) ?? [];
const xTiers = t.eventProgress("return-of-xenothreat")?.tiers.map((x) => x.pct) ?? [];
check("Orison Relief tiers are 15/25/43/57/80/100", oTiers.join(",") === "15,25,43,57,80,100", oTiers.join(","));
check("XenoThreat tiers are 15/25/50/60/85/100", xTiers.join(",") === "15,25,50,60,85,100", xTiers.join(","));
check("the two ladders are NOT the same", oTiers.join(",") !== xTiers.join(","));

// ---- 3. Contribution accumulation, driven by the REAL log lines ----
const ev = (message: string, ts: string): LogEvent =>
  ({ eventTag: "SHUDEvent_OnNotification", timestamp: ts, message }) as LogEvent;

// Verbatim from Sub's 4.10 PTU log (changelist 12473311).
const COMPLETE = 'Added notification "Contract Complete: Orison Relief: Medium Supply Haul: " [42] to queue. New queue size: 1, MissionId: [c48baebd-b6da-4537-86f1-1355c5e2d488], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';
const JOURNAL = 'Added notification "Journal Entry Added: Orison Relief: " [43] to queue. New queue size: 2, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';
const JURISDICTION = 'Added notification "Journal Entry Added: Jurisdiction: Hurston Dynamics : " [9] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';

// ⚠️ This comment used to read "the tracker only records LIVE-environment progress, same rule as
// blueprints". That has been false since `5f512f7` deliberately removed the environment gate on
// event progress — block 6 below asserts the opposite outright. Corrected 2026-08-27; it was the
// third copy of the same stale claim (the skill and a source comment carried it too), and it is
// what sent a whole flight looking for a sync bug that did not exist.
t.detectPatch("<2026> Environment: PUB");
// A marker teaches the tracker which contract this missionId is.
t.apply({
  kind: "marker", ts: "2026-08-19T21:24:19.763Z", missionId: "c48baebd-b6da-4537-86f1-1355c5e2d488",
  contract: "ORS_MA_HaulingMedium_0", contractKey: "ORS_MA_HaulingMedium", generator: "TheBackpocket",
  contractDefId: "071fd78d-ae7f-452d-b39a-98bfb9804c8c", objectiveId: "pickup_x_0", markerEntityId: "2548", pos: null,
});
t.apply(parseMissionEvent(ev(COMPLETE, "2026-08-19T21:51:36.027Z"))!);
t.apply(parseMissionEvent(ev(JOURNAL, "2026-08-19T21:51:36.161Z"))!);

const p1 = t.eventProgress("orison-relief")!;
check("one contribution was recorded", p1.contributions.length === 1, String(p1.contributions.length));
check("it was attributed to the right contract", p1.contributions[0]?.key === "ORS_MA_HaulingMedium", String(p1.contributions[0]?.key));
check("it was priced from events.json (6,000 measured)", p1.points === 6000, String(p1.points));
check("nothing is unpriced yet", p1.unpriced === 0, String(p1.unpriced));
check("the percentage is points/total", p1.pct !== null && Math.abs(p1.pct - (6000 / 288000) * 100) < 1e-9, String(p1.pct));
check("no tier is reached at ~2%", p1.tiers.every((x) => !x.reached));

// A jurisdiction entry must NOT count — it is not event progress.
t.apply(parseMissionEvent(ev(JURISDICTION, "2026-08-19T21:52:00.000Z"))!);
check("a Jurisdiction journal entry adds nothing",
  t.eventProgress("orison-relief")!.contributions.length === 1,
  String(t.eventProgress("orison-relief")!.contributions.length));
// ⚠️ The assertion above PASSES EVEN WITHOUT THE `ev.jurisdiction` GUARD — negative-controlled
// 2026-08-19 and it stayed green, because "Jurisdiction: Hurston Dynamics" matches no declared
// event name and is dropped by the exact-match lookup anyway. Left in place (it is still the
// behaviour we want) but it is NOT what protects us. The block below is: it declares an event
// whose `log` deliberately COLLIDES with the jurisdiction subject, so only the flag can save it.
{
  const cdir = mkdtempSync(join(tmpdir(), "ev-col-"));
  writeFileSync(join(cdir, "blueprints.latest.json"), JSON.stringify({
    schema: "sc-blueprint-pools/2", version: `4.10.0-LIVE.${CL}`, changelist: CL, missionCount: 0, missions: {},
  }));
  writeFileSync(join(cdir, "events.json"), JSON.stringify({
    schema: "sc-events/1",
    events: [{ id: "collider", log: "Jurisdiction: Hurston Dynamics", label: "Collider", total: 100, tiers: [100], contracts: {} }],
  }));
  const c = new MissionTracker({ dataDir: cdir, stateDir: mkdtempSync(join(tmpdir(), "ev-col-st-")) });
  c.detectPatch(`<2026> ProductVersion: 4.10 Changelist: ${CL}`);
  c.detectPatch("<2026> Environment: PUB");
  check("the collider fixture really did load", c.eventProgress("collider") !== null);
  c.apply(parseMissionEvent(ev(JURISDICTION, "2026-08-19T21:52:00.000Z"))!);
  check("a jurisdiction entry is refused even when an event's name collides with it",
    c.eventProgress("collider")!.contributions.length === 0,
    String(c.eventProgress("collider")!.contributions.length));
}

// ---- 4. An UNPRICED contribution is counted separately, never silently as zero ----
t.apply({
  kind: "marker", ts: "2026-08-19T22:10:00.000Z", missionId: "aaaaaaaa-0000-0000-0000-000000000001",
  contract: "ORS_SA_0", contractKey: "ORS_SA", generator: "TheBackpocket",
  contractDefId: "x", objectiveId: "y", markerEntityId: "1", pos: null,
});
t.apply(parseMissionEvent(ev('Added notification "Contract Complete: Orison Relief: Strike Nine Tails Squad: " [1] to queue. MissionId: [aaaaaaaa-0000-0000-0000-000000000001]', "2026-08-19T22:11:00.000Z"))!);
t.apply(parseMissionEvent(ev(JOURNAL, "2026-08-19T22:11:00.100Z"))!);

const p2 = t.eventProgress("orison-relief")!;
check("the second contribution was recorded", p2.contributions.length === 2, String(p2.contributions.length));
check("ORS_SA has no measured value, so it is UNPRICED", p2.unpriced === 1, String(p2.unpriced));
check("...and points did NOT grow by a guessed amount", p2.points === 6000, String(p2.points));
check("the unpriced one is flagged on the contribution itself",
  p2.contributions.some((c) => c.key === "ORS_SA" && c.points === null));

// ---- 4b. TWO CONTRACTS COMPLETING AT ONCE — the case real data caught ----
// 🔴 Verbatim shape from Sub's live 4.10 log (`… (17 09 14).log`): two completions in the SAME
// millisecond, then two journal entries 115 ms apart. A single-slot correlation credited BOTH
// entries to the second completion — 12,000 points from one 6,000 contract, and the other
// contract's unknown value never recorded as unpriced.
{
  const bdir = mkdtempSync(join(tmpdir(), "ev-batch-"));
  writeFileSync(join(bdir, "events.json"), realEvents);
  writeFileSync(join(bdir, "blueprints.latest.json"), JSON.stringify({
    schema: "sc-blueprint-pools/2", version: `4.10.0-LIVE.${CL}`, changelist: CL, missionCount: 2,
    missions: {
      ORS_MA_HaulingMedium: m("Orison Relief: Medium Supply Haul", "TheBackpocket"),
      ORS_MA_HaulingSmall: m("Orison Relief: Small Supply Haul", "TheBackpocket"),
    },
  }));
  const b = new MissionTracker({ dataDir: bdir, stateDir: mkdtempSync(join(tmpdir(), "ev-batch-st-")) });
  b.detectPatch(`<2026> ProductVersion: 4.10 Changelist: ${CL}`);
  b.detectPatch("<2026> Environment: PUB");

  const SMALL = "1c862f01-6256-4cf8-a367-478b0d542c79";
  const MEDIUM = "8ce13767-fbb8-4bf7-9136-70539eb513a6";
  for (const [mid, ck] of [[SMALL, "ORS_MA_HaulingSmall"], [MEDIUM, "ORS_MA_HaulingMedium"]] as const) {
    b.apply({
      kind: "marker", ts: "2026-08-19T23:00:00.000Z", missionId: mid, contract: `${ck}_0`, contractKey: ck,
      generator: "TheBackpocket", contractDefId: "x", objectiveId: "y", markerEntityId: "1", pos: null,
    });
  }
  // Both complete in the same millisecond — Small first, exactly as the log has it.
  b.apply(parseMissionEvent(ev(`Added notification "Contract Complete: Orison Relief: Small Supply Haul: " [35] to queue. MissionId: [${SMALL}]`, "2026-08-19T23:05:01.981Z"))!);
  b.apply(parseMissionEvent(ev(`Added notification "Contract Complete: Orison Relief: Medium Supply Haul: " [36] to queue. MissionId: [${MEDIUM}]`, "2026-08-19T23:05:01.981Z"))!);
  // Then one journal entry each, 115 ms apart.
  b.apply(parseMissionEvent(ev(JOURNAL, "2026-08-19T23:05:02.116Z"))!);
  b.apply(parseMissionEvent(ev(JOURNAL, "2026-08-19T23:05:02.231Z"))!);

  const p = b.eventProgress("orison-relief")!;
  const keys = p.contributions.map((c) => c.key).sort();
  check("two simultaneous completions record TWO contributions", p.contributions.length === 2, String(p.contributions.length));
  check("each journal entry claims a DIFFERENT completion",
    keys.join(",") === "ORS_MA_HaulingMedium,ORS_MA_HaulingSmall", keys.join(","));
  check("only the measured contract contributes points (6,000, not 12,000)", p.points === 6000, String(p.points));
  check("the unmeasured Small haul is counted as UNPRICED", p.unpriced === 1, String(p.unpriced));
}

// ---- 5. A past event with no total claims no percentage ----
const past = t.eventProgress("return-of-xenothreat")!;
check("XenoThreat declares no total", past.total === null);
check("...so it reports no percentage rather than 0%", past.pct === null, String(past.pct));
check("but its 25 rewards are still listed", past.tiers.reduce((s, x) => s + x.rewards.length, 0) === 25,
  String(past.tiers.reduce((s, x) => s + x.rewards.length, 0)));
check("Orison Relief's rewards are honestly UNKNOWN, not empty-as-none",
  t.eventProgress("orison-relief")!.rewardsUnknown === true);

// ---- 6. A TEST SERVER STILL COUNTS FOR EVENTS (it does not for blueprints) ----
// 🔴 These two rules look identical and are not. A blueprint receipt is dropped off-PUB because
// `observed` is what SiteSync pushes with replace:true — it would overwrite the real collection
// on subliminal.gg. Event progress has NO outbound path at all: sync.ts sends got/mission/patch
// and nothing else. Gating it bought no safety and cost the feature exactly when it matters,
// because an event reaches the PTU first. Sub, 2026-08-22, 24,000 points into Orison Relief on
// 4.10 PTU with the widget showing him nothing.
// The blueprint half of this rule lives in log-env.test.ts and must stay red-able there.
{
  const pdir = mkdtempSync(join(tmpdir(), "ev-ptu-"));
  writeFileSync(join(pdir, "events.json"), realEvents);
  writeFileSync(join(pdir, "blueprints.latest.json"), JSON.stringify({
    schema: "sc-blueprint-pools/2", version: `4.10.0-PTU.${CL}`, changelist: CL, missionCount: 1,
    missions: { ORS_MA_HaulingMedium: m("Orison Relief: Medium Supply Haul", "TheBackpocket") },
  }));
  const q = new MissionTracker({ dataDir: pdir, stateDir: mkdtempSync(join(tmpdir(), "ev-ptu-st-")) });
  q.detectPatch(`<2026> ProductVersion: 4.10 Changelist: ${CL}`);
  q.detectPatch("<2026> Environment: PTU");
  const PMID = "c48baebd-b6da-4537-86f1-1355c5e2d488";
  q.apply({
    kind: "marker", ts: "2026-08-22T00:27:00.000Z", missionId: PMID,
    contract: "ORS_MA_HaulingMedium_0", contractKey: "ORS_MA_HaulingMedium", generator: "TheBackpocket",
    contractDefId: "x", objectiveId: "pickup_x_0", markerEntityId: "1", pos: null,
  } as never);
  q.apply(parseMissionEvent(ev(COMPLETE, "2026-08-22T00:27:46.100Z"))!);
  q.apply(parseMissionEvent(ev(JOURNAL, "2026-08-22T00:27:46.316Z"))!);
  const pp = q.eventProgress("orison-relief")!;
  check("a PTU journal entry DOES record event progress", pp.contributions.length === 1, String(pp.contributions.length));
  check("...priced normally, not zeroed", pp.points === 6000, String(pp.points));
  // Non-vacuous: assert the environment genuinely reads as NOT live, or this passes for the
  // boring reason that the gate never applied in the first place.
  check("...and the tracker still knows it is NOT live", q.view().envIsLive === false, String(q.view().envIsLive));
}

// ---- 7. CANDIDATES REACH THE VIEW, AND STAY OUT OF `rewards` ----------------------------------
//
// Sub, 2026-08-22: *"I know that we don't have concrete evidence, but I want to go with what we
// found on the internet. And then we allow people to tell us if we have it wrong."* So the
// unconfirmed guesses in `rewardCandidates` may now be SHOWN — and may still never be shown as a
// reward. `EventProgress.tiers[]` carries them in a second array for exactly that reason, and the
// one edit that would undo the whole design is somebody concatenating the two.
//
// 🔴 EVERY VALUE HERE IS THE FIXTURE'S OWN. `data/events.json` is a live research artefact — its
// `contracts` map has already turned this file red once, and its `rewards` list a second time.
// `tiers`, `total` and now `rewardCandidates` are the same kind of value, so this block declares
// an event of its own and reads nothing off the shipped file.
{
  const fdir = mkdtempSync(join(tmpdir(), "ev-cand-"));
  writeFileSync(join(fdir, "blueprints.latest.json"), JSON.stringify({
    schema: "sc-blueprint-pools/2", version: `4.10.0-LIVE.${CL}`, changelist: CL, missionCount: 4,
    missions: {
      // Four contracts on the fixture event's prefix, of which the registry prices two. That 2-of-4
      // is what the coverage assertion measures, and it is deliberately neither 0 nor everything.
      FIX_Alpha: m("Fixture Alpha", "FixtureGen"),
      FIX_Beta: m("Fixture Beta", "FixtureGen"),
      FIX_Gamma: m("Fixture Gamma", "FixtureGen"),
      FIX_Delta: m("Fixture Delta", "FixtureGen"),
      // Not on the prefix — proves the denominator is filtered rather than "every mission".
      OTHER_Thing: m("Unrelated", "FixtureGen"),
    },
  }));
  writeFileSync(join(fdir, "events.json"), JSON.stringify({
    schema: "sc-events/1",
    events: [{
      id: "fixture-event", log: "Fixture Event", label: "Fixture Event", status: "current",
      contractPrefixes: ["FIX_"], generators: ["FixtureGen"],
      total: 1000, tiers: [10, 20, 30],
      // 🔑 FIX_Ghost IS PRICED BUT NOT IN THE DATASET, and it is the only reason the numerator
      // assertion can fail. Without it `Object.keys(contracts).length` and "priced keys the
      // dataset carries" are both 2, so the buggy numerator and the correct one are the same
      // number and no assertion over this fixture could ever separate them — the control came
      // back green on exactly that (see the sixth control lesson in SKILL.md).
      // It is not hypothetical either: a value measured on the PTU, for a contract the LIVE
      // dataset has not shipped yet, is precisely this row.
      contracts: { FIX_Alpha: 100, FIX_Beta: 200, FIX_Ghost: 500 },
      rewards: [{ tier: 10, name: "FIXTURE MEASURED REWARD", item: null }],
      rewardCandidates: [
        { tier: 20, name: "FIXTURE CANDIDATE", confirmed: false },
        // A candidate the registry has since marked confirmed lives on in `rewards`; showing it
        // again as a guess would print the same item twice, once as fact and once as rumour.
        { tier: 10, name: "FIXTURE MEASURED REWARD", confirmed: true },
      ],
    }],
  }));
  const f = new MissionTracker({ dataDir: fdir, stateDir: mkdtempSync(join(tmpdir(), "ev-cand-st-")) });
  f.detectPatch(`<2026> ProductVersion: 4.10 Changelist: ${CL}`);
  f.detectPatch("<2026> Environment: PUB");
  const fp = f.eventProgress("fixture-event")!;
  const tier = (pct: number) => fp.tiers.find((x) => x.pct === pct)!;

  // POSITIVE FIRST. Every separation assertion below is of the "X is not in Y" shape, and those are
  // all satisfied for free by a view that carries nothing at all.
  check("the fixture event loaded with its three tiers", fp.tiers.length === 3, String(fp.tiers.length));
  check("a candidate REACHES the view — the whole point of the change",
    tier(20).candidates.map((c) => c.name).join(",") === "FIXTURE CANDIDATE",
    JSON.stringify(tier(20).candidates));
  check("...and the measured reward reaches it too",
    tier(10).rewards.map((r) => r.name).join(",") === "FIXTURE MEASURED REWARD",
    JSON.stringify(tier(10).rewards));

  // Now the separation, which the two above make meaningful.
  check("🔴 a candidate is NOT in `rewards`", tier(20).rewards.length === 0, JSON.stringify(tier(20).rewards));
  check("🔴 a measured reward is NOT in `candidates`", tier(10).candidates.length === 0,
    JSON.stringify(tier(10).candidates));
  check("a candidate already promoted to `rewards` is not shown a second time as a guess",
    !tier(10).candidates.some((c) => c.name === "FIXTURE MEASURED REWARD"),
    JSON.stringify(tier(10).candidates));
  check("a tier with neither carries two empty lists, not one merged one",
    tier(30).rewards.length === 0 && tier(30).candidates.length === 0);
  // A candidate carries no ownership state at all: we cannot check a collection against a name
  // nobody has confirmed, and a ✔ beside a guess is what this whole separation prevents.
  check("a candidate carries no `owned` and no `item` field",
    !("owned" in (tier(20).candidates[0] as object)) && !("item" in (tier(20).candidates[0] as object)),
    Object.keys(tier(20).candidates[0]).join(","));

  // ---- Coverage: the answer to "how many missions is a tier?" is "we cannot say" ----
  check("coverage counts the DATASET's contracts as the denominator, not the priced map's",
    fp.contractsKnown === 4, String(fp.contractsKnown));
  check("...and only the ones with a measured value THIS DATASET CARRIES as the numerator",
    fp.contractsPriced === 2, String(fp.contractsPriced));
  check("a price for a contract the dataset has never seen cannot push coverage past 100%",
    fp.contractsPriced <= fp.contractsKnown, `${fp.contractsPriced}/${fp.contractsKnown}`);
  check("a mission off the event's prefix is in neither column",
    fp.contractsKnown === 4 && fp.contractsPriced === 2);
  check("coverage is genuinely partial here, so any 'we can't say' UI is reachable",
    fp.contractsPriced < fp.contractsKnown);

  // ---- The correction path: a report with no crossing behind it ----
  const rep = f.reportEventReward("fixture-event", 20, "  WHAT IT REALLY GAVE  ", "corrected");
  check("a ladder correction is accepted for a declared tier", rep !== null, String(rep));
  check("...and its name is trimmed and stored", rep?.answer?.name === "WHAT IT REALLY GAVE", String(rep?.answer?.name));
  check("...with `observed` null, because nothing was witnessed", rep?.observed === null, String(rep?.observed));
  check("...carrying the candidate it is disagreeing with", rep?.candidate === "FIXTURE CANDIDATE", String(rep?.candidate));
  check("...and queued for upload", f.unreportedRewardAnswers().some((p) => p.id === rep?.id));
  const rep2 = f.reportEventReward("fixture-event", 20, "SECOND OPINION", "corrected");
  check("a SECOND correction to the same tier is its own claim, not a duplicate",
    rep2 !== null && rep2.id !== rep?.id, `${rep?.id} vs ${rep2?.id}`);
  check("...and both are queued", f.unreportedRewardAnswers().length === 2,
    String(f.unreportedRewardAnswers().length));
  check("🔴 a tier the event does not declare is REFUSED",
    f.reportEventReward("fixture-event", 42, "nonsense", "typed") === null);
  check("🔴 an unknown event is REFUSED",
    f.reportEventReward("no-such-event", 20, "nonsense", "typed") === null);
  check("...and neither refusal queued anything", f.unreportedRewardAnswers().length === 2,
    String(f.unreportedRewardAnswers().length));
}

// ---- 9. 🔴 A PTU CONTRIBUTION MAY NOT COUNT TOWARD A LIVE COUNTER ------------------------------
//
// Sub, just after patching off 4.10 PTU onto 4.10 live: "My Siege of Orison says 15% for me,
// which is what I got in the PTU." Measured on his running app: 44,000/288,000 across 18
// contributions ALL dated 21-22 Aug, with the app reading `logEnv PUB`. The registry is keyed by
// the event's journal NAME with no other dimension, so the two runs were one bucket and summed.
//
// 🔴 THE POINT OF THIS BLOCK IS THAT BOTH HALVES HOLD AT ONCE, and asserting either alone would
// pass on a build that is wrong in the other direction. Recording is NOT gated (block 6, and
// `5f512f7` removed that gate on purpose so an event can be tracked on the PTU, which is where
// events run first). Only COUNTING is scoped to the environment being read.
{
  const dir9 = mkdtempSync(join(tmpdir(), "ev-env-"));
  writeFileSync(join(dir9, "events.json"), realEvents);
  writeFileSync(join(dir9, "blueprints.latest.json"), JSON.stringify({
    schema: "sc-blueprint-pools/2", version: `4.10.0-PTU.${CL}`, changelist: CL, missionCount: 1,
    missions: { ORS_MA_HaulingMedium: m("Orison Relief: Medium Supply Haul", "TheBackpocket") },
  }));
  const MID = "c48baebd-b6da-4537-86f1-1355c5e2d488";
  // 🔑 Each run gets its OWN missionId, because a runtime MissionId is a per-instance GUID and
  // never repeats. Reusing one is not merely unrealistic: the first completion ends that mission,
  // so a second completion on the same id resolves no contract key and the contribution lands
  // UNPRICED — which reads as "the live run did not count" and blames the environment split for
  // a fixture fault. (It did exactly that on the first run of this block.)
  const seedOne = (tr: MissionTracker, cts: string, jts: string, mid = MID) => {
    tr.apply({
      kind: "marker", ts: cts, missionId: mid, contract: "ORS_MA_HaulingMedium_0",
      contractKey: "ORS_MA_HaulingMedium", generator: "TheBackpocket",
      contractDefId: "x", objectiveId: "pickup_x_0", markerEntityId: "1", pos: null,
    } as never);
    tr.apply(parseMissionEvent(ev(COMPLETE.replace(MID, mid), cts))!);
    tr.apply(parseMissionEvent(ev(JOURNAL, jts))!);
  };

  const st9 = mkdtempSync(join(tmpdir(), "ev-env-st-"));
  const q = new MissionTracker({ dataDir: dir9, stateDir: st9 });
  q.detectPatch(`<2026> ProductVersion: 4.10 Changelist: ${CL}`);
  q.detectPatch("<2026> Environment: PTU");
  seedOne(q, "2026-08-22T00:27:46.100Z", "2026-08-22T00:27:46.316Z");

  // Positive first: the PTU run must be VISIBLE while on the PTU, or the rest of this block is
  // vouching for a build that simply stopped recording — which is the regression `5f512f7` fixed.
  const onPtu = q.eventProgress("orison-relief")!;
  check("PTU: the contribution is recorded AND counted while on the PTU",
    onPtu.contributions.length === 1 && onPtu.points === 6000,
    `n=${onPtu.contributions.length} points=${onPtu.points}`);
  check("PTU: nothing is being excluded yet", onPtu.otherEnv === 0, String(onPtu.otherEnv));
  check("...and the contribution carries the environment it was earned in",
    onPtu.contributions[0]?.env === "PTU", String(onPtu.contributions[0]?.env));

  // Now patch to live. Same tracker, same state, one header line.
  q.detectPatch("<2026> Environment: PUB");
  const onLive = q.eventProgress("orison-relief")!;
  check("🔴 LIVE: the PTU contribution does NOT count — Sub's bug",
    onLive.points === 0 && onLive.pct === 0, `points=${onLive.points} pct=${onLive.pct}`);
  check("🔴 LIVE: and no tier reads as reached", onLive.tiers.every((x) => !x.reached));
  check("LIVE: the excluded one is REPORTED, not silently dropped",
    onLive.otherEnv === 1, String(onLive.otherEnv));
  // It must still be on disk: a counter that is wrong for this server is still the true record
  // for the other one, and the player goes back to the PTU next patch.
  check("LIVE: it is EXCLUDED, not deleted — still there on the PTU",
    (() => { q.detectPatch("<2026> Environment: PTU");
             const back = q.eventProgress("orison-relief")!;
             q.detectPatch("<2026> Environment: PUB");
             return back.points === 6000; })(), "switching back restores it");

  // A live run on the same event counts normally, side by side with the PTU one on disk.
  q.detectPatch("<2026> Environment: PUB");
  seedOne(q, "2026-08-26T10:00:00.000Z", "2026-08-26T10:00:00.200Z",
    "11111111-2222-3333-4444-555555555555");
  const mixed = q.eventProgress("orison-relief")!;
  check("LIVE: a genuine live run counts", mixed.points === 6000, String(mixed.points));
  check("...counting exactly ONE contribution, not both", mixed.contributions.length === 1,
    String(mixed.contributions.length));
  check("...with the PTU one still held aside", mixed.otherEnv === 1, String(mixed.otherEnv));
}

// ---- 10. A contribution recorded before the `env` field existed counts as LIVE ------------------
//
// The app-wide rule is that an UNKNOWN environment reads as LIVE (see `logEnv`), and the
// alternative here is worse than the bug: treating legacy rows as "unknown, do not count" would
// silently delete real live progress from every existing player in order to repair the minority
// who used the PTU, and nothing on disk can tell those two apart after the fact. The purge
// control in block 11 is the honest repair for legacy data.
{
  const dir10 = mkdtempSync(join(tmpdir(), "ev-legacy-"));
  writeFileSync(join(dir10, "events.json"), realEvents);
  const st10 = mkdtempSync(join(tmpdir(), "ev-legacy-st-"));
  // A state file exactly as an older build wrote it: no `env` key on the contribution.
  writeFileSync(join(st10, "collected.json"), JSON.stringify({
    observed: [], eventContributions: { "Orison Relief": [
      { key: "ORS_MA_HaulingMedium", title: null, at: "2026-08-01T00:00:00.000Z", points: 6000 },
    ]},
  }));
  const l = new MissionTracker({ dataDir: dir10, stateDir: st10 });
  l.detectPatch(`<2026> ProductVersion: 4.10 Changelist: ${CL}`);
  l.detectPatch("<2026> Environment: PUB");
  const legacy = l.eventProgress("orison-relief")!;
  check("legacy contribution (no env) counts as LIVE", legacy.points === 6000, String(legacy.points));
  check("...and is not reported as excluded", legacy.otherEnv === 0, String(legacy.otherEnv));
  // The other side of the same rule: on a test server it is NOT this server's progress.
  l.detectPatch("<2026> Environment: PTU");
  const legacyPtu = l.eventProgress("orison-relief")!;
  check("...and does NOT count on the PTU", legacyPtu.points === 0, String(legacyPtu.points));
}

// ---- 11. The purge -----------------------------------------------------------------------------
//
// Exists because the app can NEVER observe a server-side reset: event points ride CIG's
// `ReputationService` and are never reported to the client, which is the whole reason this
// counter is accumulated from witnessed completions. A wipe or a season restart zeroes the real
// progress with no signal the app can read. `env` covers what we can detect; this covers what we
// cannot.
{
  const dir11 = mkdtempSync(join(tmpdir(), "ev-reset-"));
  writeFileSync(join(dir11, "events.json"), realEvents);
  writeFileSync(join(dir11, "blueprints.latest.json"), JSON.stringify({
    schema: "sc-blueprint-pools/2", version: `4.10.0-LIVE.${CL}`, changelist: CL, missionCount: 1,
    missions: { ORS_MA_HaulingMedium: m("Orison Relief: Medium Supply Haul", "TheBackpocket") },
  }));
  const st11 = mkdtempSync(join(tmpdir(), "ev-reset-st-"));
  const r = new MissionTracker({ dataDir: dir11, stateDir: st11 });
  r.detectPatch(`<2026> ProductVersion: 4.10 Changelist: ${CL}`);
  r.detectPatch("<2026> Environment: PUB");
  r.apply({
    kind: "marker", ts: "2026-08-26T10:00:00.000Z", missionId: "c48baebd-b6da-4537-86f1-1355c5e2d488",
    contract: "ORS_MA_HaulingMedium_0", contractKey: "ORS_MA_HaulingMedium", generator: "TheBackpocket",
    contractDefId: "x", objectiveId: "pickup_x_0", markerEntityId: "1", pos: null,
  } as never);
  r.apply(parseMissionEvent(ev(COMPLETE, "2026-08-26T10:00:00.000Z"))!);
  r.apply(parseMissionEvent(ev(JOURNAL, "2026-08-26T10:00:00.200Z"))!);

  // Positive first — sourced from the tracker BEFORE the reset, so "it is now zero" cannot pass
  // for the boring reason that it was always zero.
  const before = r.eventProgress("orison-relief")!;
  check("(setup) there really is progress to purge", before.points === 6000 && before.contributions.length === 1,
    `points=${before.points} n=${before.contributions.length}`);

  const discarded = r.resetEventProgress("orison-relief");
  check("the purge reports how much it discarded", discarded === 1, String(discarded));
  const after = r.eventProgress("orison-relief")!;
  check("🔴 progress is zero after the purge", after.points === 0 && after.contributions.length === 0,
    `points=${after.points} n=${after.contributions.length}`);
  check("...and nothing is merely hidden as another environment's", after.otherEnv === 0, String(after.otherEnv));
  check("...and no tier reads as reached", after.tiers.every((x) => !x.reached));
  // The event itself must survive — this forgets progress, not the definition.
  check("the event still exists afterwards", after.label.length > 0 && after.total === 288000, String(after.total));

  // It has to reach DISK, or the counter comes back on the next launch and the button looks broken.
  const onDisk = JSON.parse(readFileSync(join(st11, "collected.json"), "utf8"));
  check("🔴 the purge is persisted, not just in memory",
    Object.keys(onDisk.eventContributions ?? {}).length === 0,
    JSON.stringify(onDisk.eventContributions));
  // 🔑 askedTiers must go too. Left behind, the player re-earns the tier for real and is never
  // asked about the reward, because the app still believes it already asked — the reset would
  // silently disable the very thing it was meant to restore.
  check("...and the tier bookkeeping is cleared with it",
    Object.keys(onDisk.askedTiers ?? {}).length === 0, JSON.stringify(onDisk.askedTiers));

  check("an unknown event id purges nothing and does not throw",
    r.resetEventProgress("no-such-event") === 0);
}

console.log(failed ? `\nFAILED (${failed})` : "\nevent-track tests passed");
process.exit(failed ? 1 : 0);
