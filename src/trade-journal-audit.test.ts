// The journal-side consistency audit: does `trade-journal.json` still agree with itself?
//
//   npx tsx src/trade-journal-audit.test.ts        (npm run test:jaudit)
//
// 🔴 THE FAILURE THIS SUITE EXISTS FOR IS NOT HYPOTHETICAL. On 2026-08-23 rows were repaired out
// of Sub's real journal while `seen` kept their keys; three real sells became invisible at that
// launch and would have stayed invisible at every future one. It read like the confirmation gate
// refusing good trades, and it was not the gate at all.
//
// 🔑 SO THE CENTRAL BLOCK BELOW IS ITSELF THE NEGATIVE CONTROL, INLINE, RUN EVERY TIME. It takes a
// journal the real `TradeJournal` built from real log lines, performs the exact hand-repair that
// caused the incident, watches the audit go RED, puts the rows back, and watches it go GREEN. A
// control that lives in the suite cannot rot the way a one-off manual one does.
//
// ⚠️ AND EVERY "no orphans" ASSERTION IS PAIRED WITH A NON-EMPTY ONE, PLACED FIRST. An audit that
// judged zero keys would report `ok: true` forever - it would certify the exact defect it exists to
// catch - so `keysAudited > 0` is asserted before `ok` is believed, everywhere.

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { TradeJournal, seenKey } from "./trade-journal.js";
import { auditJournal, parseSeenKey, describeAudit, AUDIT_MAX_RUNS } from "./trade-journal-audit.js";
import { TradeConfirmations, type CommodityPurchase } from "./trade-log.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok || !extra ? "" : "  -- " + extra}`);
};

const tmpDirs: string[] = [];
const freshDir = () => { const d = mkdtempSync(pjoin(tmpdir(), "sc-jaudit-")); tmpDirs.push(d); return d; };

// ── Real log lines, copied byte-for-byte out of Sub's sessions ──────────────
//
// 🔑 The buy/sell pair is his 2026-08-19 Area 18 round trip; the refused pair is his 2026-08-23
// Compboard sale at Levski. Synthetic lines would agree with whatever the parser happens to do.

const BUY_AUTOLOAD =
  "<2026-08-19T17:43:31.000Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> " +
  "Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[762985455925] shopName[TDD_SCShop-001] " +
  "kioskId[762985455920] price[1202.000000] shopPricePerCentiSCU[12.019500] " +
  "resourceGUID[accacd33-3a1a-4ec7-8b4a-14b9f028047c] autoLoading[1] quantity[100.000000 cSCU] " +
  "Cargo Box Data: boxSize[1.000000] | unitAmount[1] [Team_CoreGameplayFeatures][Shops][UI]";

const BUY_ELEVATOR = BUY_AUTOLOAD.replace("autoLoading[1]", "autoLoading[0]").replace("17:43:31", "17:43:47");

const SELL_REAL =
  "<2026-08-19T18:40:48.440Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> " +
  "Sending SShopCommoditySellRequest - playerId[204772220757] shopId[762986059617] " +
  "shopName[SCShop_Admin_lt_base_g] kioskId[762986059616] amount[1506.000000] " +
  "resourceGUID[accacd33-3a1a-4ec7-8b4a-14b9f028047c] autoLoading[1] quantity[1] " +
  "transactionMode[ResourceContainer] Cargo Box Data:  [boxSize[1] | unitAmount[1]] " +
  "[Team_CoreGameplayFeatures][Shops][UI]";

/** A sale the server REFUSED. Its request line is byte-identical in shape to one that worked. */
const SELL_REFUSED =
  "<2026-08-23T19:57:48.914Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> " +
  "Sending SShopCommoditySellRequest - playerId[204772220757] shopId[776283668799] " +
  "shopName[SCShop_Levski_CargoOffice_Commodities] kioskId[776283668797] amount[242550.000000] " +
  "resourceGUID[9177e3bb-6714-49f5-8beb-46a981226ff6] autoLoading[0] quantity[1] " +
  "transactionMode[Entities] Cargo Box Data:  [Team_CoreGameplayFeatures][Shops][UI]";
/** 336 ms later. Carries no resourceGUID and nothing naming the request it answers. */
const REFUSAL =
  "<2026-08-23T19:57:49.250Z> [Error] <CEntityComponentCommodityUIProvider::RmToken_CommodityTransactionResponse> " +
  "Commodity Transaction Response Error - playerId[204772220757] result[TransactionCostMismatch] " +
  "type[Selling] [Team_CoreGameplayFeatures][Shops]";

