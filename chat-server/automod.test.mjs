// Auto-moderation matcher — pure, offline, no server. Run with `node chat-server/automod.test.mjs`.
//
// 🔴 THE FALSE-POSITIVE CASES ARE THE POINT OF THIS FILE. Chat is gated on an RSI-VERIFIED
// identity, so a wrong match on the BAN list bans a real person by their real handle, and a wrong
// match on the CENSOR list asterisks a word somebody meant. Substring matching would pass a
// "does it catch bad words" test perfectly and still be unshippable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseList, buildMatcher, maskTerm, createAutomod,
  DEFAULT_BAN_LIST, DEFAULT_CENSOR_LIST,
} from "./automod.mjs";

let n = 0;
const ok = (cond, why) => { assert(cond, why); n++; };
const hits = (re, s) => re.test(s);
const quiet = { log() {}, warn() {}, error() {} };

// ── Parsing ────────────────────────────────────────────────────────────────
{
  const terms = parseList(`
    # a comment
    Alpha
    alpha

      bravo charlie
    #disabled-term
  `);
  assert.deepEqual(terms, ["alpha", "bravo charlie"]); n++;
  ok(!terms.includes("disabled-term"), "a commented-out term is not loaded");
  ok(!terms.includes("# a comment"), "comment lines are dropped whole");
}

// ── Word boundaries — the Scunthorpe set ───────────────────────────────────
{
  const re = buildMatcher(["ass", "hell", "anal", "cum", "spic", "coon", "retard"]);
  ok(hits(re, "that fight was ass"), "a standalone term matches");
  ok(hits(re, "ASS"), "matching is case-insensitive");
  ok(hits(re, "wow, ass!"), "punctuation is a boundary");

  // Every one of these contains a listed term as a SUBSTRING and none of them is the word.
  for (const clean of [
    "class", "Cassius", "grassland", "bypass", "passenger", "Cutlass",   // ass
    "hello", "shell", "Michelle", "helluva",                             // hell
    "analysis", "analyse", "canal", "banal",                             // anal
    "cumulative", "circumstance", "document", "Scunthorpe",              // cum
    "spice", "spicy", "auspices",                                        // spic
    "raccoon", "cocoon", "tycoon",                                       // coon
    "retardant", "retardation of the field",                             // retard
  ]) ok(!hits(re, clean), `"${clean}" must not match`);

  ok(!hits(re, "assassin"), "a term twice over inside one word still does not match");
}

// ── Multi-word phrases ─────────────────────────────────────────────────────
{
  const re = buildMatcher(["alabama hot pocket", "two girls"]);
  ok(hits(re, "an alabama hot pocket"), "a phrase matches");
  ok(hits(re, "alabama   hot\tpocket"), "any run of whitespace between words");
  ok(!hits(re, "alabamahotpocket"), "a phrase does not match without its separators");
  ok(!hits(re, "two girlsx"), "the trailing boundary still applies to a phrase");
}

// ── Terms that are not word-shaped ─────────────────────────────────────────
{
  // 🔑 `\b` is defined against \w, so a `\b`-guarded emoji refuses to match beside a letter —
  // which is exactly where someone types it. Only alphanumeric ENDS get a boundary guard.
  const re = buildMatcher(["🖕", "s&m", "g-spot"]);
  ok(hits(re, "no🖕way"), "an emoji term matches with no whitespace around it");
  ok(hits(re, "🖕"), "and on its own");
  ok(hits(re, "into s&m"), "a term with an inner symbol matches");
  ok(hits(re, "the g-spot"), "a hyphenated term matches");
  ok(!hits(re, "gspot"), "and not without its hyphen");
}

// ── Longest match wins, because the match is what gets reported and masked ─
{
  const re = buildMatcher(["ass", "smart ass"]);
  assert.equal("you smart ass".match(re)[0], "smart ass"); n++;
}

// ── Regex metacharacters in a term are literal ─────────────────────────────
{
  const re = buildMatcher(["c.t"]);
  ok(hits(re, "a c.t here"), "the literal term matches");
  ok(!hits(re, "a cat here"), "the dot is escaped, not a wildcard");
}

// ── An empty list is not a matcher that matches everything ─────────────────
{
  assert.equal(buildMatcher([]), null); n++;
}

// ── Masking ────────────────────────────────────────────────────────────────
{
  assert.equal(maskTerm("shit"), "s***"); n++;
  assert.equal(maskTerm("f"), "f"); n++;
  // 🔑 The first letter stays and the length is preserved: the point is to defuse the word, not
  // to hide that anything happened. A bare row of stars reads as a bug, or as something worse
  // than it was.
  assert.equal(maskTerm("blow job"), "b*** j**"); n++;
  ok(maskTerm("bullshit").length === "bullshit".length, "masking preserves length");
}

// ── The two tiers ──────────────────────────────────────────────────────────
{
  const am = createAutomod({ mode: "on", log: quiet });
  ok(am.banSize > 50 && am.censorSize > 250, `both lists loaded (${am.banSize}/${am.censorSize})`);

  // Ordinary profanity: masked, and the message survives.
  const swear = am.scan("this mission is bullshit");
  assert.equal(swear.tier, "censor"); n++;
  assert.equal(swear.action, "censor"); n++;
  assert.equal(swear.text, "this mission is b*******"); n++;
  ok(/mission/.test(swear.text), "the rest of the sentence is untouched");

  // Every occurrence, not just the first — a global regex whose lastIndex was left dirty would
  // silently skip matches on the next call, which is a bug you only see on the second message.
  const many = am.scan("shit shit shit");
  assert.equal(many.text, "s*** s*** s***"); n++;
  assert.equal(am.scan("shit shit shit").text, "s*** s*** s***", "and again on a second call"); n++;

  // A clean message is clean.
  assert.equal(am.scan("forming up at Everus in 5"), null); n++;
}

