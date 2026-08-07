import { createServer, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readFile, readdirSync, statSync, mkdirSync, copyFileSync, rmSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { extname, join, dirname, basename } from "node:path";

import { resolveLoadout, type Build } from "./erkul.js";
import { LogWatcher } from "./watcher.js";
import { parseLine } from "./parser.js";
import { parseMissionEvent } from "./missions-parser.js";
import { PartyTracker, ownHandleFromLog } from "./party.js";
import { MissionTracker } from "./missions.js";
import { collectLogPaths } from "./log-paths.js";
import { MiningTracker } from "./mining.js";
import { MiningEconomyStore } from "./mining-economy.js";
import { MissionFeedbackStore } from "./mission-feedback.js";
import { FabClaims } from "./fab-claim.js";
import { SCENARIOS, replayLines, replayMissionId } from "./dev-replay.js";
import { SiteSync } from "./sync.js";
import { assetDir } from "./paths.js";
import { loadCatalog, ocrImage, hasScanHud, classifyScreen, type CatalogEntry, type OcrResult, type ScanRegion } from "./screen-read.js";
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
setInterval(() => void maybeShareLog(config, APP_VERSION, sharedLogStatePath), LOG_SHARE_INTERVAL_MS);

// "What's new" per version (overlay/changelog.json), cached after first read. Each entry is
// { date, notes } (date = UTC release time); a bare string[] is accepted for backward-compat.
//
// A NOTE is { kind, label, text }: `label` is the short scannable title, `text` the description,
// and `kind` (new | improved | fixed) drives the card's grouping. A PLAIN STRING is a legacy note
// — 0.1.33 and older were written before labels existed — and normalizes to text with no label and
// no kind, which the card renders as a flat ungrouped list exactly as it always did. Normalising
// HERE rather than in the card means one shape reaches every consumer, and an unknown kind from a
// hand-edited file degrades to ungrouped instead of inventing a section.
type ChangelogNote = string | { kind?: string | null; label?: string | null; text: string };
type ChangelogEntry = ChangelogNote[] | { date?: string | null; notes: ChangelogNote[] };
type NormalisedNote = { kind: string | null; label: string | null; text: string };
const CL_KINDS = new Set(["new", "improved", "fixed"]);
const clNote = (n: ChangelogNote): NormalisedNote | null => {
  if (typeof n === "string") return n.trim() ? { kind: null, label: null, text: n } : null;
  if (!n || typeof n.text !== "string" || !n.text.trim()) return null;
  const kind = typeof n.kind === "string" && CL_KINDS.has(n.kind) ? n.kind : null;
  const label = typeof n.label === "string" && n.label.trim() ? n.label.trim() : null;
  return { kind, label, text: n.text };
};
const clNotes = (e: ChangelogEntry | undefined): NormalisedNote[] =>
  (Array.isArray(e) ? e : e?.notes ?? []).map(clNote).filter((n): n is NormalisedNote => n !== null);
const clDate = (e: ChangelogEntry | undefined): string | null => (Array.isArray(e) ? null : e?.date ?? null);
let changelogCache: Record<string, ChangelogEntry> | null = null;
function loadChangelog(): Record<string, ChangelogEntry> {
  if (changelogCache) return changelogCache;
  let parsed: Record<string, ChangelogEntry> = {};
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
// Which rotated sessions (logbackups/) have already been shared. Remembered by FILENAME, and
// permanently — a backup is immutable, so "sent", "wrong patch" and "no mission signal" are all
// final answers. Without this every app launch would re-offer the whole folder.
const sharedLogStatePath = join(userDir, "shared-logs.json");

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
  /** Opt-in: when the fabricator shows a blueprint the tracker has no record of, offer to
   *  tick it. Recovers ownership the log can never report (receipts predating the install,
   *  or rotated-away logbackups) using the one screen that only lists what you own.
   *  Independent of fabCapture — this needs no upload and no sync token. */
  fabClaim: boolean;
  /** Mining Assistant: arms the capture loop to read the Refinement Center (job timers)
   *  and the mining scanner signature. Opt-in; read by electron/capture.cjs each poll. */
  miningAssistant: boolean;
  /** Where the signature number is hunted, as fractions of the frame. Null = the default band.
   *  Set by dragging the "scan read area" box (Mining Scanner cog) — the only way to cope with a
   *  HUD that doesn't sit where we assume. */
  scanRegion: ScanRegion | null;
  /** Auto-show the Mining Assistant window when the scanner/refinery screen is detected. */
  miningAutoShow: boolean;
  /** Remembers whether the Mining Assistant window was left open, so it's restored on launch. */
  miningOpen: boolean;
  /** Remembers whether the Notepad widget was left open, so it's restored on launch. */
  notepadOpen: boolean;
  /** Notepad text-size multiplier (0.8–2.0) so notes stay readable on 1080p → 4K panels. */
  notepadFontScale: number;
  /** Twitch channel whose live chat the Twitch Chat widget shows (login name, no @ or URL).
   *  Defaults to subliminalstv; empty = the widget shows its channel-picker instead. */
  twitchChannel: string;
  /** Remembers whether the Twitch Chat widget was left open, so it's restored on launch. */
  twitchChatOpen: boolean;
  /** Twitch Chat text-size multiplier (0.8-2.0) so chat stays readable on 1080p -> 4K panels. */
  twitchChatFontScale: number;
  /** Twitch application client id, used for the device-code login that enables SENDING chat.
   *  A Twitch client id is public by design (it ships in every web client) — it is NOT a secret;
   *  the user token it mints is, and that lives in twitchUserToken. Reading chat needs neither. */
  twitchClientId: string;
  /** OAuth user token (scope chat:edit) from the device-code flow. Empty = read-only chat. */
  twitchUserToken: string;
  /** The signed-in Twitch login that token belongs to — shown in the widget so you can see who
   *  you're about to talk as. Not a secret, so unlike the token it IS returned by GET /api/config. */
  twitchUserLogin: string;
  /** Refresh token from the device flow. A Twitch user token expires in ~4h, so without this,
   *  sending would silently stop working mid-session and read as a bug. */
  twitchRefreshToken: string;
  /** Remembers whether the SC Feed widget was left armed, so it's restored on launch. */
  scFeedOpen: boolean;
  /** Blueprint-unlock notifier armed. Defaults TRUE — it replaced a toast that used to live
   *  inside the Blueprint panel, so off-by-default would quietly remove an existing notification. */
  unlockAlertOpen: boolean;
  /** Where a SC Feed card's click goes: "site" opens sc-feed.subliminal.gg (default - the feed
   *  is the product), "source" opens the story's own URL (Spectrum, YouTube, Reddit...). */
  scFeedLinkTarget: "site" | "source";
  /** Speak new headlines in HAL's voice ("New news from Pipeline"). Off by default. */
  scFeedVoice: boolean;
  /** Play the alert tone when a headline arrives. */
  scFeedSound: boolean;
  /** SC Feed alert volume, 0-1. */
  scFeedVolume: number;
  /** Path to a user-chosen WAV for the SC Feed alert (empty = the built-in tone). */
  scFeedTone: string;
  /** Remembers whether the Party widget was left open, so it's restored on launch. */
  partyOpen: boolean;
  /** Remembers whether the Battaglia grind widget was left open, so it's restored on launch. */
  battagliaOpen: boolean;
  /** Remembers whether the Web Page widget was left open, so it's restored on launch. */
  webViewOpen: boolean;
  /** URL shown by the Web Page widget (http/https only). Empty = it shows its address picker. */
  webViewUrl: string;
  /** Remembers whether the Binding Chart WIDGET was left open (distinct from the full-screen
   *  binding overlay, which stays on its own hotkey). */
  bindingChartOpen: boolean;
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
  /** Manual nudge for the overlay canvas, in PHYSICAL pixels, applied to the window's position.
   *  Mixed-DPI desktops (a 225% 4K primary beside 100% 1080p monitors) leave the canvas offset
   *  from the real monitors. Rather than guess the DPI maths, the user drags it into place like a
   *  console game's safe-area screen.
   *  🔑 Defaults to 0,0, so a correct setup is bit-for-bit unaffected. */
  canvasOffsetX: number;
  canvasOffsetY: number;
  /** The other half of that calibration: a uniform scale for the canvas coordinate space. Changing
   *  the PRIMARY monitor's Windows scaling leaves the canvas both mis-placed AND mis-sized (Sub,
   *  2026-08-03), and an offset can only fix the placement. Applied as CSS `zoom` on the canvas
   *  document, so the dotted primary outline, every widget's position and every widget's contents
   *  scale as one — the user grows it until the outline sits on their real monitor edges.
   *  🔑 Defaults to 1. */
  canvasScale: number;
  /** Seconds an SC Feed story stays on screen before fading (Argante's ask). Clamped 3–60:
   *  under 3 nothing is readable, and a notifier that never leaves is a panel, not a pop-up. */
  scFeedShowSeconds: number;
  /** Seconds an Unlock Alert card stays up. Same clamp, same reasoning. */
  unlockAlertShowSeconds: number;
  miningHotkey: string;
  webViewHotkey: string;
  /** Global hotkey that shows/hides the Journal widget (Electron accelerator syntax).
   *  Read by electron/main.cjs at startup. */
  notepadHotkey: string;
  /** Hold-to-interact hotkey (Electron accelerator, default "F"): when hold-to-interact mode is
   *  on, the overlay is passive (click-through) unless this key is HELD. */
  interactHotkey: string;
  /** Opt-in: require holding the interact key to click the overlay. Off by default (the overlay
   *  is clickable whenever the cursor is over a widget). */
  holdToInteract: boolean;
  /** Global hotkey that toggles arrange/move mode (Electron accelerator syntax). */
  moveHotkey: string;
  /** Hotkey that CONFIRMS a fabricator claim prompt. A hotkey rather than only a click
   *  because the overlay is click-through over the game — confirming with the mouse means
   *  entering hold-to-interact mid-kiosk, which is exactly when you can least afford it. */
  fabClaimHotkey: string;
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
  /** First-run setup wizard: every step is resolved (done or explicitly skipped). Set when the
   *  wizard is finished; the wizard never auto-opens again once true. */
  setupDone: boolean;
  /** The wizard's "review your settings" step. Nothing else in the app can observe that a user
   *  looked at Settings, so this is the only record — it is set when they come back from it. */
  setupSettingsReviewed: boolean;
  /** The wizard's optional "share your profile" step, which happens entirely on the website.
   *  The app can't detect an RSI handle verification, so this records that the user resolved it. */
  setupShareResolved: boolean;
  /** Existing users don't get the wizard thrown at them on update — they get one dismissible
   *  banner. Set when they dismiss it or open the wizard from it, so it never returns. */
  setupNudgeDismissed: boolean;
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
  fabClaim: false,
  miningAssistant: false,
  scanRegion: null,
  miningAutoShow: false,
  miningOpen: false,
  notepadOpen: false,
  notepadFontScale: 1,
  twitchChannel: "subliminalstv", // default channel — users can point it anywhere
  twitchChatOpen: false,
  twitchChatFontScale: 1,
  twitchClientId: "44srrs673ypzr1e1y8izcfbbirkmso", // Sub's registered Twitch app
  twitchUserToken: "",
  twitchUserLogin: "",
  twitchRefreshToken: "",
  scFeedOpen: false,
  unlockAlertOpen: true,
  scFeedLinkTarget: "site",
  scFeedVoice: false,
  scFeedSound: true,
  scFeedVolume: 0.6,
  scFeedTone: "",
  partyOpen: false,
  battagliaOpen: false,
  webViewOpen: false,
  // A first-run Web Page widget opens on the blueprint tracker rather than an empty form —
  // it's the page most likely to be wanted beside the game, and it shows what the widget does.
  webViewUrl: "https://subliminal.gg/blueprints",
  bindingChartOpen: false,
  miningTone: "",
  hwAccel: false,
  amdCompat: false,
  bindingPng: "",
  bindingHotkey: "Ctrl+F3",
  overlayHotkey: "F3",
  canvasOffsetX: 0,
  canvasOffsetY: 0,
  canvasScale: 1,
  scFeedShowSeconds: 12,
  unlockAlertShowSeconds: 8,
  miningHotkey: "Shift+F3",
  webViewHotkey: "Ctrl+Shift+F3",
  notepadHotkey: "Alt+F3",
  interactHotkey: "F",
  holdToInteract: false,
  moveHotkey: "Ctrl+Alt+M",
  fabClaimHotkey: "F4",
  timeRelative: true,
  shareLogs: false,
  seenChangelog: "",
  showLoadout: false,
  hideCatbar: false,
  theme: "mobiglas",
  overlayTwist: 0, // flat by default; the user can dial in a skew angle in the hub
  overlayScale: 100,
  revertThemeOnFoot: false,
  setupDone: false,
  setupSettingsReviewed: false,
  setupShareResolved: false,
  setupNudgeDismissed: false,
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
// 🔑 Whether this is a genuinely FIRST run, decided BEFORE anything can write a config —
// the setup wizard takes over the screen, so it must never fire at someone who has been
// using the app for months. An ABSENT `setupDone` cannot serve here: every existing user's
// config predates the field and would read as fresh.
//
// Judged on the USER's config alone. `seedConfigPath` (overlay/config.json) is deliberately
// excluded: it is a bundled DEFAULT, not evidence that this user has configured anything, and
// it never ships (tools/build-server.mjs filters it out) so packaged behaviour is unchanged
// either way. Including it meant the wizard could never fire on a machine that happened to have
// a dev seed lying around — which is every developer's, and which made `npm run dev:fresh`
// (the only way to walk first-run setup once you have already done it) silently useless.
const freshInstall = !existsSync(configPath);
let config: Config = loadConfig();

/** Scan common Star Citizen install locations for per-channel game.log files, newest
 *  first. SC installs as <root>\StarCitizen\<CHANNEL>\game.log (LIVE, PTU, EPTU,
 *  TECH-PREVIEW, HOTFIX, GAME, …). The channel whose log was written most recently is
 *  the one the player actually plays, so that's the recommended pick. */
function detectGameLogs(): { path: string; channel: string; mtimeMs: number; live: boolean }[] {
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

  const found: { path: string; channel: string; mtimeMs: number; live: boolean }[] = [];
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
        if (st.isFile()) { found.push({ path: p, channel: ch, mtimeMs: st.mtimeMs, live: isLiveLog(p) }); seen.add(key); }
      } catch { /* no game.log in this channel */ }
    }
  }
  // 🔑 A LIVE log beats a newer one. Picking purely by mtime pointed the app at PTU for
  // anyone who had dabbled there most recently — and since only live progress counts, that
  // meant tracking nothing real while their actual history sat in a sibling folder.
  // Judged by the log's own `--envtag`, never the folder name: names are user-renamable
  // (and on some installs the channels are junctions to one folder), the header is not.
  // Name is the LAST tie-break and nothing more. It matters only when several candidates are
  // equally live and equally recent — which happens when the channel folders are junctions to
  // one install (Sub's setup: six paths, one inode, identical mtimes). Without it the winner
  // is directory order, so a live player can be told they're on "EPTU". It can never override
  // the env tag or recency, so a renamed folder still can't misrepresent a log.
  const nameRank = (ch: string) => {
    const c = ch.toUpperCase();
    return c === "LIVE" ? 0 : c === "GAME" ? 1 : 2;
  };
  return found.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return nameRank(a.channel) - nameRank(b.channel);
  });
}

