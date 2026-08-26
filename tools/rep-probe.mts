// Dry-run the whole REP-page chain over a still: OCR -> ladder match -> bar pixels -> rank.
// Reads a file, writes nothing, touches no config and posts nothing anywhere.
//
//   npm run probe:reppage -- <image> [<image> ...]
//
// Written the same way `contract-scan-probe.mts` was, and for the same reason: the parser has
// to be built and checked against what the OCR ACTUALLY returns over a real frame, not against
// what the screenshot looks like to a human. It drives the REAL modules — `readRepPage` from
// src, `readBars` from electron/ — through the real two-process split, so a green probe is
// evidence about the shipping path rather than about a copy of it.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ocrImage, stopOcrWorker } from "../src/screen-read.js";
import { readRepPage, repRankFromBars, repFloorForRank, type RepScopes, type RepBarRead } from "../src/rep-page.js";

const images = process.argv.slice(2);
if (!images.length) {
  console.error("usage: npm run probe:reppage -- <image> [<image> ...]");
  process.exit(1);
}

const scopes: RepScopes = JSON.parse(readFileSync("data/rep-scopes.json", "utf8")).scopes;

/** giver -> the scope keys that giver's missions award, straight off the shipped dataset. This
 *  is the third join, and the only thing that separates the ladders that are character-identical
 *  (Courier vs Courier_TransportGuild, Security vs Security_MercenaryGuild, the four Mercenary
 *  scopes). The app builds the same map from the same file. */
function giverScopes(): Record<string, string[]> {
  const path = ["data/blueprints.latest.json"].find((p) => existsSync(p));
  if (!path) return {};
  const d = JSON.parse(readFileSync(path, "utf8"));
  const out: Record<string, Set<string>> = {};
  for (const m of Object.values<any>(d.missions ?? d)) {
    if (!m?.giver) continue;
    const set = (out[m.giver] ??= new Set());
    for (const r of m.reputationGained ?? []) if (r?.scope && scopes[r.scope]) set.add(r.scope);
  }
  return Object.fromEntries(Object.entries(out).map(([g, s]) => [g, [...s]]));
}

const ELECTRON = "node_modules/electron/dist/electron.exe";
const tmp = mkdtempSync(join(tmpdir(), "rep-probe-"));

for (const img of images) {
  console.log("\n=== " + img + " ===");
  if (!existsSync(img)) { console.log("  file not found"); continue; }

  const ocr = await ocrImage(img);
  console.log(`  frame ${ocr.w}x${ocr.h}, ${ocr.lines.length} OCR lines`);

  const r = readRepPage(ocr, scopes, giverScopes());
  for (const t of r.tried) console.log(`  candidate ${t.scope}: ${t.matched}/${t.of} ranks on screen`);
  if (!r.layout) { console.log(`  REFUSED: ${r.refusal}`); continue; }

  const l = r.layout;
  console.log(`  faction  ${l.factionRaw}${l.giver ? `   -> giver "${l.giver}"` : "   (no dataset giver)"}`);
  console.log(`  standing ${l.standingRaw ?? "(none)"}`);
  console.log(`  section  ${l.sectionRaw}   -> scope ${l.scope}`);

  const cardsFile = join(tmp, "cards.json");
  writeFileSync(cardsFile, JSON.stringify(l.cards));
  let bars: (RepBarRead & { why?: string })[] = [];
  try {
    const out = execFileSync(ELECTRON, [ "tools/rep-bars-read.cjs", img, cardsFile ], { encoding: "utf8" });
    const line = out.split(/\r?\n/).find((s) => s.startsWith("REPBARS"));
    if (!line) throw new Error("the bar reader printed nothing");
    if (line.startsWith("REPBARS-ERROR")) throw new Error(JSON.parse(line.slice(14)));
    bars = JSON.parse(line.slice(8));
  } catch (e) {
    console.log(`  bar reader failed: ${(e as Error).message}`);
    continue;
  }

  const ladder = [...scopes[l.scope].ranks].sort((a, b) => a.minRep - b.minRep);
  for (const c of l.cards) {
    const b = bars.find((x) => x.rank === c.rank)!;
    const mark = !b.found ? "  ?  " : b.reached ? " [##]" : " [--]";
    console.log(
      `  ${mark} ${String(c.rank).padStart(2)} ${c.name.padEnd(28)}` +
      `${b.found ? (b.fill * 100).toFixed(0).padStart(4) + "%" : "     "}  ` +
      `minRep ${String(ladder[c.rank]?.minRep).padStart(8)}   ${b.why ?? ""}`
    );
  }

  const v = repRankFromBars(bars);
  if (v.refusal) { console.log(`  REFUSED: ${v.refusal}`); continue; }
  const floor = repFloorForRank(scopes[l.scope], v.rank!);
  console.log(
    `  => ${l.giver ?? l.factionRaw} / ${l.scope}: rank ${v.rank} "${ladder[v.rank!].name}"` +
    `, ${((v.progress ?? 0) * 100).toFixed(0)}% through it`
  );
  console.log(`  => floor this would set: ${floor} rep`);
}

stopOcrWorker();
