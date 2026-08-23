/**
 * DOES A SHOP TERMINAL TELL US WHERE THE PLAYER IS? — the measurement that answered "no".
 *
 *   node tools/measure-terminal-origin.mjs [pathToTheGAMEFolder]
 *
 * Sub asked, 2026-08-23: "now that I've been going to these terminals to buy things, I want you to
 * see if we can determine where a person is when they interact with these terminals." The proposal
 * was a new `place` tier for `src/player-origin.ts`, learned from `shopName` co-occurring with a
 * location line and persisted across sessions, because `shopName` is stable where `shopId` is not.
 *
 * 🔴 THE ANSWER IS THAT THE FIX IS REAL AND THE TIER IS WORTHLESS, AND THOSE ARE NOT THE SAME
 * SENTENCE. A terminal does place you — to the station, reliably. It buys nothing because
 * **you cannot reach a terminal without the app having already placed you**: the terminal is
 * inside a station, and getting inside one fires an inventory, an ASOP or a freight lift first.
 * Measured over Sub's whole log history, a shop line was NEVER the first thing to place him in a
 * session. Not rarely — never, 0 of 727.
 *
 * This file exists so nobody re-derives that. Re-run it after a patch, or against a different
 * player's logs, and it will say whether the conclusion still holds. What would OVERTURN it is a
 * non-zero "cold open" count: a terminal touched before any location line in that session.
 *
 * ⚠️ IT READS THE GAME'S LOGS AND WRITES NOTHING. Read-only by construction — it opens
 * `game.log` and every file in `logbackups/` and prints. No state, no network, no game files
 * touched. It is a measurement, not part of the app.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const GAME = process.argv[2]
  ?? "C:/Program Files/Roberts Space Industries/StarCitizen/GAME";

/* -- What we read out of a line ---------------------------------------------------------------
 *
 * 🔴 THERE ARE TWO SHOP COMPONENTS, AND THE APP ONLY KNEW ABOUT ONE. `src/trade-log.ts` parses
 * `CEntityComponentCommodityUIProvider` — bulk commodity terminals. `CEntityComponentShopUIProvider`
 * is a separate component for ITEM shops (gear, weapons, components, drinks) and it carries the
 * SAME `shopName`/`shopId` fields. In this corpus it is the BIGGER half: 478 lines against 249.
 * Matching only the commodity one finds 7 shop names; matching both finds 36 — which is why an
 * earlier survey that grepped one component reported a shop-name inventory five times too small.
 */
const TS = /^<([^>]+)>/;
const COMPONENT = /<CEntityComponent(Commodity|Shop)UIProvider::([A-Za-z0-9_]+)>/;
const SHOP_NAME = /shopName\[([^\]]*)\]/;
const SHOP_ID = /shopId\[([^\]]*)\]/;
/* The named form. `RequestLocationInventory` is the only line that states a place in words. */
const NAMED_LOC = /requested inventory for Location\[([^\]]+)\]/;
/* The numeric forms — the ASOP writes one, inventory moves and the freight kiosk write the other.
 * A number names nothing by itself; it is only a place once `config.haulingPlaceIds` has bound it
 * to a token, which is why the report below grades BOTH baselines. */
const NUM_LOC_A = / at location \[([0-9]+)\]/;
const NUM_LOC_B = /Location:([0-9]+)/;

const ms = (s) => { const d = Date.parse(s); return Number.isFinite(d) ? d : null; };

function logFiles(root) {
  const out = [];
  for (const n of ["game.log", "Game.log"]) if (existsSync(join(root, n))) { out.push(join(root, n)); break; }
  const backups = join(root, "logbackups");
  if (existsSync(backups)) for (const f of readdirSync(backups)) out.push(join(backups, f));
  return out;
}

/** One session's ordered event stream, plus the wall-clock span the log covers. */
function readSession(file) {
  let txt;
  try { txt = readFileSync(file, "latin1"); } catch { return null; }
  const evs = [];
  let first = null, last = null;
  for (const line of txt.split("\n")) {
    const stamp = TS.exec(line);
    const t = stamp ? ms(stamp[1]) : null;
    if (t !== null) { if (first === null) first = t; last = t; }
    if (line.indexOf("UIProvider::") >= 0) {
      const c = COMPONENT.exec(line);
      if (c) {
        const n = SHOP_NAME.exec(line);
        if (n) evs.push({ kind: "shop", t, name: n[1], id: SHOP_ID.exec(line)?.[1] ?? null, comp: c[1] });
        continue;
      }
    }
    if (line.indexOf("requested inventory for Location[") >= 0) {
      const p = NAMED_LOC.exec(line);
      if (p) evs.push({ kind: "named", t, token: p[1] });
      continue;
    }
    if (line.indexOf(" at location [") >= 0 || line.indexOf("Location:") >= 0) {
      const p = NUM_LOC_A.exec(line) ?? NUM_LOC_B.exec(line);
      if (p) evs.push({ kind: "num", t, id: p[1] });
    }
  }
  evs.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return { file: file.split(/[\\/]/).pop(), first, last, evs };
}

