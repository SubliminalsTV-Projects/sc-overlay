/**
 * MEASURE: THE COMMODITY REQUEST/RESPONSE VOCABULARY, AGAINST EVERY REAL LOG ON THIS MACHINE.
 *
 *   npm run measure:tradeconfirm
 *
 * The commit that added `TradeConfirmations` rests on a census, and a census written into a comment
 * is a claim that quietly rots. This re-runs it and **EXITS NON-ZERO THE MOMENT A CONCLUSION IS
 * OVERTURNED**, so a patch that starts emitting success responses, or moves the response latency
 * past the hold window, says so instead of being discovered in somebody's Ledger.
 *
 * 🔑 IT IS NOT A UNIT TEST AND IS NOT IN `test:trade`. It needs Star Citizen installed and a real
 * `logbackups/` folder, so it cannot run on a clean machine — which is exactly why the assertions
 * that CAN be made from fixtures live in `src/trade.test.ts` instead. This one exists to check the
 * fixtures still describe the game.
 *
 * The four conclusions it guards, all measured 2026-08-23 over 533 files / 1.47 GB:
 *
 *   1. EVERY response is an `[Error]`. A success emits nothing, which is why the rule is "commit
 *      unless refused" — waiting for an acknowledgement would discard every successful trade.
 *   2. NO response is an orphan: each has a request before it inside the window.
 *   3. The pairing is a BIJECTION — no response is the nearest-following one for two requests.
 *   4. The slowest response (565 ms) is well inside `CONFIRM_WINDOW_MS`, and the tightest gap
 *      between two requests (3,655 ms) is well outside it. A window has to fit between those two
 *      numbers, and this is what proves they are still that far apart.
 */
import { readFileSync, statSync } from "node:fs";
import { parseTradeLine, TradeConfirmations, TRADE_LOG_MARKER } from "../src/trade-log.js";
import { collectLogPaths } from "../src/log-paths.js";

const WINDOW = TradeConfirmations.WINDOW_MS;

/** 🔑 `collectLogPaths` already walks every SIBLING channel plus each one's `logbackups/`, and
 *  deduplicates by the file a path really resolves to — which matters on Sub's install, where the
 *  six channel folders are junctions to one directory. Pass any channel's `game.log`. */
const CONFIGURED = process.argv[2]
  ?? "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/game.log";
const logFiles = (): string[] => collectLogPaths(CONFIGURED);

let bytes = 0, scanned = 0;
let sends = 0, responses = 0, notAnError = 0, orphans = 0, doubleClaims = 0;
const results = new Map<string, number>();
const directions = new Map<string, number>();
const modes = new Map<string, number>();
const respGaps: number[] = [];
const sendGaps: number[] = [];

