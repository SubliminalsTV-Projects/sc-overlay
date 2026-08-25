/**
 * Drive the REAL Commodities tab through the funnel and screenshot each step.
 *
 *   node_modules/electron/dist/electron.exe tools/shoot-funnel.cjs [port]
 *
 * Not a test — a look. It drives the widget the way a player does (click the slot, type, click an
 * option) rather than assigning page state, because `executeJavaScript` runs in the page's GLOBAL
 * scope and a `window.`-qualified assignment creates a second binding the page never reads. The
 * suite has been burned by exactly that.
 *
 * 🔴 ONE WINDOW FOR THE WHOLE RUN, resized between sweeps. Destroying it leaves zero windows open
 * and Electron's default `window-all-closed` handler quits the app mid-run, printing nothing.
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const PORT = process.argv[2] || "8782";
const OUT = path.join(__dirname, "mockups", "shots", "built");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, name) {
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  process.stdout.write("  " + name + "\n");
}

/** Click a slot open, type, and take the first option — the player's own sequence. */
const DRIVE_WHAT = `(() => {
  const slots = [].slice.call(document.querySelectorAll(".slot"));
  const row = slots.find((s) => s.dataset.slot === "what");
  if (!row) return "no what slot";
  const v = row.querySelector(".v");
  if (!v) return "already open";
  v.click();
  return "opened";
})()`;

const TYPE_NEON = `(() => {
  const inp = document.querySelector(".slot.open input");
  if (!inp) return "no input";
  inp.value = "Neon";
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  return "typed";
})()`;

const PICK_FIRST = `(() => {
  const o = document.querySelector(".slotlist .o:not(.none)");
  if (!o) return "no options";
  const label = o.querySelector(".nm") ? o.querySelector(".nm").textContent : "?";
  o.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  return "picked " + label;
})()`;

const OPEN_BUY = `(() => {
  const row = [].slice.call(document.querySelectorAll(".slot")).find((s) => s.dataset.slot === "buy");
  if (!row) return "no buy slot";
  const v = row.querySelector(".v");
  if (!v) return "already open";
  v.click();
  return "opened";
})()`;

const PICK_TERMINAL = `(() => {
  const opts = [].slice.call(document.querySelectorAll(".slotlist .o:not(.none)"));
  const o = opts.find((x) => x.querySelector(".pr"));   // a terminal, not a system
  if (!o) return "no terminal options";
  const label = o.querySelector(".nm").firstChild.textContent;
  o.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  return "picked " + label;
})()`;

const REPORT = `(() => {
  const slots = [].slice.call(document.querySelectorAll(".slot")).map((s) =>
    s.dataset.slot + "=" + (s.querySelector("input") ? "(open)" : (s.querySelector(".v") || {}).textContent));
  const sec = document.querySelector("#body .sec");
  const to = document.querySelector(".tradeoff");
  return JSON.stringify({
    slots,
    heading: sec ? sec.textContent : "(none)",
    rows: document.querySelectorAll(".tdrow").length,
    tradeoff: to ? to.textContent : null,
  });
})()`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 440, height: 620, useContentSize: true, show: false });
  const run = (js) => win.webContents.executeJavaScript(js);

  for (const w of [440, 320]) {
    win.setContentSize(w, 620);
    await sleep(150);
    await win.webContents.loadURL("http://localhost:" + PORT + "/hauling.html?embedded");
    await win.webContents.executeJavaScript("document.fonts.ready.then(() => 1)");
    await sleep(900);
    await run(`document.getElementById("tabTrade").click()`);
    await sleep(1800);
    await shot(win, "funnel-rest-" + w + ".png");
    if (w === 440) console.log("  rest: " + await run(REPORT));

    console.log("  what: " + await run(DRIVE_WHAT));
    await sleep(300);
    console.log("  what: " + await run(TYPE_NEON));
    await sleep(300);
    console.log("  what: " + await run(PICK_FIRST));
    await sleep(1600);
    await shot(win, "funnel-what-" + w + ".png");
    if (w === 440) console.log("  what: " + await run(REPORT));

    console.log("  buy: " + await run(OPEN_BUY));
    await sleep(400);
    await shot(win, "funnel-buyopen-" + w + ".png");
    console.log("  buy: " + await run(PICK_TERMINAL));
    await sleep(1800);
    await shot(win, "funnel-dest-" + w + ".png");
    if (w === 440) console.log("  dest: " + await run(REPORT));
  }

  win.destroy();
  console.log("done -> " + OUT + " - " + fs.readdirSync(OUT).length + " shots");
  app.quit();
});