/* How far apart a shop line and a location line may be and still be read as the same visit.
 * MEASURED, not chosen: the preceding-gap distribution has NOTHING inside 10 s and only 10 of 727
 * inside 30 s, so anything tighter learns nothing at all. 300 s is where most lines pair — and it
 * is also where the pairing starts inventing ambiguity, which is the finding, not a setting. */
const PAIR_MS = 300_000;
/* `TRUST_MIN.place` and its halfway "stale" mark, from src/player-origin.ts. */
const DEAD_MS = 45 * 60_000;
const STALE_MS = 22.5 * 60_000;

const sessions = logFiles(GAME).map(readSession)
  .filter((s) => s && s.first !== null && s.last > s.first);
const withShops = sessions.filter((s) => s.evs.some((e) => e.kind === "shop"));

const shopLines = withShops.flatMap((s) => s.evs.filter((e) => e.kind === "shop"));
console.log(`logs read: ${sessions.length}   sessions containing a shop terminal: ${withShops.length}`);
const byComp = new Map();
for (const e of shopLines) byComp.set(e.comp, (byComp.get(e.comp) ?? 0) + 1);
console.log(`shop-terminal lines: ${shopLines.length}  (${[...byComp].map(([k, v]) => `${k} ${v}`).join(", ")})`);
console.log(`distinct shopNames: ${new Set(shopLines.map((e) => e.name)).size}`);

/* -- 1. IS `shopId` A SITE, AND IS `shopName`? -------------------------------------------------
 *
 * 🔑 The answers differ, and that is the whole argument against the persisted map. Within ONE
 * session a shopId is one physical kiosk and never straddles two places. A shopNAME does — the
 * same asset is dropped at many stations, so learning `name -> place` is learning a claim the
 * game never made.
 */
{
  let idOne = 0, idMany = 0, nmOne = 0, nmMany = 0;
  const nameOffenders = [];
  for (const s of withShops) {
    const named = s.evs.filter((e) => e.kind === "named" && e.t !== null);
    const byId = new Map(), byName = new Map();
    for (const e of s.evs) {
      if (e.kind !== "shop" || e.t === null) continue;
      let best = null;
      for (const n of named) {
        const d = Math.abs(n.t - e.t);
        if (d <= PAIR_MS && (!best || d < best.d)) best = { d, tok: n.token };
      }
      if (!best) continue;
      if (e.id) { if (!byId.has(e.id)) byId.set(e.id, new Set()); byId.get(e.id).add(best.tok); }
      if (!byName.has(e.name)) byName.set(e.name, new Set());
      byName.get(e.name).add(best.tok);
    }
    for (const [, toks] of byId) (toks.size === 1 ? idOne++ : idMany++);
    for (const [nm, toks] of byName) {
      if (toks.size === 1) nmOne++;
      else { nmMany++; nameOffenders.push(`${nm}  ->  ${[...toks].join(" / ")}   [${s.file}]`); }
    }
  }
  console.log(`\n1. WITHIN ONE SESSION, does the identifier name ONE place?`);
  console.log(`   shopId  : ${idOne} do, ${idMany} do not`);
  console.log(`   shopName: ${nmOne} do, ${nmMany} do not`);
  for (const o of nameOffenders) console.log(`      ! ${o}`);
}

/* -- 2. HOW OFTEN IS A SHOP LINE THE FIRST THING TO PLACE YOU? ---------------------------------
 *
 * 🔴 THIS IS THE NUMBER THAT DECIDES THE FEATURE. A persisted `shopName -> place` map only ever
 * pays at a "cold open" — a terminal touched before anything else in that session has said where
 * you are. Anywhere else, the map is repeating a fix the app already holds.
 */
{
  for (const [label, counts] of [["named lines only", ["named"]], ["named or numeric", ["named", "num"]]]) {
    let cold = 0;
    for (const s of withShops) {
      let placed = false;
      for (const e of s.evs) {
        if (e.t === null) continue;
        if (counts.includes(e.kind)) { placed = true; continue; }
        if (e.kind === "shop" && !placed) cold++;
      }
    }
    console.log(`\n2. COLD OPENS (${label}): ${cold} of ${shopLines.length} shop lines`);
  }
}

