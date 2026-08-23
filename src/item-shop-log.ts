/**
 * ITEM SHOPS — READING A REAL ITEM PURCHASE OUT OF `game.log`.
 *
 * The sibling of `trade-log.ts`, and deliberately NOT part of it: the two subsystems share a
 * shape and almost nothing else. `trade-log.ts` reads BULK COMMODITIES out of
 * `CEntityComponentCommodityUIProvider`; this file reads ITEMS — gear, weapons, components,
 * magazines, food, drink, ship weapons — and the confirmation rule is the exact OPPOSITE.
 * Copying the commodity gate across would book every refused purchase in the game.
 *
 * Sub found the gap himself: he bought a drink at an item terminal for 7 aUEC and expected the
 * Verse Finder to move. It could not — nothing in the app had ever read these lines.
 *
 * ── THE CENSUS (533 rotated logs, 1.47 GB, every log on Sub's disk, 2026-08-23) ──────────────
 *
 * Measured with `npm run measure:itemshops`, which re-derives every number below and EXITS
 * NON-ZERO when one is overturned. A census in a comment is a claim that rots; a census you can
 * re-run is a fact.
 *
 *   1,591 shop lines   ·   382 purchases   ·   402 responses   ·   159 files
 *
 * 🔴 THERE ARE THREE PURCHASE VERBS ACROSS TWO COMPONENTS, NOT ONE. The brief named only
 * `SendShopBuyRequest`, which is 239 of the 382 — 63%. Enumerating the components instead of
 * grepping for the named verb found the other 143 (plus 20 rentals):
 *
 *   CEntityComponentShopUIProvider::SendShopBuyRequest            239   kiosk shops
 *   CEntityComponentShoppingProvider::SendStandardItemBuyRequest  143   counter/vending shops
 *   CEntityComponentShoppingProvider::SendRentalRequest            20   vehicle rentals
 *
 * They are NOT two views of one event: cross-checked for the same item at the same price within
 * five seconds in the same file, there are **0 duplicates**. Parsing only one loses real
 * purchases; parsing both and assuming duplication would lose them too.
 *
 * ── 🔴 `client_price` IS THE TOTAL, NOT THE UNIT PRICE — AND 26.7% OF BUYS ARE qty > 1 ───────
 *
 * The single most expensive mistake available here, and it is invisible at qty 1, which is 73%
 * of the corpus and every example in the brief. Measured over every (item, shop) pair observed
 * at two different quantities: **37 pairs say TOTAL, 0 say UNIT.** The cleanest is one item at
 * one shop at three quantities:
 *
 *   AMRS_LaserCannon_S4 @ SCShop_Centermass_Area18 — qty1 = 176,093 · qty2 = 352,186 · qty4 = 704,372
 *
 * So the price of the thing is `client_price / quantity`. Publishing the raw field would have
 * reported a 6-pack of FS-9 magazines at 3,150 aUEC instead of 525, and 41 rifle magazines at
 * 26,404 instead of 644 — 102 of 382 purchases wrong, by up to 41x.
 *
 * ⚠️ One pair of 38 disagrees by 0.4% (behr_lmg at Pyro RStop: 520 at qty1, 522 at qty5, sessions
 * apart). That is the shop price DRIFTING between sessions, not the invariant failing — which is
 * itself the argument for storing observations individually with their timestamps rather than
 * folding them into a running average.
 *
 * ── 🔴 ITEM SHOPS ANSWER EXPLICITLY, SO THE RULE IS "COMMIT WHEN CONFIRMED" ──────────────────
 *
 * This is the inversion, and it is the whole reason this file exists separately.
 *
 *   commodities:  a success emits NOTHING. Only failures are logged. -> commit UNLESS refused.
 *   item shops:   EVERY request gets an answer.                      -> commit ONLY on Success.
 *
 *   requests 382   responses 402   ...   and the pairing is a perfect bijection per family:
 *     ShopUIProvider    239 requests / 239 responses — paired 239, 0 orphans, 0 unanswered
 *     ShoppingProvider  163 requests / 163 responses — paired 163, 0 orphans, 0 unanswered
 *     (163 = 143 standard buys + 20 rentals, exactly)
 *
 *   result[...] over all 402:  Success 399 · WaitingForPendingResult 2 · InsufficentFunds 1
 *                              (CIG's spelling of "Insufficient". Recorded verbatim, never fixed.)
 *
 * 🔴 SEVERITY IS NOT THE DISCRIMINATOR HERE, AND THAT IS THE TRAP. `trade-log.ts` reads a refusal
 * off the `[Error]` tag, because all 39 commodity responses are errors. Every one of these 402 is
 * a `[Notice]`, INCLUDING the `InsufficentFunds` refusal. Carrying the commodity rule across would
 * mark all 402 as "not refused" and book the failed purchase. The `result[...]` token is the only
 * thing that says what happened.
 *
 * ── 🔴 THE TWO FAMILIES MUST BE MATCHED SEPARATELY ───────────────────────────────────────────
 *
 * A `ShoppingProvider` request is NEVER answered by a `ShopUIProvider` response. Matching them in
 * one pool leaves 143 requests looking unanswered — which is exactly what a first pass reported,
 * and 143 is precisely the `SendStandardItemBuyRequest` count. Two queues, never one.
 *
 * The two responses do not even carry the same fields:
 *   ShopUIProvider   `Received ShopFlowResponse - playerId shopId shopName kioskId kioskState result type`
 *   ShoppingProvider `Shop Flow Response - playerId result`                          <- that is all
 *
 * So `shopId` corroborates the match on one family (**239/239 agree, 0 disagree**) and simply does
 * not exist on the other. It is used where it exists and never required, because requiring it
 * would silently discard every ShoppingProvider purchase.
 *
 * ── FIFO, NOT NEWEST-FIRST — AND WHY IT IS THE OPPOSITE OF THE COMMODITY GATE ────────────────
 *
 * `TradeConfirmations.refuse()` claims the NEWEST held request, because a refusal answers the most
 * recent thing asked. Here the queue is a real request/response pipeline with a bijection, so a
 * response answers the OLDEST outstanding request. Measured: scanning every file for a response
 * arriving before any request, **0 violations in both families**, and the deepest the queue ever
 * gets is **2**.
 *
 * The one place it bites is worth writing out, because it is the only multi-deep case on record:
 *
 *   02:46:59.403  SendShopBuyRequest  Drink_bottle_cruz qty=11  price=77
 *   02:48:03.966  SendShopBuyRequest  ksar_smg_mag      qty=21  price=7287
 *   02:48:04.190  RmShopFlowResponse  WaitingForPendingResult
 *   02:48:16.726  SendShopBuyRequest  ksar_smg_mag      qty=21  price=7287   <- the player retries
 *   02:48:16.904  RmShopFlowResponse  WaitingForPendingResult
 *   02:48:32.101  RmShopFlowResponse  Success
 *
 * Three requests, three responses, and only the last is a Success — so exactly one purchase is
 * booked. The drink is dropped unconfirmed. We genuinely cannot tell whether it went through, and
 * "we did not see it succeed" is the honest and safe answer: a price nobody paid is not a price.
 *
 * ── LATENCY AND THE HOLD WINDOW ──────────────────────────────────────────────────────────────
 *
 *   ShopUIProvider    177 ms min · 516 ms median · 1,321 ms p90 · 64,787 ms MAX
 *   ShoppingProvider  180 ms min · 481 ms median · 928 ms p90 · 6,137 ms max
 *
 * 🔴 THE MAX IS THE NUMBER THAT MATTERS, NOT THE MEDIAN, AND A FIRST CUT GOT THIS WRONG. Sizing
 * the hold window off p90 (30 s looked enormously generous against 1.3 s) evicted the one request
 * that really waited 64.8 s, which shifted every later response one place up the queue and lost a
 * real purchase entirely. See `MAX_HOLD_MS` for the full reasoning; the window is 300 s.
 *
 * 🔴 AND THE CLOCK IS THE LOG'S, NEVER THE WALL'S — the same rule the commodity gate keeps, for
 * the same reason. A `setTimeout` behaves one way tailing a live log and another replaying a
 * rotated one, and the difference only ever shows up as a wrong number weeks later. Feed EVERY
 * line: the boring ones are what move the clock.
 *
 * ── 🔴 `flush()` IS THE INVERSION AGAIN, AND GETTING IT WRONG IS THE WHOLE BUG ───────────────
 *
 * `TradeConfirmations.flush()` CONFIRMS everything still held — correct there, because silence
 * means success. Here silence means we never saw the server agree, so `endOfStream()` confirms
 * NOTHING and returns the abandoned requests so a caller can say so. A `flush()` that behaved
 * like the commodity one would book every unanswered purchase in every rotated log.
 *
 * ── WHAT IS DELIBERATELY NOT MODELLED ────────────────────────────────────────────────────────
 *
 * ⚠️ NO ITEM SELLS EXIST. All 402 responses are `type[Buying]`; there is no sell verb on either
 * component anywhere in 533 logs. So this file reads a BUY price and nothing else, and the absence
 * is a fact about the corpus rather than a decision.
 *
 * ⚠️ RENTALS ARE PARSED AND MARKED, NEVER PRICED. All 20 `SendRentalRequest` lines carry
 * `client_price[0.000000]` (the IAE free-fly rentals), and a 0 is not a price. They are kept as
 * `kind: "rent"` so they announce themselves rather than vanishing, and `observedUnitPrice()`
 * returns null for them. Same opt-in reasoning as `ItemQuote.k` on the UEX side.
 *
 * ⚠️ `ClGetSelectedLocationData` (371) and `ClOnSubLocationsChanged` (19) are `[Error]` UI churn
 * with no transaction in them. Ignored by name, so a genuinely new verb still reports itself
 * through `unknownMethod` instead of being silently dropped.
 */

