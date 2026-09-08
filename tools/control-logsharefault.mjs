/**
 * logsharefault — THE NEGATIVE CONTROLS, RUN AS A SCRIPT SO THEY CANNOT ROT.
 *
 * 🔴 AN ASSERTION YOU HAVE NEVER SEEN FAIL IS NOT EVIDENCE. The claims this change rests on are
 * all of shapes this repo has shipped as tautologies before — "it is set aside", "the fault is on
 * the record", "the queue kept moving". Each is injected with the exact behaviour it exists to
 * forbid, and each must go RED **on an assertion in its own block**, which is why every control
 * names the sentence it expects rather than counting failures.
 *
 * 🔑 IT MUTATES A COPY, NEVER `src/log-share.ts`. A control loop whose restore step writes the
 * protected file back is how a blue screen once left 19 KB of NUL bytes in `origin-signals.ts`.
 *
 * ⚠️ THIS REPO IS CRLF, so every anchor is a SINGLE LINE matched without any newline escape. A
 * multi-line anchor matches nothing, the copy runs UNMUTATED, and the suite then reports a green
 * that reads as "the control proves nothing is broken" — the exact conclusion a working control
 * exists to rule out. Hence the no-op abort on every patch.
 *
 *   node tools/control-logsharefault.mjs
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SRC = "src/log-share.ts";
const SUITE = "src/log-share.test.ts";
const CTL_SRC = "src/__ctl-logsharefault.ts";
const CTL_SUITE = "src/__ctl-logsharefault.test.ts";

/** `shell: false` on purpose — this repo lives under a path with a space in it, and `shell: true`
 *  concatenates argv unescaped and splits at that space (`Cannot find module 'E:.'`). */
const runSuite = () =>
  spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", CTL_SUITE],
    { encoding: "utf8", timeout: 300_000, killSignal: "SIGKILL" });

function seed() {
  writeFileSync(CTL_SRC, readFileSync(SRC, "utf8"));
  const real = readFileSync(SUITE, "utf8");
  const suite = real.split("./log-share.js").join("./__ctl-logsharefault.js");
  if (suite === real) throw new Error("could not repoint the suite's import — it would test the REAL module");
  writeFileSync(CTL_SUITE, suite);
}

const CONTROLS = [
  {
    id: "C1",
    what: "no body-level refusal — every failure is 'the site is unhappy', which is the shipped behaviour",
    anchor: '  return status >= 400 ? "refused" : "retry";',
    mutant: '  return "retry";',
    expect: "a body the site REFUSED must be set aside recoverably",
  },
  {
    id: "C2",
    what: "classify the refusal correctly but `break` on it anyway — the wedge, exactly as it shipped",
    anchor: '    if (verdict === "refused") { state.skippedPatch.add(b.n); rejected++; continue; }',
    mutant: '    if (verdict === "refused") { state.skippedPatch.add(b.n); rejected++; break; }',
    expect: "THE WEDGE: a file the site will never accept must not stop the ones it would",
  },
  {
    id: "C3",
    what: "treat EVERY failure as a body-level refusal — a 503 sets the player's backlog aside",
    anchor: '  if (status === 429 || status >= 500) return "retry";  // rate-limited or the site is down',
    mutant: '  if (false) return "retry";',
    expect: "nor set aside: a 503 says nothing about this file",
  },
  {
    id: "C4",
    what: "log the failure but remember nothing — the console-only reporting this replaced",
    anchor: "  lastFault = { at: new Date().toISOString(), what, status, detail };",
    mutant: "  void what; void status; void detail;",
    expect: "a failing upload must leave a fault the diagnostics report can state",
  },
  {
    id: "C5",
    what: "never clear the fault, so a recovered app reports itself broken forever",
    anchor: "function clearFault(note: string): void {",
    mutant: "function clearFault(note: string): void { void note; return;",
    expect: "a successful upload must CLEAR the fault",
  },
  {
    id: "C6",
    what: "let a network error propagate again, unwinding past saveState() and losing the tick",
    anchor: "    noteFault(`could not reach ${SITE} to send ${label}`, null, String(err));",
    mutant: "    throw err;",
    expect: "a verdict reached BEFORE the network died must still be saved",
  },
];

let failures = 0;
try {
  // 🔑 THE UNMUTATED COPY RUNS FIRST. If it is not green, every red below is evidence of nothing.
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
      console.error(out.split("AssertionError").slice(1).join("AssertionError").slice(0, 500));
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
