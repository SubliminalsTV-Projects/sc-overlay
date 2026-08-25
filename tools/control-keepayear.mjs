/**
 * keepayear — THE NEGATIVE CONTROLS, RUN AS A SCRIPT SO THEY CANNOT ROT.
 *
 * 🔴 AN ASSERTION YOU HAVE NEVER SEEN FAIL IS NOT EVIDENCE. Six of the claims this flight rests on
 * are of the shape this repo has repeatedly shipped as tautologies — "X is set aside", "no live
 * upload happened", "the bump was recorded". Each is injected with the exact behaviour it exists
 * to forbid, and each must go RED on an assertion IN ITS OWN BLOCK.
 *
 * 🔑 IT MUTATES A COPY, NEVER `src/log-share.ts`. A control loop whose restore step writes the
 * protected file back is how a blue screen left 19 KB of NUL bytes in `origin-signals.ts`. Nothing
 * here can damage a tracked file: the copies are created, mutated, run and deleted.
 *
 * ⚠️ THIS REPO IS CRLF, so every anchor is a SINGLE LINE matched without any newline escape. A
 * multi-line anchor matches nothing, the copy runs UNMUTATED, and the suite then reports a green
 * that reads as "the control proves nothing is broken" — the exact conclusion a working control
 * exists to rule out. Hence the no-op abort on every patch.
 *
 *   node tools/control-keepayear.mjs
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SRC = "src/log-share.ts";
const SUITE = "src/log-share.test.ts";
const CTL_SRC = "src/__ctl-log-share.ts";
const CTL_SUITE = "src/__ctl-log-share.test.ts";

/** `shell: false` on purpose — this repo lives under a path with a space in it, and `shell: true`
 *  concatenates argv unescaped and splits at that space (`Cannot find module 'E:.'`). */
const runSuite = () =>
  spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", CTL_SUITE],
    { encoding: "utf8", timeout: 300_000, killSignal: "SIGKILL" });

/** Rebuild both copies from the real files, with the suite pointed at the copied module. */
function seed() {
  writeFileSync(CTL_SRC, readFileSync(SRC, "utf8"));
  const suite = readFileSync(SUITE, "utf8").split("./log-share.js").join("./__ctl-log-share.js");
  if (suite === readFileSync(SUITE, "utf8")) throw new Error("could not repoint the suite's import — it would test the REAL module");
  writeFileSync(CTL_SUITE, suite);
}

const CONTROLS = [
  {
    id: "C1",
    what: "no retention window at all — nothing is ever out of window",
    anchor: "    if (sessionStartOf(head, b.n, b.m) < cutoff) { state.skippedPatch.add(b.n); rejected++; continue; }",
    mutant: "    if (false && sessionStartOf(head, b.n, b.m) < cutoff) { state.skippedPatch.add(b.n); rejected++; continue; }",
    expect: "a session older than the retention window belongs in skippedPatch",
  },
  {
    id: "C2",
    what: "date the session by MTIME instead of its own header stamp",
    anchor: "export function sessionStartOf(head: string, name: string, mtimeMs: number): number {",
    mutant: "export function sessionStartOf(head: string, name: string, mtimeMs: number): number { return mtimeMs;",
    expect: "the log's own line-1 UTC stamp is the session start",
  },
  {
    id: "C3",
    what: "never notice the rules change — leave RULES_VERSION at 2",
    anchor: "const RULES_VERSION = 3;",
    mutant: "const RULES_VERSION = 2;",
    expect: "the rules bump must be recorded",
  },
  {
    id: "C4",
    what: "bump, but do not re-offer what the old rule set aside",
    anchor: "    state.skippedPatch.clear();",
    mutant: "    void 0;",
    expect: "a rules change must re-offer what the old rules set aside",
  },
  {
    id: "C5",
    what: "let the reset drain eat the WHOLE rejection budget, starving the uploads",
    anchor: "  let rejected = drainRecheck(state, dir, Math.min(RECHECK_PER_TICK, REJECTS_PER_TICK), priorRules);",
    mutant: "  let rejected = drainRecheck(state, dir, REJECTS_PER_TICK, priorRules);",
    expect: "a tick that is draining a rules reset must STILL upload",
  },
  {
    id: "C6",
    what: "put the live Game.log upload back",
    anchor: "    const state = loadState(statePath);",
    mutant: "    const state = loadState(statePath); { const r = readFileSync(cfg.logPath, \"utf8\"); await upload(tail(scrubGameLog(r).text, MAX_BYTES), cfg.syncToken, appVersion, \"the live Game.log\", \"live\"); }",
    expect: "only rotated sessions may be uploaded",
  },
  {
    id: "C7",
    what: "freeze the reset's discriminator to ONE rule instead of the version's",
    anchor: "  const signal = rules >= 2 ? RULES_2_SIGNAL : RULES_1_SIGNAL;",
    mutant: "  const signal = RULES_1_SIGNAL;",
    expect: "v2 UPLOADED that same session",
  },
];

let failures = 0;
try {
  // 🔑 THE UNMUTATED COPY RUNS FIRST. If it is not green, every red below is evidence of nothing —
  // it would merely show that the copy is broken, which is not what is being claimed.
  seed();
  const base = runSuite();
  const baseOut = (base.stdout ?? "") + (base.stderr ?? "");
  if (!baseOut.includes("ALL PASS")) {
    console.error("BASELINE IS NOT GREEN — refusing to run the controls, a red below would prove nothing.");
    console.error(baseOut.slice(-1500));
    process.exit(1);
  }
  console.log("baseline (unmutated copy): GREEN\n");

  for (const c of CONTROLS) {
    seed();
    const before = readFileSync(CTL_SRC, "utf8");
    const after = before.split(c.anchor).join(c.mutant);
    // 🔴 A NO-OP PATCH REPORTS AS A FALSE GREEN, which is worse than "anchor not found".
    if (after === before) {
      console.error(`${c.id} PATCH DID NOT APPLY — anchor not found. Aborting rather than measuring nothing.`);
      console.error(`      anchor: ${c.anchor}`);
      failures++;
      continue;
    }
    writeFileSync(CTL_SRC, after);

    const r = runSuite();
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    // 🔑 A CONTROL THAT PRODUCED NO ASSERTIONS IS A BROKEN CONTROL, NEVER A PASSING ONE. Grade on
    // the TEXT, and require the suite to have actually reported something either way.
    const reported = out.includes("ALL PASS") || out.includes("AssertionError");
    const red = out.includes("AssertionError") && !out.includes("ALL PASS");
    const named = out.includes(c.expect);

    if (!reported) {
      console.error(`${c.id} FAILED: the suite reported nothing at all (crash? timeout?) — not evidence.`);
      console.error(out.slice(-800));
      failures++;
    } else if (!red) {
      console.error(`${c.id} FAILED: still GREEN with "${c.what}" injected. The assertion is a tautology.`);
      failures++;
    } else if (!named) {
      console.error(`${c.id} FAILED: went red, but NOT on its own assertion — read which one, it is a test bug.`);
      console.error(`      expected to see: ${c.expect}`);
      console.error(out.split("AssertionError").slice(1).join("AssertionError").slice(0, 400));
      failures++;
    } else {
      console.log(`${c.id} ok — red on: ${c.expect}`);
      console.log(`      injected: ${c.what}`);
    }
  }
} finally {
  rmSync(CTL_SRC, { force: true });
  rmSync(CTL_SUITE, { force: true });
}

console.log(failures ? `\n${failures} control(s) FAILED` : `\nall ${CONTROLS.length} controls behaved`);
process.exit(failures ? 1 : 0);
