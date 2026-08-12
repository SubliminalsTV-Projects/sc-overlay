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
  // Same deal for "is the game in front" — only the shell can know, so a test drives it directly.
  // wantForeground resolves null (helper hasn't answered), which is what a real cold start does.
  onGameFocus: (cb) => { window.__fireGameFocus = cb; },
  wantForeground: (on) => { window.__foregroundWanted = !!on; return Promise.resolve(null); },
};
window.overlayApi = new Proxy(real, {
  get(t, k) { return k in t ? t[k] : () => {}; },
  has() { return true; },
});
