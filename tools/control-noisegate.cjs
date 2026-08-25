/**
 * NEGATIVE CONTROLS FOR THE `console/network clean` THIRD-PARTY RULE.
 *
 *   npm run test:widgets:sandbox -- --port 8781 --serve      (in another shell)
 *   node tools/control-noisegate.cjs 8781
 *
 * The rule under test lives in `run()` in tools/widget-dom-test.cjs: a console error or a >=400
 * response is noise ONLY when its subject is a host this repo serves. The danger of a filter like
 * that is not that it fails to work — it is that it works too well and quietly retires the whole
 * assertion, which is the most expensive outcome available here. So this is TWO-SIDED:
 *
 *   C1  a local console error          must still go RED   (the assertion can still fail)
 *   C2  a local 404 that is not one of  must still go RED   (…on the network side too)
 *       the deliberate ones
 *   C3  a foreign CORS failure          must go GREEN       (the fix works)
 *   C4  C3 with the host rule removed   must go RED         (…and the fix is what did it)
 *
 * C4 is what stops C3 being free. Without it, "green" is equally consistent with the stimulus
 * never having reached the page at all.
 *
 * 🔑 It builds a PROBE COPY of the harness and never edits the harness itself — a control runner
 * that mutates the file it is protecting is one crash away from destroying it, which this repo has
 * already paid for once. The probe only splices in a label guard (so one suite runs, ~40s instead
 * of ~7min) and a stimulus injection. The noise-classification logic under test is untouched,
 * except in C4 where removing it IS the control.
 *
 * 🔑 Graded on the OUTPUT TEXT, never the exit code: the widget harness exits 0 on failures.
 */
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");

const PORT = process.argv[2] || "8781";
const ROOT = join(__dirname, "..");
const HARNESS = join(ROOT, "tools", "widget-dom-test.cjs");
const PROBE = join(ROOT, "tools", "__probe-noisegate.cjs");
const ELECTRON = join(ROOT, "node_modules", "electron", "dist", "electron.exe");

// Short suite, loads the canvas, plenty of time for the stimulus to land.
const ONLY = "page headers";

function patch(src, find, repl, what) {
  const out = src.replace(find, repl);
  // 🔴 A no-op patch reports as a false green: the suite then runs on unmodified source and prints
  // "all passed", which reads as "the control proves nothing is broken" — the exact conclusion a
  // working control exists to rule out.
  if (out === src) { console.error(`PATCH DID NOT APPLY: ${what}`); process.exit(1); }
  return out;
}

function buildProbe({ stimulus, gutHostRule }) {
  let s = readFileSync(HARNESS, "utf8");
  s = patch(s,
    "async function run(label, script, preload, query, page) {",
    `async function run(label, script, preload, query, page) {\n  if (label.indexOf(${JSON.stringify(ONLY)}) !== 0) return 0;`,
    "label guard");
  s = patch(s,
    "    const base = page ? `http://localhost:${PORT}/${page}` : URL;",
    "    const base = page ? `http://localhost:${PORT}/${page}` : URL;\n" +
    "    const __stim = process.env.PROBE_STIMULUS;",
    "stimulus hook decl");
  // ⚠️ SINGLE-LINE ANCHORS ONLY. This repo is CRLF throughout, so a multi-line anchor written with
  // "\n" silently matches nothing — which is exactly what the no-op guard above caught first try.
  s = patch(s,
    "    let res;",
    "    if (__stim) { try { await win.webContents.executeJavaScript(__stim); } catch (e) { console.log('  stimulus threw: ' + e.message); }\n" +
    "      await new Promise((r) => setTimeout(r, 4000)); }\n" +
    "    let res;",
    "stimulus injection");
  if (gutHostRule) {
    // C4: put the harness back the way it was — no host rule on the console side.
    s = patch(s,
      "    if (NET_FAILURE.test(String(msg)) && aboutForeignHost(msg, src)) return;",
      "    /* C4: host rule removed */",
      "gut the console host rule");
  }
  writeFileSync(PROBE, s);
  const chk = spawnSync(process.execPath, ["--check", PROBE], { encoding: "utf8" });
  if (chk.status !== 0) { console.error("PROBE DOES NOT PARSE:\n" + chk.stderr); process.exit(1); }
  return stimulus;
}

function runProbe(stimulus) {
  const r = spawnSync(ELECTRON, [PROBE], {
    cwd: ROOT, encoding: "utf8", timeout: 240000, killSignal: "SIGKILL",
    env: { ...process.env, OVERLAY_PORT: PORT, PROBE_STIMULUS: stimulus || "" },
  });
  return String(r.stdout || "") + String(r.stderr || "");
}

const CASES = [
  { id: "C1", want: "RED",
    what: "a LOCAL console error still reddens the run",
    gut: false,
    stimulus: `console.error("PROBE local widget failure: TypeError: thing is not a function")` },
  { id: "C2", want: "RED",
    what: "a LOCAL 404 that is not a deliberate one still reddens the run",
    gut: false,
    stimulus: `fetch("/api/__probe_no_such_route__").catch(function () {})` },
  { id: "C3", want: "GREEN",
    what: "a FOREIGN CORS failure does NOT redden the run",
    gut: false,
    // google.com answers 200 and sends no Access-Control-Allow-Origin, so a cross-origin fetch
    // produces the identical console message FFZ produced during its outage.
    stimulus: `fetch("https://www.google.com/").catch(function () {})` },
  { id: "C4", want: "RED",
    what: "…and with the host rule removed, that same failure DOES redden it",
    gut: true,
    stimulus: `fetch("https://www.google.com/").catch(function () {})` },
];

let bad = 0;
for (const c of CASES) {
  buildProbe({ stimulus: c.stimulus, gutHostRule: c.gut });
  const out = runProbe(c.stimulus);
  // 🔴 A control that produced no assertions at all is a BROKEN control, never a passing one.
  const reported = out.includes("  ok   ") || out.includes("  FAIL ");
  const red = out.includes("FAIL console/network clean");
  const got = red ? "RED" : "GREEN";
  const pass = reported && got === c.want;
  if (!pass) bad++;
  console.log(`\n${c.id} ${pass ? "PASS" : "**FAIL**"}  want ${c.want}, got ${got}${reported ? "" : "  (SUITE NEVER REPORTED)"}`);
  console.log(`     ${c.what}`);
  const line = out.split("\n").find((l) => l.includes("console/network clean"));
  if (line) console.log(`     ${line.trim().slice(0, 190)}`);
  if (!reported) console.log(out.split("\n").slice(-14).join("\n"));
}
try { unlinkSync(PROBE); } catch { /* already gone */ }
console.log(`\n${bad ? `${bad} CONTROL(S) FAILED` : "all 4 controls behaved as specified"}`);
process.exit(bad ? 1 : 0);
