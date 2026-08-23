/**
 * COMMODITY BUYS — the runs the player picked, waiting to be sequenced into the route.
 *
 * ── 🔴 THE ONE RULE, AND IT IS SUB'S ───────────────────────────────────────────────────────────
 *
 * **Quantity is never chosen here, by the player or by us.** Sub, deciding how the merged Route
 * would work:
 *
 *   "There won't be any need to change how much SCU because the player can pick that. Actually,
 *    they don't need to pick it. They can decide when they get there and when they buy it, we'll
 *    know how much they bought and then it'll override it."
 *
 * So a buy enters the route with `scu: null` — UNKNOWN, never zero and never a guess — and the real
 * figure arrives from `game.log` when the purchase happens. `hauling-route.ts` routes an unknown
 * quantity as no load, which makes every load figure on that trip a FLOOR and says so through
 * `RoutePlan.unknownScu`. Nothing in this file, and nothing downstream of it, may pick a number.
 *
 * ⚠️ THE OPTIMISER THAT WAS DELIBERATELY NOT BUILT: one that chooses how much to buy to fill the
 * hold. It was considered and rejected. The log is the source of truth everywhere else in this app
 * and this is not the exception — a suggested tonnage would be indistinguishable on screen from a
 * measured one, which is the failure mode this codebase spends most of its comments avoiding.
 *
 * ── 🔴 AND THE SECOND RULE: CONTRACTS AND COMMODITIES ARE NEVER CO-RANKED ─────────────────────
 *
 *   "you'll do the contracts and then you'll pick up commodities as more of an opportunistic
 *    approach... it doesn't really matter that contracts is going to rank by however much per
 *    hour."
 *
 * Contracts rank among themselves in the Contracts tab; commodity runs rank among themselves in
 * the Commodities tab. Route SEQUENCES what came out of either — it does not weigh one against the
 * other, and there is deliberately no shared profit-per-hour currency anywhere in this file. The
 * prices carried on a record below are the quote the player was looking at when they picked it,
 * kept so the row can show what it was, and they are never fed to the solver.
 *
 * ── STATE ────────────────────────────────────────────────────────────────────────────────────
 *
 * 🔴 `STATE_VERSION` IS A DATA-DESTRUCTION SWITCH ON THIS FILE, NOT A SCHEMA LABEL. `read()`
 * returns empty on a mismatch, exactly like every other state reader in this app, so bumping it
 * because a field was added silently deletes the picks of everyone who already has some. An
 * additive change is a BACKFILL ON READ and the version must not move. Bump only for something
 * that genuinely cannot be read forward.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CommodityPurchase } from "./trade-log.js";

const STATE_VERSION = 1;
const FILE = "hauling-buys.json";

/** One end of a run. Terminal names come from the price table; the body is what lets the tiered
 *  travel model price the leg, and the system is kept so a cross-system pick can be told apart. */
export interface BuyEnd {
  terminal: string;
  body: string | null;
  system: string | null;
}

export interface CommodityBuy {
  /** Local, synthetic, and stable for the life of the pick. Not a game id. */
  id: string;
  /**
   * 🔑 Joins straight to `data/commodities.json` AND to the log's `resourceGUID` — the same uuid on
   * both sides. This is what makes the purchase override possible with no name matching, no
   * normalising and no dialect problem. Do NOT switch it for a name.
   */
  resourceGuid: string | null;
  commodity: string;
  from: BuyEnd;
  to: BuyEnd;
  /** The quote the player was looking at when they picked it, aUEC/SCU. Display only — a forecast
   *  off crowd-reported prices, never a claim and never an input to the route. */
  buyPrice: number | null;
  sellPrice: number | null;
  addedAt: number;
  /**
   * 🔴 SCU, once the log has SEEN the purchase. NULL until then, and null is the normal state —
   * a pick is made before the buy, which is the entire point.
   */
  scu: number | null;
  /** When the purchase line landed. Null while `scu` is null. */
  boughtAt: string | null;
  /** The game's own shop token from that line, e.g. `TDD_SCShop-001`. Evidence, so a filled figure
   *  can be traced back to the line it came from rather than merely appearing. */
  shopName: string | null;
  /**
   * 🔑 THE BOX BREAKDOWN, STATED BY THE LOG — `boxSize` and `unitAmount` on the purchase line.
   *
   * This is why the Stow tab needs no partitioner for a commodity. A contract's boxes usually have
   * to be inferred (`partitionScu`, flagged PROVISIONAL) because the game names a tonnage and not a
   * manifest; a purchase names both. The captured sell reads `quantity[10] boxSize[2]
   * unitAmount[5]` — ten SCU as five boxes of two — and the buy reads `boxSize[1] unitAmount[1]`.
   * Reading it beats deriving it, every time.
   */
  boxScu: number | null;
  boxCount: number | null;
  /**
   * 🔴 WHICH PURCHASE LINE FILLED THIS, so the same line can never fill a second pick.
   *
   * The sidecar feeds this store from THREE places — the live watcher, the current-log seed and the
   * rotated-log seed — and a purchase in the newest backup is replayed on every start. Without a
   * key, restarting the app twice while holding two picks of the same commodity would credit the
   * one real buy to both of them and put cargo in the hold that was never bought.
   *
   * ⚠️ IT MUST NOT CONTAIN A FIGURE THE PARSER CAN REVISE. `main` corrected the sell line's
   * quantity from a container count to SCU on 2026-08-23; any key built on tonnage or total would
   * have changed meaning under that fix and re-applied every purchase already recorded. Timestamp,
   * shop and commodity are read verbatim off the line and are not derived from anything.
   */
  purchaseKey: string | null;
  /**
   * 🔴 WHERE THE GAME PUT IT WHEN YOU PAID, not where it is now. `autoLoading[1]` went straight
   * into the hold; `autoLoading[0]` went to the freight elevator and the player still has to
   * collect it. Proven rather than inferred — Sub bought the same commodity both ways 16 seconds
   * apart so the difference had exactly one place to show up.
   * ⚠️ It does not age. A lot bought to the elevator and since tractored in still reads `false`,
   * so this may say where cargo STARTED and never that it is still there.
   */
  autoLoaded: boolean | null;
}

