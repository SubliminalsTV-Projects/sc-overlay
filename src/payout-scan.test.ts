// The scanner's bookkeeping: dedup, the title-group rule, and the things that must
// never be recorded.
//
//   npx tsx src/payout-scan.test.ts

import { ContractMatcher, type MatchCandidate } from "./contract-match.js";
import { PayoutScanner, type PayoutObservation } from "./payout-scan.js";
import type { ContractRow } from "./contract-list.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

// A tiny synthetic dataset: one title with three same-named variants (the Pyro region
// case), one unique title, and one title with more variants than the cap allows.
const cands: MatchCandidate[] = [
  { debugName: "HH_RegionA_DeepSpace", title: "Deep space hit", giver: "Headhunters", missionType: "Mercenary", systems: ["Pyro"] },
  { debugName: "HH_RegionB_DeepSpace", title: "Deep space hit", giver: "Headhunters", missionType: "Mercenary", systems: ["Pyro"] },
  { debugName: "HH_RegionC_DeepSpace", title: "Deep space hit", giver: "Headhunters", missionType: "Mercenary", systems: ["Pyro"] },
  { debugName: "Solo_Contract", title: "Pilot in Distress", giver: "Citizens for Prosperity", missionType: "Mercenary", systems: ["Pyro"] },
  ...Array.from({ length: 20 }, (_, i) => ({
    debugName: `Haul_${i}`, title: "Trainee Rank Small Cargo Haul",
    giver: "Covalex Independent Contractors", missionType: "Hauling", systems: ["Stanton"],
  })),
];
const matcher = new ContractMatcher(cands);

const row = (title: string, giver: string, amount: number | null, kind: "payout" | "fee" | null = "payout"): ContractRow => ({
  category: "Mercenary", title, giver, amount, kind, rounded: true, y: 0,
});

const drain = (sc: PayoutScanner): PayoutObservation[] => {
  const out: PayoutObservation[] = [];
  // flush() hands the batch to the poster; capture it and report success.
  void sc.flush(async (batch) => { out.push(...batch); return true; });
  return out;
};

// ── The title-group rule ───────────────────────────────────────────────────
// 🔑 Sub, after scanning his whole board: "if it has that title, then that's the price."
// Same-titled variants differ in reward POOL and LOCATION — never in aUEC.
{
  const sc = new PayoutScanner(matcher, "12344265");
  sc.ingest([row("DEEP SPACE HIT", "HEADHUNTERS", 27000)], null);
  check("an ambiguous title records for every variant", sc.pending() === 3, `${sc.pending()} queued`);
  check("counted as ONE recorded row, not three", sc.tally.recorded === 1, String(sc.tally.recorded));
  check("nothing left in the ambiguous bucket", sc.tally.ambiguous === 0, String(sc.tally.ambiguous));
}

// ── Dedup still holds across the group ─────────────────────────────────────
{
  const sc = new PayoutScanner(matcher, "12344265");
  sc.ingest([row("DEEP SPACE HIT", "HEADHUNTERS", 27000)], null);
  sc.ingest([row("DEEP SPACE HIT", "HEADHUNTERS", 27000)], null);
  check("re-reading the same board queues nothing new", sc.pending() === 3, `${sc.pending()} queued`);
  check("the repeat is counted as a duplicate", sc.tally.duplicate === 1, String(sc.tally.duplicate));
  // A DIFFERENT price for the same contract is a real second observation — that spread is
  // the thing worth having, and must not be swallowed by the dedup.
  sc.ingest([row("DEEP SPACE HIT", "HEADHUNTERS", 31000)], null);
  check("a different price IS a new observation", sc.pending() === 6, `${sc.pending()} queued`);
}

// ── The cap ────────────────────────────────────────────────────────────────
// Above it the title has stopped identifying a contract at all, and hauling is the one
// category whose pay plausibly scales with the run rather than the title.
{
  const sc = new PayoutScanner(matcher, "12344265");
  sc.ingest([row("TRAINEE RANK SMALL CARGO HAUL", "COVALEX INDEPENDENT CONTRACTORS", 9000)], null);
  check("a 20-variant title records nothing", sc.pending() === 0, `${sc.pending()} queued`);
  check("...and is reported as ambiguous", sc.tally.ambiguous === 1, String(sc.tally.ambiguous));
}

