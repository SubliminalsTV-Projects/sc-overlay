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
  // 🔑 MATCHED WITH THE SPACES REMOVED. OCR loses word breaks at this size — the live
  // board returned "EXTRA SMALLCOVALEXSHIPMENT" and "COVALEXINDEPENDENT CONTRACTORS" —
  // and a space is the one character whose absence carries no meaning here. Stripping it
  // from both sides costs nothing and recovers every one of those rows.
  const escaped = norm
    .split(/(\[[^\]]*\])/)
    .map((part) =>
      part.startsWith("[")
        ? "(.+?)"
        : part.replace(/\s+/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${escaped}$`);
}

/** The form a title is compared in: normalised, then stripped of every space. */
export function titleKey(s: string): string {
  return normalizeTitle(s).replace(/\s+/g, "");
}

/** Loose equality for names the OCR may have mangled — "ROUGH & READY" comes back as
 *  "ROUGH e READY", so the ampersand and any stray single letter around it are dropped
 *  from both sides before comparing. */
function squash(s: string): string {
  return normalizeTitle(s)
    .replace(/\b[A-Z]\b/g, "")
    .replace(/\s+/g, "");
}

/** Levenshtein with an early bail. Only ever called on short names. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Loose equality for names the OCR may have mangled.
 *
 *  🔴 EXACT COMPARISON IS NOT ENOUGH, AND THE FIRST LIVE RUN PROVED IT. Reading Sub's real
 *  board returned "UNG FAMILY HAULING" for Ling Family Hauling (LI read as U) and
 *  "ROUGH B READY" for Rough & Ready. Both rows had a perfect title AND a perfect price
 *  and were thrown away over one character, because candidates were bucketed by an exact
 *  giver key — and a hash lookup has no way to be nearly right. The giver is the SECOND
 *  key here; it only has to be close enough to rule the others out. */
export function sameName(a: string, b: string): boolean {
  const x = squash(a);
  const y = squash(b);
  if (x === y) return true;
  if (!x || !y) return false;
  // Up to two characters on a long name, none on a short one — on something the length of
  // "Wikelo" a two-character slip is a different word, not a misread.
  const cap = Math.min(2, Math.floor(Math.max(x.length, y.length) / 6));
  return cap > 0 && editDistance(x, y, cap) <= cap;
}

/** Turn system votes into an answer, or null. Two-thirds AND at least two rows agreeing —
 *  one row is an anecdote, and a single mis-parsed title should never relocate the player.
 *  Pure, and shared by the one-shot and accumulated paths so they cannot disagree about what
 *  counts as enough evidence. */
export function decideSystem(votes: Map<string, number>): string | null {
  if (!votes.size) return null;
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((a, [, n]) => a + n, 0);
  return ranked[0][1] >= 2 && ranked[0][1] / total >= 0.67 ? ranked[0][0] : null;
}

export class ContractMatcher {
  /** 🔑 Indexed by TITLE, not bucketed by giver. The giver WAS the bucket key until the
   *  first live run discarded two perfectly-read rows over one mis-OCR'd character in the
   *  name. The title is the strongest signal; the giver is now a tolerant filter applied
   *  after it. Testing every pattern per row is a few thousand short regex executions —
   *  immaterial next to the OCR that produced the row. */
  private all: { re: RegExp; c: MatchCandidate }[] = [];

  constructor(candidates: MatchCandidate[]) {
    for (const c of candidates) {
      const re = titlePattern(c.title);
      if (re) this.all.push({ re, c });
    }
  }

  /** Candidates whose title (and, where it narrows, giver and category) fit this row. */
  private hitsFor(row: ContractRow): { re: RegExp; c: MatchCandidate }[] {
    const title = titleKey(row.title);
    if (!title) return [];
    let hits = this.all.filter((b) => b.re.test(title));
    if (row.giver && hits.length > 1) {
      const byGiver = hits.filter((b) => sameName(b.c.giver, row.giver!));
      if (byGiver.length) hits = byGiver;
    }
    if (row.category && hits.length > 1) {
      const byType = hits.filter((b) => sameName(b.c.missionType, row.category!));
      if (byType.length) hits = byType;
    }
    return hits;
  }

  /** Work out which star system the player is in FROM THE BOARD ITSELF.
   *
   *  🔑 Why this is worth having: the system is the difference between a quarter of rows
   *  recording and most of them. On one real capture, three of eight ambiguous rows
   *  resolved to a single contract the moment "Pyro" was supplied. But the app's only
   *  other source is the terrain-streaming report, which the log emits about every TEN
   *  MINUTES — so for most of a scanning session it has nothing, and every same-titled
   *  variant stays unresolved.
   *
   *  A contract board only offers contracts for where you are. So if the rows on screen
   *  overwhelmingly belong to one system, that is the system — no waiting, no guessing at
   *  a stale reading. Only rows whose candidates agree on ONE system get a vote (a row
   *  spanning several says nothing about location), and a clear majority is required, so
   *  a board that genuinely straddles systems yields null rather than a coin flip. */
  /** The single-system votes one screenful casts. Only a row whose candidates ALL sit in one
   *  system is evidence; a contract that exists in Stanton, Pyro and Nyx says nothing about
   *  where you are.
   *
   *  🔑 Split out from inferSystem() so a caller can ACCUMULATE across a whole sweep. One
   *  screenful is often no evidence at all — a board showing nothing but REFUELING casts zero
   *  votes, because every refuel contract exists in all three systems — and the per-capture
   *  version therefore answered "unknown" constantly. See PayoutScanner.ingest. */
  systemVotes(rows: ContractRow[]): Map<string, number> {
    const votes = new Map<string, number>();
    for (const row of rows) {
      const systems = new Set(this.hitsFor(row).flatMap((h) => h.c.systems ?? []));
      if (systems.size !== 1) continue;
      const s = [...systems][0];
      votes.set(s, (votes.get(s) ?? 0) + 1);
    }
    return votes;
  }

  inferSystem(rows: ContractRow[]): string | null {
    return decideSystem(this.systemVotes(rows));
  }

  /** @param system the star system the player is currently in, when known. */
  match(row: ContractRow, system?: string | null): MatchOutcome {
    const title = titleKey(row.title);
    if (!title) return { status: "unknown" };
    let hits = this.all.filter((b) => b.re.test(title));
    if (!hits.length) return { status: "unknown" };

    // The giver NARROWS; it does not gate. If nothing survives the filter the title
    // matches stand on their own — better an ambiguous row than a good read discarded
    // over a mangled name.
    if (row.giver && hits.length > 1) {
      const byGiver = hits.filter((b) => sameName(b.c.giver, row.giver!));
      if (byGiver.length) hits = byGiver;
    }
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