/** Is this game.log a LIVE (PUB) session? Reads only the header, where the tag lives —
 *  these files reach tens of MB and detection runs at startup.
 *  Unknown reads as LIVE: a log too short to carry a header yet must not be ranked below
 *  a real test-server log. Mirrors the same tolerance as the tracker's own env gate. */
function isLiveLog(p: string): boolean {
  try {
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const m = /--envtag=.?([A-Za-z0-9_]+)|Environment:\s*([A-Za-z0-9_]+)/.exec(buf.toString("utf8", 0, n));
      const tag = (m?.[1] || m?.[2] || "").toUpperCase();
      return !tag || tag === "PUB";
    } finally {
      closeSync(fd);
    }
  } catch {
    return true; // unreadable → don't demote it on a guess
  }
}

/** Is the sync token actually good? A non-empty string proves nothing — it can be revoked or
 *  typed wrong — so this asks the site. Used by both `/api/diagnostics` and `/api/setup`; one
 *  copy, because two would drift on exactly the detail that matters (401 = the token is bad and
 *  the user must act, anything else = the network is down and they must not).
 *
 *  🔑 Memoised for 5s. The setup wizard POLLS this while its connect step is open, waiting for a
 *  freshly-pasted token to go green; without the memo that step would hit subliminal.gg on every
 *  tick. The window is deliberately short — a user who pastes a token expects it to verify now,
 *  not in a minute. */
type TokenVerdict = "none" | "ok" | "rejected" | "unreachable";
let tokenMemo: { at: number; forToken: string; verdict: TokenVerdict } | null = null;
async function verifySyncToken(): Promise<TokenVerdict> {
  if (!config.syncToken) return "none";
  // Keyed on the token itself, so pasting a NEW one is never answered from the old one's memo.
  if (tokenMemo && tokenMemo.forToken === config.syncToken && Date.now() - tokenMemo.at < 5000)
    return tokenMemo.verdict;
  let verdict: TokenVerdict;
  try {
    // 🔑 MUST be an endpoint that actually authenticates. This asked `/api/sc/fab-needed`, which
    // answers 200 to anyone — no bearer at all included — so every token verified as good. The
    // setup wizard's connect step is built on this, and it was telling users with a mistyped
    // token "Connected — your collection will sync". `/api/sc/entitlement` is read-only and 401s
    // without a valid bearer, so it can actually tell them apart.
    const r = await fetch("https://subliminal.gg/api/sc/entitlement", {
      headers: { Authorization: `Bearer ${config.syncToken}` },
      signal: AbortSignal.timeout(6000),
    });
    // 401 is the ONLY "your token is bad". A definite non-401 answer means the server recognised
    // the caller — including 403, which is a VALID token that simply isn't entitled to something
    // (skins are subscriber-gated). Reading 403 as rejected would tell a perfectly connected
    // non-subscriber their token was refused.
    verdict = r.status === 401 ? "rejected" : r.status < 500 ? "ok" : "unreachable";
  } catch { verdict = "unreachable"; }
  tokenMemo = { at: Date.now(), forToken: config.syncToken, verdict };
  return verdict;
}

