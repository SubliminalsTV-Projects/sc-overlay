/**
 * Bundle the overlay server (no window) into one .mjs + its runtime assets, for the
 * Electron app to run under its own binary with ELECTRON_RUN_AS_NODE (no Node/tsx on
 * the user's machine). electron-builder ships build/server/ as an extraResource →
 * resources/server.
 *
 * It used to be a `bun build --compile` standalone exe — a 112 MB binary whose only job
 * was carrying the bun runtime, on a machine that already ships a Node runtime inside
 * Electron. Swapped 0.1.41: same TS sources, bundled by esbuild (~230 KB), run by the
 * app's own exe. Deliberately NOT minified — sidecar stack traces land in sidecar.log
 * and are read from user crash reports, so the frames must stay legible.
 *
 *   npm run build:server  ->  build/server/{server.mjs, overlay/, data/}
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";

const out = "build/server";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log("Bundling overlay server (esbuild) …");
await build({
  entryPoints: ["src/overlay-server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: `${out}/server.mjs`,
  // CJS-style requires of node builtins inside an ESM bundle need a real `require`.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

// Per-changelist datasets stay in the repo for dev, but only `latest` ships: the newest
// per-changelist pair is byte-identical to the .latest files (checked 0.1.41 — cmp says so),
// and old generations (4.8.x) are unreachable on live servers. A player on an unbundled
// changelist resolves exact → remote fetch (subliminal.gg/sc) → latest, same as today.
// Shipping all generations cost 25.5 MB of the 32 MB data dir.
const OLD_DATASET = /^blueprint(?:s|-detail)\.\d+\.json$/;
for (const dir of ["overlay", "data"]) {
  // Never ship overlay/config.json — it's the developer's personal config (erkul
  // URLs + sync token). The server seeds from DEFAULTS and persists to %APPDATA%.
  cpSync(dir, `${out}/${dir}`, {
    recursive: true,
    filter: (src) => basename(src) !== "config.json" && !OLD_DATASET.test(basename(src)),
  });
  console.log(`copied ${dir}/ -> ${out}/${dir}/`);
}
console.log("server bundle ->", out);