/* -- 3. WHAT WOULD THE TIER ACTUALLY BUY? ------------------------------------------------------
 *
 * Freshness COVERAGE over session wall-clock, with and without shop lines counted as place
 * signals. The widget is read at arbitrary moments, so coverage is the honest measure — "the fix
 * was fresh when he shopped" is true and beside the point.
 *
 * 🔑 Two baselines on purpose. The numeric location line is worthless until `haulingPlaceIds`
 * binds it, and on Sub's real machine that map held exactly ONE entry — so the pessimistic
 * named-only baseline is nearer the shipped truth than the generous one. The conclusion has to
 * survive both or it is a conclusion about the baseline.
 */
function coveredMs(times, first, last, win) {
  const iv = times.filter((t) => t !== null).sort((a, b) => a - b)
    .map((t) => [Math.max(t, first), Math.min(t + win, last)])
    .filter(([a, b]) => b > a);
  let total = 0, a0 = null, b0 = null;
  for (const [a, b] of iv) {
    if (a0 === null) { a0 = a; b0 = b; continue; }
    if (a <= b0) b0 = Math.max(b0, b);
    else { total += b0 - a0; a0 = a; b0 = b; }
  }
  if (a0 !== null) total += b0 - a0;
  return total;
}
{
  console.log(`\n3. COVERAGE — share of session wall-clock with a usable place fix`);
  let span = 0;
  for (const s of withShops) span += s.last - s.first;
  for (const [label, kinds] of [["named only", ["named"]], ["named + numeric", ["named", "num"]]]) {
    let baseFresh = 0, withFresh = 0, baseAlive = 0, withAlive = 0;
    for (const s of withShops) {
      const base = s.evs.filter((e) => kinds.includes(e.kind)).map((e) => e.t);
      /* The generous reading of the proposal: a shopId bound to a place earlier in this session
       * counts as a fresh place fix on every later visit. That is the STRONGEST form of the idea
       * — no persistence needed and no ambiguity possible — so if this buys nothing, neither does
       * the weaker cross-session name map. */
      const bound = new Set();
      let lastNamed = null;
      const extra = [];
      for (const e of s.evs) {
        if (e.t === null) continue;
        if (e.kind === "named") { lastNamed = e; continue; }
        if (e.kind !== "shop" || !e.id) continue;
        if (bound.has(e.id)) extra.push(e.t);
        else if (lastNamed && Math.abs(e.t - lastNamed.t) <= PAIR_MS) bound.add(e.id);
      }
      baseFresh += coveredMs(base, s.first, s.last, STALE_MS);
      withFresh += coveredMs(base.concat(extra), s.first, s.last, STALE_MS);
      baseAlive += coveredMs(base, s.first, s.last, DEAD_MS);
      withAlive += coveredMs(base.concat(extra), s.first, s.last, DEAD_MS);
    }
    const pc = (v) => (v / span * 100).toFixed(1) + "%";
    const mins = (v) => (v / 60000).toFixed(0) + " min";
    console.log(`   baseline "${label}" over ${(span / 3600000).toFixed(1)} h of sessions`);
    console.log(`     fresh (<22.5 min): ${pc(baseFresh)} -> ${pc(withFresh)}   gain ${mins(withFresh - baseFresh)}`);
    console.log(`     alive (<45 min)  : ${pc(baseAlive)} -> ${pc(withAlive)}   gain ${mins(withAlive - baseAlive)}`);
  }
}

/* -- 4. THE MAP THE PROPOSAL WOULD HAVE BUILT, AND WHAT IS WRONG WITH IT ------------------------ */
{
  console.log(`\n4. THE LEARNED shopName -> place MAP, by pairing window`);
  const pairs = [];
  for (const s of withShops) {
    let lastNamed = null;
    for (const e of s.evs) {
      if (e.t === null) continue;
      if (e.kind === "named") { lastNamed = e; continue; }
      if (e.kind === "shop" && lastNamed) pairs.push({ name: e.name, token: lastNamed.token, gap: e.t - lastNamed.t });
    }
  }
  for (const secs of [30, 60, 120, 300, 600]) {
    const map = new Map();
    for (const p of pairs) {
      if (p.gap > secs * 1000) continue;
      if (!map.has(p.name)) map.set(p.name, new Set());
      map.get(p.name).add(p.token);
    }
    const amb = [...map].filter(([, t]) => t.size > 1);
    console.log(`   <=${String(secs).padStart(3)}s: ${map.size} names learned, ${amb.length} already ambiguous`);
    if (secs === 300) for (const [n, t] of amb) console.log(`        ! ${n}  ->  ${[...t].join(" / ")}`);
  }
  console.log(`   (a tight window learns almost nothing; a loose one learns wrong things —`);
  console.log(`    there is no window where this map is both useful and safe)`);
}
