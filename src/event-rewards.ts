/**
 * Self-filling event rewards: notice that a player crossed a tier, notice what landed in their
 * inventory a heartbeat later, and ask them ONE question to turn that into a measurement.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * `data/events.json` knows Siege of Orison has six reward tiers and knows exactly ONE of the
 * rewards — the S-38 "SecondWind" Pistol at 15%, confirmed off Sub's own log. The other five are
 * blank, and Sub has said plainly he will not grind to 100% on the PTU to fill them in just to
 * redo it on live. So they have to fill themselves, from real players, on live day.
 *
 * The app can already see both halves of a tier grant and has never put them together:
 *   - it tracks event points, so it knows when a threshold is crossed;
 *   - it parses `Received Blueprint: <name>`.
 * Measured on Sub's log, 2026-08-22: the blueprint landed **383 ms** after the journal entry that
 * crossed 43,200. That is a tight enough correlation to say "you just passed 15% and this is what
 * you got" and be right.
 *
 * ── 🔴 THE OBSERVATION IS A CANDIDATE, NOT A MEASUREMENT ─────────────────────────────────────
 *
 * Two independent reasons the app must ask rather than record:
 *
 * 1. **Correlation is not causation, even at 383 ms.** A blueprint from a mission reward pool can
 *    land in the same second as a tier crossing — the tier crossing is itself *caused* by
 *    completing a contract, and contracts drop pool blueprints. The receipt line's MissionId is
 *    all-zeros for EVERY blueprint (measured across 173 receipts), so the log cannot attribute it.
 * 2. **One player's answer is a claim.** Corroboration happens server-side, and nothing reaches
 *    the shipped `rewards` list on one report — see the site's `/api/sc/event-reward`.
 *
 * ── 🔴 CANDIDATES MUST NEVER RENDER AS FACT ─────────────────────────────────────────────────
 *
 * `events.json` carries `rewardCandidates`: five plausible Orison rewards relayed from a viewer's
 * chatbot answer. They are unconfirmed. Their ONLY sanctioned use is inside this prompt, as the
 * thing being asked about — "it looks like you received X, is that right?" — which is exactly the
 * mechanism that promotes one to a measurement. They may not be shown as the reward anywhere.
 */

/** One `Received Blueprint:` line, kept only long enough to correlate. */
export interface ReceiptNote {
  name: string;
  atMs: number;
}

/** An unconfirmed guess at a tier's reward, from `events.json`'s `rewardCandidates`. */
export interface RewardCandidate {
  tier: number;
  name: string;
  confirmed?: boolean;
}

export type PromptAnswerSource =
  /** The player agreed with what the log observed. */
  | "confirmed"
  /** The player said the observation (or candidate) was wrong and named something else. */
  | "corrected"
  /** Nothing was observed and the player typed the name. */
  | "typed"
  /** The player said they got nothing, or dismissed it without answering. */
  | "none";

export interface PromptAnswer {
  name: string | null;
  source: PromptAnswerSource;
  at: string;
}

/**
 * One "you just crossed a tier" question.
 *
 * 🔑 `observed` and `candidate` are kept SEPARATE and both travel to the answer. When they agree
 * the card is a one-click confirmation; when they DISAGREE the observation is the higher-value
 * signal, because it means the candidate list is wrong — which is a discovery in its own right,
 * not an error case.
 */
export interface RewardPrompt {
  /** `<eventId>:<tier>` — stable, so a prompt cannot be raised twice for one tier. */
  id: string;
  eventId: string;
  eventLabel: string;
  tier: number;
  crossedAt: string;
  crossedAtMs: number;
  /** What the log saw arrive inside the correlation window. Null when nothing did. */
  observed: string | null;
  /** The unconfirmed guess for this tier, if the registry has one. */
  candidate: string | null;
  answer: PromptAnswer | null;
  /** True once the answer has been accepted by the site (or refused permanently). */
  reported: boolean;
}

/** How long after a tier crossing a blueprint receipt still counts as that tier's reward.
 *  The measured gap is 383 ms; this is deliberately generous against a loaded server, and is
 *  still far shorter than the ~seconds between two separate contract completions. */
export const RECEIPT_WINDOW_MS = 3_000;

