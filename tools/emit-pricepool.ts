/**
 * poolfill — TURN THE SHARED-LOG CORPUS INTO POOL OBSERVATIONS.
 *
 * `tools/measure-pricemine.ts` proved the corpus is worth mining and printed the verdict. This is
 * the half that ACTS on it: same input, same two SHIPPED parsers, but it emits the rows the site's
 * backfill inserts into the price pool instead of a report.
 *
 *   npx tsx tools/emit-pricepool.ts <shoplines.b64> --out <observations.jsonl> [--stats]
 *
 * ── 🔴 THE CONTRIBUTOR NEVER LEAVES THE SERVER ─────────────────────────────────────────────────
 *
 * Every row carries `logId` — the `site.bp_shared_logs` primary key — and nothing else about who
 * shared it. `owner_email` is populated on 900 of 900 rows and is what first-finder attribution is
 * built from, but resolving it is a JOIN the site does on the VPS. Pulling 57 real email addresses
 * onto a Windows dev box to compute an attribution that gets stored next to the log row they came
 * from would be moving PII for no reason at all.
 *
 * ── 🔴 A FRESH GATE PER LOG ROW, AND THE TWO GATES ARE INVERSES ────────────────────────────────
 *
 * Each `bp_shared_logs` row is one uploaded session — a complete rotated log, or the tail of a live
 * one — so the file boundary is real and `endOfStream()` applies. The gates then behave in OPPOSITE
 * directions and copying either rule to the other side books garbage:
 *
 *   · ITEMS      — an item shop answers every request, so commit ONLY on `result[Success]`.
 *                  `endOfStream()` confirms NOTHING; an unanswered request is abandoned.
 *   · COMMODITIES— a successful commodity trade emits no response at all (0 successes in 39
 *                  responses across the corpus), so commit UNLESS a refusal claims the request
 *                  inside the window, and `flush()` commits what is still held.
 *
 * ── 🔴 THE STREAM IS FILTERED, AND THAT IS A REAL CHANGE TO A GATE'S INPUT ─────────────────────
 *
 * The extract keeps only lines carrying a parser's exported marker, and both gates are documented
 * as wanting every line because the boring ones move their clock. It is safe here and it is checked
 * rather than asserted: a refusal and a `result[Success]` both carry their component's marker, so
 * neither gate can lose its evidence, and `tools/control-poolfill.ts` replays whole sessions BOTH
 * ways and requires the confirmed sets to be identical — then requires them to DIFFER once the
 * server's answer lines are dropped, so the agreement is not free.
 *
 * ── 🔴 WHAT IS AND IS NOT A PRICE ──────────────────────────────────────────────────────────────
 *
 * `unitSource` is carried on every row and the site publishes only `stated`:
 *
 *   · an item BUY   — `client_price` is the STACK TOTAL and the log states an exact integer
 *                     quantity, so `total / quantity` is arithmetic on two stated numbers.
 *                     Recorded as `stated`.
 *   · a commodity BUY  — the shop states `shopPricePerCentiSCU` outright. `stated`.
 *   · a commodity SELL — states no unit price, and flight `gemmass` proved the `Cargo Box Data`
 *                     figure is the crate's CAPACITY rather than its contents, so `total / volume`
 *                     is a FLOOR (median 0.790 of the truth, i.e. a typical estimate runs 21% low).
 *                     Recorded as `derived`, stored, and NOT published as a price. Sub's ruling for
 *                     this slice is that only what was observed may be shown.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ItemShopConfirmations, type ItemPurchase } from "../src/item-shop-log.js";
import { TradeConfirmations, type CommodityPurchase } from "../src/trade-log.js";

interface Row { id: string; usr: string; kind: string; created: string; ord: number; l: string }

/** One row of the backfill payload. Deliberately ONE shape for both catalogues, with a `kind`
 *  discriminator — the same call the app's `ObservedPriceStore` makes, and for the same reason:
 *  two parallel shapes drift in their freshness rules and their caps. */
export interface PoolWireRow {
  /** `site.bp_shared_logs.id`. The site resolves this to a contributor; see the header. */
  logId: string;
  kind: "item" | "commodity";
  side: "buy" | "sell";
  /** `itemClassGUID` or `resourceGUID`, lowercased. The one clean join in either subsystem. */
  id: string;
  /** The game's own shop token. THE terminal identity — `shopId` is per-session and re-minted. */
  terminal: string;
  shopId: string;
  /** ISO, off the LOG LINE's own timestamp. Never the moment of replay: a backfill that stamped
   *  every row with "now" would report a 39-day corpus as one second old, which is the exact
   *  opposite of the thing this whole flight is for. */
  at: string;
  /** Per item, or per SCU. */
  unitPrice: number;
  /** See the header. Only `stated` is published as a price. */
  unitSource: "stated" | "derived";
  /** Items bought, or SCU that changed hands. */
  quantity: number;
  total: number;
  /** The game's internal item name. Diagnosis only; never shown to a player. */
  token: string | null;
  /** Commodities only. `ResourceContainer` | `CargoGrid` | `Location` | `Entities`. */
  transactionMode: string | null;
  /** SCU per container and how many, when the line states them. Null on an item and on a sell
   *  with an empty manifest. */
  boxScu: number | null;
  unitAmount: number | null;
}

