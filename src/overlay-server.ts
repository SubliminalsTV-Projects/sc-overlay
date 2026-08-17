import { createServer, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { writeFile } from "node:fs/promises";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFile, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, dirname, basename, resolve, sep } from "node:path";

import { LogWatcher } from "./watcher.js";
import { parseLine } from "./parser.js";
import { parseMissionEvent } from "./missions-parser.js";
import { PlaceWatcher, SystemWatcher, debrisStepWording, type Place } from "./location.js";
import { PartyTracker, ownHandleFromLog } from "./party.js";
import { MissionTracker } from "./missions.js";
import { collectLogPaths } from "./log-paths.js";
import { MiningTracker } from "./mining.js";
import { HaulingTracker } from "./hauling.js";
import { ChatClient } from "./chat.js";
import { MiningEconomyStore } from "./mining-economy.js";
import { HaulingDataStore } from "./hauling-data.js";
import { canAutoLoad } from "./hauling-autoload.js";
import { buildHaulingPlan } from "./hauling-plan.js";
import {
  buildContracts, climbToNextRung, rankContracts, regimeFor, rungAt, HAULING_LADDER,
  type AdvisorContract,
} from "./hauling-advisor.js";
import { MissionFeedbackStore } from "./mission-feedback.js";
import { FabClaims } from "./fab-claim.js";
import { SCENARIOS, replayLines, replayMissionId, HAUL_SCENARIOS, haulReplayLines } from "./dev-replay.js";
import { SiteSync } from "./sync.js";
import { assetDir } from "./paths.js";
import { loadCatalog, ocrImage, ocrSelfTest, hasScanHud, classifyScreen, bestSignatureLine, glyphSearchBox, contractRegionOrDefault, DEFAULT_CONTRACT_REGION, type CatalogEntry, type OcrHealth, type OcrResult, type ScanRegion } from "./screen-read.js";
import { parseContractList } from "./contract-list.js";
import { ContractMatcher } from "./contract-match.js";
import { PayoutScanner, type PayoutObservation } from "./payout-scan.js";
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
  logPath: string;
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
  /** DEV BUILDS ONLY — writes the bitmaps the mining OCR is handed to <userDir>/debug-frames,
   *  served at GET /api/mining/debug-frame. Those bitmaps are screenshots of the user's desktop,
   *  and this app's position on screen reading is that it never happens unless you ask for it — so
   *  this is gated on SC_DEV here AND on app.isPackaged in main.cjs, rather than trusted to a
   *  config flag a release could ship or a stale config.json could arm. Off by default either way. */
  miningDebug: boolean;
  /** Where the signature number is hunted, as fractions of the frame. Null = the default band.
   *  Set by dragging the "scan read area" box (Mining Scanner cog) — the only way to cope with a
   *  HUD that doesn't sit where we assume. */
  scanRegion: ScanRegion | null;
  /** OPT-IN, OFF BY DEFAULT, and 🔑 DELIBERATELY NOT PERSISTED — it is reset to false on
   *  every launch. Sub's call (2026-08-11): "I want it to be more like they can
   *  temporarily turn this thing on."
   *
   *  That is the right shape for this specifically. Every other opt-in here (fabCapture,
   *  missionOcr, miningAssistant) is a standing preference you tick once, and those read
   *  the screen for YOUR benefit, live. This one reads the screen to gather data for a
   *  shared dataset, which is a different bargain — nobody should discover months later
   *  that a box they ticked once has been quietly screen-reading ever since. You turn it
   *  on for a sweep and it is off again next launch.
   *
   *  ⚠️ It stays in the config OBJECT (rather than a bare module variable) so every
   *  existing reader — capture.cjs polls the config each tick — keeps working unchanged;
   *  it is simply stripped on save. The QUEUE is persisted separately, so ending a session
   *  never loses gathered observations. */
  payoutScan: boolean;
  /** Where the offers PANEL sits, as fractions of the frame. Null = not calibrated, and
   *  the scan will not run without it: the parser needs the panel to tell the title column
   *  from the amount column, and guessing produced garbage (the bottom nav pushed the
   *  column boundary past the amounts and every row read as priceless). */
  contractRegion: ScanRegion | null;
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
  /** Remembers whether the Hauling widget was left open, so it's restored on launch. */
  haulingOpen: boolean;
  /** Ship class the player picked in the Hauling widget, overriding what the log saw. Empty =
   *  trust the log. Persisted because the log's ship signal is not guaranteed — a relog, or
   *  taking off in a ship the vehicle-control lines never named, leaves it blank. */
  haulingShip: string;
  /**
   * Places the player has named by hand, keyed by the hauling planner's own location id.
   *
   * 🔑 THAT ID IS THE COORDINATES, rounded to the kilometre (see posKey in hauling-plan.ts) — not a
   * zoneHostId, which the game reissues every session and which would make every saved name go
   * stale overnight. A marker's position is byte-identical across days, so naming a place once
   * names it for good.
   *
   * Why it has to exist at all: only a TRACKED drop-off carries a name (the Deliver line's "… to
   * <D>"), so a pickup site, or any leg the player never tracked, shows as "Site 1". Sub has asked
   * for this four times.
   */
  haulingPlaces: Record<string, string>;
  /**
   * Every place name the GAME has ever stated on a Deliver line, newest last.
   *
   * 🔴 This is the good half of the suggestion list, and it is not optional garnish. locations.json
   * carries 1,968 rows and **does not contain "Riker Memorial Spaceport"** — nor any other city
   * spaceport; it has `Area18` but not the spaceport inside it. A picker built only from the
   * dataset would fail on Sub's single most common drop-off. Names the game has actually used on a
   * hauling contract are by definition real hauling stops, so they rank above the dataset.
   */
  haulingSeenPlaces: string[];
  /* ⛔ NO haulingRank / haulingRep. A picker was built here and it was wrong twice over, both
     caught by Sub within minutes:
       1. The app ALREADY KNOWS. MissionTracker.repDiagnostics() carries every giver's witnessed
          standing, accrued from every log backup — his Covalex read 5,400 (Member) while the
          widget was asking him to type it. Asking for a number you hold is not a fallback, it is
          a bug with a text box on it.
       2. "The player cannot know their rep value" — correct. mobiGlas draws a bar, not an
          integer. The only place he could read the number is this app, so a box asking him for it
          is circular.
     Standing is read live, per giver. See the advisor endpoint. */
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
  /** Per-widget show/hide hotkeys, keyed by REGISTRY key (mining, party, chat, …).
   *
   *  🔑 One map instead of a scalar per widget. Four widgets had a hand-written config field, a
   *  hand-written shell registration and a hand-written settings row each, and the other seven had
   *  no hotkey at all — so "every widget gets one" meant writing that boilerplate seven more times
   *  and again for every widget ever added. A map keyed on the registry key means a new widget
   *  gets a hotkey for free.
   *  🔑 NO DEFAULTS (Sub, 2026-08-14: "we don't even necessarily need to put in a default"). An
   *  absent entry means no hotkey, which is also the only safe answer — eleven default chords
   *  would collide with each other, with the game, and with whatever the player already uses.
   *  ⚠️ `""` is a REAL saved value meaning "removed", distinct from absent. The legacy migration
   *  below depends on that distinction. */
  widgetHotkeys: Record<string, string>;
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
  /** How opaque the overlay is while you are NOT focused on it — i.e. while you are playing.
   *  1 = off (the default, so nobody's overlay changes appearance on update); clamped 0.2–1 in
   *  the UI, the server AND the shell, because an overlay faded to nothing is one you can't
   *  find to turn back up. Read by electron/main.cjs, which applies it as WINDOW opacity. */
  unfocusedOpacity: number;
  /** Global hotkey that forces full opacity regardless of focus (and back). Lets you read the
   *  overlay mid-fight without alt-tabbing to it. Empty = no hotkey. */
  opacityHotkey: string;
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
  /** Remembers whether the Chat widget was left open — and is also the CONNECTION gate:
   *  chat holds no socket unless the widget is open (Sub's lightweight rule). */
  chatOpen: boolean;
  /** WebSocket URL of the chat server (chat-server/server.mjs protocol). Defaults to the
   *  subliminal.gg deployment; point it at ws://127.0.0.1:8788/ws for local dev. */
  chatServerUrl: string;
  /** Dev-mode chat identity for the A/B. Production identity comes from the sync token —
   *  the site resolves it to the RSI-VERIFIED handle, and unverified accounts get no chat
   *  (Sub's rule: chat identities must be bannable). */
  chatHandle: string;
  /** Custom chat rooms the user has joined, by DISPLAY NAME. Rejoined on every connect, so a
   *  restart lands you back in the same channels. The client owns this list; the sidecar only
   *  persists what it reports. */
  chatChannels: string[];
  /** Share what you're doing (the contract you're running, or that you're scanning rocks) with
   *  the people in your chat channels.
   *  🔴 OFF by default, and it stays that way for the same reason publishing your shard on a
   *  party listing is opt-in per listing: nothing may leak from merely having the widget open.
   *  This is the one thing an external chat can show that the game's own social panel cannot —
   *  it comes off game.log — which is exactly why it has to be asked for rather than assumed. */
  chatShareActivity: boolean;
  /** Be invisible in the channels that identify WHERE you are — your server (region) and Nearby
   *  (DGS). Global, your org and custom rooms are unaffected: this hides a location, not a
   *  person.
   *  🔑 Enforced by not SENDING the location at all (see ChatClient.setHideLocation), so the
   *  shard never reaches a machine the player does not own. A server-side "hide me" flag would
   *  still have published it and merely declined to show it. */
  chatHideLocation: boolean;
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
  logPath: "C:\\Program Files\\Roberts Space Industries\\StarCitizen\\GAME\\game.log",
  syncToken: "",
  syncEnabled: false,
  fabCapture: false,
  missionOcr: false,
  fabClaim: false,
  miningAssistant: false,
  miningDebug: false,
  scanRegion: null,
  payoutScan: false,
  // 🔑 A REGION, never null. `null` used to mean "not calibrated yet", and the settings card
  // disabled the Start button until one existed — while the only surface that could set one was
  // the box that appears once scanning is armed. Nobody but Sub (who had POSTed his own) could
  // ever get past it. Everyone now starts from the measured default and DRAGS it if it's wrong,
  // which turns calibration from a precondition into a correction.
  contractRegion: DEFAULT_CONTRACT_REGION,
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
  haulingOpen: false,
  haulingShip: "",
  haulingPlaces: {},
  haulingSeenPlaces: [],
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
  widgetHotkeys: {},
  webViewHotkey: "Ctrl+Shift+F3",
  notepadHotkey: "Alt+F3",
  interactHotkey: "F",
  holdToInteract: false,
  moveHotkey: "Ctrl+Alt+M",
  fabClaimHotkey: "F4",
  unfocusedOpacity: 1,
  opacityHotkey: "",
  timeRelative: true,
  shareLogs: false,
  seenChangelog: "",
  hideCatbar: false,
  theme: "mobiglas",
  overlayTwist: 0, // flat by default; the user can dial in a skew angle in the hub
  overlayScale: 100,
  revertThemeOnFoot: false,
  chatOpen: false,
  // Production chat (Coolify VPS, CHAT_AUTH=site — identities come from the sync token's
  // verified RSI handle). Local dev server: ws://127.0.0.1:8788/ws + a chatHandle.
  chatServerUrl: "wss://chat.subliminal.gg/ws",
  chatHandle: "",
  chatChannels: [],
  chatShareActivity: false,
  chatHideLocation: false,
  setupDone: false,
  setupSettingsReviewed: false,
  setupShareResolved: false,
  setupNudgeDismissed: false,
};

// Set when the config on disk was left ARMED (a crash, or a build from before the forced-off
// rule). Read once at startup to rewrite the file immediately — see the note in loadConfig.
let payoutScanWasArmedOnDisk = false;

function loadConfig(): Config {
  // Prefer the user's saved config; fall back to the bundled default on first run.
  //
  // 🔑 `payoutScan` is forced OFF here regardless of what any file says. This is the ONLY thing
  // keeping the scan session temporary, and it is enough: whatever the file claims, the running
  // app starts disarmed and the file is rewritten to agree (see the startup save below).
  //
  // 🔴 DO NOT go back to stripping it on SAVE. That looked stronger and silently broke the
  // scanner for a whole release: `electron/capture.cjs` learns the mode by READING config.json
  // off disk every tick (`readConfig`), so a field that is never written is a field it can never
  // see — `payout` was permanently false, the contract-region crop at capture.cjs:713 never ran,
  // and the dashboard sat on "no board on screen" forever while every server-side surface
  // correctly reported the mode as ON. Nothing failed loudly; `c8c2aca` introduced it as a
  // tightening and no board was swept afterwards to notice. Forcing it off on LOAD gives the
  // same guarantee — the mode cannot survive a launch — without lying to the process that has
  // to act on it.
  for (const p of [configPath, seedConfigPath]) {
    try {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        if (raw && raw.payoutScan === true) payoutScanWasArmedOnDisk = true;
        // `contractRegion` is normalised rather than merged: every config written before the
        // default existed carries an explicit `null`, which a spread preserves — so those users
        // would keep the un-calibratable state this default was added to end. A region dragged
        // off-frame or squashed to nothing is replaced for the same reason (it reads an empty
        // rectangle and looks exactly like a scanner that has stopped working).
        return { ...DEFAULTS, ...raw, payoutScan: false,
          contractRegion: contractRegionOrDefault(raw?.contractRegion),
          // ⚠️ Copied, not spread through. A shallow `{...DEFAULTS}` hands out DEFAULTS' OWN
          // container for these two, and both are mutated in place (naming a place, learning a
          // name) — so the defaults object would accumulate this session's data and any later
          // load would inherit it. Also normalises a config written before the fields existed.
          haulingPlaces: { ...(raw?.haulingPlaces ?? {}) },
          haulingSeenPlaces: Array.isArray(raw?.haulingSeenPlaces) ? [...raw.haulingSeenPlaces] : [] };
      }
    } catch {
      /* corrupt — try the next source */
    }
  }
  return { ...DEFAULTS, haulingPlaces: {}, haulingSeenPlaces: [] };
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
// Errors forwarded by the canvas page (window.onerror / unhandledrejection). Same reasoning as
// lastSaveError: a renderer's console does not exist in a packaged build, so these used to
// vanish. Remembered here for /api/diagnostics AND echoed to the console (→ sidecar.log).
// Capped both ways — a ring of the last few, and a per-minute intake ceiling, because the one
// thing worse than losing an error is an error LOOP flooding the log that would explain it.
const CLIENT_ERR_KEEP = 20;
const CLIENT_ERR_PER_MIN = 10;
const clientErrors: { at: string; from: string; msg: string }[] = [];
let clientErrWindowStart = 0;
let clientErrWindowCount = 0;
const saveConfig = async (): Promise<void> => {
  try {
    mkdirSync(userDir, { recursive: true });
    // 🔑 `payoutScan` IS written, deliberately — see the long note in loadConfig(). It is the
    // only way `electron/capture.cjs` can learn the mode (it re-reads this file every tick), and
    // stripping it here is what silently disabled the whole scanner in `c8c2aca`. The mode stays
    // temporary because loadConfig() forces it off on every launch and rewrites the file, which
    // is a guarantee about what RUNS rather than about what is on disk.
    await writeFile(configPath, JSON.stringify(config, null, 2));
    lastSaveOk = new Date().toISOString();
    lastSaveError = null;
  } catch (e) {
    lastSaveError = { at: new Date().toISOString(), error: String(e) };
    console.error("[config] save failed:", String(e));
  }
};

