// Matching board rows to dataset contracts — run against the REAL shipped dataset, not a
// fixture, so the coverage numbers in contract-match.ts's header stay honest.
//
//   npx tsx src/contract-match.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContractMatcher, titlePattern, titleKey, sameName, type MatchCandidate } from "./contract-match.js";
import type { ContractRow } from "./contract-list.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

const DATA = join(process.cwd(), "data");
const ds = JSON.parse(readFileSync(join(DATA, "blueprints.latest.json"), "utf8")) as {
  missions: Record<string, { title: string; giver: string; missionType: string }>;
};
let detail: { missions?: Record<string, { location?: { systems?: string[] } }> } = {};
try {
  detail = JSON.parse(readFileSync(join(DATA, "blueprint-detail.latest.json"), "utf8"));
} catch {
  /* systems are optional — the matcher degrades to title+giver+type without them */
}

const candidates: MatchCandidate[] = Object.entries(ds.missions).map(([debugName, m]) => ({
  debugName,
  title: m.title,
  giver: m.giver,
  missionType: m.missionType,
  systems: detail.missions?.[debugName]?.location?.systems ?? [],
}));
const matcher = new ContractMatcher(candidates);

const row = (title: string, giver: string, category: string): ContractRow => ({
  category,
  title,
  giver,
  amount: null,
  kind: null,
  rounded: false,
  y: 0,
});

// ── titlePattern ───────────────────────────────────────────────────────────
// 🔑 Patterns match against titleKey(), which strips SPACES from both sides. OCR loses
// word breaks at this size — the live board returned "EXTRA SMALLCOVALEXSHIPMENT" and
// "COVALEXINDEPENDENT CONTRACTORS" — and a space is the one character whose absence
// carries no meaning here.
const re = titlePattern("Defend Remote Outpost near [NearbyLocation] from Outlaws")!;
check("placeholder becomes a wildcard", re.test(titleKey("DEFEND REMOTE OUTPOST NEAR YANGS PLACE FROM OUTLAWS")));
check("wrong suffix does not match", !re.test(titleKey("DEFEND REMOTE OUTPOST NEAR YANGS PLACE FROM MERCS")));
check("a title OCR ran together still matches", re.test(titleKey("DEFENDREMOTE OUTPOSTNEAR YANGSPLACE FROMOUTLAWS")));
// 🔴 ~70 dataset titles are themselves unresolved placeholders. As patterns they would
// swallow half the board.
check("an all-placeholder title is refused", titlePattern("[Destination] Errand") === null);
check("'[TargetName] needs stomping' still has real text", titlePattern("[TargetName] needs stomping") !== null);
check("ampersand mangled by OCR still matches", sameName("ROUGH e READY", "Rough & Ready"));
check("different givers do not match", !sameName("Bit Zeros", "Rough & Ready"));

// ── real rows, straight off Sub's four captures ────────────────────────────
const cases: [string, ContractRow, string | null][] = [
  ["Yang's Place", row("DEFEND REMOTE OUTPOST NEAR YANG'S PLACE FROM OUTLAWS", "CITIZENS FOR PROSPERITY", "MERCENARY"), null],
  ["Easy Pickings", row("EASY PICKINGS", "BIT ZEROS", "MERCENARY"), null],
  ["Covalex", row("SMALL COVALEX SHIPMENT NEEDS RECOVERING", "COVALEX INDEPENDENT CONTRACTORS", "MERCENARY"), null],
  ["ICC delivery", row("ICC SPECIAL DELIVERY", "LING FAMILY HAULING", "DELIVERY"), null],
  ["Jorrit dossier", row("JORRIT DOSSIER: LAB SAMPLE", "HOCKROW AGENCY", "INVESTIGATION"), null],
  ["Very Hungry", row("VERY HUNGRY", "WIKELO", "COLLECTION"), null],
  ["Better Future", row("INTERESTED IN BUILDING A BETTER FUTURE?", "RAYARI INCORPORATED", "COLLECTION"), null],
];
for (const [name, r, sys] of cases) {
  const out = matcher.match(r, sys);
  check(`${name}: resolves`, out.status === "matched" || out.status === "ambiguous", out.status);
  if (out.status === "matched") console.log(`         -> ${out.debugName} (${out.via})`);
  if (out.status === "ambiguous") console.log(`         -> ambiguous across ${out.candidates.length}`);
}

// A title that genuinely is not in the dataset must come back UNKNOWN, not be forced onto
// the nearest thing. This one is real: it was on Sub's board and our extraction never
// named it.
const gaslight = matcher.match(row("GASLIGHT HABS STROLL", "ROUGH & READY", "DELIVERY"), null);
check("a title we never extracted reads as unknown", gaslight.status === "unknown", gaslight.status);

