// Bridges the overlay page to the shell:
//  - hover(on): become click-through only while the pointer is over the HUD.
//  - onMoveMode(cb): main tells the page to enter/exit "move" mode (drag banner).
//  - beginMove(): the page's grab handle asks main to enter move mode.
//  - endMove(): the page's Done button asks main to leave move mode.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayApi", {
  hover: (on) => ipcRenderer.send("overlay:hover", !!on),
  beginMove: () => ipcRenderer.send("overlay:begin-move"),
  endMove: () => ipcRenderer.send("overlay:end-move"),
  onMoveMode: (cb) => ipcRenderer.on("overlay:move-mode", (_e, on) => cb(!!on)),
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
});
