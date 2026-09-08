#!/usr/bin/env node
/**
 * Negative controls for the widget-suite flake repairs (flight `flakes`, 2026-09-08).
 *
 * WHY THIS FILE EXISTS. Two roadmap rows, one file, one defect family: assertions that were
 * measuring something OTHER than the widget.
 *
 *   rm_widget-suite-flake  — `falls back to the render when the capture 404s` waited a flat 500ms
 *                            for a 404 plus a fallback load. 0, 0, then 2 failures across
 *                            identical runs.
 *   rm_suite-log-flakes    — three assertions read Sub's LIVE game.log: an exact row count, an
 *                            exact PAUSED tally, and a hauling fixture the sidecar's real board
 *                            replaced mid-suite (which surfaced as a nameless throw on
 *                            `trackedNow`). Measured while playing: 5-7 log lines a second.
 *
 * 🔴 THE ROADMAP ROW WARNS AGAINST THE FALSE CONCLUSION AND IT IS RIGHT: these did not fire in
 * either 6 Sep full pass, and that is NOT evidence they were fixed — nobody checked whether Star
 * Citizen was up when those runs began. Star Citizen is CLOSED as this is written, so a green run
 * here proves nothing either. That is the entire reason this file exists: the noise is SYNTHESISED
 * rather than waited for, which is both reproducible and stronger than catching Sub mid-session.
 *
 * 🔑 EVERY REPAIR IS CONTROLLED IN BOTH DIRECTIONS, or it is a tautology wearing a fix's clothes:
 *   - inject the noise the assertion must now tolerate  -> it must stay GREEN
 *   - inject the same noise with the OLD assertion back -> it must go RED  (or the green above is
 *     free, and "the repair tolerates noise" is indistinguishable from "no noise arrived")
 *   - inject the real regression the assertion exists to catch -> it must go RED
 *
 *   C1  log: a live feed at ~67 lines/sec, repaired assertions   -> all stay green
 *   C2  log: the same feed, with the old exact counts reinstated -> all three redden
 *   C3  log: the widget drops a line it was handed               -> "a line the game wrote appears"
 *   C4  log: the timestamp is stripped instead of dimmed         -> the raw-line + dimmed checks
 *   C5  log: the filter stops filtering                          -> "showing only what matched"
 *   C6  log: the freeze stops counting what arrives behind it    -> "says how many are waiting"
 *   C7  log: status() stops printing the figure it counted       -> same, by the other half
 *   C8  img: the fallback chain takes 900ms, repaired wait       -> stays green
 *   C9  img: the same 900ms chain, with the 500ms sleep back     -> reddens  (C8 was not free)
 *   C10 img: the fallback is never attempted at all              -> reddens
 *   C11 haul: an SSE frame lands mid-suite, load frozen          -> fixture survives, stays green
 *   C12 haul: the same frame with the freeze removed             -> reddens BY NAME, never a throw
 *
 * 🔴 EVERY RULE IN THE RUNNER WAS LEARNED THE EXPENSIVE WAY IN THIS REPO, so none is optional:
 *   - grade on the output TEXT, never the exit code (`test:widgets` has exited 0 while printing
 *     FAILED, and a wrapper reading `r.status` once announced GREEN above its own captured FAIL);
 *   - abort loudly on a NO-OP patch, or the suite runs on unmodified source and its green reads as
 *     "the control proves nothing is broken" — the exact conclusion a control exists to rule out;
 *   - require the suite to have produced assertions AND reached its own terminator, because a run
 *     that crashed part-way is indistinguishable from one that passed;
 *   - check WHICH assertion went red. A control that reddens a different one — especially a
 *     positive-first guard that is supposed to stay green — is a bug in the test, not evidence;
 *   - restore from a copy held IN MEMORY, never from git: these are the files being protected, and
 *     this repo has already lost a source file to a control runner that crashed mid-restore.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "tools", "widget-dom-test.cjs");
const LOGVIEW = path.join(ROOT, "overlay", "logview.html");
const UNLOCK = path.join(ROOT, "overlay", "unlockalert.html");
const PORT = process.env.CONTROL_PORT || "8781";

// ── the assertions under control ─────────────────────────────────────────────
const L_EMPTY = "the feed is cut, and the panel really is empty to start with";
const L_APPEARS = "a line the game wrote appears";
const L_RAW = "carrying the whole raw line, timestamp included";
const L_DIM = "with the timestamp dimmed rather than stripped";
const L_BURIED = "a line pushed off the DOM is still held for the filter";
const L_REACH = "and the filter reaches back and finds it";
const L_ONLY = "showing only what matched";
const L_CASE = "the filter is case-insensitive, because nobody types engine casing";
const L_NEWEST = "keeping the NEWEST lines, not the oldest";
const L_PAUSED = "and says how many are waiting";
const L_FROZE = "pausing freezes the view";

const I_FALLBACK = "falls back to the render when the capture 404s";
const I_PICTURE = "and still shows a picture";
const I_GLYPH = "falls through to the glyph when both fail";

const H_FIXTURE = "the fixture is still what is on screen, so the tracking rules are measured on it";
const H_TRACKED = "a TRACKED contract with no tonnage is not told to track it again";
const H_BOARD = "three contracts on the board";

/** One edit, and it must actually change the file. */
const patch = (file, find, replace) => ({ file, find, replace });

