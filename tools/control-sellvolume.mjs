/**
 * sellvolume — THE NEGATIVE CONTROL, RUN AS A SCRIPT SO IT CANNOT ROT.
 *
 * Puts the FABRICATED-VOLUME behaviour back into `src/trade-log.ts` (a sell with no cargo-box
 * manifest gets its volume from `quantity` again, exactly as the shipped code did), runs
 * `test:trade`, and requires it to go RED naming a specific commodity. Then restores the file from
 * HEAD and requires it to go GREEN again.
 *
 * 🔴 AN ASSERTION YOU HAVE NEVER SEEN FAIL IS NOT EVIDENCE. Every "the volume is unknown" check in
 * the suite is a claim about a value NOT being a number, and this repo has shipped several of those
 * that could never fail.
 *
 * ⚠️ THE REPO IS CRLF, so the anchor is a SINGLE LINE and is matched without any `\n`. A multi-line
 * anchor written with `\n` matches nothing here, leaves the file unchanged, and the suite then
 * reports a false green on unmodified source — which reads as "the control proves nothing is
 * broken", the exact conclusion a working control exists to rule out. Hence the no-op check below,
 * which aborts before the suite is ever run.
 *
 * ⚠️ RESTORE IS `git checkout HEAD -- <path>`, so run this only with your work committed. Writing
 * a saved copy back over the file is how a blue screen left 19 KB of NUL bytes in `origin-signals.ts`.
 *
 *   node tools/control-sellvolume.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "src/trade-log.ts";
const ANCHOR = "    const volume: Volume = kind === \"sell\" && !hasManifest";
const MUTANT = "    const volume: Volume = false && kind === \"sell\" && !hasManifest";

/** The suite's own runner. `shell: false` on purpose — this repo lives under a path with a space
 *  in it, and `shell: true` concatenates argv unescaped and splits at that space. */
const runSuite = () => spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/trade.test.ts"],
  { encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL" });

const restore = () => {
  const r = spawnSync("git", ["checkout", "HEAD", "--", FILE], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("could not restore " + FILE + ": " + (r.stderr || ""));
};

const src = readFileSync(FILE, "utf8");
if (!src.includes(ANCHOR)) {
  console.error(`ANCHOR NOT FOUND in ${FILE} — the control would have measured nothing.`);
  console.error(`  looked for: ${ANCHOR}`);
  process.exit(1);
}
const mutated = src.split(ANCHOR).join(MUTANT);
if (mutated === src) { console.error("PATCH DID NOT APPLY (no-op)"); process.exit(1); }
writeFileSync(FILE, mutated, "utf8");

// One line, and it is what distinguishes "the control is in place" from "I am about to measure
// nothing." Read it in the output rather than trusting that the write happened.
const diff = spawnSync("git", ["diff", "--stat", "--", FILE], { encoding: "utf8" });
console.log("control in place:\n" + diff.stdout.trim());
if (!diff.stdout.includes(FILE)) { restore(); console.error("git diff shows no change"); process.exit(1); }

let red, green;
try {
  red = runSuite();
} finally {
  restore();
}

const fails = (red.stdout ?? "").split("\n").filter((l) => l.startsWith("FAIL"));
console.log(`\n── WITH THE FABRICATED VOLUME BACK: ${fails.length} failing assertions ──`);
for (const l of fails.slice(0, 14)) console.log("  " + l);

green = runSuite();
const greenFails = (green.stdout ?? "").split("\n").filter((l) => l.startsWith("FAIL"));
console.log(`\n── RESTORED: ${greenFails.length} failing assertions ──`);
for (const l of greenFails.slice(0, 6)) console.log("  " + l);

// 🔑 A CONTROL IS A TWO-SIDED TEST. The fix assertions must go red, AND the file must come back
// green — a control that leaves the tree broken has told you nothing about the tree.
// 🔴 And it must fail NAMING A COMMODITY: a bare count would be satisfied by a suite that threw.
const named = fails.some((l) => l.includes("Beradom")) && fails.some((l) => l.includes("Glacosite"));
const ok = fails.length > 0 && named && greenFails.length === 0;
console.log(`\n${ok ? "CONTROL PASSES" : "CONTROL FAILED"}  — red ${fails.length} (named a commodity: ${named}), restored ${greenFails.length}`);
process.exit(ok ? 0 : 1);
