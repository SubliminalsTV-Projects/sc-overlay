/**
 * Self-check for classifyScreen's fuzzy structural anchors — the kiosk is recognized and the
 * item located even when OCR mangles the anchor glyphs (4K / high UI-scale), instead of the
 * whole screen going unrecognized. Reproduces the real 4K failures: "FABRICATION" split into
 * "FABRICA TION", and the "Tier" label read as "Tie@".
 * Run with:  npx tsx src/screen-classify.test.ts
 * Exits non-zero on any failed case.
 */
import { classifyScreen, resolveName, stripSizeGrade, type OcrResult, type CatalogEntry } from "./screen-read.js";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const CATALOG: CatalogEntry[] = [
  { name: "Palisade", item: "15ebdff2-2724-4fb3-abbf-db20e150da77" },
  { name: "TS-2", item: "8ea47c7e-f70f-469d-abc2-911cc5013854" },
  { name: "XL-1", item: "fce50a6d-690e-4b2d-9104-f3743387e1f0" },
  { name: "Aegis Dynamics S0", item: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
];

// Build an OcrResult from [text, x, y] rows (w/h don't matter for these gates).
const frame = (rows: [string, number, number][]): OcrResult => ({
  w: 3840, h: 2160,
  lines: rows.map(([text, x, y]) => ({ text, x, y, w: 200, h: 30 })),
});

// Shield: "FABRICATION" OCR-split to "FABRICA TION"; category line clean, "Tier" its own fragment.
const shield = frame([
  ["FABRICA TION KIOSK //FABRICATE", 325, 122],
  ["PALISADE", 2349, 1058],
  ["Vehicles SHIELDS", 2346, 1126],
  ["Tier", 2707, 1126],
  ["X close", 3411, 115],
]);
// Quantum drive: split title AND "Tier" mangled to "Tie@", category line mangled to "Vehicles DRIVES".
const qd = frame([
  ["FABRICA TION KIOSK //FABRICATE", 355, 140],
  ["TS-2", 2339, 1059],
  ["Vehicles DRIVES", 2339, 1125],
  ["Tie@", 2828, 1114],
  ["X close", 3411, 130],
]);
// Quantum drive "XL-1": OCR reads the digit 1 as the letter I ("XL-I") — a real Cryojenix
// contribution frame. The exact-pass 1<->I fold must still resolve it to XL-1.
const xl1 = frame([
  ["FABRICATION KIOSK //FABRICATE", 355, 140],
  ["XL-I", 2380, 1059],
  ["Vehicles QUANTUM DRIVES", 2339, 1125],
  ["Tier", 2828, 1114],
  ["X close", 3411, 130],
]);
// A non-kiosk screen must NOT be taken for a fabricator.
const notKiosk = frame([
  ["INVENTORY", 200, 100],
  ["Vehicles SHIELDS", 400, 500],
  ["Tier", 700, 500],
]);
// Another common OCR failure: a zero in a size suffix is read as the letter O, e.g. "S0"
// becomes "SO". The resolver should still match the catalog entry.
const s0 = frame([
  ["FABRICATION KIOSK //FABRICATE", 355, 140],
  ["SO", 2380, 1059],
  ["Vehicles SHIELDS", 2339, 1125],
  ["Tier", 2828, 1114],
  ["X close", 3411, 130],
]);
// Kiosk anchor present but the item area is unreadable (name/category didn't come through) ->
// a fabricator read with no item, so the capture loop can tell the user rather than fail silently.
const unreadable = frame([
  ["FABRICA TION KIOSK //FABRICATE", 355, 140],
  ["X close", 3411, 130],
]);

const shieldRead = classifyScreen(shield, CATALOG);
check("shield: split anchor still classifies as fabricator", shieldRead.kind === "fabricator", shieldRead.kind);
check("shield: resolves to Palisade", shieldRead.kind === "fabricator" && shieldRead.item === CATALOG[0].item);

const qdRead = classifyScreen(qd, CATALOG);
check("QD: split anchor + 'Tie@' still classifies", qdRead.kind === "fabricator", qdRead.kind);
check("QD: resolves to TS-2", qdRead.kind === "fabricator" && qdRead.item === CATALOG[1].item);

const xl1Read = classifyScreen(xl1, CATALOG);
check("QD: 'XL-I' (digit-1 misread) resolves to XL-1", xl1Read.kind === "fabricator" && xl1Read.item === CATALOG[2].item, xl1Read.kind === "fabricator" ? String(xl1Read.item) : xl1Read.kind);

const notRead = classifyScreen(notKiosk, CATALOG);
check("non-kiosk screen is NOT a fabricator", notRead.kind !== "fabricator", notRead.kind);

const unRead = classifyScreen(unreadable, CATALOG);
check("kiosk-but-unreadable -> fabricator with no item", unRead.kind === "fabricator" && unRead.item === null);

const s0Read = classifyScreen(s0, CATALOG);
check("size-zero 'SO' still classifies as fabricator", s0Read.kind === "fabricator");

// ── The kiosk's size/grade prefix (punkhiji, 0.1.36, 2026-08-03) ─────────────────────────────
// His radars and components "wouldn't capture". The kiosk prints a manufacturer/size/grade tag
// ahead of the name ("IND/2/B BROADSPEC") that the DATASET never carries, and the tag's tokens
// sank the whole-word overlap below its 0.6 floor — so the item resolved to nothing at all and
// the capture reported "couldn't identify this item". Not reproducible on Sub's machine: another
// player's log has the same items with no tag, so only a shared log could have found it.
{
  const PREFIX_CATALOG: CatalogEntry[] = [
    { name: "BroadSpec", item: "11111111-1111-1111-1111-111111111111" },
    { name: "BroadSpec-Go", item: "22222222-2222-2222-2222-222222222222" },
    { name: "BroadSpec-Max", item: "33333333-3333-3333-3333-333333333333" },
    { name: "Permafrost", item: "44444444-4444-4444-4444-444444444444" },
  ];
  check("the size/grade tag is stripped", stripSizeGrade("IND/2/B BroadSpec") === "BroadSpec", stripSizeGrade("IND/2/B BroadSpec"));
  check("a mixed-case manufacturer too", stripSizeGrade("Mil/2/B Permafrost") === "Permafrost", stripSizeGrade("Mil/2/B Permafrost"));
  check("an untagged name is untouched", stripSizeGrade("BroadSpec") === "BroadSpec");
  // Only a LEADING tag goes. A slash mid-name is part of the name.
  check("a slash elsewhere is untouched", stripSizeGrade("Widget A/B Thing") === "Widget A/B Thing", stripSizeGrade("Widget A/B Thing"));

  const tagged = resolveName("IND/2/B BROADSPEC", PREFIX_CATALOG);
  check("a tagged name now resolves at all", tagged.name === "BroadSpec", `${tagged.name} (${tagged.match})`);
  // Exact, not a fuzzy near-miss — the variants below only stay separable because of that.
  check("...on the EXACT pass", tagged.match === "exact", tagged.match);
  const go = resolveName("IND/2/B BROADSPEC-GO", PREFIX_CATALOG);
  check("...and -Go stays a distinct item", go.name === "BroadSpec-Go", `${go.name} (${go.match})`);
  check("an untagged name still resolves", resolveName("Permafrost", PREFIX_CATALOG).name === "Permafrost");
}

if (failed) {
  console.error(`\n${failed} case(s) FAILED`);
  process.exit(1);
}
console.log("\nall screen-classify cases passed");
