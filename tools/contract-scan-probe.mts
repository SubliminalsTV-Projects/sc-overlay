// End-to-end dry run of the payout scanner over still captures: OCR -> parse -> match.
// Nothing is uploaded. This is how a calibration region gets checked BEFORE anyone sits
// in-game dragging a box, and how a bad read gets diagnosed afterwards.
//
//   npx tsx tools/contract-scan-probe.mts <image> [x y w h]      # fractions of the frame
//
// With no region it uses DEFAULT_CONTRACT_REGION, which is what the app starts from.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ocrImage, stopOcrWorker } from "../src/screen-read.js";
import { parseContractList } from "../src/contract-list.js";
import { ContractMatcher, type MatchCandidate } from "../src/contract-match.js";

/** Where the mobiGlas offers panel sits, as fractions of the frame.
 *
 *  Measured across four real 3440x1440 captures, not guessed: the left column starts as
 *  far left as x=623 (a category whose icon OCR'd into the line) and the amount column
 *  ends by x=1221, so 0.175..0.365 covers both with room. Vertically it must EXCLUDE the
 *  "MARK ALL READ" header at y≈146 and the nav bar at y≈1326 — both are ordinary text at
 *  ordinary heights, and letting either in pushes the column boundary past the amounts. */
export const DEFAULT_CONTRACT_REGION = { x: 0.175, y: 0.135, w: 0.19, h: 0.7 };

const img = process.argv[2];
if (!img) {
  console.error("usage: npx tsx tools/contract-scan-probe.mts <image> [x y w h]");
  process.exit(1);
}
const [ax, ay, aw, ah] = process.argv.slice(3).map(Number);
const frac = Number.isFinite(ax) ? { x: ax, y: ay, w: aw, h: ah } : DEFAULT_CONTRACT_REGION;

const DATA = join(process.cwd(), "data");
const ds = JSON.parse(readFileSync(join(DATA, "blueprints.latest.json"), "utf8")) as {
  version: string;
  missions: Record<string, { title: string; giver: string; missionType: string }>;
};
let detail: { missions?: Record<string, { location?: { systems?: string[] } }> } = {};
try {
  detail = JSON.parse(readFileSync(join(DATA, "blueprint-detail.latest.json"), "utf8"));
} catch {}
const candidates: MatchCandidate[] = Object.entries(ds.missions).map(([debugName, m]) => ({
  debugName, title: m.title, giver: m.giver, missionType: m.missionType,
  systems: detail.missions?.[debugName]?.location?.systems ?? [],
}));
const matcher = new ContractMatcher(candidates);

const ocr = await ocrImage(img);
const rect = { x: frac.x * ocr.w, y: frac.y * ocr.h, w: frac.w * ocr.w, h: frac.h * ocr.h };
const rows = parseContractList(ocr, rect);

console.log(`${img.split(/[\\/]/).pop()}  ${ocr.w}x${ocr.h}  dataset ${ds.version}`);
console.log(`region  x${rect.x.toFixed(0)} y${rect.y.toFixed(0)} ${rect.w.toFixed(0)}x${rect.h.toFixed(0)}  ->  ${rows.length} rows\n`);
for (const r of rows) {
  const out = matcher.match(r, null);
  const money =
    r.amount == null ? "     —" : `${r.kind === "fee" ? "fee " : ""}${r.amount.toLocaleString("en-US")}${r.rounded ? "~" : ""}`;
  const verdict =
    out.status === "matched" ? `-> ${out.debugName}` :
    out.status === "ambiguous" ? `?? ${out.candidates.length} candidates` : "?? no dataset match";
  console.log(`  [${(r.category ?? "-").padEnd(14)}] ${money.padStart(12)}  ${r.title.slice(0, 46).padEnd(46)} ${verdict}`);
  if (r.giver) console.log(`${" ".repeat(19)}${r.giver}`);
}
stopOcrWorker();
