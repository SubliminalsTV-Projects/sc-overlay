/**
 * pricemine — ATTRIBUTION UNDER SUB'S CORRECTED RULE, and the badge that goes with it.
 *
 * Sub, mid-flight: *"the badge that tells how many days ago should represent the latest
 * confirmation. The attribution will be the first person using our app to confirm it over what
 * UEX has."* So there are two different questions per terminal x item pair, and they want two
 * different numbers:
 *
 *   ATTRIBUTION -> who observed this pair FIRST
 *   BADGE       -> when was this pair observed MOST RECENTLY
 *
 * 🔴 AND ONE PREMISE HAS TO BE TESTED, NOT ASSUMED. The strip states that `log-scrub.ts`
 * destroys identity before upload, so retroactive attribution is impossible for the existing
 * corpus. `log-scrub.ts` anonymises the log's CONTENTS — it has nothing to do with the row.
 * `POST /api/bp-tracker/logs` authenticates with the device sync token, resolves it to an owner,
 * and `putSharedLog` stamps `bp_shared_logs.owner_email`. This probe measures whether that
 * column is actually populated, because the whole retroactive-attribution question turns on it.
 *
 * Input 2 is a CSV of `usr,has_owner,rsi_verified,nameable,rows` — md5 prefixes and flags only,
 * no email ever leaves the database.
 *
 * Usage:  npx tsx tools/probe-attribution.ts <lines.b64> <attrib.csv>
 */
import { readFileSync } from "node:fs";
import { ItemShopConfirmations } from "../src/item-shop-log.js";

const NOW = Date.parse("2026-08-24T00:00:00Z");

