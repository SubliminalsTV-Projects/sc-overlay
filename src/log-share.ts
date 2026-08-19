// Opt-in log sharing. When enabled (config.shareLogs) and a sync token is set, the
// current Star Citizen Game.log is scrubbed (src/log-scrub) and uploaded to subliminal.gg
// so mission + blueprint parsing can be improved against real sessions. Deduped by the
// scrubbed content's hash so the periodic tick never re-posts an unchanged session.
//
// ROTATED SESSIONS TOO (since 0.1.39). The game writes a FRESH Game.log per launch and
// rotates the old one into logbackups/, so sharing only the live file could never show a
// session the player had already finished — a user reported Battaglia standing stuck at
// zero and every log he sent held accepts and no completions, purely because his completed
// sessions had rotated away. Backups are immutable once written, so each is uploaded once,
// ever, remembered by FILENAME in the state file (no need to read a file to know it is done).
//
// 🔑 THE FILTERS ARE WHAT MAKE THIS AFFORDABLE, and they were measured, not guessed. Re-measured
// 2026-08-16 on Sub's machine: logbackups/ held 479 files / 687 MB with the 4 MB cap applied.
// Filtered to the CURRENT patch and to sessions that contain mission signal that is 41 files /
// 132 MB, plus the hauling carve-out below at 13 files / 49 MB — 54 files / 181 MB, which at the
// measured 7.5x Postgres compression is ~24 MB stored per user. Unfiltered it would be ~92 MB
// each, nearly all of it pre-wipe sessions the tracker deliberately ignores anyway.
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
import { createHash } from "node:crypto";
import { scrubGameLog } from "./log-scrub.js";

const SITE = "https://subliminal.gg";
// The site rejects a body over 4MB (and an empty one) with a bare 400. A long session's
// game.log goes well past that, so trim to the most RECENT 4MB rather than posting something
// that can only be refused — the tail is the part that describes what the player just did.
const MAX_BYTES = 4 * 1024 * 1024;
/** Backups uploaded per tick. One keeps a first-run backlog to a trickle (Sub's 54-file
 *  backlog spreads over ~18h of app uptime) instead of a burst the site has to absorb. */
const BACKUPS_PER_TICK = 1;
/** Backups REJECTED per tick. Rejections cost no upload, so they used to be unbounded — and that
 *  is precisely what let a single tick classify (and, back then, blacklist) a whole folder. A
 *  bound makes any mistake in the rules cheap: it can only ever cost a handful of files before
 *  the next release corrects it. Also caps the I/O, since deciding "off-patch but hauling"
 *  needs the whole file, not just its header. */
const REJECTS_PER_TICK = 20;
/** A session worth sending has at least one of these. Skips crashes and 30-second launches,
 *  which are most of the folder by count and carry nothing the parser can learn from. */
const RE_SIGNAL = /MissionEnded|EndMission|Received Blueprint|Contract Complete|Contract Accepted/;
/** Cargo hauls survive the patch filter — see shareBackups. The literal names are the three
 *  hauling generators in the corpus (GoblinG 322, Covalex 41, RedWind 2); the CreateMarker arm
 *  mirrors what src/hauling.ts actually admits, which is any marker line whose generator or
 *  contract says "haul"/"cargo". Scoped to a CreateMarker line ON PURPOSE — bare "cargo" appears
 *  all over a Game.log and would match nearly every session. */
const RE_HAUL = /Covalex_Hauling|RedWind_Hauling|GoblinG_\w*HaulCargo|CreateMarker>[^\n]*?\[[^\]]*(?:haul|cargo)[^\]]*\]/i;
const RE_PRODUCT_VERSION = /ProductVersion:\s*([0-9]+\.[0-9]+)/;

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
  /** Filenames rejected ONLY for being from another game patch. Not a property of the file, but
   *  of the rule we judged it by, so it is kept apart and is recoverable — see clearSkippedBackups. */
  skippedPatch: Set<string>;
  /** sha1 of the last live body accepted by the site. Persisted because it used to live in a
   *  module-level variable, so every app restart re-posted a byte-identical Game.log: one user
   *  spent 2 of his 5 live retention slots on the same 165,261-byte body an hour apart. */
  liveHash: string;
  /** True until the one-time repair in migrateLegacyBlacklist has actually run. Persisted as the
   *  file's `v`, not inferred from the other fields, so a tick that could NOT judge the patch
   *  (no ProductVersion in the live log) leaves the repair pending instead of silently
   *  swallowing it — that condition is transient, but marking it done would be permanent. */
  legacy: boolean;
}
/** Bumped when shared-logs.json gains a field. v1 (pre-0.1.45) is `{ backups }` alone. */
const STATE_VERSION = 2;

/** Kept beside the rest of the user's state; a missing/corrupt file just means "nothing sent
 *  yet", which is safe — the worst case is re-uploading, and the site dedupes nothing so we
 *  simply avoid it here. Reads a pre-0.1.45 file (which had only `backups`) without complaint. */
function loadState(statePath: string): ShareState {
  try {
    const v = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      backups: new Set(Array.isArray(v?.backups) ? v.backups : []),
      skippedPatch: new Set(Array.isArray(v?.skippedPatch) ? v.skippedPatch : []),
      liveHash: typeof v?.liveHash === "string" ? v.liveHash : "",
      legacy: v?.v !== STATE_VERSION,
    };
  } catch {
    // No file at all is a fresh install, not a damaged one — there is nothing to repair.
    return { backups: new Set(), skippedPatch: new Set(), liveHash: "", legacy: false };
  }
}
function saveState(statePath: string, s: ShareState): void {
  try {
    const body = {
      v: s.legacy ? 1 : STATE_VERSION,
      backups: [...s.backups],
      skippedPatch: [...s.skippedPatch],
      liveHash: s.liveHash,
    };
    writeFileSync(statePath, JSON.stringify(body, null, 2));
  } catch (err) {
    console.error("[log-share] could not persist the shared-log state:", err);
  }
}

