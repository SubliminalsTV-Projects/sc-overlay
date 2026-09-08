// Stub shell API for widget-dom-test.cjs, so the page's load path sees a SAVED layout exactly
// the way it would after a restart. Permissive proxy: any member the page reaches for that we
// haven't defined is a harmless no-op, so listener wiring never throws.
//
// The saved data is deliberately PARTLY CORRUPT — a group referencing a widget that no longer
// exists, and a degenerate one-member group — because the loader is supposed to repair those
// rather than trust the file.
const SAVED = {
  // Left CLOSED on purpose: the tracker is the app's main surface and must re-open on launch
  // regardless (Sub, 2026-07-29). Suite 3 asserts the loader overrides this.
  blueprint: { x: 100, y: 100, w: 380, h: 560, visible: false },
  mining: { x: 300, y: 200, scale: null, angle: null },
  party: { x: 900, y: 600, w: 340, h: 400 },
  notepad: { x: 500, y: 100, w: 320, h: 380 },
  __groups: { list: [
    { id: "gsaved", x: 250, y: 150, w: 500, h: 420, members: ["mining", "party"], active: "party" },
    { id: "gghost", x: 10, y: 10, w: 300, h: 300, members: ["mining", "doesNotExist"], active: "doesNotExist" },
    { id: "glone", x: 20, y: 20, w: 300, h: 300, members: ["notepad"], active: "notepad" },
  ] },
};

const real = {
  getWidgets: async () => JSON.parse(JSON.stringify(SAVED)),
  saveWidget: () => {},
  getCanvasInfo: async () => ({ px: 0, py: 0, pw: 1920, ph: 1080, vw: 1920, vh: 1080 }),
  // Held so a test can fire it: this signal only ever comes from the shell's cursor poll, which
  // is the whole point of it — the page has no way to notice the cursor leaving on its own.
  onCursorAway: (cb) => { window.__fireCursorAway = cb; },
  // The hub awaits this on open. The catch-all Proxy below returns `() => {}` for anything not
  // named here, and `undefined.then` throws — so every member the page CHAINS off has to be real,
  // not just callable.
  widgetStates: async () => ({
    mining: true, notepad: true, twitchChat: false, scFeed: false,
    party: true, battaglia: false, webView: false, bindingChart: false,
  }),
  // The rects the page says are clickable. Captured rather than dropped, because "is this chrome
  // in the region list" is otherwise UNTESTABLE from inside the page: the RSEL string is
  // block-scoped inside `if (window.overlayApi)`, so a suite reaching for it gets `undefined`. A
  // suite that guards with `typeof RSEL === "string" ? … : "RSEL unreachable"` then passes on the
  // truthy fallback string and asserts nothing at all — verified by re-injecting the regression
  // and watching it stay green. Assert against these rects instead; they are what the shell
  // actually receives, and anything outside one is unclickable no matter how it renders.
  reportRegions: (rects) => { window.__regions = rects; },
  // The canvas-wide typing grab. Pages arm it through host().editStart() and the shell is the
  // only thing that can see it, so record it — a suite asserts the grab is actually RELEASED
  // when a typing widget hides, which is invisible to every DOM measurement.
  notepadEditing: (on) => { window.__editing = !!on; },
  // Same deal for "is the game in front" — only the shell can know, so a test drives it directly.
  // wantForeground resolves null (helper hasn't answered), which is what a real cold start does.
  onGameFocus: (cb) => { window.__fireGameFocus = cb; },
  wantForeground: (on) => { window.__foregroundWanted = !!on; return Promise.resolve(null); },
  // The per-widget hotkey row. Only the SHELL knows which widgets can carry one (WIDGET_TOGGLES)
  // and what is registered right now (including the historical defaults that live in no config
  // file), so the canvas asks — and without this the row correctly never appears at all, which
  // would make every assertion about it vacuous.
  // 🔑 Two keys are deliberately ABSENT from the map below — see the note on it.
  cfg: {
    getWidgetHotkeys: async () => Object.assign({}, window.__widgetAccels),
    setWidgetHotkey: async (key, accel) => {
      window.__hotkeySets.push([key, accel]);
      if (window.__hotkeyRefuse) return { ok: false, error: "in_use" };
      window.__widgetAccels[key] = accel;
      return { ok: true };
    },
  },
};
// Seeded here rather than in the suite so the page's own startup read sees them.
// 🔑 `webView` is ABSENT as well, and unlike blueprint that is a stand-in rather than a fact:
// it is a NORMAL widget (it has a popover), so it is the only way to test "the shell offers no
// hotkey for this one" against a surface that could actually have shown a row. The tracker cannot
// do that job - it has no popover at all, so the assertion would pass whatever the rule did.
window.__widgetAccels = {
  mining: "Shift+F3", notepad: "Alt+F3", bindingChart: "Ctrl+F3",
  twitchChat: "", scFeed: "", unlockAlert: "", party: "", battaglia: "", hauling: "",
  logView: "", verseFinder: "", chat: "", config: "",
};
window.__hotkeySets = [];
window.__hotkeyRefuse = false;
window.overlayApi = new Proxy(real, {
  get(t, k) { return k in t ? t[k] : () => {}; },
  has() { return true; },
});
