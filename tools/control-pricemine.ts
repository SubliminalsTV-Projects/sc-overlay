/**
 * pricemine — NEGATIVE CONTROL ON THE MEASUREMENT, NOT ON THE SEARCH.
 *
 * `measure-pricemine.ts` replays only the lines the extract query kept (anything containing
 * `CEntityComponentShop` or `CEntityComponentCommodityUIProvider::`). Both confirmation gates
 * are documented as needing EVERY line, because the boring lines are what move their clock.
 * Feeding them a filtered stream is therefore a real change to their input, and a silently
 * different answer here would put a precise, confident, wrong number into the strip.
 *
 * So: take complete uploaded sessions, run each gate BOTH ways — full text and extracted lines
 * only — and assert the confirmed sets are identical, field for field.
 *
 * Then the second half, which is the one the brief actually demands: a positive control that
 * prints the RAW LINES behind one terminal x item pair and one terminal x commodity pair, so a
 * human can check the aggregate against the log by eye.
 *
 * Usage:  npx tsx tools/control-pricemine.ts <fulllogs.jsonl>
 */
import { readFileSync } from "node:fs";
import { ItemShopConfirmations, ITEM_SHOP_LOG_MARKER } from "../src/item-shop-log.js";
import { TradeConfirmations, TRADE_LOG_MARKER } from "../src/trade-log.js";

interface Full { id: string; usr: string; kind: string; created: string; scrubbed: string }

function replay(lines: string[]): { items: string[]; comms: string[] } {
  const ic = new ItemShopConfirmations();
  const tc = new TradeConfirmations();
  const items: string[] = [];
  const comms: string[] = [];
  for (const raw of lines) {
    for (const p of ic.line(raw)) items.push(JSON.stringify([p.at, p.shopName, p.itemGuid, p.quantity, p.totalPrice, p.unitPrice, p.resultCode]));
    for (const p of tc.line(raw)) comms.push(JSON.stringify([p.at, p.kind, p.shopName, p.resourceGuid, p.scu, p.pricePerScu, p.total]));
  }
  ic.endOfStream();
  for (const p of tc.flush()) comms.push(JSON.stringify([p.at, p.kind, p.shopName, p.resourceGuid, p.scu, p.pricePerScu, p.total]));
  return { items, comms };
}

function main(): void {
  const path = process.argv[2];
  // Base64 for the reason in measure-pricemine.ts: psql TEXT format backslash-escapes, which
  // collapsed a whole log into one line and made this control silently vacuous.
  const logs: Full[] = readFileSync(path, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(Buffer.from(l.trim(), "base64").toString("utf8")));

  let fails = 0;
  const ok = (cond: boolean, label: string, detail: string) => {
    if (!cond) fails++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}  ${detail}`);
  };

  console.log("=".repeat(78));
  console.log("CONTROL A — filtered stream must equal full stream");
  console.log("=".repeat(78));
  let totalFullItems = 0, totalFullComms = 0;
  for (const lg of logs) {
    const all = lg.scrubbed.split("\n").map((s) => s.replace(/\r$/, ""));
    const kept = all.filter((s) => s.includes(ITEM_SHOP_LOG_MARKER) || s.includes(TRADE_LOG_MARKER));
    const full = replay(all);
    const filt = replay(kept);
    totalFullItems += full.items.length;
    totalFullComms += full.comms.length;
    // 🔑 POSITIVE FIRST. "the two agree" is free when both are empty, and an empty log is exactly
    // what a broken extraction produces — so assert there is something to disagree about.
    ok(full.items.length + full.comms.length > 0, `${lg.id} has signal`, `${all.length} lines -> ${kept.length} kept, ${full.items.length} item + ${full.comms.length} commodity confirmations on the FULL stream`);
    ok(JSON.stringify(full.items) === JSON.stringify(filt.items), `${lg.id} items identical`, `full ${full.items.length} vs filtered ${filt.items.length}`);
    ok(JSON.stringify(full.comms) === JSON.stringify(filt.comms), `${lg.id} commodities identical`, `full ${full.comms.length} vs filtered ${filt.comms.length}`);
  }
  ok(totalFullItems > 0 && totalFullComms > 0, "both economies exercised", `${totalFullItems} item + ${totalFullComms} commodity confirmations across ${logs.length} sessions`);

  // 🔴 THE CONTROL ON THE CONTROL. "full equals filtered" is satisfied for free by a filter that
  // happens to be harmless on a thin corpus, and by two empty sets. So break the filter the way a
  // careless extract query would — keep the REQUESTS and drop the server's answers — and require
  // the comparison to notice. If this block does not go red, the block above proves nothing.
  //
  // ⚠️ It must break in OPPOSITE directions for the two economies, and that is the whole point of
  // the two gates being inverses: dropping the answers makes the item side confirm NOTHING
  // (silence confirms nothing there) and the commodity side confirm MORE (silence confirms
  // everything there, so every refused trade books). One injection, two failure modes.
  let brokeItems = false, brokeComms = false;
  for (const lg of logs) {
    const all = lg.scrubbed.split("\n").map((s) => s.replace(/\r$/, ""));
    const full = replay(all);
    const maimed = replay(all.filter((s) => !s.includes("RmShopFlowResponse") && !s.includes("::ClOnCommodityTransactionResponse") && !(s.includes(TRADE_LOG_MARKER) && s.includes("[Error]"))));
    if (JSON.stringify(full.items) !== JSON.stringify(maimed.items)) brokeItems = true;
    if (JSON.stringify(full.comms) !== JSON.stringify(maimed.comms)) brokeComms = true;
  }
  ok(brokeItems, "control CAN fail (items)", "dropping the server's answers changes the item result");
  ok(brokeComms, "control CAN fail (commodities)", "dropping the refusals changes the commodity result");

  console.log("");
  console.log("=".repeat(78));
  console.log("CONTROL B — the RAW LINES behind one pair of each kind, for a hand check");
  console.log("=".repeat(78));
  const wantItem = process.env.CTRL_ITEM ?? "";
  const wantComm = process.env.CTRL_COMM ?? "";
  for (const lg of logs) {
    for (const raw of lg.scrubbed.split("\n")) {
      const s = raw.replace(/\r$/, "");
      if (wantItem && s.includes(wantItem) && (s.includes("BuyRequest") || s.includes("RmShopFlowResponse"))) console.log("ITEM  " + s.slice(0, 400));
      if (wantComm && s.includes(wantComm) && s.includes(TRADE_LOG_MARKER)) console.log("COMM  " + s.slice(0, 400));
    }
  }

  console.log("");
  console.log(fails ? `FAILED (${fails})` : "all controls passed");
  process.exit(fails ? 1 : 0);
}

main();
