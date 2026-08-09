// Bridges the overlay page to the shell:
//  - hover(on): become click-through only while the pointer is over the HUD.
//  - onMoveMode(cb): main tells the page to enter/exit "move" mode (drag banner).
//  - beginMove(): the page's grab handle asks main to enter move mode.
//  - endMove(): the page's Done button asks main to leave move mode.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayApi", {
  hover: (on) => ipcRenderer.send("overlay:hover", !!on),
  // Report the page's interactive element client-rects so the shell can hit-test the cursor
  // against them (replaces forward:true mouse-forwarding). rects = [{x,y,w,h}, …].
  reportRegions: (rects) => ipcRenderer.send("overlay:regions", rects),
  // The shell polls the global pointer while F is held. Ask the renderer which actual DOM
  // classification is under that canvas-local point instead of relying only on stale rectangles.
  onProbePoint: (cb) => ipcRenderer.on("overlay:probe-point", (_e, point) => cb(point)),
  reportPointClassification: (result) => ipcRenderer.send("overlay:point-classification", result),
  // A pointer press inside any shaped widget latches keyboard/mouse ownership to the overlay.
  // The latch ends when the native Overlay Manager loses focus to Star Citizen/another window.
  claimInteraction: (source) => ipcRenderer.send("overlay:claim-interaction", source || "widget"),
  releaseInteraction: (reason) => ipcRenderer.send("overlay:release-interaction", reason || "transparent canvas clicked"),
  beginMove: () => ipcRenderer.send("overlay:begin-move"),
  endMove: () => ipcRenderer.send("overlay:end-move"),
  // Force this window interactive for the duration of a drag/resize gesture so it can't drop.
  dragLock: (on) => ipcRenderer.send("overlay:drag-lock", !!on),
  onMoveMode: (cb) => ipcRenderer.on("overlay:move-mode", (_e, on) => cb(!!on)),
  // Foreground tracking (Windows) and Linux native interaction events.
  wantForeground: (on) => ipcRenderer.invoke("app:want-foreground", !!on),
  onGameFocus: (cb) => ipcRenderer.on("overlay:game-focus", (_e, on) => cb(!!on)),
  onUnifiedInteraction: (cb) => ipcRenderer.on("overlay:unified-interaction", (_e, on) => cb(!!on)),
  onMiningOnlyInteraction: (cb) => ipcRenderer.on("overlay:mining-only-interaction", (_e, on) => cb(!!on)),
  onMiningMoveMode: (cb) => ipcRenderer.on("overlay:mining-move-mode", (_e, on) => cb(!!on)),  // The app version (authoritative), for the "what's new" card.
  // The overlay window itself gaining/losing focus. Distinct from onGameFocus: that reports what
  // is in the FOREGROUND (used to fade the cog while you play), this reports that the user
  // deliberately switched TO the overlay via Alt-Tab or the taskbar.
  onWindowFocus: (cb) => ipcRenderer.on("overlay:window-focus", (_e, on) => cb(!!on)),
  // The app version (authoritative), for the "what's new" card.
  getVersion: () => ipcRenderer.invoke("app:version"),
  // While a modal (what's-new card) is open, keep the HUD hover-interactive even when
  // "locked" — so the card is always closeable while the game runs.
  setModal: (on) => ipcRenderer.send("overlay:modal", !!on),
  // OCR activity from the fabricator/mission capture loop → the cog's status readout + toasts.
  onOcr: (cb) => ipcRenderer.on("overlay:ocr", (_e, s) => cb(s)),
  // Open the full settings window (from the cog's "Open settings…").
  openSettings: () => ipcRenderer.send("overlay:open-settings"),
  // Open an external URL in the default browser (e.g. the live-on-Twitch diamond).
  openUrl: (url) => ipcRenderer.send("overlay:open-url", url),
  // The Web Page widget's content is a native WebContentsView owned by main, not an iframe —
  // an iframe can't show sites that refuse framing (RSI busts frames client-side). The widget
  // keeps its chrome here and leaves a HOLE; these report where that hole is and what goes in it.
  webViewBounds: (r) => ipcRenderer.send("webview:bounds", r),
  webViewShow: (on) => ipcRenderer.send("webview:show", !!on),
  webViewLoad: (url) => ipcRenderer.send("webview:load", url),
  webViewReload: () => ipcRenderer.send("webview:reload"),
  webViewBack: () => ipcRenderer.send("webview:back"),
  webViewClose: () => ipcRenderer.send("webview:close"),
  onWebViewState: (cb) => ipcRenderer.on("webview:state", (_e, s) => cb(s)),
  // Whether the view is actually being painted right now (it stands down for arrange mode, a
  // modal, or the overlay being switched off). A hidden view can't report this about itself.
  onWebViewPainted: (cb) => ipcRenderer.on("webview:painted", (_e, s) => cb(s)),
  // Cursor entered/left the view. The canvas can't see this itself — the view is a native
  // surface, not an iframe — and without it the Web Page widget's bar never comes out.
  onWebViewCursor: (cb) => ipcRenderer.on("webview:cursor", (_e, on) => cb(!!on)),
  // Canvas chrome is open over the native view and would otherwise be painted behind it.
  maskWebView: (on) => ipcRenderer.send("overlay:mask-view", !!on),
  // Per-widget canvas layout: read saved positions/sizes on load, and persist them as the
  // user drags/resizes a widget in arrange mode. Layout = { [id]: {x, y, scale, visible} }.
  getWidgets: () => ipcRenderer.invoke("overlay:get-widgets"),
  saveWidget: (id, layout) => ipcRenderer.send("overlay:save-widget", id, layout),
  // Primary-display offset/size within the full-desktop canvas (for default widget placement).
  getCanvasInfo: () => ipcRenderer.invoke("overlay:canvas-info"),
  // The window was re-fitted (monitor added/removed/rearranged, a Windows display-scaling change,
  // or the user nudging the canvas) — every number getCanvasInfo returned is now stale.
  onCanvasChanged: (cb) => ipcRenderer.on("overlay:canvas-changed", () => cb()),
  // Global overlay-app chrome (the in-overlay hub): toggle the other widgets on/off, read
  // their current visibility, enter/leave global arrange, and open the full settings window.
  setMining: (on) => ipcRenderer.send("app:set-mining", !!on),
  setNotepad: (on) => ipcRenderer.send("app:set-notepad", !!on),
  setBrowser: (on) => ipcRenderer.send("app:set-browser", !!on),
  setTwitchChat: (on) => ipcRenderer.send("app:set-twitch-chat", !!on),
  onNotepadVisible: (cb) => ipcRenderer.on("overlay:notepad-visible", (_e, s) => cb(s)),
  // Notepad typing mode: the overlay grabs keyboard focus + suspends the interact key so the
  // note field can be typed into over a focused game. onNotepadFocus fires once it's safe to
  // focus the field (the held interact key was released) so no stray character lands.
  notepadEditing: (on) => ipcRenderer.send("overlay:notepad-editing", !!on),
  onNotepadFocus: (cb) => ipcRenderer.on("overlay:notepad-focus", () => cb()),
  setTwitchChat: (on) => ipcRenderer.send("app:set-twitchchat", !!on),
  onTwitchChatVisible: (cb) => ipcRenderer.on("overlay:twitchchat-visible", (_e, s) => cb(s)),
  setScFeed: (on) => ipcRenderer.send("app:set-scfeed", !!on),
  onScFeedVisible: (cb) => ipcRenderer.on("overlay:scfeed-visible", (_e, s) => cb(s)),
  setUnlockAlert: (on) => ipcRenderer.send("app:set-unlockalert", !!on),
  onUnlockAlertVisible: (cb) => ipcRenderer.on("overlay:unlockalert-visible", (_e, s) => cb(s)),
  scFeedPickTone: () => ipcRenderer.invoke("scfeed:pick-tone"),
  scFeedClearTone: () => ipcRenderer.invoke("scfeed:clear-tone"),
  setParty: (on) => ipcRenderer.send("app:set-party", !!on),
  onPartyVisible: (cb) => ipcRenderer.on("overlay:party-visible", (_e, s) => cb(s)),
  setBattaglia: (on) => ipcRenderer.send("app:set-battaglia", !!on),
  onBattagliaVisible: (cb) => ipcRenderer.on("overlay:battaglia-visible", (_e, s) => cb(s)),
  // Social chat: shell-owned visibility; its send field reuses the keyboard-grab above.
  setChat: (on) => ipcRenderer.send("app:set-chat", !!on),
  onChatVisible: (cb) => ipcRenderer.on("overlay:chat-visible", (_e, s) => cb(s)),
  // Settings as a canvas widget (the standalone window still exists — see openSettings above).
  setConfig: (on) => ipcRenderer.send("app:set-config", !!on),
  onConfigVisible: (cb) => ipcRenderer.on("overlay:config-visible", (_e, s) => cb(s)),
  // Reveal one of the app's own data folders in Explorer (allow-listed in main).
  openDataFolder: (which) => ipcRenderer.send("app:open-data-folder", String(which)),
  // First-run setup: existing users with unfinished setup get one dismissible banner here
  // rather than the wizard taking over their screen. `openSetupWizard` is what its button calls.
  // The background service (sidecar) going down and coming back. It does ALL the work — the
  // overlay is only the display — so without this a dead sidecar looks like a perfectly normal
  // HUD that silently tracks nothing.
  onSidecarState: (cb) => ipcRenderer.on("overlay:sidecar-state", (_e, s) => cb(s)),
  retrySidecar: () => ipcRenderer.send("app:retry-sidecar"),
  onSetupNudge: (cb) => ipcRenderer.on("overlay:setup-nudge", (_e, s) => cb(s)),
  openSetupWizard: () => ipcRenderer.send("setup:open-wizard"),
  // Web Page widget + the Binding Chart WIDGET (the full-screen binding overlay is separate).
  setWebView: (on) => ipcRenderer.send("app:set-webview", !!on),
  onWebViewVisible: (cb) => ipcRenderer.on("overlay:webview-visible", (_e, s) => cb(s)),
  setBindingChart: (on) => ipcRenderer.send("app:set-bindingchart", !!on),
  onBindingChartVisible: (cb) => ipcRenderer.on("overlay:bindingchart-visible", (_e, s) => cb(s)),
  onBindingChartReload: (cb) => ipcRenderer.on("overlay:bindingchart-reload", () => cb()),
  widgetStates: () => ipcRenderer.invoke("app:widget-states"),
  canvasCalibration: (cal) => ipcRenderer.invoke("app:canvas-calibration", cal),
  onWidgetStates: (cb) => ipcRenderer.on("overlay:widget-states", (_e, s) => cb(s)),
  arrange: (on) => ipcRenderer.send(on ? "overlay:begin-move" : "overlay:end-move"),
  // The embedded Mining widget's cog summons the shared Overlay Manager cog.
  onSummonCog: (cb) => ipcRenderer.on("overlay:summon-cog", () => cb()),

  // Low-resource browser and Twitch-chat WebContentsView controls. The renderer owns the
  // draggable widget shells; the main process owns and positions the isolated web contents.
  browserState: () => ipcRenderer.invoke("browser:state"),
  onBrowserState: (cb) => ipcRenderer.on("browser:state", (_e, s) => cb(s)),
  browserBounds: (bounds) => ipcRenderer.send("browser:bounds", bounds),
  twitchChatBounds: (bounds) => ipcRenderer.send("browser:chat-bounds", bounds),
  browserNavigate: (url) => ipcRenderer.send("browser:navigate", url),
  browserBack: () => ipcRenderer.send("browser:back"),
  browserForward: () => ipcRenderer.send("browser:forward"),
  browserReload: () => ipcRenderer.send("browser:reload"),
  browserStop: () => ipcRenderer.send("browser:stop"),
  browserVisible: (on) => ipcRenderer.send("browser:set-visible", !!on),
  twitchChatVisible: (on) => ipcRenderer.send("browser:set-chat-visible", !!on),
  twitchChatChannel: (channel) => ipcRenderer.send("browser:set-channel", channel),
  onFHover: (cb) => ipcRenderer.on("overlay:f-hover", (_e, s) => cb(s)),

  // ── Mining Assistant (now folded into this canvas as an iframe widget) ──────────
  // The embedded mining page reaches these through the parent (same-origin). Native tone
  // picker + clear (renderers can't open OS dialogs); a suppress-gated auto-show request;
  // and main → renderer show/arm/hide of the in-canvas mining widget.
  pickTone: () => ipcRenderer.invoke("mining:pick-tone"),
  clearTone: () => ipcRenderer.invoke("mining:clear-tone"),
  miningAutoShow: () => ipcRenderer.send("mining:show"),
  onMiningVisible: (cb) => ipcRenderer.on("overlay:mining-visible", (_e, s) => cb(s)),

  // ── Settings as an embedded canvas widget ──────────────────────────────────────
  // config.html normally runs in its OWN window with its own preload (config-preload.cjs).
  // Embedded on the canvas it is an iframe and has no preload at all, so the canvas re-exposes
  // that same API as `__configHost` and the page synthesizes `window.overlayConfig` on top of
  // it — which is why none of config.html's ~23 existing call sites had to change.
  // 🔑 Every channel here is one the settings WINDOW already uses; this adds reach, not power.
  cfg: {
    pickPng: () => ipcRenderer.invoke("pick-png"),
    pickLog: (current) => ipcRenderer.invoke("pick-log", current),
    setOverlayHotkey: (a) => ipcRenderer.invoke("set-overlay-hotkey", a),
    setBindingHotkey: (a) => ipcRenderer.invoke("set-binding-hotkey", a),
    setMiningHotkey: (a) => ipcRenderer.invoke("set-mining-hotkey", a),
    setWebViewHotkey: (a) => ipcRenderer.invoke("set-webview-hotkey", a),
    setNotepadHotkey: (a) => ipcRenderer.invoke("set-notepad-hotkey", a),
    setInteractHotkey: (a) => ipcRenderer.invoke("set-interact-hotkey", a),
    setMoveHotkey: (a) => ipcRenderer.invoke("set-move-hotkey", a),
    setFabClaimHotkey: (a) => ipcRenderer.invoke("set-fabclaim-hotkey", a),
    setHoldMode: (on) => ipcRenderer.invoke("app:set-hold-mode", !!on),
    resetLayout: () => ipcRenderer.invoke("overlay:reset-layout"),
    canvasCalibration: (cal) => ipcRenderer.invoke("app:canvas-calibration", cal),
    metrics: () => ipcRenderer.invoke("app:metrics"),
    openDataFolder: (which) => ipcRenderer.send("app:open-data-folder", String(which)),
    isElevated: () => ipcRenderer.invoke("app:is-elevated"),
    restartAsAdmin: () => ipcRenderer.invoke("app:restart-as-admin"),
    getOverlayEnabled: () => ipcRenderer.invoke("overlay:get-enabled"),
    setOverlayEnabled: (on) => ipcRenderer.invoke("overlay:set-enabled", on),
    onOverlayEnabledChanged: (cb) => ipcRenderer.on("overlay:enabled-changed", (_e, on) => cb(on)),
  },
});
