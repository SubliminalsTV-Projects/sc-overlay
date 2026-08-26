/**
 * Self-check for the 4.10 REP page reader.
 * Run with:  npx tsx src/rep-page.test.ts     (or `npm run test:reppage`)
 * Exits non-zero on any failed case.
 *
 * 🔑 THE FIXTURES ARE REAL. Every OCR line below is verbatim `npx tsx tools/ocr-probe.mts`
 * output over the two 3440x1440 stills Sub captured off the 4.10 PTU on 2026-08-26, including
 * the lines that are nothing to do with this page (the left-hand faction list, the bottom nav,
 * the TEST VERSION banner). Those are the point: a reader that only works once the noise has
 * been removed by hand has not been tested against anything the app will ever be handed.
 *
 * The bar readings are likewise measured, not invented — peak luminance 216-218 for a green
 * bar against 83-94 for a grey one, over a card fill of 61-72.
 */
import { readFileSync } from "node:fs";
import {
  readRepPage, repRankFromBars, repFloorForRank, barSearchBox, normRep,
  type RepScopes, type RepBarRead,
} from "./rep-page.js";
import type { OcrLine, OcrResult } from "./screen-read.js";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

const SCOPES: RepScopes = JSON.parse(readFileSync("data/rep-scopes.json", "utf8")).scopes;

/** `x,y,w,h,text` exactly as the probe printed it. */
function L(x: number, y: number, w: number, h: number, text: string): OcrLine {
  return { x, y, w, h, text };
}
const frame = (lines: OcrLine[]): OcrResult => ({ w: 3440, h: 1440, lines });

// ── Fixture 1: Bounty Hunters Guild / BOUNTY HUNTING, 8 ranks ────────────────
const SHOT1 = frame([
  L(664, 151, 162, 27, "Q SEARCH"),
  L(810, 296, 297, 19, "BOUNTY HUNTERS GUILD"),
  L(820, 449, 305, 18, "CIVILIAN DEFENSE FORCE"),
  L(970, 1299, 159, 23, "16.764259"),
  L(1072, 1406, 130, 14, "TEST VERSION"),
  L(1382, 153, 88, 18, "CAREER"),
  L(1553, 152, 97, 19, "DOSSIER"),
  L(2784, 143, 24, 23, "x"),
  L(1404, 266, 609, 39, "BOUNTY HUNTERS GUILD"),
  L(1402, 326, 108, 18, "NEUTRAL"),
  L(1419, 427, 259, 22, "BOUNTY HUNTING"),
  L(1434, 669, 139, 14, "NOT ELIGIBLE"),
  L(1427, 995, 157, 15, "GUILD MEMBER"),
  L(2069, 666, 159, 14, "PROBATIONARY"),
  L(2070, 687, 154, 14, "GUILD MEMBER"),
  L(2070, 712, 86, 11, "ADDITIONAL"),
  L(2070, 727, 87, 11, "CONTRACTS"),
  L(2078, 993, 168, 15, "VETERAN GUILD"),
  L(2081, 1014, 86, 14, "MEMBER"),
  L(2082, 1041, 89, 11, "ADDITIONAL"),
  L(2083, 1057, 90, 11, "CONTRACTS"),
  L(2387, 665, 144, 15, "JUNIOR GUILD"),
  L(2388, 686, 85, 13, "MEMBER"),
  L(2389, 711, 87, 10, "ADDITIONAL"),
  L(2390, 726, 87, 11, "CONTRACTS"),
  L(2407, 992, 61, 15, "GUILD"),
  L(2409, 1013, 101, 15, "STEWARD"),
  L(2411, 1040, 90, 12, "ADDITIONAL"),
  L(2413, 1056, 90, 12, "CONTRACTS"),
  L(2450, 1331, 64, 13, "LANDING"),
  L(1290, 1331, 41, 13, "HOME"),
  L(1233, 1405, 102, 15, "This is an"),
  L(1348, 1405, 50, 18, "early"),
  L(1425, 1020, 90, 11, "ADDITIONAL"),
  L(1425, 1036, 90, 12, "CONTRACTS"),
  L(1411, 1330, 58, 13, "HEALTH"),
  L(1411, 1405, 100, 15, "test build"),
  L(1542, 1330, 55, 13, "COMMS"),
  L(1525, 1405, 71, 15, "and not"),
  L(1751, 668, 114, 14, "APPLICANT"),
  L(1753, 993, 148, 15, "SENIOR GUILD"),
  L(1753, 1014, 86, 15, "MEMBER"),
  L(1753, 1041, 89, 11, "ADDITIONAL"),
  L(1753, 1057, 90, 12, "CONTRACTS"),
  L(1655, 1332, 90, 13, "CONTRACTS"),
  L(1809, 1332, 42, 12, "MAPS"),
  L(1609, 1405, 311, 18, "indicative of gameplay/content"),
  L(1926, 1331, 69, 13, "JOURNAL"),
  L(1932, 1405, 62, 15, "on the"),
  L(2060, 1330, 59, 13, "ASSETS"),
  L(2007, 1405, 132, 15, "official live"),
  L(2225, 1329, 29, 13, "REP"),
  L(2321, 1331, 59, 13, "WALLET"),
  L(2286, 1406, 81, 14, "12510549"),
  L(2576, 1330, 73, 13, "VEHICLES"),
  L(2152, 1409, 71, 11, "servers."),
]);

