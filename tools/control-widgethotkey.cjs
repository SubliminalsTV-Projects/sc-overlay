/**
 * NEGATIVE CONTROLS FOR THE PER-WIDGET HOTKEY ROW.
 *
 *   npm run test:widgets:sandbox -- --port 8784 --serve      (in another shell)
 *   node tools/control-widgethotkey.cjs 8784
 *
 * 🔴 THIS CONTROL EXISTS BECAUSE THE FIRST ATTEMPT AT THIS FEATURE WAS REVERTED FOR BEING A DEAD
 * BUTTON. Half of what follows re-injects the shapes that make it dead again — a row on only one
 * of the two surfaces, a keydown listener bound to the wrong document — and each must go RED on
 * an assertion IN ITS OWN BLOCK. A control that reddens something else is a bug in the test.
 *
 * 🔑 Graded on the OUTPUT TEXT and on WHICH line went red: the widget harness exits 0 on failures,
 * and a control that takes the whole suite down looks identical to one that worked.
 *
 * 🔑 `overlay/canvas.js` is restored from a copy held IN MEMORY, never from git — this file is the
 * one being protected, and a control runner that dies mid-restore is how this repo lost a source
 * file once already.
 */
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");

const PORT = process.argv[2] || "8784";
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "overlay", "canvas.js");
const HARNESS = join(ROOT, "tools", "widget-dom-test.cjs");
const PROBE = join(ROOT, "tools", "__probe-widgethotkey.cjs");
const ELECTRON = join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ONLY = "per-widget hotkey row";

// ⚠️ SINGLE-LINE ANCHORS ONLY — this repo is CRLF, so a multi-line anchor written with a newline
// escape silently matches nothing and the run measures unmodified source.
const CASES = [
  {
    id: "H1",
    why: "the row goes in the SHELL POPOVER ONLY - the shape that was reverted as a dead button",
    anchor: "    injectHotkeyRow(w);",
    repl: "    void 0;",
    expect: "a widget whose PAGE owns its settings gets the row injected there",
  },
  {
    id: "H2",
    why: "bind the keydown to the CANVAS instead of the button's own document",
    anchor: '    win.addEventListener("keydown", onKey, true);',
    repl: '    window.addEventListener("keydown", onKey, true);',
    expect: "a bare F13 is allowed, and it lands from INSIDE the widget's own document",
  },
  {
    id: "H3",
    why: "hiding a widget mid-capture no longer releases the canvas-wide keyboard grab",
    anchor: "    if (!vis && hkCapture && hkCapture.w === w) endHotkeyCapture();",
    repl: "    void vis;",
    expect: "hiding the widget mid-capture releases the grab",
  },
  {
    id: "H4",
    why: "post the WHOLE map, which would let one widget's cog delete every other binding",
    anchor: "        body: JSON.stringify({ widgetHotkeys: { [w.key]: accel } }),",
    repl: "        body: JSON.stringify({ widgetHotkeys: Object.assign({}, widgetAccels) }),",
    expect: "posting ONLY its own key, since the map is merged per key server-side",
  },
  {
    id: "H5",
    why: "ignore the shell's refusal and show a chord that was never registered",
    anchor: "      if (res && res.ok === false) {",
    repl: "      if (false) {",
    expect: "a chord another app owns says so instead of pretending",
  },
  {
    id: "H6",
    why: "never take the keyboard grab, so the keypress goes to the game instead",
    // Unique at this indent: the other call site is inside a one-line arrow with six spaces.
    anchor: "\n    window.overlayApi?.notepadEditing?.(true);",
    repl: "\n    void 0;",
    expect: "...and takes the canvas keyboard grab, or the keypress never arrives",
  },
  {
    id: "H7",
    why: "offer the row for every widget, including ones the shell has no toggle for",
    anchor: '    for (const r of hotkeyControls(w, ".wcfg-hkrow")) r.hidden = !can;',
    repl: '    for (const r of hotkeyControls(w, ".wcfg-hkrow")) r.hidden = false;',
    expect: "a widget the shell reports no hotkey for keeps its row hidden",
  },
];

const original = readFileSync(SRC, "utf8");
const harness = readFileSync(HARNESS, "utf8");
if (harness.indexOf("async function run(label, script, preload, query, page) {") < 0) {
  console.error("PATCH DID NOT APPLY: label guard anchor"); process.exit(1);
}
writeFileSync(PROBE, harness.replace(
  "async function run(label, script, preload, query, page) {",
  `async function run(label, script, preload, query, page) {\n  if (label.indexOf(${JSON.stringify(ONLY)}) !== 0) return 0;`));
const chk = spawnSync(process.execPath, ["--check", PROBE], { encoding: "utf8" });
if (chk.status !== 0) { console.error("PROBE DOES NOT PARSE:\n" + chk.stderr); process.exit(1); }

const runProbe = () => {
  const r = spawnSync(ELECTRON, [PROBE], {
    cwd: ROOT, encoding: "utf8", timeout: 240000, killSignal: "SIGKILL",
    env: { ...process.env, OVERLAY_PORT: PORT },
  });
  return String(r.stdout || "") + String(r.stderr || "");
};

let bad = 0;
try {
  // 🔑 THE UNMUTATED SOURCE RUNS FIRST. If the suite is not green here, every red below proves
  // nothing — it would only show that the probe or the sidecar is broken.
  const base = runProbe();
  if (!base.includes("  ok   ") || base.includes("  FAIL ")) {
    console.error("BASELINE IS NOT GREEN — is the --serve sidecar up on :" + PORT + "?");
    console.error(base.split("\n").filter((l) => l.includes("FAIL") || l.includes("Error")).slice(0, 8).join("\n"));
    process.exit(1);
  }
  console.log("baseline (unmutated): GREEN\n");

  for (const c of CASES) {
    const patched = original.split(c.anchor).join(c.repl);
    // 🔴 A no-op patch runs the suite on unmodified source and prints "all passed", which reads as
    // "the control proves nothing is broken" — the exact conclusion a control exists to rule out.
    if (patched === original) { console.error(`${c.id} PATCH DID NOT APPLY — anchor not found.`); bad++; continue; }
    writeFileSync(SRC, patched);
    const out = runProbe();
    // A control that produced no assertions is a BROKEN control, never a passing one.
    const reported = out.includes("  ok   ") || out.includes("  FAIL ");
    const line = out.split("\n").find((l) => l.includes(c.expect));
    const red = !!line && line.trim().indexOf("FAIL ") === 0;
    const others = out.split("\n").filter((l) => l.trim().indexOf("FAIL ") === 0 && !l.includes(c.expect));
    const pass = reported && red;
    if (!pass) bad++;
    console.log(`${c.id} ${pass ? "ok" : "**FAILED**"}  want RED on its own assertion, got ${red ? "RED" : "GREEN"}${reported ? "" : "  (SUITE NEVER REPORTED)"}`);
    console.log(`     control: ${c.why}`);
    if (line) console.log(`     ${line.trim().slice(0, 170)}`);
    // Collateral is worth SEEING but is not a failure: several of these break one mechanism that
    // a couple of assertions in the same block depend on.
    if (others.length) console.log(`     (also red: ${others.map((l) => l.trim().slice(5, 60)).join(" / ")})`);
  }
} finally {
  writeFileSync(SRC, original);
  try { unlinkSync(PROBE); } catch { /* already gone */ }
}
console.log(`\n${bad ? `${bad} CONTROL(S) FAILED` : `all ${CASES.length} controls behaved as specified`}`);
process.exit(bad ? 1 : 0);
