/**
 * keepayear — WHAT A ONE-YEAR RETENTION WINDOW COSTS, AND WHICH CLOCK TO MEASURE IT WITH.
 *
 * `src/log-share.ts` caps a contributor's history at the CURRENT SC PATCH. That is the only
 * client-side history limit in this repo (the `live=5 / backup=25` quota is the site's, not
 * ours), and it is why a player with two years of `logbackups/` offers about six weeks of them.
 *
 * Sub's ruling is one year. Three separate things have to be measured before that can be built:
 *
 *  1. WHICH CLOCK. A backup states its age three ways and they are not the same fact:
 *       - the log's own first line, `<2026-08-23T22:10:48.704Z>` — the game's UTC session START;
 *       - the FILENAME, `Game Build(12344265) 23 Aug 26 (17 10 39).log` — LOCAL time, no offset;
 *       - the file's MTIME — the session END, and filesystem metadata besides.
 *     Agreement between them is measured here rather than assumed.
 *
 *  2. WHAT IT COSTS. How many more sessions a year admits, how many of those carry signal and
 *     therefore actually upload, and how many bytes that is AFTER scrub + tail — which is the
 *     only number the site ever sees.
 *
 *  3. WHERE THE OLD VERDICTS SIT. A rules-version reset re-opens `backups` and `skippedPatch`.
 *     For a SIGNAL widening (flight sharefilter) the recoverable sessions were in `backups`.
 *     A WINDOW widening is a different rule, so the answer may be different — and guessing it is
 *     how this change silently does nothing for every existing user.
 *
 * Needs Star Citizen installed. Reads only; writes nothing, uploads nothing.
 *
 * Usage:  npx tsx tools/probe-keepayear.ts [logbackups dir] [shared-logs.json]
 *         npm run probe:keepayear
 */
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

// 🔑 IMPORTED, NEVER COPIED. A rule re-declared in a probe is a second copy that can drift from
// the one running — the same reason the log parsers export their markers, and the reason
// probe-sharefilter's own hand-written BUYS list published a wrong baseline for a day.
import { hasShareSignal } from "../src/log-share.js";
import { scrubGameLog } from "../src/log-scrub.js";

const MAX_BYTES = 4 * 1024 * 1024;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const RE_PRODUCT_VERSION = /ProductVersion:\s*([0-9]+\.[0-9]+)/;
/** The log's first line. Anchored at the start of the file on purpose: a `<...Z>` stamp appears on
 *  every line, so an unanchored match would find one wherever the read happened to land. */
