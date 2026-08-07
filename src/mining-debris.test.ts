// What a scanned signature MEANS — `npx tsx src/mining-debris.test.ts`.
//
// Sub, 2026-07-29 (superseding "2,000 and 4,000 and anything above"): debris comes in whole
// salvage panels, so a debris signature is a MULTIPLE of 2,000. "It isn't in the rock table" is no
// longer evidence of debris on its own — a number that is neither ore nor a whole number of panels
// is `unknown`, and the app says so out loud rather than guessing "Debris".
//
// 🔑 The asymmetry asserted throughout: a value that matches the rock table is honoured whatever
// else is true of it. Weakening that would silently cost real ore call-outs, which is much worse
// than a missed piece of debris. The two values where both readings are live (16,000 Savrilium ×5
// and 18,000 Bexalite ×5) are the interesting cases and are checked against the real dataset.
import { readFileSync } from "node:fs";
import { classifySignature, isDebrisValue, repairConfusableDigits } from "./mining.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "   [" + detail + "]" : ""}`);
};

// The real table, because the collisions this has to get right are a property of the DATA. A
// fixture would keep passing after a patch moved a base value.
const data = JSON.parse(readFileSync(new URL("../data/mineables.json", import.meta.url), "utf8")) as {
  rocks: { name: string; base: number; sigs: number[] }[];
  index: Record<string, { name: string; count: number }[]>;
};
const MAX = Math.max(...data.rocks.flatMap((r) => r.sigs));
const ore = (sig: number) => (data.index[String(sig)] ?? []).length > 0;
const verdict = (sig: number) => classifySignature(sig, ore(sig), MAX);

console.log("debris values (whole salvage panels)");
check("2,000 is a debris value", isDebrisValue(2000));
check("4,000 is a debris value", isDebrisValue(4000));
check("every multiple up to the ceiling is", [6000, 8000, 12000, 20000, 24000].every(isDebrisValue));
check("4,001 is NOT (the old rule said it was)", !isDebrisValue(4001));
check("nor is any other non-multiple", ![2001, 2500, 3999, 7400, 19200, 25800].some(isDebrisValue));
check("below one whole panel is NOT", !isDebrisValue(999) && !isDebrisValue(1500) && !isDebrisValue(1999));
// The specific phantoms ordinary HUD words used to produce (the o->0, l/I->1 rescue).
check("the old phantom values (1,001 / 1,010 / 1,100) are refused",
  ![1001, 1010, 1100].some(isDebrisValue));

console.log("\nthe range a signature can have");
check("below the 2,000 floor gets no verdict at all", verdict(1999) === null && verdict(500) === null);
check(`above the ceiling (${MAX.toLocaleString()}) gets none either`,
  verdict(MAX + 1) === null && verdict(50000) === null && verdict(999999) === null);
check("the ceiling itself is in range", verdict(MAX) !== null, String(MAX));
check("a non-finite read gets none", verdict(NaN) === null && verdict(Infinity) === null);

console.log("\nore");
check("a rock signature reads as ore", verdict(3170) === "ore", "Quantainium ×1 = " + verdict(3170));
check("...at every cluster size", data.rocks[0].sigs.every((s) => verdict(s) === "ore" || verdict(s) === "ore-or-debris"));
check("17,000 (Lindinium ×5) is plain ore, not ambiguous",
  ore(17000) && verdict(17000) === "ore", String(verdict(17000)));
check("19,200 (Savrilium ×6 / Aslarite ×5) is plain ore too",
  verdict(19200) === "ore", String(verdict(19200)));

console.log("\nore AND debris — the values where both are possible");
// These two are the whole reason the verdict exists rather than a boolean.
const both = Object.keys(data.index).map(Number).filter((s) => isDebrisValue(s)).sort((a, b) => a - b);
check("exactly two values in the table are also debris values",
  both.length === 2 && both[0] === 16000 && both[1] === 18000, both.join(", "));
check("16,000 is Savrilium ×5 OR debris", verdict(16000) === "ore-or-debris"
  && data.index["16000"][0].name === "Savrilium", String(verdict(16000)));
check("18,000 is Bexalite ×5 OR debris", verdict(18000) === "ore-or-debris"
  && data.index["18000"][0].name === "Bexalite", String(verdict(18000)));

console.log("\ndebris and unknown");
check("a multiple of 2,000 with no rock is debris",
  [2000, 4000, 6000, 8000, 10000, 12000, 14000, 20000, 22000, 24000].every((s) => verdict(s) === "debris"));
