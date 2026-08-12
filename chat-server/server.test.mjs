// Protocol test for the custom chat server: spawns the real server on a scratch port and
// drives two clients through auth → channels → messages → moderation. Offline by design
// (auth=dev); run with `node chat-server/server.test.mjs`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8797; // scratch — not 8788 (a dev chat server may be running) nor 8778 (sidecar)

import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
const scratchData = mkdtempSync(join(tmpdir(), "sc-chat-test-"));

// ── A stand-in for the moderation portal ───────────────────────────────────
// The chat server only ever DIALS OUT for moderation (every /admin/* route is loopback-gated),
// so testing that link means being the other end of it: receive the pushes, serve a queue of
// actions, and collect the acks. Started BEFORE the chat server so nothing races the first poll.
const MOD_PORT = 8798;
const MOD_SECRET = "test-mod-secret";
const modEvents = [];      // what the chat server pushed at us
const modQueue = [];       // what we want it to do
const modAcks = [];        // how it said each one went
const modAuthed = (req) => req.headers.authorization === `Bearer ${MOD_SECRET}`;
const portal = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (!modAuthed(req)) { res.writeHead(401); res.end(); return; }
  if (url === "/events" && req.method === "POST") {
    let s = ""; req.on("data", (c) => (s += c));
    req.on("end", () => { try { modEvents.push(JSON.parse(s)); } catch { /* ignore */ } res.writeHead(200); res.end("{}"); });
    return;
  }
  if (url === "/actions" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rows: modQueue.splice(0, modQueue.length) }));
    return;
  }
  if (url.startsWith("/actions/") && req.method === "POST") {
    let s = ""; req.on("data", (c) => (s += c));
    req.on("end", () => { modAcks.push({ id: decodeURIComponent(url.slice("/actions/".length)), body: JSON.parse(s || "{}") }); res.writeHead(200); res.end("{}"); });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => portal.listen(MOD_PORT, "127.0.0.1", r));

// Scratch word lists. Deliberately NOT the shipped ones: nonsense terms cannot collide with
// anything else this suite says, and the shipped lists' own behaviour is covered by
// automod.test.mjs (which is also where their false-positive surface is written down).
const scratchBan = join(scratchData, "ban.txt");
const scratchCensor = join(scratchData, "censor.txt");
writeFileSync(scratchBan, "# scratch\nflarnwibble\nvoid harvester\n");
writeFileSync(scratchCensor, "# scratch\nblorptastic\n");

const server = spawn(process.execPath, [join(here, "server.mjs")], {
  env: { ...process.env, CHAT_PORT: String(PORT), CHAT_AUTH: "dev", CHAT_DATA_DIR: scratchData,
         // Dev auth trusts any handle, so the server refuses to boot with it unless told.
         CHAT_ALLOW_DEV_AUTH: "1",
         AUTOMOD_MODE: "on", AUTOMOD_BAN_LIST: scratchBan, AUTOMOD_CENSOR_LIST: scratchCensor,
         REPORT_WEBHOOK_URL: `http://127.0.0.1:${MOD_PORT}/events`,
         MOD_ACTION_URL: `http://127.0.0.1:${MOD_PORT}/actions`,
         MOD_SHARED_SECRET: MOD_SECRET, MOD_POLL_MS: "200" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tiny test client: buffers every frame, lets the test await one by predicate. */
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const frames = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data);
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) { waiters[i].resolve(f); waiters.splice(i, 1); }
    }
  };
  return {
    ws, frames,
    send: (f) => ws.send(JSON.stringify(f)),
    open: () => new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }),
    next: (pred, why, ms = 3000) =>
      new Promise((resolve, reject) => {
        const hit = frames.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error(`timeout waiting for: ${why}\nserver log:\n${serverLog}`)), ms);
        waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
      }),
  };
}

