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
 *
 * -- 🔴 A SELL DOES NOT STATE A VOLUME, AND THE APP PUBLISHED ONE ANYWAY ----------------------
 *
 * Measured 2026-08-24 (flight `sellvolume`) over the shared-log corpus, re-derived from the raw
 * rows rather than from the earlier flight's intermediate file, and deduplicated on contributor +
 * the game's own millisecond timestamp because the corpus re-uploads a growing live log:
 *
 *   204 confirmed commodity SELLS   |   45 BUYS
 *   110 of the 204 sells (53.9%) carry an EMPTY `Cargo Box Data:` - the phrase with nothing after
 *   it but the `[Team_...]` tags. 45 of 45 BUYS carry a manifest. The defect is sell-only.
 *
 * 🔑 **WHAT THE EMPTY-MANIFEST SELLS ARE.** Ranked by count: Dolivine, Hadanite, Beradom,
 * Glacosite, Sadaryx, Feynmaline, Aphorite, Beryl, Aslarite, Corundum - hand-mined gems, carried
 * in PERSONAL INVENTORY and sold at a TDD commodity exchange. There is no box data because there
 * are no boxes. **SCU is not an unknown unit for these, it is the wrong one.** A price-per-SCU for
 * Hadanite is not an uncertain number; it is a meaningless one, and the app's assumption that
 * everything sold is cargo is what was actually wrong.
 *
 * ⚠️ **BUT IT IS NOT ONLY GEMS, so do not gate on a commodity list.** 10 commodities appear on
 * BOTH sides - Tungsten, Iron, Aluminum, Gold, Laranite, Copper, Torite, Borase, Hephaestanite and
 * Recycled Material Composite all have empty-manifest sells too (17 of them). Ordinary cargo can
 * reach a terminal without a manifest. The MANIFEST is the test, never the commodity.
 *
 * 🔑 **THE DISCRIMINATOR THAT PROVES THEY ARE PARTIAL, NOT NOISE.** Against the boxed reading for
 * the same commodity at the same terminal, an empty-manifest sell prices at min 0.008x, median
 * 0.264x, **max 1.000x**. The CEILING is the evidence: if the game merely omitted the field at
 * random the two sets would overlap in both directions. They never exceed it, because `quantity`
 * has been rounded UP to a whole container the goods do not fill.
 *
 * 🔴 **AND THE RESIDUAL, WHICH IS NOT FIXED HERE AND MUST NOT BE FORGOTTEN: A BOXED SELL'S VOLUME
 * IS A CEILING TOO.** 16 groups of sells declare BYTE-IDENTICAL volumes at the same terminal for
 * the same commodity (same `quantity`, `boxSize`, `unitAmount`); **6 of the 16 disagree on the
 * total, the worst by 11.56x** (`q1 b1 u1` at Levski: 946 aUEC against 10,933). The cleanest
 * example is Lindinium at TDD Orison, four sells inside 20 seconds:
 *
 *     quantity[4] boxSize[4] unitAmount[1]  amount[202927]   -> 50,732/SCU   (UEX says ~51,000)
 *     quantity[1] boxSize[1] unitAmount[1]  amount[ 47249]   -> 47,249/SCU   (~0.93 SCU)
 *     quantity[1] boxSize[1] unitAmount[1]  amount[ 31380]   -> 31,380/SCU   (~0.62 SCU)
 *
 * Two identical declarations, 7 s apart, 1.5x apart in price. So `quantity` is the CEILING of the
 * real volume in every case and the manifest only tells you a container exists, not that it is
 * full. Across boxed sells in multi-sample groups, 24 of 69 sit below their group's best reading.
 *
 * ⚠️ **THIS FLIGHT DELIBERATELY DID NOT ACT ON THAT.** Sub's ruling was about a sell with no
 * volume, and marking EVERY sell unknown would empty his Ledger of closed runs - the feature he
 * has said he needs to trust before trading again. The bounded-by-one-container error a boxed sell
 * carries is a precision problem; the empty-manifest one is a 125x category error. If this is ever
 * revisited, the honest framing is already available: `total / quantity` is a LOWER BOUND on the
 * price, which this app already knows how to render (the reputation floors).
 *
 * 🔑 **`total` IS TRUE IN EVERY CASE.** The player was paid that many aUEC at that terminal at that
 * moment. That is what lets an unknown-volume sale be recorded rather than dropped - see
 * `TradeJournal.apply`, which books it as revenue with no SCU and no per-SCU figure.
 *
 * -- 🔴 A REQUEST IS NOT A TRANSACTION, AND THAT SHIPPED AS INVENTED PROFIT ---------------------
 *
 * Everything above parses a `Send...Request`. The name is the whole warning and nobody read it: a
 * REQUEST is what the client asked for, and the server is free to refuse. A refused request is
 * still in the log, byte-identical to one that worked.
 *
 * Sub hit it on 2026-08-23. He sold Compboard at Levski, the terminal showed an error, he retried,
 * it errored again, and the Ledger showed two completed sales:
 *
 *   19:57:48.914  SendCommoditySellRequest  amount[242550] quantity[1]
 *   19:57:49.250  [Error] RmToken_CommodityTransactionResponse
 *                 result[TransactionCostMismatch] type[Selling]        <- 336 ms later
 *   19:58:45.444  SendCommoditySellRequest  amount[242550] quantity[1] <- his retry
 *   19:58:45.702  [Error] ... same refusal                             <- 258 ms later
 *
 * **+428,872 aUEC of profit that never existed.** A third attempt at 20:02:41 refused too, so the
 * "genuine sale minutes later" in the first write-up of this bug was itself a failure - see the
 * correction under the census below.
 *
 * -- THE CENSUS THAT DECIDES THE RULE (533 files, 1.47 GB, every rotated log on Sub's disk) -----
 *
 *   65 `Send...Request` lines   |   39 `RmToken_CommodityTransactionResponse` lines
 *
 * 🔑 **EVERY ONE OF THE 39 IS AN `[Error]`. A SUCCESS EMITS NOTHING AT ALL.** So the rule is
 * "commit unless a refusal arrives", NEVER "commit when a success arrives" - the second would
 * throw away all 26 successful trades in the corpus. This was worth re-measuring rather than
 * taking from one day's log: one session could have been a quiet build.
 *
 * 🔑 **THE PAIRING IS A BIJECTION.** Every response has a send before it (0 orphans) and no
 * response was the nearest-following one for two different sends. Nothing has to be guessed about
 * which request a refusal belongs to in any session on record.
 *
 * 🔑 **THE TWO NUMBERS THAT SIZE THE WINDOW, and they are far enough apart to make the choice
 * uncontroversial:**
 *   - a refusal lands **158 ms min / 243 ms median / 565 ms MAX** after its request;
 *   - the closest two requests ever get, in any session, is **3,655 ms**.
 * `CONFIRM_WINDOW_MS` = 2,000 sits between them: 3.5x the slowest refusal on record, and a little
 * over half the tightest request spacing. Too short re-books the phantom sales; too long lets a
 * refusal claim an EARLIER request that really did succeed.
 *
 * ⚠️ **THE REFUSAL NAMES NO COMMODITY AND NO AMOUNT** - only `playerId`, `result` and
 * `type[Selling|Buying]`. So the match is by proximity and direction, and it can never be by
 * `resourceGUID`. Three `result` values are on record: `TransactionCostMismatch` (2026-08-23),
 * `EntityQueryFailed` (x24) and `WaitingForPendingResult` (x12). They are recorded, never
 * interpreted - the app has no business deciding which refusals are "real" ones.
 *
 * ⚠️ **ALL 39 ARE `type[Selling]`.** Not one refused BUY is on record - and that is a fact about
 * Sub's 13 buys, not about the game, since the field exists and names a direction. The direction is
 * matched both ways; nothing here assumes selling.
 *
 * ⚠️ **The corroborating positive signal is DELIBERATELY UNUSED.** A successful sale is followed by
 * a shop-inventory reload (`AddingCommodityBox`) because the shop's stock changed - but that same
 * reload fires whenever a kiosk is opened, so building on it would confirm a refused sale for any
 * player who re-opened the terminal to try again. Which is exactly what Sub did, three times.
 *
 * 🔑 **A held request costs LATENCY, and the number is measured rather than hoped for.** Feeding
 * every send in the corpus through a 2,000 ms window, the next log line able to release it arrives
 * a median 5.6 s later, p90 20 s, worst 54 s (and 0 of 65 reached end-of-file still held). Half a
 * minute of a trade not being listed is the price of never listing one that did not happen.
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

/**
 * 🔴 HOW MUCH CHANGED HANDS — OR THAT WE DO NOT KNOW, AS A SHAPE RATHER THAN A NULL.
 *
 * A caller cannot reach `scu` without first proving `known`, so there is no `?? 0`, no
 * `Number(x) || 0` and no accidental read of a figure the game never stated. That is the whole
 * reason this is a union instead of `number | null`: the previous shape compiled fine while every
 * consumer quietly defaulted an unknown to a number.
 */
export type Volume =
  | { known: true; scu: number }
  | { known: false; why: VolumeUnknown };

/** Why a volume could not be read. One value today; a union so a second reason cannot be added as
 *  a bare boolean and lose the distinction. */
export type VolumeUnknown = "sell-states-no-cargo-boxes";

/**
 * 🔴 aUEC PER SCU — AND WHETHER THE GAME SAID SO OR WE DIVIDED.
 *
 * `source` is not decoration. A buy carries `shopPricePerCentiSCU`, which is the shop's own number;
 * a sell carries nothing of the kind and the figure is `total / volume`, which is only as good as
 * the volume. Anything publishing a price needs to be able to tell those apart, and the same
 * distinction is what stops an override changing the answer AND the provenance.
 */
export type UnitPrice =
  | { known: true; perScu: number; source: "stated" | "derived" }
  | { known: false; why: UnitPriceUnknown };

export type UnitPriceUnknown = "no-stated-price-and-no-volume";

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
  /**
   * How much, when the log says. 🔴 A SELL WITH NO CARGO-BOX MANIFEST IS `known: false` — see
   * "A SELL DOES NOT STATE A VOLUME" in the file header. Never default it to a number.
   */
  volume: Volume;
  /** aUEC per SCU, stated on a buy and derived on a sell. Unknown when the volume is. */
  unitPrice: UnitPrice;
  /** Total aUEC for the transaction, as the log states it. 🔑 THIS IS ALWAYS TRUE, even when the
   *  volume is not: the player really was paid this many aUEC at this terminal. It is what lets an
   *  unknown-volume sale be RECORDED rather than dropped. */
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
  /**
   * 🔴 WHETHER THE SERVER ACCEPTED IT. `parseTradeLine` ALWAYS LEAVES THIS NULL, because one line
   * cannot know - the refusal, if there is one, is a different line up to 565 ms later. Only
   * `TradeConfirmations` sets it: `true` when the window passed in silence, `false` when a refusal
   * claimed it.
   *
   * 🔑 IT IS A FIELD RATHER THAN AN ABSENCE ON PURPOSE. Refused transactions must never enter the
   * price pool - a price nobody paid is not a price - and "we just don't emit those" is a
   * distinction that survives exactly until the next person writes an exporter. Anything consuming
   * a `CommodityPurchase` has to look at this to use it.
   */
  confirmed: boolean | null;
  /** The `result[...]` token off the refusal that killed it, e.g. `TransactionCostMismatch`.
   *  Recorded verbatim and never interpreted. Null unless `confirmed === false`. */
  refusedBecause: string | null;
}

