/**
 * One-off lint for the FUNNEL suite body, checking the three landmines this repo has been bitten
 * by inside `tools/widget-dom-test.cjs` template literals:
 *
 *   1. a stray BACKTICK ends the literal, the file still parses, and electron hangs FOREVER
 *      (15 hours, once). `check-suite-literals.cjs` catches the unbalanced case; a quoted word is
 *      two backticks and keeps the count even, so it catches nothing there.
 *   2. a BACKSLASH is processed by the literal before the code exists. `\b` becomes a real
 *      backspace byte and a regex that compiles fine can then never match — which makes every
 *      "must not contain" assertion pass for ever.
 *   3. redeclaring a name the PRELUDE already holds (`out ok sleep el shown cs`) is a duplicate
 *      const in one scope, i.e. a parse error that surfaces with no suite name and no line.
 *
 * Written as a FILE rather than `node -e`, because passing this through a shell is the same
 * mangling it exists to detect — the first attempt lost its backslashes on the way in.
 */
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "widget-dom-test.cjs");
const src = fs.readFileSync(SRC, "utf8");

const start = src.indexOf("const FUNNEL =");
const end = src.indexOf("const RUNSNARROW =");
if (start < 0 || end < 0 || end < start) {
  console.error("could not locate the FUNNEL block");
  process.exit(1);
}
const block = src.slice(start, end);

let bad = 0;
const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);

const backticks = block.split(BT).length - 1;
console.log("lines:      " + block.split("\n").length);
console.log("backticks:  " + backticks + "  (expect exactly 2 — the literal's own delimiters)");
if (backticks !== 2) { console.error("  !! a stray backtick ends the literal early"); bad++; }

const backslashes = block.split(BS).length - 1;
console.log("backslashes:" + backslashes + "  (expect 0)");
if (backslashes !== 0) {
  console.error("  !! a backslash in a suite body is eaten by the template literal");
  block.split("\n").forEach((l, i) => { if (l.indexOf(BS) >= 0) console.error("     line " + (i + 1) + ": " + l.trim()); });
  bad++;
}

// Declared names, found without a regex for the same reason the suite avoids one.
const names = [];
for (const kw of ["const ", "let "]) {
  let i = block.indexOf(kw);
  while (i >= 0) {
    const before = i === 0 ? " " : block[i - 1];
    if (" \t\n;({".indexOf(before) >= 0) {
      let j = i + kw.length;
      let name = "";
      while (j < block.length && "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$".indexOf(block[j]) >= 0) {
        name += block[j]; j++;
      }
      if (name) names.push(name);
    }
    i = block.indexOf(kw, i + 1);
  }
}
const TAKEN = ["out", "ok", "sleep", "el", "shown", "cs"];
const clash = names.filter((n) => TAKEN.indexOf(n) >= 0);
console.log("locals:     " + names.join(", "));
// `out`, `ok` and `sleep` are DECLARED by this suite itself (it does not use PRELUDE), so the
// clash test is against the ones it would inherit if it ever did.
const realClash = clash.filter((n) => ["el", "shown", "cs"].indexOf(n) >= 0);
if (realClash.length) { console.error("  !! shadows a PRELUDE helper: " + realClash.join(", ")); bad++; }

const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) { console.error("  !! declared twice in one scope: " + [...new Set(dupes)].join(", ")); bad++; }

console.log(bad ? "\nPROBLEMS: " + bad : "\nclean");
process.exit(bad ? 1 : 0);