function med(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function main(): void {
  const rows = readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(Buffer.from(l.trim(), "base64").toString("utf8")) as { id: string; usr: string; ord: number; l: string });

  const flags = new Map<string, { hasOwner: boolean; verified: boolean; nameable: boolean; rows: number }>();
  for (const line of readFileSync(process.argv[3], "utf8").split("\n").slice(1)) {
    const c = line.trim().split(",");
    if (c.length < 5) continue;
    flags.set(c[0], { hasOwner: c[1] === "t", verified: c[2] === "t", nameable: c[3] === "t", rows: Number(c[4]) });
  }

  const byLog = new Map<string, typeof rows>();
  for (const r of rows) { let a = byLog.get(r.id); if (!a) { a = []; byLog.set(r.id, a); } a.push(r); }

  const obs: { at: string; usr: string; pair: string }[] = [];
  const seenTx = new Set<string>();
  for (const ls of byLog.values()) {
    ls.sort((a, b) => a.ord - b.ord);
    const ic = new ItemShopConfirmations();
    for (const r of ls) for (const p of ic.line(r.l.replace(/\r$/, ""))) {
      if (p.kind !== "buy" || p.confirmed !== true || p.unitPrice === null || !p.shopName || !p.itemGuid) continue;
      const tx = JSON.stringify([ls[0].usr, p.at, p.shopName, p.itemGuid, p.quantity, p.totalPrice]);
      if (seenTx.has(tx)) continue; // the live log is re-uploaded as a growing snapshot
      seenTx.add(tx);
      obs.push({ at: p.at, usr: ls[0].usr, pair: JSON.stringify([p.shopName, p.itemGuid]) });
    }
    ic.endOfStream();
  }
  obs.sort((a, b) => a.at.localeCompare(b.at));

  const first = new Map<string, { at: string; usr: string }>();
  const last = new Map<string, string>();
  for (const o of obs) {
    if (!first.has(o.pair)) first.set(o.pair, { at: o.at, usr: o.usr });
    last.set(o.pair, o.at);
  }

  const ok = (c: boolean, label: string, detail: string) => console.log(`${c ? "PASS" : "FAIL"}  ${label}  ${detail}`);

  console.log("=".repeat(78));
  console.log("IS THE EXISTING CORPUS RETROACTIVELY ATTRIBUTABLE?");
  console.log("=".repeat(78));
  const known = [...flags.values()];
  const rowsTotal = known.reduce((a, f) => a + f.rows, 0);
  const rowsOwned = known.filter((f) => f.hasOwner).reduce((a, f) => a + f.rows, 0);
  // 🔑 POSITIVE FIRST — "no row lacks an owner" is free if there are no rows.
  ok(rowsTotal > 0, "there are shared-log rows at all", `${rowsTotal} rows across ${flags.size} contributor groups`);
  ok(rowsOwned === rowsTotal, "EVERY row carries an owner_email", `${rowsOwned} of ${rowsTotal}`);
  console.log(`  -> retroactive attribution of the EXISTING corpus is ${rowsOwned === rowsTotal ? "POSSIBLE" : "PARTIAL"}.`);
  console.log(`     log-scrub.ts anonymises the log CONTENTS; the ROW is stamped by the upload route.`);
  console.log("");

  console.log("=".repeat(78));
  console.log("ATTRIBUTION — first observer per terminal x item pair");
  console.log("=".repeat(78));
  let nameable = 0, verifiedOnly = 0, anon = 0, unknownUsr = 0;
  const perUser = new Map<string, number>();
  for (const f of first.values()) {
    perUser.set(f.usr, (perUser.get(f.usr) ?? 0) + 1);
    const fl = flags.get(f.usr);
    if (!fl) { unknownUsr++; continue; }
    if (fl.nameable) nameable++;
    else if (fl.verified) verifiedOnly++;
    else anon++;
  }
  const pc = (a: number) => `${((a / first.size) * 100).toFixed(1)}%`;
  console.log(`terminal x item pairs with a first observer  : ${first.size}`);
  console.log(`  first observer is RSI-verified AND public  : ${nameable} (${pc(nameable)})  <- a leaderboard could name these`);
  console.log(`  first observer is verified but NOT public  : ${verifiedOnly} (${pc(verifiedOnly)})`);
  console.log(`  first observer has no verified RSI handle  : ${anon} (${pc(anon)})`);
  if (unknownUsr) console.log(`  contributor hash not in the flag table     : ${unknownUsr}`);
  const ranked = [...perUser].sort((a, b) => b[1] - a[1]);
  console.log(`distinct contributors holding a first claim  : ${perUser.size}`);
  console.log(`  top 5 claim counts                         : ${ranked.slice(0, 5).map(([, n]) => n).join(", ")}`);
  console.log(`  share held by the single biggest claimant   : ${((ranked[0][1] / first.size) * 100).toFixed(1)}%`);
  console.log("");

  console.log("=".repeat(78));
  console.log("BADGE — age of the LATEST confirmation, per pair (not per observation)");
  console.log("=".repeat(78));
  const lastAges = [...last.values()].map((t) => (NOW - Date.parse(t)) / 86400000);
  const firstAges = [...first.values()].map((f) => (NOW - Date.parse(f.at)) / 86400000);
  const s = [...lastAges].sort((a, b) => a - b);
  console.log(`pairs                                        : ${last.size}`);
  console.log(`age of latest confirmation  p25 ${s[Math.floor(s.length * 0.25)].toFixed(1)} / median ${med(lastAges).toFixed(1)} / p90 ${s[Math.floor(s.length * 0.9)].toFixed(1)} / max ${s[s.length - 1].toFixed(1)} days`);
  console.log(`age of FIRST sighting       median ${med(firstAges).toFixed(1)} days   <- what the badge must NOT show`);
  console.log(`  gap between the two medians                : ${(med(firstAges) - med(lastAges)).toFixed(1)} days`);
  console.log(`pairs whose latest confirmation is under 30d : ${lastAges.filter((a) => a < 30).length} (${((lastAges.filter((a) => a < 30).length / last.size) * 100).toFixed(1)}%)`);
}

main();
