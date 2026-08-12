// Is the bundled blueprint dataset the CURRENT patch?
//
// 🔴 WHY THIS EXISTS. On 2026-08-11 data/blueprints.latest.json was found sitting at
// 4.9.0-LIVE.12248363 (2,763 missions) while the live game — and the site — were on
// 12344265 (4,075). The app self-detects the running patch from game.log and falls back
// to `latest` when it holds no exact match, so it had been quietly serving a previous
// patch's reward pools, missing 1,312 missions, with nothing anywhere saying so. It was
// found by accident, chasing an unrelated bug.
//
// Refreshing the datasets is a documented per-patch step, and a documented step with no
// alarm on it is a step that eventually gets skipped. This is the alarm.
//
//   node tools/check-dataset-fresh.mjs            # warn only
//   node tools/check-dataset-fresh.mjs --strict   # exit 1 if stale (use in release)
//
// Compares against the published site dataset rather than the game files: the site is
// what the app's own /blueprints page serves, so if the two disagree a user sees
// different pools in the app than on the website, which is the visible symptom.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const STRICT = process.argv.includes("--strict");
const REMOTE = "https://subliminal.gg/sc/blueprints.latest.json";
const LOCAL = join(process.cwd(), "data", "blueprints.latest.json");

const fail = (msg) => {
  console.error(msg);
  process.exit(STRICT ? 1 : 0);
};

let local;
try {
  local = JSON.parse(readFileSync(LOCAL, "utf8"));
} catch (e) {
  fail(`dataset check: cannot read ${LOCAL} — ${e.message}`);
}
const localCl = Number(local.changelist);
const localCount = Object.keys(local.missions ?? {}).length;

// Range-request just enough bytes for the header fields; the file is ~5 MB and this check
// runs on every release.
let remote;
try {
  const res = await fetch(REMOTE, { headers: { Range: "bytes=0-2047" } });
  const head = await res.text();
  const cl = /"changelist"\s*:\s*"?(\d+)/.exec(head)?.[1];
  const ver = /"version"\s*:\s*"([^"]+)"/.exec(head)?.[1];
  if (!cl) throw new Error("no changelist in the served header");
  remote = { changelist: Number(cl), version: ver ?? "?" };
} catch (e) {
  // Offline is not a failure — a release must not be blocked by the network. Say so
  // loudly enough that nobody reads silence as a pass.
  console.warn(`dataset check: SKIPPED, could not reach ${REMOTE} (${e.message})`);
  process.exit(0);
}

console.log(`bundled: ${local.version} (${localCount} missions)`);
console.log(`site:    ${remote.version}`);

if (localCl === remote.changelist) {
  console.log("dataset check: current.");
  process.exit(0);
}
if (localCl > remote.changelist) {
  console.log("dataset check: bundled is NEWER than the site — publish the site datasets.");
  process.exit(0);
}
fail(
  `\ndataset check: STALE. Bundled ${local.version} is behind the site's ${remote.version}.\n` +
    `The app falls back to 'latest' for an unknown patch, so it will serve the OLD pools with no\n` +
    `warning to the user. Refresh before releasing:\n` +
    `  cp <site>/public/sc/blueprints.<cl>.json data/\n` +
    `  cp <site>/public/sc/blueprints.<cl>.json data/blueprints.latest.json\n` +
    `  (same for blueprint-detail.<cl>.json)\n`,
);
