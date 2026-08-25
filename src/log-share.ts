// Opt-in log sharing. When enabled (config.shareLogs) and a sync token is set, ROTATED Star
// Citizen sessions are scrubbed (src/log-scrub) and uploaded to subliminal.gg so mission,
// blueprint, price and hauling parsing can be improved against real play.
//
// 🔴 THE LIVE Game.log IS NOT UPLOADED (since RULES_VERSION 3). It was, for as long as this file
// existed, and removing it is Sub's call — the reasoning and the measurements are on maybeShareLog.
// The short version: the game writes one GROWING file per launch, so re-posting it on every change
// delivered the same session over and over, and a backup of that same session follows a median
// 0.1h later anyway.
//
// ROTATED SESSIONS (since 0.1.39). The game writes a FRESH Game.log per launch and
// rotates the old one into logbackups/, so sharing only the live file could never show a
// session the player had already finished — a user reported Battaglia standing stuck at
// zero and every log he sent held accepts and no completions, purely because his completed
// sessions had rotated away. Backups are immutable once written, so each is uploaded once,
// ever, remembered by FILENAME in the state file (no need to read a file to know it is done).
//
// 🔑 THE FILTERS ARE WHAT MAKE THIS AFFORDABLE, and they were measured, not guessed. Re-measured
// 2026-08-25 on Sub's machine (flight keepayear): logbackups/ holds 535 files / 1.49 GB.
//
// 🔴 THE HISTORY CAP IS NOW A ONE-YEAR WINDOW, NOT THE CURRENT SC PATCH (RULES_VERSION 3). The
// patch rule offered 96 files / 60 uploads / 171 MB — about 39 days, on a folder going back to
// March 2025. A year offers 469 files / 182 uploads / 504 MB sent, which at the measured 8.4x
// Postgres compression is ~60 MB stored per user. Uncapped would be 535 / 202 / 570 MB, so a year
// is very nearly the whole folder anyway: the last 66 files buy 20 more uploads. See RETENTION_MS
// for why the patch axis was the wrong one to cap on.
//
// ⚠️ THIS IS ONLY THE CLIENT HALF. The site keeps a fixed quota per contributor (live 5 / backup
// 25 when this was written), so widening the window here shows nothing until that quota moves —
// and the quota moving shows nothing while the app can only ever offer 39 days. Both or neither.
//
// ⚠️ AN OFF-PATCH VERDICT IS NOT FINAL. It used to be recorded in the uploaded set, which meant a
// player who updated the app just after an SC patch had their whole backlog blacklisted on the
// first tick, silently and irreversibly — every rejection path `continue`s WITHOUT incrementing
// `sent`, so BACKUPS_PER_TICK never bounded them and one pass could walk the entire folder. Those
// files now go to a SEPARATE `skippedPatch` list that toggling "share logs" back on clears, and
// rejections are bounded per tick in their own right (REJECTS_PER_TICK). Damage already written
// to disk by the old build is repaired once, on first run — see migrateLegacyBlacklist.
import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { scrubGameLog } from "./log-scrub.js";

const SITE = "https://subliminal.gg";
// The site rejects a body over 4MB (and an empty one) with a bare 400. A long session's
// game.log goes well past that, so trim to the most RECENT 4MB rather than posting something
// that can only be refused — the tail is the part that describes what the player just did.
//
// 🔴 THIS CEILING IS THROWING AWAY HALF THE CORPUS BY VOLUME, measured 2026-08-25 over the 182
// in-window uploads on Sub's disk: 71 of them (39.0%) are at the ceiling, 503.8 MB of scrubbed
// text is discarded, and the worst session keeps 6.1% of itself (65.5 MB scrubbed -> 4.0 MB).
// Sweep, as sent / as stored at the measured 8.4x: 4 MB keeps 50.0% (504 MB / 60 MB) · 8 MB 69.1%
// · 16 MB 85.8% · 32 MB 95.8% (966 MB / 115 MB) · 64 MB 99.9%.
//
// 🔴 IT IS THE SITE'S LIMIT, SO THE SITE MOVES FIRST — and the ordering is not a nicety. A body
// the site refuses `break`s the loop WITHOUT recording the filename, so an oversized upload is
// retried on every tick forever and every other backup queues behind it. Raising this constant
// ahead of the site would not merely fail to help, it would wedge the queue of every heavy user.
// Whoever raises it should also make a 400 (as opposed to a transient failure) record the name,
// so a body the site will never accept cannot block the ones it would.
const MAX_BYTES = 4 * 1024 * 1024;
/** Backups uploaded per tick.
 *
 *  🔴 THIS CONSTANT IS THE CATCH-UP DIAL AND NOTHING ELSE — measured, not assumed. Steady state
 *  never reaches it: Sub plays 1.28 sessions/day and ~34% of sessions carry signal, so an
 *  established user generates **0.44 uploads/day** against a floor of 72/day at one per 20-minute
 *  tick. It binds only while a backlog exists, which happens once per user per rules change.
 *  That is why there is ONE number here and not a catch-up rate beside a steady rate: a second
 *  rate would be a mode controlling a state that does not exist, and a mode is somewhere to get
 *  stuck.
 *
 *  It was 1, which made the one thing it governs as slow as possible: the year window gives Sub a
 *  98-session backlog, and at 3/hour that is 33 hours of app uptime — about a week of real days,
 *  which reads as the feature being broken rather than as pacing. At 5 it is ~20 ticks (6.7h of
 *  uptime), caps a single client at 15 uploads/hour, and at his measured 2.77 MB mean body that is
 *  ~42 MB/hour. Reversible by changing this line. */