// ── Fixture 2: Civilian Defense Force / EMERGENCY SUPPORT, 5 ranks ───────────
const SHOT2 = frame([
  L(666, 148, 28, 27, "Q"),
  L(713, 148, 115, 27, "SEARCH"),
  L(811, 293, 297, 19, "BOUNTY HUNTERS GUILD"),
  L(804, 442, 311, 18, "CIVILIAN DEFENSE FORCE"),
  L(1072, 1406, 130, 14, "TEST VERSION"),
  L(1383, 150, 88, 18, "CAREER"),
  L(1553, 149, 98, 18, "DOSSIER"),
  L(2787, 139, 24, 23, "x"),
  L(1405, 262, 629, 40, "CIVILIAN DEFENSE FORCE"),
  L(1402, 323, 108, 17, "NEUTRAL"),
  L(1420, 422, 333, 22, "EMERGENCY SUPPORT"),
  L(1435, 665, 139, 14, "NOT ELIGIBLE"),
  L(1427, 991, 167, 14, "VETERAN FIRST"),
  L(1428, 1012, 125, 15, "RESPONDER"),
  L(2070, 663, 58, 15, "FIRST"),
  L(2071, 683, 123, 15, "RESPONDER"),
  L(2070, 704, 87, 13, "TRAINEE"),
  L(2390, 662, 58, 14, "FIRST"),
  L(2390, 683, 123, 14, "RESPONDER"),
  L(2451, 1327, 64, 13, "LANDING"),
  L(1291, 1328, 41, 12, "HOME"),
  L(1233, 1405, 102, 15, "This is an"),
  L(1348, 1405, 50, 18, "early"),
  L(1413, 1328, 57, 13, "HEALTH"),
  L(1411, 1405, 100, 15, "test build"),
  L(1544, 1327, 55, 13, "COMMS"),
  L(1525, 1405, 71, 15, "and not"),
  L(1752, 664, 114, 15, "APPLICANT"),
  L(1656, 1327, 90, 12, "CONTRACTS"),
]);

/** The giver -> scope map the app builds from the shipped dataset. Only the entries these two
 *  pages need, plus the ones that make the ambiguous cases real. */
const GIVERS: Record<string, string[]> = {
  "Bounty Hunters Guild": ["BountyHunter_BountyHuntersGuild"],
  "Civilian Defense Force": ["Emergency"],
  "Hurston Dynamics": ["Security", "BountyHunter", "Affinity"],
  "Northrock Service Group": ["BountyHunter", "FactionReputation", "Security", "Courier"],
};

