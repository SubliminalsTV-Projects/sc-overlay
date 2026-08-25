/**
 * Self-check for rotated-session sharing.  Run with:  npx tsx src/log-share.test.ts
 *
 * There are two opposite expensive failures here and the tests exist to hold BOTH at once:
 *   - "uploads the same thing every launch forever" — backups are immutable, so a verdict of
 *     sent / no signal / unreadable is FINAL and must be remembered.
 *   - "never uploads anything again, silently" — the failure found on 2026-08-16. Recording a
 *     rule-based rejection as done blacklisted it permanently, so a player who updated the app
 *     after an SC patch lost their whole backlog. A rejection is a verdict about the RULE, not the
 *     file, so it goes to a separate list that is recoverable.
 *
 * 🔴 THIS SUITE IS KEPT OFFLINE BY A STUBBED `fetch`, NOT BY MAKING EVERY FIXTURE INELIGIBLE.
 * It used to be the latter: every fixture carried the word "chat" so the scrub emptied it, which
 * kept the suite offline at the cost of never once exercising the upload path — and it made the
 * offline property depend on reasoning about each new fixture. It also became actively dangerous
 * the moment the retention rule changed, because two fixtures that were only ineligible by virtue
 * of their PATCH became eligible under a WINDOW and would have POSTed to production.
 * The stub is asserted to be installed before a single fixture is written. See selfTest below.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------------------------
// THE STUB, INSTALLED BEFORE log-share IS IMPORTED so it cannot capture the real one.
// ---------------------------------------------------------------------------------------------
interface Post { url: string; body: string; }
const posts: Post[] = [];
let failNext = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  posts.push({ url, body: typeof init?.body === "string" ? init.body : "" });
  if (url.includes("selftest")) return new Response("STUBBED", { status: 200 });
  if (failNext) return new Response("nope", { status: 400 });
  return new Response("ok", { status: 200 });
}) as typeof fetch;

const { maybeShareLog, clearSkippedBackups, hasShareSignal, wasUploadedUnderRules, sessionStartOf } =
  await import("./log-share.js");

// 🔴 POSITIVE CONTROL ON THE SAFETY MECHANISM ITSELF. Every assertion below is worthless — and
// this file starts POSTing real game logs to the production API — if the stub is not in place.
// So prove it answers before anything else runs, and prove it RECORDS, since a stub that returns
// without recording would make every "no upload happened" assertion below pass for free.
const selfTest = await fetch("https://example.invalid/selftest");
assert.equal(await selfTest.text(), "STUBBED",
  "the fetch stub is not installed — refusing to run, this suite would POST to production");
assert.equal(posts.length, 1, "…and it must RECORD, or every upload assertion here is free");
posts.length = 0;

const root = mkdtempSync(join(tmpdir(), "logshare-"));
const backupsDir = join(root, "logbackups");
mkdirSync(backupsDir);
const statePath = join(root, "shared-logs.json");
const logPath = join(root, "game.log");

// ---------------------------------------------------------------------------------------------
// FIXTURES. Dates are RELATIVE to now, never absolute: a fixture written as "2026-08-01" starts
// out describing a three-week-old session and ends up describing a three-year-old one, silently
// crossing the very window under test. Same reasoning as the trade-price fixture's asOfDaysAgo.
// ---------------------------------------------------------------------------------------------
const PATCH = "4.9.188.23497";
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
/** A rotated session as the game really writes one: a line-1 UTC stamp, then the header block. */
const session = (daysAgo: number, body: string, patch = PATCH) =>
  `<${iso(daysAgo)}> BackupNameAttachment=" Build(12344265) fixture"  -- used by backup system\n` +
  `<${iso(daysAgo)}> ProductVersion: ${patch}\n` + body;

