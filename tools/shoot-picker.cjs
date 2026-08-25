/**
 * Drive the ROUTE tab's place picker on a real commodity leg, end to end.
 *
 *   node_modules/electron/dist/electron.exe tools/shoot-picker.cjs [port]
 *
 * Not a test — the look, plus the one thing a screenshot cannot show: that picking a place really
 * MOVES the run rather than relabelling the stop. It seeds a pick, opens the picker, reads what it
 * offers, takes a different terminal, and then re-reads the plan to see whether the leg moved.
 *
 * 🔴 It drives the widget the way a player does — click the name, click an option — rather than
 * assigning page state. `executeJavaScript` runs in the page's GLOBAL scope, so a `window.`-
 * qualified assignment creates a second binding the page never reads.
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const PORT = process.argv[2] || "8782";
const BASE = "http://localhost:" + PORT;
const OUT = path.join(__dirname, "mockups", "shots", "built");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, name) {
  await sleep(400);
  fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG());
  process.stdout.write("  " + name + "\n");
}

const OPEN_PICKUP = `(() => {
  const stops = [].slice.call(document.querySelectorAll("#body .stop"));
  const up = stops.filter(function (s) { return s.className.indexOf("pickup") >= 0; })[0];
  if (!up) return "no pickup stop";
  const nm = up.querySelector(".nm.editable");
  if (!nm) return "pickup stop is not editable";
  nm.click();
  const inp = nm.querySelector("input");
  if (!inp) return "no input appeared";
  /* 🔴 A HIDDEN BrowserWindow NEVER FIRES THE focus EVENT, though focus() does move activeElement.
     The picker arms on focus, so without standing in for Chromium's dispatch the list never opens
     and the page looks broken while being perfectly correct. Only the dispatch is faked — every
     handler past this point is the page's own. */
  inp.focus();
  const landed = document.activeElement === inp;
  inp.dispatchEvent(new Event("focus"));
  return "opened, focus landed=" + landed;
})()`;

const READ_LIST = `(() => {
  const box = document.querySelector("#body .psug");
  if (!box) return JSON.stringify({ open: false });
  const head = box.querySelector(".phead");
  const rows = [].slice.call(box.querySelectorAll("div")).map(function (d) {
    const sp = d.querySelectorAll("span");
    return [].slice.call(sp).map(function (x) { return x.textContent; }).join(" | ");
  });
  return JSON.stringify({ open: true, head: head ? head.textContent : null, rows: rows });
})()`;

/** Take an option OTHER than the one the leg already uses, so the move is observable. */
const PICK_OTHER = (current) => `(() => {
  const box = document.querySelector("#body .psug");
  if (!box) return "no list";
  const rows = [].slice.call(box.querySelectorAll("div"));
  const target = rows.filter(function (d) {
    const s = d.querySelector("span");
    return s && s.textContent !== ${JSON.stringify(current)};
  })[0];
  if (!target) return "no other option";
  const label = target.querySelector("span").textContent;
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  return label;
})()`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Clear any pick left by an earlier run, then seed exactly one: a real Neon run.
  const plan0 = await (await fetch(BASE + "/api/hauling/plan")).json();
  for (const b of (plan0.buys || [])) {
    await fetch(BASE + "/api/hauling/buy/forget?id=" + encodeURIComponent(b.id), { method: "POST" });
  }
  const seeded = await (await fetch(BASE + "/api/hauling/buy", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commodity: "Neon",
      from: { terminal: "Last Landings", body: "Terminus", system: "Pyro" },
      to: { terminal: "Patch City", body: "Bloom", system: "Pyro" },
      buyPrice: 14206, sellPrice: 19000,
    }),
  })).json();
  console.log("  seeded: " + JSON.stringify(seeded.buy ? seeded.buy.from : seeded));

  const win = new BrowserWindow({ width: 440, height: 620, useContentSize: true, show: false });
  const run = (js) => win.webContents.executeJavaScript(js);

  await win.webContents.loadURL(BASE + "/hauling.html?embedded");
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => 1)");
  await sleep(1200);
  await run(`document.getElementById("tabRoute").click()`);
  await sleep(1600);
  await shot(win, "picker-route-440.png");

  console.log("  " + await run(OPEN_PICKUP));
  await sleep(900);
  const listed = await run(READ_LIST);
  console.log("  list: " + listed);
  await shot(win, "picker-open-440.png");

  let bad = 0;
  const parsed = JSON.parse(listed);
  if (!parsed.open || !parsed.rows.length) {
    console.error("  !! the picker did not open, or offered nothing");
    bad++;
  } else {
    /* 🔴 EVERY OFFERED PLACE MUST REALLY SELL IT. Checked against the sidecar's own lookup rather
       than against a list this script wrote — the whole point is that the picker's candidates come
       from the price table, and comparing it to something written here would prove nothing. */
    const look = await (await fetch(BASE + "/api/trade/commodity?name=Neon")).json();
    const legal = (look.buyAt || []).map((e) => e.terminalShort);
    const offered = parsed.rows.map((r) => r.split(" | ")[0]);
    const illegal = offered.filter((n) => legal.indexOf(n) < 0);
    console.log("  offered " + offered.length + " of " + legal.length + " legal buy terminals");
    if (illegal.length) { console.error("  !! offered places that do not sell Neon: " + illegal.join(", ")); bad++; }
    if (!offered.length) { console.error("  !! offered nothing at all"); bad++; }

    const took = await run(PICK_OTHER("Last Landings"));
    console.log("  picked: " + took);
    await sleep(2000);
    await shot(win, "picker-moved-440.png");
    /* 🔴 THE CLAIM A SCREENSHOT CANNOT MAKE. Re-read the plan: did the RUN move, or was the stop
       merely RELABELLED? Relabelling is exactly what this control used to do on a commodity leg —
       `config.haulingPlaces[locationId]` is a display name and nothing else — so the picker looked
       like it changed where you go and did not. A screenshot of the moved label is identical in
       both worlds, which is why this script re-reads the plan instead of trusting the pixels. */
    const plan1 = await (await fetch(BASE + "/api/hauling/plan")).json();
    const b = (plan1.buys || [])[0];
    const from = b ? b.from : null;
    console.log("  after: from=" + (from ? from.terminal : "(no buy)")
      + " body=" + (from ? from.body : "?") + " system=" + (from ? from.system : "?"));
    if (!from || from.terminal !== took) {
      console.error("  !! the RUN did not move - the stop was only relabelled");
      bad++;
    } else {
      console.log("  -> THE RUN MOVED");
    }
    /* The body is what the tiered travel model prices a leg off. Without it every re-pointed leg is
       charged the flat cross-body rate and every ordering involving one ties — invisible on screen,
       and the reason this check exists at all: the first cut shipped `body: null`. */
    if (from && !from.body) { console.error("  !! it moved WITHOUT a body, so the travel model cannot price it"); bad++; }
  }

  win.destroy();
  console.log(bad ? "\nPROBLEMS: " + bad : "\nthe picker offers only valid places, and picking one moves the run");
  process.exitCode = bad ? 1 : 0;
  app.quit();
});
