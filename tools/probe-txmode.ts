/**
 * gemmass — WHAT IS `transactionMode`, AND DOES IT PREDICT AN EMPTY MANIFEST?
 *
 * The log half of the gemmass question. The datacore half (`probe-gemmass.ts`) established that
 * `transactionMode` is the commodity kiosk's INVENTORY SUB-LOCATION — `globalshopcommoditydata.xml`
 * declares `subLocation_CargoGrid`, `subLocation_GeneralStorage` and `subLocation_ResourceContainers`
 * as the kiosk's own UI categories. So it names WHERE THE GOODS WERE, not what kind of goods they
 * are, and it therefore cannot be a per-commodity "this one is sold by unit" flag.
 *
 * That is a claim about the data model. This probe MEASURES whether it holds in the corpus:
 *
 *   1. every `transactionMode` value that appears, split by buy/sell and by whether the line
 *      carries a cargo-box manifest;
 *   2. whether any mode is a clean predictor of an empty manifest (the brief's warning is that
 *      ordinary cargo also produces empty manifests, so this must be measured, not assumed);
 *   3. THE DISCRIMINATING TEST between the two live explanations of the evidence —
 *      is the price of an empty-manifest sell CONTINUOUS (a part-full container) or CLUSTERED into
 *      the 8 discrete bands the datacore's quality quantization defines (a quality multiplier)?
 *
 * ⚠️ THE SHARED-LOG CORPUS DOUBLE-COUNTS — a live log is re-uploaded on every tick whose content
 * changed, so one session arrives as N rows each a superset of the last. Deduped on the GAME's own
 * millisecond timestamp keyed with the contributor, exactly as `probe-sellunit.ts` does.
 *
 * Usage:
 *   npx tsx tools/probe-txmode.ts --disk                 # Sub's own logbackups (534 files)
 *   npx tsx tools/probe-txmode.ts --b64 <file.b64>       # the shared-log corpus
 */
import { readFileSync, statSync } from "node:fs";
import { parseTradeLine, TRADE_LOG_MARKER } from "../src/trade-log.js";
import { collectLogPaths } from "../src/log-paths.js";

interface Row { id: string; usr: string; kind: string; created: string; scrubbed?: string; l?: string }

