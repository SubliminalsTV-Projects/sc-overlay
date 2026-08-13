// Social chat client — the sidecar's HALF of the chat feature. The single backend
// connection lives HERE, not in the widget: widgets are iframes that reload on regroup and
// close with the canvas, so a widget-owned socket would drop scrollback and presence every
// time. The widget talks to this module over the existing SSE + POST pattern.
//
// Backend: chat-server/server.mjs (self-hosted) — 3-tier channels, history, bans. A Centrifugo
// arm was A/B-tested on 2026-08-08 and retired the same day (Sub's call: same product work
// either way, one more service to run, and it needed a local-echo workaround — see git history
// for the adapter).
//
// The channel hierarchy:
//   global                 everyone on the app
//   region:use1b           "the server" in player speak — the region/AZ from the shard id
//   shard:pub_use1b_…_040  the actual universe instance — people you can meet
// Region + shard membership follow the Game.log (`Join PU` / `Update Shard Id` → the parser's
// `shard` event → applyShard here). Leaving the PU drops both, keeps global.
//
// Resource rule: NO connection unless the Chat widget is actually open (chatOpen) — closed
// widget = zero sockets, zero timers beyond nothing. History survives in this process across
// widget open/close within a run.

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { regionOfShard } from "./missions-parser.js";

export interface ChatIdentity {
  handle: string;
  verified: boolean;
  /** Their chosen name colour as an INDEX into the widget's palette, 0-7. Absent = never picked
   *  one, which the widget renders as the name hash it has always used. Never a colour VALUE:
   *  this crosses from one player's client into everyone else's DOM. */
  color?: number;
  /** In the PU right now, per their own game.log. 🔑 Absent means "not in the PU" — it never
   *  means offline, and nothing in this system can say offline: presence only covers rooms you
   *  are both in, so silence about someone is silence, not a claim. */
  inGame?: boolean;
  /** Their org's SID, and their standing in it.
   *  🔑 `orgStars` is RSI's own 1-5 and is the SAME SCALE for every org — the only one anything
   *  may sort, gate or infer from. `orgRank` is the org's own word for that tier ("SSGT",
   *  "President", "Expendable Crew Member") and is display text only; it cannot be compared
   *  against another org's, or against itself over time. */
  org?: string;
  orgRank?: string;
  orgStars?: number;
  /** What they are doing, off their game.log — only present when they have opted in to sharing
   *  it. 🔑 ABSENT means "not sharing", never "idle": most people will never turn this on, and a
   *  UI that renders a blank as a state would be confidently wrong about almost everyone. */
  activity?: string;
}
export interface ChatMsg {
  ch: string;
  id: number | string;
  from: ChatIdentity;
  text: string;
  at: string;
}
export type ChatStatus = "off" | "connecting" | "connected" | "error";

export interface ChatOptions {
  url: string;          // ws:// or wss:// endpoint of the chat server
  handle: string;       // dev-mode identity; production auth is the sync token
  token: string;        // overlay sync token (site-mode auth on the chat server)
  /** Custom rooms (display names) to rejoin on every connect — the user's chosen channels,
   *  persisted by the sidecar so an app restart lands them back where they were. */
  channels: string[];
}

export type ChannelKind = "global" | "region" | "shard" | "dgs" | "org" | "custom" | "dm";

/** Hash a DGS endpoint into a channel key.
 *
 *  Sub asked the fair question: the game server's IP is not a secret, so why hash it? Two
 *  reasons, and neither is player privacy - it is CIG's address, not a player's.
 *  1. A channel key is BROADCAST to every connected user. Raw, it would publish a live,
 *     continuously-updated map of which DGSs are up and who is on them. That is someone
 *     else's infrastructure and a targeting vector; it is not ours to hand out.
 *  2. Our own log-sharing strips IPs. Re-publishing them through chat would quietly undo that.
 *  It costs nothing: keys are only ever compared for EQUALITY, so a hash groups people
 *  identically. 10 hex chars is 40 bits - collision-free at any plausible server count.
 *  Salted with the shard id, so the same endpoint in two shards cannot be conflated and the
 *  digest is not a plain rainbow-table lookup of "ip:port". */
