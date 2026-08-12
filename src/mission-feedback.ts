/**
 * Crowdsourced mission facts the game files don't carry — what you actually DO in a mission,
 * how hard it was, and whether it can be soloed.
 *
 * Collected by the completion report (overlay/missions.html) in the seconds after a mission
 * ends, which is the only moment the player has the answer fresh and is not being asked to
 * recall anything. Nothing here is inferred: every field is something a human typed.
 *
 * 🔑 Stored under %APPDATA%, never beside the binary — Program Files is read-only and writing
 * there throws EPERM, which killed the sidecar silently the last time (see SKILL.md).
 *
 * 🔑 Answers are keyed by CONTRACT KEY, not title. The Battaglia work proved titles collide:
 * `Blackbox Retrieval` is two different contracts, and filing feedback under the title would
 * merge a rank-2 repeatable with a one-time intro mission.
 *
 * One answer per contract per player, last write wins. People change their minds as they run a
 * mission more times, and the later answer is the better-informed one. `pending` marks rows the
 * site hasn't accepted yet; nothing consumes it until the subliminal.gg endpoint exists, at
 * which point this file is already the upload queue.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CombatProfile } from "./mission-classify.js";

/** 1 = trivial, 5 = brutal. A 5-point scale because 3 has no middle and 10 is a survey. */
export type Difficulty = 1 | 2 | 3 | 4 | 5;

export interface MissionAnswer {
  contractKey: string;
  /** null when the player skipped the combat question (or the game data already answered it). */
  combat: CombatProfile | null;
  difficulty: Difficulty | null;
  /** Did they complete it alone? Drives "can I run this solo" — the most-asked planning question
   *  after "what does it drop". null = not answered. */
  solo: boolean | null;
  /** What they flew it in, captured from the log rather than asked (Sub, 2026-08-09). A
   *  difficulty rating means something very different in a Hammerhead than in an Aurora, so
   *  without this the 1–5 scale is comparing runs that aren't comparable. Display name as the
   *  comms channel gives it ("Drake Cutlass Black") + the manufacturer on its own for grouping.
   *  null = on foot, or never seen boarding (the app can attach mid-session). */
  ship: string | null;
  shipManufacturer: string | null;
  /** ISO time the answer was given, and the build it was given against — a mission can be
   *  rebalanced between patches, so a difficulty rating without a changelist ages badly. */
  at: string;
  changelist: string | null;
  appVersion: string | null;
  /** Not yet accepted by the site. */
  pending: boolean;
}

export interface FeedbackInput {
  contractKey?: unknown;
  combat?: unknown;
  difficulty?: unknown;
  solo?: unknown;
  ship?: unknown;
  shipManufacturer?: unknown;
  changelist?: unknown;
  appVersion?: unknown;
}

const COMBAT_VALUES: CombatProfile[] = ["fps", "ship", "mixed", "none"];

/** Validate and normalise one submission. Returns null when there is nothing worth storing —
 *  a row with a key and no actual answers is noise, not data. */
export function sanitizeAnswer(input: FeedbackInput, now = new Date()): MissionAnswer | null {
  const contractKey = typeof input.contractKey === "string" ? input.contractKey.trim() : "";
  if (!contractKey) return null;

  const combat = COMBAT_VALUES.includes(input.combat as CombatProfile) ? (input.combat as CombatProfile) : null;
  const dRaw = Number(input.difficulty);
  const difficulty = Number.isInteger(dRaw) && dRaw >= 1 && dRaw <= 5 ? (dRaw as Difficulty) : null;
  const solo = typeof input.solo === "boolean" ? input.solo : null;
  // 🔑 The ship is METADATA, not an answer — it must not on its own make a submission worth
  // storing, or every completion would file an empty row just because the player was seated.
  if (combat === null && difficulty === null && solo === null) return null;

  const str = (v: unknown, max: number): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s.slice(0, max) : null;
  };

  return {
    contractKey,
    combat,
    difficulty,
    solo,
    ship: str(input.ship, 60),
    shipManufacturer: str(input.shipManufacturer, 40),
    at: now.toISOString(),
    changelist: typeof input.changelist === "string" && input.changelist ? input.changelist : null,
    appVersion: typeof input.appVersion === "string" && input.appVersion ? input.appVersion : null,
    pending: true,
  };
}

export class MissionFeedbackStore {
  private path: string;
  private answers = new Map<string, MissionAnswer>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "mission-feedback.json");
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch {
      /* already there, or unwritable — the read below will decide */
    }
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const rows = JSON.parse(readFileSync(this.path, "utf8")) as MissionAnswer[];
      if (Array.isArray(rows)) for (const r of rows) if (r?.contractKey) this.answers.set(r.contractKey, r);
    } catch {
      /* corrupt file — start clean rather than crash the sidecar on boot */
    }
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify([...this.answers.values()], null, 2));
    } catch (err) {
      // Never throw from a request handler — an async throw here exits the whole process.
      console.log(`[feedback] could not write ${this.path}: ${(err as Error).message}`);
    }
  }

  /** Store one answer, replacing any earlier answer for the same contract. */
  record(input: FeedbackInput): MissionAnswer | null {
    const a = sanitizeAnswer(input);
    if (!a) return null;
    this.answers.set(a.contractKey, a);
    this.save();
    console.log(
      `[feedback] ${a.contractKey} — combat=${a.combat ?? "-"} difficulty=${a.difficulty ?? "-"} solo=${a.solo ?? "-"}`,
    );
    return a;
  }

  /** What this player has already said about a contract, if anything. Lets the report show a
   *  previous answer as selected instead of asking the same question again from blank. */
  get(contractKey: string | null): MissionAnswer | null {
    return contractKey ? this.answers.get(contractKey) ?? null : null;
  }

  /** Rows the site hasn't taken yet — the upload queue. */
  pending(): MissionAnswer[] {
    return [...this.answers.values()].filter((a) => a.pending);
  }

  /** Mark answers as accepted by the site. Only clears rows that are still IDENTICAL to
   *  what was uploaded: a player can revise an answer while the request is in flight, and
   *  clearing `pending` on the newer row would strand the revision here forever. */
  markUploaded(uploaded: MissionAnswer[]): void {
    let changed = false;
    for (const u of uploaded) {
      const cur = this.answers.get(u.contractKey);
      if (!cur || !cur.pending || cur.at !== u.at) continue;
      cur.pending = false;
      changed = true;
    }
    if (changed) this.save();
  }

  count(): number {
    return this.answers.size;
  }
}
