/**
 * ITEM-SHOP CAPTURE.  `npm run test:itemshoplog`
 *
 * Driven off VERBATIM lines from Sub's own rotated logs — every fixture below is a real line with
 * only `playerId` left as it was. The rules under test are about what the game writes, so a
 * hand-invented line could agree with a wrong parser and never say so.
 *
 * 🔑 THE CONTROLS ARE INLINE AND RUN EVERY TIME. A control kept in a one-off scratch file rots the
 * day someone changes the code; one that lives in the suite cannot. Each block below states the
 * regression it re-injects and asserts the wrong answer really appears.
 */
import {
  parseItemShopLine,
  ItemShopConfirmations,
  ITEM_SHOP_LOG_MARKER,
  type ItemPurchase,
} from "./item-shop-log.js";
import { ObservedPriceStore } from "./observed-prices.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, detail = "") => {
  if (c) { pass++; console.log(`ok    ${name}${detail ? "  [" + detail + "]" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`); }
};

// ── VERBATIM LINES ──────────────────────────────────────────────────────────────────────────
// Sub's 7 aUEC drink — the purchase that started this flight.
const DRINK_BUY =
  "<2025-12-18T02:46:59.403Z> [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[201964486871] shopId[8412164758590] shopName[SCShop_Orison_KelTo] kioskId[8412164758591] client_price[77.000000] itemClassGUID[72b91153-5a3e-4d71-af5c-f6c57ea2891a] itemName[Drink_bottle_cruz_01_lux_a] quantity[11]  [Team_CoreGameplayFeatures][Shops][UI]";
// The qty-1 form of the same drink at another shop — 7 aUEC, which is what proves 77/11 is right.
const DRINK_BUY_ONE =
  "<2025-12-18T03:10:00.000Z> [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[201964486871] shopId[8412164758590] shopName[SCShop_Cargo_Office] kioskId[8412164758591] client_price[7.000000] itemClassGUID[72b91153-5a3e-4d71-af5c-f6c57ea2891a] itemName[Drink_bottle_cruz_01_lux_a] quantity[1]  [Team_CoreGameplayFeatures][Shops][UI]";
// The measured TOTAL-vs-UNIT proof: one item, one shop, qty 1 and qty 2, price exactly doubled.
const CANNON_Q1 =
  "<2025-08-04T21:12:28.917Z> [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[201964486871] shopId[5060637657211] shopName[SCShop_Centermass_Area18] kioskId[5060637657200] client_price[176093.000000] itemClassGUID[27adea05-f94d-4439-872d-b043a631c34f] itemName[AMRS_LaserCannon_S4] quantity[1]  [Team_CoreGameplayFeatures][Shops][UI]";
const CANNON_Q2 =
  "<2025-08-04T21:11:10.681Z> [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[201964486871] shopId[5060637657211] shopName[SCShop_Centermass_Area18] kioskId[5060637657200] client_price[352186.000000] itemClassGUID[27adea05-f94d-4439-872d-b043a631c34f] itemName[AMRS_LaserCannon_S4] quantity[2]  [Team_CoreGameplayFeatures][Shops][UI]";
// The OTHER family — a counter shop. Note `currencyType` and `kioskId[0]`.
const PIZZA_BUY =
  "<2025-08-01T22:30:17.435Z> [Notice] <CEntityComponentShoppingProvider::SendStandardItemBuyRequest> Sending SShopBuyRequest - playerId[201964486871] shopId[5061333926387] shopName[SCShop_PizzaBar_Food_RestStop] kioskId[0] client_price[7.000000] itemClassGUID[e07fa2c7-e2f2-4041-a898-d73f1f51eb06] itemName[Drink_bottle_synergy_01_plus_a] quantity[1] currencyType[UEC] [Team_CoreGameplayFeatures][Shops][UI]";
// Responses. 🔴 Both are [Notice] — including the refusal.
const OK_UI = (t: string, shop = "8412164758590") =>
  `<${t}> [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - playerId[201964486871] shopId[${shop}] shopName[SCShop_Orison_KelTo] kioskId[8412164758591] kioskState[BuyRequestProcessing] result[Success] type[Buying] [Team_CoreGameplayFeatures][Shops][UI]`;
