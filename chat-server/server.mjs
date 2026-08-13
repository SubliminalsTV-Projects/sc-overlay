// SC Overlay chat server — option 1 of the A/B (custom, self-hosted, zero deps beyond `ws`).
//
// PROTOTYPE HOME: this lives in the app repo for the A/B test; its production home is the
// subliminal-gg stack (same VPS as the auth it needs). Everything user-facing goes through
// the sidecar (src/chat.ts) — widgets never talk to this server directly.
//
// The channel model is Sub's EVE-style hierarchy (2026-08-08):
//   global                       everyone using the app
//   region:<use1b>               same region/AZ — what players call "the server"
//   shard:<pub_use1b_..._040>    same universe instance — the people you can actually meet
// The client is TRUSTED about its own location (it read it from its own Game.log; lying gets
// you into a channel where nobody can meet you, which punishes only the liar).
//
// Identity: chat requires an RSI-VERIFIED account (Sub's rule — bannable identities).
//   CHAT_AUTH=dev   (default) hello.handle is accepted as-is, verified=true. LOCAL A/B ONLY.
//   CHAT_AUTH=site  hello.token is resolved via subliminal.gg (CHAT_AUTH_URL) into
//                   { handle, verified } — the production mode; endpoint lands with the
//                   site-side work, shape documented at verifyIdentity().
//
// Channel kinds (v2, 2026-08-09 — EVE-structured widget):
//   AUTO    global · region:<use1b> · shard:<full id>   follow the Game.log, never chosen
//   ORG     org:<sid>                                   auto-joined from the VERIFIED org on the
//                                                       RSI dossier (site auth carries it)
//   CUSTOM  custom:<slug>                               user-created rooms; join/create/leave;
//                                                       a public directory lists them
//
// Wire protocol (JSON text frames over /ws). v1 clients (0.1.41) only ever send hello/loc/msg
// and ignore unknown frames, so everything added here is backward compatible.
//   c→s  {t:"hello", token?, handle?, org?}    auth; nothing else is accepted before it
//        {t:"loc", region?, shard?}            current location (null/absent = leave)
//        {t:"msg", ch, text}                   say something
//        {t:"join", name, mode?,               custom room by display name OR join code; mode
//               category?, privacy?}           "join" errors if absent, "create" errors if
//                                              taken, default join-or-create. category/privacy
//                                              apply only when CREATING.
//        {t:"roomconfig", ch,                  owner only; re-answers the two questions a room
//               category?, privacy?}           was asked at creation. Going private mints a NEW
//                                              code and writes an invite for everyone standing
//                                              in the room; going public drops the code.
//        {t:"invite", ch, handle}              owner only; admits a handle to a private room
//        {t:"dm", to, text}                    private message to one handle
//        {t:"dmlist"}                          ask for this handle's conversations
//        {t:"leave", ch}                       custom rooms + DMs (auto/org follow identity)
//        {t:"activity", activity}              what you are doing, off game.log. OPT-IN at the
//                                              client; null clears. 48 chars, charged against
//                                              the message budget, unchanged values are free.
//        {t:"color", color}                    your name colour as an INDEX 0..7 (null clears).
//                                              An index, never a colour value — the palette is
//                                              the widget's, and a hex from a client would be
//                                              CSS landing in everyone else's DOM.
//   s→c  {t:"welcome", you:{...}, categories}  hello accepted; categories = the activity list
//        {t:"joined", ch, label?, kind?}       membership changes (always server-initiated)
//        {t:"roominfo", ch, category,          the room you just joined; `code` ONLY for a
//               privacy, owner, code?}         private room you are inside
//        {t:"invited", ch, handle}             your invite was recorded
//        {t:"roominvite", ch, label,           someone invited YOU (only if you're online;
//               category, from}                otherwise the invite just waits)
//        {t:"left", ch}
//        {t:"history", ch, msgs:[Msg]}         last messages, follows joined
//        {t:"msg", ...Msg}                     live message (Msg = {ch,id,from,text,at})
//        {t:"presence", ch, count, members}    unique handles in the room, debounced; capped at
//                                              200. members = [{handle, verified, activity?,
//                                              inGame?, color?, org?, orgRank?, orgStars?}].
//                                              🔑 orgStars is RSI's 1-5 and is the same scale
//                                              for every org — the only one anything may sort
//                                              or gate on. orgRank is the org's own word for
//                                              that tier and is display text only.
//                                              Optional fields are OMITTED
//                                              when they don't apply — `inGame` absent means
//                                              "not in the PU", never "offline". There is no
//                                              offline. `color` absent = they never picked one.
//        {t:"color", color}                    your colour was saved (echo of what you sent)
//        {t:"dir", channels}                   the PUBLIC custom-room directory
//                                              [{ch,label,category,count}], on welcome +
//                                              debounced on change. Private rooms are absent.
//        {t:"dms", threads}                    [{other, lastAt}], newest first
//        {t:"error", code, message}            bad_auth | banned | not_member | rate | bad_msg
//                                              | bad_channel | no_such_channel | channel_exists
//                                              | not_invited | not_owner | bad_handle

import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createStore, dmKey } from "./store.mjs";
import { createAutomod } from "./automod.mjs";
import { createModLink } from "./modlink.mjs";

const PORT = Number(process.env.CHAT_PORT) || 8788;
const AUTH_MODE = process.env.CHAT_AUTH === "site" ? "site" : "dev";
const AUTH_URL = process.env.CHAT_AUTH_URL || "https://subliminal.gg/api/sc/chat-auth";
const HISTORY_KEEP = 200;   // ring size per room
const HISTORY_SEND = 50;    // sent on join
const MSG_MAX = 400;        // chars
// A member row is one line in a narrow rail; anything longer is truncated on screen anyway, and
// a generous cap would just make presence a second, cheaper message channel.
const ACTIVITY_MAX = 48;
const RATE_N = 5, RATE_WINDOW_MS = 10_000; // msgs per window per connection
// Access ATTEMPTS (join / dm / invite / delete) get their own, tighter budget. A legitimate
// client sends a handful of joins on connect and then almost none; a code-guesser sends
// thousands. 12 per 30s is far above real use and far below useful brute force.
const ACT_N = 12, ACT_WINDOW_MS = 30_000;
// 🔴 Org chat is the thing Sub cares most about keeping shut ("I don't want someone to be able
// to spy on a rival org"). Membership is resolved from the VERIFIED RSI dossier — but only once,
// at hello. A client that stays connected for days keeps whatever org it had when it connected,
// so someone who joins an org on RSI, verifies, and then leaves would hold the room open
// indefinitely. Re-resolve periodically and move them when the answer changes.
const ORG_RECHECK_MS = 15 * 60 * 1000;

// CHAT_DATA_DIR: tests point this at a scratch dir so their bans/rooms never touch real state.
const dataDir = process.env.CHAT_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), "data");
const MEMBERS_CAP = 200;        // handles listed per presence frame (count is always exact)
const CUSTOM_IDLE_PRUNE_MS = 14 * 24 * 3600 * 1000; // empty custom rooms older than this drop
const PRUNE_EVERY_MS = 3600_000;

// ── Persistence ─────────────────────────────────────────────────────────────
// With DATABASE_URL set this is Postgres; without it, JSON files and memory-only scrollback
// (which is what keeps the test suite hermetic). See store.mjs.
const store = createStore({ dataDir, databaseUrl: process.env.DATABASE_URL, log: console });
const loaded = await store.init();

// ── Moderation ──────────────────────────────────────────────────────────────
// Auto-mod is the plan; reports are the backstop. Both feed ONE outbound link to the portal.
// 🔑 Every env here is optional and every one of them defaults to the behaviour that existed
// before this feature: no list means no auto-moderation, no URL means no push, no secret means
// no link at all. Nothing about a plain `docker run` of this server changes.
const automod = createAutomod({
  banFile: process.env.AUTOMOD_BAN_LIST,
  censorFile: process.env.AUTOMOD_CENSOR_LIST,
  // "censor" is the safe default: both lists mask, nobody is banned. "on" arms the ban tier.
  mode: process.env.AUTOMOD_MODE || "censor",
  log: console,
});
/** Words masked since boot. Ordinary profanity must NOT reach the mod channel — one event per
 *  "shit" and the reports that matter get scrolled past — but "is it doing anything?" still
 *  needs an answer, so it is a number on /admin/health rather than a stream of notifications. */
let censored = 0;
const modlink = createModLink({
  webhookUrl: process.env.REPORT_WEBHOOK_URL,
  actionUrl: process.env.MOD_ACTION_URL,
  secret: process.env.MOD_SHARED_SECRET,
  pollMs: Number(process.env.MOD_POLL_MS) || undefined,
  log: console,
  // The portal can do exactly two things to this server, and both are idempotent — an
  // un-acked action is redelivered, so "ban someone already banned" has to be a no-op.
  onAction: async (row) => {
    const handle = String(row?.handle ?? "").toLowerCase();
    if (!HANDLE_RE.test(handle)) throw new Error("bad handle");
    if (row?.action === "ban") applyBan(handle);
    else if (row?.action === "unban") liftBan(handle);
    else throw new Error(`unknown action ${row?.action}`);
  },
});