try {
  // Server up?
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await wait(250);
    try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { /* not yet */ }
  }
  assert(up, `chat server never answered /health\n${serverLog}`);

  // ── Auth + auto-join global ──
  const a = client();
  await a.open();
  a.send({ t: "hello", handle: "SubTest" });
  const wa = await a.next((f) => f.t === "welcome", "welcome A");
  assert.equal(wa.you.handle, "SubTest");
  await a.next((f) => f.t === "joined" && f.ch === "global", "A joins global");
  await a.next((f) => f.t === "history" && f.ch === "global", "A gets global history");

  // A bad handle is refused before it can say anything.
  const bad = client();
  await bad.open();
  bad.send({ t: "hello", handle: "x" });
  await bad.next((f) => f.t === "error" && f.code === "bad_auth", "junk handle refused");

  // ── Location → TWO tiers: region (US East 1B) and the DGS. No shard room. ──
  // 🔑 The AZ LETTER is part of the region key, so use1b and use1a are different rooms — this
  // is already "everyone specifically on US East 1B", which is why the shard tier was dropped.
  a.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: "aaaa111122" });
  await a.next((f) => f.t === "joined" && f.ch === "region:use1b", "A joins its region");
  await wait(250);
  assert(!a.frames.some((f) => f.t === "joined" && String(f.ch).startsWith("shard:")),
    "no shard room is created at all — the tier is gone, not merely hidden");

  // Second client, same region — must see A's message; a third in another region must not.
  const b = client();
  await b.open();
  b.send({ t: "hello", handle: "WingmanTest" });
  await b.next((f) => f.t === "welcome", "welcome B");
  b.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: "aaaa111122" });
  await b.next((f) => f.t === "joined" && f.ch === "region:use1b", "B joins the same region");

  const c = client();
  await c.open();
  c.send({ t: "hello", handle: "StrangerTest" });
  await c.next((f) => f.t === "welcome", "welcome C");
  c.send({ t: "loc", region: "usw2a", shard: "pub_usw2a_12326004_007", dgs: "cccc333344" });
  await c.next((f) => f.t === "joined" && f.ch === "region:usw2a", "C joins its own region");

  a.send({ t: "msg", ch: "region:use1b", text: "meet at Seraphim?" });
  const got = await b.next((f) => f.t === "msg" && f.ch === "region:use1b", "B hears A");
  assert.equal(got.text, "meet at Seraphim?");
  assert.equal(got.from.handle, "SubTest");
  assert.equal(got.from.verified, true);

  // Global reaches everyone, including the client in another region.
  a.send({ t: "msg", ch: "global", text: "hello universe" });
  await c.next((f) => f.t === "msg" && f.ch === "global" && f.text === "hello universe", "C hears global");
  // ...but C never saw the shard message (it was never a member).
  assert(!c.frames.some((f) => f.t === "msg" && f.ch === "region:use1b"), "region chat must not leak across regions");

  // Sending into a channel you're not in is refused.
  c.send({ t: "msg", ch: "region:use1b", text: "sneaky" });
  await c.next((f) => f.t === "error" && f.code === "not_member", "cross-region send refused");

  // ── Region hop: a new loc replaces the old location rooms, keeps global ──
  b.send({ t: "loc", region: "usw2a", shard: "pub_usw2a_12326004_007", dgs: "bbbb222233" });
  await b.next((f) => f.t === "left" && f.ch === "region:use1b", "B leaves the old region");
  await b.next((f) => f.t === "joined" && f.ch === "region:usw2a", "B joins the new one");

  // Leaving the PU (menu/quit): loc with nulls drops the location rooms, keeps global.
  b.send({ t: "loc", region: null, shard: null, dgs: null });
  await b.next((f) => f.t === "left" && f.ch === "region:usw2a", "B leaves region on menu");

  // ── History: a late joiner sees the scrollback ──
  const late = client();
  await late.open();
  late.send({ t: "hello", handle: "LateTest" });
  await late.next((f) => f.t === "welcome", "welcome late");
  const hist = await late.next((f) => f.t === "history" && f.ch === "global", "late history");
  assert(hist.msgs.some((m) => m.text === "hello universe"), "history must carry earlier messages");

  // ── Rate limit: 6th message inside the window is refused ──
  for (let i = 0; i < 6; i++) a.send({ t: "msg", ch: "global", text: `spam ${i}` });
  await a.next((f) => f.t === "error" && f.code === "rate", "rate limit trips");

  // ── Ban (loopback admin): banned handle is kicked and cannot reconnect ──
  const res = await fetch(`http://127.0.0.1:${PORT}/admin/ban`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "strangertest" }),
  });
  assert((await res.json()).ok, "ban should apply");
  await c.next((f) => f.t === "error" && f.code === "banned", "banned client is told");
  const c2 = client();
  await c2.open();
  c2.send({ t: "hello", handle: "StrangerTest" });
  await c2.next((f) => f.t === "error" && f.code === "banned", "banned handle cannot rejoin");
  await fetch(`http://127.0.0.1:${PORT}/admin/unban`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "strangertest" }),
  });

  // ── v2: member lists ride presence ──
  const withMembers = await a.next((f) => f.t === "presence" && f.ch === "global" && Array.isArray(f.members), "presence carries members");
  assert(withMembers.members.every((m) => typeof m.handle === "string" && typeof m.verified === "boolean"), "member rows have handle+verified");
  assert(withMembers.count >= 1, "count is at least the sender");

  // ── v2: org auto-join (dev passthrough) ──
  const o = client();
  await o.open();
  o.send({ t: "hello", handle: "OrgPilot", org: { sid: "IRREGS", name: "7th Nul Irregulars" } });
  const oj = await o.next((f) => f.t === "joined" && f.ch === "org:irregs", "org room auto-joined");
  assert.equal(oj.label, "7th Nul Irregulars", "org room carries the org NAME as label");
  assert.equal(oj.kind, "org");
  await o.next((f) => f.t === "dir" && Array.isArray(f.channels), "directory arrives on welcome");

  // ── v2: custom rooms — create, directory, join by name, leave ──
  o.send({ t: "join", name: "Salvage Crew" });
  const cj = await o.next((f) => f.t === "joined" && f.ch === "custom:salvage-crew", "custom room created+joined");
  assert.equal(cj.label, "Salvage Crew", "custom room keeps display casing");
  // mode:"create" on a taken name refuses; mode:"join" on a missing one refuses.
  o.send({ t: "join", name: "salvage crew", mode: "create" });
  await o.next((f) => f.t === "error" && f.code === "channel_exists", "create refuses a taken name");
  o.send({ t: "join", name: "no such room", mode: "join" });
  await o.next((f) => f.t === "error" && f.code === "no_such_channel", "join refuses a missing name");
  // Another client sees it in the directory and joins by the same display name.
  const dirSeen = await a.next((f) => f.t === "dir" && f.channels.some((c) => c.ch === "custom:salvage-crew"), "directory broadcast reaches others");
  assert.equal(dirSeen.channels.find((c) => c.ch === "custom:salvage-crew").label, "Salvage Crew");
  a.send({ t: "join", name: "SALVAGE CREW", mode: "join" });
  await a.next((f) => f.t === "joined" && f.ch === "custom:salvage-crew", "join is case-insensitive on the name");
  const waitMsg = a.next((f) => f.t === "msg" && f.ch === "custom:salvage-crew", "custom room delivers");
  o.send({ t: "msg", ch: "custom:salvage-crew", text: "anyone got a Reclaimer?" });
  await waitMsg;
  // Leaving: custom yes, auto/org no.
  a.send({ t: "leave", ch: "custom:salvage-crew" });
  await a.next((f) => f.t === "left" && f.ch === "custom:salvage-crew", "custom room left");
  o.send({ t: "leave", ch: "org:irregs" });
  await o.next((f) => f.t === "error" && f.code === "bad_channel", "org room refuses leave");
  // Location churn must NOT drop org/custom membership.
  o.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: "eeee555566" });
  await o.next((f) => f.t === "joined" && f.ch === "region:use1b", "org client lands in its region");
  o.send({ t: "loc", region: null, shard: null, dgs: null });
  await o.next((f) => f.t === "left" && f.ch === "region:use1b", "loc churn drops region");
  o.send({ t: "msg", ch: "org:irregs", text: "still here" });
  await o.next((f) => f.t === "msg" && f.ch === "org:irregs" && f.text === "still here", "org membership survived loc churn");

  // ── emoji survive the round trip, and truncation never splits one ──
  // 🔑 A FRESH client: `a` burned its rate-limit window on the spam test above, and a
  // rate-refused send looks exactly like a delivery failure from the outside.
  const em1 = client();
  await em1.open();
  em1.send({ t: "hello", handle: "EmojiTest" });
  await em1.next((f) => f.t === "welcome", "welcome emoji client");
  const emojiWait = em1.next((f) => f.t === "msg" && f.ch === "global" && f.text.includes("🫡"), "emoji delivered intact");
  em1.send({ t: "msg", ch: "global", text: "o7 🫡 mining ⛏️ done 💯" });
  const em = await emojiWait;
  assert.equal(em.text, "o7 🫡 mining ⛏️ done 💯", "multi-byte emoji survive byte-for-byte");
  // 🔑 400 emoji is 800 UTF-16 units — a .slice(0,400) would cut the 400th in half and emit a
  // lone surrogate. Truncation is by code point, so the tail must still be a whole emoji.
  const longWait = em1.next((f) => f.t === "msg" && f.ch === "global" && f.text.startsWith("🚀"), "long emoji message");
  em1.send({ t: "msg", ch: "global", text: "🚀".repeat(500) });
  const long = await longWait;
  assert.equal([...long.text].length, 400, "truncated to 400 CODE POINTS");
  assert(!/[\uD800-\uDFFF]/.test(long.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")),
    "no lone surrogate survives truncation");

  // ── room categories, privacy, join codes and invites ──────────────────────
  // Sub, 2026-08-09: rooms are categorised by the gameplay people are doing, and creating one
  // must no longer publish it to everybody by force.
  const owner = client();
  await owner.open();
  owner.send({ t: "hello", handle: "RoomOwner" });
  const ownerWelcome = await owner.next((f) => f.t === "welcome", "welcome room owner");
  assert(Array.isArray(ownerWelcome.categories) && ownerWelcome.categories.length === 12,
    "the welcome frame carries the activity list the dropdown is built from");
  assert(ownerWelcome.categories.some((c) => c.slug === "org-ops" && c.label === "Org Operations"),
    "categories are {slug,label}");

  // A PUBLIC room is listed, and carries its category.
  owner.send({ t: "join", name: "Halo Mining", mode: "create", category: "mining", privacy: "public" });
  await owner.next((f) => f.t === "joined" && f.ch === "custom:halo-mining", "created a public room");
  const pubInfo = await owner.next((f) => f.t === "roominfo" && f.ch === "custom:halo-mining", "roominfo for the public room");
  assert.equal(pubInfo.category, "mining", "the category was stored");
  assert.equal(pubInfo.privacy, "public");
  assert.equal(pubInfo.code, undefined, "a public room has no join code to leak");
  const pubDir = await owner.next(
    (f) => f.t === "dir" && f.channels.some((c) => c.ch === "custom:halo-mining"), "public room is in the directory");
  assert.equal(pubDir.channels.find((c) => c.ch === "custom:halo-mining").category, "mining",
    "the directory carries the category so it can group by activity");

  // A PRIVATE room is not.
  owner.send({ t: "join", name: "Sunday Ops", mode: "create", category: "org-ops", privacy: "private" });
  await owner.next((f) => f.t === "joined" && f.ch === "custom:sunday-ops", "created a private room");
  const privInfo = await owner.next((f) => f.t === "roominfo" && f.ch === "custom:sunday-ops", "roominfo for the private room");
  assert.equal(privInfo.privacy, "private");
  assert.match(privInfo.code, /^[A-HJ-NP-Z2-9]{6}$/, "a private room gets a shareable code with no O/0/I/1");
  const code = privInfo.code;
  await wait(700);   // the directory broadcast is debounced
  const lastDir = [...owner.frames].reverse().find((f) => f.t === "dir");
  assert(!lastDir.channels.some((c) => c.ch === "custom:sunday-ops"),
    "🔑 a private room is ABSENT from the directory, not merely flagged in it");

  // An outsider can't get in, and isn't told the room exists.
  const outsider = client();
  await outsider.open();
  outsider.send({ t: "hello", handle: "Outsider" });
  await outsider.next((f) => f.t === "welcome", "welcome outsider");
  outsider.send({ t: "join", name: "Sunday Ops", mode: "join" });
  const refused = await outsider.next((f) => f.t === "error", "outsider refused");
  assert.equal(refused.code, "no_such_channel",
    "🔑 a private room reads as NON-EXISTENT — 'that's private' would confirm the name to anyone guessing");

  // ...but the code lets them in.
  outsider.send({ t: "join", name: code });
  await outsider.next((f) => f.t === "joined" && f.ch === "custom:sunday-ops", "the join code admits an outsider");
  const lower = await outsider.next((f) => f.t === "roominfo" && f.ch === "custom:sunday-ops", "roominfo after code join");
  assert.equal(lower.code, code, "someone inside the room can see the code, to pass it on");
  outsider.send({ t: "leave", ch: "custom:sunday-ops" });
  await outsider.next((f) => f.t === "left" && f.ch === "custom:sunday-ops", "outsider left");

  // 🔑 Redeeming the code recorded an invite, so they can now get back in BY NAME. Without
  // this the client's rejoin-by-name on reconnect would silently drop them from the room.
  outsider.send({ t: "join", name: "Sunday Ops", mode: "join" });
  await outsider.next((f) => f.t === "joined" && f.ch === "custom:sunday-ops",
    "having used the code once, they rejoin by name — a reconnect must not lock them out");
  outsider.send({ t: "leave", ch: "custom:sunday-ops" });
  await outsider.next((f) => f.t === "left" && f.ch === "custom:sunday-ops", "outsider left again");

  // A lowercase code still works — it gets read off Discord and typed by hand.
  outsider.send({ t: "join", name: code.toLowerCase() });
  await outsider.next((f) => f.t === "joined" && f.ch === "custom:sunday-ops", "codes are case-insensitive");

  // Invite by handle: the second door, and owner-only.
  const guest = client();
  await guest.open();
  guest.send({ t: "hello", handle: "Guest" });
  await guest.next((f) => f.t === "welcome", "welcome guest");
  outsider.send({ t: "invite", ch: "custom:sunday-ops", handle: "Guest" });
  const notOwner = await outsider.next((f) => f.t === "error" && f.code === "not_owner", "a member cannot invite");
  assert(notOwner, "only the owner may widen access");

  owner.send({ t: "invite", ch: "custom:sunday-ops", handle: "Guest" });
  await owner.next((f) => f.t === "invited" && f.handle === "Guest", "invite recorded");
  const ping = await guest.next((f) => f.t === "roominvite" && f.ch === "custom:sunday-ops", "the invitee is told");
  assert.equal(ping.from, "RoomOwner");
  assert.equal(ping.label, "Sunday Ops");
  guest.send({ t: "join", name: "Sunday Ops", mode: "join" });
  await guest.next((f) => f.t === "joined" && f.ch === "custom:sunday-ops", "an invited handle joins by NAME, no code");

  // A v1 client (0.1.41) sends neither field and must still get exactly what it always got.
  owner.send({ t: "join", name: "Old Client Room", mode: "create" });
  const v1 = await owner.next((f) => f.t === "roominfo" && f.ch === "custom:old-client-room", "v1-shaped create still works");
  assert.equal(v1.privacy, "public", "backward compatible: no privacy field means public");
  assert.equal(v1.category, "social", "backward compatible: no category means Social / Other");
  // A junk category is corrected, not refused — the room is what the user wanted either way.
  owner.send({ t: "join", name: "Junk Cat", mode: "create", category: "not-a-real-category" });
  const junk = await owner.next((f) => f.t === "roominfo" && f.ch === "custom:junk-cat", "junk category");
  assert.equal(junk.category, "social", "an unknown category falls back rather than failing the create");

  // ── ORG ISOLATION ─────────────────────────────────────────────────────────
  // 🔴 Sub's stated top priority: "I don't want someone to be able to spy on a rival org."
  // Org membership comes ONLY from the verified RSI dossier at hello — there is no frame that
  // joins an org room, and these assertions are what keep it that way.
  const rival = client();
  await rival.open();
  rival.send({ t: "hello", handle: "RivalSpy", org: { sid: "RIVALS", name: "Rival Corp" } });
  await rival.next((f) => f.t === "welcome", "welcome rival");
  await rival.next((f) => f.t === "joined" && f.ch === "org:rivals", "rival lands in its OWN org");

  // Reading someone else's org is refused by membership, like any other room.
  rival.send({ t: "msg", ch: "org:irregs", text: "listening in" });
  await rival.next((f) => f.t === "error" && f.code === "not_member", "cannot post into another org");

  // There is no join verb for orgs — the custom-room one slugifies the colon away, so it can
  // only ever create `custom:orgirregs`, never `org:irregs`.
  rival.send({ t: "join", name: "org:IRREGS" });
  await wait(300);
  assert(!rival.frames.some((f) => f.t === "joined" && f.ch === "org:irregs"),
    "the custom-room join cannot reach an org room");

  // 🔑 And `loc` cannot either. It is the one frame whose channel names come from the client,
  // so it is the natural place to try to smuggle a prefix. region/shard/dgs are all shape-checked
  // and none of the patterns permits a colon.
  rival.send({ t: "loc", region: "org:irregs", shard: "org:irregs", dgs: "org:irregs" });
  await wait(300);
  assert(!rival.frames.some((f) => f.t === "joined" && String(f.ch).startsWith("org:") && f.ch !== "org:rivals"),
    "a crafted loc cannot smuggle its way into an org room");

  // The org room really is carrying traffic for its own members only.
  const orgMate = client();
  await orgMate.open();
  orgMate.send({ t: "hello", handle: "OrgMate", org: { sid: "IRREGS", name: "7th Nul Irregulars" } });
  await orgMate.next((f) => f.t === "joined" && f.ch === "org:irregs", "org mate joins");
  o.send({ t: "msg", ch: "org:irregs", text: "org secret" });
  await orgMate.next((f) => f.t === "msg" && f.text === "org secret", "org mates hear each other");
  await wait(200);
  assert(!rival.frames.some((f) => f.t === "msg" && f.text === "org secret"),
    "🔴 the rival NEVER sees org traffic");

  // ── impersonation guard ───────────────────────────────────────────────────
  // 🔴 Demonstrated on Sub's own server: a tester made rooms called irregs, sabreraven, ltx,
  // sbb and imc-subliminallianori. Nothing technical broke — the harm is that a member joins
  // the fake "irregs" thinking it is the org channel and talks freely in it.
  rival.send({ t: "join", name: "IRREGS", mode: "create" });
  const taken = await rival.next((f) => f.t === "error" && f.code === "name_reserved", "org name is reserved");
  assert.match(taken.message, /org or a player/, "and it says why");

  rival.send({ t: "join", name: "OrgPilot", mode: "create" });
  await rival.next((f) => f.t === "error" && f.code === "name_reserved", "a player's handle is reserved too");

  // Its OWN org counts as well — you cannot squat your own org's name either, because the room
  // would still be mistaken for the real channel by everyone else in it.
  rival.send({ t: "join", name: "RIVALS", mode: "create" });
  await rival.next((f) => f.t === "error" && f.code === "name_reserved", "your own org is reserved");

  // Ordinary names are unaffected — the guard must not turn into "no rooms allowed".
  rival.send({ t: "join", name: "Sunday Salvage", mode: "create" });
  await rival.next((f) => f.t === "joined" && f.ch === "custom:sunday-salvage", "a normal name still works");
  rival.send({ t: "deleteRoom", ch: "custom:sunday-salvage" });
  await rival.next((f) => f.t === "left" && f.ch === "custom:sunday-salvage", "cleaned up");

  // ── the DGS tier, and the rate limit on access attempts ───────────────────
  // region -> shard -> dgs. The DGS key is a HASH of the server's ip:port produced by the
  // client, so this server never sees or rebroadcasts a CIG address.
  const loc = client();
  await loc.open();
  loc.send({ t: "hello", handle: "Traveller" });
  await loc.next((f) => f.t === "welcome", "welcome traveller");
  loc.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: "a3f9c21e04" });
  await loc.next((f) => f.t === "joined" && f.ch === "dgs:a3f9c21e04", "joined the DGS room");
  await loc.next((f) => f.t === "joined" && f.ch === "region:use1b", "and the region");

  // Meshing hands you to another DGS WITHIN the same shard - the finest room must follow.
  loc.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: "bb11cc22dd" });
  await loc.next((f) => f.t === "left" && f.ch === "dgs:a3f9c21e04", "left the old DGS");
  await loc.next((f) => f.t === "joined" && f.ch === "dgs:bb11cc22dd", "joined the new one");
  assert(loc.frames.every((f) => !(f.t === "left" && f.ch === "region:use1b")),
    "...without churning the region room, which did not change");

  // Anything that is not exactly what dgsKey() emits is not a DGS key. This is what stops a
  // crafted value smuggling in a different key space.
  // (Uppercase hex is NOT in this list: it lower-cases to a valid key, which is correct
  // normalisation rather than a bypass — the key space is unchanged.)
  for (const bad of ["1.2.3.4:64304", "a3f9c21e0", "a3f9c21e04x", "../global", "deadbeefzz"]) {
    const mark = loc.frames.length;   // only judge frames from THIS attempt onwards
    loc.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: bad });
    await wait(80);
    const joined = loc.frames.slice(mark).filter((f) => f.t === "joined" && String(f.ch).startsWith("dgs:"));
    assert.equal(joined.length, 0, "a malformed DGS key is refused: " + bad);
  }

  // Access attempts are rate limited. `msg` always was; `join` was not - and join doubles as
  // "redeem this 6-character code", so unlimited attempts meant unlimited code guessing.
  const bf = client();
  await bf.open();
  bf.send({ t: "hello", handle: "Bruteforcer" });
  await bf.next((f) => f.t === "welcome", "welcome bruteforcer");
  for (let i = 0; i < 20; i++) bf.send({ t: "join", name: "ABC" + String(i).padStart(3, "2") });
  const limited = await bf.next((f) => f.t === "error" && f.code === "rate", "join attempts are rate limited");
  assert(limited, "a code guesser is throttled");

  // ── deleting a room ───────────────────────────────────────────────────────
  // Sub's reason is moderation: a room's NAME is broadcast to every user in the directory, so
  // an inappropriate one is a problem the moment it exists — "wait for the 14-day idle prune"
  // is not an answer.
  owner.send({ t: "join", name: "Doomed Room", mode: "create", category: "mining", privacy: "public" });
  await owner.next((f) => f.t === "joined" && f.ch === "custom:doomed-room", "created the doomed room");
  guest.send({ t: "join", name: "Doomed Room", mode: "join" });
  await guest.next((f) => f.t === "joined" && f.ch === "custom:doomed-room", "guest joined it");

  guest.send({ t: "deleteRoom", ch: "custom:doomed-room" });
  await guest.next((f) => f.t === "error" && f.code === "not_owner", "a member cannot delete a room");

  owner.send({ t: "deleteRoom", ch: "custom:doomed-room" });
  const evicted = await guest.next((f) => f.t === "left" && f.ch === "custom:doomed-room", "the guest is evicted");
  assert.equal(evicted.reason, "deleted",
    "the eviction says WHY — a channel that just vanishes reads as a disconnect and the client would try to rejoin it");
  await guest.next((f) => f.t === "notice" && /Doomed Room/.test(f.text ?? ""), "and the guest is told");
  await wait(700);
  const dirAfter = [...owner.frames].reverse().find((f) => f.t === "dir");
  assert(!dirAfter.channels.some((c) => c.ch === "custom:doomed-room"), "gone from the directory");

  // Really gone: re-creating it must be a CREATE, not a join onto leftover state.
  owner.send({ t: "join", name: "Doomed Room", mode: "create", category: "salvage", privacy: "public" });
  await wait(400);
  // 🔑 The LAST matching frame, not next(): the helper searches already-buffered frames from the
  // start, so it would hand back the roominfo from the room's first life and the assertion would
  // "fail" on a server that behaved perfectly.
  const reborn = [...owner.frames].reverse().find((f) => f.t === "roominfo" && f.ch === "custom:doomed-room");
  assert.equal(reborn.category, "salvage", "the new room is genuinely new, not the old one revived");
  owner.send({ t: "deleteRoom", ch: "custom:doomed-room" });
  await owner.next((f) => f.t === "left" && f.ch === "custom:doomed-room", "cleaned up");

  // The loopback admin route — the ONLY way to remove a room with no owner, which is every
  // room imported from the old channels.json.
  const roomsBefore = await (await fetch(`http://127.0.0.1:${PORT}/admin/rooms`)).json();
  assert(Array.isArray(roomsBefore) && roomsBefore.some((r) => r.slug === "halo-mining"),
    "admin can list rooms");
  const del = await (await fetch(`http://127.0.0.1:${PORT}/admin/room-delete`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "halo-mining" }),
  })).json();
  assert.equal(del.ok, true, "admin delete succeeds");
  const roomsAfter = await (await fetch(`http://127.0.0.1:${PORT}/admin/rooms`)).json();
  assert(!roomsAfter.some((r) => r.slug === "halo-mining"), "admin delete removes an ownerless room");

  // ── direct messages ───────────────────────────────────────────────────────
  const dmA = client();
  await dmA.open();
  dmA.send({ t: "hello", handle: "Alice" });
  await dmA.next((f) => f.t === "welcome", "welcome Alice");
  const dmB = client();
  await dmB.open();
  dmB.send({ t: "hello", handle: "Bob" });
  await dmB.next((f) => f.t === "welcome", "welcome Bob");

  dmA.send({ t: "dm", to: "Bob", text: "code is " + code });
  const gotA = await dmA.next((f) => f.t === "msg" && f.ch.startsWith("dm:"), "sender sees their own DM");
  const gotB = await dmB.next((f) => f.t === "msg" && f.ch.startsWith("dm:"), "recipient receives the DM");
  assert.equal(gotB.text, "code is " + code, "which is the whole point of DMs — handing over a join code");
  assert.equal(gotA.ch, gotB.ch, "both ends are in the SAME room");
  assert.equal(gotA.ch, "dm:alice|bob", "the room key is the ordered, lowercased pair");

  // Replying the other way must not open a second half-conversation.
  dmB.send({ t: "dm", to: "Alice", text: "on my way" });
  const back = await dmA.next((f) => f.t === "msg" && f.text === "on my way", "reply arrives");
  assert.equal(back.ch, "dm:alice|bob", "🔑 (a,b) and (b,a) are ONE conversation, not two");

  dmA.send({ t: "dm", to: "Alice", text: "hello me" });
  await dmA.next((f) => f.t === "error" && f.code === "bad_handle", "you can't DM yourself");
  dmA.send({ t: "dm", to: "not a handle!", text: "hi" });
  await dmA.next((f) => f.t === "error" && f.code === "bad_handle", "a malformed handle is refused");

  // A third party must not be able to reach into someone else's conversation.
  const nosy = client();
  await nosy.open();
  nosy.send({ t: "hello", handle: "Nosy" });
  await nosy.next((f) => f.t === "welcome", "welcome Nosy");
  nosy.send({ t: "msg", ch: "dm:alice|bob", text: "let me in" });
  const kept = await nosy.next((f) => f.t === "error" && f.code === "not_member", "outsiders can't post into a DM");
  assert(kept, "DM membership is enforced by the same not_member rule as every other room");

  // ── pins: owner only, and the ownerless rooms refuse outright ────────────
  const pinOwner = client();
  await pinOwner.open();
  pinOwner.send({ t: "hello", handle: "Owner" });
  await pinOwner.next((f) => f.t === "welcome", "welcome Owner");
  pinOwner.send({ t: "join", name: "Pin Room", mode: "create" });
  const room = await pinOwner.next((f) => f.t === "joined" && f.kind === "custom", "the room is created");
  pinOwner.send({ t: "msg", ch: room.ch, text: "meet at Checkmate" });
  const pinMe = await pinOwner.next((f) => f.t === "msg" && f.text === "meet at Checkmate", "a message to pin");

  const guest2 = client();
  await guest2.open();
  guest2.send({ t: "hello", handle: "Guest2" });
  await guest2.next((f) => f.t === "welcome", "welcome Guest2");
  guest2.send({ t: "join", name: "Pin Room" });
  await guest2.next((f) => f.t === "joined" && f.ch === room.ch, "the guest joins it");

  guest2.send({ t: "pin", ch: room.ch, id: pinMe.id });
  await guest2.next((f) => f.t === "error" && f.code === "not_owner", "a guest cannot pin");

  pinOwner.send({ t: "pin", ch: room.ch, id: pinMe.id });
  const pinned = await guest2.next((f) => f.t === "pin" && f.pin, "the pinOwner's pin reaches the room");
  assert.equal(pinned.pin.text, "meet at Checkmate", "the pinned TEXT is carried, not just an id");
  assert.equal(pinned.pin.by, "Owner", "the pin records who pinned it");

  // A joiner must be told about an existing pin, or a notice is only ever seen by whoever
  // happened to be watching when it was set.
  const lateJoiner = client();
  await lateJoiner.open();
  lateJoiner.send({ t: "hello", handle: "Latecomer" });
  await lateJoiner.next((f) => f.t === "welcome", "welcome Latecomer");
  lateJoiner.send({ t: "join", name: "Pin Room" });
  const onJoin = await lateJoiner.next((f) => f.t === "pin" && f.ch === room.ch, "the pin arrives on join");
  assert.equal(onJoin.pin.text, "meet at Checkmate", "and it is the same notice");

  // 🔑 An unpin must REACH clients as an explicit null, or a cleared notice sits there forever.
  pinOwner.send({ t: "unpin", ch: room.ch });
  const cleared = await guest2.next((f) => f.t === "pin" && f.pin === null, "an unpin broadcasts pin:null");
  assert.equal(cleared.pin, null, "pin:null is a value, not an omitted field");

  // Global has no pinOwner at all, so the widget path must refuse rather than half-work.
  pinOwner.send({ t: "pin", ch: "global", id: pinMe.id });
  await pinOwner.next((f) => f.t === "error" && f.code === "not_owner", "nobody owns Global, so nobody pins it here");

  // ── reporting ─────────────────────────────────────────────────────────────
  guest2.send({ t: "report", ch: room.ch, handle: "Owner", id: pinMe.id });
  const ack = await guest2.next((f) => f.t === "reported", "the reporter gets an acknowledgement");
  assert.equal(ack.handle, "Owner", "the acknowledgement names who was reported");
  // 🔑 Nothing may reach the room. A report that announced itself would tell the reported player
  // who reported them, which is the one thing a report must never do.
  await wait(150);
  assert(!pinOwner.frames.some((f) => f.t === "reported" || (f.t === "notice" && /report/i.test(f.text ?? ""))),
    "the reported player is told NOTHING");

  guest2.send({ t: "report", ch: room.ch, handle: "Guest2" });
  await guest2.next((f) => f.t === "error" && f.code === "bad_handle", "you cannot report yourself");
  guest2.send({ t: "report", ch: room.ch, handle: "not a handle!" });
  await guest2.next((f) => f.t === "error" && f.code === "bad_handle", "a malformed handle is refused");

  // ── party listings + applications ────────────────────────────────────────
  const pfLead = client();
  await pfLead.open();
  pfLead.send({ t: "hello", handle: "PartyLead" });
  await pfLead.next((f) => f.t === "welcome", "welcome PartyLead");
  pfLead.send({
    t: "join", name: "Halo Mining Run", mode: "create", category: "mining", privacy: "public",
    party: true, location: "Aaron Halo", sizeMax: 4, joinMode: "apply", voice: "optional", minutes: 90,
  });
  const pfRoom = await pfLead.next((f) => f.t === "roominfo" && f.party === true, "the listing is created");
  assert.equal(pfRoom.location, "Aaron Halo", "location is carried");
  assert.equal(pfRoom.sizeMax, 4, "size is carried");
  assert.equal(pfRoom.joinMode, "apply", "join mode is carried");
  assert(pfRoom.expiresAt > Date.now(), "it expires in the future");
  // 🔑 A DURATION was sent, never a timestamp — the server owns the clock.
  assert(pfRoom.expiresAt <= Date.now() + 91 * 60_000, "expiry comes from the duration, not the client clock");

  // Clamping: the server must not trust any of it.
  pfLead.send({
    t: "join", name: "Silly Numbers", mode: "create", category: "mining", privacy: "public",
    party: true, sizeMax: 9999, joinMode: "whatever", voice: "shouting", minutes: 99999,
  });
  const pfClamp = await pfLead.next((f) => f.t === "roominfo" && f.ch === "custom:silly-numbers", "clamped listing");
  assert.equal(pfClamp.sizeMax, 50, "an absurd size is clamped, not stored");
  assert.equal(pfClamp.joinMode, "open", "an unknown join mode falls back to open");
  assert.equal(pfClamp.voice, "none", "an unknown voice mode falls back to none");
  assert(pfClamp.expiresAt <= Date.now() + (12 * 60 + 1) * 60_000, "expiry is capped");

  const pfSeeker = client();
  await pfSeeker.open();
  pfSeeker.send({ t: "hello", handle: "Seeker" });
  await pfSeeker.next((f) => f.t === "welcome", "welcome Seeker");
  const pfDir = await pfSeeker.next(
    (f) => f.t === "dir" && f.channels.some((c) => c.ch === "custom:halo-mining-run" && c.party), "the listing reaches the board");
  const pfEntry = pfDir.channels.find((c) => c.ch === "custom:halo-mining-run");
  assert.equal(pfEntry.location, "Aaron Halo", "the board shows where");
  assert.equal(pfEntry.joinMode, "apply", "the board shows how to get in");

  // 🔑 Applying must NOT join you — that is the entire difference from an open listing.
  pfSeeker.send({ t: "apply", ch: "custom:halo-mining-run", note: "have a Prospector" });
  await pfSeeker.next((f) => f.t === "applied", "the applicant is acknowledged");
  await wait(200);
  assert(!pfSeeker.frames.some((f) => f.t === "joined" && f.ch === "custom:halo-mining-run"),
    "applying does not put you in the room");
  await pfLead.next((f) => f.t === "notice" && /Seeker asked to join/.test(f.text ?? ""), "the owner is told");
  const pfWithApps = await pfLead.next(
    (f) => f.t === "roominfo" && Array.isArray(f.applications) && f.applications.length === 1, "the owner sees the application");
  assert.equal(pfWithApps.applications[0].handle, "seeker", "the applicant is named");
  assert.equal(pfWithApps.applications[0].note, "have a Prospector", "their note comes with it");

  // 🔴 THE GATE. An 'apply' listing is public so people can find it, so the approval check
  // cannot live in `privacy` — without an explicit refusal here, joining by NAME walks straight
  // past the owner's approval and "you approve people" means nothing.
  pfSeeker.send({ t: "join", name: "Halo Mining Run" });
  await pfSeeker.next((f) => f.t === "error" && f.code === "not_invited", "you cannot just walk into an apply-only group");
  await wait(150);
  assert(!pfSeeker.frames.some((f) => f.t === "joined" && f.ch === "custom:halo-mining-run"),
    "and no membership was handed out anyway");

  // Only the owner may resolve an application.
  pfSeeker.send({ t: "acceptApplication", ch: "custom:halo-mining-run", handle: "seeker" });
  await pfSeeker.next((f) => f.t === "error" && f.code === "not_owner", "an applicant cannot accept themselves");

  pfLead.send({ t: "acceptApplication", ch: "custom:halo-mining-run", handle: "seeker" });
  await pfSeeker.next((f) => f.t === "notice" && /was accepted/.test(f.text ?? ""), "the applicant is told");

  // 🔑 Accepting writes an INVITE, so the ordinary join path now admits them — one way in, not
  // two. And the application list is OWNER-ONLY: nobody else learns who wants in.
  pfSeeker.send({ t: "join", name: "Halo Mining Run" });
  const pfSeekerInfo = await pfSeeker.next((f) => f.t === "roominfo" && f.ch === "custom:halo-mining-run", "an accepted applicant can now join");
  assert.equal(pfSeekerInfo.applications, undefined, "a non-owner is never shown the applicant list");
  const pfCleared = await pfLead.next(
    (f) => f.t === "roominfo" && Array.isArray(f.applications) && f.applications.length === 0, "the application is cleared");
  assert(pfCleared, "resolving removes it from the queue");
  pfLead.send({ t: "acceptApplication", ch: "custom:halo-mining-run", handle: "seeker" });
  await pfLead.next((f) => f.t === "error" && f.code === "bad_handle", "the same application cannot be resolved twice");

  // An OPEN listing refuses applications outright — there is nothing to apply for.
  pfSeeker.send({ t: "apply", ch: "custom:silly-numbers" });
  await pfSeeker.next((f) => f.t === "error" && f.code === "bad_channel", "an open listing has nothing to apply to");

  // ── Auto-moderation + the moderation link ─────────────────────────────────
  // Everything here is end-to-end through the REAL outbound path: the chat server pushes to the
  // portal stub and pulls its action queue. The matcher itself is covered in automod.test.mjs.
  const until = async (pred, why, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (pred()) return true; await wait(50); }
    throw new Error(`timeout waiting for: ${why}\nserver log:\n${serverLog}`);
  };
  const eventsOf = (kind) => modEvents.filter((e) => e.kind === kind);

  // A player report is pushed outward as well as stored. The report at line ~584 already fired,
  // so this only has to confirm it left the process.
  await until(() => eventsOf("report").length > 0, "the earlier report was pushed to the portal");
  const pushedReport = eventsOf("report")[0];
  assert.equal(pushedReport.about, "owner", "the pushed report names who was reported, lowercased");
  assert.equal(pushedReport.by, "guest2", "and who reported them");
  assert.equal(typeof pushedReport.at, "number", "with a timestamp the portal can order by");

  const badMouth = client();
  await badMouth.open();
  badMouth.send({ t: "hello", handle: "Flarnix" });
  await badMouth.next((f) => f.t === "welcome", "Flarnix connects");
  await badMouth.next((f) => f.t === "joined" && f.ch === "global", "Flarnix joins global");

  // A clean message goes through, so the next assertion is about the WORD and not about Flarnix.
  badMouth.send({ t: "msg", ch: "global", text: "anyone flying to Yela?" });
  await badMouth.next((f) => f.t === "msg" && /Yela/.test(f.text), "a clean message is delivered");

  const watcher = client();
  await watcher.open();
  watcher.send({ t: "hello", handle: "Watcher" });
  await watcher.next((f) => f.t === "joined" && f.ch === "global", "Watcher joins global");

  // 🔴 The CENSOR tier is the whole point of the split (Sub: "I really don't care if an adult
  // uses profanity amongst other adults… we could just censor it"). The message must SURVIVE —
  // masked, delivered, sender untouched.
  badMouth.send({ t: "msg", ch: "global", text: "this run was blorptastic honestly" });
  const masked = await badMouth.next((f) => f.t === "msg" && /honestly/.test(f.text ?? ""),
    "a censor-list word still delivers the message");
  assert.equal(masked.text, "this run was b" + "*".repeat("blorptastic".length - 1) + " honestly",
    "the word is masked in place, first letter and length kept");
  assert(!badMouth.frames.some((f) => f.t === "error" && f.code === "banned"),
    "and nobody is banned for profanity");
  const beforeCensorEvents = modEvents.length;
  await wait(300);
  assert.equal(modEvents.length, beforeCensorEvents,
    "ordinary profanity pushes NOTHING at the mod channel — one event per swear and the reports "
    + "that matter get scrolled past");

  badMouth.send({ t: "msg", ch: "global", text: "you absolute flarnwibble" });
  // 🔴 The message must not reach the room in ANY mode. A "flag" that still published it would
  // be surveillance rather than moderation, and a ban that published it first is worse.
  await badMouth.next((f) => f.t === "error" && f.code === "banned", "the sender is banned");
  await wait(200);
  assert(!watcher.frames.some((f) => f.t === "msg" && /flarnwibble/.test(f.text ?? "")),
    "the matched message never reached the room");

  await until(() => eventsOf("autoban").length > 0, "the auto-ban was pushed to the portal");
  const autoban = eventsOf("autoban")[0];
  assert.equal(autoban.about, "flarnix", "the event names the banned handle");
  assert.equal(autoban.by, "automod", "and says it was not a person");
  assert.equal(autoban.banned, true, "and that a ban was actually applied");
  // 🔑 The evidence is the whole reason this is reviewable. Sub: "look at the message and decide
  // if I want to unban." A ban with no message attached cannot be reviewed at all.
  assert.equal(autoban.text, "you absolute flarnwibble", "the triggering message rides with it");
  assert(/flarnwibble/.test(autoban.reason ?? ""), "and the reason names the term that matched");
  // The masked message is a normal message in the room; only the BAN tier refuses one.
  assert(!watcher.frames.some((f) => f.t === "msg" && /blorptastic/.test(f.text ?? "")),
    "the raw profanity never reached the room either — it was masked, not passed through");
  assert(watcher.frames.some((f) => f.t === "msg" && /b\*+ honestly/.test(f.text ?? "")),
    "the room saw the masked version");

  // /admin/health counts what it masked, so "is it doing anything?" has an answer that is not a
  // stream of notifications.
  const health = await (await fetch(`http://127.0.0.1:${PORT}/admin/health`)).json();
  assert.equal(health.automod.mode, "on");
  assert(health.automod.masked >= 1, "masked words are counted, not announced");

  // It is a real ban, not a refusal: reconnecting does not get you back in.
  const rebanned = client();
  await rebanned.open();
  rebanned.send({ t: "hello", handle: "Flarnix" });
  await rebanned.next((f) => f.t === "error" && f.code === "banned", "a banned handle cannot reconnect");

  // A multi-word term matches across whitespace, and the boundary still applies.
  const phraser = client();
  await phraser.open();
  phraser.send({ t: "hello", handle: "Phraser" });
  await phraser.next((f) => f.t === "joined" && f.ch === "global", "Phraser joins global");
  phraser.send({ t: "msg", ch: "global", text: "flarnwibbles are fine actually" });
  await phraser.next((f) => f.t === "msg" && /fine actually/.test(f.text), "a longer word is not the term");
  phraser.send({ t: "msg", ch: "global", text: "the void   harvester run" });
  await phraser.next((f) => f.t === "error" && f.code === "banned", "a phrase matches across any whitespace");

  // ── The portal's queue: the only two things it may do to this server ──────
  modQueue.push({ id: "act-1", action: "unban", handle: "Flarnix" });
  await until(() => modAcks.some((a) => a.id === "act-1"), "the unban was picked up and acked");
  assert.equal(modAcks.find((a) => a.id === "act-1").body.status, "applied");
  const forgiven = client();
  await forgiven.open();
  forgiven.send({ t: "hello", handle: "Flarnix" });
  await forgiven.next((f) => f.t === "welcome", "an unbanned handle can connect again");

  // Banning from the portal evicts a live connection, same as the loopback route.
  modQueue.push({ id: "act-2", action: "ban", handle: "Phraser" });
  const stillOn = client();
  await stillOn.open();
  stillOn.send({ t: "hello", handle: "Watcher2" });
  await stillOn.next((f) => f.t === "welcome", "an unrelated connection is unaffected");
  await until(() => modAcks.some((a) => a.id === "act-2"), "the ban was acked");
  const bansNow = await (await fetch(`http://127.0.0.1:${PORT}/admin/bans`)).json();
  assert(bansNow.includes("phraser"), "the queued ban landed");
  assert(!bansNow.includes("flarnix"), "and the queued unban stuck");

  // 🔑 Re-delivery is expected — an action we applied but failed to ack comes back — so both
  // verbs have to be no-ops the second time rather than errors.
  modQueue.push({ id: "act-3", action: "ban", handle: "Phraser" });
  await until(() => modAcks.some((a) => a.id === "act-3"), "a repeated ban is acked");
  assert.equal(modAcks.find((a) => a.id === "act-3").body.status, "applied", "re-banning is a no-op, not a failure");

  // A malformed row is reported back rather than silently swallowed, or the portal would show
  // an action as done that never happened.
  modQueue.push({ id: "act-4", action: "delete-everything", handle: "Phraser" });
  await until(() => modAcks.some((a) => a.id === "act-4"), "an unknown action is acked");
  assert.equal(modAcks.find((a) => a.id === "act-4").body.status, "failed");
  modQueue.push({ id: "act-5", action: "ban", handle: "no good!" });
  await until(() => modAcks.some((a) => a.id === "act-5"), "a bad handle is acked");
  assert.equal(modAcks.find((a) => a.id === "act-5").body.status, "failed");

  // The queue is not a public route by accident: the stub refuses anything unauthenticated,
  // which is what proves the server is sending the secret rather than getting lucky.
  assert.equal((await fetch(`http://127.0.0.1:${MOD_PORT}/actions`)).status, 401,
    "the portal stub really does check the shared secret");

  // ── activity: what you're doing, opt-in, on the presence frame ────────────
  const acA = client();
  await acA.open();
  acA.send({ t: "hello", handle: "ActorOne" });
  await acA.next((f) => f.t === "joined" && f.ch === "global", "ActorOne joins global");
  const acB = client();
  await acB.open();
  acB.send({ t: "hello", handle: "ActorTwo" });
  await acB.next((f) => f.t === "joined" && f.ch === "global", "ActorTwo joins global");

  /** The member row for a handle in the LATEST global presence frame this client saw. */
  const acMember = (c, handle) => {
    for (let i = c.frames.length - 1; i >= 0; i--) {
      const f = c.frames[i];
      if (f.t === "presence" && f.ch === "global" && Array.isArray(f.members)) {
        return f.members.find((m) => m.handle === handle) ?? null;
      }
    }
    return null;
  };

  acA.send({ t: "activity", activity: "Running Deep space hit" });
  await until(() => acMember(acB, "ActorOne")?.activity === "Running Deep space hit",
    "the room is told what ActorOne is doing");
  // 🔑 ABSENT, not null. Every shipped client ignores unknown fields, but a null on every row
  // would make an older widget's "has an activity" check disagree with a newer one's about the
  // same person — and most people will never turn this on, so that row is the common case.
  assert.equal(acMember(acB, "ActorTwo")?.activity, undefined,
    "someone who has not opted in carries no activity field at all");
  assert.equal(Object.prototype.hasOwnProperty.call(acMember(acB, "ActorTwo"), "activity"), false,
    "the key is omitted, not set to null");

  // Turning it off has to actually reach the room — a privacy switch that only stops FUTURE
  // updates leaves the last thing you were doing on everyone's screen indefinitely.
  acA.send({ t: "activity", activity: null });
  await until(() => acMember(acB, "ActorOne")?.activity === undefined,
    "clearing it takes it off everyone else's list");

  const acLong = "x".repeat(200);
  acA.send({ t: "activity", activity: acLong });
  await until(() => (acMember(acB, "ActorOne")?.activity ?? "").length === 48,
    "an over-long activity is capped rather than refused");

  // 🔴 It is charged against the MESSAGE budget. Presence reaches everyone in every channel you
  // are in, so an uncharged activity would be a cheaper broadcast than actually talking.
  for (let i = 0; i < 8; i++) acA.send({ t: "activity", activity: "state " + i });
  await acA.next((f) => f.t === "error" && f.code === "rate", "spamming it hits the rate limit");

  console.log("chat-server tests passed");
} finally {
  server.kill();
  portal.close();
}