/** How long the card stays on screen. Sub's number, and deliberately generous: the player is
 *  mid-game and may be in a fight when it appears. */
export const PROMPT_DWELL_MS = 120_000;

/**
 * Which tiers a points change crossed.
 *
 * 🔑 Returns EVERY tier crossed, not just the highest. A single large contract can cross two
 * thresholds at once, and each is a separate reward with a separate unknown.
 * 🔑 `prevPct` of null means "we had no reading before", which happens on the first priced
 * contribution of a session. Treating that as 0 would re-raise a prompt for every tier the player
 * cleared weeks ago, so it crosses nothing — `seenTiers` is what carries history across restarts.
 */
export function tiersCrossed(prevPct: number | null, nextPct: number | null, tiers: number[]): number[] {
  if (prevPct == null || nextPct == null) return [];
  if (nextPct <= prevPct) return [];
  return tiers.filter((t) => prevPct < t && nextPct >= t).sort((a, b) => a - b);
}

/**
 * The receipt that best explains a tier crossing, or null.
 *
 * ⚠️ Only ever looks FORWARD. A blueprint that arrived BEFORE the crossing belongs to whatever
 * happened before it; claiming it would attribute a mission-pool drop to the event.
 */
export function receiptForCrossing(
  crossedAtMs: number,
  receipts: ReceiptNote[],
  windowMs = RECEIPT_WINDOW_MS,
): ReceiptNote | null {
  let best: ReceiptNote | null = null;
  for (const r of receipts) {
    const d = r.atMs - crossedAtMs;
    if (d < 0 || d > windowMs) continue;
    if (!best || r.atMs < best.atMs) best = r;
  }
  return best;
}

/** The unconfirmed candidate for a tier, if the registry declares one. */
export function candidateForTier(candidates: RewardCandidate[] | undefined, tier: number): string | null {
  const c = (candidates ?? []).find((x) => x.tier === tier && !x.confirmed);
  return c ? c.name : null;
}

/**
 * Is this prompt due to be shown?
 *
 * Three gates, and each one exists because of a way the card could be wrong or annoying:
 * - **The correlation window must have closed.** Raising the card the instant the tier is crossed
 *   would show "we did not see what you got" and then change its mind 383 ms later, which is
 *   worse than a card that arrives three seconds late.
 * - **The dwell must not have expired.** Sub's two minutes, after which it disappears on its own.
 * - **It must be unanswered and unreported.** An answered prompt is history, not a question.
 */
export function isPromptDue(p: RewardPrompt, nowMs: number, windowMs = RECEIPT_WINDOW_MS, dwellMs = PROMPT_DWELL_MS): boolean {
  if (p.answer || p.reported) return false;
  const opens = p.crossedAtMs + windowMs;
  return nowMs >= opens && nowMs < opens + dwellMs;
}

/**
 * Should a crossing raise a question at all?
 *
 * 🔑 NO, when the tier's reward is already MEASURED. There is nothing to learn, and asking anyway
 * turns a one-time contribution into a recurring interruption for every player who ever crosses
 * 15%. The prompt exists to fill blanks, not to audit what is already known.
 */
export function shouldAsk(tier: number, measuredRewardTiers: number[]): boolean {
  return !measuredRewardTiers.includes(tier);
}

/**
 * What to send to the site, or null when the answer carries nothing worth reporting.
 *
 * 🔑 A "none" answer with no name IS still worth sending — "I crossed 43% and received nothing"
 * is evidence that the tier has no blueprint reward, which is a real possible answer and one no
 * amount of waiting for a positive report would ever establish. What is NOT worth sending is a
 * dismissal, which is why the caller distinguishes them.
 */
export function reportBody(p: RewardPrompt): {
  event: string;
  tier: number;
  name: string | null;
  observed: string | null;
  candidate: string | null;
  agreed: boolean;
  source: PromptAnswerSource;
  at: string;
} | null {
  if (!p.answer) return null;
  return {
    event: p.eventId,
    tier: p.tier,
    name: p.answer.name,
    observed: p.observed,
    candidate: p.candidate,
    // Did the log and the player agree? The site weights a confirmed observation differently
    // from a hand-typed name, because one of them had a witness.
    agreed: p.answer.source === "confirmed",
    source: p.answer.source,
    at: p.answer.at,
  };
}
