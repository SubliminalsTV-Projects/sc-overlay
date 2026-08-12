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

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
