/**
 * Self-check for rotated-session sharing.  Run with:  npx tsx src/log-share.test.ts
 *
 * The expensive failure here is not "fails to upload" — it is "uploads the same thing every
 * launch forever". Backups are immutable, so every verdict about one is FINAL: sent, wrong
 * patch, no mission signal, unreadable. All four have to be remembered, or a user with a full
 * logbackups/ folder re-offers it on every app start.
 *
 * 🔑 No network. Every fixture here is deliberately INELIGIBLE, so maybeShareLog reaches the
 * selection logic and stops before any upload — which is exactly the half worth pinning.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeShareLog } from "./log-share.js";

const root = mkdtempSync(join(tmpdir(), "logshare-"));
const backups = join(root, "logbackups");
mkdirSync(backups);
const statePath = join(root, "shared-logs.json");
const logPath = join(root, "game.log");

const header = (patch: string) => `<2026-08-01T00:00:00.000Z> ProductVersion: ${patch}\n<2026-08-01T00:00:00.000Z> [Trace] Environment:   PUB\n`;
const SIGNAL = 'Added notification "Contract Accepted:  Ship In Distress: " [4] MissionId: [11111111-2222-3333-4444-555555555555]\n';

// The live log has one job here: state the current patch. It must ALSO scrub to nothing, or
// maybeShareLog posts it and this test starts calling the production API on every run.
//
// 🔑 The patch is read from the RAW text and the scrub drops any line containing "chat", so a
// header line that also says "chat" is both readable and droppable. That is a load-bearing
// coincidence, so it is asserted below rather than assumed — if the scrub rule ever changes,
// this fails loudly instead of quietly going online.
const liveLog = `<2026-08-01T00:00:00.000Z> ProductVersion: 4.9.188.23497 chat\n<2026-08-01T00:00:00.000Z> chat noise\n`;
writeFileSync(logPath, liveLog);

// Fixtures, all ineligible for a DIFFERENT reason.
writeFileSync(join(backups, "old-patch.log"), header("4.8.184.64329") + SIGNAL); // wrong patch
writeFileSync(join(backups, "no-signal.log"), header("4.9.188.23497") + "just chatter\n"); // no signal
writeFileSync(join(backups, "empty.log"), ""); // empty
writeFileSync(join(backups, "notes.txt"), header("4.9.188.23497") + SIGNAL); // not a .log

const cfg = { shareLogs: true, syncToken: "scbp_fake_token_for_test", logPath };

const done = (): string[] => {
  try { return JSON.parse(readFileSync(statePath, "utf8")).backups ?? []; } catch { return []; }
};

try {
  // Precondition: the live fixture must scrub to nothing, or every assertion below runs against
  // a test that is quietly POSTing to the real site.
  const { scrubGameLog } = await import("./log-scrub.js");
  assert.equal(scrubGameLog(liveLog).text.trim(), "",
    "live-log fixture must scrub to empty — otherwise this test uploads to production");

  await maybeShareLog(cfg, "0.1.39", statePath);
  const after = done();

  assert(after.includes("old-patch.log"), "a wrong-patch backup must be remembered, not re-examined every tick");
  assert(after.includes("no-signal.log"), "a signal-free backup must be remembered");
  assert(after.includes("empty.log"), "an empty backup must be remembered");
  assert(!after.includes("notes.txt"), "a non-.log file should never be considered at all");

  // Idempotence: a second pass must not grow the list or re-decide anything.
  const before = after.slice().sort();
  await maybeShareLog(cfg, "0.1.39", statePath);
  assert.deepEqual(done().slice().sort(), before, "a second tick must not re-add or re-decide anything");

  // Sharing off => the state file is never touched, even with eligible-looking files present.
  const off = join(root, "off.json");
  await maybeShareLog({ ...cfg, shareLogs: false }, "0.1.39", off);
  assert.deepEqual((() => { try { return JSON.parse(readFileSync(off, "utf8")); } catch { return null; } })(), null,
    "sharing disabled must not read or write anything");

  // No token is the same refusal — the opt-in is two conditions, not one.
  const noTok = join(root, "notok.json");
  await maybeShareLog({ ...cfg, syncToken: "" }, "0.1.39", noTok);
  assert.deepEqual((() => { try { return JSON.parse(readFileSync(noTok, "utf8")); } catch { return null; } })(), null,
    "no sync token must not read or write anything");

  // A missing logbackups/ must be survivable — plenty of installs have never rotated a log.
  const bare = mkdtempSync(join(tmpdir(), "logshare-bare-"));
  const bareLog = join(bare, "game.log");
  writeFileSync(bareLog, liveLog); // same scrubs-to-nothing fixture, so this stays offline too
  await maybeShareLog({ ...cfg, logPath: bareLog }, "0.1.39", join(bare, "s.json"));
  rmSync(bare, { recursive: true, force: true });

  console.log("ALL PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
