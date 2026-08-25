/**
 * NEGATIVE CONTROL FOR THE LOG VIEW ROW-CAP ASSERTION.
 *
 *   npm run test:widgets:sandbox -- --port 8781 --serve      (in another shell)
 *   node tools/control-logviewcap.cjs 8781
 *
 * `...keeping the NEWEST lines, not the oldest` was rewritten because it raced a running game: it
 * read the LAST row, and the sidecar tails a real game.log that keeps streaming. It now asserts the
 * newest synthetic line survived AND the oldest was evicted.
 *
 * 🔴 THE POINT OF THIS CONTROL IS THAT LOOSENING AN ASSERTION TO STOP IT FLAKING IS EXACTLY HOW
 * ONE GETS RETIRED BY ACCIDENT. Both halves are injected separately, because a single control that
 * broke the cap outright would redden the pair without saying whether either half still works:
 *
 *   K1  cap keeps the OLDEST rows  ->  RED  (newest kept = false)
 *   K2  cap does not evict at all  ->  RED  (oldest evicted = false)
 *
 * K2 is the half that would otherwise be free: an unbounded list still CONTAINS the newest line, so
 * the "newest survived" half alone passes happily while the melt guard is gone.
 *
 * Graded on the OUTPUT TEXT — the widget harness exits 0 on failures.
 */
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");

const PORT = process.argv[2] || "8781";
const ROOT = join(__dirname, "..");
const PAGE = join(ROOT, "overlay", "logview.html");
const HARNESS = join(ROOT, "tools", "widget-dom-test.cjs");
const PROBE = join(ROOT, "tools", "__probe-logviewcap.cjs");
const ELECTRON = join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ONLY = "logView: raw lines";

// ⚠️ SINGLE-LINE ANCHORS ONLY — this repo is CRLF, so a multi-line anchor written with "\n"
// silently matches nothing and the run measures unmodified source.
// 🔴 THE PAGE HAS TWO ROW CAPS AND ONLY ONE OF THEM IS ON THIS PATH. `render()` does a full
// rebuild with `shown.slice(-ROWS)`; `trimRows()` caps the INCREMENTAL append. The suite drives
// `push()`, which goes push -> appendLines -> trimRows and never calls render(), so a control
// injected into render() came back GREEN twice while looking perfectly well aimed. That is the
// FOURTEENTH control lesson in SKILL.md — the control expressed the failure and a second mechanism
// absorbed it — and the question that settles it is "which guard is on the path to the thing I
// MEASURE?", not "which guard implements this rule?".
const ANCHOR = "    while (box.childElementCount > ROWS) box.removeChild(box.firstElementChild);";
const CASES = [
  { id: "K1", why: "the cap keeps the OLDEST rows instead of the newest",
    repl: "    while (box.childElementCount > ROWS) box.removeChild(box.lastElementChild);" },
  { id: "K2", why: "the cap evicts nothing at all (the melt guard is gone)",
    repl: "    while (false) box.removeChild(box.firstElementChild);" },
];

const originalPage = readFileSync(PAGE, "utf8");
let harness = readFileSync(HARNESS, "utf8");
if (harness.indexOf("async function run(label, script, preload, query, page) {") < 0) {
  console.error("PATCH DID NOT APPLY: label guard anchor"); process.exit(1);
}
writeFileSync(PROBE, harness.replace(
  "async function run(label, script, preload, query, page) {",
  `async function run(label, script, preload, query, page) {\n  if (label.indexOf(${JSON.stringify(ONLY)}) !== 0) return 0;`));
const chk = spawnSync(process.execPath, ["--check", PROBE], { encoding: "utf8" });
if (chk.status !== 0) { console.error("PROBE DOES NOT PARSE:\n" + chk.stderr); process.exit(1); }

let bad = 0;
try {
  for (const c of CASES) {
    const patched = originalPage.replace(ANCHOR, c.repl);
    // 🔴 A no-op patch runs the suite on unmodified source and prints "all passed", which reads as
    // "the control proves nothing is broken" — the exact conclusion a control exists to rule out.
    if (patched === originalPage) { console.error(`PATCH DID NOT APPLY: ${c.id}`); process.exit(1); }
    writeFileSync(PAGE, patched);
    const r = spawnSync(ELECTRON, [PROBE], {
      cwd: ROOT, encoding: "utf8", timeout: 240000, killSignal: "SIGKILL",
      env: { ...process.env, OVERLAY_PORT: PORT },
    });
    const out = String(r.stdout || "") + String(r.stderr || "");
    // A control that produced no assertions is a BROKEN control, never a passing one.
    const reported = out.includes("  ok   ") || out.includes("  FAIL ");
    const line = out.split("\n").find((l) => l.includes("keeping the NEWEST lines"));
    const red = !!line && line.indexOf("  FAIL ") === 0;
    const pass = reported && red;
    if (!pass) bad++;
    console.log(`\n${c.id} ${pass ? "PASS" : "**FAIL**"}  want RED, got ${red ? "RED" : "GREEN"}${reported ? "" : "  (SUITE NEVER REPORTED)"}`);
    console.log(`     control: ${c.why}`);
    if (line) console.log(`     ${line.trim().slice(0, 160)}`);
  }
} finally {
  // Restore from the copy held in memory, never from git: this file is the one being protected.
  writeFileSync(PAGE, originalPage);
  try { unlinkSync(PROBE); } catch { /* already gone */ }
}
console.log(`\n${bad ? `${bad} CONTROL(S) FAILED` : "both controls behaved as specified"}`);
process.exit(bad ? 1 : 0);