// ── the injected noise ───────────────────────────────────────────────────────
/* A timer standing in for Sub's running game, started AFTER the suite's own reset so the
   empty-panel guard still means something. 15ms is ~67 lines/sec against the 5-7/sec measured
   while playing, so it is a harder test than the real thing.
   🔑 The noise carries CObjectiveMarkerComponent::AddToPlayerDataBank on purpose: that is the
   exact token the filter block searches for, and it is what the game writes when Sub tracks a
   contract. Noise that avoided it would leave the filter assertions untested.
   🔴 15ms, NOT 60. Measured on the first run of this file: at 60ms nothing landed inside the
   40ms window after the suite pushes its two lines, so C2 reinstated the old `rowCount() === 2`
   and it stayed GREEN — i.e. the control could not express the failure and C1 was passing that
   assertion for free. A control has to be able to REACH every window it claims to cover. */
const LOG_NOISE_ANCHOR =
  '  ok("the feed is cut, and the panel really is empty to start with", rowCount() === 0, rowCount());';
const LOG_NOISE = LOG_NOISE_ANCHOR + "\n"
  + '  const NOISE = "<2026-09-08T12:00:00.000Z> [Notice] '
  + '<CObjectiveMarkerComponent::AddToPlayerDataBank> live noise ";\n'
  + "  let noiseN = 90000;\n"
  + "  const noiseTimer = setInterval(() => { noiseN++; push([mk(noiseN, NOISE + noiseN)]); }, 15);\n"
  + "  void noiseTimer;";

/* The hauling injection: refresh() is the REAL path an SSE frame takes on that page
   (es.onmessage -> refresh() -> clearTimeout + setTimeout(load, 120)), so this is the live feed
   arriving, not a stand-in for it. The wait is past the 120ms coalesce with room to spare.
   ⚠️ Anchored on the single unique line that opens the first assertion block, so everything the
   suite checks — the board, the provenance colours, the tracking prompt — runs AFTER the frame.
   The first version of this anchor was a multi-line one ending in an em-dash comment rule; it
   matched nothing, aborted the control, and (before the restore was added above) left the other
   half of the patch stranded in the tree. Single-line anchors, wherever they will do. */
const HAUL_INJECT_ANCHOR = '  const cards = [...document.querySelectorAll(".card")];';
const HAUL_INJECT =
  "  // INJECTED: the real coalescing path an SSE frame takes, plus time for it to fire.\n"
  + "  refresh();\n  await sleep(400);\n" + HAUL_INJECT_ANCHOR;