// 🔑 A config left ARMED — the app was killed mid-sweep, or it predates the forced-off rule — is
// rewritten disarmed RIGHT NOW, not whenever the next save happens to occur. loadConfig() already
// guarantees the running app starts disarmed, but `electron/capture.cjs` reads the FILE, so until
// this lands the file is what would arm it. The shell only spawns that loop after waitForServer(),
// so this write is ahead of its first tick. Conditional purely to avoid rewriting a file on every
// launch for the 99% of launches that were left off.
if (payoutScanWasArmedOnDisk) {
  console.log("[payout] config was left armed — disarming on disk");
  void saveConfig();
}

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

// ── Mission / blueprint tracker ─────────────────────────────────────────────
// remoteBaseUrl: pull a patch's pool data from subliminal.gg if it isn't bundled
// (offline-first — always falls back to the shipped data/ files).
const tracker = new MissionTracker({ dataDir, remoteBaseUrl: "https://subliminal.gg/sc" });
// Name->UUID catalog for the screen-read OCR endpoint; loaded lazily on first use.
let screenCatalog: CatalogEntry[] | null = null;

/** Rolling diagnostic buffer of what the mining scanner SAW, served at GET /api/mining/recent.
 *  In memory only and capped — a debug aid, never a record. It exists because the detailed
 *  `[mining]` log line is only written once a signature has parsed, so the interesting case —
 *  a frame where nothing parsed — left no trace at all. */
interface MiningReadNote {
  at: number;
  /** Which OCR pass produced this: the full-frame Windows OCR, pre-computed lines, or the
   *  magnified RapidOCR crop. Tells a Windows-OCR miss apart from a RapidOCR one. */
  pass: string;
  kind: string;
  signature: number | null;
  scanHud: boolean;
  sawText: string;
}
const MINING_READ_RING = 60;
const recentMiningReads: MiningReadNote[] = [];
let lastHeartbeat: { at: number; rate: number | null; lastTickMs: number | null; fastForMs: number | null } | null = null;
/** Per-stage tick timings from the capture loop (see the heartbeat handler). */
const TICK_RING = 80;
const recentTicks: Record<string, unknown>[] = [];

function noteMiningRead(n: Omit<MiningReadNote, "at">): void {
  recentMiningReads.push({ at: Date.now(), ...n });
  if (recentMiningReads.length > MINING_READ_RING) recentMiningReads.shift();
}

/** A short sample of the text the OCR returned, for telling "saw nothing" apart from "saw the
 *  number and mangled it". Bounded in both directions — line count and total length. */