const BACKUPS_PER_TICK = 5;
/** How far back rotated sessions are worth keeping. Sub, 2026-08-25: *"up that cap to being a year
 *  and keeping it compressed."*
 *
 *  🔴 THIS REPLACED THE CURRENT-PATCH FILTER, and the two are not the same kind of rule. The patch
 *  filter existed so a pre-wipe session did not spend storage on rep/blueprint truth a wipe had
 *  already invalidated — a good reason that only ever applied to rep and blueprints. Everything
 *  else the corpus is now read for (prices, hauling calibration, shop placement, locations) is
 *  untouched by a wipe, so the filter had quietly become a cap on the wrong axis: it held every
 *  contributor to the current patch, a 39-day window, while the folder on disk went back years.
 *  Measured on Sub's own 535 backups: the patch rule offers 96 files / 60 uploads, a year offers
 *  469 / 182. ⚠️ Off-patch sessions therefore now upload, which is the intended change. */
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** How much of a tick's rejection budget the rules-reset drain may take.
 *
 *  🔑 It gets a SHARE rather than the whole budget, which is a change from how the drain shipped.
 *  `rejected` is one counter and the upload loop breaks on it, so a drain that spent all 20 left
 *  the tick with no uploads at all — measured at 7 consecutive dead ticks on Sub's file, and the
 *  year window makes the drain bigger. The total work is identical either way; splitting it means
 *  uploads flow from the first tick instead of after two hours of apparent silence. */
const RECHECK_PER_TICK = 10;
/** Backups REJECTED per tick. Rejections cost no upload, so they used to be unbounded — and that
 *  is precisely what let a single tick classify (and, back then, blacklist) a whole folder. A
 *  bound makes any mistake in the rules cheap: it can only ever cost a handful of files before
 *  the next release corrects it. Also caps the I/O, since deciding "off-patch but hauling"
 *  needs the whole file, not just its header. */
const REJECTS_PER_TICK = 20;
/** A session worth sending has at least one of these. Skips crashes and 30-second launches,
 *  which are most of the folder by count and carry nothing the parser can learn from.
 *
 *  🔴 IT CARRIED NO PRICE TERM FOR ITS WHOLE LIFE. This filter was written when sharing was about
 *  missions and blueprints, before the app read a price at all, so a session in which the player
 *  only shopped was thrown away on their own machine before it was ever offered. Measured over 533
 *  real logbackups (`tools/probe-sharefilter.ts`): **28.4% of shopping sessions** and **12.0% of
 *  transaction lines** never uploaded.
 *
 *  🔑 THE TERM IS THE REQUEST, NOT THE COMPONENT — measured, not assumed. The parsers' own
 *  prefilters (ITEM_SHOP_LOG_MARKER / TRADE_LOG_MARKER) are deliberately loose enough to admit a
 *  shop ERROR and a kiosk merely being opened, and those lines carry no price at all:
 *  `<CShopInventory::LoadInventoryFromJSON>` is "item not in the class registry",
 *  `<CreatePurchasableInfo>` is a bare notice with no data in it. Matching on the components
 *  recovers not one extra transaction line and admits 33 sessions that carry nothing — a 68.8%
 *  false-positive rate. Matching the REQUEST recovers 100% of the transaction lines at 0.0%.
 *
 *  🔑 The generic verb form is deliberate: all five `::Send…Request` methods in the corpus are
 *  purchases (`SendShopBuyRequest` 242 lines · `SendStandardItemBuyRequest` 143 ·
 *  `SendCommoditySellRequest` 56 · `SendRentalRequest` 20 · `SendCommodityBuyRequest` 16) and
 *  there is no other `Send…Request` in 533 logs, so a sixth verb is caught without a code change
 *  while a session that only browsed is still refused. The `::` is what keeps it scoped to a
 *  component method call, for the same reason RE_HAUL is scoped to a CreateMarker line. */