const BROKE_UI =
  "<2025-08-04T21:11:10.858Z> [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - playerId[201964486871] shopId[5060637657211] shopName[SCShop_Centermass_Area18] kioskId[5060637657200] kioskState[BuyRequestProcessing] result[InsufficentFunds] type[Buying] [Team_CoreGameplayFeatures][Shops][UI]";
const PENDING_UI = (t: string) =>
  `<${t}> [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - playerId[201964486871] shopId[8412164758590] shopName[SCShop_Orison_KelTo] kioskId[8412164758591] kioskState[BuyRequestProcessing] result[WaitingForPendingResult] type[Buying] [Team_CoreGameplayFeatures][Shops][UI]`;
const OK_SHOPPING = (t: string) =>
  `<${t}> [Notice] <CEntityComponentShoppingProvider::RmShopFlowResponse> Shop Flow Response - playerId[201964486871] result[Success] [Team_CoreGameplayFeatures][Shops][UI]`;
// A vehicle rental — free, so never a price.
const RENTAL =
  "<2025-11-20T16:04:57.742Z> [Notice] <CEntityComponentShoppingProvider::SendRentalRequest> Sending SShopRentalRequest - playerId[201964486871] shopId[7627213259738] shopName[SCShop_IAE_Rentals] kioskId[7627213259744] client_price[0.000000] itemClassGUID[83318d44-b6c1-42d8-bcd1-284318718b42] itemName[RSI_Salvation] offering[0] currencyType[UEC] [Team_CoreGameplayFeatures][Shops][UI]";
// Clock movers with no shop content.
const IDLE = (t: string) => `<${t}> [Notice] <CSessionManager::Update> nothing to see here`;

// ── 1. THE PARSE ────────────────────────────────────────────────────────────────────────────
console.log("\n-- the line --");
{
  const p = parseItemShopLine(DRINK_BUY)?.purchase;
  ok(!!p, "a SendShopBuyRequest parses");
  ok(p?.itemGuid === "72b91153-5a3e-4d71-af5c-f6c57ea2891a", "itemClassGUID is read and lowercased", p?.itemGuid ?? "-");
  ok(p?.shopName === "SCShop_Orison_KelTo", "shopName is the terminal identity", p?.shopName ?? "-");
  ok(p?.quantity === 11, "quantity is read", String(p?.quantity));
  ok(p?.totalPrice === 77, "client_price is kept verbatim as the TOTAL", String(p?.totalPrice));
  ok(p?.family === "ShopUIProvider", "the family is recorded");
  ok(p?.kind === "buy", "a buy is a buy");
  ok(p?.confirmed === null, "🔴 a single line NEVER claims the server agreed", String(p?.confirmed));
  ok(p?.resultCode === null, "...and states no result");

  const s = parseItemShopLine(PIZZA_BUY)?.purchase;
  ok(!!s, "🔴 the SECOND buy verb parses too — SendStandardItemBuyRequest, 143 of 382 purchases");
  ok(s?.family === "ShoppingProvider", "...and is tagged as the other family", s?.family);
  ok(s?.currency === "UEC", "currencyType is read where present", s?.currency ?? "-");
  ok(s?.kioskId === "0", "a counter shop's kioskId[0] is kept, not treated as absent");

  const r = parseItemShopLine(RENTAL)?.purchase;
  ok(r?.kind === "rent", "🔴 a rental is marked, not silently a purchase", r?.kind);
  ok(r?.unitPrice === null, "...and a client_price[0] rental yields NO price", String(r?.unitPrice));

  ok(parseItemShopLine("<2025-01-01T00:00:00.000Z> [Notice] <CSomethingElse::Foo> hi") === null,
     "a non-shop line is null, so this is cheap on every line");
  const unk = parseItemShopLine("<2025-01-01T00:00:00.000Z> [Notice] <CEntityComponentShopUIProvider::SendShopSellRequest> hi");
  ok(unk?.unknownMethod === "ShopUIProvider::SendShopSellRequest",
     "🔑 an unmodelled verb ANNOUNCES itself — the mechanism that would have surfaced the second buy verb", unk?.unknownMethod);
}

