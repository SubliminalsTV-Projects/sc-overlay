/**
 * sellvolume — RE-DERIVING THE EMPTY-BOX SELL POPULATION FROM SCRATCH.
 *
 * The brief handed me a measurement and told me not to take it on trust, because the flight that
 * produced it had already mis-parsed this very corpus once. So this probe re-derives it from the
 * RAW shared-log rows (`dense.b64`, one base64 JSON row per line, each carrying a whole scrubbed
 * `Game.log`) rather than from any intermediate file, and it answers the question the brief's
 * framing actually rests on: **what ARE the empty-box sells?**
 *
 * It deliberately does NOT reuse `probe-sellvolume.ts`'s pre-filtered input. Two extractors reading
 * the same source is corroboration; one extractor read twice is not.
 *
 * ⚠️ THE CORPUS DOUBLE-COUNTS (see the skill's shared-log section): a live log is re-uploaded on
 * every tick whose content changed, so one session arrives as N rows each a superset of the last.
 * Deduping on the GAME's own millisecond timestamp + contributor is what makes the counts mean
 * anything — without it a single sale reads as four independent observations of the same price.
 *
 * TWO INDEPENDENT CORPORA, because one extractor read twice is not corroboration:
 *   --b64 <file>   the shared-log corpus (57 contributors), either whole rows (`scrubbed`) or
 *                  pre-split lines (`l`) — both shapes are handled.
 *   --disk [path]  Sub's own `logbackups/` on this machine, via `collectLogPaths`. Nothing about
 *                  this path touches the VPS, and the two populations barely overlap.
 *
 * Usage:  npx tsx tools/probe-sellunit.ts --b64 shoplines.b64
 *         npx tsx tools/probe-sellunit.ts --disk
 */
import { readFileSync, statSync } from "node:fs";
import { parseTradeLine } from "../src/trade-log.js";
import { collectLogPaths } from "../src/log-paths.js";

interface Row { id: string; usr: string; kind: string; created: string; scrubbed?: string; l?: string }

/** How many `boxSize[...] | unitAmount[...]` groups follow `Cargo Box Data:` on this line. */
function boxGroups(raw: string): number {
  const tail = raw.split("Cargo Box Data:")[1];
  if (tail === undefined) return -1; // the phrase is not on the line at all
  return (tail.match(/boxSize\[/g) ?? []).length;
}

/** Yields `[contributor, rawLine]` for whichever corpus was asked for. */
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
      if (!text.includes("CEntityComponentCommodityUIProvider::")) continue;
      // One contributor: these are all Sub's. Keyed by FILE so two launches that happen to
      // restate a line are not collapsed into one.
      for (const l of text.split(/\r?\n/)) yield [p, l];
    }
    return;
  }
  const src = process.argv[3];
  for (const line of readFileSync(src, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r: Row;
    try { r = JSON.parse(Buffer.from(t, "base64").toString("utf8")); } catch { continue; }
    if (r.scrubbed !== undefined) { for (const l of r.scrubbed.split("\n")) yield [r.usr, l]; }
    else if (r.l !== undefined) yield [r.usr, r.l];
  }
}

