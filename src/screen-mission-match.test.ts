/**
 * Self-check for matchScreenTitle — the tolerant, tie-safe matcher that maps an OCR-read
 * mission title (truncated by the in-game panel, glitched by OCR) to an accepted mission.
 * Run with:  npx tsx src/screen-mission-match.test.ts
 * Exits non-zero on any failed case.
 */
import { matchScreenTitle } from "./missions.js";

let failed = 0;
function check(name: string, got: string | null, want: string | null): void {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// Titles as the log's "Contract Accepted" notification stores them (quotes, colons, casing).
const ACCEPTED = [
  { id: "jester", title: 'Terrorist Shigemori "Jester" Amsden to be Neutralized' },
  { id: "dropshot", title: 'Preemptive Strike On Leland "Dropshot" Shrader' },
  { id: "tranquility", title: "Assist People's Alliance Vessel Tranquility" },
  { id: "bombing", title: "Strategic Bombing" },
];

// The real failing case: the tracked-mission HUD truncates the title, dropping "Neutralized".
check("truncated HUD read matches", matchScreenTitle('TERRORIST SHIGEMORI "JESTER" AMSDEN TO BE', ACCEPTED), "jester");
// Exact read still matches.
check("exact read matches", matchScreenTitle('Terrorist Shigemori "Jester" Amsden to be Neutralized', ACCEPTED), "jester");
// Quotes as plain chars, apostrophe — all normalized away.
check("apostrophe title matches", matchScreenTitle("ASSIST PEOPLE'S ALLIANCE VESSEL TRANQUILITY", ACCEPTED), "tranquility");
// A single OCR letter glitch mid-title (Dropshot -> Oropshot) still resolves via one-token slack.
check("one-token OCR glitch matches", matchScreenTitle('PREEMPTIVE STRIKE ON LELAND "OROPSHOT" SHRADER', ACCEPTED), "dropshot");
// Truncated-mid-word prefix still matches (panel cut "Neutr…").
check("mid-word truncation matches", matchScreenTitle("TERRORIST SHIGEMORI JESTER AMSDEN TO BE NEUTR", ACCEPTED), "jester");

// Tie-safety: an ambiguous read that could be two missions must return null, not a guess.
const TWO_BOUNTIES = [
  { id: "a", title: "Terrorist Alpha to be Neutralized" },
  { id: "b", title: "Terrorist Beta to be Neutralized" },
];
check("ambiguous read -> null", matchScreenTitle("TERRORIST TO BE NEUTRALIZED", TWO_BOUNTIES), null);
// Garbage read -> null.
check("garbage read -> null", matchScreenTitle("LOADING PLEASE WAIT", ACCEPTED), null);
// Empty -> null.
check("empty read -> null", matchScreenTitle("", ACCEPTED), null);
// No candidates -> null.
check("no candidates -> null", matchScreenTitle("Strategic Bombing", []), null);

if (failed) {
  console.error(`\n${failed} case(s) FAILED`);
  process.exit(1);
}
console.log("\nall screen-mission-match cases passed");
