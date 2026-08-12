// Contract Manager list parsing, tested against a REAL capture.
//
// The fixture below is the verbatim output of tools/ocr-probe.mts over
// ScreenShot-2026-08-11_18-45-30-82C.jpg (3440x1440, Sub's own board, Mercenary
// expanded). Not hand-authored: a synthetic fixture would encode what I THINK the OCR
// returns, and every interesting property here — the height bands, the perspective drift
// in x, the fee row, the two-line titles — only shows up in the real thing.
//
//   npx tsx src/contract-list.test.ts

import { cleanCategory, parseAmount, parseContractList, normalizeTitle } from "./contract-list.js";
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
// Written before the 20:05 captures taught me that lowercase m is MINUTES. Kept as a
// negative assertion rather than deleted — this exact line is what the bug looked like.
check("lowercase 2m is NOT 2 million", parseAmount("2m") === null);
check("uppercase 2M IS 2 million", parseAmount("2M")?.amount === 2_000_000);
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
check("lowercase 5m is NOT 5 million", parseAmount("5m") === null);
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

console.log(failures ? `
${failures} FAILED` : `
all checks passed`);
process.exit(failures ? 1 : 0);
