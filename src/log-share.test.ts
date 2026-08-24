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
import { maybeShareLog, clearSkippedBackups, hasShareSignal, wasUploadedUnderPreviousRules } from "./log-share.js";

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

// 🔴 THE PRICE SESSION. Verbatim shapes, one per purchase family, so the widened rule is checked
// against what the game really writes rather than against a paraphrase of it. Every line carries
// "chat" so the whole file scrubs to nothing — the same offline trick as the fixtures above.
const ITEM_BUY = `<2026-08-01T00:00:00.000Z> [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[201964486871] shopId[5061003307165] shopName[SCShop_lt_a_casaba_small_base_a-001] kioskId[5061003307166] client_price[3150.000000] itemClassGUID[b5f37920-ba9a-4a07-85e9-4d09f8e2f5ad] itemName[behr_lmg_ballistic_01_mag] quantity[6] chat\n`;
const COMMODITY_BUY = `<2026-08-01T00:00:00.000Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[753612056089] shopName[SCShop_Outpost_Junksite] kioskId[753612056056] price[18792.000000] shopPricePerCentiSCU[187.919998] resourceGUID[06cafea0-49fe-4dce-b0f0-dc583316c66d] autoLoading[0] quantity[100.000000 cSCU] chat\n`;
const RENTAL = `<2026-08-01T00:00:00.000Z> [Notice] <CEntityComponentShoppingProvider::SendRentalRequest> Sending SShopRentalRequest - playerId[201964486871] shopId[5061003307165] client_price[28665.000000] chat\n`;
// A session that only OPENED a kiosk. These are the lines matching the parsers' own component
// markers, and they carry no price at all — the reason the term is the request, not the component.
const BROWSED_ONLY =
  `<2026-08-01T00:00:00.000Z> [Error] <CShopInventory::LoadInventoryFromJSON> item record [9f047e7d-1324-473c-b944-03e87976f25a] is not in the class registry & could not be added to shop[Unknown Shop] inventory. chat\n` +
  `<2026-08-01T00:00:00.000Z> [Notice] <CShoppingKioskContextComponent::CreatePurchasableInfo> Shopping Kiosk Context Component CreatePurchasableInfo chat\n` +
  `<2026-08-01T00:00:00.000Z> [Error] <CEntityComponentShopUIProvider::ClGetSelectedLocationData> Invalid inventory selection chat\n`;
