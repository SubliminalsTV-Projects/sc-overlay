/**
 * TRADE - READING A REAL PURCHASE OUT OF `game.log`.
 *
 * Captured 2026-08-19 from Sub's own session: he stood at the Area 18 TDD and bought the SAME
 * commodity twice, once straight onto the ship and once to the freight elevator, specifically so
 * both shapes would be on record. Then the game crashed, which turned out to be the most useful
 * part of the experiment - see the blind spot at the bottom.
 *
 * -- The line, verbatim ---------------------------------------------------------------------
 *
 *   <2026-08-19T17:43:31.000Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest>
 *   Sending SShopCommodityBuyRequest - playerId[204772220757] shopId[762985455925]
 *   shopName[TDD_SCShop-001] kioskId[762985455920] price[1202.000000]
 *   shopPricePerCentiSCU[12.019500] resourceGUID[accacd33-3a1a-4ec7-8b4a-14b9f028047c]
 *   autoLoading[1] quantity[100.000000 cSCU] Cargo Box Data: boxSize[1.000000] | unitAmount[1]
 *   [Team_CoreGameplayFeatures][Shops][UI]
 *
 * 🔑 `autoLoading` IS THE FLAG, AND IT WAS PROVEN RATHER THAN INFERRED. The two buys above are 16
 * seconds apart, identical in every field except this one: `1` on the purchase that went straight
 * into the hold, `0` on the one that went to the freight elevator. That is not a reading of the
 * field name, it is Sub buying it both ways on purpose so the difference had exactly one place to
 * show up. It matters because an `autoLoading[0]` purchase is cargo the player still has to go and
 * collect - the Stow tab's problem - while `autoLoading[1]` is already aboard.
 *
 * 🔑 `resourceGUID` JOINS STRAIGHT TO `data/commodities.json`, WHICH IS KEYED BY THE SAME UUID.
 * `accacd33-...` is Processed Food; `60f116f4-...` is Tungsten. No name matching, no normalising,
 * no dialect problem - the one clean join in this whole subsystem. Do NOT switch it for a name.
 *
 * 🔑 UNITS. `quantity` is in **cSCU** (centiSCU): 100 cSCU = 1 SCU. `shopPricePerCentiSCU` x 100
 * is the aUEC/SCU price. `price` is the total for the transaction. On both captured buys the
 * derived per-SCU figure matched the bundled snapshot's `bestBuy` for that terminal EXACTLY
 * (1202 for Processed Food, 8265 for Tungsten) a full month after the snapshot was taken -
 * which is real evidence that BUY prices are shop-set and barely drift, unlike sell prices.
 *
 * -- 🔴 THE BLIND SPOT, AND WHY THE CRASH WAS THE USEFUL PART ---------------------------------
 *
 * After Sub's game crashed and he logged back in, the new `Game.log` contained **zero**
 * `CommodityUI` lines. The purchase is NOT restated on reconnect - it exists only in the moment it
 * happened, in whichever log file was open at the time.
 *
 * 🔑 BUT THAT IS RECOVERABLE, AND AN EARLIER DRAFT OF THIS COMMENT OVERSTATED IT. The sidecar
 * already runs `seedFromRotatedLog()` at startup, which replays the newest file in `logbackups/`
 * when it is within `BACKUP_SEED_MAX_AGE_MS` - written for exactly this class of loss, after the
 * same crash pattern ate Sub's mission state on 2026-08-17. Sub's own purchase IS in that file and
 * the seed did replay it this session. So the honest statement is narrower:
 *
 *   - A purchase in the CURRENT log, or in the most recent and still-recent rotated one, is
 *     recoverable. That covers the crash case, which is the common one.
 *   - A purchase older than that window, or from before the app was installed, is not.
 *
 * ⚠️ NEITHER PATH IS WIRED YET. `seedFromRotatedLog()`'s loop calls `parseMissionEvent` only, and
 * the live watcher likewise. This parser needs a call in both - the same one-line shape the Log
 * View widget's second `watcher.on("line")` listener uses. Deliberately left for the tower to land
 * rather than spent from this flight's budget for edits to `overlay-server.ts`, which is being
 * restructured concurrently. See the flight strip's landing notes.
 *
 * Whatever is wired, the rule stands: what was never seen is reported as UNKNOWN. The widget must
 * never present an inferred hold as a known one. "I did not see you buy anything" is a true and
 * useful answer; a confidently empty cargo list is neither.
 *
 * -- ✅ THE SELL, CAPTURED 2026-08-19 - AND IT IS NOT THE BUY LINE MIRRORED -------------------
 *
 *   <...> <CEntityComponentCommodityUIProvider::SendCommoditySellRequest>
 *   Sending SShopCommoditySellRequest - playerId[...] shopId[762986059617]
 *   shopName[SCShop_Admin_lt_base_g] kioskId[762986059616] amount[1506.000000]
 *   resourceGUID[accacd33-3a1a-4ec7-8b4a-14b9f028047c] autoLoading[1] quantity[1]
 *   transactionMode[ResourceContainer] Cargo Box Data:  [boxSize[1] | unitAmount[1]]
 *
 * The verb name was the obvious guess and the obvious guess was right. THREE OTHER THINGS WERE
 * NOT, and every one of them would have shipped a wrong number:
 *
 * 🔴 1. `quantity` CHANGES UNIT BETWEEN THE TWO LINES. A buy says `quantity[100.000000 cSCU]`
 *       (centiSCU, so 1 SCU). A sell says `quantity[1]` with NO unit, meaning one CONTAINER, and
 *       flags it with the new `transactionMode[ResourceContainer]`. Dividing by 100 regardless -
 *       which is what the buy-only parser did - reports a 1 SCU sale as **0.01 SCU**, a 100x
 *       error in every figure downstream. So the unit is read off the FIELD TEXT, not assumed.
 * 🔴 2. The total is `amount[...]`, not `price[...]`. Same meaning, different key.
 * 🔴 3. There is NO `shopPricePerCentiSCU` on a sell, so the per-SCU figure has to be derived
 *       from total / SCU rather than read.
 *
 * 🔑 The captured round trip validates the whole chain: bought at 1,202/SCU, sold at 1,506/SCU,
 * same `resourceGUID` both ends (Processed Food), against a bundled snapshot that predicted 1,500
 * at that destination.
 *
 * ⚠️ Two further methods are on record and deliberately NOT modelled yet, because nothing is known
 * about what they should do: `LoadSelectedShipBindings` (a `VehicleCargoDataRequest` naming a
 * `vehicleEntityId` - plausibly the route to reading the real hold) and `AddPlayerCommodityItem`
 * with an empty `commodityName[]`, which describes a box the PLAYER brought. They surface through
 * `unknownMethod`/`offer` rather than being dropped.
 */

