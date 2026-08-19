// A stray backtick inside a suite body silently ends its template literal.
//
// The file still parses and "node --check" still passes, so the first sign is electron throwing
// during load with a TypeError quoting the whole body - and the process never exits. A run of the
// widget suite hung for fifteen hours that way before the cause was found.
//
// Parity does not catch it: a quoted word is TWO backticks, so the count stays even and the
// second just opens a fresh literal that runs to the real terminator.
//
// What DOES catch it: every suite body must end with the IIFE close. If a backtick truncated one,
// the literal ends mid-prose instead. Runs BEFORE electron, so the failure is one line, not a
// hang. No regex and no escapes here on purpose - the pattern is full of characters that would
// need escaping, and getting that wrong is the same class of mistake this file exists to catch.
const fs = require("node:fs");
const file = process.argv[2] || "tools/widget-dom-test.cjs";
const src = fs.readFileSync(file, "utf8");
const TICK = String.fromCharCode(96);
const NL = String.fromCharCode(10);
const OPEN = TICK + "(async () => {";
const bad = [];
let at = 0;
for (;;) {
  const i = src.indexOf(OPEN, at);
  if (i < 0) break;
  at = i + OPEN.length;
  const lineStart = src.lastIndexOf(NL, i) + 1;
  const decl = src.slice(lineStart, i).trim();
  const name = decl.startsWith("const ") ? decl.slice(6).split(" ")[0] : (decl || "(anonymous)");
  const end = src.indexOf(TICK, at);
  if (end < 0) { bad.push(name + " (literal never closed)"); continue; }
  // Some suites close as })(); and some as })() - both are the IIFE, so allow the semicolon.
  let tail = src.slice(Math.max(at, end - 10), end).trim();
  while (tail.endsWith(";")) tail = tail.slice(0, -1).trim();
  if (!tail.endsWith("})()")) {
    bad.push(name + " - literal ends at line " + src.slice(0, end).split(NL).length
             + ", not at the IIFE close");
  }
}
if (bad.length) {
  console.error("");
  console.error("SUITE LITERAL TRUNCATED - a backtick inside a suite body ended it early:");
  for (const b of bad) console.error("  " + b);
  console.error("Write selectors as .card, not wrapped in backticks.");
  console.error("");
  process.exit(1);
}