// ── 2. 🔴 client_price IS THE TOTAL ─────────────────────────────────────────────────────────
console.log("\n-- the unit price (the measured correction) --");
{
  const one = parseItemShopLine(CANNON_Q1)?.purchase;
  const two = parseItemShopLine(CANNON_Q2)?.purchase;
  ok(one?.unitPrice === 176093, "qty 1: the unit price is the total", String(one?.unitPrice));
  ok(two?.unitPrice === 176093,
     "🔴 qty 2 at DOUBLE the total gives the SAME unit price — client_price is per-stack",
     `${two?.totalPrice} / ${two?.quantity} = ${two?.unitPrice}`);
  // POSITIVE first, so the must-nots below cannot pass for free.
  ok(one?.unitPrice === two?.unitPrice, "the two agree, which is what makes the rule checkable");

  const drink = parseItemShopLine(DRINK_BUY)?.purchase;
  const drink1 = parseItemShopLine(DRINK_BUY_ONE)?.purchase;
  ok(drink?.unitPrice === 7, "Sub's 11 drinks at 77 aUEC are 7 aUEC each", String(drink?.unitPrice));
  ok(drink1?.unitPrice === 7, "...matching the qty-1 purchase of the same drink elsewhere", String(drink1?.unitPrice));
  ok(drink?.unitPrice !== drink?.totalPrice,
     "🔴 CONTROL: reporting the raw field would say 77, and 26.7% of real buys are qty > 1",
     `unit ${drink?.unitPrice} vs total ${drink?.totalPrice}`);
}

// ── 3. 🔴 THE CONFIRMATION RULE IS THE OPPOSITE OF THE COMMODITY ONE ────────────────────────
console.log("\n-- commit ONLY when confirmed --");
{
  // POSITIVE: a Success really does confirm. Without this the must-nots below are free.
  const g = new ItemShopConfirmations();
  ok(g.line(DRINK_BUY).length === 0, "the request alone confirms nothing");
  const got = g.line(OK_UI("2025-12-18T02:47:00.000Z"));
  ok(got.length === 1, "an explicit result[Success] confirms it", `n=${got.length}`);
  ok(got[0]?.confirmed === true, "...and says so in the type");
  ok(got[0]?.resultCode === "Success", "...recording the token verbatim", got[0]?.resultCode ?? "-");
  ok(got[0]?.unitPrice === 7, "...carrying the UNIT price through the gate", String(got[0]?.unitPrice));
}
{
  // 🔴 THE INVERSION. Silence must confirm NOTHING. This is the assertion that separates this gate
  // from `TradeConfirmations`, where silence is exactly what confirms.
  //
  // 🔑 An EXPLICIT short window, so this tests the MECHANISM rather than today's constant. Driving
  // it with the default would make the assertion depend on `MAX_HOLD_MS`, and it would have gone
  // green-then-red purely because that constant was correctly widened from 30 s to 300 s. The
  // constant gets its own assertion below.
  const g = new ItemShopConfirmations(2000);
  g.line(DRINK_BUY);
  g.line(IDLE("2025-12-18T02:47:00.000Z"));   // +1 s, still inside the window
  ok(g.pending().length === 1, "...it is still held while the window is open");
  g.line(IDLE("2025-12-18T02:50:00.000Z"));   // long past it
  ok(g.pending().length === 0, "an unanswered request eventually leaves the queue");
  const ab = g.unanswered();
  ok(ab.length === 1, "...and is reported as unanswered rather than vanishing", `n=${ab.length}`);
  ok(ab[0]?.purchase.confirmed === null, "🔴 it is NEVER confirmed — silence is not success");
}
{
  // 🔴 THE CONSTANT ITSELF. Sized above the SLOWEST real round trip (64,787 ms), not the median —
  // a 30 s window evicted that request and silently lost the purchase its Success belonged to.
  // `measure:itemshops` re-derives the latency and fails if it ever outgrows this.
  ok(ItemShopConfirmations.MAX_HOLD_MS > 64_787,
     "🔴 the hold window clears the worst measured latency, not just the typical one",
     `${ItemShopConfirmations.MAX_HOLD_MS} ms vs 64,787 ms observed`);
}
{
  const g = new ItemShopConfirmations();
  g.line(CANNON_Q2);
  const out = g.line(BROKE_UI);
  ok(out.length === 0, "🔴 result[InsufficentFunds] confirms NOTHING", `n=${out.length}`);
  ok(g.refused().length === 1, "...the refusal is kept so it can be reported");
  ok(g.refused()[0]?.confirmed === false, "...marked false, not null");
  ok(g.refused()[0]?.resultCode === "InsufficentFunds",
     "...with CIG's own spelling preserved, never corrected", g.refused()[0]?.resultCode ?? "-");
  // 🔑 CONTROL for the severity trap: this refusal is a [Notice]. A gate that read severity the
  // way `trade-log.ts` does would see no error here and book the purchase.
  ok(BROKE_UI.includes("[Notice]") && !BROKE_UI.includes("[Error]"),
     "🔴 CONTROL: the refusal is a [Notice] — severity cannot be the discriminator here");
}
{
  const g = new ItemShopConfirmations();
  g.line(DRINK_BUY);
  const out = g.line(PENDING_UI("2025-12-18T02:47:00.000Z"));
  ok(out.length === 0, "result[WaitingForPendingResult] confirms nothing either", `n=${out.length}`);
}