interface Stats {
  logs: number;
  lines: number;
  itemRequests: number; itemConfirmed: number; itemRefused: number; itemAbandoned: number;
  commRequests: number; commConfirmed: number; commRefused: number;
  itemRows: number; commRows: number;
  dupItem: number; dupComm: number;
  droppedUnknownVolume: number;
  statedRows: number; derivedRows: number;
  pairs: number; terminals: number; catalogueIds: number;
}

/**
 * 🔴 DEDUPE ON THE GAME'S OWN MILLISECOND TIMESTAMP, KEYED WITH THE CONTRIBUTOR.
 *
 * `maybeShareLog` re-uploads the LIVE `Game.log` on every tick whose scrubbed content changed, and
 * the game writes one GROWING file per launch — so a single play session arrives as N rows, each a
 * superset of the last. Counting rows counts one transaction up to N times, and it is worse than
 * inflation: it plants duplicate observations of one pair AT ONE TIMESTAMP, which reads downstream
 * as "we saw this price twice and it did not move".
 *
 * ⚠️ The contributor is part of the key on purpose, so two players at one shop in the same
 * millisecond stay two observations rather than collapsing into one.
 */
function dedupeKey(r: PoolWireRow, usr: string): string {
  return JSON.stringify([usr, r.at, r.kind, r.id, r.terminal, r.side, r.total]);
}

function itemRow(p: ItemPurchase, logId: string): PoolWireRow | null {
  if (p.confirmed !== true) return null;
  // 🔴 `rent` is not a price. Every rental in the corpus is logged at `client_price[0]`, and a
  // zero published as a price would read as "this is free".
  if (p.kind !== "buy") return null;
  if (!p.shopName || !p.itemGuid) return null;
  if (p.unitPrice === null || !(p.unitPrice > 0)) return null;
  return {
    logId,
    kind: "item",
    side: "buy",
    id: p.itemGuid.toLowerCase(),
    terminal: p.shopName,
    shopId: p.shopId ?? "",
    at: p.at,
    unitPrice: p.unitPrice,
    unitSource: "stated",
    quantity: p.quantity ?? 1,
    total: p.totalPrice ?? p.unitPrice,
    token: p.itemName,
    transactionMode: null,
    boxScu: null,
    unitAmount: null,
  };
}

function commodityRow(p: CommodityPurchase, logId: string): PoolWireRow | null {
  if (p.confirmed !== true) return null;
  if (!p.shopName || !p.resourceGuid) return null;
  // 🔴 THE UNION IS THE FILTER. A sell with no cargo-box manifest arrives `known: false` and there
  // is no `?? 0` to fall into — that is the entire point of the shape flight `sellvolume` gave it.
  if (!p.unitPrice.known || !p.volume.known) return null;
  if (!(p.unitPrice.perScu > 0)) return null;
  if (p.total === null) return null;
  return {
    logId,
    kind: "commodity",
    side: p.kind,
    id: p.resourceGuid.toLowerCase(),
    terminal: p.shopName,
    shopId: p.shopId ?? "",
    at: p.at,
    unitPrice: p.unitPrice.perScu,
    unitSource: p.unitPrice.source,
    quantity: p.volume.scu,
    total: p.total,
    token: null,
    transactionMode: p.transactionMode,
    boxScu: p.boxScu,
    unitAmount: p.unitAmount,
  };
}

/** Replay one corpus into wire rows. Exported so the negative control drives the same code the
 *  emitter does rather than a second copy of it. */