// ── The two real pages read correctly ────────────────────────────────────────
{
  const r = readRepPage(SHOT1, SCOPES, GIVERS);
  check("shot1: the page is read at all", r.refusal === null && !!r.layout, String(r.refusal));
  const l = r.layout!;
  check("shot1: faction heading is the LARGE one, not the left-list copy",
    l?.factionRaw === "BOUNTY HUNTERS GUILD", `[${l?.factionRaw}]`);
  check("shot1: resolves to the guild scope, not the generic one",
    l?.scope === "BountyHunter_BountyHuntersGuild", `[${l?.scope}]`);
  check("shot1: joins to the dataset giver", l?.giver === "Bounty Hunters Guild", `[${l?.giver}]`);
  check("shot1: section header captured", l?.sectionRaw === "BOUNTY HUNTING", `[${l?.sectionRaw}]`);
  check("shot1: the standing word is kept but is NOT the section",
    l?.standingRaw === "NEUTRAL" && l?.standingRaw !== l?.sectionRaw, `[${l?.standingRaw}]`);
  // Positive-first: there ARE cards, before anything asserts what is in them.
  check("shot1: all 8 ladder ranks located", l?.cards.length === 8, `[${l?.cards.length}]`);
  check("shot1: cards are in ladder order and complete",
    l?.cards.map((c) => c.rank).join(",") === "0,1,2,3,4,5,6,7",
    `[${l?.cards.map((c) => c.rank).join(",")}]`);
  // The two "Guild Member"-containing names must not have stolen each other's lines.
  const byRank = new Map(l?.cards.map((c) => [c.rank, c]) ?? []);
  check("shot1: rank 2 is the two-line Probationary Guild Member",
    byRank.get(2)?.name === "Probationary Guild Member", `[${byRank.get(2)?.name}]`);
  check("shot1: rank 4 is the one-line Guild Member, at its own card",
    byRank.get(4)?.name === "Guild Member" && byRank.get(4)!.label.x < 1500,
    `[${byRank.get(4)?.name} x=${byRank.get(4)?.label.x}]`);
  check("shot1: no card absorbed the ADDITIONAL CONTRACTS reward text",
    l?.cards.every((c) => !normRep(c.name).includes("ADDITIONAL")) === true);
}
{
  const r = readRepPage(SHOT2, SCOPES, GIVERS);
  check("shot2: the page is read at all", r.refusal === null && !!r.layout, String(r.refusal));
  const l = r.layout!;
  check("shot2: resolves to Emergency", l?.scope === "Emergency", `[${l?.scope}]`);
  check("shot2: joins to the dataset giver", l?.giver === "Civilian Defense Force", `[${l?.giver}]`);
  check("shot2: all 5 ladder ranks located", l?.cards.length === 5, `[${l?.cards.length}]`);
  check("shot2: three-line rank name assembled",
    l?.cards.find((c) => c.rank === 2)?.name === "First Responder Trainee",
    `[${l?.cards.find((c) => c.rank === 2)?.name}]`);
}

// ── The ladder separates two scopes sharing a display name ───────────────────
//
// "Bounty Hunting" is the display name of BOTH `BountyHunter` and
// `BountyHunter_BountyHuntersGuild`. Their ladders differ, so shot 1 is decidable even with no
// giver map at all — which is the case for a faction the dataset has never seen.
{
  const r = readRepPage(SHOT1, SCOPES);
  check("shot1 with NO giver map: still resolves, on the ladder alone",
    r.refusal === null && r.layout?.scope === "BountyHunter_BountyHuntersGuild",
    `[${r.refusal ?? r.layout?.scope}]`);
  check("shot1 with NO giver map: reports no giver rather than guessing one",
    r.layout?.giver === null, `[${r.layout?.giver}]`);
  const generic = r.tried.find((t) => t.scope === "BountyHunter");
  check("shot1: the losing candidate was really considered and really lost",
    !!generic && generic.matched > 0 && generic.matched < generic.of,
    `[BountyHunter ${generic?.matched}/${generic?.of}]`);
}

