/**
 * Fabricator claim prompts.
 *
 * The problem this exists for: `Received Blueprint:` is the ONLY event the game logs for
 * blueprint acquisition, and logs rotate. A player who earned something before installing
 * the app — or whose logbackups are gone — owns blueprints the tracker can never witness.
 * Measured on one real user: 79 blueprints he owns, zero receipts across 869 log files.
 *
 * But the fabricator kiosk only lists blueprints you actually own, and the app is already
 * reading that screen for image capture. So the kiosk is a second, independent ownership
 * signal — and unlike the log it survives rotation. 70 of that user's 79 were already
 * photographed by his own client while the tracker never credited him with them.
 *
 * 🔑 We do NOT auto-tick from OCR. A misread name would silently write a wrong blueprint
 * into someone's synced collection, and the collection is the permanent record — a missing
 * tick costs a click, a wrong tick corrupts the thing we're trying to protect. Instead the
 * player confirms, with the item on screen in front of them, and they are the verifier.
 * That is also why the card shows the RESOLVED catalog name rather than the raw OCR text:
 * "check the OCR read it right" is only a meaningful instruction if what's displayed is
 * what would actually be saved.
 */

/** How long a prompt stays on screen before it gives up. Sub's spec. */
export const CLAIM_TTL_MS = 30_000;

/** How many times one item may prompt per app session. Sub's call: a second chance covers
 *  a prompt missed while the player was mid-craft, without becoming a nag — the OCR loop
 *  re-reads the same kiosk frame every poll, so "every time" would be unusable. */
export const MAX_PROMPTS_PER_SESSION = 2;

export interface ClaimPrompt {
  /** Catalog UUID we would tick. */
  item: string;
  /** Same-named siblings (the 3 sizes of "Cinch Scraper Module" etc.) — all get ticked,
   *  because the kiosk can't say which one you're looking at and neither can we. */
  items: string[];
  /** The blueprint name as the DATASET spells it — what gets saved, so what we show. */
  name: string;
  /** Epoch ms when this prompt expires. */
  expiresAt: number;
}

/** Why a kiosk read did not produce a prompt. Logged verbatim by the sidecar so the log
 *  can never drift from the rule it describes (same discipline as the mining verdicts). */
export type ClaimSkip =
  | "disabled"
  | "already-owned"
  | "unresolved"
  | "prompt-limit"
  | "already-prompting";

export type ClaimDecision =
  | { prompt: ClaimPrompt; why: "prompt" }
  | { prompt: null; why: ClaimSkip };

export class FabClaims {
  /** name -> how many times we've prompted for it this session. Keyed by NAME, not uuid,
   *  so same-named siblings share one budget — they are one prompt to the player. */
  private prompts = new Map<string, number>();
  private active: ClaimPrompt | null = null;

  /** Decide what a kiosk sighting should do.
   *  @param owned whether the tracker already accounts for this blueprint by any source
   *  @param now injected so tests don't depend on the clock */
  seen(
    opts: { item: string | null; items?: string[]; name: string; enabled: boolean; owned: boolean },
    now: number,
  ): ClaimDecision {
    if (!opts.enabled) return { prompt: null, why: "disabled" };
    // No dataset match means we could not sync it even if they said yes — offering the
    // tick would be a lie. The sidecar logs these; they are the `unresolved` diagnostic.
    if (!opts.item || !opts.name) return { prompt: null, why: "unresolved" };
    if (opts.owned) return { prompt: null, why: "already-owned" };
    // Don't replace a live prompt with itself every poll — that restarts its 30s timer
    // forever and the countdown never moves.
    if (this.active && this.active.expiresAt > now) {
      return { prompt: null, why: this.active.name === opts.name ? "already-prompting" : "already-prompting" };
    }
    const shown = this.prompts.get(opts.name) ?? 0;
    if (shown >= MAX_PROMPTS_PER_SESSION) return { prompt: null, why: "prompt-limit" };
    this.prompts.set(opts.name, shown + 1);
    this.active = {
      item: opts.item,
      items: opts.items?.length ? opts.items : [opts.item],
      name: opts.name,
      expiresAt: now + CLAIM_TTL_MS,
    };
    return { prompt: this.active, why: "prompt" };
  }

  /** The prompt awaiting an answer, or null once answered/expired. */
  current(now: number): ClaimPrompt | null {
    if (this.active && this.active.expiresAt <= now) this.active = null;
    return this.active;
  }

  /** Accept the live prompt. Returns it so the caller can tick + broadcast, or null if
   *  it already expired — the 30s window is real, and a late click must not tick
   *  something the player has stopped looking at. */
  accept(now: number): ClaimPrompt | null {
    const p = this.current(now);
    this.active = null;
    return p;
  }

  /** Decline without waiting for the timeout. Keeps the session count, so declining
   *  spends one of the two chances rather than being asked again immediately. */
  dismiss(): void {
    this.active = null;
  }
}