// Garbage must never match.
check("nonsense is unknown", matcher.match(row("ZZZ QQQ WWW", "BIT ZEROS", "MERCENARY"), null).status === "unknown");
// A real title with an unreadable giver stays a candidate rather than being thrown out.
// The giver narrows, it does not gate — deliberately, because the live run showed the
// giver is the field OCR mangles most. Nothing is recorded either way; ambiguous simply
// keeps the row honest instead of pretending we never saw a contract we clearly did.
check(
  "a real title with a junk giver is ambiguous, not unknown",
  matcher.match(row("EASY PICKINGS", "NOBODY AT ALL", "MERCENARY"), null).status === "ambiguous",
);

// ── coverage, measured over the whole dataset ──────────────────────────────
// Round-trip every pool contract through its own displayed title. A dataset title with a
// placeholder is filled with a stand-in first, which is exactly what the board does.
const pooled = Object.entries(
  (JSON.parse(readFileSync(join(DATA, "blueprints.latest.json"), "utf8")) as {
    missions: Record<string, { title: string; giver: string; missionType: string; pools?: Record<string, unknown> }>;
  }).missions,
).filter(([, m]) => Object.keys(m.pools ?? {}).length);

let matched = 0;
let ambiguous = 0;
let unknown = 0;
for (const [, m] of pooled) {
  if (!m.title) continue; // a few contracts carry no title at all
  const displayed = m.title.replace(/\[[^\]]*\]/g, "SOMEWHERE");
  const out = matcher.match(row(displayed.toUpperCase(), m.giver, m.missionType), null);
  if (out.status === "matched") matched++;
  else if (out.status === "ambiguous") ambiguous++;
  else unknown++;
}
const total = pooled.length;
console.log(
  `\ncoverage over ${total} pool contracts: matched ${matched} (${((matched / total) * 100).toFixed(1)}%), ` +
    `ambiguous ${ambiguous}, unknown ${unknown}`,
);
// 🔑 TWO DIFFERENT COVERAGE NUMBERS, and conflating them overstates the result. This loop
// counts PER CONTRACT (22%): every one of the 762 pool contracts, including the 148
// same-titled hauling variants that can never be told apart from a board row. The number
// that matters to someone SCANNING is per distinct TITLE (61%), because a board shows
// titles, not debug_names — one ambiguous title is one wasted row, not 148.
// Both are real; the per-title figure is the one quoted in the module header.
//
// Guards, not targets — if a dataset refresh moves these a lot, someone should look.
// A handful of unknowns is CORRECT: those contracts' own titles are pure placeholders
// ("[Destination] Errand"), so they are deliberately absent from the index.
check("almost nothing round-trips to unknown", unknown <= 10, `${unknown} unknown`);
check("a fifth resolve uniquely per contract", matched / total > 0.2, `${((matched / total) * 100).toFixed(1)}%`);
check("nothing is silently dropped", matched + ambiguous + unknown > total * 0.99);

// ── The exact rows the first LIVE run threw away ───────────────────────────
// Both had a perfect title and a perfect price and were discarded on one mangled
// character in the giver, because candidates were bucketed by an EXACT giver key and a
// hash lookup has no way to be nearly right. Read off Sub's real board, 2026-08-11.
check("OCR 'UNG FAMILY HAULING' still finds Ling Family Hauling", sameName("UNG FAMILY HAULING", "Ling Family Hauling"));
check("OCR 'ROUGH B READY' still finds Rough & Ready", sameName("ROUGH B READY", "Rough & Ready"));
const live = matcher.match(row("ICC SPECIAL DELIVERY", "UNG FAMILY HAULING", "DELIVERY"), null);
check("the live ICC row now resolves", live.status === "matched", live.status);

// ...but tolerance must not become "anything goes".
check("a genuinely different giver is still rejected", !sameName("Bit Zeros", "Rough & Ready"));
check("two wrong characters is too many", !sameName("XXNG FAMILY HAULINX", "Ling Family Hauling"));

// 🔑 THE REAL GUARD, measured rather than reasoned about: does the slack ever conflate two
// givers that actually exist? Across all 65 in the dataset it produces exactly one pair,
// and that pair is the SAME giver spelled with different capitalisation in our own data
// ("Citizens for Prosperity" / "Citizens For Prosperity") — a duplicate, not a collision.
// A tightened threshold that broke the live rows would have passed a hand-written test;
// only this one says whether the tolerance is actually safe.
const allGivers = [...new Set(Object.values(ds.missions).map((m) => m.giver).filter(Boolean))];
const conflated: string[] = [];
for (let i = 0; i < allGivers.length; i++) {
  for (let j = i + 1; j < allGivers.length; j++) {
    if (sameName(allGivers[i], allGivers[j])) conflated.push(`${allGivers[i]} == ${allGivers[j]}`);
  }
}
const realCollisions = conflated.filter((c) => {
  const [a, b] = c.split(" == ");
  return a.toLowerCase() !== b.toLowerCase();
});
check(
  "the tolerance conflates no two genuinely different givers",
  realCollisions.length === 0,
  realCollisions.join(" | ") || `${allGivers.length} givers, ${conflated.length} case-only dupes`,
);

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
