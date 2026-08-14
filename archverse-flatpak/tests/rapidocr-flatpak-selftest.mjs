import fs from "node:fs";

const [{ default: Ocr }, { default: models }] = await Promise.all([
  import("@gutenye/ocr-node"),
  import("@gutenye/ocr-models/node"),
]);

for (const modelPath of [models.detectionPath, models.recognitionPath, models.dictionaryPath]) {
  if (!fs.existsSync(modelPath)) throw new Error(`missing OCR model ${modelPath}`);
}

const engine = await Ocr.create({ models });
if (!engine) throw new Error("RapidOCR engine did not initialize");

console.log("RapidOCR Flatpak startup OK");
