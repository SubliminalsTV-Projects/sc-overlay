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
});
