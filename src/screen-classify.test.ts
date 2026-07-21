/**
 * Self-check for classifyScreen's fuzzy structural anchors — the kiosk is recognized and the
 * item located even when OCR mangles the anchor glyphs (4K / high UI-scale), instead of the
 * whole screen going unrecognized. Reproduces the real 4K failures: "FABRICATION" split into
 * "FABRICA TION", and the "Tier" label read as "Tie@".
 * Run with:  npx tsx src/screen-classify.test.ts
 * Exits non-zero on any failed case.
 */
import { classifyScreen, type OcrResult, type CatalogEntry } from "./screen-read.js";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const CATALOG: CatalogEntry[] = [
  { name: "Palisade", item: "15ebdff2-2724-4fb3-abbf-db20e150da77" },
  { name: "TS-2", item: "8ea47c7e-f70f-469d-abc2-911cc5013854" },
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
// A non-kiosk screen must NOT be taken for a fabricator.
const notKiosk = frame([
  ["INVENTORY", 200, 100],
  ["Vehicles SHIELDS", 400, 500],
  ["Tier", 700, 500],
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

const notRead = classifyScreen(notKiosk, CATALOG);
check("non-kiosk screen is NOT a fabricator", notRead.kind !== "fabricator", notRead.kind);

const unRead = classifyScreen(unreadable, CATALOG);
check("kiosk-but-unreadable -> fabricator with no item", unRead.kind === "fabricator" && unRead.item === null);

if (failed) {
  console.error(`\n${failed} case(s) FAILED`);
  process.exit(1);
}
console.log("\nall screen-classify cases passed");
