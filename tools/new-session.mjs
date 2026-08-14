#!/usr/bin/env node
/**
 * Give a session its own working tree.
 *
 *   npm run session -- <topic>          create ../sc-overlay-<topic> on branch feat/<topic>
 *   npm run session -- <topic> --branch fix/thing     use an explicit branch name
 *   npm run session -- --list           show every worktree and what it is on
 *   npm run session -- --done <topic>   remove the worktree (branch is kept)
 *
 * WHY THIS EXISTS (2026-08-14). Four sessions once shared this one checkout. Git's unit of
 * isolation IS the working tree, so four writers in one tree have no isolation at all: every
 * session's uncommitted work sat in the same `git status`, and the moment two touched the same
 * file neither could commit without carrying the other's half-finished work. One change of 20
 * lines could not be separated from 776 lines belonging to somebody else, and untangling it took
 * a night. A worktree costs one command and makes the whole class of problem impossible.
 *
 * 🔑 node_modules is JUNCTIONED, not installed. A real `npm install` in a worktree is ~600MB and
 * several minutes, and — worse — `npm install` REPLACES a junction with a real directory, so the
 * worktree silently stops sharing and npm skips electron's binary download. Both node_modules
 * (root and chat-server/) are junctioned here; do not run `npm install` inside a worktree.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();
const say = (s) => console.log(s);

/** Junction, not symlink: junctions need no privileges on Windows, symlinks do. */
function junction(link, target) {
  if (existsSync(link)) return "already linked";
  execFileSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "pipe" });
  return "linked";
}

if (args.includes("--list") || args.length === 0) {
  say(git("worktree", "list"));
  if (args.length === 0) {
    say("\nStart a session:  npm run session -- <topic>");
    say("Finish one:       npm run session -- --done <topic>");
  }
  process.exit(0);
}

if (args[0] === "--done") {
  const topic = args[1];
  if (!topic) { console.error("which one? npm run session -- --done <topic>"); process.exit(1); }
  const dir = resolve(REPO, "..", `sc-overlay-${topic}`);
  // Remove the junctions FIRST. `git worktree remove` walks the tree, and following a junction
  // into the main repo's node_modules would make it refuse (or, far worse, delete through it).
  for (const p of [join(dir, "node_modules"), join(dir, "chat-server", "node_modules")]) {
    if (existsSync(p)) { rmSync(p, { recursive: false, force: true }); say(`unlinked ${p}`); }
  }
  // ⚠️ `git worktree remove` can do its whole job — deregister the worktree, empty the contents —
  // and STILL fail to delete the now-empty folder, because Windows refuses to remove a directory
  // that is any process's current directory. A terminal sitting in the worktree is enough. It
  // surfaces as a bare "Permission denied" stack trace over what was actually a success, so
  // report the real state instead of throwing.
  try {
    say(git("worktree", "remove", dir, "--force"));
  } catch (err) {
    const stillRegistered = git("worktree", "list").includes(basename(dir));
    if (stillRegistered) throw err;
    say(`worktree deregistered, but ${dir} could not be deleted — something has it open`);
    say("(a shell sitting in that folder is the usual cause). cd out and delete it, or:");
    say(`  git -C "${REPO}" worktree prune`);
    process.exit(0);
  }
  say(`removed ${dir} — the branch is still there, nothing is lost.`);
  process.exit(0);
}

const topic = args[0].replace(/^-+/, "");
const bIdx = args.indexOf("--branch");
const branch = bIdx >= 0 ? args[bIdx + 1] : `feat/${topic}`;
const dir = resolve(REPO, "..", `sc-overlay-${topic}`);

if (existsSync(dir)) { console.error(`${dir} already exists — pick another topic, or --done it first.`); process.exit(1); }

// An existing branch is checked out rather than recreated, so resuming yesterday's rabbit hole
// works exactly the same as starting a new one.
const exists = git("branch", "--list", branch).length > 0;
say(git("worktree", "add", dir, ...(exists ? [branch] : ["-b", branch])));

say(junction(join(dir, "node_modules"), join(REPO, "node_modules")) + " node_modules");
if (existsSync(join(REPO, "chat-server", "node_modules"))) {
  say(junction(join(dir, "chat-server", "node_modules"), join(REPO, "chat-server", "node_modules")) + " chat-server/node_modules");
}

say(`
Your tree:   ${dir}
Your branch: ${branch}

Work here and commit whenever you like — nothing you do is visible to the session in the
main checkout until you merge. Do NOT run npm install (it would replace the junction).

The dev app stays a singleton on :8778 and belongs to whoever holds the main checkout.
Test widgets here against your own sidecar instead:
  APPDATA=<throwaway> PORT=8779 SC_NO_SYNC=1 npx tsx src/overlay-server.ts
  OVERLAY_PORT=8779 npm run test:widgets

When it is worth keeping:  git push -u origin ${branch}
Then tell the other session that branch name — they merge it. That is the whole handoff.
Finished:  npm run session -- --done ${topic}`);