const RULES_2_SIGNAL = /MissionEnded|EndMission|Received Blueprint|Contract Complete|Contract Accepted|::Send\w*(?:Buy|Sell|Rental)Request/;
/** The signal rule as it stood at RULES_VERSION 1, kept as SOURCE rather than as a comment because
 *  it is load-bearing: with its v2 sibling it is the only thing that tells a genuine upload apart
 *  from a rejection inside `backups`. See wasUploadedUnderRules. */
const RULES_1_SIGNAL = /MissionEnded|EndMission|Received Blueprint|Contract Complete|Contract Accepted/;
/** RULES_VERSION 3 changes the retention WINDOW, not the signal rule, so v3's signal rule IS v2's.
 *  Aliased rather than copied: two literals that must stay identical are two literals that will
 *  not. Whoever changes the signal rule next declares a new one here and leaves RULES_2_SIGNAL
 *  frozen, which is what keeps the version→rule table below honest. */
const RE_SIGNAL = RULES_2_SIGNAL;
/** The game writes its own UTC session-start stamp as the first thing in the file:
 *  `<2026-08-23T22:10:48.704Z> BackupNameAttachment=…`. Anchored to the START of the text on
 *  purpose — every line carries a stamp, so an unanchored match finds whichever one the read
 *  happened to land on. */
const RE_HEAD_STAMP = /^<(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)>/;
/** `Game Build(12344265) 23 Aug 26 (17 10 39).log` — the same moment in LOCAL time, no offset. */
const RE_NAME_DATE = /\b(\d{1,2}) ([A-Za-z]{3}) (\d{2}) \((\d{2}) (\d{2}) (\d{2})\)/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Cargo hauls survive the patch filter — see shareBackups. The literal names are the three
 *  hauling generators in the corpus (GoblinG 322, Covalex 41, RedWind 2); the CreateMarker arm
 *  mirrors what src/hauling.ts actually admits, which is any marker line whose generator or
 *  contract says "haul"/"cargo". Scoped to a CreateMarker line ON PURPOSE — bare "cargo" appears
 *  all over a Game.log and would match nearly every session. */
const RE_HAUL = /Covalex_Hauling|RedWind_Hauling|GoblinG_\w*HaulCargo|CreateMarker>[^\n]*?\[[^\]]*(?:haul|cargo)[^\]]*\]/i;
const RE_PRODUCT_VERSION = /ProductVersion:\s*([0-9]+\.[0-9]+)/;

/** Does this session carry anything worth uploading? Exported so the suite drives the REAL rule
 *  rather than a copy of it — a rule re-declared in a test is a rule that can drift from the one
 *  running, the same reason the log parsers export their markers. */
export function hasShareSignal(raw: string): boolean {
  return RE_SIGNAL.test(raw) || RE_HAUL.test(raw);
}

/** Was this session UPLOADED by the rules recorded in the state file, or merely REJECTED by them?
 *  Everything in `backups` is one or the other and the filename cannot say which, so the file
 *  itself has to answer it.
 *
 *  🔑 This is an inference off the OLD code's ordering, not a guess — exactly what makes
 *  migrateLegacyBlacklist exact. The old build only ever uploaded a session its own rules
 *  accepted, so a name they reject can only have got into `backups` as a rejection.
 *
 *  🔴 IT TAKES THE VERSION, because a single frozen rule is wrong in one direction or the other
 *  and both are expensive. Judge a v2 file by the v1 rule and every price-only session it really
 *  uploaded is released and sent again; judge a v1 file by the v2 rule and every price-only
 *  session it rejected is retained, which silently cancels the recovery the v2 widening exists
 *  for. Users arrive here from both versions — anyone who skipped 0.1.46 is still on 1.
 *
 *  🔑 The PATCH test does not appear here and does not need to: under v1 and v2 an off-patch file
 *  went to `skippedPatch`, so a name sitting in `backups` WITH signal can only be an upload.
 *  Measured on Sub's file — 24 of the 122 sessions a year admits are exactly that, and releasing
 *  them would re-send every one.
 *
 *  Exported because the state file cannot show the difference end-to-end: a released name that the
 *  NEW rules accept is simply re-recorded in the same tick, so start and end state are identical
 *  whether or not the release happened. The decision is the only place the claim is observable. */
