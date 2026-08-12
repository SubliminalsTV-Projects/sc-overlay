// SC Overlay chat — persistence.
//
// Two backends behind one API:
//   DATABASE_URL set    → Postgres (the `chat` schema on the stack's Timescale instance)
//   DATABASE_URL absent → JSON files under CHAT_DATA_DIR, scrollback in memory only
//
// 🔑 The file backend is not a legacy path to delete — it is what keeps `npm run test:chat`
// hermetic and local dev zero-setup. Every function here must work in both, so the server can
// never grow a code path that only runs in production.
//
// 🔑 Nothing here is on the hot path. A message is appended to the room's in-memory ring and
// broadcast SYNCHRONOUSLY; persistence is fire-and-forget behind it. A database hiccup must
// slow chat down or drop a live message — it may only cost scrollback.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function createStore({ dataDir, databaseUrl, schema, log = console }) {
  const dir = dataDir || join(HERE, "data");
  return databaseUrl
    ? pgStore(databaseUrl, dir, schema || process.env.CHAT_DB_SCHEMA || "chat", log)
    : fileStore(dir, log);
}

/** Postgres identifier. Only ever a schema name from our own env, but a name that reaches a
 *  connection string unchecked is the kind of thing that stops being true later. */
const safeSchema = (s) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error(`bad schema name: ${s}`);
  return s;
};

// ── shared helpers ──────────────────────────────────────────────────────────
/** DM channel key. The PAIR is the identity, so the handles are always ordered — otherwise
 *  (a,b) and (b,a) become two different conversations holding half the messages each. */
export function dmKey(h1, h2) {
  const [a, b] = [String(h1).toLowerCase(), String(h2).toLowerCase()].sort();
  return { ch: `dm:${a}|${b}`, a, b };
}
export function dmPair(ch) {
  const m = /^dm:([^|]+)\|(.+)$/.exec(ch);
  return m ? { a: m[1], b: m[2] } : null;
}

const roomRow = (slug, m) => ({
  slug,
  label: m.label,
  category: m.category ?? "social",
  privacy: m.privacy ?? "public",
  code: m.code ?? null,
  owner: m.owner ?? null,
  created: m.created ?? Date.now(),
  lastActive: m.lastActive ?? Date.now(),
  invites: m.invites ?? [],
  // Party-listing fields. Defaulted here so a room created before Tier 2 reads as a plain
  // chat room rather than as a listing with empty everything.
  isParty: m.isParty ?? false,
  location: m.location ?? null,
  sizeMax: m.sizeMax ?? null,
  joinMode: m.joinMode ?? "open",
  voice: m.voice ?? "none",
  expiresAt: m.expiresAt ?? null,
  applications: m.applications ?? [],
});