check("in range, no rock, not a panel count -> unknown",
  verdict(2500) === "unknown" && verdict(4001) === "unknown" && verdict(15555) === "unknown",
  "4,001 was 'debris' under the old rule");
check("...including a near-miss on a real rock signature",
  verdict(3171) === "unknown", "Quantainium ×1 is 3,170");

// ── the 6/8 repair ────────────────────────────────────────────────────────────
// Sub: sixes and eights are the only digits that consistently come out wrong. The OCR can't be
// trained, but it doesn't need to be — a signature is one of ~165 legal values across 2,000-25,800,
// so a wrong digit almost always lands on a number that cannot exist. This asserts the repair over
// the REAL table, including that it refuses to guess where two rocks collide.
console.log("\nrepairing a confused 6/8 digit");
const legal = (n: number) => n >= 2000 && n <= MAX && (ore(n) || isDebrisValue(n));
const fix = (n: number) => repairConfusableDigits(n, legal);

check("3,565 -> 3,585 (Gold ×1)", fix(3565) === 3585, String(fix(3565)));
check("3,165 -> 3,185 (Stileron ×1)", fix(3165) === 3185, String(fix(3165)));
check("3,800 -> 3,600 (Bexalite ×1) — the swap goes both ways", fix(3800) === 3600, String(fix(3800)));
check("a value that is ALREADY legal is never touched",
  fix(3585) === null && fix(6800) === null && fix(2000) === null,
  "6,800 is Lindinium ×2 and must not become Ice ×2");
check("a number nothing can explain is left alone", fix(3566) === null && fix(9999) === null, String(fix(9999)));
check("a read with no 6 or 8 is left alone", fix(3577) === null && fix(12345) === null);
check("out of range stays out of range", fix(88) === null && fix(68888) === null, String(fix(68888)));
check("non-integers and negatives are refused", fix(NaN) === null && fix(3585.5) === null && fix(-3685) === null);

// The two collisions. Neither may ever be auto-corrected; the second is debris either way.
check("16,000 and 18,000 are left as they are (Savrilium ×5 vs Bexalite ×5)",
  fix(16000) === null && fix(18000) === null);
check("6,000 and 8,000 too (both debris, so it changes nothing anyway)",
  fix(6000) === null && fix(8000) === null);

// ── the TWO-digit extension (Rytharr, 2026-08-07) ──────────────────────────────
// A real read of 18,980 should have been 16,960 (Copper ×4) — two digits confused in the same
// number. Neither single-digit swap alone resolves to anything legal (16,980 and 18,960 are both
// nowhere near a real value), only flipping both at once does — this is exactly the case the
// one-swap-only version couldn't reach.
console.log("\nrepairing TWO confused 6/8 digits at once");
check("18,980 -> 16,960 (Copper ×4)", fix(18980) === 16960, String(fix(18980)));
check("a single swap of 18,980 alone resolves nothing (both are illegal)",
  !legal(16980) && !legal(18960));

// Exhaustive: every single-digit 6/8 misread of every legal value.
const swap1 = (s: string) => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "6" || c === "8") out.push(s.slice(0, i) + (c === "6" ? "8" : "6") + s.slice(i + 1));
  }
  return out;
};
const all = [...new Set([...Object.keys(data.index).map(Number),
  ...Array.from({ length: Math.floor(MAX / 2000) }, (_, i) => (i + 1) * 2000)])].filter(legal);
let recovered = 0, refused = 0, wrong = 0;
for (const v of all) {
  for (const mis of swap1(String(v))) {
    const n = Number(mis);
    if (legal(n)) continue;                       // collides with a real value — untouchable by design
    const got = fix(n);
    if (got === v) recovered++;
    else if (got === null) refused++;
    else { wrong++; console.log(`       ${n} -> ${got}, expected ${v}`); }
  }
}
check("a repair NEVER lands on the wrong value", wrong === 0, wrong + " wrong");
check(`most single-digit slips are recovered (${recovered} recovered, ${refused} refused as ambiguous)`,
  recovered >= 70 && refused <= 10, recovered + "/" + (recovered + refused));
// And a repair can only ever produce something the game could have shown.
check("every repair output is itself a legal signature",
  all.flatMap((v) => swap1(String(v))).map(Number).map(fix).filter((n): n is number => n !== null).every(legal));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
