/**
 * The phrasebook: turns a name as the GAME wrote it into the English name the shipped
 * dataset knows.
 *
 * WHY. game.log records the notification text the UI rendered, so it speaks whatever
 * language the player's install is showing. Two populations are affected and neither can
 * tell that anything is wrong:
 *
 *   1. Anyone playing in one of the nine non-English languages. The notification SCAFFOLDING
 *      stays English (none of the 10 non-English global.ini files define
 *      mobiGlas_ui_MissionEvent_Activated or crafting_hud_notification_received_blueprint,
 *      so those fall back), but the PAYLOAD is translated: 417-533 of the 635 pool blueprint
 *      names in most languages. Their receipts parse and then resolve to nothing.
 *   2. Anyone running a community "component language pack" — a loose global.ini that renames
 *      items to carry class/grade info. Measured 2026-08-14: ExoAE renames "Glacier" to
 *      "Glacier Military A", Remix2 to `MIL-1A "Glacier"`, BeltaKoda's Remix to "B10 Colossus".
 *      The first two survive the existing variant-suffix and quoted-designation rules by luck;
 *      the third failed 166 of 166 pool entries.
 *
 * HOW. Every string in the game has a stable key behind it and every language file uses the
 * SAME keys, so composing the two files backwards recovers ours:
 *
 *     their string  ->  localization key  ->  English string  ->  the dataset
 *
 * That is one mechanism for both populations and for every pack that exists or will exist —
 * we never look at a pack, a repo or a version. It also means a pack updating is not our
 * problem: the file on disk is always the truth, and re-reading it is the whole "recalibrate".
 *
 * 🔑 We only ever READ. Writing to global.ini would be modifying game files, which is not
 * something we do, and the app must never become a distribution route for one either.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Shipped alongside blueprints.<changelist>.json — see tools/build-localization.mjs. */
interface LangFile {
  schema: number;
  version: string | null;
  changelist: string | null;
  /** localization key -> English name, for pivoting a global.ini found on disk. */
  keyToEnglish: Record<string, string>;
  /** language folder -> { localized name: English name }, differing entries only. */
  languages: Record<string, Record<string, string>>;
}

export interface PhrasebookInfo {
  /** "ini" = built from the user's own global.ini; "bundled" = the shipped tables;
   *  "none" = no phrasebook available (missing data file). */
  source: "ini" | "bundled" | "none";
  /** The global.ini we read, when there was one. Shown in diagnostics. */
  path: string | null;
  /** g_language from user.cfg, when set. The packs ship one containing "english". */
  language: string | null;
  /** How many localized -> English pairs are loaded. */
  entries: number;
  /** ISO time the phrasebook was last (re)built. */
  at: string;
  /**
   * Notification format keys whose WORDING differs from English once decorations are
   * stripped — i.e. cases the parser's anchors would no longer find.
   *
   * Empty for every language and every pack measured on 2026-08-14: the 10 non-English
   * global.ini files do not define these keys at all (they fall back to English), and all
   * four packs only wrap them in markup, which stripDecorations already removes. So the
   * parser needs no per-install patterns today, and building them would be speculative code
   * with a real regression risk — a malformed derived pattern breaks a working user.
   *
   * 🔑 This is the tripwire for that decision rather than the fix for it. If a pack (or a
   * future CIG translation) ever changes the words, this makes it show up in diagnostics
   * instead of presenting as "the app stopped seeing my blueprints".
   */
  formatDrift: string[];
}

/** The notification formats the parser anchors on, with their English wording. */
const FORMAT_KEYS: Record<string, string> = {
  mobiGlas_ui_MissionEvent_Activated: "Contract Accepted:  %s",
  mobiGlas_ui_MissionEvent_Complete: "Contract Complete: %s",
  mobiGlas_ui_ObjectiveEvent_Activated: "New Objective: %s",
  mobiGlas_ui_Mission_Shared: "Contract Shared: %s",
  "crafting_hud_notification_received_blueprint,P": "Received Blueprint: %s",
};