/**
 * The server refusing a commodity request. All 39 in the corpus are `[Error]` lines - see the
 * census in the file header.
 */
export interface CommodityResponse {
  at: string;
  /**
   * 🔴 TRUE ONLY FOR AN `[Error]` LINE. Nothing in this app should decide that an unfamiliar
   * response kind means failure: every observed response is an error, so a response that is NOT one
   * is a shape we have never seen, and the safe reading of a shape we have never seen is "this
   * refuses nothing". A future success line would then leave the commit rule exactly as it is.
   */
  refused: boolean;
  /** `TransactionCostMismatch` | `EntityQueryFailed` | `WaitingForPendingResult`, so far. */
  result: string | null;
  /** Off `type[Selling|Buying]`. Null when the field is absent, which matches either direction. */
  direction: "buy" | "sell" | null;
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
  /** 🔴 The server's answer. Only ever a refusal so far - a success says nothing at all, which is
   *  why the commit rule is "unless" rather than "when". */
  response?: CommodityResponse;
  /** A CommodityUIProvider method this parser does not model. Surfaced so a new verb announces
   *  itself instead of being silently discarded. */
  unknownMethod?: string;
}

const TS = /^<([^>]+)>/;
/** `[Notice]` / `[Error]` / ... The severity is what separates a refusal from any other response,
 *  so it is read rather than assumed from the method name. */
