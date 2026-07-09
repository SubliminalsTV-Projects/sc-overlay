import { createServer, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readFile, readdirSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";

import { resolveLoadout, type Build } from "./erkul.js";
import { LogWatcher } from "./watcher.js";
import { parseLine } from "./parser.js";
import { parseMissionEvent } from "./missions-parser.js";
import { MissionTracker } from "./missions.js";
import { SiteSync } from "./sync.js";
import { assetDir } from "./paths.js";
import { loadCatalog, readScreenshot, type CatalogEntry } from "./screen-read.js";
import { maybeShareLog } from "./log-share.js";

const overlayDir = assetDir(import.meta.url, "overlay");
const bundledDataDir = assetDir(import.meta.url, "data");

// Best-effort app version for the shared-log upload metadata (?v=). Reads package.json
// when present (dev + asar); empty in the bun-compiled sidecar, which is fine.
// Prefer the version the Electron shell injects at spawn (authoritative for the packaged
// app, whose bun sidecar can't read package.json); fall back to package.json in dev.
let APP_VERSION = process.env.APP_VERSION || "";
if (!APP_VERSION) {
  try {
    APP_VERSION = JSON.parse(readFileSync(assetDir(import.meta.url, "package.json"), "utf8")).version ?? "";
  } catch {
    /* version is optional metadata */
  }
}
// Periodically share the current session's scrubbed log (dedup by content hash). The
// last tick before the app closes captures the fullest session; opt-in + no-op when off.
const LOG_SHARE_INTERVAL_MS = 20 * 60 * 1000;
setInterval(() => void maybeShareLog(config, APP_VERSION), LOG_SHARE_INTERVAL_MS);

// "What's new" notes per version (overlay/changelog.json), cached after first read.
let changelogCache: Record<string, string[]> | null = null;
function loadChangelog(): Record<string, string[]> {
  if (changelogCache) return changelogCache;
  let parsed: Record<string, string[]> = {};
  try {
    parsed = JSON.parse(readFileSync(join(overlayDir, "changelog.json"), "utf8"));
  } catch {
    /* no bundled changelog */
  }
  changelogCache = parsed;
  return parsed;
}
const PORT = Number(process.env.PORT) || 8778;

// Persist runtime state in a per-user writable dir — NEVER next to the binary.
// The installed app lives under Program Files (read-only); writing config.json
// there threw EPERM and crashed the whole server. This matches where the mission
// tracker already keeps collected.json.
const userDir = join(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");
const configPath = join(userDir, "config.json");
// Read-only default that ships with the app; only used to seed a first run.
const seedConfigPath = join(overlayDir, "config.json");
// Writable copy of the datasets: bundled pools are seeded in, and any pools the
// tracker fetches for a not-yet-bundled patch cache here (Program Files is read-only).
const dataDir = join(userDir, "data");

interface Config {
  urls: string[];
  activeUrl: string | null;
  logPath: string;
  autoSwitch: boolean;
  /** subliminal.gg device token (minted on /blueprints) for collection sync. */
  syncToken: string;
  /** Whether to push collected blueprints + tracked mission to subliminal.gg. */
  syncEnabled: boolean;
  /** Opt-in: capture item renders from the in-game Fabrication Kiosk and contribute
   *  them to subliminal.gg's blueprint catalog. Read by electron/capture.cjs each poll. */
  fabCapture: boolean;
  /** Opt-in: OCR the in-game screen to read which mission you have PINNED (ground truth the
   *  game.log can't give — it sees every accepted mission equally). Independent of fabCapture;
   *  either one arms the capture loop. Read by electron/capture.cjs each poll. */
  missionOcr: boolean;
  /** GPU hardware acceleration for the Electron overlay. OFF by default — it composites
   *  a transparent window over a Vulkan game and crashes AMD drivers; software rendering
   *  is safe. Read by electron/main.cjs at startup (needs an app restart to change). */
  hwAccel: boolean;
  /** AMD compatibility mode (opt-in, restart-required). Forces the transparent HUD fully off
   *  the Windows GPU-compositing path (DirectComposition/MPO) that crashes AMD Vulkan with a
   *  device-lost, and loads the lite (no-blur/animation) HUD skin. Read by main.cjs at startup. */
  amdCompat: boolean;
  /** Absolute path to a PNG (with transparency) to show as a toggleable full-screen
   *  reference overlay — e.g. your joystick binding chart. Empty = feature off. */
  bindingPng: string;
  /** Global hotkey that shows/hides the binding-chart overlay (Electron accelerator
   *  syntax). Read by main.cjs at startup. */
  bindingHotkey: string;
  /** Global hotkey that shows/hides the whole overlay HUD (Electron accelerator
   *  syntax). Read by main.cjs at startup. */
  overlayHotkey: string;
  /** Recent-activity timestamps: relative ("2h ago") when true, absolute date+clock
   *  when false. Read by the overlay via the mission view's `prefs`. */
  timeRelative: boolean;
  /** Opt-in: after each session, upload this player's Game.log — scrubbed of handle,
   *  account id, geid, IP, and session (chat dropped) — to subliminal.gg so mission and
   *  blueprint parsing can be improved against real logs. Needs a sync token. */
  shareLogs: boolean;
  /** App version whose "what's new" card the user has dismissed. The card shows once per
   *  new version (when this !== the running version) and this is set on dismiss. */
  seenChangelog: string;
  /** Reveal the loadout-overlay settings (Erkul URLs + ship auto-switch) in config.html.
   *  Off by default — those are Sub's erkul stream-overlay feature, meaningless to normal
   *  blueprint-tracker users. Unlocked by a hidden gesture (click the Settings title 5×). */
  showLoadout: boolean;
  /** Overlay HUD declutter toggle (set from the overlay's settings cog): hide the
   *  fabricator category filter bar. Sent to the overlay via the mission view prefs.
   *  (Odds mode + Verify now live inside the cog itself, so the footer has no buttons.) */
  hideCatbar: boolean;
}

const DEFAULTS: Config = {
  urls: ["https://www.erkul.games/loadout/Zjbboonv"],
  activeUrl: "https://www.erkul.games/loadout/Zjbboonv",
  logPath: "C:\\Program Files\\Roberts Space Industries\\StarCitizen\\GAME\\game.log",
  autoSwitch: true,
  syncToken: "",
  syncEnabled: false,
  fabCapture: false,
  missionOcr: false,
  hwAccel: false,
  amdCompat: false,
  bindingPng: "",
  bindingHotkey: "Alt+F3",
  overlayHotkey: "F3",
  timeRelative: true,
  shareLogs: false,
  seenChangelog: "",
  showLoadout: false,
  hideCatbar: false,
};

function loadConfig(): Config {
  // Prefer the user's saved config; fall back to the bundled default on first run.
  for (const p of [configPath, seedConfigPath]) {
    try {
      if (existsSync(p)) return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) };
    } catch {
      /* corrupt — try the next source */
    }
  }
  return { ...DEFAULTS };
}
let config: Config = loadConfig();