// ── Refusals ─────────────────────────────────────────────────────────────────
{
  // A scrolled page: the last two cards are off screen.
  const clipped = frame(SHOT1.lines.filter((l) => !(l.y > 980 && l.x > 2000)));
  const r = readRepPage(clipped, SCOPES, GIVERS);
  check("a partly-visible ladder is REFUSED, not read at the wrong index",
    r.layout === null && r.refusal === "cards-incomplete", `[${r.refusal}]`);
}
{
  // Nothing on screen names a scope we ship.
  const noSection = frame(SHOT1.lines.filter((l) => l.text !== "BOUNTY HUNTING"));
  const r = readRepPage(noSection, SCOPES, GIVERS);
  check("a page with no scope header is refused", r.refusal === "no-section", `[${r.refusal}]`);
}
{
  // Two equally-large headings: we cannot tell which faction this is.
  const twoHeads = frame([...SHOT1.lines, L(1404, 700, 609, 39, "SOME OTHER ORG")]);
  const r = readRepPage(twoHeads, SCOPES, GIVERS);
  check("two same-size headings are refused rather than picked between",
    r.refusal === "heading-not-decisive", `[${r.refusal}]`);
}
{
  const r = readRepPage(frame([]), SCOPES, GIVERS);
  check("an empty frame is refused", r.refusal === "no-heading", `[${r.refusal}]`);
}

// ── Where the bar box lands ──────────────────────────────────────────────────
//
// Measured on shot 1: the APPLICANT card's label is at (1751,668,h14) and its bar really runs
// x 1748..1917 at y=650. The box has to contain that, and must NOT reach the neighbouring
// PROBATIONARY card's bar, which starts at x=2066.
{
  const applicant = L(1751, 668, 114, 14, "APPLICANT");
  const box = barSearchBox(applicant, 3440, 1440, 2069);
  const contains = (x: number, y: number) =>
    x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
  check("bar box contains the measured bar's left end", contains(1748, 650), JSON.stringify(box));
  check("bar box contains the measured bar's right end", contains(1917, 650), JSON.stringify(box));
  check("bar box does not reach down into the label", box.y + box.h < 668, `bottom=${box.y + box.h}`);

  // ⚠️ At this text size the 16h cap, not the neighbour clamp, is what keeps the box out of the
  // next card — the two agree to the pixel (1975). So "it stops short of the next card" would
  // pass with the clamp deleted, and is NOT evidence the clamp works. Assert each mechanism
  // where it is the one that binds.
  const lone = barSearchBox(applicant, 3440, 1440);
  check("with no neighbour at all, the 16h cap keeps the box inside the column pitch",
    lone.x + lone.w < 2066 && lone.w < 317, `right=${lone.x + lone.w} w=${lone.w}`);
  check("...and that cap is what decides it here, so the clamp is belt-and-braces",
    lone.x + lone.w === box.x + box.w, `${lone.x + lone.w} vs ${box.x + box.w}`);
  // Now a neighbour close enough that the clamp is the only thing that can stop the box.
  const tight = barSearchBox(applicant, 3440, 1440, 1880);
  check("a close neighbour DOES pull the box in — the clamp binds",
    tight.x + tight.w < 1880 && tight.x + tight.w < lone.x + lone.w,
    `right=${tight.x + tight.w}`);

  // Anchored on the text, so a different UI scale moves it proportionally.
  const big = barSearchBox(L(3502, 1336, 228, 28, "APPLICANT"), 6880, 2880, 4138);
  check("the box scales with the text rather than with the frame",
    Math.abs((big.y - 1336) / 28 - (box.y - 668) / 14) < 0.01,
    `${(big.y - 1336) / 28} vs ${(box.y - 668) / 14}`);
}

// ── Bars to a rank ───────────────────────────────────────────────────────────
//
// Shot 1, measured: Not Eligible grey, Applicant green 100%, Probationary green 19%, the rest
// grey. Shot 2: Not Eligible grey, Applicant green 8%, the rest grey.
const bars = (spec: [boolean, number][]): RepBarRead[] =>
  spec.map(([reached, fill], rank) => ({ rank, found: true, reached, fill }));

