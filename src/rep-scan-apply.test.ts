/**
 * Self-check for the REP-page RE-BASELINE — what a scan does to the stored standing.
 * Run with:  npx tsx src/rep-scan-apply.test.ts     (or `npm run test:repscan`)
 * Exits non-zero on any failed case.
 *
 * This is the half with teeth. `rep-page.test.ts` proves we read the page correctly; this proves
 * that reading it correctly does the right thing to a player's saved progress — including the
 * cases where it LOWERS it, which is the whole point of a re-baseline and also the way it could
 * destroy something real.
 *
 * Driven through the real MissionTracker against a real rank ladder, on a throwaway state file.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MissionTracker } from "./missions.js";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

const dir = mkdtempSync(join(tmpdir(), "rep-scan-"));
const GUILD = "BountyHunter_BountyHuntersGuild";
const GIVER = "Bounty Hunters Guild";

/** The real shipped ladder, so the bands under test are the game's own, not invented ones.
 *  Not Eligible -1000 | Applicant 0 | Probationary 1 | Junior 3000 | Guild 10000 |
 *  Senior 40000 | Veteran 200000 | Steward 480000 */
const scopes = JSON.parse(readFileSync("data/rep-scopes.json", "utf8")).scopes;
const ladder: { minRep: number; name: string }[] = scopes[GUILD].ranks;
check("the fixture ladder is the REAL shipped one, not a hand-written copy",
  ladder.length === 8 && ladder[2].minRep === 1 && ladder[3].minRep === 3000,
  `[${ladder.length} ranks, rank2=${ladder[2]?.minRep}, rank3=${ladder[3]?.minRep}]`);

function tracker(): MissionTracker {
  // 🔴 stateDir EXPLICITLY. The constructor takes an OPTIONS OBJECT, and a bare string falls
  // through to `%APPDATA%/sc-blueprint-tracker` — the player's REAL saved standing. The first
  // draft of this file did exactly that and re-baselined a live profile's reputation to a test
  // value. A suite whose whole subject is overwriting reputation is the last place that may
  // guess at where it is writing.
  const t = new MissionTracker({ stateDir: dir, dataDir: "data" }) as unknown as {
    repScopes: Record<string, unknown>;
    repWitnessed: Map<string, { scope: string; sum: number }>;
  };
  // The tracker loads its ladders from the data dir; point it at the real ones directly so this
  // suite does not depend on a dataset being resolvable from a temp directory.
  t.repScopes = scopes;
  return t as unknown as MissionTracker;
}

// ── The band, and interpolating inside it ────────────────────────────────────
{
  const t = tracker();
  // Rank 2 spans [1, 3000). A bar 19% full — the figure measured off Sub's own PTU still.
  const r = t.applyRepScan(GIVER, GUILD, 2, 0.19)!;
  check("a scan applies at all", !!r && r.applied === true);
  check("the band is the ladder's own", r.floor === 1 && r.ceiling === 3000,
    `[${r.floor}..${r.ceiling}]`);
  check("19% of [1,3000) is stored, not the floor", r.after === 571, `[${r.after}]`);
  check("...and it is flagged as an estimate", r.estimated === true);
  check("an estimate can NEVER leave its own band", r.after >= r.floor && r.after < r.ceiling!,
    `[${r.after} in ${r.floor}..${r.ceiling}]`);
}
{
  // 🔴 The property the whole design rests on: however wrong the linearity assumption is, the
  // stored value cannot land on a different rank. Swept across the full range of bar readings.
  const t = tracker();
  let outside = 0, wrongRank = 0;
  for (let i = 0; i <= 100; i++) {
    const r = t.applyRepScan(GIVER, GUILD, 4, i / 100)!;   // rank 4 spans [10000, 40000)
    if (r.after < 10000 || r.after >= 40000) outside++;
    // Which rank would the stored number read back as?
    let back = 0;
    for (let k = 0; k < ladder.length; k++) if (r.after >= Math.max(0, ladder[k].minRep)) back = k;
    if (back !== 4) wrongRank++;
  }
  check("across 101 bar readings, none escapes the band", outside === 0, `[${outside} escaped]`);
  check("across 101 bar readings, none reads back as a different rank", wrongRank === 0,
    `[${wrongRank} wrong]`);
}
{
  // Anti-aliasing can measure a full bar slightly over 1. It must not tip into the next rank.
  const t = tracker();
  const r = t.applyRepScan(GIVER, GUILD, 2, 1.04)!;
  check("an over-full bar is clamped below the next rank's floor", r.after === 2999,
    `[${r.after}, ceiling ${r.ceiling}]`);
}

