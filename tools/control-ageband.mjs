#!/usr/bin/env node
/**
 * Negative controls for the Verse Finder age-band assertions (flight `ageband`, 2026-09-06).
 *
 * WHY THIS FILE EXISTS. The assertion `the band really matches the age it prints` had been red on
 * an untouched `main` and was getting worse every week: it re-derived the age from the label the
 * widget printed, and `ageOf` compresses to whole months above 60 days, so a "3mo" label means
 * anything from 90 to 119 days while the stale/ancient cut sits at 100 — INSIDE that bucket. The
 * repair points the band check at the moment the widget actually banded on (`data-at` on the pill)
 * and keeps a separate, range-based check that the printed label does not contradict the colour.
 *
 * A repair like that is worth nothing until each new assertion has been seen to fail, so:
 *
 *   C1  reinstate the lossy round trip           -> the band check reddens, want stale got ancient
 *   C2  drop data-at from the pill               -> the positive-first guard reddens
 *   C3  band off a moment 40 days fresher        -> the band check reddens, data-at guards stay green
 *   C4  the label formatter drifts               -> the contradiction check reddens, band stays green
 *   C5  stamp data-at one second off the quote   -> the payload check reddens, the band stays green
 *
 * 🔴 EVERY RULE IN THE RUNNER WAS LEARNED THE EXPENSIVE WAY IN THIS REPO, so none of them is
 * optional:
 *   - grade on the output TEXT, never the exit code (`test:widgets` has exited 0 while printing
 *     FAILED, and a wrapper reading `r.status` once announced GREEN above its own captured FAIL);
 *   - abort loudly on a NO-OP patch, or the suite runs on unmodified source and its green reads as
 *     "the control proves nothing is broken" — the exact conclusion a control exists to rule out;
 *   - require the suite to have produced assertions AND reached its own terminator, because a run
 *     that crashed part-way is indistinguishable from one that passed;
 *   - check WHICH assertion went red. A control that reddens a different one — especially a
 *     positive-first guard that is supposed to stay green — is a bug in the test, not evidence.
 *   - restore from a copy held IN MEMORY, never from git: these are the files being protected, and
 *     this repo has already lost a source file to a control runner that crashed mid-restore.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "tools", "widget-dom-test.cjs");
const PAGE = path.join(ROOT, "overlay", "versefinder.html");
const PORT = process.env.CONTROL_PORT || "8797";

const BAND_CHECK = "the band really matches the age it prints";
const STAMP_GUARD = "every age pill states the moment its band was computed from";
const PAYLOAD_CHECK = "every surveyed pill's moment came from the payload, not from a clock";
const LABELS_GUARD = "there are day-ladder labels to check the colour against";
const CONTRA_CHECK = "no pill prints an age its own colour contradicts";

/** One edit, and it must actually change the file. */
function patch(file, find, replace) {
  return { file, find, replace };
}

const CONTROLS = [
  {
    name: "C1  the lossy label round trip, reinstated",
    why: "the shipped defect: derive the band from the printed label instead of the moment",
    edits: [patch(SUITE,
      "                   want: abBandFromSec(Number(p.dataset.at)),",
      "                   want: (function () { const t = ageTextOf(p).trim();"
      + " if (t === \"today\") return abBandFromSec(Number(p.dataset.at));"
      + " const n = t.slice(-2) === \"mo\" ? Number(t.slice(0, -2)) * 30 : Number(t.slice(0, -1));"
      + " return abBandForDays(n); })(),")],
    mustRedden: [BAND_CHECK],
    mustStayGreen: [STAMP_GUARD, PAYLOAD_CHECK, LABELS_GUARD, CONTRA_CHECK],
  },
  {
    name: "C2  the pill stops stating its moment",
    why: "the anti-vacuous guard: without it the band check is a must-not over an empty list",
    edits: [patch(PAGE, "          a.dataset.at = String(shownAt);", "          void shownAt;")],
    // The band check reddens too, and that is the guard working: `abStamped.length > 0` refuses to
    // pass on nothing rather than reporting 0 of 0 wrong.
    mustRedden: [STAMP_GUARD, BAND_CHECK],
    mustStayGreen: [LABELS_GUARD, CONTRA_CHECK],
  },
  {
    name: "C3  the band is computed from the wrong moment",
    why: "proves the band check is precise rather than a restatement of the page",
    edits: [patch(PAGE,
      "          a.className = \"age \" + ageBand(shownAt);",
      "          a.className = \"age \" + ageBand(shownAt + 40 * 86400);")],
    mustRedden: [BAND_CHECK],
    mustStayGreen: [STAMP_GUARD, PAYLOAD_CHECK, LABELS_GUARD],
  },
  {
    name: "C4  the label formatter drifts away from the band",
    why: "proves the contradiction check is not free — rule 1 passes this one happily",
    edits: [patch(PAGE,
      "    return Math.floor(days / 30) + \"mo\";",
      "    return Math.floor(days / 60) + \"mo\";")],
    mustRedden: [CONTRA_CHECK],
    mustStayGreen: [STAMP_GUARD, BAND_CHECK, PAYLOAD_CHECK, LABELS_GUARD],
  },
  {
    name: "C5  the stated moment is not the quote's",
    why: "proves the payload check earns its place: the band check cannot see a 1-second lie",
    edits: [patch(PAGE, "          a.dataset.at = String(shownAt);", "          a.dataset.at = String(shownAt + 1);")],
    mustRedden: [PAYLOAD_CHECK],
    mustStayGreen: [STAMP_GUARD, BAND_CHECK, LABELS_GUARD, CONTRA_CHECK],
  },
];

function runSuite() {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, "tools", "test-widgets-sandbox.mjs"),
    "--port", PORT, "--reset", "--only", "verseFinder",
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
for (const f of [SUITE, PAGE]) originals.set(f, readFileSync(f, "utf8"));

let failures = 0;
try {
  for (const c of CONTROLS) {
    console.log("\n=== " + c.name + " ===");
    console.log("    " + c.why);

    for (const e of c.edits) {
      const before = readFileSync(e.file, "utf8");
      const after = before.split(e.find).join(e.replace);
      if (after === before) {
        console.error("    PATCH DID NOT APPLY -> " + path.basename(e.file));
        console.error("    anchor: " + e.find.trim().slice(0, 90));
        console.error("    ABORTING: a no-op patch makes the run test unmodified source, and its");
        console.error("    green would read as evidence. Fix the anchor before trusting anything.");
        process.exit(2);
      }
      writeFileSync(e.file, after);
    }

    const out = runSuite();

    // A run that crashed part-way looks exactly like one that passed, so demand both that the
    // suite produced assertions and that it printed its own terminator.
    const produced = out.indexOf("ok   ") >= 0 || out.indexOf("FAIL ") >= 0;
    const finished = out.indexOf("FAILED (") >= 0 || out.indexOf("tests passed") >= 0;
    if (!produced || !finished) {
      console.error("    BROKEN CONTROL: the suite " + (produced ? "did not finish" : "produced no assertions") + ".");
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
      // Print the detail of the reddened assertion — a control is only useful if you can see
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

console.log("\n" + (failures ? failures + " control(s) misbehaved" : "all " + CONTROLS.length + " controls behaved"));
process.exit(failures ? 1 : 0);