const CONTROLS = [
  {
    name: "C1  log: a live game feeding the widget while every assertion runs",
    why: "the noise the repaired assertions must tolerate — 17 lines/sec, carrying the real token",
    only: "logView",
    edits: [patch(SUITE, LOG_NOISE_ANCHOR, LOG_NOISE)],
    mustRedden: [],
    mustStayGreen: [L_EMPTY, L_APPEARS, L_RAW, L_DIM, L_BURIED, L_REACH, L_ONLY, L_CASE,
      L_NEWEST, L_FROZE, L_PAUSED],
  },
  {
    name: "C2  log: the same feed, with the OLD exact counts reinstated",
    why: "without this, C1's green is equally consistent with the noise never arriving",
    only: "logView",
    edits: [
      patch(SUITE, LOG_NOISE_ANCHOR, LOG_NOISE),
      // the shipped `rowCount() === 2`
      patch(SUITE,
        '  ok("a line the game wrote appears", !!markerRow && !!navRow,',
        '  ok("a line the game wrote appears", rowCount() === 2,'),
      // the shipped `rowCount() === 1`
      patch(SUITE,
        '  ok("...and the filter reaches back and finds it", has(MINE), rowCount() + " rows shown");',
        '  ok("...and the filter reaches back and finds it", rowCount() === 1, rowCount() + " rows shown");'),
      // the shipped exact PAUSED tally
      patch(SUITE,
        '     stat().indexOf("PAUSED") > -1\n'
        + "       && heldWhilePaused >= heldBefore + 1\n"
        + '       && stat().indexOf(heldWhilePaused + " new") > -1,',
        '     stat().indexOf("PAUSED · 1 new") > -1,'),
    ],
    mustRedden: [L_APPEARS, L_REACH, L_PAUSED],
    mustStayGreen: [L_EMPTY, L_FROZE],
  },
  {
    name: "C3  log: the widget silently drops a line it was handed",
    why: "the regression the appears-check exists to catch — this widget's whole reason to exist",
    only: "logView",
    edits: [patch(LOGVIEW,
      "    if (frag) { box.appendChild(frag); trimRows(); scrollTail(); }",
      "    if (frag) { if (frag.firstChild) frag.removeChild(frag.firstChild);"
      + " box.appendChild(frag); trimRows(); scrollTail(); }")],
    mustRedden: [L_APPEARS],
    mustStayGreen: [L_EMPTY, L_NEWEST, L_FROZE, L_PAUSED],
  },
  {
    name: "C4  log: the timestamp is stripped instead of dimmed",
    why: "a widget that reformats the log answers 'what did the game say' with our edit of it",
    only: "logView",
    edits: [patch(LOGVIEW,
      "      el.append(ts, document.createTextNode(m[2]));",
      "      el.append(document.createTextNode(m[2]));")],
    mustRedden: [L_RAW, L_DIM],
    mustStayGreen: [L_EMPTY, L_APPEARS, L_FROZE, L_PAUSED],
  },
  {
    name: "C5  log: the filter stops filtering",
    why: "proves 'showing only what matched' is a real check and not a restatement of the render",
    only: "logView",
    edits: [patch(LOGVIEW, "    const shown = ring.filter(matches);", "    const shown = ring.slice();")],
    mustRedden: [L_ONLY, L_CASE],
    mustStayGreen: [L_EMPTY, L_APPEARS, L_PAUSED],
  },
  {
    name: "C6  log: the freeze stops counting what arrives behind it",
    why: "the first half of the PAUSED assertion — the counter really counts",
    only: "logView",
    edits: [patch(LOGVIEW,
      "    if (paused) { heldWhilePaused += lines.length; status(); return; }",
      "    if (paused) { status(); return; }")],
    mustRedden: [L_PAUSED],
    mustStayGreen: [L_EMPTY, L_APPEARS, L_FROZE],
  },
  {
    name: "C7  log: status() stops printing the figure it counted",
    why: "the second half — the assertion is about the UI, not about a variable",
    only: "logView",
    edits: [patch(LOGVIEW,
      '    if (paused) bits.push(heldWhilePaused ? `PAUSED · ${heldWhilePaused} new` : "PAUSED");',
      '    if (paused) bits.push("PAUSED");')],
    mustRedden: [L_PAUSED],
    mustStayGreen: [L_EMPTY, L_APPEARS, L_FROZE],
  },
  {
    name: "C8  img: the fallback chain takes 900ms",
    why: "the slow chain the repaired wait must tolerate — the old 500ms budget could not",
    only: "unlockAlert",
    edits: [patch(UNLOCK,
      "        if (second && !triedFallback) { triedFallback = true; img.src = second; return; }",
      "        if (second && !triedFallback) { triedFallback = true;"
      + " setTimeout(() => { img.src = second; }, 900); return; }")],
    mustRedden: [],
    mustStayGreen: [I_FALLBACK, I_PICTURE, I_GLYPH],
  },
  {
    name: "C9  img: the same 900ms chain, with the fixed 500ms sleep reinstated",
    why: "without this, C8's green is equally consistent with the delay never happening",
    only: "unlockAlert",
    edits: [
      patch(UNLOCK,
        "        if (second && !triedFallback) { triedFallback = true; img.src = second; return; }",
        "        if (second && !triedFallback) { triedFallback = true;"
        + " setTimeout(() => { img.src = second; }, 900); return; }"),
      patch(SUITE,
        "  await settles(() => src().endsWith(GOOD2) || thumb.classList.contains(\"noimg\"));",
        "  await sleep(500);"),
    ],
    // Only the fallback check. "...and still shows a picture" reads !noimg, and a fallback
    // that is merely SLOW has not failed yet at 500ms, so noimg is not set and that assertion
    // is legitimately green. Measured, not assumed — it was in mustRedden on the first run and
    // reported GREEN, which is the control being wrong rather than the assertion.
    mustRedden: [I_FALLBACK],
    mustStayGreen: [I_PICTURE, I_GLYPH],
  },
  {
    name: "C10 img: the fallback is never attempted",
    why: "the regression the assertion exists to catch — a blank tile instead of the render",
    only: "unlockAlert",
    edits: [patch(UNLOCK,
      "        if (second && !triedFallback) { triedFallback = true; img.src = second; return; }",
      "        if (false && second && !triedFallback) { triedFallback = true; img.src = second; return; }")],
    mustRedden: [I_FALLBACK, I_PICTURE],
    mustStayGreen: [I_GLYPH],
  },
  {
    name: "C11 haul: a live SSE frame lands in the middle of the suite",
    why: "exactly what Sub's game does 5-7 times a second; with load frozen the fixture survives",
    only: "hauling",
    edits: [patch(SUITE, HAUL_INJECT_ANCHOR, HAUL_INJECT)],
    mustRedden: [],
    mustStayGreen: [H_BOARD, H_FIXTURE, H_TRACKED],
  },
  {
    name: "C12 haul: the same frame, with the freeze removed",
    why: "the shipped defect — and it must now fail BY NAME rather than as a nameless throw",
    only: "hauling",
    edits: [
      patch(SUITE, HAUL_INJECT_ANCHOR, HAUL_INJECT),
      /* Undo the freeze for the HAULING suite ONLY. Its interpolation is the one followed by a
         blank line and `plan = {`; BUYROUTE's and STOW's are followed by a comment, so they keep
         theirs and stay green — which is itself evidence that the freeze is what does the work
         rather than something else about this suite. */
      patch(SUITE, "  ${HAULFREEZE}\n\n  plan = {", "\n  plan = {"),
    ],
    // 🔴 The board check is what a replaced fixture destroys FIRST, and it is the one that used to
    // be unreachable — the suite threw on trackedNow before ever printing a verdict. It must now
    // fail BY NAME. The runner separately fails this control if the suite throws at all.
    mustRedden: [H_BOARD, H_FIXTURE, H_TRACKED],
    mustStayGreen: [],
  },
];

