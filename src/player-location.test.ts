/**
 * THE ONE OWNER OF "WHERE IS THE PLAYER".  `npm run test:playerloc`
 *
 * Driven on VERBATIM log lines from Sub's own logs, because every rule here is about what a real
 * line does. A hand-written line proves the code parses a string somebody invented.
 *
 * 🔴 THE TWO ASSERTIONS THAT MATTER MOST ARE THE BORING-LOOKING ONES:
 *   - the seed stamps the LOG's time, not the wall clock
 *   - a terminal binding is never handed to anything that could persist it
 * Both are silent when broken. The first makes a three-hour-old reading outrank a current one; the
 * second is how the rejected `shopName -> place` map would come back through a side door.
 */
import { PlayerLocation, parseShopLine, terminalLabel, BIND_WINDOW_MS } from "./player-location.js";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, detail = "") => {
  if (c) { pass++; console.log(`ok    ${name}${detail ? "  [" + detail + "]" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`); }
};

/* Verbatim from game.log, 2026-08-23. */
const BUY_COMMODITY = "<2026-08-23T18:05:03.764Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[776425992034] shopName[SCShop_AdminOffice_Nyx_SocialStation] kioskId[776425992032] price[447370.000000] [Team_CGP4][Economy]";
const BUY_ITEM = "<2026-08-23T20:10:56.318Z> [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[204772220757] shopId[776283668779] shopName[SCShop_Levski_CargoOffice_ITEM] kioskId[776283668769] client_price[7.000000] [Team_CGP4][Economy]";
/* The terrain report. Two lines: the streaming body, then a line that ENDS the block — the watcher
   only commits a reading when the run of `planet cells:` lines stops. */
const CELLS = "<2026-08-23T16:47:36.296Z>   planet cells:  137 [16384] meshes:   32 [ 2048] name: pyro2";
const CELLS_ZERO = "<2026-08-23T16:47:36.296Z>   planet cells:    0 [    0] meshes:    0 [    0] name: pyro3";
const BLOCK_END = "<2026-08-23T16:47:36.300Z> [Notice] <Anything> something else entirely";
const QT = "<2026-08-23T17:00:00.000Z> [Notice] <CSCItemNavigation> [QuantumTravel] Projected Start Location is Pyro System";

const NOW = 1_800_000_000_000;

// ── The shop line, on real components ─────────────────────────────────────────────────────────
{
  const a = parseShopLine(BUY_COMMODITY);
  ok(a?.shopId === "776425992034", "the commodity component's shopId is read", a?.shopId ?? "none");
  ok(a?.kioskId === "776425992032", "...and the kiosk inside it — the precision half", a?.kioskId ?? "none");

  // 🔴 THE ITEM COMPONENT IS THE BIGGER HALF AND NOTHING IN THE APP HAD EVER READ IT: 484 lines
  // against the commodity component's 311. A parser that matched only the one the trade journal
  // uses would find two thirds of the terminals in the corpus and report that as "all of them".
  const b = parseShopLine(BUY_ITEM);
  ok(b?.shopName === "SCShop_Levski_CargoOffice_ITEM",
     "the ITEM shop component is read too, not just the commodity one", b?.shopName ?? "none");

  ok(parseShopLine(QT) === null, "a quantum line is not a shop line");
  ok(parseShopLine("<t> [Notice] <Whatever> shopId[1] shopName[x]") === null,
     "a shopId on some OTHER component is refused — the component tag is the gate");
}

