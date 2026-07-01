/**
 * Bun-compile the overlay server (no window) into a standalone .exe + its runtime
 * assets, for the Electron app to spawn in production (no Node/tsx on the user's
 * machine). electron-builder ships build/server/ as an extraResource → resources/server.
 *
 *   npm run build:server  ->  build/server/{sc-overlay-server.exe, overlay/, data/}
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const out = "build/server";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log("Compiling overlay server (bun) …");
execSync(`bun build src/overlay-server.ts --compile --outfile ${out}/sc-overlay-server.exe`, {
  stdio: "inherit",
});

for (const dir of ["overlay", "data"]) {
  cpSync(dir, `${out}/${dir}`, { recursive: true });
  console.log(`copied ${dir}/ -> ${out}/${dir}/`);
}
console.log("server bundle ->", out);