export function emit(rows: Row[]): { out: PoolWireRow[]; stats: Stats } {
  const byLog = new Map<string, Row[]>();
  for (const r of rows) {
    let a = byLog.get(r.id);
    if (!a) { a = []; byLog.set(r.id, a); }
    a.push(r);
  }
  for (const a of byLog.values()) a.sort((x, y) => x.ord - y.ord);

  const stats: Stats = {
    logs: byLog.size, lines: rows.length,
    itemRequests: 0, itemConfirmed: 0, itemRefused: 0, itemAbandoned: 0,
    commRequests: 0, commConfirmed: 0, commRefused: 0,
    itemRows: 0, commRows: 0, dupItem: 0, dupComm: 0,
    droppedUnknownVolume: 0, statedRows: 0, derivedRows: 0,
    pairs: 0, terminals: 0, catalogueIds: 0,
  };

  const seen = new Set<string>();
  const out: PoolWireRow[] = [];

  for (const [logId, lines] of byLog) {
    const usr = lines[0].usr;
    const ic = new ItemShopConfirmations();
    const tc = new TradeConfirmations();
    const items: ItemPurchase[] = [];
    const comms: CommodityPurchase[] = [];

    for (const r of lines) {
      const raw = r.l.replace(/\r$/, "");
      for (const p of ic.line(raw)) items.push(p);
      for (const p of tc.line(raw)) comms.push(p);
    }
    // 🔴 OPPOSITE VERBS, DELIBERATELY. `endOfStream()` ABANDONS what an item shop never answered;
    // `flush()` COMMITS what no commodity refusal ever claimed. See the header.
    stats.itemAbandoned += ic.endOfStream().length;
    stats.itemRefused += ic.refused().length;
    for (const p of tc.flush()) comms.push(p);
    stats.commRefused += tc.refused().length;

    for (const p of items) {
      stats.itemRequests++;
      if (p.confirmed === true) stats.itemConfirmed++;
      const row = itemRow(p, logId);
      if (!row) continue;
      const k = dedupeKey(row, usr);
      if (seen.has(k)) { stats.dupItem++; continue; }
      seen.add(k);
      out.push(row);
      stats.itemRows++;
    }
    for (const p of comms) {
      stats.commRequests++;
      if (p.confirmed === true) stats.commConfirmed++;
      const row = commodityRow(p, logId);
      if (!row) {
        if (p.confirmed === true && p.shopName && p.resourceGuid && !p.volume.known) {
          stats.droppedUnknownVolume++;
        }
        continue;
      }
      const k = dedupeKey(row, usr);
      if (seen.has(k)) { stats.dupComm++; continue; }
      seen.add(k);
      out.push(row);
      stats.commRows++;
    }
  }

  for (const r of out) (r.unitSource === "stated" ? stats.statedRows++ : stats.derivedRows++);
  stats.pairs = new Set(out.map((r) => JSON.stringify([r.kind, r.id, r.terminal, r.side]))).size;
  stats.terminals = new Set(out.map((r) => r.terminal)).size;
  stats.catalogueIds = new Set(out.map((r) => JSON.stringify([r.kind, r.id]))).size;
  return { out, stats };
}

export function readCorpus(path: string): Row[] {
  // 🔴 BASE64 ON THE SERVER SIDE. psql's `\copy … to stdout` uses TEXT format, which
  // backslash-escapes the payload — a JSON string's own `\n` comes back as a literal two-character
  // sequence and a whole-log column arrives as ONE line. Encoding before it hits the wire removes
  // the question; it is the same family as this repo's CRLF-anchor and NUL-byte traps.
  const rows: Row[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(Buffer.from(line.trim(), "base64").toString("utf8")) as Row);
  }
  return rows;
}

function main(): void {
  const path = process.argv[2];
  if (!path) throw new Error("usage: emit-pricepool.ts <shoplines.b64> --out <observations.jsonl>");
  const oi = process.argv.indexOf("--out");
  const outPath = oi > 0 ? process.argv[oi + 1] : "";

  const { out, stats } = emit(readCorpus(path));

  const say = (s: string) => console.log(s);
  say("=".repeat(70));
  say("POOLFILL — observations emitted from the shared-log corpus");
  say("=".repeat(70));
  say(`shared-log rows replayed              : ${stats.logs}`);
  say(`lines read                            : ${stats.lines}`);
  say("");
  say(`item purchases parsed                 : ${stats.itemRequests}`);
  say(`  confirmed (result[Success])         : ${stats.itemConfirmed}`);
  say(`  refused / never answered            : ${stats.itemRefused} / ${stats.itemAbandoned}`);
  say(`  emitted                             : ${stats.itemRows}  [${stats.dupItem} dropped as re-uploads]`);
  say("");
  say(`commodity transactions parsed         : ${stats.commRequests}`);
  say(`  confirmed (no refusal in window)    : ${stats.commConfirmed}`);
  say(`  refused                             : ${stats.commRefused}`);
  say(`  dropped: sell with unknowable volume: ${stats.droppedUnknownVolume}`);
  say(`  emitted                             : ${stats.commRows}  [${stats.dupComm} dropped as re-uploads]`);
  say("");
  say(`TOTAL rows                            : ${out.length}`);
  say(`  publishable as a price (stated)     : ${stats.statedRows}`);
  say(`  stored but not published (derived)  : ${stats.derivedRows}`);
  say(`distinct terminal x id x side pairs   : ${stats.pairs}`);
  say(`distinct catalogue entries            : ${stats.catalogueIds}`);
  say(`distinct game shop tokens             : ${stats.terminals}`);

  if (outPath) {
    writeFileSync(outPath, out.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    say("");
    say(`wrote ${out.length} rows -> ${outPath}`);
  }
}

// Only run as a script; the control imports `emit` directly.
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/emit-pricepool.ts")) main();