export function dgsKey(shard: string | null, dgs: string | null): string | null {
  if (!shard || !dgs) return null;
  return createHash("sha256").update(shard + "|" + dgs).digest("hex").slice(0, 10);
}

/** The activity a custom room is for. The list is the SERVER's (welcome frame) — this type is
 *  just "some slug", so adding a category server-side needs no client release. */
export interface RoomCategory { slug: string; label: string }

interface ChannelState {
  ch: string;
  kind: ChannelKind;
  label: string;
  count: number | null;         // unique handles, when the server reports presence
  members: ChatIdentity[];      // who's here (capped server-side; count stays exact)
  msgs: ChatMsg[];
  // Custom rooms only, from the roominfo frame.
  category?: string;
  privacy?: "public" | "private";
  owner?: string | null;
  /** Only ever present for a private room you are INSIDE — it is what admits the next person. */
  code?: string;
  /** Party-listing fields, present only on a room advertising for members. `applications` is
   *  owner-only — the server simply omits it for everyone else. */
  party?: boolean;
  location?: string | null;
  sizeMax?: number | null;
  joinMode?: "open" | "apply";
  voice?: "none" | "optional" | "required";
  expiresAt?: number | null;
  applications?: { handle: string; note: string | null; at: number }[];
  /** The room's pinned message, or null. Held on the CHANNEL rather than pushed straight at the
   *  widget, because a widget iframe reloads on every regroup — a pin delivered only as an event
   *  would vanish the first time someone stacked the chat widget and not come back until it was
   *  re-pinned. State the widget can re-read survives that; an event does not. */
  pin?: ChatPin | null;
}

/** What the widget asks for when creating a party listing. Every field is clamped server-side. */
export interface PartyRequest {
  party: true;
  location?: string | null;
  sizeMax?: number | null;
  joinMode?: "open" | "apply";
  voice?: "none" | "optional" | "required";
  /** How long to advertise for, in MINUTES. Never an absolute time — see the server. */
  minutes?: number;
}

/** A pinned message. `id` is null when a moderator pinned free text rather than an existing
 *  message (the loopback /admin/pin route), so it can never be assumed to reference scrollback. */
export interface ChatPin {
  ch: string;
  id: number | null;
  handle: string;
  text: string;
  by: string;
  at: number;
}

const HISTORY_KEEP = 200;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** "use1b" → "US East 1B" — the label players recognise. Unknown codes pass through raw.
 *  🔑 The prefix list is MEASURED, not guessed: across 480 shared logs from 42 players the
 *  live regions are use1b (29 players), euw1b (21), ape1a (7) and apse2a (6). `ape` was
 *  missing from the first version, so 7 players' server channel read "APE1A". Longest
 *  prefixes are tried first — `apse` must win over `aps`. */
const REGION_NAMES: Record<string, string> = {
  use: "US East", usw: "US West", usc: "US Central",
  eue: "EU East", euw: "EU West",
  ape: "Asia-Pacific East", apse: "Asia-Pacific SE", apne: "Asia-Pacific NE",
  apsw: "Asia-Pacific SW", aps: "Asia-Pacific S", apn: "Asia-Pacific N",
  au: "Australia", ause: "Australia SE",
};
export function regionLabel(region: string | null): string {
  if (!region) return "Server";
  const r = region.toLowerCase();
  const m = r.match(/^([a-z]+?)(\d+)([a-z]?)$/);
  if (!m) return region.toUpperCase();
  const name = REGION_NAMES[m[1]];
  if (!name) return region.toUpperCase();
  return `${name} ${m[2]}${m[3].toUpperCase()}`;
}

/** The region FAMILY behind a channel key, for the spoken call-out — "use1b" → "use". The
 *  voice names the region but not the digits (Sub: "you don't have to mention the number"). */
export function regionFamily(region: string | null): string | null {
  const r = (region ?? "").toLowerCase();
  const m = r.match(/^([a-z]+?)\d/);
  return m && REGION_NAMES[m[1]] ? m[1] : null;
}

