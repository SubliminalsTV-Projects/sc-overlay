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

// Copied VERBATIM from src/log-share.ts. ⚠️ If they drift, this probe measures a filter that
// is not the one running — check them against each other before trusting a number here.
const RE_SIGNAL = /MissionEnded|EndMission|Received Blueprint|Contract Complete|Contract Accepted/;
const RE_HAUL = /Covalex_Hauling|RedWind_Hauling|GoblinG_\w*HaulCargo|CreateMarker>[^\n]*?\[[^\]]*(?:haul|cargo)[^\]]*\]/i;
const ITEM = "CEntityComponentShop";
const COMM = "CEntityComponentCommodityUIProvider::";
const BUYS = /::SendShopBuyRequest|::SendStandardItemBuyRequest|::SendCommodityBuyRequest|::SendCommoditySellRequest/;

function main(): void {
  const dir = process.argv[2] ?? "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/logbackups";
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".log"));
  } catch {
    console.log(`no logbackups at ${dir} — skipping (this probe needs SC installed)`);
    return;
  }

  let total = 0, withShop = 0, withTx = 0, shopButNoSignal = 0, shopAndSignal = 0, wouldUpload = 0;
  let txLinesKept = 0, txLinesLost = 0;
  for (const n of names) {
    const p = join(dir, n);
    let raw: string;
    try { if (!statSync(p).size) continue; raw = readFileSync(p, "utf8"); } catch { continue; }
    total++;
    const shop = raw.includes(ITEM) || raw.includes(COMM);
    const txCount = (raw.match(BUYS) ? raw.split("\n").filter((l) => BUYS.test(l)).length : 0);
    const passes = RE_SIGNAL.test(raw) || RE_HAUL.test(raw);
    if (passes) wouldUpload++;
    if (shop) {
      withShop++;
      if (passes) shopAndSignal++; else shopButNoSignal++;
    }
    if (txCount) {
      withTx++;
      if (passes) txLinesKept += txCount; else txLinesLost += txCount;
    }
  }

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  console.log(`logbackups scanned                          : ${total}   (${dir})`);
  console.log(`sessions the SHARE FILTER would upload      : ${wouldUpload} (${pct(wouldUpload, total)})`);
  console.log(`sessions containing any shop/commodity line : ${withShop} (${pct(withShop, total)})`);
  console.log(`  ... that the filter UPLOADS               : ${shopAndSignal}`);
  console.log(`  ... that the filter DROPS                 : ${shopButNoSignal} (${pct(shopButNoSignal, withShop)} of shopping sessions lost)`);
  console.log(`sessions containing a real BUY/SELL request : ${withTx}`);
  console.log(`  transaction lines the filter KEEPS        : ${txLinesKept}`);
  console.log(`  transaction lines the filter LOSES        : ${txLinesLost} (${pct(txLinesLost, txLinesKept + txLinesLost)})`);
  console.log("");
  // 🔑 POSITIVE CONTROL. A zero here would be indistinguishable from "the scan found nothing",
  // which is the failure this whole flight is under orders to rule out.
  console.log(`${withTx > 0 ? "PASS" : "FAIL"}  the scan finds transactions at all  (${withTx} sessions carry one)`);
}

main();
