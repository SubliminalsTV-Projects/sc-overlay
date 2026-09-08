#!/usr/bin/env node
/**
 * Negative controls for the two Commodities/Ledger suites added on 2026-09-08 (flight `ledger`):
 * `hauling: the Ledger renders the journal audit` and `hauling: the two filters nothing used to
 * send`.
 *
 * WHY THIS FILE EXISTS. Both suites are mostly must-not assertions — the drift block offers NO
 * repair control, no request carries `knownStock`, an unset filter sends NO parameter — and this
 * repo has a long list of must-nots that turned out to be free. Each one below is paired with a
 * positive in the suite itself; this runner is what proves the pairing is real, by making the
 * must-not fail on demand while the positive beside it stays green.
 *
 *   C1  put a repair button back in the drift block  -> the no-control assertion reddens
 *   C2  draw the drift block after the empty return  -> the ordering assertion reddens
 *   C3  the vacuous verdict borrows the clean words  -> the zero-keys assertion reddens
 *   C4  swallow the keys nobody judged               -> both caveat assertions redden
 *   C5  stop sending maxAgeDays                      -> the send assertion reddens, absence stays green
 *   C6  stop sending budget                          -> the send assertion reddens
 *   C7  send maxAgeDays=0 when unset                 -> the "absent, not a sentinel" assertion reddens
 *   C8  re-wire knownStock                           -> the deliberately-unsent assertion reddens
 *   C9  light the age pill from the click, not the answer -> the echo assertion reddens
 *
 * 🔑 C5 AND C7 ARE THE PAIR WORTH LOOKING AT. C5 removes the parameter entirely and the assertion
 * "sends no maxAgeDays when unset" stays perfectly green — which is the whole argument for why an
 * absence assertion needs a positive beside it rather than standing on its own.
 *
 * 🔴 EVERY RULE IN THE RUNNER BELOW WAS LEARNED THE EXPENSIVE WAY IN THIS REPO (see
 * `tools/control-ageband.mjs`, whose shape this copies), so none of them is optional: grade on the
 * output TEXT and never the exit code; abort loudly on a NO-OP patch; require the suite to have
 * produced assertions AND reached its own terminator, because a run that crashed part-way is
 * indistinguishable from one that passed; check WHICH assertion went red, since a control that
 * reddens a positive-first guard is a bug in the test rather than evidence for it; and restore from
 * a copy held IN MEMORY, never from git, because these are the files being protected.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAB = path.join(ROOT, "overlay", "hauling-tab-trade.js");
const PORT = process.env.CONTROL_PORT || "8793";

// ── the assertions, by a substring unique across the whole run ───────────────
const A_BLOCK = "drift draws a block at all";
const A_DEDUPED = "it says DEDUPED, not refused, in those words";
const A_NOCTRL = "it offers NO control that could perform a repair";
const A_ORDER = "and the drift block is drawn ABOVE the empty state";
const A_BOUNDED = "keys the bound could have trimmed are stated rather than ignored";
const A_UNREAD = "a key this check cannot read is still mentioned";
const A_CLEAN = "a clean journal states that it was checked";
const A_VACUOUS = "but an audit that judged NOTHING does not report itself as checked";

const F_SLOT = "the funnel carries a spend slot";
const F_AGESENT = "carrying maxAgeDays, which no UI had ever sent";
const F_AGEABSENT = "and sends no maxAgeDays at all rather than a value meaning none";
const F_BUDGETSENT = "committing a figure sends budget, which no UI had ever sent";
const F_BUDGETABSENT = "and sends no budget";
const F_ASKED = "the widget really did ask for routes while this suite ran";
const F_KNOWNSTOCK = "and knownStock is on none of them";
const F_ECHO = "a board that came back filtered at 30d lights the 30d pill";

const patch = (file, find, replace) => ({ file, find, replace });

const NOTICE_CALL = "    if (j.audit && !j.audit.ok) tdAuditNotice(body, j.audit);";

const CONTROLS = [
  {
    name: "C1  a repair button, back in the drift block",
    why: "the whole constraint on this surface: there is no safe partial repair to offer",
    edits: [patch(TAB,
      "    for (const c of tdAuditCaveats(a)) {",
      "    const bad = document.createElement(\"button\");"
      + " bad.type = \"button\"; bad.textContent = \"Tidy the entries\"; box.appendChild(bad);\n"
      + "    for (const c of tdAuditCaveats(a)) {")],
    mustRedden: [A_NOCTRL],
    mustStayGreen: [A_BLOCK, A_DEDUPED, A_ORDER],
  },
  {
    name: "C2  the drift block drawn after the empty return",
    why: "the shipped-shape defect: a journal drifted enough to lose every row explains nothing",
    edits: [
      patch(TAB, NOTICE_CALL + "\r\n", ""),
      patch(TAB, "    if (runs.length) {", NOTICE_CALL + "\r\n\r\n    if (runs.length) {"),
    ],
    // The block is not drawn at all in the empty fixture, so everything about it reddens with the
    // ordering. The clean-journal half of the suite is untouched and must not move.
    mustRedden: [A_ORDER, A_BLOCK],
    mustStayGreen: [A_CLEAN, A_VACUOUS],
  },
  {
    name: "C3  the vacuous verdict borrows the clean wording",
    why: "a green audit over zero judged keys certifies nothing, and must not say it was checked",
    edits: [patch(TAB, "    if (a.keysAudited > 0) {", "    if (a.keysAudited >= 0) {")],
    mustRedden: [A_VACUOUS],
    mustStayGreen: [A_CLEAN, A_BLOCK, A_NOCTRL],
  },
  {
    name: "C4  the keys nobody judged are swallowed",
    why: "an unjudged journal must never read as a clean one",
    edits: [patch(TAB, "  function tdAuditCaveats(a) {\r\n    const out = [];",
                       "  function tdAuditCaveats(a) {\r\n    const out = [];\r\n    if (a) return out;")],
    mustRedden: [A_BOUNDED, A_UNREAD],
    mustStayGreen: [A_BLOCK, A_NOCTRL, A_CLEAN],
  },
  {
    name: "C5  maxAgeDays is not sent",
    why: "the row this flight closed. 🔑 Watch the ABSENCE assertion stay green while it does",
    edits: [patch(TAB, "    if (tdMaxAge) p.set(\"maxAgeDays\", String(tdMaxAge));", "")],
    mustRedden: [F_AGESENT],
    mustStayGreen: [F_AGEABSENT, F_ASKED, F_BUDGETSENT],
  },
  {
    name: "C6  budget is not sent",
    why: "the other half of the same row",
    edits: [patch(TAB, "    if (tdBudget) p.set(\"budget\", String(tdBudget));", "")],
    mustRedden: [F_BUDGETSENT],
    mustStayGreen: [F_BUDGETABSENT, F_SLOT, F_AGESENT],
  },
  {
    name: "C7  maxAgeDays=0 sent as a sentinel when unset",
    why: "a query string claiming a constraint that is not there is believed by its next reader",
    edits: [patch(TAB,
      "    if (tdMaxAge) p.set(\"maxAgeDays\", String(tdMaxAge));",
      "    p.set(\"maxAgeDays\", String(tdMaxAge || 0));")],
    mustRedden: [F_AGEABSENT],
    mustStayGreen: [F_AGESENT, F_ASKED],
  },
  {
    name: "C8  knownStock re-wired by a well-meaning hand",
    why: "Sub's decision of 2026-08-25, whose only other guard is a comment",
    edits: [patch(TAB,
      "    if (tdBudget) p.set(\"budget\", String(tdBudget));",
      "    p.set(\"knownStock\", \"1\");\r\n    if (tdBudget) p.set(\"budget\", String(tdBudget));")],
    mustRedden: [F_KNOWNSTOCK],
    mustStayGreen: [F_ASKED, F_AGESENT],
  },
  {
    name: "C9  the age pill lit from the click instead of the answer",
    why: "a control claiming a filter the rows are not under is worse than no control",
    edits: [patch(TAB,
      "    const activeAge = tradeData && \"maxAgeDays\" in tradeData\r\n      ? (tradeData.maxAgeDays || null) : tdMaxAge;",
      "    const activeAge = tdMaxAge;")],
    mustRedden: [F_ECHO],
    mustStayGreen: [F_ASKED, F_AGESENT, F_SLOT],
  },
];

function runSuite() {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, "tools", "test-widgets-sandbox.mjs"),
    "--port", PORT, "--reset", "--only", "hauling",
  ], { cwd: ROOT, encoding: "utf8", timeout: 12 * 60 * 1000, killSignal: "SIGKILL" });
  return (r.stdout || "") + (r.stderr || "");
}

/** Read the verdict for one named assertion out of the run's TEXT, never out of an exit code. */
function verdict(out, name) {
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (t.startsWith("ok   ") && t.indexOf(name) >= 0) return "green";
    if (t.startsWith("FAIL ") && t.indexOf(name) >= 0) return "RED";
  }
  return "absent";
}

