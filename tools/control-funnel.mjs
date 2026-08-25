/**
 * Negative controls for the what -> buy at -> sell at funnel's SERVER half.
 *
 *   npm run control:funnel
 *
 * Each control re-injects one exact regression into `src/trade-finder.ts`, requires `test:trade` to
 * go RED **naming the assertion it should redden**, then restores from HEAD and requires it green
 * again. Lives as a script rather than a one-off so it cannot rot — same shape as
 * `control:sellvolume`.
 *
 * 🔴 IT GRADES ON THE TEXT, NEVER ON THE EXIT CODE. `npm run test:trade` has been observed to exit
 * 0 while printing failures, and a wrapper reading `status` alone has already announced "GREEN, the
 * control proves nothing" directly beneath its own captured FAIL output. That is the single most
 * expensive wrong conclusion available here, so the verdict comes from `out.includes("FAIL")`.
 *
 * 🔴 AND IT ABORTS LOUDLY ON A NO-OP PATCH. An anchor that matches nothing writes the file back
 * unchanged, the suite then runs on unmodified source, and "all passed" reads as "the control
 * proves nothing is broken" — which is exactly the conclusion a working control exists to rule out.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FINDER = path.join(ROOT, "src", "trade-finder.ts");

/** Each control names the assertion it must redden, so a red run on some OTHER line is a failure
 *  of the control rather than proof of the fix. */
const CONTROLS = [
  {
    name: "the dedupe never flips — 'where can I take this' collapses to one row",
    file: FINDER,
    from: "const dedupeOnDestination = !!opts.fromTerminal;",
    to: "const dedupeOnDestination = false;",
    reddens: "with the buy pinned, one row per DESTINATION",
  },
  {
    name: "the commodity filter is a PREFIX match, so Neon drags in Neon (Ore)",
    file: FINDER,
    from: "if (wantCommodity && q.commodity.toLowerCase() !== wantCommodity) continue;",
    to: "if (wantCommodity && !q.commodity.toLowerCase().startsWith(wantCommodity)) continue;",
    reddens: "commodity is matched exactly",
  },
  {
    name: "a terminal filter matches the LONG name only, so a pick off the board finds nothing",
    file: FINDER,
    from: "return q.terminal.toLowerCase() === w || q.terminalShort.toLowerCase() === w;",
    to: "return q.terminal.toLowerCase() === w;",
    reddens: "fromTerminal matches the SHORT name",
  },
];

function runSuite() {
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(ROOT, "src", "trade.test.ts")], { cwd: ROOT, encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}

let bad = 0;

const baseline = runSuite();
if (baseline.includes("FAIL")) {
  console.error("BASELINE IS ALREADY RED — fix that before reading any control below.");
  console.error(baseline.split("\n").filter((l) => l.includes("FAIL")).join("\n"));
  process.exit(1);
}
console.log("baseline: green\n");

for (const c of CONTROLS) {
  const original = readFileSync(c.file, "utf8");
  const patched = original.replace(c.from, c.to);
  if (patched === original) {
    console.error("PATCH DID NOT APPLY: " + c.name);
    console.error("  anchor: " + c.from);
    process.exit(1);
  }
  writeFileSync(c.file, patched);
  let out;
  try { out = runSuite(); } finally { writeFileSync(c.file, original); }

  const red = out.includes("FAIL");
  const named = out.split("\n").some((l) => l.includes("FAIL") && l.includes(c.reddens));
  if (red && named) {
    console.log("ok   " + c.name);
    console.log("     reddened: " + c.reddens);
  } else if (red) {
    // 🔴 Red on the wrong line is a bug in the CONTROL, not proof of the fix.
    console.error("BAD  " + c.name);
    console.error("     went red, but NOT on: " + c.reddens);
    console.error(out.split("\n").filter((l) => l.includes("FAIL")).map((l) => "       " + l).join("\n"));
    bad++;
  } else {
    console.error("BAD  " + c.name);
    console.error("     came back GREEN — the assertion cannot see this regression.");
    bad++;
  }
}

const after = runSuite();
if (after.includes("FAIL")) { console.error("\nRESTORE FAILED — the tree is still patched."); bad++; }
else console.log("\nrestored: green");

console.log(bad ? "\nPROBLEMS: " + bad : "\nall " + CONTROLS.length + " controls red on the right assertion");
process.exit(bad ? 1 : 0);