export function wasUploadedUnderRules(rules: number, raw: string): boolean {
  const signal = rules >= 2 ? RULES_2_SIGNAL : RULES_1_SIGNAL;
  return signal.test(raw) || RE_HAUL.test(raw);
}

/** When did this session START? Exported so the suite drives the REAL rule rather than a copy.
 *
 *  🔴 THE BRIEF OFFERED TWO CLOCKS AND THE RIGHT ONE WAS A THIRD. Measured over Sub's 535 real
 *  backups: the header stamp is present on 535/535, the filename date parses on 535/535, and the
 *  three agree to within nine seconds — **not one file** falls on a different side of a one-year
 *  line depending on which you pick. So the choice is not load-bearing for correctness *today*,
 *  and that is exactly the trap: the agreement is a property of a folder that has never been
 *  copied, restored or carried to another machine.
 *
 *  The order is by what survives that:
 *    1. THE HEADER. The game's own statement, in UTC, so it is immune to a timezone move, to DST,
 *       and to the file being copied anywhere by anything. It also costs nothing — `headOf` is
 *       already read to judge the file, so this is a match against bytes we hold.
 *    2. THE FILENAME. The same instant in LOCAL time with no offset in the string, so it can only
 *       be read in the reader's zone. Fine at a year's granularity; not a reason to prefer it.
 *    3. MTIME, last and reluctantly. It is the session END rather than its start (median 0.90h
 *       later, max 24.69h), and it is filesystem metadata: a copy, a restore or a cloud sync
 *       rewrites it to NOW, which makes a three-year-old session read as today's. That failure
 *       admits data rather than excluding it, so it is the cheap direction — but it is also the
 *       one the header is immune to, which is the whole argument for the order.
 *
 *  ⚠️ A machine with a wrong clock states a wrong date here (the shared corpus holds one whose
 *  clock is a year out). Both directions are cheap: too old is a session refused, too new is one
 *  byte. Nothing tries to correct for it — there is no second opinion to correct it against. */