{
  const r = repRankFromBars(bars([
    [false, 0], [true, 1.0], [true, 0.19], [false, 0], [false, 0], [false, 0], [false, 0], [false, 0],
  ]));
  check("shot1 bars: current rank is Probationary Guild Member (2)", r.rank === 2, `[${r.rank}]`);
  check("shot1 bars: progress is the CURRENT rank's own fill", r.progress === 0.19, `[${r.progress}]`);
  check("shot1: the floor that puts under the player is rank 2's minRep",
    repFloorForRank(SCOPES.BountyHunter_BountyHuntersGuild, 2) === 1,
    `[${repFloorForRank(SCOPES.BountyHunter_BountyHuntersGuild, 2)}]`);
}
{
  const r = repRankFromBars(bars([[false, 0], [true, 0.08], [false, 0], [false, 0], [false, 0]]));
  check("shot2 bars: current rank is Applicant (1)", r.rank === 1, `[${r.rank}]`);
  check("shot2: Applicant's floor is 0, and 0 is a real answer",
    repFloorForRank(SCOPES.Emergency, 1) === 0, `[${repFloorForRank(SCOPES.Emergency, 1)}]`);
}
{
  // 🔴 Not Eligible ships at -1000 (and -320000 on Emergency). A negative floor would DROP a
  // witnessed total below zero on a re-baseline, so it is clamped rather than passed through.
  check("a negative Not Eligible floor is clamped to 0",
    repFloorForRank(SCOPES.Emergency, 0) === 0, `[${repFloorForRank(SCOPES.Emergency, 0)}]`);
  check("...and the raw dataset value really IS negative, so the clamp is doing work",
    SCOPES.Emergency.ranks.find((x) => x.name === "Not Eligible")!.minRep < 0);
}
{
  const r = repRankFromBars(bars([[false, 0], [false, 0], [false, 0]]));
  check("no green anywhere is refused, not read as rank 0",
    r.rank === null && r.refusal === "no-rank-reached", `[${r.refusal}]`);
}
{
  const r = repRankFromBars(bars([[true, 1], [false, 0], [true, 0.4], [false, 0]]));
  check("a gap in the green run is refused", r.rank === null && r.refusal === "rank-not-contiguous",
    `[${r.refusal}]`);
}
{
  const spec = bars([[false, 0], [true, 1], [true, 0.19]]);
  spec[2].found = false;
  const r = repRankFromBars(spec);
  check("one unreadable bar refuses the whole page",
    r.rank === null && r.refusal === "bars-unreadable", `[${r.refusal}]`);
}
{
  check("no bars at all is refused", repRankFromBars([]).refusal === "bars-unreadable");
}

// ── Normalisation ────────────────────────────────────────────────────────────
{
  check("case and punctuation fall out", normRep("Jr. Runner") === normRep("JR RUNNER"));
  check("an ampersand becomes a word", normRep("Rough & Ready") === "ROUGH AND READY");
  check("OCR's l-for-I in a roman numeral is repaired", normRep("Rank Ill") === normRep("Rank III"));
  check("a pipe for an I is repaired too", normRep("Rank |V") === normRep("Rank IV"));
  check("a word that is not all-roman is untouched",
    normRep("Live") === "LIVE" && normRep("Villa") === "VILLA");
  // The repair cannot tell "Ill" from a mis-read "III", so it normalises both. That is only safe
  // because the vocabulary is closed — assert that against the shipped ladders rather than
  // asserting it about the code, so a future dataset that breaks it fails HERE.
  const allRoman = Object.values(SCOPES)
    .flatMap((s) => s.ranks.map((r) => r.name))
    .filter((n) => n.split(/[^A-Za-z0-9]+/).some((t) => t.length >= 2 && /^[ilvx]+$/i.test(t)
      && !/^[IVX]+$/.test(t)));
  check("no shipped rank name is an all-roman-letter WORD the repair could mangle",
    allRoman.length === 0, allRoman.join(" | ") || "(none)");
}

console.log(failed ? `\nFAILED (${failed})` : "\nall rep-page checks passed");
process.exit(failed ? 1 : 0);
