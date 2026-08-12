// Contract Manager list parsing, tested against a REAL capture.
//
// The fixture below is the verbatim output of tools/ocr-probe.mts over
// ScreenShot-2026-08-11_18-45-30-82C.jpg (3440x1440, Sub's own board, Mercenary
// expanded). Not hand-authored: a synthetic fixture would encode what I THINK the OCR
// returns, and every interesting property here — the height bands, the perspective drift
// in x, the fee row, the two-line titles — only shows up in the real thing.
//
//   npx tsx src/contract-list.test.ts

import { cleanCategory, parseAmount, parseContractList, normalizeTitle, splitTrailingAmount, stripTrailingDuration } from "./contract-list.js";
import type { OcrResult } from "./screen-read.js";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
}

// x, y, w, h, text — exactly as OCR returned them.
const RAW: [number, number, number, number, string][] = [
  [1520, 151, 199, 20, "ACCEPTED (0/10)"],
  [728, 243, 167, 21, "COLLECTION"],
  [737, 334, 129, 21, "DELIVERY"],
  [743, 423, 204, 21, "INVESTIGATION"],
  [747, 511, 164, 21, "MERCENARY"],
  [728, 599, 301, 16, "DEFEND REMOTE OUTPOST NEAR"],
  [726, 621, 289, 16, "YANG'S PLACE FROM OUTLAWS"],
  [727, 644, 192, 13, "CITIZENS FOR PROSPERITY"],
  [723, 719, 175, 15, "PILOT IN DISTRESS"],
  [723, 743, 193, 12, "CITIZENS FOR PROSPERITY"],
  [717, 818, 141, 16, "EASY PICKINGS"],
  [716, 843, 76, 12, "BIT ZEROS"],
  [709, 921, 326, 16, "SMALL COVALEX SHIPMENT NEEDS"],
  [706, 943, 121, 16, "RECOVERING"],
  [704, 967, 288, 13, "COVALEX INDEPENDENT CONTRACTORS"],
  [692, 1048, 313, 17, "DEFEND REMOTE OUTPOST NEAR"],
  [688, 1071, 331, 17, "CHAWLA'S BEACH FROM OUTLAWS"],
  [684, 1097, 202, 12, "CITIZENS FOR PROSPERITY"],
  [1143, 243, 11, 17, "2"],
  [1148, 335, 11, 16, "2"],
  [1141, 512, 24, 17, "24"],
  [1185, 616, 36, 17, "63k"],
  [1184, 727, 36, 16, "41k"],
  [1109, 827, 108, 17, "Fee:13500"],
  [1174, 939, 37, 17, "35k"],
  [1165, 1067, 37, 18, "63k"],
  // Right-hand pane + bottom nav — must all be ignored.
  [1802, 151, 97, 18, "HISTORY"],
  [1981, 150, 105, 19, "BEACONS"],
  [1957, 693, 213, 16, "Please select a contract."],
  [1291, 1330, 41, 12, "HOME"],
  [1655, 1330, 93, 15, "CONTRACTS"],
  [2323, 1330, 60, 14, "WALLET"],
];

const ocr: OcrResult = {
  w: 3440,
  h: 1440,
  lines: RAW.map(([x, y, w, h, text]) => ({ x, y, w, h, text })),
};

// ── parseAmount ────────────────────────────────────────────────────────────
check("63k -> 63000, rounded", JSON.stringify(parseAmount("63k")) === JSON.stringify({ amount: 63000, kind: "payout", rounded: true }));
check("Fee:13500 is a FEE, exact", JSON.stringify(parseAmount("Fee:13500")) === JSON.stringify({ amount: 13500, kind: "fee", rounded: false }));
check("1.5k -> 1500", parseAmount("1.5k")?.amount === 1500);
// 🔑 CASE IS NOT THE DISCRIMINATOR (Sub: "the capitalization shouldn't matter... it still
// reads the same thing"). It briefly was, which was fragile: the game sets its menus in
// capitals and OCR's idea of case at this size is unreliable. A duration is told apart by
// STRUCTURE — it carries an s or a second component — so both cases mean millions.
check("2M is 2 million", parseAmount("2M")?.amount === 2_000_000);
check("2m is also 2 million", parseAmount("2m")?.amount === 2_000_000);
check("63K is 63 thousand", parseAmount("63K")?.amount === 63_000);
check("plain 13500 is exact", JSON.stringify(parseAmount("13500")) === JSON.stringify({ amount: 13500, kind: "payout", rounded: false }));
check("comma grouping", parseAmount("134,500")?.amount === 134500);
// The row-count badges beside a category ("24") sit in the same column as the amounts.
check("row count 24 is not money", parseAmount("24") === null);
check("row count 2 is not money", parseAmount("2") === null);
check("words are not money", parseAmount("MERCENARY") === null);