function readTextSample(body: Record<string, unknown>): string {
  const lines = body.lines;
  if (!Array.isArray(lines)) return "";
  return lines
    .map((l: unknown) => (l && typeof l === "object" ? String((l as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join(" | ")
    .slice(0, 400);
}
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

// ── What everyone else found out about this contract ────────────────────────────────────────
// Two things subliminal.gg now knows that the shipped dataset cannot: what the contract actually
// PAID (the game calculates most payouts at accept time — the number exists nowhere in the game
// files, which is what the board scanner exists to collect), and what players said about it
// afterwards (difficulty, whether they soloed it, what the fighting was like).
//
// 🔑 Fetched HERE, not in the widget. Both read endpoints answer without CORS headers, so a page
// on localhost cannot read them — and the sidecar already talks to the site.
// 🔑 Unauthenticated, deliberately: neither GET wants a token, so these numbers appear for
// everyone rather than only for people who have connected an account.
// ⚠️ It is an outbound request naming the contract you are running. No token, no identity, and
// only when a mission is actually tracked — but it IS a request that did not happen before. Gate
// it on `config.syncEnabled` if that ever needs to be tighter.
/** `ocrOnly` = every observation behind this figure came from a BOARD SCAN, with no typed report
 *  or log line corroborating it. The board abbreviates ("63k"), so a scan is the true value
 *  floored to that magnitude — systematically imprecise — and OCR is the one source that can
 *  misread outright. The widget says so in the tooltip rather than on the face of the pill. */
type CommunityPayout = { samples: number; contributors: number; min: number; max: number; median: number; currency: string; singleContributor: boolean; ocrOnly?: boolean };
type CommunityFacts = { samples: number; combatTop: string | null; difficulty: number | null; difficultyAnswers: number; soloRate: number | null; soloAnswers: number; ships: { ship: string; count: number }[] };
type Community = { payout: CommunityPayout | null; facts: CommunityFacts | null };
const communityCache = new Map<string, { at: number; data: Community | null }>();
const COMMUNITY_TTL_MS = 10 * 60_000;
let communityInFlight = "";

function communityFor(key: string | null): Community | null {
  if (!key) return null;
  const hit = communityCache.get(key);
  // Serve a stale entry while the refresh runs. Blinking the numbers away and back is worse
  // than showing ten-minute-old medians for a second.
  if (!hit || Date.now() - hit.at >= COMMUNITY_TTL_MS) void fetchCommunity(key);
  return hit ? hit.data : null;
}

async function fetchCommunity(key: string): Promise<void> {
  if (communityInFlight === key) return;
  communityInFlight = key;
  const base = (process.env.SC_SYNC_BASE || "https://subliminal.gg").replace(/\/+$/, "");
  const q = `?keys=${encodeURIComponent(key)}`;
  try {
    const grab = async (path: string, field: string) => {
      const res = await fetch(`${base}/api/sc/${path}${q}`);
      if (!res.ok) return null;
      const body = await res.json() as Record<string, Record<string, unknown>>;
      return (body?.[field]?.[key] ?? null) as never;
    };
    const [payout, facts] = await Promise.all([
      grab("mission-payout", "payouts"),
      grab("mission-feedback", "missions"),
    ]);
    communityCache.set(key, { at: Date.now(), data: { payout, facts } });
    broadcastMissions();
  } catch {
    // Offline, or the site is down. Cache the miss so a dead network cannot turn into a request
    // per SSE tick — it simply retries after the TTL.
    communityCache.set(key, { at: Date.now(), data: null });
  } finally {
    communityInFlight = "";
  }
}

function missionsPayload(): string {
  const v = tracker.view();
  return JSON.stringify({
    ...v,
    community: communityFor(v.contractKey),
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
      // 🔑 The SHELL owns window opacity but only read this at startup, so saving it did
      // nothing until the next launch (Sub, 2026-08-09: "I set it to 20, clicked into the
      // game, nothing happens"). Riding it on the prefs broadcast means EVERY surface that
      // can change it — settings window, embedded settings widget, a hand-edited config —
      // reaches the shell through one path that already fires on every config save.
      unfocusedOpacity: config.unfocusedOpacity,
      premium: entitled(),   // subscriber: skins unlocked + logos/flair shown
      demo: !!demoTheme,     // a trial preview is live → overlay shows the trial watermark
      // The contract-board scan session. Rides prefs so the CANVAS can put its dashboard on
      // screen the moment the mode is armed from anywhere — the settings window, the panel's
      // own Stop button, or a restart forcing it off. It is the only signal the panel obeys,
      // which is what keeps "panel up" and "screen-reading armed" from ever disagreeing.
      // 🔑 Read from `config`, which `loadConfig` forces to false on every launch, so a broadcast
      // on launch always carries `false` — the mode cannot come back without someone arming it.
      // ⚠️ It is NOT stripped on save, and must not be: `capture.cjs` learns the mode by reading
      // config.json off disk, so a field never written is a field it can never see. That is the
      // bug that killed the scanner for a whole release.
      payoutScan: config.payoutScan,
      // The calibrated board rectangle, so the canvas can draw its box over the real one. Rides
      // prefs rather than being fetched, so every accepted write redraws it and the outline can
      // never claim a region that isn't cropped.
      payoutRegion: config.contractRegion,
      // Whether the last contract crop came off the PRIMARY display. The box is drawn over the
      // primary (the canvas reports only that display's rect), so a game on any other monitor is
      // calibrating against pixels it cannot see. null = no crop has been taken yet, which is not
      // the same as "it's fine" and must not be reported as such.
      payoutOnPrimary: contractCropOnPrimary,
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

// ── Hauling datasets (ship cargo grids + contract cargo + locations) ────────
// Bundled reference data for the hauling optimiser (see HaulingDataStore). Served via
// /api/ships, /api/hauling-orders and /api/locations; the widget is not built yet.
const haulingData = new HaulingDataStore(dataDir);
{
  const c = haulingData.counts();
  console.log(`[hauling] ships: ${c.ships}, contracts: ${c.contracts}, locations: ${c.locations}` +
    (c.version ? ` (${c.version})` : ""));
}

// ── Naming a place the game never named ─────────────────────────────────────
//
// Only a TRACKED drop-off gets a name out of the game, so most stops read "Site 1". Sub has asked
// four times for a box to type the real name into. Two pieces make that work: a list worth
// choosing from, and a match that forgives typing.

/** Types a cargo ship can actually be sent to. Everything else in locations.json is scenery: 816
 *  asteroids, plus stars, systems, jump points and nav points. Offering them is offering a wrong
 *  answer, and it is most of the list. */
const PLACE_TYPES = new Set([
  "Outpost", "Outpost_InvalidQT", "LandingZone", "Manmade",
  "Manmade_VisibleOnInteraction", "PointOfInterest", "Moon", "Planet",
]);
/** How many suggestions a 420px panel can usefully show. */
const PLACE_LIMIT = 8;
/** ⚠️ The datacore ships unfinished rows under real-looking types — "<= PLACEHOLDER =>",
 *  "<= UNINITIALIZED =>" — and they sort to the top of an alphabetical list because of the angle
 *  bracket. Offering one as a place name is offering nonsense. */
const PLACE_JUNK = /^<=|=>$|^\s*$/;
/** Ceiling on the learned list, so a long-running install cannot grow the config without bound. */
const SEEN_PLACES_MAX = 200;

/**
 * Remember names the GAME stated, newest last.
 *
 * 🔑 A name only counts if the game produced it. `Site 3` and anything the player typed are
 * excluded — the point of this list is that its entries are known-good, so it can outrank a
 * dataset of 1,125 candidates. Player answers are already remembered per place; feeding them back
 * in here would let one typo become a permanent suggestion.
 */
function rememberSeenPlaces(names: readonly string[]): void {
  const player = new Set(Object.values(config.haulingPlaces));
  let changed = false;
  for (const raw of names) {
    const n = (raw ?? "").trim();
    if (!n || /^Site \d+$/.test(n) || player.has(n)) continue;
    const at = config.haulingSeenPlaces.indexOf(n);
    // ⚠️ `at >= 0` is load-bearing. On an EMPTY list indexOf is -1 and length-1 is also -1, so a
    // bare `at === length - 1` reads "already the most recent" for every name and the list can
    // never take its first entry. Silent: no error, just a feature that quietly never learns.
    if (at >= 0 && at === config.haulingSeenPlaces.length - 1) continue;
    if (at >= 0) config.haulingSeenPlaces.splice(at, 1);
    config.haulingSeenPlaces.push(n);
    changed = true;
  }
  if (!changed) return;
  if (config.haulingSeenPlaces.length > SEEN_PLACES_MAX) {
    config.haulingSeenPlaces = config.haulingSeenPlaces.slice(-SEEN_PLACES_MAX);
  }
  void saveConfig();
}

/**
 * Subsequence match with a bias toward the obvious reading.
 *
 * Returns null when the query's letters do not appear in order. Lower is better. A prefix match
 * beats a word-start match beats letters merely scattered through the string, so typing "bai" puts
 * "Baijini Point" above "Bloom Air Institute" even though both technically match.
 */
function fuzzyScore(name: string, q: string): number | null {
  if (!q) return 0;
  const hay = name.toLowerCase();
  const needle = q.toLowerCase();
  if (hay.startsWith(needle)) return 0;
  const at = hay.indexOf(needle);
  // A run that begins at a word boundary reads as a real hit; one starting mid-word is weaker.
  if (at >= 0) return at === 0 || /[\s&'/-]/.test(hay[at - 1]) ? 1 : 2;
  let i = 0, gaps = 0;
  for (const ch of hay) {
    if (ch === needle[i]) { i++; if (i === needle.length) break; }
    else if (i > 0) gaps++;
  }
  return i === needle.length ? 3 + gaps / 1000 : null;
}

/** Ranked suggestions for the naming box: names the game has used, then the shipped dataset. */
function haulingPlaceSuggestions(q: string): { name: string; hint: string | null; seen: boolean }[] {
  const out: { name: string; hint: string | null; seen: boolean; rank: number }[] = [];
  const taken = new Set<string>();
  // Tier 1 — the game's own words, most recently used first. `seen.length - i` keeps recency as
  // the tiebreak inside an equal fuzzy score, which is what "people work one area for hours" needs.
  const seen = config.haulingSeenPlaces;
  seen.forEach((name, i) => {
    const s = fuzzyScore(name, q);
    if (s === null) return;
    taken.add(name.toLowerCase());
    out.push({ name, hint: "used before", seen: true, rank: s - 10 - (i / (seen.length || 1)) });
  });
  // 🔑 AN EMPTY BOX OFFERS ONLY WHAT THE GAME HAS USED. Ranking 1,125 dataset rows with no query
  // to rank them BY produces an alphabetical list starting at "The Pit" — eight rows of noise, and
  // worse, it buries the handful of places this player actually visits. With nothing typed the
  // useful answer is "somewhere you have been before"; the dataset earns its place the moment
  // there are letters to match against.
  if (!q) return out.sort((a, b) => a.rank - b.rank).slice(0, PLACE_LIMIT)
    .map(({ name, hint, seen: s }) => ({ name, hint, seen: s }));
  // Tier 2 — the shipped dataset, minus everything a ship cannot be sent to.
  for (const l of Object.values(haulingData.locations())) {
    if (!l.name || !PLACE_TYPES.has(l.type ?? "")) continue;
    if (PLACE_JUNK.test(l.name)) continue;
    if (taken.has(l.name.toLowerCase())) continue;
    const s = fuzzyScore(l.name, q);
    if (s === null) continue;
    taken.add(l.name.toLowerCase());
    out.push({ name: l.name, hint: l.parentName ?? l.system ?? null, seen: false, rank: s });
  }
  out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return out.slice(0, PLACE_LIMIT).map(({ name, hint, seen: s }) => ({ name, hint, seen: s }));
}

// ── The advisor: which contracts to go looking for ──────────────────────────
//
// `src/hauling-advisor.ts` has done this work since it was written and nothing has ever called it —
// only `parseBoardTitle` was wired up. It ranks the shipped contract TYPES by reputation (or money)
// per unit of handling, which is the accept/skip decision at the board, and answers "how many of
// these to the next rung".

/** Built once: `buildContracts` walks 853 keys against the orders table, and neither dataset
 *  changes while the process is up. */
let advisorRows: AdvisorContract[] | null = null;
function advisorContracts(): AdvisorContract[] {
  if (advisorRows) return advisorRows;
  const missions = tracker.missionsByKeyPrefix("HaulCargo");
  const orders = haulingData.contracts();
  advisorRows = buildContracts(missions as never, orders as never);
  console.log(`[hauling] advisor: ${advisorRows.length} rankable contract types`);
  return advisorRows;
}

/**
 * How long one contract actually takes, MEASURED — accept to turn-in, off the player's own runs.
 *
 * 🔑 Sub asked for this directly: "we have enough information to figure out exactly how long it
 * takes me to do a mission, because you know when I grabbed it and when I turned it in." Right, and
 * it beats the modelled figure outright — `handlingEffort` counts box handling and nothing else, so
 * it is a floor, while this includes the flying, the elevator queue and the walk.
 *
 * MEDIAN, not mean. One contract accepted and forgotten for two hours would drag an average into
 * uselessness, and a hauler's run times are naturally skewed that way.
 *
 * ⚠️ Contracts overlap — several are usually run together — so this is "wall-clock from accepting
 * this one to finishing it", not "time this one cost you". It is the honest reading of what the log
 * records, and the right one for "how long until I rank up" precisely because a real session runs
 * them in parallel too.
 */
function haulingRunMinutes(): { median: number; samples: number } | null {
  const spans = hauling.view().finished
    .filter((f) => f.acceptedAt != null && f.at > f.acceptedAt)
    .map((f) => (f.at - (f.acceptedAt as number)) / 60_000)
    .sort((a, b) => a - b);
  if (!spans.length) return null;
  return { median: spans[Math.floor(spans.length / 2)], samples: spans.length };
}

/**
 * 🔴 STANDING IS PER GIVER, NOT PER SCOPE.
 *
 * Four factions share the `Hauling` scope — Covalex (817 contracts), Dead Saints (8), Red Wind (7),
 * Ling Family (7) — and reputation accrues to the FACTION. Sub saw the danger before the code did:
 * "if I select my rank, it's going to show me missions from another mission giver at that rank, and
 * I'm not that rank with that mission giver." Exactly right. Gating on one ladder would have
 * offered him Member-tier Ling Family work against a Covalex standing he earned elsewhere.
 *
 * The numbers come from MissionTracker's own accrual, which has been running all along and is
 * keyed by giver — 307 credited completions at the time this was written, reading Covalex 5,400.
 */
function haulingStandings(): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of tracker.repDiagnostics().givers) {
    if (g.scope === "Hauling") out.set(g.giver, g.sum);
  }
  return out;
}

/**
 * How long the next rung is away, for ONE giver.
 *
 * 🔑 The rate is the player's own MEASURED rep/hour, or nothing. `climbToNextRung` counts only
 * loading work — no flying, no quantum, no walk to the elevator — so turning its seconds into
 * "time to rank" would understate by however long the travelling takes, which is most of it. No
 * rate, no time: report the rep needed and say what would fix that.
 */
function haulingClimb(giver: string, standing: number, repPerHour: number | null): Record<string, unknown> {
  const { current, next } = rungAt(standing);
  if (!next) return { giver, standing, rung: current.name, next: null };
  const need = Math.max(0, next.minRep - standing);
  return {
    giver, standing,
    rung: current.name,
    next: next.name,
    // How far through the current rung they are — the bar the game draws but never numbers.
    progress: (standing - current.minRep) / Math.max(1, next.minRep - current.minRep),
    repNeeded: need,
    hours: repPerHour && repPerHour > 0 ? need / repPerHour : null,
    repPerHour,
  };
}

// ── Mining Assistant (signature scanner + refinery timer) ────────────────────
// Party roster + reward split. The log can only COUNT party members (and name them late,
// on despawn), so the roster is manual — see src/party.ts for the full finding.
const party = new PartyTracker(join(userDir, "party.json"), join(userDir, "party-sessions"));

const mining = new MiningTracker({ dataDir, stateDir: userDir });

// Hauling contracts, off the same mission event stream. Purely in-memory and derived: the game
// is the source of truth for which contracts you hold, so there is no state file to keep in sync
// and nothing to migrate.
const hauling = new HaulingTracker();

// Crowdsourced mission facts (what you actually do in it, difficulty, soloable) collected by
// the completion report. Local-only for now — this file IS the upload queue for when the
// subliminal.gg endpoint lands.

// ── Contract-board payout scanner ──────────────────────────────────────────
// OFF unless switched on (POST /api/payout-scan). While on, every full-frame OCR the
// capture loop already takes is ALSO parsed as a Contract Manager board — no second
// screenshot, no second OCR, no extra polling. That matters: the loop is the app's
// hottest path and a parallel capture would double its cost for a feature most players
// will never turn on.
let payoutScanner: PayoutScanner | null = null;
let lastPanelLines: string[] = [];
let lastFrame = "";
/** Was the last contract crop taken off the primary display? `null` until a crop has happened —
 *  the calibration box only warns on a definite `false`, because "we don't know yet" and "the
 *  game is on another monitor" are different answers and only one of them is worth interrupting
 *  someone over. Deliberately NOT persisted: it describes this session's screen layout. */
let contractCropOnPrimary: boolean | null = null;
let payoutMatcher: ContractMatcher | null = null;
let payoutMatcherFor = "";

/** Built lazily and rebuilt when the patch changes — the matcher is an index over the
 *  whole dataset and there is no point paying for it until someone scans. */
function ensurePayoutScanner(): PayoutScanner | null {
  const patch = tracker.view().patch ?? "";
  if (payoutScanner && payoutMatcherFor === patch) return payoutScanner;
  const candidates = tracker.matchCandidates();
  if (!candidates.length) return null;
  payoutMatcher = new ContractMatcher(candidates);
  payoutMatcherFor = patch;
  payoutScanner = new PayoutScanner(payoutMatcher, patch, join(userDir, "payout-queue.json"));
  console.log(`[payout] matcher built for ${patch || "(unknown patch)"} over ${candidates.length} contracts`);
  return payoutScanner;
}

/** The star system the player is in, when the log has said recently. Used only to break a
 *  tie between same-titled variants; a wrong guess here would silently mis-file a price,
 *  so an unknown place yields null and the row stays ambiguous. */
/** Last star system seen this session. 🔑 Deliberately NOT expired, unlike PlaceWatcher's
 *  own reading. The terrain report only fires about every ten minutes, so `current()`
 *  spends most of its time stale-and-therefore-unknown — which for the WIDGET is right
 *  (it must not claim you are somewhere you left) but for this is self-defeating: with no
 *  system, every same-titled Mercenary variant stays ambiguous and the scan records
 *  nothing. A SYSTEM is not a place: you cannot leave one without a long quantum trip, so
 *  the last one seen is overwhelmingly still true. Cleared on a session change, which is
 *  the only moment it can silently stop being true. */
let lastSystem: string | null = null;

/** The category and giver names the dataset actually holds — what turns the board parse
 *  from geometry-guessing into vocabulary matching. Cached: it is the same two lists every
 *  tick, and rebuilding them from 4,075 contracts per capture would be pure waste. */
let vocabCache: { patch: string; v: { categories: string[]; givers: string[] } } | null = null;
function payoutVocab(): { categories: string[]; givers: string[] } {
  const patch = tracker.view().patch ?? "";
  if (vocabCache && vocabCache.patch === patch) return vocabCache.v;
  const cands = tracker.matchCandidates();
  const v = {
    categories: [...new Set(cands.map((c) => c.missionType).filter(Boolean))],
    givers: [...new Set(cands.map((c) => c.giver).filter(Boolean))],
  };
  vocabCache = { patch, v };
  return v;
}

function currentSystem(): string | null {
  // `place` is declared further down; this only runs at request time, well after init.
  const p = place.current();
  if (p.kind === "planet" && p.body) {
    // Body codes are "<system><number><letter>" — "stanton2a" -> "stanton".
    const sys = String(p.body).replace(/[0-9].*$/, "").trim();
    if (sys.length >= 3) lastSystem = sys;
  }
  return lastSystem;
}

async function flushPayouts(): Promise<void> {
  const sc = payoutScanner;
  if (!sc || !sc.pending()) return;
  if (!config.syncEnabled || !config.syncToken) return;
  const base = (process.env.SC_SYNC_BASE || "https://subliminal.gg").replace(/\/+$/, "");
  await sc.flush(async (batch: PayoutObservation[]) => {
    const res = await fetch(`${base}/api/sc/mission-payout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.syncToken}` },
      body: JSON.stringify({ observations: batch }),
    });
    if (!res.ok) console.log(`[payout] upload refused (${res.status}) — ${batch.length} still queued`);
    return res.ok;
  });
}
// Flushed on a timer rather than per capture: the board is re-read every few seconds and
// a request per read would be pointless traffic for rows that are nearly all duplicates.
setInterval(() => { void flushPayouts(); }, 30_000).unref?.();

// ── Mission completions ─────────────────────────────────────────────────────
// Every finished contract, queued to disk and flushed to subliminal.gg.
//
// 🔴 PERSISTED, and that is not optional. The payout queue learned this the hard way: it
// was in-memory first, Sub swept his whole board while the parser was still being fixed,
// and every restart silently binned the lot. A completion is worth more than a payout
// observation — it can never be re-derived once the log rotates away — so losing one to a
// crash or an update is permanent.
//
// 🔑 The queue keeps the contractKey the log line does not carry. A live completion can be
// attributed to a specific same-titled variant; a log backfill can only ever say the title.
const completionQueuePath = join(userDir, "completion-queue.json");
type QueuedCompletion = { contractKey: string; title: string; completedAt: string };
let completionQueue: QueuedCompletion[] = [];
try {
  const raw = JSON.parse(readFileSync(completionQueuePath, "utf8"));
  if (Array.isArray(raw)) completionQueue = raw.filter((r) => r && r.completedAt && (r.title || r.contractKey));
} catch { /* no queue yet, or corrupt — start clean rather than refuse to run */ }
const saveCompletionQueue = () => {
  try { writeFileSync(completionQueuePath, JSON.stringify(completionQueue)); }
  catch (e) { console.error("[completions] queue save failed:", String(e)); }
};

tracker.on("completed", (c: { contractKey?: string; title?: string; at?: string }) => {
  const completedAt = c?.at || new Date().toISOString();
  if (!c?.title && !c?.contractKey) return;
  // Same idempotency triple the server enforces, applied locally too — the tracker can
  // re-emit an end for a mission it re-marked, and there is no reason to send a row the
  // server will only throw away.
  const key = `${c.contractKey || ""}§${completedAt}`;
  if (completionQueue.some((q) => `${q.contractKey}§${q.completedAt}` === key)) return;
  completionQueue.push({ contractKey: c.contractKey || "", title: c.title || "", completedAt });
  saveCompletionQueue();
});

async function flushCompletions(): Promise<void> {
  if (!completionQueue.length) return;
  if (!config.syncEnabled || !config.syncToken) return;
  const base = (process.env.SC_SYNC_BASE || "https://subliminal.gg").replace(/\/+$/, "");
  const batch = completionQueue.slice(0, 200);
  try {
    const res = await fetch(`${base}/api/sc/mission-completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.syncToken}` },
      body: JSON.stringify({ completions: batch }),
    });
    if (!res.ok) {
      console.log(`[completions] upload refused (${res.status}) — ${completionQueue.length} still queued`);
      return; // keep them; the server is idempotent so a retry costs nothing
    }
    completionQueue = completionQueue.slice(batch.length);
    saveCompletionQueue();
  } catch (e) {
    console.log(`[completions] upload failed (${String(e)}) — ${completionQueue.length} still queued`);
  }
}
setInterval(() => { void flushCompletions(); }, 60_000).unref?.();

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
// ── Social chat — the sidecar holds ONE backend connection; widgets ride the SSE below.
const chat = new ChatClient();
const chatClients = new Set<ServerResponse>();
chat.on("sse", (frame: unknown) => {
  const data = `data: ${JSON.stringify(frame)}\n\n`;
  for (const res of chatClients) res.write(data);
});
/** (Re)arm chat from config. The widget being open is the connection gate — closed widget,
 *  zero sockets. Without any identity (no dev handle, no sync token) there is nothing to
 *  connect AS, so stay off and let the widget show its verify prompt. */
function chatConfigure(): void {
  const active = config.chatOpen && !!(config.chatHandle || config.syncToken);
  // 🔑 Applied BEFORE the socket is armed, so a restart never leaks one location frame on the
  // way to honouring the setting. `sendLoc()` runs on `welcome`, which is early enough to matter.
  chat.setHideLocation(config.chatHideLocation);
  chat.configure({
    url: config.chatServerUrl,
    handle: config.chatHandle,
    token: config.syncToken,
    channels: config.chatChannels,
  }, active);
}
// The client is authoritative about which custom rooms it's in (joins and leaves both land
// asynchronously, from the server). Persist whatever it reports so the next launch rejoins.
chat.on("channels", (names: string[]) => {
  if (JSON.stringify(names) === JSON.stringify(config.chatChannels)) return;
  config.chatChannels = names;
  void saveConfig();
});

/** The parser events chat cares about: shard join/hop feeds the region+shard channels,
 *  and leaving the PU (quit/menu) drops them. Runs on the seed pass too, so a mid-session
 *  app start knows the current shard without waiting for a hop. */
function applyChatSignals(ev: import("./missions-parser.js").MissionEvent): void {
  // `ev.dgs` is undefined on Update Shard Id (that line names no endpoint) — passing it
  // through unchanged is what keeps the current DGS instead of clearing it.
  if (ev.kind === "shard") chat.applyShard(ev.shard, ev.dgs);
  else if (ev.kind === "sessionEnd") chat.applyShard(null, null);
}

/* 🔴 A LOCATION WE CANNOT REFRESH IS A LOCATION WE MUST NOT PUBLISH.
 *
 *  Clearing used to depend ENTIRELY on a `<Channel Destroyed>` line reading as sessionEnd. Quit
 *  the game any other way — alt-F4, a crash, killing the process — and that line is never
 *  written, so the client kept its last shard forever while the overlay stayed open. Reported
 *  twice by Sub (2026-08-10): a player sat in "US East 1B" for hours with the game shut.
 *
 *  🔑 The invariant is the LOG FILE'S OWN MTIME, not a parser event. Events only fire when
 *  something interesting happens, so "no events" is normal during quiet play and would false-
 *  clear; but the game appends to game.log continuously while it runs, and stops the instant it
 *  exits. Statting one file is also far cheaper than anything that inspects processes.
 *
 *  Deliberately generous (15 min): over-reporting presence is the bug being fixed, but dropping
 *  someone mid-session would be a worse one, and the same over-reporting is what got the whole
 *  shard tier deleted in 0.1.42 ("it reported three people when one was genuinely nearby"). */
const LOC_STALE_MS = 15 * 60 * 1000;
const LOC_CHECK_MS = 60 * 1000;
function dropStaleLocation(): void {
  if (!chat.hasLocation()) return;          // nothing to clear — don't stat for no reason
  const p = config.logPath;
  // 🔴 BOTH OF THESE USED TO `return`, AND THAT BROKE THE RULE THIS FUNCTION IS NAMED AFTER.
  // No log path, or a log we cannot stat, is precisely "a location we cannot refresh" — so it
  // is precisely the case that must not stay published. Instead the location was pinned
  // forever, and re-asserted on every reconnect, because `sendLoc()` runs on welcome.
  // Sub, 2026-08-12, about a tester frozen in US East 1B: "he is not online, he is not in the
  // game… he's not there." That is what this was: a client with no readable log holding a shard
  // it saw once. It also makes the new in-game marker lie, which is worse than a stale room.
  if (!p) { console.log("[chat] no log path — dropping location"); chat.applyShard(null, null); return; }
  let mtime = 0;
  try {
    mtime = statSync(p).mtimeMs;
  } catch {
    console.log(`[chat] cannot read ${p} — dropping location`);
    chat.applyShard(null, null);
    return;
  }
  if (Date.now() - mtime < LOC_STALE_MS) return;
  console.log(`[chat] game.log untouched for ${Math.round((Date.now() - mtime) / 60000)}m — dropping location`);
  chat.applyShard(null, null);
}
setInterval(dropStaleLocation, LOC_CHECK_MS).unref();

const miningClients = new Set<ServerResponse>();
// ── Where the player is ─────────────────────────────────────────────────────
// The body-name map rides in the dataset (`pyro2` -> "Monox"), so it refreshes per
// patch with everything else rather than being a hard-coded list here.
const place = new PlaceWatcher(mining.bodyNames());
// Seeded from the DATASET's own system vocabulary, so a system added in a patch is recognised
// without a code change — and so nothing outside that vocabulary can be mistaken for one.
const sysWatch = new SystemWatcher(tracker.knownSystems());
// User override. `auto` trusts the log; the other two are the player saying "I know
// where I am, stop guessing" -- which matters because the log reading can be ten
// minutes old and a forced value is never stale.
type PlaceMode = "auto" | "planet" | "space";
function placeMode(): PlaceMode {
  const m = (config as { miningPlaceMode?: string }).miningPlaceMode;
  return m === "planet" || m === "space" ? m : "auto";
}
/** The place the widget should actually use, after the override. */
function effectivePlace(): Place {
  const mode = placeMode();
  if (mode === "planet") return { kind: "planet", body: "manual", name: "(set by you)", at: Date.now() };
  if (mode === "space") return { kind: "space", at: Date.now() };
  return place.current();
}
function miningViewWithPlace() {
  const v = mining.view();
  const p = effectivePlace();
  // 🔑 The debris/harvestable wording is decided HERE, not in the widget. Both step by
  // exactly 2,000 so the COUNT is never in doubt -- only the kind is -- and the rule for
  // wording that lives in location.ts. Computing it in the renderer would be the same
  // rule in two places, which is how the verdict logic drifted before.
  const sig = v.scan?.signature ?? 0;
  const wording = v.scan && sig % 2000 === 0 && v.scan.verdict !== "ore"
    ? debrisStepWording(sig / 2000, p)
    : null;
  return { ...v, place: p, placeMode: placeMode(), placeAgeMs: place.ageMs(), wording };
}

function miningSend(msg: unknown): void {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of miningClients) res.write(data);
}
// Appearance (theme + skew + scale) for the Mining Assistant window — same resolved values the
// HUD gets in its prefs, so the mining widget retints (incl. Drake auto-by-ship) and matches.
function miningAppearance(): { kind: "appearance"; theme: string; overlayTwist: number; overlayScale: number } {
  return { kind: "appearance", theme: effectiveTheme(), overlayTwist: config.overlayTwist, overlayScale: config.overlayScale };
}
// ── Hauling optimiser ──────────────────────────────────────────────────────
// Its own SSE channel rather than a field on the missions payload: hauling state changes on a
// completely different cadence (a marker burst on accept, then nothing for twenty minutes), and
// every widget on the missions stream would otherwise re-render for a delivery it doesn't show.
const haulingClients = new Set<ServerResponse>();
function haulingSend(msg: unknown): void {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of haulingClients) res.write(data);
}
hauling.on("change", () => { if (haulingClients.size) haulingSend({ kind: "state", view: hauling.view() }); });