const NAMES: Record<string, string> = { "accacd33-3a1a-4ec7-8b4a-14b9f028047c": "Processed Food" };
const nameOf = (g: string): string | null => NAMES[g.toLowerCase()] ?? null;

/** Take a fixture through the REAL confirmation gate, the way the sidecar does. Hand-setting
 *  `confirmed: true` would test a path the app never uses. Throws so a broken fixture fails loudly
 *  instead of quietly making every assertion below vacuous. */
const gated = (line: string): CommodityPurchase => {
  const c = new TradeConfirmations();
  c.line(line);
  const [p] = c.flush();
  if (!p) throw new Error("fixture did not parse as a purchase: " + line.slice(0, 70));
  return p;
};

/** Swap a log line's timestamp without a regex. */
const atTime = (line: string, iso: string): string => `<${iso}>` + line.slice(line.indexOf(">") + 1);

const readState = (dir: string) => JSON.parse(readFileSync(pjoin(dir, "trade-journal.json"), "utf8"));
const writeState = (dir: string, s: unknown) => writeFileSync(pjoin(dir, "trade-journal.json"), JSON.stringify(s));

/** Sub's round trip, persisted: two buys of Processed Food, one sale of 1 SCU. */
function healthyJournalDir(): string {
  const dir = freshDir();
  const j = new TradeJournal(dir, nameOf);
  j.apply(gated(BUY_AUTOLOAD));
  j.apply(gated(BUY_ELEVATOR));
  j.apply(gated(SELL_REAL));
  j.save();
  return dir;
}

// ── The key format, pinned from both ends ───────────────────────────────────

console.log("\n-- a seen key survives the round trip --");
{
  // 🔑 `seenKey` builds them and `parseSeenKey` takes them apart, in two modules that deliberately
  // do not import each other. This assertion is the only thing holding them together.
  const buy = gated(BUY_AUTOLOAD);
  const k = parseSeenKey(seenKey(buy));
  check("a real buy key parses", !!k, seenKey(buy));
  check("...recovering the timestamp", k?.at === buy.at, `${k?.at} vs ${buy.at}`);
  check("...the kind", k?.kind === "buy", String(k?.kind));
  check("...the shop", k?.shopName === buy.shopName, `${k?.shopName} vs ${buy.shopName}`);
  check("...the commodity uuid", k?.resourceGuid === buy.resourceGuid, String(k?.resourceGuid));
  check("...and the stated total", k?.total === String(buy.total), `${k?.total} vs ${buy.total}`);

  const sell = gated(SELL_REAL);
  check("a real sell key parses as a sell", parseSeenKey(seenKey(sell))?.kind === "sell",
    String(parseSeenKey(seenKey(sell))?.kind));

  // An absent shop is stored as "", not as the string "null". Getting this wrong would make every
  // shopless purchase an orphan.
  const noShop = { ...buy, shopName: null } as CommodityPurchase;
  check("a purchase with no shop keys as empty, not \"null\"", parseSeenKey(seenKey(noShop))?.shopName === "",
    JSON.stringify(parseSeenKey(seenKey(noShop))?.shopName));
}

// ── A healthy journal ───────────────────────────────────────────────────────

console.log("\n-- a journal the app built itself audits clean --");
{
  const v = new TradeJournal(healthyJournalDir(), nameOf).view(new Date("2026-08-19T19:00:00Z"));
  const a = v.audit;
  // 🔑 POSITIVE FIRST. Everything below is free on an empty report.
  check("the fixture really produced rows", a.rows.runs === 1 && a.rows.open === 1,
    JSON.stringify(a.rows));
  check("...and real keys were judged", a.keysAudited === 3, String(a.keysAudited));
  check("...of both kinds", a.sellKeys === 1 && a.buyKeys === 2, `${a.sellKeys} sell / ${a.buyKeys} buy`);
  check("...none of them bounded out", a.boundedOutKeys === 0, String(a.boundedOutKeys));
  check("...and none unreadable", a.unreadableKeys.length === 0, JSON.stringify(a.unreadableKeys));
  // Only now is this worth anything.
  check("the audit is clean", a.ok && a.orphans.length === 0, JSON.stringify(a.orphans));
  check("...and says so in words", describeAudit(a).startsWith("journal audit: OK"), describeAudit(a));
}

// ── 🔴 THE INCIDENT, REPRODUCED — the control that runs every time ──────────

