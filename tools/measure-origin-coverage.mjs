/**
 * WHEN IS THE APP BLIND ABOUT WHERE THE PLAYER IS, AND WHAT DOES EACH SOURCE BUY?
 *
 *   node tools/measure-origin-coverage.mjs [pathToTheGAMEFolder]
 *   npm run measure:origin
 *
 * Sub's complaint was that the Verse Finder said "Location unknown". This is the measurement that
 * found out why, and it re-derives every figure quoted in `src/player-location.ts`. A census
 * written into a comment is a claim that rots; a census you can re-run is a fact.
 *
 * 🔴 WHAT IT ASSERTS, as an exit code — the two conclusions the design rests on:
 *   1. Seeding the two location watchers from the startup replay is the DOMINANT fix. If it ever
 *      stops being worth more than every other source put together, the priorities have changed.
 *   2. The in-session bindings are UNAMBIGUOUS. A numeric location id, or a shop terminal id, that
 *      is ever seen naming two different places in one session is the observation that would make
 *      the whole binding design unsafe — the same way the `shopName -> place` map went wrong.
 *
 * ⚠️ IT READS THE GAME'S LOGS AND WRITES NOTHING. Read-only by construction. It is a measurement,
 * not part of the app.
 *
 * ⚠️ It is deliberately NOT in any `test:` script: it needs Star Citizen installed and a real
 * history of play. Same shape as `measure:terminalorigin` and `measure:tradeconfirm`.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const GAME = process.argv[2] ?? "C:/Program Files/Roberts Space Industries/StarCitizen/GAME";

/* The lines each tier is read from. Kept as plain `indexOf` prefilters in front of the regexes for
 * the same reason `trade-log.ts` exports its marker: a prefilter is a second, invisible copy of the
 * parser's vocabulary, so it must be visibly the same vocabulary. */
const TS = /^<([^>]+)>/;
const NAMED = /requested inventory for Location\[([^\]]+)\]/;
const NUM_A = / at location \[([0-9]+)\]/;
const NUM_B = /Location:([0-9]+)/;
const CELLS = /planet cells:\s*(\d+)\s*\[\s*\d+\]\s*meshes:\s*\d+\s*\[\s*\d+\]\s*name:\s*(\S+)/;
const SHOP_ID = /shopId\[([^\]]*)\]/;
/* Both shop components. The item one is the bigger half and nothing in the app read it before. */
const SHOP_COMP = /<CEntityComponent(?:Commodity|Shop)UIProvider::/;
const QT_TAG = "[QuantumTravel]";

/* From src/player-origin.ts. A trust window's HALF is where a reading stops being current and
 * starts being recent, which is the honest line for "does the widget have something to say". */
const PLACE_FRESH = 22.5 * 60_000;
const PLACE_ALIVE = 45 * 60_000;
const BODY_WIN = 25 * 60_000;
/* From src/player-location.ts — the same window the app binds with, not a second opinion. */
const BIND_MS = 5 * 60_000;

const ms = (s) => { const d = Date.parse(s); return Number.isFinite(d) ? d : null; };

function logFiles(root) {
  const out = [];
  for (const n of ["game.log", "Game.log"]) if (existsSync(join(root, n))) { out.push(join(root, n)); break; }
  const b = join(root, "logbackups");
  if (existsSync(b)) for (const f of readdirSync(b)) out.push(join(b, f));
  return out;
}

/** One session. 🔑 One file IS one session: the game writes a fresh Game.log per launch. */
function readSession(file) {
  let txt;
  try { txt = readFileSync(file, "latin1"); } catch { return null; }
  const evs = [];
  let first = null, last = null, inBlock = false, streaming = 0;
  for (const line of txt.split("\n")) {
    const stamp = TS.exec(line);
    const t = stamp ? ms(stamp[1]) : null;
    if (t !== null) { if (first === null) first = t; last = t; }

    // The terrain report. A block is delimited by the run of `planet cells:` lines ENDING — the
    // one moment the report is known to be complete. Grouping by timestamp splits one block in two.
    const c = CELLS.exec(line);
    if (c) { inBlock = true; if (Number(c[1]) > 0) streaming++; continue; }
    if (inBlock) { inBlock = false; if (streaming > 0 && t !== null) evs.push({ k: "body", t }); streaming = 0; }

    if (t === null) continue;
    if (line.indexOf("requested inventory for Location[") >= 0) {
      const m = NAMED.exec(line);
      if (m) evs.push({ k: "named", t, tok: m[1] });
      continue;
    }
    if (line.indexOf(QT_TAG) >= 0) { evs.push({ k: "qt", t }); continue; }
    if (line.indexOf("shopId[") >= 0 && SHOP_COMP.test(line)) {
      const id = SHOP_ID.exec(line)?.[1];
      if (id) evs.push({ k: "shop", t, id });
      continue;
    }
    if (line.indexOf(" at location [") >= 0 || line.indexOf("Location:") >= 0) {
      const m = NUM_A.exec(line) ?? NUM_B.exec(line);
      if (m) evs.push({ k: "num", t, id: m[1] });
    }
  }
  if (first === null || last <= first) return null;
  evs.sort((a, b) => a.t - b.t);
  return { file: file.split(/[\\/]/).pop(), first, last, evs };
}