// ── normalizeTitle ─────────────────────────────────────────────────────────
check(
  "curly and straight apostrophes normalise the same",
  normalizeTitle("Yang’s Place") === normalizeTitle("YANG'S PLACE"),
);
check("placeholder brackets survive", normalizeTitle("Defend near [NearbyLocation]").includes("[NEARBYLOCATION]"));

// ── parseContractList ──────────────────────────────────────────────────────
// The calibrated offers panel, as the app will pass it. Measured off the capture: the
// list sits between the panel's rounded border and the detail pane.
const PANEL = { x: 660, y: 200, w: 580, h: 1000 };
const rows = parseContractList(ocr, PANEL);
check("five contract rows", rows.length === 5, `got ${rows.length}: ${rows.map((r) => r.title).join(" | ")}`);

const byTitle = (frag: string) => rows.find((r) => r.title.includes(frag));

const yang = byTitle("YANG");
check("two-line title is joined", yang?.title === "DEFEND REMOTE OUTPOST NEAR YANG'S PLACE FROM OUTLAWS", yang?.title);
check("giver read", yang?.giver === "CITIZENS FOR PROSPERITY", String(yang?.giver));
check("category is the expanded one", yang?.category === "MERCENARY", String(yang?.category));
check("amount attached to the right row", yang?.amount === 63000, String(yang?.amount));
check("amount marked rounded", yang?.rounded === true);

const pilot = byTitle("PILOT IN DISTRESS");
check("one-line title stays one row", pilot?.title === "PILOT IN DISTRESS", pilot?.title);
check("one-line row gets its own amount", pilot?.amount === 41000, String(pilot?.amount));

// The whole reason this test exists: a cost must never be filed as a reward.
const easy = byTitle("EASY PICKINGS");
check("fee row is kind=fee", easy?.kind === "fee", String(easy?.kind));
check("fee row amount is the fee", easy?.amount === 13500, String(easy?.amount));
check("fee row giver", easy?.giver === "BIT ZEROS", String(easy?.giver));

const covalex = byTitle("COVALEX SHIPMENT");
check("second two-line title joined", covalex?.title === "SMALL COVALEX SHIPMENT NEEDS RECOVERING", covalex?.title);
check("its amount is 35k not the neighbour's", covalex?.amount === 35000, String(covalex?.amount));

const chawla = byTitle("CHAWLA");
check("last row parsed despite perspective drift", chawla?.amount === 63000, String(chawla?.amount));
check("last row giver", chawla?.giver === "CITIZENS FOR PROSPERITY", String(chawla?.giver));

// Nothing from the right-hand pane, the nav bar, or the collapsed categories.
check("no row titled BEACONS/HISTORY/CONTRACTS", !rows.some((r) => /BEACONS|HISTORY|CONTRACTS|WALLET|HOME/.test(r.title)));
check("collapsed categories produce no rows", !rows.some((r) => /^(COLLECTION|DELIVERY|INVESTIGATION)$/.test(r.title)));
check("every row has a title", rows.every((r) => r.title.length > 3));
check("every row got an amount", rows.every((r) => r.amount != null), rows.map((r) => `${r.title.slice(0, 18)}=${r.amount}`).join(", "));


// ═══════════════════════════════════════════════════════════════════════════
// Three more real captures (2026-08-11 20:05-20:06), taken specifically to break
// the parser. They did. Everything below is a case the first screenshot could not
// have shown, and every one of them is verbatim ocr-probe output.
// ═══════════════════════════════════════════════════════════════════════════

const mk = (rows: [number, number, number, number, string][]): OcrResult => ({
  w: 3440,
  h: 1440,
  lines: rows.map(([x, y, w, h, text]) => ({ x, y, w, h, text })),
});