/** One `key[value]` field. Same shape as the commodity parser's, and separate on purpose: the two
 *  vocabularies are different and a shared helper would invite sharing the vocabulary too. */
function fields(line: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([A-Za-z][A-Za-z0-9_]*)\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

function fnum(f: Map<string, string>, key: string): number | null {
  const raw = f.get(key);
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** Which component emitted the line. The two are separate request/response pipelines and must
 *  never be matched against each other — see the header. */
export type ShopFamily = "ShopUIProvider" | "ShoppingProvider";

export interface ItemPurchase {
  /** ISO timestamp off the log line. */
  at: string;
  family: ShopFamily;
  /** The verb, verbatim, so a reader can tell a counter buy from a kiosk buy. */
  verb: string;
  /** `"rent"` is a vehicle hire, always at `client_price[0]` in the corpus. Never a price. */
  kind: "buy" | "rent";
  /** The game's shop token, e.g. `SCShop_Levski_CargoOffice_ITEM`. THE terminal identity — the
   *  commodity side measured `shopId` to be per-session and re-minted, and there is no reason to
   *  expect this component to differ. */
  shopName: string | null;
  /** Per-session entity id. Recorded because it corroborates the response match on this family,
   *  never used as a terminal key. */
  shopId: string | null;
  kioskId: string | null;
  /** `itemClassGUID`, lowercased. Joins to `ShopItem.u` in the Verse Finder's table at 75.4%
   *  (86 of 114 distinct items bought). No name matching anywhere. */
  itemGuid: string | null;
  /** The game's internal name, e.g. `Drink_bottle_cruz_01_lux_a`. Kept for diagnosis; it is NOT
   *  the display name and must never be shown to a player. */
  itemName: string | null;
  /** How many were bought. 73% of the corpus is 1; the rest is why `unitPrice` exists. */
  quantity: number | null;
  /** `client_price[...]` — the TOTAL for the whole transaction. See the header. */
  totalPrice: number | null;
  /** 🔴 THE PRICE OF ONE, which is what a shop quotes and what the Verse Finder shows.
   *  `totalPrice / quantity`, measured over 37 same-item-same-shop pairs. Null when either half
   *  is missing or the quantity is zero — never silently the total. */
  unitPrice: number | null;
  /** `currencyType[...]`, e.g. `UEC`. Absent on every ShopUIProvider line. */
  currency: string | null;
  /**
   * 🔴 WHETHER THE SERVER AGREED. `parseItemShopLine` ALWAYS leaves this null — one line cannot
   * know, because the answer is a different line up to a few seconds later.
   * `ItemShopConfirmations` sets it: `true` only on an explicit `result[Success]`, `false` on any
   * other stated result, and it stays NULL for a request that was never answered.
   *
   * 🔑 NULL IS NOT SUCCESS. The price pool's rule is that `null` counts as refused; that is right
   * here for a stronger reason than there, since a success is always stated and its absence is
   * therefore real evidence of nothing having happened.
   */
  confirmed: boolean | null;
  /** The `result[...]` token that decided it, verbatim (`Success`, `InsufficentFunds`,
   *  `WaitingForPendingResult`). Null while unanswered. Recorded, never interpreted — the app has
   *  no business ranking which refusals are "real". */
  resultCode: string | null;
}

export interface ItemShopResponse {
  at: string;
  family: ShopFamily;
  /** 🔴 TRUE ONLY FOR A LITERAL `result[Success]`. Anything else — a refusal we know, or a token
   *  no build has ever emitted — is not a success. That asymmetry is deliberate: an unknown result
   *  must never confirm a purchase, whereas the commodity gate's equivalent unknown must never
   *  refuse one. Each errs toward not inventing a transaction. */
  success: boolean;
  result: string | null;
  /** Off `type[Buying]`. All 402 in the corpus are Buying; the field is read rather than assumed
   *  so a future sell announces itself. */
  direction: "buy" | "sell" | null;
  /** Present on ShopUIProvider only. Corroborates the FIFO match (239/239 agree); absent on
   *  ShoppingProvider, where FIFO is all there is. */
  shopId: string | null;
}

export interface ItemShopLogEvent {
  purchase?: ItemPurchase;
  response?: ItemShopResponse;
  /** A verb on one of these components that this parser does not model. Surfaced rather than
   *  dropped, so a new one announces itself — the mechanism that would have caught
   *  `SendStandardItemBuyRequest` years earlier had anything been reading it. */
  unknownMethod?: string;
}

const TS = /^<([^>]+)>/;
const METHOD = /<CEntityComponent(ShopUIProvider|ShoppingProvider)::([A-Za-z0-9_]+)>/;

/**
 * Every line this parser cares about contains this.
 *
 * 🔴 EXPORTED SO A PREFILTER CANNOT DRIFT FROM THE PARSER. The commodity side learned this the
 * expensive way: a bulk replay prefiltered on `::Send`, which matches every request and not one
 * refusal, and re-booked every failed sale on the next launch. Narrowing this string to a verb
 * would do the identical damage here, in the opposite direction — it would drop every Success and
 * confirm nothing at all.
 *
 * ⚠️ It matches `CEntityComponentShopUIProvider` AND `CEntityComponentShoppingProvider`, which is
 * why it stops at `Shop`. It also catches `CEntityComponentMiningShopUIProvider` (6 lines) and a
 * handful of `CEntityComponentShop*` — all of which fall through to `unknownMethod` or are not
 * matched by `METHOD` at all. A prefilter is allowed to be broader than the parser; it must never
 * be narrower.
 */
export const ITEM_SHOP_LOG_MARKER = "CEntityComponentShop";

/** The two request verbs that buy an item outright, plus the rental. */
const BUY_VERBS = new Set(["SendShopBuyRequest", "SendStandardItemBuyRequest"]);
const RENT_VERBS = new Set(["SendRentalRequest"]);

/** Pure UI churn on these components — no transaction, nothing to record. Named individually so
 *  an unfamiliar verb still reaches `unknownMethod`. */
const IGNORED = new Set([
  "ClGetSelectedLocationData",
  "ClOnSubLocationsChanged",
  "OnGainedAuthority",
  "RmTokenInventoryIdResponse",
]);

/**
 * Parse one log line. Returns null for anything that is not an item-shop line, so this is cheap
 * to call on every line of the watcher's stream.
 */
export function parseItemShopLine(line: string): ItemShopLogEvent | null {
  const method = METHOD.exec(line);
  if (!method) return null;
  const family = method[1] as ShopFamily;
  const verb = method[2];
  const at = TS.exec(line)?.[1] ?? "";

  if (BUY_VERBS.has(verb) || RENT_VERBS.has(verb)) {
    const f = fields(line);
    const quantity = RENT_VERBS.has(verb) ? 1 : fnum(f, "quantity");
    const totalPrice = fnum(f, "client_price");
    const guid = f.get("itemClassGUID");

    // 🔴 THE UNIT PRICE IS DERIVED, AND ONLY WHEN IT CAN BE. `client_price` is the total for the
    // whole stack (37 measured pairs, 0 against), so the price of the thing is total/quantity.
    // A missing or zero quantity yields null rather than falling back to the total: a total
    // presented as a unit price is not an approximation, it is a wrong number, and at qty 41 it is
    // wrong by 41x.
    //
    // 🔑 A NON-POSITIVE TOTAL ALSO YIELDS NULL, not 0. Every one of the 20 rentals logs
    // `client_price[0.000000]`, and a 0 that flows downstream as a number is a free ship — it
    // would sort to the top of any cheapest-first list and read as the best deal in the game.
    // "We have no price for this" has to be expressible, and null is how.
    const unitPrice =
      totalPrice !== null && totalPrice > 0 && quantity !== null && quantity > 0
        ? totalPrice / quantity
        : null;

    return {
      purchase: {
        at,
        family,
        verb,
        kind: RENT_VERBS.has(verb) ? "rent" : "buy",
        shopName: f.get("shopName") ?? null,
        shopId: f.get("shopId") ?? null,
        kioskId: f.get("kioskId") ?? null,
        itemGuid: guid ? guid.toLowerCase() : null,
        itemName: f.get("itemName") ?? null,
        quantity,
        totalPrice,
        unitPrice,
        currency: f.get("currencyType") ?? null,
        // 🔴 One line cannot know. Only the gate sets this.
        confirmed: null,
        resultCode: null,
      },
    };
  }

  if (verb === "RmShopFlowResponse") {
    const f = fields(line);
    const result = f.get("result") ?? null;
    const t = (f.get("type") ?? "").toLowerCase();
    return {
      response: {
        at,
        family,
        // 🔴 The literal token, not the severity. Every one of these lines is a `[Notice]`,
        // including the refusal — see the header.
        success: result === "Success",
        result,
        direction: t === "buying" ? "buy" : t === "selling" ? "sell" : null,
        shopId: f.get("shopId") ?? null,
      },
    };
  }

  if (IGNORED.has(verb)) return null;
  return { unknownMethod: `${family}::${verb}` };
}

/** A request that was never answered. Returned by `endOfStream()` so "we stopped watching before
 *  the server replied" can be reported rather than guessed at in either direction. */
export interface AbandonedPurchase {
  purchase: ItemPurchase;
  /** Why it left the queue: the stream ended, or it aged out of the hold window. */
  reason: "end-of-stream" | "timed-out";
}

/**
 * 🔴 THE ONLY THING ALLOWED TO SAY AN ITEM PURCHASE HAPPENED.
 *
 * `parseItemShopLine` reads a REQUEST. This holds it until the server answers, and releases it as
 * confirmed ONLY on an explicit `result[Success]`.
 *
 * The rules, all measured — reasoning in the file header:
 *
 * 🔑 **COMMIT ONLY WHEN CONFIRMED.** The exact opposite of `TradeConfirmations`. Every item
 * request in 533 logs got an answer; silence here is evidence of nothing having happened, not of
 * success.
 *
 * 🔑 **TWO QUEUES, ONE PER FAMILY.** A ShoppingProvider request is never answered by a
 * ShopUIProvider response. One pool leaves 143 of 382 purchases permanently unconfirmed.
 *
 * 🔑 **A RESPONSE CLAIMS THE OLDEST HELD REQUEST IN ITS FAMILY.** A real pipeline drains FIFO, and
 * the corpus has 0 response-before-request violations with a max queue depth of 2.
 *
 * 🔑 **THE CLOCK IS THE LOG'S.** Held requests age out on the timestamp of an arriving LINE, so
 * live tailing and replaying a rotated log behave identically. Feed every line.
 *
 * ⚠️ Use ONE instance for the live stream so the startup seed and the watcher hand over inside the
 * same queue, and a FRESH one per file for a bulk replay of complete rotated logs, calling
 * `endOfStream()` at the end of each.
 */
export class ItemShopConfirmations {
  /**
   * 🔴 SIZED ABOVE THE SLOWEST REAL ROUND TRIP, WHICH IS 64.8 SECONDS — NOT ABOVE THE TYPICAL ONE.
   *
   * The median is 516 ms and p90 is 1,321 ms, and a first cut used 30 s on the strength of those.
   * It was wrong, and the corpus said so: the one genuinely multi-deep sequence on record has a
   * request waiting **64,787 ms** for its answer, because the shop was wedged — which is precisely
   * what the server was reporting when it said `WaitingForPendingResult`. A 30 s window evicted
   * that request, every later response shifted one place up the queue, and the trailing Success
   * found nothing to confirm: **one real purchase silently lost.**
   *
   * 🔑 The asymmetry that decides the number: evicting too EARLY shifts the whole queue and
   * mis-attributes a Success to the next request — a wrong price for a real item. Evicting too
   * LATE costs nothing measurable, because `endOfStream()` bounds the queue at every file boundary
   * and the queue never gets deeper than 2. So this is generous on purpose: 4.6x the worst
   * observed latency, the same order of safety factor the commodity gate's window carries.
   *
   * It exists at all only so a request whose answer was never written — the app attaching
   * mid-purchase, a crash between the two lines — cannot sit in the queue and be claimed by an
   * unrelated Success minutes later. `measure:itemshops` fails if the worst real latency ever
   * grows past it.
   */
  static readonly MAX_HOLD_MS = 300_000;

  /** The deepest the queue is ever measured to get is 2. This is a runaway guard, not a model of
   *  anything: if it is ever reached, something is wrong and the OLDEST request is the one least
   *  likely to still be live. */
  static readonly MAX_HELD = 16;

  private readonly maxHoldMs: number;
  private queues: Record<ShopFamily, { p: ItemPurchase; ms: number }[]> = {
    ShopUIProvider: [],
    ShoppingProvider: [],
  };
  private clock = 0;
  private refusals: ItemPurchase[] = [];
  private abandoned: AbandonedPurchase[] = [];

  /** Refused and abandoned purchases are kept, bounded, so a caller can REPORT them. They must
   *  never reach a price store — but "it silently vanished" is its own bug report. */
  private static readonly MAX_KEPT = 50;

  constructor(maxHoldMs: number = ItemShopConfirmations.MAX_HOLD_MS) {
    this.maxHoldMs = maxHoldMs;
  }

  /**
   * Feed one raw log line, IN LOG ORDER. Returns the purchases this line CONFIRMED — usually
   * none, and never the one on this line.
   */
  line(raw: string): ItemPurchase[] {
    const at = TS.exec(raw)?.[1];
    const ms = at ? Date.parse(at) : NaN;
    // A line with no readable timestamp (a continuation, a truncated write) is not evidence that
    // time passed, so it must not age anything out.
    const stamped = Number.isFinite(ms);

    // Not a shop line at all: its only job is to move the clock. The overwhelmingly common case,
    // and it costs one indexOf.
    if (!raw.includes(ITEM_SHOP_LOG_MARKER)) {
      if (stamped) this.advance(ms);
      return [];
    }

    const ev = parseItemShopLine(raw);

    // 🔴 THE RESPONSE IS HANDLED BEFORE THE CLOCK MOVES, so a reply arriving a hair outside the
    // hold window still finds its request instead of missing an already-evicted one. Same ordering
    // the commodity gate keeps, and for the same reason.
    if (ev?.response) {
      const out = this.settle(ev.response);
      if (stamped) this.advance(ms);
      return out;
    }

    if (stamped) this.advance(ms);
    if (ev?.purchase && stamped) {
      const q = this.queues[ev.purchase.family];
      q.push({ p: ev.purchase, ms });
      while (q.length > ItemShopConfirmations.MAX_HELD) {
        const dropped = q.shift();
        if (dropped) this.note({ purchase: dropped.p, reason: "timed-out" });
      }
    }
    return [];
  }

  /**
   * End of stream. 🔴 CONFIRMS NOTHING — the inversion that matters most.
   *
   * `TradeConfirmations.flush()` confirms everything still held, because for commodities a
   * complete file with no refusal is a file saying the request went through. Here a complete file
   * with no Success is a file saying we never saw the server agree. Returns what was abandoned so
   * a caller can report it.
   */
  endOfStream(): AbandonedPurchase[] {
    const out: AbandonedPurchase[] = [];
    for (const fam of Object.keys(this.queues) as ShopFamily[]) {
      for (const h of this.queues[fam]) {
        const rec: AbandonedPurchase = { purchase: h.p, reason: "end-of-stream" };
        out.push(rec);
        this.note(rec);
      }
      this.queues[fam] = [];
    }
    return out;
  }

  /** What is being held right now, oldest first across both families. A caller may want to say
   *  "one purchase is still waiting on the server" rather than show nothing and look broken. */
  pending(): ItemPurchase[] {
    return [...this.queues.ShopUIProvider, ...this.queues.ShoppingProvider]
      .sort((a, b) => a.ms - b.ms)
      .map((h) => h.p);
  }

  /** Purchases the server explicitly declined, newest last. Bounded. */
  refused(): ItemPurchase[] {
    return [...this.refusals];
  }

  /** Purchases that left the queue with no answer at all, newest last. Bounded. Distinct from
   *  `refused()`: "the server said no" and "we never heard" are different facts and collapsing
   *  them makes the second look like the first. */
  unanswered(): AbandonedPurchase[] {
    return [...this.abandoned];
  }

  /** A response settles the OLDEST outstanding request in its own family. */
  private settle(r: ItemShopResponse): ItemPurchase[] {
    const q = this.queues[r.family];
    if (!q.length) {
      // ⚠️ Never observed — 0 orphan responses across 533 logs — but a player who starts the app
      // mid-purchase will produce one, and it must not throw or invent a victim.
      return [];
    }
    const h = q.shift();
    if (!h) return [];

    // ⚠️ `shopId` CORROBORATES, IT DOES NOT GATE. It agrees 239/239 where both sides state one,
    // but ShoppingProvider responses carry none at all — requiring it would discard all 143 of
    // that family's purchases. A disagreement is worth recording and is not worth refusing on,
    // because the FIFO order is the stronger evidence.
    const mismatched = !!(r.shopId && h.p.shopId && r.shopId !== h.p.shopId);

    if (r.success && !mismatched) {
      return [{ ...h.p, confirmed: true, resultCode: r.result }];
    }
    this.keepRefusal({
      ...h.p,
      confirmed: false,
      resultCode: mismatched ? `ShopIdMismatch:${r.result ?? "?"}` : r.result,
    });
    return [];
  }

  /** Age out anything the server never answered. */
  private advance(ms: number): void {
    if (ms > this.clock) this.clock = ms;
    for (const fam of Object.keys(this.queues) as ShopFamily[]) {
      const keep: { p: ItemPurchase; ms: number }[] = [];
      for (const h of this.queues[fam]) {
        if (this.clock - h.ms > this.maxHoldMs) this.note({ purchase: h.p, reason: "timed-out" });
        else keep.push(h);
      }
      this.queues[fam] = keep;
    }
  }

  private keepRefusal(p: ItemPurchase): void {
    this.refusals.push(p);
    if (this.refusals.length > ItemShopConfirmations.MAX_KEPT) this.refusals.shift();
  }

  private note(a: AbandonedPurchase): void {
    this.abandoned.push(a);
    if (this.abandoned.length > ItemShopConfirmations.MAX_KEPT) this.abandoned.shift();
  }
}
