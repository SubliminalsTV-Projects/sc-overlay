// Dev harness: run the overlay's own OCR over a still image and dump every line with
// its bounding box.
//
// Written for the mobiGlas Contract Manager work — the row parser has to be built
// against what the OCR ACTUALLY returns (line splits, casing, where the amount lands),
// not against what the screenshot looks like to a human. Reusable for any future
// screen-reading feature.
//
//   npx tsx tools/ocr-probe.mts <image>
import { ocrImage, stopOcrWorker } from "../src/screen-read.js";

const img = process.argv[2];
if (!img) {
  console.error("usage: npx tsx tools/ocr-probe.mts <image>");
  process.exit(1);
}

const r = await ocrImage(img);
console.log(`frame ${r.w}x${r.h}  lines=${r.lines.length}`);
for (const l of r.lines) {
  const box = `${String(Math.round(l.x)).padStart(5)},${String(Math.round(l.y)).padStart(4)}`;
  const size = `${String(Math.round(l.w)).padStart(4)}x${String(Math.round(l.h)).padStart(3)}`;
  console.log(`${box}  ${size}  ${l.text}`);
}
stopOcrWorker();