// ── 4. 🔴 TWO FAMILIES, TWO QUEUES ──────────────────────────────────────────────────────────
console.log("\n-- the families never cross --");
{
  const g = new ItemShopConfirmations();
  g.line(PIZZA_BUY);                                   // ShoppingProvider request
  const wrong = g.line(OK_UI("2025-08-01T22:30:18.000Z")); // ShopUIProvider success
  ok(wrong.length === 0,
     "🔴 a ShopUIProvider response may NOT confirm a ShoppingProvider request", `n=${wrong.length}`);
  ok(g.pending().length === 1, "...the request is still waiting for its own family's answer");
  const right = g.line(OK_SHOPPING("2025-08-01T22:30:19.000Z"));
  ok(right.length === 1, "...and its own family's Success does confirm it", `n=${right.length}`);
  ok(right[0]?.itemName === "Drink_bottle_synergy_01_plus_a", "...the right purchase", right[0]?.itemName ?? "-");
}
{
  // Both families in flight at once — they must not interfere.
  const g = new ItemShopConfirmations();
  g.line(DRINK_BUY);
  g.line(PIZZA_BUY);
  const a = g.line(OK_SHOPPING("2025-12-18T02:47:00.000Z"));
  ok(a.length === 1 && a[0].family === "ShoppingProvider",
     "with one request held in each family, a response settles its OWN", a[0]?.family ?? "-");
  const b = g.line(OK_UI("2025-12-18T02:47:01.000Z"));
  ok(b.length === 1 && b[0].family === "ShopUIProvider", "...and the other settles the other", b[0]?.family ?? "-");
}