function main(): void {
  const commPath = "data/commodities.json";
  const names = new Map<string, string>();
  try {
    const j = JSON.parse(readFileSync(commPath, "utf8"));
    for (const [guid, c] of Object.entries<{ name?: string }>(j.commodities ?? {})) {
      if (c?.name) names.set(guid.toLowerCase(), c.name);
    }
  } catch { /* names are a nicety; the counts stand without them */ }

  const seen = new Set<string>();
  let rows = 0, dupLines = 0;
  let buys = 0, sells = 0;
  let sellNoBox = 0, sellBoxed = 0, sellNoPhrase = 0;
  let buyNoBox = 0, buyBoxed = 0, buyNoPhrase = 0;
  // commodity x terminal, split by whether the line stated boxes.
  const byCommodity = new Map<string, { noBox: number; boxed: number; amount: number[]; shops: Set<string> }>();
  const perPair = new Map<string, { boxed: number[]; noBox: number[] }>();
  const qtyShapes = new Map<string, number>();

  for (const [usr, raw0] of corpus()) {
    const raw = raw0.replace(/\r$/, "");
    if (!raw.includes("CEntityComponentCommodityUIProvider::")) continue;
    const ev = parseTradeLine(raw);
    const p = ev?.purchase;
    if (!p) continue;

    // Dedupe on the contributor plus the line itself — the line carries the GAME's own millisecond
    // timestamp, so two players transacting in the same millisecond stay two observations while one
    // session re-uploaded four times does not.
    const key = `${usr}|${raw}`;
    if (seen.has(key)) { dupLines++; continue; }
    seen.add(key);
    rows++;

    const g = boxGroups(raw);
    if (p.kind === "buy") {
      buys++;
      if (g < 0) buyNoPhrase++; else if (g === 0) buyNoBox++; else buyBoxed++;
      continue;
    }
    sells++;
    if (g < 0) sellNoPhrase++; else if (g === 0) sellNoBox++; else sellBoxed++;

    const guid = (p.resourceGuid ?? "").toLowerCase();
    const nm = names.get(guid) ?? (guid ? `(unknown ${guid.slice(0, 8)})` : "(no guid)");
    let e = byCommodity.get(nm);
    if (!e) { e = { noBox: 0, boxed: 0, amount: [], shops: new Set() }; byCommodity.set(nm, e); }
    if (g === 0) e.noBox++; else if (g > 0) e.boxed++;
    if (p.total !== null) e.amount.push(p.total);
    if (p.shopName) e.shops.add(p.shopName);

    const rawQty = /quantity\[([^\]]*)\]/.exec(raw)?.[1] ?? "(absent)";
    const shape = `${p.kind} quantity[${/[a-z]/i.test(rawQty) ? rawQty.replace(/[0-9.]+/, "N") : "N"}] boxes=${g}`;
    qtyShapes.set(shape, (qtyShapes.get(shape) ?? 0) + 1);

    if (p.shopName && p.resourceGuid && p.pricePerScu) {
      const k = `${p.shopName}|${p.resourceGuid}`;
      let q = perPair.get(k); if (!q) { q = { boxed: [], noBox: [] }; perPair.set(k, q); }
      (g === 0 ? q.noBox : q.boxed).push(p.pricePerScu);
    }
  }

  const pct = (n: number, d: number) => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
  console.log(`transaction lines kept ${rows}   duplicate transaction lines dropped ${dupLines}`);
  console.log("");
  console.log(`BUYS  ${buys}   boxed ${buyBoxed}  empty 'Cargo Box Data:' ${buyNoBox}  phrase absent ${buyNoPhrase}`);
  console.log(`SELLS ${sells}   boxed ${sellBoxed}  empty 'Cargo Box Data:' ${sellNoBox} (${pct(sellNoBox, sells)})  phrase absent ${sellNoPhrase}`);
  console.log("");
  console.log("quantity-field shapes seen on SELLS:");
  for (const [k, v] of [...qtyShapes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log("");

  console.log("SELLS BY COMMODITY — is the empty-box population really hand-mined gems and salvage?");
  const ranked = [...byCommodity].sort((a, b) => b[1].noBox - a[1].noBox);
  console.log("  no-box  boxed  commodity                          shops  amount range (aUEC)");
  for (const [nm, e] of ranked.slice(0, 22)) {
    const lo = e.amount.length ? Math.min(...e.amount) : 0;
    const hi = e.amount.length ? Math.max(...e.amount) : 0;
    console.log(`  ${String(e.noBox).padStart(6)}  ${String(e.boxed).padStart(5)}  ${nm.padEnd(34)} ${String(e.shops.size).padStart(5)}  ${lo.toLocaleString()} – ${hi.toLocaleString()}`);
  }
  const gemOnly = ranked.filter(([, e]) => e.noBox > 0 && e.boxed === 0);
  const both = ranked.filter(([, e]) => e.noBox > 0 && e.boxed > 0);
  console.log("");
  console.log(`  commodities sold ONLY without box data : ${gemOnly.length}  (${gemOnly.reduce((a, [, e]) => a + e.noBox, 0)} sells)`);
  console.log(`  commodities sold BOTH ways             : ${both.length}  (${both.reduce((a, [, e]) => a + e.noBox, 0)} no-box sells)`);
  console.log(`     -> ${both.map(([n]) => n).slice(0, 12).join(", ")}`);
  console.log("");

  // The discriminator: if empty-box sells were partial/unboxed volumes, their DERIVED per-SCU
  // figure must sit at or below the boxed reading at the same terminal, never above.
  let pairsBoth = 0, below = 0, atOrAbove = 0;
  const ratios: number[] = [];
  for (const e of perPair.values()) {
    if (!e.boxed.length || !e.noBox.length) continue;
    pairsBoth++;
    const ref = Math.max(...e.boxed);
    for (const v of e.noBox) { ratios.push(v / ref); if (v < ref * 0.99) below++; else atOrAbove++; }
  }
  ratios.sort((a, b) => a - b);
  console.log(`terminal x commodity pairs with BOTH kinds: ${pairsBoth}`);
  console.log(`  empty-box below the boxed reference: ${below}   at or above: ${atOrAbove}`);
  if (ratios.length) {
    console.log(`  ratio  min ${ratios[0].toFixed(3)}  median ${ratios[Math.floor(ratios.length / 2)].toFixed(3)}  max ${ratios[ratios.length - 1].toFixed(3)}  (n=${ratios.length})`);
  }

  // 🔴 And the half that matters more than the empty-box story: do two sells that state the SAME
  // declared volume agree on price? If they do not, the boxed reading is not trustworthy either.
  console.log("");
  console.log("BOXED SELLS AT ONE TERMINAL — do identical declared volumes agree?");
  let disagree = 0, spreadMax = 1;
  for (const [k, e] of perPair) {
    if (e.boxed.length < 2) continue;
    const lo = Math.min(...e.boxed), hi = Math.max(...e.boxed);
    if (hi > lo * 1.05) {
      disagree++;
      if (hi / lo > spreadMax) spreadMax = hi / lo;
      if (disagree <= 6) console.log(`  ${k.split("|")[0]}  ${(hi / lo).toFixed(1)}x   ${lo.toFixed(0)} .. ${hi.toFixed(0)} aUEC/SCU`);
    }
  }
  console.log(`  pairs whose BOXED sells disagree by >5%: ${disagree}   worst spread ${spreadMax.toFixed(1)}x`);
}

main();
