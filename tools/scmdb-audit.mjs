#!/usr/bin/env node
// Cross-reference our shipped mission dataset against scmdb.net.
//
// This is an OCCASIONAL validation tool, not a pipeline step (Sub, 2026-08-13) — run it
// when you want a second opinion on the extraction, not after every patch.
//
//   node tools/scmdb-audit.mjs            audit the newest local dataset
//   node tools/scmdb-audit.mjs --refresh  re-download instead of using the cache
//   node tools/scmdb-audit.mjs --payouts  also compare against real observed payouts
//
// 🔑 It REFUSES to run unless scmdb publishes our exact changelist. Comparing a 4.9.0
// dataset against their 4.10.0 PTU dump would report hundreds of "disagreements" that are
// just CIG re-tiering missions between patches — a diff that loud is worse than no diff.
//
// 🔑 scmdb's robots.txt disallows /data/ for CRAWLERS. This fetches two files on demand,
// which is what their own SPA does. Do not put it on a schedule without asking them first.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = "https://scmdb.net/data";
const CACHE = join(tmpdir(), "scmdb-audit");
const REFRESH = process.argv.includes("--refresh");
const WANT_PAYOUTS = process.argv.includes("--payouts");

const nf = (n) => (n == null ? "—" : n.toLocaleString("en-US"));
const h1 = (s) => console.log("\n" + s + "\n" + "=".repeat(s.length));

/** Their debugName and our mission key are the same string in a different dialect: some of
 *  ours carry a " (DISABLED)" suffix the contract records don't. Nothing else differs. */
const normKey = (k) => k.replace(/\s*\(DISABLED\)\s*$/i, "").trim().toLowerCase();

/** The mobiGlas board abbreviates money ("63k", "1M"), so any board-scanned payout is the
 *  real value FLOORED to that magnitude. Our own parser already flags these `rounded`. */
const boardForms = (exact) => [exact, Math.floor(exact / 1e3) * 1e3, Math.floor(exact / 1e6) * 1e6];

async function cached(file) {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, file);
  if (existsSync(path) && !REFRESH) return JSON.parse(readFileSync(path, "utf8"));
  process.stderr.write("fetching " + file + " ... ");
  const res = await fetch(BASE + "/" + file);
  if (!res.ok) throw new Error("scmdb " + file + " -> HTTP " + res.status);
  const text = await res.text();
  writeFileSync(path, text);
  process.stderr.write("ok (" + (text.length / 1e6).toFixed(1) + " MB)\n");
  return JSON.parse(text);
}

/** Newest blueprints.<changelist>.json in data/ — never `latest`, which is a copy and
 *  would leave the report unable to name the changelist it actually audited. */
function newestLocal() {
  const files = readdirSync("data").filter((f) => /^blueprints\.\d+\.json$/.test(f));
  if (!files.length) throw new Error("no data/blueprints.<changelist>.json found");
  const pick = files.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  return { file: pick, data: JSON.parse(readFileSync(join("data", pick), "utf8")) };
}

