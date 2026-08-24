/**
 * gemmass — IS `max(amount / capacity)` A SOUND ESTIMATOR OF THE TRUE PRICE PER SCU?
 *
 * The strip's prize question. If `boxSize` states the crate's CAPACITY and the crate can be
 * part-full, then for every observed sell:
 *
 *     amount = (SCU actually inside) x price      and      SCU inside <= capacity
 *     => amount / capacity <= price
 *
 * So each sell yields a LOWER BOUND on the true unit price, and `max` over many observations
 * converges upward to it, reaching it exactly the first time somebody sells a full crate.
 *
 * 🔴 THE TEST THAT CAN FAIL, and the whole reason this probe exists: the estimator must NEVER
 * exceed the true price. We cannot join a log `shopName` to a UEX terminal (measured 0 of 75 in
 * the pricemine flight), so the available ground truth is the commodity's price RANGE across all
 * its terminals. That gives a two-sided reading:
 *
 *   - estimator > the commodity's MAXIMUM UEX price  =>  BROKEN. The sale cannot have happened at
 *     a terminal paying more than any terminal pays. Any overshoot beyond UEX's own staleness is
 *     a real defect and is reported as one.
 *   - estimator within [min, max]                    =>  CONSISTENT, and the tighter to max the
 *     more of the true price the corpus has recovered.
 *
 * ⚠️ Capacity is `quantity x boxSize` — `quantity` on a SELL is a CONTAINER COUNT, per the header
 * of `src/trade-log.ts`. That is the parser's documented semantics, not a fit: under the competing
 * reading (boxSize x unitAmount) 17 of 91 sells imply MORE cargo than the crate can hold, which is
 * physically impossible and is what rules that reading out.
 *
 * ⚠️ Refined and ore are DIFFERENT resourceGUIDs and are never merged — keyed on the GUID, never
 * on the name, because `Lindinium` and `Lindinium (Ore)` is exactly what a name match would fuse.
 *
 * Usage:  npx tsx tools/probe-unitprice.ts --b64 <file.b64>
 *         npx tsx tools/probe-unitprice.ts --disk
 */
import { readFileSync, statSync } from "node:fs";
import { collectLogPaths } from "../src/log-paths.js";

interface Row { id: string; usr: string; kind: string; created: string; scrubbed?: string; l?: string }

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

interface Obs { guid: string; amount: number; capacity: number; shop: string; at: string }

function main(): void {
  const cj = JSON.parse(readFileSync("data/commodities.json", "utf8")) as {
    commodities: Record<string, {
      name: string; bestSell: number | null;
      prices: { terminal: string; sell: number | null }[];
    }>;
  };

  const seen = new Set<string>();
  const obs: Obs[] = [];
  let sells = 0, empty = 0;

  for (const [who, raw] of corpus()) {
    if (!raw.includes("SendCommoditySellRequest")) continue;
    const guid = raw.match(/resourceGUID\[([^\]]+)\]/)?.[1];
    const amount = Number(raw.match(/amount\[([0-9.]+)/)?.[1]);
    const at = raw.match(/^<([^>]+)>/)?.[1] ?? "";
    const shop = raw.match(/shopName\[([^\]]+)\]/)?.[1] ?? "(none)";
    if (!guid || !Number.isFinite(amount) || amount <= 0) continue;
    const key = `${who}|${at}|${guid}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sells++;

    const tail = raw.split("Cargo Box Data:")[1];
    const groups = tail === undefined ? -1 : (tail.match(/boxSize\[/g) ?? []).length;
    if (groups <= 0) { empty++; continue; }   // no manifest => no capacity => no bound
    const boxSize = Number(tail!.match(/boxSize\[([0-9.]+)/)?.[1]);
    const qty = Number(raw.match(/quantity\[([0-9.]+)/)?.[1]);
    if (!Number.isFinite(boxSize) || !Number.isFinite(qty) || boxSize <= 0 || qty <= 0) continue;
    obs.push({ guid, amount, capacity: boxSize * qty, shop, at });
  }

  console.log(`sells seen ${sells}   empty-manifest (no capacity, excluded) ${empty}   ` +
    `usable observations ${obs.length}\n`);

  const per = new Map<string, Obs[]>();
  for (const o of obs) {
    if (!per.has(o.guid)) per.set(o.guid, []);
    per.get(o.guid)!.push(o);
  }

  console.log("=== estimator max(amount/capacity) vs UEX ground truth ===");
  console.log("  commodity                     n   estimator     UEX min     UEX max   vs max   verdict");
  let broken = 0, consistent = 0, unpriced = 0;
  const rows: { name: string; n: number; est: number; lo: number; hi: number; r: number }[] = [];

  for (const [guid, list] of [...per].sort((a, b) => b[1].length - a[1].length)) {
    const rec = cj.commodities[guid];
    const name = rec?.name ?? guid.slice(0, 8);
    const est = Math.max(...list.map(o => o.amount / o.capacity));
    const sellPrices = (rec?.prices ?? []).map(p => p.sell).filter((x): x is number => !!x && x > 0);
    if (!sellPrices.length) {
      unpriced++;
      console.log(`  ${name.padEnd(28)} ${String(list.length).padStart(3)} ` +
        `${est.toFixed(0).padStart(11)}   ${"-".padStart(9)}   ${"-".padStart(9)}` +
        `   ${"-".padStart(6)}   UNPRICED by UEX (nothing to check against)`);
      continue;
    }
    const lo = Math.min(...sellPrices), hi = Math.max(...sellPrices);
    const r = est / hi;
    // 5% tolerance for UEX staleness: prices are crowd-sourced, rounded, median days old.
    const verdict = r > 1.05 ? "OVERSHOOT - estimator broken" : "consistent";
    if (r > 1.05) broken++; else consistent++;
    rows.push({ name, n: list.length, est, lo, hi, r });
    console.log(`  ${name.padEnd(28)} ${String(list.length).padStart(3)} ` +
      `${est.toFixed(0).padStart(11)} ${lo.toLocaleString().padStart(11)} ` +
      `${hi.toLocaleString().padStart(11)}   ${r.toFixed(3).padStart(6)}   ${verdict}`);
  }

  console.log(`\n  consistent ${consistent}   OVERSHOOT ${broken}   unpriced-by-UEX ${unpriced}`);
  if (!rows.length) return;

  // How close does the estimator get, and does more evidence get it closer?
  const rs = rows.map(x => x.r).sort((a, b) => a - b);
  const q = (p: number) => rs[Math.min(rs.length - 1, Math.floor(p * rs.length))];
  console.log(`\n=== how tight is the floor? (estimator / UEX max) ===`);
  console.log(`  min=${rs[0].toFixed(3)}  median=${q(0.5).toFixed(3)}  ` +
    `p90=${q(0.9).toFixed(3)}  max=${rs[rs.length - 1].toFixed(3)}`);
  console.log(`  🔑 A sound floor sits at or just below 1.000 and NEVER meaningfully above it.`);

  const few = rows.filter(x => x.n <= 2), many = rows.filter(x => x.n >= 5);
  const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
  console.log(`\n=== does more evidence tighten it? (the convergence claim) ===`);
  console.log(`  commodities with <=2 observations: ${few.length}, mean ratio ` +
    `${mean(few.map(x => x.r)).toFixed(3)}`);
  console.log(`  commodities with >=5 observations: ${many.length}, mean ratio ` +
    `${mean(many.map(x => x.r)).toFixed(3)}`);
  console.log(`  🔑 The estimator can only rise with more evidence, so a higher mean for the`);
  console.log(`     well-observed group is the convergence claim showing up in the data.`);
}

main();
