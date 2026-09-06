/**
 * Negative controls for the invariants `test:repscan` and `test:reppage` gained with the rep-scan
 * feedback work. Run with `npm run control:repname`.
 *
 * Each control re-injects the exact defect the assertion exists to catch, requires the suite to
 * go RED **naming that assertion**, and restores the file. A green control here means the
 * assertion is a tautology, not that the code is fine.
 *
 * The rules this runner obeys, all of them learned the expensive way in this repo:
 *  · GRADE ON THE OUTPUT TEXT (`FAIL `), never on the exit code.
 *  · ABORT LOUDLY ON A NO-OP PATCH — a replace that matched nothing runs the suite on unmodified
 *    source and prints a perfect green, which reads as "the control proves nothing is broken".
 *  · REQUIRE THE SUITE TO HAVE REPORTED AT ALL, and to have reached its own TERMINATOR. A run
 *    that produced no assertions, or that crashed part-way, is a broken control and never a pass.
 *  · CHECK *WHICH* ASSERTION WENT RED. A control that reddens a different assertion — especially
 *    a positive-first guard — is a bug in the test, not evidence for it.
 *  · Restore from a copy held IN MEMORY, not from git: these are the files being protected, and a
 *    runner that dies mid-restore is how this repo lost a source file once already.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const APPLY = ["src/rep-scan-apply.test.ts"];
const PAGE = ["src/rep-page.test.ts"];
const CONTROLS = [
  {
    name: "C1 giverScopes keyed by the raw dataset spelling again",
    suite: APPLY,
    file: "src/missions.ts",
    from: "      const key = normRep(m.giver);",
    to: "      const key = m.giver;   // CONTROL: the pre-fix behaviour",
    reddens: ["giverScopes offers EXACTLY ONE key"],
    // The positive-first guard must survive: it is sourced from the dataset file, not from the
    // code under control, so it vouches for there being two spellings either way.
    staysGreen: ["the dataset really does spell this faction more than one way"],
  },
  {
    name: "C2 the interpolation cap removed (a 100% bar lands on the next rank's floor)",
    suite: APPLY,
    file: "src/missions.ts",
    from: "      ? Math.min(Math.round(floor + p * ((ceiling as number) - floor)), (ceiling as number) - 1)",
    to: "      ? Math.round(floor + p * ((ceiling as number) - floor))   // CONTROL: cap removed",
    reddens: ["the stored value and the rank index NEVER name different ranks"],
    staysGreen: ["the sweep really covered every rank of every shipped scope"],
  },
  {
    // The state the Covalex / Wikelo Emporium report arrived in: a refusal that names no faction.
    name: "C3 a refusal stops carrying the faction heading it read",
    suite: PAGE,
    file: "src/rep-page.ts",
    from: 'return { layout: null, refusal: "cards-incomplete", tried, factionRaw, sectionRaw, giver };',
    to: 'return { layout: null, refusal: "cards-incomplete", tried };   // CONTROL: the pre-fix behaviour',
    reddens: ["...and it names the faction heading it read"],
    // Sourced from a DIFFERENT refusal path, so it vouches that the fixture still reads and the
    // suite still runs even with this one path gutted.
    staysGreen: ["...and still names the giver it resolved, so the gap is reportable"],
  },
  {
    // 🔑 The one that stops "empty tried" being a free assertion: make the loop consider a ladder
    // it should have skipped, and the data-gap signature disappears.
    name: "C4 the giver's scope set stops filtering the candidate ladders",
    suite: PAGE,
    file: "src/rep-page.ts",
    from: "    if (giverScopeSet && !giverScopeSet.has(key)) continue;   // this giver never awards it",
    to: "    if (false && giverScopeSet && !giverScopeSet.has(key)) continue;   // CONTROL",
    reddens: ["...with an EMPTY tried, which is what says it was a data gap and not a bad read"],
    staysGreen: ["...while the same frame with the real giver map reads fine and DID weigh ladders"],
  },
  {
    // Sub's own bug: the heading resolves to the 35-mission `Covalex` instead of the 925-mission
    // `Covalex Independent Contractors` that actually awards Hauling.
    name: "C5 the COVALEX heading alias removed",
    suite: PAGE,
    file: "src/rep-page.ts",
    from: '  "COVALEX": "Covalex Independent Contractors",',
    to: "  // CONTROL: alias removed",
    reddens: ["a COVALEX heading is attributed to the canonical giver, not the 35-mission one"],
    // Sourced from the shipped DATASET, not from the alias table, so it vouches that the split
    // this alias exists for is real whether or not the alias is present.
    staysGreen: ["the dataset really does split Covalex into two givers"],
  },
  {
    // The FIRST of Wikelo's two defects: OCR reads the game's ampersand as a lowercase e, so
    // "BARTER e TRADE" never matched "Barter & Trade" and the page refused `no-section` —
    // a refusal the capture loop does not even forward, so it was silent as well as wrong.
    name: "C6 the ampersand-misread repair removed",
    suite: PAGE,
    file: "src/rep-page.ts",
    from: '  return toks.map((t, i) => (t === "E" && i > 0 && i < toks.length - 1 ? "AND" : t));',
    to: "  return toks;   // CONTROL: ampersand repair removed",
    reddens: ["the ampersand misread normalises to the same thing as a real ampersand",
              "shot3: the Wikelo page reads at all"],
    // Sourced from the shipped files, not from normRep, so it vouches the vocabulary is really
    // closed whether or not the repair exists.
    staysGreen: ["no shipped name has a standalone E the ampersand repair could corrupt"],
  },
  {
    // The SECOND defect, independent of the first: the heading is longer than the giver.
    // Note this alias runs the opposite way to Covalex's, which is why a prefix RULE was rejected.
    name: "C7 the WIKELO EMPORIUM heading alias removed",
    suite: PAGE,
    file: "src/rep-page.ts",
    from: '  "WIKELO EMPORIUM": "Wikelo",',
    to: "  // CONTROL: alias removed",
    reddens: ["shot3: the heading is aliased to the dataset giver rep is stored under"],
    // The page still READS without the alias — it just cannot be attributed. That asymmetry is
    // the whole reason both fixes were needed, so assert the reading half survives.
    staysGreen: ["shot3: the Wikelo page reads at all"],
  },
  {
    // The reason Wikelo was SILENT rather than merely broken: `no-section` was never forwarded,
    // so the page produced no feedback on the widget and no line in sidecar.log.
    name: "C8 no-section stops being reported even when we know the faction",
    suite: PAGE,
    file: "src/rep-page.ts",
    from: '  return r.refusal === "no-section" && !!r.giver;',
    to: "  return false;   // CONTROL: the pre-fix behaviour",
    reddens: ["a rep page whose section we cannot match IS reported when we know the faction"],
    // Must stay green, or the control has just made the rule report NOTHING rather than testing
    // the clause — and "quiet on an unknown heading" would then pass for the wrong reason.
    staysGreen: ["...and stays quiet on a no-section frame whose heading is nobody we know",
                 "a scrolled ladder is reported to the player"],
  },
];

let bad = 0;
for (const c of CONTROLS) {
  const original = readFileSync(c.file, "utf8");
  const patched = original.replace(c.from, c.to);
  if (patched === original) {
    console.log(`\n${c.name}\n  ABORT — the anchor did not match. The control would have run on`
      + ` unmodified source and printed a false green.\n  anchor: ${JSON.stringify(c.from)}`);
    bad++;
    continue;
  }
  let out = "";
  try {
    writeFileSync(c.file, patched);
    const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", ...c.suite],
      { encoding: "utf8", timeout: 300_000 });
    out = (r.stdout ?? "") + (r.stderr ?? "");
  } finally {
    writeFileSync(c.file, original);
  }

  const reported = /^(ok|FAIL)/m.test(out);
  const finished = /all rep re-baseline checks passed|all rep-page checks passed|FAILED \(\d+\)/.test(out);
  const failedLines = out.split(/\r?\n/).filter((l) => l.startsWith("FAIL"));
  const hit = c.reddens.every((a) => failedLines.some((l) => l.includes(a)));
  const vouched = c.staysGreen.every((a) => !failedLines.some((l) => l.includes(a)));

  const ok = reported && finished && failedLines.length > 0 && hit && vouched;
  if (!ok) bad++;
  console.log(`\n${c.name}\n  ${ok ? "PASS" : "BROKEN"} — `
    + `reported=${reported} finished=${finished} failures=${failedLines.length} `
    + `reddened-the-right-one=${hit} positive-guard-survived=${vouched}`);
  for (const l of failedLines) console.log("    " + l);
}

console.log(bad ? `\nCONTROLS BROKEN (${bad})` : `\nall ${CONTROLS.length} controls behaved`);
process.exit(bad ? 1 : 0);
