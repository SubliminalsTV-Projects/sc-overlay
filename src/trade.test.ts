// Commodity trading: the log parser, and the finder's honesty rules.
//
//   npx tsx src/trade.test.ts
//
// 🔑 THE PARSER FIXTURES ARE REAL LINES, copied byte-for-byte out of Sub's own session on
// 2026-08-19 (Area 18 TDD, the same commodity bought twice - once auto-loaded, once to the
// freight elevator - plus a Shubin buy and a shop inventory line). Synthetic fixtures would have
// agreed with whatever the parser happened to do; these agree with the game.

import { parseTradeLine } from "./trade-log.js";
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
  check("a suffixed variant is NOT folded in", l?.buyAt.every((e) => e.terminal !== "E"), JSON.stringify(l?.buyAt.map((e) => e.terminal)));
  check("buy terminals are cheapest first", l?.buyAt[0].price === 100, String(l?.buyAt[0].price));
  check("sell terminals are dearest first", l?.sellAt[0].price === 300, String(l?.sellAt[0].price));
  check("an unknown commodity is null, not an empty shell", lookupCommodity(quotes, "Unobtainium", "live", NOW) === null);
  check("a commodity with no sell side still returns", !!lookupCommodity(quotes, "Titanium (Ore)", "live", NOW));
  check("...with a null sell summary rather than a zero", lookupCommodity(quotes, "Titanium (Ore)", "live", NOW)?.sell === null);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
