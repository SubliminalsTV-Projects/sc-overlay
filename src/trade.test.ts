// Commodity trading: the log parser, and the finder's honesty rules.
//
//   npx tsx src/trade.test.ts
//
// 🔑 THE PARSER FIXTURES ARE REAL LINES, copied byte-for-byte out of Sub's own session on
// 2026-08-19 (Area 18 TDD, the same commodity bought twice - once auto-loaded, once to the
// freight elevator - plus a Shubin buy and a shop inventory line). Synthetic fixtures would have
// agreed with whatever the parser happened to do; these agree with the game.

import { parseTradeLine, type CommodityPurchase } from "./trade-log.js";
import { findRoutes, lookupCommodity, legMinutes, type TradeRoute } from "./trade-finder.js";
import type { TradeQuote } from "./trade-prices.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok || !extra ? "" : "  -- " + extra}`);
};

// ── Real log lines ──────────────────────────────────────────────────────────

const BUY_AUTOLOAD =
  "<2026-08-19T17:43:31.000Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> " +
  "Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[762985455925] shopName[TDD_SCShop-001] " +
  "kioskId[762985455920] price[1202.000000] shopPricePerCentiSCU[12.019500] " +
  "resourceGUID[accacd33-3a1a-4ec7-8b4a-14b9f028047c] autoLoading[1] quantity[100.000000 cSCU] " +
  "Cargo Box Data: boxSize[1.000000] | unitAmount[1] [Team_CoreGameplayFeatures][Shops][UI]";

const BUY_ELEVATOR = BUY_AUTOLOAD.replace("autoLoading[1]", "autoLoading[0]").replace("17:43:31", "17:43:47");

const BUY_SHUBIN =
  "<2026-08-19T17:23:33.458Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> " +
  "Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[762985629190] " +
  "shopName[SCShop_ht_delta_shubin_m_store] kioskId[762985629189] price[33061.000000] " +
  "shopPricePerCentiSCU[82.650002] resourceGUID[60f116f4-c02a-45b2-9ded-333747795124] autoLoading[0] " +
  "quantity[400.000000 cSCU] Cargo Box Data: boxSize[4.000000] | unitAmount[1] [Team_CoreGameplayFeatures][Shops][UI]";

const SHOP_INVENTORY =
  "<2026-08-19T17:41:28.913Z> [Notice] <CEntityComponentCommodityUIProvider::LoadShopInventoryData::<lambda_1>::operator ()> " +
  "AddingCommodityBox - playerId[204772220757] shopId[753611946905] shopName[SCShop_Admin_Area18] " +
  "commodityName[ResourceType.Waste] Available Box Sizes:  boxSize[1] boxSize[2] boxSize[4] boxSize[8] " +
  "boxSize[16] boxSize[24] boxSize[32] [Team_CoreGameplayFeatures][Shops][UI]";

const NOT_OURS =
  "<2026-08-19T17:41:28.913Z> [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> something else entirely";

console.log("\n-- parsing a real purchase --");
{
  const e = parseTradeLine(BUY_AUTOLOAD);
  const p = e?.purchase;
  check("a buy line parses as a purchase", !!p);
  check("shop is the TDD", p?.shopName === "TDD_SCShop-001", String(p?.shopName));
  check("resourceGUID survives whole", p?.resourceGuid === "accacd33-3a1a-4ec7-8b4a-14b9f028047c", String(p?.resourceGuid));
  // 100 cSCU = 1 SCU. Getting this wrong is a 100x error in every downstream figure.
  check("quantity converts cSCU -> SCU", p?.scu === 1, String(p?.scu));
  // 12.0195 per centiSCU x 100 = 1201.95 aUEC/SCU.
  check("price per SCU is centi x 100", Math.abs((p?.pricePerScu ?? 0) - 1201.95) < 0.01, String(p?.pricePerScu));
  check("total is carried as stated", p?.total === 1202, String(p?.total));
  check("box size", p?.boxScu === 1, String(p?.boxScu));
  check("timestamp is kept", p?.at === "2026-08-19T17:43:31.000Z", String(p?.at));
  check("kind is buy", p?.kind === "buy");
}

console.log("\n-- autoLoading tells the two purchases apart --");
{
  // 🔑 This is the assertion the whole experiment was run for: two buys 16s apart, identical in
  // every field but one. If these ever read the same, the Stow tab cannot know what is aboard.
  const onShip = parseTradeLine(BUY_AUTOLOAD)?.purchase;
  const onElevator = parseTradeLine(BUY_ELEVATOR)?.purchase;
  check("auto-loaded buy reads true", onShip?.autoLoaded === true, String(onShip?.autoLoaded));
  check("freight-elevator buy reads false", onElevator?.autoLoaded === false, String(onElevator?.autoLoaded));
  check("they are otherwise the same purchase",
    onShip?.resourceGuid === onElevator?.resourceGuid && onShip?.scu === onElevator?.scu);
  check("false is not confused with absent", onElevator?.autoLoaded !== null);
}

console.log("\n-- a second real buy, different shop and box size --");
{
  const p = parseTradeLine(BUY_SHUBIN)?.purchase;
  check("Shubin buy parses", !!p);
  check("4 SCU", p?.scu === 4, String(p?.scu));
  check("8265 aUEC/SCU", Math.abs((p?.pricePerScu ?? 0) - 8265) < 0.5, String(p?.pricePerScu));
  check("4 SCU box", p?.boxScu === 4, String(p?.boxScu));
  // 8265 x 4 = 33060, and the log says 33061 - the game rounds. Assert the RELATIONSHIP holds
  // rather than an exact identity, or this fails on every rounding boundary.
  check("total is consistent with per-SCU x quantity",
    Math.abs((p?.total ?? 0) - (p?.pricePerScu ?? 0) * (p?.scu ?? 0)) <= 2,
    `${p?.total} vs ${(p?.pricePerScu ?? 0) * (p?.scu ?? 0)}`);
}