// ── Attribution is carried, so the site can tell them apart ────────────────
{
  const sc = new PayoutScanner(matcher, "12344265");
  sc.ingest([row("PILOT IN DISTRESS", "CITIZENS FOR PROSPERITY", 41000)], null);
  sc.ingest([row("DEEP SPACE HIT", "HEADHUNTERS", 27000)], null);
  const obs = drain(sc);
  const solo = obs.find((o) => o.contractKey === "Solo_Contract");
  const grouped = obs.find((o) => o.contractKey === "HH_RegionA_DeepSpace");
  check("a uniquely-resolved row is marked unique", solo?.attribution === "unique", String(solo?.attribution));
  check("a grouped row is marked title-group", grouped?.attribution === "title-group", String(grouped?.attribution));
  check("grouped rows carry the variant count", grouped?.variants === 3, String(grouped?.variants));
}

// ── The things that must NEVER be recorded ─────────────────────────────────
{
  const sc = new PayoutScanner(matcher, "12344265");
  sc.ingest([row("DEEP SPACE HIT", "HEADHUNTERS", 13500, "fee")], null);
  check("a FEE row records no payout", sc.pending() === 0, `${sc.pending()} queued`);
  check("...and is counted as a fee", sc.tally.feeOnly === 1);

  sc.ingest([row("DEEP SPACE HIT", "HEADHUNTERS", null, null)], null);
  check("a row with no price records nothing", sc.pending() === 0, `${sc.pending()} queued`);

  sc.ingest([row("SOMETHING NOT IN THE DATASET", "HEADHUNTERS", 5000)], null);
  check("an unmatched title records nothing", sc.pending() === 0, `${sc.pending()} queued`);
  check("...but its real name is kept for the dataset", sc.tally.unknownTitles.length === 1, sc.tally.unknownTitles.join(","));
}

// ── A failed upload must not lose the queue ────────────────────────────────
{
  const sc = new PayoutScanner(matcher, "12344265");
  sc.ingest([row("PILOT IN DISTRESS", "CITIZENS FOR PROSPERITY", 41000)], null);
  await sc.flush(async () => false);
  check("a refused upload keeps everything queued", sc.pending() === 1, `${sc.pending()} queued`);
  check("...and says why", sc.tally.lastFlushError !== null, String(sc.tally.lastFlushError));
  await sc.flush(async () => true);
  check("a successful upload clears it", sc.pending() === 0, `${sc.pending()} queued`);
  check("...and clears the error", sc.tally.lastFlushError === null);
}

// ── The deduced system must STICK for the session ──────────────────────────
// 🔴 It used to be recomputed from each screenful and reassigned every capture, null included.
// Measured on Sub's 2026-08-12 sweep: the system was never known once, and all 8 ambiguous
// rows were refuel contracts that resolve the moment it is — 19 same-titled variants collapse
// to 6 for Pyro, under the 12-variant cap. A board showing one category casts no votes at all
// when those contracts exist in every system, so "this screenful" is the wrong unit of
// evidence; the sweep is.
{
  const sc = new PayoutScanner(matcher, "12344265");

  // A screenful with nothing system-specific on it. Two rows, both Pyro-only in this fixture,
  // so this is the evidence-bearing capture.
  sc.ingest([
    row("DEEP SPACE HIT", "HEADHUNTERS", 63000),
    row("PILOT IN DISTRESS", "CITIZENS FOR PROSPERITY", 41000),
  ], null);
  check("the board deduces the system", sc.inferredSystem === "Pyro", String(sc.inferredSystem));

  // Now a capture that says nothing — the case that used to wipe it. Scrolling to a category
  // whose contracts exist everywhere is not evidence you have left the system.
  sc.ingest([row("TRAINEE RANK SMALL CARGO HAUL", "COVALEX INDEPENDENT CONTRACTORS", 12000)], null);
  check("a later screenful with no evidence does not un-know it",
    sc.inferredSystem === "Pyro", String(sc.inferredSystem));

  // And an empty capture — the board closed, or mobiGlas shut — likewise.
  sc.ingest([], null);
  check("...nor does an empty capture", sc.inferredSystem === "Pyro", String(sc.inferredSystem));
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