const SIGNAL = 'Added notification "Contract Accepted:  Ship In Distress: " [4] MissionId: [11111111-2222-3333-4444-555555555555]\n';
// Verbatim shapes, one per purchase family, so the price term is checked against what the game
// really writes rather than against a paraphrase of it.
const ITEM_BUY = `<2026-08-01T00:00:00.000Z> [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[201964486871] shopId[5061003307165] shopName[SCShop_lt_a_casaba_small_base_a-001] kioskId[5061003307166] client_price[3150.000000] itemClassGUID[b5f37920-ba9a-4a07-85e9-4d09f8e2f5ad] itemName[behr_lmg_ballistic_01_mag] quantity[6]\n`;
const COMMODITY_BUY = `<2026-08-01T00:00:00.000Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[753612056089] shopName[SCShop_Outpost_Junksite] kioskId[753612056056] price[18792.000000] shopPricePerCentiSCU[187.919998] resourceGUID[06cafea0-49fe-4dce-b0f0-dc583316c66d] autoLoading[0] quantity[100.000000 cSCU]\n`;
const RENTAL = `<2026-08-01T00:00:00.000Z> [Notice] <CEntityComponentShoppingProvider::SendRentalRequest> Sending SShopRentalRequest - playerId[201964486871] shopId[5061003307165] client_price[28665.000000]\n`;
const HAUL = `<2026-08-01T00:00:00.000Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [275d8ca8-c591-4147-9058-e052d6a22d7e], generator name [Covalex_Hauling], contract [HaulCargo_AToB_Processed_Stims_Stanton3_SupplyGrade], contractDefinitionId[1440f8e2-ec3e-483c-9f48-cb1e7e71f92b], objectiveId [dropoff_4d907890-87c7-4d71-8484-85d8936d18d4_0], markerEntityId [12897], zoneHostId [742554712000]\n`;
// A session that only OPENED a kiosk: the lines matching the parsers' own component markers,
// which carry no price at all. This is why the term is the request, not the component.
const BROWSED_ONLY =
  `<2026-08-01T00:00:00.000Z> [Error] <CShopInventory::LoadInventoryFromJSON> item record [9f047e7d-1324-473c-b944-03e87976f25a] is not in the class registry & could not be added to shop[Unknown Shop] inventory.\n` +
  `<2026-08-01T00:00:00.000Z> [Notice] <CShoppingKioskContextComponent::CreatePurchasableInfo> Shopping Kiosk Context Component CreatePurchasableInfo\n` +
  `<2026-08-01T00:00:00.000Z> [Error] <CEntityComponentShopUIProvider::ClGetSelectedLocationData> Invalid inventory selection\n`;

const shopOnlyLog = session(2, ITEM_BUY + COMMODITY_BUY);
const missionLog = session(2, SIGNAL);

// The live log states the current patch for the one-time legacy repair and is NOT uploaded.
// It deliberately holds real-looking content: under the old code that content would have been
// POSTed, so its presence here is what makes the "no live upload" assertion mean something.
const liveLog = session(0, SIGNAL + ITEM_BUY);
writeFileSync(logPath, liveLog);

const cfg = { shareLogs: true, syncToken: "scbp_fake_token_for_test", logPath };
const uploads = () => posts.filter((p) => p.url.includes("/api/bp-tracker/logs"));
const kindsOf = () => uploads().map((p) => (p.url.match(/kind=(\w+)/) ?? [])[1]);

interface State { backups: string[]; skippedPatch: string[]; rules?: number; recheck?: string[]; liveHash?: string; v?: number }
const state = (p = statePath): State => {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return { backups: v.backups ?? [], skippedPatch: v.skippedPatch ?? [], rules: v.rules, recheck: v.recheck, liveHash: v.liveHash, v: v.v };
  } catch { return { backups: [], skippedPatch: [] }; }
};
const done = (): string[] => state().backups;

