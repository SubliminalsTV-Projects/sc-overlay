/**
 * Run the journal consistency audit against a REAL `trade-journal.json`.
 *
 *   npm run audit:journal                       %APPDATA%/sc-blueprint-tracker/trade-journal.json
 *   npm run audit:journal -- <path-to-file>     any journal, e.g. one a user sent in
 *
 * Exits 0 when the file agrees with itself, 1 when it does not - so it can sit in front of a
 * support conversation and answer the question rather than starting one.
 *
 * 🔴 IT READS AND PRINTS. IT NEVER WRITES. The only safe repair for a drifted journal is deleting
 * the whole file, and this tool deliberately cannot do that for you: editing rows out is what
 * causes the state it reports, and an automatic "fix" here would be the same mistake with a
 * progress bar. See `src/trade-journal-audit.ts`.
 *
 * 🔑 NOT A UNIT TEST, AND NOT IN ANY `test:` SCRIPT, because it needs a real journal on the machine
 * it runs on. `test:jaudit` is the one that runs everywhere. Same contract as `measure:tradeconfirm`
 * and `measure:itemshops`: a claim you can re-run is a fact; one written into a comment rots.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditJournal, describeAudit } from "../src/trade-journal-audit.js";

const defaultPath = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"),
  "sc-blueprint-tracker",
  "trade-journal.json",
);
const path = process.argv[2] ?? defaultPath;

let raw: string;
try {
  raw = readFileSync(path, "utf8");
} catch (e) {
  // No journal is not a failure. A player who has never traded has nothing to audit, and saying
  // "DRIFT" at them would be the crying-wolf failure this whole subsystem is written to avoid.
  console.log(`no journal at ${path} - nothing to audit (${(e as Error).message})`);
  process.exit(0);
}

let state: unknown;
try {
  state = JSON.parse(raw);
} catch (e) {
  console.log(`🔴 ${path} is not valid JSON: ${(e as Error).message}`);
  console.log("The app reads this as \"nothing recorded yet\" and carries on, so the journal is");
  console.log("effectively empty. Deleting the file is the clean way to say the same thing.");
  process.exit(1);
}

const report = auditJournal(state as Parameters<typeof auditJournal>[0]);
console.log(`${path}`);
console.log(`rows: ${report.rows.runs} run(s), ${report.rows.unmatched} unmatched, ` +
  `${report.rows.open} open lot(s), ${report.rows.writtenOff} written off`);
console.log(describeAudit(report));
process.exit(report.ok ? 0 : 1);