export function sessionStartOf(head: string, name: string, mtimeMs: number): number {
  const iso = head.match(RE_HEAD_STAMP)?.[1];
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  const m = name.match(RE_NAME_DATE);
  if (m) {
    const mon = MONTHS.indexOf(m[2].toLowerCase());
    if (mon >= 0) {
      const t = new Date(2000 + Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  return mtimeMs;
}

/** Keep the last `max` bytes, cut at a line boundary so the upload never starts mid-record. */
function tail(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  const cut = text.slice(-max);
  const nl = cut.indexOf("\n");
  return nl >= 0 ? cut.slice(nl + 1) : cut;
}

/** First 4KB of a file — enough for the header block, without reading a 65MB log to learn
 *  it is from last year. */
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

/** "4.9.188.23497" -> "4.9". The patch line is what the tracker's own post-wipe window keys on;
 *  a pre-wipe session cannot contribute rep or blueprint truth, so it is not worth a byte. */
function patchOf(text: string): string | null {
  return text.match(RE_PRODUCT_VERSION)?.[1] ?? null;
}

export interface LogShareConfig {
  shareLogs: boolean;
  syncToken: string;
  logPath: string;
}

interface ShareState {
  /** Filenames with a FINAL verdict — uploaded, or permanently ineligible (empty, unreadable,
   *  no signal of any kind). A backup is immutable, so these are never re-examined. */
  backups: Set<string>;
  /** Filenames rejected by a RECOVERABLE rule — one that is a claim about our policy rather than
   *  about the file. Since RULES_VERSION 3 that means OUT OF THE RETENTION WINDOW; before it, from
   *  another game patch. Kept apart from `backups` so a later, wider rule can reach them — see
   *  clearSkippedBackups and the rules bump in shareBackups.
   *
   *  ⚠️ THE JSON KEY STAYS `skippedPatch` even though the patch filter is gone. It is persisted on
   *  every user's disk, and renaming it would make every existing list read as empty — which is
   *  survivable (everything is simply re-offered) but is a migration paid for nothing. The name is
   *  historical; the meaning is stated here. */
  skippedPatch: Set<string>;
  /** True until the one-time repair in migrateLegacyBlacklist has actually run. Persisted as the
   *  file's `v`, not inferred from the other fields, so a tick that could NOT judge the patch
   *  (no ProductVersion in the live log) leaves the repair pending instead of silently
   *  swallowing it — that condition is transient, but marking it done would be permanent. */
  legacy: boolean;
  /** The RULES_VERSION whose verdicts the rejection sets in this file were decided under. A
   *  rejection is a claim about the RULE, so when the rules move, every one of them is owed
   *  another look — the same reasoning that split `skippedPatch` out of `backups`, applied to the
   *  signal rule as well. */
  rules: number;
  /** Names a rules change has put back in play but that have not been re-judged yet. Drained a
   *  bounded slice per tick and PERSISTED, so the work resumes after a restart and can never
   *  become the whole-folder pass REJECTS_PER_TICK exists to prevent. */
  recheck: Set<string>;
}
/** Bumped when shared-logs.json gains a field. v1 (pre-0.1.45) is `{ backups }` alone. */
const STATE_VERSION = 2;
/** Bumped when the ACCEPTANCE RULES change — RE_SIGNAL, RE_HAUL, the patch test. Never for a
 *  schema change, which is what STATE_VERSION is for.
 *
 *  🔴 IT MUST NOT BE STATE_VERSION, and reaching for that is the instinctive wrong move. `legacy`
 *  is `v?.v !== STATE_VERSION`, so bumping `v` re-fires migrateLegacyBlacklist on every existing
 *  user — and a version field on a state file in this app is a data-destruction switch, not a
 *  schema label. A rules change is purely additive to the file, so it gets its own field.
 *
 *  1 = the mission/blueprint rules this filter shipped with.  2 = the price term added.
 *  3 = the current-patch filter replaced by a one-year retention window.
 *
 *  🔴 THE BUMP IS THE ENTIRE FEATURE FOR ANYONE WHO HAS ALREADY RUN THE APP, and it is the single
 *  most likely way this change does nothing while looking correct. A widened rule only ever meets
 *  sessions nobody has judged yet; every one of Sub's 535 was already decided (131 recorded, 404
 *  set aside), so without the bump a year-long window recovers exactly zero of the 98 sessions it
 *  exists to reach. Verified as a transition rather than assumed: an existing file says `rules: 2`
 *  and 3 !== 2, so it fires once and stamps itself. */
const RULES_VERSION = 3;
/** The value a file written before `rules` existed is read as. */
const PRE_RULES_VERSION = 1;

/** Kept beside the rest of the user's state; a missing/corrupt file just means "nothing sent
 *  yet", which is safe — the worst case is re-uploading, and the site dedupes nothing so we
 *  simply avoid it here. Reads a pre-0.1.45 file (which had only `backups`) without complaint. */
function loadState(statePath: string): ShareState {
  try {
    const v = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      backups: new Set(Array.isArray(v?.backups) ? v.backups : []),
      skippedPatch: new Set(Array.isArray(v?.skippedPatch) ? v.skippedPatch : []),
      legacy: v?.v !== STATE_VERSION,
      // A file with no `rules` field was written by a build whose rules predate the price term.
      rules: typeof v?.rules === "number" ? v.rules : PRE_RULES_VERSION,
      recheck: new Set(Array.isArray(v?.recheck) ? v.recheck : []),
    };
  } catch {
    // No file at all is a fresh install, not a damaged one — there is nothing to repair, and
    // nothing was ever judged under the old rules, so it starts at the current ones.
    return { backups: new Set(), skippedPatch: new Set(), legacy: false, rules: RULES_VERSION, recheck: new Set() };
  }
}
function saveState(statePath: string, s: ShareState): void {
  try {
    const body = {
      v: s.legacy ? 1 : STATE_VERSION,
      backups: [...s.backups],
      skippedPatch: [...s.skippedPatch],
      // ⚠️ `liveHash` is deliberately no longer written. It deduped the live upload, which no
      // longer happens; an older build reading this file simply finds none and re-posts one live
      // body once, which is the cheap direction for a rollback to be wrong in.
      rules: s.rules,
      recheck: [...s.recheck],
    };
    writeFileSync(statePath, JSON.stringify(body, null, 2));
  } catch (err) {
    console.error("[log-share] could not persist the shared-log state:", err);
  }
}

/** Undo the damage the old blacklist already did, once, on the first run of the fixed code.
 *
 *  🔑 This is safe to infer, not a guess: the old code checked the patch BEFORE it uploaded, so
 *  it could never have sent an off-patch file. Any off-patch name in a pre-0.1.45 list is
 *  therefore a wrongful blacklist, and on-patch names are the genuine uploads. Measured on Sub's
 *  own machine the day this was found: 479 recorded, 70 real, 409 wrongful.
 *
 *  Dropping them from `backups` (rather than moving them to `skippedPatch`) is deliberate — they
 *  have to flow through normal judgement again so the hauling carve-out gets a look at them. */
function migrateLegacyBlacklist(state: ShareState, dir: string, currentPatch: string | null): void {
  if (!currentPatch) return; // can't tell on-patch from off yet — stay legacy and retry next tick
  state.legacy = false;
  if (!state.backups.size) return;
  let freed = 0;
  for (const n of [...state.backups]) {
    try {
      if (patchOf(headOf(join(dir, n))) !== currentPatch) { state.backups.delete(n); freed++; }
    } catch { /* gone from disk — leave it recorded, it can never be uploaded anyway */ }
  }
  if (freed) console.log(`[log-share] released ${freed} backup(s) blacklisted by the old patch filter`);
}

/** Re-judge a bounded slice of what a rules change put back in play. Returns how much of the
 *  tick's rejection budget it spent.
 *
 *  🔴 A RULES CHANGE THAT ONLY LOOKS FORWARD HELPS NOBODY WHO HAS ALREADY RUN THE APP. A widened
 *  filter only ever meets sessions nobody has judged yet, and on a machine that has been running a
 *  while that is almost none of them — every one of the 533 backups on Sub's own disk was already
 *  decided, 134 of them recorded as final. Without this, widening RE_SIGNAL recovers nothing that
 *  exists today and only starts paying from the next rotated session onwards.
 *
 *  🔴 IT MAY NOT SIMPLY EMPTY `backups`, which is the obvious move and is a stampede. That set
 *  holds genuine uploads as well as rejections and no name tells them apart, so releasing it
 *  wholesale would re-offer 134 sessions at BACKUPS_PER_TICK = 1 — 45 hours of duplicate uploads
 *  off one release. The file's own contents are the discriminator.
 *
 *  🔑 Bounded and resumable for the same reason REJECTS_PER_TICK exists at all: a single pass over
 *  the folder here reads whole files (RE_HAUL does not live in the header), which is precisely the
 *  unbounded-rejection-path failure that was fixed once already, wearing a migration's clothes. */
function drainRecheck(state: ShareState, dir: string, budget: number, priorRules: number): number {
  let spent = 0;
  for (const n of state.recheck) {
    if (spent >= budget) break;
    state.recheck.delete(n); // safe mid-iteration: a Set iterator does not revisit a deleted entry
    spent++;
    try {
      const raw = readFileSync(join(dir, n), "utf8");
      // Accepted by the old rules => it was uploaded, and must stay recorded or it is sent twice.
      // Rejected by them => the verdict was about the rule, so put it back in front of the new one.
      if (!wasUploadedUnderRules(priorRules, raw)) state.backups.delete(n);
    } catch {
      // Gone from disk, or locked. Leave it recorded — it can never be uploaded anyway, and a
      // transient lock must not be turned into a release that re-sends it.
    }
  }
  return spent;
}

/** Turning "share logs" back ON is the user's recovery gesture, so it must re-offer everything a
 *  recoverable rule set aside — since RULES_VERSION 3, everything that fell outside the retention
 *  window when it was judged. Deliberately does NOT touch `backups`: re-offering a session already
 *  sent would just spend the site's retention on a duplicate. */
export function clearSkippedBackups(statePath: string): void {
  if (!statePath) return; // nothing is remembered without a state file, so there is nothing to clear
  const state = loadState(statePath);
  if (!state.skippedPatch.size) return;
  console.log(`[log-share] re-offering ${state.skippedPatch.size} previously set-aside backup(s)`);
  state.skippedPatch.clear();
  saveState(statePath, state);
}

/** POST one scrubbed body. Returns true when the site accepted it.
 *
 *  🔑 `kind` is not cosmetic — the site keeps a separate retention quota per kind, and that split
 *  is why a rotated session survives long enough to be read. ⚠️ Only "backup" is ever sent now;
 *  "live" stays in the type because the site's API still has the arm and a caller that guessed at
 *  a third value would be a silent 400. See maybeShareLog for why the live upload was removed. */
async function upload(text: string, token: string, appVersion: string, label: string, kind: "live" | "backup"): Promise<boolean> {
  const bytes = Buffer.byteLength(text, "utf8");
  const res = await fetch(`${SITE}/api/bp-tracker/logs?v=${encodeURIComponent(appVersion)}&kind=${kind}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${token}` },
    body: text,
  });
  if (res.ok) {
    console.log(`[log-share] uploaded ${label} (${bytes} bytes)`);
    return true;
  }
  // A bare status told us nothing when this fired for real — say what was sent and what
  // the site said back, so the next one doesn't need an investigation.
  const why = await res.text().catch(() => "");
  console.error(`[log-share] upload rejected: ${res.status} ${why.slice(0, 200)} (sent ${bytes} bytes of ${label} as ${appVersion || "unknown version"})`);
  return false;
}

