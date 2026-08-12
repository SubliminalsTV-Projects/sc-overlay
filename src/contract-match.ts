// Matching a row read off the Contract Manager board back to a dataset contract.
//
// The board shows a title with its placeholders already FILLED IN and uppercased
// ("DEFEND REMOTE OUTPOST NEAR YANG'S PLACE FROM OUTLAWS"); the dataset stores the
// template ("Defend Remote Outpost near [NearbyLocation] from Outlaws"). So a title is
// matched as a PATTERN, and the giver and category are exact secondary keys.
//
// 🔑 MEASURED FEASIBILITY, not assumed (blueprints 4.9.0-LIVE.12344265, pool missions):
//     title + giver + category            -> 61% resolve to exactly one contract
//     ... + the system the player is in   -> 75%
// The remaining 25% are same-title variants inside one system — the RegionA/B/C/D problem
// that cost Sub a week on "Deep space hit". An ACCEPTED mission can be pinned down from
// the objective and route log lines, but a contract merely SITTING ON A BOARD emits
// neither, so there is no signal and none is invented.
//
// 🔑 AN AMBIGUOUS ROW RECORDS NOTHING. Payout observations aggregate to a median, so one
// value filed against the wrong variant is not a small error — it is permanent. Same rule
// the blueprint pools already follow: an admittedly-unknown answer beats a confident wrong
// one. Unresolved rows are returned so the caller can log them, which is worth doing for
// its own sake: ~70 contracts have titles our extraction never resolved (they sit in the
// data as "[Destination] Errand", "PU Bounty PVE Pyro Rough And Ready Cargo"), and the
// board is the only place their real name is visible.

import type { ContractRow } from "./contract-list.js";
import { normalizeTitle } from "./contract-list.js";

export interface MatchCandidate {
  debugName: string;
  title: string;
  giver: string;
  missionType: string;
  /** Star systems this variant is offered in, when the detail dataset is present. */
  systems?: string[];
}

export type MatchOutcome =
  | { status: "matched"; debugName: string; via: "unique" | "system" }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "unknown" };

/** Turn a dataset title into a matcher. `[Placeholder]` becomes a wildcard; everything
 *  else is literal. Returns null for a title that is ITSELF an unresolved placeholder
 *  ("[Destination] Errand") — those would match almost anything and must never win. */
export function titlePattern(datasetTitle: string): RegExp | null {
  const norm = normalizeTitle(datasetTitle);
  if (!norm) return null;
  // 🔴 A title that is MOSTLY placeholder carries no distinguishing text and would
  // swallow half the board. "[Destination] Errand" leaves the single word "ERRAND", which
  // as `^(.+?) ERRAND$` matches any errand anywhere. Two real words minimum — that keeps
  // "[TargetName] needs stomping" (NEEDS STOMPING) while refusing the vacuous ones.
  const literal = norm.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  if (literal.length < 8 || literal.split(" ").filter(Boolean).length < 2) return null;
  const escaped = norm
    .split(/(\[[^\]]*\])/)
    .map((part) => (part.startsWith("[") ? "(.+?)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${escaped}$`);
}

/** Loose equality for names the OCR may have mangled — "ROUGH & READY" comes back as
 *  "ROUGH e READY", so the ampersand and any stray single letter around it are dropped
 *  from both sides before comparing. */
export function sameName(a: string, b: string): boolean {
  const squash = (s: string) =>
    normalizeTitle(s)
      .replace(/\b[A-Z]\b/g, "")
      .replace(/\s+/g, "");
  return squash(a) === squash(b);
}

export class ContractMatcher {
  /** Bucketed by giver so a board row only ever tests the patterns that could apply. */
  private byGiver = new Map<string, { re: RegExp; c: MatchCandidate }[]>();

  constructor(candidates: MatchCandidate[]) {
    for (const c of candidates) {
      const re = titlePattern(c.title);
      if (!re) continue;
      const key = normalizeTitle(c.giver).replace(/\b[A-Z]\b/g, "").replace(/\s+/g, "");
      const list = this.byGiver.get(key);
      if (list) list.push({ re, c });
      else this.byGiver.set(key, [{ re, c }]);
    }
  }

  /** @param system the star system the player is currently in, when known. */
  match(row: ContractRow, system?: string | null): MatchOutcome {
    if (!row.giver) return { status: "unknown" };
    const key = normalizeTitle(row.giver).replace(/\b[A-Z]\b/g, "").replace(/\s+/g, "");
    const bucket = this.byGiver.get(key);
    if (!bucket?.length) return { status: "unknown" };

    const title = normalizeTitle(row.title);
    let hits = bucket.filter((b) => b.re.test(title));
    // The category is a filter, not a requirement: it is only applied when it actually
    // narrows things, so a category header the OCR mangled can't wipe out a good match.
    if (row.category && hits.length > 1) {
      const byType = hits.filter((b) => sameName(b.c.missionType, row.category!));
      if (byType.length) hits = byType;
    }
    if (!hits.length) return { status: "unknown" };

    const names = [...new Set(hits.map((b) => b.c.debugName))];
    if (names.length === 1) return { status: "matched", debugName: names[0], via: "unique" };

    // Same title, same giver, same type — the player's current system is the last signal
    // available for a contract that is only being LOOKED at, not run.
    if (system) {
      const sys = normalizeTitle(system);
      const inSystem = hits.filter((b) => (b.c.systems ?? []).some((s) => normalizeTitle(s) === sys));
      const narrowed = [...new Set(inSystem.map((b) => b.c.debugName))];
      if (narrowed.length === 1) return { status: "matched", debugName: narrowed[0], via: "system" };
      if (narrowed.length > 1) return { status: "ambiguous", candidates: narrowed };
    }
    return { status: "ambiguous", candidates: names };
  }
}
