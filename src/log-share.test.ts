/**
 * Self-check for rotated-session sharing.  Run with:  npx tsx src/log-share.test.ts
 *
 * There are two opposite expensive failures here and the tests exist to hold BOTH at once:
 *   - "uploads the same thing every launch forever" — backups are immutable, so a verdict of
 *     sent / no signal / unreadable is FINAL and must be remembered.
 *   - "never uploads anything again, silently" — the failure found on 2026-08-16. Recording a
 *     WRONG-PATCH file as done blacklisted it permanently, so a player who updated the app after
 *     an SC patch lost their whole backlog. Off-patch is a verdict about the RULE, not the file,
 *     so it goes to a separate list that is recoverable.
 *
 * 🔑 No network. Every fixture here is deliberately INELIGIBLE, so maybeShareLog reaches the
 * selection logic and stops before any upload — which is exactly the half worth pinning. The two
 * fixtures that are meant to PASS the patch filter scrub to empty instead, so they prove they got
 * past the filter without ever posting. Both are asserted to scrub empty before anything else runs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeShareLog, clearSkippedBackups } from "./log-share.js";

const root = mkdtempSync(join(tmpdir(), "logshare-"));
const backups = join(root, "logbackups");
mkdirSync(backups);
const statePath = join(root, "shared-logs.json");
const logPath = join(root, "game.log");

const header = (patch: string) => `<2026-08-01T00:00:00.000Z> ProductVersion: ${patch}\n<2026-08-01T00:00:00.000Z> [Trace] Environment:   PUB\n`;
const SIGNAL = 'Added notification "Contract Accepted:  Ship In Distress: " [4] MissionId: [11111111-2222-3333-4444-555555555555]\n';

// The live log has one job here: state the current patch. It must ALSO scrub to nothing, or
// maybeShareLog posts it and this test starts calling the production API on every run.
//
// 🔑 The patch is read from the RAW text and the scrub drops any line containing "chat", so a
// header line that also says "chat" is both readable and droppable. That is a load-bearing
// coincidence, so it is asserted below rather than assumed — if the scrub rule ever changes,
// this fails loudly instead of quietly going online.
const liveLog = `<2026-08-01T00:00:00.000Z> ProductVersion: 4.9.188.23497 chat\n<2026-08-01T00:00:00.000Z> chat noise\n`;
writeFileSync(logPath, liveLog);

// A rotated session on an OLD patch that contains a cargo haul. It has to clear the patch filter
// (that is the carve-out) but must not go online, so every line carries "chat" and the whole file
// scrubs to nothing — asserted below, exactly like the live fixture.
const HAUL_CHATTY = `<2026-08-01T00:00:00.000Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [275d8ca8-c591-4147-9058-e052d6a22d7e], generator name [Covalex_Hauling], contract [HaulCargo_AToB_Processed_Stims_Stanton3_SupplyGrade], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0], markerEntityId [12897], zoneHostId [742554712000] chat\n`;
const chattyHeader = (patch: string) => `<2026-08-01T00:00:00.000Z> ProductVersion: ${patch} chat\n`;
const oldHaulLog = chattyHeader("4.8.184.64329") + HAUL_CHATTY;

// Fixtures, each ineligible — or eligible-but-empty — for a DIFFERENT reason.
writeFileSync(join(backups, "old-patch.log"), header("4.8.184.64329") + SIGNAL); // wrong patch, no haul
writeFileSync(join(backups, "old-patch-haul.log"), oldHaulLog); // wrong patch, BUT a cargo haul
writeFileSync(join(backups, "no-signal.log"), header("4.9.188.23497") + "just chatter\n"); // no signal
writeFileSync(join(backups, "empty.log"), ""); // empty
writeFileSync(join(backups, "notes.txt"), header("4.9.188.23497") + SIGNAL); // not a .log

const cfg = { shareLogs: true, syncToken: "scbp_fake_token_for_test", logPath };

const state = (p = statePath): { backups: string[]; skippedPatch: string[]; liveHash?: string } => {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return { backups: v.backups ?? [], skippedPatch: v.skippedPatch ?? [], liveHash: v.liveHash };
  } catch { return { backups: [], skippedPatch: [] }; }
};
const done = (): string[] => state().backups;

try {
  // Precondition: the live fixture must scrub to nothing, or every assertion below runs against
  // a test that is quietly POSTing to the real site.
  const { scrubGameLog } = await import("./log-scrub.js");
  assert.equal(scrubGameLog(liveLog).text.trim(), "",
    "live-log fixture must scrub to empty — otherwise this test uploads to production");
  assert.equal(scrubGameLog(oldHaulLog).text.trim(), "",
    "old-patch haul fixture must scrub to empty — it clears the patch filter, so anything left would be POSTed");

  await maybeShareLog(cfg, "0.1.45", statePath);
  const after = done();
  const skipped = state().skippedPatch;

  assert(after.includes("no-signal.log"), "a signal-free backup must be remembered");
  assert(after.includes("empty.log"), "an empty backup must be remembered");
  assert(!after.includes("notes.txt") && !skipped.includes("notes.txt"), "a non-.log file should never be considered at all");

  // 🔴 THE REGRESSION. A wrong-patch backup must be set aside, never written to the uploaded set:
  // recording it there is permanent, and it is what wiped whole backlogs at an SC patch boundary.
  assert(skipped.includes("old-patch.log"), "a wrong-patch backup belongs in skippedPatch");
  assert(!after.includes("old-patch.log"), "a wrong-patch backup must NEVER be recorded as uploaded — that blacklists it forever");

  // The carve-out: hauling signal outranks the patch filter, so this one must not be set aside.
  assert(!skipped.includes("old-patch-haul.log"), "an old-patch backup containing a cargo haul must clear the patch filter");
  assert(after.includes("old-patch-haul.log"), "…and having cleared it, be resolved (here: scrubbed to empty) rather than left pending");

  // Idempotence: a second pass must not grow either list or re-decide anything.
  const before = after.slice().sort();
  await maybeShareLog(cfg, "0.1.45", statePath);
  assert.deepEqual(done().slice().sort(), before, "a second tick must not re-add or re-decide anything");
  assert.deepEqual(state().skippedPatch.slice().sort(), skipped.slice().sort(), "nor re-decide the skipped ones");

  // Toggling "share logs" back on re-offers the skipped files, and ONLY those — anything already
  // uploaded stays uploaded, or the gesture would spend the site's retention on duplicates.
  clearSkippedBackups(statePath);
  assert.deepEqual(state().skippedPatch, [], "the toggle gesture must clear the skipped list");
  assert.deepEqual(done().slice().sort(), before, "…and must not touch the uploaded set");
  await maybeShareLog(cfg, "0.1.45", statePath);
  assert(state().skippedPatch.includes("old-patch.log"), "a re-offered backup is re-judged, and lands back in skippedPatch while the patch still differs");

  // The live hash is persisted, not held in module memory — a restart used to re-post a
  // byte-identical body. This pins the round-trip (a pre-set hash survives a tick); the upload
  // path that WRITES it can't be exercised offline.
  const seeded = join(root, "seeded.json");
  writeFileSync(seeded, JSON.stringify({ backups: [], skippedPatch: [], liveHash: "deadbeef" }));
  await maybeShareLog(cfg, "0.1.45", seeded);
  assert.equal(state(seeded).liveHash, "deadbeef", "a persisted live hash must survive a tick, not be reset to empty");
  assert.notEqual(state().liveHash, undefined, "the state file must carry a liveHash field at all");

  // Sharing off => the state file is never touched, even with eligible-looking files present.
  const off = join(root, "off.json");
  await maybeShareLog({ ...cfg, shareLogs: false }, "0.1.39", off);
  assert.deepEqual((() => { try { return JSON.parse(readFileSync(off, "utf8")); } catch { return null; } })(), null,
    "sharing disabled must not read or write anything");

  // No token is the same refusal — the opt-in is two conditions, not one.
  const noTok = join(root, "notok.json");
  await maybeShareLog({ ...cfg, syncToken: "" }, "0.1.39", noTok);
  assert.deepEqual((() => { try { return JSON.parse(readFileSync(noTok, "utf8")); } catch { return null; } })(), null,
    "no sync token must not read or write anything");

  // 🔴 THE DAMAGE IS ALREADY ON DISK. Shipping the fix alone would help nobody who ran the old
  // build — Sub's own state file had 479 names recorded, 409 of them wrongly blacklisted. The old
  // code checked the patch BEFORE uploading, so an off-patch name can only ever be a wrongful
  // blacklist; that is what makes the repair exact rather than a guess.
  const legacyState = join(root, "legacy.json");
  writeFileSync(legacyState, JSON.stringify({ backups: ["old-patch.log", "old-patch-haul.log", "no-signal.log"] }));
  await maybeShareLog(cfg, "0.1.45", legacyState);
  const repaired = state(legacyState);
  assert(!repaired.backups.includes("old-patch.log"),
    "a wrongly-blacklisted off-patch backup must be released by the one-time repair");
  assert(repaired.skippedPatch.includes("old-patch.log"),
    "…and set aside as recoverable — released into nothing is the same loss wearing a different name");
  assert(repaired.backups.includes("no-signal.log"),
    "an ON-patch name in a legacy list is a genuine upload and must survive the repair");
  assert.equal(JSON.parse(readFileSync(legacyState, "utf8")).v, 2, "the repaired file must be stamped with the new schema version");
  // Released files have to be re-judged, which is the only way the carve-out ever sees them.
  for (let i = 0; i < 5; i++) await maybeShareLog(cfg, "0.1.45", legacyState);
  assert(state(legacyState).backups.includes("old-patch-haul.log"),
    "a released backup carrying a cargo haul must be picked up on a later tick, not re-skipped");

  // A repair that cannot judge the patch yet must stay PENDING, not mark itself done. The live
  // log here has no ProductVersion line, so currentPatch is null.
  const noPatch = join(root, "nopatch-live.log");
  writeFileSync(noPatch, "<2026-08-01T00:00:00.000Z> chat only, no version line\n");
  const pending = join(root, "pending.json");
  writeFileSync(pending, JSON.stringify({ backups: ["old-patch.log"] }));
  await maybeShareLog({ ...cfg, logPath: noPatch }, "0.1.45", pending);
  assert.notEqual(JSON.parse(readFileSync(pending, "utf8")).v, 2,
    "with no patch to compare against, the repair must stay pending instead of being swallowed");

  // 🔴 ONE TICK MUST NOT SWEEP A FOLDER. Rejections cost no upload, so they were unbounded, and
  // BACKUPS_PER_TICK (which only counts SENDS) never held them back — that is how a single pass
  // could reach every file a user owned. With a bound, any mistake in the rules is survivable:
  // it costs a handful of files, not an archive, before the next release corrects it.
  const many = mkdtempSync(join(tmpdir(), "logshare-many-"));
  const manyBackups = join(many, "logbackups");
  mkdirSync(manyBackups);
  const manyLog = join(many, "game.log");
  writeFileSync(manyLog, liveLog);
  const TOTAL = 60;
  for (let i = 0; i < TOTAL; i++) {
    writeFileSync(join(manyBackups, `bulk-${String(i).padStart(3, "0")}.log`), header("4.9.188.23497") + "just chatter\n");
  }
  const manyState = join(many, "s.json");
  await maybeShareLog({ ...cfg, logPath: manyLog }, "0.1.45", manyState);
  const classified = state(manyState).backups.length + state(manyState).skippedPatch.length;
  assert(classified > 0, "a tick must still make progress");
  assert(classified < TOTAL, `one tick classified all ${TOTAL} backups — the per-tick rejection bound is not holding`);

  // …and it must still finish the folder eventually, a bounded slice at a time.
  for (let i = 0; i < 10; i++) await maybeShareLog({ ...cfg, logPath: manyLog }, "0.1.45", manyState);
  assert.equal(state(manyState).backups.length, TOTAL, "repeated ticks must eventually classify the whole folder");
  rmSync(many, { recursive: true, force: true });

  // 🔴 THE TRAP AT FOLDER SCALE, which is the size it actually did its damage at. One off-patch
  // file proves the branch exists; only a folder proves the two properties that matter together —
  // that the rejection bound holds on the skippedPatch path (the bulk case above walks the
  // `backups` path, a different branch that a bound could hold on while this one leaks), and that
  // NOT ONE name reaches the final set on the way through.
  const patchDir = mkdtempSync(join(tmpdir(), "logshare-patch-"));
  const patchBackups = join(patchDir, "logbackups");
  mkdirSync(patchBackups);
  const patchLive = join(patchDir, "game.log");
  writeFileSync(patchLive, liveLog); // states the current patch, and scrubs to nothing
  const OFF = 30;
  const offNames: string[] = [];
  for (let i = 0; i < OFF; i++) {
    const n = `off-${String(i).padStart(3, "0")}.log`;
    offNames.push(n);
    writeFileSync(join(patchBackups, n), header("4.8.184.64329") + SIGNAL);
  }
  const patchState = join(patchDir, "s.json");
  const patchCfg = { ...cfg, logPath: patchLive };

  await maybeShareLog(patchCfg, "0.1.45", patchState);
  const t1 = state(patchState);
  // Non-empty FIRST: every "must not be in backups" assertion below is trivially true of a run
  // that classified nothing at all, and a run that classified nothing is the other way to fail.
  assert(t1.skippedPatch.length > 0, "the first tick must actually classify something");
  assert(t1.skippedPatch.length < OFF, `one tick set aside all ${OFF} off-patch backups — the rejection bound does not hold on this path`);
  assert.deepEqual(t1.backups, [], "not one off-patch backup may be written into the final set");

  // Ticked out, the whole folder is set aside and none of it is blacklisted.
  for (let i = 0; i < 10; i++) await maybeShareLog(patchCfg, "0.1.45", patchState);
  const t2 = state(patchState);
  assert.deepEqual(t2.skippedPatch.slice().sort(), offNames.slice().sort(), "a bounded slice at a time, every off-patch backup must end up set aside");
  assert.deepEqual(t2.backups, [], "…and none of them recorded as a final verdict");

  // A LATER TICK CAN STILL REACH THEM. This is the whole point of the split: the recovery gesture
  // puts the entire folder back in play, which the old single-set behaviour could never do.
  clearSkippedBackups(patchState);
  assert.deepEqual(state(patchState).skippedPatch, [], "the recovery gesture must empty the skipped list");
  await maybeShareLog(patchCfg, "0.1.45", patchState);
  const t3 = state(patchState);
  assert(t3.skippedPatch.length > 0, "a re-offered folder must be re-judged, not quietly forgotten");
  assert.deepEqual(t3.backups, [], "re-judging must still never blacklist an off-patch backup");
  rmSync(patchDir, { recursive: true, force: true });

  // A missing logbackups/ must be survivable — plenty of installs have never rotated a log.
  const bare = mkdtempSync(join(tmpdir(), "logshare-bare-"));
  const bareLog = join(bare, "game.log");
  writeFileSync(bareLog, liveLog); // same scrubs-to-nothing fixture, so this stays offline too
  await maybeShareLog({ ...cfg, logPath: bareLog }, "0.1.39", join(bare, "s.json"));
  rmSync(bare, { recursive: true, force: true });

  console.log("ALL PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