/** Bans — lowercase handles. The whole point of the RSI-verify gate is that these stick. */
const bans = loaded.bans;
/** handle (lowercase) → colour INDEX 0..7. The palette itself lives in the widget, so it can be
 *  theme-aware across the 16 manufacturer skins; the server only ever knows which of the eight.
 *  🔴 An index, never a colour value: a hex from a client would be arbitrary CSS landing in every
 *  other player's member list. */
const userColors = loaded.prefs ?? new Map();
const COLOR_MAX = 7;
/** slug → { label, category, privacy, code, owner, created, lastActive, invites } */
const customDir = loaded.rooms;
/** ch → { ch, id, handle, text, by, at } — at most one pinned message per room.
 *  🔑 The pinned TEXT is held here, not looked up in scrollback. Scrollback is pruned and a pin
 *  is meant to outlive it; a pin that silently emptied itself would be worse than no pin. */
const pins = loaded.pins ?? new Map();
/** Slugs a custom room may NOT be called: org SIDs and verified handles the server has seen.
 *  🔴 A room named "irregs" renders in the browse list looking like the IRREGS org channel, so
 *  a member joins the fake one and talks freely to whoever is listening. NOTHING technical is
 *  broken — org:irregs and custom:irregs are different keys and org traffic never leaks — which
 *  is precisely why it has to be stopped at the NAME. Demonstrated on Sub's own server
 *  (2026-08-09): a tester created irregs, sabreraven, ltx, sbb and imc-subliminallianori. */
const reservedNames = loaded.reserved ?? new Set();
/** Learn a name so nobody can take it. Called for every org and handle that connects. */
function reserveName(name, kind) {
  const n = String(name ?? "").toLowerCase();
  if (!n || reservedNames.has(n)) return;
  reservedNames.add(n);
  store.rememberName(n, kind);
}
let nextMsgId = loaded.maxMessageId + 1;

/** A room is "active" whenever someone speaks in it or its membership changes — that timestamp
 *  is the only thing standing between the directory and unbounded growth. */
function touchRoom(slug) {
  const meta = customDir.get(slug);
  if (!meta) return;
  meta.lastActive = Date.now();
  store.touchRoom(slug, meta.lastActive);
}

/** Retire rooms nobody has been in for a fortnight, so the directory can't grow forever.
 *  🔑 This used to ride along inside the save function, which meant it only ever ran when
 *  something ELSE changed — a directory that stopped changing also stopped being pruned. */
function pruneIdleRooms() {
  const now = Date.now();
  for (const [slug, meta] of customDir) {
    const empty = (rooms.get(`custom:${slug}`)?.members.size ?? 0) === 0;
    if (empty && now - (meta.lastActive ?? meta.created ?? now) > CUSTOM_IDLE_PRUNE_MS) {
      customDir.delete(slug);
      store.deleteRoom(slug);
    }
  }
}
// ── Activity categories ─────────────────────────────────────────────────────
// What kind of gameplay a room is for, so the directory groups by what people are DOING rather
// than being one flat list of names (Sub, 2026-08-09). The server owns this list and ships it in
// the welcome frame — the widget's dropdown is rendered from it, so adding a category here is
// the whole change, with no client release needed.
// 🔑 The SLUG is what's stored; labels are free to be reworded. Never renumber or reuse a slug.
const ROOM_CATEGORIES = [
  { slug: "org-ops",   label: "Org Operations" },
  { slug: "ship-pvp",  label: "Ship Combat / PvP" },
  { slug: "fps",       label: "FPS / Ground Combat" },
  { slug: "bounty",    label: "Bounty Hunting" },
  { slug: "mining",    label: "Mining" },
  { slug: "salvage",   label: "Salvage" },
  { slug: "hauling",   label: "Hauling & Trading" },
  { slug: "explore",   label: "Exploration" },
  { slug: "medical",   label: "Medical & Rescue" },
  { slug: "racing",    label: "Racing" },
  { slug: "events",    label: "Events" },
  { slug: "social",    label: "Social / Other" },
];
const CATEGORY_SLUGS = new Set(ROOM_CATEGORIES.map((c) => c.slug));
// Rooms created before categories existed land here rather than being refused — "Social / Other"
// is the honest answer for a room whose creator was never asked.
const DEFAULT_CATEGORY = "social";

