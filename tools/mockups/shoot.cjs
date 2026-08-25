/**
 * Screenshot every mockup state, at real widget size, in the app's own Chromium.
 *
 *   node_modules/electron/dist/electron.exe tools/mockups/shoot.cjs
 *
 * Writes PNGs into tools/mockups/shots/. Uses `useContentSize` so the window's CONTENT is exactly
 * the widget's size on the canvas — a screenshot at some other width is a screenshot of a
 * different design.
 *
 * ⚠️ It waits on `document.fonts.ready` rather than a fixed sleep. Inter is loaded by @font-face
 * and a shot taken before it arrives is a shot of the system fallback, which measures differently
 * and would make every judgement about whether something fits wrong.
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const DIR = __dirname;
const OUT = path.join(DIR, "shots");

const OPTIONS = [
  ["a", "option-a-filter.html"],
  ["b", "option-b-funnel.html"],
  ["c", "option-c-dossier.html"],
];
const STATES = ["rest", "search", "route"];
/** mobiGlas is the default skin (no data-theme) and the one Sub is on; drake is the furthest from
 *  it in the token space, so the pair is the cheapest real test that nothing is hard-coded. */
const SKINS = [["mobiglas", ""], ["drake", "drake"]];
const SIZES = [440, 320];

async function shoot(win, file, state, theme, w, name) {
  const url = "file:///" + path.join(DIR, file).replace(/\\/g, "/")
    + "?embedded&state=" + state + (theme ? "&theme=" + theme : "");
  /* 🔴 ONE RETRY, AND IT IS NOT DEFENSIVE PADDING. Reusing a window across a resize makes the very
     next loadURL reject with ERR_FAILED (-2) — the previous navigation's stop-loading listener
     fires against the new one. A silent skip here would leave a whole width sweep missing from the
     shots directory while the run still printed "done". */
  for (let attempt = 0; ; attempt++) {
    try { await win.webContents.loadURL(url); break; }
    catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => 1)");
  await new Promise((r) => setTimeout(r, 250));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  process.stdout.write("  " + name + "\n");
}

/* 🔴 ONE WINDOW FOR THE WHOLE RUN, RESIZED BETWEEN SWEEPS. Destroying the window at the end of a
   sweep leaves zero windows open, and Electron's DEFAULT `window-all-closed` handler quits the app
   — so the 320px sweep silently never ran and the script printed nothing at all, neither the shots
   nor its own "done" line. A run that ends early and quietly is worse than one that throws. */
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: SIZES[0], height: 620, useContentSize: true, show: false,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  for (const w of SIZES) {
    win.setContentSize(w, 620);
    await new Promise((r) => setTimeout(r, 120));
    for (const [ok, file] of OPTIONS) {
      for (const [sk, theme] of SKINS) {
        if (w !== 440 && sk !== "mobiglas") continue;   // the narrow sweep is about layout, not colour
        for (const state of STATES) {
          await shoot(win, file, state, theme,  w,
            `${ok}-${state}-${sk}-${w}.png`);
        }
      }
    }
  }
  win.destroy();
  console.log("done ->", OUT, "-", fs.readdirSync(OUT).length, "shots");
  app.quit();
});
