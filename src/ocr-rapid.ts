// RapidOCR (PP-OCR via @gutenye/ocr-node → onnxruntime-node) adapter.
//
// Runs in the ELECTRON MAIN process only (real Node — the native ONNX addon works there),
// NOT the bun-compiled sidecar. It produces the SAME OcrResult shape the WinRT `ocrImage`
// returns, so `classifyScreen` and all the positional logic stay unchanged; only the engine
// underneath swaps. The model loads once (lazy singleton) — first call pays ~1-2s, the rest are
// warm. `w`/`h` come from the caller (main has the screenshot's nativeImage.getSize()).
import type { OcrResult } from "./screen-read.js";

let _ocr: Promise<any> | null = null;
function getOcr(): Promise<any> {
  if (!_ocr) _ocr = import("@gutenye/ocr-node").then(({ default: Ocr }) => Ocr.create());
  return _ocr;
}

export async function ocrRapid(imagePath: string, w: number, h: number): Promise<OcrResult> {
  const ocr = await getOcr();
  const res = await ocr.detect(imagePath); // [{ text, box: [[x,y],…4], mean }]
  const lines = (res as any[]).map((r) => {
    const xs = r.box.map((p: number[]) => p[0]);
    const ys = r.box.map((p: number[]) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { text: String(r.text ?? ""), x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  });
  return { w, h, lines };
}
