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
// 🔑 THE FILTERS ARE WHAT MAKE THIS AFFORDABLE, and they were measured, not guessed. On Sub's
// machine logbackups/ held 441 files / 1.2 GB (618 MB with the 4 MB cap applied). Filtered to
// the CURRENT patch and to sessions that actually contain mission signal it is 23 files / 74 MB,
// which at the measured 7.5x Postgres compression is ~10 MB stored per user — under a gigabyte
// even at 100 sharers. Unfiltered it would be ~82 MB stored each, nearly all of it pre-wipe
// sessions the tracker deliberately ignores anyway.
import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { scrubGameLog } from "./log-scrub.js";

const SITE = "https://subliminal.gg";
// The site rejects a body over 4MB (and an empty one) with a bare 400. A long session's
// game.log goes well past that, so trim to the most RECENT 4MB rather than posting something
// that can only be refused — the tail is the part that describes what the player just did.
const MAX_BYTES = 4 * 1024 * 1024;
/** Backups uploaded per tick. One keeps a first-run backlog to a trickle (Sub's 23-file
 *  backlog spreads over ~7.5h of app uptime) instead of a burst the site has to absorb. */
const BACKUPS_PER_TICK = 1;
/** A session worth sending has at least one of these. Skips crashes and 30-second launches,
 *  which are most of the folder by count and carry nothing the parser can learn from. */
const RE_SIGNAL = /MissionEnded|EndMission|Received Blueprint|Contract Complete|Contract Accepted/;
const RE_PRODUCT_VERSION = /ProductVersion:\s*([0-9]+\.[0-9]+)/;

let lastHash = "";

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

/** Persisted set of backup filenames already uploaded. Kept beside the rest of the user's
 *  state; a missing/corrupt file just means "nothing sent yet", which is safe — the worst
 *  case is re-uploading, and the site dedupes nothing so we simply avoid it here. */
function loadDone(statePath: string): Set<string> {
  try {
    const v = JSON.parse(readFileSync(statePath, "utf8"));
    return new Set(Array.isArray(v?.backups) ? v.backups : []);
  } catch {
    return new Set();
  }
}
function saveDone(statePath: string, done: Set<string>): void {
  try {
    writeFileSync(statePath, JSON.stringify({ backups: [...done] }, null, 2));
  } catch (err) {
    console.error("[log-share] could not persist the uploaded-backup list:", err);
  }
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

/** Send up to BACKUPS_PER_TICK rotated sessions that are on the CURRENT patch, carry mission
 *  signal, and have not been sent before. Newest first — the most recent session is the one
 *  most likely to explain whatever the player is asking about. */
async function shareBackups(cfg: LogShareConfig, appVersion: string, statePath: string, currentPatch: string | null): Promise<void> {
  const dir = join(dirname(cfg.logPath), "logbackups");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".log"));
  } catch {
    return; // no logbackups/ — nothing rotated yet, or a non-standard install
  }
  const done = loadDone(statePath);
  const fresh = names.filter((n) => !done.has(n));
  if (!fresh.length) return;

  // Newest first, by mtime.
  const ordered = fresh
    .map((n) => { try { return { n, p: join(dir, n), m: statSync(join(dir, n)).mtimeMs, size: statSync(join(dir, n)).size }; } catch { return null; } })
    .filter((x): x is { n: string; p: string; m: number; size: number } => x !== null)
    .sort((a, b) => b.m - a.m);

  let sent = 0;
  for (const b of ordered) {
    if (sent >= BACKUPS_PER_TICK) break;
    // Cheap rejections first, and MARK THEM DONE so we never look at them again. A backup is
    // immutable, so "not this patch" and "no signal" are permanent answers, not transient ones.
    if (!b.size) { done.add(b.n); continue; }
    let raw: string;
    try {
      if (currentPatch && patchOf(headOf(b.p)) !== currentPatch) { done.add(b.n); continue; }
      raw = readFileSync(b.p, "utf8");
    } catch { done.add(b.n); continue; } // unreadable (locked/deleted) — don't retry forever
    if (!RE_SIGNAL.test(raw)) { done.add(b.n); continue; }

    const text = tail(scrubGameLog(raw).text, MAX_BYTES);
    if (!Buffer.byteLength(text, "utf8")) { done.add(b.n); continue; }
    if (await upload(text, cfg.syncToken, appVersion, `rotated session ${b.n}`, "backup")) {
      done.add(b.n);
      sent++;
    } else {
      break; // site is unhappy — stop and retry next tick rather than hammering it
    }
  }
  saveDone(statePath, done);
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
    // Nothing survived the scrub: skip rather than spend a request the site must refuse.
    if (bytes === 0) {
      console.error(`[log-share] nothing to upload — ${raw.length} chars scrubbed to 0 (${cfg.logPath})`);
    } else {
      const hash = createHash("sha1").update(text).digest("hex");
      if (hash !== lastHash) {
        const trimmed = bytes < Buffer.byteLength(scrubbed, "utf8") ? ", tail only" : "";
        if (await upload(text, cfg.syncToken, appVersion, `the live Game.log${trimmed}`, "live")) lastHash = hash;
      }
    }
    // Rotated sessions are gated on knowing the current patch: without it every backup would
    // look eligible and a first run would try to ship the entire folder.
    if (statePath) await shareBackups(cfg, appVersion, statePath, patchOf(raw.slice(0, 4096)));
  } catch (err) {
    console.error("[log-share] failed:", err);
  }
}