/** One `key[value]` field off a CommodityUIProvider line. */
function fields(line: string): Map<string, string> {
  const out = new Map<string, string>();
  // Deliberately not a single regex over the whole line: `Cargo Box Data:` and the trailing
  // `[Team_...][Shops][UI]` tags are also bracketed, and a greedy pattern picks them up as fields.
  const re = /([A-Za-z][A-Za-z0-9]*)\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

/** A number out of a field, tolerating the unit suffix inside the bracket (`100.000000 cSCU`). */
function fnum(f: Map<string, string>, key: string): number | null {
  const raw = f.get(key);
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export interface CommodityPurchase {
  /** ISO timestamp off the log line. */
  at: string;
  /** "buy" | "sell". */
  kind: "buy" | "sell";
  /** The game's own shop token, e.g. `TDD_SCShop-001`, `SCShop_Admin_Area18`. */
  shopName: string | null;
  shopId: string | null;
  /** Joins directly to `data/commodities.json`'s top-level key. */
  resourceGuid: string | null;
  /** SCU, converted from the log's centiSCU. */
  scu: number | null;
  /** aUEC per SCU, from `shopPricePerCentiSCU` x 100. */
  pricePerScu: number | null;
  /** Total aUEC for the transaction, as the log states it. */
  total: number | null;
  /** SCU per box. */
  boxScu: number | null;
  unitAmount: number | null;
  /** `ResourceContainer` on a sell, absent on a buy. It is what tells you whether `quantity`
   *  counted centiSCU or containers, so it is kept rather than collapsed away. */
  transactionMode: string | null;
  /** 🔑 True = straight into the ship. False = waiting on the freight elevator. Proven, not
   *  inferred - see the file header. Null when the field was absent. */
  autoLoaded: boolean | null;
}

/** What a shop offers, off `AddingCommodityBox`. An IN-GAME source of the box sizes a terminal
 *  actually handles, which is finer than UEX's single `max_container_size`. */
export interface ShopOffer {
  at: string;
  shopName: string | null;
  shopId: string | null;
  /** As the game writes it, e.g. `ResourceType.Waste`. */
  commodityToken: string | null;
  boxSizes: number[];
}

export interface TradeLogEvent {
  purchase?: CommodityPurchase;
  offer?: ShopOffer;
  /** A CommodityUIProvider method this parser does not model. Surfaced so a new verb announces
   *  itself instead of being silently discarded. */
  unknownMethod?: string;
}

const TS = /^<([^>]+)>/;
const METHOD = /<CEntityComponentCommodityUIProvider::([A-Za-z0-9_]+)/;

/** Methods we deliberately ignore: pure UI churn with nothing to record. */
const IGNORED = new Set([
  "ClSetSelectedPlayerLocationInfo",
  "CreateAmmoResourceContainerEntity",
]);

/**
 * Parse one log line. Returns null for anything that is not a CommodityUIProvider line, so this
 * is cheap to call on every line of the watcher's stream.
 */
export function parseTradeLine(line: string): TradeLogEvent | null {
  const method = METHOD.exec(line);
  if (!method) return null;
  const name = method[1];
  const at = TS.exec(line)?.[1] ?? "";
  const f = fields(line);

  if (name === "SendCommodityBuyRequest" || name === "SendCommoditySellRequest") {
    const auto = f.get("autoLoading");
    const boxScu = fnum(f, "boxScu") ?? fnum(f, "boxSize");
    const unitAmount = fnum(f, "unitAmount");

    // 🔴 THE UNIT IS READ, NEVER ASSUMED. A buy writes `quantity[100.000000 cSCU]`; a sell writes
    // `quantity[1]` meaning one container. Assuming centiSCU on both turns a 1 SCU sale into
    // 0.01 SCU. The raw field text is the only thing that says which, so keep it.
    const rawQty = f.get("quantity");
    const qty = rawQty === undefined ? null : Number.parseFloat(rawQty);
    const inCentiScu = !!rawQty && /cscu/i.test(rawQty);
    let scu: number | null = null;
    if (qty !== null && Number.isFinite(qty)) {
      // 🔴 A SELL'S `quantity` IS ALREADY SCU. It was read as a CONTAINER COUNT and multiplied
      // by the box size, which is right only when boxSize is 1 - and every sample this parser
      // was written from had boxSize[1], where 1 x 1 = 1 hides the difference.
      //
      // Sub's real Degnous Root sale proves it. `quantity[10] boxSize[2] unitAmount[5]` was TEN
      // SCU: the BUY of the same goods said `quantity[1000 cSCU]`, and 5 boxes x 2 SCU = 10
      // agrees. Multiplying gave twenty, which halved the per-SCU price, halved the revenue,
      // and reported a +142,830 aUEC profit as a -152,270 LOSS - with a phantom 10 SCU left
      // over that landed in `unmatched` as a duplicate sale.
      scu = inCentiScu ? qty / 100 : qty;
    }

    // A buy states the per-SCU price outright; a sell does not, so derive it. Never the other way
    // round - a stated figure always beats one of ours.
    const perCenti = fnum(f, "shopPricePerCentiSCU");
    const total = fnum(f, "price") ?? fnum(f, "amount");
    let pricePerScu: number | null = perCenti === null ? null : perCenti * 100;
    if (pricePerScu === null && total !== null && scu !== null && scu > 0) pricePerScu = total / scu;

    return {
      purchase: {
        at,
        kind: name === "SendCommodityBuyRequest" ? "buy" : "sell",
        shopName: f.get("shopName") ?? null,
        shopId: f.get("shopId") ?? null,
        resourceGuid: f.get("resourceGUID") ?? null,
        scu,
        pricePerScu,
        total,
        boxScu,
        unitAmount,
        /** Present on a sell only, e.g. `ResourceContainer`. It is what makes `quantity` legible. */
        transactionMode: f.get("transactionMode") ?? null,
        autoLoaded: auto === undefined ? null : auto === "1",
      },
    };
  }

  if (name === "LoadShopInventoryData" || name === "AddPlayerCommodityItem") {
    // ⚠️ `boxSize` repeats on these lines ("Available Box Sizes: boxSize[1] boxSize[2] ..."), and
    // `fields()` keeps only the first of a repeated key on purpose - so collect them separately.
    const sizes: number[] = [];
    const re = /boxSize\[([0-9.]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const n = Number.parseFloat(m[1]);
      if (Number.isFinite(n) && n > 0) sizes.push(n);
    }
    const token = f.get("commodityName") ?? null;
    return {
      offer: {
        at,
        shopName: f.get("shopName") ?? null,
        shopId: f.get("shopId") ?? null,
        // An empty `commodityName[]` is normal on `AddPlayerCommodityItem` - it describes a box
        // the PLAYER brought, not something the shop stocks. Keep it null rather than "".
        commodityToken: token ? token : null,
        boxSizes: sizes,
      },
    };
  }

  if (IGNORED.has(name)) return null;
  return { unknownMethod: name };
}
