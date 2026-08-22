/**
 * matchLocationToken — the join from the game's own location tokens to a starmap place.
 *
 * 🔴 THE REGRESSION THIS EXISTS FOR. `onBoard` accepted a name whose letters appear IN ORDER
 * inside the other, and required exactly one hit. "Ita" is a subsequence of "SeraphimStation"
 * (i…t…a), so Crusader's orbital station matched TWO places and the rule discarded the real
 * answer along with the coincidence. Sub, 2026-08-22, docked at RR_CRU_LEO: the log said so, the
 * parser produced it, the hauling tracker held it — and the Verse Finder still showed "Location
 * unknown" with no distances, because this function returned null.
 *
 * Run with:  npx tsx src/location-token.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchLocationToken } from "./hauling-locations.js";
import { HaulingDataStore } from "./hauling-data.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? "  [" + detail + "]" : ""}`);
};

const dataDir = join(import.meta.dirname, "..", "data");
const locs = JSON.parse(readFileSync(join(dataDir, "locations.json"), "utf8")).locations as
  Record<string, { name?: string }>;
const names = new Map<string, string>();
for (const [id, v] of Object.entries(locs)) if (v.name) names.set(id, v.name);
const data = new HaulingDataStore(dataDir);
const nameOf = (id: string | null): string | null => (id ? locs[id]?.name ?? id : null);

// Non-vacuous: if the board were empty every assertion below would pass for the wrong reason.
check("the starmap board is populated", names.size > 1000, String(names.size));

// ── The four orbital stations. RR = Rest & Relax, LEO = low orbit; nothing in the data says so. ──
for (const [token, want] of [
  ["RR_CRU_LEO", "Seraphim Station"],
  ["RR_HUR_LEO", "Everus Harbor"],
  ["RR_ARC_LEO", "Baijini Point"],
  ["RR_MIC_LEO", "Port Tressler"],
] as const) {
  const got = nameOf(matchLocationToken(token, names, data));
  check(`${token} resolves to ${want}`, got === want, String(got));
}

// ── The safety property is unchanged: one answer or none, never a guess. ──
check("a token that names nothing resolves to NOTHING",
  matchLocationToken("RR_ZZZ_LEO", names, data) === null,
  String(matchLocationToken("RR_ZZZ_LEO", names, data)));
check("so does an empty token", matchLocationToken("", names, data) === null);

console.log(failed ? `\nFAILED (${failed})` : "\nlocation-token tests passed");
process.exit(failed ? 1 : 0);