/** Send up to BACKUPS_PER_TICK rotated sessions that carry signal and have not been sent before.
 *  Newest first — the most recent session is the one most likely to explain whatever the player
 *  is asking about. Mutates `state`; the caller persists it. */
async function shareBackups(cfg: LogShareConfig, appVersion: string, state: ShareState, currentPatch: string | null): Promise<void> {
  const dir = join(dirname(cfg.logPath), "logbackups");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".log"));
  } catch {
    return; // no logbackups/ — nothing rotated yet, or a non-standard install
  }
  if (state.legacy) migrateLegacyBlacklist(state, dir, currentPatch);

  // 🔑 A RULES CHANGE RE-OPENS EVERY VERDICT THE OLD RULES PRODUCED. Noticing the bump and doing
  // the work it creates are two separate steps on purpose: `rules` records that the bump was seen,
  // so it fires exactly once; `recheck` carries the work, so a restart resumes instead of starting
  // the folder over. Reversible by construction — putting RULES_VERSION back disarms it, and an
  // older build reading this file simply drops the two fields, which re-arms it on the next
  // upgrade. Re-offering is the safe direction to be wrong in.
  // The version the verdicts in this file were decided under, captured BEFORE the bump overwrites
  // it — it is what the drain judges them by, and one line later it is gone.
  const priorRules = state.rules;
  if (state.rules !== RULES_VERSION) {
    state.rules = RULES_VERSION;
    for (const n of state.backups) state.recheck.add(n);
    // 🔴 WHICH SET A RESET RECOVERS DEPENDS ON WHICH RULE MOVED, and for this change it is the
    // exact inverse of the last one. A SIGNAL widening (v2) recovered nothing here, because the
    // patch test ran first and set every one of these aside again — its 4 recoverable sessions
    // sat in `backups`. A WINDOW widening (v3) is the rule that put them here in the first place,
    // so this is where nearly all of it is: measured on Sub's own file, 98 of the 122 sessions a
    // year admits are in `skippedPatch` and the other 24 are already uploaded. Clearing both is
    // what makes the reset indifferent to which rule moved — the alternative is a reset that has
    // to be reasoned about correctly every time, and it was reasoned about wrongly once already.
    state.skippedPatch.clear();
    console.log(`[log-share] acceptance rules changed — re-judging ${state.recheck.size} recorded backup(s)`);
  }
  // Takes a SHARE of the tick's rejection budget rather than all of it. `rejected` is one counter
  // and the upload loop breaks on it, so a drain allowed the full 20 left the tick with no uploads
  // at all — 7 dead ticks in a row on Sub's file, and the year window makes the drain longer. The
  // work is the same either way; this just stops it looking like nothing is happening.
  let rejected = drainRecheck(state, dir, Math.min(RECHECK_PER_TICK, REJECTS_PER_TICK), priorRules);

  const fresh = names.filter((n) => !state.backups.has(n) && !state.skippedPatch.has(n));
  if (!fresh.length) return;

  // Newest first, by mtime.
  const ordered = fresh
    .map((n) => { try { return { n, p: join(dir, n), m: statSync(join(dir, n)).mtimeMs, size: statSync(join(dir, n)).size }; } catch { return null; } })
    .filter((x): x is { n: string; p: string; m: number; size: number } => x !== null)
    .sort((a, b) => b.m - a.m);

  // One clock for the whole tick, so two files judged in the same pass cannot land on opposite
  // sides of a line that moved between them.
  const cutoff = Date.now() - RETENTION_MS;
  let sent = 0;
  for (const b of ordered) {
    if (sent >= BACKUPS_PER_TICK || rejected >= REJECTS_PER_TICK) break;
    if (!b.size) { state.backups.add(b.n); rejected++; continue; }

    // 🔑 THE WINDOW IS DECIDED FROM THE HEADER ALONE, AND THE ORDERING IS THE POINT. The patch
    // rule this replaced needed the whole body before it could refuse anything, because the haul
    // carve-out that exempted it does not live in the header — so refusing a 65 MB session cost
    // reading all 65 MB of it. A year is stated on line one, so an out-of-window file is now
    // refused for 4 KB. On Sub's folder that is 55 of the cleared names costing a header read
    // apiece instead of a body read apiece, on the one tick where the backlog is largest.
    let head: string;
    try { head = headOf(b.p); } catch { state.backups.add(b.n); rejected++; continue; }
    if (sessionStartOf(head, b.n, b.m) < cutoff) { state.skippedPatch.add(b.n); rejected++; continue; }

    // 🔑 THE HAUL CARVE-OUT IS GONE FROM HERE, and it is not a loss. Its only job was to let an
    // OFF-PATCH haul past the patch test, so it went out with the test it existed to bypass —
    // RE_HAUL is still a signal term inside hasShareSignal, which is its other and now only job.
    // A haul older than the window is refused like anything else: Sub asked for a year, and an
    // exemption that reaches past it is an uncapped window wearing a carve-out's clothes.
    let raw: string;
    try { raw = readFileSync(b.p, "utf8"); } catch { state.backups.add(b.n); rejected++; continue; } // locked/deleted
    if (!hasShareSignal(raw)) { state.backups.add(b.n); rejected++; continue; }

    const text = tail(scrubGameLog(raw).text, MAX_BYTES);
    if (!Buffer.byteLength(text, "utf8")) { state.backups.add(b.n); rejected++; continue; }
    if (await upload(text, cfg.syncToken, appVersion, `rotated session ${b.n}`, "backup")) {
      state.backups.add(b.n);
      sent++;
    } else {
      break; // site is unhappy — stop and retry next tick rather than hammering it
    }
  }
}

