/**
 * Dev tool: replay a whole game.log through the MissionTracker and print the final
 * tracked-mission view (pool with owned/needed) plus the collected list. Validates the
 * parser -> tracker -> dataset chain, including variant matching, against a real session.
 *
 *   npm run missions-replay -- "C:/.../GAME/Game.log" [stateDir]
 *
 * Pass a throwaway stateDir to avoid touching real %APPDATA% state.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseLine } from "./parser.js";
import { parseMissionEvent } from "./missions-parser.js";
import { MissionTracker } from "./missions.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

const logPath = process.argv[2] ?? "C:/Program Files/Roberts Space Industries/StarCitizen/GAME/Game.log";
const stateDir = process.argv[3] ?? join(here, "..", ".replay-state");

const tracker = new MissionTracker({ dataDir, stateDir });

const lines = readFileSync(logPath, "utf8").split(/\r?\n/);
for (const line of lines) {
  if (!line) continue;
  tracker.detectPatch(line);
  const ev = parseMissionEvent(parseLine(line));
  if (ev) tracker.apply(ev);
}

const v = tracker.view();
console.log(`patch:            ${v.patch}`);
console.log(`tracked contract: ${v.contractKey}`);
console.log(`title:            ${v.title}`);
console.log(`generator:        ${v.generator}`);
console.log(`has pool:         ${v.hasPool}`);
console.log(`collected total:  ${v.collectedTotal}`);
if (v.hasPool) {
  console.log(`\nPOOL  (${v.totals.owned}/${v.totals.total} owned):`);
  for (const pool of v.pools) {
    for (const b of pool.blueprints) {
      const mark = b.owned ? (b.source === "manual" ? "[~]" : b.source === "default" ? "[d]" : "[x]") : "[ ]";
      console.log(`  ${mark} ${b.name}${b.chance !== 1 ? `  (${Math.round(b.chance * 100)}%)` : ""}`);
    }
  }
}
