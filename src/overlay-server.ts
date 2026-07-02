import { createServer, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readFile, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";

import { resolveLoadout, type Build } from "./erkul.js";
import { LogWatcher } from "./watcher.js";
import { parseLine } from "./parser.js";
import { parseMissionEvent } from "./missions-parser.js";
import { MissionTracker } from "./missions.js";
import { SiteSync } from "./sync.js";
import { assetDir } from "./paths.js";

const overlayDir = assetDir(import.meta.url, "overlay");
const bundledDataDir = assetDir(import.meta.url, "data");
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
}

const DEFAULTS: Config = {
  urls: ["https://www.erkul.games/loadout/Zjbboonv"],
  activeUrl: "https://www.erkul.games/loadout/Zjbboonv",
  logPath: "C:\\Program Files\\Roberts Space Industries\\StarCitizen\\GAME\\game.log",
  autoSwitch: true,
  syncToken: "",
  syncEnabled: false,
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
const missionClients = new Set<ServerResponse>();
function broadcastMissions(): void {
  const data = `data: ${JSON.stringify(tracker.view())}\n\n`;
  for (const res of missionClients) res.write(data);
}
tracker.on("change", broadcastMissions);

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
    res.write(`data: ${JSON.stringify(tracker.view())}\n\n`);
    req.on("close", () => missionClients.delete(res));
    return;
  }

  // Current mission/blueprint view (snapshot).
  if (url === "/api/missions" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(tracker.view()));
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
  if (url === "/api/missions/own" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.name === "string" && typeof body.owned === "boolean") {
      tracker.setOwned(body.name, body.owned);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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
    // Never echo the raw token back to the page — only whether one is set.
    const { syncToken, ...rest } = config;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...rest, hasSyncToken: !!syncToken, resolved: urls }));
    return;
  }

  // Config write.
  if (url === "/api/config" && req.method === "POST") {
    const body = await readBody(req);
    if (Array.isArray(body.urls)) config.urls = body.urls.filter((u: unknown) => typeof u === "string" && u);
    if (typeof body.logPath === "string") config.logPath = body.logPath;
    if (typeof body.autoSwitch === "boolean") config.autoSwitch = body.autoSwitch;
    // Only overwrite the token when a non-empty one is sent (the page leaves the
    // field blank to keep the saved token); an explicit "" via clearToken wipes it.
    if (typeof body.syncToken === "string" && body.syncToken.trim()) config.syncToken = body.syncToken.trim();
    if (body.clearToken === true) config.syncToken = "";
    if (typeof body.syncEnabled === "boolean") config.syncEnabled = body.syncEnabled;
    await saveConfig();
    await reindex();
    startWatcher();
    // Re-arm sync with the new settings and reconcile the full collection.
    if (sync.configure(config.syncToken, config.syncEnabled)) syncFull();
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
