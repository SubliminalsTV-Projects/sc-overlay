import { createServer, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readFile } from "node:fs";
import { extname, join } from "node:path";

import { resolveLoadout, type Build } from "./erkul.js";
import { LogWatcher } from "./watcher.js";
import { parseLine } from "./parser.js";
import { parseMissionEvent } from "./missions-parser.js";
import { MissionTracker } from "./missions.js";
import { assetDir } from "./paths.js";

const overlayDir = assetDir(import.meta.url, "overlay");
const dataDir = assetDir(import.meta.url, "data");
const configPath = join(overlayDir, "config.json");
const PORT = 8778;

interface Config {
  urls: string[];
  activeUrl: string | null;
  logPath: string;
  autoSwitch: boolean;
}

const DEFAULTS: Config = {
  urls: ["https://www.erkul.games/loadout/Zjbboonv"],
  activeUrl: "https://www.erkul.games/loadout/Zjbboonv",
  logPath: "C:\\Program Files\\Roberts Space Industries\\StarCitizen\\GAME\\game.log",
  autoSwitch: true,
};

let config: Config = existsSync(configPath)
  ? { ...DEFAULTS, ...JSON.parse(readFileSync(configPath, "utf8")) }
  : { ...DEFAULTS };
const saveConfig = () => writeFile(configPath, JSON.stringify(config, null, 2));

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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...config, resolved: urls }));
    return;
  }

  // Config write.
  if (url === "/api/config" && req.method === "POST") {
    const body = await readBody(req);
    if (Array.isArray(body.urls)) config.urls = body.urls.filter((u: unknown) => typeof u === "string" && u);
    if (typeof body.logPath === "string") config.logPath = body.logPath;
    if (typeof body.autoSwitch === "boolean") config.autoSwitch = body.autoSwitch;
    await saveConfig();
    await reindex();
    startWatcher();
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
      res.writeHead(200, { "Content-Type": MIME[extname(p)] ?? "application/octet-stream" });
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
  await reindex();
  if (config.activeUrl) await setActive(config.activeUrl, "startup");
  startWatcher();
});
