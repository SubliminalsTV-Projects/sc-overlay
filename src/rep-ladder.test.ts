/**
 * Self-check for the reputation progress-bar math — repLadderPosition (estimate placed on
 * a scope's rank ladder) and familyAtLeast48 (the 4.8-wipe log window).
 * Run with:  npx tsx src/rep-ladder.test.ts
 * Exits non-zero on any failed case.
 */
import { repLadderPosition, familyAtLeast48, type RepScope } from "./missions.js";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

// The real FactionReputation ladder (the extractor's correctness oracle).
const FACTION: RepScope = {
  displayName: "Standing",
  ranks: [
    { minRep: 0, name: "Neutral" },
    { minRep: 800, name: "Jr. Contractor" },
    { minRep: 2200, name: "Contractor" },
    { minRep: 5800, name: "Sr. Contractor" },
    { minRep: 15000, name: "Veteran Contractor" },
    { minRep: 38000, name: "Head Contractor" },
    { minRep: 95250, name: "Elite Contractor" },
  ],
};
// Wikelo lists ranks BEST-first (descending minRep) — the tricky case.
const WIKELO: RepScope = {
  displayName: "Standing",
  ranks: [
    { minRep: 999, name: "Very Best Customer" },
    { minRep: 340, name: "Very Good Customer" },
    { minRep: 0, name: "New Customer" },
  ],
};

// --- witnessed sum drives the bar (the only trusted signal) ---
{
  const p = repLadderPosition(FACTION, 3000)!;
  check("witnessed 3000 -> Contractor", p.standing === "Contractor", `got ${p.standing}`);
  check("  next is Sr. Contractor @5800", p.nextName === "Sr. Contractor" && p.nextMin === 5800);
  check("  curMin 2200", p.curMin === 2200);
  check("  not max, has data", !p.max && !p.noData);
}

// --- the real regression: ~6,200 must read Senior, NOT Veteran (the mission-rank guess
//     used to push this to Veteran; rank_index is a difficulty tier, not a gate) ---
{
  const p = repLadderPosition(FACTION, 6200)!;
  check("witnessed 6200 -> Sr. Contractor (not Veteran)", p.standing === "Sr. Contractor", `got ${p.standing}`);
  check("  next Veteran Contractor @15000", p.nextName === "Veteran Contractor" && p.nextMin === 15000);
}

// --- no completions witnessed: noData, no faked standing ---
{
  const p = repLadderPosition(FACTION, 0)!;
  check("witnessed 0 -> noData", p.noData === true && p.estimate === 0);
  check("  sits at Neutral", p.standing === "Neutral");
}

// --- top of ladder ---
{
  const p = repLadderPosition(FACTION, 100000)!;
  check("above ceiling -> Elite Contractor, max", p.standing === "Elite Contractor" && p.max);
  check("  nextMin null at max", p.nextMin === null && p.nextName === null);
}

// --- Wikelo (descending list): sort-by-minRep still places correctly ---
{
  const p = repLadderPosition(WIKELO, 500)!;
  check("wikelo 500 -> Very Good Customer", p.standing === "Very Good Customer", `got ${p.standing}`);
  check("  estimate 500", p.estimate === 500);
  check("  next Very Best Customer @999", p.nextName === "Very Best Customer" && p.nextMin === 999);
}

// --- 4.8 wipe window ---
check("4.7 excluded", familyAtLeast48("4.7") === false);
check("4.8 included", familyAtLeast48("4.8") === true);
check("4.9 included", familyAtLeast48("4.9") === true);
check("4.23 included (numeric, not string, compare)", familyAtLeast48("4.23") === true);
check("5.0 included", familyAtLeast48("5.0") === true);
check("3.24 excluded", familyAtLeast48("3.24") === false);
check("unknown excluded (conservative)", familyAtLeast48(null) === false);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