console.log("\n-- 🔴 rows repaired out of the journal while seen keeps their keys --");
{
  const dir = healthyJournalDir();
  const before = new TradeJournal(dir, nameOf).audit();
  check("the journal starts clean", before.ok && before.keysAudited === 3,
    `${before.keysAudited} judged, ${before.orphans.length} orphan(s)`);

  // THE HAND REPAIR. Exactly what happened: the rows go, the keys stay.
  const state = readState(dir);
  const keptKeys = state.seen.length;
  const healthyRuns = state.runs;
  state.runs = [];
  state.unmatched = [];
  writeState(dir, state);

  const after = new TradeJournal(dir, nameOf).audit();
  check("the keys survived the repair", keptKeys === 3 && after.keysTotal === 3, String(after.keysTotal));
  // 🔴 The assertion the whole file is for.
  check("the audit goes RED", !after.ok, JSON.stringify(after));
  check("...naming the orphaned sell", after.orphans.some((o) => o.kind === "sell" && o.at === "2026-08-19T18:40:48.440Z"),
    JSON.stringify(after.orphans.map((o) => `${o.kind}@${o.at}`)));
  // The buy that had been CONSUMED by that sale loses its evidence too - its run is gone and it is
  // no longer an open lot. The buy still holding cargo is untouched and must NOT be accused.
  check("...and the buy whose run went with it", after.orphans.some((o) => o.kind === "buy"),
    JSON.stringify(after.orphans.map((o) => o.kind)));
  check("...while the lot still on file is left alone", after.orphans.length === 2,
    JSON.stringify(after.orphans.map((o) => `${o.kind}@${o.at}`)));

  const said = describeAudit(after);
  check("the report says DRIFT", said.includes("DRIFT"), said.split("\n")[0]);
  // 🔴 The sentence that stops the reader repeating the repair that caused this.
  check("...names deleting the whole file as the only safe repair", said.includes("DELETING trade-journal.json"), said);
  check("...refuses the row edit", said.includes("Do not edit rows out of it"), said);
  check("...and refuses the key edit too", said.includes("dropping keys re-books"), said);
  // 🔑 The diagnosis, not just the symptom. This is the half that was got backwards.
  check("...and says DEDUPED rather than refused", said.includes("DEDUPED, not refused"), said);

  // PUT THE ROWS BACK IN THE SAME FILE and watch it go green again. A control that only ever
  // reddens has not shown that the green state was earned rather than accidental - and restoring
  // the same journal, rather than building a fresh one, is what makes the two runs comparable.
  const repaired = readState(dir);
  repaired.runs = healthyRuns;
  writeState(dir, repaired);
  const green = new TradeJournal(dir, nameOf).audit();
  check("the same journal with its rows back is green again", green.ok && green.keysAudited === 3,
    `${green.keysAudited} judged, ${green.orphans.length} orphan(s)`);
}

console.log("\n-- the buy side: an open lot deleted by hand --");
{
  const dir = healthyJournalDir();
  const state = readState(dir);
  check("there was a lot to delete", state.open.length === 1, JSON.stringify(state.open.length));
  state.open = [];
  writeState(dir, state);

  const a = new TradeJournal(dir, nameOf).audit();
  check("the surviving keys are still judged", a.keysAudited === 3, String(a.keysAudited));
  check("the audit goes RED", !a.ok, JSON.stringify(a.orphans));
  check("...naming the buy with nothing behind it", a.orphans.length === 1 && a.orphans[0].kind === "buy",
    JSON.stringify(a.orphans.map((o) => `${o.kind}@${o.at}`)));
  // The sale and the buy it consumed are still evidenced by the run. Accusing them would be the
  // audit inventing drift out of an ordinary journal.
  check("...and leaving the closed run's two ends alone", !a.orphans.some((o) => o.kind === "sell"),
    JSON.stringify(a.orphans.map((o) => o.kind)));
}

// ── 🔑 WHY AN ORPHAN CAN ONLY EVER MEAN DEDUPE ──────────────────────────────

