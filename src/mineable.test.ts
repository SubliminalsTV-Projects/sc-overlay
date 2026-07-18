/**
 * Self-check for the mining signature parser + lookup.
 * Run with:  npx tsx src/mineable.test.ts
 * Exits non-zero on any failed case.
 */
import { parseSignature, parseDuration } from "./screen-read.js";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// parseSignature — the real OCR forms seen on the scan HUD (icon junk + comma/no-comma).
check("comma form '2 2,000'", parseSignature("2 2,000"), 2000);
check("no-comma form '2 2000'", parseSignature("2 2000"), 2000);
check("o-for-0 '....2,ooo'", parseSignature("....2,ooo"), 2000);
check("real rock '3,170'", parseSignature("3,170"), 3170);
check("icon + rock 'x 25,800'", parseSignature("x 25,800"), 25800);
check("period-as-comma '3.170'", parseSignature("3.170"), 3170);
check("icon-merged '33170' rejected (>30000)", parseSignature("33170"), null);
check("no number", parseSignature("STRONG"), null);
check("too small '900'", parseSignature("900"), null);

// parseDuration — refinery countdowns.
check("41m 35s", parseDuration("41m 35s"), 41 * 60 + 35);
check("14h 53m", parseDuration("14h 53m"), 14 * 3600 + 53 * 60);
check("spaced '1 h 5 m'", parseDuration("1 h 5 m"), 3600 + 5 * 60);
check("OCR '11h'->'Ilh 10m'", parseDuration("Ilh 10m"), 11 * 3600 + 10 * 60);
check("OCR 'Ilh 47m'", parseDuration("Ilh 47m"), 11 * 3600 + 47 * 60);
check("OCR '9h'->'gh 20m'", parseDuration("gh 20m"), 9 * 3600 + 20 * 60);
check("OCR 'IOh 4m'", parseDuration("IOh 4m"), 10 * 3600 + 4 * 60);
check("OCR '8h'->'Bh 58m' (8h not dropped, 58 kept)", parseDuration("Bh 58m"), 8 * 3600 + 58 * 60);
check("real '53m 52s' unaffected", parseDuration("53m 52s"), 53 * 60 + 52);
check("no duration", parseDuration("PROCESSING"), null);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
