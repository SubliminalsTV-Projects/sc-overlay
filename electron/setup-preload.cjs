// Preload for the first-run setup wizard. Deliberately its own tiny surface rather than
// reusing config-preload: the wizard needs four things, and handing a first-run page the
// whole settings API (hotkey registration, layout reset, restart-as-admin) would expose
// controls it has no business calling.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlaySetup", {
  // Native open-FILE dialog for game.log — a renderer can't open OS dialogs, and Electron 43
  // removed File.path, so the wizard's "Locate game.log…" has no other route. Shared handler
  // with the settings window; returns an absolute path, or null when cancelled.
  pickLog: (current) => ipcRenderer.invoke("pick-log", current),
  // The "review your settings" step deep-links into the REAL settings window rather than
  // reproducing its controls — one copy of that UI, so the two can't drift apart.
  openSettings: () => ipcRenderer.send("setup:open-settings"),
  // https only, enforced again in main.cjs — the wizard sends fixed URLs, but a renderer is
  // never the right place to trust a shell-level "open anything" capability.
  openExternal: (url) => ipcRenderer.send("setup:open-external", String(url)),
  close: () => ipcRenderer.send("setup:close"),
});
