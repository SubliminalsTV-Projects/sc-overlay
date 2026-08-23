// The commodity picks: what the player chose, and the log filling in what they actually bought.
//
//   npx tsx src/hauling-buys.test.ts
//
// 🔴 THE CLAIM THIS FILE EXISTS TO DEFEND: nothing here ever chooses a tonnage. A pick is stored
// with `scu: null` and the ONLY thing that fills it is a purchase line out of `game.log`. Sub's
// ruling — "they don't need to pick it. They can decide when they get there and when they buy it,
// we'll know how much they bought and then it'll override it."
//
// ⚠️ EVERY LOG LINE BELOW IS CAPTURED, not constructed. The one exception is stated where it is
// used and differs from its original in the timestamp alone. This matters: the block that once
// asserted the container formula was built on a CONSTRUCTED fixture carrying `boxSize[1]`, where a
// container count and an SCU count are the same number — so it could not tell right from wrong,
// and a real 10 SCU sale was read as 20 for weeks.
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HaulingBuys } from "./hauling-buys.js";
import { parseTradeLine } from "./trade-log.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

// ⚠️ Cleaned up at the end. A suite that leaves files in %TEMP% has turned a DIFFERENT suite red in
// this repo before — `log-paths.test.ts` read 21 instead of 0 because another test left a game.log
// lying about.
const dir = mkdtempSync(join(tmpdir(), "haulbuys-"));

// ── the captured lines ─────────────────────────────────────────────────────
// Sub at the Area 18 TDD, 2026-08-19. Processed Food, one SCU, straight into the hold.
const BUY_FOOD =
  "<2026-08-19T17:43:31.000Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> "
  + "Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[762985455925] "
  + "shopName[TDD_SCShop-001] kioskId[762985455920] price[1202.000000] "
  + "shopPricePerCentiSCU[12.019500] resourceGUID[accacd33-3a1a-4ec7-8b4a-14b9f028047c] "
  + "autoLoading[1] quantity[100.000000 cSCU] Cargo Box Data: boxSize[1.000000] | unitAmount[1] "
  + "[Team_CoreGameplayFeatures][Shops][UI]";
// The other end of the same round trip. 🔑 NOT the buy line mirrored: the total is `amount`, there
// is no per-SCU price, and `quantity` carries no unit.
const SELL_FOOD =
  "<2026-08-19T18:48:02.000Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> "
  + "Sending SShopCommoditySellRequest - playerId[204772220757] shopId[762986059617] "
  + "shopName[SCShop_Admin_lt_base_g] kioskId[762986059616] amount[1506.000000] "
  + "resourceGUID[accacd33-3a1a-4ec7-8b4a-14b9f028047c] autoLoading[1] quantity[1] "
  + "transactionMode[ResourceContainer] Cargo Box Data:  [boxSize[1] | unitAmount[1]]";
// A different commodity at a different shop — 100 cSCU of it, bought to the FREIGHT ELEVATOR.
const BUY_JUNK =
  "<2026-08-19T17:43:47.000Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> "
  + "Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[762985455931] "
  + "shopName[SCShop_Outpost_Junksite] kioskId[762985455930] price[18792.000000] "
  + "shopPricePerCentiSCU[187.919998] resourceGUID[06cafea0-1111-4c8b-9d2e-7f3a55210000] "
  + "autoLoading[0] quantity[100.000000 cSCU] Cargo Box Data: boxSize[1.000000] | unitAmount[1] "
  + "[Team_CoreGameplayFeatures][Shops][UI]";

const FOOD_GUID = "accacd33-3a1a-4ec7-8b4a-14b9f028047c";
const buyOf = (line: string) => {
  const p = parseTradeLine(line)?.purchase;
  if (!p) throw new Error("the fixture line did not parse as a purchase: " + line.slice(0, 80));
  return p;
};

// POSITIVE FIRST. Every "did not fill" assertion below is free if the lines do not parse at all,
// and a silently unparsed fixture is the way this whole file becomes a tautology.
check("the captured buy line parses, with a tonnage on it",
  buyOf(BUY_FOOD).kind === "buy" && buyOf(BUY_FOOD).scu === 1,
  `scu ${buyOf(BUY_FOOD).scu}`);
