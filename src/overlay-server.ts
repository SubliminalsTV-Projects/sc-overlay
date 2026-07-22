import { createServer, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readFile, readdirSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";

import { resolveLoadout, type Build } from "./erkul.js";
import { LogWatcher } from "./watcher.js";
import { parseLine } from "./parser.js";
import { parseMissionEvent } from "./missions-parser.js";
import { MissionTracker } from "./missions.js";
import { MiningTracker } from "./mining.js";
import { MiningEconomyStore } from "./mining-economy.js";
import { SiteSync } from "./sync.js";
import { assetDir } from "./paths.js";
import { loadCatalog, readScreenshot, classifyScreen, type CatalogEntry, type OcrResult } from "./screen-read.js";
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
  /** Mining Assistant: arms the capture loop to read the Refinement Center (job timers)
   *  and the mining scanner signature. Opt-in; read by electron/capture.cjs each poll. */
  miningAssistant: boolean;
  /** Auto-show the Mining Assistant window when the scanner/refinery screen is detected. */
  miningAutoShow: boolean;
  /** Remembers whether the Mining Assistant window was left open, so it's restored on launch. */
  miningOpen: boolean;
  /** Path to a user-chosen WAV to use as the alert tone (empty = built-in synth tone). */
  miningTone: string;
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
  /** Global hotkey that shows/hides the Mining Assistant window (Electron accelerator
   *  syntax). Read by main.cjs at startup. */
  miningHotkey: string;
  /** Hold-to-interact hotkey (Electron accelerator, default "F"): when hold-to-interact mode is
   *  on, the overlay is passive (click-through) unless this key is HELD. */
  interactHotkey: string;
  /** Opt-in: require holding the interact key to click the overlay. Off by default (the overlay
   *  is clickable whenever the cursor is over a widget). */
  holdToInteract: boolean;
  /** Global hotkey that toggles arrange/move mode (Electron accelerator syntax). */
  moveHotkey: string;
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
  /** Overlay manufacturer theme: "mobiglas" (default), "drake", or "auto" (match the ship
   *  you're flying, detected from the log). Sent to the overlay via the mission view prefs. */
  theme: "mobiglas" | "drake" | "anvil" | "greys" | "esperia" | "misc" | "banu" | "gatac" | "mirai" | "origin" | "aegis" | "crusader" | "rsi" | "kruger" | "argo" | "cnou" | "auto";
  /** Local subscriber-entitlement override for manufacturer skins. Default false = locked
   *  (preview-only). Superseded by the server-resolved Twitch-sub check when that lands. */
  premiumOverride?: boolean;
  /** Y-axis (left↔right yaw) rotation of the overlay panel, in degrees, to line it up with a
   *  perspective-angled in-game HUD. 0 = flat, 4 = the default subtle tilt. Sent via prefs. */
  overlayTwist: number;
  /** Global overlay UI scale, in percent (100 = design size). Lets 4K users size it up and
   *  small screens size it down. Applied as CSS zoom; the window resizes to match. */
  overlayScale: number;
  /** When you get out of your ship (leave its comms channel), revert the theme to Mobiglas
   *  instead of keeping the ship's manufacturer skin. Affects theme="auto" AND the /api/ship
   *  signal. Default false = stay on the last ship's manufacturer until you board another. */
  revertThemeOnFoot: boolean;
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
  miningAssistant: false,
  miningAutoShow: false,
  miningOpen: false,
  miningTone: "",
  hwAccel: false,
  amdCompat: false,
  bindingPng: "",
  bindingHotkey: "Ctrl+F3",
  overlayHotkey: "F3",
  miningHotkey: "Shift+F3",
  interactHotkey: "F",
  holdToInteract: false,
  moveHotkey: "Ctrl+Alt+M",
  timeRelative: true,
  shareLogs: false,
  seenChangelog: "",
  showLoadout: false,
  hideCatbar: false,
  theme: "mobiglas",
  overlayTwist: 0, // flat by default; the user can dial in a skew angle in the hub
  overlayScale: 100,
  revertThemeOnFoot: false,
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
// ── Overlay theme (manufacturer) ─────────────────────────────────────────────
// The ship manufacturer we last detected in the log (for theme: "auto"). Drake and Anvil have
// bespoke themes so far; every other manufacturer (and "unknown") falls back to Mobiglas.
let shipManufacturer: string | null = null;
let shipName: string | null = null; // ship display name from the comms-join, e.g. "Grey's Basher"
const MFR_THEME: Record<string, "drake" | "anvil" | "greys" | "esperia" | "misc" | "banu" | "gatac" | "mirai" | "origin" | "aegis" | "crusader" | "rsi" | "kruger" | "argo" | "cnou"> = { drake: "drake", anvil: "anvil", greys: "greys", esperia: "esperia", misc: "misc", banu: "banu", gatac: "gatac", mirai: "mirai", origin: "origin", aegis: "aegis", crusader: "crusader", rsi: "rsi", kruger: "kruger", argo: "argo", "consolidated outland": "cnou" };
// Manufacturer codes (the vehicle-entity prefix) → a manufacturer key; display-name leads use
// the same keys. Extend both this and MFR_THEME as more manufacturer themes are added.
const MFR_BY_CODE: Record<string, string> = {
  DRAK: "drake", ORIG: "origin", AEGS: "aegis", ANVL: "anvil", RSI: "rsi", MISC: "misc",
  CRUS: "crusader", ARGO: "argo", BANU: "banu", AOPO: "aopoa", CNOU: "consolidated outland",
  GAMA: "gatac", GRIN: "greycat", ESPR: "esperia", TMBL: "tumbril", KRIG: "kruger",
  MRAI: "mirai", XIAN: "xian", VNCL: "vanduul", GLSN: "greys",
};
// Channel-name lead prefixes that abbreviate the manufacturer (so the full manufacturer key
// from MFR_BY_CODE isn't a startsWith match). Dots survive the apostrophe-strip in the match.
const MFR_LEAD_ALIAS: Record<string, string> = { "c.o.": "consolidated outland" };
/** Resolve a ship's DISPLAY NAME (the comms-channel lead) to a manufacturer key, or null.
 *  Ship names may contain an apostrophe ("Grey's Shiv"), so strip apostrophes before matching;
 *  most names lead with the brand ("MISC Prospector"), some abbreviate ("C.O. Nomad"). */
function manufacturerFromShipName(shipDisplayName: string): string | null {
  const lead = shipDisplayName.trim().toLowerCase().replace(/['’`]/g, "");
  for (const name of Object.values(MFR_BY_CODE)) if (lead.startsWith(name)) return name;
  // Some ships abbreviate the manufacturer in the channel name, so the full manufacturer
  // key isn't a prefix (Consolidated Outland → "C.O. Nomad"). Map those lead-prefixes.
  for (const [alias, name] of Object.entries(MFR_LEAD_ALIAS)) if (lead.startsWith(alias)) return name;
  return null;
}
/** The manufacturer of the local player's ship from a log line, or null.
 *  AC: the OnVehicleSpawned entity name carries a MANU_ prefix. PU: the comms channel is
 *  named "<Ship Display Name> : <Player>", so the display name leads with the manufacturer. */
function manufacturerFromLine(line: string): string | null {
  const spawn = line.match(/OnVehicleSpawned\s+\d+\s+\(([A-Za-z0-9_]+?)_\d+\)\s+by player 0/);
  if (spawn) { const code = spawn[1].split("_")[0].toUpperCase(); if (MFR_BY_CODE[code]) return MFR_BY_CODE[code]; }
  const join = line.match(/joined channel '([^:]+?)\s*:\s*[^']+'/);
  if (join) return manufacturerFromShipName(join[1]);
  return null;
}
/** PU comms-channel enter/exit for the local player's ship — "You have joined/left the channel
 *  '<Ship> : <Player>'". Gives both a ship NAME and an exit signal (AC spawn has neither). */
function shipChannelEvent(line: string): { action: "enter" | "leave"; ship: string; manufacturer: string | null } | null {
  const m = line.match(/You have (joined|left the) channel '([^:]+?)\s*:\s*[^']+'/);
  if (!m) return null;
  const ship = m[2].trim();
  return { action: m[1] === "joined" ? "enter" : "leave", ship, manufacturer: manufacturerFromShipName(ship) };
}
type ManufacturerTheme = "mobiglas" | "drake" | "anvil" | "greys" | "esperia" | "misc" | "banu" | "gatac" | "mirai" | "origin" | "aegis" | "crusader" | "rsi" | "kruger" | "argo" | "cnou";
// Manufacturer skins are a subscriber perk. Entitlement is server-resolved; until the
// Twitch-sub pipeline lands it's a local override (default false = locked for everyone).
// A real active-Twitch-subscriber (server-resolved via /api/sc/entitlement, below) OR a local
// override (dev / preview). The Twitch result is the real driver of skins staying pinned.
function entitled(): boolean { return twitchEntitled || config.premiumOverride === true; }
// Non-subscribers may PREVIEW a skin: it applies briefly then reverts to Mobiglas, with a
// trial watermark on the overlay — so nobody gets used to keeping a skin they haven't unlocked.
let demoTheme: ManufacturerTheme | null = null;
let demoTimer: ReturnType<typeof setTimeout> | undefined;
const DEMO_MS = 20000;
function startDemo(theme: ManufacturerTheme): void {
  demoTheme = theme;
  clearTimeout(demoTimer);
  demoTimer = setTimeout(() => { demoTheme = null; broadcastMissions(); miningSend(miningAppearance()); }, DEMO_MS);
  broadcastMissions();
  miningSend(miningAppearance());
}
/** The theme to actually apply. FREE: "auto" (match the ship you're flying) + "mobiglas".
 *  SUBSCRIBER: pinning a specific manufacturer regardless of ship. A live trial demo wins. */
function effectiveTheme(): ManufacturerTheme {
  if (demoTheme) return demoTheme;
  if (config.theme === "auto") return (shipManufacturer && MFR_THEME[shipManufacturer]) || "mobiglas";
  if (config.theme === "mobiglas") return "mobiglas";
  return entitled() ? config.theme : "mobiglas"; // a pinned manufacturer is subscriber-only
}

// Accent hex per theme = the `--cyan` value of each :root[data-theme] block in missions.html.
// KEEP IN SYNC with that CSS. (`--accent-rgb` there is just rgb(--cyan), so we derive it below.)
const THEME_ACCENT: Record<ManufacturerTheme, string> = {
  mobiglas: "#45D0E0", drake: "#E4802F", anvil: "#26D6AB", greys: "#83D93E",
  esperia: "#E8455A", misc: "#E7B93E", banu: "#F2511E", gatac: "#A47CE8",
  mirai: "#3E9BF2", origin: "#5E8AD6", aegis: "#5CBBD9", crusader: "#4FA6E4",
  rsi: "#8B90E9", kruger: "#5CDD90", argo: "#E37B36", cnou: "#CFF0F6",
};
function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
}
// manufacturer key → its entity code (invert MFR_BY_CODE; first code wins).
const MFR_CODE_BY_NAME: Record<string, string> = {};
for (const [code, name] of Object.entries(MFR_BY_CODE)) if (!(name in MFR_CODE_BY_NAME)) MFR_CODE_BY_NAME[name] = code;
/** The flown ship's manufacturer theme + accent, DECOUPLED from config.theme/entitlement/demo —
 *  for external consumers (stream overlays via GET /api/ship + the SSE) that re-tint to the ship,
 *  independent of what skin the streamer has pinned on their own HUD. `theme` falls back to
 *  "mobiglas" for a manufacturer with no bespoke skin, so registering a new theme (MFR_THEME +
 *  THEME_ACCENT + the CSS block) makes it auto-report here with ZERO change to this endpoint. */
function shipInfo() {
  const theme: ManufacturerTheme = (shipManufacturer && MFR_THEME[shipManufacturer]) || "mobiglas";
  const accent = THEME_ACCENT[theme];
  return {
    type: "shipTheme" as const,
    theme,
    accent,
    accentRgb: hexToRgb(accent),
    manufacturer: shipManufacturer,                                              // raw key, e.g. "aopoa" (null on foot)
    ship: shipName,                                                              // display name (null on foot)
    code: shipManufacturer ? (MFR_CODE_BY_NAME[shipManufacturer] ?? null) : null,
    onFoot: !shipManufacturer,
  };
}

// The overlay view plus user prefs the overlay needs (kept out of the tracker, which
// doesn't know about config). Sent on every mission broadcast so a config change (e.g.
// the time-format toggle) reaches the overlay live via broadcastMissions().
function missionsPayload(): string {
  return JSON.stringify({
    ...tracker.view(),
    appVersion: APP_VERSION,
    live: twitchLive,
    ship: shipInfo(), // flown-ship manufacturer/theme/accent — push-live for external overlays
    prefs: {
      timeRelative: config.timeRelative,
      hideCatbar: config.hideCatbar,
      missionOcr: config.missionOcr,
      fabCapture: config.fabCapture,
      theme: effectiveTheme(),
      overlayTwist: config.overlayTwist,
      overlayScale: config.overlayScale,
      premium: entitled(),   // subscriber: skins unlocked + logos/flair shown
      demo: !!demoTheme,     // a trial preview is live → overlay shows the trial watermark
    },
  });
}
function broadcastMissions(): void {
  const data = `data: ${missionsPayload()}\n\n`;
  for (const res of missionClients) res.write(data);
}
tracker.on("change", broadcastMissions);

// ── Mining / economy datasets (commodities prices + rock->ore composition) ───
// Bundled, version-independent reference data for offline use (see MiningEconomyStore).
// Served on demand via /api/commodities + /api/mining-composition; no UI consumes it yet.
const economy = new MiningEconomyStore(dataDir);
{
  const c = economy.counts();
  console.log(`[economy] commodities: ${c.commodities}, mining resources: ${c.resources}` +
    (c.compositionSource ? ` (composition from ${c.compositionSource})` : ""));
}

// ── Mining Assistant (signature scanner + refinery timer) ────────────────────
const mining = new MiningTracker({ dataDir, stateDir: userDir });
const miningClients = new Set<ServerResponse>();
function miningSend(msg: unknown): void {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of miningClients) res.write(data);
}
// Appearance (theme + skew + scale) for the Mining Assistant window — same resolved values the
// HUD gets in its prefs, so the mining widget retints (incl. Drake auto-by-ship) and matches.
function miningAppearance(): { kind: "appearance"; theme: string; overlayTwist: number; overlayScale: number } {
  return { kind: "appearance", theme: effectiveTheme(), overlayTwist: config.overlayTwist, overlayScale: config.overlayScale };
}
mining.on("change", () => miningSend({ kind: "state", view: mining.view() }));
// Transient alerts the overlay turns into TTS + sound + a flash.
mining.on("target-hit", (hit) => miningSend({ kind: "target-hit", hit }));
mining.on("refinery-done", (job) => miningSend({ kind: "refinery-done", job }));

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

// Subscriber-skin entitlement: poll subliminal.gg with the device token to learn whether the
// linked account is an ACTIVE Twitch subscriber. That server-resolved result (not the local
// premiumOverride) is what lets a pinned manufacturer skin stay up instead of reverting after
// the trial. No token (unsynced) → not entitled → trial only. Site: GET /api/sc/entitlement.
let twitchEntitled = false;
const ENTITLEMENT_POLL_MS = 20 * 60 * 1000;
async function pollEntitlement(): Promise<void> {
  const applyIfChanged = (next: boolean) => {
    if (next !== twitchEntitled) { twitchEntitled = next; broadcastMissions(); miningSend(miningAppearance()); }
  };
  if (!config.syncToken) { applyIfChanged(false); return; } // unsynced → can't be entitled
  try {
    const base = process.env.SC_SYNC_BASE || "https://subliminal.gg";
    const r = await fetch(`${base}/api/sc/entitlement`, {
      headers: { Authorization: `Bearer ${config.syncToken}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return; // 401/5xx — keep last known state
    const j = (await r.json()) as { entitled?: boolean };
    applyIfChanged(!!j.entitled);
  } catch {
    /* network hiccup — keep last known state */
  }
}
void pollEntitlement();
setInterval(() => void pollEntitlement(), ENTITLEMENT_POLL_MS).unref?.();

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
    // Also seed the CURRENT ship (last board still in effect) so theme="auto" matches on a cold
    // start while already seated — the watcher only tails NEW lines, so it wouldn't otherwise see it.
    let seedMfr: string | null = null, seedShip: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      tracker.detectPatch(line);
      const ev = parseMissionEvent(parseLine(line));
      if (ev) tracker.apply(ev);
      const chan = shipChannelEvent(line);
      if (chan) {
        if (chan.action === "enter" && chan.manufacturer) { seedMfr = chan.manufacturer; seedShip = chan.ship; }
        else if (chan.action === "leave" && config.revertThemeOnFoot && (chan.manufacturer === seedMfr || chan.ship === seedShip)) { seedMfr = null; seedShip = null; }
      } else {
        const mfr = manufacturerFromLine(line); // AC OnVehicleSpawned (no channel)
        if (mfr) { seedMfr = mfr; seedShip = null; }
      }
    }
    shipManufacturer = seedMfr; shipName = seedShip;
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

    // Theme auto-switch: track the manufacturer of the ship we're in; re-broadcast so the
    // overlay retints live when theme="auto". Independent of the erkul loadout autoSwitch.
    // Track the flown ship's manufacturer (drives theme="auto" AND the /api/ship signal). The PU
    // comms channel gives enter + EXIT with a ship name; AC's OnVehicleSpawned gives only a spawn.
    // Broadcast on any change so external overlays get it push-live even when theme != "auto"
    // (the HUD's own theme is prefs.theme = effectiveTheme(), unchanged unless it's in Auto).
    const chan = shipChannelEvent(e.message);
    if (chan) {
      if (chan.action === "enter" && chan.manufacturer) {
        if (chan.manufacturer !== shipManufacturer || chan.ship !== shipName) {
          shipManufacturer = chan.manufacturer; shipName = chan.ship;
          broadcastMissions(); miningSend(miningAppearance());
        }
      } else if (chan.action === "leave" && config.revertThemeOnFoot && shipManufacturer &&
                 (chan.manufacturer === shipManufacturer || chan.ship === shipName)) {
        // Left our ship's channel and the user opted to revert to Mobiglas on foot.
        shipManufacturer = null; shipName = null;
        broadcastMissions(); miningSend(miningAppearance());
      }
    } else {
      const mfr = manufacturerFromLine(e.message); // AC-only spawn (no channel, no exit event)
      if (mfr && mfr !== shipManufacturer) {
        shipManufacturer = mfr; shipName = null;
        broadcastMissions(); miningSend(miningAppearance());
      }
    }

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
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
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

  // The flown ship's manufacturer theme + accent, independent of the pinned display theme.
  // For external consumers (e.g. Streamer.bot) that re-tint stream overlays to the current ship.
  // Also emitted push-live on the /missions/events SSE as the `ship` field of each payload.
  if (url === "/api/ship" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(shipInfo()));
    return;
  }

  // Crafting detail (recipe / dismantle / craft time / stats / manufacturer) for one
  // blueprint, looked up by ?item=<uuid> or ?name=<blueprint name>. Powers the overlay's
  // recipe view on demand (kept OUT of the mission-view payload so the SSE stays lean).
  if (url === "/api/blueprint-detail" && req.method === "GET") {
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const key = (q.get("item") || q.get("name") || "").trim();
    const detail = key ? tracker.blueprintDetail(key) : null;
    res.writeHead(detail ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(detail ?? { error: "not found" }));
    return;
  }

  // Commodity economy: ?item=<uuid|name> for one commodity's refine map + material props +
  // per-terminal buy/sell prices; no query returns the whole commodity map.
  if (url === "/api/commodities" && req.method === "GET") {
    const key = new URL(req.url ?? "", "http://x").searchParams.get("item")?.trim();
    const body = key ? economy.commodity(key) : { commodities: economy.commodities() };
    res.writeHead(key && !body ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
    return;
  }

  // Rock/deposit -> ore composition: ?key=<resource key> for one, else the whole map.
  if (url === "/api/mining-composition" && req.method === "GET") {
    const key = new URL(req.url ?? "", "http://x").searchParams.get("key")?.trim();
    const body = key ? economy.composition(key) : { resources: economy.resources() };
    res.writeHead(key && !body ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
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

  // Guaranteed ITEM rewards (jumpsuit/hat/etc.) — manual tick only; the log never
  // reports item awards. Tracked apart from blueprints (no collected-count / no sync).
  if (url === "/api/missions/own-item" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.name === "string" && typeof body.owned === "boolean") {
      tracker.setGuaranteedOwned(body.name, body.owned);
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
    if (!screenCatalog) screenCatalog = loadCatalog(dataDir);
    if (Array.isArray(body.lines)) {
      // Pre-computed OCR from the main process (RapidOCR reads the fabricator name off a right-
      // panel crop). Classify directly — skip the WinRT OCR entirely for this call.
      const ocr: OcrResult = { w: Number(body.w) || 0, h: Number(body.h) || 0, lines: body.lines };
      result = classifyScreen(ocr, screenCatalog);
    } else if (typeof body.path === "string" && body.path) {
      result = await readScreenshot(body.path, screenCatalog);
    }
    // Routing applies to BOTH sources. Mining reads feed its tracker (same process); the
    // mission/fabricator reads are routed by capture.cjs off the returned result.
    const rd = result as { kind?: string; signature?: number; name?: string; items?: string[] };
    if (rd.kind === "refinery") mining.applyRefineryRead(result as never);
    else if (rd.kind === "mineable" && typeof rd.signature === "number") mining.applyMineableRead(rd.signature);
    // A fabricator display name can map to several distinct same-named items (e.g. the 3
    // sizes of "Cinch Scraper Module"). Hand back every sibling UUID so the capture loop can
    // share the one captured image across all of them (the log/kiosk can't say which size).
    else if (rd.kind === "fabricator" && rd.name) rd.items = tracker.itemUuidsForName(rd.name);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // Mining Assistant: live state stream + snapshot + controls.
  if (url === "/mining/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("\n");
    miningClients.add(res);
    res.write(`data: ${JSON.stringify({ kind: "state", view: mining.view() })}\n\n`);
    res.write(`data: ${JSON.stringify(miningAppearance())}\n\n`); // theme + skew + scale
    req.on("close", () => miningClients.delete(res));
    return;
  }
  if (url === "/api/mining" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mining.view()));
    return;
  }
  if (url === "/api/mining/target" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.name === "string") mining.setTarget(body.name, body.on !== false);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // The user's chosen alert-tone WAV (config.miningTone). HEAD is used by the window to
  // know whether a custom tone is set; GET streams it. 404 when unset/missing.
  if (url === "/api/mining/tone") {
    if (config.miningTone && existsSync(config.miningTone)) {
      const buf = readFileSync(config.miningTone);
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": buf.length });
      res.end(req.method === "HEAD" ? undefined : buf);
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  if (url === "/api/mining/remove-job" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.id === "string") mining.removeJob(body.id);
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
    // This machine's LAN IPv4 (private range), so the settings page can offer a browser-source
    // URL that works from a phone/second device on the same network (localhost only works on
    // this PC). null if we can't find one (no LAN / VPN-only).
    const lanHost = (() => {
      for (const iface of Object.values(networkInterfaces())) {
        for (const a of iface ?? []) {
          if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
        }
      }
      return null;
    })();
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
    res.end(JSON.stringify({ ...rest, premium: entitled(), hasSyncToken: !!syncToken, syncTokenPreview, resolved: urls, lanHost, port: PORT }));
    return;
  }

  // "What's new" card: notes for the running version + whether it's already been seen.
  // The version comes from the Electron shell (app.getVersion, authoritative — the
  // bun-compiled sidecar can't read package.json), falling back to APP_VERSION in dev.
  if (url === "/api/changelog" && req.method === "GET") {
    const ver = new URL(req.url ?? "", "http://x").searchParams.get("v")?.trim() || APP_VERSION;
    const cl = loadChangelog();
    // Return the 5 most recent versions (semver desc), not just the current one — we patch fast,
    // so a user returning a day later has often skipped a few versions and would otherwise only
    // see the newest. `version`/`seen` still govern whether the card shows (on a version bump).
    const cmpDesc = (a: string, b: string) => {
      const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      return 0;
    };
    const entries = Object.keys(cl).sort(cmpDesc).slice(0, 5).map((v) => ({ version: v, notes: cl[v] ?? [] }));
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ version: ver, entries, seen: config.seenChangelog === ver }));
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
    if (typeof body.miningAssistant === "boolean") config.miningAssistant = body.miningAssistant;
    if (typeof body.miningAutoShow === "boolean") config.miningAutoShow = body.miningAutoShow;
    if (typeof body.miningOpen === "boolean") config.miningOpen = body.miningOpen;
    if (typeof body.miningTone === "string") config.miningTone = body.miningTone;
    // GPU accel is read by electron/main.cjs at startup; persist here, restart applies it.
    if (typeof body.hwAccel === "boolean") config.hwAccel = body.hwAccel;
    if (typeof body.amdCompat === "boolean") config.amdCompat = body.amdCompat;
    if (typeof body.bindingPng === "string") config.bindingPng = body.bindingPng;
    if (typeof body.bindingHotkey === "string" && body.bindingHotkey.trim()) config.bindingHotkey = body.bindingHotkey.trim();
    if (typeof body.overlayHotkey === "string" && body.overlayHotkey.trim()) config.overlayHotkey = body.overlayHotkey.trim();
    if (typeof body.miningHotkey === "string" && body.miningHotkey.trim()) config.miningHotkey = body.miningHotkey.trim();
    if (typeof body.interactHotkey === "string" && body.interactHotkey.trim()) config.interactHotkey = body.interactHotkey.trim();
    if (typeof body.holdToInteract === "boolean") config.holdToInteract = body.holdToInteract;
    if (typeof body.moveHotkey === "string" && body.moveHotkey.trim()) config.moveHotkey = body.moveHotkey.trim();
    if (typeof body.timeRelative === "boolean") config.timeRelative = body.timeRelative;
    if (typeof body.shareLogs === "boolean") config.shareLogs = body.shareLogs;
    if (typeof body.showLoadout === "boolean") config.showLoadout = body.showLoadout;
    if (typeof body.hideCatbar === "boolean") config.hideCatbar = body.hideCatbar;
    if (typeof body.revertThemeOnFoot === "boolean") config.revertThemeOnFoot = body.revertThemeOnFoot;
    if (body.theme === "mobiglas" || body.theme === "drake" || body.theme === "anvil" || body.theme === "greys" || body.theme === "esperia" || body.theme === "misc" || body.theme === "banu" || body.theme === "gatac" || body.theme === "mirai" || body.theme === "origin" || body.theme === "aegis" || body.theme === "crusader" || body.theme === "rsi" || body.theme === "kruger" || body.theme === "argo" || body.theme === "cnou" || body.theme === "auto") {
      const t = body.theme as Config["theme"];
      if (t !== "mobiglas" && t !== "auto" && !entitled()) {
        // Pinning a specific manufacturer is subscriber-only → preview it (trial), don't persist.
        startDemo(t);
      } else {
        config.theme = t; // Mobiglas + Auto are free; entitled users persist any pinned theme
        clearTimeout(demoTimer); demoTheme = null;
      }
    }
    if (typeof body.overlayTwist === "number" && isFinite(body.overlayTwist))
      config.overlayTwist = Math.max(-35, Math.min(35, Math.round(body.overlayTwist)));
    if (typeof body.overlayScale === "number" && isFinite(body.overlayScale))
      config.overlayScale = Math.max(50, Math.min(200, Math.round(body.overlayScale)));
    await saveConfig();
    // Push the new prefs to every open overlay (incl. OBS browser-source) live.
    broadcastMissions();
    // The Mining Assistant window shares the same appearance (theme + skew + scale).
    miningSend(miningAppearance());
    await reindex();
    startWatcher();
    // Re-arm sync with the new settings and reconcile the full collection.
    if (sync.configure(config.syncToken, config.syncEnabled)) syncFull();
    // A changed token → re-resolve subscriber entitlement now (don't wait for the 20-min tick).
    void pollEntitlement();
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
