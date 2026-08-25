/** keepayear — how long the SIDECAR BLOCKS to judge one backup.
 *  readFileSync + scrubGameLog are synchronous, so this is dead event loop: every widget frozen.
 *  Read-only. Usage: npx tsx tools/probe-keepayear-cost.ts */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasShareSignal } from "../src/log-share.js";
import { scrubGameLog } from "../src/log-scrub.js";
const dir = process.argv[2] ?? "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/logbackups";
const rows = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".log"))
  .map((n) => { try { return { n, size: statSync(join(dir, n)).size }; } catch { return null; } })
  .filter((x): x is { n: string; size: number } => !!x && x.size > 0)
  .sort((a, b) => b.size - a.size);
const pick = [...rows.slice(0, 5), ...rows.slice(Math.floor(rows.length / 2), Math.floor(rows.length / 2) + 5)];
console.log("largest 5, then median 5:");
let worst = 0;
for (const r of pick) {
  const t0 = performance.now();
  const raw = readFileSync(join(dir, r.n), "utf8");
  const tRead = performance.now() - t0;
  const t1 = performance.now();
  const sig = hasShareSignal(raw);
  const tSig = performance.now() - t1;
  const t2 = performance.now();
  if (sig) scrubGameLog(raw);
  const tScrub = performance.now() - t2;
  const total = tRead + tSig + tScrub;
  if (total > worst) worst = total;
  console.log(`  ${(r.size / 1048576).toFixed(1).padStart(6)} MB  read ${tRead.toFixed(0).padStart(5)}ms  signal ${tSig.toFixed(0).padStart(5)}ms  scrub ${tScrub.toFixed(0).padStart(6)}ms  TOTAL ${total.toFixed(0).padStart(6)}ms  ${sig ? "upload" : "reject"}`);
}
console.log(`\nworst single file: ${worst.toFixed(0)}ms of BLOCKED event loop`);
console.log(`a tick of 5 uploads worst-case: ~${(worst * 5 / 1000).toFixed(1)}s blocked`);