// ── Join codes ──────────────────────────────────────────────────────────────
// A private room is reached two ways: this code, or an invite from the owner. The alphabet drops
// O/0/I/1 — a code is read off Discord and typed by hand, and those are the pairs people get
// wrong. Stored and compared uppercase, so "k7m2qd" works.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;
function makeCode() {
  const taken = new Set([...customDir.values()].map((m) => m.code).filter(Boolean));
  for (let tries = 0; tries < 50; tries++) {
    let s = "";
    for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!taken.has(s)) return s;
  }
  return null;   // 32^6 codes against a handful of rooms — this is a bug, not bad luck
}
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`, "i");
/** Find a private room by its join code. */
function roomByCode(code) {
  const up = String(code).toUpperCase();
  for (const [slug, meta] of customDir) if (meta.code && meta.code === up) return { slug, meta };
  return null;
}
/** May this connection enter this room? Public rooms are open; a private one needs the code,
 *  an invite, or ownership. Redeeming a code records an invite (see the join handler), so
 *  after the first entry the invite list is the single answer to "who is allowed in here". */
function mayJoin(conn, meta, typed) {
  if (meta.owner && meta.owner === conn.handleLower) return true;
  if (meta.invites?.includes(conn.handleLower)) return true;
  // 🔴 An 'apply' listing is PUBLIC — it has to be, or nobody could find it to apply. So the
  // approval gate cannot live in `privacy`; without this check a plain join by name walks
  // straight past it and "you approve people" is decorative. Accepting an application writes an
  // invite, which is why the invite check above is what lets an approved person in.
  if (meta.isParty && meta.joinMode === "apply") return false;
  if (meta.privacy !== "private") return true;
  return !!(meta.code && typed && String(typed).toUpperCase() === meta.code);
}

/** Display name → slug. The slug is the identity; the label keeps the user's casing. */
/** Validate the party-listing half of a create frame. Everything is clamped server-side: these
 *  fields are broadcast to every connected user, so "the client wouldn't send that" is not a
 *  guarantee worth resting a directory on.
 *
 *  🔑 The client sends a DURATION, not an `expiresAt`. A wall-clock timestamp from a machine we
 *  do not control is a listing that never expires (clock behind) or is dead on arrival (clock
 *  ahead) — and desktop clocks are wrong often enough that this would look random. */
const PARTY_MAX_MINUTES = 12 * 60;
const JOIN_MODES = new Set(["open", "apply"]);
const VOICE_MODES = new Set(["none", "optional", "required"]);
function partyFieldsFrom(f) {
  if (!f || f.party !== true) return { isParty: false };
  const mins = Number(f.minutes);
  const size = Number(f.sizeMax);
  return {
    isParty: true,
    // Free text: it is either what the leader typed or the region label their client offered
    // after they opted in. The server never derives it — we are not told where anyone is.
    location: typeof f.location === "string" ? f.location.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 60) || null : null,
    sizeMax: Number.isFinite(size) ? Math.min(50, Math.max(2, Math.round(size))) : null,
    joinMode: JOIN_MODES.has(f.joinMode) ? f.joinMode : "open",
    voice: VOICE_MODES.has(f.voice) ? f.voice : "none",
    expiresAt: Date.now() + Math.min(PARTY_MAX_MINUTES, Math.max(15, Number.isFinite(mins) ? Math.round(mins) : 120)) * 60_000,
  };
}

function slugOfName(name) {
  const s = String(name ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
  return /^[a-z0-9][a-z0-9._-]{2,29}$/.test(s) ? s : null;
}
/** The public directory. 🔑 PRIVATE ROOMS ARE NEVER IN IT — not filtered on the client, absent
 *  from the frame. A room you can see the name and headcount of is not private, and the whole
 *  reason private rooms exist is that creating one used to publish it to everybody. */
function dirPayload() {
  const out = [];
  for (const [slug, meta] of customDir) {
    if (meta.privacy === "private") continue;
    // An EXPIRED listing stops being advertised as one, but the room itself carries on as an
    // ordinary chat room — people are still in it talking. Dropping the room would evict them
    // for the crime of the leader picking a short window.
    const live = meta.isParty && (!meta.expiresAt || meta.expiresAt > Date.now());
    out.push({
      ch: `custom:${slug}`,
      label: meta.label,
      category: meta.category ?? DEFAULT_CATEGORY,
      count: new Set([...(rooms.get(`custom:${slug}`)?.members ?? [])].map((c) => c.handleLower)).size,
      ...(live ? {
        party: true,
        location: meta.location ?? null,
        sizeMax: meta.sizeMax ?? null,
        joinMode: meta.joinMode ?? "open",
        voice: meta.voice ?? "none",
        expiresAt: meta.expiresAt ?? null,
      } : {}),
    });
  }
  return out;
}
let dirTimer = null;
function broadcastDir() {
  if (dirTimer) return;
  dirTimer = setTimeout(() => {
    dirTimer = null;
    const frame = JSON.stringify({ t: "dir", channels: dirPayload() });
    for (const c of conns) if (c.handle && c.ws.readyState === 1) c.ws.send(frame);
  }, 500);
}

// ── Rooms ───────────────────────────────────────────────────────────────────
/** ch → { members:Set<conn>, history:Msg[], nextId, presenceTimer } */
const rooms = new Map();
function room(ch) {
  let r = rooms.get(ch);
  if (!r) { r = { members: new Set(), history: [], nextId: 1, presenceTimer: null, hydrated: false }; rooms.set(ch, r); }
  return r;
}
/** Pull a cold room's scrollback out of the store, once.
 *
 *  🔑 The in-memory ring stays the source of truth for LIVE sends — this only fills it the
 *  first time a room is touched after a restart. Concurrent joiners share one query via the
 *  stored promise, or ten people reconnecting after a redeploy each run their own. */
function hydrate(ch) {
  const r = room(ch);
  if (r.hydrated) return Promise.resolve(r);
  if (!r.hydrating) {
    r.hydrating = store.loadHistory(ch, HISTORY_KEEP)
      .then((msgs) => {
        // Anything said WHILE the load was in flight is already in the ring and is newer than
        // anything the query saw, so the loaded rows go in front of it rather than replacing it.
        const live = r.history;
        r.history = msgs.concat(live.filter((m) => !msgs.some((h) => h.id === m.id)));
        if (r.history.length > HISTORY_KEEP) r.history.splice(0, r.history.length - HISTORY_KEEP);
        r.hydrated = true;
        return r;
      })
      .catch((e) => { console.error("[chat] history load failed for", ch, e?.message); r.hydrated = true; return r; });
  }
  return r.hydrating;
}
function roomSend(ch, frame) {
  const r = rooms.get(ch);
  if (!r) return;
  const text = JSON.stringify(frame);
  for (const c of r.members) if (c.ws.readyState === 1) c.ws.send(text);
}
/** In the PU right now, as far as their own game.log is concerned. Membership of a `region:`
 *  room is the ONLY evidence of it the server has, and it is good evidence: the client joins one
 *  off a `Join PU` line and the sidecar drops it after 15 minutes of an untouched log. */
const inPu = (conn) => {
  for (const ch of conn.channels) if (ch.startsWith("region:")) return true;
  return false;
};

function presence(ch) {
  const r = rooms.get(ch);
  if (!r || r.presenceTimer) return;
  r.presenceTimer = setTimeout(() => {
    r.presenceTimer = null;
    // One row per HANDLE (a second window isn't a second person), capped for frame size —
    // the count stays exact past the cap.
    const seen = new Map();
    // 🔑 `activity` is OMITTED when absent rather than sent as null. Every shipped client
    // ignores unknown fields, so adding one is safe — but a null on every row would make an
    // older widget's "does this member have an activity" check answer differently from a newer
    // one's for the same person, and the protocol has to stay boringly backward compatible.
    for (const c of r.members) {
      if (seen.has(c.handleLower)) continue;
      const m = { handle: c.handle, verified: c.verified };
      if (c.activity) m.activity = c.activity;
      // Absent = "no choice made", which the client renders as the name hash it always used.
      const col = userColors.get(c.handleLower);
      if (typeof col === "number") m.color = col;
      // Org standing, for the badge. Sent only when the dossier actually gave us one.
      if (c.orgSid) m.org = c.orgSid;
      if (c.orgRank) m.orgRank = c.orgRank;
      if (c.orgStars) m.orgStars = c.orgStars;
      // 🔑 IN-GAME is derived from membership of a `region:` room, which the client only ever
      // holds while game.log says it is in the PU — and the sidecar drops it after 15 minutes of
      // an untouched log, so it self-corrects when someone alt-F4s. No new client data, no new
      // frame, and nothing a client can assert about itself that its own log has not already said.
      // 🔴 There is deliberately NO "offline" here. Everyone in a presence list is connected by
      // definition; someone you cannot see is simply absent from the list, and saying "offline"
      // about them would be a confident lie about a person sitting in a room you never joined.
      for (const ch of c.channels) if (ch.startsWith("region:")) { m.inGame = true; break; }
      seen.set(c.handleLower, m);
    }
    roomSend(ch, { t: "presence", ch, count: seen.size, members: [...seen.values()].slice(0, MEMBERS_CAP) });
    if (ch.startsWith("custom:")) broadcastDir();
  }, 250);
}
/** Label + kind ride the joined frame for rooms the CLIENT can't derive (org names, custom
 *  display casing). Auto channels send neither; the client's own labels are already right. */
function joinRoom(conn, ch, label, kind) {
  if (conn.channels.has(ch)) return;
  const r = room(ch);
  r.members.add(conn);
  conn.channels.add(ch);
  // `joined` goes out immediately so the channel appears at once; `history` follows when the
  // store answers. They were always separate frames, and the client appends rather than
  // waiting on the pair, so a cold room costs a beat of empty scrollback and nothing else.
  conn.send({ t: "joined", ch, ...(label ? { label } : {}), ...(kind ? { kind } : {}) });
  // A pin is room state, not scrollback — send it on the way in or a joiner sees the notice only
  // if someone happens to re-pin while they are watching.
  if (pins.has(ch)) conn.send({ t: "pin", ch, pin: pins.get(ch) });
  hydrate(ch).then((h) => {
    if (conn.channels.has(ch)) conn.send({ t: "history", ch, msgs: h.history.slice(-HISTORY_SEND) });
  });
  presence(ch);
}
/** Validate, record and broadcast one message into a room the sender is already in.
 *  Returns the message, or null if it was refused (the refusal is already sent).
 *  🔑 Channel messages and DMs both come through here — the rate limit, the control-char strip
 *  and the code-point truncation are rules about MESSAGES, not about channels, and a second
 *  copy of them is a second place for them to drift. */
/** The per-connection rate window, shared by messages and reports so the rule lives in ONE place.
 *  🔑 Checking and STAMPING are separate on purpose: an empty message is rejected without
 *  spending quota, and that has to stay true now a second caller uses the same window. */
function underRate(conn) {
  const now = Date.now();
  conn.stamps = conn.stamps.filter((s) => now - s < RATE_WINDOW_MS);
  return conn.stamps.length < RATE_N;
}

function deliver(conn, ch, raw) {
  const now = Date.now();
  if (!underRate(conn)) { conn.send({ t: "error", code: "rate", message: "Slow down a little." }); return null; }
  // Strip control chars; the widget renders via textContent so markup is inert anyway.
  // 🔑 Truncate by CODE POINT, not by .slice(): an emoji is a surrogate PAIR, and slicing
  // between its halves emits a lone surrogate — the black-diamond "�" every client would
  // then render, from a message that was perfectly valid when sent.
  const cleaned = String(raw ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
  const text = [...cleaned].slice(0, MSG_MAX).join("");
  if (!text) { conn.send({ t: "error", code: "bad_msg", message: "Empty message." }); return null; }
  // Auto-moderation runs on the FINAL text, after cleaning and truncation, so what is judged is
  // exactly what would have been broadcast.
  //
  // 🔴 The two tiers do genuinely different things, which is Sub's policy and not an
  // implementation detail: a slur REFUSES the message and bans, ordinary profanity is asterisked
  // and the message goes through. "I really don't care if an adult uses profanity amongst other
  // adults. I don't need to ban for that."
  const hit = automod.scan(text);
  let body = text;
  if (hit) {
    // 🔑 The rate stamp is pushed FIRST so a refused message still costs its quota; without
    // that, matching text is the one thing you can send as fast as you like.
    if (hit.action === "ban") {
      conn.stamps.push(now);
      recordModEvent({
        kind: "autoban", ch, about: conn.handleLower, by: "automod",
        reason: `ban list: ${hit.term}`, text, banned: true,
      });
      applyBan(conn.handleLower);   // sends the eviction itself
      return null;
    }
    body = hit.text ?? text;
    // 🔑 Which LIST matched decides whether a moderator hears about it, never what was done.
    // A slur masked in "censor" mode is exactly what a mod wants to see; ordinary profanity is
    // not, and pushing one event per "shit" would make the mod channel unreadable inside a day —
    // at which point the reports that matter get scrolled past. Counted instead, on /admin/health.
    if (hit.tier === "ban") {
      recordModEvent({
        kind: "autoflag", ch, about: conn.handleLower, by: "automod",
        reason: `ban list: ${hit.term} (censor mode — no ban applied)`, text, banned: false,
      });
    } else { censored++; }
  }
  conn.stamps.push(now);
  const msg = { ch, id: nextMsgId++, from: { handle: conn.handle, verified: conn.verified }, text: body, at: new Date().toISOString() };
  const r = room(ch);
  r.history.push(msg);
  if (r.history.length > HISTORY_KEEP) r.history.splice(0, r.history.length - HISTORY_KEEP);
  // Broadcast FIRST, persist behind it — the store is never allowed to delay a live message.
  roomSend(ch, { t: "msg", ...msg });
  store.saveMessage(msg);
  return msg;
}

/** Set or clear a room's pin, tell the room, and persist behind it.
 *  Used by the owner's pin verb AND the loopback admin route, so an ownerless system room ends
 *  up in exactly the same state as a custom one — the same reason destroyRoom is shared. */
function setPin(ch, pin) {
  if (pin) { pins.set(ch, pin); store.savePin(pin); }
  else { pins.delete(ch); store.deletePin(ch); }
  // 🔑 `pin: null` is a real value here, not an omission — an unpin has to REACH clients, and a
  // frame that simply left the field out would leave the old banner sitting there forever.
  roomSend(ch, { t: "pin", ch, pin: pin ?? null });
}

/** Ban a handle: remember it, persist it, and evict every connection holding it.
 *  Shared by the loopback /admin/ban route, the portal's queued action, and auto-moderation, so
 *  a ban means exactly one thing however it was decided — the same reasoning as destroyRoom.
 *  🔑 Idempotent on purpose. A queued action that we applied but failed to ACK is redelivered,
 *  so re-banning has to be free; `bans` is a Set and the store insert is ON CONFLICT DO NOTHING. */
function applyBan(handle) {
  bans.add(handle);
  for (const c of conns) if (c.handleLower === handle) { c.send({ t: "error", code: "banned", message: "You have been banned." }); c.ws.close(); }
  store.saveBan(handle);
  return true;
}
function liftBan(handle) {
  bans.delete(handle);
  store.deleteBan(handle);
  return true;
}

/** Record one moderation event and tell the portal about it.
 *
 *  🔑 An auto-ban writes the SAME SHAPE as a player report — same table, same snapshotted
 *  message text — because Sub's requirement for reviewing one is his requirement for reviewing
 *  the other: "take a look at the message and decide if I want to unban." A ban with no evidence
 *  attached cannot be reviewed at all, and by the time anyone looks, scrollback has been pruned.
 *  🔑 The row is written FIRST and the push is not awaited: the record is what matters, the
 *  Discord ping is a convenience, and neither is allowed to sit in front of a live message. */
function recordModEvent({ kind, ch, about, by, reason, id = null, text = null, banned = false }) {
  const at = Date.now();
  store.saveReport({ ch, about, by, reason, id, text, at });
  modlink.push({ kind, ch, about, by, reason, msgId: id, text, banned, at, mode: automod.mode });
}

/** Wipe a custom room: evict everyone, drop it from the directory, delete it and its messages.
 *  Used by the owner's delete and by the loopback admin route, so both paths behave identically
 *  — a moderator deleting a room and an owner deleting one must not leave different residue. */
function destroyRoom(slug, label) {
  const ch = `custom:${slug}`;
  const r = rooms.get(ch);
  if (r) {
    for (const c of [...r.members]) {
      c.channels.delete(ch);
      // Say WHY. A channel that silently vanishes reads as a disconnect, and the client would
      // cheerfully re-add it to customRooms and try to rejoin on the next reconnect.
      c.send({ t: "left", ch, reason: "deleted" });
      c.send({ t: "notice", level: "info", text: `“${label ?? slug}” was deleted.` });
    }
    r.members.clear();
    rooms.delete(ch);
  }
  customDir.delete(slug);
  store.deleteRoom(slug);
  broadcastDir();
  return true;
}

/** Join a custom room and hand back what the widget needs to describe it.
 *  🔑 The join CODE only ever goes to someone already inside the room — it is what admits the
 *  next person, so shipping it in the directory or on a refusal would defeat the whole gate. */
function joinCustom(conn, slug, meta) {
  joinRoom(conn, `custom:${slug}`, meta.label, "custom");
  sendRoomInfo(conn, slug, meta);
  touchRoom(slug);
}

/** Describe a room to ONE connection. Split out of joinCustom so the same frame can be re-sent
 *  when something about the room changes for that person — an application arriving, or being
 *  accepted — instead of only ever at join time.
 *  🔑 The pending applications go ONLY to the owner. They are a list of who wants in, which is
 *  nobody else's business, and the frame is per-connection precisely so it can differ. */
function sendRoomInfo(conn, slug, meta) {
  conn.send({
    t: "roominfo", ch: `custom:${slug}`,
    category: meta.category ?? DEFAULT_CATEGORY,
    privacy: meta.privacy ?? "public",
    owner: meta.owner ?? null,
    ...(meta.privacy === "private" ? { code: meta.code } : {}),
    ...(meta.isParty ? {
      party: true,
      location: meta.location ?? null,
      sizeMax: meta.sizeMax ?? null,
      joinMode: meta.joinMode ?? "open",
      voice: meta.voice ?? "none",
      expiresAt: meta.expiresAt ?? null,
    } : {}),
    ...(meta.owner === conn.handleLower ? { applications: meta.applications ?? [] } : {}),
  });
}

function leaveRoom(conn, ch) {
  if (!conn.channels.has(ch)) return;
  conn.channels.delete(ch);
  const r = rooms.get(ch);
  if (r) {
    r.members.delete(conn);
    // An empty region/shard room is garbage — shards churn every patch day. Global persists,
    // and CUSTOM rooms keep their object (and scrollback) while their directory entry lives;
    // pruneIdleRooms() is what finally retires them.
    if (r.members.size === 0 && (ch.startsWith("region:") || ch.startsWith("shard:"))) rooms.delete(ch);
    else presence(ch);
  }
  if (ch.startsWith("custom:")) {
    touchRoom(ch.slice("custom:".length));
    broadcastDir();
  }
  conn.send({ t: "left", ch });
}

// ── Identity ────────────────────────────────────────────────────────────────
const HANDLE_RE = /^[A-Za-z0-9._-]{3,30}$/; // RSI handle shape
const ORG_SID_RE = /^[A-Za-z0-9]{3,12}$/; // RSI org SIDs (e.g. IRREGS)
async function verifyIdentity(hello) {
  if (AUTH_MODE === "dev") {
    const handle = String(hello.handle ?? "").trim();
    if (!HANDLE_RE.test(handle)) return null;
    // Dev passthrough for org testing: hello.org = {sid, name}.
    const sid = String(hello.org?.sid ?? "");
    const org = ORG_SID_RE.test(sid) ? { sid, name: String(hello.org?.name ?? sid).slice(0, 60) } : null;
    return { handle, verified: true, org };
  }
  // site mode: the token is the overlay's existing sync token; the endpoint answers
  // { handle: "RSIHandle", verified: true|false } and 401s an unknown token. A KNOWN
  // token with no verified handle is a distinct case — the user needs to hear "go
  // verify", not "who are you".
  const token = String(hello.token ?? "");
  if (!token) return null;
  try {
    const res = await fetch(AUTH_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const d = await res.json();
    const handle = String(d?.handle ?? "");
    if (d?.verified !== true || !HANDLE_RE.test(handle)) return { handle: "", verified: false };
    // The verified org from the RSI dossier (captured at handle-verification time) drives the
    // org channel. Absent/redacted org just means no org room — never a refusal.
    const sid = String(d?.orgSid ?? "");
    // 🔑 `stars` is RSI's own 1-5 and is the same scale for every org; `rank` is the org's own
    // word for that tier and is DISPLAY TEXT ONLY. Anything that sorts, gates or infers must use
    // the stars — "President", "SSGT" and "Soon to be Casual" are all real tier names and none
    // of them can be ordered against another org's.
    const stars = Number(d?.orgRankStars);
    const org = ORG_SID_RE.test(sid) ? {
      sid,
      name: String(d?.orgName ?? sid).slice(0, 60),
      rank: String(d?.orgRank ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 32),
      stars: Number.isInteger(stars) && stars >= 1 && stars <= 5 ? stars : 0,
    } : null;
    return { handle, verified: true, org };
  } catch { return null; }
}

// ── Location → channel names. Validate hard: these strings come from clients. ──
const REGION_RE = /^[a-z0-9]{3,12}$/;
const SHARD_RE = /^[a-z0-9][a-z0-9_-]{4,63}$/i;
// Exactly what dgsKey() emits: 10 lowercase hex characters. Nothing else is a DGS key.
const DGS_RE = /^[0-9a-f]{10}$/;
function locChannels(loc) {
  const out = [];
  const region = typeof loc.region === "string" ? loc.region.toLowerCase() : "";
  const shard = typeof loc.shard === "string" ? loc.shard : "";
  const dgs = typeof loc.dgs === "string" ? loc.dgs.toLowerCase() : "";
  if (REGION_RE.test(region)) out.push(`region:${region}`);
  // 🔑 NO shard room. Dropped 2026-08-09 on Sub's call. Two location tiers, not three:
  //   region  use1b   everyone on US East 1B — the LETTER is part of the key, so 1A and 1B
  //                   are different rooms and someone on 1A never sees this one
  //   dgs     <hash>  the Dynamic Game Server actually running where you are — who is around
  //                   you right now
  // The shard sat between them with no meaning a player could act on: it is an implementation
  // detail of how CIG splits a region, and it kept showing three people when only one was
  // genuinely nearby. `shard` is still ACCEPTED in the frame because it salts the DGS hash and
  // v1 clients send it; it just no longer opens a room of its own.
  // 🔑 The client sends a HASH of ip:port, never the endpoint, so this server never learns and
  // never rebroadcasts a CIG address. Shape-checked so the key space stays exactly what the
  // client can produce and a crafted value cannot smuggle in a prefix.
  if (DGS_RE.test(dgs)) out.push(`dgs:${dgs}`);
  return out;
}

// ── HTTP (health + loopback admin) ──────────────────────────────────────────
const loopback = (req) => {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
};
function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 4096) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } });
  });
}
const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/health") {
    // 🔑 A health check says "I am alive", not "here is every room and who is in it". The room
    // map named every private and custom room and its occupancy to anyone on the internet —
    // which, for rooms whose whole point is not being listed, defeats the feature. The detail
    // moved to the loopback admin side, where the ban and room tools already live.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: AUTH_MODE, connections: wss.clients.size, rooms: rooms.size }));
    return;
  }
  if (url === "/admin/health" && loopback(req)) {
    const roomStats = {};
    for (const [ch, r] of rooms) roomStats[ch] = r.members.size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true, mode: AUTH_MODE, connections: wss.clients.size, rooms: roomStats,
      automod: { mode: automod.mode, ban: automod.banSize, censor: automod.censorSize, masked: censored },
    }));
    return;
  }
  // Ban admin is loopback-only — same rule as the sidecar's /api/twitch/*: an endpoint
  // that ACTS with authority IS the authority, so it must not answer the LAN.
  if (url.startsWith("/admin/") && !loopback(req)) { res.writeHead(403); res.end(); return; }
  // Who is actually connected, and what each connection is asserting about itself. There was no
  // way to answer "why is this person showing as in-game when they are not" — /admin/health
  // gives counts, and counts cannot name anybody.
  if (url === "/admin/conns" && req.method === "GET") {
    const now = Date.now();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([...conns].filter((c) => c.handle).map((c) => ({
      handle: c.handle,
      org: c.orgSid, orgStars: c.orgStars,
      rooms: [...c.channels],
      inPu: inPu(c),
      // 🔑 The three ages that actually explain a ghost: how long the socket has been up, when
      // they last said anything at all, and when they last asserted a LOCATION. A location far
      // older than the session is a client that set it once and never corrected it.
      connectedMin: Math.round((now - (c.connectedAt ?? now)) / 60000),
      lastFrameMin: c.lastFrameAt ? Math.round((now - c.lastFrameAt) / 60000) : null,
      lastLocMin: c.lastLocAt ? Math.round((now - c.lastLocAt) / 60000) : null,
    }))));
    return;
  }
  // Drop a handle's LOCATION rooms without touching their account. Sub, 2026-08-12, about a
  // tester stuck in US East 1B: "I just want him removed. Preferably without banning him from
  // the whole app." Banning was the only eviction this server had, and a ban is the wrong tool
  // for a client that is simply wrong about where it is.
  // 🔑 It sticks for as long as the socket lives, because a client only re-asserts `loc` on
  // welcome (reconnect) or a real shard change — so this is not a game of whack-a-mole unless
  // their app restarts.
  if (url === "/admin/clear-location" && req.method === "POST") {
    const handle = String((await readBody(req)).handle ?? "").toLowerCase();
    if (!HANDLE_RE.test(handle)) { res.writeHead(400); res.end(); return; }
    let cleared = 0;
    for (const c of conns) {
      if (c.handleLower !== handle) continue;
      for (const ch of [...c.channels]) {
        if (ch.startsWith("region:") || ch.startsWith("shard:") || ch.startsWith("dgs:")) { leaveRoom(c, ch); cleared++; }
      }
      c.locBlocked = true;   // and don't let the same stale value walk straight back in
      for (const ch of c.channels) presence(ch);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, handle, cleared }));
    return;
  }
  if (url === "/admin/bans" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([...bans]));
    return;
  }
  if ((url === "/admin/ban" || url === "/admin/unban") && req.method === "POST") {
    const handle = String((await readBody(req)).handle ?? "").toLowerCase();
    if (!HANDLE_RE.test(handle)) { res.writeHead(400); res.end(); return; }
    if (url === "/admin/ban") applyBan(handle); else liftBan(handle);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, bans: bans.size }));
    return;
  }
  // Moderation: list and delete ANY room, including ones with no owner (everything imported
  // from the old channels.json has owner NULL, so the owner-gated path can never touch them).
  // Loopback-only like the ban routes — an endpoint that ACTS with authority IS the authority.
  if (url === "/admin/rooms" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([...customDir.entries()].map(([slug, m]) => ({
      slug, label: m.label, category: m.category, privacy: m.privacy, owner: m.owner,
      members: rooms.get(`custom:${slug}`)?.members.size ?? 0,
    }))));
    return;
  }
  if (url === "/admin/room-delete" && req.method === "POST") {
    const slug = String((await readBody(req)).slug ?? "").toLowerCase();
    const meta = customDir.get(slug);
    if (!meta) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "no such room" })); return; }
    destroyRoom(slug, meta.label);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, deleted: slug, rooms: customDir.size }));
    return;
  }
  // The reports queue. Read-only — acting on a report means banning, and that route already
  // exists; this one only answers "what has been reported".
  if (url === "/admin/reports" && req.method === "GET") {
    const list = await store.listReports(200);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }
  // Pinning for the rooms nobody owns — global, region, Nearby, org. Same shape as the
  // owner's verb; `text` is given directly rather than looked up, because a notice in Global
  // is usually something a moderator is WRITING, not a message someone already sent.
  if (url === "/admin/pin" && req.method === "POST") {
    const b = await readBody(req);
    const ch = String(b.ch ?? "");
    const text = String(b.text ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
    if (!ch || !text) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "ch and text required" })); return; }
    setPin(ch, { ch, id: null, handle: String(b.handle ?? "Moderator"), text: [...text].slice(0, MSG_MAX).join(""), by: "admin", at: Date.now() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ch }));
    return;
  }
  if (url === "/admin/unpin" && req.method === "POST") {
    const ch = String((await readBody(req)).ch ?? "");
    setPin(ch, null);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ch }));
    return;
  }
  res.writeHead(404); res.end();
});

// ── WebSocket ───────────────────────────────────────────────────────────────
// 🔴 maxPayload. Without it `ws` will buffer a frame of ANY size — a single client streaming
// a huge message is an out-of-memory kill of the whole chat server for everyone. 16 KB is
// forty times the 400-character message limit, which leaves room for the biggest legitimate
// frame (a hello with a token) and nothing like enough for an attack.
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
const conns = new Set();

wss.on("connection", (ws) => {
  const conn = {
    ws,
    handle: null, handleLower: null, verified: false,
    // What this player is doing, as their own client chose to describe it. OPT-IN at the
    // client — an absent activity is the normal, expected state and means nothing more than
    // "not sharing", never "idle".
    activity: null,
    channels: new Set(),
    orgSid: null, orgRank: null, orgStars: 0, token: null, // org membership + the token used to re-check it
    connectedAt: Date.now(), lastFrameAt: 0, lastLocAt: 0,
    // Set by /admin/clear-location: this connection's own idea of where it is has been
    // overruled, and re-asserting the SAME value must not undo that. A genuinely new location
    // clears the block, because that is a client that has actually moved.
    locBlocked: false, lastLocKey: null,
    stamps: [], // send timestamps for the message rate limit
    acts: [],   // and for access attempts (join / dm / invite / delete)
    alive: true,
    send(frame) { if (ws.readyState === 1) ws.send(JSON.stringify(frame)); },
  };
  conns.add(conn);
  ws.on("pong", () => { conn.alive = true; });

  ws.on("message", async (raw) => {
    let f;
    try { f = JSON.parse(String(raw)); } catch { return; }
    if (!f || typeof f !== "object") return;
    conn.lastFrameAt = Date.now();

    if (f.t === "hello" && !conn.handle) {
      const id = await verifyIdentity(f);
      if (!id) { conn.send({ t: "error", code: "bad_auth", message: "Could not verify your account." }); ws.close(); return; }
      // The gate: no verified RSI account, no chat. (dev mode returns verified=true.)
      if (!id.verified) { conn.send({ t: "error", code: "bad_auth", message: "Verify your RSI account on subliminal.gg to use chat." }); ws.close(); return; }
      if (bans.has(id.handle.toLowerCase())) { conn.send({ t: "error", code: "banned", message: "You have been banned." }); ws.close(); return; }
      conn.handle = id.handle;
      conn.handleLower = id.handle.toLowerCase();
      conn.verified = id.verified;
      conn.orgSid = id.org ? id.org.sid.toLowerCase() : null;
      // The org's own word for their tier, and RSI's underlying 1-5. Only the number is
      // comparable between orgs; the word is a label.
      conn.orgRank = id.org?.rank || null;
      conn.orgStars = id.org?.stars || 0;
      // Every real handle and org that connects becomes a name nobody can impersonate.
      reserveName(conn.handleLower, "handle");
      if (conn.orgSid) reserveName(conn.orgSid, "org");
      // Kept solely to RE-ASK the site later (see the org recheck). Never logged, never sent.
      conn.token = typeof f.token === "string" ? f.token : null;
      // The category list rides the welcome frame so the widget's dropdown is rendered from the
      // server's list rather than a copy that drifts. v1 clients ignore the extra field.
      // `you.color` is their own saved choice, so the picker opens showing what is actually set
      // rather than defaulting to "none" and inviting them to re-pick what they already have.
      conn.send({
        t: "welcome",
        you: { handle: conn.handle, verified: conn.verified, color: userColors.get(conn.handleLower) ?? null },
        categories: ROOM_CATEGORIES,
      });
      joinRoom(conn, "global");
      // Verified org → its room, automatically. No setup, no invite — membership on the RSI
      // dossier IS the invite.
      if (id.org) joinRoom(conn, `org:${id.org.sid.toLowerCase()}`, id.org.name, "org");
      conn.send({ t: "dir", channels: dirPayload() });
      // Conversations waiting for them. Sent rather than asked for, because a DM received while
      // offline is the case DMs exist to handle — it has to be visible on the next login without
      // the user knowing to go looking.
      store.dmThreads(conn.handleLower)
        .then((threads) => { if (threads.length && conn.ws.readyState === 1) conn.send({ t: "dms", threads }); })
        .catch(() => { /* the list is a convenience; chat works without it */ });
      return;
    }
    if (!conn.handle) return; // nothing but hello before auth

    // 🔴 Rate-limit the frames that ATTEMPT ACCESS, not just the one that talks. `msg` was
    // limited from the start; `join` was not — and join doubles as "redeem this 6-character
    // code", so an attacker could guess codes as fast as the socket allowed. `dm` and `invite`
    // are here too: both reach a named stranger, so unlimited attempts are unlimited spam.
    // Separate budget from messages, because a burst of joins on connect is normal and must not
    // eat the allowance for actually speaking.
    if (f.t === "join" || f.t === "dm" || f.t === "invite" || f.t === "deleteRoom" || f.t === "roomconfig") {
      const now = Date.now();
      conn.acts = (conn.acts ?? []).filter((s) => now - s < ACT_WINDOW_MS);
      if (conn.acts.length >= ACT_N) {
        conn.send({ t: "error", code: "rate", message: "Too many attempts — wait a moment." });
        return;
      }
      conn.acts.push(now);
    }

    if (f.t === "loc") {
      const wasInPu = inPu(conn);
      const want = new Set(locChannels(f));
      conn.lastLocAt = Date.now();
      // 🔑 An overruled location stays overruled until the client says something DIFFERENT.
      // A stuck client re-asserts the same shard on every reconnect; a real player who moves
      // sends a new one, and that is the signal that it is worth listening to them again.
      const key = [...want].sort().join(",");
      if (conn.locBlocked) {
        if (key === conn.lastLocKey) return;
        conn.locBlocked = false;
      }
      conn.lastLocKey = key;
      // Only the AUTO location channels churn with the log — global/org/custom stay put.
      for (const ch of [...conn.channels])
        if ((ch.startsWith("region:") || ch.startsWith("shard:") || ch.startsWith("dgs:")) && !want.has(ch)) leaveRoom(conn, ch);
      for (const ch of want) joinRoom(conn, ch);
      // 🔑 Joining/leaving a room only refreshes THAT room's presence — but the in-game marker
      // rides on every room this person is in, so quitting the game would leave a stale "in game"
      // dot beside their name in Global and their org for as long as they stayed connected.
      // Only on a real transition: `loc` arrives on every shard hop and most of them do not
      // change whether they are in the PU at all.
      if (inPu(conn) !== wasInPu) for (const ch of conn.channels) presence(ch);
      return;
    }

    // ── your name colour ─────────────────────────────────────────────────
    // Sub, 2026-08-12: "just pick eight colors and allow the people to go and change the color
    // of their name." It is a per-PERSON choice that everyone else sees, so it lives on the
    // server rather than in each client's localStorage — the whole value is that a regular
    // becomes recognisable at a glance to the room, not to themselves.
    if (f.t === "color") {
      const raw = f.color;
      const idx = raw === null || raw === undefined ? null : Number(raw);
      // 🔴 An INTEGER 0..7, and it is validated here rather than trusted. The client renders
      // this into every other player's DOM; anything that is not one of eight indices is refused
      // outright rather than clamped, because a clamp turns a bad frame into a silent wrong answer.
      if (idx !== null && !(Number.isInteger(idx) && idx >= 0 && idx <= COLOR_MAX)) {
        conn.send({ t: "error", code: "bad_msg", message: "That isn't one of the colours." });
        return;
      }
      if ((userColors.get(conn.handleLower) ?? null) === idx) return;   // unchanged is free
      if (!underRate(conn)) { conn.send({ t: "error", code: "rate", message: "Slow down a little." }); return; }
      conn.stamps.push(Date.now());
      if (idx === null) userColors.delete(conn.handleLower); else userColors.set(conn.handleLower, idx);
      store.saveUserColor(conn.handleLower, idx);
      conn.send({ t: "color", color: idx });
      // Same fan-out as activity: every room they are in has a member list that just went stale.
      for (const ch of conn.channels) presence(ch);
      return;
    }

    // ── what you are doing ───────────────────────────────────────────────
    // The friends list and the member rail are the only places this shows, and it is the one
    // thing an external chat can offer that the game's own social panel will not: it comes off
    // game.log. Sharing it is OPT-IN at the client and null clears it.
    //
    // 🔴 This is a short string broadcast to every member of every channel you are in, so it
    // has to cost something. It is charged against the MESSAGE budget: setting an activity is
    // at most as cheap as saying it out loud, which is the bar a would-be spammer has to beat
    // for this to be worth abusing. An unchanged value is free — clients re-send on reconnect
    // and on every log event, and none of that should burn quota.
    if (f.t === "activity") {
      const raw = f.activity === null || f.activity === undefined ? null : String(f.activity);
      const cleaned = raw === null ? null
        : ([...raw.replace(/[\x00-\x1f\x7f]/g, " ").trim()].slice(0, ACTIVITY_MAX).join("") || null);
      if (cleaned === conn.activity) return;
      if (!underRate(conn)) { conn.send({ t: "error", code: "rate", message: "Slow down a little." }); return; }
      conn.stamps.push(Date.now());
      conn.activity = cleaned;
      // Every room they are in has a member list that just went stale. presence() debounces per
      // room, so a player in eight channels costs eight debounced frames, not eight immediate ones.
      for (const ch of conn.channels) presence(ch);
      return;
    }

    // Custom rooms: join-or-create by display name (mode narrows it: "join" = must exist,
    // "create" = must not).
    // v1 clients (0.1.41) send only {name, mode} — they get a public Social/Other room, exactly
    // what they got before categories existed. `category` and `privacy` are additive.
    if (f.t === "join") {
      const typed = String(f.name ?? "").trim().slice(0, 30);

      // A private room has no name anyone can look up, so the same box takes its CODE. Try that
      // first: a 6-char code and a 6-char room name are both plausible, and a code can only ever
      // match a room that deliberately handed it out.
      if (f.mode !== "create" && CODE_RE.test(typed)) {
        const hit = roomByCode(typed);
        if (hit) {
          if (!mayJoin(conn, hit.meta, typed)) { conn.send({ t: "error", code: "not_invited", message: "That code isn't valid any more." }); return; }
          // 🔑 Redeeming a code RECORDS an invite. Without this the code is the only way back
          // in, so the app reconnecting (or restarting) would silently drop them from a room
          // they are legitimately in — the client rejoins by NAME, and a name alone does not
          // open a private room. It also makes revocation mean something: pulling someone's
          // invite actually removes them, instead of them holding a permanent skeleton key.
          if (!hit.meta.invites.includes(conn.handleLower)) {
            hit.meta.invites.push(conn.handleLower);
            store.addInvite(hit.slug, conn.handleLower, "code");
          }
          joinCustom(conn, hit.slug, hit.meta);
          return;
        }
        // Not a code — fall through and try it as an ordinary name.
      }

      const slug = slugOfName(typed);
      if (!slug) { conn.send({ t: "error", code: "bad_channel", message: "Channel names are 3–30 letters, numbers, spaces or -._" }); return; }
      const existing = customDir.get(slug);

      if (f.mode === "join" && !existing) { conn.send({ t: "error", code: "no_such_channel", message: `No channel called “${typed}”.` }); return; }
      if (f.mode === "create" && existing) { conn.send({ t: "error", code: "channel_exists", message: `“${existing.label}” already exists — join it instead.` }); return; }

      if (existing) {
        // 🔑 An apply-only listing is the one refusal that must NOT be vague. It is public and
        // sitting on the board with its name on it, so "no such channel" would be an obvious lie
        // and would leave the person with no idea what to do next. Tell them to ask.
        if (existing.isParty && existing.joinMode === "apply"
            && existing.owner !== conn.handleLower && !existing.invites?.includes(conn.handleLower)) {
          conn.send({ t: "error", code: "not_invited", message: `“${existing.label}” approves people first — ask to join.` });
          return;
        }
        // 🔑 A private room must be indistinguishable from one that does not exist. Saying
        // "that's private" confirms the name to anyone guessing, which is half of finding it.
        if (!mayJoin(conn, existing, typed)) {
          conn.send({ t: "error", code: "no_such_channel", message: `No channel called “${typed}”.` });
          return;
        }
        joinCustom(conn, slug, existing);
        return;
      }

      // 🔴 The impersonation guard. Checked at CREATE only: an existing room keeps working, and
      // the answer can only ever get stricter as more orgs and handles connect.
      if (reservedNames.has(slug)) {
        conn.send({ t: "error", code: "name_reserved",
          message: `“${typed}” is the name of an org or a player, so a room can't be called that. Pick something else.` });
        return;
      }
      const category = CATEGORY_SLUGS.has(f.category) ? f.category : DEFAULT_CATEGORY;
      const privacy = f.privacy === "private" ? "private" : "public";
      const code = privacy === "private" ? makeCode() : null;
      if (privacy === "private" && !code) { conn.send({ t: "error", code: "bad_channel", message: "Couldn't allocate a join code — try again." }); return; }
      const meta = { slug, label: typed, category, privacy, code, owner: conn.handleLower,
                     created: Date.now(), lastActive: Date.now(), invites: [], applications: [],
                     ...partyFieldsFrom(f) };
      customDir.set(slug, meta);
      store.saveRoom(meta);
      broadcastDir();     // a no-op for a private room, which is never in the directory
      joinCustom(conn, slug, meta);
      return;
    }

    // Invite someone into a private room. Owner only — an invite is the power to widen access,
    // so it belongs to whoever accepted responsibility for the room by making it.
    if (f.t === "invite") {
      const ch = String(f.ch ?? "");
      const slug = ch.startsWith("custom:") ? ch.slice("custom:".length) : "";
      const meta = customDir.get(slug);
      if (!meta) { conn.send({ t: "error", code: "no_such_channel", message: "No such channel." }); return; }
      if (meta.owner !== conn.handleLower) { conn.send({ t: "error", code: "not_owner", message: "Only the person who made the room can invite to it." }); return; }
      const handle = String(f.handle ?? "").trim();
      if (!HANDLE_RE.test(handle)) { conn.send({ t: "error", code: "bad_handle", message: "That doesn't look like an RSI handle." }); return; }
      const lower = handle.toLowerCase();
      if (!meta.invites.includes(lower)) {
        meta.invites.push(lower);
        store.addInvite(slug, lower, conn.handleLower);
      }
      conn.send({ t: "invited", ch, handle });
      // Tell them now if they're online; otherwise the invite simply waits for them.
      for (const c of conns) {
        if (c.handleLower === lower && c.ws.readyState === 1) {
          c.send({ t: "roominvite", ch, label: meta.label, category: meta.category, from: conn.handle });
        }
      }
      return;
    }

    // Delete a room outright. Owner only — the same authority that can widen access can end it.
    // 🔑 This is a MODERATION tool as much as a tidy-up: a room's NAME is broadcast to every
    // user in the directory, so an inappropriate one is a problem the moment it exists and
    // "wait fourteen days for the idle prune" is not an answer.
    if (f.t === "deleteRoom") {
      const ch = String(f.ch ?? "");
      const slug = ch.startsWith("custom:") ? ch.slice("custom:".length) : "";
      const meta = customDir.get(slug);
      if (!meta) { conn.send({ t: "error", code: "no_such_channel", message: "No such channel." }); return; }
      if (meta.owner !== conn.handleLower) { conn.send({ t: "error", code: "not_owner", message: "Only the person who made the room can delete it." }); return; }
      destroyRoom(slug, meta.label);
      return;
    }

    // ── change a room's activity or privacy AFTER it exists ──────────────
    // Sub's ask, 2026-08-13. Until now the two questions a room answers at creation could only be
    // answered once: a room made public could never be closed, and one filed under the wrong
    // activity was wrong forever. Owner only — the same authority that invites, pins and deletes.
    if (f.t === "roomconfig") {
      const ch = String(f.ch ?? "");
      const slug = ch.startsWith("custom:") ? ch.slice("custom:".length) : "";
      const meta = customDir.get(slug);
      if (!meta) { conn.send({ t: "error", code: "no_such_channel", message: "No such channel." }); return; }
      if (meta.owner !== conn.handleLower) { conn.send({ t: "error", code: "not_owner", message: "Only the person who made the room can change it." }); return; }

      const wantCat = f.category === undefined || f.category === null ? null : String(f.category);
      if (wantCat !== null && !CATEGORY_SLUGS.has(wantCat)) {
        conn.send({ t: "error", code: "bad_channel", message: "That isn't one of the activities." });
        return;
      }
      const wantPriv = f.privacy === undefined || f.privacy === null ? null
        : (f.privacy === "private" ? "private" : "public");
      if (wantCat === null && wantPriv === null) return;   // nothing asked for is not an error

      // 🔴 An APPLY listing is public BY NECESSITY — it has to be findable to be applied to, which
      // is why the approval gate could never live in `privacy` in the first place. Hiding one from
      // the directory would leave a room whose whole purpose is taking applications with no way to
      // reach it, so this is refused rather than quietly accepted.
      if (wantPriv === "private" && meta.isParty && meta.joinMode === "apply") {
        conn.send({ t: "error", code: "bad_channel",
          message: "A group that approves people has to stay findable — it can't be private." });
        return;
      }

      const before = { category: meta.category ?? DEFAULT_CATEGORY, privacy: meta.privacy ?? "public" };
      if (wantCat !== null) meta.category = wantCat;

      let admitted = 0;
      if (wantPriv !== null && wantPriv !== before.privacy) {
        if (wantPriv === "private") {
          // A fresh code every time, never the room's old one back. A code that has been out in
          // the world is exactly what going private is meant to stop honouring — resurrecting it
          // would make the whole trip a no-op for anyone who had ever held it.
          const code = makeCode();
          if (!code) { conn.send({ t: "error", code: "bad_channel", message: "Couldn't allocate a join code — try again." }); return; }
          meta.privacy = "private";
          meta.code = code;
          // 🔴 EVERYONE STANDING IN THE ROOM MUST BE WRITTEN AN INVITE, or closing the door
          // evicts them on their next reconnect. The client rejoins custom rooms BY NAME, and a
          // name alone does not open a private room — so without this the people who were already
          // here would silently vanish from a room they are legitimately in, the same trap
          // redeeming a code already had to solve.
          for (const c of (rooms.get(ch)?.members ?? [])) {
            if (!c.handleLower || meta.invites.includes(c.handleLower)) continue;
            meta.invites.push(c.handleLower);
            store.addInvite(slug, c.handleLower, conn.handleLower);
            admitted++;
          }
        } else {
          // Public again: the code is DROPPED, not kept alongside. Anyone can walk in by name now,
          // so a live code is a second door that nobody is watching and that survives the room
          // being closed again later.
          meta.privacy = "public";
          meta.code = null;
        }
      }

      store.saveRoom(meta);
      // The directory is what changes for everyone else: a room going private leaves it entirely,
      // one going public appears, and a category change moves it between the rail's groups.
      broadcastDir();
      // 🔑 Re-describe the room to everyone IN it, one frame each — `sendRoomInfo` is
      // per-connection precisely because the answer differs: only the owner is told who has
      // applied, and only a member of a private room is ever handed the code.
      for (const c of (rooms.get(ch)?.members ?? [])) sendRoomInfo(c, slug, meta);
      if (wantPriv !== null && wantPriv !== before.privacy) {
        roomSend(ch, { t: "notice", level: "info", text: wantPriv === "private"
          ? `${meta.label} is now private. Everyone here stays; new people need the code.`
          : `${meta.label} is now public — anyone can join it by name, and the old code no longer works.` });
      }
      if (admitted) conn.send({ t: "notice", level: "info",
        text: `${admitted} ${admitted === 1 ? "person" : "people"} already here kept their access.` });
      return;
    }

    // ── pins ─────────────────────────────────────────────────────────────
    // Custom rooms: the OWNER pins, the same authority that can invite and delete. Global,
    // region, Nearby and org rooms have no owner at all, so they are pinned over the loopback
    // /admin/pin route instead — exactly the gap room deletion already had, where an ownerless
    // room could never be touched by the owner-gated path.
    if (f.t === "pin" || f.t === "unpin") {
      const ch = String(f.ch ?? "");
      if (!conn.channels.has(ch)) { conn.send({ t: "error", code: "not_member", message: "Not in that channel." }); return; }
      const slug = ch.startsWith("custom:") ? ch.slice("custom:".length) : "";
      const meta = slug ? customDir.get(slug) : null;
      if (!meta || meta.owner !== conn.handleLower) {
        conn.send({ t: "error", code: "not_owner", message: "Only the person who made the room can pin here." });
        return;
      }
      if (f.t === "unpin") { setPin(ch, null); return; }
      const id = Number(f.id);
      const src = room(ch).history.find((m) => m.id === id);
      if (!src) { conn.send({ t: "error", code: "bad_msg", message: "That message is no longer here." }); return; }
      setPin(ch, { ch, id, handle: src.from.handle, text: src.text, by: conn.handle, at: Date.now() });
      return;
    }

    // ── applying to a party listing ──────────────────────────────────────
    // 🔑 Applying does NOT join you. That is the whole difference between join_mode 'open' and
    // 'apply': the owner decides. Accepting writes a normal room_invite, so admission runs down
    // the exact path invites already use and there is no second way into a room to get wrong.
    if (f.t === "apply") {
      const slug = String(f.ch ?? "").startsWith("custom:") ? String(f.ch).slice("custom:".length) : "";
      const meta = slug ? customDir.get(slug) : null;
      if (!meta || !meta.isParty) { conn.send({ t: "error", code: "no_such_channel", message: "No such listing." }); return; }
      if (meta.joinMode !== "apply") { conn.send({ t: "error", code: "bad_channel", message: "That group is open — just join it." }); return; }
      if (meta.owner === conn.handleLower) { conn.send({ t: "error", code: "bad_handle", message: "It's your own group." }); return; }
      if (!underRate(conn)) { conn.send({ t: "error", code: "rate", message: "Slow down a little." }); return; }
      conn.stamps.push(Date.now());
      const note = typeof f.note === "string" ? f.note.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 140) : null;
      meta.applications = (meta.applications ?? []).filter((a) => a.handle !== conn.handleLower);
      meta.applications.push({ handle: conn.handleLower, note, at: Date.now() });
      store.addApplication(slug, conn.handleLower, note);
      conn.send({ t: "applied", ch: f.ch });
      // Tell the owner if they are online. If they are not, it is waiting in roominfo when they
      // next open the room — an application must not depend on both people being on at once.
      for (const c of conns) {
        if (c.handleLower === meta.owner && c.ws.readyState === 1) {
          c.send({ t: "notice", level: "info", text: `${conn.handle} asked to join “${meta.label}”.` });
          sendRoomInfo(c, slug, meta);
        }
      }
      return;
    }

    if (f.t === "acceptApplication" || f.t === "declineApplication") {
      const slug = String(f.ch ?? "").startsWith("custom:") ? String(f.ch).slice("custom:".length) : "";
      const meta = slug ? customDir.get(slug) : null;
      if (!meta) { conn.send({ t: "error", code: "no_such_channel", message: "No such channel." }); return; }
      if (meta.owner !== conn.handleLower) { conn.send({ t: "error", code: "not_owner", message: "Only the group's owner can do that." }); return; }
      const who = String(f.handle ?? "").toLowerCase();
      if (!(meta.applications ?? []).some((a) => a.handle === who)) {
        conn.send({ t: "error", code: "bad_handle", message: "No application from them." });
        return;
      }
      meta.applications = meta.applications.filter((a) => a.handle !== who);
      store.deleteApplication(slug, who);
      if (f.t === "acceptApplication") {
        // Admission IS an invite — same record, same effect on a reconnect.
        if (!meta.invites.includes(who)) meta.invites.push(who);
        store.addInvite(slug, who, conn.handleLower);
      }
      const word = f.t === "acceptApplication" ? "accepted" : "declined";
      for (const c of conns) {
        if (c.handleLower === who && c.ws.readyState === 1) {
          c.send({ t: "notice", level: "info", text: `Your request to join “${meta.label}” was ${word}.` });
        }
      }
      sendRoomInfo(conn, slug, meta);
      return;
    }

    // ── reporting a player ───────────────────────────────────────────────
    // 🔑 Nothing is broadcast and nothing changes in the room. A report that visibly did
    // something would be a weapon: it tells the reported player who reported them, and it hands
    // anyone a way to make a room look moderated. It lands in the store for review, and the
    // reporter gets an acknowledgement so they know it went somewhere.
    if (f.t === "report") {
      const ch = String(f.ch ?? "");
      if (!conn.channels.has(ch)) { conn.send({ t: "error", code: "not_member", message: "Not in that channel." }); return; }
      const about = String(f.handle ?? "").trim();
      if (!HANDLE_RE.test(about)) { conn.send({ t: "error", code: "bad_handle", message: "That doesn't look like an RSI handle." }); return; }
      if (about.toLowerCase() === conn.handleLower) { conn.send({ t: "error", code: "bad_handle", message: "You can't report yourself." }); return; }
      // Same window the message limiter uses — a report costs a message's worth of quota, so the
      // button can't be held down to flood the table.
      if (!underRate(conn)) { conn.send({ t: "error", code: "rate", message: "Slow down a little." }); return; }
      conn.stamps.push(Date.now());
      const id = Number.isFinite(Number(f.id)) ? Number(f.id) : null;
      const src = id === null ? null : room(ch).history.find((m) => m.id === id);
      recordModEvent({
        kind: "report",
        ch, about: about.toLowerCase(), by: conn.handleLower,
        reason: typeof f.reason === "string" ? f.reason.slice(0, 300) : null,
        id, text: src ? src.text : null,
        banned: bans.has(about.toLowerCase()),
      });
      conn.send({ t: "reported", ch, handle: about });
      return;
    }

    if (f.t === "leave") {
      const ch = String(f.ch ?? "");
      // Only custom rooms and DMs are leavable — auto channels follow the log, the org room
      // follows the dossier. (Muting those is a CLIENT affordance, not membership.)
      if (!ch.startsWith("custom:") && !ch.startsWith("dm:")) { conn.send({ t: "error", code: "bad_channel", message: "Only custom channels can be left." }); return; }
      leaveRoom(conn, ch);
      return;
    }

    if (f.t === "msg") {
      const ch = String(f.ch ?? "");
      if (!conn.channels.has(ch)) { conn.send({ t: "error", code: "not_member", message: "Not in that channel." }); return; }
      const msg = deliver(conn, ch, f.text);
      if (msg && ch.startsWith("custom:")) touchRoom(ch.slice("custom:".length));
      return;
    }

    // ── Direct messages ──────────────────────────────────────────────────
    // A DM is an ordinary room whose key is the ORDERED pair of handles, so scrollback,
    // persistence, rate limiting and rendering are all the code that already existed. What is
    // different is only who may be in it and how you get there.
    if (f.t === "dm") {
      const to = String(f.to ?? "").trim();
      if (!HANDLE_RE.test(to)) { conn.send({ t: "error", code: "bad_handle", message: "That doesn't look like an RSI handle." }); return; }
      if (to.toLowerCase() === conn.handleLower) { conn.send({ t: "error", code: "bad_handle", message: "You can't message yourself." }); return; }
      if (bans.has(to.toLowerCase())) { conn.send({ t: "error", code: "no_such_handle", message: `Can't reach ${to}.` }); return; }
      const { ch, a, b } = dmKey(conn.handle, to);
      // Both ends join before the send, so the message lands live for whoever is online and in
      // scrollback for whoever isn't. 🔑 EVERY connection of theirs — a second window is the
      // same person and must not miss a DM.
      joinRoom(conn, ch, to, "dm");
      for (const c of conns) {
        if (c.handleLower === to.toLowerCase() && c.ws.readyState === 1) joinRoom(c, ch, conn.handle, "dm");
      }
      const msg = deliver(conn, ch, f.text);
      if (msg) store.touchDm(a, b, Date.now());
      return;
    }

    if (f.t === "dmlist") {
      store.dmThreads(conn.handleLower)
        .then((threads) => conn.send({ t: "dms", threads }))
        .catch((e) => { console.error("[chat] dm list failed:", e?.message); conn.send({ t: "dms", threads: [] }); });
      return;
    }
  });

  ws.on("close", () => {
    conns.delete(conn);
    for (const ch of [...conn.channels]) {
      conn.channels.delete(ch);
      const r = rooms.get(ch);
      if (r) {
        r.members.delete(conn);
        if (r.members.size === 0 && (ch.startsWith("region:") || ch.startsWith("shard:") || ch.startsWith("dgs:") || ch.startsWith("dm:"))) rooms.delete(ch);
        else presence(ch);
      }
      if (ch.startsWith("custom:")) {
        touchRoom(ch.slice("custom:".length));
        broadcastDir();
      }
    }
  });
});

