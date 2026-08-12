/**
 * Build the overlay sidecar and copy its runtime assets.
 *
 * Windows keeps the upstream Bun-compiled standalone executable. Linux emits
 * the NodeNext module tree because the ArchVerse launcher already ships Node
 * and starts server/sc-overlay-server.mjs directly.
 *
 *   Windows -> build/server/{sc-overlay-server.exe, overlay/, data/}
 *   Linux   -> build/server/{sc-overlay-server.mjs, *.js, overlay/, data/}
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { applyArchVerseOverlayPatches } from "./archverse-overlay-patches.mjs";

const out = "build/server";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (process.platform === "win32") {
  console.log("Compiling overlay server for Windows (bun) …");
  execSync(`bun build src/overlay-server.ts --compile --outfile ${out}/sc-overlay-server.exe`, {
    stdio: "inherit",
  });
} else {
  console.log("Compiling overlay server for Linux/Node (tsc) …");
  execSync(`npx tsc --outDir ${out} --declaration false --sourceMap false`, {
    stdio: "inherit",
  });
  renameSync(`${out}/overlay-server.js`, `${out}/sc-overlay-server.mjs`);
}

// Per-changelist datasets stay in the repo for dev, but only `latest` ships: the newest
// per-changelist pair is byte-identical to the .latest files (checked 0.1.41 — cmp says so),
// and old generations (4.8.x) are unreachable on live servers. A player on an unbundled
// changelist resolves exact → remote fetch (subliminal.gg/sc) → latest, same as today.
// Shipping all generations cost 25.5 MB of the 32 MB data dir.
const OLD_DATASET = /^blueprint(?:s|-detail)\.\d+\.json$/;
for (const dir of ["overlay", "data"]) {
  // Never ship overlay/config.json — it may contain a developer's personal
  // configuration. The server seeds defaults and writes runtime state under
  // the user's config directory instead.
  cpSync(dir, `${out}/${dir}`, {
    recursive: true,
    filter: (src) => basename(src) !== "config.json",
  });
  console.log(`copied ${dir}/ -> ${out}/${dir}/`);
}

// Apply Linux-fork UX as a thin build layer instead of permanently forking the
// giant upstream HTML files. This keeps future upstream merges dramatically cleaner.
applyArchVerseOverlayPatches(out);

console.log("server bundle ->", out);