try {
  // =============================================================================================
  // 1. THE CLOCK. Exported so this drives the REAL rule rather than a copy of it.
  // =============================================================================================
  const HEAD_TIME = "2026-01-15T10:00:00.000Z";
  const withHeader = `<${HEAD_TIME}> BackupNameAttachment=" Build(12344265) 20 Mar 25 (10 29 50)"  -- used by backup system\n`;
  const OLD_NAME = "Game Build(9636689) 20 Mar 25 (10 29 50).log";

  // Positive first: the header must actually be read, or every precedence claim below is free.
  assert.equal(sessionStartOf(withHeader, OLD_NAME, 1234),
    Date.parse(HEAD_TIME),
    "the log's own line-1 UTC stamp is the session start");
  // …and it must OUTRANK both of the others, which is the whole reason it is first. The name here
  // says March 2025 and the mtime says 1970, so a fallback firing is unmistakable.
  assert.notEqual(sessionStartOf(withHeader, OLD_NAME, 1234), 1234, "mtime must not win over the header");
  assert.equal(new Date(sessionStartOf(withHeader, OLD_NAME, 1234)).getUTCFullYear(), 2026,
    "…nor may the filename's 2025 date win over the header's 2026 one");

  // The filename is the fallback, read in LOCAL time because the string carries no offset.
  const byName = sessionStartOf("no stamp on this line at all\n", OLD_NAME, 1234);
  assert.notEqual(byName, 1234, "with no header, the filename date must be used before mtime");
  assert.equal(new Date(byName).getFullYear(), 2025, "…and it must parse the year");
  assert.equal(new Date(byName).getMonth(), 2, "…the month (March = 2)");
  assert.equal(new Date(byName).getDate(), 20, "…and the day");

  // mtime is last and only when nothing else is available.
  assert.equal(sessionStartOf("nothing here", "unnamed.log", 987654),
    987654, "with neither a header nor a dated filename, mtime is all there is");

  // 🔴 THE ANCHOR IS LOAD-BEARING. Every line of a Game.log begins with a stamp, so an unanchored
  // match would find whichever one the 4 KB read happened to land on — and silently date a session
  // by a line from the middle of it. A stamp that is not at position 0 must be ignored.
  const notFirst = `some preamble\n<2020-01-01T00:00:00.000Z> a stamp, but not on line one\n`;
  assert.equal(sessionStartOf(notFirst, "unnamed.log", 555), 555,
    "a stamp that is not the first thing in the file must not be read as the session start");

  // =============================================================================================
  // 2. THE SIGNAL RULE. Unchanged by this flight, and re-pinned so a window change cannot quietly
  //    take the price term with it.
  // =============================================================================================
  assert(shopOnlyLog.length > 0 && missionLog.length > 0 && BROWSED_ONLY.length > 0, "the rule fixtures must be non-empty");
  assert(hasShareSignal(shopOnlyLog), "a session whose only signal is a shop purchase must be worth uploading");
  assert(hasShareSignal(session(2, RENTAL)), "…and a rental, which is a price observation like any other");
  assert(hasShareSignal(missionLog), "a mission session must still qualify");
  // 🔑 RE_HAUL's OTHER JOB. It stopped being a patch bypass when the patch test went, but it is
  // still a signal term — a cargo haul with no mission or price line is a session worth having.
  assert(hasShareSignal(session(2, HAUL)), "a cargo haul is still signal in its own right");
  assert(!hasShareSignal(session(2, BROWSED_ONLY)),
    "browsing a shop is not a price — matching the component instead of the request admits 68.8% noise");
  assert(!hasShareSignal(session(2, "just chatter\n")), "a session with nothing in it must still be refused");

  // =============================================================================================
  // 3. THE RESET'S DISCRIMINATOR, WHICH TAKES THE VERSION. A single frozen rule is wrong in one
  //    direction or the other and both are expensive, so both directions are pinned here.
  // =============================================================================================
  assert(!wasUploadedUnderRules(1, shopOnlyLog),
    "v1 REJECTED a shop-only session — that is what makes it releasable, and the v2 recovery depends on it");
  assert(wasUploadedUnderRules(2, shopOnlyLog),
    "v2 UPLOADED that same session, so a v2 file must never release it and send it twice");
  assert(wasUploadedUnderRules(1, missionLog), "a mission session was uploaded by both, so neither may release it");
  assert(wasUploadedUnderRules(2, missionLog), "…under v2 as well");
  assert(wasUploadedUnderRules(1, session(2, HAUL)), "…nor may a cargo haul be released: the carve-out uploaded it under v1 too");
  // A file with no `rules` field reads as 1, and anything at or above 2 uses the v2 rule.
  assert(!wasUploadedUnderRules(0, shopOnlyLog), "an absent/legacy version falls to the v1 rule");
  assert(wasUploadedUnderRules(3, shopOnlyLog), "v3 did not move the signal rule, so it judges by v2's");

  // =============================================================================================
  // 4. THE WINDOW, END TO END.
  // =============================================================================================
  writeFileSync(join(backupsDir, "recent.log"), missionLog);                       // 2 days old, signal
  writeFileSync(join(backupsDir, "ancient.log"), session(400, SIGNAL));            // 400 days old, signal
  writeFileSync(join(backupsDir, "ancient-haul.log"), session(400, HAUL));         // 400 days old, a haul
  writeFileSync(join(backupsDir, "no-signal.log"), session(2, "just chatter\n"));  // in window, nothing in it
  writeFileSync(join(backupsDir, "empty.log"), "");
  writeFileSync(join(backupsDir, "notes.txt"), missionLog);                        // not a .log

  await maybeShareLog(cfg, "0.1.47", statePath);
  const after = done();
  const skipped = state().skippedPatch;

  // Positive first: a run that classified nothing at all satisfies every "must not" below.
  assert(skipped.length > 0, "the first tick must actually set something aside");
  assert(after.length > 0, "…and must actually resolve something");

  // 🔴 THE WINDOW ITSELF.
  assert(skipped.includes("ancient.log"), "a session older than the retention window belongs in skippedPatch");
  assert(!after.includes("ancient.log"),
    "…and must NEVER be recorded as a final verdict — that blacklists it forever, the 2026-08-16 bug");
  assert(after.includes("recent.log"), "a session inside the window carrying signal must be uploaded and recorded");
  assert(uploads().length > 0, "…which means it really was POSTed, not merely classified");

  // 🔴 THE HAUL CARVE-OUT IS DELIBERATELY GONE. It existed only to let an OFF-PATCH haul past the
  // patch test, so it went out with the test it bypassed. An exemption that reaches past the
  // window would BE an uncapped window. Pinned so nobody restores it as a kindness.
  assert(skipped.includes("ancient-haul.log"),
    "a cargo haul older than the window is set aside like anything else — the carve-out was a PATCH bypass, not a window one");
  assert(!after.includes("ancient-haul.log"), "…and is still recoverable rather than blacklisted");

  assert(after.includes("no-signal.log"), "a signal-free backup must be remembered");
  assert(after.includes("empty.log"), "an empty backup must be remembered");
  assert(!after.includes("notes.txt") && !skipped.includes("notes.txt"), "a non-.log file should never be considered at all");

  // 🔴 THE LIVE LOG IS NOT UPLOADED. The fixture holds a real mission line and a real purchase, so
  // under the previous build it would have been POSTed on this very tick.
  assert.deepEqual([...new Set(kindsOf())], ["backup"],
    "only rotated sessions may be uploaded — a kind=live POST means the live upload came back");
  assert(!uploads().some((p) => p.body.includes("BackupNameAttachment=\" Build(12344265) fixture\"") && p.body === liveLog),
    "…and the live body specifically must never appear on the wire");
  // The state file must not carry the dead field either.
  assert.equal(state().liveHash, undefined, "liveHash is dead state and must no longer be written");

  // Idempotence: a second pass must not grow either list, re-decide anything, or re-upload.
  const before = after.slice().sort();
  const uploadCount = uploads().length;
  await maybeShareLog(cfg, "0.1.47", statePath);
  assert.deepEqual(done().slice().sort(), before, "a second tick must not re-add or re-decide anything");
  assert.deepEqual(state().skippedPatch.slice().sort(), skipped.slice().sort(), "nor re-decide the set-aside ones");
  assert.equal(uploads().length, uploadCount, "…and must not re-upload a session already sent");

  // The recovery gesture re-offers what a recoverable rule set aside, and ONLY that.
  clearSkippedBackups(statePath);
  assert.deepEqual(state().skippedPatch, [], "the toggle gesture must clear the set-aside list");
  assert.deepEqual(done().slice().sort(), before, "…and must not touch the uploaded set");
  await maybeShareLog(cfg, "0.1.47", statePath);
  assert(state().skippedPatch.includes("ancient.log"),
    "a re-offered backup is re-judged, and lands back in skippedPatch while it is still out of window");

  // Sharing off => the state file is never touched, even with eligible files present.
  const off = join(root, "off.json");
  await maybeShareLog({ ...cfg, shareLogs: false }, "0.1.47", off);
  assert.deepEqual((() => { try { return JSON.parse(readFileSync(off, "utf8")); } catch { return null; } })(), null,
    "sharing disabled must not read or write anything");
  const noTok = join(root, "notok.json");
  await maybeShareLog({ ...cfg, syncToken: "" }, "0.1.47", noTok);
  assert.deepEqual((() => { try { return JSON.parse(readFileSync(noTok, "utf8")); } catch { return null; } })(), null,
    "no sync token must not read or write anything");

  // =============================================================================================
  // 5. THE ONE-TIME LEGACY REPAIR. Still patch-based: it undoes damage the pre-0.1.45 build wrote,
  //    and that build's bug was the PATCH test, whatever the rule is today.
  // =============================================================================================
  // ⚠️ THIS BLOCK IS ABOUT THE PATCH, NOT THE WINDOW, and the two are easy to conflate now that
  // only one of them is a live rule. `legacy-off.log` is deliberately OFF-patch and comfortably
  // INSIDE the window: the repair keys on the patch because that is what the old build's bug was,
  // and a fixture that is merely old would not exercise it at all.
  const legDir = mkdtempSync(join(tmpdir(), "logshare-legacy-"));
  const legBackups = join(legDir, "logbackups");
  mkdirSync(legBackups);
  const legLive = join(legDir, "game.log");
  writeFileSync(legLive, liveLog); // states the current patch
  writeFileSync(join(legBackups, "legacy-off.log"), session(30, SIGNAL, "4.8.184.64329"));
  writeFileSync(join(legBackups, "legacy-on.log"), session(30, "just chatter\n"));
  const legCfg = { ...cfg, logPath: legLive };
  const legacyState = join(legDir, "legacy.json");
  writeFileSync(legacyState, JSON.stringify({ backups: ["legacy-off.log", "legacy-on.log"] }));
  // 🔑 THE OBSERVABLE IS THE UPLOAD, NOT THE LIST — and that is a real change from how this was
  // tested before. Under the patch rule a released off-patch name bounced straight into
  // skippedPatch, so the list could show the release. Under a one-year window it is released,
  // re-judged, uploaded AND re-recorded inside the SAME tick, so the list looks identical either
  // way and only the wire can tell "repaired" from "never touched". The patch string is unique to
  // this fixture, which is what makes the body a discriminator.
  const beforeLegacy = uploads().length;
  await maybeShareLog(legCfg, "0.1.47", legacyState);
  const repaired = state(legacyState);
  assert(uploads().length > beforeLegacy, "the repair tick must have uploaded something at all");
  assert(uploads().slice(beforeLegacy).some((p) => p.body.includes("4.8.184.64329")),
    "an off-patch name in a legacy list can only be a wrongful blacklist — it must be released, re-judged and sent");
  assert(repaired.backups.includes("legacy-on.log"),
    "an ON-patch name in a legacy list is a genuine upload and must survive the repair");
  assert(repaired.backups.includes("legacy-off.log"),
    "…and the released one is recorded again once it really has been sent, so it is not sent twice");
  assert.equal(JSON.parse(readFileSync(legacyState, "utf8")).v, 2, "the repaired file must be stamped with the new schema version");
  // Idempotence: having been sent, it must not be sent again on the next tick.
  const afterLegacy = uploads().length;
  for (let i = 0; i < 3; i++) await maybeShareLog(legCfg, "0.1.47", legacyState);
  assert.equal(uploads().length, afterLegacy, "a repaired-and-sent backup must not be uploaded a second time");

  // A repair that cannot judge the patch yet must stay PENDING, not mark itself done.
  const noPatch = join(legDir, "nopatch-live.log");
  writeFileSync(noPatch, "<2026-08-01T00:00:00.000Z> no version line here\n");
  const pending = join(legDir, "pending.json");
  writeFileSync(pending, JSON.stringify({ backups: ["legacy-off.log"] }));
  await maybeShareLog({ ...legCfg, logPath: noPatch }, "0.1.47", pending);
  assert.notEqual(JSON.parse(readFileSync(pending, "utf8")).v, 2,
    "with no patch to compare against, the repair must stay pending instead of being swallowed");
  rmSync(legDir, { recursive: true, force: true });

  // =============================================================================================
  // 6. ONE TICK MUST NOT SWEEP A FOLDER. Rejections cost no upload, so they were unbounded once,
  //    and that is how a single pass could reach every file a user owned.
  // =============================================================================================
  const many = mkdtempSync(join(tmpdir(), "logshare-many-"));
  const manyBackups = join(many, "logbackups");
  mkdirSync(manyBackups);
  const manyLog = join(many, "game.log");
  writeFileSync(manyLog, liveLog);
  const TOTAL = 60;
  for (let i = 0; i < TOTAL; i++) {
    writeFileSync(join(manyBackups, `bulk-${String(i).padStart(3, "0")}.log`), session(2, "just chatter\n"));
  }
  const manyState = join(many, "s.json");
  await maybeShareLog({ ...cfg, logPath: manyLog }, "0.1.47", manyState);
  const classified = state(manyState).backups.length + state(manyState).skippedPatch.length;
  assert(classified > 0, "a tick must still make progress");
  assert(classified < TOTAL, `one tick classified all ${TOTAL} backups — the per-tick rejection bound is not holding`);
  for (let i = 0; i < 12; i++) await maybeShareLog({ ...cfg, logPath: manyLog }, "0.1.47", manyState);
  assert.equal(state(manyState).backups.length, TOTAL, "repeated ticks must eventually classify the whole folder");
  rmSync(many, { recursive: true, force: true });

  // 🔴 THE SAME BOUND ON THE OTHER PATH. The bulk case above walks the `backups` branch; the
  // set-aside branch is a different one that a bound could hold on while this one leaks.
  const winDir = mkdtempSync(join(tmpdir(), "logshare-window-"));
  const winBackups = join(winDir, "logbackups");
  mkdirSync(winBackups);
  const winLive = join(winDir, "game.log");
  writeFileSync(winLive, liveLog);
  const OLD = 30;
  const oldNames: string[] = [];
  for (let i = 0; i < OLD; i++) {
    const n = `old-${String(i).padStart(3, "0")}.log`;
    oldNames.push(n);
    writeFileSync(join(winBackups, n), session(400 + i, SIGNAL));
  }
  const winState = join(winDir, "s.json");
  const winCfg = { ...cfg, logPath: winLive };
  await maybeShareLog(winCfg, "0.1.47", winState);
  const w1 = state(winState);
  assert(w1.skippedPatch.length > 0, "the first tick must actually classify something");
  assert(w1.skippedPatch.length < OLD, `one tick set aside all ${OLD} out-of-window backups — the bound does not hold on this path`);
  assert.deepEqual(w1.backups, [], "not one out-of-window backup may be written into the final set");
  for (let i = 0; i < 12; i++) await maybeShareLog(winCfg, "0.1.47", winState);
  const w2 = state(winState);
  assert.deepEqual(w2.skippedPatch.slice().sort(), oldNames.slice().sort(), "a bounded slice at a time, every out-of-window backup must end up set aside");
  assert.deepEqual(w2.backups, [], "…and none of them recorded as a final verdict");
  rmSync(winDir, { recursive: true, force: true });

  // =============================================================================================
  // 7. THE RULES BUMP. This is the entire feature for anyone who has already run the app: without
  //    it a widened rule only ever meets sessions nobody has judged yet, which on a real machine
  //    is almost none of them.
  // =============================================================================================
  const rulesDir = mkdtempSync(join(tmpdir(), "logshare-rules-"));
  const rulesBackups = join(rulesDir, "logbackups");
  mkdirSync(rulesBackups);
  const rulesLive = join(rulesDir, "game.log");
  writeFileSync(rulesLive, liveLog);
  writeFileSync(join(rulesBackups, "mission.log"), missionLog);
  const rulesState = join(rulesDir, "s.json");
  const rulesCfg = { ...cfg, logPath: rulesLive };
  // A state file exactly as the PREVIOUS build leaves one: schema v2, rules 2, a name recorded and
  // a name set aside. `set-aside.log` is the one this change exists to reach — under the old patch
  // rule it was refused, and it is comfortably inside a one-year window.
  writeFileSync(join(rulesBackups, "set-aside.log"), session(120, SIGNAL, "4.8.184.64329"));
  writeFileSync(rulesState, JSON.stringify({
    v: 2, rules: 2, backups: ["mission.log"], skippedPatch: ["set-aside.log"],
  }));

  // Captured BEFORE the first tick: the bump clears the set-aside list and the upload loop runs in
  // that SAME tick, so recovery starts immediately rather than on some later pass. Taking this
  // baseline afterwards measures nothing and reads as a failure.
  const beforeRecovery = uploads().length;
  await maybeShareLog(rulesCfg, "0.1.47", rulesState);
  const r1 = state(rulesState);
  // Positive first: the bump must have been NOTICED. Every claim below is satisfied for free by a
  // run that did nothing at all, which is the other way this fails.
  assert.equal(r1.rules, 3, "the rules bump must be recorded, or it fires again on every tick forever");
  assert.deepEqual(r1.skippedPatch, [],
    "a rules change must re-offer what the old rules set aside — a rejection outlives the rule that made it");
  assert(Array.isArray(r1.recheck), "the pending re-judge list must be persisted, not held in memory");
  assert(r1.backups.includes("mission.log"),
    "a session the OLD rules uploaded must survive the reset — releasing it re-sends it");

  // 🔴 AND THE RECOVERY ACTUALLY HAPPENS. The set-aside session is inside a year, so it must now
  // be uploaded. This is the assertion the whole flight turns on: without the bump it stays lost
  // forever, and every other assertion in this block passes just as happily without it.
  for (let i = 0; i < 6; i++) await maybeShareLog(rulesCfg, "0.1.47", rulesState);
  const r2 = state(rulesState);
  assert(uploads().length > beforeRecovery,
    "the previously set-aside session must actually be UPLOADED once a year-long window admits it");
  assert(r2.backups.includes("set-aside.log"),
    "…and recorded, so it is not sent again on the next tick");
  assert.deepEqual(r2.recheck, [], "the pending list must drain to empty, not stall part-way");
  assert.equal(r2.rules, 3, "…and the rules version must not move again once stamped");

  // Idempotence of the gesture: a settled version must NOT clear the set-aside list again. That is
  // the touchedShareLogs re-offer-forever failure, which re-reads a whole folder on every tick.
  writeFileSync(join(rulesBackups, "late-ancient.log"), session(500, SIGNAL));
  await maybeShareLog(rulesCfg, "0.1.47", rulesState);
  assert(state(rulesState).skippedPatch.includes("late-ancient.log"), "a later out-of-window backup is still set aside normally");
  await maybeShareLog(rulesCfg, "0.1.47", rulesState);
  assert(state(rulesState).skippedPatch.includes("late-ancient.log"),
    "a settled rules version must NOT clear the set-aside list again — that is the re-offer-forever bug");
  rmSync(rulesDir, { recursive: true, force: true });

  // =============================================================================================
  // 8. THE RESET MUST NOT STAMPEDE — AND MUST NOT STARVE THE UPLOADS EITHER.
  // =============================================================================================
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
  // One session that is NOT recorded, so it is fresh work for the upload loop on the same tick the
  // drain runs. Named to sort first by mtime is not reliable, so it is simply the newest write.
  writeFileSync(join(burstBackups, "fresh.log"), session(1, SIGNAL));
  const burstState = join(burstDir, "s.json");
  writeFileSync(burstState, JSON.stringify({ v: 2, rules: 2, backups: recordedNames, skippedPatch: [] }));

  const beforeBurst = uploads().length;
  await maybeShareLog({ ...cfg, logPath: burstLive }, "0.1.47", burstState);
  const b1 = state(burstState);
  assert((b1.recheck ?? []).length > 0, `one tick drained all ${RECORDED} recorded backups — the re-judge is not bounded`);
  assert((b1.recheck ?? []).length < RECORDED, "…and it must still make progress, or the drain never finishes");
  // Every one of these was uploaded under the old rules, so not one may be released whatever the
  // drain does — a leak here shows up as duplicate uploads, not as a slow tick.
  assert.equal(b1.backups.filter((n) => n.startsWith("rec-")).length, RECORDED,
    "a bounded drain must not release a single genuine upload");

  // 🔴 THE BUDGET SPLIT. The drain and the upload loop share one rejection counter, so a drain
  // allowed the WHOLE budget leaves the tick with no uploads at all — measured at 7 consecutive
  // dead ticks on Sub's real state file, and a year-long window makes the drain longer. Uploads
  // have to flow from the very first tick or the feature reads as broken.
  assert(uploads().length > beforeBurst,
    "a tick that is draining a rules reset must STILL upload — the drain may take a share of the budget, not all of it");
  assert(b1.backups.includes("fresh.log"), "…and the freshly-judged session must be recorded on that same tick");

  for (let i = 0; i < 12; i++) await maybeShareLog({ ...cfg, logPath: burstLive }, "0.1.47", burstState);
  const b2 = state(burstState);
  assert.deepEqual(b2.recheck, [], "repeated ticks must finish the re-judge, a bounded slice at a time");
  assert.equal(b2.backups.filter((n) => n.startsWith("rec-")).length, RECORDED,
    "…with every genuine upload still recorded at the end of it");
  rmSync(burstDir, { recursive: true, force: true });

  // =============================================================================================
  // 9. A REFUSED UPLOAD MUST NOT BE RECORDED. It is retried next tick instead — which is also why
  //    MAX_BYTES may not be raised ahead of the site: a body the site will never accept would be
  //    retried forever with every other backup queued behind it.
  // =============================================================================================
  const failDir = mkdtempSync(join(tmpdir(), "logshare-fail-"));
  const failBackups = join(failDir, "logbackups");
  mkdirSync(failBackups);
  const failLive = join(failDir, "game.log");
  writeFileSync(failLive, liveLog);
  writeFileSync(join(failBackups, "refused.log"), session(1, SIGNAL));
  const failState = join(failDir, "s.json");
  failNext = true;
  await maybeShareLog({ ...cfg, logPath: failLive }, "0.1.47", failState);
  failNext = false;
  assert(!state(failState).backups.includes("refused.log"),
    "a session the site REFUSED must not be recorded as done — it has to be retried");
  await maybeShareLog({ ...cfg, logPath: failLive }, "0.1.47", failState);
  assert(state(failState).backups.includes("refused.log"), "…and the retry must succeed once the site accepts it");
  rmSync(failDir, { recursive: true, force: true });

  // A missing logbackups/ must be survivable — plenty of installs have never rotated a log.
  const bare = mkdtempSync(join(tmpdir(), "logshare-bare-"));
  const bareLog = join(bare, "game.log");
  writeFileSync(bareLog, liveLog);
  await maybeShareLog({ ...cfg, logPath: bareLog }, "0.1.47", join(bare, "s.json"));
  rmSync(bare, { recursive: true, force: true });

  // Final sweep: across everything above, not one live body may have reached the wire.
  assert.deepEqual([...new Set(kindsOf())], ["backup"], "not one kind=live upload may have happened in this entire suite");

  console.log(`ALL PASS (${uploads().length} stubbed uploads, all kind=backup)`);
} finally {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
}
