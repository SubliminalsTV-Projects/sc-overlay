/**
 * Dev tool: replay a game.log through the mission/blueprint parser and print the
 * timeline of accepts, tracked-mission markers, completions, and received blueprints.
 *
 *   npm run missions-dump -- "C:/Program Files/Roberts Space Industries/StarCitizen/GAME/Game.log"
 *
 * Use it to sanity-check parsing against a real session before wiring the overlay.
 */
import { readFileSync } from "node:fs";
import { parseLine } from "./parser.js";
import { parseMissionEvent, type MissionEvent } from "./missions-parser.js";

const DEFAULT_LOG = "C:/Program Files/Roberts Space Industries/StarCitizen/GAME/Game.log";
const path = process.argv[2] ?? DEFAULT_LOG;

const text = readFileSync(path, "utf8");
const lines = text.split(/\r?\n/);

const events: MissionEvent[] = [];
for (const line of lines) {
  if (!line) continue;
  const ev = parseMissionEvent(parseLine(line));
  if (ev) events.push(ev);
}

const counts: Record<string, number> = {};
for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;

const short = (id: string | null) => (id ? id.slice(0, 8) : "--------");
const fmt = (e: MissionEvent): string => {
  switch (e.kind) {
    case "accept":
      return `ACCEPT   [${short(e.missionId)}] ${e.title ?? ""}`;
    case "marker":
      return `TRACK    [${short(e.missionId)}] ${e.contractKey}  (${e.generator})`;
    case "activeObjective":
      return `ACTIVE   [${short(e.missionId)}] obj=${short(e.objectiveId)}`;
    case "end":
      return `END      [${short(e.missionId)}] ${e.state}`;
    case "blueprintReceived":
      return `BLUEPRINT  «${e.name}»  (mission ${short(e.missionId)})`;
    case "sessionStart":
      return `SESSION  (PU entered / server change)`;
  }
};

console.log(`Parsed ${lines.length} lines from ${path}`);
console.log(`Mission/blueprint events: ${events.length}`, counts);
console.log("\n--- timeline ---");
for (const e of events) {
  const ts = e.ts ? e.ts.slice(11, 19) : "        ";
  console.log(`${ts}  ${fmt(e)}`);
}

// Distinct tracked contracts seen (these are the pool keys to look up).
const contracts = new Map<string, number>();
for (const e of events) if (e.kind === "marker") contracts.set(e.contractKey, (contracts.get(e.contractKey) ?? 0) + 1);
console.log("\n--- distinct tracked contracts (pool keys) ---");
for (const [c, n] of [...contracts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)}x  ${c}`);

// Distinct blueprints received.
const bps = new Map<string, number>();
for (const e of events) if (e.kind === "blueprintReceived") bps.set(e.name, (bps.get(e.name) ?? 0) + 1);
console.log("\n--- distinct blueprints received ---");
for (const [b, n] of [...bps.entries()].sort()) console.log(`  ${n}x  ${b}`);
