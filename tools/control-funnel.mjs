/**
 * Negative controls for the what -> buy at -> sell at funnel's SERVER half.
 *
 *   npm run control:funnel
 *
 * Each control re-injects one exact regression into the source, requires that control's OWN suite
 * to go RED **naming the assertion it should redden**, then restores the file and requires green
 * again. Lives as a script rather than a one-off so it cannot rot — same shape as
 * `control:sellvolume`.
 *
 * Two files, two suites: `src/trade-finder.ts` against `test:trade` for the three filters the slots
 * drive, and `src/hauling-buys.ts` against `test:buys` for the re-point guard. The last one is the
 * only control here that protects real data rather than a layout — nothing would LOOK wrong if it
 * went; the Ledger would simply start disagreeing with the game about where money was spent.
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
const BUYS = path.join(ROOT, "src", "hauling-buys.ts");

const TRADE_SUITE = path.join(ROOT, "src", "trade.test.ts");
const BUYS_SUITE = path.join(ROOT, "src", "hauling-buys.test.ts");

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
  {
    /* 🔴 THE ONE THAT PROTECTS REAL DATA. Once the log has matched a purchase to a pick, where it
       happened is a fact; re-pointing it would overwrite an observation with an intention. Nothing
       about the widget would look wrong if this guard went — the Ledger would simply start
       disagreeing with the game about where money was spent. */
    name: "a re-point is allowed after the log has already recorded the purchase",
    file: BUYS,
    suite: BUYS_SUITE,
    from: "if (buy.scu !== null) return null;   // the log already recorded where this really happened",
    to: "if (false) return null;",
    reddens: "and now it REFUSES to move",
  },
];

function runSuite(suite) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    suite || TRADE_SUITE], { cwd: ROOT, encoding: "utf8" });
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
  try { out = runSuite(c.suite); } finally { writeFileSync(c.file, original); }

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
const afterBuys = runSuite(BUYS_SUITE);
if (afterBuys.includes("FAIL")) { console.error("RESTORE FAILED in hauling-buys.ts."); bad++; }
if (after.includes("FAIL")) { console.error("\nRESTORE FAILED — the tree is still patched."); bad++; }
else console.log("\nrestored: green");

console.log(bad ? "\nPROBLEMS: " + bad : "\nall " + CONTROLS.length + " controls red on the right assertion");
process.exit(bad ? 1 : 0);
