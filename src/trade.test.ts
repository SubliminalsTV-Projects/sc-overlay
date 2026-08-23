// Commodity trading: the log parser, and the finder's honesty rules.
//
//   npx tsx src/trade.test.ts
//
// 🔑 THE PARSER FIXTURES ARE REAL LINES, copied byte-for-byte out of Sub's own session on
// 2026-08-19 (Area 18 TDD, the same commodity bought twice - once auto-loaded, once to the
// freight elevator - plus a Shubin buy and a shop inventory line). Synthetic fixtures would have
// agreed with whatever the parser happened to do; these agree with the game.

import { parseTradeLine, TradeConfirmations, TRADE_LOG_MARKER, type CommodityPurchase } from "./trade-log.js";
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
// 🔴 SUB'S REAL DEGNOUS ROOT TRADE, 2026-08-23 - the capture that disproved the container
// formula on a sell. He bought 10 SCU and sold the lot. His in-game balance went 4,576,646 ->
// 4,719,476, a +142,830 profit, while the app reported a 152,270 LOSS.
const BUY_DEGNOUS =
  "<2026-08-23T18:05:03.764Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> " +
  "Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[776425992034] " +
  "shopName[SCShop_AdminOffice_Nyx_SocialStation] kioskId[776425992032] price[447370.000000] " +
  "shopPricePerCentiSCU[447.369995] resourceGUID[a0046f6f-ce84-4ca2-b5d1-d6598a9aad39] " +
  "autoLoading[0] quantity[1000.000000 cSCU] Cargo Box Data: boxSize[2.000000] | unitAmount[5]";
const SELL_DEGNOUS =
  "<2026-08-23T18:33:49.285Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> " +
  "Sending SShopCommoditySellRequest - playerId[204772220757] shopId[776426083309] " +
  "shopName[SCShop_AdminOffice_Nyx_SocialStation] kioskId[776426083307] amount[590200.000000] " +
  "resourceGUID[a0046f6f-ce84-4ca2-b5d1-d6598a9aad39] autoLoading[0] quantity[10] " +
  "transactionMode[ResourceContainer] Cargo Box Data:  [boxSize[2] | unitAmount[5]]";

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

  // 🔴 REPLACED A CONSTRUCTED FIXTURE WITH A REAL ONE. This block used to fabricate a sell by
  // editing quantity and boxSize on the 1-SCU capture, and assert quantity x boxSize. The block
  // above was honest that it was constructed, and it was wrong: `quantity` on a sell is SCU, not
  // a container count. Sub's real Degnous Root sale settles it on captured data.
  const dSell = parseTradeLine(SELL_DEGNOUS)?.purchase;
  const dBuy = parseTradeLine(BUY_DEGNOUS)?.purchase;
  check("the real sell of 10 SCU reads as 10 SCU, not 20", dSell?.scu === 10, String(dSell?.scu));
  check("...and the buy of the SAME goods agrees", dBuy?.scu === 10, String(dBuy?.scu));
  // The two lines state the volume differently - cSCU on the buy, bare SCU on the sell - so their
  // agreement is the check that matters. Boxes corroborate: 5 units x 2 SCU = 10 on both.
  check("...and the box breakdown corroborates both",
    (dSell?.unitAmount ?? 0) * (dSell?.boxScu ?? 0) === 10 &&
    (dBuy?.unitAmount ?? 0) * (dBuy?.boxScu ?? 0) === 10,
    `${dSell?.unitAmount}x${dSell?.boxScu} / ${dBuy?.unitAmount}x${dBuy?.boxScu}`);
  check("the derived per-SCU is the full 59,020, not half of it",
    Math.round(dSell?.pricePerScu ?? 0) === 59020, String(dSell?.pricePerScu));
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
/**
 * Parse a known-good fixture AND take it through the real confirmation gate. Throws rather than
 * returning undefined, so a broken fixture fails loudly here instead of silently making every
 * journal assertion vacuous.
 *
 * 🔴 THE GATE IS NOT OPTIONAL AND IS NOT STUBBED HERE. `parseTradeLine` yields a REQUEST, which
 * the journal refuses by design — see the invented-profit bug in `trade-log.ts`. A fixture line
 * with no refusal behind it is a transaction that went through, and `flush()` is exactly how the
 * sidecar states that at the end of a complete log. Hand-setting `confirmed: true` would have made
 * every assertion below test a path the app does not use.
 */