/** Best-effort: never throws. Trickles ROTATED sessions when sharing is on and a token is set.
 *
 *  🔴 THE LIVE Game.log IS NO LONGER UPLOADED — Sub's call, 2026-08-25, made against the measured
 *  latency it was buying: *"I don't really care about latency with it. We're usually not
 *  troubleshooting something immediately… if we get rid of the current log, we don't have to worry
 *  about duplication. I think it's just a complete waste."*
 *
 *  What it cost, which is what settled it. The live log re-posted on every tick whose scrubbed
 *  content changed, and the game writes one GROWING file per launch — so a single session arrived
 *  as N rows, each a superset of the last. That is not merely wasted storage: it plants duplicate
 *  observations of one event at one timestamp, which reads downstream as independent corroboration
 *  (`pricemine` had to dedupe around it). It also spent all five of the site's live slots on
 *  successive tails of the SAME session, so it did not even preserve the head of a long one.
 *
 *  What it bought, measured over 468 real session gaps: a backup appears only when the player
 *  launches SC again, median **0.1h** later, p75 9.1h, p90 22.2h. So four sessions in five were
 *  superseded within the hour anyway, and the tail is a day — which matters only if someone is
 *  being troubleshooted live, and there the answer is to ask them to relaunch, or for the file.
 *
 *  ⚠️ THE LIVE LOG IS STILL READ, but only its first 4 KB, and only to learn the current patch for
 *  the one-time legacy repair. That alone removes a whole-file read plus a scrub of up to 65 MB
 *  from every 20-minute tick — ~720 ms of blocked event loop, measured, forever, during play. */
export async function maybeShareLog(cfg: LogShareConfig, appVersion = "", statePath = ""): Promise<void> {
  try {
    if (!cfg.shareLogs || !cfg.syncToken) return;
    if (!statePath) return; // nowhere to remember what has been sent; a tick would re-offer forever
    // 🔑 The HEADER only. migrateLegacyBlacklist is the last thing that needs the current patch,
    // and it lives at ~byte 770. ⚠️ Not a gate: with no ProductVersion the repair stays pending and
    // the retention window is unaffected — what bounds a first run is BACKUPS_PER_TICK and
    // REJECTS_PER_TICK, never this value.
    let liveHead = "";
    try { liveHead = headOf(cfg.logPath); } catch { /* no live log yet — backups still trickle */ }
    const state = loadState(statePath);
    await shareBackups(cfg, appVersion, state, patchOf(liveHead));
    saveState(statePath, state);
  } catch (err) {
    console.error("[log-share] failed:", err);
  }
}