console.log("\n-- 🔑 a refused sale leaves NO key, so the gate can never produce an orphan --");
{
  // 🔴 This is the fact the whole diagnosis rests on: `apply()` tests `confirmed` BEFORE it pushes
  // to `seen`. If this ever stops being true, "key present with no row" stops meaning deduped and
  // the report above starts telling people to delete a healthy file.
  // ⚠️ THE ACCEPTED SALE GOES IN FIRST, AND IT IS NOT DECORATION. Fed the refused pair alone the
  // journal is never dirty, so `save()` writes NO FILE, and "the file has no keys" would then be
  // true because there is no file - a pass for entirely the wrong reason. With one accepted sale
  // alongside it, the file exists and the assertion is about what `apply()` did.
  const dir = freshDir();
  const both = (g: string): string | null =>
    (g.toLowerCase() === "9177e3bb-6714-49f5-8beb-46a981226ff6" ? "Compboard" : nameOf(g));
  const j = new TradeJournal(dir, both);
  const c = new TradeConfirmations();
  for (const line of [SELL_REAL, SELL_REFUSED, REFUSAL]) for (const p of c.line(line)) j.apply(p);
  for (const p of c.flush()) j.apply(p);
  j.save();

  const state = readState(dir);
  // POSITIVE FIRST: the accepted sale really did land, so the file is a real journal.
  check("the accepted sale is booked", state.unmatched.length === 1
    && state.unmatched[0].resourceGuid === "accacd33-3a1a-4ec7-8b4a-14b9f028047c",
    JSON.stringify(state.unmatched.map((u: { resourceGuid: string }) => u.resourceGuid)));
  check("...and the refused one is not", !state.unmatched.some(
    (u: { resourceGuid: string }) => u.resourceGuid === "9177e3bb-6714-49f5-8beb-46a981226ff6"),
    JSON.stringify(state.unmatched));
  // 🔴 The fact the whole diagnosis rests on.
  check("🔴 the refused sale left NO key behind it", state.seen.length === 1, JSON.stringify(state.seen));
  check("...and the one key there is the ACCEPTED sale's",
    String(state.seen[0]).includes("accacd33-3a1a-4ec7-8b4a-14b9f028047c"), String(state.seen[0]));

  const a = new TradeJournal(dir, both).audit();
  check("...so the audit has nothing to accuse", a.ok && a.keysAudited === 1,
    `${a.keysAudited} judged, ${a.orphans.length} orphan(s)`);
}

// ── The bound is not drift, and the bound must not eat the audit ────────────

console.log("\n-- a trimmed row is not drift, and the watermark still judges everything newer --");
{
  // Drive the real journal past MAX_RUNS with real gated lines: one buy and one sale a minute for
  // MAX_RUNS + 1 pairs. The oldest run is trimmed away while its key stays in `seen`.
  const dir = freshDir();
  const j = new TradeJournal(dir, nameOf);
  const base = Date.parse("2026-08-01T00:00:00.000Z");
  const pairs = AUDIT_MAX_RUNS + 1;
  for (let i = 0; i < pairs; i++) {
    const buyAt = new Date(base + i * 60000).toISOString();
    const sellAt = new Date(base + i * 60000 + 1000).toISOString();
    j.apply(gated(atTime(BUY_AUTOLOAD, buyAt)));
    j.apply(gated(atTime(SELL_REAL, sellAt)));
  }
  j.save();
  const state = readState(dir);

  // 🔑 A BEHAVIOURAL PIN ON THE BOUND. `AUDIT_MAX_RUNS` is a copy of the journal's own `MAX_RUNS`;
  // comparing two constants would prove nothing, so this asserts the journal really trims there.
  check("the journal trimmed at the bound the audit assumes", state.runs.length === AUDIT_MAX_RUNS,
    `${state.runs.length} vs ${AUDIT_MAX_RUNS}`);
  check("...while every key is still on file", state.seen.length === pairs * 2, String(state.seen.length));

  const a = new TradeJournal(dir, nameOf).audit();
  check("the trimmed pair's keys are skipped, not accused", a.boundedOutKeys === 2, String(a.boundedOutKeys));
  check("...and reported rather than swallowed", describeAudit(a).includes("not judged"), describeAudit(a));
  check("...leaving the journal clean", a.ok && a.orphans.length === 0, JSON.stringify(a.orphans.slice(0, 3)));
  // 🔴 THE GUARD THAT MAKES THE BLOCK ABOVE WORTH ANYTHING. A watermark bug that skipped EVERY key
  // would satisfy "clean" here for free, forever.
  check("...having still judged everything above the watermark", a.keysAudited === pairs * 2 - 2,
    `${a.keysAudited} of ${a.keysTotal}`);

  // And real drift ABOVE the watermark is still caught WHILE THE BOUND IS IN PLAY.
  //
  // ⚠️ THE REPLACEMENT ROW IS LOAD-BEARING, and leaving it out cost a confusing first result. Just
  // deleting a run drops `runs` to 499, which is BELOW the bound - so the watermark goes away, the
  // two genuinely-trimmed keys become judgeable, and the block reports four orphans instead of the
  // one it injected. (That behaviour is correct: `runs` never shrinks on its own, so a short list
  // beside a full `seen` is itself a hand-edited file. It is simply not what this block is testing.)
  // Duplicating a surviving run keeps the length at the bound, so the ONLY thing that changed is
  // the row this block removed.
  const drifted = readState(dir);
  const lastSell = drifted.runs[drifted.runs.length - 1].soldAt;
  const filler = drifted.runs[0];
  drifted.runs = [filler, ...drifted.runs.filter((r: { soldAt: string }) => r.soldAt !== lastSell)];
  writeState(dir, drifted);
  check("the bound is still in play after the edit", drifted.runs.length === AUDIT_MAX_RUNS,
    String(drifted.runs.length));

  const b = new TradeJournal(dir, nameOf).audit();
  check("the older keys are still bounded out", b.boundedOutKeys === 2, String(b.boundedOutKeys));
  check("a row removed above the watermark is still caught", !b.ok, String(b.orphans.length));
  check("...naming that sale", b.orphans.some((o) => o.kind === "sell" && o.at === lastSell),
    JSON.stringify(b.orphans.map((o) => `${o.kind}@${o.at}`)));
  // Its buy end went with it: the lot was consumed, so that run was its only evidence.
  check("...and its buy, and nothing else", b.orphans.length === 2 && b.orphans.filter((o) => o.kind === "buy").length === 1,
    JSON.stringify(b.orphans.map((o) => `${o.kind}@${o.at}`)));
}