// ── 5. FIFO, AND THE REAL MULTI-DEEP CASE FROM THE CORPUS ───────────────────────────────────
console.log("\n-- FIFO, on the one real multi-deep sequence --");
{
  // The verbatim 2025-12-18 sequence: drink, ksar, pending, ksar retry, pending, success.
  // Three requests, three responses, exactly ONE purchase.
  const KSAR = (t: string) =>
    `<${t}> [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[201964486871] shopId[8412164758590] shopName[SCShop_Orison_KelTo] kioskId[8412164758591] client_price[7287.000000] itemClassGUID[aaaaaaaa-0000-0000-0000-000000000001] itemName[ksar_smg_energy_01_mag] quantity[21]  [Team_CoreGameplayFeatures][Shops][UI]`;
  const g = new ItemShopConfirmations();
  const confirmed: ItemPurchase[] = [];
  for (const l of [
    DRINK_BUY,                                  // 02:46:59.403
    KSAR("2025-12-18T02:48:03.966Z"),
    PENDING_UI("2025-12-18T02:48:04.190Z"),
    KSAR("2025-12-18T02:48:16.726Z"),
    PENDING_UI("2025-12-18T02:48:16.904Z"),
    OK_UI("2025-12-18T02:48:32.101Z"),
  ]) confirmed.push(...g.line(l));

  ok(confirmed.length === 1, "exactly ONE purchase is confirmed out of three requests", `n=${confirmed.length}`);
  ok(confirmed[0]?.itemName === "ksar_smg_energy_01_mag",
     "🔑 and it is the RETRY that succeeded, not the drink", confirmed[0]?.itemName ?? "-");
  ok(confirmed[0]?.unitPrice === 347, "...priced per magazine, not per stack of 21", String(confirmed[0]?.unitPrice));
  // 🔴 CONTROL: newest-first (the commodity gate's rule) would confirm the drink here.
  ok(!confirmed.some((c) => c.itemName === "Drink_bottle_cruz_01_lux_a"),
     "🔴 CONTROL: newest-first matching would have booked the drink, which we never saw succeed");
}

// ── 6. THE CLOCK IS THE LOG'S ───────────────────────────────────────────────────────────────
console.log("\n-- the log's clock, not the wall's --");
{
  const g = new ItemShopConfirmations(2000);
  g.line(DRINK_BUY);
  g.line("a line with no timestamp at all");
  ok(g.pending().length === 1, "an unstamped line is not evidence that time passed");
  g.line(IDLE("2025-12-18T02:47:30.000Z"));           // +31s of LOG time
  ok(g.pending().length === 0, "a stamped line past the window ages it out");
  ok(g.unanswered().length === 1, "...as unanswered, never as confirmed");
}
{
  // endOfStream is the inversion of TradeConfirmations.flush().
  const g = new ItemShopConfirmations();
  g.line(DRINK_BUY);
  const left = g.endOfStream();
  ok(left.length === 1, "end of stream reports what was still held", `n=${left.length}`);
  ok(left[0]?.purchase.confirmed === null,
     "🔴 endOfStream() CONFIRMS NOTHING — the opposite of the commodity flush(), which confirms all");
  ok(g.pending().length === 0, "...and the queue is emptied");
}

// ── 7. THE MARKER ───────────────────────────────────────────────────────────────────────────
console.log("\n-- the prefilter cannot drift --");
{
  ok(DRINK_BUY.includes(ITEM_SHOP_LOG_MARKER), "the marker matches a request");
  ok(OK_UI("2025-01-01T00:00:00.000Z").includes(ITEM_SHOP_LOG_MARKER), "...and a UI response");
  ok(OK_SHOPPING("2025-01-01T00:00:00.000Z").includes(ITEM_SHOP_LOG_MARKER),
     "🔴 ...and the OTHER family's response — narrowing this string would drop every Success");
  ok(PIZZA_BUY.includes(ITEM_SHOP_LOG_MARKER), "...and the other family's request");
  ok(!IDLE("2025-01-01T00:00:00.000Z").includes(ITEM_SHOP_LOG_MARKER), "and not an unrelated line");
}