// ── file backend ────────────────────────────────────────────────────────────
function fileStore(dir, log) {
  const bansPath = join(dir, "bans.json");
  const channelsPath = join(dir, "channels.json");
  const readJson = (p, fallback) => {
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
  };
  const writeJson = (p, v) => {
    try { mkdirSync(dir, { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); }
    catch (e) { log.error?.("[store] write failed", p, e?.message); }
  };
  const pinsPath = join(dir, "pins.json");
  const reportsPath = join(dir, "reports.json");
  const prefsPath = join(dir, "user-prefs.json");
  let rooms = new Map();
  let bans = new Set();
  let pins = new Map();

  return {
    mode: "file",
    async init() {
      bans = new Set(Object.values(readJson(bansPath, [])).map((h) => String(h).toLowerCase()));
      rooms = new Map(Object.entries(readJson(channelsPath, {})).map(([slug, m]) => [slug, roomRow(slug, m)]));
      pins = new Map(Object.entries(readJson(pinsPath, {})));
      const prefs = new Map(Object.entries(readJson(prefsPath, {})));
      return { rooms, bans, pins, prefs, reserved: new Set(), maxMessageId: 0 };
    },
    // Scrollback is memory-only here: a test that wants durable history wants the pg backend.
    async loadHistory() { return []; },
    saveMessage() {},
    async pruneMessages() {},

    saveRoom(r) { rooms.set(r.slug, roomRow(r.slug, r)); writeJson(channelsPath, Object.fromEntries(rooms)); },
    deleteRoom(slug) { rooms.delete(slug); writeJson(channelsPath, Object.fromEntries(rooms)); },
    touchRoom(slug, at) { const r = rooms.get(slug); if (r) { r.lastActive = at; writeJson(channelsPath, Object.fromEntries(rooms)); } },
    addInvite(slug, handle) {
      const r = rooms.get(slug);
      if (!r) return;
      if (!r.invites.includes(handle)) r.invites.push(handle);
      writeJson(channelsPath, Object.fromEntries(rooms));
    },
    saveBan(h) { bans.add(h); writeJson(bansPath, [...bans]); },
    deleteBan(h) { bans.delete(h); writeJson(bansPath, [...bans]); },

    saveUserColor(handle, color) {
      const all = readJson(prefsPath, {});
      if (color === null) delete all[handle]; else all[handle] = color;
      writeJson(prefsPath, all);
    },

    // 🔑 Re-applying REPLACES your row rather than queueing a second one, so an eager applicant
    // cannot bury the owner in duplicates of the same request.
    addApplication(slug, handle, note) {
      const r = rooms.get(slug);
      if (!r) return;
      r.applications = (r.applications ?? []).filter((a) => a.handle !== handle);
      r.applications.push({ handle, note: note ?? null, at: Date.now() });
      writeJson(channelsPath, Object.fromEntries(rooms));
    },
    deleteApplication(slug, handle) {
      const r = rooms.get(slug);
      if (!r) return;
      r.applications = (r.applications ?? []).filter((a) => a.handle !== handle);
      writeJson(channelsPath, Object.fromEntries(rooms));
    },

    savePin(p) { pins.set(p.ch, p); writeJson(pinsPath, Object.fromEntries(pins)); },
    deletePin(ch) { pins.delete(ch); writeJson(pinsPath, Object.fromEntries(pins)); },
    // Reports are APPENDED, never replaced — two people reporting the same message is two
    // reports, and the second one is the signal.
    saveReport(r) {
      const all = readJson(reportsPath, []);
      all.push(r);
      writeJson(reportsPath, all);
    },
    async listReports(limit = 200) { return readJson(reportsPath, []).slice(-limit).reverse(); },

    touchDm() {},
    async dmThreads() { return []; },
    rememberName() {},
    async close() {},
  };
}

// ── postgres backend ────────────────────────────────────────────────────────
function pgStore(url, dir, schema, log) {
  const ns = safeSchema(schema);
  let pool = null;
  // Fire-and-forget writes still have to be OBSERVABLE, or a silently failing insert reads as
  // "chat lost my scrollback again" with nothing anywhere saying why.
  const bg = (label, p) => { p.catch((e) => log.error?.(`[store] ${label} failed:`, e?.message)); };

  return {
    mode: "postgres",
    async init() {
      const { default: pg } = await import("pg");
      // search_path on the POOL, so every connection it hands out is already pointed at our
      // schema — schema.sql and every query below are unqualified.
      pool = new pg.Pool({
        connectionString: url, max: 4, idleTimeoutMillis: 30_000,
        options: `-c search_path=${ns}`,
      });
      await pool.query(readFileSync(join(HERE, "schema.sql"), "utf8"));

      // One-time import of the JSON files this backend replaces. Guarded on the table being
      // EMPTY, not on the files being absent — the Coolify volume keeps them forever, and
      // re-importing on every boot would resurrect rooms that were deliberately deleted.
      const { rows: [{ n }] } = await pool.query("SELECT count(*)::int n FROM rooms");
      if (n === 0) await importJson(pool, dir, log);

      const rooms = new Map();
      const { rows } = await pool.query(`
        SELECT r.*, coalesce(array_agg(i.handle) FILTER (WHERE i.handle IS NOT NULL), '{}') invites
        FROM rooms r LEFT JOIN room_invites i USING (slug) GROUP BY r.slug`);
      for (const r of rows) {
        rooms.set(r.slug, {
          slug: r.slug, label: r.label, category: r.category, privacy: r.privacy,
          code: r.code, owner: r.owner,
          created: +r.created, lastActive: +r.last_active, invites: r.invites,
          isParty: !!r.is_party, location: r.location, sizeMax: r.size_max,
          joinMode: r.join_mode ?? "open", voice: r.voice ?? "none",
          expiresAt: r.expires_at === null ? null : +r.expires_at,
          applications: [],
        });
      }
      const appsQ = await pool.query("SELECT slug, handle, note, at FROM room_applications ORDER BY at");
      for (const a of appsQ.rows) {
        rooms.get(a.slug)?.applications.push({ handle: a.handle, note: a.note, at: +a.at });
      }
      const namesQ = await pool.query("SELECT name FROM known_names");
      const bansQ = await pool.query("SELECT handle FROM bans");
      const prefsQ = await pool.query("SELECT handle, color FROM user_prefs WHERE color IS NOT NULL");
      const maxQ = await pool.query("SELECT coalesce(max(id), 0)::bigint m FROM messages");
      const pinsQ = await pool.query("SELECT ch, msg_id, handle, text, by, at FROM pins");
      return {
        rooms,
        reserved: new Set(namesQ.rows.map((r) => r.name)),
        bans: new Set(bansQ.rows.map((b) => b.handle)),
        prefs: new Map(prefsQ.rows.map((p) => [p.handle, p.color])),
        pins: new Map(pinsQ.rows.map((p) => [p.ch, {
          ch: p.ch, id: p.msg_id === null ? null : Number(p.msg_id),
          handle: p.handle, text: p.text, by: p.by, at: +p.at,
        }])),
        // 🔑 Seed the id counter from the DB. It restarts at 1 otherwise, and a fresh message
        // then collides with a loaded one — clients key off the id, so that shows up as a
        // message that will not render or one that replaces another.
        maxMessageId: Number(maxQ.rows[0].m),
      };
    },

    async loadHistory(ch, limit) {
      const { rows } = await pool.query(
        "SELECT id, handle, verified, text, at FROM messages WHERE ch = $1 ORDER BY id DESC LIMIT $2",
        [ch, limit],
      );
      return rows.reverse().map((r) => ({
        ch, id: Number(r.id), from: { handle: r.handle, verified: r.verified },
        text: r.text, at: new Date(r.at).toISOString(),
      }));
    },
    saveMessage(m) {
      bg("insert message", pool.query(
        "INSERT INTO messages (id, ch, handle, verified, text, at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [m.id, m.ch, m.from.handle, m.from.verified, m.text, m.at],
      ));
    },
    // Keep the newest `keep` per channel — the same bound the in-memory ring enforces, so the
    // two can't drift into "scrollback is longer after a restart than before it".
    async pruneMessages(keep) {
      const { rowCount } = await pool.query(`
        DELETE FROM messages m USING (
          SELECT id, row_number() OVER (PARTITION BY ch ORDER BY id DESC) rn FROM messages
        ) s WHERE m.id = s.id AND s.rn > $1`, [keep]);
      return rowCount;
    },

    saveRoom(r) {
      bg("upsert room", pool.query(`
        INSERT INTO rooms (slug, label, category, privacy, code, owner, created, last_active,
                           is_party, location, size_max, join_mode, voice, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0), to_timestamp($8/1000.0),
                $9,$10,$11,$12,$13, CASE WHEN $14::bigint IS NULL THEN NULL ELSE to_timestamp($14/1000.0) END)
        ON CONFLICT (slug) DO UPDATE SET
          label = excluded.label, category = excluded.category,
          privacy = excluded.privacy, code = excluded.code, last_active = excluded.last_active,
          is_party = excluded.is_party, location = excluded.location, size_max = excluded.size_max,
          join_mode = excluded.join_mode, voice = excluded.voice, expires_at = excluded.expires_at`,
        [r.slug, r.label, r.category ?? "social", r.privacy ?? "public", r.code ?? null,
         r.owner ?? null, r.created ?? Date.now(), r.lastActive ?? Date.now(),
         r.isParty ?? false, r.location ?? null, r.sizeMax ?? null,
         r.joinMode ?? "open", r.voice ?? "none", r.expiresAt ?? null]));
    },
    deleteRoom(slug) {
      bg("delete room", pool.query("DELETE FROM rooms WHERE slug = $1", [slug]));
      bg("delete room messages", pool.query("DELETE FROM messages WHERE ch = $1", [`custom:${slug}`]));
    },
    touchRoom(slug, at) {
      bg("touch room", pool.query("UPDATE rooms SET last_active = to_timestamp($2/1000.0) WHERE slug = $1", [slug, at]));
    },
    addInvite(slug, handle, by) {
      bg("add invite", pool.query(
        "INSERT INTO room_invites (slug, handle, invited_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [slug, handle, by ?? ""]));
    },
    saveBan(h) { bg("ban", pool.query("INSERT INTO bans (handle) VALUES ($1) ON CONFLICT DO NOTHING", [h])); },
    deleteBan(h) { bg("unban", pool.query("DELETE FROM bans WHERE handle = $1", [h])); },

    saveUserColor(handle, color) {
      bg("user color", pool.query(
        `INSERT INTO user_prefs (handle, color) VALUES ($1, $2)
         ON CONFLICT (handle) DO UPDATE SET color = excluded.color, updated = now()`,
        [handle, color]));
    },

    addApplication(slug, handle, note) {
      bg("apply", pool.query(
        `INSERT INTO room_applications (slug, handle, note) VALUES ($1,$2,$3)
         ON CONFLICT (slug, handle) DO UPDATE SET note = excluded.note, at = now()`,
        [slug, handle, note ?? null]));
    },
    deleteApplication(slug, handle) {
      bg("unapply", pool.query("DELETE FROM room_applications WHERE slug = $1 AND handle = $2", [slug, handle]));
    },

    savePin(p) {
      bg("pin", pool.query(`
        INSERT INTO pins (ch, msg_id, handle, text, by, at)
        VALUES ($1, $2, $3, $4, $5, to_timestamp($6/1000.0))
        ON CONFLICT (ch) DO UPDATE SET
          msg_id = excluded.msg_id, handle = excluded.handle,
          text = excluded.text, by = excluded.by, at = excluded.at`,
        [p.ch, p.id, p.handle, p.text, p.by, p.at]));
    },
    deletePin(ch) { bg("unpin", pool.query("DELETE FROM pins WHERE ch = $1", [ch])); },
    saveReport(r) {
      bg("report", pool.query(
        "INSERT INTO reports (ch, about, by, reason, msg_id, msg_text) VALUES ($1, $2, $3, $4, $5, $6)",
        [r.ch, r.about, r.by, r.reason, r.id, r.text]));
    },
    async listReports(limit = 200) {
      const { rows } = await pool.query(
        "SELECT ch, about, by, reason, msg_id, msg_text, at FROM reports ORDER BY at DESC LIMIT $1", [limit]);
      return rows.map((r) => ({
        ch: r.ch, about: r.about, by: r.by, reason: r.reason,
        id: r.msg_id === null ? null : Number(r.msg_id), text: r.msg_text, at: +r.at,
      }));
    },

    touchDm(a, b, at) {
      bg("touch dm", pool.query(`
        INSERT INTO dm_threads (a, b, last_at) VALUES ($1,$2, to_timestamp($3/1000.0))
        ON CONFLICT (a, b) DO UPDATE SET last_at = excluded.last_at`, [a, b, at]));
    },
    /** Every conversation this handle is part of, newest first — the DM list. */
    async dmThreads(handle, limit = 50) {
      const { rows } = await pool.query(`
        SELECT CASE WHEN a = $1 THEN b ELSE a END AS other, last_at
        FROM dm_threads WHERE a = $1 OR b = $1 ORDER BY last_at DESC LIMIT $2`, [handle, limit]);
      return rows.map((r) => ({ other: r.other, lastAt: new Date(r.last_at).toISOString() }));
    },
    /** Record an org SID or verified handle so a custom room can never be named after it. */
    rememberName(name, kind) {
      bg("remember name", pool.query(
        "INSERT INTO known_names (name, kind) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING",
        [name, kind]));
    },
    async close() { await pool?.end(); },
  };
}

/** Carry data/{channels,bans}.json into the tables that replace them. Runs once, on the first
 *  boot against an empty `chat.rooms`. */
async function importJson(pool, dir, log) {
  let rooms = {}, bans = [];
  try { rooms = JSON.parse(readFileSync(join(dir, "channels.json"), "utf8")); } catch { /* none */ }
  try { bans = JSON.parse(readFileSync(join(dir, "bans.json"), "utf8")); } catch { /* none */ }
  for (const [slug, m] of Object.entries(rooms)) {
    // Rooms that predate categories keep working — they are simply Uncategorised until someone
    // says otherwise, which is the honest answer for a room created before the field existed.
    await pool.query(`
      INSERT INTO rooms (slug, label, category, privacy, created, last_active)
      VALUES ($1,$2,'social','public', to_timestamp($3/1000.0), to_timestamp($4/1000.0))
      ON CONFLICT DO NOTHING`,
      [slug, m.label ?? slug, m.created ?? Date.now(), m.lastActive ?? Date.now()]);
  }
  for (const h of bans) {
    await pool.query("INSERT INTO bans (handle) VALUES ($1) ON CONFLICT DO NOTHING", [String(h).toLowerCase()]);
  }
  const n = Object.keys(rooms).length;
  if (n || bans.length) log.log?.(`[store] imported ${n} room(s) and ${bans.length} ban(s) from JSON`);
}
