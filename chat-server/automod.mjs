// SC Overlay chat — auto-moderation, in two tiers.
//
// 🔴 THE TIERS ARE SUB'S POLICY, VERBATIM (2026-08-11): "I'm worried about racial slurs, hate
// speech, that type of stuff… Otherwise, I really don't care if an adult uses profanity amongst
// other adults. I don't need to ban for that. We could just censor it."
//
//   ban.txt     slurs and hate speech → the message is refused and the sender is banned
//   censor.txt  ordinary profanity   → the word is asterisked and the message goes through
//
// The two lists are separate FILES, not flags on one list, because they answer different
// questions and get pruned by different reasoning. A term in neither file never fires at all —
// which is how `escort` is handled, and it is not a hypothetical: it was on the published list,
// it is an SC mission type, and "need an escort" is close to the most-typed sentence in an LFG
// channel.
//
// 🔴 MATCH ON WORD BOUNDARIES, NEVER `includes()` — the Scunthorpe problem. Every other chat
// surface in Star Citizen is pseudonymous; this one is gated on an RSI-VERIFIED identity, which
// is the whole reason a ban here sticks. It is also the reason a false positive is expensive: it
// bans a real person by their real handle. `includes("ass")` fires on "class", "Cassius",
// "Grassland" and the ship called Cutlass.
//
// 🔑 A term's boundary is asserted with LOOKAROUNDS, not `\b`. `\b` is defined against `\w`, so
// it is simply wrong at either end of a term that does not start or end with a word character —
// on the list's one emoji (🖕) a `\b` guard would refuse to match it next to a letter, which is
// exactly where someone would put it. So each end is guarded only when the term's own character
// there is alphanumeric.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BAN_LIST = join(HERE, "wordlist-ban.txt");
export const DEFAULT_CENSOR_LIST = join(HERE, "wordlist-censor.txt");

/** Read a word-list file into unique lowercase terms.
 *  `#` comments a line out, so reviewing a list is editing it rather than deleting from it — a
 *  term Sub decides against stays visible as a decision instead of vanishing. */
export function parseList(text) {
  const terms = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#"));
  return [...new Set(terms)];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One alternation over every term. Literals only, so there is nothing here to backtrack.
 *  🔑 Longest first: the match is what gets REPORTED and what gets asterisked, and a moderator
 *  reading "ass" when the message contained a three-word phrase learns the wrong thing. */
export function buildMatcher(terms, { global = false } = {}) {
  if (!terms.length) return null;
  const parts = [...terms].sort((a, b) => b.length - a.length).map((t) => {
    // Spaces in a term match any run of whitespace — nobody types a phrase with exactly one.
    const body = esc(t).replace(/\s+/g, "\\s+");
    const lead = /^[a-z0-9]/.test(t) ? "(?<![a-z0-9])" : "";
    const tail = /[a-z0-9]$/.test(t) ? "(?![a-z0-9])" : "";
    return `${lead}${body}${tail}`;
  });
  return new RegExp(`(?:${parts.join("|")})`, global ? "giu" : "iu");
}

/** Asterisk a matched word, keeping its first character and its length.
 *  🔑 The first letter stays because the point is to defuse the word, not to hide that anything
 *  happened — a row of stars with no shape reads as a bug or as censorship of something worse
 *  than it was. Whitespace inside a phrase is preserved so the line still scans. */
export function maskTerm(match) {
  let atWordStart = true;
  return [...match].map((ch) => {
    if (/\s/.test(ch)) { atWordStart = true; return ch; }
    if (atWordStart) { atWordStart = false; return ch; }
    return "*";
  }).join("");
}

function loadList(file, label, log) {
  try {
    return parseList(readFileSync(file, "utf8"));
  } catch (e) {
    // A missing list is not a reason to refuse to start — it means that tier is inactive, which
    // is where this feature was yesterday. Say so loudly and carry on.
    log?.warn?.(`[automod] no ${label} list at ${file} (${e?.message}) — that tier is off`);
    return [];
  }
}

/** modes:
 *    "off"    — loaded but never consulted
 *    "censor" — BOTH lists censor. Nobody is banned. The safe way to run a list you have not
 *               finished pruning, and the default for exactly that reason.
 *    "on"     — ban.txt bans and refuses the message; censor.txt asterisks and lets it through
 */
export function createAutomod({
  banFile = DEFAULT_BAN_LIST,
  censorFile = DEFAULT_CENSOR_LIST,
  mode = "censor",
  log = console,
} = {}) {
  const banTerms = loadList(banFile, "ban", log);
  const censorTerms = loadList(censorFile, "censor", log);
  const banRe = buildMatcher(banTerms);
  // The censor pass has to find EVERY occurrence, not just the first — a message with three
  // swears in it should come out with three of them masked.
  const censorRe = buildMatcher(censorTerms, { global: true });
  const active = mode !== "off" && !!(banRe || censorRe);
  log?.log?.(`[automod] mode=${mode} ban=${banTerms.length} censor=${censorTerms.length} active=${active}`);

  return {
    mode,
    active,
    banSize: banTerms.length,
    censorSize: censorTerms.length,
    /** `tier` is WHICH LIST matched; `action` is what to do about it. They are separate because
     *  in "censor" mode a slur is masked rather than banned — but a moderator still needs to hear
     *  about it, and must never hear about ordinary profanity. Nothing downstream can tell those
     *  two apart from `action` alone.
     *  @returns {{tier:"ban"|"censor", action:"ban"|"censor", term: string, text?: string}|null} */
    scan(text) {
      if (!active) return null;
      const raw = String(text ?? "");
      // 🔑 The ban list is checked FIRST and wins outright. A slur inside an otherwise profane
      // message must not be quietly asterisked along with everything else — the whole point of
      // the split is that one of these is a ban and the other is not.
      const hit = banRe ? banRe.exec(raw) : null;
      if (hit) {
        const term = hit[0].toLowerCase();
        if (mode === "on") return { tier: "ban", action: "ban", term };
        // "censor" mode: known-bad, but nobody is banned while a list is still being pruned.
        return { tier: "ban", action: "censor", term, text: raw.replace(banRe, maskTerm) };
      }
      if (!censorRe) return null;
      censorRe.lastIndex = 0;   // a /g/ regex is stateful; a stale lastIndex skips real matches
      const first = censorRe.exec(raw);
      if (!first) return null;
      censorRe.lastIndex = 0;
      return {
        tier: "censor", action: "censor", term: first[0].toLowerCase(),
        text: raw.replace(censorRe, maskTerm),
      };
    },
  };
}
