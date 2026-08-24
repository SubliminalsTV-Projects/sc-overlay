/**
 * pricemine — DOES THE SHARED-LOG CORPUS BEAT UEX AS A PRICE SOURCE?
 *
 * Measurement only. Reads the extracted shop/commodity lines from the opt-in shared logs
 * (`site.bp_shared_logs`), replays them through the SHIPPED parsers — `src/item-shop-log.ts`
 * and `src/trade-log.ts`, never a third copy — and prints the coverage / freshness / movement
 * numbers the verdict rests on.
 *
 * Input: a JSONL file, one object per matching log line, produced by the extract query in the
 * strip. Fields: id (log row), usr (hashed contributor), kind, created, ord, l (the raw line).
 *
 * Usage:  npx tsx tools/measure-pricemine.ts <lines.jsonl> [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ItemShopConfirmations, type ItemPurchase } from "../src/item-shop-log.js";
import { TradeConfirmations, parseTradeLine, type CommodityPurchase } from "../src/trade-log.js";

interface Row { id: string; usr: string; kind: string; created: string; ord: number; l: string }

interface ItemObs extends ItemPurchase { log: string; usr: string }
interface CommObs extends CommodityPurchase { log: string; usr: string }

const NOW = Date.parse("2026-08-24T00:00:00Z");

function pct(a: number, b: number): string {
  return b ? `${((a / b) * 100).toFixed(1)}%` : "n/a";
}

function quantiles(xs: number[], qs: number[]): number[] {
  if (!xs.length) return qs.map(() => NaN);
  const s = [...xs].sort((a, b) => a - b);
  return qs.map((q) => {
    const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
    return s[i];
  });
}

function main(): void {
  const path = process.argv[2];
  if (!path) throw new Error("usage: measure-pricemine.ts <lines.jsonl>");
  const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : "";

  // 🔴 BASE64, NOT RAW JSON. psql's `\copy ... to stdout` emits TEXT format, which backslash-
  // escapes the payload — so a JSON string's own `\r`/`\n` came back as a literal backslash-r,
  // and a whole-log column arrived as ONE line containing two-character `\n` sequences. That
  // silently turned a six-session control into six single-line files. Encoding on the server
  // removes the question entirely.
  const rows: Row[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(Buffer.from(line.trim(), "base64").toString("utf8")) as Row);
  }

  // Group by log row, keeping log order.
  const byLog = new Map<string, Row[]>();
  for (const r of rows) {
    let a = byLog.get(r.id);
    if (!a) { a = []; byLog.set(r.id, a); }
    a.push(r);
  }
  for (const a of byLog.values()) a.sort((x, y) => x.ord - y.ord);

  const items: ItemObs[] = [];
  const comms: CommObs[] = [];
  let itemRequests = 0, itemRefused = 0, itemAbandoned = 0;
  let commRequests = 0, commRefused = 0;
  const unknownVerbs = new Map<string, number>();
  const offerShops = new Set<string>();

  for (const [logId, lines] of byLog) {
    const usr = lines[0].usr;
    // ⚠️ A FRESH GATE PER LOG ROW. Each row is one uploaded session (a complete rotated log, or
    // the tail of a live one), so the file boundary is real and end-of-stream applies.
    const ic = new ItemShopConfirmations();
    const tc = new TradeConfirmations();
    for (const r of lines) {
      const raw = r.l.replace(/\r$/, "");
      for (const p of ic.line(raw)) items.push({ ...p, log: logId, usr });
      for (const p of tc.line(raw)) comms.push({ ...p, log: logId, usr });

      // Census of what the parsers SAW, so a zero can be told apart from a parse failure.
      const ev = parseTradeLine(raw);
      if (ev?.purchase) commRequests++;
      if (ev?.offer?.shopName) offerShops.add(ev.offer.shopName);
      if (ev?.unknownMethod) unknownVerbs.set(ev.unknownMethod, (unknownVerbs.get(ev.unknownMethod) ?? 0) + 1);
      if (raw.includes("::SendShopBuyRequest") || raw.includes("::SendStandardItemBuyRequest") || raw.includes("::SendRentalRequest")) itemRequests++;
    }
    const ab = ic.endOfStream();
    itemAbandoned += ab.length;
    itemRefused += ic.refused().length;
    for (const p of tc.flush()) comms.push({ ...p, log: logId, usr });
    commRefused += tc.refused().length;
  }

  // ── 🔴 DEDUPE FIRST, OR EVERY NUMBER BELOW IS INFLATED ───────────────────────────────────
  //
  // `maybeShareLog` re-uploads the LIVE Game.log on every tick whose scrubbed content changed,
  // and the game writes one growing file per launch. So a single play session arrives as N rows,
  // each a superset of the last: four rows measured here from one contributor all begin at
  // 2026-08-24T06:48:47 and were stored 20 minutes apart, and each carries the same 12 commodity
  // purchases. Counting rows counts the same transaction up to N times — and worse, it plants
  // duplicate observations of one pair at one timestamp, which reads downstream as "we saw this
  // price twice and it did not move".
  //
  // The game's own millisecond timestamp is the transaction id. Keyed with the contributor so
  // two players at one shop in the same millisecond stay two observations.
  const dedupe = <T extends { at: string; usr: string; shopName: string | null }>(xs: T[], id: (x: T) => string): { kept: T[]; dropped: number } => {
    const seen = new Set<string>();
    const kept: T[] = [];
    let dropped = 0;
    for (const x of xs) {
      const k = JSON.stringify([x.usr, x.at, x.shopName, id(x)]);
      if (seen.has(k)) { dropped++; continue; }
      seen.add(k);
      kept.push(x);
    }
    return { kept, dropped };
  };

  // ── ITEMS ────────────────────────────────────────────────────────────────────────────────
  const itemRaw = items.filter((p) => p.kind === "buy" && p.confirmed === true && p.unitPrice !== null && p.shopName && p.itemGuid);
  const itemDd = dedupe(itemRaw, (p) => `${p.itemGuid}|${p.quantity}|${p.totalPrice}`);
  const itemBuys = itemDd.kept;
  const itemPairs = new Map<string, ItemObs[]>();
  for (const p of itemBuys) {
    const k = JSON.stringify([p.shopName, p.itemGuid]);
    let a = itemPairs.get(k); if (!a) { a = []; itemPairs.set(k, a); } a.push(p);
  }

  // ── COMMODITIES ──────────────────────────────────────────────────────────────────────────
  const commRaw = comms.filter((p) => p.confirmed === true && p.shopName && p.resourceGuid && p.pricePerScu !== null && p.pricePerScu > 0);
  const commDd = dedupe(commRaw, (p) => `${p.resourceGuid}|${p.kind}|${p.scu}|${p.total}`);
  // 🔴 A SELL WITH NO BOX DATA HAS AN UNKNOWABLE VOLUME, SO ITS PER-SCU PRICE IS NOT A PRICE.
  //
  // A BUY states `shopPricePerCentiSCU` outright (101 of 101 in this corpus). A SELL states no
  // unit price at all, so `pricePerScu` is derived as total/scu — and `quantity` on a partial
  // container is rounded up to 1 while the real fill sits in `Cargo Box Data`, which 60.2% of
  // sells leave EMPTY. Measured against the boxed reading at the same terminal, an empty-box
  // sell comes in at min 0.008x, median 0.264x and **never above 1.000x** — the exact signature
  // of a part-full container, not of noise. See tools/probe-sellvolume.ts.
  //
  // Keeping them would have reported Tungsten swinging 256 -> 8,157 aUEC/SCU in thirteen
  // seconds and called it a market.
  const commUsable = commDd.kept.filter((p) => p.kind === "buy" || (p.boxScu !== null && p.unitAmount !== null));
  const commUnknownVol = commDd.kept.length - commUsable.length;
  const commOk = commUsable;
  const commPairs = new Map<string, CommObs[]>();
  for (const p of commOk) {
    // buy and sell are two different prices at one terminal — never merged.
    const k = JSON.stringify([p.shopName, p.resourceGuid, p.kind]);
    let a = commPairs.get(k); if (!a) { a = []; commPairs.set(k, a); } a.push(p);
  }

  // ── UEX SIDE ─────────────────────────────────────────────────────────────────────────────
  const shops = JSON.parse(readFileSync("data/item-shops.json", "utf8")) as {
    fetchedAt: number;
    items: { n: string; u: string; q: { t: number; p: number; m: number; k?: string }[] }[];
    terminals: { n: string; sys: string; body: string; place: string }[];
  };
  let uexItemQuotes = 0;
  const uexItemPairs = new Set<string>();
  const uexItemUuids = new Set<string>();
  const uexItemAges: number[] = [];
  const uexTerminalsUsed = new Set<number>();
  // ⚠️ Not every priced UEX row carries a game uuid — those can never be joined to a log
  // observation by id, so the number is reported rather than hidden behind a guard.
  let uexNoUuid = 0;
  const uexNamesNoUuid = new Set<string>();
  for (const it of shops.items) {
    for (const q of it.q) {
      if (q.k === "rent") continue;
      uexItemQuotes++;
      uexItemPairs.add(JSON.stringify([q.t, it.u ?? `name:${it.n}`]));
      if (it.u) uexItemUuids.add(it.u.toLowerCase());
      else { uexNoUuid++; uexNamesNoUuid.add(it.n); }
      uexTerminalsUsed.add(q.t);
      uexItemAges.push((NOW - q.m * 1000) / 86400000);
    }
  }

  let trade: { quotes: { commodity: string; terminal: string; buy: number | null; sell: number | null; asOf: number }[]; fetchedAt: number } | null = null;
  try {
    trade = JSON.parse(readFileSync(process.env.TRADE_PRICES ?? "", "utf8"));
  } catch { /* optional */ }

  const out: Record<string, unknown> = {};
  const say = (s: string) => console.log(s);

  say("=".repeat(78));
  say("CORPUS");
  say("=".repeat(78));
  say(`shared-log rows with any shop/commodity line : ${byLog.size}`);
  say(`extracted lines                              : ${rows.length}`);
  say(`distinct contributors (hashed)               : ${new Set(rows.map((r) => r.usr)).size}`);
  say("");
  say(`item-shop purchase REQUESTS seen             : ${itemRequests}`);
  say(`  confirmed (result[Success])                : ${items.filter((p) => p.confirmed).length}`);
  say(`  refused by the server                      : ${itemRefused}`);
  say(`  never answered (abandoned at EOF)          : ${itemAbandoned}`);
  say(`  usable buy quotes (priced, shop, item)     : ${itemBuys.length}  [${itemDd.dropped} dropped as re-uploads of the same transaction]`);
  say(`commodity transaction REQUESTS seen          : ${commRequests}`);
  say(`  confirmed (no refusal in window)           : ${comms.filter((p) => p.confirmed).length}`);
  say(`  refused                                    : ${commRefused}`);
  say(`  after de-duping re-uploads                 : ${commDd.kept.length}  [${commDd.dropped} dropped as re-uploads of the same transaction]`);
  say(`  usable quotes (volume knowable)            : ${commOk.length}  [${commUnknownVol} dropped: a SELL with empty Cargo Box Data]`);
  say(`    of those, buys ${commOk.filter((p) => p.kind === "buy").length} (unit price STATED) / sells ${commOk.filter((p) => p.kind === "sell").length} (unit price DERIVED)`);
  if (unknownVerbs.size) {
    say(`  ⚠️ unmodelled commodity verbs             : ${[...unknownVerbs].map(([k, v]) => `${k}x${v}`).join(", ")}`);
  }
  say("");

  say("=".repeat(78));
  say("1. COVERAGE — ITEMS");
  say("=".repeat(78));
  const ourItemShops = new Set(itemBuys.map((p) => p.shopName!));
  const ourItemGuids = new Set(itemBuys.map((p) => p.itemGuid!));
  say(`OURS   terminal x item pairs                 : ${itemPairs.size}`);
  say(`OURS   distinct game shop tokens             : ${ourItemShops.size}`);
  say(`OURS   distinct items                        : ${ourItemGuids.size}`);
  say(`UEX    terminal x item pairs (sale quotes)   : ${uexItemPairs.size}`);
  say(`UEX    distinct terminals carrying a quote   : ${uexTerminalsUsed.size} (of ${shops.terminals.length} listed)`);
  say(`UEX    distinct items priced (with a uuid)   : ${uexItemUuids.size}`);
  say(`UEX    priced quotes with NO game uuid       : ${uexNoUuid} across ${uexNamesNoUuid.size} names (unjoinable by id)`);
  const itemsAlsoInUex = [...ourItemGuids].filter((g) => uexItemUuids.has(g));
  say(`ITEM AXIS overlap: of our ${ourItemGuids.size} items, ${itemsAlsoInUex.length} are priced by UEX (${pct(itemsAlsoInUex.length, ourItemGuids.size)})`);
  say(`                   -> ${ourItemGuids.size - itemsAlsoInUex.length} items UEX prices nowhere at all`);
  // 🔑 THE ONLY DEFENSIBLE "NEW COVERAGE" NUMBER. Terminal x item pairs cannot be compared —
  // the terminal axis does not join (section 6). What CAN be compared is the item axis, so a
  // pair whose ITEM appears in no UEX quote anywhere is coverage UEX provably does not have,
  // whatever its terminal turns out to be.
  const novelPairs = new Set([...itemPairs.keys()].filter((k) => !uexItemUuids.has((JSON.parse(k) as string[])[1])));
  say(`NEW COVERAGE: terminal x item pairs whose ITEM is unpriced by UEX anywhere : ${novelPairs.size} of ${itemPairs.size} (${pct(novelPairs.size, itemPairs.size)})`);
  say("");

  say("=".repeat(78));
  say("2. COVERAGE — COMMODITIES");
  say("=".repeat(78));
  const ourCommShops = new Set(commOk.map((p) => p.shopName!));
  const ourCommGuids = new Set(commOk.map((p) => p.resourceGuid!));
  say(`OURS   terminal x commodity x side           : ${commPairs.size}`);
  say(`OURS   distinct game shop tokens             : ${ourCommShops.size}   [${[...ourCommShops].sort().join(", ")}]`);
  say(`OURS   distinct commodities                  : ${ourCommGuids.size}`);
  say(`OURS   shops seen OFFERING boxes (any line)  : ${offerShops.size}`);
  if (trade) {
    const uexCommPairs = new Set<string>();
    const uexCommTerm = new Set<string>();
    const uexCommName = new Set<string>();
    const uexCommAges: number[] = [];
    for (const q of trade.quotes) {
      uexCommTerm.add(q.terminal); uexCommName.add(q.commodity);
      if (q.buy) uexCommPairs.add(JSON.stringify([q.terminal, q.commodity, "buy"]));
      if (q.sell) uexCommPairs.add(JSON.stringify([q.terminal, q.commodity, "sell"]));
      uexCommAges.push((NOW - q.asOf * 1000) / 86400000);
    }
    const [p25, p50, p90, pmax] = quantiles(uexCommAges, [0.25, 0.5, 0.9, 1]);
    say(`UEX    terminal x commodity x side          : ${uexCommPairs.size}`);
    say(`UEX    distinct terminals                   : ${uexCommTerm.size}`);
    say(`UEX    distinct commodities                 : ${uexCommName.size}`);
    say(`UEX    quote age days  p25 ${p25.toFixed(1)} / median ${p50.toFixed(1)} / p90 ${p90.toFixed(1)} / max ${pmax.toFixed(1)}`);
    say(`UEX    snapshot fetched                     : ${new Date(trade.fetchedAt).toISOString().slice(0, 10)}`);
    out.uexCommPairs = uexCommPairs.size;
  } else {
    say(`UEX    (no trade-prices.json — set TRADE_PRICES=<path>)`);
  }
  say("");

  // Per-item UEX price envelope, for the agreement check below.
  const uexByUuid = new Map<string, number[]>();
  for (const it of shops.items) {
    if (!it.u) continue;
    const ps = it.q.filter((q) => q.k !== "rent" && q.p > 0).map((q) => q.p);
    if (ps.length) uexByUuid.set(it.u.toLowerCase(), ps);
  }
  let inRange = 0, outRange = 0, noUexRow = 0;
  const outliers: string[] = [];
  for (const p of itemBuys) {
    const ps = uexByUuid.get(p.itemGuid!);
    if (!ps) { noUexRow++; continue; }
    const lo = Math.min(...ps), hi = Math.max(...ps);
    // 1% slack for the game's own rounding of a stack total.
    if (p.unitPrice! >= lo * 0.99 && p.unitPrice! <= hi * 1.01) inRange++;
    else { outRange++; if (outliers.length < 6) outliers.push(`${p.itemName ?? p.itemGuid} @ ${p.shopName}: we read ${p.unitPrice!.toFixed(0)}, UEX spans ${lo}-${hi}`); }
  }
  say("=".repeat(78));
  say("2b. DO OUR READS AGREE WITH UEX?  (item axis — the only axis that joins)");
  say("=".repeat(78));
  say(`observations of an item UEX prices somewhere : ${inRange + outRange}`);
  say(`  inside UEX's own min-max for that item     : ${inRange} (${pct(inRange, inRange + outRange)})`);
  say(`  OUTSIDE it — no UEX row could produce it   : ${outRange} (${pct(outRange, inRange + outRange)})`);
  say(`observations of an item UEX prices NOWHERE   : ${noUexRow}`);
  for (const o of outliers) say(`    e.g. ${o}`);
  say("");

  // Same agreement test for commodities, against the shipped UEX snapshot's per-commodity
  // envelope. The terminal axis does not join, so this asks only "could any UEX row have
  // produced this number" — which is exactly the question that separates a real reading from
  // a derivation artifact.
  try {
    const cj = JSON.parse(readFileSync("data/commodities.json", "utf8")) as {
      commodities: Record<string, { name: string; prices: { buy: number | null; sell: number | null }[] }>;
    };
    let cIn = 0, cOut = 0, cNo = 0;
    const cOutliers: string[] = [];
    for (const p of commOk) {
      const c = cj.commodities[p.resourceGuid!];
      const vals = (c?.prices ?? []).map((x) => (p.kind === "buy" ? x.buy : x.sell)).filter((v): v is number => !!v && v > 0);
      if (!vals.length) { cNo++; continue; }
      const lo = Math.min(...vals), hi = Math.max(...vals);
      if (p.pricePerScu! >= lo * 0.9 && p.pricePerScu! <= hi * 1.1) cIn++;
      else { cOut++; if (cOutliers.length < 6) cOutliers.push(`${c.name} ${p.kind} @ ${p.shopName}: we read ${p.pricePerScu!.toFixed(0)}, UEX spans ${lo}-${hi}`); }
    }
    say("=".repeat(78));
    say("2c. DO OUR COMMODITY READS AGREE WITH THE UEX SNAPSHOT? (commodity axis only)");
    say("=".repeat(78));
    say(`observations of a commodity UEX prices       : ${cIn + cOut}`);
    say(`  inside UEX's own min-max (any terminal)    : ${cIn} (${pct(cIn, cIn + cOut)})`);
    say(`  OUTSIDE it                                 : ${cOut} (${pct(cOut, cIn + cOut)})`);
    const buyIn = commOk.filter((p) => p.kind === "buy");
    const sellIn = commOk.filter((p) => p.kind === "sell");
    const side = (xs: typeof commOk) => {
      let i = 0, o = 0;
      for (const p of xs) {
        const c = cj.commodities[p.resourceGuid!];
        const vals = (c?.prices ?? []).map((x) => (p.kind === "buy" ? x.buy : x.sell)).filter((v): v is number => !!v && v > 0);
        if (!vals.length) continue;
        if (p.pricePerScu! >= Math.min(...vals) * 0.9 && p.pricePerScu! <= Math.max(...vals) * 1.1) i++; else o++;
      }
      return `${i} in / ${o} out (${pct(i, i + o)} in)`;
    };
    say(`  BUYS  (stated unit price)                 : ${side(buyIn)}`);
    say(`  SELLS (derived unit price)                : ${side(sellIn)}`);
    for (const o of cOutliers) say(`    e.g. ${o}`);
    say("");
  } catch { /* dataset absent */ }

  say("=".repeat(78));
  say("3. FRESHNESS");
  say("=".repeat(78));
  const itemAges = itemBuys.map((p) => (NOW - Date.parse(p.at)) / 86400000);
  const commAges = commOk.map((p) => (NOW - Date.parse(p.at)) / 86400000);
  const [ip25, ip50, ip90, ipmax] = quantiles(itemAges, [0.25, 0.5, 0.9, 1]);
  const [cp25, cp50, cp90, cpmax] = quantiles(commAges, [0.25, 0.5, 0.9, 1]);
  const [up25, up50, up90, upmax] = quantiles(uexItemAges, [0.25, 0.5, 0.9, 1]);
  say(`OURS item obs   age days  p25 ${ip25.toFixed(1)} / median ${ip50.toFixed(1)} / p90 ${ip90.toFixed(1)} / max ${ipmax.toFixed(1)}`);
  say(`UEX  item quote age days  p25 ${up25.toFixed(1)} / median ${up50.toFixed(1)} / p90 ${up90.toFixed(1)} / max ${upmax.toFixed(1)}`);
  say(`OURS comm obs   age days  p25 ${cp25.toFixed(1)} / median ${cp50.toFixed(1)} / p90 ${cp90.toFixed(1)} / max ${cpmax.toFixed(1)}`);
  const allObsTimes = [...itemBuys.map((p) => p.at), ...commOk.map((p) => p.at)].sort();
  say(`corpus observation window                    : ${allObsTimes[0]?.slice(0, 10)} .. ${allObsTimes[allObsTimes.length - 1]?.slice(0, 10)}`);
  const withoutOutlier = allObsTimes.filter((t) => t >= "2026-");
  say(`  ... excluding pre-2026 stragglers          : ${withoutOutlier[0]?.slice(0, 10)} .. ${withoutOutlier[withoutOutlier.length - 1]?.slice(0, 10)}  (${allObsTimes.length - withoutOutlier.length} dropped)`);
  say("");
  // 🔑 Contributor spread decides whether corroboration is even possible. A pair every one of
  // whose observations came from ONE player cannot be corroborated by anybody.
  const spread = (pairs: Map<string, { usr: string }[]>, label: string) => {
    let multi = 0;
    for (const obs of pairs.values()) if (new Set(obs.map((o) => o.usr)).size > 1) multi++;
    say(`${label}: pairs with observations from MORE THAN ONE contributor: ${multi} of ${pairs.size} (${pct(multi, pairs.size)})`);
  };
  spread(itemPairs, "ITEMS      ");
  spread(commPairs, "COMMODITIES");
  say(`contributors with at least one usable ITEM obs      : ${new Set(itemBuys.map((p) => p.usr)).size}`);
  say(`contributors with at least one usable COMMODITY obs : ${new Set(commOk.map((p) => p.usr)).size}`);
  say("");

  say("=".repeat(78));
  say("4. DOES IT MOVE?  (items and commodities reported SEPARATELY — never averaged)");
  say("=".repeat(78));
  const movement = (pairs: Map<string, { at: string; price: number }[]>, label: string) => {
    let repeat = 0, moved = 0, held = 0;
    // 🔑 A REPEAT INSIDE ONE SESSION CANNOT DETECT A CHANGE — buying the same thing twice in
    // four minutes is not a second reading of the market. The number that answers "does it move"
    // is the one over pairs seen on DIFFERENT DAYS, and it is far smaller than the raw repeat
    // count. Both are printed so the weaker one cannot masquerade as the stronger.
    let spanned = 0, spannedMoved = 0;
    const spans: number[] = [];
    const moves: { k: string; lo: number; hi: number; days: number }[] = [];
    for (const [k, obs] of pairs) {
      if (obs.length < 2) continue;
      repeat++;
      const s = [...obs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const days = (Date.parse(s[s.length - 1].at) - Date.parse(s[0].at)) / 86400000;
      spans.push(days);
      // 🔴 A RELATIVE TOLERANCE, NOT EXACT EQUALITY. A commodity SELL states no unit price, so
      // `pricePerScu` is DERIVED (total / SCU) and carries float noise plus the game's own
      // rounding of the total: one pair came back "4082 -> 4082" and was still counted as a
      // move. Exact equality therefore over-reports movement on precisely the half of the data
      // the whole verdict turns on. 0.5% is far below any real market step and far above the
      // noise — the biggest genuine moves here are 10x.
      const vals = s.map((o) => o.price);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const didMove = lo > 0 && (hi - lo) / lo > 0.005;
      if (didMove) {
        moved++;
        moves.push({ k, lo, hi, days });
      } else held++;
      if (days >= 1) { spanned++; if (didMove) spannedMoved++; }
    }
    const [, medSpan] = quantiles(spans, [0, 0.5]);
    say(`${label}`);
    say(`  pairs observed MORE THAN ONCE              : ${repeat} of ${pairs.size} (${pct(repeat, pairs.size)})`);
    say(`  ... of those, price NEVER moved            : ${held} (${pct(held, repeat)})`);
    say(`  ... of those, price DID move               : ${moved} (${pct(moved, repeat)})`);
    say(`  median span between first and last obs     : ${Number.isFinite(medSpan) ? medSpan.toFixed(2) + " days" : "n/a"}`);
    say(`  pairs re-observed A DAY OR MORE APART      : ${spanned}`);
    say(`  ... of those, price DID move               : ${spannedMoved} (${pct(spannedMoved, spanned)})`);
    return { repeat, moved, held, spanned, spannedMoved, moves };
  };
  const itemMv = movement(new Map([...itemPairs].map(([k, v]) => [k, v.map((p) => ({ at: p.at, price: p.unitPrice! }))])), "ITEMS (fixed shop prices expected)");
  say("");
  const commMv = movement(new Map([...commPairs].map(([k, v]) => [k, v.map((p) => ({ at: p.at, price: p.pricePerScu! }))])), "COMMODITIES — all sides together");
  say("");
  // 🔴 THE SPLIT THAT DECIDES THE COMMODITY VERDICT. A BUY states its unit price; a SELL does
  // not, and the log does not reliably state the VOLUME either — two sells of Tungsten at
  // SCShop_Admin_lt_base_g on the same day both read `quantity[1] boxSize[1] unitAmount[1]`
  // and cost 1,304 and 7,130 aUEC. Identical declared volume, 5.5x apart. That is a
  // part-full 1 SCU container, and nothing on the line says how full.
  //
  // So "does the price move" has to be asked of buys and sells separately, or the sell side's
  // unstated volume is reported as market movement.
  const bySide = (side: "buy" | "sell") =>
    new Map([...commPairs].filter(([k]) => (JSON.parse(k) as string[])[2] === side)
      .map(([k, v]) => [k, v.map((p) => ({ at: p.at, price: p.pricePerScu! }))]));
  movement(bySide("buy"), "COMMODITIES — BUYS only (unit price STATED by the game)");
  say("");
  movement(bySide("sell"), "COMMODITIES — SELLS only (unit price DERIVED from an unstated volume)");
  for (const m of commMv.moves.slice(0, 8)) {
    say(`    e.g. ${m.k}  range ${m.lo.toFixed(0)}-${m.hi.toFixed(0)} aUEC/SCU over ${m.days.toFixed(2)}d`);
  }
  say("");

  say("=".repeat(78));
  say("5. CHANGE vs CONFIRMATION — can attribution even be computed?");
  say("=".repeat(78));
  const attributable = (pairs: Map<string, unknown[]>, mv: { repeat: number; moved: number }, label: string) => {
    const single = pairs.size - mv.repeat;
    say(`${label}`);
    say(`  first-ever observation of a pair (NEW)     : ${pairs.size}`);
    say(`  pairs where we have PRIOR history          : ${mv.repeat} (${pct(mv.repeat, pairs.size)})`);
    say(`  pairs seen exactly once — no prior to beat : ${single} (${pct(single, pairs.size)})`);
    say(`  observations that CHANGED a known price    : ${mv.moved}`);
  };
  attributable(itemPairs, itemMv, "ITEMS");
  say("");
  attributable(commPairs, commMv, "COMMODITIES");
  say("");

  say("=".repeat(78));
  say("6. THE JOIN — game shop token vs UEX terminal name");
  say("=".repeat(78));
  const uexNames = new Set(shops.terminals.map((t) => t.n.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const ourTokens = [...new Set([...ourItemShops, ...ourCommShops, ...offerShops])];
  const exact = ourTokens.filter((t) => uexNames.has(t.toLowerCase().replace(/[^a-z0-9]/g, "")));
  say(`distinct game shop tokens in the corpus      : ${ourTokens.length}`);
  say(`... matching a UEX terminal name exactly     : ${exact.length}`);
  say(`tokens: ${ourTokens.sort().join("  ")}`);
  say("");

  out.corpus = { logs: byLog.size, lines: rows.length, contributors: new Set(rows.map((r) => r.usr)).size };
  out.items = { requests: itemRequests, confirmed: items.filter((p) => p.confirmed).length, refused: itemRefused, abandoned: itemAbandoned, usable: itemBuys.length, pairs: itemPairs.size, shops: ourItemShops.size, guids: ourItemGuids.size, uexPairs: uexItemPairs.size, uexItems: uexItemUuids.size, uexTerminals: uexTerminalsUsed.size, overlapItems: itemsAlsoInUex.length, ...itemMv, moves: undefined };
  out.commodities = { requests: commRequests, refused: commRefused, usable: commOk.length, pairs: commPairs.size, shops: ourCommShops.size, guids: ourCommGuids.size, offerShops: offerShops.size, ...commMv, moves: commMv.moves };
  out.join = { tokens: ourTokens.length, exact: exact.length, tokenList: ourTokens };
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2));
}

main();
