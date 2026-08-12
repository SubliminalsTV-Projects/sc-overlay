-- SC Overlay chat — Postgres schema (Timescale instance, `chat` schema, role chat_app).
--
-- Scrollback used to be an in-memory ring per room, so every Coolify redeploy silently wiped
-- every conversation in every channel. It also made DMs pointless: a message to someone who is
-- offline has to survive until they come back, and nothing here survived a restart.
--
-- Idempotent — safe to re-run. The server applies it on boot when DATABASE_URL is set.
--
-- 🔑 Table names are UNQUALIFIED on purpose: the pool sets search_path from CHAT_DB_SCHEMA
-- (default `chat`), so the same file builds a scratch schema for the store test. Hard-coding
-- `chat.` here would mean the Postgres path could only ever be exercised against live chat.

CREATE TABLE IF NOT EXISTS messages (
  id        bigint PRIMARY KEY,          -- assigned by the server, monotonic across restarts
  ch        text        NOT NULL,
  handle    text        NOT NULL,
  verified  boolean     NOT NULL DEFAULT true,
  text      text        NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
-- The only read pattern: the last N of one channel, newest first.
CREATE INDEX IF NOT EXISTS messages_ch_id ON messages (ch, id DESC);

-- Custom rooms. Replaces data/channels.json, which held only { label, created, lastActive }.
--   category  one of the activity slugs in ROOM_CATEGORIES (server.mjs) — how the directory groups
--   privacy   'public'  listed in the directory, anyone may join
--             'private' unlisted; entry needs the join CODE or an invite
--   code      short shareable code, private rooms only
CREATE TABLE IF NOT EXISTS rooms (
  slug        text PRIMARY KEY,
  label       text        NOT NULL,
  category    text        NOT NULL DEFAULT 'social',
  privacy     text        NOT NULL DEFAULT 'public',
  code        text,
  owner       text,                                  -- lowercase handle of the creator
  created     timestamptz NOT NULL DEFAULT now(),
  last_active timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rooms_privacy CHECK (privacy IN ('public', 'private'))
);
-- A code has to identify exactly one room to be worth typing. Partial: public rooms have none.
CREATE UNIQUE INDEX IF NOT EXISTS rooms_code ON rooms (code) WHERE code IS NOT NULL;

-- ── Party listings (Tier 2) ────────────────────────────────────────────────────────────────
-- 🔴 THESE MUST BE `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, NOT extra lines in the CREATE
-- above. `rooms` already exists in production, so `CREATE TABLE IF NOT EXISTS` is a NO-OP there
-- and any column added to it would silently never appear — the server would then read undefined
-- for every listing field and the whole feature would look broken on the live server while
-- passing every test against a fresh scratch schema.
--
-- A party listing IS a room, not a separate entity: it inherits membership, invites, the join
-- code, scrollback, presence, the pin and moderation. These columns are the only thing a
-- listing adds.
--   is_party   this room is advertising for members; plain chat rooms stay false
--   location   free text, or the leader's real region if they opted in when creating
--   size_max   headcount they want; the live count comes from presence, not from here
--   join_mode  'open'  anyone may walk in
--              'apply' they ask first and the owner accepts (accepting reuses the invite path)
--   voice      'none' | 'optional' | 'required' — expectation only; we host no voice
--   expires_at when the listing stops being advertised. A stale LFG board is a dead one.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_party   boolean     NOT NULL DEFAULT false;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS location   text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS size_max   integer;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS join_mode  text        NOT NULL DEFAULT 'open';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS voice      text        NOT NULL DEFAULT 'none';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS expires_at timestamptz;
-- The board's only read pattern: live listings, soonest to expire.
CREATE INDEX IF NOT EXISTS rooms_party ON rooms (expires_at) WHERE is_party;

-- Applications, for a listing whose join_mode is 'apply'. Accepting one writes a normal
-- room_invite, so the "let them in" path is code that already exists and is already tested.
-- 🔑 One row per (slug, handle): re-applying updates your note, it does not queue a second
-- application the owner has to dismiss twice.
CREATE TABLE IF NOT EXISTS room_applications (
  slug   text        NOT NULL REFERENCES rooms(slug) ON DELETE CASCADE,
  handle text        NOT NULL,
  note   text,
  at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, handle)
);

-- Invite-by-handle, the second way into a private room. Handles are stored lowercase; the RSI
-- handle is the identity everywhere in this server.
CREATE TABLE IF NOT EXISTS room_invites (
  slug       text        NOT NULL REFERENCES rooms(slug) ON DELETE CASCADE,
  handle     text        NOT NULL,
  invited_by text        NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, handle)
);

-- Bans. Replaces data/bans.json. The whole point of the RSI-verify gate is that these stick.
CREATE TABLE IF NOT EXISTS bans (
  handle text PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now()
);

-- One row per DM conversation, so a player's DM list is one indexed read rather than a scan of
-- every dm: channel. `a` is always the lexicographically smaller handle — the pair is the
-- identity, and storing it ordered is what stops (a,b) and (b,a) becoming two conversations.
CREATE TABLE IF NOT EXISTS dm_threads (
  a         text NOT NULL,
  b         text NOT NULL,
  last_at   timestamptz NOT NULL DEFAULT now(),
  a_read_at timestamptz,
  b_read_at timestamptz,
  PRIMARY KEY (a, b),
  CONSTRAINT dm_ordered CHECK (a < b)
);
CREATE INDEX IF NOT EXISTS dm_threads_a ON dm_threads (a, last_at DESC);
CREATE INDEX IF NOT EXISTS dm_threads_b ON dm_threads (b, last_at DESC);

-- Player reports. Chat is gated on an RSI-verified identity, so unlike most SC chat surfaces a
-- report here resolves to a real, bannable person — which is what makes reviewing them worth the
-- table. Reviewed over the loopback /admin/reports route, the same way bans are managed.
-- 🔑 `msg_text` is SNAPSHOTTED rather than joined to messages(id): scrollback is pruned and a
-- reported message is exactly the one someone wants deleted, so a foreign key would let the
-- evidence disappear with it.
CREATE TABLE IF NOT EXISTS reports (
  id       bigserial PRIMARY KEY,
  ch       text        NOT NULL,
  about    text        NOT NULL,        -- lowercase handle being reported
  by       text        NOT NULL,        -- lowercase handle doing the reporting
  reason   text,
  msg_id   bigint,                      -- the message complained about, when there is one
  msg_text text,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_at ON reports (at DESC);

-- One pinned message per room. Custom rooms: the owner pins. Global/region/Nearby/org have no
-- owner, so those are pinned over the loopback /admin/pin route instead — same reasoning as
-- room deletion, where the ownerless rooms needed an admin path or they could never be touched.
-- 🔑 The pinned TEXT is snapshotted for the same reason reports snapshot theirs: a pin has to
-- outlive the scrollback prune, or the busiest rooms would silently lose their notice.
CREATE TABLE IF NOT EXISTS pins (
  ch     text PRIMARY KEY,
  msg_id bigint,
  handle text        NOT NULL,          -- who wrote the pinned message
  text   text        NOT NULL,
  by     text        NOT NULL,          -- who pinned it
  at     timestamptz NOT NULL DEFAULT now()
);

-- Names that a custom room may NOT be called: org SIDs and verified handles the server has
-- seen. A room called "irregs" renders in the browse list looking like the IRREGS org channel,
-- so a member can join the fake one and talk freely to whoever is listening. No technical
-- boundary is crossed — org:irregs and custom:irregs are different keys — which is exactly why
-- it needs blocking at the NAME, not at the membership check.
-- Populated as people connect, so it covers the orgs and handles that actually use the app.
CREATE TABLE IF NOT EXISTS known_names (
  name text PRIMARY KEY,        -- lowercased slug form
  kind text NOT NULL,           -- 'org' | 'handle'
  seen timestamptz NOT NULL DEFAULT now()
);