const sessions = logFiles(GAME).map(readSession).filter(Boolean);
if (!sessions.length) {
  // ⚠️ Silence must not read as confirmation — an empty log folder measures nothing.
  console.log("INCONCLUSIVE — no readable logs. Nothing was measured.");
  process.exit(2);
}
const span = sessions.reduce((a, s) => a + (s.last - s.first), 0);
console.log(`${sessions.length} sessions, ${(span / 3600000).toFixed(1)} h of wall-clock\n`);

/** Total wall-clock covered by a set of [start,end) intervals, clamped to the session. */
function covered(iv, first, last) {
  const s = iv.map(([a, b]) => [Math.max(a, first), Math.min(b, last)])
    .filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let tot = 0, a0 = null, b0 = null;
  for (const [a, b] of s) {
    if (a0 === null) { a0 = a; b0 = b; continue; }
    if (a <= b0) b0 = Math.max(b0, b); else { tot += b0 - a0; a0 = a; b0 = b; }
  }
  if (a0 !== null) tot += b0 - a0;
  return tot;
}

/** The intervals a signal set covers, in the order the app would learn them. */
function intervals(s, { seed = false, numeric = false, terminal = false, win = PLACE_FRESH } = {}) {
  const out = s.evs.filter((e) => e.k === "named").map((e) => [e.t, e.t + win]);
  if (seed) {
    for (const e of s.evs) if (e.k === "body") out.push([e.t, e.t + BODY_WIN]);
    // A system reading does not expire: you cannot leave one without a jump, and a jump writes
    // more of these. So the first quantum line covers the rest of the session.
    const q = s.evs.find((e) => e.k === "qt");
    if (q) out.push([q.t, s.last]);
  }
  const bound = new Set();
  let lastNamed = null;
  for (const e of s.evs) {
    if (e.k === "named") { lastNamed = e; continue; }
    const on = e.k === "num" ? numeric : e.k === "shop" ? terminal : false;
    if (!on || !e.id) continue;
    if (bound.has(e.id)) out.push([e.t, e.t + win]);
    else if (lastNamed && Math.abs(e.t - lastNamed.t) <= BIND_MS) bound.add(e.id);
  }
  return out;
}

/* ── 1. THE DARK SESSIONS ─────────────────────────────────────────────────────────────────────
 *
 * 🔴 THIS IS SUB'S ACTUAL COMPLAINT, so it goes first. The ladder falls back to the freshest
 * EXPIRED reading rather than to nothing, so a session with one named location line anywhere in it
 * can never say "Location unknown". Darkness is therefore a property of the whole session, not of
 * a moment — and the question is how many sessions have no signal in them at all.
 */
const noNamed = sessions.filter((s) => !s.evs.some((e) => e.k === "named"));
const rescuable = noNamed.filter((s) => s.evs.some((e) => e.k === "body" || e.k === "qt"));
const stillDark = noNamed.length - rescuable.length;
{
  const darkH = (a) => (a.reduce((x, s) => x + (s.last - s.first), 0) / 3600000).toFixed(1);
  console.log(`1. SESSIONS THAT CAN ONLY SAY "Location unknown"`);
  console.log(`   no named location line anywhere : ${noNamed.length}/${sessions.length}  (${darkH(noNamed)} h)`);
  console.log(`   ...but DO hold a terrain report or a quantum route,`);
  console.log(`      i.e. dark only because the startup seed`);
  console.log(`      never fed the two watchers            : ${rescuable.length}  (${darkH(rescuable)} h)`);
  console.log(`   genuinely nothing to say                : ${stillDark}`);
}

/* ── 2. FRESHNESS COVERAGE, one source at a time ───────────────────────────────────────────── */
const STEPS = [
  ["A  named place lines only (what shipped)", {}],
  ["B  + the seed feeding body & system", { seed: true }],
  ["C  + the numeric location id, bound", { seed: true, numeric: true }],
  ["D  + a shop terminal, bound", { seed: true, numeric: true, terminal: true }],
];
const pcs = [];
{
  console.log(`\n2. FRESHNESS COVERAGE — share of wall-clock with a reading inside its own window`);
  let prev = null;
  for (const [label, opt] of STEPS) {
    const tot = sessions.reduce((a, s) => a + covered(intervals(s, opt), s.first, s.last), 0);
    const pc = tot / span * 100;
    pcs.push(pc);
    console.log(`   ${label.padEnd(42)} ${pc.toFixed(1)}%`
      + (prev === null ? "" : `   +${(pc - prev).toFixed(1)} pp`));
    prev = pc;
  }
}

