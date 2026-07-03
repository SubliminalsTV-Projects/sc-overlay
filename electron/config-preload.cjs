// Preload for the config window: exposes a native file picker so config.html can let
// the user choose their binding-chart PNG (renderers can't open OS dialogs directly,
// and Electron 43 removed File.path). Returns the absolute path, or null if cancelled.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayConfig", {
  pickPng: () => ipcRenderer.invoke("pick-png"),
  // Master overlay switch (crash workaround) — controlled live via the shell, not the
  // sidecar config, so toggling destroys/creates the HUD window immediately.
  getOverlayEnabled: () => ipcRenderer.invoke("overlay:get-enabled"),
  setOverlayEnabled: (on) => ipcRenderer.invoke("overlay:set-enabled", on),
  onOverlayEnabledChanged: (cb) =>
    ipcRenderer.on("overlay:enabled-changed", (_e, on) => cb(on)),
});