// Re-resolve org membership for live connections, and move anyone whose org changed.
// 🔑 Site mode only: `dev` trusts hello.org, so there is nothing to re-check and re-checking
// would just churn. A failed lookup (site down, network blip) changes NOTHING — losing your org
// room because of a transient 500 would be worse than the staleness this closes.
setInterval(() => {
  if (AUTH_MODE !== "site") return;
  for (const c of conns) {
    if (!c.handle || !c.token) continue;
    verifyIdentity({ token: c.token }).then((id) => {
      if (!id || !id.verified) return;                       // transient failure — leave it alone
      const next = id.org ? id.org.sid.toLowerCase() : null;
      // A promotion inside the SAME org is not a room change but it is a badge change, so it
      // has to reach the rails — otherwise a rank sticks at whatever it was when they connected.
      const nextRank = id.org?.rank || null;
      const nextStars = id.org?.stars || 0;
      if (next === c.orgSid && nextRank === c.orgRank && nextStars === c.orgStars) return;
      if (next === c.orgSid) {
        c.orgRank = nextRank; c.orgStars = nextStars;
        for (const ch of c.channels) presence(ch);
        return;
      }
      if (c.orgSid) leaveRoom(c, `org:${c.orgSid}`);
      c.orgSid = next;
      c.orgRank = nextRank;
      c.orgStars = nextStars;
      if (next) joinRoom(c, `org:${next}`, id.org.name, "org");
      console.log(`[chat-server] org changed for ${c.handle}: ${c.orgSid ?? "none"}`);
    }).catch(() => { /* transient — keep the current membership */ });
  }
}, ORG_RECHECK_MS).unref();