function runSuite(only) {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, "tools", "test-widgets-sandbox.mjs"),
    "--port", PORT, "--reset", "--only", only,
  ], { cwd: ROOT, encoding: "utf8", timeout: 10 * 60 * 1000, killSignal: "SIGKILL" });
  return (r.stdout || "") + (r.stderr || "");
}

/** Read the verdict for one named assertion out of the run's TEXT. */
function verdict(out, name) {
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (t.startsWith("ok   ") && t.indexOf(name) >= 0) return "green";
    if (t.startsWith("FAIL ") && t.indexOf(name) >= 0) return "RED";
  }
  return "absent";
}

const originals = new Map();
for (const f of [SUITE, LOGVIEW, UNLOCK]) originals.set(f, readFileSync(f, "utf8"));

const only = process.argv.slice(2).filter((a) => a.indexOf("-") !== 0);
const chosen = only.length
  ? CONTROLS.filter((c) => only.some((o) => c.name.toLowerCase().indexOf(o.toLowerCase()) === 0))
  : CONTROLS;
if (!chosen.length) {
  console.error("no control matched " + JSON.stringify(only) + "; names are:");
  for (const c of CONTROLS) console.error("  " + c.name);
  process.exit(2);
}

let failures = 0;
try {
  for (const c of chosen) {
    console.log("\n=== " + c.name + " ===");
    console.log("    " + c.why);

    for (const e of c.edits) {
      const before = readFileSync(e.file, "utf8");
      /* 🔴 EVERY FILE IN THIS REPO IS CRLF — tools/*.cjs and overlay/*.html alike, measured. A
         multi-line anchor written with a bare newline therefore matches NOTHING, and the failure
         mode is a no-op patch: the suite runs on unmodified source and its green reads as "the
         control proves nothing is broken". The abort below catches that, but only after burning a
         run, so translate the endings first and keep single-line anchors where possible. */
      const crlf = before.indexOf("\r\n") >= 0;
      const find = crlf ? e.find.split("\n").join("\r\n") : e.find;
      const repl = crlf ? e.replace.split("\n").join("\r\n") : e.replace;
      const after = before.split(find).join(repl);
      if (after === before) {
        console.error("    PATCH DID NOT APPLY -> " + path.basename(e.file)
          + (crlf ? " (CRLF, anchor was translated)" : " (LF)"));
        console.error("    anchor: " + e.find.trim().slice(0, 100));
        console.error("    ABORTING: a no-op patch makes the run test unmodified source, and its");
        console.error("    green would read as evidence. Fix the anchor before trusting anything.");
        /* 🔴 RESTORE BEFORE EXITING. process.exit() does NOT run the finally below, so an abort
           on the SECOND edit of a multi-edit control leaves the FIRST one written to the tree —
           which is this repo's documented "a control runner that crashes strands a control"
           hazard, and it happened here on the first run of this very file: C12's refresh()
           injection was left in widget-dom-test.cjs and only `git status` caught it. */
        for (const [f, text] of originals) writeFileSync(f, text);
        console.error("    (the tree has been restored)");
        process.exit(2);
      }
      writeFileSync(e.file, after);
    }

    const out = runSuite(c.only);

    // A run that crashed part-way looks exactly like one that passed, so demand both that the
    // suite produced assertions and that it printed its own terminator.
    const produced = out.indexOf("ok   ") >= 0 || out.indexOf("FAIL ") >= 0;
    const finished = out.indexOf("FAILED (") >= 0 || out.indexOf("tests passed") >= 0;
    if (!produced || !finished) {
      console.error("    BROKEN CONTROL: the suite " + (produced ? "did not finish" : "produced no assertions") + ".");
      console.error("    That is never a pass. Last lines:\n" + out.split("\n").slice(-14).join("\n"));
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
      // 🔴 A suite that THREW named no assertion at all, which is the exact failure mode the
      // hauling guard was added to remove. Say so rather than letting it read as a clean red.
      if (out.indexOf("suite threw before it could report") >= 0) {
        console.error("    ^^ THE SUITE THREW — a nameless throw is not a graded failure.");
        for (const line of out.split("\n")) {
          if (line.indexOf("suite threw before it could report") >= 0) console.error("      " + line.trim());
        }
        bad = true;
      }
      // Print the detail of the reddened assertions — a control is only useful if you can see
      // what it actually said.
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

console.log("\n" + (failures ? failures + " control(s) misbehaved" : "all " + chosen.length + " controls behaved"));
process.exit(failures ? 1 : 0);