/** "pub_use1b_12326004_040" → "Shard 040". */
export function shardLabel(shard: string | null): string {
  if (!shard) return "Shard";
  const seg = shard.split("_");
  return `Shard ${seg[seg.length - 1] ?? shard}`;
}

export class ChatClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private opts: ChatOptions | null = null;
  private active = false;      // widget open + feature on → we want a connection
  private status: ChatStatus = "off";
  private lastError: string | null = null;
  private you: ChatIdentity | null = null;
  private shard: string | null = null; // full id from the log; region derives from it
  /** "<ip>:<port>" of the DGS. Kept ONLY to derive the hashed room key — never sent. */
  private dgs: string | null = null;
  /** shard id → the endpoint last seen joining it.
   *  🔑 This exists because of the ORDER the game logs a shard hop:
   *      <Join PU> …address…port…shard[X]     ← the only line with the endpoint
   *      <Channel Destroyed> map="megamap"    ← reads as sessionEnd, clears location
   *      <Update Shard Id> New Shard Id: X    ← re-establishes the shard, no endpoint
   *  So the endpoint is always learned and then thrown away moments later, and the trailing
   *  line can never restore it on its own. Measured on Sub's real log: every one of his four
   *  shard events ended with dgs=null for exactly this reason, and no Nearby room appeared.
   *  Bounded — a session touches a handful of shards, not thousands. */
  private dgsForShard = new Map<string, string>();
  private channels = new Map<string, ChannelState>();
  /** Public custom-room directory as the server last broadcast it. Private rooms are never in
   *  it — the server omits them, so there is nothing to filter here. */
  private directory: { ch: string; label: string; category?: string; count: number }[] = [];
  /** The activity list the room-creation dropdown is built from; the server's, via welcome. */
  private categories: RoomCategory[] = [];
  /** DM conversations, newest first — including ones that arrived while the app was closed. */
  private dmThreads: { other: string; lastAt: string }[] = [];
  /** Custom rooms (display names) we are — or want to be — in; rejoined on every welcome.
   *  Changes emit "channels" so the sidecar can persist them across app restarts. */
  private customRooms: string[] = [];
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closingDeliberately = false;
  private cfgId = 0; // guards a stale socket's callbacks after reconfigure

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** (Re)configure and set whether a connection is WANTED. Safe to call repeatedly with the
   *  same values — only a real change tears the socket down. */
  configure(opts: ChatOptions, active: boolean): void {
    // The channel list seeds customRooms but is NOT part of the change check — the sidecar
    // echoes our own "channels" events back through config, and treating that echo as a
    // change would bounce the socket on every join/leave.
    const { channels: seedChannels, ...rest } = opts;
    const prev = this.opts ? (({ channels: _c, ...r }) => r)(this.opts) : null;
    const changed = JSON.stringify(prev) !== JSON.stringify(rest);
    this.opts = opts;
    if (this.customRooms.length === 0 && Array.isArray(seedChannels)) this.customRooms = [...seedChannels];
    if (changed || active !== this.active) {
      this.active = active;
      this.teardown();
      // A DIFFERENT backend/identity is a different world — its channels and scrollback don't
      // carry over (a dead "Shard" tab with another server's history is worse than none).
      // Merely closing the widget (active=false, opts unchanged) keeps history on purpose.
      if (changed) this.channels.clear();
      if (this.active) this.connect();
      else { this.status = "off"; this.pushState(); }
    }
  }

  /** The parser saw a shard change (null = left the PU). Region/shard channels follow. */
  /** Are we currently claiming to be somewhere? Lets the staleness check skip the file stat
   *  entirely when there is nothing to drop. */
  hasLocation(): boolean {
    return this.shard !== null;
  }

  applyShard(shard: string | null, dgs?: string | null): void {
    // 🔑 The DGS moves on its own. Server meshing hands you between DGSs as you travel WITHIN
    // one shard, so a change with the same shard id is a real move to different neighbours and
    // must re-key the room. Update Shard Id carries no endpoint, so `undefined` means "no news"
    // and keeps the current value; an explicit null means we left the PU.
    // Learn the endpoint whenever a line actually carries one.
    if (shard && dgs) {
      this.dgsForShard.set(shard, dgs);
      if (this.dgsForShard.size > 8) this.dgsForShard.delete(this.dgsForShard.keys().next().value as string);
    }
    // `undefined` means "this line named no endpoint" — fall back to the one we learned for
    // THIS shard rather than to whatever is currently held, which a sessionEnd may have wiped.
    const nextDgs = dgs === undefined ? (shard ? this.dgsForShard.get(shard) ?? null : null) : dgs;
    if (shard === this.shard && nextDgs === this.dgs) return;
    this.shard = shard;
    this.dgs = shard ? nextDgs : null;
    this.sendLoc();
    this.pushState(); // labels update even while disconnected
  }

  private teardown(): void {
    this.cfgId++;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.ws) {
      this.closingDeliberately = true;
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.retry = 0;
    this.you = null;
  }

  private connect(): void {
    if (!this.opts || !this.active) return;
    const id = ++this.cfgId;
    this.status = "connecting";
    this.lastError = null;
    this.pushState();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.fail(String((e as Error).message ?? e), id);
      return;
    }
    this.ws = ws;
    this.closingDeliberately = false;
    ws.onopen = () => {
      if (id !== this.cfgId) return;
      this.wsSend({ t: "hello", token: this.opts!.token, handle: this.opts!.handle });
    };
    ws.onmessage = (e) => {
      if (id !== this.cfgId) return;
      let f: any;
      try { f = JSON.parse(String(e.data)); } catch { return; }
      this.onFrame(f);
    };
    ws.onclose = () => {
      if (id !== this.cfgId) return;
      this.ws = null;
      if (this.closingDeliberately) return;
      this.fail(this.lastError ?? "connection lost", id);
    };
    ws.onerror = () => { /* onclose always follows and carries the retry */ };
  }

  private fail(message: string, id: number): void {
    if (id !== this.cfgId || !this.active) return;
    this.status = "error";
    this.lastError = message;
    this.pushState();
    const delay = BACKOFF_MS[Math.min(this.retry++, BACKOFF_MS.length - 1)];
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
  }

  private wsSend(frame: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  /** Publish what the player is doing, or null to stop.
   *
   *  🔴 OPT-IN, and the caller owns that decision — this method just sends what it is given.
   *  The same rule as publishing your shard on a party listing (Sub, 2026-08-10): nothing may
   *  leak from merely having the widget open.
   *  🔑 Held so it can be RE-SENT on welcome. A reconnect is invisible to the user, and without
   *  this their activity would silently vanish from every rail the first time the socket blipped
   *  — which reads as the feature being broken, not as a reconnect. Same reason sendLoc is
   *  re-run there. */
  /** Pick your name colour, by palette index (null clears it back to the name hash).
   *  Re-sent on welcome for the same reason `sendLoc` is: a reconnect is invisible to the user,
   *  and their colour silently reverting for everyone else would read as the feature failing. */
  setColor(color: number | null): void {
    const next = color === null || color === undefined ? null : Math.trunc(Number(color));
    if (next !== null && !(Number.isInteger(next) && next >= 0 && next <= 7)) return;
    if (next === this.color) return;
    this.color = next;
    this.sendColor();
  }
  private color: number | null = null;
  private sendColor(): void {
    if (this.status !== "connected") return;
    this.wsSend({ t: "color", color: this.color });
  }

  setActivity(activity: string | null): void {
    const next = activity && activity.trim() ? activity.trim().slice(0, 48) : null;
    if (next === this.activity) return;
    this.activity = next;
    this.sendActivity();
  }
  private activity: string | null = null;
  private sendActivity(): void {
    if (this.status !== "connected") return;
    this.wsSend({ t: "activity", activity: this.activity });
  }

  /** Be invisible in the channels that identify where you are — your server (region) and Nearby
   *  (DGS). Sub's ask, 2026-08-12.
   *
   *  🔴 IMPLEMENTED BY NOT SENDING, never by asking the server to hide you. A server-side flag
   *  would mean the shard you are on still travels to a machine you do not own and is merely
   *  not shown — which is not what "invisible" means to the person ticking it. This way the only
   *  thing the server ever learns is that you left, and the same reasoning already governs the
   *  DGS endpoint (hashed client-side because a key is broadcast to everyone in the room).
   *  🔑 Turning it ON must PUSH a null location, not just stop sending: rooms you are already in
   *  do not empty themselves, and "it takes effect next time you change shard" is not a privacy
   *  switch. */
  setHideLocation(hide: boolean): void {
    const next = !!hide;
    if (next === this.hideLocation) return;
    this.hideLocation = next;
    if (this.status !== "connected") return;
    if (next) this.wsSend({ t: "loc", region: null, shard: null, dgs: null });
    else this.sendLoc();
  }
  private hideLocation = false;

  private sendLoc(): void {
    if (this.status !== "connected") return;
    // Nothing about where this player is may leave the process while they are hidden — including
    // on a reconnect, which is where a flag checked only at the call site would leak it.
    if (this.hideLocation) return;
    // 🔑 The HASH goes on the wire, never the endpoint. The server keys the room on whatever
    // it is given, so if the raw ip:port ever left this process it would be published to every
    // user of the channel.
    this.wsSend({
      t: "loc", region: regionOfShard(this.shard), shard: this.shard,
      dgs: dgsKey(this.shard, this.dgs),
    });
  }

  // ── The chat-server protocol (chat-server/server.mjs) ─────────────────────

  private onFrame(f: any): void {
    switch (f.t) {
      case "welcome":
        this.status = "connected";
        this.retry = 0;
        this.you = f.you ?? null;
        if (Array.isArray(f.categories)) this.categories = f.categories;
        this.sendLoc();
        // Only sends anything if the user actually turned it on — null is a no-op on the server.
        if (this.activity) this.sendActivity();
        // 🔑 The server's own copy wins on a FIRST connect (it is the durable one, and this
        // process may have just started); after that, ours is what the user last chose here.
        if (this.color === null && typeof f.you?.color === "number") this.color = f.you.color;
        else if (this.color !== null && this.color !== (f.you?.color ?? null)) this.sendColor();
        // Rejoin the user's custom rooms — this is what makes a reconnect (or app restart)
        // land back in the same channels instead of just Global.
        for (const name of this.customRooms) this.wsSend({ t: "join", name });
        this.pushState();
        return;
      case "joined": {
        const c = this.ensureChannel(f.ch, f.kind);
        if (typeof f.label === "string" && f.label) c.label = f.label;
        if (c.kind === "custom" && !this.customRooms.includes(c.label)) {
          this.customRooms.push(c.label);
          this.emit("channels", [...this.customRooms]);
        }
        this.pushState();
        return;
      }
      case "left": {
        const gone = this.channels.get(f.ch);
        this.channels.delete(f.ch);
        if (gone?.kind === "custom") {
          this.customRooms = this.customRooms.filter((n) => n.toLowerCase() !== gone.label.toLowerCase());
          this.emit("channels", [...this.customRooms]);
        }
        this.pushState();
        return;
      }
      case "dir":
        this.directory = Array.isArray(f.channels) ? f.channels : [];
        this.emit("sse", { type: "dir", channels: this.directory });
        return;
      case "roominfo": {
        // Category / privacy / owner, and for a private room you're inside, the join code.
        const c = this.ensureChannel(f.ch, "custom");
        c.category = f.category;
        c.privacy = f.privacy;
        c.owner = f.owner ?? null;
        // 🔑 AUTHORITATIVE, not "keep what we had" — the server sends `code` on every roominfo
        // for a private room you are inside, so an ABSENT one means there is no code any more.
        // A room turned public would otherwise keep showing the code it used to have, which is a
        // dead string presented as a live way in.
        c.code = typeof f.code === "string" ? f.code : undefined;
        c.party = f.party === true;
        c.location = f.location ?? null;
        c.sizeMax = f.sizeMax ?? null;
        c.joinMode = f.joinMode ?? "open";
        c.voice = f.voice ?? "none";
        c.expiresAt = f.expiresAt ?? null;
        // Owner-only, so an ABSENT list means "not yours to see" — leave whatever we had rather
        // than blanking it, since a non-owner frame must not wipe the owner's own view.
        if (Array.isArray(f.applications)) c.applications = f.applications;
        this.pushState();
        return;
      }
      // The server confirming what it saved. Kept so `view().you.color` is what the SERVER has,
      // not what we hoped it had — the picker renders off that.
      case "color":
        this.color = typeof f.color === "number" ? f.color : null;
        if (this.you) this.you = { ...this.you, color: this.color ?? undefined };
        this.pushState();
        return;
      case "notice":
        // A plain server-to-user message. Today: "that room was deleted" — which the user has
        // to be told, or a channel disappearing reads as a connection fault.
        this.emit("sse", { type: "notice", level: f.level ?? "info", text: String(f.text ?? "") });
        return;
      case "invited":
        this.emit("sse", { type: "notice", level: "info", text: `Invited ${f.handle}.` });
        return;
      case "roominvite":
        // Someone opened a private room to you. A notice, not an auto-join: being pulled into a
        // room without asking is how the org-ops room ends up full of people who didn't want it.
        this.emit("sse", {
          type: "notice", level: "info",
          text: `${f.from} invited you to “${f.label}” — join it by name to accept.`,
        });
        return;
      case "dms":
        this.dmThreads = Array.isArray(f.threads) ? f.threads : [];
        this.pushState();
        return;
      case "history": {
        const c = this.ensureChannel(f.ch);
        if (Array.isArray(f.msgs)) c.msgs = f.msgs.slice(-HISTORY_KEEP);
        this.pushState();
        return;
      }
      case "msg":
        this.pushMsg({ ch: f.ch, id: f.id, from: f.from, text: f.text, at: f.at });
        return;
      case "presence": {
        const c = this.channels.get(f.ch);
        if (c) {
          c.count = f.count;
          if (Array.isArray(f.members)) c.members = f.members;
          this.emit("sse", { type: "presence", ch: f.ch, count: f.count, members: c.members });
        }
        return;
      }
      case "pin": {
        // 🔑 `pin: null` is an UNPIN, not a missing field — the server sends it deliberately, so
        // this must write null through rather than treat it as "nothing to do", or a cleared
        // notice would sit on every client until they reconnected.
        const c = this.ensureChannel(f.ch);
        c.pin = f.pin ?? null;
        this.pushState();
        return;
      }
      case "applied":
        this.emit("sse", { type: "notice", level: "info", text: "Request sent. The group's owner decides." });
        return;
      case "reported":
        // Reporting is silent by design on the server — nothing is broadcast and nothing changes
        // in the room — so this acknowledgement is the ONLY feedback the reporter ever gets.
        // Without it the button looks broken and people press it again.
        this.emit("sse", {
          type: "notice", level: "info",
          text: `Reported ${f.handle}. Thanks — it's been logged for review.`,
        });
        return;
      case "error":
        // banned / bad_auth close the socket right after; surface the reason, don't hammer.
        this.lastError = f.message ?? f.code ?? "chat error";
        if (f.code === "banned" || f.code === "bad_auth") this.retry = BACKOFF_MS.length - 1;
        this.emit("sse", { type: "notice", level: "error", text: this.lastError });
        return;
    }
  }

  // ── Shared state plumbing ─────────────────────────────────────────────────

  private ensureChannel(ch: string, kindHint?: string): ChannelState {
    let c = this.channels.get(ch);
    if (!c) {
      const kind: ChannelKind =
        kindHint === "org" || kindHint === "custom" || kindHint === "dm" ? kindHint
        : ch === "global" ? "global"
        : ch.startsWith("region:") ? "region"
        : ch.startsWith("shard:") ? "shard"
        : ch.startsWith("dgs:") ? "dgs"
        : ch.startsWith("org:") ? "org"
        : ch.startsWith("dm:") ? "dm"
        : ch.startsWith("custom:") ? "custom"
        : "custom";
      c = { ch, kind, label: this.labelFor(ch, kind), count: null, members: [], msgs: [] };
      this.channels.set(ch, c);
    }
    return c;
  }

  private labelFor(ch: string, kind: ChannelKind): string {
    if (kind === "global") return "Global";
    if (kind === "region") return regionLabel(ch.slice("region:".length));
    if (kind === "shard") return shardLabel(ch.slice("shard:".length));
    // The key is a digest, so it can't be rendered — and it would mean nothing to a player if
    // it could. What matters is what it MEANS: these are the people around you right now.
    if (kind === "dgs") return "Nearby";
    // A DM is titled with the OTHER person. The key holds both handles lowercased, so pick the
    // one that isn't you; the server's joined frame carries their real casing and overwrites it.
    if (kind === "dm") {
      const pair = ch.slice("dm:".length).split("|");
      const me = (this.you?.handle ?? "").toLowerCase();
      return pair.find((h) => h !== me) ?? pair[0] ?? ch;
    }
    // org/custom labels come from the server on the joined frame; the raw key is the fallback.
    return ch.split(":").slice(1).join(":");
  }

  private pushMsg(msg: ChatMsg): void {
    const c = this.ensureChannel(msg.ch);
    c.msgs.push(msg);
    if (c.msgs.length > HISTORY_KEEP) c.msgs.splice(0, c.msgs.length - HISTORY_KEEP);
    this.emit("sse", { type: "msg", msg });
  }

  private pushState(): void {
    this.emit("sse", { type: "state", view: this.view() });
  }

  // ── Public API (the sidecar's HTTP layer calls these) ─────────────────────

  send(ch: string, text: string): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    const t = text.trim();
    if (!t) return { ok: false, message: "Empty message." };
    this.wsSend({ t: "msg", ch, text: t });
    return { ok: true };
  }

  /** Join (or create) a custom room. Membership lands via the joined frame.
   *  `name` doubles as the JOIN CODE box: a private room has no name anyone can look up, so the
   *  server tries a code first when the text is code-shaped.
   *  `category` and `privacy` apply only when CREATING — joining an existing room can't restyle
   *  it, which would otherwise let anyone flip someone else's private room public. */
  join(name: string, mode?: "join" | "create", category?: string, privacy?: "public" | "private",
       party?: PartyRequest):
    { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    const n = name.trim();
    if (!n) return { ok: false, message: "Name a channel first." };
    this.wsSend({
      t: "join", name: n,
      ...(mode ? { mode } : {}),
      ...(mode === "create" && category ? { category } : {}),
      ...(mode === "create" && privacy ? { privacy } : {}),
      // Only meaningful on create. The server clamps every field, so this is a request, not a
      // setting — and it sends a DURATION, never a wall-clock expiry off this machine's clock.
      ...(mode === "create" && party ? party : {}),
    });
    return { ok: true };
  }

  /** Change what a room you own is FOR, or who can find it. Both are answered at creation and,
   *  until now, could never be answered again.
   *  🔑 The server does the work that makes closing a room safe — a fresh join code, and an
   *  invite for everyone already standing in it — because only it knows who those people are. */
  setRoomConfig(ch: string, category?: string, privacy?: "public" | "private"):
    { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    if (!ch.startsWith("custom:")) return { ok: false, message: "Only rooms you made can be changed." };
    if (!category && !privacy) return { ok: false, message: "Nothing to change." };
    this.wsSend({ t: "roomconfig", ch, ...(category ? { category } : {}), ...(privacy ? { privacy } : {}) });
    return { ok: true };
  }

  /** Delete a room you own. Everyone in it is evicted and its scrollback goes with it. */
  deleteRoom(ch: string): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    this.wsSend({ t: "deleteRoom", ch });
    return { ok: true };
  }

  /** Admit an RSI handle to a private room you own. */
  invite(ch: string, handle: string): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    const h = handle.trim();
    if (!h) return { ok: false, message: "Who do you want to invite?" };
    this.wsSend({ t: "invite", ch, handle: h });
    return { ok: true };
  }

  /** Message one player directly. The conversation opens on both ends. */
  dm(to: string, text: string): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    const t = text.trim();
    if (!t) return { ok: false, message: "Empty message." };
    this.wsSend({ t: "dm", to: to.trim(), text: t });
    return { ok: true };
  }

  /** Refresh the conversation list (it also arrives unasked on connect). */
  dmList(): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    this.wsSend({ t: "dmlist" });
    return { ok: true };
  }

  /** Pin a message in a room you own. The server refuses anyone else, and refuses the ownerless
   *  system rooms outright — those are pinned by a moderator over the loopback admin route. */
  pin(ch: string, id: number): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    if (!Number.isFinite(id)) return { ok: false, message: "Which message?" };
    this.wsSend({ t: "pin", ch, id });
    return { ok: true };
  }

  /** Clear a room's pin. Owner only, same as setting it. */
  unpin(ch: string): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    this.wsSend({ t: "unpin", ch });
    return { ok: true };
  }

  /** Report a player. Deliberately produces no visible change in the room — see the server. */
  report(ch: string, handle: string, id?: number | null, reason?: string): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    const h = handle.trim();
    if (!h) return { ok: false, message: "Report who?" };
    this.wsSend({
      t: "report", ch, handle: h,
      ...(Number.isFinite(id as number) ? { id } : {}),
      ...(reason ? { reason } : {}),
    });
    return { ok: true };
  }

  /** Ask to join an apply-only listing. 🔑 This does NOT join you — the owner decides. */
  apply(ch: string, note?: string): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    this.wsSend({ t: "apply", ch, ...(note ? { note } : {}) });
    return { ok: true };
  }

  /** Owner: admit or turn away an applicant. Accepting writes a normal invite. */
  resolveApplication(ch: string, handle: string, accept: boolean): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    const h = handle.trim();
    if (!h) return { ok: false, message: "Which applicant?" };
    this.wsSend({ t: accept ? "acceptApplication" : "declineApplication", ch, handle: h });
    return { ok: true };
  }

  /** Leave a custom room (the server refuses auto/org channels). */
  leave(ch: string): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    this.wsSend({ t: "leave", ch });
    return { ok: true };
  }

  /** Widget bootstrap + /api/chat/state. Channel order is the fixed hierarchy. */
  view() {
    // DMs sort last: they're a conversation list, not part of the channel hierarchy.
    const order = { global: 0, region: 1, shard: 2, dgs: 3, org: 4, custom: 5, dm: 6 } as const;
    const channels = [...this.channels.values()]
      .sort((a, b) => order[a.kind] - order[b.kind] || a.ch.localeCompare(b.ch))
      .map((c) => ({
        ch: c.ch, kind: c.kind, label: c.label, count: c.count, members: c.members, msgs: c.msgs,
        category: c.category, privacy: c.privacy, owner: c.owner, code: c.code,
        pin: c.pin ?? null,
        party: c.party ?? false, location: c.location ?? null, sizeMax: c.sizeMax ?? null,
        joinMode: c.joinMode ?? "open", voice: c.voice ?? "none", expiresAt: c.expiresAt ?? null,
        applications: c.applications ?? [],
      }));
    return {
      status: this.status,
      error: this.lastError,
      you: this.you,
      shard: this.shard,
      region: regionOfShard(this.shard),
      regionLabel: regionLabel(regionOfShard(this.shard)),
      shardLabel: shardLabel(this.shard),
      channels,
      // The browsable directory of custom rooms, minus the ones already joined (the left
      // rail lists "channels you could join", not a duplicate of your tabs).
      directory: this.directory.filter((d) => !this.channels.has(d.ch)),
      // The activity list the create-room dropdown renders from, straight from the server.
      categories: this.categories,
      // Conversations that exist but aren't open as tabs — the ones with something waiting.
      dmThreads: this.dmThreads.filter((t) => !this.channels.has(`dm:${[
        (this.you?.handle ?? "").toLowerCase(), t.other.toLowerCase(),
      ].sort().join("|")}`)),
    };
  }
}