// ── 8. ONLY CONFIRMED TRANSACTIONS REACH THE STORE ──────────────────────────────────────────
console.log("\n-- the store refuses everything unconfirmed --");
{
  const dir = mkdtempSync(join(tmpdir(), "observed-"));
  try {
    const s = new ObservedPriceStore(dir);
    const base = {
      kind: "item" as const, id: "72B91153-5A3E-4D71-AF5C-F6C57EA2891A",
      terminal: "SCShop_Orison_KelTo", unitPrice: 7, quantity: 11, total: 77,
      at: "2025-12-18T02:46:59.403Z", side: "buy" as const,
      token: "Drink_bottle_cruz_01_lux_a", system: "Stanton",
    };
    // POSITIVE FIRST — otherwise every must-not below is satisfied by an empty store.
    ok(s.add({ ...base, confirmed: true }), "a CONFIRMED observation is stored");
    ok(s.count() === 1, "...and the store holds it", `n=${s.count()}`);
    ok(s.forId("item", "72b91153-5a3e-4d71-af5c-f6c57ea2891a").length === 1,
       "🔑 the id is matched case-insensitively — the log writes it uppercase, the table lowercase");

    ok(!s.add({ ...base, at: "2025-12-18T03:00:00.000Z", confirmed: false }),
       "🔴 a REFUSED observation is dropped");
    ok(!s.add({ ...base, at: "2025-12-18T03:01:00.000Z", confirmed: null }),
       "🔴 `null` counts as refused — the pool's rule, kept here");
    ok(!s.add({ ...base, at: "2025-12-18T03:02:00.000Z", unitPrice: 0, confirmed: true }),
       "🔴 a zero price is not a price (this is what a free rental logs)");
    ok(s.count() === 1, "🔴 CONTROL: after three refusals the store STILL holds exactly one",
       `n=${s.count()}`);

    ok(!s.add({ ...base, confirmed: true }), "the same purchase twice is idempotent");
    ok(s.count() === 1, "...so the seed/watcher handover cannot double-count", `n=${s.count()}`);

    // Commodities live in the same store under their own namespace.
    ok(s.add({ ...base, kind: "commodity", id: "5f2d394d-6e69-4cb8-afb2-81a96544936e",
               terminal: "Admin - Baijini Point", unitPrice: 35000, confirmed: true }),
       "a commodity observation lands in the same store");
    ok(s.forId("item", "5f2d394d-6e69-4cb8-afb2-81a96544936e").length === 0,
       "🔴 ...but NOT in the item namespace — two catalogues, two id spaces");
    ok(s.forId("commodity", "5f2d394d-6e69-4cb8-afb2-81a96544936e").length === 1,
       "...it is found under its own kind");

    // Persistence reads FORWARD.
    s.save();
    const again = new ObservedPriceStore(dir);
    ok(again.count() === 2, "the store round-trips through disk", `n=${again.count()}`);
    ok(again.forId("item", base.id).length === 1, "...with the item still findable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 9. END TO END: a real purchase becomes a fresh quote ────────────────────────────────────
console.log("\n-- end to end --");
{
  const dir = mkdtempSync(join(tmpdir(), "observed-e2e-"));
  try {
    const s = new ObservedPriceStore(dir);
    const g = new ItemShopConfirmations();
    // Feed the drink buy, a refused cannon buy, and the drink's Success — in log order.
    for (const l of [CANNON_Q2, BROKE_UI, DRINK_BUY, OK_UI("2025-12-18T02:47:00.000Z")]) {
      for (const p of g.line(l)) {
        s.add({
          kind: "item", id: p.itemGuid ?? "", terminal: p.shopName ?? "",
          unitPrice: p.unitPrice ?? 0, quantity: p.quantity ?? 1, total: p.totalPrice ?? 0,
          at: p.at, side: "buy", token: p.itemName, system: null, confirmed: p.confirmed,
        });
      }
    }
    const rows = s.latestPerTerminal("item", "72b91153-5a3e-4d71-af5c-f6c57ea2891a");
    ok(rows.length === 1, "the confirmed drink reaches the store", `n=${rows.length}`);
    ok(rows[0]?.unitPrice === 7, "🔑 at 7 aUEC — the number Sub expected to see", String(rows[0]?.unitPrice));
    ok(rows[0]?.terminal === "SCShop_Orison_KelTo", "...naming the shop he bought it at");
    ok(s.forId("item", "27adea05-f94d-4439-872d-b043a631c34f").length === 0,
       "🔴 CONTROL: the REFUSED cannon purchase never reached the store");
    ok(s.count() === 1, "...so exactly one row exists, not two", `n=${s.count()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${fail ? `FAILED (${fail})` : "all passed"}  ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