// ── cm1: COLLECTION expanded. An EXPIRY TIMER under the payout, a row with a timer
//    and NO payout at all, and category icons OCR'd as stray characters. ──────────
const cm1 = mk([
  [720, 287, 169, 22, "COLLECTION"],
  [708, 377, 329, 16, "INTERESTED IN BUILDING A BETTER"],
  [709, 399, 85, 16, "FUTURE?"],
  [710, 422, 172, 12, "RAYARI INCORPORATED"],
  [712, 497, 134, 17, "VERY HUNGRY"], // its giver line never came back from OCR
  [735, 612, 205, 21, "INVESTIGATION"],
  [732, 700, 131, 20, "DELIVERY"],
  [727, 788, 169, 21, "MERCENARY"],
  [720, 876, 228, 21, "BOUNTY HUNTER"],
  [710, 966, 119, 21, "HAULING"],
  [649, 1052, 312, 29, "e SERVICE BEACONS"],
  [623, 1149, 246, 34, "5 HAND MINING"],
  [674, 782, 27, 34, "e,"], // pure icon noise on its own line
  [1138, 289, 12, 18, "2"],
  [1163, 383, 48, 17, "103k"],
  [1134, 412, 78, 13, "24m 52s"],
  [1137, 507, 78, 13, "59m SSS"], // OCR mangled "55s"
  [1145, 700, 11, 17, "2"],
  [1129, 789, 25, 16, "25"],
]);
const r1 = parseContractList(cm1, { x: 600, y: 250, w: 640, h: 950 });
const future = r1.find((r) => r.title.includes("BUILDING A BETTER"));
check("timer row: payout still read", future?.amount === 103000, String(future?.amount));
check("timer row: kind is payout", future?.kind === "payout", String(future?.kind));
check("timer row: giver read", future?.giver === "RAYARI INCORPORATED", String(future?.giver));
const hungry = r1.find((r) => r.title.includes("VERY HUNGRY"));
check("timer-only row exists", !!hungry, r1.map((r) => r.title).join(" | "));
// 🔴 The one that matters: 59m must NOT become 59,000,000 aUEC.
check("timer-only row has NO amount", hungry?.amount == null, String(hungry?.amount));
check("missing giver doesn't glue the next title on", hungry?.title === "VERY HUNGRY", hungry?.title);
check("icon noise never becomes a category", !r1.some((r) => r.category === "E," || r.category === "E"));
check("icon prefix stripped from category", !r1.some((r) => (r.category ?? "").startsWith("E ")));
check("cleanCategory strips a digit icon", cleanCategory("5 HAND MINING") === "HAND MINING", String(cleanCategory("5 HAND MINING")));
check("cleanCategory strips a two-digit icon", cleanCategory("15 SALVAGE") === "SALVAGE", String(cleanCategory("15 SALVAGE")));
check("cleanCategory strips 'b,'", cleanCategory("b, MERCENARY") === "MERCENARY", String(cleanCategory("b, MERCENARY")));
check("cleanCategory rejects pure noise", cleanCategory("e,") === null && cleanCategory("u") === null);
check("cleanCategory leaves a clean name alone", cleanCategory("BOUNTY HUNTER") === "BOUNTY HUNTER");

// ── cm2: INVESTIGATION expanded. "1M" is a MILLION-aUEC payout; "Sm 17s" is a timer
//    OCR'd badly. One character apart, opposite meanings. ─────────────────────────
const cm2 = mk([
  [719, 287, 169, 21, "COLLECTION"],
  [727, 377, 207, 21, "INVESTIGATION"],
  [710, 463, 287, 16, "JORRIT DOSSIER: LAB SAMPLE"],
  [711, 488, 137, 13, "HOCKROW AGENCY"],
  [734, 579, 130, 20, "DELIVERY"],
  [1148, 489, 66, 14, "Sm 17s"],
  [1146, 580, 11, 16, "2"],
]);
const r2 = parseContractList(cm2, { x: 600, y: 250, w: 640, h: 950 });
const jorrit = r2.find((r) => r.title.includes("JORRIT"));
check("Jorrit row parsed", !!jorrit, r2.map((r) => r.title).join(" | "));
// OCR dropped the "1M" glyph entirely on this capture — a real and tolerable outcome.
check("garbled timer is never money", jorrit?.amount == null, String(jorrit?.amount));
check("colon in the title survives", jorrit?.title === "JORRIT DOSSIER: LAB SAMPLE", jorrit?.title);
check("1M is a million-aUEC payout", parseAmount("1M")?.amount === 1_000_000, JSON.stringify(parseAmount("1M")));
check("1M is flagged rounded", parseAmount("1M")?.rounded === true);
// 🔴 The trap, stated three ways.
// ⚠️ The one residual, stated rather than hidden: a WHOLE-MINUTE countdown with no
// seconds part would read as millions. Never seen in any real capture — every countdown
// carried its seconds — and the alternative was keeping case as the discriminator, which
// is worse for the reasons above.
check("a bare 5m reads as millions (known, accepted)", parseAmount("5m")?.amount === 5_000_000);
check("'5m 17s' is not money", parseAmount("5m 17s") === null);
check("'24m 52s' is not money", parseAmount("24m 52s") === null);
check("'59m SSS' is not money", parseAmount("59m SSS") === null);
check("'Sm 17s' is not money", parseAmount("Sm 17s") === null);
check("bare '45s' is not money", parseAmount("45s") === null);