/* ── 3. PLACE-TIER PRECISION ───────────────────────────────────────────────────────────────────
 *
 * 🔑 A SEPARATE QUESTION FROM SECTION 2, and the numeric id looks worthless in that one. Coverage
 * treats every tier alike; a per-station distance can only come from a PLACE. So the id's real
 * value is here, where "near Lyria" does not count.
 */
{
  console.log(`\n3. PLACE-TIER coverage — the only tier a per-station distance can come from`);
  for (const [win, name] of [[PLACE_FRESH, "fresh"], [PLACE_ALIVE, "alive"]]) {
    const base = sessions.reduce((a, s) => a + covered(intervals(s, { win }), s.first, s.last), 0);
    const num = sessions.reduce((a, s) => a + covered(intervals(s, { numeric: true, win }), s.first, s.last), 0);
    const all = sessions.reduce((a, s) => a + covered(intervals(s, { numeric: true, terminal: true, win }), s.first, s.last), 0);
    const pc = (v) => (v / span * 100).toFixed(1) + "%";
    const h = (v) => (v / 3600000).toFixed(1) + " h";
    console.log(`   ${name.padEnd(6)} named ${pc(base)}  -> +numeric id ${pc(num)} (+${h(num - base)})`
      + `  -> +terminal ${pc(all)} (+${h(all - num)})`);
  }
}

/* ── 4. ARE THE IN-SESSION BINDINGS UNAMBIGUOUS? ───────────────────────────────────────────────
 *
 * 🔴 THE SAFETY ASSERTION. The rejected `shopName -> place` map failed here — 5 of 27 pairings were
 * already wrong at a 300 s window. Both identifiers bound here must not repeat that, and the run
 * goes red if either ever does.
 */
let ambiguous = 0;
{
  console.log(`\n4. DO THE BOUND IDENTIFIERS EACH NAME ONE PLACE?`);
  for (const [label, kind] of [["numeric location id", "num"], ["shop terminal id", "shop"]]) {
    let one = 0, many = 0;
    const bad = [];
    for (const s of sessions) {
      const seen = new Map();
      let lastNamed = null;
      for (const e of s.evs) {
        if (e.k === "named") { lastNamed = e; continue; }
        if (e.k !== kind || !e.id || !lastNamed || Math.abs(e.t - lastNamed.t) > BIND_MS) continue;
        if (!seen.has(e.id)) seen.set(e.id, new Set());
        seen.get(e.id).add(lastNamed.tok);
      }
      for (const [id, toks] of seen) {
        if (toks.size === 1) one++;
        else { many++; bad.push(`${id} -> ${[...toks].join(" / ")}  [${s.file}]`); }
      }
    }
    ambiguous += many;
    console.log(`   ${label.padEnd(20)}: ${one} name one place, ${many} name several`);
    for (const b of bad.slice(0, 10)) console.log(`      ! ${b}`);
    // ⚠️ Zero bindings is not a pass. An identifier nobody ever bound cannot be ambiguous, so a
    // corpus that produced none would satisfy the check above for free.
    if (!one && !many) console.log(`      ⚠️ nothing bound — this says nothing either way`);
  }
}

/* ── THE VERDICT, AS AN EXIT CODE ───────────────────────────────────────────────────────────── */
console.log("");
if (ambiguous > 0) {
  console.log(`OVERTURNED — ${ambiguous} in-session bindings named more than one place.`);
  console.log("That is the failure mode the persisted shopName map was rejected for. Re-open the design.");
  process.exit(1);
}
const seedGain = pcs[1] - pcs[0];
const restGain = pcs[3] - pcs[1];
if (!(seedGain > restGain)) {
  console.log(`OVERTURNED — seeding the watchers now buys ${seedGain.toFixed(1)} pp against ${restGain.toFixed(1)} pp`);
  console.log("from everything else. It was the dominant fix; the priorities have changed.");
  process.exit(1);
}
console.log(`HOLDS — seeding the watchers is worth ${seedGain.toFixed(1)} points of freshness against`);
console.log(`${restGain.toFixed(1)} from every other source combined, and no bound identifier ever`);
console.log(`named two places. ${rescuable.length} sessions were dark for the seed alone.`);
