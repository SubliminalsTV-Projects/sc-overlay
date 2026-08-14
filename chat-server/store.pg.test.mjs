// The Postgres backend, against a real database.
//
// Not part of `npm run test:chat` — it needs a DATABASE_URL, and the only Postgres this project
// has is inside the VPS's Docker network. Run it there:
//
//   docker run --rm --network coolify -v /tmp/chat-server:/app -w /app \
//     -e DATABASE_URL=postgres://chat_app:PW@te7082rmeabjlnwzimhtdg9h:5432/subliminal \
//     -e CHAT_DB_SCHEMA=chat_test node:22 node store.pg.test.mjs
//
// 🔑 CHAT_DB_SCHEMA is what makes this safe to run: it builds and DROPS its own scratch schema,
// so a test run can never touch a real conversation. Never point it at `chat`.

import { createStore } from "./store.mjs";
import pg from "pg";

const URL = process.env.DATABASE_URL;
const SCHEMA = process.env.CHAT_DB_SCHEMA || "chat_test";
if (!URL) { console.error("DATABASE_URL required"); process.exit(1); }
if (SCHEMA === "chat") { console.error("refusing to run against the live `chat` schema"); process.exit(1); }

let fails = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log("  ok   " + name + (detail ? "   [" + detail + "]" : ""));
  else { fails++; console.log("  FAIL " + name + (detail ? "   [" + detail + "]" : "")); }
};
const msg = (id, ch, handle, text) => ({
  id, ch, from: { handle, verified: true }, text, at: new Date(1786000000000 + id * 1000).toISOString(),
});
const settle = () => new Promise((r) => setTimeout(r, 400));   // fire-and-forget writes

const admin = new pg.Client({ connectionString: URL });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await admin.query(`CREATE SCHEMA ${SCHEMA}`);

