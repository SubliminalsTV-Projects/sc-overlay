/**
 * pricemine — WHAT THE UPLOAD FILTER COSTS A PRICE CORPUS.
 *
 * `src/log-share.ts` only uploads a rotated session that matches RE_SIGNAL (mission/blueprint
 * events) or RE_HAUL. Neither mentions shops. So a session in which the player only shopped is
 * never uploaded, and the shared corpus is a MISSION corpus that happens to contain some
 * shopping — which is exactly the kind of selection bias that makes a coverage number look like
 * a fact about the game when it is a fact about the filter.
 *
 * The shared corpus cannot measure what it never received. Sub's own `logbackups/` can: it is
 * the unfiltered population every upload decision is made against.
 *
 * Needs Star Citizen installed. Reads only; writes nothing.
 *
 * Usage:  npx tsx tools/probe-sharefilter.ts [logbackups dir]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// 🔑 THE "AFTER" RULE IS IMPORTED, NOT COPIED (flight sharefilter, 2026-08-24). The original probe
// copied the regex and warned that a drift would make it measure a filter nobody is running; the
// module now exports the predicate, so that whole class of error is gone for the after-figure.
// RE_SIGNAL_BEFORE stays a copy on purpose — it is a historical record of the rule this change
// replaced, and it is meant to sit still while the live one moves.
import { hasShareSignal } from "../src/log-share.js";

const RE_SIGNAL_BEFORE = /MissionEnded|EndMission|Received Blueprint|Contract Complete|Contract Accepted/;
const RE_HAUL = /Covalex_Hauling|RedWind_Hauling|GoblinG_\w*HaulCargo|CreateMarker>[^\n]*?\[[^\]]*(?:haul|cargo)[^\]]*\]/i;
const before = (raw: string) => RE_SIGNAL_BEFORE.test(raw) || RE_HAUL.test(raw);
const ITEM = "CEntityComponentShop";
const COMM = "CEntityComponentCommodityUIProvider::";
// ⚠️ `::SendRentalRequest` ADDED 2026-08-24 (flight sharefilter) — it was missing, and its absence
// showed up as the probe calling 4 sessions "admitted but carrying no transaction" when what they
// carry is a ship hire. A rental is a price observation like any other (UEX models it as `k:"rent"`
// with its own spread), so leaving it out made the false-positive figure describe the probe rather
// than the filter. It moves the published pricemine baseline: transaction lines are 477 counting
// rentals, 457 without, and 12.0% lost becomes 13.2%. Both are stated in the strip.
const BUYS = /::SendShopBuyRequest|::SendStandardItemBuyRequest|::SendCommodityBuyRequest|::SendCommoditySellRequest|::SendRentalRequest/;

function main(): void {
  const dir = process.argv[2] ?? "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/logbackups";
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".log"));
  } catch {
    console.log(`no logbackups at ${dir} — skipping (this probe needs SC installed)`);
    return;
  }

  interface Tally { upload: number; shopKept: number; shopLost: number; txKept: number; txLost: number; noiseSessions: number }
  const mk = (): Tally => ({ upload: 0, shopKept: 0, shopLost: 0, txKept: 0, txLost: 0, noiseSessions: 0 });
  const B = mk(), A = mk();
  let total = 0, withShop = 0, withTx = 0, totalTx = 0;

  for (const n of names) {
    const p = join(dir, n);
    let raw: string;
    try { if (!statSync(p).size) continue; raw = readFileSync(p, "utf8"); } catch { continue; }
    total++;
    const shop = raw.includes(ITEM) || raw.includes(COMM);
    const txCount = (raw.match(BUYS) ? raw.split("\n").filter((l) => BUYS.test(l)).length : 0);
    if (shop) withShop++;
    if (txCount) { withTx++; totalTx += txCount; }

    for (const [t, passes] of [[B, before(raw)], [A, hasShareSignal(raw)]] as Array<[Tally, boolean]>) {
      if (passes) t.upload++;
      if (shop) { if (passes) t.shopKept++; else t.shopLost++; }
      if (txCount) { if (passes) t.txKept += txCount; else t.txLost += txCount; }
      // 🔑 THE FALSE-POSITIVE MEASURE, and the reason it is phrased this way: the job is to admit
      // PRICE signal, so a session this rule admits that neither the OLD rule wanted nor carries a
      // single transaction is a session the widening bought for nothing. Matching everything would
      // be a regression wearing a fix's clothes, and this is the number that says so.
      if (passes && !before(raw) && !txCount) t.noiseSessions++;
    }
  }

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  const row = (label: string, b: string, a: string) => console.log(`${label.padEnd(44)}${b.padStart(16)}${a.padStart(16)}`);
  console.log(`logbackups scanned: ${total}   (${dir})`);
  console.log(`sessions holding a shop/commodity line: ${withShop}   sessions holding a real BUY/SELL: ${withTx} (${totalTx} lines)\n`);
  row("", "BEFORE", "AFTER");
  row("sessions the filter uploads", `${B.upload} (${pct(B.upload, total)})`, `${A.upload} (${pct(A.upload, total)})`);
  row("  shopping sessions LOST", `${B.shopLost} (${pct(B.shopLost, withShop)})`, `${A.shopLost} (${pct(A.shopLost, withShop)})`);
  row("  transaction lines KEPT", `${B.txKept} (${pct(B.txKept, totalTx)})`, `${A.txKept} (${pct(A.txKept, totalTx)})`);
  row("  transaction lines LOST", `${B.txLost} (${pct(B.txLost, totalTx)})`, `${A.txLost} (${pct(A.txLost, totalTx)})`);
  row("  newly admitted, NO transaction in it", "-", `${A.noiseSessions} (${pct(A.noiseSessions, A.upload - B.upload)} of what it added)`);
  console.log("");
  // 🔑 POSITIVE CONTROL. A zero here would be indistinguishable from "the scan found nothing",
  // which is the failure this whole flight is under orders to rule out.
  console.log(`${withTx > 0 ? "PASS" : "FAIL"}  the scan finds transactions at all  (${withTx} sessions carry one)`);
  // 🔑 …and the other direction: if BEFORE lost nothing there was no bug to fix, and every
  // "AFTER is better" reading below would be measuring a filter that was already fine.
  console.log(`${B.txLost > 0 ? "PASS" : "FAIL"}  the OLD rule really did lose price data (${B.txLost} lines)`);
  console.log(`${A.txLost < B.txLost ? "PASS" : "FAIL"}  the NEW rule recovers some of it        (${B.txLost - A.txLost} lines recovered)`);
}

main();
