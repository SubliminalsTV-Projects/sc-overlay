// ChatClient (the sidecar's half) against the real chat server (spawned here).
// Run: npx tsx src/chat.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { ChatClient, regionLabel, shardLabel } from "./chat.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const CUSTOM_PORT = 8796;   // scratch — not 8788 (a dev chat server) nor 8778 (the sidecar)
const SHARD = "pub_use1b_12326004_040";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until a ChatClient SSE event satisfies the predicate. State predicates are ALSO tried
 *  against the current view first — the frame may have fired before the listener attached. */
function until(client: ChatClient, pred: (f: any) => boolean, why: string, ms = 6000): Promise<any> {
  const now = { type: "state", view: client.view() };
  if (pred(now)) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { client.off("sse", on); reject(new Error("timeout: " + why)); }, ms);
    const on = (f: any) => { if (pred(f)) { clearTimeout(t); client.off("sse", on); resolve(f); } };
    client.on("sse", on);
  });
}
const connected = (c: ChatClient) => until(c, (f) => f.type === "state" && f.view.status === "connected", "connected");

// ── labels ──────────────────────────────────────────────────────────────────
assert.equal(regionLabel("use1b"), "US East 1B");
assert.equal(regionLabel("usw2a"), "US West 2A");
assert.equal(regionLabel("euw1b"), "EU West 1B");
assert.equal(shardLabel(SHARD), "Shard 040");

