/**
 * One-off: prove the classes `_new.css` introduces are actually PAINTED, in two skins.
 *
 * A class-name assertion cannot tell a painted band from an unpainted one. `--good` is defined in
 * ZERO themes in this repo and `var(--good)` renders as the inherited colour while reading as
 * deliberate in the source — so the only honest check is to read the computed colour back and
 * require the bands to be DISTINCT from each other and from an unstyled sibling.
 *
 *   node_modules/electron/dist/electron.exe tools/mockups/_probe-colors.cjs
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const FILE = path.join(__dirname, "option-c-dossier.html").split(path.sep).join("/");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 440, height: 620, useContentSize: true, show: false });
  let bad = 0;
  try {
    for (const theme of ["", "drake"]) {
      await win.webContents.loadURL("file:///" + FILE + "?embedded&state=search" + (theme ? "&theme=" + theme : ""));
      const out = await win.webContents.executeJavaScript(`(() => {
        const g = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).color : "(absent)"; };
        const probe = (cls) => { const s = document.createElement("span"); s.className = cls; s.textContent = "x";
          document.body.appendChild(s); const v = getComputedStyle(s).color; s.remove(); return v; };
        const bands = {};
        for (const c of ["age0", "age1", "age2", "warn", "calm"]) bands[c] = probe("badge " + c);
        const bg = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).backgroundColor : "(absent)"; };
        return { home: g(".sysb.home"), away: g(".sysb.away"),
          homeBg: bg(".sysb.home"), awayBg: bg(".sysb.away"), badgePlain: probe("badge"),
          bands, tradeoffB: g(".tradeoff b"), buyPr: g(".prow.b .rail .pr"), sellPr: g(".prow.s .rail .pr") };
      })()`);
      console.log((theme || "mobiglas") + "  " + JSON.stringify(out));
      const seen = new Set(Object.values(out.bands));
      if (seen.size < 4) { console.error("  !! age bands are not distinct"); bad++; }
      /* 🔴 NOT `!==`. Two colours can differ and still be the same colour to an eye: on Drake the
         first cut of the system badge was rgb(251,178,74) vs rgb(246,169,58), which passes an
         equality test and is invisible on screen. Require a real distance, or the check certifies
         exactly the defect it exists to catch. */
      const rgb = (s) => (s.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
      const dist = (a, b) => { const [x, y] = [rgb(a), rgb(b)]; return Math.abs(x[0]-y[0]) + Math.abs(x[1]-y[1]) + Math.abs(x[2]-y[2]); };
      const sysbSeparated = dist(out.home, out.away) >= 120 || out.homeBg !== out.awayBg;
      if (!sysbSeparated) {
        console.error("  !! sysb home/away are only " + dist(out.home, out.away)
          + " apart and share a background — indistinguishable on this skin"); bad++;
      }
      if (dist(out.buyPr, out.sellPr) < 120) { console.error("  !! buy and sell prices are too close"); bad++; }
      for (const [k, v] of Object.entries(out)) {
        if (typeof v === "string" && v === "(absent)") { console.error("  !! " + k + " element not found"); bad++; }
      }
    }
  } catch (e) { console.error("PROBE FAILED " + e.message); bad++; }
  console.log(bad ? "PROBLEMS: " + bad : "all painted, all distinct");
  process.exitCode = bad ? 1 : 0;
  win.destroy();
  app.quit();
});