mining.on("change", () => miningSend({ kind: "state", view: miningViewWithPlace() }));
// Transient alerts the overlay turns into TTS + sound + a flash.
mining.on("target-hit", (hit) => miningSend({ kind: "target-hit", hit }));
mining.on("refinery-done", (job) => miningSend({ kind: "refinery-done", job }));

/* ── What you're doing, published to the people in your channels ────────────
 *
 * 🔴 OPT-IN, off by default (`chatShareActivity`). Same rule as publishing your shard on a
 * party listing: nothing may leak from merely having the widget open. This is the one thing an
 * external chat can show that the game's own social panel will not — it comes off game.log —
 * and that is exactly why it has to be asked for rather than assumed.
 *
 * 🔑 The MISSION wins over mining. Someone scanning rocks for a contract is running the
 * contract; naming the rocks would describe the means and hide the point.
 * 🔑 Mining has no "stopped" event, so it can only be inferred from a scan going stale — hence
 * the timer as well as the two change hooks. Everything downstream is idempotent
 * (`setActivity` drops an unchanged value before it reaches the socket), so re-running this on
 * every mining tick, every mission change and once a minute costs nothing.
 */
const ACTIVITY_MINING_MS = 10 * 60 * 1000;
function chatActivityLabel(): string | null {
  const title = tracker.view().title;
  if (title) return `Running ${title}`;
  const scan = mining.view().scan;
  if (scan && Date.now() - scan.at < ACTIVITY_MINING_MS) return "Mining";
  return null;
}
function pushChatActivity(): void {
  chat.setActivity(config.chatShareActivity ? chatActivityLabel() : null);
}
tracker.on("change", pushChatActivity);
mining.on("change", pushChatActivity);
setInterval(pushChatActivity, 60_000).unref();

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

// What the player was flying when a mission completed, for the crowdsourced report (Sub's ask,
// 2026-08-09). Captured the moment the completion appears rather than when they answer, because
// the card outlives the moment: they can get out, board something else, or quit to the hangar
// with the report still up. One slot — the card only ever asks about the completion on screen.
let completionShip: { key: string; ship: string | null; manufacturer: string | null } | null = null;
tracker.on("change", () => {
  const c = tracker.view().completion;
  if (!c?.contractKey || completionShip?.key === c.contractKey) return;
  completionShip = { key: c.contractKey, ship: shipName, manufacturer: shipManufacturer };
});

/** Force a resync now (token set / startup / verify). */
function syncFull(): void {
  sync.markDirty();
}

/** One-time read of the current log so the overlay knows the tracked mission +
 *  collected state immediately on start (the watcher then tails from the end). */
/** How far back a rotated log is still worth reading. A hauling run spans hours, not days, and a
 *  week-old log would resurrect contracts that are long gone. */
const BACKUP_SEED_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * 🔴 A LOG ROTATION MUST NOT ERASE WHAT THE PLAYER ALREADY DID.
 *
 * The game starts a fresh `Game.log` on every launch and moves the old one to `logbackups/`. The
 * seed below reads only the CURRENT file, so everything from before the last restart was simply
 * gone — and mission state does not restate itself.
 *
 * Sub, 2026-08-17, holding 103 SCU of Scrap: the widget told him to go and collect it. He had
 * collected it hours earlier; the game logged `pickup … MISSION_OBJECTIVE_STATE_COMPLETED` and then
 * rotated the log, and the app was reading a file that started after the fact. Same root cause as
 * losing his ship, his tonnages and his contracts across each of the day's crashes.
 *
 * So: replay the most recent backup first, then the live log on top. Mission events are idempotent
 * — the tracker keys by missionId and objectiveId — so anything restated simply lands twice.
 *
 * ⚠️ Only the newest backup, and only if it is recent. Reading the whole folder would drag back
 * every contract the player has ever flown.
 */