// ── 🔴 The escort rule: a mission word fires NOWHERE ───────────────────────
// Sub, 2026-08-11: "Escort for sure cannot be censored. Somebody might be using that word to
// describe a mission." This is the assertion that keeps the whole feature honest.
{
  const am = createAutomod({ mode: "on", log: quiet });
  for (const line of [
    "running deep space hit, need an escort",
    "anyone free to escort me to Pyro?",
    "escort mission pays well",
  ]) assert.equal(am.scan(line), null, `escort must not fire: "${line}"`), n++;

  // And the same for every other ordinary word pulled out of the published list.
  for (const line of [
    "how to kill a Hammerhead solo?",
    "hardcore mining run, 4 hours",
    "that Polaris is sexy",
    "this contract sucks, the payout is nothing",
    "and then poof, the rock was gone",
    "snatch and grab at Checkmate",
    "big black ship on the pad",
  ]) assert.equal(am.scan(line), null, `ordinary vocabulary must not fire: "${line}"`), n++;
}

// ── Ordinary Star Citizen chat is untouched by BOTH lists ──────────────────
{
  const am = createAutomod({ mode: "on", log: quiet });
  for (const line of [
    "anyone got a Cutlass Black for the deep space hit?",
    "running class 3 quantum, forming up now",
    "my analysis of the pool says 5 of 8",
    "the Scunthorpe run pays better",
    "hello o7 forming up at Everus",
    "circumstances changed, bailing on this one",
    "grassland biome, no rocks worth scanning",
    "documents are in the mobiGlas",
    "bypassing the shield generator",
    "Michelle is on the way",
    "raccoon-shaped asteroid, 19200 signature",
    "flame retardant coating on the hull",
    "add some spice to the cargo run",
    "in the cockpit, give me a sec",
    "Titan suit or heavy armour?",
  ]) ok(am.scan(line) === null, `clean line flagged: "${line}" -> ${JSON.stringify(am.scan(line))}`);
}

// ── The ban tier bans; the censor tier never does ──────────────────────────
{
  const banTerms = parseList(readFileSync(DEFAULT_BAN_LIST, "utf8"));
  const censorTerms = parseList(readFileSync(DEFAULT_CENSOR_LIST, "utf8"));
  // 🔑 The two files must not overlap, or which tier a word lands in depends on evaluation
  // order rather than on a decision anyone made.
  const overlap = banTerms.filter((t) => censorTerms.includes(t));
  assert.deepEqual(overlap, [], `a term is on BOTH lists: ${overlap.join(", ")}`); n++;

  const on = createAutomod({ mode: "on", log: quiet });
  const slur = banTerms[0];
  const hit = on.scan(`you ${slur}`);
  assert.equal(hit.tier, "ban"); n++;
  assert.equal(hit.action, "ban", "a ban-list term bans in `on` mode"); n++;

  // "censor" mode is the safe way to run a list still being pruned: the slur is masked and the
  // sender keeps their account. The TIER still says it was the ban list, which is what makes a
  // moderator hear about it while ordinary profanity stays quiet.
  const safe = createAutomod({ mode: "censor", log: quiet });
  const soft = safe.scan(`you ${slur}`);
  assert.equal(soft.action, "censor", "`censor` mode bans nobody"); n++;
  assert.equal(soft.tier, "ban", "...but still reports which list it was"); n++;
  ok(soft.text.includes("*"), "and masks it");
  assert.equal(safe.scan("this is bullshit").tier, "censor", "ordinary profanity is the other tier"); n++;

  // The ban list wins outright — a slur in an otherwise profane message must not be quietly
  // asterisked along with everything else.
  const mixed = on.scan(`this bullshit ${slur} thing`);
  assert.equal(mixed.tier, "ban"); n++;
  assert.equal(mixed.action, "ban"); n++;
}

// ── off, and a missing list ────────────────────────────────────────────────
{
  const off = createAutomod({ mode: "off", log: quiet });
  assert.equal(off.active, false); n++;
  assert.equal(off.scan("bullshit"), null, "an off automod never matches"); n++;

  // A missing list disables that tier rather than throwing — no auto-moderation is where this
  // feature was yesterday, and refusing to boot over it would be worse than the gap.
  const gone = createAutomod({ banFile: "./nope.txt", censorFile: "./nope.txt", mode: "on", log: quiet });
  assert.equal(gone.active, false); n++;
  assert.equal(gone.scan("anything"), null); n++;

  // One tier can run without the other.
  const banOnly = createAutomod({ censorFile: "./nope.txt", mode: "on", log: quiet });
  ok(banOnly.active, "a ban list with no censor list still runs");
  assert.equal(banOnly.scan("this is bullshit"), null, "...and lets profanity straight through"); n++;
}

console.log(`automod tests passed (${n} assertions)`);