const SEVERITY = /^<[^>]+>\s*\[([A-Za-z]+)\]/;
const METHOD = /<CEntityComponentCommodityUIProvider::([A-Za-z0-9_]+)/;

/** Every line this parser cares about contains this. Exported so a bulk replay's cheap prefilter
 *  cannot drift from what the parser handles — narrowing it to `::Send` is what would silently
 *  skip every refusal and re-open the invented-profit bug. */
export const TRADE_LOG_MARKER = "CEntityComponentCommodityUIProvider::";

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

    // 🔴 THE CARGO-BOX MANIFEST IS WHAT MAKES A SELL'S VOLUME MEAN ANYTHING. Read from the raw
    // line rather than from `boxScu`, because the question is whether the game listed ANY
    // container at all - `fields()` keeps the first of a repeated key and would answer a
    // different question on a multi-box line.
    const boxTail = line.split("Cargo Box Data:")[1];
    const hasManifest = boxTail !== undefined && boxTail.includes("boxSize[");
    const kind = name === "SendCommodityBuyRequest" ? "buy" : "sell";

    // A BUY states its quantity in cSCU with real precision and states the unit price outright, so
    // neither depends on the manifest. A SELL with no manifest states neither.
    const volume: Volume = kind === "sell" && !hasManifest
      ? { known: false, why: "sell-states-no-cargo-boxes" }
      : scu !== null && scu > 0
        ? { known: true, scu }
        : { known: false, why: "sell-states-no-cargo-boxes" };

    // A buy states the per-SCU price outright; a sell does not, so derive it. Never the other way
    // round - a stated figure always beats one of ours, and a derived one is only as good as the
    // volume it was divided by.
    const perCenti = fnum(f, "shopPricePerCentiSCU");
    const total = fnum(f, "price") ?? fnum(f, "amount");
    const unitPrice: UnitPrice = perCenti !== null
      ? { known: true, perScu: perCenti * 100, source: "stated" }
      : volume.known && total !== null
        ? { known: true, perScu: total / volume.scu, source: "derived" }
        : { known: false, why: "no-stated-price-and-no-volume" };

    return {
      purchase: {
        at,
        kind,
        shopName: f.get("shopName") ?? null,
        shopId: f.get("shopId") ?? null,
        resourceGuid: f.get("resourceGUID") ?? null,
        volume,
        unitPrice,
        total,
        boxScu,
        unitAmount,
        /** Present on a sell only, e.g. `ResourceContainer`. It is what makes `quantity` legible. */
        transactionMode: f.get("transactionMode") ?? null,
        autoLoaded: auto === undefined ? null : auto === "1",
        // 🔴 A SINGLE LINE CANNOT KNOW. Left null here and set only by `TradeConfirmations`.
        confirmed: null,
        refusedBecause: null,
      },
    };
  }

  if (name === "RmToken_CommodityTransactionResponse") {
    const t = (f.get("type") ?? "").toLowerCase();
    return {
      response: {
        at,
        refused: (SEVERITY.exec(line)?.[1] ?? "") === "Error",
        result: f.get("result") ?? null,
        direction: t === "selling" ? "sell" : t === "buying" ? "buy" : null,
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

/**
 * 🔴 THE ONLY THING ALLOWED TO SAY A TRANSACTION HAPPENED.
 *
 * `parseTradeLine` reads a REQUEST. This holds it, watches for the refusal that would kill it, and
 * releases it once the window has passed in silence. The full reasoning and the census that sized
 * the window are in the file header; the rules the code has to keep are:
 *
 * 🔑 **COMMIT UNLESS REFUSED, never commit-when-confirmed.** A success emits no line at all, so
 * waiting for one discards every successful trade in the corpus.
 *
 * 🔑 **THE CLOCK IS THE LOG'S, NEVER THE WALL'S.** A held request is released by the arrival of a
 * LINE whose timestamp is past the window, and by `flush()` at end of stream. A `setTimeout` would
 * behave one way while tailing and another while replaying a rotated log, and the difference would
 * only ever show up as a wrong number in somebody's journal weeks later. Feed EVERY line, not only
 * the commodity ones - the non-commodity ones are what move the clock while tailing.
 *
 * 🔑 **ONLY ONE REQUEST IS EVER RESIDENT, AND THE REASON IS NOT THE ONE YOU REACH FOR.** The tower
 * asked what happens when a refusal lands with a queue behind it — a fair question, because the
 * census measured request SPACING and spacing is not residency. The answer is that a REQUEST line
 * is itself a stamped line, so it advances the clock and releases the request before it. With the
 * tightest pair of requests 3,655 ms apart against a 2,000 ms window, the previous one is always
 * already gone. **Both measured numbers are load-bearing**: raise the window past the spacing and
 * several really do pile up.
 *
 * 🔑 **THE NEWEST MATCH IS A TIE-BREAK FOR A REGIME THE SHIPPED WINDOW NEVER ENTERS, not the thing
 * keeping this correct.** Worth stating plainly because it was got wrong once, in this very file: a
 * source control flipping the iteration in refuse() to oldest-first comes back GREEN at the shipped
 * window, because the window filter alone already excludes every older request. The ordering only
 * becomes observable — and the control only reddens — once the window is widened past the request
 * spacing, which is exactly how the suite exercises it.
 *
 * ⚠️ Instances are cheap and hold at most a handful of entries. Use ONE for the live stream so the
 * seed and the watcher hand over inside the same window, and a FRESH one per file for a bulk
 * replay of complete rotated logs, flushing at the end of each.
 */
export class TradeConfirmations {
  /** 3.5x the slowest refusal on record (565 ms), and comfortably inside the tightest gap ever
   *  seen between two requests (3,655 ms). Both bounds are measured - see the file header. */
  static readonly WINDOW_MS = 2000;

  private readonly windowMs: number;
  private held: { p: CommodityPurchase; ms: number }[] = [];
  private clock = 0;
  private refusals: CommodityPurchase[] = [];

  /** Refused transactions are kept, bounded, so a caller can REPORT them. They must never reach
   *  the journal or the price pool, but "it silently vanished" is its own bug report. */
  private static readonly MAX_REFUSALS = 50;

  constructor(windowMs: number = TradeConfirmations.WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Feed one raw log line, IN LOG ORDER. Returns the purchases this line confirmed - usually none,
   * and never the one on this line.
   */
  line(raw: string): CommodityPurchase[] {
    const at = TS.exec(raw)?.[1];
    const ms = at ? Date.parse(at) : NaN;
    // A line with no readable timestamp (a continuation, a truncated write) moves nothing. It is
    // not evidence that time passed, so it must not release anything.
    const stamped = Number.isFinite(ms);

    // Not a commodity line at all: its only job is to move the clock. This is the overwhelmingly
    // common case and it costs one indexOf.
    if (!raw.includes(TRADE_LOG_MARKER)) {
      return stamped ? this.advance(ms) : [];
    }

    const ev = parseTradeLine(raw);

    // 🔴 THE REFUSAL IS HANDLED BEFORE THE CLOCK MOVES. Advancing first would be harmless at the
    // measured latencies, and would quietly stop working the day a refusal arrived a hair outside
    // the window - the request would already be gone and the refusal would find nothing to kill.
    if (ev?.response) {
      if (ev.response.refused) this.refuse(ev.response);
      return stamped ? this.advance(ms) : [];
    }

    const out = stamped ? this.advance(ms) : [];
    if (ev?.purchase && stamped) this.held.push({ p: ev.purchase, ms });
    return out;
  }

  /**
   * End of stream: everything still held is confirmed.
   *
   * 🔑 THAT IS THE SAME RULE, NOT AN EXCEPTION TO IT. A complete file that never carried a refusal
   * for a request is a file that says the request went through. Call it at the end of each rotated
   * log in a bulk replay; do NOT call it at the seam between the startup seed and the live watcher,
   * where the next bytes of the very same file are still to come.
   */
  flush(): CommodityPurchase[] {
    const out = this.held.map((h) => confirm(h.p));
    this.held = [];
    return out;
  }

  /** What is being held right now, oldest first. A caller may want to say "one trade is still
   *  waiting on the server" rather than show nothing and look broken. */
  pending(): CommodityPurchase[] {
    return this.held.map((h) => h.p);
  }

  /** Refused transactions, newest last. Bounded. */
  refused(): CommodityPurchase[] {
    return [...this.refusals];
  }

  /** Release anything whose window closed before `ms`. */
  private advance(ms: number): CommodityPurchase[] {
    if (ms > this.clock) this.clock = ms;
    const out: CommodityPurchase[] = [];
    const keep: { p: CommodityPurchase; ms: number }[] = [];
    for (const h of this.held) {
      if (this.clock - h.ms > this.windowMs) out.push(confirm(h.p));
      else keep.push(h);
    }
    this.held = keep;
    return out;
  }

  private refuse(r: CommodityResponse): void {
    // Newest first: the server is answering the most recent request it was given.
    for (let i = this.held.length - 1; i >= 0; i--) {
      const h = this.held[i];
      const rMs = Date.parse(r.at);
      if (Number.isFinite(rMs) && rMs - h.ms > this.windowMs) continue;
      if (r.direction && r.direction !== h.p.kind) continue;
      this.held.splice(i, 1);
      this.refusals.push({ ...h.p, confirmed: false, refusedBecause: r.result });
      if (this.refusals.length > TradeConfirmations.MAX_REFUSALS) this.refusals.shift();
      return;
    }
    // ⚠️ No held request to kill. Never observed - all 39 refusals in the corpus have a send
    // before them - but a refusal for something we never saw asked is a real possibility once a
    // player starts the app mid-transaction, and it must not throw or invent a victim.
  }
}

function confirm(p: CommodityPurchase): CommodityPurchase {
  return { ...p, confirmed: true, refusedBecause: null };
}