const originals = new Map();
for (const f of [TAB]) originals.set(f, readFileSync(f, "utf8"));

const only = process.argv.slice(2).filter((a) => a.indexOf("--") !== 0);
let failures = 0;
let ran = 0;
try {
  for (const c of CONTROLS) {
    if (only.length && !only.some((o) => c.name.indexOf(o) === 0)) continue;
    ran++;
    console.log("\n=== " + c.name + " ===");
    console.log("    " + c.why);

    for (const e of c.edits) {
      const before = readFileSync(e.file, "utf8");
      // CRLF: every source file in this repo is CRLF, so a multi-line anchor written with "\n"
      // silently does not match. Try both before deciding a patch is a no-op.
      const lf = e.find.split("\r\n").join("\n");
      const crlf = e.find.split("\n").join("\r\n");
      const found = before.indexOf(e.find) >= 0 ? e.find
        : (before.indexOf(crlf) >= 0 ? crlf : (before.indexOf(lf) >= 0 ? lf : null));
      const after = found === null ? before
        : before.split(found).join(found === lf ? e.replace.split("\r\n").join("\n") : e.replace);
      if (after === before) {
        console.error("    PATCH DID NOT APPLY -> " + path.basename(e.file));
        console.error("    anchor: " + e.find.trim().slice(0, 90));
        console.error("    ABORTING: a no-op patch makes the run test unmodified source, and its");
        console.error("    green would read as evidence. Fix the anchor before trusting anything.");
        for (const [f, text] of originals) writeFileSync(f, text);
        process.exit(2);
      }
      writeFileSync(e.file, after);
    }

    const out = runSuite();

    // A run that crashed part-way looks exactly like one that passed.
    const produced = out.indexOf("ok   ") >= 0 || out.indexOf("FAIL ") >= 0;
    const finished = out.indexOf("FAILED (") >= 0 || out.indexOf("tests passed") >= 0;
    if (!produced || !finished) {
      console.error("    BROKEN CONTROL: the suite "
        + (produced ? "did not finish" : "produced no assertions") + ".");
      console.error("    That is never a pass. Last lines:\n" + out.split("\n").slice(-12).join("\n"));
      failures++;
    } else {
      let bad = false;
      for (const n of c.mustRedden) {
        const v = verdict(out, n);
        console.log("    must redden : " + (v === "RED" ? "RED   " : "!!! " + v.toUpperCase() + " ") + n);
        if (v !== "RED") bad = true;
      }
      for (const n of c.mustStayGreen) {
        const v = verdict(out, n);
        console.log("    must stay   : " + (v === "green" ? "green " : "!!! " + v.toUpperCase() + " ") + n);
        if (v !== "green") bad = true;
      }
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (t.startsWith("FAIL ") && c.mustRedden.some((n) => t.indexOf(n) >= 0)) console.log("      " + t);
      }
      if (bad) { console.error("    ^^ CONTROL MISBEHAVED"); failures++; }
    }

    for (const [f, text] of originals) writeFileSync(f, text);
  }
} finally {
  for (const [f, text] of originals) writeFileSync(f, text);
}

console.log("\n" + (failures ? failures + " of " + ran + " control(s) misbehaved"
  : "all " + ran + " controls behaved"));
process.exit(failures ? 1 : 0);