/** Same rules as the parser's stripDecorations, so drift is judged the way the parser sees it. */
function stripped(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/\[[^\]]*\b(?:Rep|BP)\b[^\]]*\]/gi, "")
    .replace(/\s*\*\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read `g_language` out of a user.cfg. The language packs ship one — it is what tells the
 *  game (and therefore us) WHICH Localization folder is live when more than one is present.
 *  Returns null when the file or the key is absent, which is the ordinary case. */
export function readGameLanguage(channelDir: string): string | null {
  const p = join(channelDir, "user.cfg");
  if (!existsSync(p)) return null;
  try {
    // Lines look like `g_language = english`, sometimes with a trailing comment.
    const m = readFileSync(p, "utf8").match(/^\s*g_language\s*=\s*([^\s;#]+)/im);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The loose global.ini for this install, if the player has one.
 *
 * 🔑 We already know where to look, because we already know where their game.log is: the
 * language file sits at `<channel>/data/Localization/<language>/global.ini`, and both packs
 * install to exactly that path (ExoAE ships a `data` folder to drop in the LIVE root,
 * BeltaKoda ships the `LIVE` folder containing it).
 *
 * When several folders exist, user.cfg's g_language decides — that is what the game itself
 * reads, so it is the only correct tiebreaker. Falling back to whatever single folder is
 * present covers a pack installed without its user.cfg.
 */
export function findLanguageFile(logPath: string): { path: string; language: string | null } | null {
  if (!logPath) return null;
  const channelDir = dirname(logPath);
  const locDir = join(channelDir, "data", "Localization");
  if (!existsSync(locDir)) return null;

  const language = readGameLanguage(channelDir);
  const candidates: string[] = [];
  if (language) candidates.push(join(locDir, language, "global.ini"));
  try {
    for (const d of readdirSync(locDir)) candidates.push(join(locDir, d, "global.ini"));
  } catch {
    /* unreadable — the g_language candidate above may still land */
  }
  for (const c of candidates) if (existsSync(c)) return { path: c, language };
  return null;
}

/** Parse a global.ini into key -> value. Tolerates the BOM and CRLF. Values may contain "="
 *  (mission descriptions do), so only the FIRST one separates. */
function parseIni(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.replace(/^﻿/, "").replace(/\r/g, "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) map.set(line.slice(0, i), line.slice(i + 1));
  }
  return map;
}

export class Phrasebook {
  /** localized name -> English name. Empty when nothing needs translating. */
  private table = new Map<string, string>();
  private info: PhrasebookInfo = { source: "none", path: null, language: null, entries: 0, at: new Date().toISOString(), formatDrift: [] };
  /** Identity of the ini we built from, so a rebuild can be skipped when nothing changed. */
  private stamp: string | null = null;

  constructor(private dataDir: string) {}

  status(): PhrasebookInfo {
    return { ...this.info };
  }

  /**
   * (Re)build from the shipped tables and, when present, the player's own global.ini.
   * Cheap and idempotent — `force` skips the unchanged-file short-circuit, which is what the
   * Calibrate button passes after the player updates their pack.
   */
  load(logPath: string, changelist?: string | null, force = false): PhrasebookInfo {
    const lang = this.readLangFile(changelist);
    const found = findLanguageFile(logPath);

    if (found) {
      let stamp: string | null = null;
      try {
        const st = statSync(found.path);
        stamp = `${found.path}:${st.size}:${st.mtimeMs}`;
      } catch {
        /* fall through and just re-read it */
      }
      // A 10 MB parse per app start is worth avoiding, but never at the cost of being stale
      // after a pack update — hence size+mtime rather than path alone.
      if (!force && stamp && stamp === this.stamp && this.info.source === "ini") return this.status();
      const built = lang ? this.fromIni(found.path, lang) : null;
      if (built) {
        this.table = built.table;
        this.stamp = stamp;
        this.info = {
          source: "ini",
          path: found.path,
          language: found.language,
          entries: built.table.size,
          at: new Date().toISOString(),
          formatDrift: built.formatDrift,
        };
        return this.status();
      }
    }

    // No loose file (the ordinary install): merge every bundled language. Merging means we
    // never have to work out WHICH language they picked — the build step already removed any
    // string two languages disagree about, so a hit is unambiguous whoever wrote it.
    this.stamp = null;
    this.table = new Map();
    if (lang) for (const t of Object.values(lang.languages)) for (const [k, v] of Object.entries(t)) this.table.set(k, v);
    this.info = {
      source: lang ? "bundled" : "none",
      path: null,
      language: found?.language ?? null,
      entries: this.table.size,
      at: new Date().toISOString(),
      formatDrift: [],
    };
    return this.status();
  }

  /** The English name for a name read out of the log, or null if we have no translation for
   *  it — which means either it is already English, or we genuinely do not recognise it.
   *  Callers distinguish those two by asking the dataset. */
  translate(name: string): string | null {
    if (!name) return null;
    return this.table.get(name) ?? this.table.get(name.trim()) ?? null;
  }

  private readLangFile(changelist?: string | null): LangFile | null {
    const candidates = [
      changelist ? join(this.dataDir, `lang.${changelist}.json`) : null,
      join(this.dataDir, "lang.latest.json"),
    ].filter(Boolean) as string[];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        return JSON.parse(readFileSync(p, "utf8")) as LangFile;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /**
   * Pivot the player's own file: their string -> key -> English.
   *
   * 🔑 Ambiguity is declined, never guessed. A pack can point two keys at one string (Remix
   * sets a number of item names to the literal "PLACEHOLDER"), and crediting the wrong
   * blueprint is worse than crediting none — it syncs to the site under that wrong name.
   */
  private fromIni(path: string, lang: LangFile): { table: Map<string, string>; formatDrift: string[] } | null {
    let theirs: Map<string, string>;
    try {
      theirs = parseIni(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
    const candidates = new Map<string, Set<string>>();
    for (const [key, english] of Object.entries(lang.keyToEnglish)) {
      const mine = theirs.get(key);
      if (mine === undefined || mine === english) continue; // untranslated: already matches
      let set = candidates.get(mine);
      if (!set) candidates.set(mine, (set = new Set()));
      set.add(english);
    }
    const out = new Map<string, string>();
    for (const [mine, set] of candidates) if (set.size === 1) out.set(mine, [...set][0]);

    const formatDrift: string[] = [];
    for (const [key, english] of Object.entries(FORMAT_KEYS)) {
      const mine = theirs.get(key);
      if (mine !== undefined && stripped(mine) !== stripped(english)) formatDrift.push(key);
    }
    return { table: out, formatDrift };
  }
}
