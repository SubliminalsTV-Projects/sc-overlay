/**
 * pricemine — WHY THE COMMODITY "MOVEMENT" NUMBER WAS WRONG, MEASURED.
 *
 * The first pass reported Tungsten selling at TDD Orison for 256 and 8,157 aUEC/SCU thirteen
 * seconds apart. Tungsten's real sell price is ~8,265, so a 32x intraday swing is not a market.
 * The three raw lines say what happened:
 *
 *   19:28:06  amount[2154] quantity[1] transactionMode[ResourceContainer] Cargo Box Data:
 *   19:28:13  amount[8157] quantity[1] transactionMode[ResourceContainer] Cargo Box Data:  [boxSize[1] | unitAmount[1]]
 *   19:28:19  amount[ 256] quantity[1] transactionMode[ResourceContainer] Cargo Box Data:
 *
 * All three are `quantity[1]`. The middle one states a full 1 SCU box and prices out at 8,157 —
 * the real figure. The other two carry NO box data at all: they are PARTIAL containers, and
 * `quantity` has been rounded up to 1. 2154/8157 = 0.26 SCU, 256/8157 = 0.03 SCU.
 *
 * So a sell with empty `Cargo Box Data` has an UNKNOWN volume, and `pricePerScu` (which is
 * derived as total/scu, because a sell states no unit price) is then an arbitrary fraction of
 * the real price. This probe measures how much of the corpus that is.
 *
 * Usage:  npx tsx tools/probe-sellvolume.ts <lines.b64>
 */
import { readFileSync } from "node:fs";
import { parseTradeLine } from "../src/trade-log.js";

interface Row { id: string; usr: string; ord: number; l: string }

function main(): void {
  const rows: Row[] = readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(Buffer.from(l.trim(), "base64").toString("utf8")));

  let buys = 0, sells = 0;
  let sellNoBox = 0, sellBox = 0, sellMultiBox = 0;
  let buyNoUnitPrice = 0;
  const perPair = new Map<string, { withBox: number[]; noBox: number[] }>();

  for (const r of rows) {
    const raw = r.l.replace(/\r$/, "");
    const ev = parseTradeLine(raw);
    const p = ev?.purchase;
    if (!p) continue;
    // "Cargo Box Data:" followed by at least one `[boxSize[...] | unitAmount[...]]` group.
    const boxPart = raw.split("Cargo Box Data:")[1] ?? "";
    const groups = (boxPart.match(/boxSize\[/g) ?? []).length;
    if (p.kind === "buy") {
      buys++;
      if (p.pricePerScu === null) buyNoUnitPrice++;
      continue;
    }
    sells++;
    if (groups === 0) sellNoBox++;
    else { sellBox++; if (groups > 1) sellMultiBox++; }
    if (p.shopName && p.resourceGuid && p.pricePerScu) {
      const k = `${p.shopName}|${p.resourceGuid}`;
      let e = perPair.get(k); if (!e) { e = { withBox: [], noBox: [] }; perPair.set(k, e); }
      (groups === 0 ? e.noBox : e.withBox).push(p.pricePerScu);
    }
  }

  const ok = (c: boolean, label: string, detail: string) => console.log(`${c ? "PASS" : "FAIL"}  ${label}  ${detail}`);

  console.log(`commodity BUY  requests parsed              : ${buys}   (of which no stated unit price: ${buyNoUnitPrice})`);
  console.log(`commodity SELL requests parsed              : ${sells}`);
  console.log(`  sells WITH at least one box group         : ${sellBox}  (multi-group: ${sellMultiBox})`);
  console.log(`  sells with EMPTY 'Cargo Box Data:'        : ${sellNoBox}  (${((sellNoBox / Math.max(1, sells)) * 100).toFixed(1)}% — volume unknowable)`);
  console.log("");

  // 🔑 THE DISCRIMINATOR. If empty-box sells are partial containers, their derived per-SCU price
  // is a FRACTION of the boxed one at the same terminal — never above it, and often far below.
  // If instead the game just omits the field sometimes, the two sets would overlap.
  let pairsBoth = 0, noBoxLower = 0, noBoxHigher = 0;
  const ratios: number[] = [];
  for (const e of perPair.values()) {
    if (!e.withBox.length || !e.noBox.length) continue;
    pairsBoth++;
    const ref = Math.max(...e.withBox);
    for (const v of e.noBox) {
      ratios.push(v / ref);
      if (v < ref * 0.99) noBoxLower++; else noBoxHigher++;
    }
  }
  ok(pairsBoth > 0, "there are pairs with BOTH kinds of sell", `${pairsBoth} terminal x commodity pairs`);
  ok(noBoxLower > 0, "empty-box sells price BELOW the boxed one", `${noBoxLower} below vs ${noBoxHigher} at-or-above`);
  ratios.sort((a, b) => a - b);
  if (ratios.length) {
    console.log(`  ratio of an empty-box sell to the boxed reference at the same terminal:`);
    console.log(`    min ${ratios[0].toFixed(3)}  median ${ratios[Math.floor(ratios.length / 2)].toFixed(3)}  max ${ratios[ratios.length - 1].toFixed(3)}  (n=${ratios.length})`);
  }
}

main();