console.log(`\nstore (postgres, schema=${SCHEMA})`);
try {
  let store = createStore({ databaseUrl: URL, schema: SCHEMA, dataDir: "/nonexistent" });
  let boot = await store.init();
  ok("a fresh schema boots empty", boot.rooms.size === 0 && boot.bans.size === 0);
  ok("...and the id counter starts at 0", boot.maxMessageId === 0, boot.maxMessageId);

  // ── scrollback survives a restart, which is the entire point ────────────
  for (let i = 1; i <= 5; i++) store.saveMessage(msg(i, "global", "IMC-Subliminal", "hello " + i));
  store.saveMessage(msg(6, "custom:mining", "Rytharr", "anyone at Aaron Halo"));
  await settle();

  let hist = await store.loadHistory("global", 50);
  ok("history comes back", hist.length === 5, hist.length);
  ok("...oldest first", hist[0].text === "hello 1" && hist[4].text === "hello 5");
  ok("...with the sender intact", hist[0].from.handle === "IMC-Subliminal" && hist[0].from.verified === true);
  ok("...and is scoped to its channel", (await store.loadHistory("custom:mining", 50)).length === 1);
  ok("a channel nobody has used is empty, not an error", (await store.loadHistory("shard:nope", 50)).length === 0);

  const limited = await store.loadHistory("global", 2);
  ok("a limit returns the NEWEST rows", limited.length === 2 && limited[1].text === "hello 5",
     limited.map((m) => m.text).join(","));

  await store.close();
  store = createStore({ databaseUrl: URL, schema: SCHEMA, dataDir: "/nonexistent" });
  boot = await store.init();
  ok("RESTART: scrollback is still there", (await store.loadHistory("global", 50)).length === 5);
  // The bug this prevents: ids restarting at 1 and colliding with loaded history.
  ok("RESTART: the id counter resumes past the stored max", boot.maxMessageId === 6, boot.maxMessageId);

  // ── rooms ───────────────────────────────────────────────────────────────
  store.saveRoom({ slug: "sunday-ops", label: "Sunday Ops", category: "org-ops",
                   privacy: "private", code: "K7M2QD", owner: "imc-subliminal",
                   created: 1786000000000, lastActive: 1786000000000 });
  store.saveRoom({ slug: "halo-mining", label: "Halo Mining", category: "mining",
                   privacy: "public", code: null, owner: "rytharr",
                   created: 1786000000000, lastActive: 1786000000000 });
  store.addInvite("sunday-ops", "rytharr", "imc-subliminal");
  store.addInvite("sunday-ops", "rytharr", "imc-subliminal");   // idempotent
  store.saveBan("griefer");
  await settle();

  await store.close();
  store = createStore({ databaseUrl: URL, schema: SCHEMA, dataDir: "/nonexistent" });
  boot = await store.init();
  ok("RESTART: rooms are still there", boot.rooms.size === 2, boot.rooms.size);
  const ops = boot.rooms.get("sunday-ops");
  ok("...with their category", ops.category === "org-ops", ops.category);
  ok("...their privacy", ops.privacy === "private", ops.privacy);
  ok("...their join code", ops.code === "K7M2QD", ops.code);
  ok("...their owner", ops.owner === "imc-subliminal", ops.owner);
  ok("...and their invites, deduped", JSON.stringify(ops.invites) === '["rytharr"]', JSON.stringify(ops.invites));
  ok("a public room carries no code", boot.rooms.get("halo-mining").code === null);
  ok("RESTART: bans stick", boot.bans.has("griefer"));

  // ── saveRoom as an UPDATE, not an insert (roomconfig, 2026-08-13) ───────
  // 🔑 Until roomconfig existed, saveRoom was only ever called on a room being CREATED, so the
  // ON CONFLICT DO UPDATE half was carrying the whole feature untested. This is the path that
  // decides whether a privacy change survives the next redeploy — if `code` were missing from
  // the update list, a reopened room would come back private with its old code still live.
  store.saveRoom({ slug: "sunday-ops", label: "Sunday Ops", category: "salvage",
                   privacy: "public", code: null, owner: "imc-subliminal",
                   created: 1786000000000, lastActive: 1786000000000 });
  await settle();
  await store.close();
  store = createStore({ databaseUrl: URL, schema: SCHEMA, dataDir: "/nonexistent" });
  boot = await store.init();
  const reopened = boot.rooms.get("sunday-ops");
  ok("RECONFIG: a changed category persists", reopened.category === "salvage", reopened.category);
  ok("RECONFIG: a changed privacy persists", reopened.privacy === "public", reopened.privacy);
  ok("🔴 RECONFIG: reopening a room really drops its code", reopened.code === null, String(reopened.code));
  ok("...and it is still one room, not a second one", boot.rooms.size === 2, boot.rooms.size);
  ok("...keeping the invites written while it was closed",
     JSON.stringify(reopened.invites) === '["rytharr"]', JSON.stringify(reopened.invites));

  store.deleteBan("griefer");
  store.touchRoom("halo-mining", 1786999999000);
  await settle();
  store.deleteRoom("halo-mining");
  await settle();
  await store.close();
  store = createStore({ databaseUrl: URL, schema: SCHEMA, dataDir: "/nonexistent" });
  boot = await store.init();
  ok("an unban sticks too", !boot.bans.has("griefer"));
  ok("a deleted room is gone", !boot.rooms.has("halo-mining"), [...boot.rooms.keys()].join(","));

  // ── DM threads ──────────────────────────────────────────────────────────
  // The ordering rule matters: without it (a,b) and (b,a) are two half-conversations.
  const { dmKey } = await import("./store.mjs");
  const k1 = dmKey("IMC-Subliminal", "Rytharr");
  const k2 = dmKey("Rytharr", "IMC-Subliminal");
  ok("a DM key is the same whichever way round you build it", k1.ch === k2.ch, k1.ch + " vs " + k2.ch);
  ok("...and is lowercased", k1.ch === "dm:imc-subliminal|rytharr", k1.ch);

  const k3 = dmKey("IMC-Subliminal", "Zed");
  store.touchDm(k1.a, k1.b, 1786000005000);
  store.touchDm(k3.a, k3.b, 1786000009000);
  store.saveMessage(msg(20, k1.ch, "Rytharr", "code is K7M2QD"));
  await settle();

  const threads = await store.dmThreads("imc-subliminal");
  ok("both conversations are listed", threads.length === 2, threads.map((t) => t.other).join(","));
  ok("...newest first", threads[0].other === "zed", threads.map((t) => t.other).join(","));
  ok("the other side sees the same conversation",
     (await store.dmThreads("rytharr")).map((t) => t.other).join(",") === "imc-subliminal");
  ok("a DM's messages persist like any other channel",
     (await store.loadHistory(k1.ch, 50))[0].text === "code is K7M2QD");
  ok("someone with no DMs gets an empty list", (await store.dmThreads("nobody")).length === 0);

  // ── prune ───────────────────────────────────────────────────────────────
  for (let i = 100; i < 140; i++) store.saveMessage(msg(i, "global", "Spammer", "spam " + i));
  await settle();
  ok("all of it landed", (await store.loadHistory("global", 500)).length === 45);
  const pruned = await store.pruneMessages(10);
  ok("prune trims to the bound", pruned > 0, pruned);
  const after = await store.loadHistory("global", 500);
  ok("...keeping exactly the bound", after.length === 10, after.length);
  ok("...and keeping the NEWEST", after[9].text === "spam 139", after[9].text);
  ok("...per channel, not globally", (await store.loadHistory(k1.ch, 50)).length === 1);

  // ── pins ────────────────────────────────────────────────────────────────
  store.savePin({ ch: "global", id: 3, handle: "Rytharr", text: "meet at Checkmate", by: "IMC-Subliminal", at: 1786000000000 });
  await settle();
  let reboot = await store.init();
  ok("a pin survives a restart", reboot.pins.get("global")?.text === "meet at Checkmate",
     reboot.pins.get("global")?.text);
  ok("...carrying who wrote it and who pinned it",
     reboot.pins.get("global")?.handle === "Rytharr" && reboot.pins.get("global")?.by === "IMC-Subliminal");
  ok("...with the message id as a NUMBER, not a bigint string",
     typeof reboot.pins.get("global")?.id === "number", typeof reboot.pins.get("global")?.id);

  // One pin per room: pinning again REPLACES rather than accumulating.
  store.savePin({ ch: "global", id: 4, handle: "Zed", text: "new plan", by: "IMC-Subliminal", at: 1786000001000 });
  await settle();
  reboot = await store.init();
  ok("pinning again replaces the old pin", reboot.pins.get("global")?.text === "new plan", reboot.pins.get("global")?.text);
  ok("...and there is still only one", reboot.pins.size === 1, reboot.pins.size);

  // 🔑 A moderator pin has no message behind it, so the id must be allowed to be NULL.
  store.savePin({ ch: "region:use1b", id: null, handle: "Moderator", text: "server going down", by: "admin", at: 1786000002000 });
  await settle();
  reboot = await store.init();
  ok("a moderator pin with no message id is stored", reboot.pins.get("region:use1b")?.text === "server going down");
  ok("...and its id reads back as null", reboot.pins.get("region:use1b")?.id === null, String(reboot.pins.get("region:use1b")?.id));

  store.deletePin("global");
  await settle();
  reboot = await store.init();
  ok("unpinning removes it", !reboot.pins.has("global"));
  ok("...without touching another room's pin", reboot.pins.has("region:use1b"));

  // ── reports ─────────────────────────────────────────────────────────────
  store.saveReport({ ch: "global", about: "rytharr", by: "imc-subliminal", reason: null, id: 3, text: "something rude", at: Date.now() });
  store.saveReport({ ch: "global", about: "rytharr", by: "zed", reason: "spam", id: null, text: null, at: Date.now() });
  await settle();
  const reports = await store.listReports(50);
  ok("both reports are kept", reports.length === 2, reports.length);
  // 🔑 Two people reporting the same handle is TWO rows — the second one is the signal.
  ok("...including two about the same person", reports.filter((r) => r.about === "rytharr").length === 2);
  const withText = reports.find((r) => r.text);
  ok("...with the reported message snapshotted", withText?.text === "something rude", withText?.text);
  ok("...and its id as a number", typeof withText?.id === "number", typeof withText?.id);
  const noMsg = reports.find((r) => r.reason === "spam");
  ok("a report with no message still stores", !!noMsg && noMsg.id === null && noMsg.text === null);
  ok("...newest first", reports[0].at >= reports[1].at);

  await store.close();
} finally {
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
}

console.log(fails ? `\n${fails} FAILED` : "\nstore (postgres) tests passed");
process.exit(fails ? 1 : 0);
