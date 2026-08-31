/**
 * THE SIDECAR'S CONFIG — its shape, its defaults, where it lives on disk, and how it is read.
 *
 * 🔴 THE PATHS AND THE CONFIG ARE ONE SUBJECT, which is why they share a file. The whole reason
 * the path block exists is that config must be written to %APPDATA% and NEVER beside the binary:
 * the installed app lives under Program Files (read-only), and writing there threw EPERM and
 * killed the sidecar invisibly — which presented as a blank config window and no sync at all.
 * Separating "where it goes" from "what it is" would put that reasoning in a different file from
 * the thing it constrains.
 *
 * What is NOT here: the mutable `config` singleton itself. It stays in overlay-server.ts as
 * `let config: Config = loadConfig()`, so all 239 `config.` reads are untouched and nothing had
 * to learn an accessor. This module hands out the shape and the loader; the server owns the value.
 *
 * `payoutScanWasArmedOnDisk` is an exported `let` written only by `loadConfig`. ESM export
 * bindings are live, so the server reads the current value rather than a snapshot — that is the
 * only reason it can stay a flag instead of becoming a return value, which would have been a
 * signature change rather than a move.
 *
 * Lifted verbatim out of overlay-server.ts (2026-08-19).
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { assetDir } from "./paths.js";
import { contractRegionOrDefault, DEFAULT_CONTRACT_REGION, type ScanRegion } from "./screen-read.js";

export const overlayDir = assetDir(import.meta.url, "overlay");
export const bundledDataDir = assetDir(import.meta.url, "data");

// Persist runtime state in a per-user writable dir — NEVER next to the binary.
// The installed app lives under Program Files (read-only); writing config.json
// there threw EPERM and crashed the whole server. This matches where the mission
// tracker already keeps collected.json.
export const userDir = join(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");
export const configPath = join(userDir, "config.json");
// Read-only default that ships with the app; only used to seed a first run.
export const seedConfigPath = join(overlayDir, "config.json");
// Writable copy of the datasets: bundled pools are seeded in, and any pools the
// tracker fetches for a not-yet-bundled patch cache here (Program Files is read-only).
export const dataDir = join(userDir, "data");
// Which rotated sessions (logbackups/) have already been shared. Remembered by FILENAME, and
// permanently — a backup is immutable, so "sent", "wrong patch" and "no mission signal" are all
// final answers. Without this every app launch would re-offer the whole folder.
export const sharedLogStatePath = join(userDir, "shared-logs.json");

export interface Config {
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
  /** Read the in-game REP page and re-baseline the player's standing from it.
   *
   *  🔑 A STANDING preference, deliberately unlike `payoutScan` above, which is forced off on
   *  every load. That one is a temporary MODE because it feeds a shared dataset, which is a
   *  different bargain from the rest of the OCR here. This one reads the player's own screen for
   *  the player's own bar — the same bargain as the Mining Scanner and the fabricator capture —
   *  so it stays where they are: opt-in, off by default, and it means it when it is on. */
  repScan: boolean;
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
  /** Remembers whether the Quartermaster widget was left open, so it's restored on launch. */
  quartermasterOpen: boolean;
  /** Quartermaster auto-capture: "off" (default), "chips" (one-click confirm), or "auto"
   *  (kiosk buys of tracked stock commit unasked). A standing preference, deliberately
   *  unlike payoutScan: nothing here costs anything to keep armed — the funnel already
   *  runs for the trade journal. */
  qmCapture: "off" | "chips" | "auto";
  /** Remembers whether the Battaglia grind widget was left open, so it's restored on launch. */
  battagliaOpen: boolean;
  /** Remembers whether the Hauling widget was left open, so it's restored on launch. */
  haulingOpen: boolean;
  /** Remembers whether the Log View widget was left open, so it's restored on launch. */
  logViewOpen: boolean;
  /** Remembers whether the Verse Finder widget was left open, so it's restored on launch. */
  verseFinderOpen: boolean;
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
  /**
   * The game's NUMERIC location ids bound to the readable tokens seen at the same place —
   * `{"3490636373": "RR_ARC_LEO"}`.
   *
   * 🔑 Nothing in the log states this pairing. The ASOP terminal, an inventory move and the freight
   * kiosk all report a bare number; only `RequestLocationInventory` reports a name. Observing both
   * within a short window at one place is what binds them, and once bound the number alone is a
   * position fix — which matters because ASOP and item-moves are the terminals you touch when you
   * are NOT moving cargo, exactly the gap the named signal leaves.
   */
  haulingPlaceIds: Record<string, string>;
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

export const DEFAULTS: Config = {
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
  repScan: false,
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
  quartermasterOpen: false,
  qmCapture: "off",
  battagliaOpen: false,
  haulingOpen: false,
  logViewOpen: false,
  verseFinderOpen: false,
  haulingShip: "",
  haulingPlaces: {},
  haulingSeenPlaces: [],
  haulingPlaceIds: {},
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
export let payoutScanWasArmedOnDisk = false;

export function loadConfig(): Config {
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
          haulingPlaceIds: { ...(raw?.haulingPlaceIds ?? {}) },
          haulingSeenPlaces: Array.isArray(raw?.haulingSeenPlaces) ? [...raw.haulingSeenPlaces] : [] };
      }
    } catch {
      /* corrupt — try the next source */
    }
  }
  return { ...DEFAULTS, haulingPlaces: {}, haulingPlaceIds: {}, haulingSeenPlaces: [] };
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
export const freshInstall = !existsSync(configPath);
