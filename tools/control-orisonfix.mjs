#!/usr/bin/env node
/**
 * Negative controls for flight `orisonfix`.
 *
 * A green test is not evidence until it can go red. Each control below re-injects the exact
 * behaviour that was fixed, runs the suite that is supposed to catch it, and requires that suite
 * to FAIL **naming the assertion we expect**. A control that reddens a different assertion is a
 * bug in the test, not proof of coverage.
 *
 * Three rules this runner follows, each of which has burned this repo before:
 *  - GRADE ON THE OUTPUT TEXT (`FAIL `), never on the exit code.
 *  - ABORT LOUDLY ON A NO-OP PATCH. A `replace()` whose anchor does not match rewrites the file
 *    unchanged, the suite then runs on pristine source and prints "all passed" — which reads as
 *    "the control proves nothing is broken", the exact conclusion a working control rules out.
 *  - REQUIRE THE SUITE TO HAVE REPORTED SOMETHING. A suite that produced no assertions at all
 *    (a parse error, a bad spawn) is a broken control, never a passing one.
 *
 * Restores are from an IN-MEMORY copy taken before the first patch, not from git: a runner that
 * crashes mid-restore must not be able to leave a mutilated source file behind, and this repo has
 * lost a source file that way once already.
 *
 * Run with:  npm run control:orisonfix
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MISSIONS = join(ROOT, "src", "missions.ts");

const pristine = readFileSync(MISSIONS, "utf8");
let failures = 0;

/**
 * ⚠️ EVERY SOURCE FILE IN THIS REPO IS CRLF. A multi-line anchor written with `\n` matches
 * nothing, the patch silently becomes a no-op, and the suite then runs on pristine source and
 * prints a false green. Anchors below are written with `\n` for readability and converted here.
 */
const EOL = pristine.includes("\r\n") ? "\r\n" : "\n";
const nl = (s) => s.split("\n").join(EOL);

function runSuite(file) {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", file)],
    { cwd: ROOT, encoding: "utf8", timeout: 180000 });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

/**
 * @param name       what is being controlled
 * @param suite      the test file that must go red
 * @param patch      (src) => mutated src
 * @param mustRedden substrings of the assertion names that MUST appear on a FAIL line
 */
function control(name, suite, patch, mustRedden) {
  const patched = patch(pristine);
  if (patched === pristine) {
    console.log(`\n🔴 CONTROL "${name}": PATCH DID NOT APPLY (anchor not found) — aborting.`);
    console.log("   Running the suite now would measure UNMODIFIED source and print a false green.");
    failures++;
    return;
  }
  writeFileSync(MISSIONS, patched);
  let out;
  try {
    out = runSuite(suite);
  } finally {
    writeFileSync(MISSIONS, pristine); // always, even if the suite threw
  }

  const reported = out.includes("ok  ") || out.includes("FAIL");
  // 🔴 A SUITE THAT DIED PART-WAY LOOKS EXACTLY LIKE A SUITE THAT PASSED — it has printed some
  // `ok` lines and no `FAIL` lines, so both checks above are satisfied and the control reads
  // GREEN. C5 hit this on its first run: the injected regression made the constructor THROW, the
  // process died before reaching the assertions, and the runner reported "stayed green — the
  // assertion is a tautology" about an assertion that is nothing of the sort. Every suite here
  // ends by printing its own terminator; demand it.
  const finished = /tests passed|FAILED \(\d+\)/.test(out);
  const failLines = out.split(/\r?\n/).filter((l) => l.includes("FAIL"));
  console.log(`\n── CONTROL: ${name}`);
  if (!reported || !finished) {
    console.log(`   🔴 the suite did not run to completion (${reported ? "aborted part-way" : "no assertions at all"})`);
    console.log("      — a broken control, never a pass. Last lines:");
    console.log("   " + out.split(/\r?\n/).filter(Boolean).slice(-6).join("\n   "));
    failures++;
    return;
  }
  if (!failLines.length) {
    console.log("   🔴 suite stayed GREEN with the regression re-injected — the assertion is a tautology.");
    failures++;
    return;
  }
  console.log(`   suite went red (${failLines.length} FAIL line(s)):`);
  for (const l of failLines.slice(0, 6)) console.log("     " + l.trim());
  for (const want of mustRedden) {
    const hit = failLines.some((l) => l.includes(want));
    console.log(`   ${hit ? "✅" : "🔴"} expected assertion reddened: "${want}"`);
    if (!hit) failures++;
  }
}