// ── cm3: DELIVERY expanded. Small values, and an ampersand OCR'd as a letter. ─────
const cm3 = mk([
  [732, 470, 130, 21, "DELIVERY"],
  [713, 557, 210, 16, "ICC SPECIAL DELIVERY"],
  [713, 581, 157, 13, "LING FAMILY HAULING"],
  [712, 655, 231, 17, "GASLIGHT HABS STROLL"],
  [712, 680, 119, 13, "ROUGH e READY"], // "ROUGH & READY"
  [1177, 565, 36, 17, "31k"],
  [1189, 665, 24, 16, "8k"],
]);
const r3 = parseContractList(cm3, { x: 600, y: 400, w: 640, h: 500 });
check("two delivery rows", r3.length === 2, r3.map((r) => `${r.title}=${r.amount}`).join(" | "));
check("31k on the right row", r3.find((r) => r.title.includes("ICC"))?.amount === 31000);
check("small 8k parsed", r3.find((r) => r.title.includes("GASLIGHT"))?.amount === 8000);
check("category applies to both", r3.every((r) => r.category === "DELIVERY"));

// ═══════════════════════════════════════════════════════════════════════════
// RAPIDOCR, off the LIVE board (2026-08-11). A different engine and a different
// problem. PP-OCR reads the characters far better than Windows OCR — which is why the
// board was switched to it — but it FUSES the columns, returning
// "INTERESTED IN BUILDING A BETTER 103k" as one detection. Column geometry cannot
// separate what the engine already joined, so this path matches against the game's own
// VOCABULARY (29 category names, 65 givers) instead of guessing from pixel heights.
// Height bands were hopeless here anyway: a title's wrapped second line ("FUTURe?", 17px)
// is the same size as a giver ("WIKELO", 16px).
// ═══════════════════════════════════════════════════════════════════════════
const VOCAB = {
  categories: ["Collection", "Delivery", "Investigation", "Mercenary", "Bounty Hunter", "Hauling", "Hand Mining", "Salvage"],
  givers: ["Rayari Incorporated", "Wikelo", "Ling Family Hauling", "Rough & Ready", "Bit Zeros"],
};
const liveOcr = mk([
  [36, 7, 618, 11, "1:USERLOG ATFU OIBM"],   // the panel's own chrome, decoded as garbage
  [116, 93, 428, 22, "COLLECTION 2"],        // category fused with its count
  [102, 182, 507, 27, "INTERESTED IN BUILDING A BETTER 103k"], // title fused with the price
  [104, 205, 87, 17, "FUTURe?"],             // wrapped line, same height as a giver
  [529, 216, 81, 19, "27m 29s"],             // a countdown on its own line
  [105, 229, 172, 12, "RAYARIINCORPORATED"], // giver, spaces lost
  [108, 304, 504, 26, "VERY HUNGRY 52m 8s"], // title fused with a countdown, no price at all
  [107, 328, 58, 16, "WIKELO"],
  [130, 419, 424, 22, "DELIVERY 2"],
  [123, 593, 430, 23, "MERCENARY 24"],
]);
const lv = parseContractList(liveOcr, { x: 0, y: 0, w: 654, h: 1008 }, VOCAB);
check("live board yields exactly the two real rows", lv.length === 2, lv.map((r) => r.title).join(" | "));
const better = lv.find((r) => r.title.startsWith("INTERESTED"));
check("fused price is split off the title", better?.amount === 103000, String(better?.amount));
check("wrapped second line joined, not read as a giver", (better?.title ?? "").includes("FUTUR"), better?.title);
check("giver recovered from spaceless OCR", better?.giver === "Rayari Incorporated", String(better?.giver));
check("category recovered from a fused count", better?.category === "COLLECTION", String(better?.category));
// 🔴 The countdown must reach neither the money nor the words.
const liveHungry = lv.find((r) => r.title.startsWith("VERY HUNGRY"));
check("fused countdown stripped from the title", liveHungry?.title === "VERY HUNGRY", hungry?.title);
check("items-only row still has no amount", liveHungry?.amount == null, String(liveHungry?.amount));
check("standalone countdown never becomes a title", !lv.some((r) => /\d+\s*m\b/i.test(r.title)));
check("panel chrome above the first category is dropped", !lv.some((r) => r.title.includes("USERLOG")));
// ── The panel chrome, sitting CLOSE to the first category ──────────────────────────────
// The existing "above the first category" check passes on the 2026-08-11 fixture without any
// help, because an 86px gap there flushes the stray on its own. Sub's 2026-08-12 sweep proved
// the gap cannot be relied on: the same chrome fused into titles four times
// ("1:USFR LOO NEED A HITTER", "T:USEN LOG KEEP ASTEROID MINING BASE SAFE"). This packs it
// tight against the board so distance cannot do the work, leaving the structural rule to.
const tight = mk([
  [45, 13, 50, 9, "1:USEN LOO"],             // the chrome, 9px, hard against the region top
  [126, 30, 427, 21, "MERCENARY 24"],        // category only 17px below it
  [102, 58, 507, 22, "NEED A HITTER 42k"],
  [105, 84, 172, 16, "HEADHUNTERS"],
]);
const tv = parseContractList(tight, { x: 0, y: 0, w: 654, h: 1008 },
  { categories: ["Mercenary"], givers: ["Headhunters"] });