interface State {
  v: number;
  buys: CommodityBuy[];
}

const empty = (): State => ({ v: STATE_VERSION, buys: [] });

/**
 * Identify one purchase line, for the replay guard. See `CommodityBuy.purchaseKey`.
 *
 * 🔴 EVERY PART IS READ VERBATIM OFF THE LINE. No tonnage, no total, nothing the parser derives —
 * `main` revised how a quantity is read on 2026-08-23, and a key containing one would have changed
 * meaning under that fix and silently re-applied every purchase already recorded.
 */
export function purchaseKeyOf(p: CommodityPurchase): string {
  return [p.at, p.kind, p.shopId ?? "", p.shopName ?? "", (p.resourceGuid ?? "").toLowerCase()].join("|");
}

/** A record off disk, with every field this version expects present. See the STATE_VERSION note:
 *  an older file is a valid newer one once the new fields are defaulted, so it is repaired rather
 *  than thrown away. */
function backfill(raw: unknown): CommodityBuy | null {
  const r = raw as Partial<CommodityBuy> | null;
  if (!r || typeof r.id !== "string" || !r.id) return null;
  const end = (e: unknown): BuyEnd => {
    const v = e as Partial<BuyEnd> | null;
    return {
      terminal: typeof v?.terminal === "string" ? v.terminal : "",
      body: typeof v?.body === "string" ? v.body : null,
      system: typeof v?.system === "string" ? v.system : null,
    };
  };
  const num = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);
  return {
    id: r.id,
    resourceGuid: typeof r.resourceGuid === "string" ? r.resourceGuid : null,
    commodity: typeof r.commodity === "string" ? r.commodity : "",
    from: end(r.from),
    to: end(r.to),
    buyPrice: num(r.buyPrice),
    sellPrice: num(r.sellPrice),
    addedAt: num(r.addedAt) ?? 0,
    // ⚠️ A non-positive tonnage is not a tonnage. `0` on this field would mean "you bought
    // nothing", which the log never says — so it reads back as unknown rather than as a figure.
    scu: (() => { const n = num(r.scu); return n !== null && n > 0 ? n : null; })(),
    boughtAt: typeof r.boughtAt === "string" ? r.boughtAt : null,
    shopName: typeof r.shopName === "string" ? r.shopName : null,
    // Backfilled, not version-bumped: a record written before these existed is a perfectly valid
    // record with them absent. See the STATE_VERSION note at the top of this file.
    boxScu: num(r.boxScu),
    boxCount: num(r.boxCount),
    purchaseKey: typeof r.purchaseKey === "string" ? r.purchaseKey : null,
    autoLoaded: typeof r.autoLoaded === "boolean" ? r.autoLoaded : null,
  };
}

export class HaulingBuys {
  private readonly path: string;
  private state: State = empty();
  private loaded = false;

  constructor(private readonly userDir: string) {
    this.path = join(userDir, FILE);
  }