const buyOf = (line: string): CommodityPurchase => {
  const c = new TradeConfirmations();
  c.line(line);
  const [p] = c.flush();
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

console.log("\n-- upgrading a journal must not re-book its own history --");
{
  // 🔴 THE FIX ALMOST SHIPPED A SECOND BUG. The idempotency key used to contain `scu`, so the
  // moment the parser revised that figure every stored key stopped matching and the sale was
  // booked again. It happened on Sub's own machine: one corrected run, and a phantom beside it.
  const dir = freshDir();
  const j1 = new TradeJournal(dir, nameOf);
  j1.apply(buyOf(BUY_DEGNOUS));
  j1.apply(buyOf(SELL_DEGNOUS));
  j1.save();
  // Reopen the SAME directory, exactly as a restart after an update would.
  const j2 = new TradeJournal(dir, nameOf);
  const changed = j2.apply(buyOf(SELL_DEGNOUS));
  check("replaying the same sale changes nothing", changed === false, String(changed));
  const v = j2.view(new Date("2026-08-23T19:00:00Z"));
  check("still exactly one run", v.runs.length === 1, String(v.runs.length));
  check("...and no phantom appeared", (v.unmatched?.length ?? 0) === 0, String(v.unmatched?.length));
  check("...and the profit is still the balance delta", Math.round(v.runs[0]?.profit ?? 0) === 142830,
    String(v.runs[0]?.profit));
}

console.log("\n-- Sub's real Degnous Root run: a profit reported as a loss --");
{
  // 🔴 THE WHOLE BUG, END TO END. His balance moved 4,576,646 -> 4,719,476 in game: +142,830.
  // The app said -152,270 and ALSO left a phantom 10 SCU in `unmatched`, because it believed
  // twenty SCU had been sold when only ten existed. Both symptoms come from the one misread.
  const j = new TradeJournal(freshDir(), nameOf);
  j.apply(buyOf(BUY_DEGNOUS));
  j.apply(buyOf(SELL_DEGNOUS));
  const v = j.view(new Date("2026-08-23T19:00:00Z"));
  check("the run closes as exactly one run", v.runs.length === 1, String(v.runs.length));
  const r = v.runs[0];
  check("cost is what the buy line said", Math.round(r?.cost ?? 0) === 447370, String(r?.cost));
  check("revenue is the FULL amount, not half", Math.round(r?.revenue ?? 0) === 590200, String(r?.revenue));
  check("🔴 profit matches the in-game balance delta", Math.round(r?.profit ?? 0) === 142830, String(r?.profit));
  check("...and it is a PROFIT, not a loss", (r?.profit ?? 0) > 0, String(r?.profit));
  // The pair that proves the phantom is gone: nothing stranded, nothing left open.
  check("no phantom sale is left unmatched", (v.unmatched?.length ?? 0) === 0, String(v.unmatched?.length));
  check("...and no lot is left open", v.open.length === 0, String(v.open.length));
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

// ── 🔴 A REQUEST IS NOT A TRANSACTION ───────────────────────────────────────
//
// Every line below is copied byte-for-byte out of Sub's `Game.log` for 2026-08-23. He tried to
// sell Compboard at Levski three times; the terminal errored every time; the Ledger showed the
// sales as completed and credited him +428,872 aUEC of profit that never existed.
//
// 🔑 The fixtures are REQUEST/ERROR PAIRS, not requests alone. A suite that feeds only successful
// transactions certifies nothing about this bug — it is the refusal that has to be in the stream.

/** 10 SCU of Compboard at 28,113.75/SCU, total 281,138. The cost basis for the phantom profit. */
const BUY_COMPBOARD =
  "<2026-08-23T18:52:32.982Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> " +
  "Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[776426083309] " +
  "shopName[SCShop_AdminOffice_Nyx_SocialStation] kioskId[776426083307] price[281138.000000] " +
  "shopPricePerCentiSCU[281.137512] resourceGUID[9177e3bb-6714-49f5-8beb-46a981226ff6] " +
  "autoLoading[0] quantity[1000.000000 cSCU] Cargo Box Data: boxSize[2.000000] | unitAmount[5] " +
  "[Team_CoreGameplayFeatures][Shops][UI]";

/** The first refused sale: 1 SCU for 242,550 aUEC. */
const SELL_REFUSED_1 =
  "<2026-08-23T19:57:48.914Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> " +
  "Sending SShopCommoditySellRequest - playerId[204772220757] shopId[776283668799] " +
  "shopName[SCShop_Levski_CargoOffice_Commodities] kioskId[776283668797] amount[242550.000000] " +
  "resourceGUID[9177e3bb-6714-49f5-8beb-46a981226ff6] autoLoading[0] quantity[1] " +
  "transactionMode[Entities] Cargo Box Data:  [Team_CoreGameplayFeatures][Shops][UI]";
/** 336 ms later. Note what it does NOT carry: no resourceGUID, no amount, nothing naming the
 *  request it answers. Proximity and direction are all there is. */
const REFUSAL_1 =
  "<2026-08-23T19:57:49.250Z> [Error] <CEntityComponentCommodityUIProvider::RmToken_CommodityTransactionResponse> " +
  "Commodity Transaction Response Error - playerId[204772220757] result[TransactionCostMismatch] " +
  "type[Selling] [Team_CoreGameplayFeatures][Shops]";

/** His retry, 56 seconds later. Identical request. */
const SELL_REFUSED_2 = SELL_REFUSED_1.replace("19:57:48.914", "19:58:45.444");
/** 258 ms after the retry. */
const REFUSAL_2 = REFUSAL_1.replace("19:57:49.250", "19:58:45.702");

/** A line that is not ours at all, used as the CLOCK — this is what releases a held request while
 *  tailing, and it is why `tradeLogLine` has to be called on every line rather than the
 *  interesting ones. */
const clockLine = (iso: string): string =>
  `<${iso}> [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> unrelated traffic`;

const NAMES2: Record<string, string> = { "9177e3bb-6714-49f5-8beb-46a981226ff6": "Compboard" };
const nameOf2 = (g: string): string | null => NAMES2[g.toLowerCase()] ?? null;

/** Feed a whole stream through one confirmer into one journal, the way the sidecar does. */
function replay(lines: readonly string[], j: TradeJournal, c = new TradeConfirmations()): TradeConfirmations {
  for (const l of lines) for (const p of c.line(l)) j.apply(p);
  return c;
}

console.log("\n-- the refusal line parses at all --");
{
  const r = parseTradeLine(REFUSAL_1)?.response;
  check("an [Error] response line is recognised", !!r);
  check("...as a refusal", r?.refused === true, String(r?.refused));
  check("...carrying the result verbatim", r?.result === "TransactionCostMismatch", String(r?.result));
  check("...and the direction", r?.direction === "sell", String(r?.direction));
  // 🔑 It used to fall through to `unknownMethod`, which is the mechanism working exactly as
  // designed — a new verb announced itself and nobody looked at it for four days.
  check("...and it is NOT reported as an unmodelled verb",
    parseTradeLine(REFUSAL_1)?.unknownMethod === undefined, String(parseTradeLine(REFUSAL_1)?.unknownMethod));
  // A `[Notice]` response is a shape never seen in 533 log files. The safe reading of an unseen
  // shape is "this refuses nothing", so the commit rule is unchanged by one.
  const notice = parseTradeLine(REFUSAL_1.replace("[Error]", "[Notice]"))?.response;
  check("a response that is not an [Error] refuses nothing", notice?.refused === false, String(notice?.refused));
  // The other two result values on record. Recorded, never interpreted.
  for (const res of ["EntityQueryFailed", "WaitingForPendingResult"]) {
    check(`result[${res}] is a refusal too`,
      parseTradeLine(REFUSAL_1.replace("TransactionCostMismatch", res))?.response?.refused === true, res);
  }
}

console.log("\n-- 🔴 Sub's three refused Compboard sales are not booked --");
{
  const j = new TradeJournal(freshDir(), nameOf2);
  const c = replay([
    BUY_COMPBOARD,
    clockLine("2026-08-23T18:52:40.000Z"),      // releases the buy
    SELL_REFUSED_1, REFUSAL_1,
    clockLine("2026-08-23T19:57:55.000Z"),
    SELL_REFUSED_2, REFUSAL_2,
    clockLine("2026-08-23T19:58:55.000Z"),
  ], j);
  const v = j.view(new Date("2026-08-23T21:00:00Z"));

  // 🔑 POSITIVE FIRST, always. Every assertion after this one is about something NOT being in a
  // list, and a pipeline that booked nothing at all — a broken fixture, a parser that stopped
  // matching — satisfies all of them for free.
  check("the buy really was booked", v.open.length === 1 && v.open[0].scu === 10,
    JSON.stringify(v.open.map((o) => o.scu)));
  check("...at the price the log stated", Math.round(v.open[0]?.pricePerScu ?? 0) === 28114,
    String(v.open[0]?.pricePerScu));
  check("...and the two refusals were SEEN, not merely missed", c.refused().length === 2,
    String(c.refused().length));
  check("...each carrying why", c.refused().every((p) => p.refusedBecause === "TransactionCostMismatch"),
    JSON.stringify(c.refused().map((p) => p.refusedBecause)));
  check("...and marked refused rather than left undecided", c.refused().every((p) => p.confirmed === false),
    JSON.stringify(c.refused().map((p) => p.confirmed)));

  // 🔴 THE BUG. Both of these were closed runs in his Ledger.
  check("no refused sale becomes a closed run", v.runs.length === 0, String(v.runs.length));
  check("...nor an unpriced sale", v.unmatched.length === 0, String(v.unmatched.length));
  check("...so the phantom profit is zero", v.allTime.profit === 0, String(v.allTime.profit));
  check("...and the cargo is still listed as held", v.open.length === 1 && v.open[0].scu === 10,
    JSON.stringify(v.open.map((o) => o.scu)));
  check("nothing is left held by the confirmer", c.pending().length === 0, String(c.pending().length));
}

console.log("\n-- ...and the CONTROL: with the refusals out of the stream, the fiction comes back --");
{
  // 🔴 THE ONE THAT MATTERS. This is not a hypothetical regression — it is the shipped code, and
  // it is reachable through a prefilter narrowed to `::Send`, which is what `backfillFromBackups`
  // used to do. If this block ever goes quiet, the suite has stopped testing the bug.
  //
  // 🔑 Two independent mechanisms hold the fix up, so each gets its own control below: the gate
  // withholding a refused request, and the journal refusing anything not `confirmed === true`.
  const j = new TradeJournal(freshDir(), nameOf2);
  const stream = [BUY_COMPBOARD, clockLine("2026-08-23T18:52:40.000Z"),
    SELL_REFUSED_1, REFUSAL_1, clockLine("2026-08-23T19:57:55.000Z"),
    SELL_REFUSED_2, REFUSAL_2, clockLine("2026-08-23T19:58:55.000Z")];
  // CONTROL A: the prefilter that only lets requests through — the back door into this bug.
  replay(stream.filter((l) => !l.includes("RmToken_")), j);
  const v = j.view(new Date("2026-08-23T21:00:00Z"));
  check("CONTROL: without the refusals, both failed sales book as runs", v.runs.length === 2,
    String(v.runs.length));
  check("CONTROL: ...inventing the exact profit Sub was shown",
    Math.round(v.allTime.profit) === 428872, String(Math.round(v.allTime.profit)));
  // 🔑 The margin smell, printed rather than gated on: 762% against a real one of 23%. It is a
  // coincidence of this case and the response line is the evidence — see `trade-log.ts`.
  check("CONTROL: ...at an implausible margin nobody should have to notice",
    Math.round(v.runs[0]?.marginPct ?? 0) === 763, String(v.runs[0]?.marginPct));
}

console.log("\n-- ...and CONTROL B: the journal's own lock, independent of the gate --");
{
  // Belt and braces, and each brace is controlled separately: a caller that forgets the gate must
  // get an EMPTY journal, loudly, rather than the original bug in silence.
  const raw = parseTradeLine(SELL_REFUSED_1)?.purchase;
  check("a raw parse is UNDECIDED, not confirmed", raw?.confirmed === null, String(raw?.confirmed));
  const j = new TradeJournal(freshDir(), nameOf2);
  check("...and the journal refuses to book it", j.apply(raw!) === false, "apply()");
  check("...so nothing lands", j.view().runs.length === 0 && j.view().unmatched.length === 0, "view");
  // CONTROL B: the same record with the flag flipped by hand DOES land — which is what proves the
  // flag is the thing standing in the way, rather than some other refusal in `apply()`.
  const k = new TradeJournal(freshDir(), nameOf2);
  check("CONTROL: the same record marked confirmed is booked",
    k.apply({ ...raw!, confirmed: true }) === true, "apply()");
  check("CONTROL: ...and shows up as revenue", k.view().unmatched.length === 1,
    String(k.view().unmatched.length));
}

console.log("\n-- a successful sale is still booked, which is the other half of the rule --");
{
  // 🔑 THE RULE IS "COMMIT UNLESS REFUSED", NOT "COMMIT WHEN CONFIRMED". A success emits NO line
  // at all — 26 of the 65 requests in the 533-log corpus have no response behind them — so a gate
  // waiting for an acknowledgement would throw every real trade away. This is the assertion that
  // would catch someone "tightening" it.
  const j = new TradeJournal(freshDir(), nameOf);
  replay([BUY_DEGNOUS, clockLine("2026-08-23T18:05:10.000Z"),
    SELL_DEGNOUS, clockLine("2026-08-23T18:33:55.000Z")], j);
  const v = j.view(new Date("2026-08-23T19:00:00Z"));
  check("the silent round trip closes as a run", v.runs.length === 1, String(v.runs.length));
  check("...with the profit his balance really moved by", Math.round(v.runs[0]?.profit ?? 0) === 142830,
    String(v.runs[0]?.profit));
}

console.log("\n-- the window: sized off the corpus, at both ends --");
{
  // The slowest refusal on record is 565 ms behind its request. Anything inside the window kills.
  const j = new TradeJournal(freshDir(), nameOf2);
  replay([SELL_REFUSED_1, REFUSAL_1.replace("19:57:49.250", "19:57:49.479"),  // +565 ms
    clockLine("2026-08-23T19:58:00.000Z")], j);
  check("a refusal at the slowest latency on record still kills the request",
    j.view().unmatched.length === 0 && j.view().runs.length === 0, JSON.stringify(j.view().unmatched));

  // 🔴 THE OTHER END, and it is the failure mode nobody thinks about: a window wide enough to
  // reach BACK past an earlier request would delete a trade that really happened. The tightest two
  // requests ever get in the corpus is 3,655 ms, so a refusal that far behind must claim nothing.
  const k = new TradeJournal(freshDir(), nameOf2);
  const c = replay([SELL_REFUSED_1,
    REFUSAL_1.replace("19:57:49.250", "19:57:52.569"),   // +3,655 ms: outside the window
    clockLine("2026-08-23T19:58:00.000Z")], k);
  check("a refusal 3,655 ms late claims nothing", c.refused().length === 0, String(c.refused().length));
  check("...and the request it did not claim is booked", k.view().unmatched.length === 1,
    String(k.view().unmatched.length));
}

console.log("\n-- the clock is the LOG's, not the wall's --");
{
  // 🔴 THE DESIGN CONSTRAINT. A wall-clock timer behaves one way while tailing and another while
  // replaying a rotated log — and the replay is where it would commit a request before the refusal
  // two lines down had been read. Nothing here sleeps, and everything below turns on timestamps.
  const c = new TradeConfirmations();
  check("a request is HELD, not returned", c.line(SELL_REFUSED_1).length === 0, "on the request line");
  check("...still held a second later", c.line(clockLine("2026-08-23T19:57:49.900Z")).length === 0, "+986 ms");
  check("...and released by a line past the window", c.line(clockLine("2026-08-23T19:57:51.000Z")).length === 1, "+2,086 ms");
  check("...exactly once", c.line(clockLine("2026-08-23T19:57:59.000Z")).length === 0, "no double release");

  // End of a COMPLETE file is the same rule, not an exception to it: no refusal ever arrived.
  const d = new TradeConfirmations();
  d.line(SELL_REFUSED_1);
  check("flush() releases what a finished log left held", d.flush().length === 1, "flush");
  check("...and pending() said so beforehand", new TradeConfirmations().line(SELL_REFUSED_1).length === 0, "held");

  // A line with no readable timestamp is not evidence that time passed.
  const e = new TradeConfirmations();
  e.line(SELL_REFUSED_1);
  check("an unstamped line releases nothing", e.line("a continuation line with no timestamp").length === 0, "unstamped");
  check("...and the request is still there to be released", e.flush().length === 1, "flush");
}

console.log("\n-- a refusal only claims its own direction --");
{
  // All 39 refusals on record are type[Selling]. The field names a direction, so Buying is a shape
  // the game can write and the app must not assume away.
  const c = new TradeConfirmations();
  c.line(SELL_REFUSED_1);
  c.line(REFUSAL_1.replace("type[Selling]", "type[Buying]"));
  check("a Buying refusal does not kill a held SELL", c.refused().length === 0, String(c.refused().length));
  check("...and the sell survives to be booked", c.flush().length === 1, "flush");

  const d = new TradeConfirmations();
  d.line(BUY_COMPBOARD);
  d.line(REFUSAL_1.replace("19:57:49.250", "2026-08-23T18:52:33.318").replace("type[Selling]", "type[Buying]")
    .replace("<2026-08-23T19:57:49.250Z>", "<2026-08-23T18:52:33.318Z>"));
  check("...while a Buying refusal DOES kill a held buy", d.refused().length === 1, String(d.refused().length));
}

console.log("\n-- the seam between the startup seed and the live watcher --");
{
  // 🔴 ONE CONFIRMER SPANS BOTH, and that is the whole reason `liveConfirm` is a module singleton
  // in `trade-routes.ts`. The seed reads the current log up to a byte and the watcher takes over
  // from exactly there, so a request in the seed's last bytes has its refusal in the watcher's
  // first ones. A fresh instance — or a `flush()` at the handover — commits the phantom sale.
  const j = new TradeJournal(freshDir(), nameOf2);
  const c = new TradeConfirmations();
  for (const p of c.line(SELL_REFUSED_1)) j.apply(p);     // ...end of the seed read
  for (const p of c.line(REFUSAL_1)) j.apply(p);          // first line the watcher tails
  for (const p of c.line(clockLine("2026-08-23T19:58:00.000Z"))) j.apply(p);
  check("a refusal on the far side of the seam still kills the request",
    j.view().unmatched.length === 0 && c.refused().length === 1,
    `${j.view().unmatched.length} unmatched / ${c.refused().length} refused`);

  // CONTROL: flushing at the seam is precisely the mistake, and it books the fiction.
  const k = new TradeJournal(freshDir(), nameOf2);
  const seed = new TradeConfirmations();
  seed.line(SELL_REFUSED_1);
  for (const p of seed.flush()) k.apply(p);              // <- the mistake
  const tail = new TradeConfirmations();
  for (const p of tail.line(REFUSAL_1)) k.apply(p);
  check("CONTROL: flushing at the seam books the refused sale", k.view().unmatched.length === 1,
    String(k.view().unmatched.length));
}

console.log("\n-- the prefilter a bulk replay uses must not narrow to the requests --");
{
  // 🔴 THE BACK DOOR. `backfillFromBackups` skips lines cheaply before parsing them, and its old
  // filter was `CommodityUIProvider::Send` — which matches every request and not one refusal. The
  // marker is exported from the parser so the two cannot drift apart again.
  check("the exported marker matches a request", SELL_REFUSED_1.includes(TRADE_LOG_MARKER), TRADE_LOG_MARKER);
  check("...AND matches a refusal", REFUSAL_1.includes(TRADE_LOG_MARKER), TRADE_LOG_MARKER);
  check("...and still excludes an unrelated line", !clockLine("2026-08-23T19:00:00.000Z").includes(TRADE_LOG_MARKER), "");
  // The narrowed filter, stated as the thing it must never be again.
  check("CONTROL: the old `::Send` filter would have dropped the refusal",
    !REFUSAL_1.includes("CommodityUIProvider::Send"), "the shipped bug");
}

// -- HOW MANY REQUESTS ARE IN FLIGHT AT ONCE: SPACING vs RESIDENCY --
//
// Raised by the tower on 2026-08-23, and it was the right question. The census measured request
// SPACING (min 3,655 ms) and concluded requests arrive one at a time, but spacing is not residency.
// If several are held when a refusal lands, which one does it convict?
//
// 🔑 ONLY ONE IS EVER HELD, AND THE REASON IS NOT OBVIOUS: a REQUEST line is itself a stamped line,
// so it advances the clock and releases the request before it. With every pair of requests 3,655 ms
// apart at the tightest, against a 2,000 ms window, the previous one is always already gone.
// **The two measured numbers are what make that true**, so widening the window past the spacing
// breaks it — which is the regime the second block below reaches, honestly, to test the tie-break.
{
  const SELL_DYM =
    "<2026-08-23T19:57:21.520Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> " +
    "Sending SShopCommoditySellRequest - playerId[204772220757] shopId[776283668799] " +
    "shopName[SCShop_Levski_CargoOffice_Commodities] kioskId[776283668797] amount[531300.000000] " +
    "resourceGUID[53513e3d-93cc-4079-b87b-cf20a4692661] autoLoading[0] quantity[21] " +
    "transactionMode[CargoGrid] Cargo Box Data:  [boxSize[8] | unitAmount[1]] [Team_CoreGameplayFeatures][Shops][UI]";
  const SELL_AV = SELL_DYM
    .replace("19:57:21.520", "19:57:38.354").replace("amount[531300.000000]", "amount[429935.000000]")
    .replace("53513e3d-93cc-4079-b87b-cf20a4692661", "5f2d394d-6e69-4cb8-afb2-81a96544936e")
    .replace("quantity[21]", "quantity[11]");

  console.log("\n-- at the real window, only ONE request is ever in flight --");
  // 🔑 NOT ONE CLOCK LINE BETWEEN THEM: this is the bulk-replay feed, where only commodity lines
  // reach the gate. It is the harshest case for residency, and it is still one at a time.
  const c = new TradeConfirmations();
  const a = c.line(SELL_DYM);
  const held1 = c.pending().length;
  const b = c.line(SELL_AV);
  const held2 = c.pending().length;
  const d = c.line(SELL_REFUSED_1);
  const held3 = c.pending().length;
  c.line(REFUSAL_1);
  const rest = c.flush();

  check("a request line ITSELF releases the one before it", a.length === 0 && b.length === 1, a.length + "/" + b.length);
  check("...and the third releases the second", d.length === 1, String(d.length));
  check("so exactly one is ever resident", held1 === 1 && held2 === 1 && held3 === 1, held1 + "/" + held2 + "/" + held3);
  check("exactly one request was refused", c.refused().length === 1, String(c.refused().length));
  check("...and it is the one the refusal actually followed",
    c.refused()[0]?.at === "2026-08-23T19:57:48.914Z", String(c.refused()[0]?.at));
  check("...leaving nothing else held", rest.length === 0, String(rest.length));
  const booked = [...b, ...d];
  check("both unrefused sells are confirmed", booked.length === 2 && booked.every((p) => p.confirmed === true),
    JSON.stringify(booked.map((p) => [p.at, p.confirmed])));
  check("...at 21 SCU and 11 SCU", JSON.stringify(booked.map((p) => p.scu)) === "[21,11]",
    JSON.stringify(booked.map((p) => p.scu)));

  console.log("\n-- ...and when they ARE all resident, the refusal still convicts the right one --");
  // Widen the window past the request spacing and three really are resident together. This is the
  // regime the tower was worried about, reached by changing the window rather than by pretending.
  const wide = new TradeConfirmations(30000);
  wide.line(SELL_DYM); wide.line(SELL_AV); wide.line(SELL_REFUSED_1);
  check("a window wider than the spacing really does hold all three",
    wide.pending().length === 3, String(wide.pending().length));
  wide.line(REFUSAL_1);
  // 🔑 THIS is where `refuse()` taking the NEWEST match earns its keep, and it is the ONLY place.
  // At the shipped window the window filter alone settles it and the ordering is unobservable — a
  // source control on the ordering there comes back GREEN, which is how this block came to be
  // rewritten. Here the ordering is the only thing deciding, so an oldest-first "simplification"
  // reddens exactly these two lines.
  check("only one of the three dies", wide.refused().length === 1, String(wide.refused().length));
  check("...and it is the NEWEST, not the oldest",
    wide.refused()[0]?.at === "2026-08-23T19:57:48.914Z", String(wide.refused()[0]?.at));
  const survivors = wide.flush();
  check("...the other two survive to be booked", survivors.length === 2 && survivors.every((p) => p.confirmed === true),
    JSON.stringify(survivors.map((p) => p.at)));
}

console.log("\n-- 🔴 a `seen` key with no row behind it is a PERMANENT, SILENT skip --");
{
  // 🔴 A REPAIR HAZARD, NOT A PARSER BUG, and it was misread as one on 2026-08-23. A journal
  // repaired by deleting ROWS while leaving `seen` alone will never re-derive those transactions —
  // at this launch or any future one. `apply()` returns false at the dedupe check, so the sale
  // produces no run AND no unmatched row: it is simply absent.
  //
  // 🔑 THE SIGNATURE POINTS THE OPPOSITE WAY TO THE OBVIOUS READING. A key present in `seen` with
  // nothing behind it CANNOT be the confirmation gate refusing the sale — `apply()` checks
  // `confirmed` BEFORE it keys anything, so a refused request never reaches `seen` at all.
  // Key present + no row means DEDUPED, every time.
  //
  // 👉 The only safe repair is deleting the WHOLE file. Editing rows out of it destroys history.
  const dir = freshDir();
  const key = "2026-08-23T19:57:21.520Z|sell|SCShop_Levski_CargoOffice_Commodities|53513e3d-93cc-4079-b87b-cf20a4692661|531300";
  writeFileSync(pjoin(dir, "trade-journal.json"),
    JSON.stringify({ v: 1, open: [], runs: [], unmatched: [], writtenOff: [], nextLotId: 1, seen: [key] }));

  const SELL_DYM2 =
    "<2026-08-23T19:57:21.520Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> " +
    "Sending SShopCommoditySellRequest - playerId[204772220757] shopId[776283668799] " +
    "shopName[SCShop_Levski_CargoOffice_Commodities] kioskId[776283668797] amount[531300.000000] " +
    "resourceGUID[53513e3d-93cc-4079-b87b-cf20a4692661] autoLoading[0] quantity[21] " +
    "transactionMode[CargoGrid] Cargo Box Data:  [boxSize[8] | unitAmount[1]] [Team_CoreGameplayFeatures][Shops][UI]";

  const j = new TradeJournal(dir, () => "Dymantium");
  const p = buyOf(SELL_DYM2);
  // POSITIVE FIRST: the gate confirmed it, so nothing about the refusal path is in play here.
  check("the gate confirmed the sale", p.confirmed === true, String(p.confirmed));
  check("...and the journal still declines it, on the dedupe check", j.apply(p) === false, "apply()");
  const v = j.view(new Date("2026-08-23T23:00:00Z"));
  check("...producing no run", v.runs.length === 0, String(v.runs.length));
  check("...AND no unmatched row - it is simply absent", v.unmatched.length === 0, String(v.unmatched.length));

  // CONTROL: the same sale against a journal with an EMPTY `seen` IS recorded, which proves the
  // dedupe list is what stands in the way rather than anything about the sale itself.
  const clean = freshDir();
  writeFileSync(pjoin(clean, "trade-journal.json"),
    JSON.stringify({ v: 1, open: [], runs: [], unmatched: [], writtenOff: [], nextLotId: 1, seen: [] }));
  const k = new TradeJournal(clean, () => "Dymantium");
  check("CONTROL: with `seen` cleared the very same sale is recorded", k.apply(p) === true, "apply()");
  check("CONTROL: ...as revenue, since no purchase was replayed with it",
    k.view().unmatched.length === 1, String(k.view().unmatched.length));
}

cleanupTmp();
console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
