/**
 * Self-check for the mission-OCR resurrection guard. The in-game mission title lingers on
 * screen after a contract completes, so the next OCR read finds no ACTIVE candidate and used
 * to fall through to the synthetic `ocr:<key>` registration — re-registering the mission you
 * just finished under a GUESSED contract key (keys[0] of every dataset variant sharing the
 * title). The phantom then outranked the real marker-identified mission, could never be
 * flagged completed, and showed the MERGED pool of all variants.
 *
 * Sub's session, 2026-08-07: "Kill the king" really was HH_Pyro_RegionC_DerelictOutpost
 * (one pool, 8/8 owned) and completed cleanly — the widget showed Rustville, 14/18, and
 * "not complete" indefinitely.
 *
 * Run with:  npx tsx src/screen-resurrect.test.ts     Exits non-zero on any failed case.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionTracker } from "./missions.js";
import type { MissionEvent } from "./missions-parser.js";

const CL = "99999999";
const bp = (name: string) => ({ blueprint: name, chance: 1, item: name.toLowerCase(), type: "Weapon", subType: null, classification: null });
const mission = (title: string, pools: Record<string, ReturnType<typeof bp>[]>) =>
  ({ title, generatorClass: "Test", missionKey: title, pools });

// Two dataset variants share the title, with DIFFERENT pools — the shape that makes the
// phantom's key a guess and its pool a union. Mirrors the real 4-variants/2-pools case.
const dataset = {
  schema: "sc-blueprint-pools/2", version: `9.9.0-LIVE.${CL}`, changelist: CL, missionCount: 2,
  missions: {
    // Sorts first, so it is what resolveAcceptTitle() would pick as keys[0] — the WRONG one.
    Kill_RegionA: mission("Kill The King", { "pool-a": [bp("Coda Pistol"), bp("Coda Magazine")] }),
    Kill_RegionC: mission("Kill The King", { "pool-c": [bp("Devastator Shotgun")] }),
  },
};

const dir = mkdtempSync(join(tmpdir(), "res-"));
writeFileSync(join(dir, "blueprints.latest.json"), JSON.stringify(dataset));
const t = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "res-st-")) });
t.detectPatch("<2026> ProductVersion: 9.9 build_version[99999999] Changelist: 99999999");

let failed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}`);
}

const GUID = "af7e117e-102d-41b7-b826-a6bc9919e364";
const marker = (missionId: string, contractKey: string): MissionEvent =>
  ({ kind: "marker", ts: null, missionId, contract: contractKey, contractKey, generator: "Test", contractDefId: "", objectiveId: "", markerEntityId: null, pos: null });

// ---- the real mission: marker (authoritative key) + accept (title) ----
t.apply(marker(GUID, "Kill_RegionC"));
t.apply({ kind: "accept", ts: "2026-08-07T22:06:37.222Z", missionId: GUID, title: "Kill the king" });

check("OCR matches the live mission (no phantom)", t.setScreenMission("KILL THE KING") === true);
check("tracks the marker's mission id", t.view().missions.length === 1 && t.view().missions[0].id === GUID);
check("marker key wins — not ambiguous", t.view().ambiguous === false);
check("shows ONLY the real variant's pool",
  JSON.stringify(t.view().pools.flatMap((p) => p.blueprints.map((b) => b.name))) === JSON.stringify(["Devastator Shotgun"]));

// ---- complete it ----
// A fresh stamp on purpose: the completion CARD is gated on the log line being recent
// (COMPLETION_FRESH_MS), and `completed` is only true while that card holds — once it
// expires the mission is ended, so effectiveMissionId() has moved off it entirely.
t.apply({ kind: "end", ts: new Date().toISOString(), missionId: GUID, state: "MISSION_STATE_COMPLETED" });
check("completion registers", t.view().completed === true);

// ---- the bug: OCR re-reads the title still on screen ----
check("lingering title after completion is a NO-OP", t.setScreenMission("KILL THE KING") === false);
const after = t.view();
check("no phantom ocr: mission registered", after.missions.every((m) => !m.id.startsWith("ocr:")));
check("still not showing a merged/ambiguous pool", after.ambiguous !== true);
check("does not resurrect as incomplete",
  after.contractKey !== "Kill_RegionA" && !(after.contractKey === "Kill_RegionC" && after.completed === false));

// A truncated/glitched read of the same ended title must be refused too — the guard uses the
// same tolerant matcher as the live lookup, not exact equality.
check("truncated read of the ended title is also refused", t.setScreenMission("KILL THE KIN") === false);

// A session reset means you went out to the MENU (only the SC_Frontend establish resets), so
// every mission id from the old shard is stale — the record is dropped with it. OCR reading a
// title afterwards is the recovery case, and a fresh synthetic entry is the honest answer: the
// old GUID must not come back, and the new entry is flagged ambiguous because its key is a guess.
t.apply({ kind: "sessionStart", ts: new Date().toISOString() });
check("after a session reset, OCR registers rather than re-attaching", t.setScreenMission("KILL THE KING") === true);
check("the old shard's GUID does not come back", t.view().missions.every((m) => m.id !== GUID));

// ---- the title-less window: marker parsed, accept not yet ----
// A `marker` event sets contractKey but NOT title, so the mission is invisible to the
// title matcher until its accept line lands. An OCR poll in that gap used to mint a phantom
// beside the real mission — and because keys[0] is the RegionA variant while the player was
// on RegionC, the panel flipped from a correct 8/8 to a merged 14/18. Sub, 2026-08-07.
const gap = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "res-st3-")) });
gap.detectPatch("<2026> ProductVersion: 9.9 build_version[99999999] Changelist: 99999999");
gap.apply(marker("guid-regionc", "Kill_RegionC")); // marker only — no accept yet
check("title-less marker mission is still matched by OCR", gap.setScreenMission("KILL THE KING") === true);
const g = gap.view();
check("no phantom minted beside it", g.missions.every((m) => !m.id.startsWith("ocr:")));
check("stays on the marker's variant, not keys[0]", g.contractKey === "Kill_RegionC");
check("pool is the real one, not a merge", g.ambiguous === false && g.totals.total === 1);
// The accept arriving late must not create a second entry either.
gap.apply({ kind: "accept", ts: null, missionId: "guid-regionc", title: "Kill the king" });
check("late accept does not add a duplicate", gap.view().missions.length === 1);

// ---- a session reset must not un-end old missions ----
// resetSession() clears endedMissionIds. It used to leave the mission RECORDS behind, so every
// mission the tracker had ever seen became un-ended and OCR-matchable on title — reachable
// through setScreenMission() (which scans the whole map) even though the seqs no longer index
// it. Sub, 2026-08-08: a "Deep space hit" completed at 22:00 reappeared after three resets.
const stale = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "res-st4-")) });
stale.detectPatch("<2026> ProductVersion: 9.9 build_version[99999999] Changelist: 99999999");
stale.apply(marker("guid-old", "Kill_RegionC"));
stale.apply({ kind: "accept", ts: null, missionId: "guid-old", title: "Kill the king" });
stale.apply({ kind: "end", ts: null, missionId: "guid-old", state: "MISSION_STATE_COMPLETED" });
// Quit to menu and back — the exact shape of Channel Destroyed / Context Establisher.
stale.apply({ kind: "sessionEnd", ts: null });
stale.apply({ kind: "sessionStart", ts: null });
check("after a reset the picker is empty", stale.view().missions.length === 0);
check("a completed mission from the old shard is NOT OCR-matchable",
  stale.setScreenMission("KILL THE KING") === true); // resolves fresh from the dataset...
const st = stale.view();
check("...as a NEW synthetic entry, not the old GUID", st.missions.every((m) => m.id !== "guid-old"));
check("and the old shard's record is gone", st.missions.length === 1 && st.missions[0].id.startsWith("ocr:"));

// ---- the genuine recovery path still works ----
// Alt-F4 → relaunch rotates game.log: the accept and marker are GONE, so the tracker has no
// record of this mission at all. OCR is then the only signal that you are on it, and the
// synthetic registration is the whole point — it must still fire.
const fresh = new MissionTracker({ dataDir: dir, stateDir: mkdtempSync(join(tmpdir(), "res-st2-")) });
fresh.detectPatch("<2026> ProductVersion: 9.9 build_version[99999999] Changelist: 99999999");
check("with no log history, OCR recovery registers the mission", fresh.setScreenMission("KILL THE KING") === true);
const rec = fresh.view();
check("recovered mission is the synthetic entry", rec.missions.some((m) => m.id.startsWith("ocr:")));
check("recovered mission is flagged ambiguous (key is a guess)", rec.ambiguous === true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