  private read(): State {
    if (this.loaded) return this.state;
    this.loaded = true;
    try {
      const j = JSON.parse(readFileSync(this.path, "utf8")) as Partial<State>;
      // See the header: a mismatch EMPTIES the file, so this comparison is a destruction switch.
      // It is `!==` rather than `<` deliberately — a downgrade must not silently reinterpret a
      // shape it does not know either.
      if (j?.v !== STATE_VERSION) return (this.state = empty());
      const buys = Array.isArray(j.buys) ? j.buys.map(backfill).filter((b): b is CommodityBuy => b !== null) : [];
      this.state = { v: STATE_VERSION, buys };
    } catch {
      // Missing or corrupt reads as "nothing picked yet", never as damage to repair.
      this.state = empty();
    }
    return this.state;
  }

  private save(): void {
    try {
      mkdirSync(this.userDir, { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.state, null, 2));
    } catch { /* a pick that cannot be persisted still works for this session */ }
  }

  list(): CommodityBuy[] {
    return this.read().buys.slice();
  }

  /**
   * Add a pick. `id` is minted here so no caller can hand in a colliding one.
   *
   * 🔴 THE PARAMETER TYPE IS THE ENFORCEMENT. Everything the LOG fills in is omitted from what a
   * caller may supply — tonnage, manifest, where it was loaded, when it was bought — so a route
   * that tried to accept a player-chosen SCU would not compile. Sub's ruling is a type here, not a
   * comment somewhere that a later edit can quietly step around.
   */
  add(
    spec: Omit<CommodityBuy,
      "id" | "addedAt" | "scu" | "boughtAt" | "shopName" | "boxScu" | "boxCount" | "purchaseKey" | "autoLoaded">,
    now: number,
  ): CommodityBuy {
    const s = this.read();
    // Monotonic within a run, and prefixed so it can never be mistaken for a mission id or a
    // marker key in a map keyed by location.
    const buy: CommodityBuy = {
      ...spec,
      id: "buy" + now.toString(36) + (s.buys.length + 1).toString(36),
      addedAt: now,
      scu: null,
      boughtAt: null,
      shopName: null,
      boxScu: null,
      boxCount: null,
      autoLoaded: null,
      purchaseKey: null,
    };
    s.buys.push(buy);
    this.save();
    return buy;
  }

  /** Drop a pick. Returns what was removed, or null when the id was already gone — a second click
   *  on a stale widget is not an error, the row is off the list either way. */
  remove(id: string): CommodityBuy | null {
    const s = this.read();
    const i = s.buys.findIndex((b) => b.id === id);
    if (i < 0) return null;
    const [gone] = s.buys.splice(i, 1);
    this.save();
    return gone;
  }

  /**
   * The purchase override — the whole reason a quantity may be left unknown.
   *
   * 🔑 MATCHED ON `resourceGUID`, and FIFO among the picks that share it: the oldest pick still
   * waiting on a figure takes the purchase. Two picks of the same commodity is a real case (buy
   * here, buy more there), and crediting both to whichever was found first would double a load.
   *
   * ⚠️ Only a BUY. A sell is the other end of the trip and says nothing about what went aboard;
   * `trade-log.ts` reports the two with the same shape and one differing field, which is exactly
   * how a parser ends up treating them as one thing.
   *
   * ⚠️ Only a pick that has no figure yet. A second purchase of a commodity already accounted for
   * belongs to a pick nobody made, and inventing one here would put cargo in the hold the player
   * never asked the route to carry.
   *
   * Returns the buy it filled, or null when nothing matched — which is the common case, since most
   * purchases have no pick behind them at all.
   */
  applyPurchase(p: CommodityPurchase): CommodityBuy | null {
    if (p.kind !== "buy") return null;
    if (!p.resourceGuid) return null;
    // 🔴 A non-positive tonnage is refused rather than written. The line has been misread before
    // (a sell's `quantity` was taken as a container count and doubled), and a zero written here
    // would read downstream as "bought nothing" — a claim the log never makes.
    if (p.scu === null || !(p.scu > 0)) return null;
    const want = p.resourceGuid.toLowerCase();
    const s = this.read();
    // See `purchaseKey`: the seed replays the newest rotated log on every start, so without this
    // one real purchase would fill a fresh pick on every restart.
    const key = purchaseKeyOf(p);
    if (s.buys.some((b) => b.purchaseKey === key)) return null;
    const hit = s.buys
      .filter((b) => b.scu === null && (b.resourceGuid ?? "").toLowerCase() === want)
      .sort((a, b) => a.addedAt - b.addedAt)[0];
    if (!hit) return null;
    hit.purchaseKey = key;
    hit.scu = p.scu;
    hit.boughtAt = p.at || null;
    hit.shopName = p.shopName;
    // The manifest the line states outright, so the Stow tab never has to partition a commodity.
    hit.boxScu = p.boxScu !== null && p.boxScu > 0 ? p.boxScu : null;
    hit.boxCount = p.unitAmount !== null && p.unitAmount > 0 ? p.unitAmount : null;
    hit.autoLoaded = p.autoLoaded;
    this.save();
    return hit;
  }
}