for (const p of logFiles()) {
  let text: string;
  try {
    if (statSync(p).size > 512 * 1024 * 1024) continue;   // a runaway log is not a data point
    text = readFileSync(p, "utf8");
  } catch { continue; }
  scanned++; bytes += text.length;
  if (!text.includes(TRADE_LOG_MARKER)) continue;

  const reqs: { ms: number; kind: string; mode: string }[] = [];
  const resps: { ms: number; refused: boolean; result: string | null; dir: string | null }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(TRADE_LOG_MARKER)) continue;
    const ev = parseTradeLine(line);
    if (ev?.purchase) {
      const ms = Date.parse(ev.purchase.at);
      if (!Number.isFinite(ms)) continue;
      reqs.push({ ms, kind: ev.purchase.kind, mode: ev.purchase.transactionMode ?? "(none)" });
    } else if (ev?.response) {
      const ms = Date.parse(ev.response.at);
      if (!Number.isFinite(ms)) continue;
      resps.push({ ms, refused: ev.response.refused, result: ev.response.result, dir: ev.response.direction });
    }
  }
  sends += reqs.length;
  responses += resps.length;
  for (let i = 1; i < reqs.length; i++) sendGaps.push(reqs[i].ms - reqs[i - 1].ms);

  const claimed = new Set<number>();
  for (const r of resps) {
    if (!r.refused) notAnError++;
    results.set(r.result ?? "(none)", (results.get(r.result ?? "(none)") ?? 0) + 1);
    directions.set(r.dir ?? "(none)", (directions.get(r.dir ?? "(none)") ?? 0) + 1);
    // Nearest PRECEDING request, the same way the gate resolves one.
    let best = -1, bestGap = Infinity;
    for (let i = 0; i < reqs.length; i++) {
      const d = r.ms - reqs[i].ms;
      if (d >= 0 && d < bestGap) { bestGap = d; best = i; }
    }
    if (best < 0 || bestGap > WINDOW) { orphans++; continue; }
    respGaps.push(bestGap);
    if (claimed.has(best)) doubleClaims++;
    claimed.add(best);
    const m = reqs[best].mode;
    modes.set(`${m} refused`, (modes.get(`${m} refused`) ?? 0) + 1);
  }
  for (let i = 0; i < reqs.length; i++) {
    if (!claimed.has(i)) modes.set(`${reqs[i].mode} ok`, (modes.get(`${reqs[i].mode} ok`) ?? 0) + 1);
  }
}

respGaps.sort((a, b) => a - b);
sendGaps.sort((a, b) => a - b);
const pick = (a: number[], f: number): number => (a.length ? a[Math.floor(a.length * f)] : NaN);

console.log(`scanned ${scanned} log files, ${(bytes / 1e9).toFixed(2)} GB`);
console.log(`  ${sends} Send...Request lines`);
console.log(`  ${responses} RmToken_CommodityTransactionResponse lines  (${sends - respGaps.length} requests answered by silence)`);
console.log(`  result values: ${[...results].map(([k, v]) => `${k} x${v}`).join(", ") || "(none)"}`);
console.log(`  directions:    ${[...directions].map(([k, v]) => `${k} x${v}`).join(", ") || "(none)"}`);
if (respGaps.length) {
  console.log(`  response latency ms: min ${respGaps[0]}  median ${pick(respGaps, 0.5)}  MAX ${respGaps[respGaps.length - 1]}   (window ${WINDOW})`);
}
if (sendGaps.length) {
  console.log(`  request spacing ms:  MIN ${sendGaps[0]}  median ${pick(sendGaps, 0.5)}                     (window ${WINDOW})`);
}
console.log(`  transactionMode -- a CORRELATE, never evidence: ${[...modes].sort().map(([k, v]) => `${k} x${v}`).join(", ")}`);

let bad = 0;
const must = (name: string, ok: boolean, detail: string): void => {
  if (!ok) bad++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok ? "" : "  -- " + detail}`);
};

console.log("");
if (!responses) {
  console.log("  no commodity responses on this machine — nothing to check, and nothing disproved.");
  process.exit(0);
}
// POSITIVE FIRST: a corpus with no requests in it satisfies every rule below for free.
must("there are requests to reason about at all", sends > 0, String(sends));
must("...and responses", responses > 0, String(responses));
must("EVERY response is an [Error] — a success still emits nothing", notAnError === 0, `${notAnError} were not`);
must("no response is an orphan", orphans === 0, `${orphans} had no request within ${WINDOW} ms`);
must("the pairing is a bijection", doubleClaims === 0, `${doubleClaims} responses claimed a request twice`);
must(`the slowest response is inside the ${WINDOW} ms window`,
  respGaps[respGaps.length - 1] < WINDOW, `${respGaps[respGaps.length - 1]} ms`);
must(`the tightest two requests are outside it`,
  !sendGaps.length || sendGaps[0] > WINDOW, `${sendGaps[0]} ms`);

console.log(bad ? `\n${bad} CONCLUSION(S) OVERTURNED — read trade-log.ts before touching anything\n` : "\nevery conclusion still holds\n");
process.exit(bad ? 1 : 0);
