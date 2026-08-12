/**
 * Launch the dev app against a THROWAWAY profile, so it behaves like a brand-new install.
 *
 * Why this exists: the first-run setup wizard happens exactly once per machine, and anyone who
 * has used the app has already spent theirs. Clearing the setup flags is not the same thing —
 * the wizard would still auto-tick "find your game log" and "connect your account", because
 * those really are configured. The only way to see what a new user sees is a profile with
 * nothing in it.
 *
 * Everything the app persists hangs off %APPDATA%: the sidecar's config/collection
 * (…/sc-blueprint-tracker) and Electron's own userData, which is where the widget layout lives.
 * Point that at an empty directory and the app genuinely believes it is a first run — the
 * sidecar reports freshInstall, the shell opens the wizard, and no saved layout exists.
 *
 * 🔑 SYNC IS HARD-DISABLED here (SC_NO_SYNC=1, enforced in src/sync.ts). Every push is an
 * authoritative FULL REPLACE, so a throwaway profile holding an empty collection, with a real
 * token pasted into the wizard's connect step, would upload nothing-at-all over the real
 * collection and destroy it. That makes walking the whole flow — including pasting a real
 * token — safe.
 *
 *   npm run dev:fresh            reuse the throwaway profile (keeps what you did last time)
 *   npm run dev:fresh -- --reset wipe it first: a true first run again
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Kept inside the repo (gitignored) rather than the system temp: it must be easy to find, easy
// to delete, and obvious that it is not your real data.
const PROFILE = join(ROOT, ".dev-profile");

if (process.argv.includes("--reset") && existsSync(PROFILE)) {
  rmSync(PROFILE, { recursive: true, force: true });
  console.log("wiped the throwaway profile — this will be a true first run");
}
mkdirSync(PROFILE, { recursive: true });

console.log(`profile : ${PROFILE}`);
console.log("sync    : DISABLED (SC_NO_SYNC=1) — your real collection cannot be touched");
console.log("port    : 8778 — quit any other copy of the app first, or it will refuse the port\n");

const electron = join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const child = spawn(electron, ["electron/main.cjs"], {
  cwd: ROOT,
  // APPDATA is the whole trick: the sidecar and Electron both derive their storage from it, and
  // the sidecar inherits this env because main spawns it with {...process.env}.
  env: { ...process.env, APPDATA: PROFILE, SC_NO_SYNC: "1" },
  stdio: "inherit",
  detached: false,
});
child.on("exit", (code) => process.exit(code ?? 0));