// Save to the writable user dir; a write failure must never crash the server
// (an EPERM writing under Program Files is exactly what took it down before).
//
// 🔑 A failure here is INVISIBLE in the worst possible way: every endpoint still answers
// {ok:true} because it only reports that the in-memory config was updated, so the app behaves
// perfectly until it restarts and every setting the user changed is gone. Worse, the one place
// this was reported — console.error — goes nowhere whenever the sidecar's stdio isn't being
// captured, which is exactly when you most need it. So the last failure is REMEMBERED and
// surfaced by /api/diagnostics, and a save that succeeds clears it.
let lastSaveError: { at: string; error: string } | null = null;
let lastSaveOk: string | null = null;
// Live overlay geometry, merged from the shell (`shell` key) and the canvas page (`canvas` key).
// See the /api/overlay-geometry routes; in memory only, because it describes a window that exists
// right now and a stale copy would be worse than none.
let overlayGeometry: Record<string, unknown> | null = null;
const saveConfig = async (): Promise<void> => {
  try {
    mkdirSync(userDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2));
    lastSaveOk = new Date().toISOString();
    lastSaveError = null;
  } catch (e) {
    lastSaveError = { at: new Date().toISOString(), error: String(e) };
    console.error("[config] save failed:", String(e));
  }
};

// ── Notepad (local-only scratch notes) ───────────────────────────────────────
// A flat list of notes stored beside config.json in the per-user dir (NEVER next to
// the binary — Program Files is read-only). The Notepad widget owns the UI and POSTs
// the whole array back on edit; single-user/single-window, so no merge is needed.
const notesPath = join(userDir, "notes.json");
interface Note { id: string; title: string; body: string; createdAt: number; updatedAt: number; }
function readNotes(): Note[] {
  try {
    if (!existsSync(notesPath)) return [];
    const parsed = JSON.parse(readFileSync(notesPath, "utf8"));
    return Array.isArray(parsed?.notes) ? parsed.notes : [];
  } catch { return []; }
}
async function saveNotes(notes: Note[]): Promise<void> {
  try {
    mkdirSync(userDir, { recursive: true });
    await writeFile(notesPath, JSON.stringify({ notes }, null, 2));
  } catch (e) {
    console.error("[notes] save failed:", String(e));
  }
}
// Clamp an incoming note array (cap counts + field sizes so a runaway client can't bloat the file).
function sanitizeNotes(input: unknown): Note[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  return input.slice(0, 500).map((n: any): Note => ({
    id: typeof n?.id === "string" && n.id ? n.id.slice(0, 64) : now.toString(36) + Math.random().toString(36).slice(2, 8),
    title: typeof n?.title === "string" ? n.title.slice(0, 200) : "",
    body: typeof n?.body === "string" ? n.body.slice(0, 20000) : "",
    createdAt: Number.isFinite(n?.createdAt) ? n.createdAt : now,
    updatedAt: Number.isFinite(n?.updatedAt) ? n.updatedAt : now,
  }));
}

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
/** Fabricator claim prompts — offer to tick a blueprint the kiosk is showing that we have
 *  no record of. Session-scoped on purpose: the two-prompts-per-item budget resets when the
 *  app restarts, which is the point (a prompt missed today is worth re-offering tomorrow). */
const fabClaims = new FabClaims();

