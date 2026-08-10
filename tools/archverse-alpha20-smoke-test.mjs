import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { applyArchVerseOverlayPatches } from "./archverse-overlay-patches.mjs";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "archverse-alpha20-"));
const overlay = join(temp, "overlay");
mkdirSync(overlay, { recursive: true });

try {
  writeFileSync(join(overlay, "missions.html"), "<html><body>Mining Scanner</body></html>");
  writeFileSync(join(overlay, "mining.html"), "<html><body>Mining Scanner<script>const t='Mining assistant ready';</script></body></html>");
  writeFileSync(join(overlay, "config.html"), "<html><body>Mining Scanner / Mining Assistant</body></html>");
  applyArchVerseOverlayPatches(temp);

  const missions = readFileSync(join(overlay, "missions.html"), "utf8");
  const mining = readFileSync(join(overlay, "mining.html"), "utf8");
  const config = readFileSync(join(overlay, "config.html"), "utf8");
  assert.match(missions, /Resource Scanner/);
  assert.match(missions, /ARCHVERSE_WIDGET_APPEARANCE_V1/);
  assert.match(mining, /Resource Scanner/);
  assert.match(mining, /ARCHVERSE_RESOURCE_SCANNER_V1/);
  assert.match(mining, /Resource scanner ready/);
  assert.doesNotMatch(config, /Mining (Scanner|Assistant)/);

  // Parse both browser extensions without executing their browser globals.
  const resourceJs = readFileSync(join(root, "overlay", "archverse-resource-scanner.js"), "utf8");
  const appearanceJs = readFileSync(join(root, "overlay", "archverse-widget-appearance.js"), "utf8");
  new Function(resourceJs);
  new Function(appearanceJs);

  // Safety invariant: salvage voice is explicitly behind a positive-confirmation property.
  assert.match(resourceJs, /salvageConfirmed\s*===\s*true/);
  const debrisSpeech = [...resourceJs.matchAll(/speak\("([^"]*debris[^"]*)"\)/gi)].map((m) => m[1]);
  assert.deepEqual(debrisSpeech, ["Salvageable debris"]);

  console.log("ArchVerse Alpha 20 smoke test: PASS");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
