/**
 * THE ONE PLACE A LOG LINE BECOMES AN OBSERVED PRICE.
 *
 * The sidecar reads `game.log` in three places — the rotated-log seed, the live-log seed, and the
 * watcher — and every one of them already called `tradeLogLine()`. This file wraps that single
 * call so all three gain item-shop capture by changing ONE WORD each, instead of growing three
 * copies of a fan-out that would then have to be kept in step.
 *
 * 🔑 THAT IS THE POINT, NOT TIDINESS. This project has been bitten repeatedly by a rule enforced
 * in some of its call sites and not others — `seedFromRotatedLog()` was missing the environment
 * gate for months, and every receipt in a replayed PTU backup counted as live. A fan-out that
 * lives in one function cannot be half-applied.
 *
 * ── WHAT FLOWS THROUGH HERE ──────────────────────────────────────────────────────────────────
 *
 *   items        `item-shop-log.ts`  ->  confirmed on an explicit `result[Success]`
 *   commodities  `trade-log.ts`      ->  confirmed by the ABSENCE of a refusal
 *
 * 🔴 THE TWO CONFIRMATION RULES ARE OPPOSITE AND MUST STAY THAT WAY. Item shops answer every
 * request, so silence there means nothing happened; commodity terminals answer only to refuse, so
 * silence there means it went through. Each subsystem owns its own gate and this file never
 * second-guesses either — it takes `confirmed` as given and passes it to a store that drops
 * anything which is not exactly `true`.
 *
 * ⚠️ ONE gate instance for the whole live stream, deliberately not reset between the seed and the
 * watcher: they read contiguous bytes of the same file, so a purchase whose Success is in the
 * watcher's first bytes must still find its request. The commodity side keeps the identical rule
 * for the identical reason.
 */

import { tradeLogLine, type TradeDeps } from "./trade-routes.js";
import { ItemShopConfirmations, type ItemPurchase } from "./item-shop-log.js";
import { ObservedPriceStore } from "./observed-prices.js";
import type { CommodityPurchase } from "./trade-log.js";

let items: ItemShopConfirmations | null = null;
let store: ObservedPriceStore | null = null;
let saveTimer: NodeJS.Timeout | null = null;

/** Debounced, because a bulk replay can confirm dozens of purchases in a few milliseconds and one
 *  disk write per purchase during startup is a stall nobody asked for. */
const SAVE_DEBOUNCE_MS = 2000;

/** Stand the feed up. Idempotent, so a log-path change can re-arm the watcher without losing the
 *  in-flight queue or re-reading the state file. */
export function initPriceFeed(stateDir: string): ObservedPriceStore {
  if (!store) store = new ObservedPriceStore(stateDir);
  if (!items) items = new ItemShopConfirmations();
  return store;
}

/** The store, for the Verse Finder to BORROW read-only — the same pattern `verse-routes.ts` uses
 *  for the commodity table. Null before `initPriceFeed`, which callers must treat as "no
 *  observations", never as an error. */
export function observedPrices(): ObservedPriceStore | null {
  return store;
}

/**
 * Feed one raw log line, IN LOG ORDER. Replaces the direct `tradeLogLine()` call at all three
 * sites; it still does everything that did (the trade journal is updated exactly as before) and
 * additionally records observed prices.
 *
 * 🔑 EVERY line must be fed, not just the interesting ones — both gates release held requests on
 * the timestamp of an ARRIVING line, so the boring lines are what move the clock. Feeding only
 * matching lines would leave a purchase held until the next purchase, which is minutes away.
 */
export function priceFeedLine(line: string, deps: TradeDeps): void {
  // Commodities: unchanged behaviour, plus the confirmed ones now reach the store.
  for (const p of tradeLogLine(line, deps)) recordCommodity(p, deps);

  // Items: the half the app was blind to.
  if (!items) return;
  for (const p of items.line(line)) recordItem(p, deps);
}

/** Flush anything the item gate is still holding. Call at the end of a COMPLETE rotated log.
 *
 *  🔴 It confirms NOTHING — see `ItemShopConfirmations.endOfStream()`. Deliberately NOT called at
 *  the seam between the startup seed and the live watcher, where the next bytes of the same file
 *  are still to come and a held request's Success may be among them. */
export function priceFeedEndOfStream(): void {
  items?.endOfStream();
  flushSoon();
}

function recordItem(p: ItemPurchase, deps: TradeDeps): void {
  if (!store || !p.itemGuid || !p.shopName) return;
  const added = store.add({
    kind: "item",
    id: p.itemGuid,
    terminal: p.shopName,
    // 🔴 The UNIT price. `client_price` is the stack total and a quarter of real purchases are
    // qty > 1 — see `item-shop-log.ts`.
    unitPrice: p.unitPrice ?? 0,
    quantity: p.quantity ?? 1,
    total: p.totalPrice ?? 0,
    at: p.at,
    // No item SELL verb exists anywhere in 533 logs, so this is always a buy.
    side: "buy",
    token: p.itemName,
    system: deps.system?.() ?? null,
    confirmed: p.confirmed,
  });
  if (added) flushSoon();
}

function recordCommodity(p: CommodityPurchase, deps: TradeDeps): void {
  if (!store || !p.resourceGuid || !p.shopName) return;
  const added = store.add({
    kind: "commodity",
    id: p.resourceGuid,
    terminal: p.shopName,
    // Already per-SCU on both sides of a commodity transaction: stated by the shop on a buy,
    // derived from total/SCU on a sell. `trade-log.ts` owns that distinction.
    unitPrice: p.pricePerScu ?? 0,
    quantity: p.scu ?? 1,
    total: p.total ?? 0,
    at: p.at,
    // 🔑 A commodity SELL is a real price and is kept, tagged as a sell. Unlike items, where the
    // player can only ever buy, a commodity has two prices at a terminal and they are not
    // interchangeable — quoting a sell figure as a buy price is how you tell someone a shop sells
    // Laranite for what it pays for it.
    side: p.kind === "sell" ? "sell" : "buy",
    token: null,
    system: deps.system?.() ?? null,
    confirmed: p.confirmed,
  });
  if (added) flushSoon();
}

function flushSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    store?.save();
  }, SAVE_DEBOUNCE_MS);
  // Never hold the process open for a price write.
  saveTimer.unref?.();
}