const RE_HEAD_STAMP = /^<(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)>/;
/** `Game Build(12344265) 23 Aug 26 (17 10 39).log` -> day, month name, 2-digit year. */
const RE_NAME_DATE = /\b(\d{1,2}) ([A-Za-z]{3}) (\d{2}) \((\d{2}) (\d{2}) (\d{2})\)/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function headOf(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, 4096, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The game's own UTC session start, off line 1. null when the file does not begin with one. */
function headStamp(head: string): number | null {
  const m = head.match(RE_HEAD_STAMP);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

/** The filename's stated session start. LOCAL time — there is no offset in the string, so this is
 *  interpreted in the machine's own zone, which is the best anyone can do with it. */
function nameStamp(name: string): number | null {
  const m = name.match(RE_NAME_DATE);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  if (mon < 0) return null;
  const t = new Date(2000 + Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(t) ? t : null;
}

function mb(bytes: number): string { return (bytes / 1024 / 1024).toFixed(1) + " MB"; }
function pct(a: number, b: number): string { return b ? ((a / b) * 100).toFixed(1) + "%" : "—"; }
function day(t: number | null): string { return t == null ? "—" : new Date(t).toISOString().slice(0, 10); }

interface Row {
  n: string; size: number; mtime: number;
  head: number | null; name: number | null;
  patch: string | null;
  signal: boolean; sendBytes: number; rawBytes: number; scrubBytes: number;
}

function main(): void {
  const dir = process.argv[2] ?? "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/logbackups";
  const statePath = process.argv[3] ?? join(process.env.APPDATA ?? "", "sc-blueprint-tracker", "shared-logs.json");

  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".log"));
  } catch {
    console.log(`no logbackups at ${dir} — skipping (this probe needs SC installed)`);
    return;
  }

  const now = Date.now();
  console.log(`probe-keepayear — ${names.length} backups in ${dir}`);
  console.log(`now = ${new Date(now).toISOString()}   one-year cutoff = ${new Date(now - YEAR_MS).toISOString()}\n`);

  const rows: Row[] = [];
  let currentPatch: string | null = null;
  let newestMtime = 0;

  for (const n of names) {
    const p = join(dir, n);
    let size = 0, mtime = 0;
    try { const st = statSync(p); size = st.size; mtime = st.mtimeMs; } catch { continue; }
    let head = "";
    try { head = headOf(p); } catch { /* locked */ }
    const patch = head.match(RE_PRODUCT_VERSION)?.[1] ?? null;
    const row: Row = {
      n, size, mtime,
      head: headStamp(head), name: nameStamp(n),
      patch, signal: false, sendBytes: 0, rawBytes: 0, scrubBytes: 0,
    };
    if (mtime > newestMtime) { newestMtime = mtime; currentPatch = patch; }
    rows.push(row);
  }
  console.log(`current patch (newest backup's header) = ${currentPatch}\n`);

  // ---- 1. WHICH CLOCK -----------------------------------------------------------------
  console.log("=== 1. WHICH CLOCK — is a year measurable, and do the three agree? ===");
  const haveHead = rows.filter((r) => r.head != null).length;
  const haveName = rows.filter((r) => r.name != null).length;
  console.log(`  header line-1 stamp present : ${haveHead}/${rows.length} (${pct(haveHead, rows.length)})`);
  console.log(`  filename date parseable     : ${haveName}/${rows.length} (${pct(haveName, rows.length)})`);
  console.log(`  mtime present               : ${rows.length}/${rows.length} (100.0%)`);

  const both = rows.filter((r) => r.head != null && r.name != null);
  const dHeadName = both.map((r) => (r.name as number) - (r.head as number));
  const dHeadMtime = rows.filter((r) => r.head != null).map((r) => r.mtime - (r.head as number));
  const stat = (xs: number[]) => {
    if (!xs.length) return "—";
    const s = [...xs].sort((a, b) => a - b);
    const h = (v: number) => (v / 3600000).toFixed(2) + "h";
    return `min ${h(s[0])} · median ${h(s[Math.floor(s.length / 2)])} · max ${h(s[s.length - 1])}`;
  };
  console.log(`  filename minus header  : ${stat(dHeadName)}   <- the timezone offset, if the two are one moment`);
  console.log(`  mtime minus header     : ${stat(dHeadMtime)}   <- session LENGTH, if mtime is the session end`);

  // Do the three ever disagree about which SIDE of the cutoff a file is on? That is the only
  // disagreement that changes a decision — a few hours' skew inside the window costs nothing.
  const cut = now - YEAR_MS;
  const side = (t: number | null) => (t == null ? null : t >= cut);
  let flip = 0;
  const flips: string[] = [];
  for (const r of rows) {
    const s = [side(r.head), side(r.name), side(r.mtime)].filter((x) => x !== null);
    if (s.length > 1 && s.some((x) => x !== s[0])) { flip++; if (flips.length < 8) flips.push(r.n); }
  }
  console.log(`  files the three clocks DISAGREE about (in-window vs out) : ${flip}`);
  for (const f of flips) console.log(`      ${f}`);

  // ---- 2. WHAT IT COSTS ---------------------------------------------------------------
  console.log("\n=== 2. WHAT A YEAR COSTS — read every file once (this is the slow part) ===");
  let read = 0;
  for (const r of rows) {
    if (!r.size) continue;
    let raw: string;
    try { raw = readFileSync(join(dir, r.n), "utf8"); } catch { continue; }
    read++;
    r.rawBytes = Buffer.byteLength(raw, "utf8");
    r.signal = hasShareSignal(raw);
    if (r.signal) {
      const scrubbed = scrubGameLog(raw).text;
      r.scrubBytes = Buffer.byteLength(scrubbed, "utf8");
      r.sendBytes = Math.min(r.scrubBytes, MAX_BYTES);
    }
    if (read % 100 === 0) process.stderr.write(`    …${read} read\n`);
  }

  const inYear = (r: Row) => {
    const t = r.head ?? r.name ?? r.mtime;
    return t >= cut;
  };
  const onPatch = (r: Row) => currentPatch == null || r.patch === currentPatch;

  const report = (label: string, sel: (r: Row) => boolean) => {
    const set = rows.filter(sel);
    const up = set.filter((r) => r.signal && r.size);
    const bytes = up.reduce((a, r) => a + r.sendBytes, 0);
    console.log(
      `  ${label.padEnd(22)} files ${String(set.length).padStart(4)}` +
      `  ·  upload ${String(up.length).padStart(4)}` +
      `  ·  ${mb(bytes).padStart(9)} sent` +
      `  ·  ${mb(bytes / 8.4).padStart(9)} on disk @8.4:1`,
    );
    return { set, up, bytes };
  };
  console.log("");
  const nowRule = report("TODAY (current patch)", onPatch);
  const yearRule = report("ONE YEAR", inYear);
  const allRule = report("EVERYTHING (no cap)", () => true);

  console.log(`\n  one year adds ${yearRule.up.length - nowRule.up.length} uploads / ${mb(yearRule.bytes - nowRule.bytes)} over today`);
  console.log(`  an uncapped window would add a further ${allRule.up.length - yearRule.up.length} uploads / ${mb(allRule.bytes - yearRule.bytes)}`);

  const dates = rows.map((r) => r.head ?? r.name ?? r.mtime).sort((a, b) => a - b);
  console.log(`  folder spans ${day(dates[0])} .. ${day(dates[dates.length - 1])}`);

  // ---- 2b. THE 4 MB CEILING -----------------------------------------------------------
  console.log("\n=== 2b. IS MAX_BYTES CUTTING REAL SESSIONS SHORT? ===");
  const upAll = yearRule.up;
  const capped = upAll.filter((r) => r.sendBytes >= MAX_BYTES);
  console.log(`  uploads at the 4 MB ceiling : ${capped.length}/${upAll.length} (${pct(capped.length, upAll.length)})`);
  if (capped.length) {
    // SCRUBBED bytes, which is what tail() actually cuts — the raw figure overstates the loss,
    // because the scrub removes lines before tail() ever sees them.
    const lost = capped.reduce((a, r) => a + (r.scrubBytes - MAX_BYTES), 0);
    const worst = capped.reduce((a, r) => (r.scrubBytes > a.scrubBytes ? r : a), capped[0]);
    console.log(`  scrubbed bytes DISCARDED by tail() : ${mb(lost)} across those ${capped.length} sessions`);
    console.log(`  worst single session : ${worst.n}`);
    console.log(`      ${mb(worst.rawBytes)} raw -> ${mb(worst.scrubBytes)} scrubbed -> ${mb(MAX_BYTES)} sent (${pct(MAX_BYTES, worst.scrubBytes)} kept)`);
    const uncapped = upAll.reduce((a, r) => a + r.scrubBytes, 0);
    const cappedTotal = upAll.reduce((a, r) => a + r.sendBytes, 0);
    console.log(`\n  a year, UNCAPPED : ${mb(uncapped)} sent · ${mb(uncapped / 8.4)} on disk @8.4:1`);
    console.log(`  a year, capped   : ${mb(cappedTotal)} sent · ${mb(cappedTotal / 8.4)} on disk`);
    console.log(`  => the ceiling is currently throwing away ${pct(uncapped - cappedTotal, uncapped)} of the corpus by volume`);

    // What ceiling buys what? A ceiling only matters for the sessions above it, so the useful
    // question is how much of the whole corpus each candidate keeps.
    console.log(`\n  ceiling sweep over the ${upAll.length} in-window uploads:`);
    for (const capMb of [4, 8, 16, 32, 64, 128]) {
      const cap = capMb * 1024 * 1024;
      const kept = upAll.reduce((a, r) => a + Math.min(r.scrubBytes, cap), 0);
      const hit = upAll.filter((r) => r.scrubBytes > cap).length;
      console.log(
        `      ${String(capMb).padStart(4)} MB  keeps ${pct(kept, uncapped).padStart(6)} of the corpus` +
        `  ·  ${String(hit).padStart(3)} sessions still truncated` +
        `  ·  ${mb(kept).padStart(9)} sent · ${mb(kept / 8.4).padStart(8)} on disk`,
      );
    }
    const biggest = upAll.reduce((a, r) => (r.scrubBytes > a.scrubBytes ? r : a), upAll[0]);
    console.log(`      a ceiling of ${mb(biggest.scrubBytes)} would truncate nothing at all in this folder`);
  }

  // ---- 3. WHERE THE OLD VERDICTS SIT --------------------------------------------------
  console.log("\n=== 3. WHERE THE OLD VERDICTS SIT — which set does the reset have to re-open? ===");
  let state: { backups?: string[]; skippedPatch?: string[]; rules?: number } | null = null;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* absent */ }
  if (!state) {
    console.log(`  no state file at ${statePath} — cannot answer (this half needs a machine that has run the app)`);
  } else {
    const backups = new Set(state.backups ?? []);
    const skipped = new Set(state.skippedPatch ?? []);
    console.log(`  ${statePath}`);
    console.log(`  rules=${state.rules ?? "(absent => 1)"}  backups=${backups.size}  skippedPatch=${skipped.size}`);
    // 🔑 POSITIVE CONTROL. Without it, every "recovered = 0" below is equally consistent with
    // reading a state file that describes some other folder, which would look identical.
    const known = rows.filter((r) => backups.has(r.n) || skipped.has(r.n)).length;
    console.log(`  positive control — folder names present in the state file : ${known}/${rows.length} (${pct(known, rows.length)})`);

    // A one-year window admits these and today's patch rule does not. But "admitted" is not
    // "recovered": a name already in `backups` WITH signal was UPLOADED, not rejected, so it must
    // stay recorded or the reset sends it twice. That is exactly what the drain's discriminator
    // decides, and getting it backwards is the expensive direction.
    const admitted = rows.filter((r) => r.size && r.signal && inYear(r) && !onPatch(r));
    const fromSkipped = admitted.filter((r) => skipped.has(r.n));
    const alreadySent = admitted.filter((r) => backups.has(r.n));
    const fromNeither = admitted.filter((r) => !skipped.has(r.n) && !backups.has(r.n));
    console.log(`\n  sessions a one-year window ADMITS that today's rule refuses : ${admitted.length}`);
    console.log(`      in skippedPatch — genuinely recovered   : ${fromSkipped.length}`);
    console.log(`      in backups WITH signal — already sent   : ${alreadySent.length}  <- must NOT be released`);
    console.log(`      never judged at all                     : ${fromNeither.length}`);
    console.log(`      => real recovery : ${fromSkipped.length + fromNeither.length} sessions, ${mb([...fromSkipped, ...fromNeither].reduce((a, r) => a + r.sendBytes, 0))}`);

    // What the reset itself costs before a single byte is uploaded.
    const rejudge = [...skipped].length;
    console.log(`\n  reset cost: drain ${backups.size} recorded names + re-judge ${rejudge} cleared names`);
    const outOfWindow = rows.filter((r) => skipped.has(r.n) && !inYear(r)).length;
    console.log(`      of the cleared, out-of-window (header read only, no body) : ${outOfWindow}`);
  }

  console.log("\n=== done ===");
}

main();
