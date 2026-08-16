/**
 * Look at the Hauling widget without playing the game.
 *
 *   npm run hauling-demo             # starts on 8781 and prints the URL
 *   npm run hauling-demo -- --port 8790
 *
 * Starts a sidecar with SC_DEV=1, pushes every scenario in `HAUL_SCENARIOS` through the
 * HaulingTracker (via /api/dev/hauling-replay), and hands you the URL. Ctrl-C stops it.
 *
 * 🔑 NEVER 8778, and never the real profile. The app's own sidecar owns 8778, and a second server
 * sharing %APPDATA% would write its config from under the running one — so this uses its own port
 * AND a throwaway profile directory. `seedDataDir()` fills a fresh profile from the bundled
 * `data/`, which is why the ship picker and the contract bounds are fully populated in here even
 * though nothing has ever run in that profile.
 *
 * What you are looking at: four contracts covering every case the widget has to be honest about —
 * one TRACKED (the game stated its tonnage), one accepted but NOT tracked (only the dataset's
 * range, so the please-track prompt is up), one multi-leg with a delivery already ticked off, and
 * one mission-item haul whose boxes the log enumerated exactly.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const argPort = process.argv.indexOf("--port");
const PORT = argPort > -1 ? Number(process.argv[argPort + 1]) : 8781;

if (PORT === 8778) {
  console.error("8778 is the app's own sidecar. Pick another port.");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "sc-hauling-demo-"));
console.log(`throwaway profile: ${profile}`);

const server = spawn(process.execPath, [join(repo, "node_modules", "tsx", "dist", "cli.mjs"), join(repo, "src", "overlay-server.ts")], {
  cwd: repo,
  stdio: ["ignore", "pipe", "inherit"],
  env: {
    ...process.env,
    PORT: String(PORT),
    SC_DEV: "1",
    SC_NO_SYNC: "1",           // a throwaway profile must never phone home
    APPDATA: profile,
    LOCALAPPDATA: profile,
    HOME: profile,
    USERPROFILE: profile,
  },
});
server.stdout.on("data", (b) => process.stdout.write(b));
const bye = () => { try { server.kill(); } catch { /* already gone */ } };
process.on("SIGINT", () => { bye(); process.exit(0); });
process.on("exit", bye);

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const r = await fetch(`${base}/api/hauling`);
    if (r.ok) break;
  } catch { /* not listening yet */ }
  if (i === 59) { console.error("the sidecar never came up"); bye(); process.exit(1); }
}

const res = await fetch(`${base}/api/dev/hauling-replay`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",   // no scenario named = run the whole set, which is the useful default
});
const body = await res.json();
if (!res.ok || !body.ok) {
  console.error("replay failed:", body);
  bye();
  process.exit(1);
}

console.log(`\n  seeded ${body.scenarios.length} scenarios (${body.events} events)\n`);
console.log(`  widget   →  ${base}/hauling.html`);
console.log(`  canvas   →  ${base}/missions.html?canvas=1&hauling`);
console.log(`  raw plan →  ${base}/api/hauling/plan\n`);
console.log("  Ctrl-C to stop.");