function seedFromRotatedLog(): void {
  try {
    const dir = join(dirname(config.logPath), "logbackups");
    if (!existsSync(dir)) return;
    const newest = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".log"))
      .map((f) => join(dir, f))
      .map((p) => ({ p, at: statSync(p).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0];
    if (!newest || Date.now() - newest.at > BACKUP_SEED_MAX_AGE_MS) return;
    let applied = 0;
    for (const line of readFileSync(newest.p, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      const ev = parseMissionEvent(parseLine(line));
      if (ev) { tracker.apply(ev); hauling.apply(ev); applied++; }
    }
    const mins = Math.round((Date.now() - newest.at) / 60000);
    console.log(`[seed] rotated log replayed: ${applied} mission events from ${mins}m ago (${newest.p})`);
  } catch (err) {
    console.log(`[seed] rotated log skipped: ${(err as Error).message}`);
  }
}

function seedTrackerFromLog(): number | null {
  try {
    // Before the live log: whatever the player did before the game last restarted.
    seedFromRotatedLog();
    // 🔑 Read as a BUFFER so the exact byte count is known. `text.length` is CHARACTERS, and the
    // watcher seeks by bytes — any non-ASCII in the log (handles, ship names) would make the two
    // disagree and re-emit or skip lines at the seam.
    const buf = readFileSync(config.logPath);
    seedEndsAt = buf.length;
    const text = buf.toString("utf8");
    party.setSelf(ownHandleFromLog(text)); // you're always in your own party — pre-fill the roster
    // Also seed the CURRENT ship (last board still in effect) so theme="auto" matches on a cold
    // start while already seated — the watcher only tails NEW lines, so it wouldn't otherwise see it.
    let seedMfr: string | null = null, seedShip: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      tracker.detectPatch(line);
      const ev = parseMissionEvent(parseLine(line));
      if (ev) { tracker.apply(ev); party.apply(ev); hauling.apply(ev); applyChatSignals(ev); }
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
    seedEndsAt = null;
  }
  return seedEndsAt;
}

// ── Log watcher → auto ship-switch ──────────────────────────────────────────
let watcher: LogWatcher | null = null;
/** Byte offset the seed read stopped at, so the watcher can pick up exactly there.
 *  Null when there was no seed (no log yet, or a mid-session log-path change). */
let seedEndsAt: number | null = null;
function startWatcher(): void {
  watcher?.stop();
  // 🔴 Hand over from the seed read at its exact byte, not at whatever the file measures NOW.
  // The two used to be independent, and everything the game logged in between belonged to
  // neither — see the startPosition note in watcher.ts for what that costs.
  // Build the phrasebook here rather than at construction: this is the one place that always
  // runs with a SETTLED log path, on boot and again after the user repoints it. Without it a
  // player on a non-English UI, or running a language pack, resolves nothing — see localization.ts.
  try {
    const loc = tracker.setLogPath(config.logPath);
    console.log(`[localization] ${loc.source}${loc.path ? ` ${loc.path}` : ""} (${loc.entries} names`
      + `${loc.language ? `, g_language=${loc.language}` : ""})`);
    if (loc.formatDrift.length)
      console.log(`[localization] !! notification wording differs from English: ${loc.formatDrift.join(", ")}`);
  } catch (err) {
    console.log(`[localization] failed: ${(err as Error).message}`);
  }
  watcher = new LogWatcher(config.logPath, {
    pollInterval: 1000,
    ...(seedEndsAt != null ? { startPosition: seedEndsAt } : {}),
  });
  // One handover only: a later restart of the watcher (log-path change) must not rewind to a
  // stale offset from this boot's seed.
  seedEndsAt = null;
  watcher.on("event", (e) => {
    // Feed the mission/blueprint tracker on every line (independent of ship auto-switch).
    tracker.detectPatch(e.raw);
    // Planet-side vs space, off the engine's terrain-streaming report. A HINT only —
    // it is printed about every 10 minutes, so it can be that stale. It orders the
    // wording of an ambiguous 2,000-step signature; it never suppresses anything.
    if (place.push(e.raw)) { miningSend({ kind: "state", view: miningViewWithPlace() }); }
    // Which SYSTEM, off the quantum-navigation lines — explicit, and far more frequent than the
    // terrain report above. A change re-broadcasts because the idle panel filters its suggestions
    // by system, and a stale answer there sends someone to another star.
    if (sysWatch.push(e.raw)) { tracker.setSystem(sysWatch.current()); broadcastMissions(); }
    const me = parseMissionEvent(e);
    if (me) { tracker.apply(me); party.apply(me); hauling.apply(me); applyChatSignals(me); }

    // Theme auto-switch: track the manufacturer of the ship we're in; re-broadcast so the
    // overlay retints live when theme="auto".
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
  });
  watcher.start();
  console.log(`[watcher] watching ${config.logPath}`);
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
  // The bundled colour emoji font. Chromium content-sniffs fonts so octet-stream also works,
  // but a correct type is what keeps it working if that ever tightens.
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
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

// ── OCR health ────────────────────────────────────────────────────────────────
// 🔑 Diagnostics used to report screen reading as PREFERENCES only — fabCapture on, missionOcr
// on — which says nothing about whether the engine works on that machine. A user whose OCR was
// being blocked outright produced a diagnostics report identical to someone whose OCR was fine,
// which is exactly how "his OCR just isn't working" became unanswerable (2026-08-11).
//
// 🔑 Gated on a screen-reading feature actually being ON. Every OCR opt-in is off by default and
// nothing may start a PowerShell worker on the machine of someone who never asked for screen
// reading — self-testing a feature nobody enabled would be the app doing the very thing it
// promises not to.
let ocrHealth: OcrHealth | null = null;
let ocrHealthAt = 0;
function screenReadingOn(): boolean {
  return config.fabCapture === true || config.missionOcr === true
    || config.miningAssistant === true || config.fabClaim === true;
}
/** Cached, because the first call pays the worker's ~570ms startup. Re-tested on a stale cache so
 *  someone who allow-lists the app mid-session gets a fresh answer without restarting. */
async function getOcrHealth(maxAgeMs = 60_000): Promise<OcrHealth | null> {
  if (!screenReadingOn()) return null;
  // 🔴 RapidOCR failing to LOAD outranks the Windows-OCR self-test, and is reported first.
  // Learned from 0.1.42, where the packaged app resolved its ONNX models to a path inside
  // app.asar that native code cannot read: the engine never started, the Mining Scanner called
  // out nothing, and every diagnostic in the app said OCR was fine — because the only thing being
  // self-tested was the OTHER engine. A tester had to decompile the asar to find it.
  // 🔑 Reported through the existing banner rather than a new surface: this is the same fact the
  // banner already exists to tell people ("screen reading isn't working"), and one that names the
  // failing file beats a second warning nobody has learned to read yet.
  if (rapidOcrFailure) {
    return { ok: false, matched: false, lines: 0, text: "", ranAt: rapidOcrFailure.at, ms: 0,
      reason: rapidOcrFailure.reason,
      // The Windows-OCR worker's signature, which is what `signal` describes, says nothing about
      // why RapidOCR would not load — so it is reported clean rather than borrowed to look full.
      signal: { spawnError: null, exitedBeforeReady: false, lastExitCode: null, everReady: false } };
  }
  if (ocrHealth && Date.now() - ocrHealthAt < maxAgeMs) return ocrHealth;
  ocrHealth = await ocrSelfTest();
  ocrHealthAt = Date.now();
  return ocrHealth;
}
/** Set by the capture loop (the only process that runs RapidOCR) the first time its engine refuses
 *  to start. Not persisted: it describes THIS launch's install, and a fixed install must clear it
 *  by simply not reporting again. */
let rapidOcrFailure: { reason: string; at: string } | null = null;

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

  // ── Network policy ────────────────────────────────────────────────────────
  // 🔴 This server binds ALL interfaces so OBS browser sources on a second PC can read the
  // widget pages. That makes every route reachable by the whole LAN, and it was previously
  // open house: a security report from a viewer on Sub's stream (2026-08-09) chained
  // unauthenticated POST /api/config into full sync-token theft — repoint `chatServerUrl` at
  // your own WebSocket and the sidecar cheerfully sends `{t:"hello", token}` straight to you.
  //
  // The rule now, in one place rather than per-route:
  //   • ANY mutating request (non-GET/HEAD) must come from this machine. OBS is a DISPLAY
  //     surface — it reads. Nothing on another PC has business changing this user's settings,
  //     spending their Twitch credential, or driving their chat identity.
  //   • Sensitive GETs are loopback-only too: they carry credentials (config), name paths on
  //     disk (diagnostics/setup), read arbitrary files (mining tone), or fetch arbitrary URLs
  //     on the LAN's behalf (can-embed, an SSRF hop into the private network).
  // Everything else — widget pages, their read-only data and event streams — stays public so
  // OBS keeps working.
  const SENSITIVE_GET = new Set([
    // /api/ocr/health names security software running on this PC and how it is failing — a
    // profile of the machine, useless to the owner's OBS and no business of anything on the LAN.
    "/api/config", "/api/diagnostics", "/api/setup", "/api/ocr/health", "/api/mining/tone", "/api/scfeed/tone",
    // Names the path of the player's global.ini on disk — same class as diagnostics/setup.
    "/api/can-embed", "/api/dev/note", "/api/localization",
  ]);
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  const sensitive = mutating || SENSITIVE_GET.has(url);
  if (sensitive && !fromThisMachine(req)) {
    res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "This endpoint is only available on the machine running SC Overlay." }));
    return;
  }
  // 🔑 Loopback is NOT enough on its own. The Web Page widget will load any http(s) URL, and a
  // page open in it runs ON this machine — so a hostile site can fetch http://127.0.0.1:8778/…
  // and every loopback check above passes. Same for any browser the user happens to have open.
  // A browser stamps `Origin` on cross-origin requests, and our own widgets are same-origin
  // (no Origin on same-origin GETs, and our own host when there is one), so an Origin naming
  // somebody else is proof the caller is a web page that has no business here.
  const origin = req.headers.origin;
  if (sensitive && typeof origin === "string" && origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
    res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Cross-origin requests are not accepted." }));
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
  // Name suggestions for the chat widget's /bp and /item autocomplete. Local dataset only —
  // typing a blueprint name mid-flight must not wait on the network.
  // Every blueprint name distinctive enough to link on sight, so the chat widget can turn
  // "DebBolt3" into a link with nobody typing a command. Fetched ONCE per widget load and
  // cached — it changes only when the dataset does.
  if (url === "/api/blueprint-names" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ names: tracker.autoLinkNames() }));
    return;
  }
  if (url === "/api/blueprint-search" && req.method === "GET") {
    const q = new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "";
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ names: tracker.searchBlueprintNames(q) }));
    return;
  }
  // Mission titles for the chat widget's /mission command ("let's run this one").
  if (url === "/api/mission-search" && req.method === "GET") {
    const q = new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "";
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ missions: tracker.searchMissionTitles(q) }));
    return;
  }
  // The widget's mission search: a brief for a contract you have NOT accepted, so someone can
  // check what a job pays and drops without alt-tabbing out of the game. Keyed by TITLE because
  // that is what a player can actually type; previewByTitle() owns what happens when a title
  // covers several variants. Community payout is folded in so the brief ranks its money the same
  // way the live panel does (observed beats the model).
  if (url?.startsWith("/api/mission-preview") && req.method === "GET") {
    const title = (new URL(req.url ?? "", "http://x").searchParams.get("title") || "").trim();
    const preview = title ? tracker.previewByTitle(title) : null;
    if (!preview) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ...preview, community: communityFor(preview.contractKey) }));
    return;
  }
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
    // `?names=1` — just the names, for the Loot Split autocomplete. The full map is ~600KB of
    // per-terminal prices, which is a silly thing to hand a small always-on-top widget that only
    // wants to spell "Hephaestanite". 🔑 Autocompleting from THIS list (rather than the 26 mining
    // rocks) is what makes the ¤ sell-price lookup beside it always resolve: same source, so a
    // name the widget offered can never be a name the lookup then rejects.
    if (new URL(req.url ?? "", "http://x").searchParams.get("names")) {
      // 🔑 ORES ONLY, and grouped raw vs refined (Sub, 2026-08-11). The first cut offered the whole
      // commodity map and it was unusable: 734 entries carrying ships (Aegis Avenger Titan),
      // helmets, drugs, a literal "<= PLACEHOLDER =>", the STALE AsteroidCTypeMineableRock family
      // the game stopped showing, and internal identifiers including CIG's own typo
      // MineableRock_test_Hephasestanite. A list that long also cannot be got through — the native
      // control gave up around "Bracer".
      //
      // The mining table is the right source precisely because it is the list of things you can
      // come away with: ship-mined rock plus hand-mined gems. The economy map then supplies the
      // real commodity spellings and, via `refinesTo`, which side of the refine each one sits on —
      // an authority in the data instead of guessing from the suffix, which is inconsistent
      // anyway ("(Ore)", "(Raw)", "(Pure)", "(R)" are all in use.)
      //
      // Anything with no commodity at all (Ice) is dropped rather than offered: every name here
      // must be one the ¤ sell-price lookup beside it can resolve, or the autocomplete would hand
      // people a spelling the next control rejects. The field stays free text regardless — this
      // is a suggestion list, never a whitelist.
      // ⚠️ `refinesTo` is the authority but it is NOT complete: the gem ores "Jaclium (Ore)" and
      // "Saldynium (Ore)" declare no refine target and landed under Refined on the first run. The
      // suffix backs it up. "(Pure)" is deliberately NOT a raw marker — Carinite (Pure) is the
      // processed form, so treating every parenthesis as "raw" would have moved it the wrong way.
      const RAW_SUFFIX = /\((?:ore|raw|r)\)$/i;
      const commodities = Object.values(economy.commodities())
        .map((c) => ({ name: (c.name ?? "").trim(), refines: !!c.refinesTo }))
        .filter((c) => c.name && !c.name.includes("_"));
      const raw: string[] = [];
      const refined: string[] = [];
      for (const ore of mining.oreNames()) {
        for (const c of commodities) {
          if (c.name !== ore && !c.name.startsWith(ore + " (")) continue;
          const bucket = c.refines || RAW_SUFFIX.test(c.name) ? raw : refined;
          if (!bucket.includes(c.name)) bucket.push(c.name);
        }
      }
      const groups = [
        { label: "Raw / unrefined", names: raw.sort((a, b) => a.localeCompare(b)) },
        { label: "Refined", names: refined.sort((a, b) => a.localeCompare(b)) },
      ].filter((g) => g.names.length);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ groups }));
      return;
    }
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

  // ── Hauling reference data ────────────────────────────────────────────────
  // Ship cargo grids: ?ship=<class or display name> for one hull, else the whole map.
  // `?names=1` returns just class+name+SCU — the map is ~80 KB of grid geometry and a
  // ship picker only wants a list to spell, the same reasoning as /api/commodities?names.
  if (url === "/api/ships" && req.method === "GET") {
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const ship = q.get("ship")?.trim();
    if (ship) {
      const found = haulingData.ship(ship);
      res.writeHead(found ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(found ?? { error: "not found" }));
      return;
    }
    if (q.get("names")) {
      // Cargo-carrying spaceships only, biggest first — a ground vehicle with a 1 SCU
      // cubby is not a hauling ship and only makes the list harder to get through.
      const list = Object.values(haulingData.ships())
        .filter((s) => s.isSpaceship && s.totalScu > 0)
        .sort((a, b) => b.totalScu - a.totalScu)
        // `autoLoad` rides along because the stowage view has to know BEFORE it draws anything:
        // an open hauler's boxes are placed by the station's arm, so a stowage diagram for one
        // describes work that does not exist. It is a property of the hull, so it belongs on the
        // hull list rather than being re-derived per plan.
        .map((s) => ({ className: s.className, displayName: s.displayName, totalScu: s.totalScu,
                       autoLoad: canAutoLoad(s.className) }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ships: list }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cellMetres: haulingData.cellMetres(), ships: haulingData.ships() }));
    return;
  }

  // Contract cargo requirements: ?key=<contract key from CreateMarker> for one, else all.
  // The box table always rides along — it is small and every consumer needs it.
  if (url === "/api/hauling-orders" && req.method === "GET") {
    const key = new URL(req.url ?? "", "http://x").searchParams.get("key")?.trim();
    if (key) {
      const found = haulingData.contract(key);
      res.writeHead(found ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(found ? { ...found, maxBoxScu: haulingData.maxBoxScu(key), boxes: haulingData.boxes() } : { error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ boxes: haulingData.boxes(), contracts: haulingData.contracts() }));
    return;
  }

  // Locations: ?code=<internal code as game.log writes it> resolves an alias (may match
  // more than one place), ?uuid=<id> fetches one, else the whole map.
  if (url === "/api/locations" && req.method === "GET") {
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const code = q.get("code")?.trim();
    if (code) {
      const hits = haulingData.byCode(code);
      res.writeHead(hits.length ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(hits.length ? { code, matches: hits } : { error: "not found" }));
      return;
    }
    const uuid = q.get("uuid")?.trim();
    if (uuid) {
      const found = haulingData.location(uuid);
      res.writeHead(found ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(found ?? { error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ locations: haulingData.locations() }));
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
    // A session reset means a new shard or a fresh log — the cached system may no longer
    // be where the player is, and a WRONG system silently mis-files a price.
    lastSystem = null;
    seedTrackerFromLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Re-read the player's language file. This is the Calibrate button: a language pack updating
  // is not something we can detect from the outside (and not something we want to poll a 10 MB
  // file for), so the user tells us. `force` skips the size+mtime short-circuit because an edit
  // that happens to preserve both would otherwise appear to do nothing.
  // 🔑 Also re-runs the seed, so blueprints already recorded under names we could not place get
  // resolved retroactively — without that, Calibrate would only help FUTURE receipts and the
  // player would still be staring at the empty pool they pressed it for.
  if (url === "/api/localization/calibrate" && req.method === "POST") {
    const info = tracker.setLogPath(config.logPath, true);
    seedTrackerFromLog();
    console.log(`[localization] recalibrated: ${info.source} (${info.entries} names)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...tracker.localizationStatus() }));
    return;
  }

  if (url === "/api/localization" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(tracker.localizationStatus()));
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
    if (body.miningCrop === true && Array.isArray(body.lines)) {
      // RapidOCR re-read of a TIGHT CROP already limited to the configured mining scan region —
      // every line here is already "in the box" by construction (that's what the crop IS), so this
      // skips classifyScreen's scanRegion filtering, which is written for a full-frame read, and
      // looks for the best signature-shaped candidate directly. Same reasoning as the fabricator's
      // RapidOCR second pass: Windows OCR mangles this small, translucent-backgrounded, stylized
      // text often enough that most scans never produced a candidate to classify at all.
      const ocr: OcrResult = { w: Number(body.w) || 0, h: Number(body.h) || 0, lines: body.lines };
      const best = bestSignatureLine(ocr.lines, ocr.w / 2);
      // 🔑 glyphSearchBox MUST be computed in FULL-FRAME coordinates, not crop-relative ones.
      // It clamps the pin's search box to stay inside "the frame" — but the crop is only ~150px
      // wide while the pin sits ~20-40px further left than the number, so a crop-relative call
      // clamped against the CROP's own edge instead of the screen's, silently shifting the search
      // box right into territory that isn't where the pin actually is. Translate the candidate line
      // to its true on-screen position first (capture.cjs sends the crop's offset + the real frame
      // size alongside the lines) so the clamp — and everything downstream that samples `shot`,
      // the UNCROPPED bitmap — uses the real screen bounds.
      const offX = Number(body.offsetX) || 0, offY = Number(body.offsetY) || 0;
      const frameW = Number(body.frameW) || ocr.w, frameH = Number(body.frameH) || ocr.h;
      result = best
        ? (() => {
            const onScreen = { ...best.l, x: best.l.x + offX, y: best.l.y + offY };
            return { kind: "mineable", signature: best.sig, raw: best.l.text.trim(),
              pin: glyphSearchBox(onScreen, frameW, frameH),
              text: { x: onScreen.x, y: onScreen.y, w: onScreen.w, h: onScreen.h } };
          })()
        : { kind: "none" };
    } else if (body.contractCrop === true && Array.isArray(body.lines)) {
      // RapidOCR re-read of the calibrated offers panel. The crop IS the panel, so every
      // line is in-region by construction and the parser gets the crop's own bounds.
      const ocr: OcrResult = { w: Number(body.w) || 0, h: Number(body.h) || 0, lines: body.lines };
      // Which monitor the crop came off. Only broadcast on a CHANGE: this arrives every tick of
      // an armed scan, and re-broadcasting the whole mission payload at that rate to say nothing
      // has changed is the idle-repaint mistake in another costume.
      if (typeof body.onPrimary === "boolean" && body.onPrimary !== contractCropOnPrimary) {
        contractCropOnPrimary = body.onPrimary;
        broadcastMissions();
      }
      if (config.payoutScan) {
        try {
          const sc = ensurePayoutScanner();
          if (sc) {
            sc.ingest(
              parseContractList(ocr, { x: 0, y: 0, w: ocr.w, h: ocr.h }, payoutVocab()),
              currentSystem(),
            );
          }
        } catch (e) {
          console.log(`[payout] scan error: ${(e as Error).message}`);
        }
      }
      lastPanelLines = ocr.lines.map((l) => `${Math.round(l.x)},${Math.round(l.y)} ${Math.round(l.w)}x${Math.round(l.h)} ${l.text}`);
      lastFrame = `panel ${ocr.w}x${ocr.h} (RapidOCR)`;
      result = { kind: "none" };
    } else if (Array.isArray(body.lines)) {
      // Pre-computed OCR from the main process (RapidOCR reads the fabricator name off a right-
      // panel crop). Classify directly — skip the WinRT OCR entirely for this call.
      const ocr: OcrResult = { w: Number(body.w) || 0, h: Number(body.h) || 0, lines: body.lines };
      result = classifyScreen(ocr, screenCatalog, { scanRegion: config.scanRegion });
      scanHud = hasScanHud(ocr);
    } else if (typeof body.path === "string" && body.path) {
      const ocr = await ocrImage(body.path);
      result = classifyScreen(ocr, screenCatalog, { scanRegion: config.scanRegion });
      scanHud = hasScanHud(ocr);
      // 🔑 Contract parsing does NOT happen on this branch. This is Windows OCR, which
      // mangles the panel's ~12px giver line badly enough to lose otherwise-perfect rows
      // ("UNG FAMILY HAULING" for Ling Family Hauling, "ROUGH B READY" for Rough & Ready,
      // and a "1M" payout dropped entirely). capture.cjs re-reads the calibrated panel with
      // RapidOCR and posts it back as `contractCrop`, handled above.
    }
    // Routing applies to BOTH sources. Mining reads feed its tracker (same process); the
    // mission/fabricator reads are routed by capture.cjs off the returned result.
    const rd = result as { kind?: string; signature?: number; name?: string; items?: string[] };
    // 🔑 DIAGNOSTIC RING — the only record of a read that found NOTHING. /api/mining/scan is the
    // detailed log, but the caller only posts there once a signature has parsed, so a frame that
    // yielded no number is invisible everywhere: nothing logged, nothing broadcast, no readout
    // shown. That is exactly the failure being chased (Sub, 2026-08-08: Torite sat on screen for
    // ~10s, "it didn't display what number it was looking at"). Held in memory and served over
    // HTTP on purpose — sidecar.log is not readable from every environment that needs to debug
    // this, and a diagnostic nobody can retrieve is the same as no diagnostic.
    noteMiningRead({
      pass: body.miningCrop === true ? "rapidocr-crop" : Array.isArray(body.lines) ? "lines" : "winocr-full",
      kind: rd.kind ?? "none",
      signature: typeof rd.signature === "number" ? rd.signature : null,
      scanHud,
      // What the OCR actually saw, so a miss can be told apart from a mangle. Capped hard — this
      // is a rolling debug buffer, not a transcript.
      sawText: readTextSample(body),
    });
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

  // ── Social chat: live stream + snapshot + send ──
  // 🔴 READING chat is loopback-only, exactly like SENDING it. This server binds ALL interfaces
  // on purpose (OBS browser sources run on another PC), so an ungated route is readable by
  // anything that can reach port 8778 — the whole LAN, a flatmate, a VPN peer, a forwarded port.
  // These two carry the ENTIRE chat state: every DM, every org message, and the JOIN CODE of
  // every private room the user is in. That last one is the worst of it, because a leaked code
  // is durable remote access to a private room from anywhere in the world, long after whoever
  // read it left the network.
  //
  // Reported by a viewer on Sub's stream (2026-08-09) as "spoofing into DMs, private chats and
  // org chats" — one hole, all three symptoms. The POST routes below already carried this rule
  // and the reasoning behind it; the read paths were simply missed.
  if (url === "/chat/events" || (url === "/api/chat" && req.method === "GET")) {
    if (!fromThisMachine(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Chat can only be read from this machine." }));
      return;
    }
  }
  if (url === "/chat/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("\n");
    chatClients.add(res);
    res.write(`data: ${JSON.stringify({ type: "state", view: chat.view() })}\n\n`);
    req.on("close", () => chatClients.delete(res));
    return;
  }
  if (url === "/api/chat" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    // The widget's gate state rides along: it must know WHY chat is off (no identity vs.
    // widget-off vs. backend down) to show the right prompt. hasToken decides which gate
    // copy fits — production identity is the sync token's verified handle; the typed
    // chatHandle only means anything against a local dev chat server.
    res.end(JSON.stringify({
      ...chat.view(),
      open: config.chatOpen,
      shareActivity: config.chatShareActivity,
      hideLocation: config.chatHideLocation,
      hasIdentity: !!(config.chatHandle || config.syncToken),
      hasToken: !!config.syncToken,
      handle: config.chatHandle,
      // Pointing anywhere but production means a dev server, whose auth accepts a typed
      // handle — the widget only reveals its dev-identity row then.
      devServer: !config.chatServerUrl.startsWith("wss://chat.subliminal.gg"),
    }));
    return;
  }
  // Sending speaks AS the user's chat identity — same capability class as the identity
  // itself, so like /api/twitch/* it must not answer the LAN (OBS sources only read).
  if (url === "/api/chat/send" && req.method === "POST") {
    if (!fromThisMachine(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: "Chat can only be sent from this machine." }));
      return;
    }
    const body = await readBody(req);
    const out = chat.send(String(body.ch ?? ""), String(body.text ?? ""));
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(out));
    return;
  }
  // Joining/creating and leaving custom rooms, inviting, and DMs — same loopback rule as
  // sending: every one of these ACTS with the user's chat identity, so the LAN must not be
  // able to drive them. (A DM in particular is a message sent as him to a named person.)
  // 🔑 pin/unpin/report belong in THIS group, not a laxer one: a pin speaks to a whole room in
  // his name and a report accuses a named player as him. Both are the "acts with the user's
  // identity" case, so the LAN (which the sidecar serves for OBS) must not be able to drive them.
  if ((url === "/api/chat/join" || url === "/api/chat/leave" || url === "/api/chat/invite"
       || url === "/api/chat/dm" || url === "/api/chat/dmlist"
       || url === "/api/chat/pin" || url === "/api/chat/unpin" || url === "/api/chat/report"
       || url === "/api/chat/apply" || url === "/api/chat/application"
       || url === "/api/chat/color" || url === "/api/chat/hide-location"
       || url === "/api/chat/delete-room" || url === "/api/chat/room-config") && req.method === "POST") {
    if (!fromThisMachine(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: "Chat channels can only be changed from this machine." }));
      return;
    }
    const body = await readBody(req);
    const out =
      url.endsWith("/join") ? chat.join(
        String(body.name ?? ""),
        body.mode === "join" || body.mode === "create" ? body.mode : undefined,
        body.category ? String(body.category) : undefined,
        body.privacy === "private" || body.privacy === "public" ? body.privacy : undefined,
        body.party === true ? {
          party: true,
          location: body.location ? String(body.location) : null,
          sizeMax: Number.isFinite(Number(body.sizeMax)) ? Number(body.sizeMax) : null,
          joinMode: body.joinMode === "apply" ? "apply" : "open",
          voice: body.voice === "optional" || body.voice === "required" ? body.voice : "none",
          minutes: Number.isFinite(Number(body.minutes)) ? Number(body.minutes) : undefined,
        } : undefined)
      : url.endsWith("/invite") ? chat.invite(String(body.ch ?? ""), String(body.handle ?? ""))
      : url.endsWith("/delete-room") ? chat.deleteRoom(String(body.ch ?? ""))
      // Re-answer what a room you own is for / who can find it. The server refuses anyone who
      // does not own it; this only decides which fields were actually asked about.
      : url.endsWith("/room-config") ? chat.setRoomConfig(
        String(body.ch ?? ""),
        body.category ? String(body.category) : undefined,
        body.privacy === "private" || body.privacy === "public" ? body.privacy : undefined)
      : url.endsWith("/dmlist") ? chat.dmList()
      : url.endsWith("/dm") ? chat.dm(String(body.to ?? ""), String(body.text ?? ""))
      : url.endsWith("/pin") ? chat.pin(String(body.ch ?? ""), Number(body.id))
      : url.endsWith("/unpin") ? chat.unpin(String(body.ch ?? ""))
      // Your name colour, as everyone else will see it — so it belongs in the same
      // "acts with the user's identity" group as the rest, not on the LAN.
      : url.endsWith("/color") ? (chat.setColor(body.color === null ? null : Number(body.color)), true)
      // Persisted, because a privacy choice that forgets itself on restart is not one. The
      // sidecar owns the socket, so this is also the only place that CAN enforce it.
      : url.endsWith("/hide-location") ? ((config.chatHideLocation = body.hide !== false),
                                          chat.setHideLocation(config.chatHideLocation),
                                          void saveConfig(), true)
      : url.endsWith("/apply") ? chat.apply(String(body.ch ?? ""), body.note ? String(body.note) : undefined)
      : url.endsWith("/application") ? chat.resolveApplication(
        String(body.ch ?? ""), String(body.handle ?? ""), body.accept === true)
      : url.endsWith("/report") ? chat.report(
        String(body.ch ?? ""), String(body.handle ?? ""),
        Number.isFinite(Number(body.id)) ? Number(body.id) : null,
        body.reason ? String(body.reason) : undefined)
      : chat.leave(String(body.ch ?? ""));
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(out));
    return;
  }

  // Hauling optimiser: live contract state + the "please track these" list.
  if (url === "/hauling/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("\n");
    haulingClients.add(res);
    res.write(`data: ${JSON.stringify({ kind: "state", view: hauling.view() })}\n\n`);
    req.on("close", () => haulingClients.delete(res));
    return;
  }
  if (url === "/api/hauling" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, ...hauling.view() }));
    return;
  }
  /**
   * Candidate place names for the Hauling widget's naming box, best first.
   *
   * 🔴 TWO TIERS, AND THE ORDER IS THE WHOLE POINT.
   *   1. Names the GAME has stated on a hauling Deliver line, most recent first. These are real
   *      hauling stops by construction, and they cover what the dataset cannot: locations.json has
   *      1,968 rows and none of them is "Riker Memorial Spaceport" — it carries `Area18` but not
   *      the spaceport inside it, and the same is true of every city.
   *   2. locations.json, filtered to types a ship can actually be sent to. That drops 816 asteroids
   *      and the stars, systems and jump points — 1,968 rows down to 1,125 — because an asteroid is
   *      never a cargo stop and offering it is offering a wrong answer.
   *
   * Matching is subsequence-fuzzy so "sams" finds "Samson & Son's Salvage Center", with a prefix
   * and word-start bonus so exact typing still wins. Sub: "you just start typing it in and it'll
   * just autocorrect it."
   */
  if (url.startsWith("/api/hauling/places") && req.method === "GET") {
    const q = (new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "").trim();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, places: haulingPlaceSuggestions(q) }));
    return;
  }
  /**
   * What to go looking for on the board, ranked, plus how far the next rung is.
   *
   * ⚠️ These figures are SOLO estimates — every contract scored as if it were the only one you
   * took — and they are the right ones for the accept/skip decision. They are NOT comparable with
   * the Route tab's numbers, which re-score the accepted set with real packing. See the header of
   * hauling-advisor.ts.
   */
  if (url.startsWith("/api/hauling/advisor") && req.method === "GET") {
    const qs = new URL(req.url ?? "", "http://x").searchParams;
    const goal = qs.get("goal") === "money" ? "money" : "rep";
    const ship = qs.get("ship") || config.haulingShip || shipName || null;
    /* 🔑 THE FAMILIES ARE NOT ONE BOARD. Planetary 455, Hauling 161, Stellar 160, Interstellar 49,
       Local 28 — and the player picks a board before they pick a contract, so ranking across all
       of them at once answers a question nobody asked. Sub: "we also have planetary and stellar
       hauling missions... we need a filter for that too."

       ⚠️ Interstellar especially. It is a SEPARATE ECONOMY (see hauling-advisor's header): its
       Rookie tier pays 50 OR 100 and its Master tier pays 0 or 200 where every core Master pays
       8000 — money contracts with the rep switched off. Blending it into a reputation ranking
       produces an order that is wrong for both. */
    const wantType = qs.get("type") || "";
    const types = new Map<string, number>();
    for (const c of advisorContracts()) types.set(c.missionType ?? "Hauling", (types.get(c.missionType ?? "Hauling") ?? 0) + 1);
    const standings = haulingStandings();
    /* 🔴 GATED PER GIVER. rankContracts takes ONE standing, which is right for one faction and
       wrong across four — so it is called with no standing at all (nothing locked) and the lock is
       applied here, against the giver each contract actually belongs to. A contract from a faction
       we have never worked for gates on 0, which is correct: that is exactly what the board shows. */
    const ranked = rankContracts(advisorContracts(), { ship, goal, includeLocked: true, missionType: wantType || null })
      .map((r) => {
        const giver = r.contract.giver ?? "";
        const standing = standings.get(giver) ?? 0;
        const idx = r.contract.rank ? HAULING_LADDER.findIndex((x) => x.name === r.contract.rank) : -1;
        // An unparseable title has no rung, so it cannot be gated — treat it as open, same as
        // rankContracts does.
        const locked = idx >= 0 && HAULING_LADDER[idx].minRep > standing;
        return { ...r, locked, giver, standing };
      })
      .sort((a, b) => Number(a.locked) - Number(b.locked) || b.score - a.score
        || a.effort.stops - b.effort.stops || a.effort.boxes - b.effort.boxes);
    const regime = regimeFor(ship);
    // The rate to quote the climb against: what the player is actually managing, else the plan's
    // forecast. See haulingClimb — a modelled per-run time would be a floor, not an answer.
    const rates = buildHaulingPlan(hauling.view(), haulingData, {
      ship: config.haulingShip, detectedShip: shipName, pins: {}, hidden: [],
      rewards: (k) => tracker.rewardsForKey(k), placeNames: config.haulingPlaces,
    }).rates;
    const perHour = rates.actual?.repPerHour ?? rates.projected?.repPerHour ?? null;
    /**
     * 🔴 COLLAPSE BY TITLE. The list is matched against the board by its TITLE — that is the whole
     * premise of the module — and the datasets carry one key per COMMODITY, so a straight top-24
     * opened with six byte-identical "Experienced Rank - Small Cargo Haul" rows. Six lines of a
     * 560px panel saying one thing, and it reads like a bug.
     *
     * Keeps the best-scoring instance of each title (the list is already sorted, so the first one
     * wins) and counts the rest, because "there are 6 of these on the board" is real information —
     * it is how likely you are to actually find one.
     *
     * ⚠️ Box count is part of the identity, not just the title: same-titled contracts genuinely
     * differ (4 boxes at 500 rep/box vs 6 at 333), and collapsing those would hide a 1.5x
     * difference behind one row.
     */
    const byTitle = new Map<string, { row: typeof ranked[number]; variants: number }>();
    for (const r of ranked) {
      const k = `${r.contract.title}|${r.effort.boxes}`;
      const had = byTitle.get(k);
      if (had) had.variants++;
      else byTitle.set(k, { row: r, variants: 1 });
    }
    /**
     * 🔴 KEEP A WINDOW ON THE NEXT RUNG. `includeLocked` retains locked contracts but they sort
     * last, so a plain top-24 of an unlocked-rich list cuts every one of them — which defeats the
     * reason they are kept at all. Sub is sitting at a rank cusp deliberately waiting to see what
     * changes when he crosses it; "what does the next rung open up" is the question, not a footnote.
     *
     * So the list is the best unlocked PLUS the best few locked, rather than the best N overall.
     */
    const collapsed = [...byTitle.values()];
    const open = collapsed.filter((x) => !x.row.locked).slice(0, 20);
    const soon = collapsed.filter((x) => x.row.locked).slice(0, 4);
    const top = [...open, ...soon].map(({ row: r, variants }) => ({
      variants,
      key: r.contract.key,
      title: r.contract.title,
      giver: r.contract.giver,
      missionType: r.contract.missionType,
      rank: r.contract.rank,
      size: r.contract.size,
      direct: r.contract.shape.pickups === 1 && r.contract.shape.dropoffs === 1,
      pickups: r.contract.shape.pickups,
      dropoffs: r.contract.shape.dropoffs,
      rep: r.contract.rep,
      payout: r.contract.payout,
      scuLo: r.contract.scuLo,
      scuHi: r.contract.scuHi,
      boxes: r.effort.boxes,
      repRate: r.repRate,
      moneyRate: r.moneyRate,
      locked: r.locked,
      standing: r.standing,
    }));
    // "How many of these to the next rung" — off the best UNLOCKED rep contract, which is what the
    // player would actually be flying, and against ITS giver's standing.
    const bestOpen = ranked.find((r) => !r.locked && r.contract.rep > 0) ?? null;
    const runs = bestOpen
      ? climbToNextRung(bestOpen.contract, bestOpen.standing, regime)
      : null;
    /* Every hauling faction the player has any standing with, best first — because "how far to the
       next rank" is four different questions and the widget should not silently answer one. */
    const climbs = [...standings.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([giver, sum]) => haulingClimb(giver, sum, perHour));
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      ok: true, goal, regime,
      type: wantType || null,
      types: [...types.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      ladder: HAULING_LADDER,
      contracts: top,
      climbs,
      /** Measured, from his own finished runs — see haulingRunMinutes. */
      runMinutes: haulingRunMinutes(),
      runsOfBest: runs && bestOpen
        ? { key: bestOpen.contract.key, title: bestOpen.contract.title, giver: bestOpen.giver,
            rep: bestOpen.contract.rep, runs: runs.runs, boxes: runs.boxes }
        : null,
    }));
    return;
  }
  /** Name a place by hand — or clear it by sending an empty name. Keyed by the planner's location
   *  id, which IS the coordinates (see PlanOptions.placeNames). */
  if (url === "/api/hauling/place" && req.method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const id = typeof body.locationId === "string" ? body.locationId : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (id) {
      if (name) config.haulingPlaces[id] = name;
      else delete config.haulingPlaces[id];
      saveConfig();
      hauling.emit("change");   // re-solve and push, so the route relabels immediately
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: !!id }));
    return;
  }
  // The solved plan: route order, box layout, and every load figure tagged with where it came
  // from. Computed HERE rather than in the widget because the solver and the datasets are both
  // server-side — the page only draws what this returns.
  //
  // 🔑 It takes the player's OVERRIDES (ship, objective, pinned tonnages), so it cannot ride on
  // the SSE payload. The widget re-POSTs on every state change, which at this size is trivial.
  if (url === "/api/hauling/plan" && (req.method === "GET" || req.method === "POST")) {
    const body = req.method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};
    const pins: Record<string, number> = {};
    for (const [id, v] of Object.entries((body.pins ?? {}) as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) pins[id] = Math.round(n);
    }
    const plan = buildHaulingPlan(hauling.view(), haulingData, {
      // An absent `ship` falls back to the saved pick; an explicit "" clears it back to the log.
      ship: typeof body.ship === "string" ? body.ship : config.haulingShip,
      // …and if neither the pick nor the hauling log line names a hull, use the ship the app's
      // own detector already resolved for the skin. See PlanOptions.detectedShip.
      detectedShip: shipName,
      objective: body.objective === "fewest-stops" ? "fewest-stops" : "auec-per-hour",
      // Where the player says they are standing. See PlanOptions.startAt.
      startAt: typeof body.startAt === "string" && body.startAt ? body.startAt : null,
      // Contracts the player has set aside. See PlanOptions.hidden.
      hidden: Array.isArray(body.hidden) ? body.hidden.filter((x): x is string => typeof x === "string") : [],
      pins,
      // What each contract pays and what standing it moves. The log states the payout only once a
      // contract has completed and never states reputation at all, so both come off the mission
      // dataset the blueprint tracker already has loaded.
      rewards: (key) => tracker.rewardsForKey(key),
      // Places the player named by hand. See ConfigShape.haulingPlaces — keyed by coordinates, so
      // an answer given once holds for good.
      placeNames: config.haulingPlaces,
    });
    // 🔑 LEARN EVERY NAME THE GAME STATES. locations.json does not carry city spaceports —
    // "Riker Memorial Spaceport" is not in its 1,968 rows — so the dataset alone cannot offer the
    // player the name they most often need. A name the game used on a hauling contract is by
    // definition a real hauling stop, which makes this the better half of the suggestion list.
    rememberSeenPlaces(Object.values(plan.locationNames));
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, ...plan }));
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
  // Diagnostic frames written by the capture loop when config.miningDebug is on. Listing is a
  // plain GET; a specific frame comes back as a PNG. Loopback-only — these are screenshots of the
  // user's desktop, and the sidecar binds every interface for OBS browser sources.
  if (url.startsWith("/api/mining/debug-frame") && req.method === "GET") {
    if (process.env.SC_DEV !== "1" || !fromThisMachine(req)) { res.writeHead(403); res.end(); return; }
    const dir = join(userDir, "debug-frames");
    const want = new URL(req.url ?? "/", "http://localhost").searchParams.get("file");
    if (!want) {
      let files: string[] = [];
      try { files = readdirSync(dir).filter((f) => f.endsWith(".png")).sort(); } catch { /* not created yet */ }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ enabled: config.miningDebug, dir, files }));
      return;
    }
    // Basename only — never let a query string walk out of the debug directory.
    const safe = basename(want);
    if (!safe.endsWith(".png")) { res.writeHead(400); res.end(); return; }
    try {
      const buf = readFileSync(join(dir, safe));
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(buf);
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  // The diagnostic ring (see noteMiningRead). Read-only, in-memory, no persistence — it answers
  // "what did the scanner actually see in the last minute, and how fast was it looking".
  // Replay board rows captured earlier — same matcher, same dedup, same credential as a
  // live scan, so a replayed row is indistinguishable from one read off the screen.
  // Exists because a sweep's worth of good reads was lost to app restarts before the
  // queue was persisted; see tools/payout-replay.mjs.
  if (url === "/api/payout-scan/replay" && req.method === "POST") {
    if (!fromThisMachine(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "loopback_only" }));
      return;
    }
    const body = await readBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const sc = ensurePayoutScanner();
    if (!sc || !rows.length) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: sc ? "no_rows" : "no_dataset" }));
      return;
    }
    const before = sc.events(1000).length;
    sc.ingest(
      rows.map((r: Record<string, unknown>) => ({
        category: (r.category as string) ?? null,
        title: String(r.title ?? ""),
        giver: (r.giver as string) ?? null,
        amount: typeof r.amount === "number" ? r.amount : null,
        kind: (r.kind as "payout" | "fee" | null) ?? null,
        rounded: r.rounded !== false,
        y: 0,
      })),
      currentSystem(),
    );
    const events = sc.events(1000).slice(0, sc.events(1000).length - before);
    let uploaded: number | null = null;
    if (body.dry !== true) {
      const pending = sc.pending();
      await flushPayouts();
      uploaded = pending - sc.pending();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ events, tally: sc.tally, queued: sc.pending(), uploaded }));
    return;
  }

  // ── Payout scanner: on/off + what it has seen ────────────────────────────
  // A MODE, not a hotkey. Sub drives it by saying "turn it on" and later "turn it off",
  // because gathering these means flying to another system for a different board — so it
  // has to survive hours of travel, disconnects and shard changes.
  //
  // 🔒 Loopback only. It is off by default and it reads the player's screen; a LAN caller
  // (the sidecar binds all interfaces so OBS on another PC can load widget pages) must not
  // be able to switch screen-reading on. Same rule as /api/twitch/*.
  if (url === "/api/payout-scan") {
    if (!fromThisMachine(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "loopback_only" }));
      return;
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (typeof body.on === "boolean") {
        config.payoutScan = body.on;
        saveConfig();
        console.log(`[payout] scanning ${body.on ? "ON" : "OFF"}`);
        // 🔑 Tell the overlay, because the dashboard lives ON the canvas now and this route is
        // the ONE place the mode changes — the settings window, the panel's Stop button and
        // the panel's ✕ all arrive here. Broadcasting from here rather than from each caller
        // is what makes "the panel is up" and "the screen is being read" the same fact; a
        // caller that forgot to push would leave an armed scanner with nothing on screen
        // saying so, which is the exact blindness the dashboard was built to end.
        // Deliberately NOT routed through /api/config: that endpoint is reachable from the
        // LAN (widget pages serve to OBS on another PC) and this one is loopback-only on
        // purpose — arming a screen-reader must stay a decision made at this machine.
        broadcastMissions();
        // Flush immediately on the way out so a sweep's tail isn't stranded for 30s.
        if (!body.on) void flushPayouts();
      }
      // `null` is RESET-TO-DEFAULT, not un-calibrate — the box's Reset control and a fresh
      // install must land on the same rectangle, and there is no longer a "no region" state to
      // return to. Anything else is validated server-side and silently ignored when unusable,
      // because a bad region kills every read without failing — the same trap the mining scan
      // box already documents.
      if (body.region === null) { config.contractRegion = { ...DEFAULT_CONTRACT_REGION }; saveConfig(); broadcastMissions(); }
      else if (body.region && typeof body.region === "object") {
        const r = body.region as Record<string, number>;
        const ok = ["x", "y", "w", "h"].every((k) => Number.isFinite(r[k]))
          && r.w > 0.02 && r.h > 0.02
          && r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.001 && r.y + r.h <= 1.001;
        if (ok) {
          config.contractRegion = { x: r.x, y: r.y, w: r.w, h: r.h };
          saveConfig();
          // The box that sent this is drawn from the broadcast, so an ignored region must not
          // leave the outline sitting somewhere nothing is being read. Echoing every accepted
          // write back means the drawn rectangle is always the stored one.
          broadcastMissions();
        }
      }
    }
    const sc = payoutScanner;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      on: config.payoutScan,
      region: config.contractRegion,
      calibrated: !!config.contractRegion,
      // Says WHY nothing is being recorded, which is the question anyone asks first.
      ready: config.payoutScan && !!config.contractRegion && !!config.syncToken && config.syncEnabled,
      syncReady: !!config.syncToken && config.syncEnabled,
      patch: tracker.view().patch ?? null,
      system: currentSystem(),
      inferredSystem: payoutScanner ? payoutScanner.inferredSystem : null,
      tally: sc ? sc.tally : null,
      // Per-row feed + freshness, for overlay/payout-scan.html. A stalled scanner and an
      // idle one look identical in a total, so the page needs to know WHEN the last
      // capture landed, not just how many rows have ever been seen.
      events: sc ? sc.events(60) : [],
      lastCaptureAt: sc ? sc.lastCaptureAt : 0,
      lastCaptureRows: sc ? sc.lastCaptureRows : 0,
      frame: lastFrame,
      panelLines: lastPanelLines,
    }));
    return;
  }

  if (url === "/api/mining/recent" && req.method === "GET") {
    const now = Date.now();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      now,
      heartbeat: lastHeartbeat,
      ticks: recentTicks,
      reads: recentMiningReads.map((r) => ({ ...r, agoMs: now - r.at })),
    }));
    return;
  }
  if (url === "/api/mining" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(miningViewWithPlace()));
    return;
  }
  // The player's planet/space override. Persisted like any other pref so it survives
  // a restart -- someone who mines on foot should not have to re-set it every launch.
  if (url === "/api/mining/place-mode" && req.method === "POST") {
    const body = await readBody(req);
    const m = String((body as { mode?: string })?.mode ?? "");
    if (m !== "auto" && m !== "planet" && m !== "space") { res.writeHead(400); res.end('{"error":"bad mode"}'); return; }
    (config as { miningPlaceMode?: string }).miningPlaceMode = m;
    saveConfig();
    miningSend({ kind: "state", view: miningViewWithPlace() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, placeMode: m }));
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
    res.end(JSON.stringify({ ...rest, premium: entitled(), hasSyncToken: !!syncToken, syncTokenPreview, hasTwitchLogin: !!twitchUserToken, lanHost, port: PORT }));
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
    const touchedLogPath = typeof body.logPath === "string";
    const touchedSync = typeof body.syncEnabled === "boolean"
      || (typeof body.syncToken === "string" && body.syncToken.trim().length > 0)
      || body.clearToken === true;
    const touchedShareLogs = typeof body.shareLogs === "boolean";
    if (touchedLogPath) config.logPath = body.logPath;
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
    // Dev builds only — see the note on the Config field. A packaged sidecar refuses to arm it at
    // all, so neither a stale config.json nor anything on the LAN can switch desktop capture on.
    if (typeof body.miningDebug === "boolean") config.miningDebug = body.miningDebug && process.env.SC_DEV === "1";
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
    if (typeof body.haulingOpen === "boolean") config.haulingOpen = body.haulingOpen;
    if (typeof body.haulingShip === "string") config.haulingShip = body.haulingShip.trim();
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
    if (typeof body.chatOpen === "boolean") config.chatOpen = body.chatOpen;
    if (typeof body.chatShareActivity === "boolean") {
      config.chatShareActivity = body.chatShareActivity;
      // Apply it NOW, not on the next mission event. Turning it OFF has to take effect
      // immediately — a privacy switch that waits for something to happen is not a switch.
      pushChatActivity();
    }
    // ws/wss only — this string becomes an outbound WebSocket dial.
    const wsUrl = (v: unknown, fallback: string): string => {
      if (typeof v !== "string") return fallback;
      const raw = v.trim();
      if (!raw) return fallback;
      try {
        const u = new URL(raw);
        return u.protocol === "ws:" || u.protocol === "wss:" ? u.toString() : fallback;
      } catch { return fallback; }
    };
    if (body.chatServerUrl !== undefined) config.chatServerUrl = wsUrl(body.chatServerUrl, config.chatServerUrl);
    // RSI handle shape; "" is a real value (no dev identity → chat stays gated).
    if (typeof body.chatHandle === "string") {
      const h = body.chatHandle.trim();
      if (!h || /^[A-Za-z0-9._-]{3,30}$/.test(h)) config.chatHandle = h;
    }
    // Only ever WRITTEN by the chat client's own "channels" event (see chat.on above) — a
    // POST may still clear it, which is how a user resets their room list by hand.
    if (Array.isArray(body.chatChannels)) {
      config.chatChannels = body.chatChannels.filter((n: unknown) => typeof n === "string" && n.trim()).slice(0, 30);
    }
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
    // 🔑 MERGED per key, never replaced wholesale. A widget's own cog posts only its own entry
    // (the sidecar merges field-by-field, which is what makes a partial POST safe), so replacing
    // the map would let one widget's settings sheet delete every other widget's hotkey. Keys are
    // taken from the body as-is; an unknown one is inert because the shell only registers keys
    // that exist in its toggle table.
    if (body.widgetHotkeys && typeof body.widgetHotkeys === "object" && !Array.isArray(body.widgetHotkeys)) {
      const merged: Record<string, string> = { ...(config.widgetHotkeys ?? {}) };
      for (const [k, v] of Object.entries(body.widgetHotkeys as Record<string, unknown>)) {
        if (typeof v === "string") merged[k] = v.trim();
        else if (v === null) delete merged[k]; // null = forget this widget entirely
      }
      config.widgetHotkeys = merged;
    }
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
    if (typeof body.opacityHotkey === "string") config.opacityHotkey = body.opacityHotkey.trim();
    // Clamped here as well as in the slider: a hand-edited 0 would fade the overlay to
    // invisible with no visible control left to undo it.
    if (typeof body.unfocusedOpacity === "number" && Number.isFinite(body.unfocusedOpacity))
      config.unfocusedOpacity = Math.max(0.2, Math.min(1, Math.round(body.unfocusedOpacity * 100) / 100));
    if (typeof body.timeRelative === "boolean") config.timeRelative = body.timeRelative;
    if (typeof body.shareLogs === "boolean") config.shareLogs = body.shareLogs;
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
    // Scoped to what actually changed (see touched* flags above) — a save that never touched
    // these fields has no reason to tear down the log watcher mid-
    // session, or push a sync/entitlement round-trip to subliminal.gg.
    if (touchedLogPath) startWatcher();
    // Re-arm sync with the new settings and reconcile the full collection.
    if (touchedSync) {
      if (sync.configure(config.syncToken, config.syncEnabled)) syncFull();
      // A changed token → re-resolve subscriber entitlement now (don't wait for the 20-min tick).
      void pollEntitlement();
    }
    // Re-arm chat (widget toggled, backend switched, identity changed). Internally compares
    // its config and only tears the socket down on a REAL change, so it needs no touched* gate.
    chatConfigure();
    // If log-sharing was just turned on, upload the current session now.
    if (touchedShareLogs) void maybeShareLog(config, APP_VERSION, sharedLogStatePath);
    // Push prefs (e.g. the time-format toggle) to any open overlay immediately.
    broadcastMissions();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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
    // 🔴 NORMALISE THE QUERY TOO. This stripped the suffix off the CANDIDATE only, so every
    // fallback compared a bare "aslarite" against a typed "aslarite (raw)" and could never fire —
    // leaving the exact match as the only route in. That is invisible until the autocomplete
    // starts offering suffixed names, which is exactly what grouping raw vs refined did: half the
    // list it hands you is a spelling only one of the three matchers can resolve, and
    // "Hephaestanite (Raw)" resolved to nothing at all.
    const bare = norm(want);
    const named = all.filter((c) => c.name && c.kind !== "mineable");
    const match =
      named.find((c) => c.name!.toLowerCase() === want) ??
      named.find((c) => norm(c.name!) === bare) ??
      named.find((c) => norm(c.name!).startsWith(bare) && bare.length >= 3) ??
      null;
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "unknown_commodity", name: want }));
      return;
    }
    // 🔑 A RAW ORE HAS NO SELL TERMINALS — you sell what it refines INTO. Matching the typed name
    // exactly is therefore not enough: "Aslarite (Raw)" resolves perfectly and answers with zero
    // quotes, which reads as "we have no idea" when the real answer is sitting one hop away
    // through `refinesTo`. Follow it, and SAY that is what happened, because refining does not
    // return one SCU for one SCU and a raw pile is not worth the refined price outright.
    let priced = match;
    let refinedFrom: string | null = null;
    const quotesOf = (c: typeof match) => (c?.prices ?? []).filter((p) => (Number(p.sell) || 0) > 0).length;
    if (!quotesOf(match)) {
      const target = (match as { refinesTo?: { name?: string } }).refinesTo?.name;
      const hop = target ? named.find((c) => c.name!.toLowerCase() === target.toLowerCase()) : null;
      if (hop && quotesOf(hop)) { priced = hop; refinedFrom = match.name!; }
      else {
        // 🔑 LAST RESORT: a record this endpoint deliberately skipped. `kind !== "mineable"` is
        // there to stop "aluminum" answering with a MineableRock_ entity — but it is too wide, and
        // it silently hid every hand-mined GEM: Hadanite, Aphorite, Carinite, Dolivine each have
        // one record, marked mineable, carrying 44-62 real terminal quotes (Hadanite sells at
        // 600,000). The commodity entry sharing the name has none, so the lookup matched the empty
        // one and answered "no sell price" for the most valuable things you can put in a split.
        // Only accepted when it actually HAS quotes, and internal identifiers stay excluded.
        const gem = all.find((c) => c.name && !c.name.includes("_")
          && norm(c.name) === bare && quotesOf(c as typeof match));
        if (gem) priced = gem as typeof match;
      }
    }
    const sells = (priced.prices ?? []).map((p) => Number(p.sell) || 0).filter((v) => v > 0);
    const summary = sells.length
      ? {
          low: Math.min(...sells),
          avg: Math.round(sells.reduce((a, b) => a + b, 0) / sells.length),
          high: Math.max(...sells),
          quotes: sells.length,
        }
      : { low: null, avg: null, high: null, quotes: 0 };
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    // `name` is what was PRICED, `refinedFrom` what was asked for — the widget needs both to say
    // "priced as Aslarite" rather than quietly answering a different question than it was asked.
    res.end(JSON.stringify({ name: priced.name, refinedFrom, best: priced.bestSell ?? null, ...summary }));
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
  // What the canvas polls to decide whether to warn the user. Separate from /api/diagnostics so
  // asking "is OCR alive" doesn't drag the whole health report (and its live token check) with it.
  // The capture loop reporting that its RapidOCR engine would not start. Loopback-only like
  // everything else that describes this machine; it only ever sets a message the banner shows.
  if (url === "/api/ocr/rapid-failure" && req.method === "POST") {
    const body = await readBody(req);
    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 300) : "";
    rapidOcrFailure = reason ? { reason, at: new Date().toISOString() } : null;
    if (reason) console.error(`[ocr] RapidOCR unavailable: ${reason}`);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url === "/api/ocr/health" && req.method === "GET") {
    const health = await getOcrHealth();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    // `enabled:false` is why the canvas can tell "OCR is off" from "OCR is broken" — it must
    // never warn someone who deliberately has screen reading switched off.
    res.end(JSON.stringify({ enabled: screenReadingOn(), health }));
    return;
  }

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
        // Whether the engine actually WORKS here, not just whether it was asked for. Null when no
        // screen-reading feature is on, which is not a failure — there is nothing to test.
        ocr: await getOcrHealth(),
      },
      display: { hwAccel: config.hwAccel === true, amdCompat: config.amdCompat === true, theme: config.theme || "mobiglas" },
      twitch: { chatChannel: config.twitchChannel || "(none)", signedInAs: config.twitchUserLogin || "(not signed in)" },
      // Mixed-DPI is the one class of bug that is INVISIBLE from a machine whose monitors all
      // match, and the reports that reach us ("it's offset", "it vanished") can't distinguish a
      // window in the wrong place from a canvas laid out at the wrong scale. These are the numbers
      // that tell them apart, so they belong in the paste-able report rather than in a log file.
      geometry: overlayGeometry ?? "(the overlay has not reported yet — is it switched off?)",
      // Which language the log is being read in, and what we could not place. An unmatched
      // receipt is otherwise invisible — this is the difference between a user reporting "the
      // app is broken" and reporting "my language pack renamed these five things".
      localization: tracker.localizationStatus(),
      // Standing per giver plus the completion count behind it. A sum out of proportion to the
      // count is an accrual leak, and the count is the half that makes the sum interpretable.
      reputation: tracker.repDiagnostics(),
      // The last few canvas/page errors (see /api/client-error) — the report used to carry only
      // STATE, and "what recently went wrong" is the half a frozen-looking widget needs.
      recentClientErrors: clientErrors.slice(),
      // The tail of sidecar.log, so one Copy-diagnostics paste carries the history too — asking
      // a user to dig %APPDATA% out of a Discord thread was the single biggest support friction.
      // Secrets are redacted BY VALUE before anything leaves this process: the report's header
      // promises "no passwords or tokens" and the tail must not be the exception. mtime rides
      // along because a dev-run sidecar logs to a terminal, not this file — a stale tail must be
      // recognisable as stale rather than read as "the app logged nothing".
      logTail: (() => {
        try {
          const p = join(userDir, "sidecar.log");
          if (!existsSync(p)) return { lines: [], note: "no sidecar.log — dev runs log to the terminal instead" };
          const st = statSync(p);
          let text = readFileSync(p, "utf8");
          for (const secret of [config.syncToken, config.twitchUserToken, config.twitchRefreshToken]) {
            if (secret && secret.length >= 8) text = text.split(secret).join("[redacted]");
          }
          const all = text.split(/\r?\n/).filter((l) => l.trim().length);
          return {
            modifiedMinutesAgo: Math.round((Date.now() - st.mtimeMs) / 60000),
            lines: all.slice(-60),
          };
        } catch { return { lines: [], note: "sidecar.log unreadable" }; }
      })(),
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
  // the OCR's text). The glyph corroborates, it never licenses — what the tracker does with a read
  // is decided by the VALUE (see applyMineableRead), and a number the game cannot draw is refused
  // however convincing the pixels beside it looked.
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
  // Diagnostic liveness ping from the capture loop (electron/capture.cjs), throttled client-side to
  // ~15s, for an intermittent mining-loop hang that isn't root-caused yet. sidecar.log carries no
  // per-line timestamps otherwise, which made a real hang indistinguishable from "not at the
  // scanner" — this settles that question directly from the log. Safe to remove once the hang is
  // understood; harmless to leave in until then.
  if (url === "/api/heartbeat" && req.method === "POST") {
    const body = await readBody(req);
    console.log(`[mining-heartbeat] ${new Date().toISOString()} rate=${body?.rate}ms lastTick=${body?.lastTickMs}ms fastFor=${body?.fastUntil}ms`);
    // Also kept in memory so the cadence is retrievable over HTTP, not only from sidecar.log.
    lastHeartbeat = {
      at: Date.now(),
      rate: Number.isFinite(Number(body?.rate)) ? Number(body?.rate) : null,
      lastTickMs: Number.isFinite(Number(body?.lastTickMs)) ? Number(body?.lastTickMs) : null,
      fastForMs: Number.isFinite(Number(body?.fastUntil)) ? Number(body?.fastUntil) : null,
    };
    // Per-stage tick timings, batched by the capture loop so measuring adds no round-trips of its
    // own. This is what decides whether the tick cost is fixable and WHERE — the loop's fast rate
    // is floored at lastTickMs * 1.5, so an expensive stage silently caps how fast scanning can go.
    if (Array.isArray(body?.ticks)) {
      for (const t of body.ticks as Record<string, unknown>[]) {
        if (t && typeof t === "object") recentTicks.push({ at: Date.now(), ...t });
      }
      while (recentTicks.length > TICK_RING) recentTicks.shift();
    }
    res.writeHead(204);
    res.end();
    return;
  }

  // The canvas forwards its window.onerror / unhandledrejection here — the only durable place.
  // POST, so the standard mutating gate (loopback + Origin) already applies; nothing on the LAN
  // can write to this machine's log through it.
  if (url === "/api/client-error" && req.method === "POST") {
    const now = Date.now();
    if (now - clientErrWindowStart > 60_000) { clientErrWindowStart = now; clientErrWindowCount = 0; }
    if (++clientErrWindowCount > CLIENT_ERR_PER_MIN) {
      res.writeHead(429, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "too many error reports — the first ones are what matter" }));
      return;
    }
    const body = await readBody(req);
    const msg = String(body?.msg ?? "").slice(0, 300);
    if (!msg) {
      res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "msg is required" }));
      return;
    }
    const from = String(body?.source ?? "page").slice(0, 40);
    const stack = String(body?.stack ?? "").slice(0, 1200);
    clientErrors.push({ at: new Date().toISOString(), from, msg });
    while (clientErrors.length > CLIENT_ERR_KEEP) clientErrors.shift();
    console.error(`[client-error] [${from}] ${msg}${stack ? "\n" + stack : ""}`);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

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
        if (ev) { tracker.apply(ev); party.apply(ev); hauling.apply(ev); }
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

  // Hauling scenarios — the same idea as /api/dev/replay, but feeding the hauling tracker
  // instead of the report card, so the widget can be built and reviewed without flying a
  // contract. Separate route because it takes a different scenario shape entirely (legs,
  // positions, manifests) and returns the resulting view rather than a completion.
  if (url === "/api/dev/hauling-replay") {
    if (process.env.SC_DEV !== "1" || !fromThisMachine(req)) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "not available" }));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ scenarios: HAUL_SCENARIOS }));
      return;
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const wanted = (body as { scenario?: string })?.scenario;
      // No scenario named = run the whole set, which is the useful default: a real player holds
      // several contracts at once, and every layout question (do the cards stack, does the
      // please-track prompt crowd out the route list) only appears with more than one.
      const chosen = wanted ? HAUL_SCENARIOS.filter((x) => x.id === wanted) : HAUL_SCENARIOS;
      if (!chosen.length) {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "unknown scenario", known: HAUL_SCENARIOS.map((x) => x.id) }));
        return;
      }
      const now = Date.now();
      let count = 0;
      for (const s of chosen) {
        for (const line of haulReplayLines(s, replayMissionId(++replaySeq), now)) {
          const ev = parseMissionEvent(parseLine(line));
          if (ev) { hauling.apply(ev); count++; }
        }
      }
      console.log(`[dev-replay] hauling: ${chosen.map((s) => s.id).join(", ")} — ${count} events`);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, scenarios: chosen.map((s) => s.id), events: count, view: hauling.view() }));
      return;
    }
  }

  // Crowdsourced mission facts. POST one answer from the completion report; GET reads back
  // what this player already said about a contract so the report can pre-select it.
  // 🔑 `url` is already stripped of its query string, so the key comes off `req.url` — a route
  // written as `url.startsWith("/api/mission-feedback?")` could never match.
  if (url === "/api/mission-feedback" && req.method === "POST") {
    const body = await readBody(req);
    // Ship comes from the log, never from a question — the player already told the game what
    // they were flying. Prefer the one captured AT COMPLETION over whatever they are in now:
    // the report can sit on screen while they climb out, and a difficulty rating has to answer
    // for the run, not for where they happen to be standing when they click.
    const key = typeof (body as { contractKey?: unknown }).contractKey === "string" ? (body as { contractKey: string }).contractKey : "";
    const at = completionShip && completionShip.key === key ? completionShip : null;
    const saved = missionFeedback.record({
      ...(body as object),
      ship: at ? at.ship : shipName,
      shipManufacturer: at ? at.manufacturer : shipManufacturer,
      changelist: tracker.view().build,
      appVersion: APP_VERSION,
    });
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
  // 🔴 PATH TRAVERSAL. This was `join(overlayDir, decodeURIComponent(url))` with no containment
  // check, so `GET /..%2f..%2f…/config.json` walked straight out of the overlay directory and
  // returned the user's config — INCLUDING THEIR SYNC TOKEN — to anything that could reach port
  // 8778. Unauthenticated remote arbitrary file read, and the token is the whole account: chat
  // identity, collection, the lot. Reported by a viewer on Sub's stream (2026-08-09) and
  // reproduced here before fixing.
  //
  // 🔑 Decode FIRST, then resolve, then verify containment. Checking the raw string for ".."
  // is the classic non-fix — `%2e%2e%2f` sails past it, and it is `decodeURIComponent` that
  // turns it back into `../`. Only comparing the RESOLVED absolute path can be trusted, and it
  // needs the trailing separator or a sibling directory like `overlay-secrets/` also matches.
  let p = url === "/" ? "/index.html" : url;
  let decoded: string;
  try { decoded = decodeURIComponent(p); } catch { res.writeHead(400); res.end("bad path"); return; }
  const target = resolve(overlayDir, "." + (decoded.startsWith("/") ? decoded : "/" + decoded));
  const root = resolve(overlayDir) + sep;
  if (!target.startsWith(root)) {
    res.writeHead(403); res.end("forbidden");
    return;
  }
  readFile(target, (err, buf) => {
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
  startWatcher();
  // Arm chat AFTER the seed pass so the current shard (read from the log) rides the first
  // connection's loc frame instead of arriving as a later correction.
  chatConfigure();
  // Settle the OCR question at boot so the verdict is in sidecar.log whether or not anyone
  // thinks to ask for it — the log is what a user sends when they report "it isn't working",
  // and it was previously silent on the one thing that mattered. Fire-and-forget: it spawns a
  // PowerShell worker and nothing here should wait on it (no-op unless screen reading is on).
  void getOcrHealth().catch(() => { /* the self-test reports its own failures */ });
});
