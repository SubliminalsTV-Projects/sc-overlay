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
  readRepPage, repReadPayload, repRankFromBars, repFloorForRank, barSearchBox, normRep,
  REP_HEADING_ALIASES,
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

// ── Fixture 3: Wikelo Emporium / BARTER & TRADE, 3 ranks ─────────────────────
// Verbatim OCR over Sub's own 3440x1440 capture, 2026-09-06 — the page he reported as "not
// working". It carries TWO independent defects at once and that is exactly why it is here:
//   · the section header comes back as "BARTER e TRADE" (Windows OCR reads the game's ampersand
//     as a lowercase e), which refused `no-section` — a refusal the capture loop does not even
//     forward, so it was silent as well as wrong;
//   · the heading is "WIKELO EMPORIUM" while the dataset giver is plain `Wikelo`.
// Fixing either alone still leaves the page unreadable, which is the point of keeping the frame
// whole rather than reducing it to the one line under test.
const SHOT3 = frame([
  L(2766, 145, 23, 23, "x"),
  L(1372, 147, 89, 19, "CAREER"),
  L(1543, 148, 98, 18, "DOSSIER"),
  L(1390, 264, 463, 37, "WIKELO EMPORIUM"),
  L(1392, 321, 109, 17, "NEUTRAL"),
  L(797, 336, 93, 20, "COVALE"),
  L(1409, 422, 260, 22, "BARTER e TRADE"),
  L(804, 491, 177, 17, "HEADHUNTERS"),
  L(806, 640, 384, 17, "INTERSEC DEFENSE SOLUTIONS"),
  L(2057, 662, 114, 15, "VERY BEST"),
  L(1740, 663, 117, 14, "VERY GOOD"),
  L(1423, 664, 163, 15, "NEW CUSTOMER"),
  L(1741, 683, 110, 15, "CUSTOMER"),
  L(2058, 683, 110, 14, "CUSTOMER"),
  L(2058, 707, 121, 11, "SPECIAL IDRIS-P"),
  L(1741, 708, 106, 11, "SPECIAL WOLF"),
  L(2059, 722, 140, 12, "BARTER CONTRACT"),
  L(1741, 723, 140, 11, "BARTER CONTRACT"),
  L(799, 790, 225, 18, "RECCO BATTAGLIA"),
  L(786, 942, 323, 19, "UNITED WAYFARERS CLUB"),
  L(746, 1103, 241, 20, "WIKELO EMPORIUM"),
  L(2214, 1323, 29, 13, "REP"),
  L(1646, 1327, 90, 14, "CONTRACTS"),
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
  // 🔴 A REFUSAL HAS TO SAY WHICH FACTION IT REFUSED. Sub reported "Covalex and Wikelo Emporium
  // don't seem to be working" and nothing anywhere said which page had been declined or why: the
  // three refusals a player can act on were the only ones reaching a human AND the only ones
  // absent from sidecar.log. Everything below the heading match is already known by this point,
  // so withholding it was never a safety property — just an omission.
  check("...and it names the faction heading it read", r.factionRaw === "BOUNTY HUNTERS GUILD",
    `[${r.factionRaw}]`);
  check("...and the section header", r.sectionRaw === "BOUNTY HUNTING", `[${r.sectionRaw}]`);
  check("...and whether the heading resolved to a giver at all",
    r.giver === "Bounty Hunters Guild", `[${r.giver}]`);
}
{
  // Nothing on screen names a scope we ship.
  const noSection = frame(SHOT1.lines.filter((l) => l.text !== "BOUNTY HUNTING"));
  const r = readRepPage(noSection, SCOPES, GIVERS);
  check("a page with no scope header is refused", r.refusal === "no-section", `[${r.refusal}]`);
  check("...and still names the faction, which is all it managed to read",
    r.factionRaw === "BOUNTY HUNTERS GUILD" && !r.sectionRaw,
    `[${r.factionRaw} / ${r.sectionRaw}]`);
}
{
  // 🔴 AN EMPTY `tried` ON A `no-scope` IS THE DIAGNOSIS, not a missing detail: it means the
  // candidate loop skipped everything on `giverScopeSet` — the heading resolved to a giver our
  // dataset says never awards the scope this page is showing. That is a DATA gap, and it is a
  // completely different fix from "we weighed real ladders and none matched", which produces the
  // SAME refusal string with a populated `tried`. This is the distinction the Covalex report
  // needs, so it is asserted rather than left to be re-derived from a log line.
  const starved = readRepPage(frame(SHOT1.lines), SCOPES,
    { "Bounty Hunters Guild": ["Wikelo"] });   // a giver that awards nothing on this page
  check("a giver that never awards the section's scope refuses no-scope",
    starved.refusal === "no-scope", `[${starved.refusal}]`);
  check("...with an EMPTY tried, which is what says it was a data gap and not a bad read",
    starved.tried.length === 0, `[${starved.tried.length} considered]`);
  check("...and still names the giver it resolved, so the gap is reportable",
    starved.giver === "Bounty Hunters Guild" && starved.sectionRaw === "BOUNTY HUNTING",
    `[${starved.giver} / ${starved.sectionRaw}]`);
  // POSITIVE CONTROL off the SAME frame: with the real giver map that identical page resolves and
  // `tried` is populated. Without it, everything above is equally consistent with the fixture
  // simply being unreadable — which would make "empty tried" mean nothing at all.
  const ok2 = readRepPage(frame(SHOT1.lines), SCOPES, GIVERS);
  check("...while the same frame with the real giver map reads fine and DID weigh ladders",
    ok2.refusal === null && ok2.tried.length > 0,
    `[${ok2.refusal} / ${ok2.tried.length} tried]`);
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

// ── The wire shape both routes send ──────────────────────────────────────────
{
  // 🔴 THE BUG THIS BLOCK EXISTS FOR: the projection from a RepLayoutResult to the JSON the
  // capture loop reads was written out BY HAND IN TWO PLACES — `/api/screen-read` (the one the
  // loop actually consumes) and `/api/rep-read`. Refusal detail was added to the second only, so
  // the field never arrived and the log confidently printed
  //   refused: no-scope (heading ? -> no giver matched) [no candidate ladders were even considered]
  // — asserting a DATA GAP about a frame nobody had asked, because an absent `tried` was
  // indistinguishable from an empty one. There is one projection now; this pins its contract so a
  // future field cannot be added to a route instead of to the shape.
  const good = repReadPayload(readRepPage(frame(SHOT1.lines), SCOPES, GIVERS));
  check("a good read is projected with everything the bar reader needs",
    good.ok === true && !!good.scope && !!good.cards && good.giver === "Bounty Hunters Guild",
    `[${good.scope} / ${good.giver}]`);

  const clipped = frame(SHOT1.lines.filter((l) => !(l.y > 980 && l.x > 2000)));
  const bad = repReadPayload(readRepPage(clipped, SCOPES, GIVERS));
  check("a refusal is projected with the heading, the section and the giver",
    bad.ok === false && bad.faction === "BOUNTY HUNTERS GUILD"
      && bad.section === "BOUNTY HUNTING" && bad.giver === "Bounty Hunters Guild",
    `[${bad.faction} / ${bad.section} / ${bad.giver}]`);
  // 🔑 `tried` must be PRESENT on every refusal, even when it is empty. An absent field and an
  // empty array mean opposite things to the log line that reads them, and conflating them is what
  // manufactured the false "data gap" verdict above.
  check("...and always carries `tried`, so absent and empty stay distinguishable",
    Array.isArray(bad.tried), `[${typeof bad.tried}]`);

  // 🔴 WHICH refusals reach the player is decided HERE, not in capture.cjs. It used to be an
  // ACTIONABLE_REP_REFUSALS set in the capture loop — a second copy of this module's own refusal
  // vocabulary, in the one file no suite can load.
  check("a scrolled ladder is reported to the player", bad.report === true, `[${bad.report}]`);
  check("...and a frame that is not the rep page at all is NOT",
    repReadPayload(readRepPage(frame([]), SCOPES, GIVERS)).report === false,
    `[no-heading -> ${repReadPayload(readRepPage(frame([]), SCOPES, GIVERS)).report}]`);
  // 🔴 THE WIKELO CLAUSE. `no-section` is normally the commonest refusal there is, so it is only
  // reported when the heading resolved to a giver we know — otherwise Sub's page fails with no
  // feedback anywhere, which is exactly what happened. Both halves asserted, or "report on
  // no-section" would look identical to "report on everything".
  const noSectionKnown = readRepPage(
    frame(SHOT1.lines.filter((l) => l.text !== "BOUNTY HUNTING")), SCOPES, GIVERS);
  check("a rep page whose section we cannot match IS reported when we know the faction",
    noSectionKnown.refusal === "no-section" && !!noSectionKnown.giver
      && repReadPayload(noSectionKnown).report === true,
    `[${noSectionKnown.refusal} / ${noSectionKnown.giver}]`);
  const noSectionUnknown = readRepPage(
    frame(SHOT1.lines.filter((l) => l.text !== "BOUNTY HUNTING")), SCOPES, { "Someone Else": [] });
  check("...and stays quiet on a no-section frame whose heading is nobody we know",
    noSectionUnknown.refusal === "no-section" && !noSectionUnknown.giver
      && repReadPayload(noSectionUnknown).report === false,
    `[${noSectionUnknown.refusal} / ${noSectionUnknown.giver}]`);

  // A refusal from BEFORE the heading is known projects nulls rather than omitting the keys —
  // the consumer can then tell "we never got that far" from "the field was not sent".
  const blank = repReadPayload(readRepPage(frame([]), SCOPES, GIVERS));
  check("a refusal with nothing read yet still projects the keys, as nulls",
    blank.ok === false && blank.refusal === "no-heading"
      && blank.faction === null && blank.section === null && Array.isArray(blank.tried),
    `[${blank.refusal} / ${blank.faction} / ${blank.section}]`);
}

// ── Heading aliases: what the GAME calls a faction vs what our dataset calls its giver ───────
{
  // 🔴 Measured on Sub's own live log: the REP page heading is "COVALEX" with a "HAULING"
  // section, and the dataset splits Covalex into `Covalex` (35 missions, Courier only) and
  // `Covalex Independent Contractors` (925, Hauling + Standing + Courier). The heading matched the
  // small one, which awards no Hauling, so a page he was staring at refused `no-scope` forever.
  const ds = JSON.parse(readFileSync("data/blueprints.latest.json", "utf8"))
    .missions as Record<string, { giver?: string; reputationGained?: { scope?: string }[] }>;
  const real: Record<string, Set<string>> = {};
  const missionCount: Record<string, number> = {};
  for (const m of Object.values(ds)) {
    if (!m.giver) continue;
    (real[m.giver] ??= new Set());
    missionCount[m.giver] = (missionCount[m.giver] ?? 0) + 1;
    for (const r of m.reputationGained ?? []) if (r.scope && SCOPES[r.scope]) real[m.giver].add(r.scope);
  }
  const realGivers = Object.fromEntries(Object.entries(real).map(([g, s]) => [g, [...s]]));

  // POSITIVE FIRST: the split this alias exists for is really in the shipped dataset. If CIG or a
  // regeneration ever merges the two spellings, everything below passes for free.
  check("the dataset really does split Covalex into two givers",
    !!realGivers["Covalex"] && !!realGivers["Covalex Independent Contractors"],
    `[Covalex ${missionCount["Covalex"]}m, CIC ${missionCount["Covalex Independent Contractors"]}m]`);
  check("...and only the big one awards Hauling, which is why the small one refused",
    !realGivers["Covalex"].includes("Hauling")
      && realGivers["Covalex Independent Contractors"].includes("Hauling"),
    `[Covalex ${realGivers["Covalex"]} | CIC ${realGivers["Covalex Independent Contractors"]}]`);

  for (const [heading, canon] of Object.entries(REP_HEADING_ALIASES)) {
    // ⚠️ An alias whose target is not a real giver silently does nothing — it falls through to the
    // ordinary match and the page goes on refusing, looking exactly like an unaliased build.
    check(`alias ${JSON.stringify(heading)} points at a giver that exists`,
      !!realGivers[canon], `[${canon}]`);
    check(`...and ${JSON.stringify(heading)} is already normRep form, or it can never match`,
      normRep(heading) === heading, `[${normRep(heading)}]`);
  }

  // 🔴 THE GUARD THAT MATTERS ON THE NEXT PATCH. The table is explicit BECAUSE a prefix rule is
  // the kind of heuristic that has burned this repo before — so the safety rests on there being
  // few enough pairs to inspect by hand. Pin the count: a dataset that grows a third one must
  // fail here rather than be silently mishandled by a table nobody revisited.
  const pairs: string[] = [];
  const names = Object.keys(realGivers);
  for (const a of names) for (const b of names) {
    if (a !== b && normRep(b).startsWith(normRep(a) + " ")) pairs.push(`${a} < ${b}`);
  }
  check("the dataset still has exactly the two hand-inspected prefix pairs",
    pairs.length === 2, pairs.join(" ; ") || "[none]");
  check("...and they are the two that were inspected",
    pairs.some((p) => p.startsWith("Covalex <"))
      && pairs.some((p) => p.toLowerCase().startsWith("civilian defense force <")),
    pairs.join(" ; "));
  // Civilian Defense Force is deliberately NOT aliased: both spellings award Emergency, so the
  // heading already resolves and it scans fine today. Asserting the reason, not just the absence.
  check("the un-aliased prefix pair really needs no alias — both spellings award the same scope",
    !REP_HEADING_ALIASES[normRep("Civilian Defense Force")]
      && realGivers["Civilian Defense Force"].includes("Emergency")
      && realGivers["CIVILIAN DEFENSE FORCE INITIATIVE"].includes("Emergency"),
    `[${realGivers["Civilian Defense Force"]} | ${realGivers["CIVILIAN DEFENSE FORCE INITIATIVE"]}]`);

  // And the alias actually changes the answer, driven through the real reader on the real frame.
  // SHOT1 is a Bounty Hunters Guild page, so stand a Covalex heading in for its own.
  const asCovalex = frame(SHOT1.lines.map((l) =>
    l.text === "BOUNTY HUNTERS GUILD" ? { ...l, text: "COVALEX" } : l));
  const aliased = readRepPage(asCovalex, SCOPES,
    { ...GIVERS, "Covalex": ["Courier"],
      "Covalex Independent Contractors": ["BountyHunter_BountyHuntersGuild"] });
  check("a COVALEX heading is attributed to the canonical giver, not the 35-mission one",
    aliased.layout?.giver === "Covalex Independent Contractors" && aliased.refusal === null,
    `[${aliased.layout?.giver ?? aliased.refusal}]`);
  // POSITIVE CONTROL: without the alias target in the map the same frame falls back to the
  // ordinary match and refuses — so the assertion above is about the ALIAS, not about the frame.
  const unaliased = readRepPage(asCovalex, SCOPES, { ...GIVERS, "Covalex": ["Courier"] });
  check("...and with only the small giver present it refuses, exactly as Sub saw",
    unaliased.refusal === "no-scope" && unaliased.giver === "Covalex" && unaliased.tried.length === 0,
    `[${unaliased.refusal} / ${unaliased.giver} / ${unaliased.tried.length} tried]`);
}

// ── The ampersand OCR reads as a lowercase e ─────────────────────────────────
{
  // 🔴 Measured, not supposed: Windows OCR returned "BARTER e TRADE" for the game's
  // "BARTER & TRADE". The scope's display name normalises to BARTER AND TRADE, so the header
  // could never match and the page refused `no-section` on every tick — and `no-section` is NOT
  // one of the refusals the capture loop forwards, so Sub got no message at all.
  check("the ampersand misread normalises to the same thing as a real ampersand",
    normRep("BARTER e TRADE") === normRep("Barter & Trade"),
    `[${normRep("BARTER e TRADE")} vs ${normRep("Barter & Trade")}]`);
  check("...and a real ampersand is unaffected",
    normRep("Rough & Ready") === "ROUGH AND READY", `[${normRep("Rough & Ready")}]`);
  check("...and the misread form of that one lands in the same place too",
    normRep("ROUGH e READY") === normRep("Rough & Ready"), `[${normRep("ROUGH e READY")}]`);
  // The repair only fires MID-phrase, which is the only position an ampersand occupies.
  check("a leading or trailing E is left alone",
    normRep("E TRADE") === "E TRADE" && normRep("BARTER E") === "BARTER E",
    `[${normRep("E TRADE")} | ${normRep("BARTER E")}]`);

  // 🔴 THE SAFETY ARGUMENT, ASSERTED AGAINST THE SHIPPED FILES rather than taken on trust —
  // exactly what the roman-numeral repair does, and for the same reason. The substitution is only
  // safe because the vocabulary is CLOSED: if any scope display name, rank name or dataset giver
  // ever contains a standalone E token, this repair starts corrupting a real name.
  const ds = JSON.parse(readFileSync("data/blueprints.latest.json", "utf8"))
    .missions as Record<string, { giver?: string }>;
  const vocab: string[] = [];
  for (const s of Object.values(SCOPES)) {
    if (s.displayName) vocab.push(s.displayName);
    for (const r of s.ranks) vocab.push(r.name);
  }
  for (const m of Object.values(ds)) if (m.giver) vocab.push(m.giver);
  // Positive first: the vocabulary was really assembled. An empty list satisfies the guard below
  // for free, and that is the one way this assertion could quietly stop meaning anything.
  check("the closed vocabulary was really assembled", vocab.length > 250, `[${vocab.length} entries]`);
  const withE = vocab.filter((v) => {
    // Read the RAW tokens, not normRep's output — normRep is the thing under test here.
    const t = v.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
    return t.some((x, i) => x.toUpperCase() === "E" && i > 0 && i < t.length - 1);
  });
  check("no shipped name has a standalone E the ampersand repair could corrupt",
    withE.length === 0, withE.join(" | ") || "(none)");
}

// ── The Wikelo page, end to end on the real capture ──────────────────────────
{
  // Both defects at once. Fixing either alone leaves the page unreadable.
  const r = readRepPage(SHOT3, SCOPES, { ...GIVERS, "Wikelo": ["Wikelo"] });
  check("shot3: the Wikelo page reads at all", r.refusal === null && !!r.layout, String(r.refusal));
  check("shot3: the ampersand-misread section still resolves to the right scope",
    r.layout?.scope === "Wikelo" && r.layout?.sectionRaw === "BARTER e TRADE",
    `[${r.layout?.scope} / ${r.layout?.sectionRaw}]`);
  check("shot3: the heading is aliased to the dataset giver rep is stored under",
    r.layout?.giver === "Wikelo", `[${r.layout?.giver}]`);
  check("shot3: the heading really is the longer in-game name, so the alias is load-bearing",
    r.layout?.factionRaw === "WIKELO EMPORIUM", `[${r.layout?.factionRaw}]`);
  check("shot3: all three ranks located, in order",
    r.layout?.cards.map((c) => c.rank).join(",") === "0,1,2",
    `[${r.layout?.cards.map((c) => c.rank).join(",")}]`);
  check("shot3: no card absorbed the BARTER CONTRACT reward text",
    r.layout?.cards.every((c) => !normRep(c.name).includes("CONTRACT")) === true,
    `[${r.layout?.cards.map((c) => c.name).join(" | ")}]`);
  // ⚠️ The left-hand faction list also says WIKELO EMPORIUM (and OCR dropped the X off COVALEX
  // there). The heading must be the LARGE one, not the list copy — the same trap SHOT1 guards.
  check("shot3: the heading is the large one, not the left-list copy",
    (r.layout?.cards[0]?.label.x ?? 0) > 1200, `[card0 x=${r.layout?.cards[0]?.label.x}]`);
}

console.log(failed ? `\nFAILED (${failed})` : "\nall rep-page checks passed");
process.exit(failed ? 1 : 0);
