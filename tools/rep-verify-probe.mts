/**
 * End-to-end check of the rep rebuild against the REAL logs, in a throwaway profile.
 *
 * Runs the actual verifyFromLogs over every Star Citizen log on this machine and prints the
 * standing it computes for each giver. Never touches the live profile (its own stateDir, no
 * sidecar, no sync), so it is safe to run while the app is up.
 *
 *   npx tsx tools/rep-verify-probe.mts
 */
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionTracker } from "../src/missions.js";

const LOGDIR = "C:/Program Files/Roberts Space Industries/StarCitizen/GAME/logbackups";
const LIVE = "C:/Program Files/Roberts Space Industries/StarCitizen/GAME/game.log";

const paths = [LIVE, ...readdirSync(LOGDIR).map((f) => join(LOGDIR, f))].filter((p) => {
  try { return statSync(p).isFile(); } catch { return false; }
});

const dir = mkdtempSync(join(tmpdir(), "repprobe-"));
try {
  const t = new MissionTracker({ dataDir: join(import.meta.dirname, "..", "data"), stateDir: dir });
  t.detectPatch("<2026-08-13T00:00:00.000Z> ProductVersion: 4.9.188.23497");
  t.detectPatch(`<2026-08-13T00:00:00.000Z>    [Cmdline* ] --envtag='PUB'`);
  const started = Date.now();
  const res = t.verifyFromLogs(paths);
  const d = t.repDiagnostics();
  console.log(`scanned ${res.files} PUB logs (${res.skipped} skipped) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`credited completions: ${d.creditedCompletions}\n`);
  for (const g of d.givers) {
    console.log(String(g.sum).padStart(7), (g.standing ?? "?").padEnd(26), g.giver, `[${g.scope}]`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
