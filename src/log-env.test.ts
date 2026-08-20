/**
 * Self-check for the LIVE/PTU environment gate.
 * Run with:  npx tsx src/log-env.test.ts
 *
 * Only PUB (live) progress counts. `verifyFromLogs` has always enforced that; the LIVE
 * watcher path never did, so playing PTU with the app open folded test-server blueprints
 * into the real collection — which SiteSync then pushed with replace:true, as if earned
 * on live. These assertions pin the gate AND its deliberate tolerance: an UNKNOWN
 * environment must behave as live, because the app can attach to a log mid-session and
 * never see the header, and breaking the common install to protect the rare one is worse
 * than the bug being fixed.
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
const REAL_BLUEPRINT = "Morozov-SH Arms"; // a real pool name, so it resolves like the live path

/** How many blueprints this tracker holds because it SAW A RECEIPT IN THE LOG.
 *
 *  🔑 Not collectedTotal. That counts every ownership source — starter-gear defaults, manual
 *  ticks, fabricator confirmations — so it reads 8 on a brand-new profile before a single log
 *  line has been parsed, and "collectedTotal > 0" would call every gate below satisfied no
 *  matter what the parser did. These tests are about ONE question: did a receipt from this
 *  environment get recorded? So ask exactly that. */
const inGameCount = (t: MissionTracker): number =>
  t.collectedItemsWithDates().filter((x) => x.source === "in-game").length;

/** A tracker fed one header line then one blueprint receipt. Returns whether it counted. */
function collectsUnder(header: string | null): boolean {
  const stateDir = mkdtempSync(join(tmpdir(), "logenv-"));
  try {
    const t = new MissionTracker({ dataDir, stateDir });
    t.detectPatch("<2026-08-01T00:00:00.000Z> ProductVersion: 4.9.188.23497");
    if (header) t.detectPatch(header);
    t.apply({ kind: "blueprintReceived", ts: new Date().toISOString(), name: REAL_BLUEPRINT, missionId: null } as never);
    return inGameCount(t) > 0;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// The real header shapes, copied from Sub's own logs.
const PUB = `<2026-08-01T00:00:00.000Z>    [Cmdline* ] --envtag='PUB'`;
const PTU = `<2026-08-01T00:00:00.000Z>    [Cmdline* ] --envtag='PTU'`;
const EPTU = `<2026-08-01T00:00:00.000Z> [Trace] Environment:   EPTU`;
const TECH = `<2026-08-01T00:00:00.000Z>    [Cmdline* ] --envtag='TECH-PREVIEW'`;

check("PUB (live) receipts COUNT", collectsUnder(PUB), true);
check("no header yet — unknown counts as live", collectsUnder(null), true);
check("PTU receipts are DROPPED", collectsUnder(PTU), false);
check("EPTU (the 'Environment:' form) is DROPPED", collectsUnder(EPTU), false);
check("TECH-PREVIEW is DROPPED", collectsUnder(TECH), false);

// A log that goes PTU and then back to PUB (the launcher rewrites the header per session)
// must start counting again — the gate is about the CURRENT session, not a permanent mark.
{
  const stateDir = mkdtempSync(join(tmpdir(), "logenv-"));
  try {
    const t = new MissionTracker({ dataDir, stateDir });
    t.detectPatch("<2026-08-01T00:00:00.000Z> ProductVersion: 4.9.188.23497");
    t.detectPatch(PTU);
    t.apply({ kind: "blueprintReceived", ts: new Date().toISOString(), name: REAL_BLUEPRINT, missionId: null } as never);
    check("still nothing after the PTU session", inGameCount(t), 0);
    t.detectPatch(PUB);
    t.apply({ kind: "blueprintReceived", ts: new Date().toISOString(), name: REAL_BLUEPRINT, missionId: null } as never);
    check("a later PUB session counts again", inGameCount(t) > 0, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// ---- PTU MUST STILL BE USABLE. Everything except blueprints keeps working. ----
// 🔑 Sub's explicit requirement, and worth pinning rather than trusting: the gate is meant to
// stop ONE thing (test-server progress entering the real collection), not to degrade the app.
// Measured on the shipped source there are exactly TWO isLiveEnv gates — the blueprint receipt
// and the dynamic-event journal entry — and nothing else consults the environment. These
// assertions are what would catch a third gate being added by accident.
{
  const stateDir = mkdtempSync(join(tmpdir(), "logenv-ptu-"));
  try {
    const t = new MissionTracker({ dataDir, stateDir });
    t.detectPatch("<2026-08-20T00:00:00.000Z> ProductVersion: 4.10.190.27847 Changelist: 12479687");
    t.detectPatch(PTU);
    check("the gate is closed for this session", t.view().envIsLive, false);
    check("...and the UI is told which environment", t.view().logEnv, "PTU");

    // A real accept + marker pair, the way the live path receives them.
    const MID = "c48baebd-b6da-4537-86f1-1355c5e2d488";
    t.apply({ kind: "accept", ts: "2026-08-20T00:01:00.000Z", missionId: MID, title: "Orison Relief: Medium Supply Haul" } as never);
    t.apply({ kind: "marker", ts: "2026-08-20T00:01:01.000Z", missionId: MID, contract: "ORS_MA_HaulingMedium_0",
      contractKey: "ORS_MA_HaulingMedium", generator: "TheBackpocket", contractDefId: "d", objectiveId: "o",
      markerEntityId: "1", pos: null } as never);

    const v = t.view();
    check("a mission accepted on PTU is still TRACKED", v.contractKey, "ORS_MA_HaulingMedium");
    check("...and still shows its title", typeof v.title === "string" && v.title.length > 0, true);
    check("...and still appears in the mission picker", (v.missions ?? []).length > 0, true);
    // The dataset must still be loaded and non-empty — a gate that emptied it would make every
    // assertion above pass vacuously on a tracker that knows nothing.
    check("...against a NON-EMPTY dataset", t.matchCandidates().length > 0, true);

    // A completion on PTU must still fire, because the mission/hauling side is not gated.
    // ⚠️ The field is `recentMissions`. An earlier draft read `t.view().recent`, which does not
    // exist — so `?? []` made it vacuously empty and the assertion failed for a reason that had
    // nothing to do with the environment gate. Read a field the view really has.
    // Timestamped NOW because the history is a recency window; a stale stamp would drop out of it
    // and look like the completion was refused.
    t.apply({ kind: "contractComplete", ts: new Date().toISOString(), missionId: MID, title: "Orison Relief: Medium Supply Haul" } as never);
    check("a completion on PTU is still recorded in history", t.view().recentMissions.length > 0, true);

    // ...but the one thing that IS gated stays gated, in the same tracker, at the same moment.
    // Paired deliberately: "everything works" and "blueprints do not" have to be true together,
    // or this test would pass on a build that had simply stopped gating anything.
    t.apply({ kind: "blueprintReceived", ts: new Date().toISOString(), name: REAL_BLUEPRINT, missionId: null } as never);
    check("...while the blueprint is STILL refused", inGameCount(t), 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