// ── Both directions: the point of a re-baseline ──────────────────────────────
{
  const t = tracker() as unknown as { repWitnessed: Map<string, { scope: string; sum: number }> };
  // The app has over-counted badly — it thinks the player is a Senior Guild Member.
  t.repWitnessed.set(GIVER, { scope: GUILD, sum: 55_000 });
  const r = (t as unknown as MissionTracker).applyRepScan(GIVER, GUILD, 2, 0.19)!;
  check("a scan LOWERS an over-counted total", r.outcome === "lowered" && r.after === 571,
    `[${r.before} -> ${r.after}]`);
  check("...which is the case max()-of-lower-bounds could never fix", r.after < r.before);
}
{
  const t = tracker();
  // Fresh install, app has seen nothing, player is really a Guild Member.
  const r = t.applyRepScan(GIVER, GUILD, 4, 0.5)!;
  check("a scan RAISES a total the app never saw", r.outcome === "raised" && r.after === 25_000,
    `[${r.before} -> ${r.after}]`);
}

// ── The edges ────────────────────────────────────────────────────────────────
{
  const t = tracker();
  const r = t.applyRepScan(GIVER, GUILD, 7, 0.5)!;   // Guild Steward — the top rank
  check("the top rank has no ceiling to interpolate into, so it takes the floor",
    r.ceiling === null && r.after === 480_000 && r.estimated === false, `[${r.after}]`);
}
{
  const t = tracker();
  const r = t.applyRepScan(GIVER, GUILD, 0, 0.5)!;   // Not Eligible, minRep -1000
  check("a negative floor never stores a negative total", r.after === 0 && r.floor === 0,
    `[${r.after}]`);
  check("...and the raw ladder value really is negative, so the clamp is doing work",
    ladder[0].minRep < 0, `[${ladder[0].minRep}]`);
}
{
  const t = tracker();
  const noBar = t.applyRepScan(GIVER, GUILD, 2, null)!;
  check("with no bar reading it falls back to the floor and says so",
    noBar.after === 1 && noBar.estimated === false, `[${noBar.after}]`);
  const nan = t.applyRepScan(GIVER, GUILD, 2, NaN)!;
  check("a NaN bar reading does not produce a NaN total", nan.after === 1, `[${nan.after}]`);
}
{
  const t = tracker();
  check("an unknown scope applies nothing", t.applyRepScan(GIVER, "NoSuchScope", 2, 0.5) === null);
  check("a rank off the end of the ladder applies nothing",
    t.applyRepScan(GIVER, GUILD, 99, 0.5) === null);
  check("a negative rank applies nothing", t.applyRepScan(GIVER, GUILD, -1, 0.5) === null);
}

// ── It survives a restart, and does not destroy an older state file ──────────
{
  const t = tracker();
  t.applyRepScan(GIVER, GUILD, 4, 0.5);
  const t2 = tracker();
  const back = (t2 as unknown as { repWitnessed: Map<string, { sum: number }> })
    .repWitnessed.get(GIVER);
  check("the re-baselined total is persisted and read back", back?.sum === 25_000,
    `[${back?.sum}]`);
  const scanned = (t2 as unknown as { repScanned: Map<string, { rank: number }> })
    .repScanned.get(GIVER);
  check("the scan itself is persisted, so the bar can say where its number came from",
    scanned?.rank === 4, `[${scanned?.rank}]`);
}
{
  // 🔴 A STATE FILE WRITTEN BEFORE SCANNING EXISTED MUST STILL LOAD. `repScanned` is additive,
  // so STATE_VERSION deliberately did NOT move — bumping it is a data-destruction switch in this
  // app, not a schema label. Prove an older file survives by removing the new key entirely.
  const t = tracker();
  t.applyRepScan(GIVER, GUILD, 4, 0.5);
  const statePath = [join(dir, "collected.json")].find((p) => existsSync(p));
  check("the state file was found, so this block is testing something", !!statePath,
    statePath ?? "(not found)");
  if (statePath) {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    check("...and it really carries the new key", !!raw.repScanned);
    delete raw.repScanned;
    writeFileSync(statePath, JSON.stringify(raw));
    const old = tracker() as unknown as {
      repWitnessed: Map<string, { sum: number }>; repScanned: Map<string, unknown>;
    };
    check("a pre-scan state file still loads, with the standing intact",
      old.repWitnessed.get(GIVER)?.sum === 25_000, `[${old.repWitnessed.get(GIVER)?.sum}]`);
    check("...and simply has no scan recorded", old.repScanned.size === 0,
      `[${old.repScanned.size}]`);
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\nFAILED (${failed})` : "\nall rep re-baseline checks passed");
process.exit(failed ? 1 : 0);