/* ── 🔴 THE THREE COMPONENTS THE OLD RULE COULD NOT SEE ───────────────────────────────────────
 *
 * `parseShopLine` used to require the text between `CEntityComponent` and `UIProvider::` to be
 * exactly "Commodity" or "Shop". Enumerating the components that really write `shopName[` over
 * Sub's 555 logbackups turns up FIVE, and three of them were refused: 171 lines — but **23 shop
 * tokens that appear nowhere else**, including every ship dealership and rental desk, every food
 * stall and both refinery ore desks.
 *
 * 🔑 THE OLD RULE IS FROZEN HERE AS SOURCE rather than described, so this block cannot be a claim
 * about what somebody remembers the parser used to do. `log-share.ts` keeps its superseded signal
 * rules the same way and for the same reason.
 *
 * 🔑 IT IS TWO-SIDED. The frozen rule must still ACCEPT the two original components — otherwise
 * "the old rule rejected these three" is satisfied by a frozen copy that rejects everything, which
 * is exactly the free must-not this repo keeps walking into.
 */
{
  /** VERBATIM from `logbackups/`, one per newly-accepted component. */
  const BUY_SHOPPING = "<2025-08-01T22:30:17.435Z> [Notice] <CEntityComponentShoppingProvider::SendStandardItemBuyRequest> Sending SShopBuyRequest - playerId[201964486871] shopId[5061333926387] shopName[SCShop_PizzaBar_Food_RestStop] kioskId[0] client_price[7.000000] itemClassGUID[e07fa2c7-e2f2-4041-a898-d73f1f51eb06] itemName[Drink_bottle_synergy_01_plus_a] quantity[1] currencyType[UEC] [Team_CoreGameplayFeatures][Shops][UI]";
  const RENTAL = "<2026-05-14T16:28:05.619Z> [Error] <CEntityComponentShop::GetRentalOptionsForEntityClassGUID> Item was not found in inventory - itemGUID[bba050c3-1348-45a8-91c6-73e4ecf5082f] itemName[COOL_JUST_S01_Thermax_SCItem] shopId[200862236441], shopName[SCShop_FW_ExpoHall] [Team_CoreGameplayFeatures][Shops]";
  const REFINERY = "<2026-07-17T19:00:54.632Z> [Notice] <CEntityComponentMiningShopUIProvider::OnRefineryRequest> Sending SShopRefineryRequest - playerId[204772220757] shopId[718803279034] shopName[SCShop_NyxSocialStation_ORESales] kioskId[718803279035] request[] currencyType[UEC] [Team_CoreGameplayFeatures][Shops][UI]";

  /** The SHIPPED rule as of 0.1.47, copied verbatim. Frozen; never "kept in step". */
  const oldRule = (line: string): boolean => {
    const c = line.indexOf("CEntityComponent");
    if (c < 0) return false;
    const t = line.indexOf("UIProvider::", c);
    if (t < 0) return false;
    const between = line.slice(c + "CEntityComponent".length, t);
    if (between !== "Commodity" && between !== "Shop") return false;
    return /shopId\[[^\]]+\]/.test(line) && /shopName\[[^\]]+\]/.test(line);
  };

  // POSITIVE FIRST: the frozen copy is a real rule, not a stub that says no to everything.
  ok(oldRule(BUY_COMMODITY) && oldRule(BUY_ITEM),
     "the frozen old rule really does accept the two components it was written for",
     `${oldRule(BUY_COMMODITY)}/${oldRule(BUY_ITEM)}`);

  ok(!oldRule(BUY_SHOPPING) && !oldRule(RENTAL) && !oldRule(REFINERY),
     "🔴 ...and really did refuse all three of the others — the gap is not hypothetical",
     `${oldRule(BUY_SHOPPING)}/${oldRule(RENTAL)}/${oldRule(REFINERY)}`);

  const a = parseShopLine(BUY_SHOPPING);
  ok(a?.shopName === "SCShop_PizzaBar_Food_RestStop",
     "ShoppingProvider — no `UIProvider::` in its name at all — is read now", a?.shopName ?? "none");

  // ⚠️ [Error] SEVERITY, AND THAT IS FINE HERE. `trade-log.ts` gates a PURCHASE on severity; this
  // parser answers "where is the player standing", and a rental lookup that failed still happened
  // at the rental desk. Copying the trade gate's rule across would lose the whole component.
  const b = parseShopLine(RENTAL);
  ok(b?.shopName === "SCShop_FW_ExpoHall",
     "a bare CEntityComponentShop line is read, [Error] severity and all", b?.shopName ?? "none");
  ok(b?.kioskId === null, "...and it states no kiosk, which is absence rather than failure",
     String(b?.kioskId));

  const c = parseShopLine(REFINERY);
  ok(c?.shopName === "SCShop_NyxSocialStation_ORESales",
     "MiningShopUIProvider — \"MiningShop\" is not \"Shop\" — is read now", c?.shopName ?? "none");
  ok(c?.kioskId === "718803279035", "...with its kiosk", c?.kioskId ?? "none");
}

// ── The label ─────────────────────────────────────────────────────────────────────────────────
{
  ok(terminalLabel("SCShop_Levski_CargoOffice_Commodities") === "Levski Cargo Office Commodities",
     "the asset name becomes something a person would say", terminalLabel("SCShop_Levski_CargoOffice_Commodities"));
  ok(terminalLabel("SCShop_ConscientiousObjects_Levski-001") === "Conscientious Objects Levski",
     "...with the instance suffix dropped", terminalLabel("SCShop_ConscientiousObjects_Levski-001"));
}

// ── 🔴 THE SEED MUST STAMP THE LOG'S OWN TIME ─────────────────────────────────────────────────
//
// Positive first: the reading has to EXIST before "it is not stamped now" can mean anything, and a
// watcher that silently swallowed the line would satisfy every must-not check for free.
{
  const LOG_T = Date.parse("2026-08-23T16:47:36.296Z");
  const pl = new PlayerLocation({ bodyNames: { pyro2: "Monox" }, now: () => NOW });
  pl.push(CELLS, LOG_T);
  pl.push(CELLS_ZERO, LOG_T);
  pl.push(BLOCK_END, LOG_T);
  const p = pl.place.current(LOG_T + 1000);
  ok(p.kind === "planet", "a replayed terrain report produces a body reading", p.kind);
  ok(p.kind === "planet" && p.at === LOG_T,
     "...stamped when the GAME wrote it, not when we replayed it",
     p.kind === "planet" ? new Date(p.at).toISOString() : "n/a");
  // And the consequence, which is the reason the rule exists: a stale replay must READ stale.
  ok(pl.place.current(LOG_T + 60 * 60_000).kind === "unknown",
     "...so an hour-old replayed report is not asserted as a current position");
}

