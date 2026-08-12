/**
 * The seed read and the watcher must be CONTIGUOUS.
 *
 * 🔴 Why this exists. The sidecar starts by reading the whole current game.log to seed the
 * tracker, does other startup work, and only then starts the watcher — which used to begin
 * tailing from a fresh stat of the file. Anything the game wrote in between was processed by
 * NEITHER, and a mission accept is exactly the kind of line that lands there: the tracker never
 * learns the mission, OCR re-registers it later from the title still on screen, and a title
 * guess cannot be narrowed to one variant — so the panel shows the merged pool of every
 * same-title variant and can never be marked complete. Sub hit that on "Simple Hit"
 * (2026-08-12): 23/25 across four merged pools, for a contract that was one pool of 7 and
 * already finished.
 *
 * The gap is invisible to every other test in the suite, because they all drive the watcher
 * directly rather than through the boot sequence.
 *
 * Run with:  npx tsx src/watcher-handover.test.ts
 */
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogWatcher } from "./watcher.js";

let failed = 0;
const check = (name: string, cond: boolean, detail= "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? "   [" + detail + "]" : ""}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "handover-"));
const log = join(dir, "game.log");

async function collect(w: LogWatcher, ms: number): Promise<string[]> {
  const seen: string[] = [];
  w.on("line", (raw: string) => seen.push(raw));
  w.start();
  await sleep(ms);
  w.stop();
  return seen;
}

(async () => {
  // ── the real boot shape: seed reads, THEN the game writes, THEN the watcher starts ──
  writeFileSync(log, "before-seed-1\nbefore-seed-2\n");
  const seeded = readFileSync(log);           // the seed's read
  const seedEndsAt = seeded.length;
  appendFileSync(log, "ACCEPTED-IN-THE-GAP\n"); // written while startup was still busy

  const w = new LogWatcher(log, { pollInterval: 30, startPosition: seedEndsAt });
  const seen = await collect(w, 260);
  check("the line written during startup is not lost", seen.includes("ACCEPTED-IN-THE-GAP"), seen.join(","));
  check("...and nothing the seed already read is replayed",
    !seen.includes("before-seed-1") && !seen.includes("before-seed-2"), seen.join(","));

  // ── the bug, reproduced: without the handover the same line vanishes ──
  writeFileSync(log, "before-seed-1\nbefore-seed-2\n");
  appendFileSync(log, "ACCEPTED-IN-THE-GAP\n");
  const w2 = new LogWatcher(log, { pollInterval: 30 });   // no startPosition = old behaviour
  const seen2 = await collect(w2, 260);
  check("negative control: without the handover it IS lost", !seen2.includes("ACCEPTED-IN-THE-GAP"), seen2.join(","));

  // ── a rotation between seed and watcher must not skip the new session ──
  // The offset belongs to a file that no longer exists; taking it literally would seek past
  // the whole of a fresh, shorter log.
  writeFileSync(log, "long-previous-session-line-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  const staleOffset = readFileSync(log).length;
  writeFileSync(log, "new-session-1\n");                   // rotated: much shorter
  const w3 = new LogWatcher(log, { pollInterval: 30, startPosition: staleOffset });
  const seen3 = await collect(w3, 260);
  check("a stale offset past EOF is clamped, not obeyed", seen3.includes("new-session-1"), seen3.join(","));

  // ── the ordinary tail is unchanged ──
  writeFileSync(log, "old\n");
  const w4 = new LogWatcher(log, { pollInterval: 30 });
  const seen4Promise = collect(w4, 300);
  await sleep(120);
  appendFileSync(log, "fresh\n");
  const seen4 = await seen4Promise;
  check("with no seed, tailing still starts at the end", !seen4.includes("old") && seen4.includes("fresh"), seen4.join(","));

  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
})();