/** Callers with no state path have nowhere to persist to, so they get a process-lifetime record.
 *  This is what `lastHash` used to be, and it is only ever the fallback. */
const memState: ShareState = { backups: new Set(), skippedPatch: new Set(), liveHash: "", legacy: false };

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

/** Turning "share logs" back ON is the user's recovery gesture, so it must re-offer everything
 *  that was skipped for being off-patch at the time. Deliberately does NOT touch `backups`:
 *  re-offering a session already sent would just spend the site's retention on a duplicate. */
export function clearSkippedBackups(statePath: string): void {
  if (!statePath) { memState.skippedPatch.clear(); return; }
  const state = loadState(statePath);
  if (!state.skippedPatch.size) return;
  console.log(`[log-share] re-offering ${state.skippedPatch.size} previously off-patch backup(s)`);
  state.skippedPatch.clear();
  saveState(statePath, state);
}

/** POST one scrubbed body. Returns true when the site accepted it.
 *
 *  🔑 `kind` is not cosmetic — the site keeps a separate retention quota per kind. Under one
 *  shared quota the live log, which re-uploads on every content change, evicted rotated sessions
 *  within hours of them arriving. Sending "backup" is what keeps a finished session around long
 *  enough to be read. */
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
  const fresh = names.filter((n) => !state.backups.has(n) && !state.skippedPatch.has(n));
  if (!fresh.length) return;

  // Newest first, by mtime.
  const ordered = fresh
    .map((n) => { try { return { n, p: join(dir, n), m: statSync(join(dir, n)).mtimeMs, size: statSync(join(dir, n)).size }; } catch { return null; } })
    .filter((x): x is { n: string; p: string; m: number; size: number } => x !== null)
    .sort((a, b) => b.m - a.m);

  let sent = 0;
  let rejected = 0;
  for (const b of ordered) {
    if (sent >= BACKUPS_PER_TICK || rejected >= REJECTS_PER_TICK) break;
    if (!b.size) { state.backups.add(b.n); rejected++; continue; }

    // The header alone answers the patch question, but hauling does not live in the header, so a
    // patch MISMATCH is the one case that has to read the body before it can be judged.
    let raw: string;
    let onPatch: boolean;
    try {
      onPatch = !currentPatch || patchOf(headOf(b.p)) === currentPatch;
      raw = readFileSync(b.p, "utf8");
    } catch { state.backups.add(b.n); rejected++; continue; } // locked/deleted — don't retry forever

    // 🔑 The patch filter exists so pre-wipe sessions don't spend storage on rep/blueprint truth
    // that a wipe already invalidated. A cargo haul is not that: an old-patch haul is still a
    // valid haul, and phase 5's calibration corpus wants it. Measured at 13 files / 49 MB on a
    // 479-backup folder, so the exemption is narrow enough to afford.
    const haul = RE_HAUL.test(raw);
    if (!onPatch && !haul) { state.skippedPatch.add(b.n); rejected++; continue; }
    if (!RE_SIGNAL.test(raw) && !haul) { state.backups.add(b.n); rejected++; continue; }

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

/** Best-effort: never throws. Uploads only when sharing is on, a token is set, and the
 *  scrubbed content changed since the last upload. Also trickles rotated sessions. */
export async function maybeShareLog(cfg: LogShareConfig, appVersion = "", statePath = ""): Promise<void> {
  try {
    if (!cfg.shareLogs || !cfg.syncToken) return;
    const raw = readFileSync(cfg.logPath, "utf8");
    if (!raw.trim()) return;
    const scrubbed = scrubGameLog(raw).text;
    const text = tail(scrubbed, MAX_BYTES);
    const bytes = Buffer.byteLength(text, "utf8");
    // One load and one save per tick, so the live hash and the backup lists can never disagree
    // about which of them wrote the file last.
    const state = statePath ? loadState(statePath) : memState;
    // Nothing survived the scrub: skip rather than spend a request the site must refuse.
    if (bytes === 0) {
      console.error(`[log-share] nothing to upload — ${raw.length} chars scrubbed to 0 (${cfg.logPath})`);
    } else {
      const hash = createHash("sha1").update(text).digest("hex");
      if (hash !== state.liveHash) {
        const trimmed = bytes < Buffer.byteLength(scrubbed, "utf8") ? ", tail only" : "";
        if (await upload(text, cfg.syncToken, appVersion, `the live Game.log${trimmed}`, "live")) state.liveHash = hash;
      }
    }
    // The live log is where the current patch comes from. ⚠️ It is NOT a gate: when the live log
    // carries no ProductVersion, `onPatch` is true for everything and the patch filter is simply
    // off for that tick. What stops a first run walking the folder is BACKUPS_PER_TICK and
    // REJECTS_PER_TICK, not this value — the comment that used to sit here said otherwise.
    if (statePath) {
      await shareBackups(cfg, appVersion, state, patchOf(raw.slice(0, 4096)));
      saveState(statePath, state);
    }
  } catch (err) {
    console.error("[log-share] failed:", err);
  }
}