// Reap dead connections (a yanked network cable never sends close).
setInterval(() => {
  for (const c of conns) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch { /* closing */ }
  }
}, 30_000);

// Retire idle rooms and trim scrollback to the same bound the in-memory ring keeps. Hourly:
// both are housekeeping, and doing them on a change would tie how often they run to how busy
// chat happens to be.
setInterval(() => {
  pruneIdleRooms();
  store.pruneMessages(HISTORY_KEEP)
    .then((n) => { if (n) console.log(`[chat-server] pruned ${n} old message(s)`); })
    .catch((e) => console.error("[chat-server] message prune failed:", e?.message));
}, PRUNE_EVERY_MS).unref();

// 🔴 Deploy footgun: CHAT_AUTH defaults to "dev", which accepts ANY hello.handle as verified.
// Mis-set (or unset) in production and every identity in chat is free to claim. Refuse to start
// that way unless someone says so out loud.
if (AUTH_MODE === "dev" && process.env.CHAT_ALLOW_DEV_AUTH !== "1") {
  console.error("[chat-server] REFUSING TO START: CHAT_AUTH is 'dev', which trusts any handle. "
    + "Set CHAT_AUTH=site for production, or CHAT_ALLOW_DEV_AUTH=1 if this really is a local test.");
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`[chat-server] listening on :${PORT} (auth=${AUTH_MODE}, store=${store.mode}, `
    + `rooms=${customDir.size}, bans=${bans.size}, `
    + `automod=${automod.mode} ban:${automod.banSize} censor:${automod.censorSize})`);
  // Started AFTER listen so a poll can never race the boot, and no-op unless both the queue URL
  // and the shared secret are set.
  modlink.start();
});