check("chrome packed against the board still does not reach a title",
  tv.length === 1 && tv[0].title === "NEED A HITTER", tv.map((r) => r.title).join(" | "));
check("...and the row it would have broken parses whole",
  tv[0]?.amount === 42000 && tv[0]?.giver === "Headhunters", `${tv[0]?.amount} / ${tv[0]?.giver}`);

// 🔑 The escape hatch. Scrolled deep into one long category there may be no header in frame,
// and dropping "everything above the first category" would then drop the whole board.
const noHeader = mk([
  [102, 58, 507, 22, "NEED A HITTER 42k"],
  [105, 84, 172, 16, "HEADHUNTERS"],
]);
const nh = parseContractList(noHeader, { x: 0, y: 0, w: 654, h: 1008 },
  { categories: ["Mercenary"], givers: ["Headhunters"] });
check("with no category header in frame, nothing is dropped", nh.length === 1, String(nh.length));

// ── Digit confusions in the money column ───────────────────────────────────────────────
// "PILOT IN DISTRESS 4lk" cost twice over in one sweep: the 41,000 was lost AND "4lk" stayed
// in the title, so the dataset match failed too. splitTrailingAmount could not even reach it.
check("4lk reads as 41,000", parseAmount("4lk")?.amount === 41000, String(parseAmount("4lk")?.amount));
check("O for zero is rescued too", parseAmount("6O000")?.amount === 60000, String(parseAmount("6O000")?.amount));
const pd = splitTrailingAmount("PILOT IN DISTRESS 4lk");
check("...and it is split off the title, not left in it",
  pd.head === "PILOT IN DISTRESS" && pd.money?.amount === 41000, `${pd.head} / ${pd.money?.amount}`);
// 🔑 The guard that makes this safe: a real digit must already be present, or the rescue turns
// WORDS into money. "IIOO" parsing as 1,100 is a bug the mining scanner already paid for.
check("a word with no digit is never rescued into a number", parseAmount("IIOO") === null,
  JSON.stringify(parseAmount("IIOO")));
check("...nor one that would become a plausible amount", parseAmount("lOOk") === null,
  JSON.stringify(parseAmount("lOOk")));
// Still a duration, still refused — the rescue must not smuggle a countdown into the money slot.
check("a countdown is still not money after rescue", parseAmount("5m l7s") === null,
  JSON.stringify(parseAmount("5m l7s")));

check("stripTrailingDuration handles the mangled form", stripTrailingDuration("SOMETHING 59m SSS") === "SOMETHING");
check("stripTrailingDuration leaves a real title alone", stripTrailingDuration("SMALL COVALEX SHIPMENT") === "SMALL COVALEX SHIPMENT");

console.log(failures ? `
${failures} FAILED` : `
all checks passed`);
process.exit(failures ? 1 : 0);
