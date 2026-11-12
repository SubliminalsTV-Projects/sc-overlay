// Electron half of tools/render-cargo-grids.ts — run that, not this. Takes the spec it wrote and
// an output dir, serves overlay/ on loopback (the theme sheet and fonts use absolute /paths) and
// captures each view offscreen at 3440x1440 with a transparent background.
//
// Its own --user-data-dir on purpose: an electron started from this repo otherwise shares the dev
// app's %APPDATA%\Electron profile, and per-host zoom set there has leaked into Sub's app before.
"use strict";
const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const [specPath, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith(".cjs"));
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const OVERLAY = path.join(__dirname, "..", "overlay");
const W = 3440, H = 1440;

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "cargo-grids-electron-")));
app.disableHardwareAcceleration();

const PAGE = `<!doctype html><html data-theme="${spec.theme || ""}"><head><meta charset="utf-8">
<link rel="stylesheet" href="/widget-theme.css">
<style>
  html, body { margin: 0; background: transparent !important; }
  body { width: ${W}px; height: ${H}px; display: flex; align-items: center; justify-content: center;
    font-family: var(--sans); color: var(--cyan-text); }
  .panel { box-sizing: border-box; width: ${W - 160}px; max-height: ${H - 120}px; padding: 44px 56px 36px;
    background: var(--panel-solid); border: 2px solid rgba(var(--accent-rgb), 0.35); border-radius: 18px;
    box-shadow: 0 0 60px rgba(0,0,0,0.55); display: flex; flex-direction: column; gap: 26px; }
  .head { display: flex; align-items: baseline; gap: 28px; }
  .head h1 { margin: 0; font-family: "Space Grotesk", var(--sans); font-size: 64px; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--cyan-bright); }
  .head .sub { font-size: 34px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--gold); font-weight: 700; }
  .head .ver { margin-left: auto; font-size: 24px; color: var(--faint); font-family: var(--mono); }
  .row { display: flex; justify-content: space-evenly; align-items: flex-end; gap: 40px; }
  .card { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .isowrap { background: rgba(0, 0, 0, 0.26); border: 1px solid var(--divider); border-radius: 10px; padding: 10px; }
  .name { font-size: 38px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--cyan); }
  .scu { font-size: 54px; font-weight: 800; color: var(--gold); font-family: var(--mono); }
  .stat { font-size: 26px; color: var(--cyan-dim); font-family: var(--mono); text-align: center; line-height: 1.45; }
  .stat b { color: var(--cyan-text); font-weight: 700; }
  .foot { display: flex; gap: 34px; align-items: center; font-size: 24px; color: var(--faint); }
  .legend { display: flex; gap: 30px; font-size: 28px; color: var(--cyan-text); font-family: var(--mono); }
  .legend i { display: inline-block; width: 26px; height: 26px; border-radius: 5px; vertical-align: -4px; margin-right: 10px; }
  .foot .brand { margin-left: auto; letter-spacing: 0.08em; text-transform: uppercase; }
  /* Copied from overlay/hauling.html so the drawing is the widget's. */
  svg.iso { display: block; overflow: visible; margin: 0 auto; }
  svg.iso .iso-floor { fill: rgba(var(--accent-rgb), 0.07); stroke: rgba(var(--accent-rgb), 0.3); stroke-width: 0.04; }
  svg.iso .iso-wall { fill: rgba(var(--accent-rgb), 0.045); stroke: rgba(var(--accent-rgb), 0.22); stroke-width: 0.04; }
  svg.iso .iso-wall-b { fill: rgba(var(--accent-rgb), 0.02); }
  svg.iso .iso-rule { stroke: rgba(var(--accent-rgb), 0.16); stroke-width: 0.025; }
  svg.iso .iso-face { stroke: rgba(0, 0, 0, 0.55); stroke-width: 0.03; stroke-linejoin: round; }
  svg.iso .iso-num { fill: #04121a; font-family: var(--mono); font-weight: 700; text-anchor: middle; dominant-baseline: central; }
  /* The widget's DOOR marks grid y=0, an app convention. Which end of these holds the player
     actually walks in from is not stated anywhere we read, so the picture does not claim one. */
  svg.iso .iso-door { display: none; }
</style></head><body><div class="panel" id="p"></div>
<script src="/hauling-stow.js"></script>
<script>
const SPEC = ${JSON.stringify(spec)};
const KX = Math.cos(Math.PI / 6), KY = 0.5, PAD = 0.6;
const PALETTE = { 32: "hsl(38 78% 58%)", 24: "hsl(280 50% 66%)", 16: "hsl(172 58% 48%)",
  8: "hsl(210 65% 62%)", 4: "hsl(330 55% 64%)", 2: "hsl(8 72% 63%)", 1: "hsl(0 0% 70%)" };
const FACES = [0.56, 0.78, 1];   // left, right, top — the order iso() appends them
const label = (g) => SPEC.labels[g.name] || StowView.gridLabel(g.name, SPEC.className);
const m = (cells) => String(Number((cells * 1.25).toFixed(2)));
const vb = (g) => ({ w: (g.w + g.l) * KX + 2 * PAD, h: (g.w + g.l) * KY + g.h + 2 * PAD });

function draw(view, only) {
  const grids = SPEC.grids.filter((g) => !only || g.name === only);
  const p = document.getElementById("p");
  // A close-up hugs its one grid rather than leaving most of a full-width panel empty.
  p.style.width = only ? "auto" : "";
  p.style.minWidth = only ? "1500px" : "";
  const full = view !== "grids";
  const title = only ? label(grids[0]) : (full ? "Full load" : "Cargo grids");
  const total = grids.reduce((s, g) => s + g.w * g.l * g.h, 0);
  p.innerHTML = '<div class="head"><h1>' + SPEC.displayName + '</h1><span class="sub">' + title + " · "
    + total + ' SCU</span><span class="ver">Alpha ' + SPEC.version.replace(/-LIVE\\..*/, " LIVE") + "</span></div>";
  const row = document.createElement("div"); row.className = "row"; p.appendChild(row);
  // One scale for every grid on the page, so a small hold LOOKS small.
  const availW = ${W - 160} - 112 - 40 * (grids.length - 1) - 40 * grids.length;
  const availH = only ? 760 : 700;
  const scale = Math.min(availW / grids.reduce((s, g) => s + vb(g).w, 0),
    ...grids.map((g) => availH / vb(g).h), only ? 120 : 90);
  for (const g of grids) {
    const boxes = full ? SPEC.placements.filter((q) => q.grid === g.name).map((q) =>
      ({ ...q, missionId: String(q.scu), group: String(q.scu) })) : [];
    const svg = StowView.iso({ w: g.w, l: g.l, h: g.h }, boxes, {});
    svg.setAttribute("width", Math.round(vb(g).w * scale));
    svg.setAttribute("height", Math.round(vb(g).h * scale));
    for (const box of svg.querySelectorAll(".iso-box")) {
      const base = PALETTE[box.dataset.mission] || PALETTE[1];
      box.querySelectorAll(".iso-face").forEach((f, i) =>
        f.setAttribute("fill", "color-mix(in srgb, " + base + " " + Math.round(FACES[i % 3] * 100) + "%, #04121a)"));
    }
    const card = document.createElement("div"); card.className = "card";
    const wrap = document.createElement("div"); wrap.className = "isowrap"; wrap.appendChild(svg);
    const counts = {};
    for (const b of boxes) counts[b.scu] = (counts[b.scu] || 0) + 1;
    const mb = g.maxBox ? g.maxBox.x * g.maxBox.y * g.maxBox.z : null;
    const lines = [
      "<b>" + g.w + " × " + g.l + " × " + g.h + "</b> cells · " + m(g.w) + " × " + m(g.l) + " × " + m(g.h) + " m",
      mb ? "largest box <b>" + mb + " SCU</b>" : "",
      full ? Object.keys(counts).sort((a, b) => b - a).map((s) => counts[s] + " × " + s).join(" + ") : "",
    ].filter(Boolean);
    card.innerHTML = only ? "" : '<div class="name">' + label(g) + '</div>';   // the heading already names it
    card.appendChild(wrap);
    card.insertAdjacentHTML("beforeend", '<div class="scu">' + g.w * g.l * g.h + ' SCU</div><div class="stat">' + lines.join("<br>") + "</div>");
    row.appendChild(card);
  }
  const foot = document.createElement("div"); foot.className = "foot";
  if (full) {
    const sizes = [...new Set(SPEC.placements.filter((q) => grids.some((g) => g.name === q.grid)).map((q) => q.scu))].sort((a, b) => b - a);
    foot.innerHTML = '<div class="legend">' + sizes.map((s) => '<span><i style="background:' + PALETTE[s] + '"></i>' + s + " SCU</span>").join("") + "</div>";
  } else {
    foot.innerHTML = "<span>1 cell = 1.25 m = 1 SCU · drawn to one scale</span>";
  }
  foot.insertAdjacentHTML("beforeend", '<span class="brand">From the game files · SC Overlay</span>');
  p.appendChild(foot);
}
window.__draw = draw;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url === "/__render.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PAGE); }
  const file = path.join(OVERLAY, path.normalize(url).replace(/^([/\\])+/, ""));
  if (!file.startsWith(OVERLAY) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".ttf": "font/ttf" }[path.extname(file)] || "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(file).pipe(res);
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const win = new BrowserWindow({
    show: false, width: W, height: H, useContentSize: true, frame: false, transparent: true,
    backgroundColor: "#00000000", webPreferences: { offscreen: true },
  });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/__render.html`);
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  const views = [["grids", null, "grids"], ["full", null, "full-load"],
    ...spec.grids.map((g) => ["full", g.name, g.name.replace(/^hardpoint_/, "")])];
  let wrote = 0;
  for (const [view, only, suffix] of views) {
    await win.webContents.executeJavaScript(`__draw(${JSON.stringify(view)}, ${JSON.stringify(only)}); true`);
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
    const out = path.join(outDir, `${spec.className}-${suffix}.png`);
    fs.writeFileSync(out, img.toPNG());
    console.log("wrote", out, img.getSize().width + "x" + img.getSize().height);
    wrote++;
  }
  console.log(`${wrote} of ${views.length} images`);
  server.close();
  app.exit(wrote === views.length ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(1); });
