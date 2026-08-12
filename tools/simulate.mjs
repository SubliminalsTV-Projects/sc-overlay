/**
 * Simulate finishing a mission in the RUNNING dev app, so the completion report and its
 * crowdsourcing questions can be tested without playing Star Citizen.
 *
 *   npm run simulate              → list the scenarios
 *   npm run simulate -- survey    → run one
 *
 * Needs the dev app (or `npm run overlay`) up on :8778. The endpoint only exists in dev builds
 * and only answers loopback — see src/dev-replay.ts for why it is gated that hard.
 */
const BASE = process.env.SC_OVERLAY_URL || "http://localhost:8778";
const id = process.argv[2];

async function main() {
  let list;
  try {
    const r = await fetch(`${BASE}/api/dev/replay`);
    if (r.status === 404) {
      console.error("The replay endpoint is not available.\n" +
        "It only exists in a DEV build (SC_DEV=1, set by electron/main.cjs on the non-packaged\n" +
        "spawn). If you're running the installed app, start the dev one instead:\n" +
        "  npm run overlay-app");
      process.exit(1);
    }
    list = (await r.json()).scenarios;
  } catch {
    console.error(`Nothing answering at ${BASE}. Start the app (npm run overlay-app) or the\n` +
      "sidecar alone (npm run overlay), then try again.");
    process.exit(1);
  }

  if (!id) {
    console.log("Scenarios — run one with:  npm run simulate -- <id>\n");
    for (const s of list) {
      console.log(`  ${s.id.padEnd(12)} ${s.label}`);
      console.log(`  ${"".padEnd(12)} ${s.note}\n`);
    }
    return;
  }

  const res = await fetch(`${BASE}/api/dev/replay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario: id }),
  });
  const out = await res.json();
  if (!res.ok) {
    console.error(`${out.error}${out.known ? `\nknown: ${out.known.join(", ")}` : ""}`);
    process.exit(1);
  }
  console.log(`Replayed "${out.scenario}" — ${out.lines} log lines.`);
  if (out.note) console.log(`Note: ${out.note}`);

  // Read the card back rather than reporting what we injected. 🔑 Those differ: the tiles come
  // from receipts dated inside the mission's accept→complete window, and re-receiving a
  // blueprint you already own keeps its ORIGINAL receipt date (earliest wins), so the injected
  // one usually isn't the one displayed. Printing the injection would quietly mislead — and the
  // whole point of this tool is to tell you what is on screen.
  const c = (await (await fetch(`${BASE}/api/missions`)).json()).completion;
  // 🔑 Compare the card's own timestamp against the one this run generated. A card left over
  // from the PREVIOUS scenario looks identical otherwise, and reporting it as success is worse
  // than reporting nothing.
  if (!c || c.at !== out.at) {
    if (out.outcome === "abandoned") {
      console.log("\nPASS — no card, which is the expected result. Abandoning a mission shows no\n" +
        "report at all.");
      return;
    }
    console.log(`\n⚠ No card for THIS run${c ? " (the one showing is from an earlier replay)" : ""}.\n` +
      "Something is wrong — check sidecar.log.");
    process.exit(1);
  }
  const combat = c.classification?.combat;
  console.log(`\nOn the card now:`);
  console.log(`  ${c.title}  (${c.giver ?? "?"} · ${c.missionType ?? "?"})`);
  console.log(`  time ${Math.round((c.durationMs ?? 0) / 60000)}min` +
    (c.aUEC != null ? `  ·  ${c.aUEC.toLocaleString()} aUEC` : "") +
    (c.poolProgress ? `  ·  pool ${c.poolProgress.owned}/${c.poolProgress.total}` : ""));
  console.log(`  blueprints: ${c.blueprints?.length ? c.blueprints.map((b) => b.name).join(", ") : "(none)"}`);
  console.log(`  combat question: ${combat ? `NOT asked — game data says "${combat}"` : "ASKED (this is the crowdsourcing UI)"}`);
  console.log(`\nIt stays up ~40s; touching it cancels the countdown.`);
}

main();
