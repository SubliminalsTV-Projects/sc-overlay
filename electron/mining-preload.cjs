// Preload for the Mining Assistant window. Mirrors the main HUD's shell bridge (preload.cjs)
// so the window behaves identically: click-through until hovered, hover-suspended move mode,
// and a cog "modal" that stays clickable. Plus the mining-only extras: hide/show, a native
// alert-tone WAV picker, and opening the full settings window.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("miningApi", {
  // Shell interaction model (same as the HUD).
  hover: (on) => ipcRenderer.send("mining:hover", !!on),
  beginMove: () => ipcRenderer.send("mining:begin-move"),
  endMove: () => ipcRenderer.send("mining:end-move"),
  // Force this window interactive for the duration of a drag/resize gesture so it can't drop.
  dragLock: (on) => ipcRenderer.send("mining:drag-lock", !!on),
  onMoveMode: (cb) => ipcRenderer.on("mining:move-mode", (_e, on) => cb(!!on)),
  // Keep the window clickable (even under an eventual lock) while the cog menu is open.
  setModal: (on) => ipcRenderer.send("mining:modal", !!on),
  // Mining-window extras.
  hide: () => ipcRenderer.send("mining:hide"),
  show: () => ipcRenderer.send("mining:show"),
  pickTone: () => ipcRenderer.invoke("mining:pick-tone"), // -> true if a WAV was chosen
  clearTone: () => ipcRenderer.invoke("mining:clear-tone"),
  openSettings: () => ipcRenderer.send("overlay:open-settings"),
  // Clicking this window's cog summons the shell's global cog (lives in the HUD window).
  summonCog: () => ipcRenderer.send("mining:summon-cog"),
  // Per-widget canvas layout (shared global IPC with the HUD). This widget saves under its
  // own id ("mining"), so it never collides with the Blueprint widget's layout.
  getWidgets: () => ipcRenderer.invoke("overlay:get-widgets"),
  saveWidget: (id, layout) => ipcRenderer.send("overlay:save-widget", id, layout),
});