check("...and the captured sell line parses too, as a SELL",
  buyOf(SELL_FOOD).kind === "sell" && buyOf(SELL_FOOD).scu === 1);

// ── a pick starts with no tonnage, and that is not a failure state ─────────
const pick = (store: HaulingBuys, commodity: string, guid: string | null, at: number) =>
  store.add({
    commodity,
    resourceGuid: guid,
    from: { terminal: "TDD Area 18", body: "ArcCorp", system: "Stanton" },
    to: { terminal: "Baijini Point", body: "ArcCorp", system: "Stanton" },
    buyPrice: 1202,
    sellPrice: 1506,
  }, at);

{
  const s = new HaulingBuys(dir);
  const b = pick(s, "Processed Food", FOOD_GUID, 1_000);
  check("a pick is stored with NO tonnage", b.scu === null && b.boughtAt === null, `scu ${b.scu}`);
  check("...and it is a real record, not an empty one",
    !!b.id && b.commodity === "Processed Food" && b.from.terminal === "TDD Area 18");
  check("...whose id is namespaced so it can never be read as a mission id", b.id.startsWith("buy"), b.id);

  // ── the override ────────────────────────────────────────────────────────
  const filled = s.applyPurchase(buyOf(BUY_FOOD));
  check("🔴 the purchase line fills the tonnage in", !!filled && filled.scu === 1, `scu ${filled?.scu}`);
  check("...along with the manifest the line states, so Stow needs no partitioner",
    filled?.boxScu === 1 && filled?.boxCount === 1, `${filled?.boxCount} x ${filled?.boxScu} SCU`);
  check("...and where the game put it, and which shop said so",
    filled?.autoLoaded === true && filled?.shopName === "TDD_SCShop-001", `${filled?.shopName}`);
  check("...and it is the pick that was already there, not a new row", s.list().length === 1);
}

// ── what must NOT fill a pick ─────────────────────────────────────────────
{
  const s = new HaulingBuys(mkdtempSync(join(tmpdir(), "haulbuys-")));
  pick(s, "Processed Food", FOOD_GUID, 1_000);
  check("a SELL of the same commodity fills nothing",
    s.applyPurchase(buyOf(SELL_FOOD)) === null && s.list()[0].scu === null);
  check("...and a BUY of a DIFFERENT commodity fills nothing either",
    s.applyPurchase(buyOf(BUY_JUNK)) === null && s.list()[0].scu === null);
  // Paired positive: the pick is still fillable, so the two refusals above are refusals rather
  // than a store that never fills anything.
  check("...while the right line still does", s.applyPurchase(buyOf(BUY_FOOD))?.scu === 1);
}

// ── the replay guard ──────────────────────────────────────────────────────
// 🔴 The sidecar feeds this store from THREE places and the newest rotated log is replayed on
// every start, so one real purchase must never fill two picks.
{
  const s = new HaulingBuys(mkdtempSync(join(tmpdir(), "haulbuys-")));
  pick(s, "Processed Food", FOOD_GUID, 1_000);
  pick(s, "Processed Food", FOOD_GUID, 2_000);
  const first = s.applyPurchase(buyOf(BUY_FOOD));
  const again = s.applyPurchase(buyOf(BUY_FOOD));
  check("🔴 replaying the SAME purchase line fills nothing a second time", again === null);
  check("...so exactly one of two identical picks has a tonnage",
    s.list().filter((b) => b.scu !== null).length === 1,
    s.list().map((b) => String(b.scu)).join(","));
  check("...and it is the OLDER pick, FIFO", first?.addedAt === 1_000, String(first?.addedAt));
  // Paired positive: a genuinely different purchase DOES fill the second one. Without this the
  // guard above is satisfied by a store that stopped filling anything after the first line.
  const second = s.applyPurchase(buyOf(BUY_FOOD.replace("17:43:31", "19:11:04")));
  check("...while a second, real purchase fills the second pick",
    second?.addedAt === 2_000 && s.list().every((b) => b.scu === 1),
    s.list().map((b) => String(b.scu)).join(","));
}