function missionsPayload(): string {
  return JSON.stringify({
    ...tracker.view(),
    appVersion: APP_VERSION,
    // The live claim prompt (or null). Rides the missions SSE because that is what the
    // Unlock Alerts widget already listens to — no new channel, and it self-clears when
    // the 30s window lapses because `current()` expires it on read.
    fabClaim: fabClaims.current(Date.now()),
    live: twitchLive,
    ship: shipInfo(), // flown-ship manufacturer/theme/accent — push-live for external overlays
    prefs: {
      timeRelative: config.timeRelative,
      hideCatbar: config.hideCatbar,
      missionOcr: config.missionOcr,
      fabCapture: config.fabCapture,
      fabClaim: config.fabClaim,
      fabClaimKey: config.fabClaimHotkey,   // shown in the prompt ("or press F4")
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
// Party roster + reward split. The log can only COUNT party members (and name them late,
// on despawn), so the roster is manual — see src/party.ts for the full finding.
const party = new PartyTracker(join(userDir, "party.json"), join(userDir, "party-sessions"));

const mining = new MiningTracker({ dataDir, stateDir: userDir });

// Crowdsourced mission facts (what you actually do in it, difficulty, soloable) collected by
// the completion report. Local-only for now — this file IS the upload queue for when the
// subliminal.gg endpoint lands.
const missionFeedback = new MissionFeedbackStore(userDir);

/** Push answered missions to subliminal.gg. Uses the SAME device token as the blueprint
 *  sync (there is only one credential and one account), so a player who has connected the
 *  tracker is already set up — and a player who hasn't simply keeps their answers locally
 *  until they do. The endpoint upserts per (player, contract), so re-sending the whole
 *  queue is harmless and rows stay `pending` until a request actually succeeds. */
async function flushMissionFeedback(): Promise<void> {
  if (!config.syncEnabled || !config.syncToken) return;
  const pending = missionFeedback.pending();
  if (pending.length === 0) return;
  const base = (process.env.SC_SYNC_BASE || "https://subliminal.gg").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/sc/mission-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.syncToken}` },
      body: JSON.stringify({ answers: pending }),
    });
    if (!res.ok) {
      // Leave everything pending and try again later. A 401 means the token needs
      // re-pasting; anything else is transient as far as this queue is concerned.
      console.log(`[feedback] upload refused (${res.status}) — ${pending.length} answers still queued`);
      return;
    }
    missionFeedback.markUploaded(pending);
    console.log(`[feedback] uploaded ${pending.length} answer(s) to ${base}`);
  } catch (err) {
    console.log(`[feedback] upload failed (${(err as Error).message}) — ${pending.length} answers still queued`);
  }
}
// Retry the queue periodically: the site may be down, the token may not be pasted yet, or
// the player may be offline mid-session. Nothing here is urgent enough to warrant more.
setInterval(() => void flushMissionFeedback(), 10 * 60_000);
// 🔑 And once at startup. Without this an app that STARTS with a queue — answered offline,
// or answered before the endpoint existed — sits on it until someone answers something new
// or ten minutes pass. The delay lets the sidecar finish booting first; nothing about a
// backlog is urgent enough to race startup for.
setTimeout(() => void flushMissionFeedback(), 15_000);

// Monotonic per-process counter so two runs of the same dev scenario are two distinct
// completions rather than one the tracker de-duplicates by missionId.
let replaySeq = 0;
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

// ── SC Feed (OmniFeed) proxy ─────────────────────────────────────────────────
// The SC Feed widget shows the same unified stream as sc-feed.subliminal.gg's OmniFeed. We
// proxy it through the sidecar rather than fetching from the overlay page: it sidesteps CORS,
// and the upstream payload is ~280KB of full channel objects — flattening to the newest few
// headlines here keeps the widget's poll cheap. Cached so several open surfaces (overlay +
// OBS browser-source) share one upstream request.
interface FeedItem { id: string; title: string; source: string; url: string; at: string; tag?: string }
const SCFEED_URL = "https://sc-feed.subliminal.gg/api/sc-feed";
const SCFEED_TTL_MS = 60_000;
const SCFEED_MAX = 40;
let scFeedCache: { at: number; items: FeedItem[] } = { at: 0, items: [] };
async function scFeedItems(): Promise<FeedItem[]> {
  if (Date.now() - scFeedCache.at < SCFEED_TTL_MS) return scFeedCache.items;
  try {
    const r = await fetch(SCFEED_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return scFeedCache.items; // keep the last good list on a bad response
    const channels = (await r.json()) as Array<{
      id?: string; label?: string; messages?: Array<{ id?: string; title?: string; url?: string; timestamp?: string; tag?: string }>;
    }>;
    const items: FeedItem[] = [];
    for (const c of Array.isArray(channels) ? channels : []) {
      for (const m of c.messages ?? []) {
        if (!m?.id || !m.title || !m.timestamp) continue;
        items.push({
          id: `${c.id ?? "?"}:${m.id}`,
          title: m.title,
          source: c.label || c.id || "SC Feed",
          url: m.url || "https://sc-feed.subliminal.gg",
          at: m.timestamp,
          ...(m.tag ? { tag: m.tag } : {}),
        });
      }
    }
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    scFeedCache = { at: Date.now(), items: items.slice(0, SCFEED_MAX) };
  } catch {
    /* network hiccup — serve the last good list (possibly empty) */
  }
  return scFeedCache.items;
}

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
    party.setSelf(ownHandleFromLog(text)); // you're always in your own party — pre-fill the roster
    // Also seed the CURRENT ship (last board still in effect) so theme="auto" matches on a cold
    // start while already seated — the watcher only tails NEW lines, so it wouldn't otherwise see it.
    let seedMfr: string | null = null, seedShip: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      tracker.detectPatch(line);
      const ev = parseMissionEvent(parseLine(line));
      if (ev) { tracker.apply(ev); party.apply(ev); }
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
    if (me) { tracker.apply(me); party.apply(me); }

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

// ── Twitch device-code login ─────────────────────────────────────────────────
// Sending chat needs a user token, and getting one needs an OAuth flow. The DEVICE flow is the
// right shape for a desktop app: no redirect URI, no client secret — the user types a short code
// on twitch.tv while we poll. It runs HERE and not in the widget for two reasons: id.twitch.tv
// sends no CORS headers (the flow is designed for non-browser clients), and the token has to be
// persisted, which only the sidecar can do.
//
// 🔑 The token NEVER leaves this process. Sending goes through Helix rather than IRC's
// `PASS oauth:<token>`, because IRC-from-the-widget means handing the token to the renderer — and
// this server also answers on the LAN for OBS browser sources, so anything on the network could
// then read it. That is the same reason GET /api/config strips it. Reading chat is unchanged:
// still anonymous IRC, still no token.
//
// 🔑 …but keeping the token in here is only half of it. Anything that ACTS with the token is the
// same capability as holding it, and this server answers on the LAN by design (it advertises its
// own LAN IP for OBS browser sources). So the three endpoints below are LOOPBACK ONLY: the
// widgets run in the app on this machine and are unaffected, while the rest of the network can
// still load widget pages and read chat. Without this, anything on the network could post to
// #yourchannel as you.
const TWITCH_SCOPES = "user:write:chat";

/** True for a request that came from this machine. IPv6-mapped IPv4 (`::ffff:127.0.0.1`) is what
 *  a loopback request usually looks like on a dual-stack listener, so match that too. */
function fromThisMachine(req: import("node:http").IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "::1" || a === "127.0.0.1" || a.startsWith("::ffff:127.");
}

type TwitchLoginState =
  | { state: "idle" }
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: number }
  | { state: "ok"; login: string }
  | { state: "error"; message: string };

let twitchLogin: TwitchLoginState = { state: "idle" };
let twitchPoll: ReturnType<typeof setTimeout> | null = null;
const twitchIdCache = new Map<string, string>(); // channel login -> broadcaster id

function stopTwitchPoll() {
  if (twitchPoll) { clearTimeout(twitchPoll); twitchPoll = null; }
}

/** Resolve a token to its login + user id. Doubles as the liveness check — an expired or revoked
 *  token fails to validate, which is how we know to reach for the refresh token. */
async function twitchValidate(token: string): Promise<{ login: string; userId: string } | null> {
  if (!token) return null;
  try {
    const r = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: "OAuth " + token },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d: any = await r.json();
    return d?.login ? { login: String(d.login), userId: String(d.user_id) } : null;
  } catch { return null; }
}

/** Swap the refresh token for a fresh access token. A Twitch user token lasts ~4 hours, so
 *  without this, sending would quietly stop working part-way through a session. */
async function twitchRefreshToken(): Promise<boolean> {
  if (!config.twitchRefreshToken) return false;
  try {
    const r = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.twitchClientId.trim(),
        grant_type: "refresh_token",
        refresh_token: config.twitchRefreshToken,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const d: any = await r.json();
    if (!r.ok || !d?.access_token) return false;
    config.twitchUserToken = String(d.access_token);
    if (d.refresh_token) config.twitchRefreshToken = String(d.refresh_token);
    await saveConfig();
    return true;
  } catch { return false; }
}

/** A usable token, refreshed if the stored one has expired. null = signed out or re-auth needed. */
async function twitchAuth(): Promise<{ token: string; userId: string; login: string } | null> {
  let v = await twitchValidate(config.twitchUserToken);
  if (!v && (await twitchRefreshToken())) v = await twitchValidate(config.twitchUserToken);
  if (!v) return null;
  if (v.login !== config.twitchUserLogin) { config.twitchUserLogin = v.login; await saveConfig(); }
  return { token: config.twitchUserToken, userId: v.userId, login: v.login };
}

async function startTwitchLogin(): Promise<TwitchLoginState> {
  stopTwitchPoll();
  const clientId = config.twitchClientId.trim();
  if (!clientId) return (twitchLogin = { state: "error", message: "No Twitch client id is configured." });
  try {
    const r = await fetch("https://id.twitch.tv/oauth2/device", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scopes: TWITCH_SCOPES }),
      signal: AbortSignal.timeout(10000),
    });
    const d: any = await r.json();
    if (!r.ok || !d?.device_code) throw new Error(String(d?.message ?? `Twitch said ${r.status}`));
    const intervalMs = Math.max(1000, Number(d.interval ?? 5) * 1000);
    const expiresAt = Date.now() + Math.max(60, Number(d.expires_in ?? 1800)) * 1000;
    twitchLogin = {
      state: "pending",
      userCode: String(d.user_code ?? ""),
      // Twitch's verification_uri already carries the code, so the browser lands pre-filled.
      verificationUri: String(d.verification_uri ?? "https://www.twitch.tv/activate"),
      expiresAt,
    };
    twitchPoll = setTimeout(() => void pollTwitchDevice(String(d.device_code), intervalMs, expiresAt), intervalMs);
  } catch (e) {
    twitchLogin = { state: "error", message: String((e as Error)?.message || e) };
  }
  return twitchLogin;
}

async function pollTwitchDevice(deviceCode: string, intervalMs: number, expiresAt: number): Promise<void> {
  twitchPoll = null;
  if (Date.now() > expiresAt) {
    twitchLogin = { state: "error", message: "That code expired — start again." };
    return;
  }
  let d: any = null, ok = false;
  try {
    const r = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.twitchClientId.trim(),
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        scopes: TWITCH_SCOPES,
      }),
      signal: AbortSignal.timeout(10000),
    });
    d = await r.json();
    ok = r.ok;
  } catch { /* a dropped request is transient — keep polling */ }

  if (ok && d?.access_token) {
    config.twitchUserToken = String(d.access_token);
    config.twitchRefreshToken = String(d.refresh_token ?? "");
    const v = await twitchValidate(config.twitchUserToken);
    config.twitchUserLogin = v?.login ?? "";
    await saveConfig();
    twitchLogin = v
      ? { state: "ok", login: v.login }
      : { state: "error", message: "Twitch returned a token that doesn't validate." };
    return;
  }
  // "authorization_pending" is the normal not-yet-approved answer; "slow_down" means back off.
  // Anything else (denied, expired, bad client) is fatal and must SAY so rather than spin forever.
  const msg = String(d?.message ?? "");
  if (/slow.?down/i.test(msg)) intervalMs += 1000;
  else if (msg && !/authorization_pending/i.test(msg)) {
    twitchLogin = { state: "error", message: msg };
    return;
  }
  twitchPoll = setTimeout(() => void pollTwitchDevice(deviceCode, intervalMs, expiresAt), intervalMs);
}

async function twitchSend(text: string): Promise<{ ok: boolean; message?: string }> {
  const auth = await twitchAuth();
  if (!auth) return { ok: false, message: "Not signed in to Twitch." };
  const channel = config.twitchChannel.trim().toLowerCase();
  if (!channel) return { ok: false, message: "No channel set." };
  const headers = {
    Authorization: "Bearer " + auth.token,
    "Client-Id": config.twitchClientId.trim(),
    "Content-Type": "application/json",
  };
  let broadcasterId = twitchIdCache.get(channel) ?? "";
  if (!broadcasterId) {
    try {
      const r = await fetch("https://api.twitch.tv/helix/users?login=" + encodeURIComponent(channel), {
        headers, signal: AbortSignal.timeout(8000),
      });
      const d: any = await r.json();
      broadcasterId = String(d?.data?.[0]?.id ?? "");
    } catch { /* reported just below */ }
    if (!broadcasterId) return { ok: false, message: "Couldn't find #" + channel + " on Twitch." };
    twitchIdCache.set(channel, broadcasterId);
  }
  try {
    const r = await fetch("https://api.twitch.tv/helix/chat/messages", {
      method: "POST", headers, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: auth.userId, message: text }),
    });
    const d: any = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, message: String(d?.message ?? `Twitch said ${r.status}`) };
    // 🔑 Helix can ACCEPT the request and still drop the message (AutoMod held it, followers-only,
    // banned, duplicate). It reports that in the payload, not the status code — so a 200 alone is
    // not proof it was sent, and treating it as such would look like the widget silently eating
    // messages.
    const sent = d?.data?.[0];
    if (sent && sent.is_sent === false) {
      return { ok: false, message: String(sent?.drop_reason?.message ?? "Twitch dropped that message.") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message || e) };
  }
}

const server = createServer((req, res) => {
  // One route throwing must not take the whole sidecar down with it. This handler is async, so
  // an unhandled rejection here IS a process exit — and the app can't tell the difference between
  // a dead sidecar and a slow one, so it just quietly stops working.
  void handleRequest(req, res).catch((e) => {
    console.error(`[server] ${req.method} ${req.url} failed:`, (e as Error)?.stack ?? String(e));
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: "server_error" }));
  });
});

async function handleRequest(req: import("node:http").IncomingMessage, res: ServerResponse) {
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
    // 🔑 Scan EVERY channel folder, not just the configured one. A player who has LIVE and
    // PTU as separate installs gets pointed at whichever they played most recently — so
    // someone who dabbles in PTU had their entire LIVE history sitting unscanned in a
    // sibling folder while verify found nothing (the envtag gate correctly rejected every
    // PTU session it was given). Scanning siblings is safe precisely BECAUSE that gate
    // reads the environment out of each log's header rather than trusting the folder name:
    // a renamed or oddly-named channel can neither hide a live log nor smuggle in a test one.
    // 🔑 Deduped by the file each path RESOLVES to, not by the path as written — see
    // collectLogPaths, and `npm run test:logpaths` which pins both install layouts. Separate real
    // channel folders are all still scanned; channel names that are links to one folder are
    // scanned once. On Sub's install LIVE/PTU/EPTU/HOTFIX/TECH-PREVIEW all link to GAME, so every
    // log arrived under SIX names: 1746 files for 291 real ones, every completion in them credited
    // six times (exactly the ~6x his standings were inflated by), and six times the memory churn,
    // which is what pushed the scan into the 4 GB heap limit.
    const paths = collectLogPaths(config.logPath);
    const result = tracker.verifyFromLogs(paths);
    syncFull(); // push the recovered collection to subliminal.gg if sync is on
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...result }));
    return;
  }

  // The capture loop saw a blueprint at the Fabrication Kiosk. Decide whether to offer a
  // tick. Posted on EVERY kiosk frame, so the interesting work is all in FabClaims (which
  // refuses to re-prompt, nag, or restart its own timer) — this route only supplies the
  // one thing that module can't know: whether the tracker already accounts for it.
  if (url === "/api/fab/seen" && req.method === "POST") {
    const body = await readBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const item = typeof body.item === "string" && body.item ? body.item : null;
    const items = Array.isArray(body.items) ? body.items.filter((i: unknown) => typeof i === "string") : [];
    const d = fabClaims.seen(
      { item, items, name, enabled: config.fabClaim === true, owned: !!name && tracker.isAlreadyOwned(name) },
      Date.now(),
    );
    // Logged from the SIDECAR, because electron/ stdout goes nowhere on a detached GUI app —
    // and `why` is emitted verbatim so the log can't drift from the rule that produced it.
    if (d.why !== "disabled" && d.why !== "already-owned") {
      console.log(`[fab-claim] ${name || "(unnamed)"}: ${d.why}`);
    }
    if (d.prompt) broadcastMissions();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, why: d.why }));
    return;
  }

  // The player answered a claim prompt. `accept` ticks it (and every same-named sibling);
  // anything else just dismisses. Expiry is enforced inside FabClaims, so a click that
  // lands after the 30s window ticks nothing and says so.
  if (url === "/api/fab/claim" && req.method === "POST") {
    const body = await readBody(req);
    // Accept via BODY (the widget button) or QUERY (the global hotkey, which fires from the
    // shell with no body). Without the query form a hotkey press would read as a dismissal —
    // the opposite of what the player just asked for.
    const accept = body.accept === true || /[?&]accept=1(&|$)/.test(req.url ?? "");
    if (!accept) {
      fabClaims.dismiss();
      broadcastMissions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, added: false, why: "dismissed" }));
      return;
    }
    const p = fabClaims.accept(Date.now());
    const added = p ? tracker.setFabOwned(p.name) : false;
    if (added) {
      console.log(`[fab-claim] ${p!.name}: CONFIRMED at the fabricator -> ticked (source=fab)`);
      syncFull(); // push it to subliminal.gg like any other collection change
    }
    broadcastMissions();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, added, name: p?.name ?? null, why: p ? (added ? "added" : "already-owned") : "expired" }));
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
    // Was the mining scan HUD on screen at all? Reported separately from `kind` because it is
    // true on frames where no signature parsed — which is exactly when the capture loop still
    // needs to know the player is scanning, so it can keep polling fast instead of idling.
    let scanHud = false;
    if (!screenCatalog) screenCatalog = loadCatalog(dataDir);
    if (Array.isArray(body.lines)) {
      // Pre-computed OCR from the main process (RapidOCR reads the fabricator name off a right-
      // panel crop). Classify directly — skip the WinRT OCR entirely for this call.
      const ocr: OcrResult = { w: Number(body.w) || 0, h: Number(body.h) || 0, lines: body.lines };
      result = classifyScreen(ocr, screenCatalog, { scanRegion: config.scanRegion });
      scanHud = hasScanHud(ocr);
    } else if (typeof body.path === "string" && body.path) {
      const ocr = await ocrImage(body.path);
      result = classifyScreen(ocr, screenCatalog, { scanRegion: config.scanRegion });
      scanHud = hasScanHud(ocr);
    }
    // Routing applies to BOTH sources. Mining reads feed its tracker (same process); the
    // mission/fabricator reads are routed by capture.cjs off the returned result.
    const rd = result as { kind?: string; signature?: number; name?: string; items?: string[] };
    if (rd.kind === "refinery") mining.applyRefineryRead(result as never);
    // A mineable is NOT applied here any more. The number alone doesn't prove a scan happened —
    // that's what put "Debris" in the player's ear while they weren't scanning. The caller has
    // the pixels, so it checks the frame for the scan glyph beside the number and comes back via
    // POST /api/mining/scan with the verdict.
    // A fabricator display name can map to several distinct same-named items (e.g. the 3
    // sizes of "Cinch Scraper Module"). Hand back every sibling UUID so the capture loop can
    // share the one captured image across all of them (the log/kiosk can't say which size).
    else if (rd.kind === "fabricator" && rd.name) rd.items = tracker.itemUuidsForName(rd.name);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...(result as object), scanHud }));
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
    // Never echo real secrets back to a page. The Twitch USER TOKEN is one (it can post as the
    // user) and the REFRESH token is worse (it mints new ones indefinitely); the client id is not
    // (it's public by design and the widget needs it to start login).
    // ⚠️ This server also answers on the LAN for OBS browser sources, so anything omitted from
    // this destructure is readable by every device on the network — add new secrets HERE.
    const { syncToken, twitchUserToken, twitchRefreshToken: _refresh, ...rest } = config;
    const syncTokenPreview = syncToken ? `${syncToken.slice(0, 9)}…${syncToken.slice(-4)}` : "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...rest, premium: entitled(), hasSyncToken: !!syncToken, syncTokenPreview, hasTwitchLogin: !!twitchUserToken, resolved: urls, lanHost, port: PORT }));
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
    const entries = Object.keys(cl).sort(cmpDesc).slice(0, 5).map((v) => ({ version: v, notes: clNotes(cl[v]), date: clDate(cl[v]) }));
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

  // Serve the user's chosen binding-chart PNG (for the Binding Chart widget). 404 when unset/missing.
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
    // Which concerns this particular save actually touched — every widget shares this one route
    // (a font-scale tweak in the notepad posts here just like the settings page does), so the
    // expensive work below (reindex, watcher restart, sync) must be scoped to what the request
    // actually carried. Un-scoped, EVERY save — however small — re-ran a network fetch per loadout
    // URL, tore down and rebuilt the log watcher, and re-pushed the whole collection to
    // subliminal.gg, regardless of which field changed.
    const touchedUrls = Array.isArray(body.urls);
    const touchedLogPath = typeof body.logPath === "string";
    const touchedSync = typeof body.syncEnabled === "boolean"
      || (typeof body.syncToken === "string" && body.syncToken.trim().length > 0)
      || body.clearToken === true;
    const touchedShareLogs = typeof body.shareLogs === "boolean";
    if (touchedUrls) config.urls = body.urls.filter((u: unknown) => typeof u === "string" && u);
    if (touchedLogPath) config.logPath = body.logPath;
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
    if (typeof body.fabClaim === "boolean") config.fabClaim = body.fabClaim;
    if (typeof body.miningAssistant === "boolean") config.miningAssistant = body.miningAssistant;
    // The dragged scan region. `null` resets to the default band. Stored as fractions, and only
    // if it's usable: a region dragged off-frame or collapsed to nothing would silently stop all
    // scanning, and "my scanner died and I don't know why" is the worst outcome here.
    if (body.scanRegion === null) config.scanRegion = null;
    else if (body.scanRegion && typeof body.scanRegion === "object") {
      const r = body.scanRegion as ScanRegion;
      const ok = [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n))
        && r.w > 0.02 && r.h > 0.01 && r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.001 && r.y + r.h <= 1.001;
      if (ok) config.scanRegion = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    if (typeof body.miningAutoShow === "boolean") config.miningAutoShow = body.miningAutoShow;
    if (typeof body.miningOpen === "boolean") config.miningOpen = body.miningOpen;
    if (typeof body.notepadOpen === "boolean") config.notepadOpen = body.notepadOpen;
    if (typeof body.notepadFontScale === "number" && isFinite(body.notepadFontScale))
      config.notepadFontScale = Math.max(0.8, Math.min(2, body.notepadFontScale));
    // Twitch login names are alphanumeric + underscore; store lowercase (the embed is case-insensitive).
    if (typeof body.twitchChannel === "string") {
      const ch = body.twitchChannel.trim();
      if (!ch || /^[A-Za-z0-9_]{2,40}$/.test(ch)) config.twitchChannel = ch.toLowerCase();
    }
    if (typeof body.twitchChatOpen === "boolean") config.twitchChatOpen = body.twitchChatOpen;
    if (typeof body.twitchChatFontScale === "number" && isFinite(body.twitchChatFontScale))
      config.twitchChatFontScale = Math.max(0.8, Math.min(2, body.twitchChatFontScale));
    if (typeof body.twitchClientId === "string") config.twitchClientId = body.twitchClientId.trim();
    if (typeof body.scFeedOpen === "boolean") config.scFeedOpen = body.scFeedOpen;
    if (typeof body.unlockAlertOpen === "boolean") config.unlockAlertOpen = body.unlockAlertOpen;
    if (body.scFeedLinkTarget === "site" || body.scFeedLinkTarget === "source") config.scFeedLinkTarget = body.scFeedLinkTarget;
    if (typeof body.scFeedVoice === "boolean") config.scFeedVoice = body.scFeedVoice;
    if (typeof body.scFeedSound === "boolean") config.scFeedSound = body.scFeedSound;
    if (typeof body.scFeedVolume === "number" && isFinite(body.scFeedVolume))
      config.scFeedVolume = Math.max(0, Math.min(1, body.scFeedVolume));
    if (typeof body.scFeedTone === "string") config.scFeedTone = body.scFeedTone;
    if (typeof body.partyOpen === "boolean") config.partyOpen = body.partyOpen;
    if (typeof body.battagliaOpen === "boolean") config.battagliaOpen = body.battagliaOpen;
    if (typeof body.webViewOpen === "boolean") config.webViewOpen = body.webViewOpen;
    // http/https only — this string ends up as an iframe src.
    if (typeof body.webViewUrl === "string") {
      const raw = body.webViewUrl.trim();
      if (!raw) config.webViewUrl = "";
      else {
        try {
          const u = new URL(raw);
          if (u.protocol === "http:" || u.protocol === "https:") config.webViewUrl = u.toString();
        } catch { /* keep the previous value on an unparseable URL */ }
      }
    }
    if (typeof body.bindingChartOpen === "boolean") config.bindingChartOpen = body.bindingChartOpen;
    if (typeof body.miningTone === "string") config.miningTone = body.miningTone;
    // GPU accel is read by electron/main.cjs at startup; persist here, restart applies it.
    if (typeof body.hwAccel === "boolean") config.hwAccel = body.hwAccel;
    if (typeof body.amdCompat === "boolean") config.amdCompat = body.amdCompat;
    if (typeof body.bindingPng === "string") config.bindingPng = body.bindingPng;
    // 🔑 An EMPTY hotkey is a real value: "this action has no hotkey". The `&& .trim()` guard these
    // used to carry silently discarded it, so Settings could clear a hotkey, the shell would
    // unregister it, and the next config read handed the old key straight back. A hotkey is
    // rebindable and now also REMOVABLE; only an absent field falls back to the default.
    if (typeof body.bindingHotkey === "string") config.bindingHotkey = body.bindingHotkey.trim();
    if (typeof body.overlayHotkey === "string") config.overlayHotkey = body.overlayHotkey.trim();
    if (typeof body.miningHotkey === "string") config.miningHotkey = body.miningHotkey.trim();
    if (typeof body.webViewHotkey === "string") config.webViewHotkey = body.webViewHotkey.trim();
    if (typeof body.notepadHotkey === "string") config.notepadHotkey = body.notepadHotkey.trim();
    // Clamped SERVER-side as well as in the input: a hand-edited config.json with 0 (or a string)
    // would otherwise make a notifier vanish instantly or never leave, with no control to undo it.
    const showSecs = (v: unknown, fallback: number): number =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(3, Math.min(60, Math.round(v))) : fallback;
    // Clamped to one screen's worth in each direction: enough for any real misalignment, and a
    // typo can never fling the canvas somewhere the user cannot find it to nudge it back.
    const nudge = (v: unknown, fallback: number): number =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(-4000, Math.min(4000, Math.round(v))) : fallback;
    if (body.canvasOffsetX !== undefined) config.canvasOffsetX = nudge(body.canvasOffsetX, config.canvasOffsetX);
    if (body.canvasOffsetY !== undefined) config.canvasOffsetY = nudge(body.canvasOffsetY, config.canvasOffsetY);
    // Canvas scale, same reasoning as the nudge: clamped here as well as in the UI, because 0 (or
    // a string, or a hand-edited 40) collapses the whole canvas to a dot with no visible control
    // left to undo it. 0.5–3 covers every real Windows scaling ratio (a 225% primary beside 100%
    // side monitors is the worst case seen) with room either side.
    const canvasZoom = (v: unknown, fallback: number): number =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(0.5, Math.min(3, Math.round(v * 100) / 100)) : fallback;
    if (body.canvasScale !== undefined) config.canvasScale = canvasZoom(body.canvasScale, config.canvasScale);
    if (body.scFeedShowSeconds !== undefined) config.scFeedShowSeconds = showSecs(body.scFeedShowSeconds, config.scFeedShowSeconds);
    if (body.unlockAlertShowSeconds !== undefined) config.unlockAlertShowSeconds = showSecs(body.unlockAlertShowSeconds, config.unlockAlertShowSeconds);
    if (typeof body.interactHotkey === "string") config.interactHotkey = body.interactHotkey.trim();
    if (typeof body.holdToInteract === "boolean") config.holdToInteract = body.holdToInteract;
    if (typeof body.moveHotkey === "string") config.moveHotkey = body.moveHotkey.trim();
    if (typeof body.fabClaimHotkey === "string") config.fabClaimHotkey = body.fabClaimHotkey.trim();
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
    // Scoped to what actually changed (see touchedUrls etc. above) — a save that never touched
    // these fields has no reason to refetch every loadout URL, tear down the log watcher mid-
    // session, or push a sync/entitlement round-trip to subliminal.gg.
    if (touchedUrls) await reindex();
    if (touchedLogPath) startWatcher();
    // Re-arm sync with the new settings and reconcile the full collection.
    if (touchedSync) {
      if (sync.configure(config.syncToken, config.syncEnabled)) syncFull();
      // A changed token → re-resolve subscriber entitlement now (don't wait for the 20-min tick).
      void pollEntitlement();
    }
    // If log-sharing was just turned on, upload the current session now.
    if (touchedShareLogs) void maybeShareLog(config, APP_VERSION, sharedLogStatePath);
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

  // A mission giver's grind track (the Battaglia widget): standing ladder, your position on it,
  // and what each rank unlocks. ?giver= overrides the default so the widget can retire/retarget
  // without a code change when 4.10 lands.
  if (url === "/api/grind-track" && req.method === "GET") {
    const giver = new URL(req.url ?? "", "http://x").searchParams.get("giver")?.trim() || "Recco Battaglia";
    const track = tracker.giverTrack(giver);
    res.writeHead(track ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(track ?? { error: "unknown_giver", giver }));
    return;
  }

  // Sell-price summary for an ore/commodity (low / average / high across every terminal that
  // buys it). Sourced from the BUNDLED commodity data - no UEX call, works offline.
  if (url === "/api/commodity-price" && req.method === "GET") {
    const want = (new URL(req.url ?? "", "http://x").searchParams.get("name") ?? "").trim().toLowerCase();
    const all = Object.values(economy.commodities()) as Array<{ name?: string; kind?: string | null; bestSell?: number | null; prices?: Array<{ sell?: number | null; terminal?: string | null }> }>;
    // Exact name first, then the refined/ore variants people actually type ("aluminum" should
    // find "Aluminum", not "Aluminum (Ore)" or a MineableRock_ entity).
    const norm = (n: string) => n.toLowerCase().replace(/\s*\(.*\)\s*/g, "").trim();
    const named = all.filter((c) => c.name && c.kind !== "mineable");
    const match =
      named.find((c) => c.name!.toLowerCase() === want) ??
      named.find((c) => norm(c.name!) === want) ??
      named.find((c) => norm(c.name!).startsWith(want) && want.length >= 3) ??
      null;
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "unknown_commodity", name: want }));
      return;
    }
    const sells = (match.prices ?? []).map((p) => Number(p.sell) || 0).filter((v) => v > 0);
    const summary = sells.length
      ? {
          low: Math.min(...sells),
          avg: Math.round(sells.reduce((a, b) => a + b, 0) / sells.length),
          high: Math.max(...sells),
          quotes: sells.length,
        }
      : { low: null, avg: null, high: null, quotes: 0 };
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ name: match.name, best: match.bestSell ?? null, ...summary }));
    return;
  }

  // Will this URL actually load in an iframe? A page can refuse via X-Frame-Options or a CSP
  // frame-ancestors directive, and the browser gives the embedder NO usable error — you just get a
  // blank box. So check server-side first and say so plainly.
  // 🔑 Follow redirects and read the FINAL response's headers: www.erkul.games 301s to
  // erkul.games, and only the destination carries `X-Frame-Options: DENY` — reading the redirect's
  // headers is exactly how this was misdiagnosed as "erkul allows framing".
  if (url === "/api/can-embed" && req.method === "GET") {
    const target = (new URL(req.url ?? "", "http://x").searchParams.get("url") ?? "").trim();
    let embeddable = true, reason = "", finalUrl = target;
    try {
      const u = new URL(target);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
      const r = await fetch(u, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36" },
        signal: AbortSignal.timeout(8000),
      });
      finalUrl = r.url || target;
      const xfo = (r.headers.get("x-frame-options") ?? "").toLowerCase();
      const csp = (r.headers.get("content-security-policy") ?? "").toLowerCase();
      const fa = csp.match(/frame-ancestors([^;]*)/)?.[1] ?? "";
      if (xfo.includes("deny")) { embeddable = false; reason = "sends X-Frame-Options: DENY"; }
      else if (xfo.includes("sameorigin")) { embeddable = false; reason = "sends X-Frame-Options: SAMEORIGIN"; }
      else if (fa && (fa.includes("'none'") || (!fa.includes("*") && !fa.includes("http")))) {
        embeddable = false; reason = "its security policy blocks embedding (frame-ancestors)";
      }
    } catch {
      // Unreachable or timed out — let the iframe try anyway rather than blocking on a bad check.
      reason = "";
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ embeddable, reason, finalUrl }));
    return;
  }

  // Twitch sign-in, for SENDING chat only — reading needs none of this and keeps working signed
  // out. POST starts the device flow, GET is the widget's poll, DELETE signs out.
  // Loopback only: these speak for the signed-in account, and the server is on the LAN.
  if (url.startsWith("/api/twitch/") && !fromThisMachine(req)) {
    res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, message: "Only this machine can sign in or send." }));
    return;
  }
  if (url === "/api/twitch/login" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(await startTwitchLogin()));
    return;
  }
  if (url === "/api/twitch/login" && req.method === "GET") {
    // A token revoked on twitch.tv must read as signed OUT here, or the widget offers a send box
    // that can only fail. Checked once on the first ask after a restart, not on every poll.
    if (twitchLogin.state === "idle" && config.twitchUserToken) {
      const v = await twitchAuth();
      twitchLogin = v ? { state: "ok", login: v.login } : { state: "idle" };
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(twitchLogin));
    return;
  }
  if (url === "/api/twitch/login" && req.method === "DELETE") {
    stopTwitchPoll();
    // Best-effort revoke so signing out here actually ends the grant, not just forgets it locally.
    if (config.twitchUserToken) {
      void fetch("https://id.twitch.tv/oauth2/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.twitchClientId.trim(), token: config.twitchUserToken }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => { /* the local clear below is what matters */ });
    }
    config.twitchUserToken = "";
    config.twitchRefreshToken = "";
    config.twitchUserLogin = "";
    await saveConfig();
    twitchLogin = { state: "idle" };
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(twitchLogin));
    return;
  }
  // Send a chat message as the signed-in user. 500 is Twitch's own limit for a chat message.
  if (url === "/api/twitch/send" && req.method === "POST") {
    const body = await readBody(req);
    const text = String(body?.text ?? "").trim().slice(0, 500);
    const r = text ? await twitchSend(text) : { ok: false, message: "Nothing to send." };
    res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(r));
    return;
  }

  // Who is answering on this port. Deliberately the cheapest route here — no disk, no network —
  // because the shell polls it on every launch before it will trust this process.
  // 🔑 `instance` is a nonce the shell mints per launch and injects, so a match proves this is the
  // sidecar THAT shell spawned. Version alone is not enough: two builds of the same version (a dev
  // run and an installed one) are exactly the case that bit us — an orphaned sidecar kept the port
  // and the new app silently served its stale data.
  if (url === "/api/instance" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      instance: process.env.SC_INSTANCE || null,
      version: APP_VERSION || null,
      pid: process.pid,
    }));
    return;
  }

  // The first-run setup wizard's view of the world: which of its steps are ALREADY satisfied,
  // so it can auto-complete them instead of making a user redo work the app can see is done.
  // 🔑 Carries no secret — the token is a verdict, never the string (same rule as diagnostics).
  if (url === "/api/setup" && req.method === "GET") {
    const logPath = config.logPath || "";
    let logFound = false;
    let logChannel = "";
    try {
      if (logPath && existsSync(logPath) && statSync(logPath).isFile()) {
        logFound = true;
        logChannel = basename(dirname(logPath));
      }
    } catch { /* unreadable path — logFound stays false, which is the answer */ }

    const token = await verifySyncToken();
    // "Skipped" is a real resolution, so a step is DONE when the app can see it done OR the
    // user said to move on. What must never happen is a step passing silently on neither.
    const steps = {
      gameLog: { done: logFound, path: logPath, channel: logChannel, live: logFound && isLiveLog(logPath) },
      connect: { done: token === "ok", token, syncEnabled: config.syncEnabled === true },
      settings: { done: config.setupSettingsReviewed === true },
      share: { done: config.setupShareResolved === true, optional: true },
    };
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      // `freshInstall` is decided at startup, before anything can write a config — see the
      // comment there for why an absent `setupDone` can't stand in for it.
      freshInstall,
      setupDone: config.setupDone === true,
      nudgeDismissed: config.setupNudgeDismissed === true,
      steps,
    }));
    return;
  }

  // The wizard records progress here. Each field is independent so a user who resolves one
  // step and quits keeps that step — the wizard is resumable, not all-or-nothing.
  if (url === "/api/setup" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.settingsReviewed === "boolean") config.setupSettingsReviewed = body.settingsReviewed;
    if (typeof body.shareResolved === "boolean") config.setupShareResolved = body.shareResolved;
    if (typeof body.done === "boolean") config.setupDone = body.done;
    // Dismissing the nudge and finishing the wizard both mean "never nag me again", so
    // finishing implies dismissal — otherwise a user who completes setup from the banner
    // would still see the banner on the next launch.
    if (body.dismissNudge === true || body.done === true) config.setupNudgeDismissed = true;
    await saveConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Everything this process can say about its own health, in one request. Support threads are
  // otherwise a guessing game — "it stopped working" with no way to tell a dead sidecar from a
  // missing game.log from an expired token. The Settings button copies this to the clipboard.
  // 🔑 It must NEVER carry a secret: the sync token is reduced to a yes/no plus a live check,
  // and the log PATH is included but never its contents.
  if (url === "/api/diagnostics" && req.method === "GET") {
    const logPath = config.logPath || "";
    let logStat: { exists: boolean; sizeMB?: number; modifiedMinutesAgo?: number } = { exists: false };
    try {
      if (logPath && existsSync(logPath)) {
        const st = statSync(logPath);
        logStat = {
          exists: true,
          sizeMB: Math.round((st.size / 1048576) * 10) / 10,
          modifiedMinutesAgo: Math.round((Date.now() - st.mtimeMs) / 60000),
        };
      }
    } catch { /* an unreadable path is itself the answer: exists stays false */ }

    // Can we actually WRITE where everything is persisted? An EPERM here (Program Files) once
    // killed the sidecar invisibly, and it presents as "nothing saves" rather than as an error.
    let userDirWritable = false;
    try {
      mkdirSync(userDir, { recursive: true });
      const probe = join(userDir, ".write-probe");
      await writeFile(probe, "ok");
      rmSync(probe, { force: true });
      userDirWritable = true;
    } catch { /* stays false */ }

    // Is the sync token still good? Ask the site rather than trusting that a non-empty string works.
    const syncToken = await verifySyncToken();

    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      app: { version: APP_VERSION || "unknown", sidecarPort: PORT, uptimeMinutes: Math.round(process.uptime() / 60) },
      gameLog: { path: logPath || "(not set)", ...logStat, watching: watcher ? "yes" : "no" },
      // `userDirWritable` probes the DIRECTORY; `configSave` reports what actually happened to
      // config.json. They can disagree — a writable dir with an unwritable config file is a real
      // state, and it presents as "none of my settings stick" with nothing else to go on.
      data: {
        patch: tracker.view().patch ?? "(none loaded)", userDir, userDirWritable,
        configPath,
        configSave: lastSaveError
          ? { ok: false, at: lastSaveError.at, error: lastSaveError.error }
          : { ok: true, lastSavedAt: lastSaveOk ?? "(not saved this session)" },
      },
      // `enabled` is the user's setting; `active` is whether sync can actually push. They differ
      // when SC_NO_SYNC is set (the throwaway first-run profile), and reporting only the setting
      // made diagnostics say sync was on while every push was being refused.
      sync: { enabled: config.syncEnabled === true, active: sync.active, token: syncToken },
      screenReading: {
        fabCapture: config.fabCapture === true,
        missionOcr: config.missionOcr === true,
        fabClaim: config.fabClaim === true,
        miningAssistant: config.miningAssistant === true,
        shareLogs: config.shareLogs === true,
      },
      display: { hwAccel: config.hwAccel === true, amdCompat: config.amdCompat === true, theme: config.theme || "mobiglas" },
      twitch: { chatChannel: config.twitchChannel || "(none)", signedInAs: config.twitchUserLogin || "(not signed in)" },
      // Mixed-DPI is the one class of bug that is INVISIBLE from a machine whose monitors all
      // match, and the reports that reach us ("it's offset", "it vanished") can't distinguish a
      // window in the wrong place from a canvas laid out at the wrong scale. These are the numbers
      // that tell them apart, so they belong in the paste-able report rather than in a log file.
      geometry: overlayGeometry ?? "(the overlay has not reported yet — is it switched off?)",
      // Standing per giver plus the completion count behind it. A sum out of proportion to the
      // count is an accrual leak, and the count is the half that makes the sum interpretable.
      reputation: tracker.repDiagnostics(),
    }));
    return;
  }

  // Where the overlay window ACTUALLY is, and what the canvas made of it. Reported by the shell
  // (only it can see `screen` and the window's real bounds) and by the canvas page (only it knows
  // what it rendered), because a mixed-DPI fault can live in either half.
  // 🔑 In memory only, and last-write-wins: this is a snapshot of a live window, so persisting it
  // would just serve a stale answer after a monitor change.
  if (url === "/api/overlay-geometry" && req.method === "POST") {
    const body = await readBody(req);
    if (body && typeof body === "object") {
      overlayGeometry = { ...(overlayGeometry ?? {}), ...body, at: new Date().toISOString() };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url === "/api/overlay-geometry" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(overlayGeometry ?? {}));
    return;
  }

  // The verdict on a signature the screen-read found: did the frame also show the scan glyph
  // beside it? Only the caller can answer that (it holds the bitmap; this process only ever sees
  // the OCR's text). Unconfirmed numbers still resolve a KNOWN rock — a table hit is its own
  // evidence — but they can't announce debris, which is where the false call-outs came from.
  if (url === "/api/mining/scan" && req.method === "POST") {
    const body = await readBody(req);
    const signature = Number(body?.signature);
    // Logged HERE, not in the caller: the caller is a detached GUI process whose stdout goes
    // nowhere, while this lands in sidecar.log — the file a user can read and send. Every read
    // prints its numbers, so the colour band can be tuned from real scans instead of the single
    // frame it was built from.
    const g = body?.glyph as { fraction?: number; total?: number; mean?: number[]; hitMean?: number[]; ref?: { mean: number[]; lum: number; lumFloor: number } } | undefined;
    if (Number.isFinite(signature)) {
      // The tracker owns the rules, so it also says what it did with the read — one place to
      // change, and the log can never drift out of step with the behaviour it describes.
      const outcome = mining.applyMineableRead(signature, body?.confirmed === true);
      console.log(
        `[mining] signature ${signature} — glyph ${body?.confirmed === true ? "FOUND" : "not found"}` +
        (g ? ` (${Math.round((g.fraction ?? 0) * 100)}% of ${g.total}px, box mean rgb ${g.mean}` +
             `${g.hitMean ? `, matched mean rgb ${g.hitMean}` : ""}` +
             `${g.ref ? `, ref ink rgb ${g.ref.mean} lum ${g.ref.lum} floor ${g.ref.lumFloor}` : ""})` : "") +
        // Cadence rides along so "it feels slower in this ship" is answerable from the log. It
        // used to be console.log'd in capture.cjs, i.e. into the void — that process has no stdout.
        ` — polling ${body?.pollMs ?? "?"}ms${body?.scanHud === true ? "" : " (no HUD words seen)"}` +
        ` — ${outcome.why}`,
      );
      // Every read, ANNOUNCED OR NOT, so the "scan read area" outline can print what the OCR saw.
      // The rejected ones are the whole point: a number the app refused is exactly what a player
      // needs to see next to the one on their screen. Rect goes out as FRACTIONS of the frame so
      // the canvas can place and size it on any resolution.
      const t = body?.text as { x?: number; y?: number; w?: number; h?: number } | undefined;
      const fr = body?.frame as { w?: number; h?: number } | undefined;
      const frac = t && fr?.w && fr?.h
        ? { x: (t.x ?? 0) / fr.w, y: (t.y ?? 0) / fr.h, w: (t.w ?? 0) / fr.w, h: (t.h ?? 0) / fr.h }
        : null;
      // `signature` stays what the OCR actually read — that is the whole point of the readout. When
      // a 6/8 digit was repaired, `repairedFrom` carries the original so the two can be told apart.
      miningSend({
        kind: "read", signature, raw: typeof body?.raw === "string" ? body.raw : null,
        box: frac, confirmed: body?.confirmed === true, repairedFrom: outcome.repairedFrom ?? null,
        verdict: outcome.verdict, announced: outcome.announced, used: outcome.used,
        why: outcome.why, at: Date.now(),
      });
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Dev replay ────────────────────────────────────────────────────────────────────────
  // Simulate a mission ending so the report card and its questions can be tested without
  // playing. Feeds real log LINES through the real parser into the live tracker.
  // 🔑 Gated THREE ways, because this writes to the real collection: dev builds only
  // (`SC_DEV` is set by main.cjs on the non-packaged spawn and by nothing else), loopback only,
  // and it can only "receive" a blueprint the player already owns.
  // Let the overlay WINDOW write a line into sidecar.log. It's a detached GUI process with no
  // console, so this is the only way anything it observes becomes readable — see the comment on
  // mrNote() in missions.html. Same dev+loopback gate as the replay below.
  if (url === "/api/dev/note" && req.method === "GET") {
    if (process.env.SC_DEV === "1" && fromThisMachine(req)) {
      console.log(`[overlay] ${new URL(req.url ?? "/", "http://localhost").searchParams.get("msg") ?? ""}`);
    }
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (url === "/api/dev/replay") {
    if (process.env.SC_DEV !== "1" || !fromThisMachine(req)) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "not available" }));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ scenarios: SCENARIOS }));
      return;
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const s = SCENARIOS.find((x) => x.id === (body as { scenario?: string })?.scenario);
      if (!s) {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "unknown scenario", known: SCENARIOS.map((x) => x.id) }));
        return;
      }
      // Only ever re-receive something already owned — see dev-replay.ts. A scenario that wants
      // a drop but finds nothing owned still runs; it just has no blueprint, and says so.
      const blueprint = s.drop ? tracker.ownedPoolBlueprint(s.contractKey) : null;
      // Pin `now` so the completion timestamp we hand back is exactly the one the card will
      // carry. The CLI compares them: without that it happily reports the PREVIOUS run's card
      // as this run's success, which it did for the abandon scenario.
      const now = Date.now();
      const lines = replayLines(s, replayMissionId(++replaySeq), blueprint, now);
      for (const line of lines) {
        const ev = parseMissionEvent(parseLine(line));
        if (ev) { tracker.apply(ev); party.apply(ev); }
      }
      // Force the tiles for this simulated run. The receipt above genuinely happened, but it
      // cannot move an already-owned blueprint's unlock date into the window the report reads
      // from — see forceCompletionBlueprints() for the full reason.
      if (blueprint) tracker.forceCompletionBlueprints([blueprint]);
      console.log(`[dev-replay] ${s.id} — ${lines.length} lines, blueprint=${blueprint ?? "none"}`);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ok: true, scenario: s.id, lines: lines.length, blueprint, at: new Date(now).toISOString(),
        outcome: s.outcome,
        note: s.drop && !blueprint ? "you own nothing in this mission's pool, so it ran without a drop" : null,
      }));
      return;
    }
  }

  // Crowdsourced mission facts. POST one answer from the completion report; GET reads back
  // what this player already said about a contract so the report can pre-select it.
  // 🔑 `url` is already stripped of its query string, so the key comes off `req.url` — a route
  // written as `url.startsWith("/api/mission-feedback?")` could never match.
  if (url === "/api/mission-feedback" && req.method === "POST") {
    const body = await readBody(req);
    const saved = missionFeedback.record({ ...(body as object), changelist: tracker.view().build, appVersion: APP_VERSION });
    // Push straight away so an answer reaches the site while the player is still at their
    // desk; the interval above is only the retry path. Deliberately not awaited — the
    // report card must never wait on the network to acknowledge a click.
    if (saved) void flushMissionFeedback();
    res.writeHead(saved ? 200 : 400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(saved ? { ok: true, answer: saved } : { ok: false, error: "no answers in submission" }));
    return;
  }
  if (url === "/api/mission-feedback" && req.method === "GET") {
    const key = new URL(req.url ?? "/", "http://localhost").searchParams.get("key");
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ answer: missionFeedback.get(key), total: missionFeedback.count() }));
    return;
  }

  // Party roster: members + their % cut, plus the live detected party size and the handles
  // harvested from the log for autocomplete. POST replaces the whole member list.
  if (url === "/api/party" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(party.view()));
    return;
  }
  // Saved splits. A crew often can't settle up until the ore is refined and sold, which may be
  // days and several sessions later — so a split has to be storable and recoverable. Each save
  // also writes a plain-text twin they can read without the app (see PartyTracker.renderText).
  if (url === "/api/party/sessions" && req.method === "POST") {
    const body = await readBody(req);
    const saved = await party.saveSession(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, session: saved, folder: party.sessionFolder(), view: party.view() }));
    return;
  }
  if (url === "/api/party/session" && req.method === "GET") {
    const id = new URL(req.url ?? "", "http://x").searchParams.get("id") ?? "";
    const s = party.getSession(id);
    res.writeHead(s ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(s ?? { error: "not_found" }));
    return;
  }
  if (url === "/api/party/session" && req.method === "DELETE") {
    const id = new URL(req.url ?? "", "http://x").searchParams.get("id") ?? "";
    await party.deleteSession(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, view: party.view() }));
    return;
  }

  if (url === "/api/party" && req.method === "POST") {
    const body = await readBody(req);
    party.setMembers(body?.members);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(party.view()));
    return;
  }

  // SC Feed alert tone: the user's WAV if they picked one, else 404 so the widget falls back
  // to its built-in synth tone (mirrors /api/mining/tone).
  if (url === "/api/scfeed/tone" && req.method === "GET") {
    try {
      if (config.scFeedTone && existsSync(config.scFeedTone)) {
        res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
        res.end(readFileSync(config.scFeedTone));
        return;
      }
    } catch { /* fall through */ }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no_tone" }));
    return;
  }

  // SC Feed (OmniFeed) headlines for the SC Feed widget — proxied + flattened, see scFeedItems().
  if (url === "/api/scfeed" && req.method === "GET") {
    const items = await scFeedItems();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ items, fetchedAt: new Date(scFeedCache.at).toISOString() }));
    return;
  }

  // Notepad: local-only scratch notes (see overlay/notepad.html). GET reads the list;
  // POST replaces it with the widget's full array (debounced client-side on edit).
  if (url === "/api/notes" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ notes: readNotes() }));
    return;
  }
  if (url === "/api/notes" && req.method === "POST") {
    const body = await readBody(req);
    const notes = sanitizeNotes(body?.notes);
    await saveNotes(notes);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: notes.length }));
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
}

// Last line of defence. Node exits on an unhandled rejection, and this process is spawned with no
// terminal — so without this, a stray throw anywhere (a timer, the watcher, an SSE write to a
// socket that just went away) ends the sidecar leaving nothing behind to say why. Log the stack,
// then exit so the shell's restart takes over: a crashed sidecar that stays dead is worse.
process.on("uncaughtException", (e) => {
  console.error("[server] uncaught exception:", e?.stack ?? String(e));
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("[server] unhandled rejection:", (e as Error)?.stack ?? String(e));
  process.exit(1);
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
