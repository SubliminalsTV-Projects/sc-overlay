/**
 * Publish `data/events.json` to the site, so a discovery reaches every running app without an
 * app release.
 *
 *   npm run sync:events              # write it, bumping `revision`
 *   npm run sync:events -- --check   # say what would happen, write nothing
 *   npm run sync:events -- --site <path-to-subliminal-gg>
 *
 * 🔑 THE POINT OF THIS SCRIPT IS THAT NOBODY HAS TO REMEMBER THE INTEGER. `src/event-feed.ts`
 * adopts the remote copy only when its `revision` is strictly greater than the copy in effect,
 * which is what stops a stale site copy deleting a discovery a build shipped with. That guard is
 * only as good as the bump, and a bump nobody remembers is a correction that silently never
 * reaches players — the exact failure the feed exists to remove. So the bump is mechanical:
 * `max(site, bundled) + 1`, never typed by hand.
 *
 * ⚠️ It writes into the SITE repo, which deploys to production when its trunk moves. This script
 * only ever writes the file; committing and deploying stays a human decision.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const siteArg = argv.indexOf("--site") >= 0 ? argv[argv.indexOf("--site") + 1] : null;

// Default to the sibling checkout in Sub's tree. Overridable, and it FAILS rather than guessing
// further — writing an events file into the wrong repo would be silent and confusing.
const DEFAULT_SITE = resolve(repo, "..", "..", "SubliminalsTV", "subliminal-gg");
const site = resolve(siteArg ?? DEFAULT_SITE);

const src = join(repo, "data", "events.json");
const dst = join(site, "public", "sc", "events.json");

if (!existsSync(src)) fail(`no events file at ${src}`);
if (!existsSync(join(site, "public", "sc"))) {
  fail(`site repo not found at ${site}\n       pass --site <path-to-subliminal-gg>`);
}

const body = JSON.parse(readFileSync(src, "utf8"));
if (!Array.isArray(body.events)) fail("data/events.json has no `events` array");

const siteRev = existsSync(dst) ? revisionOf(readFileSync(dst, "utf8")) : 0;
const bundledRev = Number.isFinite(body.revision) ? body.revision : 0;
const next = Math.max(siteRev, bundledRev) + 1;

// Both copies carry the SAME revision, so `git diff` between the repos is only ever about
// content. The bundled file is bumped too — otherwise the next sync would compute the same
// number again and a second correction could never outrank the first.
const out = { ...body, revision: next };

console.log(`  bundled revision : ${bundledRev}`);
console.log(`  site revision    : ${siteRev}${existsSync(dst) ? "" : "  (no file yet)"}`);
console.log(`  publishing as    : ${next}`);
console.log(`  -> ${dst}`);

if (check) {
  console.log("\n--check: nothing written.");
  process.exit(0);
}

const text = JSON.stringify(out, null, 2) + "\n";
writeFileSync(dst, text);
writeFileSync(src, text);
console.log("\nWritten. Commit + deploy the site; every running app picks it up within 30 minutes.");

function revisionOf(text) {
  try {
    const r = JSON.parse(text).revision;
    return Number.isFinite(r) ? r : 0;
  } catch {
    return 0;
  }
}

function fail(msg) {
  console.error(`sync:events: ${msg}`);
  process.exit(1);
}
