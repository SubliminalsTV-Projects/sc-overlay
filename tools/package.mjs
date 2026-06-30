/**
 * Package the blueprint tracker into a portable single-exe via bun, with the
 * runtime assets (overlay/, data/) shipped alongside.
 *
 *   npm run package   ->   dist/sc-blueprint-tracker.exe + dist/overlay + dist/data
 *
 * Distribute the whole dist/ folder. End users double-click the exe; it starts the
 * local server and opens the blueprint window. (OBS users add the localhost URL.)
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

console.log("Compiling single-exe with bun ...");
execSync("bun build src/standalone.ts --compile --outfile dist/sc-blueprint-tracker.exe", {
  stdio: "inherit",
});

for (const dir of ["overlay", "data"]) {
  cpSync(dir, `dist/${dir}`, { recursive: true });
  console.log(`copied ${dir}/ -> dist/${dir}/`);
}

console.log("\nPackaged. Ship the whole dist/ folder:");
console.log("  dist/sc-blueprint-tracker.exe");
console.log("  dist/overlay/   dist/data/");
