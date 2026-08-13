// Recover every contract completion from archived Game.logs and send them to subliminal.gg.
//
//   node tools/backfill-completions.mjs --dry
//   node tools/backfill-completions.mjs --token scbp_… [--base https://subliminal.gg]
//
// 🔴 THE LOG REPEATS EACH COMPLETION, AND NOT THREE TIMES. Every completion is a UI
// notification, and the notification logs a line per lifecycle action — Next, StartFade,
// Remove — plus more when it re-shows. Measured across Sub's 468 archived logs: 2,909 raw
// lines collapse to 494 real completions, an inflation of 5.89x. A backfill that counted
// lines would have put a number on his profile that was nearly six times too large, and it
// would have looked entirely plausible.
//
// 🔑 Dedup is by (title, within DEDUPE_MS). The line carries no mission id — only the
// display title — so there is nothing better to key on, and two genuine runs of the same
// contract inside a minute is not a thing that happens.
//
// ⚠️ The line gives a TITLE, never a contract_key. So this can count runs and name them; it
// cannot attribute them to a specific same-titled variant. That is a real limit and the
// site's per-contract figures should not pretend otherwise — see lib/db/mission-completions.ts.

import { readFile, readdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = "") => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const DRY = has("--dry");
const TOKEN = val("--token", process.env.SC_SYNC_TOKEN || "");
const BASE = val("--base", "https://subliminal.gg").replace(/\/+$/, "");
const DEDUPE_MS = 60_000;
const BATCH = 500;

const ROOTS = [
  "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE",
  "C:/Program Files/Roberts Space Industries/StarCitizen/PTU",
];

// The notification line, e.g.
// <2026-08-01T04:22:48.945Z> [Notice] <UpdateNotificationItem> Notification "Contract Complete: Salvage Job: Large: " [272], …
const LINE = /^<([^>]+)>.*Contract Complete:\s*(.*?)"\s*\[/;

async function logFiles() {
  // 🔑 Deduped by REAL path. On installs like Sub's, every channel folder (LIVE, PTU, EPTU…)
  // is a junction to one directory, so a naive walk reads all 468 logs twice and reports
  // 940 files and double the raw lines. The completion COUNT survives — the time-window
  // dedup collapses the copies — but the diagnostics lie, and a diagnostic that lies about
  // a backfill is how a wrong total gets believed.
  const seen = new Set();
  const out = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    // The live Game.log too, not just the archive — the current session's completions are
    // real completions, and a backfill run right after playing should include them.
    const add = async (p) => {
      try {
        const real = await realpath(p);
        if (seen.has(real)) return;
        seen.add(real);
        out.push(real);
      } catch { /* vanished between readdir and here */ }
    };
    if (existsSync(join(root, "Game.log"))) await add(join(root, "Game.log"));
    const backups = join(root, "logbackups");
    if (!existsSync(backups)) continue;
    for (const f of await readdir(backups)) {
      if (f.toLowerCase().endsWith(".log")) await add(join(backups, f));
    }
  }
  return out;
}

const files = await logFiles();
if (!files.length) {
  console.error("No Star Citizen logs found. Checked:\n  " + ROOTS.join("\n  "));
  process.exit(1);
}

let rawLines = 0;
const events = [];
for (const f of files) {
  let text;
  try {
    text = await readFile(f, "utf8");
  } catch {
    continue; // a log being written right now, or one we cannot read — skip, don't abort
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("Contract Complete")) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    rawLines++;
    const at = Date.parse(m[1]);
    // The title trails a colon and spaces in the notification ("Salvage Job: Large: ").
    const title = m[2].replace(/[:\s]+$/, "").trim();
    if (!title || Number.isNaN(at)) continue;
    events.push({ at, title });
  }
}

events.sort((a, b) => a.at - b.at);
const lastSeen = new Map();
const completions = [];
for (const e of events) {
  const prev = lastSeen.get(e.title);
  lastSeen.set(e.title, e.at);
  if (prev != null && e.at - prev < DEDUPE_MS) continue;
  completions.push({ title: e.title, completedAt: new Date(e.at).toISOString(), source: "backfill" });
}

const distinct = new Set(completions.map((c) => c.title)).size;
console.log(`logs scanned      : ${files.length}`);
console.log(`raw lines matched : ${rawLines}`);
console.log(`real completions  : ${completions.length}  (${(rawLines / Math.max(1, completions.length)).toFixed(2)}x inflation)`);
console.log(`distinct contracts: ${distinct}`);
if (completions.length) {
  console.log(`window            : ${completions[0].completedAt.slice(0, 10)} → ${completions[completions.length - 1].completedAt.slice(0, 10)}`);
}

if (DRY || !completions.length) {
  const top = {};
  for (const c of completions) top[c.title] = (top[c.title] || 0) + 1;
  console.log("\nmost-run:");
  for (const [t, n] of Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(4)}  ${t.slice(0, 64)}`);
  }
  if (DRY) console.log("\n--dry: nothing uploaded.");
  process.exit(0);
}

if (!TOKEN) {
  console.error("\nNeed --token scbp_… (the overlay's sync token) to upload. Use --dry to preview.");
  process.exit(1);
}

let sent = 0;
let added = 0;
for (let i = 0; i < completions.length; i += BATCH) {
  const slice = completions.slice(i, i + BATCH);
  const res = await fetch(`${BASE}/api/sc/mission-completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ completions: slice }),
  });
  if (!res.ok) {
    console.error(`\nbatch ${i / BATCH + 1} failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    process.exit(1);
  }
  const d = await res.json();
  sent += slice.length;
  added += d.added ?? 0;
  console.log(`  sent ${sent}/${completions.length} · new ${added}`);
}
// Re-running is safe and SHOULD report 0 new — the endpoint is idempotent on
// (owner, contract, completedAt). A second run reporting hundreds means the dedup key
// changed, which is worth noticing rather than silently doubling someone's count.
console.log(`\ndone — ${added} new of ${sent} sent. Re-running should now add 0.`);