// ── custom backend ──────────────────────────────────────────────────────────
async function testCustom(): Promise<void> {
  // 🔑 CHAT_DATA_DIR to a scratch dir, or the test's created rooms persist into the real
  // chat-server/data/channels.json — and the NEXT run's `create` correctly refuses the name
  // that is already there, which reads as a broken feature (it hung this suite once).
  const server = spawn(process.execPath, [join(repo, "chat-server", "server.mjs")], {
    env: {
      ...process.env,
      CHAT_PORT: String(CUSTOM_PORT),
      CHAT_AUTH: "dev",
      // Dev auth trusts any handle, so the server refuses to boot with it unless told to.
      CHAT_ALLOW_DEV_AUTH: "1",
      CHAT_DATA_DIR: mkdtempSync(join(tmpdir(), "sc-chat-client-test-")),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await wait(250);
      try { up = (await fetch(`http://127.0.0.1:${CUSTOM_PORT}/health`)).ok; } catch { /* not yet */ }
    }
    assert(up, "custom chat server never came up");

    const opts = (handle: string) => ({
      url: `ws://127.0.0.1:${CUSTOM_PORT}/ws`, handle, token: "", channels: [] as string[],
    });
    const a = new ChatClient();
    const b = new ChatClient();
    // 🔑 RECORD "channels" from the start rather than awaiting one later: it fires as part of
    // the joined frame we already awaited, so a listener attached afterwards waits forever
    // (this hung the suite once). Same trap as `until`'s check-current-state-first.
    const aChannels: string[][] = [];
    a.on("channels", (names: string[]) => aChannels.push(names));
    const wa = connected(a);
    a.configure(opts("SubTest"), true);
    await wa;

    // Shard applied BEFORE b connects — the loc must ride the connect, not only a later change.
    b.applyShard(SHARD);
    const wb = connected(b);
    b.configure(opts("WingmanTest"), true);
    await wb;
    // TWO location tiers, not three (2026-08-09): the region key carries the AZ letter, so
    // "region:use1b" already means everyone on US East 1B specifically. The shard sat between
    // that and the DGS with nothing a player could act on.
    a.applyShard(SHARD, "1.2.3.4:64304");
    b.applyShard(SHARD, "1.2.3.4:64304");

    await until(a, (f) => f.type === "state" && f.view.channels.some((c: any) => c.kind === "dgs"), "A in the DGS channel");
    await until(b, (f) => f.type === "state" && f.view.channels.some((c: any) => c.kind === "dgs"), "B in the DGS channel");
    const va = a.view();
    assert.deepEqual(va.channels.map((c) => c.kind), ["global", "region", "dgs"], "hierarchy order");
    assert.equal(va.channels[1].label, "US East 1B");
    assert.equal(va.channels[2].label, "Nearby");
    assert(!va.channels.some((c) => c.kind === "shard"), "no shard channel exists any more");

    const heard = until(b, (f) => f.type === "msg" && f.msg.text === "meet at Seraphim?", "B hears A in the region");
    assert.equal(a.send("region:use1b", "meet at Seraphim?").ok, true);
    const got = await heard;
    assert.equal(got.msg.from.handle, "SubTest");

    // Leaving the PU drops region+shard, keeps global (and its history).
    // 🔑 The REAL shard-hop ordering, taken from Sub's log. The endpoint only ever appears on
    // <Join PU>; a <Channel Destroyed> (sessionEnd) lands between that and <Update Shard Id>,
    // which re-establishes the shard carrying no endpoint. Before the per-shard memory, this
    // exact sequence left dgs=null every time and no Nearby room was ever created.
    a.applyShard(SHARD, "1.2.3.4:64304");   // Join PU
    a.applyShard(null, null);               // Channel Destroyed -> sessionEnd
    a.applyShard(SHARD);                    // Update Shard Id, no endpoint
    await wait(150);
    const nearby = a.view().channels.filter((c) => c.kind === "dgs");
    assert.equal(nearby.length, 1, "the DGS survives a shard hop's sessionEnd");
    assert.match(nearby[0].ch, /^dgs:[0-9a-f]{10}$/, "and it is a hashed key, never the endpoint");
    assert(!JSON.stringify(a.view()).includes("1.2.3.4"), "the raw endpoint NEVER leaves the client");

    a.applyShard(null);
    await until(a, (f) => f.type === "state" && f.view.channels.length === 1 && f.view.channels[0].kind === "global", "A back to global only");

    // ── v2: members ride presence into the view (the right rail's data) ──
    await until(a, (f) => f.type === "presence" || (f.type === "state" && f.view.channels.some((c: any) => c.members?.length)), "presence with members");
    const gl = a.view().channels.find((c) => c.ch === "global")!;
    assert(gl.members.some((m) => m.handle === "SubTest"), "own handle appears in the member list");
    assert(gl.members.every((m) => typeof m.verified === "boolean"), "members carry verified");

    // ── v2: custom rooms — create, directory, join by name, leave, and PERSISTENCE ──
    const joined = until(a, (f) => f.type === "state" && f.view.channels.some((c: any) => c.kind === "custom"), "A in a custom room");
    assert.equal(a.join("Salvage Crew", "create").ok, true);
    await joined;
    const custom = a.view().channels.find((c) => c.kind === "custom")!;
    assert.equal(custom.label, "Salvage Crew", "display casing survives");
    assert.equal(custom.ch, "custom:salvage-crew");

    // B sees it in the directory and joins by name.
    await until(b, (f) => f.type === "dir" && f.channels.some((c: any) => c.ch === "custom:salvage-crew"), "directory reaches B");
    const bJoined = until(b, (f) => f.type === "state" && f.view.channels.some((c: any) => c.ch === "custom:salvage-crew"), "B joins the custom room");
    b.join("salvage crew", "join");
    await bJoined;
    const crossTalk = until(b, (f) => f.type === "msg" && f.msg.ch === "custom:salvage-crew", "custom room carries messages");
    a.send("custom:salvage-crew", "bring a tractor beam");
    await crossTalk;

    // 🔑 The "channels" event is what the sidecar persists — without it a restart loses the room.
    assert.deepEqual(aChannels.at(-1), ["Salvage Crew"], "joining emits the room list to persist");

    // Leaving emits the pruned list and drops the channel.
    a.leave("custom:salvage-crew");
    await until(a, (f) => f.type === "state" && !f.view.channels.some((c: any) => c.kind === "custom"), "custom room gone from A");
    assert.deepEqual(aChannels.at(-1), [], "leaving emits an empty room list");

    // ── v2: a client configured WITH saved rooms rejoins them on connect (restart path) ──
    const c = new ChatClient();
    const cJoined = until(c, (f) => f.type === "state" && f.view.channels.some((x: any) => x.ch === "custom:salvage-crew"), "saved room rejoined on connect");
    c.configure({ url: `ws://127.0.0.1:${CUSTOM_PORT}/ws`, handle: "RestartTest", token: "", channels: ["Salvage Crew"] }, true);
    await cJoined;
    c.configure({ url: `ws://127.0.0.1:${CUSTOM_PORT}/ws`, handle: "RestartTest", token: "", channels: ["Salvage Crew"] }, false);

    a.configure(opts("SubTest"), false); // widget closed → deliberate disconnect, no retry
    b.configure(opts("WingmanTest"), false);
    assert.equal(a.view().status, "off");
    console.log("chat client vs custom backend: ok");
  } finally {
    server.kill();
  }
}

await testCustom();
console.log("chat client tests passed");
// Let the closed sockets' libuv handles finish tearing down before exit — an immediate
// process.exit() races them on Windows and aborts (uv assert) AFTER the pass line prints.
setTimeout(() => process.exit(0), 250);