console.log("\n-- shop inventory lines --");
{
  const o = parseTradeLine(SHOP_INVENTORY)?.offer;
  check("inventory line parses as an offer", !!o);
  check("commodity token kept as the game writes it", o?.commodityToken === "ResourceType.Waste", String(o?.commodityToken));
  // ⚠️ Repeated `boxSize[..]` keys: the generic field map keeps the FIRST of a repeated key, so a
  // naive implementation reports one size. The real answer is all seven.
  check("every box size is collected", o?.boxSizes.length === 7, JSON.stringify(o?.boxSizes));
  check("the sizes are the real ladder",
    JSON.stringify(o?.boxSizes) === JSON.stringify([1, 2, 4, 8, 16, 24, 32]), JSON.stringify(o?.boxSizes));
}

// The other half of the same round trip, captured an hour later at the far end. Real line.
const SELL_REAL =
  "<2026-08-19T18:40:48.440Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> " +
  "Sending SShopCommoditySellRequest - playerId[204772220757] shopId[762986059617] " +
  "shopName[SCShop_Admin_lt_base_g] kioskId[762986059616] amount[1506.000000] " +
  "resourceGUID[accacd33-3a1a-4ec7-8b4a-14b9f028047c] autoLoading[1] quantity[1] " +
  "transactionMode[ResourceContainer] Cargo Box Data:  [boxSize[1] | unitAmount[1]] " +
  "[Team_CoreGameplayFeatures][Shops][UI]";

console.log("\n-- the sell line, which is NOT the buy line mirrored --");
{
  const p = parseTradeLine(SELL_REAL)?.purchase;
  check("a sell line parses", !!p);
  check("kind is sell", p?.kind === "sell", String(p?.kind));
  // 🔴 The 100x trap. `quantity[1]` here is ONE CONTAINER, not 1 cSCU. Dividing by 100 the way the
  // buy line requires would report this 1 SCU sale as 0.01 SCU.
  check("quantity[1] with no unit is containers, not centiSCU", p?.scu === 1, String(p?.scu));
  check("the total comes from amount[], not price[]", p?.total === 1506, String(p?.total));
  // No shopPricePerCentiSCU on a sell, so this one is derived.
  check("per-SCU is derived when the line does not state it", p?.pricePerScu === 1506, String(p?.pricePerScu));
  check("transactionMode is kept", p?.transactionMode === "ResourceContainer", String(p?.transactionMode));
  check("box size survives the nested Cargo Box Data brackets", p?.boxScu === 1, String(p?.boxScu));
  check("the shop is named", p?.shopName === "SCShop_Admin_lt_base_g", String(p?.shopName));
}

console.log("\n-- the round trip joins on resourceGUID alone --");
{
  const bought = parseTradeLine(BUY_AUTOLOAD)?.purchase;
  const sold = parseTradeLine(SELL_REAL)?.purchase;
  check("both ends name the same commodity", bought?.resourceGuid === sold?.resourceGuid, String(sold?.resourceGuid));
  check("...and it is the Processed Food uuid",
    sold?.resourceGuid === "accacd33-3a1a-4ec7-8b4a-14b9f028047c", String(sold?.resourceGuid));
  check("bought at 1202/SCU", Math.round(bought?.pricePerScu ?? 0) === 1202, String(bought?.pricePerScu));
  check("sold at 1506/SCU", Math.round(sold?.pricePerScu ?? 0) === 1506, String(sold?.pricePerScu));
  // The whole point of the subsystem, computable from two log lines and nothing else.
  const profit = ((sold?.pricePerScu ?? 0) - (bought?.pricePerScu ?? 0)) * (sold?.scu ?? 0);
  check("a real profit falls out of the two lines", Math.round(profit) === 304, String(profit));
  check("...and it is positive, not merely defined", profit > 0);
  // 🔑 The buy line and the sell line must not be parsed by one set of assumptions - assert they
  // genuinely differ, so a future "simplification" that unifies them fails here.
  check("the two lines really do carry different keys",
    BUY_AUTOLOAD.includes("shopPricePerCentiSCU") && !SELL_REAL.includes("shopPricePerCentiSCU"));
  check("...and different quantity units",
    BUY_AUTOLOAD.includes("cSCU") && !SELL_REAL.includes("cSCU"));
}

console.log("\n-- containers x box size, corroborated on the buy lines --");
{
  // 🔑 WHY THIS BLOCK EXISTS. Sub's real sell carries `boxSize[1]`, so `quantity x boxScu` and
  // `quantity` alone give the same answer and no assertion over that line can tell the two apart -
  // the negative control proved it by staying green. The BUY lines settle it on real data,
  // because they state the volume BOTH ways: a cSCU quantity and a box breakdown. Where both are
  // present they must agree, and that agreement is what licenses the container formula on a sell.
  for (const [label, line] of [["TDD, 1 SCU box", BUY_AUTOLOAD], ["Shubin, 4 SCU box", BUY_SHUBIN]] as const) {
    const p = parseTradeLine(line)?.purchase;
    const viaBoxes = (p?.unitAmount ?? 0) * (p?.boxScu ?? 0);
    check(`${label}: boxes x box size equals the centiSCU volume`, viaBoxes === p?.scu, `${viaBoxes} vs ${p?.scu}`);
    check(`${label}: ...and that volume is not zero`, (p?.scu ?? 0) > 0, String(p?.scu));
  }

  // A container-mode line with a box bigger than 1, so the multiplication is load-bearing.
  // ⚠️ CONSTRUCTED from the real sell above by changing only quantity and boxSize - labelled as
  // such rather than passed off as a capture. The formula it checks is the one corroborated above.
  const twoBigBoxes = SELL_REAL.replace("quantity[1]", "quantity[2]").replace("boxSize[1]", "boxSize[4]");
  const p = parseTradeLine(twoBigBoxes)?.purchase;
  check("2 containers of 4 SCU is 8 SCU, not 2", p?.scu === 8, String(p?.scu));
  check("...and the derived per-SCU divides by the real volume",
    Math.abs((p?.pricePerScu ?? 0) - 1506 / 8) < 0.01, String(p?.pricePerScu));
}

