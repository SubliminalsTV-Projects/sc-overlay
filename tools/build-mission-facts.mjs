// Trim mission-extra.<cl>.json down to the handful of fields the WIDGET shows.
//
// 🔑 The full file is 6.2 MB and the app already ships a 4.5 MB dataset; adding the whole thing
// to every installer to render three chips and one stat tile is not a trade worth making. The
// site reads the full file server-side and never sends it to a browser, so only the app needs a
// trimmed copy. Fields kept are exactly the ones rendered — add one here the moment the UI
// renders one more, and not before.
//
// Usage: node tools/build-mission-facts.mjs <mission-extra.json> <out.json>
import { readFileSync, writeFileSync } from "node:fs";

const [, , src, out] = process.argv;
if (!src || !out) {
  console.error("usage: node tools/build-mission-facts.mjs <mission-extra.json> <out.json>");
  process.exit(1);
}

const ds = JSON.parse(readFileSync(src, "utf8"));
const missions = ds.missions ?? {};
const trimmed = {};
let kept = 0;

for (const [key, m] of Object.entries(missions)) {
  const r = m.repeat ?? {};
  const o = {};
  // How long before you can take it again. THE metric — "back on the board" (boardRespawnMin) is
  // deliberately NOT carried: that is when an EXPIRED offer reappears, which nobody waits for.
  if (r.personalCooldownMin != null) {
    o.cd = r.personalCooldownMin;
    if (r.personalCooldownVarMin) o.cdVar = r.personalCooldownVarMin;
  }
  if (m.expectedDurationMin != null) o.dur = m.expectedDurationMin;
  // CIG's own blended difficulty, 1–7. The four axes stay out until something renders them.
  if (m.difficulty && m.difficulty.score != null) o.diff = m.difficulty.score;
  // Only ever recorded when it is FALSE — absence must never read as "you can retry".
  if (r.canReacceptAfterFailing === false) o.noRetry = true;
  if (Object.keys(o).length) { trimmed[key] = o; kept++; }
}

const payload = {
  schema: "sc-mission-facts/1",
  changelist: ds.changelist ?? "",
  version: ds.version ?? "",
  missions: trimmed,
};
writeFileSync(out, JSON.stringify(payload));
const mb = (n) => (n / 1048576).toFixed(2) + " MB";
console.log(`mission-facts: ${kept} of ${Object.keys(missions).length} contracts carry at least one fact`);
console.log(`  ${src} ${mb(readFileSync(src).length)}  ->  ${out} ${mb(readFileSync(out).length)}`);
