/**
 * THE WIDGET CANVAS — the overlay shell that hosts every widget, including the tracker.
 *
 * The WIDGETS registry, per-widget frames and their lifecycle, grouping and group tabs, the
 * bottom chrome bar and its per-widget settings popover, drag/resize/arrange mode, the two
 * independent fade alphas, text scale and tilt, the hub, the what's-new card, the mining scan box,
 * the contract-board box, the payout panel, the Web Page widget's native-view mask, and the OCR
 * status chrome.
 *
 * Everything the TRACKER PANEL itself draws is missions-tracker.js, which loads before this file.
 * The split is by reason to change: this file moves when the widget system does.
 *
 * Lifted verbatim out of missions.html (2026-08-19). Classic scripts on one page share a global
 * lexical environment, so nothing here is exported and not one call site moved; load order is
 * preserved exactly — this runs after the tracker, as it always did.
 */
  // ── Canvas widget: free-floating position + independent scale + arrange drag/resize ──
  // Only active in canvas mode (Electron overlay-app, or ?canvas=1). The panel is positioned
  // by --wx/--wy and sized by --wscale; arrange mode (move mode) lets the user drag it and
  // drag the corner to resize, persisting the layout to widgets.json via the shell.
  // ── The Blueprint panel is a REGISTRY widget now ────────────────────────────────────────
  // Its geometry, drag, resize, grouping and text size all run through the same code as every
  // other widget (WBY.blueprint, `local: true`). What survives here are thin aliases, so the many
  // existing call sites keep working while there is still exactly one source of truth.
  const BP = () => WBY.blueprint;
  function applyWidget() { applyFrame(BP()); }
  function persistWidget() { persistW(BP()); }
  function defaultWidgetPos() { BP().defFn(BP()); }
  function setBlueprintVisible(on) { setWidgetVisible(BP(), on); }

  // Pointer-drag helper: track by delta so the panel's transform (twist/scale) never fights it.
  // Holds a shell "drag lock" for the gesture so the (otherwise hover-gated) window stays
  // interactive even if the pointer briefly outruns the widget.
  //
  // 🔑 The gesture runs under a full-canvas SHIELD. Every other widget is an IFRAME, and pointer
  // events over an iframe belong to ITS document — this window's pointermove simply stops
  // arriving. That is the whole "the box freezes when I drag near another box, then jumps to
  // catch up" bug: the drag wasn't slow, it was blind for as long as the cursor was over a
  // neighbour. The shield keeps every event in this document for the duration.
  function dragPointer(onMove, onEnd, opts) {
    const resizing = !!(opts && opts.resize);
    window.overlayApi?.dragLock?.(true);
    const shield = $("dragShield");
    if (shield) shield.classList.toggle("resizing", resizing);
    shield?.classList.add("on");
    // `bare` skips the drop-target reveal: that exists so a dragged WIDGET can be dropped into a
    // group, and nothing else can be. Showing every bar while dragging canvas chrome (which no
    // group will ever accept) advertises a drop that cannot happen.
    if (!resizing && !(opts && opts.bare)) document.body.classList.add("dragging"); // every bar comes out as a drop target
    const move = (ev) => onMove(ev);
    let ended = false;
    const up = () => {
      if (ended) return;
      ended = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
      shield?.classList.remove("on", "resizing");
      document.body.classList.remove("dragging");
      window.overlayApi?.dragLock?.(false);
      (onEnd || persistWidget)();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    // ⚠️ pointerup ALONE is not enough to lower a drag lock. A cancelled pointer or a window that
    // loses the device leaves it raised, and a raised lock makes the whole overlay swallow every
    // click on every display. Cheap to listen for; catastrophic to miss.
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
  }

  // Primary-display offset/size within the full-desktop canvas (fetched at init). Falls back to
  // the whole window so a single-monitor / non-electron context still works.
  let canvasInfo = null;
  // Publish the PRIMARY monitor's rect within the (multi-monitor) canvas as CSS vars, so screen-
  // anchored chrome (the arrange banner/frame + summoned cog) pins to the primary, never a void corner.
  function applyCanvasVars() {
    const ci = canvasInfo; if (!ci) return;
    const s = document.documentElement.style, vw = ci.vw != null ? ci.vw : (ci.px + ci.pw);
    // The user's canvas scale (mixed-DPI calibration; 1 for everyone who doesn't need it). CSS
    // `zoom` on the ROOT scales the whole canvas as one — the dotted primary outline, every
    // widget's position and, measured in Electron 43, the content INSIDE each widget's iframe.
    // 🔑 It also makes getBoundingClientRect() report zoom-adjusted px, so the regions we hand the
    // shell for cursor hit-testing stay in window coordinates with no correction at either end.
    s.zoom = ci.scale && ci.scale !== 1 ? String(ci.scale) : "";
    s.setProperty("--prim-top", ci.py + "px");
    s.setProperty("--prim-left", ci.px + "px");
    s.setProperty("--prim-cx", (ci.px + ci.pw / 2) + "px");
    s.setProperty("--prim-right", (vw - (ci.px + ci.pw)) + "px");
    s.setProperty("--prim-w", ci.pw + "px");
    s.setProperty("--prim-h", ci.ph + "px");
  }
  // Re-read the geometry and re-lay-out everything that hangs off it. The shell fires
  // overlay:canvas-changed whenever the window is re-fitted — a monitor plugged/unplugged, a
  // WINDOWS DISPLAY-SCALING CHANGE, or the user nudging the canvas. Without this the window
  // resized underneath a page still laid out for the old arrangement, and the nudge appeared to
  // do nothing at all (the window moved; --prim-* and every widget's position did not).
  async function refreshCanvasGeometry() {
    try { canvasInfo = await window.overlayApi?.getCanvasInfo?.() || canvasInfo; } catch { /* keep what we had */ }
    applyCanvasVars();
    applyAllFrames();
    drawScanBox();
    reportGeometry();
  }
  // The canvas's half of the mixed-DPI diagnostics: what this document actually LAID OUT, which
  // only it can say. The shell posts the display/window half (see reportGeometry in main.cjs); a
  // fault can live in either, and the pair is what tells "the window is in the wrong place" apart
  // from "the window is right and the canvas inside it is the wrong size".
  function reportGeometry() {
    if (!CANVAS) return;
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    const body = { canvas: {
      canvasInfo,
      zoom: document.documentElement.style.zoom || "(none)",
      devicePixelRatio: window.devicePixelRatio,
      inner: { w: window.innerWidth, h: window.innerHeight },
      // The dotted primary outline is drawn from these, so they ARE the alignment target.
      prim: { top: v("--prim-top"), left: v("--prim-left"), w: v("--prim-w"), h: v("--prim-h"), right: v("--prim-right") },
    } };
    fetch("/api/overlay-geometry", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => { /* diagnostics must never break a re-layout */ });
  }
  // ══ Canvas widgets ═══════════════════════════════════════════════════════════════════════
  // Every embedded widget is the same object: an iframe on THIS canvas whose geometry this shell
  // owns (one window → no cross-window z-order bugs), whose visibility the shell (main.cjs)
  // drives — so tray, hotkey, hub toggle and auto-show stay ONE source of truth — and whose
  // layout persists to widgets.json under `key`.
  //
  // This was eight hand-copied blocks that differed only in their variable names, so adding a
  // widget meant thirteen separate hookups and grouping them would have meant knowing eight sets
  // of ids. Only the GENUINE differences live in the table now; the generic machinery below is
  // written once.
  //
  //   key       widgets.json key + the shell visibility channel it answers to
  //   page      embedded page, loaded as /<page>?embedded=1&theme=…
  //   title     iframe title / the name this widget goes by in the UI
  //   def       default resting spot — PRIMARY-relative; applyFrame() adds the canvas offset
  //   size      default box size, plus the clamps its corner drag honours
  //   shape     "box" (flat; the corner drag GROWS it to show more — right for anything
  //             text-bearing) or "scaled" (tilt + zoom as one unit — Mining's fixed-size readout)
  //   notifier  invisible until it has something to say; gets a labelled drop zone in arrange
  //   focusFn   contentWindow fn focusing its text field, for the shared in-game typing grab
  //   host      extra members merged onto the same-origin bridge the embedded page calls
  //   onShow / onHide   side effects when visibility flips
  //
  // Note the resize clamps are per-widget and deliberately NOT normalised: only Web Page and
  // Binding Chart were raised to 6000×3000 (they hold a whole website / a dense chart); the rest
  // keep the tighter caps they shipped with.
  const WIDGETS = [
    {
      // The main Blueprint panel. A registry widget like any other so it can be GROUPED (Battaglia
      // + missions was the pairing Sub wanted), but LOCAL: it lives in this document rather than an
      // iframe, so it has no page to load, no theme to push and no bridge to talk over.
      key: "blueprint", local: true, title: "Mission & BP Tracker", flair: true,
      size: { w: 380, h: 560, minW: 300, maxW: 1400, minH: 240, maxH: 1600 },
      // Default resting spot: top-right of the PRIMARY display, where this panel has always sat.
      defFn: (w) => {
        const ci = canvasInfo || { px: 0, py: 0, pw: window.innerWidth, ph: window.innerHeight };
        w.s.x = Math.max(8, Math.round(ci.pw - (w.s.w != null ? w.s.w : w.size.w) - 40));
        w.s.y = 40;
      },
      // 🔴 Hiding the panel with the search box open would strand the canvas-wide keyboard grab:
      // the panel goes away, `notepadEditing` stays true, and every click on every display stops
      // reaching the game with nothing on screen to explain it or turn it off. The registry's
      // other typing widgets all carry this exact hook for the same reason.
      onHide: () => { try { closeSearch(); } catch { /* never block a hide */ } },
    },
    {
      key: "mining", page: "mining.html", title: "Mining Scanner",
      // Box-shaped like every other widget as of 2026-07-25. It used to be "scaled" (tilt+zoom as
      // a unit, sizing its own frame from its content) and that made it the odd one out: a stack
      // shares ONE box, so a member insisting on its own size fought it, rendered clipped, and
      // drifted further on every merge. Responsive + a text-size control is the better trade.
      allow: "autoplay", flair: true,
      def: { x: 40, y: 60 }, size: { w: 416, h: 560, minW: 300, maxW: 1400, minH: 240, maxH: 1600 },
      // A hidden-but-ARMED mining widget stays subscribed so auto-show can pop it on a scan — so
      // it has to be TOLD it's hidden or it announces from off-screen. The rule for every widget:
      // invisible means no sound and no work beyond whatever is needed to un-hide itself.
      // The scan read area goes wherever this widget goes — see syncScanBox. Closing the scanner
      // (hotkey, hub, tray, or a stack bringing another member forward) used to leave the outline
      // sitting on the game with nothing left to explain it.
      onShow: (w) => { try { frameWin(w)?.__miningSetHidden?.(false); } catch { /* not ready */ } syncScanBox(); },
      onHide: (w) => { try { frameWin(w)?.__miningSetHidden?.(true); } catch { /* not ready */ } syncScanBox(); },
      host: (w) => ({
        setModal: (on) => { miningModal = !!on; syncModal(); },
        requestAutoShow: () => window.overlayApi?.miningAutoShow?.(),
        // "Show the scan read area": drawn here, because only the canvas spans the screen. The page
        // has already written the pref, and syncScanBox reads it — one rule for the toggle, the
        // widget being closed, and startup, instead of three places that can disagree.
        scanBox: () => syncScanBox(),
        // Every signature read, announced or not, so the box can show what the OCR actually saw.
        scanRead: (info) => showScanRead(info),
        // Mining's settings menu has its own angle slider; it drives the parent's state like every
        // other widget's does, so a stacked Mining tilts the whole stack.
        getAngle: () => wAngle(w),
        setAngle: (deg) => setWidgetAngle(w, deg),
        persist: () => persistLayout(w),
      }),
    },
    {
      // 🔑 key "config", not "settings": the bridge is named window["__" + key + "Host"], and
      // config.html reaches for __configHost. The page name, the bridge and the saved-layout key
      // all line up; only the LABEL is "Settings".
      key: "config", page: "config.html", title: "Settings",
      def: { x: 200, y: 80 }, size: { w: 720, h: 620, minW: 420, maxW: 6000, minH: 320, maxH: 3000 },
      focusFn: "__configFocus", // hotkey capture + text fields need the shared keyboard grab
      // Re-expose the settings-window preload API to the embedded page. Listed explicitly rather
      // than spread: `overlayApi.cfg` is a contextBridge proxy, and wrapping each call keeps this
      // working whether or not that object survives a spread.
      host: () => {
        const c = window.overlayApi?.cfg;
        if (!c) return {};
        const out = {};
        for (const k of [
          "pickPng", "pickLog", "setOverlayHotkey", "setBindingHotkey", "setMiningHotkey",
          "setWebViewHotkey", "setInteractHotkey", "setMoveHotkey", "setFabClaimHotkey",
          "setOpacityHotkey", "setUnfocusedOpacity",
          "setHoldMode", "resetLayout", "metrics", "openDataFolder", "isElevated",
          "restartAsAdmin", "getOverlayEnabled", "setOverlayEnabled", "onOverlayEnabledChanged",
          // 🔑 This list is an ALLOWLIST, so a method added to config-preload.cjs reaches the
          // settings WINDOW and silently misses the embedded widget. canvasCalibration shipped
          // that way: config.html hides the row when the bridge doesn't answer, so the control
          // was simply absent from the surface most people open. Add here as well as there.
          "canvasCalibration",
        ]) {
          if (typeof c[k] === "function") out[k] = (...a) => c[k](...a);
        }
        return out;
      },
    },
    {
      key: "notepad", page: "notepad.html", title: "Journal",
      def: { x: 480, y: 60 }, size: { w: 320, h: 380, minW: 220, maxW: 900, minH: 160, maxH: 900 },
      focusFn: "__notepadFocus",
      // Don't strand the keyboard grab: hiding mid-typing would leave the interact key suspended.
      onHide: (w) => { try { frameWin(w)?.__notepadExitTyping?.(); } catch { /* iframe gone */ } },
    },
    {
      key: "twitchChat", page: "twitchchat.html", title: "Twitch Chat",
      def: { x: 860, y: 60 }, size: { w: 340, h: 460, minW: 260, maxW: 900, minH: 220, maxH: 1100 },
      focusFn: "__twitchChatFocus",
      // Hiding mid-typing must release the keyboard grab, or the whole canvas stays interactive
      // with nothing visible to explain it — and hide UNLOADS the iframe, so the page can never
      // release it after the fact. Same rule as notepad/party/chat.
      onHide: (w) => { try { frameWin(w)?.__twitchChatExitTyping?.(); } catch { /* iframe gone */ } },
      // Sign-in sends the user to twitch.tv/activate — that has to open in a real browser.
      host: () => ({ openUrl: (u) => window.overlayApi?.openUrl?.(u) }),
    },
    {
      key: "scFeed", page: "scfeed.html", title: "SC Feed",
      notifier: true, z: 21,
      def: { x: 480, y: 560 }, size: { w: 340, h: 140, minW: 240, maxW: 760, minH: 110, maxH: 420 },
      moveLabel: "📰 SC Feed news pops up here · drag to move · corner to resize",
      host: (w) => ({
        // The card faded in/out — flip the interactive-region flag with it, so an idle feed can
        // never swallow a click meant for the game.
        active: (on) => { const el = wEl(w); if (el) el.classList.toggle("live", !!on); },
        openUrl: (url) => window.overlayApi?.openUrl?.(url),
        pickTone: () => window.overlayApi?.scFeedPickTone?.(),   // native dialog lives in the shell
        clearTone: () => window.overlayApi?.scFeedClearTone?.(),
      }),
      onHide: (w) => { wEl(w)?.classList.remove("live"); },
    },
    {
      // The "Blueprint Received" toast, as a widget you can put where you'll actually see it.
      // It used to be pinned to the bottom edge of the Blueprint panel, which is the one place a
      // notification is useless — Sub unlocked a blueprint and never saw it fire.
      key: "unlockAlert", page: "unlockalert.html", title: "Unlock Alerts",
      notifier: true, z: 22,
      def: { x: 780, y: 300 }, size: { w: 320, h: 86, minW: 240, maxW: 620, minH: 74, maxH: 200 },
      moveLabel: "✓ Blueprint unlocks pop up here · drag to move · corner to resize",
      host: (w) => ({
        // Only claim screen space while a card is actually up (see .live in the RSEL region list).
        active: (on) => { const el = wEl(w); if (el) el.classList.toggle("live", !!on); },
      }),
      onHide: (w) => { wEl(w)?.classList.remove("live"); },
    },
    {
      key: "party", page: "party.html", title: "Loot Split",
      def: { x: 860, y: 560 }, size: { w: 340, h: 400, minW: 280, maxW: 760, minH: 200, maxH: 900 },
      focusFn: "__partyFocus",
      host: () => ({
        // Reveal the saved-splits folder so a crew can open the plain-text copies outside the app.
        openFolder: () => window.overlayApi?.openDataFolder?.("party-sessions"),
      }),
      onHide: (w) => { try { frameWin(w)?.__partyExitTyping?.(); } catch { /* iframe gone */ } },
    },
    {
      key: "battaglia", page: "battaglia.html", title: "Event Tracker",
      def: { x: 40, y: 560 }, size: { w: 360, h: 470, minW: 300, maxW: 760, minH: 240, maxH: 900 },
    },
    {
      // Hauling optimiser: what order to run the accepted contracts, and where the boxes go.
      // Wider and taller than its neighbours by default because it draws a to-scale cell map of a
      // cargo grid — a C2's main hold is 8 cells across and 15 deep, and squeezing that into a
      // 360px column makes the one thing the widget exists to show unreadable.
      // The title carries the warning too: the hub list and the tray are where someone TURNS IT ON,
      // which is before they ever see the widget's own badge.
      key: "hauling", page: "hauling.html", title: "Hauling (experimental)",
      def: { x: 420, y: 200 }, size: { w: 440, h: 620, minW: 320, maxW: 1200, minH: 260, maxH: 1400 },
      focusFn: "__haulingFocus", // the SCU pin box needs the shared keyboard grab
      // Don't strand the keyboard grab: hiding mid-edit would leave the interact key suspended,
      // and hide UNLOADS the iframe so the page can never release it after the fact. Same rule as
      // notepad/party/chat.
      onHide: (w) => { try { frameWin(w)?.__haulingExitTyping?.(); } catch { /* iframe gone */ } },
    },
    {
      // Log View: the raw game.log tail, on screen, while playing. It is a diagnostic instrument
      // rather than a feature — its job is to let Sub spot a line mid-flight and report it, so
      // "is X even logged?" stops being a question anyone has to guess at.
      // Wider than a column widget by default: these are long monospaced lines and a narrow frame
      // wraps every one of them into four, which is the state in which a log is unreadable.
      key: "logView", page: "logview.html", title: "Log",
      def: { x: 40, y: 60 }, size: { w: 520, h: 420, minW: 300, maxW: 2400, minH: 180, maxH: 1600 },
      focusFn: "__logViewFocus", // the filter box needs the shared keyboard grab
      // Don't strand the keyboard grab: hiding with the filter focused would leave the interact
      // key suspended, and hide UNLOADS the iframe so the page can never release it afterwards.
      onHide: (w) => { try { frameWin(w)?.__logViewExitTyping?.(); } catch { /* iframe gone */ } },
    },
    {
      // Player-to-player chat (Global / Server / Shard tabs). The SIDECAR owns the connection
      // and history (src/chat.ts) — this page only renders and posts, so closing or regrouping
      // it drops nothing. No socket exists unless this widget is open (chatOpen is the gate).
      key: "chat", page: "chat.html", title: "Chat",
      // Three panes (channels · chat · members), so it defaults wider than a single-column
      // widget; the rails collapse from its header when the user wants it narrow.
      def: { x: 760, y: 400 }, size: { w: 820, h: 480, minW: 280, maxW: 1600, minH: 240, maxH: 1200 },
      focusFn: "__chatFocus",
      // 🔑 Without this the blueprint/wiki/profile links fell back to window.open, which inside
      // the canvas is an Electron popup, not the user's browser. Every widget that links OUT
      // needs openUrl re-exposed — the base bridge does not carry it.
      host: () => ({ openUrl: (u) => window.overlayApi?.openUrl?.(u) }),
      // Don't strand the keyboard grab: hiding mid-typing would leave the interact key suspended.
      onHide: (w) => { try { frameWin(w)?.__chatExitTyping?.(); } catch { /* iframe gone */ } },
    },
    {
      key: "webView", page: "webview.html", title: "Web Page",
      def: { x: 480, y: 120 }, size: { w: 420, h: 520, minW: 260, maxW: 6000, minH: 200, maxH: 3000 },
      focusFn: "__webViewFocus",
      // No tilt: somebody else's website is not ours to skew, and a tilted page is just harder
      // to read. (Sub, 2026-07-29 — the angle control is per-widget, and these two don't get one.)
      noAngle: true,
      // The page itself is a native view owned by the shell (an iframe can't show sites that
      // refuse framing). The widget page keeps its chrome and reports the HOLE to fill; these
      // relay it, converting the page's own coordinates into canvas ones.
      host: (w) => ({
        openUrl: (u) => window.overlayApi?.openUrl?.(u),
        viewBounds: (r) => reportWebViewHole(w, r),
        viewShow: (on) => { if (on) scheduleWebViewSync(w); else window.overlayApi?.webViewShow?.(false); },
        viewLoad: (u) => window.overlayApi?.webViewLoad?.(u),
        viewReload: () => window.overlayApi?.webViewReload?.(),
        viewBack: () => window.overlayApi?.webViewBack?.(),
      }),
      // Tabbed away, closed, or the whole overlay hidden: the view must go with it, or someone
      // else's website floats over the game with nothing behind it.
      onShow: (w) => scheduleWebViewSync(w),
      // The typing grab must release BEFORE the iframe unloads (same rule as notepad/party/chat).
      onHide: (w) => {
        try { frameWin(w)?.__webViewExitTyping?.(); } catch { /* iframe gone */ }
        window.overlayApi?.webViewShow?.(false);
      },
    },
    {
      key: "bindingChart", page: "bindingwidget.html", title: "Infographic Viewer",
      def: { x: 120, y: 120 }, size: { w: 620, h: 340, minW: 260, maxW: 6000, minH: 160, maxH: 3000 },
      // Same reasoning: a binding chart is dense reference art. Tilting it only costs legibility.
      noAngle: true,
      // Re-read the PNG each time it's summoned, so a re-exported chart appears without a restart.
      onShow: (w) => { try { frameWin(w)?.__bindingReload?.(); } catch { /* not loaded yet */ } },
      // 🔑 The PNG picker moved OUT of global Settings and into this widget (Sub, 2026-08-11):
      // "what is this widget showing" is a question you ask at the widget. The shell owns the
      // file dialog, and overlayApi.cfg is the very channel the settings page already used —
      // this adds reach, not power.
      host: () => ({
        pickPng: async () => {
          let p = null;
          try { p = await window.overlayApi?.cfg?.pickPng?.(); } catch { /* no shell (OBS/browser) */ }
          if (!p) return null;               // dialog cancelled, or no shell to ask
          await setBindingPng(p);
          return p;
        },
        clearPng: () => setBindingPng(""),
      }),
    },
  ];

  // Settings no longer holds a copy of this value, deliberately: it saves the WHOLE form, so a
  // path chosen here while that window sat open would have been written back stale. The POST is a
  // field-by-field merge server-side, so sending this one key disturbs nothing else.
  async function setBindingPng(path) {
    try {
      await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bindingPng: path }),
      });
    } catch { /* sidecar down — the widget re-reads on its next show */ }
    try { frameWin(WBY.bindingChart)?.__bindingReload?.(); } catch { /* not loaded yet */ }
  }

  // Runtime state hangs off each entry as `.s` so it never collides with the config above.
  const WBY = {};
  for (const w of WIDGETS) {
    // The Blueprint panel is the app's main surface, so it starts SHOWN; every other widget is
    // opt-in and starts hidden.
    w.s = { x: null, y: null, w: null, h: null, scale: null, angle: null, visible: !!w.local };
    w.armed = false; // iframe src is set (page live) — true even while hidden, for auto-show
    WBY[w.key] = w;
  }

  const wEl = (w) => (w.local ? $("panel") : $("w-" + w.key));
  const frameEl = (w) => (w.local ? null : $("wf-" + w.key));
  const frameWin = (w) => { try { return frameEl(w)?.contentWindow || null; } catch { return null; } };
  // A local widget's settings live in THIS document, reached directly rather than over the bridge.
  const wSettingsRoot = (w) => {
    if (w.local) return $("cogMenu");
    try { return frameWin(w)?.__widgetSettingsRoot?.() || null; } catch { return null; }
  };
  const wOpenSettings = (w) => {
    if (w.local) { $("cogMenu")?.classList.add("open"); $("cog")?.classList.add("open"); return; }
    try { frameWin(w)?.__widgetSettings?.(); } catch { /* iframe gone */ }
  };
  // The pages expose only __widgetSettings (open) — no close — but they DO expose their panel's
  // root element, and both implementations open it by adding `open`. So the shell can close one
  // without a new bridge method. Asserted by the widget suite, since it rests on that convention.
  const wCloseSettings = (w) => {
    if (w.local) { $("cogMenu")?.classList.remove("open"); $("cog")?.classList.remove("open"); return; }
    try { wSettingsRoot(w)?.classList.remove("open"); } catch { /* iframe gone */ }
  };

  // ── a widget's settings close themselves after 15s of not being used ────────────────────────
  // Sub, 2026-08-03: "if the person doesn't click in there within 15 seconds, it just goes away."
  // Not merely tidiness: an open popover is in RSEL, so it is a permanently CLICKABLE box sitting
  // over the game, and it masks the Web Page widget's native view for as long as it is up. A
  // forgotten one costs you clicks and hides a widget.
  // 🔑 "Used" means a click ANYWHERE on the widget, which is why the re-arm lives in touchWidget:
  // every embedded page already calls summonCog on pointerdown, so a click inside an iframe-owned
  // settings panel counts too. Without that, adjusting Mining's cog panel would have it shut under
  // you at 15s — the shell cannot see clicks inside an iframe any other way.
  // 15s in real use; `?wcfgidle=<ms>` shortens it so the harness doesn't sit here for a quarter of
  // a minute per assertion (same trick as ?coghide).
  const WCFG_IDLE_MS = +(new URLSearchParams(location.search).get("wcfgidle")) || 15000;
  let wcfgIdleT = null;
  let wcfgOpenFor = null; // the widget whose settings are up, so only that one gets closed
  function cancelWidgetSettingsIdle() {
    clearTimeout(wcfgIdleT); wcfgIdleT = null; wcfgOpenFor = null;
  }
  function armWidgetSettingsIdle(w) {
    clearTimeout(wcfgIdleT);
    if (w) wcfgOpenFor = w;
    if (!wcfgOpenFor) { wcfgIdleT = null; return; }
    wcfgIdleT = setTimeout(() => {
      const target = wcfgOpenFor;
      cancelWidgetSettingsIdle();
      if (!target) return;
      wEl(target)?.classList.remove("cfgopen");
      wCloseSettings(target);
      syncViewMask();
    }, WCFG_IDLE_MS);
  }
  // 🔑 The ONE place a widget goes on or off screen, and therefore the one place that tells the
  // page about it. It used to be setWidgetVisible that fired onShow/onHide — but that isn't the
  // only path here: a widget backgrounded as a GROUP TAB goes through refreshGroupDisplay, which
  // calls straight into showEl. So a mining widget tabbed behind another kept announcing rocks
  // out loud from a box nobody could see, because it was never told it had gone dark.
  // (Rule, unchanged: invisible means no sound and no work beyond un-hiding itself.)
  function showEl(w, vis) {
    vis = !!vis;
    const was = wShown(w);
    if (w.local) document.body.classList.toggle("bp-hidden", !vis);
    else { const el = wEl(w); if (el) el.style.display = vis ? "" : "none"; }
    if (vis !== was) notifyVisibility(w, vis);
  }
  // Also called on the page's own ready(): an armed-hidden iframe (mining waiting to auto-show)
  // is created and hidden in the same breath, so the hide fired while its contentWindow was still
  // empty and the call vanished into an optional chain. The page asks again once it can listen.
  function notifyVisibility(w, vis) {
    try { (vis ? w.onShow : w.onHide)?.(w); } catch { /* iframe gone mid-flip */ }
  }
  const wShown = (w) => (w.local
    ? !document.body.classList.contains("bp-hidden")
    : (wEl(w) && wEl(w).style.display !== "none"));
  const wScale = (w) => (w.s.scale != null ? w.s.scale : Math.max(50, Math.min(200, Number(PREFS.overlayScale) || 100)) / 100);
  // Declared up here because buildWidgetEls() below runs immediately and stamps it into the markup;
  // the rest of the angle machinery lives with the geometry code further down.
  const ANGLE_MAX = 35;

  // Generate every widget's markup into #widgets (see the container in the body).
  function buildWidgetEls() {
    const host = $("widgets"); if (!host) return;
    host.innerHTML = WIDGETS.filter((w) => !w.local).map((w) => {
      const cls = "widget" + (w.shape === "scaled" ? " scaled" : "") + (w.notifier ? " notifier" : "")
        + (w.flair ? " flair" : "");
      const style = "display:none" + (w.z ? ";--wz:" + w.z : "");
      const allow = w.allow ? ' allow="' + escapeAttr(w.allow) + '"' : "";
      const label = w.moveLabel || "⠿ Drag to move · corner to resize";
      const trinkets = w.flair
        ? '<img class="tape tr" alt="" src="tape-m-tl.webp"><img class="tape bl" alt="" src="tape-m-br.webp">'
          + '<img class="bolt tr" alt="" src="anvil-bolt-tl.webp"><img class="bolt bl" alt="" src="anvil-screw-br.webp">'
          + '<div class="corner tr"></div><div class="corner bl"></div>'
        : "";
      return '<div class="' + cls + '" id="w-' + w.key + '" style="' + style + '">'
        + '<iframe id="wf-' + w.key + '" title="' + escapeAttr(w.title) + '"' + allow + ' scrolling="no"></iframe>'
        + trinkets
        + '<div class="whood"><div class="whead">'
        + '<span class="wh-left">'
        + '<span class="wh-id">'
        + '<span class="dia"></span><span class="wh-title">' + escapeHtml(w.title) + '</span>'
        + '</span><span class="wh-tabs"></span>'
        + '</span>'
        + '<span class="wh-right">'
        + '<button type="button" class="wh-btn wh-move" title="Move / arrange widgets">⠿</button>'
        + '<button type="button" class="wh-btn wh-reset" title="Reset this widget’s position and size">↺</button>'
        + '<button type="button" class="wh-btn wh-cog" title="' + escapeAttr(w.title) + ' settings">⚙</button>'
        + '<button type="button" class="wh-btn wh-close" title="Close ' + escapeAttr(w.title) + '">✕</button>'
        + '</span>'
        + '</div></div>'
        + '<div class="wcfg">'
        + '<div class="wcfg-row"><span class="wcfg-lbl">Text size</span>'
        + '<button type="button" class="wh-btn wcfg-dn" title="Smaller text">A−</button>'
        + '<button type="button" class="wh-btn wcfg-up" title="Bigger text">A+</button>'
        + '<span class="wcfg-val"></span></div>'
        + (w.noAngle ? ''
          : '<div class="wcfg-row wcfg-angrow"><span class="wcfg-lbl">Angle</span>'
          + '<input type="range" class="wcfg-ang" min="-' + ANGLE_MAX + '" max="' + ANGLE_MAX + '" step="1" value="0"'
          + ' title="Tilt this widget left or right" />'
          + '<span class="wcfg-angv"></span></div>')
        + '<div class="wcfg-sec">Fade when idle</div>'
        + '<div class="wcfg-row wcfg-dimrow"><span class="wcfg-lbl">Panel</span>'
        + '<input type="range" class="wcfg-dim" min="20" max="100" step="5" value="100"'
        + ' title="How faint the panel goes while you are not using it. 100% never fades." />'
        + '<span class="wcfg-dimv"></span></div>'
        + '<div class="wcfg-row wcfg-dimrow"><span class="wcfg-lbl">Text</span>'
        + '<input type="range" class="wcfg-dimtext" min="20" max="100" step="5" value="100"'
        + ' title="How faint the text goes while you are not using it. Independent of the panel." />'
        + '<span class="wcfg-dimtextv"></span></div>'
        + '<label class="wcfg-row"><span class="wcfg-lbl">Full on hover</span>'
        + '<input type="checkbox" class="wcfg-hover"'
        + ' title="Bring this widget back to full opacity while the cursor is over it." /></label>'
        + '</div>'
        + '<div class="wmove"><div class="movebox">' + label + '<button type="button" class="wdone">Done</button></div></div>'
        + '<div class="wresize" title="Drag to resize"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M8 20 L20 8 M14 20 L20 14"/></svg></div>'
        + '</div>';
    }).join("");
  }
  buildWidgetEls();

  // Position/size a widget. x/y are PRIMARY-relative; the primary's offset within the (possibly
  // multi-monitor) canvas is added here, so an existing layout stays put and a leftward drag can
  // carry onto another monitor.
  // ── Widget groups ───────────────────────────────────────────────────────────────────────
  // Drag a widget onto another's header and they stack as TABS in one frame.
  //
  // 🔑 A group NEVER reparents an iframe. Moving an <iframe> in the DOM reloads it, which would
  // wipe Twitch chat scrollback, unsaved notes, and every live SSE/poll the embedded page holds.
  // So a group is only: a shared box + exactly one member displayed. Same result, no reloads.
  //
  // Shape: `{ id, x, y, w, h, members: [key], active: key }`, persisted in widgets.json under the
  // reserved "__groups" key (no widget uses it, and the loader reads widgets by their own key).
  let GROUPS = [];
  const groupOf = (w) => GROUPS.find((g) => g.members.includes(w.key)) || null;
  const boxW = (w) => (w.s.w != null ? w.s.w : w.size.w);
  const boxH = (w) => (w.s.h != null ? w.s.h : w.size.h);
  function saveGroups() { window.overlayApi?.saveWidget?.("__groups", { list: GROUPS }); }

  // ── Per-widget angle ────────────────────────────────────────────────────────────────────
  // The left↔right yaw that gives the HUD its helmet-projection look. Per WIDGET, so a panel on
  // the left and one on the right can each angle inward. A STACK shares one angle: the members
  // share a box, so letting each tab carry its own would tilt the frame every time you switched
  // tab. Range matches the old global overlayTwist config at ±ANGLE_MAX (declared above).
  const wAngle = (w) => {
    // A widget that doesn't tilt reads as flat everywhere — including inside a tilted GROUP, and
    // including a value saved back when it did have a slider. Otherwise removing the control
    // would strand someone's Web Page or chart crooked with no way to straighten it.
    if (w.noAngle) return 0;
    const g = groupOf(w);
    if (g && g.angle != null) return g.angle;
    return w.s.angle != null ? w.s.angle : (w.angle != null ? w.angle : 0);
  };
  const clampAngle = (deg) => Math.max(-ANGLE_MAX, Math.min(ANGLE_MAX, Math.round(Number(deg) || 0)));
  function setWidgetAngle(w, deg) {
    const v = clampAngle(deg);
    const g = groupOf(w);
    if (g) { g.angle = v; applyGroup(g); } else { w.s.angle = v; applyFrame(w); }
    showAngle(w);
    return v;
  }
  // Where a widget's layout belongs: a stacked one lives on its GROUP, so writing w.s through
  // would save a value nothing reads back.
  function persistLayout(w) { if (groupOf(w)) saveGroups(); else persistW(w); }

  function applyFrame(w) {
    const el = wEl(w); if (!el) return;
    const ox = canvasInfo?.px || 0, oy = canvasInfo?.py || 0;
    const g = groupOf(w);
    const x = g ? g.x : w.s.x, y = g ? g.y : w.s.y;
    if (x != null) el.style.setProperty("--wx", (x + ox) + "px");
    if (y != null) el.style.setProperty("--wy", (y + oy) + "px");
    // Angle applies to EVERY widget, whatever its shape and whether or not it's stacked — see the
    // note on .widget in the CSS for why it can't live in the `scaled` branch below.
    el.style.setProperty("--wangle", wAngle(w) + "deg");
    // A scaled widget drops to box shape while grouped, so every tab in a stack is the same size —
    // its own setSize is ignored for the same reason (see the registry's host).
    if (w.shape === "scaled" && !g) {
      el.style.setProperty("--wscale", wScale(w));
    } else {
      el.style.setProperty("--ww", (g ? g.w : boxW(w)) + "px");
      el.style.setProperty("--wh", (g ? g.h : boxH(w)) + "px");
      if (g) { const f = frameEl(w); if (f) { f.style.width = ""; f.style.height = ""; } }
    }
    el.classList.toggle("grouped", !!g);
    el.classList.toggle("scaled", w.shape === "scaled" && !g);
    // The Web Page widget's content is a native view the shell paints at coordinates we hand it,
    // so it can't follow the widget on its own — every geometry change has to re-report.
    if (w.key === "webView") scheduleWebViewSync(w);
  }
  function applyAllFrames() { for (const w of WIDGETS) applyFrame(w); renderGroupTabs(); }
  function applyGroup(g) { for (const k of g.members) { const w = WBY[k]; if (w) applyFrame(w); } renderGroupTabs(); }

  // Only the active member of a group is displayed; the rest stay mounted but hidden.
  /** Which member a stack actually DISPLAYS — not always `active`.
   *
   *  `active` is the tab the user last fronted and it is deliberately STICKY: hiding a member
   *  (hotkey, tray, hub) no longer drops it from the stack, so `active` can point at something
   *  currently hidden. Displaying that member would paint nothing AND draw no tab strip —
   *  renderGroupTabs puts the tabs in the displayed member's own bar — so the whole stack would
   *  become invisible and unclickable with no way back. Falling back to any visible member keeps
   *  the stack reachable while leaving `active` untouched, so the user's chosen tab returns the
   *  moment they unhide it. */
  const groupShown = (g) => (WBY[g.active]?.s.visible ? g.active : null)
    || g.members.find((k) => WBY[k]?.s.visible) || g.active;

  function refreshGroupDisplay(g) {
    const shown = groupShown(g);
    for (const k of g.members) {
      const w = WBY[k], el = wEl(w); if (!w || !el) continue;
      showEl(w, w.s.visible && shown === k);
    }
    renderGroupTabs();
  }

  // Tabs live in the LEFT half of the FRONTED member's own bar, so a stack shows exactly one bar
  // (the visible widget's) rather than a separate floating strip. Every other member's tab slot is
  // cleared, since only one of them is on screen at a time anyway.
  function renderGroupTabs() {
    for (const w of WIDGETS) {
      const el = wEl(w); if (!el) continue;
      const slot = el.querySelector(".wh-tabs"); if (!slot) continue;
      const g = groupOf(w);
      // Tabs belong to the member actually on screen, which is not always `active` — see groupShown.
      const shown = g ? groupShown(g) : null;
      if (!g || shown !== w.key) { if (slot.innerHTML) slot.innerHTML = ""; continue; }
      // Only members that are actually SHOWN get a tab. A hidden one is still in the stack (it
      // rejoins the moment its hotkey/tray toggle brings it back) but listing it would be a dead
      // control: clicking a tab fronts a member, and fronting something hidden displays nothing.
      slot.innerHTML = g.members.filter((k) => WBY[k]?.s.visible).map((k) => {
        const m = WBY[k]; if (!m) return "";
        return '<button type="button" class="gtab' + (shown === k ? " on" : "") + '"'
          + ' data-g="' + g.id + '" data-k="' + k + '">' + escapeHtml(m.title) + '</button>';
      }).join("")
        + '<button type="button" class="gtab gdetach" data-g="' + g.id + '" title="Pop this tab out of the group">⧉</button>';
    }
  }

  // Merge `a` into whatever group `b` belongs to, creating one if `b` is still standalone.
  function groupWidgets(a, b) {
    if (!a || !b || a === b) return;
    let g = groupOf(b);
    if (!g) {
      g = { id: "g" + Date.now().toString(36), x: b.s.x, y: b.s.y, w: boxW(b), h: boxH(b),
            angle: wAngle(b), members: [b.key], active: b.key };
      GROUPS.push(g);
    }
    const prev = groupOf(a);
    if (prev && prev !== g) detachFromGroup(a, { keepPlace: true });
    if (!g.members.includes(a.key)) g.members.push(a.key);
    g.active = a.key; // the tab you just dropped is the one you want to be looking at
    applyGroup(g);
    refreshGroupDisplay(g);
    saveGroups();
  }

  // Pop one widget out of its group. A group of one isn't a group, so it dissolves.
  function detachFromGroup(w, opts) {
    const g = groupOf(w); if (!g) return;
    g.members = g.members.filter((k) => k !== w.key);
    // Keep the group's size, but offset the position so the popped widget is visibly separate
    // instead of landing exactly on top of the stack it just left.
    const off = opts && opts.keepPlace ? 0 : 24;
    w.s.x = g.x + off; w.s.y = g.y + off; w.s.w = g.w; w.s.h = g.h;
    if (g.angle != null) w.s.angle = g.angle; // keep the tilt it had while stacked
    if (g.active === w.key) g.active = g.members[0] || null;
    if (g.members.length < 2) {
      // Drop the group BEFORE re-applying the survivor: applyFrame() reads groupOf(), so doing it
      // the other way round leaves the last member still believing it's stacked.
      const survivors = g.members.slice();
      GROUPS = GROUPS.filter((x) => x !== g);
      for (const k of survivors) {
        const m = WBY[k]; if (!m) continue;
        m.s.x = g.x; m.s.y = g.y; m.s.w = g.w; m.s.h = g.h;
        if (g.angle != null) m.s.angle = g.angle;
        persistW(m); applyFrame(m); showEl(m, m.s.visible);
      }
    } else {
      refreshGroupDisplay(g);
    }
    persistW(w); applyFrame(w); showEl(w, w.s.visible);
    renderGroupTabs();
    saveGroups();
  }

  // 🔑 `angle` is saved for BOTH shapes. It used to be written only in the scaled branch, so a box
  // widget's tilt was forgotten on restart even once it applied.
  function persistW(w) {
    // `dim` is the PANEL alpha; `dimText` and `hoverFull` ride alongside it. All three save as
    // null when untouched, which is what "inherit the global default" is stored as.
    const fade = { dim: w.s.dim, dimText: w.s.dimText, hoverFull: w.s.hoverFull };
    const layout = w.shape === "scaled"
      ? { x: w.s.x, y: w.s.y, scale: w.s.scale, angle: w.s.angle, text: w.s.text, ...fade }
      : { x: w.s.x, y: w.s.y, w: w.s.w, h: w.s.h, angle: w.s.angle, text: w.s.text, ...fade };
    window.overlayApi?.saveWidget?.(w.key, layout);
  }

  // ── Per-widget fade: the PANEL and its TEXT, independently ───────────────────────────────
  // Sub's ask (2026-08-11): a widget you can almost see through, still carrying text you can
  // read. `w.s.dim` is the PANEL alpha and `w.s.dimText` the TEXT alpha — each 0.2–1, or null
  // meaning "inherit". Null is the default, so a user who never opens these controls keeps
  // exactly the behaviour they had; and dimText falls back to the PANEL value before the global
  // one, so moving only the panel slider still behaves like the single control it replaces.
  //
  // 🔑 BOTH ALPHAS ARE PUSHED INTO THE WIDGET'S OWN DOCUMENT, never applied to the wrapper.
  // CSS does not cascade across an iframe boundary, but every widget page is served by our own
  // sidecar, so the frames are same-origin and their documents are writable — the same route
  // applyTextScale() already takes for `zoom`. The wrapper must stay fully opaque: an opacity
  // there would MULTIPLY with the two inside, and multiplication is exactly what made the
  // useful combination unreachable before. Nesting can only ever make text DIMMER than the
  // panel under it, so "faint panel, readable text" does not exist in that model at any
  // setting. Two sibling alphas with no container opacity is the whole trick.
  //
  // 🔑 Which is also why hover stops being a CSS rule. `.widget:hover { opacity: 1 }` cannot
  // reach the document doing the fading, so hover has to be pushed too — and once it is pushed
  // it can be a per-widget preference (`w.s.hoverFull`, default on) rather than a blanket rule.
  const DIM_MIN = 0.2;
  const clampDim = (v) => Math.max(DIM_MIN, Math.min(1, Number(v) || 0));
  let globalDim = 1;                       // from prefs.unfocusedOpacity
  const wDim = (w) => (typeof w.s.dim === "number" ? w.s.dim : globalDim);
  const wDimText = (w) => (typeof w.s.dimText === "number" ? w.s.dimText : wDim(w));
  const wHoverFull = (w) => w.s.hoverFull !== false;
  // Arrange mode and the override hotkey force everything to full — you cannot place what you
  // cannot see. The shell toggles html.no-dim; reading the class keeps ONE source of truth for
  // a decision that is now half CSS (notifiers) and half JS (everything else).
  const fadeOverridden = () => document.documentElement.classList.contains("no-dim");
  const isHovered = (el) => { try { return !!el && el.matches(":hover"); } catch { return false; } };

  // True while a fade slider is under the thumb. The 0.18s transition is right for a STATE change
  // (idle <-> hover should glide) and exactly wrong under a continuously changing value, where it
  // makes the panel trail the slider and only arrive after you stop.
  let fadeDragging = false;
  function applyFade(w) {
    const el = wEl(w); if (!el) return;
    // A notifier has no widget panel to split, so it keeps the original single-opacity path.
    if (w.notifier) { el.style.setProperty("--wdim", String(clampDim(wDim(w)))); return; }
    // Interaction ALWAYS restores a widget. Turning "full on hover" off should stop it lighting
    // up as the cursor crosses it — not hide the thing you are in the middle of using.
    const busy = el.classList.contains("touched") || el.classList.contains("moving");
    const full = fadeOverridden() || busy || (wHoverFull(w) && isHovered(el));
    const surf = full ? 1 : clampDim(wDim(w));
    const text = full ? 1 : clampDim(wDimText(w));
    // The canvas draws this widget's skin trinkets on the WRAPPER, outside the iframe (which
    // clips them), so they cannot inherit the panel's fade — hand them the surface alpha here.
    el.style.setProperty("--wsurf", String(surf));
    writeFade(w, surf, text);
    showFade(w);
  }
  function writeFade(w, surf, text) {
    const set = (root) => {
      if (!root) return;
      root.style.setProperty("--wsurf", String(surf));
      root.style.setProperty("--wtext", String(text));
      root.style.setProperty("--wfade-ms", fadeDragging ? "0ms" : "0.18s");
    };
    // The tracker is local to THIS document, which hosts every other widget too — so its values
    // go on its own panel. On :root they would fade the entire overlay at once.
    if (w.local) { set($("panel")); return; }
    try { set(frameEl(w)?.contentDocument?.documentElement); }
    catch { /* iframe not ready — reapplied from the load/ready handlers */ }
  }
  function applyAllFades() { for (const w of WIDGETS) applyFade(w); }

  // Both control surfaces can be showing the same widget at once — the local .wcfg popover and,
  // for a page that has settings of its own, the rows injected into them — so every readout is
  // updated rather than the first one found.
  function fadeControls(w, sel) {
    const out = [];
    const local = wEl(w)?.querySelectorAll(sel); if (local) out.push(...local);
    let root = null; try { root = wSettingsRoot(w); } catch { /* iframe gone */ }
    if (root) out.push(...root.querySelectorAll(sel));
    return out;
  }
  const dimLabel = (v) => (v >= 1 ? "Off" : Math.round(v * 100) + "%");
  function showFade(w) {
    // 🔑 Never write back into the control being dragged. Assigning `.value` to the input under
    // the thumb fights the drag, and it is redundant — the browser already has the value.
    const live = document.activeElement;
    const set = (i, v) => { if (i !== live) i.value = v; };
    for (const i of fadeControls(w, ".wcfg-dim")) set(i, String(Math.round(wDim(w) * 100)));
    for (const o of fadeControls(w, ".wcfg-dimv")) o.textContent = dimLabel(wDim(w));
    for (const i of fadeControls(w, ".wcfg-dimtext")) set(i, String(Math.round(wDimText(w) * 100)));
    for (const o of fadeControls(w, ".wcfg-dimtextv")) o.textContent = dimLabel(wDimText(w));
    for (const c of fadeControls(w, ".wcfg-hover")) c.checked = wHoverFull(w);
  }
  // 100% means "never fade" for THIS widget — stored explicitly rather than as null, so it stays
  // opaque even if the global default is later turned down.
  //
  // 🔑 Moving the PANEL slider pins the text value first. Text inherits the panel number until it
  // is set, which is right for a widget nobody has configured — but with both sliders on screen it
  // read as the panel slider dragging the text one along with it, and it appeared to "fix itself"
  // the moment you happened to touch Text (Sub, 2026-08-11). Materialising the inherited value on
  // the first panel drag keeps the inheritance as a DEFAULT without ever showing it as coupling.
  function setWidgetDim(w, pct) {
    if (typeof w.s.dimText !== "number") w.s.dimText = wDimText(w);
    w.s.dim = clampDim(Number(pct) / 100);
    applyFade(w);
  }
  function setWidgetDimText(w, pct) { w.s.dimText = clampDim(Number(pct) / 100); applyFade(w); }
  function setWidgetHoverFull(w, on) { w.s.hoverFull = !!on; applyFade(w); }

  // ── Per-widget text size ────────────────────────────────────────────────────────────────
  // Every widget is responsive now: dragging the corner gives you more ROOM, not bigger text. So
  // how big the text is has to be its own control — a narrow widget would otherwise truncate or
  // grow a scrollbar, while someone with a spare monitor just gets acres of whitespace.
  // Applied as a `zoom` on the embedded document (same-origin), which scales its content without
  // touching the box the parent owns. Persisted per widget alongside the layout.
  const TEXT_MIN = 0.7, TEXT_MAX = 2.0;
  const textScale = (w) => (w.s.text != null ? w.s.text : 1);
  function applyTextScale(w) {
    if (w.local) { const c = wEl(w)?.querySelector(".pool"); if (c) c.style.zoom = textScale(w); return; }
    try {
      const doc = frameEl(w)?.contentDocument;
      if (doc && doc.documentElement) doc.documentElement.style.zoom = textScale(w);
    } catch { /* iframe not ready — reapplied on load/ready */ }
  }
  function showTextScale(w) {
    for (const v of textReadouts(w)) v.textContent = Math.round(textScale(w) * 100) + "%";
  }
  const textReadouts = (w) => {
    const out = [];
    const local = wEl(w)?.querySelector(".wcfg-val"); if (local) out.push(local);
    const r = wSettingsRoot(w); const inj = r?.querySelector(".wtext-val"); if (inj) out.push(inj);
    return out;
  };
  // ── "Show the scan read area" ───────────────────────────────────────────────────────────
  // The Mining Scanner's cog toggles this; the CANVAS draws it, because the canvas is the only
  // surface that spans the screen. The fractions are the ones classifyScreen() actually searches
  // for a signature number — keep them in step, or the box lies about what is read.
  //   x: within 0.17 of centre   y: from cy-0.24h up to cy-0.015h
  // Drawn over the PRIMARY display, which is where the game is captured from; on a multi-monitor
  // rig with SC on a second screen the outline sits on the wrong one, and that is worth knowing
  // before trusting it as a diagnostic.
  // The default band, as fractions — MUST match DEFAULT_SCAN_REGION in screen-read.ts, which is
  // what the classifier falls back to. The suite asserts the drawn box against the same numbers.
  const SCAN_DEFAULT = { x: 0.5 - 0.17, y: 0.5 - 0.24, w: 0.34, h: 0.24 - 0.015 };
  let scanRegion = null;   // fractions, or null while we're using the default

  const scanDisplay = () => canvasInfo || { px: 0, py: 0, pw: window.innerWidth, ph: window.innerHeight };
  function drawScanBox() {
    const el = document.getElementById("scanBox");
    if (!el) return;
    const ci = scanDisplay();
    const f = scanRegion || SCAN_DEFAULT;
    el.style.left = Math.round(ci.px + f.x * ci.pw) + "px";
    el.style.top = Math.round(ci.py + f.y * ci.ph) + "px";
    el.style.width = Math.round(f.w * ci.pw) + "px";
    el.style.height = Math.round(f.h * ci.ph) + "px";
  }
  function setScanBox(on) {
    document.body.classList.toggle("scanbox", !!on);
    if (on) drawScanBox();
  }
  /** The one rule for whether the outline is up: the Mining Scanner is on screen and the player
   *  hasn't hidden it. It is a calibration overlay for that widget — leaving it behind when the
   *  scanner is closed (or is the hidden member of a stack) puts an unexplained dashed box over
   *  the game with no control anywhere to remove it.
   *
   *  🔑 Default is SHOWN (Sub, 2026-08-01: he was scanning without the box up and wanted it there
   *  automatically). The pref is therefore stored INVERTED — `miningScanBoxHidden`, absent = show —
   *  under a NEW key rather than flipping the meaning of the old one, so nobody's saved "off"
   *  silently becomes "on" or vice versa. Hiding does not clear anything else, so reopening the
   *  scanner brings the box back exactly where the player left it. */
  function syncScanBox() {
    let hidden = false;
    try { hidden = localStorage.getItem("miningScanBoxHidden") === "1"; } catch { /* no storage */ }
    applyScanBoxOpacity();
    setScanBox(!hidden && wShown(WBY.mining));
  }
  /** The box's user-set opacity, applied as a CSS variable. Clamped to a 10% FLOOR: 0 would not
   *  be subtle, it would be invisible, and an invisible box cannot be dragged, reset or hidden.
   *  Read here rather than passed in, so every caller of syncScanBox() gets it for free. */
  function applyScanBoxOpacity() {
    let pct = 100;
    try {
      const v = parseInt(localStorage.getItem("miningScanBoxOpacity") || "100", 10);
      if (Number.isFinite(v)) pct = Math.min(100, Math.max(10, v));
    } catch { /* no storage */ }
    document.documentElement.style.setProperty("--sb-op", String(pct / 100));
  }
  // ── The number the OCR read, under the box ──────────────────────────────────────────────────
  // The point is comparison: the player reads the real signature and this one, and a discrepancy
  // explains itself. So it shows for EVERY read, including the ones the app refused — and it shows
  // the NUMBER, nothing else.
  const SCAN_READ_TTL_MS = 12000; // a number from a minute ago would be read as current. It isn't.
  let scanReadTimer = null;
  function showScanRead(info) {
    const el = document.getElementById("scanBox"); if (!el || !info) return;
    const n = Number(info.signature);
    const text = Number.isFinite(n) ? n.toLocaleString() : String(info.raw || "?").trim();
    // Both copies carry the same value — one string, set twice, so they can never disagree.
    for (const id of ["sbReadVal", "sbReadVal2"]) {
      const v = document.getElementById(id); if (v) v.textContent = text;
    }
    // Each copy is flipped independently, against the edge that would actually clip IT. The top
    // one drops below the box near the top of the screen; the left one tucks inside near the left.
    // 🔑 Measured off the real rect, not assumed — the box is user-dragged and can sit anywhere.
    const ci = scanDisplay(), r = el.getBoundingClientRect();
    el.classList.toggle("read-below", r.top - 34 < ci.py);
    el.classList.toggle("read-inset", r.left - 10 < ci.px);
    // Struck through = the read was NOT USED. 🔑 Off `used`, never `announced`: the loop re-reads the
    // same rock every poll, and those repeats announce nothing while being perfectly valid — driving
    // this off `announced` struck out the live number a second after it appeared.
    el.classList.toggle("refused", info.used === false);
    el.classList.add("has-read");
    clearTimeout(scanReadTimer);
    scanReadTimer = setTimeout(() => el.classList.remove("has-read"), SCAN_READ_TTL_MS);
  }

  /** Persist the dragged region (or null to reset). The SIDECAR owns it — it's what runs the
   *  classifier — so this is the same POST the settings page uses, not a local-only pref. */
  function saveScanRegion(f) {
    scanRegion = f;
    drawScanBox();
    fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanRegion: f }),
    }).catch(() => { /* best-effort; the box still shows what we set */ });
  }

  // Drag the box to move it, its corner to resize. Fractions of the display it sits on, so the
  // setting survives a resolution change. Clamped into the frame and to a sane minimum — a region
  // dragged off-screen or squashed to nothing would silently stop all scanning.
  //
  // 🔑 Shared by the Mining Scanner's scan box and the contract board's calibration box. The
  // gesture is the fiddly part (pointer capture, the drag lock, one write per gesture rather than
  // per frame), and a second hand-rolled copy of it is a second place for those to be got subtly
  // wrong. `live` redraws on every frame; `commit` persists ONCE, on release.
  function wireCalBox(el, { ignore = [], start: readStart, live, commit, dragClass = "sb-dragging",
                            minW = 0.03, minH = 0.02 }) {
    if (!el) return;
    let mode = null, sx = 0, sy = 0, start = null;
    el.addEventListener("pointerdown", (e) => {
      // Both controls live INSIDE the box, so a pointerdown on either would otherwise start a
      // drag of the box under them.
      if (e.target && ignore.includes(e.target.id)) return; // handled below
      mode = (e.target && e.target.classList.contains("sb-grip")) ? "resize" : "move";
      sx = e.clientX; sy = e.clientY;
      start = { ...readStart() };
      document.body.classList.add(dragClass);
      window.overlayApi?.dragLock?.(true);   // keep the window interactive for the whole gesture
      // Capture keeps the drag alive if the cursor outruns the box. It throws when the pointer id
      // isn't active (a synthetic event, or one already released) — that must not abort the drag.
      try { el.setPointerCapture?.(e.pointerId); } catch { /* drag still works without capture */ }
      e.preventDefault(); e.stopPropagation();
    });
    el.addEventListener("pointermove", (e) => {
      if (!mode) return;
      const ci = scanDisplay();
      const dx = (e.clientX - sx) / ci.pw, dy = (e.clientY - sy) / ci.ph;
      const f = { ...start };
      if (mode === "move") { f.x = start.x + dx; f.y = start.y + dy; }
      else { f.w = start.w + dx; f.h = start.h + dy; }
      f.w = Math.max(minW, Math.min(1, f.w));
      f.h = Math.max(minH, Math.min(1, f.h));
      f.x = Math.max(0, Math.min(1 - f.w, f.x));
      f.y = Math.max(0, Math.min(1 - f.h, f.y));
      live(f);
      e.preventDefault();
    });
    // 🔴 THE RELEASE LISTENS ON `window`, NOT ON THE BOX. This is the bug that made the overlay
    // swallow clicks mid-firefight (Sub, 2026-08-13) and it was genuinely dangerous.
    //
    // `dragLock(true)` forces the ENTIRE overlay interactive across every display AND takes
    // focus, deliberately never handing it back. Both are correct for the length of a gesture.
    // But the release was bound to the BOX, guarded by a setPointerCapture whose failure is
    // swallowed ("drag still works without capture" — true of the drag, false of the release).
    // Without capture, a pointer that leaves the box before you let go means the box never sees
    // pointerup, `end` never runs, and dragLock is never lowered. The overlay then eats every
    // click on every monitor and the game stops receiving keystrokes too — which is why tapping
    // F to leave interaction mode appeared to do nothing: Star Citizen was not getting the F.
    // The scan box has sat centre-upper screen, interactive, since it shipped; one stray click
    // with a missed release is all it took, which is exactly why this was rare and random.
    //
    // The widget drag (`dragPointer`) always did this correctly. This now matches it.
    const end = (e) => {
      if (!mode) return;
      mode = null;
      document.body.classList.remove(dragClass);
      window.overlayApi?.dragLock?.(false);
      try { el.releasePointerCapture?.(e && e.pointerId); } catch { /* already released */ }
      commit();   // one write per gesture, not per frame
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    // Belt and braces: a pointer that vanishes without either event (the window losing the device
    // entirely) still ends the gesture rather than leaving the lock raised forever.
    window.addEventListener("blur", () => { if (mode) end(); });
  }

  (() => {
    wireCalBox(document.getElementById("scanBox"), {
      ignore: ["sbReset", "sbHide"],
      start: () => scanRegion || SCAN_DEFAULT,
      live: (f) => { scanRegion = f; drawScanBox(); },
      commit: () => saveScanRegion(scanRegion),
    });
    // Hide is the opt-out for people who don't want the outline on screen. It only writes the
    // pref and re-runs the ONE rule — it never pokes the box directly, so this can't drift from
    // what syncScanBox() decides on the next widget show/hide or launch.
    document.getElementById("sbHide")?.addEventListener("click", (e) => {
      e.stopPropagation();
      try { localStorage.setItem("miningScanBoxHidden", "1"); } catch { /* no storage */ }
      syncScanBox();
      // Tell the Mining Scanner's settings sheet its checkbox just changed. Without this it keeps
      // the value it rendered at init, and re-showing the box needs a redundant off-then-on.
      try { frameWin(WBY.mining)?.__miningSyncSettings?.(); } catch { /* iframe not ready */ }
    });
    document.getElementById("sbReset")?.addEventListener("click", (e) => {
      e.stopPropagation();
      saveScanRegion(null);
    });
  })();

  // The toggle is the mining cog's (same-origin localStorage) and is applied by syncScanBox once the
  // layout loader has settled visibility. The REGION is the sidecar's, since that's what actually
  // reads the screen.
  fetch("/api/config", { cache: "no-store" }).then((r) => r.json()).then((c) => {
    if (c && c.scanRegion) { scanRegion = c.scanRegion; drawScanBox(); }
  }).catch(() => { /* default band it is */ });

  // ── Where the contract scanner reads the offers board ──────────────────────────────────────
  // The same object as the scan box above, for the other screen-reader. Two things make it
  // simpler than its sibling: the region is never absent (the sidecar normalises it to the
  // measured default on load, so calibration is a CORRECTION, never a precondition), and it
  // arrives on the mission SSE — so the drawn rectangle is always the stored one, and a write the
  // server rejects redraws to what is really being cropped instead of leaving a lie on screen.
  let boardRegion = null;      // fractions, straight off `prefs.payoutRegion`
  let boardHidden = false;     // session-only: dismissing the outline is not a lasting preference
  let boardOnPrimary = null;   // null = no crop taken yet, so nothing is known either way

  function drawBoardBox() {
    const el = document.getElementById("boardBox");
    if (!el || !boardRegion) return;
    const ci = scanDisplay();
    el.style.left = Math.round(ci.px + boardRegion.x * ci.pw) + "px";
    el.style.top = Math.round(ci.py + boardRegion.y * ci.ph) + "px";
    el.style.width = Math.round(boardRegion.w * ci.pw) + "px";
    el.style.height = Math.round(boardRegion.h * ci.ph) + "px";
  }
  /** The one rule for whether the outline is up: the scan mode is armed and it hasn't been
   *  dismissed this session. Same shape as syncScanBox — the mode owns it, nothing else, so it
   *  cannot be left behind over the game with no control anywhere to remove it. */
  let bbShown = false;
  function syncBoardBox(on) {
    const el = document.getElementById("boardBox");
    if (!el) return;
    if (!on) boardHidden = false;   // a fresh scan starts with the outline back
    const show = !!on && !boardHidden && !!boardRegion;
    if (show === bbShown) return;   // called on every mission tick; only act on a real change
    bbShown = show;
    document.body.classList.toggle("boardbox", show);
    if (show) drawBoardBox();
  }
  /** Say so when the game is on another monitor — the box only covers the primary, so a region
   *  set here describes pixels the capture never looks at. Only on a definite `false`: before the
   *  first crop this is unknown, and warning on unknown would fire at everyone for the first few
   *  seconds of every scan. */
  function syncBoardWarn() {
    const el = document.getElementById("boardBox"), w = document.getElementById("bbWarn");
    if (!el || !w) return;
    const off = boardOnPrimary === false;
    el.classList.toggle("off-primary", off);
    if (off) w.textContent = "Star Citizen is on another display. This outline only covers your "
      + "primary one, so what you set here won't match what gets read.";
  }
  function saveBoardRegion(f) {
    // `null` means reset — the server answers it with the default and broadcasts, so the redraw
    // comes back the same way a drag does. One path, one source for what the box shows.
    fetch("/api/payout-scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: f }),
    }).catch(() => { /* best-effort; the next broadcast still carries the truth */ });
  }
  wireCalBox(document.getElementById("boardBox"), {
    ignore: ["bbReset", "bbHide"],
    start: () => boardRegion,
    live: (f) => { boardRegion = f; drawBoardBox(); },
    commit: () => saveBoardRegion(boardRegion),
    dragClass: "bb-dragging",
    // Floors above the server's `> 0.02` validation, not equal to it: a box dragged to exactly the
    // limit would be silently rejected, and a control that refuses a gesture without saying so is
    // worse than one that stops you making it. A board this small reads nothing anyway.
    minW: 0.05, minH: 0.05,
  });
  document.getElementById("bbHide")?.addEventListener("click", (e) => {
    e.stopPropagation();
    boardHidden = true;
    syncBoardBox(true);   // still armed — only the outline goes away
  });
  document.getElementById("bbReset")?.addEventListener("click", (e) => {
    e.stopPropagation();
    saveBoardRegion(null);
  });

  // ── The contract-board scan session's dashboard ────────────────────────────────────────────
  // Chrome tied to a MODE, in the same family as the scan box above: one rule decides whether it
  // is on screen, and that rule is the mode itself. Nothing here may hide or show the panel
  // directly, or "the panel is up" and "the app is reading your screen" start to drift apart —
  // which is precisely the blindness this dashboard was built to end.
  const PP_MIN_W = 320, PP_MIN_H = 260;
  // Wide enough that the page's own narrow layout (<=560px) engages, tall enough for the stat
  // grid plus a screenful of rows without scrolling.
  const PP_DEF_W = 460, PP_DEF_H = 620;
  let ppGeom = null;   // {x,y,w,h} in canvas px, or null until first read/placement

  const ppDisplay = () => canvasInfo || { px: 0, py: 0, pw: window.innerWidth, ph: window.innerHeight };

  /** Clamp a geometry so the panel is always reachable on the PRIMARY monitor.
   *  🔑 Sized and placed against --prim-* / canvasInfo, never `vh`. The canvas spans the whole
   *  virtual desktop, so on Sub's rig (a portrait 1080x1920 beside a 3440x1440) `vh` is 1928 —
   *  the unit that hung the patch-notes card off both edges of the monitor it was centred on. */
  function ppClamp(g) {
    const ci = ppDisplay();
    const w = Math.max(PP_MIN_W, Math.min(g.w, ci.pw - 24));
    const h = Math.max(PP_MIN_H, Math.min(g.h, ci.ph - 24));
    return {
      w, h,
      x: Math.max(ci.px + 12, Math.min(ci.px + ci.pw - w - 12, g.x)),
      y: Math.max(ci.py + 12, Math.min(ci.py + ci.ph - h - 12, g.y)),
    };
  }
  function ppDefaultGeom() {
    const ci = ppDisplay();
    // Right-hand side of the primary display: mobiGlas draws the contract board on the LEFT, and
    // the panel exists to be read beside the board rather than on top of it.
    return ppClamp({
      w: PP_DEF_W, h: PP_DEF_H,
      x: ci.px + ci.pw - PP_DEF_W - 40,
      y: ci.py + Math.round((ci.ph - PP_DEF_H) / 2),
    });
  }
  function ppLoadGeom() {
    try {
      const raw = JSON.parse(localStorage.getItem("payoutPanelGeom") || "null");
      if (raw && ["x", "y", "w", "h"].every((k) => Number.isFinite(raw[k]))) return ppClamp(raw);
    } catch { /* no storage, or it was hand-edited to nonsense */ }
    return ppDefaultGeom();
  }
  // Local, not server-side — unlike the mining scan REGION, which the classifier itself reads and
  // therefore has to live in config. This is only where a window sits.
  function ppSaveGeom() {
    try { localStorage.setItem("payoutPanelGeom", JSON.stringify(ppGeom)); } catch { /* no storage */ }
  }
  function ppApplyGeom() {
    const el = document.getElementById("payoutPanel");
    if (!el || !ppGeom) return;
    el.style.left = Math.round(ppGeom.x) + "px";
    el.style.top = Math.round(ppGeom.y) + "px";
    el.style.width = Math.round(ppGeom.w) + "px";
    el.style.height = Math.round(ppGeom.h) + "px";
  }

  /** THE one rule: the panel is up exactly while the scan session is armed.
   *  Driven from applyPrefs(), so every route into the mode — the settings window, the
   *  dashboard's own Stop button, a relaunch forcing it off — arrives here through the same
   *  prefs broadcast and cannot disagree with the others. */
  let ppShown = false;
  function syncPayoutPanel() {
    const on = !!PREFS.payoutScan;
    // The calibration box rides the same broadcast, but tracks the REGION as well as the mode —
    // and the region changes while the mode does not (every accepted drag echoes back). So it is
    // updated BEFORE the mode's change guard, and guards on its own values instead. Compared
    // field-by-field rather than redrawn every tick: this is the hottest broadcast in the app.
    const pr = PREFS.payoutRegion;
    if (pr && (!boardRegion || pr.x !== boardRegion.x || pr.y !== boardRegion.y
               || pr.w !== boardRegion.w || pr.h !== boardRegion.h)) {
      boardRegion = { x: pr.x, y: pr.y, w: pr.w, h: pr.h };
      drawBoardBox();
    }
    if (PREFS.payoutOnPrimary !== boardOnPrimary) {
      boardOnPrimary = PREFS.payoutOnPrimary ?? null;
      syncBoardWarn();
    }
    syncBoardBox(on);
    if (on === ppShown) return;   // this runs on every mission tick; only act on a real change
    ppShown = on;
    document.body.classList.toggle("payoutscan", on);
    const frame = document.getElementById("ppFrame");
    if (on) {
      ppGeom = ppLoadGeom();
      ppApplyGeom();
      // src is set on SHOW and cleared on hide, so a dismissed panel stops its 1s poll instead of
      // ticking unseen forever. Assigning it here (rather than in the markup) is also what gives
      // each session a clean page, which is what you want from something you just switched on.
      if (frame && !frame.getAttribute("src")) frame.setAttribute("src", "/payout-scan.html");
    } else if (frame) {
      frame.removeAttribute("src");
    }
  }

  /** Ending the session, from the ✕. It POSTs the MODE off and lets the broadcast take the panel
   *  down — it never touches the panel directly.
   *  🔑 ✕ stops SCANNING, it does not merely dismiss the dashboard. A panel you can close while
   *  screen-reading stays armed leaves a mode running with nothing on screen to explain it, and
   *  puts the user back to reading a counter that cannot tell "working" from "merely running" —
   *  the exact problem this page exists to solve. Same switch, one meaning. */
  // 🔑 The ✕ must NOT hide the panel itself. "The panel is up" and "your screen is being read" are
  // deliberately the same fact, so only the mode going off may take it down — hiding optimistically
  // would reintroduce the exact blindness this dashboard exists to end (an armed scanner with
  // nothing on screen saying so).
  // ⚠️ But a request that fails then looks EXACTLY like a dead button, which is what Sub hit
  // (2026-08-13: "I click X, it just doesn't work"). So if the mode has not actually gone off
  // shortly after asking, say so on the panel instead of leaving him clicking a ✕ that appears
  // inert. The Stop button in the dashboard and the settings card both remain as ways out.
  function ppEndSession() {
    const say = (msg) => {
      const h = document.getElementById("ppHint");
      if (!h) return;
      h.textContent = msg || "";
      h.style.display = msg ? "block" : "none";
    };
    say("");
    fetch("/api/payout-scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: false }),
    }).then((r) => {
      if (!r.ok) say("Couldn't stop the scan (server said " + r.status + "). Try Stop in the panel.");
    }).catch(() => {
      say("Couldn't reach the background service to stop the scan — is it still running?");
    });
    // Whatever the request said, the mode is what decides. If it has not gone off by now the
    // request was lost somewhere that did not throw, and silence is the unhelpful answer.
    setTimeout(() => { if (PREFS.payoutScan) say("Still scanning — the stop request didn't take. Try again, or stop it from Settings."); }, 1500);
  }

  (() => {
    const el = document.getElementById("payoutPanel");
    if (!el) return;
    document.getElementById("ppClose")?.addEventListener("click", (e) => {
      e.stopPropagation();
      ppEndSession();
    });
    // Drag by the header, resize by the corner. Both run under the canvas-wide drag shield: this
    // panel CONTAINS an iframe, so without it every pointermove from the moment the cursor
    // crossed into the dashboard would go to that document instead of this one and the gesture
    // would freeze mid-drag.
    const startDrag = (e, mode) => {
      if (!ppGeom) return;
      const sx = e.clientX, sy = e.clientY, start = { ...ppGeom };
      e.preventDefault(); e.stopPropagation();
      dragPointer(
        (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          ppGeom = ppClamp(mode === "resize"
            ? { ...start, w: start.w + dx, h: start.h + dy }
            : { ...start, x: start.x + dx, y: start.y + dy });
          ppApplyGeom();
        },
        ppSaveGeom,                                   // one write per gesture, not per frame
        { resize: mode === "resize", bare: true },
      );
    };
    document.getElementById("ppHead")?.addEventListener("pointerdown", (e) => {
      if (e.target && e.target.id === "ppClose") return;   // handled above
      startDrag(e, "move");
    });
    document.getElementById("ppGrip")?.addEventListener("pointerdown", (e) => startDrag(e, "resize"));
  })();

  // ── The Web Page widget's native view ───────────────────────────────────────────────────
  // Its content isn't in the DOM at all: the shell paints a WebContentsView over the canvas,
  // because an iframe can't show a site that busts frames (which the RSI site does). The widget
  // page leaves a hole and tells us where it is IN ITS OWN coordinates; add the frame's position
  // to get canvas coordinates, which is what the shell wants.
  //
  // Everything that moves a widget has to re-report: dragging, resizing, tab switches, show/hide.
  /** The Web Page widget's content is a NATIVE view painted above ALL page content, so any canvas
   *  chrome landing on the same rectangle is drawn BEHIND it — present in the DOM, correct size,
   *  simply invisible and unclickable. That is how the Web Page widget's own ⚙ ended up
   *  unreachable: it opened behind the website.
   *  🔑 Reported as ONE boolean from ONE place. Each caller toggling the mask itself is how the
   *  three existing reasons (arrange, modal, chrome) would start disagreeing — close the hub while
   *  a settings popover is still open and a per-caller mask would un-cover the view underneath it.
   *  Only the Web Page widget is a native view; every other widget is a DOM iframe and stacks
   *  normally by z-index, so none of them can have this problem. */
  function syncViewMask() {
    const chromeOpen = !!document.querySelector(".widget.cfgopen")
      || !!document.querySelector("#hub.open");
    window.overlayApi?.maskWebView?.(chromeOpen);
  }

  /** The hold-to-interact bypass. `modalOpen` is ONE boolean in the shell, and four callers (the
   *  hub, what's-new, the settings cog, mining's cog) each used to write it directly — so closing
   *  any one of them cleared it for whichever others were still open. Exactly the trap the native
   *  view mask above describes, so it gets the same answer: compute the OR from the DOM in ONE
   *  place and report that.
   *  ⚠️ THE MISSION REPORT IS DELIBERATELY NOT IN THIS LIST, and must not be added (Sub, 2026-08-10).
   *  Everything here is something the player OPENED; the report arrives unbidden. This flag bypasses
   *  the hold for the WHOLE canvas, so a card nobody asked for would make every widget rect swallow
   *  game clicks for its entire lifetime — "I don't want them to accidentally do it when they're
   *  just playing the game because it's very annoying." Reaching the card is the same deal as every
   *  other widget: alt-tab to the overlay, or hold the interact key. Clicking it from mobiGlas is
   *  fine and wanted, and needs nothing from us — the game has already released the cursor there.
   *  🔑 Mining's cog lives in an IFRAME and has no selector here, so it reports through the bridge. */
  let miningModal = false;
  function syncModal() {
    const open = !!document.querySelector("#hub.open")
      || !!document.querySelector("#whatsnew.show")
      || !!document.querySelector("#cogMenu.open")
      || miningModal;
    window.overlayApi?.setModal?.(open);
  }

  let webViewHole = null;   // last rect the page told us, in page coordinates
  function reportWebViewHole(w, r) {
    if (r) webViewHole = r;
    const el = wEl(w);
    const frame = document.getElementById("wf-" + w.key);
    // Hidden, or tabbed to the back of a stack: nothing to paint.
    if (!webViewHole || !el || !frame || el.style.display === "none") {
      window.overlayApi?.webViewShow?.(false);
      return;
    }
    const box = frame.getBoundingClientRect();
    window.overlayApi?.webViewBounds?.({
      x: box.left + webViewHole.x,
      y: box.top + webViewHole.y,
      width: webViewHole.width,
      height: webViewHole.height,
    });
    window.overlayApi?.webViewShow?.(true);
  }
  // Drag/resize fire continuously; one rAF-coalesced update per frame is enough and keeps the
  // view glued to the widget instead of trailing it.
  // The shell tells us whether the view is actually on screen — the only reliable source, since a
  // hidden view keeps reporting its last size from the inside.
  let webViewPainted = null;
  window.overlayApi?.onWebViewPainted?.((s) => { webViewPainted = s; });
  let webViewSync = 0;
  function scheduleWebViewSync(w) {
    const widget = w || WBY.webView;
    if (!widget || webViewSync) return;
    webViewSync = requestAnimationFrame(() => { webViewSync = 0; reportWebViewHole(widget, null); });
  }

  // ── Per-widget angle, part 2: the controls ──────────────────────────────────────────────
  // Every place an angle can be read or driven from, for ONE widget: the popover on its own bar,
  // the row injected into a page that has its own settings menu, and — for the two widgets that
  // shipped a bespoke slider (the Blueprint panel, Mining) — that slider. They all drive the same
  // state, so they all have to show the same number.
  const angleControls = (w) => {
    const out = [];
    const el = wEl(w);
    const own = el?.querySelector(".wcfg-ang");
    if (own) out.push({ input: own, val: el.querySelector(".wcfg-angv") });
    const r = wSettingsRoot(w);
    if (r) {
      const inj = r.querySelector(".wang-ang");
      if (inj) out.push({ input: inj, val: r.querySelector(".wang-val") });
      const bespoke = r.querySelector("#cogAngle");
      if (bespoke) out.push({ input: bespoke, val: r.querySelector("#cogAngleV") });
    }
    return out;
  };
  function showAngle(w) {
    const deg = wAngle(w);
    for (const c of angleControls(w)) {
      if (c.input) c.input.value = String(deg);
      if (c.val) c.val.textContent = deg + "°";
    }
  }
  // Inject a Text size row into a page's OWN settings menu, so its cog opens one place with
  // everything in it (Sub, 2026-07-25) rather than a popover that points at a second menu.
  // Angle rides along for the same reason — it's the other control the frame owns rather than the
  // page, and without it a widget whose page has settings had no way to be tilted at all.
  function injectWidgetRows(w) {
    injectTextRow(w);
    injectAngleRow(w);
    injectFadeRows(w);
    showAngle(w);
  }
  // 🔑 The fade controls have to be injected as well, not just offered in the local popover.
  // A widget with settings of its own never opens that popover (the cog has ONE destination), so
  // until now those widgets — the Mission & BP Tracker, Mining Scanner, Loot Split and Event
  // Tracker — had NO fade control at all. Chat is the widget Sub asked for this for.
  function injectFadeRows(w) {
    const root = wSettingsRoot(w);
    if (!root || root.querySelector(".wfade-rows")) return;
    const doc = root.ownerDocument;
    const box = doc.createElement("div");
    box.className = "wfade-rows";
    // These rows go INSIDE the widget's document, so unlike the .wcfg popover they do follow the
    // per-widget text-size control (it is a zoom on that document). Sized to match it at 100%.
    const rowCss = "display:flex;align-items:center;gap:8px;padding:7px 12px;";
    const lblCss = "flex:1;font-size:12px;letter-spacing:.05em;opacity:.9";
    const rngCss = "width:92px;height:5px;cursor:pointer;accent-color:var(--cyan,#45D0E0)";
    const valCss = "min-width:38px;text-align:right;font-size:11.5px;opacity:.8";
    const slider = (cls, label, title) => '<div style="' + rowCss + '">'
      + '<span style="' + lblCss + '">' + label + '</span>'
      + '<input type="range" class="' + cls + '" min="20" max="100" step="5" style="' + rngCss + '"'
      + ' title="' + title + '" />'
      + '<b class="' + cls + 'v" style="' + valCss + '"></b></div>';
    box.innerHTML =
      '<div style="padding:8px 12px 3px;font-size:10px;font-weight:700;letter-spacing:.16em;'
      + 'text-transform:uppercase;opacity:.65">Fade when idle</div>'
      + slider("wcfg-dim", "Panel", "How faint this widget's panel goes while you are not using it. 100% never fades.")
      + slider("wcfg-dimtext", "Text", "How faint this widget's text goes while you are not using it. 100% never fades.")
      + '<label style="' + rowCss + 'cursor:pointer">'
      + '<span style="' + lblCss + '">Full on hover</span>'
      + '<input type="checkbox" class="wcfg-hover" style="accent-color:var(--cyan,#45D0E0);cursor:pointer;width:14px;height:14px"'
      + ' title="Bring this widget back to full opacity while the cursor is over it." /></label>';
    wireFadeControls(w, box);
    root.appendChild(box);
    showFade(w);
  }
  // Shared by the injected rows and the local popover, so the two surfaces cannot drift.
  // Live-apply while dragging, persist on release — the same shape as the angle slider, so a
  // widget never saves a value the user is still sweeping through.
  function wireFadeControls(w, root) {
    const bind = (sel, set) => {
      const el = root.querySelector(sel); if (!el) return;
      // `input` fires while dragging, `change` on release. The drag flag drops the transition to
      // 0ms for the duration, so the panel tracks the thumb exactly instead of chasing it, and
      // the glide comes back for the state changes it was meant for.
      el.addEventListener("input", (e) => { e.stopPropagation(); fadeDragging = true; set(el); });
      el.addEventListener("change", (e) => { e.stopPropagation(); set(el); fadeDragging = false; applyFade(w); persistW(w); });
      el.addEventListener("click", (e) => e.stopPropagation());
      // Don't start a widget drag — and make sure a pointer released anywhere clears the flag,
      // since `change` never fires for a drag that ends outside the control.
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("pointerup", () => { fadeDragging = false; applyFade(w); });
      el.addEventListener("blur", () => { fadeDragging = false; });
    };
    bind(".wcfg-dim", (el) => setWidgetDim(w, el.value));
    bind(".wcfg-dimtext", (el) => setWidgetDimText(w, el.value));
    bind(".wcfg-hover", (el) => setWidgetHoverFull(w, el.checked));
  }
  function injectAngleRow(w) {
    const root = wSettingsRoot(w);
    // Nothing to do for a page that already has its own angle slider (Mining), or the Blueprint
    // panel, whose cog menu carries one — a second control for the same value reads as a bug.
    // Nor for a widget that doesn't tilt at all (see noAngle).
    if (w.noAngle || !root || root.querySelector(".wang-row") || root.querySelector("#cogAngle")) return;
    const doc = root.ownerDocument;
    const row = doc.createElement("div");
    row.className = "wang-row";
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 12px;";
    row.innerHTML = '<span style="flex:1;font-size:11px;letter-spacing:.06em;opacity:.85">Angle</span>'
      + '<input type="range" class="wang-ang" min="-' + ANGLE_MAX + '" max="' + ANGLE_MAX + '" step="1"'
      + ' style="width:84px;height:4px;cursor:pointer;accent-color:var(--cyan,#45D0E0)" />'
      + '<b class="wang-val" style="min-width:34px;text-align:right;font-size:10px;opacity:.75"></b>';
    const input = row.querySelector(".wang-ang");
    input.addEventListener("input", (e) => { e.stopPropagation(); setWidgetAngle(w, input.value); });
    input.addEventListener("change", (e) => { e.stopPropagation(); persistLayout(w); });
    input.addEventListener("click", (e) => e.stopPropagation());
    root.appendChild(row);
  }
  function injectTextRow(w) {
    const root = wSettingsRoot(w);
    if (!root || root.querySelector(".wtext-row")) return;
    const doc = root.ownerDocument;
    const row = doc.createElement("div");
    row.className = "wtext-row";
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 12px;";
    row.innerHTML = '<span style="flex:1;font-size:11px;letter-spacing:.06em;opacity:.85">Text size</span>'
      + '<button type="button" class="wtext-dn" style="font:inherit;font-size:11px;cursor:pointer;padding:2px 7px;border-radius:5px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.22);color:inherit">A−</button>'
      + '<button type="button" class="wtext-up" style="font:inherit;font-size:11px;cursor:pointer;padding:2px 7px;border-radius:5px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.22);color:inherit">A+</button>'
      + '<b class="wtext-val" style="min-width:34px;text-align:right;font-size:10px;opacity:.75"></b>';
    row.querySelector(".wtext-dn").addEventListener("click", (e) => { e.stopPropagation(); bumpTextScale(w, -0.1); });
    row.querySelector(".wtext-up").addEventListener("click", (e) => { e.stopPropagation(); bumpTextScale(w, +0.1); });
    root.appendChild(row);
    showTextScale(w);
  }
  function bumpTextScale(w, by) {
    w.s.text = Math.round(Math.max(TEXT_MIN, Math.min(TEXT_MAX, textScale(w) + by)) * 100) / 100;
    applyTextScale(w); showTextScale(w); persistW(w);
  }
  // Close any open settings popover on an outside click.
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest(".wcfg, .wh-cog")) return;
    document.querySelectorAll(".widget.cfgopen").forEach((b) => b.classList.remove("cfgopen"));
    cancelWidgetSettingsIdle(); // closed by hand — nothing left for the timer to close
    syncViewMask();
  });

  // Put ONE widget back to its default SIZE, in the MIDDLE of the primary monitor. The tray's
  // "Reset overlay layout" is all-or-nothing (it deletes widgets.json), which is too blunt when a
  // single widget has been dragged off-screen or resized badly. Nulling the size fields makes
  // applyFrame fall back to the registry defaults, and persistW writes the nulls through so the
  // reset survives a restart.
  //
  // Centre, NOT the registry default spot (Sub, 2026-07-25): the defaults are scattered starting
  // positions that read as arbitrary once you've arranged your own layout — and the whole point of
  // reset is recovering a widget you can't reach, so it has to land somewhere unmistakably on
  // screen. Coordinates are PRIMARY-relative; applyFrame adds the canvas offset.
  function centreWidget(w) {
    const ci = canvasInfo || { pw: window.innerWidth, ph: window.innerHeight };
    w.s.x = Math.max(0, Math.round((ci.pw - boxW(w)) / 2));
    w.s.y = Math.max(0, Math.round((ci.ph - boxH(w)) / 2));
  }
  function resetWidget(w) {
    if (groupOf(w)) detachFromGroup(w, { keepPlace: true }); // reset means "back on its own", too
    w.s.w = null; w.s.h = null; w.s.scale = null; w.s.angle = null; w.s.text = null;
    w.s.dim = null; w.s.dimText = null; w.s.hoverFull = null;
    centreWidget(w);
    const f = frameEl(w);
    if (f) { f.style.width = ""; f.style.height = ""; } // drop any inline size (mining's setSize)
    applyFrame(w);
    applyTextScale(w);
    applyFade(w);  // back to inheriting the global default, and to full-on-hover
    showAngle(w); // the sliders have to fall back to flat with it
    persistW(w);
  }

  // Reveal a widget's header without needing the wrapper to see a cursor that's over its IFRAME.
  // Cleared when the pointer goes down anywhere else, so it behaves like hover rather than a latch.
  let touchedWidget = null;
  function touchWidget(w) {
    // A click anywhere on the widget whose settings are up means you are still using them, so the
    // idle timer restarts. 🔑 BEFORE the early return: clicking the SAME widget twice is the common
    // case and must keep the panel alive. Embedded pages route their pointerdown here via
    // summonCog, which is what makes this cover clicks INSIDE an iframe's own settings panel.
    if (w && w === wcfgOpenFor) armWidgetSettingsIdle();
    if (touchedWidget === w) return;
    const was = touchedWidget;
    if (was) wEl(was)?.classList.remove("touched");
    touchedWidget = w;
    if (w) wEl(w)?.classList.add("touched");
    // `.touched` restores a faded widget to full, and for a panelled widget that is no longer a
    // CSS rule — the alphas live inside its document, so the class change has to be pushed.
    if (was) applyFade(was);
    if (w) applyFade(w);
  }
  document.addEventListener("pointerdown", (e) => {
    const t = e.target; // a non-Element target (document) has no closest()
    if (!(t instanceof Element) || !t.closest(".widget")) touchWidget(null);
  });
  // ...and when the cursor leaves the overlay entirely. Without this the latch only ever cleared
  // on a pointerdown somewhere else IN this window — but after clicking into Twitch chat or the
  // Notepad you move the cursor back to the GAME, where the window is click-through and sees
  // nothing at all, so the bar stayed out for good. The shell's cursor poll is the only thing
  // that still knows where the pointer is.
  window.overlayApi?.onCursorAway?.(() => touchWidget(null));
  // A cursor over the Web Page widget's native view never reaches this document, so :hover can't
  // reveal its bar the way it does for every other widget. The shell watches the cursor and tells
  // us; `.touched` is the same lever an embedded page pulls on pointerdown.
  window.overlayApi?.onWebViewCursor?.((on) => { if (WBY.webView) touchWidget(on ? WBY.webView : null); });

  // Create the iframe (idempotent). Loading it starts whatever the page does — SSE, polling,
  // audio — so only arm it when the widget is shown, or when the shell asks for it to be armed
  // hidden (mining's auto-show).
  // Does this page have settings of its own? That decides whether the cog's popover offers a way
  // through to them (every widget gets text size regardless).
  // 🔑 Probed on the iframe's LOAD event, not just on the page's ready() call: a page can call
  // ready() before it finishes defining its own exports, so a ready-only probe misses them.
  function probeSettings(w) {
    if (w.local) { wEl(w)?.classList.add("has-settings"); injectWidgetRows(w); return; }
    try {
      const has = typeof frameWin(w)?.__widgetSettings === "function";
      wEl(w)?.classList.toggle("has-settings", has);
      if (has) injectWidgetRows(w);
      else showAngle(w); // its own popover carries the slider instead
    } catch { /* iframe gone */ }
  }

  function ensureFrame(w) {
    if (w.local || w.armed) return;
    const f = frameEl(w); if (!f) return;
    // Wire the load handler ONCE — a widget can be unloaded and re-armed any number of times now.
    if (!w.wired) {
      w.wired = true;
      // 🔑 The fade has to be re-pushed on every load. It lives on the frame's OWN documentElement
      // now, so a reload (arming, a regroup, a theme switch) throws it away silently — the widget
      // would come back at full opacity with its sliders still claiming otherwise.
      f.addEventListener("load", () => { if (w.armed) { probeSettings(w); applyTextScale(w); applyFade(w); } });
    }
    const theme = document.documentElement.getAttribute("data-theme") || (PREFS && PREFS.theme) || "mobiglas";
    const lite = document.documentElement.classList.contains("amd-lite") ? "&lite=1" : "";
    f.src = "/" + w.page + "?embedded=1&theme=" + encodeURIComponent(theme) + lite;
    w.armed = true;
  }

  // 🔑 CLOSED MEANS CLOSED (Sub, 2026-07-25). Hiding a widget used to leave its iframe loaded
  // forever, so a widget you opened once and closed kept its poll timers running, kept its SSE
  // stream open and, in Twitch chat's case, kept an IRC socket taking every message in the
  // channel — for a box that isn't on screen. Dropping the src frees the timers, the sockets and
  // the document's memory in one go; re-opening reloads it, which is what "open" should mean.
  //
  // NOT the same as backgrounding a group tab: that never comes through here (see
  // refreshGroupDisplay), so a tabbed-away widget still keeps its scrollback and unsaved text.
  // A widget the shell ARMED (mining waiting to auto-show, see keepLoaded) also stays loaded —
  // it has to be listening to be able to pop itself up.
  function unloadFrame(w) {
    if (w.local || !w.armed || w.keepLoaded) return;
    const f = frameEl(w); if (!f) return;
    w.armed = false;
    try { f.src = "about:blank"; } catch { /* already gone */ }
    wEl(w)?.classList.remove("has-settings");
  }

  // `bringToFront` distinguishes a USER turning a widget on from the shell REPLAYING saved
  // visibility at startup. Both arrive on the same channel, and treating the replay as nine
  // deliberate "show this" actions re-fronted each group member in turn — last one wins, by
  // registry order — then persisted it, so a stack could never remember the tab you left it on.
  function setWidgetVisible(w, on, bringToFront = true) {
    const el = wEl(w); if (!el) return;
    w.s.visible = !!on;
    const g = groupOf(w);
    if (on) {
      ensureFrame(w);
      if (g && bringToFront) { g.active = w.key; saveGroups(); } // turning one on brings its tab forward
      showEl(w, true); // fires onShow
      applyFrame(w);
      if (g) refreshGroupDisplay(g);
      // Turned on while arrange is ALREADY active? Then it joins arrange too. After the group
      // refresh, because that is what decides whether this member is the displayed one.
      syncArrange(w);
    } else {
      showEl(w, false); // fires onHide
      unloadFrame(w);
      el.classList.remove("moving");
      // 🔑 Hiding does NOT leave the stack. Closing a tab does — but the ✕ is the only control
      // that means "close", and it detaches on its own (see the .wh-close handler). Everything
      // else routed here is a visibility TOGGLE: a hotkey, the tray, the hub checkbox. Detaching
      // on those orphaned the widget — Argante: hide the Mining Scanner by hotkey and it was
      // kicked out of its group, then came back as a lone window sitting behind the stack it used
      // to belong to. `active` is left alone so the tab he chose is still fronted when it returns.
      if (g) refreshGroupDisplay(g);
    }
    renderGroupTabs();
  }

  // Keep an embedded page's theme in sync when the overlay retints (same-origin; no SSE needed).
  // It applies ?theme= at load, so a not-yet-ready iframe is already correct.
  function syncWidgetTheme(w) {
    if (w.local || !w.armed) return;
    const f = frameEl(w); if (!f) return;
    try {
      const doc = f.contentDocument;
      const theme = document.documentElement.getAttribute("data-theme") || "mobiglas";
      if (doc && doc.documentElement) doc.documentElement.setAttribute("data-theme", theme);
    } catch { /* iframe not ready yet */ }
  }
  function syncAllWidgetThemes() { for (const w of WIDGETS) syncWidgetTheme(w); }

  // Same-origin bridges: every embedded page calls window.parent.__<key>Host. The common members
  // are identical for all of them, so only the extras come from the table.
  for (const w of WIDGETS) {
    if (w.local) continue; // nothing to bridge to - it is in this document
    const base = {
      // notifyVisibility: the page is only NOW able to hear it. An armed-hidden widget is created
      // and hidden before its contentWindow exists, so that first onHide went nowhere.
      ready: () => { applyFrame(w); syncWidgetTheme(w); probeSettings(w); applyTextScale(w); applyFade(w); notifyVisibility(w, wShown(w)); },
      // Every embedded page calls this on pointerdown, so it doubles as "the user is engaging
      // THIS widget" — which is what reveals its header even if the wrapper never sees the
      // cursor because an iframe is under it.
      summonCog: () => { touchWidget(w); summonGlobalCog(); },
      persist: () => persistW(w),
    };
    // Text fields share ONE keyboard grab with the shell; textFocusTarget routes the focus signal
    // back to whichever widget asked for it.
    if (w.focusFn) {
      base.editStart = () => { textFocusTarget = w.key; window.overlayApi?.notepadEditing?.(true); };
      base.editEnd = () => window.overlayApi?.notepadEditing?.(false);
    }
    window["__" + w.key + "Host"] = { ...base, ...(w.host ? w.host(w) : {}) };
  }

  // Which widget asked for the keyboard grab — the shell's focus signal is one channel shared by
  // every widget with a text field, so route it to the one that asked.
  let textFocusTarget = "notepad";
  // The shell says the (held) interact key is released → safe to focus the text field now.
  window.overlayApi?.onNotepadFocus?.(() => {
    try {
      const w = WBY[textFocusTarget];
      if (w?.focusFn) frameWin(w)?.[w.focusFn]?.();
      else frameWin(WBY.notepad)?.__notepadFocus?.(); // widgets without their own field fall back
    } catch { /* iframe gone */ }
  });

  // Shell (main.cjs) drives visibility on a per-widget channel: {on:true} show ·
  // {on:false,arm:true} load hidden so it can pop itself later · {on:false} hide.
  for (const w of WIDGETS) {
    if (w.local) continue; // no shell channel; the hub toggles this one directly
    const chan = "on" + w.key.charAt(0).toUpperCase() + w.key.slice(1) + "Visible";
    window.overlayApi?.[chan]?.((s) => {
      if (!s) return;
      // `arm` = "keep listening while hidden" (mining's auto-show). Everything else gets unloaded
      // when it's closed, so it stops costing anything.
      w.keepLoaded = !!s.arm;
      // s.initial = the shell replaying saved state on launch, not a click. It must NOT re-front
      // this widget's group tab (see setWidgetVisible).
      if (s.on) setWidgetVisible(w, true, !s.initial);
      else { if (s.arm) ensureFrame(w); setWidgetVisible(w, false); }
    });
  }
  // Re-read the chart PNG whenever the shell asks (a re-exported chart shows up without a restart).
  window.overlayApi?.onBindingChartReload?.(() => { try { frameWin(WBY.bindingChart)?.__bindingReload?.(); } catch { /* not loaded */ } });
  // The shell's fade override: the hotkey, and arrange mode. Per-widget values are untouched —
  // this only suspends the fade while it is on.
  // html.no-dim still drives the notifiers straight from CSS, but a panelled widget's fade lives
  // inside its own document where that class cannot reach — so the override has to be re-pushed.
  window.overlayApi?.onDimOverride?.((off) => {
    document.documentElement.classList.toggle("no-dim", !!off);
    applyAllFades();
  });
  window.overlayApi?.onDimGlobal?.((v) => { if (Number.isFinite(v)) { globalDim = v; applyAllFades(); } });

  // Tab clicks (delegated on the document — tabs are re-rendered into widget bars constantly).
  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest(".gtab") : null; if (!btn) return;
    e.stopPropagation();
    const g = GROUPS.find((x) => x.id === btn.dataset.g); if (!g) return;
    if (btn.classList.contains("gdetach")) {
      // Pop out the member you can SEE, which is not always `active` — the ⧉ sits in the displayed
      // member's own tab strip, so targeting `active` could pop a hidden widget instead.
      const active = WBY[groupShown(g)]; if (active) detachFromGroup(active);
      return;
    }
    const w = WBY[btn.dataset.k]; if (!w) return;
    g.active = w.key;
    if (!w.s.visible && window.overlayApi) { // clicking a closed tab reopens it, via the shell
      const setter = "set" + w.key.charAt(0).toUpperCase() + w.key.slice(1);
      window.overlayApi[setter]?.(true);
    }
    refreshGroupDisplay(g);
    saveGroups();
  });

  // Which widget's BAR is under the cursor — the drop target while dragging. Aiming at the bar
  // (rather than a strip of the panel) is why arrange mode keeps bars out: you drag one bar onto
  // another, and both ends of the gesture are the same visible thing.
  function dropTargetAt(cx, cy, dragging) {
    for (const t of WIDGETS) {
      if (t === dragging) continue;
      const el = wEl(t); if (!el || !wShown(t)) continue;
      const gt = groupOf(t), gd = groupOf(dragging);
      if (gt && gd && gt === gd) continue; // already stacked together
      const bar = el.querySelector(".whead"); if (!bar) continue;
      const r = bar.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return t;
    }
    return null;
  }
  let dropHighlighted = null;
  function highlightDrop(t) {
    if (dropHighlighted === t) return;
    if (dropHighlighted) wEl(dropHighlighted)?.classList.remove("droptarget");
    dropHighlighted = t;
    if (t) wEl(t)?.classList.add("droptarget");
  }
  if (CANVAS) {
    // Load saved layouts (all widgets share widgets.json, keyed by `key`), then wire drag/resize.
    (async () => {
      let all = null;
      try { all = await window.overlayApi?.getWidgets?.(); } catch { /* none saved yet */ }
      const q = new URLSearchParams(location.search);
      // Groups first, so applyFrame() below already knows which widgets share a box. Drop any
      // member that no longer exists, and any group left with fewer than two.
      const savedGroups = (all && all.__groups && Array.isArray(all.__groups.list)) ? all.__groups.list : [];
      GROUPS = savedGroups
        .map((g) => ({ ...g, members: (g.members || []).filter((k) => WBY[k]) }))
        .filter((g) => g.members.length >= 2);
      for (const g of GROUPS) if (!g.members.includes(g.active)) g.active = g.members[0];
      for (const w of WIDGETS) {
        const saved = (all && all[w.key]) || null;
        if (saved) w.s = { ...w.s, ...saved };
        // 🔑 The Mission & BP Tracker ALWAYS opens on launch, whatever it was left in (Sub,
        // 2026-07-29: "I don't care what its last state was"). It is the app's main surface, and
        // a saved `visible:false` — a stray ✕, or a session that ended with it closed — meant
        // opening the app to an empty screen. Forced HERE, where the saved layout is applied,
        // rather than in the canvas block further down: that block races this loader and lost.
        // Every other widget still restores exactly what it was.
        if (w.key === "blueprint" && w.s.visible === false) w.s.visible = true;
        if (w.s.x == null || w.s.y == null) {
          if (w.defFn) w.defFn(w); else { w.s.x = w.def.x; w.s.y = w.def.y; }
        }
        applyFrame(w);
        applyTextScale(w);
        applyFade(w);
        if (w.local) probeSettings(w); // no iframe load event will ever fire for it
        if (q.has(w.key.toLowerCase())) setWidgetVisible(w, true); // headless-test this widget
      }
      renderGroupTabs();
      // 🔑 PULL the shell's visibility state, now that the widgets actually EXIST.
      //
      // This is the fix for "the app starts and none of my widgets are anywhere to be found"
      // (Sub, 2026-08-03). The shell PUSHES visibility from did-finish-load, but this loader is
      // async — it awaits getWidgets() — so those messages routinely arrive BEFORE any widget
      // element has been built. setWidgetVisible opens with `const el = wEl(w); if (!el) return;`
      // so every one of them was SILENTLY DROPPED and the canvas stayed empty. The only escape
      // was the overlay hotkey, which destroys and recreates the window (setOverlayEnabled) and
      // re-runs the whole race — hence "hit F3, sometimes twice".
      //
      // A push cannot fix this, because the shell has no way to know when the renderer is ready;
      // every attempt to time it is another guess. So the renderer ASKS, at the one moment it
      // knows it is ready. `app:widget-states` and preload's widgetStates() already existed for
      // exactly this — nothing had ever called them.
      //
      // bringToFront:false — this is a REPLAY of saved state, not a click, so it must not
      // re-front a stack's tab (same reason did-finish-load sends `initial: true`).
      try {
        const states = await window.overlayApi?.widgetStates?.();
        if (states) {
          for (const [key, on] of Object.entries(states)) {
            const w = WBY[key];
            if (w && !!on !== !!w.s.visible) setWidgetVisible(w, !!on, false);
          }
        }
      } catch { /* no shell — OBS/browser, where the page owns its own visibility */ }
      // 🔑 APPLY the restored `active` — restoring it isn't enough. Two things make this the only
      // place it can happen: the loader is async (it awaits getWidgets), so the shell's per-widget
      // visibility messages can land BEFORE GROUPS exists, at which point groupOf() is null and
      // nothing group-aware runs; and showEl is driven per widget, so without this every visible
      // member of a stack ends up displayed at once in the same box. Same trap as the tracker's
      // forced-open rule and syncScanBox below: it has to be decided at the END, once state settles.
      for (const g of GROUPS) refreshGroupDisplay(g);
      // Now that visibility is settled, decide whether the scan read area is up. It can't be
      // decided at parse time: the widget's frame doesn't exist yet, so it would always come out
      // "hidden" and a player who left the outline on would find it gone.
      syncScanBox();
    })();

    for (const w of WIDGETS) {
      const el = wEl(w); if (!el) continue;
      // The move banner doubles as a drag shield over the iframe, which would otherwise swallow
      // the pointer.
      // Two grab surfaces, one gesture: the full-widget shield (the big easy target) and the bar
      // itself, so a widget can be dragged by its bar onto another widget's bar.
      const startDrag = (e) => {
        if (e.target.closest(".wdone") || e.target.closest(".wresize")) return;
        e.preventDefault();
        // Dragging any member of a group moves the whole stack.
        const g0 = groupOf(w);
        const sx = e.clientX, sy = e.clientY;
        const ox = g0 ? g0.x : w.s.x, oy = g0 ? g0.y : w.s.y;
        let dropOn = null;
        dragPointer((ev) => {
          const nx = ox + (ev.clientX - sx), ny = oy + (ev.clientY - sy);
          if (g0) { g0.x = nx; g0.y = ny; applyGroup(g0); }
          // Just the frame: moving a standalone widget can't change anyone's tabs, and rebuilding
          // every bar's tab strip on each pointermove was work the drag paid for nothing.
          else { w.s.x = nx; w.s.y = ny; applyFrame(w); }
          dropOn = dropTargetAt(ev.clientX, ev.clientY, w);
          highlightDrop(dropOn);
        }, () => {
          highlightDrop(null);
          if (dropOn) groupWidgets(w, dropOn);      // dropped on another widget's bar → stack
          else if (g0) saveGroups();
          else persistW(w);
        });
      };
      el.querySelector(".wmove")?.addEventListener("pointerdown", startDrag);
      // The bar is a drag handle WHENEVER it's out, not just while arranging (Sub, 2026-07-25) —
      // if it looks grabbable it should be grabbable. Clicks on its buttons and tabs still win,
      // since those sit above it and stop the event.
      el.querySelector(".whead")?.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".wh-btn, .gtab, .wcfg")) return;
        startDrag(e);
      });
      el.querySelector(".wresize")?.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        const sx = e.clientX, sy = e.clientY;
        const g = groupOf(w);
        if (w.shape === "scaled" && !g) {
          const os = wScale(w);
          dragPointer((ev) => { w.s.scale = Math.max(0.5, Math.min(2.5, os + (ev.clientX - sx) / 380)); applyFrame(w); }, () => persistW(w), { resize: true });
        } else {
          const f = frameEl(w);
          const ow = g ? g.w : (w.s.w != null ? w.s.w : (f?.offsetWidth || w.size.w));
          const oh = g ? g.h : (w.s.h != null ? w.s.h : (f?.offsetHeight || w.size.h));
          const z = w.size;
          dragPointer((ev) => {
            const nw = Math.max(z.minW, Math.min(z.maxW, ow + (ev.clientX - sx)));
            const nh = Math.max(z.minH, Math.min(z.maxH, oh + (ev.clientY - sy)));
            // Resizing a grouped widget resizes the whole stack — the tabs share one box.
            if (g) { g.w = nw; g.h = nh; applyGroup(g); }
            else { w.s.w = nw; w.s.h = nh; applyFrame(w); }
          }, () => { if (g) saveGroups(); else persistW(w); }, { resize: true });
        }
      });
      el.querySelector(".wdone")?.addEventListener("click", () => window.overlayApi.endMove());

      // Header actions. Close goes through the SHELL's per-widget setter rather than just hiding
      // the element, so the tray checkbox, the cog hub and the persisted flag all stay in step —
      // the shell is the one source of truth for visibility.
      const setter = "set" + w.key.charAt(0).toUpperCase() + w.key.slice(1);
      el.querySelector(".wh-close")?.addEventListener("click", (e) => {
        e.stopPropagation();
        // Closing a tab leaves the stack, the way closing a browser tab does. This is the ONLY
        // control that means "close" — a hotkey or tray toggle just hides — so the detach lives
        // here rather than in setWidgetVisible, which cannot tell the two apart (both arrive back
        // from the shell on the same visibility channel).
        detachFromGroup(w);
        if (window.overlayApi?.[setter]) window.overlayApi[setter](false);
        else setWidgetVisible(w, false); // no shell (OBS/browser) — hide locally
      });
      // THIS widget's own settings, not the app's — global settings live on the global cog and the
      // tray (Sub, 2026-07-24). Opens a small popover carrying TEXT SIZE (every widget has it,
      // since they're all responsive now) plus a way through to the page's own panel if it has one.
      const bar = el.querySelector(".whead");
      el.querySelector(".wh-cog")?.addEventListener("click", (e) => {
        e.stopPropagation();
        // 🔑 THE TRACKER'S BAR COG *IS* #cog — one button carrying both `wh-cog` and `id="cog"`,
        // so it has TWO click listeners and `stopPropagation` does nothing about that (they are
        // on the same element; only stopImmediatePropagation would, and suppressing the other one
        // is not what we want). #cog's own handler already toggles the menu correctly, so this one
        // must stand down or the two fight: this opens, that sees it open and closes it, and the
        // menu never appears. It went unnoticed for exactly as long as this branch was a no-op for
        // local widgets — the old code reached through frameWin(), which is null for a widget that
        // lives in this document.
        if (w.local) return;
        // 🔑 THE COG TOGGLES. It used to only ever OPEN, so clicking it a second time re-opened an
        // already-open sheet and read as a dead button — the 15s idle timer was the only way to
        // dismiss one (Sub, 2026-08-11: "I can't get the settings menu to go away"). Both
        // destinations had it: the popover branch cleared `cfgopen` from every widget and then
        // immediately put it back on this one, and the pages expose no close at all.
        // Whether THIS widget was open has to be read BEFORE the clear below wipes the evidence.
        let wasOpen = el.classList.contains("cfgopen");
        if (el.classList.contains("has-settings")) {
          try { wasOpen = !!wSettingsRoot(w)?.classList.contains("open"); } catch { /* iframe gone */ }
        }
        document.querySelectorAll(".widget.cfgopen").forEach((b) => b.classList.remove("cfgopen"));
        if (wasOpen) {
          wCloseSettings(w);
          cancelWidgetSettingsIdle();
          syncViewMask();
          return;
        }
        touchWidget(w);
        // ONE destination. A page with its own settings opens THAT (the Text size row was injected
        // into it); everything else opens the local popover, which carries Text size itself.
        if (el.classList.contains("has-settings")) {
          try { wOpenSettings(w); showTextScale(w); showAngle(w); showFade(w); } catch { /* iframe gone */ }
          syncViewMask();
          armWidgetSettingsIdle(w);
          return;
        }
        el.classList.add("cfgopen");
        showTextScale(w);
        showAngle(w);
        showFade(w);
        syncViewMask();
        armWidgetSettingsIdle(w);
      });
      el.querySelector(".wcfg")?.addEventListener("click", (e) => e.stopPropagation());
      el.querySelector(".wcfg-dn")?.addEventListener("click", (e) => { e.stopPropagation(); bumpTextScale(w, -0.1); });
      el.querySelector(".wcfg-up")?.addEventListener("click", (e) => { e.stopPropagation(); bumpTextScale(w, +0.1); });
      // Live-apply while dragging, persist on release — the same shape as the Blueprint panel's
      // slider, so a widget never saves an angle the user is still sweeping through.
      const angIn = el.querySelector(".wcfg-ang");
      angIn?.addEventListener("input", (e) => { e.stopPropagation(); setWidgetAngle(w, angIn.value); });
      angIn?.addEventListener("change", (e) => { e.stopPropagation(); persistLayout(w); });
      angIn?.addEventListener("pointerdown", (e) => e.stopPropagation()); // don't start a widget drag
      // 🔑 persistW, not persistLayout. The fade is per WIDGET, but persistLayout writes to the
      // GROUP when one is stacked — so a grouped widget's fade was being saved onto an object
      // nothing reads it back from, and silently forgot itself on restart.
      wireFadeControls(w, el);
      el.querySelector(".wh-move")?.addEventListener("click", (e) => { e.stopPropagation(); window.overlayApi?.beginMove?.(); });
      el.querySelector(".wh-reset")?.addEventListener("click", (e) => { e.stopPropagation(); resetWidget(w); });
      // Engaging a widget's own chrome reveals its header too (the iframe can't report this one).
      el.addEventListener("pointerdown", () => touchWidget(w));
      // Hover-to-full used to be `.widget:hover { opacity: 1 }`. It cannot stay CSS now that the
      // fade lives inside the widget's own document, so the crossing is watched here and pushed
      // through applyFade — which is also what lets it be a per-widget preference.
      el.addEventListener("mouseenter", () => applyFade(w));
      el.addEventListener("mouseleave", () => applyFade(w));
    }
  }

  // Arrange mode holds a sample card up so an idle (invisible) SC Feed can still be positioned.
  // Arrange-mode sample card for a notifier. Each notifier page exposes __<key>Preview, so this
  // works for any of them rather than being wired to one — the second notifier (Unlock Alerts)
  // would be invisible in arrange mode if this stayed scFeed-only.
  function notifierPreview(w, on) {
    try { frameWin(w)?.["__" + w.key + "Preview"]?.(on); } catch { /* iframe not ready */ }
  }

  /** Put ONE widget into (or out of) arrange decoration — the drag banner and, for a notifier,
   *  its sample card. Reads the single source of truth, `body.arranging`, rather than taking a
   *  flag, so no caller can disagree with the mode the canvas is actually in.
   *
   *  🔑 Called by the arrange TOGGLE for every widget AND by the show path for one. That second
   *  call is the whole point: arrange used to decorate only the widgets that existed at the
   *  moment it was entered, so a widget switched on afterwards opened undecorated — Sub: "it's
   *  just not in the move mode like every other app is" — and the only cure was leaving and
   *  re-entering arrange, which re-ran the sweep. Same shape as syncScanBox: one rule, applied
   *  from every path that can change the answer. */
  function syncArrange(w) {
    const el = wEl(w); if (!el) return;
    const on = document.body.classList.contains("arranging") && el.style.display !== "none";
    el.classList.toggle("moving", on);
    if (w.notifier) notifierPreview(w, on);
  }

  if (CANVAS) {
    $("panel").classList.add("canvas");
    document.body.classList.add("canvas");
    (async () => {
      try { canvasInfo = await window.overlayApi?.getCanvasInfo?.() || null; } catch { /* single-monitor fallback */ }
      applyCanvasVars(); // pin screen-anchored chrome to the primary monitor (multi-monitor void-safe)
      drawScanBox();     // now that the real display geometry is known, not the window's guess
      window.overlayApi?.onCanvasChanged?.(() => { void refreshCanvasGeometry(); });
      reportGeometry(); // baseline, so diagnostics has an answer before anything changes
      let saved = null;
      // (the panel's own layout is loaded by the registry loader, keyed "blueprint")
      const q = new URLSearchParams(location.search); // test overrides
      applyAllFrames(); // re-apply every widget with the now-loaded canvas offset (they init in their own async block)
      // The tracker's forced-open rule lives in the registry loader (search "ALWAYS opens on
      // launch") — it has to, because that loader applies the saved layout AFTER this block.
      if (WBY.blueprint.s.visible === false) document.body.classList.add("bp-hidden");
      if (q.has("arrange")) { // headless-test the arrange chrome (incl. any widget also shown via its own flag)
        $("panel").classList.add("moving"); document.body.classList.add("arranging");
        for (const w of WIDGETS) syncArrange(w);
      }
      if (q.has("cogopen")) { $("cogMenu").classList.add("open"); $("cog").classList.add("open"); } // headless-test the widget cog
      // headless-test the patch-notes modal. Markup is written out rather than built through
      // wnListHtml because that lives in a later block and isn't on `window` yet at this point.
      // It mirrors the builder's shape: a kind heading, then label-over-description notes, plus
      // one legacy unlabelled note so both paths are on screen at once.
      if (q.has("whatsnew")) { $("wnVer").textContent = "v0.1.31"; $("wnList").innerHTML = '<div class="wn-group"><div class="wn-gver">v0.1.31</div><div class="wn-kind">New</div><ul><li><div class="wn-note"><div class="wn-label">Newest note one</div><div class="wn-desc">What the first change actually does.</div></div></li></ul><div class="wn-kind">Fixed</div><ul><li><div class="wn-note"><div class="wn-label">Newest note two</div><div class="wn-desc">What the second change actually does.</div></div></li></ul></div><div class="wn-group"><div class="wn-gver">v0.1.30</div><ul><li><div class="wn-note nolabel"><div class="wn-desc">Older note</div></div></li></ul></div>'; $("whatsnew").classList.add("show"); }
      if (q.has("cog")) $("globalCog").classList.add("show"); // headless-test the summoned cog
      if (q.has("bppop")) maybeBpPop({ name: "MH1 Multi-Tool", image: null, at: new Date().toISOString() }); // headless-test the blueprint-received pop
      // Headless-test the Mission/Faction drawers with a TWO-SCOPE reputation award — the case
      // that made "+200 / +50" unreadable, and the one a live tracked mission rarely happens to
      // be. Real values: Headhunters' Turf War, rank 2, FactionReputation 200 + Affinity 50.
      if (q.has("missioninfo")) {
        $("panel").classList.remove("empty"); document.body.classList.remove("empty");
        const el = $("pool");
        if (el) el.innerHTML = missionInfoHtml({
          giver: "Headhunters", missionType: "Mercenary", illegal: true,
          rankRequired: 2, rankRequiredName: "Contractor",
          reputationGained: [
            { faction: "Headhunters", scope: "FactionReputation", amount: 200 },
            { faction: "Headhunters", scope: "Affinity", amount: 50 },
          ],
          reputationLost: [], payout: null, whereToGet: ["Rat's Nest", "Starlight Service Station"],
          otherPools: [{ places: ["Orbituary", "Bloom"], total: 7, owned: 5 }],
          community: null, inferredRank: 2, contractKey: "demo", ambiguous: false,
        }, true);
      }
      // Headless-test the whole idle panel: closest-to-done, the session totals, the per-hour
      // rates and a Latest list long enough to prove the size-based truncation.
      if (q.has("rates")) {
        $("panel").classList.remove("empty"); document.body.classList.remove("empty");
        const now = Date.now();
        // Two distinguishable 1x1 GIFs standing in for the two image sources. Inline, so the
        // fixture costs no network and cannot 404 the suite's console/network check.
        const FIXTURE_CAPTURE = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
        const FIXTURE_RENDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        const bps = ["Atzkav Sniper Rifle", "Calico Arms Tactical", "Atzkav \"Igniter\" Sniper Rifle",
          "Custodian SMG", "Karna Rifle", "Yubarev Pistol", "Salvo Frag Pistol", "Behring P8-AR",
          "Lumin V SMG", "Arclight II", "Devastator-12", "Gallant Rifle"]
          // 🔑 A real-shaped mix of image coverage, because the tile has three code paths and the
          // measured split is roughly 27% capture / 70% render-only / 3% neither. Every third
          // entry carries only a render and every fourth carries nothing, so a fixture render
          // exercises the fallback chain AND the no-art glyph rather than only the happy path.
          //
          // ⚠️ INLINE DATA URIs, NOT URL-SHAPED FAKES. Pointing these at
          // `/api/fab-img/<made-up-uuid>` made every fixture tile fetch something that does not
          // exist, and `test:widgets` correctly failed the run on four 404s — a fixture must not
          // put the suite's own network check in the red. Two DISTINCT one-pixel images so the
          // assertions can still tell which source a tile chose.
          .map((name, i) => ({
            name,
            at: new Date(now - (i + 1) * 18 * 60000).toISOString(),
            item: i % 4 === 3 ? null : "fixture-item-" + i,
            image: i % 4 === 3 || i % 3 === 2 ? null : FIXTURE_CAPTURE,
            imageFallback: i % 4 === 3 ? null : FIXTURE_RENDER,
          }));
        current = {
          earnings: { repLastHr: 1240, repPace: 1480, aUECLastHr: null, aUECPace: null,
            aUECTotal: 148250, repTotal: 2860, missions: 6 },
          // TEN, like the blueprint list — the two share the leftover space and a one-entry
          // fixture cannot exercise the split, the ten-row cap, or the "+N more" reservation.
          // Half carry no aUEC on purpose: calculated-reward contracts log no payout, and the row
          // must simply omit the figure rather than print a zero.
          recentMissions: ["Blackbox Retrieval Very Dangerous", "Deep space hit", "Moraine Data Retrieval",
            "Need a death at Asteroid Base", "Turf War", "Critical Fleet Refuel", "Cargo Run: Bloom",
            "Salvager Needed", "Wanted: Dead or Alive", "Urgent Convoy Refuel"]
            .map((title, i) => ({ title, aUEC: i % 2 ? null : 9000 + i * 1500,
              at: new Date(now - (i + 1) * 11 * 60000).toISOString() })),
          recentBlueprints: bps,
          // POOLS, not contracts — one row per poolUuid. Shaped like the real thing: a pool fed by
          // many contracts (the common case, 65 of 89), a single-contract pool that must show no
          // "more contracts" affordance, and a PAIR that collide on giver+type exactly as Sub's
          // two Shubin mining pools do, so the disambiguation has something to disambiguate.
          // Payouts are always modelled on pool contracts; they are carried but not rendered.
          // Standing with four givers, shaped like the real thing (measured on Sub’s collection:
          // 9 givers carry witnessed rep, Battaglia furthest through its rank at 72%).
          // 🔑 The LAST entry is at max rank — toGo null — and must be dropped by every layout:
          // there is no next rank to incentivise, so listing it is an invitation to nothing.
          // Only ONE giver gates a reward at its next rank, which is the honest ratio and is what
          // forces the "unlock" layout to degrade rather than render an empty promise.
          standings: [
            { faction: "Recco Battaglia", scope: "MissionProviderReputation_Battaglia",
              standing: "Prestige 1", nextName: "Prestige 2", estimate: 24700, curMin: 20000,
              nextMin: 30000, pct: 72, toGo: 5300, contractsToGo: 27,
              nextRewards: ["MISC Prospector Alliance", "Drake Golem Alliance"] },
            { faction: "Covalex Independent Contractors", scope: "Hauling",
              standing: "Junior", nextName: "Member", estimate: 1800, curMin: 750,
              nextMin: 5250, pct: 31, toGo: 3450, contractsToGo: 7, nextRewards: [] },
            { faction: "United Wayfarers Club", scope: "FactionReputation",
              standing: "Neutral", nextName: "Jr. Contractor", estimate: 200, curMin: 0,
              nextMin: 800, pct: 25, toGo: 600, contractsToGo: 3, nextRewards: [] },
            { faction: "Maxed Faction", scope: "FactionReputation",
              standing: "Head Contractor", nextName: null, estimate: 99000, curMin: 90000,
              nextMin: null, pct: 100, toGo: null, contractsToGo: null, nextRewards: [] },
          ],
          closestPools: [
            { poolUuid: "819a9851-9c2e-4a24-872b-b860331d32d0", key: "a", title: "Turf War",
              poolName: "Mercenary · Headhunters", variants: 26,
              missionTitles: ["Turf War", "Turf War: Escalation", "Clear the Nest"],
              missing: ["Karna Rifle", "Salvo Frag Pistol"],
              owned: 5, total: 7, places: ["Rat's Nest", "Starlight Service Station"],
              payMin: 54500, payMax: 54500, payoutEstimated: true, durMin: 15.12, rep: 100,
              cooldownMin: 30, giver: "Headhunters", missionType: "Mercenary" },
            { poolUuid: "32463294-45d5-4e92-a773-dce1f28a2a2b", key: "b", title: "Cargo Run: Bloom",
              poolName: "Ship Mining · Shubin Interstellar", variants: 36,
              missionTitles: ["XL Purchase Order: Ship Mined Ore", "Purchase Order: Ship Mined Ore"],
              missing: ["Arbor MH1 Mining Laser", "Helix I Mining Laser", "Pitman Mining Laser"],
              owned: 8, total: 11, places: ["Orbituary"],
              payMin: 96000, payMax: 96000, payoutEstimated: true, durMin: 40.24, rep: 250,
              cooldownMin: null, giver: "Shubin Interstellar", missionType: "Ship Mining" },
            { poolUuid: "7c495074-f31a-4f52-bde2-c912b183ac81", key: "c",
              title: "Salvager Needed (Med. Supply of RMC)",
              poolName: "Salvage · Adagio Holdings", variants: 1,
              missionTitles: ["Salvager Needed (Med. Supply of RMC)"],
              missing: ["Cinch Scraper Module", "Trawler Scraper Module"],
              owned: 3, total: 5, places: ["Checkmate"],
              payMin: 108250, payMax: 108250, payoutEstimated: true, durMin: 30, rep: 100,
              cooldownMin: 30, giver: "Adagio Holdings", missionType: "Salvage" },
            { poolUuid: "253e9697-5605-4732-b4fa-56af7a3dc140", key: "d", title: "Deep space hit",
              poolName: "Ship Mining · Shubin Interstellar", variants: 19,
              missionTitles: ["XL Purchase Order: Ship Mined Ore", "Deep space hit"],
              missing: ["Lawson Mining Laser", "Surveyor-Go"],
              owned: 6, total: 8, places: [],
              payMin: null, payMax: null, payoutEstimated: false, durMin: null, rep: null,
              cooldownMin: null, giver: "Shubin Interstellar", missionType: "Ship Mining" },
          ],
        };
        const el = $("pool");
        if (el) { el.innerHTML = recentActivityHtml(current); el.classList.add("idle"); latestShown = latestMisShown = bpShown = -1; observeLatest(); }
        // The suite drives the fit directly: how many rows fit is the behaviour under test, and
        // waiting on a ResizeObserver to maybe fire is how a size test becomes flaky.
        window.__fitLatest = fitLatest;
        window.__latestCount = () => latestShown;
      }
      if (q.has("phys")) { $("panel").classList.remove("empty"); document.body.classList.remove("empty"); const el = $("pool"); if (el) el.innerHTML = rewardsHtml({ itemRewards: [{ name: 'CF-227 Badger "Hazard-Zone" Repeater', amount: 2, owned: false }, { name: "Drake Golem Alliance", amount: 1, owned: false }, { name: "People's Alliance Hat", amount: 1, owned: true }] }); } // headless-test Physical Rewards
      if (q.has("hub")) { $("globalCog").classList.add("show", "open"); $("hub").classList.add("open"); } // headless-test the hub
    })();

    // (drag + resize for this panel are wired by the generic per-widget loop, which finds
    //  #moveBanner / #resizeHandle through the same .wmove / .wresize hooks.)
  }

  // Per-widget reset in the hub: the same action as the ↺ on the widget's own bar, but reachable
  // when that bar has gone off-screen with the widget — which is the only reason it's here.
  // Wired outside the shell gate below because it's pure page state (nothing to ask main.cjs for).
  if (CANVAS) {
    document.querySelectorAll("#hub .hub-reset").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); e.preventDefault();
        const w = WBY[btn.dataset.w]; if (!w) return;
        resetWidget(w);
        btn.classList.add("done"); // brief flash — a hidden widget gives no other feedback
        setTimeout(() => btn.classList.remove("done"), 900);
      });
    });
  }

  // ── Global overlay-app hub (canvas shell only) ────────────────────────────
  // The screen-anchored cog opens an in-overlay menu governing the whole overlay app:
  // widget on/off (Blueprint / Mining / Binding), global appearance, and arrange. It lives
  // outside #panel so it persists when the Blueprint widget is hidden.
  if (CANVAS && window.overlayApi) {
    const gc = $("globalCog"), hub = $("hub");
    let hubLeaveT;
    // Summon the global cog when a widget cog is clicked (this window directly; the Mining
    // window over IPC). It fades out again when unused.
    window.overlayApi.onSummonCog?.(summonGlobalCog);
    // While the hub is OPEN keep the window interactive (it's a corner menu off the panel, so
    // moving off it must not make it click-through and un-closeable — an outside click closes it).
    // Hovering the cog/hub also keeps the summoned cog from fading.
    const hubEnter = () => { clearTimeout(hubLeaveT); cogHovered = true; clearTimeout(cogHideT); armGameHide(); window.overlayApi.hover(true); };
    const hubLeave = () => { cogHovered = false; rescheduleCogHide(); armGameHide(); if (hubOpen) return; hubLeaveT = setTimeout(() => window.overlayApi.hover(false), 150); };
    gc.addEventListener("mouseenter", hubEnter); gc.addEventListener("mouseleave", hubLeave);
    hub.addEventListener("mouseenter", hubEnter); hub.addEventListener("mouseleave", hubLeave);
    function setHub(open) {
      hubOpen = open;
      hub.classList.toggle("open", open);
      gc.classList.toggle("open", open);
      syncViewMask(); // the hub can land on top of the native view too

      if (!open) { syncModal(); window.overlayApi.hover?.(false); rescheduleCogHide(); return; }
      clearTimeout(cogHideT); // keep the cog shown while the hub is open
      // Read the RAW config for appearance (theme may be "auto" — PREFS carries the resolved
      // value, so read config directly to show the real setting).
      fetch("/api/config").then((r) => r.json()).then((c) => {
        $("hubTheme").value = c.theme || "mobiglas";
      }).catch(() => { /* fall back to whatever's in the inputs */ });
      $("wgBlueprint").checked = WBY.blueprint.s.visible !== false;
      window.overlayApi.widgetStates?.().then((s) => { if (s) { $("wgMining").checked = !!s.mining; $("wgNotepad").checked = !!s.notepad; $("wgTwitchChat").checked = !!s.twitchChat; $("wgScFeed").checked = !!s.scFeed; $("wgUnlockAlert").checked = !!s.unlockAlert; $("wgParty").checked = !!s.party; $("wgBattaglia").checked = !!s.battaglia; $("wgHauling").checked = !!s.hauling; $("wgLogView").checked = !!s.logView; $("wgChat").checked = !!s.chat; $("wgWebView").checked = !!s.webView; $("wgBindingChart").checked = !!s.bindingChart; } });
      syncModal(); window.overlayApi.hover?.(true);
    }
    gc.addEventListener("click", (e) => { e.stopPropagation(); armGameHide(); setHub(!hub.classList.contains("open")); });
    hub.addEventListener("click", (e) => { e.stopPropagation(); armGameHide(); });
    document.addEventListener("click", () => { if (hub.classList.contains("open")) setHub(false); });

    // ── Time the cog out once you're back IN THE GAME ────────────────────────
    // The 10s fade (rescheduleCogHide) deliberately never fires while the hub is open, so a hub
    // you opened and then forgot about stayed up indefinitely. That isn't only clutter: an open
    // hub holds setModal(true), which bypasses hold-to-interact, so the canvas keeps swallowing
    // clicks the entire time it's forgotten. Nobody is reading the hub while Star Citizen has
    // focus — so 30s of GAME focus closes it. Hovering or clicking it restarts the clock, and the
    // timer only ever runs while the game is actually in front, so it can't close under you.
    // 30s in real use; `?coghide=<ms>` shortens it so the harness doesn't have to wait half a minute.
    const COG_GAME_HIDE_MS = +(new URLSearchParams(location.search).get("coghide")) || 30000;
    let gameHideT = null, gameFocused = false;
    const cogIsUp = () => gc.classList.contains("show") || hub.classList.contains("open");
    function clearGameHide() { clearTimeout(gameHideT); gameHideT = null; }
    function armGameHide() {
      clearGameHide();
      if (!gameFocused || !cogIsUp()) return;
      gameHideT = setTimeout(() => {
        gameHideT = null;
        if (!gameFocused || !cogIsUp()) return;
        if (cogHovered) { armGameHide(); return; } // pointer is on it — you're using it, wait
        if (hubOpen) setHub(false);                // also drops setModal, so clicks pass through
        gc.classList.remove("show", "open");
      }, COG_GAME_HIDE_MS);
    }
    window.overlayApi.onGameFocus?.((on) => { gameFocused = on; armGameHide(); });

    // Switching TO the overlay (Alt-Tab / taskbar) is a deliberate "I want to use this", so the
    // cog comes up and stays up for as long as the window holds focus. Losing focus doesn't yank
    // it away — it just re-arms the normal 10s fade, so it behaves exactly as before once you're
    // back in the game.
    // 🔑 `armGameHide()` is re-armed on blur too: the game-focus timer bails early when the cog
    // isn't up, so without this a cog pinned by window focus would never get its game-focus timer
    // started and would sit there once you tabbed back into Star Citizen.
    window.overlayApi.onWindowFocus?.((on) => {
      winFocused = on;
      if (on) { clearGameHide(); summonGlobalCog(); }
      else { rescheduleCogHide(); armGameHide(); }
    });

    // Only pay for the foreground helper while the cog is up — same opt-in contract the OCR loop
    // and hold-to-interact use, so with the cog down this costs nothing. Watching the CLASS
    // catches every path that summons or hides it (widget cog, panel pointerdown, arrange mode,
    // the Mining window over IPC) without each call site having to remember this exists.
    let cogWanted = null;
    const syncCogWant = () => {
      const up = cogIsUp();
      if (up === cogWanted) return;
      cogWanted = up;
      if (!up) clearGameHide();
      Promise.resolve(window.overlayApi.wantForeground?.(up)).then((now) => {
        // null = the helper hasn't answered yet; leave gameFocused alone rather than guessing.
        if (typeof now === "boolean") gameFocused = now;
        armGameHide();
      }).catch(() => { /* no shell (browser preview) — the timer just never arms */ });
    };
    const cogWatch = new MutationObserver(syncCogWant);
    cogWatch.observe(gc, { attributes: true, attributeFilter: ["class"] });
    cogWatch.observe(hub, { attributes: true, attributeFilter: ["class"] });
    syncCogWant();
    // Widget on/off. Blueprint hides in-page; Mining is a separate window (via the shell). The
    // Binding chart is hotkey-only (nobody keeps it visible), so it's not a hub toggle.
    $("wgBlueprint").addEventListener("change", () => setBlueprintVisible($("wgBlueprint").checked));
    $("wgMining").addEventListener("change", () => window.overlayApi.setMining($("wgMining").checked));
    $("wgNotepad").addEventListener("change", () => window.overlayApi.setNotepad($("wgNotepad").checked));
    $("wgTwitchChat").addEventListener("change", () => window.overlayApi.setTwitchChat($("wgTwitchChat").checked));
    $("wgScFeed").addEventListener("change", () => window.overlayApi.setScFeed($("wgScFeed").checked));
    $("wgUnlockAlert").addEventListener("change", () => window.overlayApi.setUnlockAlert($("wgUnlockAlert").checked));
    $("wgParty").addEventListener("change", () => window.overlayApi.setParty($("wgParty").checked));
    $("wgBattaglia").addEventListener("change", () => window.overlayApi.setBattaglia($("wgBattaglia").checked));
    $("wgHauling").addEventListener("change", () => window.overlayApi.setHauling($("wgHauling").checked));
    $("wgLogView").addEventListener("change", () => window.overlayApi.setLogView($("wgLogView").checked));
    $("wgChat").addEventListener("change", () => window.overlayApi.setChat($("wgChat").checked));
    $("wgWebView").addEventListener("change", () => window.overlayApi.setWebView($("wgWebView").checked));
    $("wgBindingChart").addEventListener("change", () => window.overlayApi.setBindingChart($("wgBindingChart").checked));
    // Stay in sync if a widget is toggled elsewhere (tray) while the hub is open.
    window.overlayApi.onWidgetStates?.((s) => { if (s) { $("wgMining").checked = !!s.mining; $("wgNotepad").checked = !!s.notepad; $("wgTwitchChat").checked = !!s.twitchChat; $("wgScFeed").checked = !!s.scFeed; $("wgUnlockAlert").checked = !!s.unlockAlert; $("wgParty").checked = !!s.party; $("wgBattaglia").checked = !!s.battaglia; $("wgHauling").checked = !!s.hauling; $("wgLogView").checked = !!s.logView; $("wgChat").checked = !!s.chat; $("wgWebView").checked = !!s.webView; $("wgBindingChart").checked = !!s.bindingChart; } });
    // Global appearance — persisted config (also broadcasts to OBS sources).
    $("hubTheme").addEventListener("change", () => setPref({ theme: $("hubTheme").value }));
    // Layout
    $("hubArrange").addEventListener("click", (e) => { e.stopPropagation(); window.overlayApi.arrange(true); setHub(false); });
    $("hubSettings").addEventListener("click", (e) => { e.stopPropagation(); window.overlayApi.openSettings(); setHub(false); });
    // Re-open the "What's new" patch-notes card (force = ignore the per-version seen flag).
    $("hubWhatsNew").addEventListener("click", (e) => { e.stopPropagation(); setHub(false); window.__showWhatsNew?.(true); });
  }

  // Electron overlay: report hover so the shell makes the HUD clickable only while
  // the pointer is over it (clicks pass to the game everywhere else). No-op in OBS.
  // ── "What's new" card: the markup builder ───────────────────────────────────────────────────
  // Page scope, OUTSIDE the overlayApi guard below, because building markup from JSON needs no
  // shell — only showWhatsNew does (it reads the app version through the preload). Keeping it in
  // there made it unreachable to anything without an Electron shell, the widget suite included,
  // which is why that suite used to carry its own copy of this markup and could pass against a
  // shape nobody rendered.
  const WN_MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const wnP2 = (n) => String(n).padStart(2, "0");
  const wnFmtUTC = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return WN_MON[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear() + " · " + wnP2(d.getUTCHours()) + ":" + wnP2(d.getUTCMinutes()) + " UTC";
  };
  // Group order is fixed and deliberate: what you gained, then what got better, then what stopped
  // being broken. Fixes last because they are the least interesting thing in a release to everyone
  // except the person who hit the bug.
  const WN_KINDS = [["new", "New"], ["improved", "Improved"], ["fixed", "Fixed"]];
  // 🔑 EACH NOTE COLLAPSES TO ITS LABEL (Sub, 2026-08-14): "a person can just look and see a list,
  // and then if they want more information they can get the paragraph." A feature release runs to
  // a dozen notes and the card became a wall of prose you had to read to find out whether anything
  // mattered to you — the labels ARE the release summary, so they should be readable as one.
  // 🔑 Same <details> grammar the version headers already use (caret, no marker, rotate on open),
  // so the card has ONE disclosure idiom rather than two that look different.
  // ⚠️ A note with NO label is never wrapped — legacy notes (0.1.33 and older) carry everything in
  // the description, so collapsing one would hide the entire note behind an empty summary.
  const wnNoteHtml = (n) => {
    const text = typeof n === "string" ? n : (n && n.text) || "";
    const label = n && n.label ? n.label : "";
    if (!label) {
      return '<li><div class="wn-note nolabel"><div class="wn-desc">' + escapeHtml(text) + "</div></div></li>";
    }
    // 🔑 `collapsible` drops the row's ◆ — the caret replaces it rather than sitting beside it.
    // Two markers on one line read as noise, and of the two only the caret says "there is more
    // here". A note with no label keeps its ◆, since it has no caret to stand in.
    return '<li class="collapsible"><details class="wn-note"><summary class="wn-label">' + escapeHtml(label) + "</summary>" +
           '<div class="wn-desc">' + escapeHtml(text) + "</div></details></li>";
  };
  // A version renders as New / Improved / Fixed sections. Notes with NO kind — everything written
  // before 0.1.34, which the sidecar normalises to text-only — fall through to a single unheaded
  // list at the top, so an old version keeps the shape it shipped with rather than being filed
  // under a guess. An empty section is omitted entirely, never left as a bare heading: 0.1.36 is
  // a single fix and would otherwise show two empty ones.
  const wnBodyHtml = (notes) => {
    const unkinded = notes.filter((n) => !n || !n.kind);
    let html = unkinded.length ? "<ul>" + unkinded.map(wnNoteHtml).join("") + "</ul>" : "";
    for (const [kind, heading] of WN_KINDS) {
      const group = notes.filter((n) => n && n.kind === kind);
      if (group.length) html += '<div class="wn-kind">' + heading + "</div><ul>" + group.map(wnNoteHtml).join("") + "</ul>";
    }
    return html;
  };
  // Newest version is expanded; older ones (2..5) are collapsed <details> — click to expand.
  const wnListHtml = (entries) => entries.map((e, i) => {
    const body = wnBodyHtml(Array.isArray(e.notes) ? e.notes : []);
    const dt = wnFmtUTC(e.date);
    const head = "v" + escapeHtml(e.version) + (dt ? ' <span class="wn-date">' + dt + "</span>" : "");
    return i === 0
      ? '<div class="wn-group"><div class="wn-gver">' + head + "</div>" + body + "</div>"
      : '<details class="wn-group"><summary class="wn-gver">' + head + "</summary>" + body + "</details>";
  }).join("");
  window.__wnListHtml = wnListHtml; // the widget suite renders through this, never its own copy

  if (window.overlayApi) {
    const panel = $("panel");
    panel.classList.add("electron"); // reveals the grab handle (OBS mode has no window to move)
    let leaveT;
    panel.addEventListener("mouseenter", () => { clearTimeout(leaveT); window.overlayApi.hover(true); });
    panel.addEventListener("mouseleave", () => { leaveT = setTimeout(() => window.overlayApi.hover(false), 150); });
    // Any interaction with the widget (clicking the cog, the mission picker, a row, the grip…)
    // summons the global cog — it should be reachable whenever the user is engaging the overlay.
    panel.addEventListener("pointerdown", () => summonGlobalCog());
    // Arrange mode (grip / hub / tray / Ctrl+Alt+M): show this widget's drag banner AND the
    // full-screen arrange indicator (so it's clear the whole screen is in edit mode).
    window.overlayApi.onMoveMode?.((on) => {
      if (on) summonGlobalCog(); // arranging is an interaction too
      panel.classList.toggle("moving", on);
      document.body.classList.toggle("arranging", on);
      // Every shown widget joins arrange mode. SC Feed is invisible unless it has news, so it
      // also gets a sample card held up — otherwise there'd be nothing to aim its drop zone at.
      for (const w of WIDGETS) syncArrange(w);
    });
    // Close the Blueprint panel from the panel itself (setBlueprintVisible persists it, and the
    // hub checkbox reads that flag when it opens, so the two stay in step).
    // Hovering the panel pulls its bar out too; `.touched` keeps it out while its cog menu is open.
    // The tracker keeps its own copy of the touch latch (it is local to this document rather than
    // a registry iframe), so its fade has to be re-pushed from here as well — same reason as
    // touchWidget: the alphas are on the panel, not in a stylesheet that can see the class.
    const localW = () => WIDGETS.find((w) => w.local);
    const refadeLocal = () => { const w = localW(); if (w) applyFade(w); };
    $("panel").addEventListener("pointerdown", () => { $("panel").classList.add("touched"); refadeLocal(); });
    $("panel").addEventListener("mouseenter", refadeLocal);
    $("panel").addEventListener("mouseleave", refadeLocal);
    document.addEventListener("pointerdown", (e) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.closest("#panel")) { $("panel").classList.remove("touched"); refadeLocal(); }
    });
    $("moveDone").addEventListener("click", () => window.overlayApi.endMove());
    // The full-screen banner's Done exits arrange for ALL widgets. It's off the panel, so it
    // reports hover (like the global cog) to make itself clickable.
    const ab = document.querySelector("#arrangeScrim .ab");
    let abLeaveT;
    ab.addEventListener("mouseenter", () => { clearTimeout(abLeaveT); window.overlayApi.hover(true); });
    ab.addEventListener("mouseleave", () => { abLeaveT = setTimeout(() => window.overlayApi.hover(false), 150); });
    $("arrangeDone").addEventListener("click", () => window.overlayApi.endMove());

    // ── canvas calibration (nudge + scale) ──────────────────────────────────────────────────
    // Moves and sizes the whole canvas. Widget coordinates are untouched, so nobody's saved layout
    // shifts, and the canvas keeps spanning every monitor — dragging a widget to another screen
    // still works, which is the first thing a multi-monitor user does. Every change round-trips
    // through the shell, which re-fits the window and pushes overlay:canvas-changed back, so the
    // dotted outline the user is aiming at redraws from the same numbers that were just saved.
    {
      let cal = { x: 0, y: 0, scale: 1 };
      const show = () => {
        const v = $("nudgeVal"); if (v) v.textContent = cal.x + ", " + cal.y;
        const s = $("nudgeScale"); if (s) s.textContent = Math.round(cal.scale * 100) + "%";
      };
      const push = async () => {
        try { cal = (await window.overlayApi?.canvasCalibration?.(cal)) || cal; } catch { /* no shell */ }
        show();
      };
      // Read the stored value so the display is honest the moment arrange mode opens.
      (async () => { try { cal = (await window.overlayApi?.canvasCalibration?.()) || cal; } catch { /* none */ } show(); })();
      $("canvasNudge")?.addEventListener("click", (e) => {
        const b = e.target instanceof Element ? e.target.closest("button") : null; if (!b) return;
        e.stopPropagation();
        if (b.id === "nudgeReset") { cal = { x: 0, y: 0, scale: 1 }; void push(); return; }
        const nz = Number(b.dataset.nz || 0);
        if (nz) {
          // Shift = 1%, for the last bit of sizing once the dashed edge is nearly right.
          const stepPct = e.shiftKey ? 1 : 5;
          const pct = Math.round(cal.scale * 100) + Math.sign(nz) * stepPct;
          cal = { ...cal, scale: Math.max(0.5, Math.min(3, pct / 100)) };
          void push();
          return;
        }
        // Shift = 1px, for the last bit of alignment once the dashed edge is nearly right.
        const step = e.shiftKey ? 1 : 10;
        const nx = Number(b.dataset.nx || 0), ny = Number(b.dataset.ny || 0);
        if (!nx && !ny) return;
        cal = { ...cal, x: cal.x + Math.sign(nx) * step, y: cal.y + Math.sign(ny) * step };
        void push();
      });
    }

    // Report interactive element rects to the shell (~10×/s) so pollCursor() can hit-test the
    // cursor against them — REPLACES forward:true mouse-forwarding (which stuttered the whole
    // cursor when elevated). Inactive elements are display:none → 0-size → filtered out.
    if (window.overlayApi.reportRegions) {
      // `.widget` covers every registry widget at once (a hidden one is display:none → 0-size →
      // filtered out below). Mining's iframe is sized snugly to its panel by the embedded page,
      // so its rect ≈ the visible widget. NOTIFIERS are deliberately excluded from the blanket
      // rule and matched only while a card is up (.live) or being arranged — an idle SC Feed must
      // never eat a click meant for the game.
      // The slid-out title bar sits ABOVE its widget, outside the rect getBoundingClientRect()
      // reports for .widget — so it needs reporting in its own right, but ONLY while it's out.
      // A parked bar must not leave a permanently-clickable strip hanging over the game.
      // The slid-out bar hangs BELOW its widget, outside the rect getBoundingClientRect() reports
      // for .widget — so it needs reporting in its own right, but ONLY while it's out. A parked
      // bar must not leave a permanently-clickable strip over the game. (#panel's own bar is
      // covered the same way; #panel itself is already listed.)
      // `body.scanbox #scanBox` only: the scan-read-area box is draggable, and a drag can't start
      // unless the shell makes the window interactive over it. Listed ONLY while it's shown —
      // it's a calibration mode you switch on, and a box that size must not sit in the cursor
      // hit-test the rest of the time.
      // #mreport is deliberately ABSENT: it lives inside #panel and covers it exactly, so the
      // panel's own rect already makes it clickable. Listing it would report the same rectangle
      // twice for no gain.
      // 🔑 `#setupNudge.show`, not `#setupNudge` — a hidden banner must never claim a region, or
    // it would swallow game clicks along a blank strip above the taskbar for the whole session.
      // 🔑 `body.payoutscan #payoutPanel`, for the same reason as the scan box above: it is a
      // MODE's chrome, and a panel this size must not sit in the cursor hit-test — swallowing
      // game clicks over a 460x620 rectangle — for the rest of the session once it is gone.
      // It also has to be here at all: anything outside a widget's own rect is unclickable
      // unless the page reports it, so an unlisted panel would render perfectly and refuse
      // every click, including its own Stop button.
      // 🔑 `body.boardbox #boardBox` — the contract board's calibration box, same contract as the
      // scan box: listed only while its mode has it on screen, because it is a large rectangle
      // over the middle of the game and an unlisted one would render but refuse every drag.
    const RSEL = "body.scanbox #scanBox, body.boardbox #boardBox, body.payoutscan #payoutPanel, #panel, #globalCog, #hub, #cogMenu, #whatsnew, #setupNudge.show, #svcDown.show, #ocrWarn.show, #arrangeScrim .ab, #arrangeScrim .nudge, .widget:not(.notifier), .widget.notifier.live, .widget.notifier.moving, .widget.notifier.cfgopen, .widget:hover .whead, .widget.touched .whead, .widget.grouped .whead, #panel:hover .whead, #panel.touched .whead, #panel.grouped .whead";
      // Only cross the process boundary when the answer actually changed. The rects are stable for
      // minutes at a time (they move on drag/resize/show/hide/hover), so this was ten identical
      // IPC messages a second, forever.
      let lastRegions = "";
      const reportRegions = () => {
        const rects = [];
        document.querySelectorAll(RSEL).forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 1 && r.height > 1) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
        });
        const sig = JSON.stringify(rects);
        if (sig === lastRegions) return;
        lastRegions = sig;
        window.overlayApi.reportRegions(rects);
      };
      setInterval(reportRegions, 100);
      reportRegions();
    }

    // "What's new" card. Auto-shows once per new version on launch AND is re-openable any time
    // from the hub's "Patch notes" button (force=true ignores the per-version seen flag).
    // Hover-interactive + flagged as a modal so it stays clickable to close even when locked.
    let wnVersion = null;
    const wnClose = async () => {
      if (wnVersion && $("wnDontShow").checked) {
        try { await fetch("/api/changelog-seen?v=" + encodeURIComponent(wnVersion), { method: "POST" }); } catch { /* best-effort */ }
      }
      $("whatsnew").classList.remove("show");
      syncModal();
      window.overlayApi.hover(false);
    };
    async function showWhatsNew(force) {
      try {
        const version = await window.overlayApi.getVersion?.();
        if (!version) return;
        wnVersion = version;
        const data = await (await fetch("/api/changelog?v=" + encodeURIComponent(version))).json();
        const entries = (Array.isArray(data.entries) ? data.entries : []).filter((e) => Array.isArray(e.notes) && e.notes.length);
        if (!entries.length) return;
        if (!force && data.seen) return; // auto-show respects the seen flag; the hub button forces it
        const card = $("whatsnew");
        // Center on the PRIMARY monitor. The launch auto-show can win the race against the async
        // canvas-info fetch, leaving --prim-* at their full-canvas defaults (100%/0) so the card
        // straddles both monitors. Ensure canvas-info is loaded + the vars applied before showing.
        if (!canvasInfo) { try { canvasInfo = await window.overlayApi?.getCanvasInfo?.() || null; } catch { /* single-monitor */ } }
        applyCanvasVars();
        // Header chip = newest version; body groups the last few versions so a returning user
        // sees everything they missed across our fast patches, not just the latest.
        $("wnVer").textContent = "v" + (entries[0].version || version);
        $("wnList").innerHTML = wnListHtml(entries);
        card.classList.add("show");
        syncModal();
      } catch { /* changelog is best-effort */ }
    }
    // Close + hover wiring (attached once; the hub button re-opens the same card).
    $("wnX").addEventListener("click", wnClose);
    $("wnCloseBtn").addEventListener("click", wnClose);
    { let wnLeaveT; const card = $("whatsnew");
      card.addEventListener("mouseenter", () => { clearTimeout(wnLeaveT); window.overlayApi.hover(true); });
      card.addEventListener("mouseleave", () => { wnLeaveT = setTimeout(() => window.overlayApi.hover(false), 150); }); }
    window.__showWhatsNew = showWhatsNew; // reachable from the hub button (different block scope)
    showWhatsNew(false); // auto-show on launch

    // ── setup nudge ──────────────────────────────────────────────────────────────────────
    // The shell decides WHETHER this shows (only an existing user with unfinished setup who
    // hasn't dismissed it before); this only renders it. It is not a modal — setModal() is never
    // called, so the overlay stays click-through everywhere except the banner's own rect.
    // 🔑 Inside the `if (window.overlayApi)` guard on purpose: there is no shell in an OBS
    // browser source, so the nudge can neither arrive nor open a wizard there, and reaching
    // for `overlayApi.hover` outside the guard would throw on a page that renders fine today.
    const nudge = $("setupNudge");
    // Dismissal is persisted server-side, not here: it must survive a restart, and the shell
    // reads it back from /api/setup on the next launch to decide whether to send this at all.
    const closeNudge = () => {
      nudge.classList.remove("show");
      window.overlayApi.hover(false);
      fetch("/api/setup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissNudge: true }),
      }).catch(() => { /* best-effort — worst case it offers once more next launch */ });
    };
    $("snX").addEventListener("click", closeNudge);
    $("snGo").addEventListener("click", () => { window.overlayApi.openSetupWizard?.(); closeNudge(); });
    nudge.addEventListener("mouseenter", () => window.overlayApi.hover(true));
    nudge.addEventListener("mouseleave", () => window.overlayApi.hover(false));
    // ── screen reading blocked ────────────────────────────────────────────────────────────
    // Shown ONLY when a screen-reading feature is switched on AND the engine failed a self-test
    // (it is handed an image we ship, so "no text" cannot be an innocent explanation). Silence
    // for everybody else — a warning aimed at people who deliberately have OCR off is pure nag,
    // and every OCR opt-in is off by default.
    {
      const box = $("ocrWarn");
      const DISMISSED = "sco.ocrWarnDismissed";
      box.addEventListener("mouseenter", () => window.overlayApi.hover(true));
      box.addEventListener("mouseleave", () => window.overlayApi.hover(false));
      // Dismissing is FOREVER, not per-launch: someone may know exactly why their OCR is off and
      // not care, and re-nagging them every start would earn the app a place in the ignore pile.
      // The state stays in /api/diagnostics either way, so support never loses it.
      $("owX").addEventListener("click", () => {
        try { localStorage.setItem(DISMISSED, "1"); } catch { /* private mode — warn again, fine */ }
        box.classList.remove("show");
        window.overlayApi.hover(false);
      });
      const checkOcr = () => {
        try { if (localStorage.getItem(DISMISSED) === "1") return; } catch { /* carry on */ }
        fetch("/api/ocr/health").then((r) => r.json()).then((d) => {
          // `enabled` is what separates "OCR is off" from "OCR is broken". Warning on the first
          // would be telling people about a feature they switched off on purpose.
          if (!d || !d.enabled || !d.health || d.health.ok !== false) { box.classList.remove("show"); return; }
          $("owBody").textContent = d.health.reason || "Screen reading isn't working on this PC.";
          box.classList.add("show");
        }).catch(() => { /* the sidecar has its own banner for being down */ });
      };
      checkOcr();
      // Re-checked so somebody who allow-lists the app mid-session sees it clear itself. The
      // sidecar caches the verdict for 60s, so this costs a cheap request, not an OCR run.
      setInterval(checkOcr, 300000);
    }

    // ── background service down ───────────────────────────────────────────────────────────
    // Pure display: the shell decides the state and pushes every transition, including a re-push
    // once this page loads, so the banner cannot be stranded on after recovery or missed because
    // the page was not up when the sidecar died.
    {
      const svc = $("svcDown");
      const retry = $("sdRetry");
      retry.addEventListener("click", () => {
        retry.disabled = true;
        retry.textContent = "Starting…";
        window.overlayApi.retrySidecar?.();
      });
      svc.addEventListener("mouseenter", () => window.overlayApi.hover(true));
      svc.addEventListener("mouseleave", () => window.overlayApi.hover(false));
      window.overlayApi.onSidecarState?.((st) => {
        if (!st || !st.down) {
          svc.classList.remove("show");
          window.overlayApi.hover(false);
          retry.disabled = false;
          retry.textContent = "Try again";
          return;
        }
        // Two very different situations, and saying "stopped" during an automatic retry would be
        // a lie that invites a pointless click.
        $("sdBody").textContent = st.retrying
          ? "SC Overlay isn't tracking anything right now. Reconnecting…"
          : "SC Overlay isn't tracking missions, blueprints or mining until this restarts.";
        retry.style.display = st.retrying ? "none" : "";
        if (!st.retrying) { retry.disabled = false; retry.textContent = "Try again"; }
        svc.classList.add("show");
      });
    }

    window.overlayApi.onSetupNudge?.((s) => {
      const n = Number(s && s.steps) || 0;
      $("snBody").textContent = n === 1
        ? "One step of setup is still unfinished. It takes about a minute."
        : n + " steps of setup are still unfinished. It takes about a minute.";
      nudge.classList.add("show");
    });
  }

  // Filter bar: click a lit tab to filter the pool to that category; click it again
  // (or its highlighted state) to clear back to All. Greyed tabs are inert.
  $("catbar").addEventListener("click", (e) => {
    const cat = e.target.closest(".cat");
    if (!cat || cat.classList.contains("off")) return;
    const tab = cat.getAttribute("data-tab");
    activeTab = activeTab === tab ? null : tab;
    if (current) render(current);
  });

  // ── Settings cog: pool display, Verify, OCR ───────────────────────────────
  function setCog(open) {
    $("cogMenu").classList.toggle("open", open);
    $("cog").classList.toggle("open", open);
    if (open) {
      $("tgCatbar").checked = !PREFS.hideCatbar;
      $("tgOddsAdj").checked = oddsMode === "adjusted";
      $("tgTimeRel").checked = PREFS.timeRelative !== false;
      $("tgMissionOcr").checked = !!PREFS.missionOcr;
      $("tgFabCapture").checked = !!PREFS.fabCapture;
      showAngle(WBY.blueprint); // this slider is one of that widget's angle controls

      updateOcr();
      summonGlobalCog(); // clicking a widget cog reveals the global settings cog
      syncModal();
      window.overlayApi?.hover?.(true);
    } else {
      syncModal();
      rescheduleCogHide(); // menu closed — restart the global cog's 10s countdown
    }
  }
  $("cog").addEventListener("click", (e) => { e.stopPropagation(); setCog(!$("cogMenu").classList.contains("open")); });
  $("cogMenu").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { if ($("cogMenu").classList.contains("open")) setCog(false); });
  // A persisted display pref: apply locally now, save it (broadcasts to OBS too).
  function setPref(patch) {
    Object.assign(PREFS, patch);
    applyPrefs();
    fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })
      .catch(() => { /* best-effort; the local apply already took effect */ });
  }
  $("tgCatbar").addEventListener("change", () => setPref({ hideCatbar: !$("tgCatbar").checked }));
  // Odds mode: base (out of the full pool) vs adjusted (only what you still need). Session-local.
  $("tgOddsAdj").addEventListener("change", () => {
    oddsMode = $("tgOddsAdj").checked ? "adjusted" : "base";
    if (current) render(current);
  });
  // Recent-activity time format (moved here from the settings window). Persisted + re-rendered.
  $("tgTimeRel").addEventListener("change", () => { setPref({ timeRelative: $("tgTimeRel").checked }); if (current) render(current); });
  // Mission-name OCR on/off — read by the capture loop each poll (not a display pref).
  $("tgMissionOcr").addEventListener("change", () => { setPref({ missionOcr: $("tgMissionOcr").checked }); updateOcr(); });
  $("tgFabCapture").addEventListener("change", () => { setPref({ fabCapture: $("tgFabCapture").checked }); updateOcr(); });
  // Per-widget angle: live-apply on drag, persist on release. Goes through setWidgetAngle so a
  // grouped panel tilts its whole stack (and saves to the group) rather than to itself alone.
  $("cogAngle")?.addEventListener("input", () => setWidgetAngle(WBY.blueprint, $("cogAngle").value));
  $("cogAngle")?.addEventListener("change", () => persistLayout(WBY.blueprint));
  $("openSettings").addEventListener("click", (e) => { e.stopPropagation(); window.overlayApi?.openSettings?.(); setCog(false); });

  // OCR activity (fabricator image capture + tracked-mission read). Fed by the Electron
  // shell over IPC; a no-op in OBS browser-source mode (no overlayApi).
  let OCR = { state: "", fabNote: "", fabWarn: false };
  let inFab = false;   // a fabricator kiosk is on screen (OCR context) -> gold diamond
  let isLive = false;  // SubliminalsTV is live on Twitch (from the view) -> purple diamond
  let ocrToastT;
  function showOcrToast(text) {
    const ver = document.querySelector(".foot-col-ver");
    const el = $("footToast");
    if (!ver || !el) return;
    el.textContent = text;
    ver.classList.add("toasting");
    clearTimeout(ocrToastT); ocrToastT = setTimeout(() => ver.classList.remove("toasting"), 4200);
  }
  // One-line OCR status strip on the widget face. Hidden entirely unless OCR is armed
  // (at least one opt-in on) — so OBS/idle overlays stay uncluttered.
  function updateOcr() {
    const bar = $("ocrBar");
    const active = OCR.state === "watching" || OCR.state === "fabricator";
    const armed = OCR.state && OCR.state !== "off";
    const warn = OCR.state === "fabricator" && OCR.fabWarn;
    bar.classList.toggle("show", !!armed);
    bar.classList.toggle("on", active);
    bar.classList.toggle("warn", warn);
    let head;
    if (OCR.state === "fabricator") head = OCR.fabNote ? "Fabricator — " + OCR.fabNote : "Reading the fabricator…";
    else if (OCR.state === "idle") head = "Waiting for Star Citizen…";
    else if (active) head = "Watching Star Citizen…";
    else head = "";
    $("ocrBarText").textContent = head;
  }
  // Diamond glyph colour: gold in the fabricator, purple when SubliminalsTV is live, else cyan.
  // Fabricator wins (it's a momentary crafting cue); the live click/tooltip stay active whenever live.
  function updateDiamond() {
    const d = $("liveDot");
    d.classList.toggle("fab", inFab);
    d.classList.toggle("live", isLive && !inFab);
    d.classList.toggle("clickable", isLive);
    if (!isLive) $("liveTip").classList.remove("show");
  }
  function onOcrEvent(s) {
    if (!s || !s.state) return;
    if (s.state === "mission") {
      if (s.title) showOcrToast("🎯 " + s.title);
    } else if (s.state === "captured") {
      // Report the TRUTH, and keep it on the bar (sticky) instead of snapping back to a generic
      // "Reading…" that looks idle. uploaded = confirmed on the site; queued = saved + retrying.
      const nm = s.name || "item";
      if (s.uploaded) {
        OCR.fabNote = "✓ shared " + nm; OCR.fabWarn = false;
        showOcrToast("📸 " + nm + " · shared to site");
      } else if (s.queued) {
        OCR.fabNote = "⚠ upload failed — retrying " + nm; OCR.fabWarn = true;
        showOcrToast("⚠ " + nm + " · captured, upload failed — retrying");
      } else {
        OCR.fabNote = "captured " + nm + " (turn on Sync to share)"; OCR.fabWarn = false;
        showOcrToast("📸 " + nm + " · saved locally (Sync off)");
      }
    } else if (s.state === "shared") {
      // A previously-failed upload finally landed (the retry loop drained it) — confirm to the user.
      const snm = s.name || "item";
      OCR.fabNote = "✓ shared " + snm; OCR.fabWarn = false;
      showOcrToast("✓ " + snm + " shared to site" + (s.pending ? " (" + s.pending + " still uploading)" : ""));
    } else if (s.state === "settling") {
      // Name what it's reading immediately, so it never just sits on a generic "Reading…".
      OCR.fabNote = "reading " + (s.name || "item") + "…"; OCR.fabWarn = false;
    } else if (s.state === "have") {
      // Recognized the item, but its image is already on the site — nothing to capture. Name it
      // (the strip truncates with an ellipsis when the name is long).
      OCR.fabNote = "already have " + (s.name || "this item"); OCR.fabWarn = false;
    } else if (s.state === "render") {
      if (s.stuck) {
        // The render never brightened after several tries — this item can't be captured (quantum
        // drives + some ship components show a dark schematic in the kiosk, not a lit 3D model).
        // Say so plainly instead of sitting on "waiting…" forever.
        OCR.fabNote = "can't capture " + (s.name || "this item") + " — no 3D render";
        OCR.fabWarn = true;
        showOcrToast("⚠ " + (s.name || "Item") + " — no render to capture (quantum drives & some ship parts can't be pictured yet)");
      } else {
        // Recognized the item, waiting for its 3D render to finish loading before capturing.
        OCR.fabNote = "waiting for item render…"; OCR.fabWarn = false;
      }
    } else if (s.state === "unresolved") {
      // In the fabricator with image capture on, but OCR couldn't identify the item on
      // screen — so no picture was taken. Flag it (gold) and let the user know why.
      OCR.fabNote = "couldn't read this item"; OCR.fabWarn = true;
      showOcrToast("⚠ Fabricator — couldn't read this item");
    } else if (s.state === "auth") {
      // Upload auth failed (invalid/expired token). Keep captures queued locally, but
      // tell the user exactly what to do instead of a generic retry warning.
      OCR.fabNote = "sync token invalid — relink in Settings"; OCR.fabWarn = true;
      showOcrToast("⚠ Sync token invalid — relink your blueprint tracker in Settings");
    } else {
      OCR.state = s.state;                 // context: off / idle / watching / fabricator
      inFab = s.state === "fabricator";
      if (s.state !== "fabricator") { OCR.fabNote = ""; OCR.fabWarn = false; }  // left the kiosk
      updateDiamond();
    }
    updateOcr();
  }
  window.overlayApi?.onOcr?.(onOcrEvent);
  // Live-on-Twitch diamond: hover invite + click through to the stream.
  $("liveDot").addEventListener("mouseenter", () => { if (isLive) $("liveTip").classList.add("show"); });
  $("liveDot").addEventListener("mouseleave", () => $("liveTip").classList.remove("show"));
  $("liveDot").addEventListener("click", (e) => {
    if (!isLive) return;
    e.stopPropagation();
    const url = "https://twitch.tv/subliminalstv";
    if (window.overlayApi?.openUrl) window.overlayApi.openUrl(url);
    else window.open(url, "_blank");
  });