const main = async () => {
  const { file, data: ours } = newestLocal();
  console.log("local dataset : " + file + "  (" + ours.version + ")");

  const versions = await cached("versions.json");
  const match = versions.find((v) => v.version.toLowerCase() === String(ours.version).toLowerCase());
  if (!match) {
    console.error("\nscmdb does not publish our changelist (" + ours.version + ").");
    console.error("they currently have: " + versions.map((v) => v.version).join(", "));
    console.error("\nRefusing to compare across changelists — the diff would be patch drift, not error.");
    process.exit(2);
  }
  console.log("scmdb dataset : " + match.file);

  const them = await cached(match.file);

  // ---- index their side -------------------------------------------------------------
  const byKey = new Map();
  for (const c of them.contracts) {
    for (const dn of c.debugNames?.length ? c.debugNames : [c.debugName]) {
      if (dn) byKey.set(normKey(dn), c);
    }
  }

  // ---- 1. blueprint pools: the hard join, and our regression alarm --------------------
  h1("1. BLUEPRINT POOLS  (joined on pool GUID — same namespace both sides)");
  const ourPools = new Map();
  for (const m of Object.values(ours.missions)) {
    for (const [guid, entries] of Object.entries(m.pools ?? {})) {
      if (!ourPools.has(guid)) ourPools.set(guid, entries);
    }
  }
  const shared = [...ourPools.keys()].filter((g) => them.blueprintPools[g]);
  const orphans = Object.keys(them.blueprintPools).filter((g) => !ourPools.has(g));
  console.log("ours " + ourPools.size + " · theirs " + Object.keys(them.blueprintPools).length + " · shared " + shared.length);

  const contentDiffs = [];
  for (const guid of shared) {
    const a = [...new Set(ourPools.get(guid).map((e) => e.item))].sort();
    const b = [...new Set(them.blueprintPools[guid].blueprints.map((e) => e.entityClass))].sort();
    if (a.join() === b.join()) continue;
    const A = new Set(a), B = new Set(b);
    contentDiffs.push({
      name: them.blueprintPools[guid].name,
      guid,
      theyHave: them.blueprintPools[guid].blueprints.filter((e) => !A.has(e.entityClass)).map((e) => e.name),
      weHave: ourPools.get(guid).filter((e) => !B.has(e.item)).map((e) => e.blueprint),
    });
  }
  if (!contentDiffs.length) {
    console.log("✅ pool CONTENTS identical on all " + shared.length + " shared pools.");
  } else {
    console.log("🔴 " + contentDiffs.length + " pools disagree — investigate before shipping:");
    for (const d of contentDiffs) {
      console.log("   " + d.name + "  (" + d.guid.slice(0, 8) + ")");
      if (d.theyHave.length) console.log("      scmdb has, we DON'T : " + d.theyHave.join(" | "));
      if (d.weHave.length) console.log("      we have, scmdb DOESN'T: " + d.weHave.join(" | "));
    }
  }
  console.log("\npools scmdb references that we link to no mission: " + orphans.length);
  for (const g of orphans.slice(0, 12)) console.log("   " + them.blueprintPools[g].name);
  if (orphans.length > 12) console.log("   … and " + (orphans.length - 12) + " more");

  // ---- 2. payouts we cannot extract --------------------------------------------------
  h1("2. PAYOUTS  (they carry CalculatedReward values our extraction cannot see)");
  const gaps = [];
  for (const [k, m] of Object.entries(ours.missions)) {
    const c = byKey.get(normKey(k));
    if (c?.rewardUEC != null && m.payout == null) gaps.push({ key: k, uec: c.rewardUEC, pooled: !!Object.keys(m.pools ?? {}).length });
  }
  console.log("missions where we show no payout and scmdb has one: " + gaps.length);
  console.log("   … of those, ones that carry a blueprint pool   : " + gaps.filter((g) => g.pooled).length);
  for (const g of gaps.filter((x) => x.pooled).slice(0, 8)) {
    console.log("   " + g.key.slice(0, 56).padEnd(58) + nf(g.uec) + " aUEC");
  }

  // ---- 3. pyro region: the split-pool discriminator, as data -------------------------
  h1("3. PYRO REGION  (explicit A/B/C/D labels — the split-pool discriminator)");
  const labelled = them.contracts.filter((c) => c.pyroRegion?.length);
  console.log("scmdb contracts carrying a region label: " + labelled.length);
  const ourAmbiguous = new Map();
  for (const [k, m] of Object.entries(ours.missions)) {
    if (!Object.keys(m.pools ?? {}).length) continue;
    const t = (m.title ?? "").trim();
    if (!t) continue;
    if (!ourAmbiguous.has(t)) ourAmbiguous.set(t, new Set());
    ourAmbiguous.get(t).add(Object.keys(m.pools).sort().join(","));
  }
  const split = [...ourAmbiguous.entries()].filter(([, sigs]) => sigs.size > 1);
  console.log("our titles with >1 distinct pool signature (split-pool traps): " + split.length);
  let rescuable = 0;
  for (const [title] of split) {
    const theirs = them.contracts.filter((c) => (c.title ?? "").trim() === title);
    if (theirs.length > 1 && theirs.every((c) => c.pyroRegion?.length)) rescuable++;
  }
  console.log("… of which scmdb labels every variant with a region: " + rescuable);

  // ---- 4. observed payouts (opt-in) --------------------------------------------------
  if (WANT_PAYOUTS) {
    h1("4. OBSERVED vs DATACORE  (subliminal.gg real completions vs scmdb)");
    const keys = Object.keys(ours.missions).filter((k) => byKey.get(normKey(k))?.rewardUEC != null);
    const observed = {};
    for (let i = 0; i < keys.length; i += 60) {
      const res = await fetch("https://subliminal.gg/api/sc/mission-payout?keys=" + encodeURIComponent(keys.slice(i, i + 60).join(",")));
      if (!res.ok) { console.error("site payout API -> HTTP " + res.status + ", skipping section"); break; }
      Object.assign(observed, (await res.json()).payouts ?? {});
    }
    const rounding = [], genuine = [];
    for (const [k, v] of Object.entries(observed)) {
      if (!v?.samples) continue;
      const exact = byKey.get(normKey(k))?.rewardUEC;
      if (exact == null) continue;
      const forms = boardForms(exact);
      const seen = [v.median, v.min, v.max].filter((x) => x != null);
      (seen.some((x) => forms.includes(x)) ? rounding : genuine).push({ k, exact, seen, n: v.samples });
    }
    console.log("contracts with BOTH a datacore value and real completions: " + (rounding.length + genuine.length));
    console.log("   agree once the board's own k/M rounding is applied    : " + rounding.length);
    console.log("   genuinely disagree                                    : " + genuine.length);
    for (const g of genuine.sort((a, b) => b.n - a.n).slice(0, 12)) {
      console.log("   n=" + String(g.n).padStart(2) + "  " + g.k.slice(0, 50).padEnd(52) + "scmdb=" + nf(g.exact).padStart(9) + "  observed=" + g.seen.map(nf).join("/"));
    }
  } else {
    console.log("\n(run with --payouts to also check scmdb's numbers against real completions)");
  }
};

main().catch((err) => { console.error("\n" + err.message); process.exit(1); });
