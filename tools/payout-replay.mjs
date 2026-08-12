// Replay board rows captured earlier through the live scanner, and upload them.
//
// 🔴 WHY THIS EXISTS. On 2026-08-11 Sub scanned his whole contract board while the parser
// was still being fixed. The OCR was GOOD — every title, giver and price came back
// correctly — but the code misread its own output, and each fix meant restarting the app,
// which threw the queue away, because the queue lived only in memory. He closed the game
// having generated real data that no longer existed anywhere.
//
// The reads themselves survived in the session's diagnostics, so nothing is actually lost
// — but only because someone happened to be looking. The durable fix is the queue being
// persisted (it is now); this is how the already-gathered data gets in.
//
// It posts to the sidecar rather than to subliminal.gg directly, so it uses the same
// matcher, the same dedup, the same title-group rule and the same credential as a live
// scan. A row replayed here is indistinguishable from a row read off the screen.
//
//   node tools/payout-replay.mjs <rows.json> [--dry]
//
// rows.json: [{ "category", "title", "giver", "amount", "kind" }, ...]
//   kind: "payout" | "fee" | null. amount null = no price on the row.

import { readFileSync } from "node:fs";

const file = process.argv[2];
const dry = process.argv.includes("--dry");
if (!file) {
  console.error("usage: node tools/payout-replay.mjs <rows.json> [--dry]");
  process.exit(1);
}
const rows = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(rows) || !rows.length) {
  console.error("no rows");
  process.exit(1);
}

const PORT = process.env.OVERLAY_PORT || 8778;
const res = await fetch(`http://localhost:${PORT}/api/payout-scan/replay`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rows, dry }),
});
if (!res.ok) {
  console.error(`sidecar refused: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const out = await res.json();

console.log(`${rows.length} rows replayed${dry ? " (DRY RUN — nothing queued)" : ""}\n`);
for (const e of out.events.slice().reverse()) {
  const amt = e.amount == null ? "—" : e.amount.toLocaleString("en-US");
  console.log(`  [${e.outcome.padEnd(9)}] ${amt.padStart(9)}  ${e.title.slice(0, 44).padEnd(44)} ${e.detail}`);
}
console.log(`\nrecorded ${out.tally.recorded} · queued ${out.queued} observations`);
if (out.uploaded != null) console.log(`uploaded ${out.uploaded}`);
if (out.tally.lastFlushError) console.log(`upload error: ${out.tally.lastFlushError}`);