/** Scan common Star Citizen install locations for per-channel game.log files, newest
 *  first. SC installs as <root>\StarCitizen\<CHANNEL>\game.log (LIVE, PTU, EPTU,
 *  TECH-PREVIEW, HOTFIX, GAME, …). The channel whose log was written most recently is
 *  the one the player actually plays, so that's the recommended pick. */
function detectGameLogs(): { path: string; channel: string; mtimeMs: number }[] {
  const bases: string[] = [];
  for (const d of ["C", "D", "E", "F", "G", "H"])
    for (const sub of [
      "Program Files\\Roberts Space Industries\\StarCitizen",
      "Roberts Space Industries\\StarCitizen",
      "Games\\Roberts Space Industries\\StarCitizen",
      "Games\\StarCitizen",
      "StarCitizen",
    ])
      bases.push(`${d}:\\${sub}`);
  // Also scan the parent of the currently-configured path (its siblings = channels).
  try { bases.push(dirname(dirname(config.logPath))); } catch { /* ignore */ }

  const found: { path: string; channel: string; mtimeMs: number }[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    let channels: string[];
    try { channels = readdirSync(base); } catch { continue; }
    for (const ch of channels) {
      const p = join(base, ch, "game.log");
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      try {
        const st = statSync(p);
        if (st.isFile()) { found.push({ path: p, channel: ch, mtimeMs: st.mtimeMs }); seen.add(key); }
      } catch { /* no game.log in this channel */ }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Save to the writable user dir; a write failure must never crash the server
// (an EPERM writing under Program Files is exactly what took it down before).
const saveConfig = async (): Promise<void> => {
  try {
    mkdirSync(userDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("[config] save failed:", String(e));
  }
};

// First run / wrong channel: if the configured game.log doesn't exist, auto-detect the
// most recently played channel so the app works without the user hunting for the path.
if (!existsSync(config.logPath)) {
  const found = detectGameLogs();
  if (found.length) {
    config.logPath = found[0].path;
    void saveConfig();
    console.log(`[detect] auto-selected game.log: ${config.logPath} (channel ${found[0].channel})`);
  }
}

// Seed the writable data dir from the bundled pools. Bundled files are refreshed
// each start (an app update ships newer pools); runtime-fetched patch datasets are
// left in place so offline patches keep working.
function seedDataDir(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    for (const f of readdirSync(bundledDataDir)) {
      if (f.endsWith(".json")) copyFileSync(join(bundledDataDir, f), join(dataDir, f));
    }
  } catch (e) {
    console.error("[data] seed failed:", String(e));
  }
}
seedDataDir();

// ── Loadout cache + ship index ──────────────────────────────────────────────
const TTL = 60_000;
const cache = new Map<string, { build: Build; at: number }>();
async function getBuild(url: string): Promise<Build> {
  const c = cache.get(url);
  if (c && Date.now() - c.at < TTL) return c.build;
  const build = await resolveLoadout(url);
  cache.set(url, { build, at: Date.now() });
  return build;
}

// ship localName (lowercase) -> erkul url, so a [VEHICLE SPAWN] can pick a build
const shipIndex = new Map<string, string>();
async function reindex(): Promise<void> {
  shipIndex.clear();
  for (const u of config.urls) {
    try {
      const b = await getBuild(u);
      if (b.ship.localName) shipIndex.set(b.ship.localName.toLowerCase(), u);
    } catch (e) {
      console.error("[reindex] failed for", u, String(e));
    }
  }
}

// ── SSE broadcast of the active build ───────────────────────────────────────
const clients = new Set<ServerResponse>();
let activeBuild: Build | null = null;

function broadcast(): void {
  const data = `data: ${JSON.stringify(activeBuild)}\n\n`;
  for (const res of clients) res.write(data);
}

async function setActive(url: string, reason: string): Promise<boolean> {
  // Resolve FIRST — only commit if it actually loaded, so a bad/unresolvable
  // URL never replaces a good active build with a silent stale fallback.
  try {
    const build = await getBuild(url);
    activeBuild = build;
    config.activeUrl = url;
    void saveConfig();
    console.log(`[active] ${build.ship.name} — ${reason}`);
    broadcast();
    return true;
  } catch (e) {
    console.error(`[active] could not resolve ${url}: ${String(e)}`);
    return false;
  }
}

// ── Mission / blueprint tracker ─────────────────────────────────────────────
// remoteBaseUrl: pull a patch's pool data from subliminal.gg if it isn't bundled
// (offline-first — always falls back to the shipped data/ files).
const tracker = new MissionTracker({ dataDir, remoteBaseUrl: "https://subliminal.gg/sc" });
// Name->UUID catalog for the screen-read OCR endpoint; loaded lazily on first use.
let screenCatalog: CatalogEntry[] | null = null;
const missionClients = new Set<ServerResponse>();
// The overlay view plus user prefs the overlay needs (kept out of the tracker, which
// doesn't know about config). Sent on every mission broadcast so a config change (e.g.
// the time-format toggle) reaches the overlay live via broadcastMissions().
function missionsPayload(): string {
  return JSON.stringify({
    ...tracker.view(),
    appVersion: APP_VERSION,
    live: twitchLive,
    prefs: {
      timeRelative: config.timeRelative,
      hideCatbar: config.hideCatbar,
      missionOcr: config.missionOcr,
      fabCapture: config.fabCapture,
    },
  });
}
function broadcastMissions(): void {
  const data = `data: ${missionsPayload()}\n\n`;
  for (const res of missionClients) res.write(data);
}
tracker.on("change", broadcastMissions);

// Is SubliminalsTV live on Twitch? Polled via sc-feed's public twitch proxy (which holds the
// Twitch credentials) so the distributed app never embeds secrets. Drives the overlay diamond
// going purple + inviting viewers to the stream. Same channel/source as subliminal.gg.
let twitchLive = false;
const TWITCH_POLL_MS = 3 * 60 * 1000;
async function pollTwitchLive(): Promise<void> {
  try {
    const r = await fetch(
      "https://sc-feed.subliminal.gg/api/sc-feed/twitch-proxy?logins=subliminalstv",
      { signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return;
    const j = (await r.json()) as { states?: Record<string, { live?: boolean }> };
    const live = !!j.states?.subliminalstv?.live;
    if (live !== twitchLive) {
      twitchLive = live;
      broadcastMissions();
    }
  } catch {
    /* network hiccup — keep last known state */
  }
}
void pollTwitchLive();
setInterval(() => void pollTwitchLive(), TWITCH_POLL_MS).unref?.();

// ── subliminal.gg collection sync ────────────────────────────────────────────
// Pushes received blueprints (resolved name→UUID) + the tracked mission to the
// player's subliminal.gg account. No-op until a token is configured + enabled.
const sync = new SiteSync(process.env.SC_SYNC_BASE || "https://subliminal.gg");
sync.configure(config.syncToken, config.syncEnabled);
// The snapshot is the full authoritative collection + current mission, computed
// lazily at flush time so frequent state changes just markDirty() cheaply.
sync.setProvider(() => ({
  got: tracker.collectedItemsWithDates(),
  mission: tracker.currentContractKey()
    ? { debugName: tracker.currentContractKey()!, patch: tracker.currentChangelist() ?? "" }
    : null,
}));

// Any tracker state change (receipt, manual toggle, verify, mission switch) → resync.
tracker.on("change", () => sync.markDirty());

/** Force a resync now (token set / startup / verify). */
function syncFull(): void {
  sync.markDirty();
}

/** One-time read of the current log so the overlay knows the tracked mission +
 *  collected state immediately on start (the watcher then tails from the end). */
function seedTrackerFromLog(): void {
  try {
    const text = readFileSync(config.logPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      tracker.detectPatch(line);
      const ev = parseMissionEvent(parseLine(line));
      if (ev) tracker.apply(ev);
    }
  } catch {
    /* log not present yet */
  }
}

// ── Log watcher → auto ship-switch ──────────────────────────────────────────
let watcher: LogWatcher | null = null;
function startWatcher(): void {
  watcher?.stop();
  watcher = new LogWatcher(config.logPath, { pollInterval: 1000 });
  watcher.on("event", (e) => {
    // Feed the mission/blueprint tracker on every line (independent of ship auto-switch).
    tracker.detectPatch(e.raw);
    const me = parseMissionEvent(e);
    if (me) tracker.apply(me);

    if (!config.autoSwitch) return;
    // Only the LOCAL player's ship is logged as "... by player 0".
    const m = e.message.match(/OnVehicleSpawned\s+\d+\s+\(([A-Za-z0-9_]+?)_\d+\)\s+by player 0/);
    if (!m) return;
    const url = shipIndex.get(m[1].toLowerCase());
    if (url && url !== config.activeUrl) void setActive(url, `log: ${m[1]}`);
  });
  watcher.start();
  console.log(`[watcher] watching ${config.logPath} (autoSwitch=${config.autoSwitch})`);
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  // SVG must be served as image/svg+xml or Chromium won't use it as a CSS mask
  // (SVG in image contexts is MIME-strict; raster is content-sniffed regardless).
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function readBody(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(s || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];

  // Live event stream for the overlay.
  if (url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");
    clients.add(res);
    if (activeBuild) res.write(`data: ${JSON.stringify(activeBuild)}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  // Live mission/blueprint state stream.
  if (url === "/missions/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");
    missionClients.add(res);
    res.write(`data: ${missionsPayload()}\n\n`);
    req.on("close", () => missionClients.delete(res));
    return;
  }

  // Current mission/blueprint view (snapshot).
  if (url === "/api/missions" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(missionsPayload());
    return;
  }

  // Re-scan the current log + all rotated logbackups for received-blueprint receipts
  // and fold them into the collected set (recovers history + accidental un-ticks).
  if (url === "/api/missions/verify" && req.method === "POST") {
    const paths: string[] = [];
    if (existsSync(config.logPath)) paths.push(config.logPath);
    try {
      const backups = join(dirname(config.logPath), "logbackups");
      for (const f of readdirSync(backups)) {
        if (f.toLowerCase().endsWith(".log")) paths.push(join(backups, f));
      }
    } catch {
      /* no logbackups dir */
    }
    const result = tracker.verifyFromLogs(paths);
    syncFull(); // push the recovered collection to subliminal.gg if sync is on
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...result }));
    return;
  }

  // Re-sync to the current log: wipe the active-mission set and re-read game.log
  // (drops stale missions from a previous shard the log never logged ending).
  if (url === "/api/missions/refresh" && req.method === "POST") {
    tracker.resetSession();
    seedTrackerFromLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Pin the overlay to a specific accepted mission (picker), or "" / null = auto.
  if (url === "/api/missions/select" && req.method === "POST") {
    const body = await readBody(req);
    tracker.selectMission(typeof body.missionId === "string" && body.missionId ? body.missionId : null);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Manual owned/not-owned override: { name, owned }.
  // The screen OCR read of the mission pinned in-game (from the capture loop) — sets
  // the auto-follow target to ground truth. No-op if the title matches no known mission.
  if (url === "/api/missions/screen" && req.method === "POST") {
    const body = await readBody(req);
    const matched = typeof body.title === "string" ? tracker.setScreenMission(body.title) : false;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, matched }));
    return;
  }

  if (url === "/api/missions/own" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.name === "string" && typeof body.owned === "boolean") {
      tracker.setOwned(body.name, body.owned);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Screen OCR — Electron main captures a full screenshot to a temp file and posts its
  // path here; we OCR it and report whether the fabricator (which item) or a tracked
  // mission is on screen. Main then crops+uploads the item render / follows the mission.
  if (url === "/api/screen-read" && req.method === "POST") {
    const body = await readBody(req);
    let result: unknown = { kind: "none" };
    if (typeof body.path === "string" && body.path) {
      if (!screenCatalog) screenCatalog = loadCatalog(dataDir);
      result = await readScreenshot(body.path, screenCatalog);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // The active, resolved build.
  if (url === "/api/loadout") {
    if (!activeBuild && config.activeUrl) await setActive(config.activeUrl, "on-demand");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(activeBuild));
    return;
  }

  // Config read — includes resolved ship name per url for the config UI.
  if (url === "/api/config" && req.method === "GET") {
    const urls = await Promise.all(
      config.urls.map(async (u) => {
        try {
          const b = await getBuild(u);
          return { url: u, ship: b.ship.name, ok: true };
        } catch {
          return { url: u, ship: "(unreachable)", ok: false };
        }
      }),
    );
    // Never echo the raw token back to the page — only a truncated preview so the settings
    // page can show "the key is in" (scbp_1a2b…wxyz) without exposing the full secret.
    const { syncToken, ...rest } = config;
    const syncTokenPreview = syncToken ? `${syncToken.slice(0, 9)}…${syncToken.slice(-4)}` : "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...rest, hasSyncToken: !!syncToken, syncTokenPreview, resolved: urls }));
    return;
  }

  // "What's new" card: notes for the running version + whether it's already been seen.
  // The version comes from the Electron shell (app.getVersion, authoritative — the
  // bun-compiled sidecar can't read package.json), falling back to APP_VERSION in dev.
  if (url === "/api/changelog" && req.method === "GET") {
    const ver = new URL(req.url ?? "", "http://x").searchParams.get("v")?.trim() || APP_VERSION;
    const notes = ver ? loadChangelog()[ver] ?? [] : [];
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ version: ver, notes, seen: config.seenChangelog === ver }));
    return;
  }
  // Dismiss the "what's new" card — don't show it again until the next version.
  if (url === "/api/changelog-seen" && req.method === "POST") {
    const ver = new URL(req.url ?? "", "http://x").searchParams.get("v")?.trim() || APP_VERSION;
    config.seenChangelog = ver;
    await saveConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Detect installed SC channels' game.log files (for the config "Detect" button).
  if (url === "/api/detect-log" && req.method === "GET") {
    const found = detectGameLogs();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ recommended: found[0]?.path ?? null, candidates: found }));
    return;
  }

  // Serve the user's chosen binding-chart PNG (for binding.html). 404 when unset/missing.
  if ((url === "/api/binding-image" || url?.startsWith("/api/binding-image?")) && req.method === "GET") {
    try {
      if (config.bindingPng && existsSync(config.bindingPng)) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        res.end(readFileSync(config.bindingPng));
        return;
      }
    } catch {
      /* fall through to 404 */
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no_binding_image" }));
    return;
  }

  // Config write.
  if (url === "/api/config" && req.method === "POST") {
    const body = await readBody(req);
    if (Array.isArray(body.urls)) config.urls = body.urls.filter((u: unknown) => typeof u === "string" && u);
    if (typeof body.logPath === "string") config.logPath = body.logPath;
    if (typeof body.autoSwitch === "boolean") config.autoSwitch = body.autoSwitch;
    // Apply the checkbox first, then let a freshly-pasted token force sync ON — pasting a
    // token IS the intent to sync, so it can't be left silently disabled. The token is only
    // overwritten when a non-empty one is sent (the page leaves the field blank/masked to keep
    // the saved token); an explicit "" via clearToken wipes it.
    if (typeof body.syncEnabled === "boolean") config.syncEnabled = body.syncEnabled;
    if (typeof body.syncToken === "string" && body.syncToken.trim()) {
      config.syncToken = body.syncToken.trim();
      config.syncEnabled = true;
    }
    if (body.clearToken === true) config.syncToken = "";
    if (typeof body.fabCapture === "boolean") config.fabCapture = body.fabCapture;
    if (typeof body.missionOcr === "boolean") config.missionOcr = body.missionOcr;
    // GPU accel is read by electron/main.cjs at startup; persist here, restart applies it.
    if (typeof body.hwAccel === "boolean") config.hwAccel = body.hwAccel;
    if (typeof body.amdCompat === "boolean") config.amdCompat = body.amdCompat;
    if (typeof body.bindingPng === "string") config.bindingPng = body.bindingPng;
    if (typeof body.bindingHotkey === "string" && body.bindingHotkey.trim()) config.bindingHotkey = body.bindingHotkey.trim();
    if (typeof body.overlayHotkey === "string" && body.overlayHotkey.trim()) config.overlayHotkey = body.overlayHotkey.trim();
    if (typeof body.timeRelative === "boolean") config.timeRelative = body.timeRelative;
    if (typeof body.shareLogs === "boolean") config.shareLogs = body.shareLogs;
    if (typeof body.showLoadout === "boolean") config.showLoadout = body.showLoadout;
    if (typeof body.hideCatbar === "boolean") config.hideCatbar = body.hideCatbar;
    await saveConfig();
    // Push the new prefs to every open overlay (incl. OBS browser-source) live.
    broadcastMissions();
    await reindex();
    startWatcher();
    // Re-arm sync with the new settings and reconcile the full collection.
    if (sync.configure(config.syncToken, config.syncEnabled)) syncFull();
    // If log-sharing was just turned on, upload the current session now.
    void maybeShareLog(config, APP_VERSION);
    // Push prefs (e.g. the time-format toggle) to any open overlay immediately.
    broadcastMissions();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Manual switch.
  if (url === "/api/active" && req.method === "POST") {
    const body = await readBody(req);
    const ok = typeof body.url === "string" ? await setActive(body.url, "manual") : false;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok, active: config.activeUrl }));
    return;
  }

  // Static files.
  let p = url === "/" ? "/index.html" : url;
  readFile(join(overlayDir, decodeURIComponent(p)), (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
    } else {
      // no-store so the Electron/OBS view always gets the latest overlay HTML/CSS/JS
      // (stale caching made UI changes appear not to take effect).
      res.writeHead(200, {
        "Content-Type": MIME[extname(p)] ?? "application/octet-stream",
        "Cache-Control": "no-store, must-revalidate",
      });
      res.end(buf);
    }
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    // Another instance already owns the port — fine. A standalone launcher will just
    // open its window against the running server instead of crashing with a stack trace.
    console.log(`[server] port ${PORT} already in use — using the running instance.`);
    return;
  }
  throw err;
});

server.listen(PORT, async () => {
  console.log(`loadout overlay →  http://localhost:${PORT}/`);
  console.log(`blueprints      →  http://localhost:${PORT}/missions.html`);
  console.log(`config page     →  http://localhost:${PORT}/config.html`);
  tracker.loadDataset();
  seedTrackerFromLog();
  // Push the existing collection + tracked mission once the log has been seeded.
  syncFull();
  await reindex();
  if (config.activeUrl) await setActive(config.activeUrl, "startup");
  startWatcher();
});