console.log("\n-- what the parser must NOT do --");
{
  check("a non-commodity line is ignored entirely", parseTradeLine(NOT_OURS) === null);
  check("an empty line is ignored", parseTradeLine("") === null);
  // 🔴 A verb we do not model must ANNOUNCE itself. The sell verb is still unconfirmed, and this
  // project has three times concluded "not logged" from a keyword guess that simply missed.
  const unknown = parseTradeLine(
    "<2026-08-19T18:00:00.000Z> [Notice] <CEntityComponentCommodityUIProvider::SomeNewVerb> whatever");
  check("an unmodelled verb is surfaced, not swallowed", unknown?.unknownMethod === "SomeNewVerb", JSON.stringify(unknown));
  // The tags at the end of every line are bracketed too; they must not become fields.
  const p = parseTradeLine(BUY_AUTOLOAD)?.purchase;
  check("trailing [Team_...] tags are not parsed as fields", p?.shopName === "TDD_SCShop-001");
}

// ── The finder ──────────────────────────────────────────────────────────────

const q = (o: Partial<TradeQuote> & { commodity: string; terminal: string }): TradeQuote => ({
  commodity: o.commodity,
  terminal: o.terminal,
  terminalShort: o.terminalShort ?? o.terminal,
  system: o.system ?? "Stanton",
  body: o.body ?? "ArcCorp",
  place: o.place ?? o.terminal,
  buy: o.buy ?? null,
  sell: o.sell ?? null,
  stockScu: o.stockScu ?? null,
  demandScu: o.demandScu ?? null,
  maxContainerScu: o.maxContainerScu ?? null,
  asOf: o.asOf ?? null,
});

const NOW = 1_755_600_000_000; // fixed, so nothing here is time-dependent
const daysAgo = (d: number) => Math.round((NOW - d * 86_400_000) / 1000);

console.log("\n-- routes: the arithmetic --");
{
  const quotes = [
    q({ commodity: "Processed Food", terminal: "TDD Area 18", buy: 1202, stockScu: 5000, asOf: daysAgo(1) }),
    q({ commodity: "Processed Food", terminal: "Everus Harbor", body: "Hurston", sell: 1500, demandScu: 4437, asOf: daysAgo(2) }),
  ];
  const r = findRoutes(quotes, { capacityScu: 64, now: NOW });
  check("one route is found", r.length === 1, String(r.length));
  const one = r[0];
  check("margin is sell minus buy", one?.marginPerScu === 298, String(one?.marginPerScu));
  check("the hold is the binding constraint here", one?.scuBound === "hold", String(one?.scuBound));
  check("moves a full hold", one?.moveScu === 64, String(one?.moveScu));
  check("profit is margin x SCU", one?.profit === 298 * 64, String(one?.profit));
  check("capital required is buy x SCU", one?.capitalRequired === 1202 * 64, String(one?.capitalRequired));
  // Rule B: a route is only as fresh as its stalest half.
  check("age is the OLDER of the two quotes", Math.round(one?.ageDays ?? 0) === 2, String(one?.ageDays));
  check("cross-body leg costs more than same-body",
    legMinutes(one.from, one.to) > legMinutes(one.from, { ...one.to, body: one.from.body }));
}

console.log("\n-- routes: the bound that bit is named --");
{
  const base = [
    q({ commodity: "X", terminal: "A", buy: 100, stockScu: 20 }),
    q({ commodity: "X", terminal: "B", body: "Hurston", sell: 200, demandScu: 4000 }),
  ];
  const stockBound = findRoutes(base, { capacityScu: 64, now: NOW })[0];
  check("stock is named when stock is smallest", stockBound?.scuBound === "stock", String(stockBound?.scuBound));
  check("and it caps the run", stockBound?.moveScu === 20, String(stockBound?.moveScu));

  const demand = [
    q({ commodity: "X", terminal: "A", buy: 100, stockScu: 900 }),
    q({ commodity: "X", terminal: "B", body: "Hurston", sell: 200, demandScu: 7 }),
  ];
  const demandBound = findRoutes(demand, { capacityScu: 64, now: NOW })[0];
  check("demand is named when the buyer is the limit", demandBound?.scuBound === "demand", String(demandBound?.scuBound));
  check("and it caps the run", demandBound?.moveScu === 7, String(demandBound?.moveScu));

  // 🔴 Rule C. With no stock reported the hold is a CEILING, not a fact, and the route must say so.
  const silent = [
    q({ commodity: "X", terminal: "A", buy: 100 }),
    q({ commodity: "X", terminal: "B", body: "Hurston", sell: 200 }),
  ];
  const unknown = findRoutes(silent, { capacityScu: 64, now: NOW })[0];
  check("unreported stock is NOT reported as a hold-bound run", unknown?.scuBound === "unknown", String(unknown?.scuBound));
  check("but the route is still offered", !!unknown);

  // A reported ZERO is knowledge, and must not read the same as silence.
  const none = [
    q({ commodity: "X", terminal: "A", buy: 100, stockScu: 0 }),
    q({ commodity: "X", terminal: "B", body: "Hurston", sell: 200, demandScu: 400 }),
  ];
  check("a reported stock of zero drops the route entirely", findRoutes(none, { capacityScu: 64, now: NOW }).length === 0);
}

