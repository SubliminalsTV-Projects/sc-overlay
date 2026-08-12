/**
 * Self-check for which logs "Verify from logs" scans.
 * Run with:  npx tsx src/log-paths.test.ts
 *
 * Sub's install has LIVE/PTU/EPTU/HOTFIX/TECH-PREVIEW as LINKS to one GAME folder, so every log
 * arrived under six names and every completion in it was credited six times. Deduplicating by
 * resolved path fixes that — but MOST installs have those channels as separate real directories
 * with genuinely different logs, and every one of those must still be scanned. Sub, 2026-08-03:
 * "it needs to work for people who are using symlinks and people who are not."
 *
 * So both layouts are built on disk and asserted here. The linked case is skipped LOUDLY if the
 * OS refuses to create a link (directory junctions need no privileges on Windows, but this must
 * never pass quietly on a machine where it could not be tested).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { collectLogPaths } from "./log-paths.js";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

/** A channel folder with a game.log and `backups` rotated logs, each with unique content. */
function makeChannel(root: string, name: string, backups: number): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "logbackups"), { recursive: true });
  writeFileSync(join(dir, "game.log"), `${name} current\n`);
  for (let i = 0; i < backups; i++) writeFileSync(join(dir, "logbackups", `${name}-${i}.log`), `${name} old ${i}\n`);
  return dir;
}

// ── Layout 1: the ordinary install — separate real channel folders ──────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), "logpaths-real-"));
  try {
    const sc = join(root, "StarCitizen");
    makeChannel(sc, "LIVE", 2);   // 3 logs
    makeChannel(sc, "PTU", 1);    // 2 logs
    makeChannel(sc, "EPTU", 0);   // 1 log
    const found = collectLogPaths(join(sc, "LIVE", "game.log"));
    check("every real channel's logs are scanned", found.length, 6);
    // The point of scanning siblings at all: a player pointed at LIVE still gets their PTU history
    // read (the environment gate, not this function, is what then rejects test-server sessions).
    check("...including the siblings", new Set(found.map((p) => basename(p).split("-")[0].replace(".log", ""))).size >= 3, true);
    check("the configured channel's own log comes first", basename(found[0]), "game.log");
    check("no duplicates", new Set(found.map((p) => p.toLowerCase())).size, found.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Layout 2: Sub's install — channel names are LINKS to one folder ─────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), "logpaths-linked-"));
  let linked = false;
  try {
    const sc = join(root, "StarCitizen");
    const game = makeChannel(sc, "GAME", 4); // 5 real logs
    try {
      // "junction" needs no elevation on Windows and resolves the same way Sub's links do.
      for (const name of ["LIVE", "PTU", "EPTU", "HOTFIX", "TECH-PREVIEW"]) {
        symlinkSync(game, join(sc, name), "junction");
      }
      linked = true;
    } catch (e) {
      console.log(`SKIP  linked layout — this OS would not create a junction (${(e as Error).message})`);
    }
    if (linked) {
      // Configured via one of the LINKS, which is what the launcher actually writes.
      const viaLink = collectLogPaths(join(sc, "LIVE", "game.log"));
      check("six names for one folder still scan five logs", viaLink.length, 5);
      check("...and via the real folder too", collectLogPaths(join(game, "game.log")).length, 5);
      const ids = new Set(viaLink.map((p) => p.toLowerCase()));
      check("no path repeats", ids.size, viaLink.length);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (!linked) failed++; // never pass silently on an untested platform
}

// ── Degenerate inputs must not throw ────────────────────────────────────────────────────────
check("an empty path yields nothing", collectLogPaths("").length, 0);
check("a path that does not exist yields nothing", collectLogPaths(join(tmpdir(), "no-such-dir-xyz", "game.log")).length, 0);

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