// ── The vacuity the brief warns about, demonstrated rather than asserted away ─

console.log("\n-- 🔑 a vacuous audit would certify the exact defect it exists to catch --");
{
  // An empty journal is genuinely consistent, so `ok` is true and `orphans` is empty. That is the
  // shape a broken audit hides in: a caller reading `ok` alone cannot tell "checked, clean" from
  // "checked nothing". `keysAudited` is the field that separates them, which is why every green
  // assertion in this file is preceded by a non-empty one.
  const a = new TradeJournal(freshDir(), nameOf).audit();
  check("an empty journal reports no orphans", a.orphans.length === 0 && a.ok, JSON.stringify(a));
  check("🔑 ...on ZERO keys judged", a.keysAudited === 0, String(a.keysAudited));
  check("...and the report refuses to call that OK", describeAudit(a).includes("nothing to check"), describeAudit(a));
}

console.log("\n-- a key in a shape the parser does not know is reported, never accused --");
{
  // Guessing at an unrecognised key would let this audit accuse a healthy journal. An unreadable
  // key is a claim about this parser, not about the file.
  const dir = healthyJournalDir();
  const state = readState(dir);
  state.seen.push("this-is-not-a-key");
  writeState(dir, state);
  const a = new TradeJournal(dir, nameOf).audit();
  check("the junk key is reported", a.unreadableKeys.length === 1, JSON.stringify(a.unreadableKeys));
  check("...and NOT counted as drift", a.ok && a.orphans.length === 0, JSON.stringify(a.orphans));
  check("...while the real keys are still judged", a.keysAudited === 3, String(a.keysAudited));
  check("...and the count is surfaced", describeAudit(a).includes("unrecognised shape"), describeAudit(a));
}

console.log("\n-- the audit never writes ------------------------------------");
{
  // 🔴 The one behaviour the file promises. A "repair" that edits rows is what caused the incident.
  const dir = healthyJournalDir();
  const state = readState(dir);
  state.runs = [];
  writeState(dir, state);
  const onDisk = readFileSync(pjoin(dir, "trade-journal.json"), "utf8");
  const j = new TradeJournal(dir, nameOf);
  check("the drifted journal is detected", !j.audit().ok, JSON.stringify(j.audit().orphans.length));
  j.view();
  check("...and the file is byte-identical afterwards",
    readFileSync(pjoin(dir, "trade-journal.json"), "utf8") === onDisk, "the audit wrote to the journal");
  // The module exports no writer at all - the strongest form of this promise.
  check("...because the audit module exports nothing that writes",
    Object.keys({ auditJournal, parseSeenKey, describeAudit }).length === 3);
}

for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(failures === 0 ? "\nAll journal-audit assertions passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