console.log("\n-- routes: filters --");
{
  const quotes = [
    q({ commodity: "X", terminal: "A", system: "Stanton", buy: 100, stockScu: 500 }),
    q({ commodity: "X", terminal: "P", system: "Pyro", body: "Pyro I", sell: 400, demandScu: 500 }),
    q({ commodity: "X", terminal: "S", system: "Stanton", body: "Hurston", sell: 150, demandScu: 500 }),
  ];
  const all = findRoutes(quotes, { capacityScu: 64, now: NOW, limit: 50 });
  check("the cross-system route is found at all", all.some((r) => r.crossSystem), JSON.stringify(all.map((r) => r.to.terminal)));

  // The backhaul filter: I am already going to Stanton/Hurston, what can I take?
  const backhaul = findRoutes(quotes, { capacityScu: 64, now: NOW, toBody: "Hurston", limit: 50 });
  check("toBody restricts the destination", backhaul.length === 1 && backhaul[0].to.terminal === "S",
    JSON.stringify(backhaul.map((r) => r.to.terminal)));
  check("...and it is NOT empty", backhaul.length > 0);

  const fromPyro = findRoutes(quotes, { capacityScu: 64, now: NOW, fromSystem: "Pyro" });
  check("fromSystem with no buy side yields nothing", fromPyro.length === 0, String(fromPyro.length));

  const stocked = findRoutes(
    [q({ commodity: "Y", terminal: "A", buy: 10 }), q({ commodity: "Y", terminal: "B", body: "Hurston", sell: 99 })],
    { capacityScu: 64, now: NOW, requireKnownStock: true });
  check("requireKnownStock drops unreported rows", stocked.length === 0, String(stocked.length));
}

console.log("\n-- routes: budget and ranking --");
{
  const quotes = [
    q({ commodity: "X", terminal: "A", buy: 1000, stockScu: 5000 }),
    q({ commodity: "X", terminal: "B", body: "Hurston", sell: 1500, demandScu: 5000 }),
  ];
  const poor = findRoutes(quotes, { capacityScu: 64, budget: 10_000, now: NOW })[0];
  check("a small budget caps the SCU", poor?.moveScu === 10, String(poor?.moveScu));
  check("and capital required never exceeds the budget", (poor?.capitalRequired ?? 0) <= 10_000, String(poor?.capitalRequired));

  // 🔑 Ranked on per-hour, not per-SCU: a fat margin on a tiny pile loses to a full hold nearby.
  const mixed = [
    q({ commodity: "Fat", terminal: "A", buy: 1000, stockScu: 2 }),
    q({ commodity: "Fat", terminal: "B", body: "Hurston", sell: 90_000, demandScu: 900 }),
    q({ commodity: "Bulk", terminal: "A", buy: 100, stockScu: 5000 }),
    q({ commodity: "Bulk", terminal: "C", sell: 900, demandScu: 5000 }),
  ];
  const ranked = findRoutes(mixed, { capacityScu: 400, now: NOW, limit: 10 });
  check("the ranking is not empty", ranked.length >= 2, String(ranked.length));
  check("a full hold of the cheap thing outranks 2 SCU of the rich thing",
    ranked[0]?.commodity === "Bulk", ranked.map((r) => `${r.commodity}:${Math.round(r.profitPerHour)}`).join(" "));
  check("per-SCU margin still favours the rich one, which is why per-hour matters",
    (mixed[1].sell as number) - (mixed[0].buy as number) > (mixed[3].sell as number) - (mixed[2].buy as number));

  // One decision per row, not forty hats.
  const many = [
    q({ commodity: "X", terminal: "A", buy: 100, stockScu: 900 }),
    ...Array.from({ length: 12 }, (_, i) => q({ commodity: "X", terminal: "D" + i, body: "Hurston", sell: 200 - i, demandScu: 900 })),
  ];
  const deduped = findRoutes(many, { capacityScu: 64, now: NOW, limit: 50 });
  check("one row per (commodity, buy terminal)", deduped.length === 1, String(deduped.length));
  check("...and it kept the BEST destination", deduped[0]?.to.terminal === "D0", String(deduped[0]?.to.terminal));
}

console.log("\n-- lookup: ranges, never one number --");
{
  const quotes = [
    q({ commodity: "Titanium", terminal: "A", buy: 100, asOf: daysAgo(1) }),
    q({ commodity: "Titanium", terminal: "B", buy: 140, asOf: daysAgo(9) }),
    q({ commodity: "Titanium", terminal: "C", buy: 120, asOf: daysAgo(3) }),
    q({ commodity: "Titanium", terminal: "D", sell: 300 }),
    q({ commodity: "Titanium (Ore)", terminal: "E", buy: 5 }),
  ];
  const l = lookupCommodity(quotes, "titanium", "live", NOW);
  check("lookup finds it case-insensitively", !!l);
  check("buy side is a range", l?.buy?.low === 100 && l?.buy?.high === 140, JSON.stringify(l?.buy));
  check("with the terminal count behind it", l?.buy?.terminals === 3, String(l?.buy?.terminals));
  check("median is beside the range, not instead of it", l?.buy?.median === 120, String(l?.buy?.median));
  check("age spread is carried", Math.round(l?.buy?.freshestDays ?? 0) === 1 && Math.round(l?.buy?.stalestDays ?? 0) === 9,
    JSON.stringify([l?.buy?.freshestDays, l?.buy?.stalestDays]));
  // 🔴 Exact match only: "Titanium (Ore)" is a different commodity at a different price, and
  // answering a Titanium question with it is the bug /api/commodity-price had to be repaired for.
  check("a suffixed variant is NOT folded in", !!l?.buyAt.every((e) => e.terminal !== "E"), JSON.stringify(l?.buyAt.map((e) => e.terminal)));
  check("buy terminals are cheapest first", l?.buyAt[0].price === 100, String(l?.buyAt[0].price));
  check("sell terminals are dearest first", l?.sellAt[0].price === 300, String(l?.sellAt[0].price));
  check("an unknown commodity is null, not an empty shell", lookupCommodity(quotes, "Unobtainium", "live", NOW) === null);
  check("a commodity with no sell side still returns", !!lookupCommodity(quotes, "Titanium (Ore)", "live", NOW));
  check("...with a null sell summary rather than a zero", lookupCommodity(quotes, "Titanium (Ore)", "live", NOW)?.sell === null);
}

// ── The normaliser: sparse UEX inventory columns ────────────────────────────
//
// 🔴 The regression this guards is the one that deleted four fifths of the route table. UEX writes
// 0 into `scu_sell` on 1,628 of 1,882 sell rows while `scu_sell_stock` carries the real figure, so
// reading that 0 as "this terminal will take nothing" capped those runs at 0 SCU and dropped them.