// ── C1 ─────────────────────────────────────────────────────────────────────────────────────────
// Remove the environment filter: count every stored contribution, as the shipped build did.
control(
  "C1 count contributions from EVERY environment (Sub's shipped bug)",
  "event-track.test.ts",
  (s) => s.replace(
    "const contributions = stored.filter((c) => this.sameEnv(c.env));",
    "const contributions = stored.slice();",
  ),
  ["LIVE: the PTU contribution does NOT count", "LIVE: and no tier reads as reached"],
);

// ── C2 ─────────────────────────────────────────────────────────────────────────────────────────
// The opposite direction, and it is NOT redundant: a build that refuses PTU contributions
// outright also makes C1's assertions green. Only this control stops the fix being "re-gate it",
// which is precisely what `5f512f7` removed on purpose.
control(
  "C2 refuse PTU contributions entirely (the fix Sub explicitly did NOT want)",
  "event-track.test.ts",
  (s) => s.replace(
    "const contributions = stored.filter((c) => this.sameEnv(c.env));",
    "const contributions = stored.filter((c) => this.sameEnv(c.env) && this.isLiveEnv);",
  ),
  ["PTU: the contribution is recorded AND counted while on the PTU"],
);

// ── C3 ─────────────────────────────────────────────────────────────────────────────────────────
// Make the purge a no-op that still reports success.
control(
  "C3 the purge discards nothing",
  "event-track.test.ts",
  (s) => s.replace(
    nl("    this.eventContributions.delete(def.log);\n    this.askedTiers.delete(def.id);"),
    nl("    this.askedTiers.delete(def.id);"),
  ),
  ["progress is zero after the purge", "the purge is persisted, not just in memory"],
);

// ── C4 ─────────────────────────────────────────────────────────────────────────────────────────
// Leave askedTiers behind. Its own control, because C3 passing does not cover it: the counter
// can zero correctly while the tier bookkeeping survives and silently suppresses the reward
// question the player has just re-earned.
control(
  "C4 the purge forgets the contributions but keeps askedTiers",
  "event-track.test.ts",
  (s) => s.replace(
    nl("    this.askedTiers.delete(def.id);\n    this.rewardPrompts"),
    nl("    this.rewardPrompts"),
  ),
  ["the tier bookkeeping is cleared with it"],
);

// ── C5 ─────────────────────────────────────────────────────────────────────────────────────────
// Put the ABORT back: once a field throws, every field after it is abandoned. That — not a bare
// crash — is what the shipped code did, because the whole method sat inside one try whose catch
// swallowed everything.
//
// ⚠️ The first draft of this control simply un-wrapped the `missionHistory` assignment, which
// makes the constructor THROW instead. The suite then died before its assertions ran, printed no
// FAIL lines, and the runner scored it GREEN — see the `finished` guard above. A control has to
// reproduce the old BEHAVIOUR, not merely break the new code somewhere nearby.
control(
  "C5 restore the all-or-nothing loadState (one bad field abandons the rest)",
  "state-recovery.test.ts",
  (s) => s.replace(
    nl("    const load = (name: keyof Persisted, fn: () => void): void => {\n      try {\n        fn();\n      } catch {"),
    nl("    let aborted = false;\n    const load = (name: keyof Persisted, fn: () => void): void => {\n      if (aborted) return;\n      try {\n        fn();\n      } catch {\n        aborted = true;"),
  ),
  ["eventContributions survives the throw", "askedTiers survives too"],
);

// ── C6 ─────────────────────────────────────────────────────────────────────────────────────────
// Keep the isolation but drop the PRESERVATION half — the field loads as a default and the save
// overwrites the original. This is the control that proves the two properties are independent:
// C5's assertions all stay green here.
control(
  "C6 isolate fields but overwrite what could not be read",
  "state-recovery.test.ts",
  (s) => s.replace(
    "const out: Persisted = { ...data, ...this.unreadableState };",
    "const out: Persisted = { ...data };",
  ),
  ["the unreadable field is written back UNCHANGED, not emptied"],
);

console.log(
  failures
    ? `\n🔴 ${failures} control problem(s) — read the lines above; a control that stays green or reddens the wrong assertion is not coverage.`
    : "\n✅ all 6 controls behaved: each re-injected regression reddened the assertion written to catch it.",
);
process.exit(failures ? 1 : 0);