// ── The numeric location id: bound, and only from a real pairing ──────────────────────────────
{
  const saved: Record<string, string> = {};
  const pl = new PlayerLocation({
    savedPlaceIds: () => saved,
    savePlaceId: (id, tok) => { saved[id] = tok; },
    now: () => NOW,
  });

  pl.learn({ token: "Stanton3_Area18", at: NOW - 1000 }, { id: "3490636373", at: NOW - 2000 });
  ok(saved["3490636373"] === "Stanton3_Area18",
     "a number seen at the same visit as a token is bound to it", saved["3490636373"] ?? "none");

  // 🔴 OUTSIDE THE WINDOW IS NOT A PAIRING. The log never states this join anywhere, so learning it
  // from two readings that are not the same visit is inventing it.
  const saved2: Record<string, string> = {};
  const pl2 = new PlayerLocation({ savedPlaceIds: () => saved2, savePlaceId: (i, t) => { saved2[i] = t; }, now: () => NOW });
  pl2.learn({ token: "Stanton3_Area18", at: NOW }, { id: "999", at: NOW - BIND_WINDOW_MS - 1 });
  ok(!saved2["999"], "...and one seen too far apart is not", saved2["999"] ?? "unbound");

  // The whole point: an id alone, later, still names the place.
  const r = pl.inputs({ atLocationId: { id: "3490636373", at: NOW - 500 } });
  ok(r.boundPlace?.token === "Stanton3_Area18",
     "a later hit on a bound id resolves with no token line in sight", r.boundPlace?.token ?? "none");
  ok(r.boundPlace?.at === NOW - 500, "...carrying the id's OWN time, so it can age honestly");
  ok(pl.inputs({ atLocationId: { id: "nope", at: NOW } }).boundPlace === null,
     "an UNBOUND id resolves to nothing, never to a guess");
}

// ── 🔴 A TERMINAL BINDING IS IN-SESSION ONLY. Never persisted, and there is no path that could. ──
{
  const saved: Record<string, string> = {};
  let saves = 0;
  const pl = new PlayerLocation({
    savedPlaceIds: () => saved,
    savePlaceId: (id, tok) => { saves++; saved[id] = tok; },
    now: () => NOW,
  });
  const AT = NOW - 10_000;
  pl.push(BUY_ITEM, AT);
  pl.learn({ token: "Nyx_Levski", at: AT + 1000 }, null);

  const t = pl.terminal();
  ok(t?.boundToken === "Nyx_Levski", "a terminal touched at a named place is bound to it", t?.boundToken ?? "none");
  ok(pl.boundTerminals() === 1, "...and the session holds exactly that one binding", String(pl.boundTerminals()));
  // POSITIVE FIRST, then the refusal — otherwise "nothing was persisted" is satisfied by a run in
  // which nothing was learned either, which is indistinguishable downstream.
  ok(saves === 0, "...and NOTHING was written to the persisted map by it", `${saves} saves`);
  ok(Object.keys(saved).length === 0, "...which is still empty", JSON.stringify(saved));

  // A fresh session starts with no terminal knowledge at all. That is the guarantee: a binding
  // that cannot outlive the session cannot be wrong about a later one — which is exactly how the
  // rejected shopName map went wrong (SCShop_Cargo_Office exists at 13 stations).
  const next = new PlayerLocation({ savedPlaceIds: () => saved, now: () => NOW });
  next.push(BUY_ITEM, NOW);
  ok(next.terminal()?.boundToken === null,
     "a NEW session knows nothing about that terminal", String(next.terminal()?.boundToken));
  ok(next.terminal()?.label === "Levski Cargo Office ITEM",
     "...but still knows which desk it was, which needs no binding", next.terminal()?.label ?? "none");
}

// ── inputs(): the whole assembly, and the thing that used to be dropped ───────────────────────
{
  const pl = new PlayerLocation({ savedPlaceIds: () => ({ "42": "Nyx_Levski" }), now: () => NOW });
  const i = pl.inputs({
    atLocation: { token: "Stanton3_Area18", at: NOW - 60_000 },
    atLocationId: { id: "42", at: NOW - 5_000 },
    cargoMove: { direction: "up", platform: "LoadingPlatformManager", at: NOW - 90_000 },
  });
  ok(i.atLocationId?.id === "42", "the raw id is still handed on, unchanged", i.atLocationId?.id ?? "none");
  ok(i.boundPlace?.token === "Nyx_Levski",
     "...AND the resolved form beside it — the field whose absence made this signal invisible",
     i.boundPlace?.token ?? "none");
  ok(i.terminal === null, "no terminal touched means no terminal fix, not an empty one", String(i.terminal));
}

console.log(`\n${fail ? `FAILED (${fail})` : "all passed"}  ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