import { TradePriceStore } from "./trade-prices.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

// 🔴 EVERY STORE GETS ITS OWN stateDir. The first draft shared one, so the refresh cache written
// by the first block was read back as a "cache" source by the next two and turned three correct
// assertions red for reasons that had nothing to do with them. Same shape as the handover suite
// leaving game.log files in %TEMP% and reddening the log-paths suite: a test that writes to a
// shared location decides other suites results by run order.
const tmpDirs: string[] = [];
const freshDir = () => { const d = mkdtempSync(pjoin(tmpdir(), "sc-trade-test-")); tmpDirs.push(d); return d; };
const cleanupTmp = () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } };

const remote = (rows: unknown[], terminals: unknown[]) =>
  (async () => new Response(JSON.stringify({ prices: rows, terminals, fetchedAt: NOW }), {
    status: 200, headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;

const TERMS = [
  { id: 1, name: "Admin - A", nickname: "A", star_system_name: "Stanton", planet_name: "ArcCorp", is_available_live: 1, max_container_size: 32 },
  { id: 2, name: "Admin - B", nickname: "B", star_system_name: "Stanton", planet_name: "Hurston", is_available_live: 1, max_container_size: 24 },
  { id: 3, name: "Admin - Gone", nickname: "Gone", star_system_name: "Pyro", planet_name: "Pyro I", is_available_live: 0, max_container_size: 32 },
];

async function storeWith(rows: unknown[]) {
  const s = new TradePriceStore({
    dataDir: ".", stateDir: freshDir(), url: "http://stub/",
    bundled: () => ({}), places: () => new Map(), fetchImpl: remote(rows, TERMS),
  });
  return s.refresh();
}

console.log("\n-- the normaliser --");
{
  const t = await storeWith([
    // The real shape: scu_sell is a sparse 0, scu_sell_stock carries the figure.
    { id_terminal: 2, commodity_name: "Aluminum", price_sell: 8300, scu_sell: 0, scu_sell_stock: 1034, date_modified: daysAgo(1) },
    { id_terminal: 1, commodity_name: "Aluminum", price_buy: 5000, scu_buy: 400, date_modified: daysAgo(1) },
    // A terminal the game does not currently have.
    { id_terminal: 3, commodity_name: "Aluminum", price_sell: 99_999, scu_sell_stock: 50, date_modified: daysAgo(1) },
  ]);
  check("the live table is built", t.source === "live" && t.quotes.length > 0, `${t.source} ${t.quotes.length}`);
  const sell = t.quotes.find((x) => x.terminal === "Admin - B");
  check("a sparse scu_sell falls through to scu_sell_stock", sell?.demandScu === 1034, String(sell?.demandScu));
  check("...and is NOT reported as a demand of zero", sell?.demandScu !== 0);
  const buy = t.quotes.find((x) => x.terminal === "Admin - A");
  check("buy-side stock is carried", buy?.stockScu === 400, String(buy?.stockScu));
  check("terminal hierarchy resolves to a body", buy?.body === "ArcCorp", String(buy?.body));
  check("max container size is carried", buy?.maxContainerScu === 32, String(buy?.maxContainerScu));

  // ⚠️ A must-not-contain assertion is free when the set is empty, so assert the set first.
  check("an offline terminal is dropped", t.droppedOffline === 1, String(t.droppedOffline));
  check("...and its quote is not in the table", !t.quotes.some((x) => x.terminal === "Admin - Gone"));

  // 🔴 A ZERO IN A UEX INVENTORY COLUMN IS SILENCE, AND MUST BECOME null RATHER THAN 0.
  // Without this the fixture above never exercises the rule - `scu_sell_stock` carries a real
  // figure there, so the leading argument is never the zero and a broken `inventory()` passes.
  // The consequence of getting it wrong is not cosmetic: `stockScu: 0` deletes the route, while
  // `stockScu: null` keeps it and labels it "stock unknown", which is the true statement.
  const zeros = await storeWith([
    { id_terminal: 1, commodity_name: "Quartz", price_buy: 100, scu_buy: 0, date_modified: daysAgo(1) },
    { id_terminal: 2, commodity_name: "Quartz", price_sell: 400, scu_sell_stock: 0, scu_sell: 0, date_modified: daysAgo(1) },
  ]);
  const zBuy = zeros.quotes.find((x) => x.commodity === "Quartz" && x.buy !== null);
  const zSell = zeros.quotes.find((x) => x.commodity === "Quartz" && x.sell !== null);
  check("a zero scu_buy reads as unreported, not as an empty shelf", zBuy?.stockScu === null, String(zBuy?.stockScu));
  check("a zero in BOTH demand columns reads as unreported", zSell?.demandScu === null, String(zSell?.demandScu));
  const zRoutes = findRoutes(zeros.quotes, { capacityScu: 64, now: NOW });
  check("...so the route survives instead of being deleted", zRoutes.length === 1, String(zRoutes.length));
  check("...and is honestly labelled unknown", zRoutes[0]?.scuBound === "unknown", String(zRoutes[0]?.scuBound));

  // 🔴 The end-to-end consequence: the route must survive, at the FULL hold.
  const routes = findRoutes(t.quotes, { capacityScu: 64, now: NOW });
  check("the route is not deleted by a sparse demand column", routes.length === 1, String(routes.length));
  check("...and it is not capped to zero", routes[0]?.moveScu === 64, String(routes[0]?.moveScu));
  check("...and demand is not the named bound", routes[0]?.scuBound === "hold", String(routes[0]?.scuBound));
}

console.log("\n-- the source chain never goes blank --");
{
  const failing = new TradePriceStore({
    dataDir: ".", stateDir: freshDir(), url: "http://stub/",
    bundled: () => ({ x: { name: "Bundled Thing", prices: [{ terminal: "T", buy: 5, sell: 9 }] } }),
    places: () => new Map(),
    fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
  });
  const before = failing.current();
  check("it starts on the bundled snapshot", before.source === "bundled" && before.quotes.length === 1, before.source);
  const after = await failing.refresh();
  check("a failed refresh keeps the previous table", after.quotes.length === 1, String(after.quotes.length));
  check("...and records WHY, not just that", (after.lastError ?? "").includes("ECONNREFUSED"), String(after.lastError));
  check("...and does not claim to be live", after.source === "bundled", after.source);

  // 🔴 A 200 carrying nothing is not a success. Replacing a good table with zero quotes and
  // reporting "live" is the worst outcome, because it looks healthy.
  const empty = new TradePriceStore({
    dataDir: ".", stateDir: freshDir(), url: "http://stub/",
    bundled: () => ({ x: { name: "Bundled Thing", prices: [{ terminal: "T", buy: 5, sell: 9 }] } }),
    places: () => new Map(), fetchImpl: remote([], TERMS),
  });
  const e = await empty.refresh();
  check("an empty 200 does not replace a good table", e.quotes.length === 1, String(e.quotes.length));
  check("...and says so", (e.lastError ?? "").includes("empty"), String(e.lastError));
}

// ── The journal: what you actually did ──────────────────────────────────────
//
// Driven by Sub's REAL round trip: two buys of Processed Food at the Area 18 TDD (one auto-loaded,
// one to the freight elevator) and one sale of 1 SCU at the far end. The partial fill is not an
// edge case here — it is literally what happened.

import { TradeJournal } from "./trade-journal.js";

const NAMES: Record<string, string> = { "accacd33-3a1a-4ec7-8b4a-14b9f028047c": "Processed Food" };
const nameOf = (g: string): string | null => NAMES[g.toLowerCase()] ?? null;
/** Parse a known-good fixture. Throws rather than returning undefined, so a broken fixture fails
 *  loudly here instead of silently making every journal assertion vacuous. */
const buyOf = (line: string): CommodityPurchase => {
  const p = parseTradeLine(line)?.purchase;
  if (!p) throw new Error("fixture did not parse as a purchase: " + line.slice(0, 60));
  return p;
};

console.log("\n-- the journal --");
{
  const j = new TradeJournal(freshDir(), nameOf);
  j.apply(buyOf(BUY_AUTOLOAD));   // 1 SCU @ 1201.95, 17:43:31
  j.apply(buyOf(BUY_ELEVATOR));   // 1 SCU @ 1201.95, 17:43:47
  j.apply(buyOf(SELL_REAL));      // sells 1 SCU @ 1506, 18:40:48
  const v = j.view(new Date("2026-08-19T19:00:00Z"));

  check("the sale closed exactly one run", v.runs.length === 1, String(v.runs.length));
  check("...of 1 SCU, not the whole 2", v.runs[0]?.scu === 1, String(v.runs[0]?.scu));
  // 🔑 The number Sub wanted to see.
  check("...with the real profit on it", Math.round(v.runs[0]?.profit ?? 0) === 304, String(v.runs[0]?.profit));
  check("...and the margin", Math.round(v.runs[0]?.marginPct ?? 0) === 25, String(v.runs[0]?.marginPct));
  check("...naming both ends", v.runs[0]?.buyShop === "TDD_SCShop-001" && v.runs[0]?.sellShop === "SCShop_Admin_lt_base_g",
    `${v.runs[0]?.buyShop} -> ${v.runs[0]?.sellShop}`);
  check("...and the commodity", v.runs[0]?.commodity === "Processed Food", String(v.runs[0]?.commodity));
  // 17:43:31 -> 18:40:48 is 57.28 minutes.
  check("elapsed time is the real span", Math.round(v.runs[0]?.minutes ?? 0) === 57, String(v.runs[0]?.minutes));
  check("...and a rate falls out of it", Math.round(v.runs[0]?.profitPerHour ?? 0) === 318, String(v.runs[0]?.profitPerHour));

  // 🔴 The remainder is still aboard. Losing it would under-report what the player is holding.
  check("the unsold SCU stays an open position", v.open.length === 1 && v.open[0].scu === 1,
    JSON.stringify(v.open.map((o) => o.scu)));
  check("nothing became an unpriced sale", v.unmatched.length === 0, String(v.unmatched.length));
  check("today's totals count the run", v.today.runs === 1 && Math.round(v.today.profit) === 304,
    JSON.stringify(v.today));
}

console.log("\n-- the journal: a sale we cannot price --");
{
  const j = new TradeJournal(freshDir(), nameOf);
  j.apply(buyOf(SELL_REAL));      // sold, but no purchase was ever seen
  const v = j.view(new Date("2026-08-19T19:00:00Z"));
  // 🔴 THE RULE. Revenue is a fact; profit without a cost basis is fiction.
  check("an unmatched sale is recorded", v.unmatched.length === 1, String(v.unmatched.length));
  check("...as revenue", Math.round(v.unmatched[0]?.revenue ?? 0) === 1506, String(v.unmatched[0]?.revenue));
  check("...and NOT as a closed run", v.runs.length === 0, String(v.runs.length));
  check("...so profit stays zero", v.today.profit === 0, String(v.today.profit));
  check("...but the revenue is still surfaced, not swallowed", Math.round(v.today.unpricedRevenue) === 1506,
    String(v.today.unpricedRevenue));
  check("...and counted", v.today.unpricedSales === 1, String(v.today.unpricedSales));
}

console.log("\n-- the journal: FIFO across lots at different prices --");
{
  const j = new TradeJournal(freshDir(), nameOf);
  const cheap = BUY_AUTOLOAD;                                        // 1 SCU @ 1201.95
  const dear = BUY_AUTOLOAD.replace("shopPricePerCentiSCU[12.019500]", "shopPricePerCentiSCU[20.000000]")
    .replace("17:43:31", "17:44:31");                                // 1 SCU @ 2000
  const sellBoth = SELL_REAL.replace("quantity[1]", "quantity[2]");  // 2 containers of 1 SCU
  j.apply(buyOf(cheap)); j.apply(buyOf(dear)); j.apply(buyOf(sellBoth));
  const v = j.view(new Date("2026-08-19T19:00:00Z"));
  check("two lots close as two runs", v.runs.length === 2, String(v.runs.length));
  // 🔑 FIFO, not average cost: the oldest lot is consumed first and the two runs keep their own
  // buy prices. Averaging would smear a good buy into a bad one.
  const byTime = [...v.runs].sort((a, b) => Date.parse(a.boughtAt) - Date.parse(b.boughtAt));
  check("the OLDEST lot went first", Math.round(byTime[0].buyPricePerScu) === 1202, String(byTime[0].buyPricePerScu));
  check("...and the dearer one second", Math.round(byTime[1].buyPricePerScu) === 2000, String(byTime[1].buyPricePerScu));
  check("their profits differ, because their costs did",
    Math.round(byTime[0].profit) !== Math.round(byTime[1].profit),
    `${byTime[0].profit} vs ${byTime[1].profit}`);
  check("nothing is left open", v.open.length === 0, String(v.open.length));
  check("totals add both runs", Math.round(v.today.profit) === Math.round(byTime[0].profit + byTime[1].profit),
    String(v.today.profit));
}

console.log("\n-- the journal: selling PART of a bigger lot --");
{
  // 🔑 WHY THIS BLOCK EXISTS. Every other journal fixture uses 1 SCU lots, so `min(lot, remaining)`
  // and `lot` give the same answer and no assertion over them can tell a partial take from a
  // whole-lot take — the negative control proved it by staying green. This buys FOUR and sells one.
  const TUNGSTEN = "60f116f4-c02a-45b2-9ded-333747795124";
  const sellOne = SELL_REAL.replace("accacd33-3a1a-4ec7-8b4a-14b9f028047c", TUNGSTEN);
  const j = new TradeJournal(freshDir(), () => "Tungsten");
  j.apply(buyOf(BUY_SHUBIN));   // 4 SCU @ 8265
  j.apply(buyOf(sellOne));      // sells 1 SCU @ 1506
  const v = j.view(new Date("2026-08-19T19:00:00Z"));
  check("one SCU closed", v.runs.length === 1 && v.runs[0].scu === 1, JSON.stringify(v.runs.map((r) => r.scu)));
  // 🔴 The remainder must SURVIVE at its own price. Consuming the whole lot would silently book a
  // 4 SCU loss and leave the player holding cargo the app says they sold.
  check("three SCU stay open", v.open.length === 1 && v.open[0].scu === 3, JSON.stringify(v.open.map((o) => o.scu)));
  check("...at the price they were bought for", Math.round(v.open[0].pricePerScu) === 8265, String(v.open[0].pricePerScu));
  check("the closed run costs ONE SCU, not four", Math.round(v.runs[0].cost) === 8265, String(v.runs[0].cost));
}

console.log("\n-- the journal: a buy and sell in the same instant --");
{
  // A rate over zero elapsed minutes is not a rate. Without a fixture where the two timestamps
  // match, nothing can distinguish `null` from `Infinity`.
  const j = new TradeJournal(freshDir(), nameOf);
  j.apply(buyOf(BUY_AUTOLOAD));
  j.apply(buyOf(SELL_REAL.replace("18:40:48.440", "17:43:31.000")));
  const v = j.view(new Date("2026-08-19T19:00:00Z"));
  check("the run is still recorded", v.runs.length === 1, String(v.runs.length));
  check("elapsed is zero", v.runs[0].minutes === 0, String(v.runs[0].minutes));
  check("...and the rate is null, not Infinity", v.runs[0].profitPerHour === null, String(v.runs[0].profitPerHour));
  check("...and the totals do not carry an Infinity either",
    v.today.profitPerHour === null || Number.isFinite(v.today.profitPerHour), String(v.today.profitPerHour));
}

console.log("\n-- the journal: replaying the same log twice must not double-count --");
{
  const j = new TradeJournal(freshDir(), nameOf);
  // 🔴 The sidecar reads the current log AND replays the newest rotated one at startup, and a
  // player restarts the app freely. Without a seen-key this books the same sale every time.
  for (let i = 0; i < 3; i++) { j.apply(buyOf(BUY_AUTOLOAD)); j.apply(buyOf(SELL_REAL)); }
  const v = j.view(new Date("2026-08-19T19:00:00Z"));
  check("one run, not three", v.runs.length === 1, String(v.runs.length));
  check("...and the profit is not tripled", Math.round(v.today.profit) === 304, String(v.today.profit));
  check("...and it IS recorded, rather than everything being dropped", v.runs.length > 0);
  // The two buys differ only by autoLoading, and must still be two distinct lots.
  const k = new TradeJournal(freshDir(), nameOf);
  k.apply(buyOf(BUY_AUTOLOAD)); k.apply(buyOf(BUY_ELEVATOR));
  check("two genuinely different buys are both kept", k.view().open.length === 2,
    String(k.view().open.length));
}

console.log("\n-- the journal: writing off cargo that is never coming back --");
{
  // Sub's exact situation, minus the wall: two lots held, one of them destroyed. He flew a loaded
  // ship into a wall on purpose and the loot has been listed ever since.
  const dir = freshDir();
  const j = new TradeJournal(dir, nameOf);
  j.apply(buyOf(BUY_AUTOLOAD));
  j.apply(buyOf(BUY_ELEVATOR));

  // 🔑 POSITIVE FIRST. Every assertion below is about something leaving a list, and a list that was
  // empty to begin with satisfies all of them for free.
  const before = j.view();
  check("two lots are held before anything is written off", before.open.length === 2, String(before.open.length));
  check("...and each one has an id to remove it BY", before.open.every((o) => !!o.id),
    JSON.stringify(before.open.map((o) => o.id)));
  check("...that are distinct", new Set(before.open.map((o) => o.id)).size === 2,
    JSON.stringify(before.open.map((o) => o.id)));

  const target = before.open.find((o) => o.autoLoaded === false);
  const gone = j.forget(target!.id, new Date("2026-08-22T22:00:00Z"));
  check("forgetting a held lot reports what it removed", gone?.id === target!.id, String(gone?.id));
  check("...with the cost it really carried", Math.round(gone?.cost ?? 0) === 1202, String(gone?.cost));

  const after = j.view(new Date("2026-08-22T23:00:00Z"));
  check("the lot leaves the held list", after.open.length === 1, String(after.open.length));
  check("...and it is the RIGHT one that left",
    after.open[0]?.id !== target!.id && after.open[0]?.autoLoaded === true,
    JSON.stringify(after.open.map((o) => [o.id, o.autoLoaded])));
  check("...landing on the written-off record rather than vanishing",
    after.writtenOff.length === 1 && after.writtenOff[0]?.id === target!.id,
    JSON.stringify(after.writtenOff.map((w) => w.id)));

  // 🔴 THE RULE THIS FEATURE MUST NOT BREAK. The money left the account, so the cost stays on the
  // record — and it must never reach a profit total, in either direction. Asserting "profit is 0"
  // alone would pass on a build that folded the loss in and happened to net to zero, so the
  // unpriced-revenue and run counts are checked beside it.
  check("a write-off never becomes profit or loss", after.allTime.profit === 0, String(after.allTime.profit));
  check("...nor a closed run", after.allTime.runs === 0, String(after.allTime.runs));
  check("...nor unpriced revenue", after.allTime.unpricedRevenue === 0, String(after.allTime.unpricedRevenue));

  // Two clicks on the same row must not book the loss twice — the widget re-reads after each one,
  // so a stale row is ordinary rather than an error.
  check("forgetting the same lot twice is a no-op", j.forget(target!.id) === null, "second call");
  check("...leaving exactly one write-off", j.view().writtenOff.length === 1, String(j.view().writtenOff.length));
  check("an unknown id removes nothing", j.forget("lot-that-never-was") === null, "unknown id");

  // It has to survive the app being restarted, which is the whole point of a persisted journal.
  const reopened = new TradeJournal(dir, nameOf).view();
  check("the write-off survives a restart", reopened.writtenOff.length === 1, String(reopened.writtenOff.length));
  check("...and the lot does not come back", reopened.open.length === 1, String(reopened.open.length));
}

import { writeFileSync } from "node:fs";

console.log("\n-- the journal: an older file is READ FORWARD, never wiped --");
{
  // 🔴 THE TRAP THIS PINS. `read()` returns an empty journal on a version mismatch, so bumping
  // STATE_VERSION to add `id`/`writtenOff` would have DESTROYED the record of every player who
  // already had one. This is Sub's own file shape, verbatim: v:1, lots with no `id`, no
  // `writtenOff`, no `nextLotId`, and one real closed run he would not have got back.
  const dir = freshDir();
  const legacy = {
    v: 1,
    open: [
      { resourceGuid: "accacd33-3a1a-4ec7-8b4a-14b9f028047c", commodity: "Processed Food", scu: 1,
        pricePerScu: 1201.95, shopName: "TDD_SCShop-001", at: "2026-08-19T17:43:47.243Z",
        atMs: 1787161427243, autoLoaded: false },
      { resourceGuid: "60f116f4-c02a-45b2-9ded-333747795124", commodity: "Tungsten", scu: 4,
        pricePerScu: 8265.0002, shopName: "SCShop_ht_delta_shubin_m_store", at: "2026-08-19T17:23:33.458Z",
        atMs: 1787160213458, autoLoaded: false },
    ],
    runs: [{ commodity: "Processed Food", resourceGuid: "accacd33-3a1a-4ec7-8b4a-14b9f028047c", scu: 1,
      buyPricePerScu: 1201.95, sellPricePerScu: 1506, cost: 1201.95, revenue: 1506, profit: 304.05,
      marginPct: 25.3, buyShop: "TDD_SCShop-001", sellShop: "SCShop_Admin_lt_base_g",
      boughtAt: "2026-08-19T17:43:31.000Z", soldAt: "2026-08-19T18:40:48.440Z", minutes: 57.29,
      profitPerHour: 318.43 }],
    unmatched: [],
    seen: ["2026-08-19T17:43:31.000Z|buy|TDD_SCShop-001|accacd33-3a1a-4ec7-8b4a-14b9f028047c|1|1202"],
  };
  writeFileSync(pjoin(dir, "trade-journal.json"), JSON.stringify(legacy));

  const v = new TradeJournal(dir, nameOf).view();
  check("an id-less file keeps its lots", v.open.length === 2, String(v.open.length));
  check("...keeps the closed run and its profit", v.runs.length === 1 && Math.round(v.runs[0].profit) === 304,
    JSON.stringify(v.runs.map((r) => r.profit)));
  check("...and every lot is given an id it did not have", v.open.every((o) => !!o.id),
    JSON.stringify(v.open.map((o) => o.id)));
  check("...distinct ones, or the ✕ would remove the wrong row",
    new Set(v.open.map((o) => o.id)).size === 2, JSON.stringify(v.open.map((o) => o.id)));
  check("...and writtenOff defaults to a list rather than undefined",
    Array.isArray(v.writtenOff) && v.writtenOff.length === 0, JSON.stringify(v.writtenOff));

  // The backfilled ids have to be usable, not just present: an id assigned on read but never
  // persisted would work once and then name nothing after a restart.
  const j2 = new TradeJournal(dir, nameOf);
  const id = j2.view().open[0].id;
  check("a backfilled id can actually be removed by", j2.forget(id) !== null, id);
  const j3 = new TradeJournal(dir, nameOf).view();
  check("...and stays removed across a restart", j3.open.length === 1 && j3.writtenOff.length === 1,
    `${j3.open.length}/${j3.writtenOff.length}`);
}

cleanupTmp();
console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
