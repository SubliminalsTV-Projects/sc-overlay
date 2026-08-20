/**
 * The dataset must FOLLOW the log: switching game builds mid-session has to swap the pools.
 *
 * This behaviour has been relied on since 4.8 (it is what makes a 4.8.2 player get 4.8.2 pools
 * rather than the newest bundled ones) and was never covered. It matters more now than it did:
 * the app ships a 4.10 PTU dataset alongside 4.9 LIVE, so a player who quits PTU and launches
 * LIVE is a real, everyday path — and if the dataset does not flip back, they are shown 4.10
 * pools for a 4.9 game and every mission looks wrong.
 *
 * 🔑 Asserts the MISSION SET, not just the version label. A test that only checked `patch` would
 * pass on a build that updated the string and kept the old pools loaded — which is the failure
 * that would actually hurt.
 *
 * Run with:  npx tsx src/dataset-flip.test.ts
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

const dir = mkdtempSync(join(tmpdir(), "dsflip-"));
const pool = (name: string) => ({ blueprint: name, chance: 1, item: name.toLowerCase(), type: "W", subType: null, classification: null });
const build = (version: string, cl: string, key: string) => JSON.stringify({
  schema: "sc-blueprint-pools/2", version, changelist: cl, missionCount: 1,
  missions: { [key]: { title: key, generatorClass: "T", missionKey: key, pools: { p: [pool(key + " BP")] } } },
});

// Two bundled datasets, exactly as the repo ships them: per-changelist files plus a `.latest`
// that is a COPY of the newest. 4.10 is the PTU extraction, 4.9 is LIVE.
writeFileSync(join(dir, "blueprints.111.json"), build("4.9.0-LIVE.111", "111", "NineOnly"));
writeFileSync(join(dir, "blueprints.222.json"), build("4.10.0-PTU.222", "222", "TenOnly"));
writeFileSync(join(dir, "blueprints.latest.json"), readFileSync(join(dir, "blueprints.222.json")));

const t = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "dsflip-st-")) });
const keys = () => t.matchCandidates().map((m) => m.debugName).sort();

// Header lines in the shapes the game really writes them (taken from a live 4.10 log:
// "ProductVersion: 4.10.190.27847", "Environment:   PTU", "--envtag='PTU").
const header = (family: string, cl: string, env: string) =>
  `<2026-08-20T06:09:35.326Z> ProductVersion: ${family}.190.27847 Changelist: ${cl} --envtag='${env}'`;

// ---- 1. First detect loads the matching dataset ----
t.detectPatch(header("4.10", "222", "PTU"));
check("a 4.10 log loads the 4.10 dataset", t.view().patch === "4.10.0-PTU.222", String(t.view().patch));
check("...and its missions are the 4.10 ones", keys().join(",") === "TenOnly", keys().join(","));
// Non-empty guard: every "the right missions loaded" assertion below compares a joined list, and
// an EMPTY list joins to "" — which would quietly satisfy a mistyped expectation.
check("...the mission set is non-empty", keys().length > 0, String(keys().length));
check("...and PTU is reported as not-live", t.view().envIsLive === false && t.view().logEnv === "PTU",
  `${t.view().logEnv}/${t.view().envIsLive}`);

// ---- 2. THE FLIP: quit PTU 4.10, launch LIVE 4.9 ----
t.detectPatch(header("4.9", "111", "PUB"));
check("a 4.9 log flips the dataset back to 4.9", t.view().patch === "4.9.0-LIVE.111", String(t.view().patch));
check("...and the 4.10 missions are GONE", !keys().includes("TenOnly"), keys().join(","));
check("...replaced by the 4.9 ones", keys().join(",") === "NineOnly", keys().join(","));
check("...the mission set is still non-empty", keys().length > 0, String(keys().length));
check("...and PUB is reported as live again", t.view().envIsLive === true && t.view().logEnv === "PUB",
  `${t.view().logEnv}/${t.view().envIsLive}`);

// ---- 3. And back again, so the flip is not one-way ----
t.detectPatch(header("4.10", "222", "PTU"));
check("flipping back to 4.10 works too", t.view().patch === "4.10.0-PTU.222", String(t.view().patch));
check("...with the 4.10 missions restored", keys().join(",") === "TenOnly", keys().join(","));

// ---- 4. HEADER LINES ARRIVING OUT OF ORDER still end on the right dataset ----
// 🔑 This is what `else if (familyChanged)` is really for, and the first version of this test got
// it wrong. detectPatch is fed ONE LINE AT A TIME, and a header's family and changelist can
// arrive on separate lines in either order. So the family-only branch is a RE-EVALUATION, not a
// guarantee of a flip: it calls loadDataset with the changelist still current, and an exact
// changelist match legitimately outranks the family fallback. Asserting that a family line alone
// flips the dataset demanded more than the design promises — and it does not need to promise it,
// because two different builds always carry two different changelists.
// What must hold is that whichever order the lines arrive in, the tracker SETTLES on the build
// the log describes.
{
  const t2 = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "dsflip-st2-")) });
  t2.detectPatch(header("4.10", "222", "PTU"));
  const before = t2.view().patch;
  // Family line first, changelist second — the out-of-order case.
  t2.detectPatch("<2026> FileVersion: 4.9.0.0");
  const midway = t2.view().patch;
  t2.detectPatch("<2026> Changelist: 111");
  check("out-of-order header lines still settle on the right dataset",
    before === "4.10.0-PTU.222" && t2.view().patch === "4.9.0-LIVE.111",
    `${before} -> ${midway} -> ${t2.view().patch}`);
  check("...and the missions really swapped",
    t2.matchCandidates().map((m) => m.debugName).join(",") === "NineOnly",
    t2.matchCandidates().map((m) => m.debugName).join(","));
  // Recorded rather than asserted: the intermediate state holds the OLD dataset because the old
  // changelist is still bundled and still matches exactly. That is correct, and writing it down
  // stops the next reader "fixing" it.
  check("...the midway state is documented, not asserted", midway === "4.10.0-PTU.222", midway ?? "null");
}

// ---- 5. An UNBUNDLED changelist in a known family falls back to that family ----
// The exact build is not shipped, so it must land on the same FAMILY's dataset rather than on
// `.latest` — "latest" alone would hand a 4.9 player 4.10 pools.
{
  const t3 = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "dsflip-st3-")) });
  t3.detectPatch(header("4.9", "999999", "PUB"));   // 999999 is not bundled
  check("an unbundled 4.9 build still gets 4.9 pools, not .latest",
    t3.view().patch === "4.9.0-LIVE.111", String(t3.view().patch));
  check("...and not the newest bundled set", t3.view().patch !== "4.10.0-PTU.222", String(t3.view().patch));
}

console.log(failed ? `\nFAILED (${failed})` : "\ndataset-flip tests passed");
process.exit(failed ? 1 : 0);
