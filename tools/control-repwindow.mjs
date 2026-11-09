// Negative controls for the REP-page WINDOW rule (feat/standingrep, 2026-11-09).
//
// A standing-only faction (Adagio Holdings, Bit Zeros) never saved on a screen too small to show
// its whole 7-rank ladder at once, because the reader demanded every rank on screen. It now reads
// an unbroken run of ranks and lets the bar step refuse only when the rank could be off screen.
// Each control re-injects one way of getting that wrong, names the assertion it must REDDEN and
// the guard that must STAY GREEN, aborts on a no-op patch, requires the suite to reach its own
// terminator, grades on the output TEXT, and restores the file from a copy held in memory.
// C1 is the shipped bug itself.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const F = "src/rep-page.ts";
const orig = readFileSync(F, "utf8");
const C = [
  { name: "C1 old rule: every rank must be on screen",
    from: "  if (!isWindow) return { layout: null, refusal: \"cards-incomplete\"",
    to: "  if (best.cards.length !== scopes[best.key].ranks.length) return { layout: null, refusal: \"cards-incomplete\"",
    reddens: ["standing-only, top row only: the page is READ", "a page with its last cards off screen is read as a WINDOW"],
    stays: ["standing-only: the whole page reads, as it does on Sub's screen", "the Standing ladder really has 7 ranks"] },
  { name: "C2 top-edge guard removed (green to the last visible card is accepted)",
    from: "  if (rank === hi && hi < top) return",
    to: "  if (false && rank === hi && hi < top) return",
    reddens: ["window 0-3, ALL green: refused"],
    stays: ["window 0-3, green to 1, card 2 grey: rank 1 is read", "window 3-6 reaching the top, all green"] },
  { name: "C3 bottom-edge guard removed (nothing green below the window reads no-rank-reached)",
    from: "refusal: lo > 0 ? \"cards-incomplete\" : \"no-rank-reached\"",
    to: "refusal: \"no-rank-reached\"",
    reddens: ["window 3-6, nothing green: refused cards-incomplete"],
    stays: ["no green anywhere is refused, not read as rank 0"] },
  { name: "C4 hole check removed in the reader",
    from: "    && best.cards.every((c, i) => i === 0 || c.rank === best!.cards[i - 1].rank + 1);",
    to: "    && true;",
    reddens: ["a window with a HOLE in it is REFUSED"],
    stays: ["a page with its last cards off screen is read as a WINDOW"] },
];
let bad = 0;
try {
  for (const c of C) {
    const s = orig.split(c.from).join(c.to);
    if (s === orig) { console.log("NO-OP PATCH:", c.name); bad++; continue; }
    writeFileSync(F, s);
    const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/rep-page.test.ts"], { encoding: "utf8" });
    const out = r.stdout + r.stderr;
    const finished = /checks passed|FAILED \(\d+\)/.test(out);
    const red = (n) => out.split("\n").some((l) => l.startsWith("FAIL") && l.includes(n));
    const green = (n) => out.split("\n").some((l) => l.startsWith("ok") && l.includes(n));
    const okR = c.reddens.every(red), okG = c.stays.every(green);
    console.log(`${finished && okR && okG ? "PASS" : "BROKEN"}  ${c.name}  finished=${finished} reddened=${okR} staysGreen=${okG}`);
    if (!(finished && okR && okG)) { bad++; console.log(out.split("\n").filter(l=>l.startsWith("FAIL")).join("\n")); }
  }
} finally { writeFileSync(F, orig); }
console.log(bad ? `CONTROLS BROKEN (${bad})` : "all controls behaved");
process.exit(bad ? 1 : 0);
