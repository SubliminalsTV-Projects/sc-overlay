/**
 * RE-DERIVE THE ITEM-SHOP CENSUS FROM EVERY REAL LOG ON THIS MACHINE.  `npm run measure:itemshops`
 *
 * 🔑 A CENSUS WRITTEN INTO A CODE COMMENT IS A CLAIM THAT ROTS; A CENSUS YOU CAN RE-RUN IS A FACT.
 * Same shape as `measure:tradeconfirm` and `measure:terminalorigin`: this is NOT a unit test and
 * is deliberately not in any `test:` script, because it needs Star Citizen installed. It EXITS
 * NON-ZERO the moment one of the conclusions `item-shop-log.ts` rests on is overturned — a build
 * that starts emitting item SELLS, a latency that outgrows the hold window, a fourth purchase verb.
 *
 * ⚠️ Read the OUTPUT as well as the exit code. Several checks are advisory and say so.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseItemShopLine,
  ItemShopConfirmations,
  ITEM_SHOP_LOG_MARKER,
} from "../src/item-shop-log.js";

const ROOTS = [
  "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/logbackups",
  join(process.env.USERPROFILE ?? "", "SC-Data-Mirror", "logbackups"),
];

let bad = 0;
const check = (cond: boolean, name: string, detail = "") => {
  if (cond) console.log(`ok    ${name}${detail ? "  [" + detail + "]" : ""}`);
  else { bad++; console.log(`OVERTURNED  ${name}${detail ? "  [" + detail + "]" : ""}`); }
};
const note = (name: string, detail: string) => console.log(`      ${name}  [${detail}]`);

const dir = ROOTS.find((d) => d && existsSync(d));
if (!dir) {
  console.log("no logbackups folder found — this measurement needs Star Citizen installed.");
  process.exit(0);
}

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith(".log"))
  .map((f) => join(dir, f))
  .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

console.log(`reading ${files.length} rotated logs from ${dir}\n`);

interface Row { file: string; verb: string; family: string; ms: number; ev: ReturnType<typeof parseItemShopLine> }
const rows: Row[] = [];
let shopLines = 0, totalLines = 0;

for (const f of files) {
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    totalLines++;
    if (!line.includes(ITEM_SHOP_LOG_MARKER)) continue;
    shopLines++;
    const ev = parseItemShopLine(line);
    if (!ev) continue;
    const ts = /^<([^>]+)>/.exec(line);
    const ms = ts ? Date.parse(ts[1]) : NaN;
    const verb = ev.purchase?.verb ?? (ev.response ? "RmShopFlowResponse" : ev.unknownMethod ?? "?");
    const family = ev.purchase?.family ?? ev.response?.family ?? "?";
    rows.push({ file: f, verb, family, ms, ev });
  }
}

const purchases = rows.filter((r) => r.ev?.purchase);
const responses = rows.filter((r) => r.ev?.response);
const unknown = rows.filter((r) => r.ev?.unknownMethod);

console.log(`── SHAPE ──`);
note("lines scanned", String(totalLines));
note("item-shop lines", String(shopLines));
note("purchases", String(purchases.length));
note("responses", String(responses.length));

// ── 1. THE VERB SET. A fourth purchase verb is the failure this file exists to catch. ─────────
const verbs = new Map<string, number>();
for (const r of rows) verbs.set(`${r.family}::${r.verb}`, (verbs.get(`${r.family}::${r.verb}`) ?? 0) + 1);
console.log(`\n── VERBS ──`);
for (const [v, n] of [...verbs].sort((a, b) => b[1] - a[1])) note(v, String(n));
check(unknown.length === 0,
  "🔴 no UNMODELLED verb on either shop component",
  unknown.length ? [...new Set(unknown.map((u) => u.ev!.unknownMethod))].join(", ") : "0");

// ── 2. THE CONFIRMATION VOCABULARY ────────────────────────────────────────────────────────────
const results = new Map<string, number>();
const directions = new Map<string, number>();
for (const r of responses) {
  const k = r.ev!.response!.result ?? "(none)";
  results.set(k, (results.get(k) ?? 0) + 1);
  const d = r.ev!.response!.direction ?? "(none)";
  directions.set(d, (directions.get(d) ?? 0) + 1);
}
console.log(`\n── RESPONSES ──`);
for (const [k, n] of [...results].sort((a, b) => b[1] - a[1])) note(`result[${k}]`, String(n));
for (const [k, n] of [...directions].sort((a, b) => b[1] - a[1])) note(`type[${k}]`, String(n));

check(results.has("Success"),
  "🔴 a SUCCESS is still stated explicitly — the whole commit rule rests on this",
  `${results.get("Success") ?? 0} of ${responses.length}`);
check(!directions.has("sell"),
  "no item SELL exists (the parser reads a buy price only)",
  directions.has("sell") ? `${directions.get("sell")} sells appeared — the model needs extending` : "0");

// 🔴 The severity trap: if these ever became [Error] lines, a future reader might reintroduce
// severity-based matching. Assert the CURRENT truth so the comment cannot rot silently.
let noticeResp = 0;
for (const f of files) {
  let text: string; try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const line of text.split(/\r?\n/)) {
    if (line.includes("RmShopFlowResponse") && line.includes(ITEM_SHOP_LOG_MARKER)) {
      if (/^<[^>]+>\s*\[Notice\]/.test(line)) noticeResp++;
    }
  }
}
check(noticeResp === responses.length,
  "🔴 EVERY response is a [Notice], refusals included — severity can never be the discriminator",
  `${noticeResp} of ${responses.length}`);

// ── 3. `client_price` IS THE TOTAL ────────────────────────────────────────────────────────────
const groups = new Map<string, { qty: number; price: number; item: string }[]>();
for (const r of purchases) {
  const p = r.ev!.purchase!;
  if (p.kind !== "buy" || !p.itemGuid || !p.shopName || p.quantity === null || p.totalPrice === null) continue;
  const k = JSON.stringify([p.itemGuid, p.shopName]);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push({ qty: p.quantity, price: p.totalPrice, item: p.itemName ?? "?" });
}
let saysTotal = 0, saysUnit = 0, ambiguous = 0;
for (const g of groups.values()) {
  const byQ = new Map<number, number>();
  for (const x of g) byQ.set(x.qty, x.price);
  const arr = [...byQ].sort((a, b) => a[0] - b[0]);
  if (arr.length < 2) continue;
  const [q0, p0] = arr[0];
  for (const [q, p] of arr.slice(1)) {
    const asTotal = Math.abs(p / q - p0 / q0) < 0.01;
    const asUnit = Math.abs(p - p0) < 0.01;
    if (asTotal && !asUnit) saysTotal++;
    else if (asUnit && !asTotal) saysUnit++;
    else ambiguous++;
  }
}
const multi = purchases.filter((r) => (r.ev!.purchase!.quantity ?? 1) > 1).length;
console.log(`\n── client_price ──`);
note("same-item-same-shop pairs at differing quantity", `TOTAL ${saysTotal} · UNIT ${saysUnit} · ambiguous ${ambiguous}`);
note("purchases with quantity > 1", `${multi} of ${purchases.length} (${(multi / purchases.length * 100).toFixed(1)}%)`);
check(saysTotal > 0 && saysUnit === 0,
  "🔴 `client_price` is the STACK TOTAL — the unit price must stay total/quantity",
  `${saysTotal} for, ${saysUnit} against`);

// ── 4. THE PAIRING, PER FAMILY, AND THE LATENCY THAT SIZES THE HOLD WINDOW ────────────────────
console.log(`\n── PAIRING (per family, per file, FIFO) ──`);
const lat: Record<string, number[]> = { ShopUIProvider: [], ShoppingProvider: [] };
let unanswered = 0, orphan = 0, maxDepth = 0;
for (const f of files) {
  const fr = rows.filter((r) => r.file === f && Number.isFinite(r.ms));
  for (const fam of ["ShopUIProvider", "ShoppingProvider"] as const) {
    const q: number[] = [];
    for (const r of fr.filter((x) => x.family === fam)) {
      if (r.ev?.purchase) { q.push(r.ms); maxDepth = Math.max(maxDepth, q.length); }
      else if (r.ev?.response) {
        const t = q.shift();
        if (t === undefined) orphan++;
        else lat[fam].push(r.ms - t);
      }
    }
    unanswered += q.length;
  }
}
const stat = (a: number[]) => {
  if (!a.length) return "n=0";
  const s = [...a].sort((x, y) => x - y);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return `min ${s[0]} p50 ${p(0.5)} p90 ${p(0.9)} max ${s[s.length - 1]} (n=${s.length})`;
};
for (const fam of ["ShopUIProvider", "ShoppingProvider"] as const) note(`${fam} latency ms`, stat(lat[fam]));
note("max queue depth", String(maxDepth));
check(orphan === 0, "no response arrives with no request outstanding (FIFO is safe)", String(orphan));
check(unanswered === 0, "no request is left unanswered inside a file", String(unanswered));

const worst = Math.max(...lat.ShopUIProvider, ...lat.ShoppingProvider, 0);
check(worst < ItemShopConfirmations.MAX_HOLD_MS,
  "🔴 the slowest real round trip still fits inside MAX_HOLD_MS",
  `worst ${worst} ms vs window ${ItemShopConfirmations.MAX_HOLD_MS} ms (${(ItemShopConfirmations.MAX_HOLD_MS / Math.max(worst, 1)).toFixed(1)}x)`);
check(maxDepth <= ItemShopConfirmations.MAX_HELD,
  "the queue never approaches the runaway guard",
  `${maxDepth} vs ${ItemShopConfirmations.MAX_HELD}`);

// ── 5. THE GATE, RUN FOR REAL OVER EVERY FILE ────────────────────────────────────────────────
console.log(`\n── THE GATE, END TO END ──`);
let confirmed = 0, refused = 0, abandoned = 0;
const confirmedItems = new Set<string>();
for (const f of files) {
  let text: string; try { text = readFileSync(f, "utf8"); } catch { continue; }
  // A FRESH gate per file: these are COMPLETE rotated logs, so the seam that matters for the live
  // stream does not exist here. `endOfStream()` at the end of each is what bounds the queue.
  const gate = new ItemShopConfirmations();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    for (const p of gate.line(line)) {
      confirmed++;
      if (p.itemGuid) confirmedItems.add(p.itemGuid);
    }
  }
  abandoned += gate.endOfStream().length;
  refused += gate.refused().length;
}
note("confirmed purchases", String(confirmed));
note("explicitly refused", String(refused));
note("unanswered at end of file", String(abandoned));
note("distinct items with a confirmed price", String(confirmedItems.size));
check(confirmed > 0, "the gate confirms real purchases (it is not simply refusing everything)", String(confirmed));
check(confirmed + refused + abandoned === purchases.filter((r) => Number.isFinite(r.ms)).length,
  "every purchase is accounted for — confirmed, refused, or reported unanswered",
  `${confirmed} + ${refused} + ${abandoned} vs ${purchases.filter((r) => Number.isFinite(r.ms)).length}`);

// ── 6. THE JOIN INTO THE VERSE FINDER'S TABLE ────────────────────────────────────────────────
const tablePath = join(process.env.APPDATA ?? "", "sc-blueprint-tracker", "item-shops.json");
if (existsSync(tablePath)) {
  try {
    const t = JSON.parse(readFileSync(tablePath, "utf8")) as { items?: { u?: string | null }[] };
    const known = new Set((t.items ?? []).map((i) => String(i.u ?? "").toLowerCase()).filter(Boolean));
    const hit = [...confirmedItems].filter((g) => known.has(g)).length;
    console.log(`\n── THE JOIN ──`);
    note("itemClassGUID -> ShopItem.u", `${hit} of ${confirmedItems.size} (${(hit / Math.max(confirmedItems.size, 1) * 100).toFixed(1)}%)`);
    check(hit > 0, "🔴 a confirmed purchase can be matched to a Verse Finder row", `${hit} resolve`);
  } catch { /* advisory only */ }
}

console.log(`\n${bad ? `OVERTURNED (${bad}) — a conclusion item-shop-log.ts rests on no longer holds` : "all conclusions still hold"}`);
process.exit(bad ? 1 : 0);