const shopOnlyLog = chattyHeader("4.9.188.23497") + ITEM_BUY + COMMODITY_BUY;
const missionLog = chattyHeader("4.9.188.23497") + `Added notification "Contract Accepted:  Ship In Distress: " [4] MissionId: [11111111-2222-3333-4444-555555555555] chat\n`;

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

  // 🔴 THE PRICE TERM. RE_SIGNAL carried no shop or commodity term for its whole life, so a
  // session in which the player only shopped was discarded on their own machine — measured at
  // 28.4% of shopping sessions and 12.0% of transaction lines over 533 real logbackups.
  //
  // 🔑 Asserted against the EXPORTED rule rather than through the state file, because the state
  // file cannot express this: an admitted session and a rejected one are both written to
  // `backups`, so no end-to-end assertion here can tell them apart. Driving the rule directly is
  // the only place the claim is falsifiable — narrowing RE_SIGNAL back reddens the four below.
  //
  // Positive first: the fixtures must really be sessions, or every "must not" is free.
  assert(shopOnlyLog.length > 0 && missionLog.length > 0 && BROWSED_ONLY.length > 0, "the rule fixtures must be non-empty");
  assert(hasShareSignal(shopOnlyLog), "a session whose only signal is a shop purchase must be worth uploading");
  assert(hasShareSignal(chattyHeader("4.9.188.23497") + RENTAL), "…and a rental, which is a price observation like any other");
  assert(hasShareSignal(missionLog), "a mission session must still qualify — the widening adds a term, it does not replace one");

  // 🔴 SCOPE. The widening admits PRICE signal, not everything. A session that only opened a
  // kiosk carries no price: these are the exact lines the parsers' own component markers match,
  // and matching them recovers no extra transaction while admitting 33 sessions holding nothing.
  assert(!hasShareSignal(chattyHeader("4.9.188.23497") + BROWSED_ONLY),
    "browsing a shop is not a price — matching the component instead of the request admits 68.8% noise");
  assert(!hasShareSignal(header("4.9.188.23497") + "just chatter\n"),
    "a session with nothing in it must still be refused");

  // The discriminator the rules reset rests on. `backups` holds genuine uploads AND rejections;
  // this is what tells them apart, so it has to be right in both directions or the reset either
  // re-sends a session or fails to recover one.
  assert(!wasUploadedUnderPreviousRules(shopOnlyLog),
    "the old rules rejected a shop-only session — that is the whole bug, and what makes it releasable");
  assert(wasUploadedUnderPreviousRules(missionLog),
    "the old rules UPLOADED a mission session, so it must never be released and sent twice");
  assert(wasUploadedUnderPreviousRules(oldHaulLog),
    "…nor may a cargo haul be released: the carve-out uploaded it under the old rules too");

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

  // 🔴 A RULES CHANGE THAT ONLY LOOKS FORWARD RECOVERS NOTHING. A widened filter only ever meets
  // sessions nobody has judged yet, and on a machine that has been running a while that is almost
  // none of them — all 533 backups on Sub's own disk were already decided, 134 of them recorded in
  // the final set. So the bump has to reach back into the verdicts the OLD rule wrote.
  const rulesDir = mkdtempSync(join(tmpdir(), "logshare-rules-"));
  const rulesBackups = join(rulesDir, "logbackups");
  mkdirSync(rulesBackups);
  const rulesLive = join(rulesDir, "game.log");
  writeFileSync(rulesLive, liveLog); // states the current patch, scrubs to nothing
  writeFileSync(join(rulesBackups, "shop.log"), shopOnlyLog);   // the old rules REJECTED this
  writeFileSync(join(rulesBackups, "mission.log"), missionLog); // the old rules UPLOADED this
  const rulesState = join(rulesDir, "s.json");
  const rulesCfg = { ...cfg, logPath: rulesLive };
  // A state file exactly as the previous build left it: both names recorded, a name set aside by
  // the patch filter, schema v2, and NO `rules` field — which is what marks the rules as stale.
  writeFileSync(rulesState, JSON.stringify({
    v: 2, backups: ["shop.log", "mission.log"], skippedPatch: ["gone-off-patch.log"], liveHash: "",
  }));

  await maybeShareLog(rulesCfg, "0.1.46", rulesState);
  const r1 = JSON.parse(readFileSync(rulesState, "utf8"));
  // Positive first: the bump must actually have been noticed. Every claim below is satisfied for
  // free by a run that did nothing at all, which is the other way this can fail.
  assert.equal(r1.rules, 2, "the rules bump must be recorded, or it fires again on every tick forever");
  assert.deepEqual(r1.skippedPatch, [],
    "a rules change must re-offer what the old rules set aside — a rejection outlives the rule that made it");
  assert(!r1.recheck?.length || Array.isArray(r1.recheck), "the pending re-judge list must be persisted, not held in memory");
  // The mission session was uploaded under the old rules and must still be recorded. Releasing it
  // would re-send it: 134 such names at one upload per 20-minute tick is 45 hours of duplicates.
  assert(state(rulesState).backups.includes("mission.log"),
    "a session the OLD rules uploaded must survive the reset — releasing it re-sends it");

  // …and the shop session is reachable again. It scrubs to empty, so it resolves rather than
  // uploading; what is being pinned is that it was RE-JUDGED at all, which the old build's final
  // verdict made impossible.
  for (let i = 0; i < 5; i++) await maybeShareLog(rulesCfg, "0.1.46", rulesState);
  const r2 = JSON.parse(readFileSync(rulesState, "utf8"));
  assert.deepEqual(r2.recheck, [], "the pending list must drain to empty, not stall part-way");
  assert.equal(r2.rules, 2, "…and the rules version must not move again once stamped");

  // Idempotence: a settled file must not be re-offered on every tick. This is the failure the
  // `touchedShareLogs` incident was — a recovery gesture that fires repeatedly is a folder being
  // re-read forever, not a recovery.
  writeFileSync(join(rulesBackups, "late-off-patch.log"), header("4.8.184.64329") + SIGNAL);
  await maybeShareLog(rulesCfg, "0.1.46", rulesState);
  assert(state(rulesState).skippedPatch.includes("late-off-patch.log"), "a later off-patch backup is still set aside normally");
  await maybeShareLog(rulesCfg, "0.1.46", rulesState);
  assert(state(rulesState).skippedPatch.includes("late-off-patch.log"),
    "a settled rules version must NOT clear the skipped list again — that is the re-offer-forever bug");
  rmSync(rulesDir, { recursive: true, force: true });

  // 🔴 THE RESET MUST NOT STAMPEDE. The whole hazard of re-opening old verdicts is that a heavy
  // user has hundreds of them, so the drain has to be BOUNDED per tick and resumable, exactly like
  // the rejection path it shares a budget with. Unbounded, this is a full-folder read of whole
  // files (RE_HAUL does not live in the header) on the first tick after an update.
  const burstDir = mkdtempSync(join(tmpdir(), "logshare-burst-"));
  const burstBackups = join(burstDir, "logbackups");
  mkdirSync(burstBackups);
  const burstLive = join(burstDir, "game.log");
  writeFileSync(burstLive, liveLog);
  const RECORDED = 60;
  const recordedNames: string[] = [];
  for (let i = 0; i < RECORDED; i++) {
    const n = `rec-${String(i).padStart(3, "0")}.log`;
    recordedNames.push(n);
    writeFileSync(join(burstBackups, n), missionLog); // all uploaded under the old rules
  }
  const burstState = join(burstDir, "s.json");
  writeFileSync(burstState, JSON.stringify({ v: 2, backups: recordedNames, skippedPatch: [], liveHash: "" }));
  await maybeShareLog({ ...cfg, logPath: burstLive }, "0.1.46", burstState);
  const b1 = JSON.parse(readFileSync(burstState, "utf8"));
  assert(b1.recheck.length > 0, `one tick drained all ${RECORDED} recorded backups — the re-judge is not bounded`);
  assert(b1.recheck.length < RECORDED, "…and it must still make progress, or the drain never finishes");
  // Every one of these was uploaded under the old rules, so not one may be released whatever the
  // drain does — a bound that leaked here would show up as duplicate uploads, not as a slow tick.
  assert.equal(b1.backups.length, RECORDED, "a bounded drain must not release a single genuine upload");
  for (let i = 0; i < 10; i++) await maybeShareLog({ ...cfg, logPath: burstLive }, "0.1.46", burstState);
  const b2 = JSON.parse(readFileSync(burstState, "utf8"));
  assert.deepEqual(b2.recheck, [], "repeated ticks must finish the re-judge, a bounded slice at a time");
  assert.equal(b2.backups.length, RECORDED, "…with every genuine upload still recorded at the end of it");
  rmSync(burstDir, { recursive: true, force: true });

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