/** How many `boxSize[...]` groups follow `Cargo Box Data:`. -1 = the phrase is not on the line. */
function boxGroups(raw: string): number {
  const tail = raw.split("Cargo Box Data:")[1];
  if (tail === undefined) return -1;
  return (tail.match(/boxSize\[/g) ?? []).length;
}

function* corpus(): Generator<[string, string]> {
  const mode = process.argv[2];
  if (mode === "--disk") {
    const configured = process.argv[3]
      ?? "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/game.log";
    for (const p of collectLogPaths(configured)) {
      let text: string;
      try {
        if (statSync(p).size > 512 * 1024 * 1024) continue;
        text = readFileSync(p, "utf8");
      } catch { continue; }
      if (!text.includes(TRADE_LOG_MARKER)) continue;
      for (const l of text.split(/\r?\n/)) yield [p, l];
    }
    return;
  }
  const src = process.argv[3];
  if (!src) { console.error("usage: --disk | --b64 <file>"); process.exit(2); }
  for (const line of readFileSync(src, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r: Row;
    try { r = JSON.parse(Buffer.from(t, "base64").toString("utf8")); } catch { continue; }
    if (r.scrubbed !== undefined) { for (const l of r.scrubbed.split("\n")) yield [r.usr, l]; }
    else if (r.l !== undefined) yield [r.usr, r.l];
  }
}

interface Tx {
  at: string; kind: "buy" | "sell"; mode: string; shop: string; guid: string;
  total: number | null; groups: number; boxScu: number | null; unitAmount: number | null;
  /** `quantity[N]` off the raw line. On a SELL this is a CONTAINER COUNT (src/trade-log.ts). */
  qty: number | null;
}

function main(): void {
  const seen = new Set<string>();
  const txs: Tx[] = [];
  let lines = 0, parsed = 0, dupes = 0;

  for (const [who, raw] of corpus()) {
    if (!raw.includes(TRADE_LOG_MARKER)) continue;
    lines++;
    const ev = parseTradeLine(raw);
    if (!ev || ev.kind === "unknownMethod" || !("purchase" in ev)) continue;
    const p = (ev as { purchase: import("../src/trade-log.js").CommodityPurchase }).purchase;
    if (!p) continue;
    parsed++;
    // Dedupe on the GAME's own timestamp + contributor: the corpus re-uploads growing logs.
    const key = `${who}|${p.at}|${p.kind}|${p.resourceGuid}|${p.total}`;
    if (seen.has(key)) { dupes++; continue; }
    seen.add(key);
    txs.push({
      at: p.at, kind: p.kind, mode: p.transactionMode ?? "(absent)",
      shop: p.shopName ?? "(none)", guid: p.resourceGuid ?? "(none)",
      total: p.total, groups: boxGroups(raw),
      boxScu: p.boxScu, unitAmount: p.unitAmount,
      qty: (() => { const m = raw.match(/quantity\[([0-9.]+)/); return m ? Number(m[1]) : null; })(),
    });
  }

  console.log(`corpus: ${lines} marker lines, ${parsed} parsed transactions, ` +
    `${dupes} deduped, ${txs.length} distinct\n`);
  if (!txs.length) { console.error("no transactions — wrong corpus?"); process.exit(2); }

  // ---- 1. transactionMode enumeration ----
  console.log("=== transactionMode x kind x manifest ===");
  const modes = new Map<string, { buy: number; sell: number; empty: number; full: number }>();
  for (const t of txs) {
    if (!modes.has(t.mode)) modes.set(t.mode, { buy: 0, sell: 0, empty: 0, full: 0 });
    const m = modes.get(t.mode)!;
    m[t.kind]++;
    if (t.groups === 0) m.empty++; else if (t.groups > 0) m.full++;
  }
  console.log("  mode                      buys  sells   empty-manifest  with-manifest");
  for (const [name, m] of [...modes].sort((a, b) => (b[1].buy + b[1].sell) - (a[1].buy + a[1].sell))) {
    console.log(`  ${name.padEnd(24)} ${String(m.buy).padStart(5)} ${String(m.sell).padStart(6)}` +
      `   ${String(m.empty).padStart(13)}  ${String(m.full).padStart(12)}`);
  }

  // ---- 2. is any mode a clean predictor of an empty manifest? ----
  console.log("\n=== does the mode predict an empty manifest? (sells only) ===");
  const sells = txs.filter(t => t.kind === "sell");
  const byMode = new Map<string, { empty: number; full: number }>();
  for (const t of sells) {
    if (!byMode.has(t.mode)) byMode.set(t.mode, { empty: 0, full: 0 });
    const m = byMode.get(t.mode)!;
    if (t.groups === 0) m.empty++; else if (t.groups > 0) m.full++;
  }
  for (const [name, m] of byMode) {
    const tot = m.empty + m.full;
    const pct = tot ? (100 * m.empty / tot).toFixed(1) : "n/a";
    const clean = m.empty === 0 || m.full === 0;
    console.log(`  ${name.padEnd(24)} ${String(m.empty).padStart(4)} empty / ` +
      `${String(tot).padStart(4)} sells = ${pct.padStart(5)}%   ` +
      `${clean ? "CLEAN SPLIT" : "MIXED - not a predictor"}`);
  }

  // ---- 3. commodities on both sides ----
  console.log("\n=== commodities appearing with BOTH empty and non-empty manifests ===");
  const perGuid = new Map<string, { empty: number; full: number }>();
  for (const t of sells) {
    if (!perGuid.has(t.guid)) perGuid.set(t.guid, { empty: 0, full: 0 });
    const g = perGuid.get(t.guid)!;
    if (t.groups === 0) g.empty++; else if (t.groups > 0) g.full++;
  }
  const both = [...perGuid].filter(([, g]) => g.empty > 0 && g.full > 0);
  console.log(`  ${both.length} of ${perGuid.size} commodities sold appear on BOTH sides`);
  for (const [g, c] of both.slice(0, 15)) {
    console.log(`     ${g}  empty=${c.empty} full=${c.full}`);
  }

  // ---- 4. THE DISCRIMINATING TEST ----
  // Group sells by (commodity, shop, declared manifest). Within a group the declared volume is
  // identical, so any spread in `total` is unexplained by the manifest. Continuous spread => a
  // part-full container. Spread landing on a few discrete ratios => a quantized quality multiplier.
  console.log("\n=== discriminating test: continuous fill, or quantized quality? ===");
  console.log("  (sells grouped by commodity + shop + identical declared manifest)");
  const groups = new Map<string, number[]>();
  for (const t of sells) {
    if (t.total === null || t.total <= 0) continue;
    const k = `${t.guid}|${t.shop}|g${t.groups}|b${t.boxScu}|u${t.unitAmount}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t.total);
  }
  const multi = [...groups].filter(([, v]) => v.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  console.log(`  ${multi.length} groups with >=3 sells sharing an identical declared manifest`);

  // The 8 quantized quality bands the datacore defines for these commodities.
  const BANDS = [305, 585, 618, 729, 853, 930, 954, 1000];
  const bandRatios = new Set<string>();
  for (const a of BANDS) for (const b of BANDS) if (b > a) bandRatios.add((b / a).toFixed(4));

  let quantHits = 0, quantTests = 0;
  for (const [k, vals] of multi.slice(0, 12)) {
    const s = [...vals].sort((a, b) => a - b);
    const lo = s[0], hi = s[s.length - 1];
    console.log(`\n  ${k}`);
    console.log(`    n=${s.length}  min=${lo.toLocaleString()}  max=${hi.toLocaleString()}  ` +
      `spread=${(hi / lo).toFixed(2)}x`);
    console.log(`    values: ${s.slice(0, 12).map(v => v.toLocaleString()).join(", ")}` +
      `${s.length > 12 ? " ..." : ""}`);
    // How many of the pairwise ratios land within 0.5% of a quality-band ratio?
    let hit = 0, tot = 0;
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
      const r = s[j] / s[i];
      if (r < 1.0001) continue;
      tot++;
      for (const br of bandRatios) {
        if (Math.abs(r / Number(br) - 1) < 0.005) { hit++; break; }
      }
    }
    quantHits += hit; quantTests += tot;
    console.log(`    pairwise ratios matching a quality-band ratio (+-0.5%): ${hit}/${tot}`);
  }
  if (quantTests) {
    console.log(`\n  TOTAL across shown groups: ${quantHits}/${quantTests} = ` +
      `${(100 * quantHits / quantTests).toFixed(1)}% of ratios sit on a quality band`);
    console.log(`  🔑 The 28 band ratios span 1.02..3.28, so a CONTINUOUS distribution would hit`);
    console.log(`     roughly 10-20% by chance alone. A quality mechanism should read far higher.`);
  }

  // ---- 5. do fractional box sizes ever appear? ----
  console.log("\n=== declared boxSize values seen (the datacore defines 1/8, 1/4, 1/2 SCU boxes) ===");
  const sizes = new Map<string, number>();
  for (const t of txs) sizes.set(String(t.boxScu), (sizes.get(String(t.boxScu)) ?? 0) + 1);
  console.log("  " + [...sizes].sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([s, n]) => `${s}:${n}`).join("  "));

  // ---- 6. THE FALSIFIABLE TEST OF THE PART-FULL-CONTAINER MODEL ----
  //
  // The model: a sell's `amount` is (SCU actually inside) x (aUEC per SCU), and the manifest's
  // `boxSize` states the container's CAPACITY, not its contents. If that is right, then for every
  // boxed sell the IMPLIED volume must be <= the DECLARED capacity. It is allowed to be less
  // (a part-full container); it must not be more.
  //
  // 🔴 THE TEST IS ONLY HONEST IF IT CAN FAIL. Using the commodity's HIGHEST known sell price
  // gives the SMALLEST implied volume, i.e. the reading most favourable to the model — so a
  // violation here is a real violation and not an artefact of picking a cheap terminal. The log's
  // `shopName` does NOT join to a UEX terminal name (measured 0 of 75 in the pricemine flight), so
  // a per-terminal price is not available and the commodity-wide maximum is the correct proxy.
  console.log("\n=== part-full-container model: is implied volume <= declared capacity? ===");
  let priced: Record<string, { name: string; bestSell: number | null }> = {};
  try {
    const j = JSON.parse(readFileSync("data/commodities.json", "utf8")) as {
      commodities: Record<string, { name: string; bestSell: number | null }>;
    };
    priced = j.commodities;
  } catch { console.log("  (data/commodities.json unreadable - skipping)"); return; }

  let tested = 0, within = 0, over = 0;
  const overs: string[] = [];
  const fills: number[] = [];
  for (const t of sells) {
    if (t.groups <= 0 || t.total === null || t.boxScu === null || t.unitAmount === null) continue;
    const rec = priced[t.guid];
    const px = rec?.bestSell ?? null;
    if (!px || px <= 0) continue;
    // Declared capacity: the manifest states one box group here; capacity is size x count.
    const capacity = t.boxScu * (t.qty ?? 1);
    if (capacity <= 0) continue;
    const impliedScu = t.total / px;
    const fill = impliedScu / capacity;
    tested++;
    fills.push(fill);
    if (fill <= 1.05) within++; else { over++; overs.push(`${rec.name} fill=${fill.toFixed(2)}x`); }
  }
  console.log(`  boxed sells with a known price: ${tested}`);
  if (tested) {
    console.log(`    implied volume WITHIN declared capacity (<=1.05x): ${within} ` +
      `(${(100 * within / tested).toFixed(1)}%)`);
    console.log(`    implied volume OVER declared capacity:            ${over} ` +
      `(${(100 * over / tested).toFixed(1)}%)`);
    const s = [...fills].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    console.log(`    fill fraction  min=${s[0].toFixed(3)}  median=${q(0.5).toFixed(3)}  ` +
      `p90=${q(0.9).toFixed(3)}  max=${s[s.length - 1].toFixed(3)}`);
    console.log(`  🔑 A fill fraction spread across (0,1] with a CEILING at 1 is the signature of`);
    console.log(`     a part-full container. A fixed price per unit would pin it at one value.`);
    if (overs.length) console.log(`    over-capacity cases: ${overs.slice(0, 8).join("; ")}`);
  }

  // The four Lindinium sells the brief asks about, worked end to end.
  console.log("\n=== the brief's four Lindinium sells, under the part-full model ===");
  const LIND = "392b4dca-449a-4d4d-8fef-beab024d9ee7";
  const lind = sells.filter(t => t.guid === LIND).sort((a, b) => a.at.localeCompare(b.at));
  const lrec = priced[LIND];
  if (!lind.length) { console.log("  (no Lindinium sells in this corpus)"); return; }
  // Derive the terminal's price from the sell whose implied volume most nearly fills its box.
  const rate = Math.max(...lind.map(t => (t.total ?? 0) / ((t.boxScu ?? 1) * (t.qty ?? 1))));
  console.log(`  UEX best sell for ${lrec?.name}: ${lrec?.bestSell?.toLocaleString()} aUEC/SCU`);
  console.log(`  rate implied by the fullest container here: ${rate.toFixed(0)} aUEC/SCU ` +
    `(${lrec?.bestSell ? ((rate / lrec.bestSell - 1) * 100).toFixed(1) : "?"}% vs UEX)`);
  console.log("  time                      amount   box  implied SCU   fill of capacity");
  for (const t of lind) {
    const cap = (t.boxScu ?? 1) * (t.qty ?? 1);
    const scu = (t.total ?? 0) / rate;
    console.log(`  ${t.at}  ${String(t.total?.toLocaleString()).padStart(9)}  ` +
      `${String(cap).padStart(3)}  ${scu.toFixed(3).padStart(11)}   ${(scu / cap).toFixed(3)}`);
  }
}

main();