// ── it survives a restart ─────────────────────────────────────────────────
{
  const d = mkdtempSync(join(tmpdir(), "haulbuys-"));
  const a = new HaulingBuys(d);
  const made = pick(a, "Titanium", "11111111-2222-3333-4444-555555555555", 3_000);
  const b = new HaulingBuys(d);
  check("a pick survives a restart", b.list().length === 1 && b.list()[0].id === made.id);
  check("...and so does a tonnage the log filled in", (() => {
    a.applyPurchase(buyOf(BUY_FOOD.replace(FOOD_GUID, "11111111-2222-3333-4444-555555555555")));
    return new HaulingBuys(d).list()[0].scu === 1;
  })());
  check("...and a removed pick stays removed",
    !!new HaulingBuys(d).remove(made.id) && new HaulingBuys(d).list().length === 0);
}

// ── 🔴 the version field is a data-destruction switch ─────────────────────
// An older file is a valid newer one once the new fields are defaulted, so it must be READ
// FORWARD. The control for this assertion is simply bumping STATE_VERSION, which reddens it.
{
  const d = mkdtempSync(join(tmpdir(), "haulbuys-"));
  const path = join(d, "hauling-buys.json");
  // A record as an earlier build would have written it: no boxScu, no boxCount, no purchaseKey,
  // no autoLoaded. Everything the player actually chose is present.
  writeFileSync(path, JSON.stringify({
    v: 1,
    buys: [{
      id: "buyold1", resourceGuid: FOOD_GUID, commodity: "Processed Food",
      from: { terminal: "TDD Area 18", body: "ArcCorp", system: "Stanton" },
      to: { terminal: "Baijini Point", body: "ArcCorp", system: "Stanton" },
      buyPrice: 1202, sellPrice: 1506, addedAt: 1, scu: null, boughtAt: null, shopName: null,
    }],
  }));
  const s = new HaulingBuys(d);
  check("🔴 a file written before the newer fields existed is READ, not emptied",
    s.list().length === 1 && s.list()[0].id === "buyold1", `${s.list().length} pick(s)`);
  check("...with the missing fields defaulted rather than undefined",
    s.list()[0].boxScu === null && s.list()[0].purchaseKey === null && s.list()[0].autoLoaded === null);
  check("...and it still takes its purchase", s.applyPurchase(buyOf(BUY_FOOD))?.scu === 1);
}

// A file from a version this build does not know is NOT read forward — that is the one case the
// version field is for, and it is the opposite of the case above.
{
  const d = mkdtempSync(join(tmpdir(), "haulbuys-"));
  writeFileSync(join(d, "hauling-buys.json"), JSON.stringify({ v: 99, buys: [{ id: "x", commodity: "Nope" }] }));
  check("a file from an unknown version is not half-read", new HaulingBuys(d).list().length === 0);
}

// ── a tonnage the log never states is never invented ──────────────────────
{
  const s = new HaulingBuys(mkdtempSync(join(tmpdir(), "haulbuys-")));
  pick(s, "Processed Food", FOOD_GUID, 1_000);
  // `quantity[0...]` — a line stating nothing was moved. Refused rather than written, because a
  // zero downstream reads as "bought nothing", which the log does not say.
  const zero = buyOf(BUY_FOOD.replace("quantity[100.000000 cSCU]", "quantity[0.000000 cSCU]"));
  check("a zero tonnage is refused rather than recorded",
    s.applyPurchase(zero) === null && s.list()[0].scu === null, `scu ${s.list()[0].scu}`);
  // A pick made before the guid was known can never be matched — worth knowing, and worth not
  // silently matching by name instead.
  const s2 = new HaulingBuys(mkdtempSync(join(tmpdir(), "haulbuys-")));
  pick(s2, "Processed Food", null, 1_000);
  check("...and a pick with no resourceGUID is never matched by name",
    s2.applyPurchase(buyOf(BUY_FOOD)) === null && s2.list()[0].scu === null);
}

// The state file is JSON a human can read, which is how a support question gets answered.
{
  const d = mkdtempSync(join(tmpdir(), "haulbuys-"));
  const s = new HaulingBuys(d);
  pick(s, "Titanium", FOOD_GUID, 5_000);
  const raw = JSON.parse(readFileSync(join(d, "hauling-buys.json"), "utf8")) as { v: number; buys: unknown[] };
  check("the file on disk carries its version and the picks", raw.v === 1 && raw.buys.length === 1);
}

try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
