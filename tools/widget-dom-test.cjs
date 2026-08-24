// Widget-canvas DOM tests — `npm run test:widgets` (needs `npm run overlay` on :8778).
//
// WHY ELECTRON AND NOT A HEADLESS SCREENSHOT: missions.html holds an SSE connection and the
// widget pages run repeating timers, so `msedge --headless --screenshot` never completes on them.
// Loading the REAL page in a hidden Electron window is both the runtime it actually ships in and
// the only way to assert on live DOM state. Read-only against the sidecar — it just opens another
// SSE client.
//
// Suite 1 runs with no shell API (fresh install) and exercises grouping.
// Suite 2 injects a stub preload reporting a saved layout, and checks the restore path.
//
// ⚠️ EVERY SUITE BODY IS A TEMPLATE LITERAL, so a backtick anywhere inside one — including in a
// comment, e.g. quoting a variable name the way the rest of this codebase does — ENDS the string and
// the whole file fails to parse. That failure is easy to miss: `npm run test:widgets` exits 0 and
// prints an "App threw an error during load" stack instead of any assertions, so a run that tested
// NOTHING reads as a quiet success. Use plain words inside a suite; `node --check` catches it.
const { app, BrowserWindow } = require("electron");
const path = require("path");

// Piping this run into `head`/`grep -m` closes stdout early, and the next console.log then throws
// EPIPE — which Electron surfaces as a "JavaScript error in the main process" DIALOG, on top of
// whatever the user was doing. Swallow it: a closed pipe means nobody is reading, not a failure.
process.stdout.on("error", (e) => { if (e && e.code !== "EPIPE") throw e; });
process.stderr.on("error", (e) => { if (e && e.code !== "EPIPE") throw e; });

const PORT = process.env.OVERLAY_PORT || 8778;
// `harness=1` marks this page as automation. The suite drives the LIVE sidecar and the LIVE config
// (see SKILL.md), and the completion report now writes real crowdsourced answers — so a stray
// synthetic click on a question would file a rating no human ever gave. The page refuses to POST
// feedback when this flag is present.
const URL = `http://localhost:${PORT}/missions.html?canvas=1&harness=1&party&mining&notepad`;

const PRELUDE = `
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // The Blueprint panel is a LOCAL registry widget: it lives in this document rather than an
  // iframe, so it has no w-/wf- elements and hides via a body class.
  const el = (w) => (w.local ? document.getElementById("panel") : document.getElementById("w-" + w.key));
  const shown = (w) => (w.local
    ? !document.body.classList.contains("bp-hidden")
    : el(w).style.display !== "none");
  const cs = (w, v) => el(w).style.getPropertyValue(v);
  await sleep(900); // let the async layout loader settle
  // A hidden window never composites, so CSS transitions don't advance and a mid-slide transform
  // would be read as "still parked". Assert on settled geometry instead.
  const noAnim = document.createElement("style");
  noAnim.textContent = ".whead,.tape,.bolt,.corner{transition:none !important}";
  document.head.appendChild(noAnim);
`;

// ── Suite 1: grouping behaviour ────────────────────────────────────────────────
const GROUPING = `(async () => {
  ${PRELUDE}
  const saved = [];
  window.overlayApi = Object.assign({}, window.overlayApi, {
    saveWidget: (id, l) => saved.push([id, JSON.parse(JSON.stringify(l))]),
  });

  // 14 = the 12 canvas widgets + the Blueprint panel (a local, non-iframe widget) + Settings.
  // Bump this deliberately when a widget is added — it is the one assertion that notices a
  // registry entry going missing, which would otherwise just look like a widget quietly absent.
  ok("registry has 15 widgets (incl. the Blueprint panel and Settings)", typeof WIDGETS !== "undefined" && WIDGETS.length === 15, typeof WIDGETS !== "undefined" ? WIDGETS.length : "unreachable");
  ok("starts ungrouped", GROUPS.length === 0, GROUPS.length);
  const party = WBY.party, mining = WBY.mining, notepad = WBY.notepad;
  ok("test widgets shown", shown(party) && shown(mining) && shown(notepad));

  groupWidgets(party, mining);
  const g = GROUPS[0];
  ok("one group created", GROUPS.length === 1);
  ok("members are mining+party", g && g.members.join(",") === "mining,party", g && g.members.join(","));
  ok("dropped widget becomes active", g && g.active === "party", g && g.active);
  ok("active member shown", shown(party));
  ok("inactive member hidden", !shown(mining));
  // The whole point of not reparenting: a backgrounded tab keeps its iframe, so chat scrollback,
  // unsaved notes and live SSE all survive being tabbed away from.
  ok("inactive member NOT unloaded", !!document.getElementById("wf-mining").src, "iframe src kept");
  ok("members share x", cs(party,"--wx") === cs(mining,"--wx"), cs(party,"--wx") + " vs " + cs(mining,"--wx"));
  ok("members share width", cs(party,"--ww") === cs(mining,"--ww"), cs(party,"--ww") + " vs " + cs(mining,"--ww"));
  ok("no widget is scale-based any more (all responsive)", !document.querySelector(".widget.scaled"));
  ok("members flagged .grouped", el(party).classList.contains("grouped") && el(mining).classList.contains("grouped"));

  const strip = el(WBY[GROUPS[0] ? GROUPS[0].active : "party"]).querySelector(".wh-tabs");
  ok("tab strip rendered", !!strip);
  const tabs = strip ? [...strip.querySelectorAll(".gtab:not(.gdetach)")].map(b => b.dataset.k) : [];
  ok("a tab per member", tabs.join(",") === "mining,party", tabs.join(","));
  ok("detach button present", !!(strip && strip.querySelector(".gdetach")));
  ok("tabs live in the fronted member's own bar", !!(strip && strip.closest(".whead")));
  ok("grouped bar is pinned OUT (tabs must stay visible)",
     getComputedStyle(el(WBY[g.active]).querySelector(".whead")).transform.replace(/ /g, "") === "matrix(1,0,0,1,0,0)",
     getComputedStyle(el(WBY[g.active]).querySelector(".whead")).transform);
  ok("grouped widget shows tabs instead of its name",
     getComputedStyle(el(WBY[g.active]).querySelector(".wh-id")).display === "none");

  strip.querySelector('.gtab[data-k="mining"]').click();
  await sleep(30);
  ok("clicking a tab swaps the visible member", shown(mining) && !shown(party));

  groupWidgets(notepad, party);
  ok("third member joins existing group", GROUPS.length === 1 && GROUPS[0].members.length === 3, GROUPS[0] && GROUPS[0].members.join(","));
  detachFromGroup(WBY[GROUPS[0].active]);
  ok("group survives with 2 after detach", GROUPS.length === 1 && GROUPS[0].members.length === 2, GROUPS[0] && GROUPS[0].members.join(","));

  detachFromGroup(WBY[GROUPS[0].active]);
  ok("group dissolves below 2 members", GROUPS.length === 0, GROUPS.length);
  ok("no tabs once dissolved", ![...document.querySelectorAll(".wh-tabs")].some(t => t.innerHTML.trim()));
  // Regression: applyFrame() reads groupOf(), so the group must be dropped BEFORE re-applying the
  // survivor, or the last member stays flagged as grouped.
  ok("survivors standalone again", !el(party).classList.contains("grouped") && !el(mining).classList.contains("grouped"));
  ok("mining stays responsive after ungrouping", !el(mining).classList.contains("scaled"));

  groupWidgets(party, mining);
  const gs = saved.filter(s => s[0] === "__groups").pop();
  ok("groups persisted under __groups", !!gs && Array.isArray(gs[1].list), gs ? JSON.stringify(gs[1]).slice(0, 110) : "none");
  // HIDING IS NOT CLOSING. A hotkey / tray / hub toggle routes through setWidgetVisible, and it
  // used to detach — so hiding the Mining Scanner by hotkey orphaned it, and it came back as a
  // lone window sitting behind the stack it used to belong to (Argante, 0.1.35). Only the ✕ means
  // close. These two assertions are the whole contract, so they are written as a pair.
  setWidgetVisible(WBY.party, false);
  ok("hiding a member KEEPS it in the stack", GROUPS.length === 1 && GROUPS[0].members.length === 2,
     GROUPS[0] ? GROUPS[0].members.join(",") : "no group");
  // The active tab still points at the hidden member — deliberately, so the tab the user chose is what
  // returns. That makes the next three assertions load-bearing: a stack that displays a hidden
  // member paints nothing AND draws no tab strip (tabs live in the displayed member's own bar),
  // which would leave the whole group invisible and unclickable with no way back.
  ok("...and the active tab is still remembered", GROUPS[0] && GROUPS[0].active === "party",
     GROUPS[0] && GROUPS[0].active);
  ok("...but the stack still shows a member", shown(mining));
  const hidStrip = el(mining).querySelector(".wh-tabs");
  ok("...with its tab strip", !!(hidStrip && hidStrip.innerHTML.trim()));
  ok("...listing only members you can actually see",
     hidStrip ? hidStrip.querySelectorAll(".gtab:not(.gdetach)").length === 1 : false,
     hidStrip ? hidStrip.querySelectorAll(".gtab:not(.gdetach)").length + " tab(s)" : "no strip");
  setWidgetVisible(WBY.party, true);
  await sleep(30);
  ok("unhiding rejoins the stack, fronted", GROUPS.length === 1 && GROUPS[0].active === "party" && shown(party),
     GROUPS[0] && GROUPS[0].active);
  // The ✕ is the ONE control that means "close", so it is the one that leaves the stack.
  el(party).querySelector(".wh-close").click();
  await sleep(30);
  ok("the ✕ closes OUT of the stack", GROUPS.length === 0, GROUPS.length);

  // Regression: a widget switched on while arrange is ALREADY active used to open undecorated —
  // no drag banner, "not in move mode like every other app" — because arrange only ever swept the
  // widgets that existed when it was entered. Leaving and re-entering arrange was the only cure.
  document.body.classList.add("arranging");
  setWidgetVisible(WBY.notepad, false);
  await sleep(60);
  setWidgetVisible(WBY.notepad, true);
  await sleep(80);
  ok("a widget turned on DURING arrange joins arrange", el(WBY.notepad).classList.contains("moving"));
  // ...and the sweep still agrees with it, so the two paths cannot drift apart.
  for (const w of WIDGETS) syncArrange(w);
  ok("...and the arrange sweep agrees", el(WBY.notepad).classList.contains("moving"));
  document.body.classList.remove("arranging");
  for (const w of WIDGETS) syncArrange(w);
  ok("leaving arrange clears it again", !el(WBY.notepad).classList.contains("moving"));
  setWidgetVisible(WBY.notepad, false);
  return out;
})()`;

// ── Suite 2: BRUTE-FORCE every pair merge ─────────────────────────────────────
// Sub hit a real bug merging Twitch chat with the Mining Assistant: the Mining panel came back
// cut off, and stayed broken even after separating them. Rather than test the pairs he happened
// to try, group and ungroup ALL 28 combinations and assert the widget is whole afterwards.
const PAIRS = `(async () => {
  ${PRELUDE}
  // Show everything so every pair is actually mergeable.
  for (const w of WIDGETS) { setWidgetVisible(w, true); }
  await sleep(500);

  const frameBox = (w) => (w.local ? el(w).getBoundingClientRect() : document.getElementById("wf-" + w.key).getBoundingClientRect());
  // 🔑 The frame being the right size proves NOTHING about whether the widget is usable — Sub's
  // mining+party breakage had a perfectly sized frame with the panel inside it clipped. So look
  // INSIDE the iframe and check the page's own panel actually fits the box it was given.
  const innerFit = (w) => {
    try {
      if (w.local) return null; // its content IS this document; nothing to reach into
      const doc = document.getElementById("wf-" + w.key).contentDocument;
      const panel = doc && (doc.getElementById("panel") || doc.getElementById("card"));
      if (!panel) return null;
      const f = frameBox(w), p = panel.getBoundingClientRect();
      return { overflowX: Math.round(p.width - f.width), overflowY: Math.round(p.height - f.height) };
    } catch { return null; }
  };
  const fits = (w) => { const o = innerFit(w); return !o || (o.overflowX <= 2 && o.overflowY <= 2); };
  // 🔴 WAIT FOR THE FRAME TO REPORT ITSELF EMBEDDED BEFORE MEASURING IT. Identical trap to the
  // one already fixed in the size sweep below, arriving through a different door: grouping and
  // ungrouping re-runs a widget's page, and until it has read ?embedded and set body.embedded
  // its #panel sits at the page's STANDALONE fixed size. Measured in that window, the check
  // reports an overflow that is nothing but the load not having finished.
  // 🔑 THE SIGNATURE, and it is how this was told apart from a real clip: the reported overflow
  // equals standalone minus frame EXACTLY. Hauling is 420x560 standalone, so against logView's
  // 520x420 box it reported -100x140 and against verseFinder's 460x480 it reported -40x80 - the
  // arithmetic to the pixel, three times over, while a direct measurement of the same page at
  // the same three sizes WITH ?embedded showed an overflow of 0. The suite's own later
  // "every widget's content fits its box after all that" assertion passed in the same run,
  // which is the other half of the tell.
  // ⚠️ It falls through after ~1.5s and measures anyway: a widget that NEVER embeds is a real
  // failure and must still be able to fail here.
  const embeddedReady = async (w) => {
    if (w.local) return true;
    for (let i = 0; i < 60; i++) {
      try {
        const d = document.getElementById("wf-" + w.key).contentDocument;
        if (d && d.body && d.body.classList.contains("embedded")) return true;
      } catch { /* cross-document timing */ }
      await sleep(25);
    }
    return false;
  };
  // Snapshot each widget's healthy standalone frame size to compare against after a merge cycle.
  const baseline = {};
  for (const w of WIDGETS) { const r = frameBox(w); baseline[w.key] = [Math.round(r.width), Math.round(r.height)]; }

  const broken = [], groupBad = [], clipped = [];
  for (let i = 0; i < WIDGETS.length; i++) {
    for (let j = i + 1; j < WIDGETS.length; j++) {
      const a = WIDGETS[i], b = WIDGETS[j];
      groupWidgets(a, b);
      const g = GROUPS[0];
      // While grouped: one box, exactly one member on screen, and it must have real size.
      const vis = g ? g.members.filter(k => shown(WBY[k])) : [];
      const fr = frameBox(WBY[g ? g.active : a.key]);
      if (!g || g.members.length !== 2 || vis.length !== 1 || fr.width < 20 || fr.height < 20) {
        groupBad.push(a.key + "+" + b.key + " (members=" + (g ? g.members.length : 0) + " visible=" + vis.length +
                      " frame=" + Math.round(fr.width) + "x" + Math.round(fr.height) + ")");
      }
      // The fronted member's CONTENT must fit the shared box - this is the check that catches a
      // widget rendering clipped inside a perfectly-sized frame.
      const act = WBY[g ? g.active : a.key];
      await embeddedReady(act);
      if (!fits(act)) {
        const o = innerFit(act);
        clipped.push(a.key + "+" + b.key + " grouped -> " + act.key + " overflows by " + o.overflowX + "x" + o.overflowY);
      }
      // Ungroup. A widget INHERITING the stack's box is intended (you sized that stack on
      // purpose), so don't demand the original size back. What must never happen is what Sub hit:
      // a widget landing at a size nobody chose, or shrinking/growing a bit more on every cycle.
      while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
      await sleep(60); // mining re-measures on a timer
      for (const w of [a, b]) { await embeddedReady(w); }
      const cycle1 = {};
      for (const w of [a, b]) { const r = frameBox(w); cycle1[w.key] = [Math.round(r.width), Math.round(r.height)]; }
      for (const w of [a, b]) {
        const got = cycle1[w.key];
        if (got[0] < 100 || got[1] < 60) broken.push(a.key + "+" + b.key + " -> " + w.key + " degenerate " + got.join("x"));
        if (!fits(w)) {
          const o = innerFit(w);
          clipped.push(a.key + "+" + b.key + " ungrouped -> " + w.key + " overflows by " + o.overflowX + "x" + o.overflowY);
        }
      }
      // Same cycle again: the size must SETTLE, not drift further each time.
      groupWidgets(a, b);
      while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
      await sleep(60);
      for (const w of [a, b]) {
        const r = frameBox(w), got = [Math.round(r.width), Math.round(r.height)], was = cycle1[w.key];
        if (Math.abs(got[0] - was[0]) > 4 || Math.abs(got[1] - was[1]) > 4) {
          broken.push(a.key + "+" + b.key + " -> " + w.key + " DRIFTS " + was.join("x") + " then " + got.join("x"));
        }
      }
      // put them back where they started so the next pair starts clean
      for (const w of [a, b]) { resetWidget(w); }
      await sleep(40);
    }
  }
  ok("all 28 pairs group cleanly", groupBad.length === 0, groupBad.slice(0, 4).join(" | "));
  ok("no pair leaves a widget's CONTENT clipped inside its box", clipped.length === 0,
     clipped.length + " clipped: " + clipped.slice(0, 5).join(" | "));
  ok("no pair leaves a widget degenerate or drifting", broken.length === 0,
     broken.length + " broken: " + broken.slice(0, 4).join(" | "));
  await sleep(200);
  ok("every widget's content fits its box after all that", WIDGETS.every(fits),
     WIDGETS.filter(w => !fits(w)).map(w => w.key + " " + JSON.stringify(innerFit(w))).join(" | "));

  // The two pairs Sub called out by name, end to end. What matters is that the CONTENT fits both
  // while stacked and after separating - frame size alone never revealed the bug.
  for (const partner of ["twitchChat", "party"]) {
    groupWidgets(WBY.mining, WBY[partner]);
    await sleep(80);
    const gOk = fits(WBY[GROUPS[0].active]);
    detachFromGroup(WBY.mining);
    await sleep(200);
    ok("mining+" + partner + ": content fits stacked AND after separating",
       gOk && fits(WBY.mining) && fits(WBY[partner]),
       "stacked=" + gOk + " mining=" + JSON.stringify(innerFit(WBY.mining)) + " " + partner + "=" + JSON.stringify(innerFit(WBY[partner])));
    resetWidget(WBY.mining); resetWidget(WBY[partner]);
  }
  return out;
})()`;

// ── Suite 3: title-bar chrome (parked behind the widget, slides out on hover) ──
const CHROME = `(async () => {
  ${PRELUDE}
  const w = WBY.party;
  const box = () => el(w).getBoundingClientRect();
  const hood = el(w).querySelector(".whood");
  const bar = el(w).querySelector(".whead");
  ok("every widget has a title bar", [...document.querySelectorAll(".widget")].every(e => e.querySelector(".whood > .whead")));
  ok("bar carries move/reset/settings/close", bar.querySelectorAll(".wh-right .wh-btn").length === 4,
     bar.querySelectorAll(".wh-right .wh-btn").length);
  // The name lives in the page's own header; the bar only names things when widgets are stacked.
  ok("bar does NOT repeat the widget name", getComputedStyle(bar.querySelector(".wh-id")).display === "none");

  // The hood hangs ABOVE the widget, so the bar can never cover content.
  const hr = hood.getBoundingClientRect();
  ok("hood sits below the widget", Math.abs(hr.top - box().bottom) < 1, "hood.top=" + hr.top.toFixed(1) + " widget.bottom=" + box().bottom.toFixed(1));
  ok("hood clips its contents", getComputedStyle(hood).overflow === "hidden", getComputedStyle(hood).overflow);

  // At rest the bar is pushed fully below the hood => clipped away to nothing.
  el(w).classList.remove("touched");
  const parked = bar.getBoundingClientRect();
  ok("bar is PARKED behind the widget at rest", parked.bottom <= hr.top + 1,
     "bar.bottom=" + parked.bottom.toFixed(1) + " hood.top=" + hr.top.toFixed(1));
  ok("parked bar is not clickable", getComputedStyle(bar).pointerEvents === "none", getComputedStyle(bar).pointerEvents);

  // Slid out: it occupies the strip ABOVE the widget and stops exactly at its top edge.
  el(w).classList.add("touched");
  const outR = bar.getBoundingClientRect();
  ok("bar slides OUT below the widget", outR.top >= box().bottom - 1 && outR.bottom > box().bottom,
     "bar=" + outR.top.toFixed(1) + ".." + outR.bottom.toFixed(1) + " widget.bottom=" + box().bottom.toFixed(1));
  ok("slid-out bar covers NO widget content", outR.top >= box().bottom - 1);
  ok("slid-out bar is clickable", getComputedStyle(bar).pointerEvents === "auto");
  ok("bar spans the widget width", Math.abs(outR.width - box().width) < 2, outR.width.toFixed(1) + " vs " + box().width.toFixed(1));

  // The shell must only be told about the bar while it's out, or a parked bar leaves a
  // permanently clickable strip hanging over the game.
  const RSEL = ".widget:hover .whead, .widget.touched .whead";
  ok("slid-out bar IS reported to the shell", [...document.querySelectorAll(RSEL)].includes(bar));
  el(w).classList.remove("touched");
  ok("parked bar is NOT reported to the shell", ![...document.querySelectorAll(RSEL)].includes(bar));

  // Arrange mode hands the whole widget to the drag shield.
  // Arrange mode KEEPS the bar out: it's the drag handle, and the thing you aim at to stack
  // widgets (drag one bar onto another).
  el(w).classList.add("moving");
  ok("bar stays OUT in arrange mode (it's the drag handle)",
     getComputedStyle(hood).display !== "none" &&
     getComputedStyle(bar).transform.replace(/ /g, "") === "matrix(1,0,0,1,0,0)",
     getComputedStyle(bar).transform);
  ok("bar's buttons go inert while arranging", getComputedStyle(bar.querySelector(".wh-btn")).pointerEvents === "none");
  el(w).classList.remove("moving");

  // ── manufacturer trinkets ──────────────────────────────────────────────────
  // They are the skin's IDENTITY, not chrome: visible at all times, including while the bar is
  // parked, and the bottom one travels with the bar instead of being covered or hidden.
  const mw = WBY.mining;
  const root = document.documentElement, theme0 = root.getAttribute("data-theme");
  ok("flair widget is marked", el(mw).classList.contains("flair"));
  const tTr = el(mw).querySelector(".tape.tr"), tBl = el(mw).querySelector(".tape.bl");
  ok("trinkets sit top-right and bottom-left", !!tTr && !!tBl);
  ok("no trinkets on a non-flair widget", !el(WBY.notepad).querySelector(".tape.tr, .corner.tr"));

  root.setAttribute("data-theme", "mobiglas");
  ok("no trinket on a theme that has none", getComputedStyle(tTr).display === "none", getComputedStyle(tTr).display);
  root.setAttribute("data-theme", "drake");
  ok("Drake shows its tape", getComputedStyle(tTr).display === "block", getComputedStyle(tTr).display);

  // The requirement Sub called out: they must NOT disappear with the bar.
  el(mw).classList.remove("touched");
  ok("trinkets stay visible while the bar is PARKED",
     getComputedStyle(tTr).display === "block" && getComputedStyle(tBl).display === "block");
  const blParked = tBl.getBoundingClientRect().top;
  el(mw).classList.add("touched");
  const blOut = tBl.getBoundingClientRect().top;
  const barH = parseFloat(getComputedStyle(el(mw).querySelector(".whead")).height);
  ok("bottom trinket travels DOWN with the bar", Math.abs((blOut - blParked) - barH) < 2,
     "moved " + (blOut - blParked).toFixed(1) + "px, bar is " + barH.toFixed(1) + "px");
  ok("top trinket stays put", Math.abs(el(mw).querySelector(".tape.tr").getBoundingClientRect().top - tTr.getBoundingClientRect().top) < 0.5);
  el(mw).classList.remove("touched");

  root.setAttribute("data-theme", "argo");
  ok("Argo shows its cog", /cog-argo/.test(getComputedStyle(el(mw).querySelector(".corner.tr")).backgroundImage));
  if (theme0) root.setAttribute("data-theme", theme0); else root.removeAttribute("data-theme");
  const mbar = el(mw).querySelector(".whead");

  // ── per-widget settings cog ────────────────────────────────────────────────
  // It opens THAT widget's own panel, so it only exists where the page exposes one. It must never
  // quietly stand in for global settings (those live on the global cog and the tray).
  for (let i = 0; i < 40 && !el(mw).classList.contains("has-settings"); i++) await sleep(50); // iframe load
  ok("Mining exposes its own settings", typeof document.getElementById("wf-mining").contentWindow.__widgetSettings === "function");
  ok("Mining is detected as having its own settings", el(mw).classList.contains("has-settings"));
  const np = WBY.notepad;
  // EVERY widget has a cog now - it carries text size, which they all have. Only the pass-through
  // to a page's own settings panel depends on that page having one.
  ok("every widget has a cog", WIDGETS.every(x => getComputedStyle(el(x).querySelector(".wh-cog")).display !== "none"));
  ok("a page's OWN settings menu gets the Text size row injected",
     !!document.getElementById("wf-mining").contentWindow.__widgetSettingsRoot().querySelector(".wtext-row"));

  // ── the Blueprint panel carries the same bar ───────────────────────────────
  const bp = document.getElementById("panel");
  const bpbar = bp.querySelector(".whood > .whead");
  ok("Blueprint panel has the bar too", !!bpbar);
  ok("Blueprint bar has all four controls", bpbar && bpbar.querySelectorAll(".wh-right .wh-btn").length === 4,
     bpbar && bpbar.querySelectorAll(".wh-right .wh-btn").length);
  ok("Blueprint's old top-right chrome is gone", !!document.getElementById("grip") && !!document.getElementById("grip").closest(".whead"));
  // NB the panel carries a 3D perspective tilt, so its projected rect and a child's don't share
  // an edge — assert the LAYOUT invariant (the hood is pinned to the panel's bottom) instead.
  const bphood = bp.querySelector(".whood");
  ok("Blueprint bar hangs below the panel", bphood && bp.clientHeight > 0 &&
     Math.abs(bphood.getBoundingClientRect().top - bp.getBoundingClientRect().bottom) < 14,
     bphood && ("hood.top=" + bphood.getBoundingClientRect().top.toFixed(0) +
                " panel.bottom=" + bp.getBoundingClientRect().bottom.toFixed(0)));
  if (theme0) root.setAttribute("data-theme", theme0); else root.removeAttribute("data-theme");

  return out;
})()`;

// ── Suite 5: every control is actually VISIBLE and REACHABLE ──────────────────
// Three separate bugs this session were the same shape: a control that exists, is display:block,
// and does nothing — because an ancestor's overflow:hidden clipped it away (mining's cog menu, the
// settings popover) or it sat outside every region the shell hit-tests (so the click went to the
// game). getBoundingClientRect() is happily non-zero in both cases, so only an explicit check
// finds them. This suite opens each widget's chrome and proves you could actually click it.
const REACH = `(async () => {
  ${PRELUDE}
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(400);

  // Intersect an element's rect with every clipping ancestor's rect. Anything that survives with
  // real area is genuinely on screen; anything that doesn't has been clipped away.
  let lastClipper = "";
  const visibleArea = (node) => {
    let r = node.getBoundingClientRect();
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    lastClipper = "";
    for (let p = node.parentElement; p; p = p.parentElement) {
      const st = getComputedStyle(p);
      // An ancestor only clips if it establishes a clipping box; a scrollable one still shows what
      // is inside its padding box. html/body are the viewport and never count as clippers here.
      if (p === document.body || p === document.documentElement) continue;
      if (st.overflow === "visible" && st.overflowX === "visible" && st.overflowY === "visible") continue;
      const pr = p.getBoundingClientRect();
      const nx0 = Math.max(x0, pr.left), ny0 = Math.max(y0, pr.top);
      const nx1 = Math.min(x1, pr.right), ny1 = Math.min(y1, pr.bottom);
      if ((nx1 - nx0) * (ny1 - ny0) < (x1 - x0) * (y1 - y0)) {
        lastClipper = p.tagName + "." + String(p.className).split(" ")[0];
      }
      x0 = nx0; y0 = ny0; x1 = nx1; y1 = ny1;
    }
    return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  };
  // The shell only routes clicks to rects this page reports; anything outside them hits the game.
  const RSEL = "#panel, #globalCog, #hub, #cogMenu, #whatsnew, #arrangeScrim .ab, .widget:not(.notifier), .widget.notifier.live, .widget.notifier.moving, .widget.notifier.cfgopen, .widget:hover .whead, .widget.touched .whead, .widget.grouped .whead, #panel:hover .whead, #panel.touched .whead";
  const reachable = (node) => {
    const r = node.getBoundingClientRect();
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    return [...document.querySelectorAll(RSEL)].some((reg) => {
      const q = reg.getBoundingClientRect();
      return cx >= q.left && cx <= q.right && cy >= q.top && cy <= q.bottom;
    });
  };

  const clipped = [], unreachable = [];
  for (const w of WIDGETS) {
    const el = w.local ? document.getElementById("panel") : document.getElementById("w-" + w.key);
    el.classList.add("touched"); // bar out, the way hovering it would
    // the bar's own controls
    for (const b of el.querySelectorAll(".wh-right .wh-btn")) {
      const cls = b.className.replace("wh-btn ", "");
      if (visibleArea(b) < 25) clipped.push(w.key + " " + cls + " [clipped by " + lastClipper + "]");
      else if (!reachable(b)) unreachable.push(w.key + " " + cls);
    }
    // and whatever its cog opens - the page's own menu, or the local popover
    el.querySelector(".wh-cog").click();
    await sleep(20);
    if (el.classList.contains("has-settings")) {
      let root = null; try { root = w.local ? document.getElementById("cogMenu") : document.getElementById("wf-" + w.key).contentWindow.__widgetSettingsRoot(); } catch {}
      if (!root || !root.querySelector(".wtext-row")) clipped.push(w.key + " own-menu text row missing");
    } else {
      const cfg = el.querySelector(".wcfg");
      if (!cfg) {
        clipped.push(w.key + " has no settings surface at all");
      } else if (visibleArea(cfg) < 400) {
        clipped.push(w.key + " popover area=" + Math.round(visibleArea(cfg)) + " [clipped by " + lastClipper + "]");
      } else {
        if (!reachable(cfg)) unreachable.push(w.key + " settings popover");
        for (const b of cfg.querySelectorAll(".wh-btn")) {
          if (getComputedStyle(b).display === "none") continue;
          if (visibleArea(b) < 25) clipped.push(w.key + " popover " + b.className.replace("wh-btn ", ""));
        }
      }
    }
    // 🔑 Close what this iteration opened. Removing cfgopen only closes the LOCAL popover — a
    // page's own sheet stayed open for the rest of the suite, so the later "the cog opens its own
    // sheet" check was really asserting that it was already open. That went unnoticed until the
    // cog learned to toggle, at which point the same click correctly CLOSED it and the check
    // failed. The stale state was the bug; the toggle just exposed it.
    wCloseSettings(w);
    el.classList.remove("cfgopen");
    el.classList.remove("touched");
  }
  ok("no widget control is clipped away by an ancestor", clipped.length === 0, clipped.slice(0, 6).join(" | "));
  ok("every widget control sits inside a reported click region", unreachable.length === 0, unreachable.slice(0, 6).join(" | "));

  // The cog must actually DO something - a dead control that merely exists is the bug we keep
  // hitting. There are two shapes: a page with its own settings sheet opens THAT, everything else
  // opens the local popover. Check one of each.
  const w0 = WBY.notepad, e0 = document.getElementById("w-notepad");
  e0.classList.add("touched");
  e0.querySelector(".wh-cog").click(); await sleep(20);
  ok("a widget with no page settings opens a visible popover",
     e0.classList.contains("cfgopen") && visibleArea(e0.querySelector(".wcfg")) > 400,
     "cfgopen=" + e0.classList.contains("cfgopen") + " area=" + Math.round(visibleArea(e0.querySelector(".wcfg"))));
  const e1 = document.getElementById("w-party");
  e1.classList.add("touched");
  e1.querySelector(".wh-cog").click(); await sleep(40);
  let sheetOpen = false;
  try { sheetOpen = document.getElementById("wf-party").contentDocument.getElementById("wsettings").classList.contains("open"); } catch {}
  ok("a widget WITH page settings opens its own sheet", sheetOpen);
  ok("...and the Text size row was injected into that sheet",
     !!document.getElementById("wf-party").contentWindow.__widgetSettingsRoot().querySelector(".wtext-row"));
  // and text size must move
  const before = w0.s.text || 1;
  e0.querySelector(".wcfg-up").click(); await sleep(20);
  ok("text size control changes the scale", (w0.s.text || 1) > before, before + " -> " + (w0.s.text || 1));
  e0.querySelector(".wcfg-dn").click();
  e0.classList.remove("cfgopen", "touched");
  return out;
})()`;

// ── Suite 6: sweeps ───────────────────────────────────────────────────────────
// The pair suite fixes one dimension (which widgets are stacked) and holds everything else at its
// default. These sweep the OTHER dimensions - every manufacturer skin, the full size range, the
// full text-size range - because a bug in one skin or at one extreme is otherwise only ever found
// by a user. All of them assert the same thing: content stays inside the box it was given.
const THEMES = ["mobiglas", "drake", "anvil", "greys", "argo", "misc", "aegis", "crusader", "rsi",
                "mirai", "origin", "esperia", "banu", "gatac", "kruger", "cnou"];
const SWEEPS = `(async () => {
  ${PRELUDE}
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(500);

  const frameBox = (w) => (w.local ? el(w).getBoundingClientRect()
                                   : document.getElementById("wf-" + w.key).getBoundingClientRect());
  const innerFit = (w) => {
    try {
      if (w.local) return null;
      const doc = document.getElementById("wf-" + w.key).contentDocument;
      const panel = doc && (doc.getElementById("panel") || doc.getElementById("card"));
      if (!panel) return null;
      const f = frameBox(w), pr = panel.getBoundingClientRect();
      return { ox: Math.round(pr.width - f.width), oy: Math.round(pr.height - f.height) };
    } catch { return null; }
  };
  const fits = (w) => { const o = innerFit(w); return !o || (o.ox <= 2 && o.oy <= 2); };
  const root = document.documentElement, theme0 = root.getAttribute("data-theme");
  const THEMES = ${JSON.stringify(THEMES)};

  // ── theme sweep: every skin, every widget ───────────────────────────────────
  // A skin is a token swap plus per-theme trinket images, so the things that break are a missing
  // asset (renders as nothing) and a rule that changes layout.
  const themeBad = [], missingArt = [];
  for (const th of THEMES) {
    root.setAttribute("data-theme", th);
    for (const w of WIDGETS) { syncWidgetTheme(w); }
    await sleep(30);
    for (const w of WIDGETS) {
      if (!fits(w)) themeBad.push(th + "/" + w.key + " " + JSON.stringify(innerFit(w)));
      const box = frameBox(w);
      if (box.width < 40 || box.height < 40) themeBad.push(th + "/" + w.key + " collapsed");
    }
    // trinket art actually resolves (a 404 renders as an empty box, silently)
    for (const sel of [".tape.tr", ".tape.bl", ".corner.tr", ".corner.bl", ".bolt.tr", ".bolt.bl"]) {
      for (const node of document.querySelectorAll(".flair " + sel)) {
        if (getComputedStyle(node).display === "none") continue;
        if (node.tagName === "IMG") { if (!node.complete || node.naturalWidth === 0) missingArt.push(th + " " + sel); }
        else {
          const bg = getComputedStyle(node).backgroundImage;
          if (!bg || bg === "none") missingArt.push(th + " " + sel + " (no image)");
        }
      }
    }
  }
  if (theme0) root.setAttribute("data-theme", theme0); else root.removeAttribute("data-theme");
  ok("every skin renders every widget without breaking layout", themeBad.length === 0, themeBad.slice(0, 5).join(" | "));
  ok("every skin's trinket art resolves", missingArt.length === 0, [...new Set(missingArt)].slice(0, 6).join(" | "));

  // ── size sweep: both ends of every widget's clamp range ─────────────────────
  // Resolves once the frame's own document reports it is embedded. Falls through after ~1.5s and
  // measures anyway — a widget that NEVER embeds is a real failure worth surfacing, not a wait.
  const embeddedReady = async (w) => {
    if (w.local) return true;
    for (let i = 0; i < 60; i++) {
      try {
        const fr = frameEl(w);
        const d = fr && fr.contentDocument;
        if (d && d.body && d.body.classList.contains("embedded")) return true;
      } catch { /* cross-document timing */ }
      await sleep(25);
    }
    return false;
  };
  const sizeBad = [];
  for (const w of WIDGETS) {
    for (const [lbl, ww, hh] of [["min", w.size.minW, w.size.minH], ["max", w.size.maxW, w.size.maxH]]) {
      if (ww == null) continue;
      w.s.w = Math.min(ww, 1600); w.s.h = Math.min(hh, 1200); // keep it inside the test viewport
      // 🔴 WAIT FOR THE PAGE TO BE EMBEDDED — a fixed sleep is a flake generator here. An embedded
      // widget page only fills its frame once it has read ?embedded=1 and set body.embedded; until
      // then webview and bindingwidget render at their STANDALONE fixed size (420x520 / 620x340),
      // overflowing a min-size frame by exactly that difference. Measured mid-load, the check
      // reports a failure that says nothing about the widget. It showed up as the LAST widgets in
      // the registry failing together the moment missions.html grew — the tail of the sweep is
      // where a fixed budget runs out first.
      applyFrame(w); await embeddedReady(w); await sleep(20);
      if (!fits(w)) sizeBad.push(w.key + "@" + lbl + " " + JSON.stringify(innerFit(w)));
      const b = frameBox(w);
      if (b.width < 40 || b.height < 30) sizeBad.push(w.key + "@" + lbl + " collapsed to " + Math.round(b.width) + "x" + Math.round(b.height));
    }
    resetWidget(w);
  }
  ok("every widget survives both ends of its size range", sizeBad.length === 0, sizeBad.slice(0, 5).join(" | "));

  // ── text-size sweep: 70% to 200% ────────────────────────────────────────────
  // This is the control that replaced scaling, so it has to hold at both extremes: a widget must
  // not spill out of its box at 200%, and must not collapse at 70%.
  const textBad = [];
  for (const w of WIDGETS) {
    for (const scale of [0.7, 1, 1.5, 2]) {
      w.s.text = scale; applyTextScale(w); await sleep(25);
      if (!fits(w)) textBad.push(w.key + "@" + Math.round(scale * 100) + "% " + JSON.stringify(innerFit(w)));
    }
    w.s.text = null; applyTextScale(w);
  }
  ok("every widget holds its box from 70% to 200% text", textBad.length === 0, textBad.slice(0, 5).join(" | "));

  // ── stacks of three and four ────────────────────────────────────────────────
  // Pairs never exercise tab overflow in the bar, which is where a third and fourth tab land.
  while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
  const quad = ["party", "mining", "battaglia", "notepad"].map(k => WBY[k]);
  groupWidgets(quad[1], quad[0]);
  groupWidgets(quad[2], quad[0]);
  groupWidgets(quad[3], quad[0]);
  await sleep(60);
  const g4 = GROUPS[0];
  ok("four widgets stack into one group", g4 && g4.members.length === 4, g4 && g4.members.join(","));
  const bar4 = el(WBY[g4.active]).querySelector(".whead");
  const tabs4 = bar4.querySelectorAll(".wh-tabs .gtab:not(.gdetach)").length;
  ok("the bar shows a tab per member", tabs4 === 4, tabs4);
  // the tab row must not push the controls off the bar
  const right4 = bar4.querySelector(".wh-right").getBoundingClientRect();
  const barR = bar4.getBoundingClientRect();
  ok("controls stay on the bar with four tabs",
     right4.right <= barR.right + 1 && right4.width > 20,
     "controls end " + Math.round(right4.right) + " bar ends " + Math.round(barR.right));
  ok("exactly one member of a four-stack is on screen",
     g4.members.filter(k => shown(WBY[k])).length === 1,
     g4.members.filter(k => shown(WBY[k])).join(","));
  while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
  for (const w of WIDGETS) resetWidget(w);
  return out;
})()`;

// ── Suite: what the Mining Scanner SAYS for each verdict ──────────────────────
// The verdict model is the whole point of the feature, and the part Sub judges is what he HEARS.
// Runs against mining.html standalone with the speech calls stubbed — a real one would make the
// hidden test window talk out loud, which is how a synthetic "Debris" once spoke at Sub mid-session.
const MININGSAY = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(400);
  // Stub BOTH speech paths (clips, and the Windows-TTS fallback) plus the sound cue, and record.
  let said = null, chimed = false;
  window.speakClips = (slugs, fallback) => { said = { slugs, fallback }; };
  window.speak = (text) => { said = { slugs: null, fallback: text }; };
  window.cue = async () => { chimed = true; };
  const scan = (v, sig, matches, confirmed) => ({ signature: sig, matches, at: Date.now(), confirmed, verdict: v });
  const say = (sc) => { said = null; chimed = false; view = { rocks: [], targets: [...targetSet], scan: sc, jobs: [] }; renderScan(); onNewScan(sc); };
  const rock = (name, count) => ({ name, rarity: "Legendary", count });

  localStorage.setItem("miningDebris", "on");
  localStorage.setItem("miningSpeakMode", "target");
  targetSet.clear();

  // ore, not a target, targets-only mode -> shown, not announced (unchanged behaviour)
  say(scan("ore", 3170, [rock("Quantainium", 1)], true));
  await sleep(30);
  ok("a non-target rock in targets-only mode stays quiet", said === null, JSON.stringify(said));
  ok("...but the panel still names it", document.getElementById("scanNow").textContent.includes("Quantainium"));

  // ore, targeted
  targetSet.add("Quantainium");
  say(scan("ore", 3170, [rock("Quantainium", 1)], true));
  await sleep(30);
  ok("a TARGET is announced", said && said.slugs && said.slugs[0] === "c_thatlookslike"
     && said.slugs[1] === "n_quantainium", JSON.stringify(said && said.slugs));

  // 19,200 = Savrilium x6 OR Aslarite x5 — the TARGET has to win, not matches[0]
  targetSet.clear(); targetSet.add("Aslarite");
  say(scan("ore", 19200, [rock("Savrilium", 6), rock("Aslarite", 5)], true));
  await sleep(30);
  ok("when two rocks share a signature, the TARGETED one is named",
     said && said.slugs && said.slugs[1] === "n_aslarite", JSON.stringify(said && said.slugs));
  ok("...and the panel leads with it too",
     document.getElementById("scanNow").querySelector(".rock").textContent.includes("Aslarite"));

  // 16,000 = Savrilium x5 AND eight debris panels
  targetSet.clear();
  say(scan("ore-or-debris", 16000, [rock("Savrilium", 5)], true));
  await sleep(30);
  // Sub, 2026-08-08: lead with the LIKELIER reading and say the doubt out loud. Both real
  // collisions are a rare ore at x5 against an ordinary panel count, so off-target leads with
  // debris — "Probably debris. Could be <ore>. Your call." The ore name still rides in the middle,
  // which is why this is three clips rather than two.
  ok("an ambiguous value is announced even in targets-only mode",
     said && said.slugs && said.slugs[0] === "c_probablydebris" && said.slugs[1] === "n_savrilium"
       && said.slugs[2] === "c_yourcall",
     JSON.stringify(said && said.slugs));
  ok("...and the panel flags it as maybe-debris",
     !!document.getElementById("scanNow").querySelector(".maybe"));
  targetSet.add("Savrilium");
  say(scan("ore-or-debris", 16000, [rock("Savrilium", 5)], true));
  await sleep(30);
  // 🔑 The old assertion here demanded the prefix be "hopeful". That requirement is GONE — Sub
  // did not want the app implying it knows. A target still LEADS with the rock (never buried under
  // "debris"), but hedged: "That might be <ore>. I'm not certain. Worth flying over."
  ok("...and a TARGET leads with the rock, hedged rather than promised",
     said && said.slugs && said.slugs[0] === "c_mightbe" && said.slugs[1] === "n_savrilium"
       && said.slugs[2] === "c_notcertain",
     JSON.stringify(said && said.slugs));
  ok("...with the target chime", chimed);

  // debris
  targetSet.clear();
  say(scan("debris", 6000, [], true));
  await sleep(30);
  ok("debris says Debris", said && said.slugs && said.slugs[0] === "n_debris", JSON.stringify(said && said.slugs));
  ok("...without the target chime", !chimed);

  // unknown — a value the game cannot draw as a signature. The tracker refuses these outright now
  // (Sub, 2026-08-09: the scanner was popping open mid-flight off a HUD number whose glyph check
  // passed), so one should never arrive here at all. A stale scan persisted from an older build
  // still has to RENDER without speaking, which is what this asserts.
  say(scan("unknown", 2500, [], true));
  await sleep(30);
  ok("an unknown value is silent even with the glyph confirmed", said === null, JSON.stringify(said));
  ok("...and never chimes or claims to be a rock", !chimed
     && document.getElementById("scanNow").textContent.includes("Unknown"),
     document.getElementById("scanNow").textContent.slice(0, 60));

  // the switch
  localStorage.setItem("miningDebris", "off");
  say(scan("debris", 8000, [], true));
  await sleep(30);
  ok("the switch silences debris", said === null);
  say(scan("ore-or-debris", 18000, [rock("Bexalite", 5)], true));
  await sleep(30);
  ok("...and an ambiguous read you aren't hunting", said === null);
  targetSet.add("Bexalite");
  say(scan("ore-or-debris", 18000, [rock("Bexalite", 5)], true));
  await sleep(30);
  // 18,000 is the OTHER real collision (Bexalite x5, Rare, vs nine panels). The "call out debris"
  // switch governs everything that isn't the ore you came for — but a target is never suppressed
  // by it, hedged phrasing or not.
  ok("...but NEVER a target", said && said.slugs && said.slugs[0] === "c_mightbe"
       && said.slugs[1] === "n_bexalite",
     JSON.stringify(said && said.slugs));
  localStorage.setItem("miningDebris", "on");
  targetSet.clear();
  return out;
})()`;

// ── Suite: the patch-notes card fits the MONITOR ──────────────────────────────
// This card has trapped a user once already (0.1.31: close controls below the screen, with an
// always-on-top overlay over Task Manager). The 0.1.32 fix pinned the header/footer and capped the
// card at 82vh — but `vh` is this WINDOW, and this window is the whole multi-monitor canvas. With a
// taller second display the cap exceeded the monitor the card centres on and the trap reopened.
// So the assertion is against --prim-h (the primary monitor) with the REAL changelog loaded, and
// the failing condition is simulated directly: a primary shorter than the canvas.
const PATCHNOTES = `(async () => {
  ${PRELUDE}
  // Render through the PAGE'S OWN builder. showWhatsNew itself needs overlayApi.getVersion, which
  // this suite has no shell for, but everything below that is __wnListHtml — so the card is sized
  // against the markup that actually ships. This suite used to keep its own copy of that markup,
  // which meant it could go on passing against a shape nobody renders.
  // The CONTENT has to be the real changelog too: it is what makes the card tall.
  const data = await (await fetch("/api/changelog?v=0.1.35")).json();
  const entries = (Array.isArray(data.entries) ? data.entries : []).filter(e => Array.isArray(e.notes) && e.notes.length);
  ok("the sidecar serves real patch notes to size against", entries.length > 0, entries.length + " versions");
  ok("the card is built by the page, not by this test", typeof window.__wnListHtml === "function");
  // ── notes collapse to their labels (Sub, 2026-08-14) ─────────────────────────────────────
  // A feature release runs to a dozen notes; the card was a wall of prose you had to read to find
  // out whether any of it mattered to you. The labels ARE the summary, so they must be readable
  // as a list with the paragraphs behind a disclosure.
  {
    const one = window.__wnListHtml([{ version: "9.9.9", date: "2026-08-14T00:00:00Z",
      notes: [{ kind: "new", label: "A labelled note", text: "The paragraph behind it." },
              { kind: "new", text: "A legacy note with no label at all." }] }]);
    const host = document.createElement("div");
    host.innerHTML = one;
    const det = host.querySelectorAll("details.wn-note");
    ok("a labelled note is a collapsible details", det.length === 1);
    ok("...closed by default, so the card reads as a list", det[0] && !det[0].open);
    ok("...with the label as its summary", det[0] && det[0].querySelector("summary.wn-label")
       && det[0].querySelector("summary.wn-label").textContent === "A labelled note");
    ok("...and the paragraph inside it, not beside it",
       det[0] && det[0].querySelector(".wn-desc")
       && det[0].querySelector(".wn-desc").textContent === "The paragraph behind it.");
    // A legacy note carries everything in the description — collapsing one hides the whole note
    // behind an empty summary, so it must stay a plain row.
    const legacy = host.querySelector("li:not(.collapsible) .wn-note.nolabel");
    ok("a note with NO label is never collapsed", !!legacy, legacy ? "plain row" : "MISSING");
    ok("...and keeps its bullet, while a collapsible row drops it for the caret",
       host.querySelectorAll("li.collapsible").length === 1);
  }
  document.getElementById("wnList").innerHTML = window.__wnListHtml(entries);
  document.getElementById("whatsnew").classList.add("show");

  const card = document.querySelector("#whatsnew .wn-card");
  const list = document.getElementById("wnList");
  const headEl = document.querySelector("#whatsnew .wn-head");
  const footEl = document.querySelector("#whatsnew .wn-foot");
  // Every display worth designing for, plus the one that broke: a primary SHORTER than the canvas
  // window is exactly the multi-monitor case, and 720 is the ceiling a 1080p screen sets.
  const CASES = [
    { label: "1080p", h: 1080, top: 0 },
    { label: "primary shorter than the canvas (portrait side monitor)", h: 900, top: 90 },
    { label: "a small laptop panel", h: 768, top: 0 },
  ];
  for (const c of CASES) {
    const s = document.documentElement.style;
    s.setProperty("--prim-top", c.top + "px");
    s.setProperty("--prim-left", "0px");
    s.setProperty("--prim-w", "1600px");
    s.setProperty("--prim-h", c.h + "px");
    await sleep(60);
    const r = card.getBoundingClientRect();
    const hTop = headEl.getBoundingClientRect().top, fBot = footEl.getBoundingClientRect().bottom;
    ok("[" + c.label + "] the card fits inside the monitor", r.height <= c.h,
       Math.round(r.height) + "px tall in " + c.h + "px");
    ok("[" + c.label + "] the ✕ is on screen", hTop >= c.top, Math.round(hTop) + " >= " + c.top);
    ok("[" + c.label + "] \\"Got it\\" is on screen", fBot <= c.top + c.h,
       Math.round(fBot) + " <= " + (c.top + c.h));
    // Capping without a scroll would just hide notes, which is NOT the ask ("I don't want to just
    // cut it off"): the overflow has to be reachable.
    // KEY: assert REACHABILITY, not scrolling. The old form required scrollHeight > clientHeight,
    // which silently asserts "the changelog is long" - it went red the moment a release shipped
    // with short notes (0.1.36: 247px of content in a 356px card; nothing to scroll, nothing
    // wrong). A permanently-failing assertion hides real regressions, which is worse than the gap
    // it was covering. What matters either way: no note is unreachable.
    const scrolls = list.scrollHeight > list.clientHeight;
    ok("[" + c.label + "] no notes are unreachable",
       scrolls ? getComputedStyle(list).overflowY === "auto" : list.scrollHeight <= list.clientHeight + 1,
       (scrolls ? "overflows and scrolls" : "fits, no scroll needed") +
       " - " + list.clientHeight + " of " + list.scrollHeight + "px");
  }
  document.getElementById("whatsnew").classList.remove("show");
  return out;
})()`;

// ── Suite: patch notes are grouped and labelled ───────────────────────────────
// Notes used to be bare paragraphs, so finding what changed meant reading all of them. Each note
// is now { kind, label, text } and the card groups them New / Improved / Fixed.
// Two things are worth pinning. First the ORDER, because it is an editorial decision and nothing
// else enforces it. Second the LEGACY path: 0.1.33 and older are plain strings with no kind, and
// they must still render — as one unheaded list, not filed under a guessed section. The sidecar
// serves only the newest 5 versions, so the legacy case is checked against the builder directly
// rather than waiting for a release to age out and break it in the field.
const PATCHGROUPS = `(async () => {
  ${PRELUDE}
  const list = document.getElementById("wnList");
  const data = await (await fetch("/api/changelog?v=0.1.38")).json();
  const entries = (Array.isArray(data.entries) ? data.entries : []).filter(e => Array.isArray(e.notes) && e.notes.length);
  const newest = entries[0];
  ok("the newest version's notes carry a kind and a label",
     newest.notes.every(n => n && n.kind && n.label), newest.version);
  ok("...and every kind is one we render",
     newest.notes.every(n => ["new", "improved", "fixed"].includes(n.kind)));

  list.innerHTML = window.__wnListHtml(entries);
  // 🔑 The card must be SHOWN before anything is measured. #whatsnew is display:none until then,
  // so every getBoundingClientRect() reads 0 and the two geometry assertions below pass without
  // testing anything — which is exactly how the first version of this suite reported a label x of
  // 0 and called it agreement.
  document.getElementById("whatsnew").classList.add("show");
  await sleep(40);
  const first = list.querySelector(".wn-group");
  ok("the card is laid out, so the measurements below mean something",
     first.getBoundingClientRect().width > 100, Math.round(first.getBoundingClientRect().width) + "px wide");
  const headings = [...first.querySelectorAll(".wn-kind")].map(el => el.textContent);
  const expected = ["New", "Improved", "Fixed"].filter(h =>
    newest.notes.some(n => n.kind === h.toLowerCase()));
  ok("sections read New, then Improved, then Fixed", headings.join(",") === expected.join(","),
     headings.join(" / "));
  // An empty section must be omitted, never left as a bare heading — 0.1.36 is a single fix.
  ok("no section is left empty",
     [...first.querySelectorAll(".wn-kind")].every(h => {
       const ul = h.nextElementSibling;
       return ul && ul.tagName === "UL" && ul.children.length > 0;
     }));
  const label = first.querySelector(".wn-label");
  const desc = first.querySelector(".wn-desc");
  ok("a note shows its label above its description", !!label && !!desc, label && label.textContent);
  ok("...on its own line", !!label && label.getBoundingClientRect().bottom <= desc.getBoundingClientRect().top + 1);
  ok("...and the label is not repeated in the description",
     !desc.textContent.startsWith(label.textContent));
  // Every label must be reachable in one glance: they are the scan target, so they share a left
  // edge. Compare within a section — a heading indents nothing, but a wrapped description must
  // not push the next label right.
  const lefts = [...first.querySelectorAll(".wn-label")].map(el => Math.round(el.getBoundingClientRect().left));
  ok("every label starts at the same x", new Set(lefts).size === 1, [...new Set(lefts)].join(","));

  // LEGACY: a plain string, exactly as 0.1.33 and older are stored.
  list.innerHTML = window.__wnListHtml([{ version: "0.1.33", date: null, notes: ["An old note with no label."] }]);
  ok("a legacy note still renders", list.textContent.includes("An old note with no label."));
  ok("...with no invented section heading", list.querySelectorAll(".wn-kind").length === 0);
  ok("...and is not dimmed like a description under a label",
     list.querySelector(".wn-note").classList.contains("nolabel"));
  document.getElementById("whatsnew").classList.remove("show");
  list.innerHTML = "";
  return out;
})()`;

// ── Suite: the setup nudge ────────────────────────────────────────────────────
// The banner shown to EXISTING users who never finished setup. Three things can go wrong with
// it, and all three have precedent in this file: it can be sized off the canvas instead of the
// monitor (the patch-notes bug), its buttons can sit outside the rect the shell hit-tests (the
// scan-box Reset button), and a hidden one can keep claiming a region and eat game clicks.
//
// 🔑 It does NOT drive the real /api/setup. That endpoint writes the user's config, and this
// harness runs against the LIVE one — a suite that marks setup complete would silently disarm
// the wizard for whoever ran the tests. The shell decides whether to show the banner; the page
// only renders it, so rendering is the whole contract worth asserting here.
// ── Suite: the background-service-down banner ─────────────────────────────────
// The sidecar does all the work and this window is only the display, so a dead one is invisible
// unless something says so. Asserts the banner is purely a function of pushed state — it must not
// linger after recovery, and its button has to be reachable.
// ── Suite: chrome must not open BEHIND the Web Page widget's native view ──────
// That widget's content is a native surface painted above all page content, so canvas DOM landing
// on it is invisible and unclickable while looking perfectly healthy in the inspector — which is
// exactly how its own settings cog became unreachable. The only observable contract is that the
// canvas REPORTS a mask, so that is what this asserts.
const VIEWMASK = `(async () => {
  ${PRELUDE}
  const masks = [];
  try {
  window.overlayApi = Object.assign({}, window.overlayApi, { maskWebView: (on) => masks.push(!!on) });
  const web = WBY.webView;
  ok("the Web Page widget is in the registry", !!web, web ? web.key : "MISSING");

  // 🔑 It is the ONLY native view. Every other widget is a DOM iframe and stacks by z-index, so
  // none of them can be hidden behind their own content — assert that here, so a second
  // native-view widget added later trips this test instead of shipping the same bug.
  ok("only one widget is native-view backed", WIDGETS.filter(w => w.key === "webView").length === 1);

  setWidgetVisible(web, true);
  await sleep(250);
  const el = document.getElementById("w-" + web.key);
  ok("its wrapper exists once shown", !!el);
  const cog = el && el.querySelector(".wh-cog");
  ok("it has a settings cog", !!cog);

  if (cog) {
    masks.length = 0;
    cog.click();
    await sleep(120);
    ok("opening the Web Page cog masks the native view", masks.some(m => m === true),
       "masks=" + JSON.stringify(masks));
    masks.length = 0;
    document.body.click();
    await sleep(120);
    ok("closing it un-masks", masks.some(m => m === false), "masks=" + JSON.stringify(masks));
  }

  setWidgetVisible(web, false);
  await sleep(100);
  } catch (err) { ok("suite ran without throwing", false, String(err && err.stack || err).slice(0, 300)); }
  return out;
})()`;

const SVCDOWN = `(async () => {
  ${PRELUDE}
  const svc = document.getElementById("svcDown");
  const retry = document.getElementById("sdRetry");
  const body = document.getElementById("sdBody");
  const REGION = "#svcDown.show";
  ok("the banner exists", !!svc && !!retry);
  ok("a healthy sidecar shows nothing", getComputedStyle(svc).display === "none");
  ok("...and claims no interactive region", document.querySelectorAll(REGION).length === 0);

  // Automatic retry: honest wording, and no button to press while the app is already trying.
  svc.classList.add("show");
  body.textContent = "SC Overlay isn't tracking anything right now. Reconnecting…";
  retry.style.display = "none";
  await sleep(40);
  ok("while reconnecting it says so", body.textContent.indexOf("Reconnecting") > -1, body.textContent);
  ok("...and offers no button to press", getComputedStyle(retry).display === "none");

  // Given up: the state Sub actually hit — app running, nothing working, nothing said.
  body.textContent = "SC Overlay isn't tracking missions, blueprints or mining until this restarts.";
  retry.style.display = "";
  await sleep(40);
  ok("once it gives up it says what is broken", body.textContent.indexOf("isn't tracking") > -1);
  ok("...and offers Try again", getComputedStyle(retry).display !== "none");
  ok("...which the shell can actually hit-test", document.querySelectorAll(REGION).length === 1);
  const r = svc.getBoundingClientRect(), b = retry.getBoundingClientRect();
  ok("...with the button INSIDE the reported rect",
     b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1,
     Math.round(b.width) + "x" + Math.round(b.height));

  svc.classList.remove("show");
  await sleep(40);
  ok("recovery clears it and releases the region",
     getComputedStyle(svc).display === "none" && document.querySelectorAll(REGION).length === 0);
  return out;
})()`;

const SETUPNUDGE = `(async () => {
  ${PRELUDE}
  const nudge = document.getElementById("setupNudge");
  ok("the nudge exists in the canvas", !!nudge);

  const REGION = "#setupNudge.show";
  const hiddenClaims = document.querySelectorAll(REGION).length;
  ok("a hidden nudge claims NO interactive region", hiddenClaims === 0,
     hiddenClaims + " matches while hidden");

  document.getElementById("snBody").textContent = "2 steps of setup are still unfinished. It takes about a minute.";
  nudge.classList.add("show");
  await sleep(80);
  ok("a shown nudge claims exactly one region", document.querySelectorAll(REGION).length === 1);

  // Same display cases as the patch-notes suite, including the one that actually broke: a
  // primary monitor SHORTER than the canvas window is the multi-monitor case.
  const CASES = [
    { label: "1080p", w: 1920, h: 1080, top: 0, left: 0 },
    { label: "primary shorter than the canvas (portrait side monitor)", w: 3440, h: 1440, top: 0, left: 1080 },
    { label: "a small laptop panel", w: 1366, h: 768, top: 0, left: 0 },
  ];
  for (const c of CASES) {
    const s = document.documentElement.style;
    s.setProperty("--prim-top", c.top + "px");
    s.setProperty("--prim-left", c.left + "px");
    s.setProperty("--prim-w", c.w + "px");
    s.setProperty("--prim-h", c.h + "px");
    await sleep(60);
    const r = nudge.getBoundingClientRect();
    ok("[" + c.label + "] the nudge sits on the primary monitor horizontally",
       r.left >= c.left - 1 && r.right <= c.left + c.w + 1,
       Math.round(r.left) + ".." + Math.round(r.right) + " within " + c.left + ".." + (c.left + c.w));
    ok("[" + c.label + "] the nudge sits on the primary monitor vertically",
       r.top >= c.top - 1 && r.bottom <= c.top + c.h + 1,
       Math.round(r.top) + ".." + Math.round(r.bottom) + " within " + c.top + ".." + (c.top + c.h));
    // A banner, not a takeover. If it ever grows to cover the screen it has become the modal
    // this was deliberately not built as.
    ok("[" + c.label + "] the nudge stays a banner, not a takeover",
       r.height < c.h * 0.25 && r.width < c.w * 0.9,
       Math.round(r.width) + "x" + Math.round(r.height) + " on " + c.w + "x" + c.h);

    // 🔑 Both controls INSIDE the banner's own box. The shell hit-tests the element rect it is
    // told about, so a button hanging outside it is visible and permanently unclickable.
    for (const id of ["snGo", "snX"]) {
      const b = document.getElementById(id).getBoundingClientRect();
      ok("[" + c.label + "] " + id + " is inside the reported rect",
         b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1,
         Math.round(b.left) + "," + Math.round(b.top) + " in " +
         Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height));
      ok("[" + c.label + "] " + id + " has a clickable size", b.width > 8 && b.height > 8,
         Math.round(b.width) + "x" + Math.round(b.height));
    }
  }

  nudge.classList.remove("show");
  await sleep(40);
  ok("dismissing releases the region", document.querySelectorAll(REGION).length === 0);
  return out;
})()`;

// ── Suite: the contract payout scan session's dashboard ───────────────────────
// It is chrome tied to a MODE, and every way it can break is invisible from a screenshot of a
// working app: the panel can render perfectly and refuse every click (not in RSEL), it can keep
// polling after it is dismissed (src left set), it can drift out of step with the scanner (the ✕
// hiding the panel instead of ending the session), or it can strand itself off-monitor. Each of
// those gets an assertion here, because a green sweep of the other suites proves none of them.
//
// 🔑 Driven through PREFS + applyPrefs(), which is the REAL path — the mode arrives from the
// sidecar's prefs broadcast and nothing else is allowed to show or hide the panel. Poking
// syncPayoutPanel() directly would test a function nobody calls that way.
// (No backticks and no backslash escapes anywhere in a suite body — this is a template literal.)
const PAYOUTPANEL = `(async () => {
  ${PRELUDE}
  const panel = document.getElementById("payoutPanel");
  const frame = document.getElementById("ppFrame");
  ok("the panel exists", !!panel);
  ok("...and hosts the dashboard in an iframe", !!frame && frame.tagName === "IFRAME");

  // OFF is the state every launch starts in, so it is the one that has to be right by default.
  PREFS.payoutScan = false; applyPrefs();
  await sleep(80);
  ok("with the mode off it is not on screen", getComputedStyle(panel).display === "none");
  ok("...and it is not polling", !frame.getAttribute("src"), String(frame.getAttribute("src")));
  // Region membership is measured off the rects the page actually SENDS the shell (captured by
  // the stub preload), never off the RSEL string. RSEL is block-scoped inside the page's
  // "if window.overlayApi" guard, so a typeof check on it is false here and a guarded read
  // returns the truthy fallback TEXT — an assertion in that shape passes with the selector
  // deleted, which was confirmed by deleting it.
  const regionHas = (el) => {
    const b = el.getBoundingClientRect();
    return (window.__regions || []).some((r) =>
      Math.abs(r.x - b.left) <= 1 && Math.abs(r.y - b.top) <= 1 &&
      Math.abs(r.w - b.width) <= 1 && Math.abs(r.h - b.height) <= 1);
  };
  await sleep(180);   // the region report is on a 100ms interval and only fires on a real change
  ok("...and it claims no clickable region, so it cannot swallow game clicks while gone",
     !regionHas(panel), JSON.stringify(window.__regions || []).slice(0, 120));

  PREFS.payoutScan = true; applyPrefs();
  await sleep(120);
  ok("arming the mode puts it on screen", getComputedStyle(panel).display === "flex");
  ok("...and it loads the dashboard page", frame.getAttribute("src") === "/payout-scan.html",
     String(frame.getAttribute("src")));
  // Anything outside a widget's own rect is unclickable unless the page REPORTS it, so an
  // unlisted panel renders perfectly and refuses every click — including the Stop button it
  // exists to offer, which would leave the scanner armed with no way to reach the control that
  // stops it.
  await sleep(180);
  ok("...and the shell is told to make the window interactive over it", regionHas(panel),
     JSON.stringify(window.__regions || []).slice(0, 160));

  // On the PRIMARY monitor, in full. The canvas spans the whole virtual desktop, so a panel sized
  // or placed against the window rather than --prim-* can land on a monitor that is not there, or
  // hang off both edges of the one it is centred on.
  const ci = canvasInfo || { px: 0, py: 0, pw: innerWidth, ph: innerHeight };
  const r = panel.getBoundingClientRect();
  ok("it sits wholly inside the primary display",
     r.left >= ci.px - 1 && r.top >= ci.py - 1 &&
     r.right <= ci.px + ci.pw + 1 && r.bottom <= ci.py + ci.ph + 1,
     Math.round(r.left) + "," + Math.round(r.top) + " " +
     Math.round(r.width) + "x" + Math.round(r.height) + " in " +
     ci.pw + "x" + ci.ph + " at " + ci.px + "," + ci.py);
  ok("...at a size the dashboard is readable at", r.width >= 320 && r.height >= 260,
     Math.round(r.width) + "x" + Math.round(r.height));

  // Dragging the header moves it, and the gesture runs under the shield — without that, the first
  // pointermove over the iframe would go to the dashboard's document and the drag would freeze.
  //
  // 🔑 Placed in the MIDDLE of the primary display before the drag, deliberately. The default
  // position is hard against the right edge (the board renders on mobiGlas's left, so the panel
  // sits opposite it), and the first version of this suite dragged right FROM there: the clamp
  // stopped it at +28 of a +50 drag and the assertion failed on working code. A drag test has to
  // start somewhere the drag can actually complete.
  const head = document.getElementById("ppHead");
  ppGeom = ppClamp({ x: ci.px + Math.round(ci.pw / 2) - 230, y: ci.py + 60, w: 460, h: 620 });
  ppApplyGeom();
  await sleep(40);
  const d0 = panel.getBoundingClientRect();
  head.dispatchEvent(new PointerEvent("pointerdown", { clientX: d0.left + 40, clientY: d0.top + 8, bubbles: true }));
  const shield = document.getElementById("dragShield");
  ok("dragging raises the shield, so the iframe cannot swallow the gesture",
     !!shield && shield.classList.contains("on"));
  ok("...without advertising a drop into a group, which cannot happen",
     !document.body.classList.contains("dragging"));
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: d0.left + 90, clientY: d0.top + 38, bubbles: true }));
  await sleep(60);
  const d1 = panel.getBoundingClientRect();
  ok("the header drags it", Math.round(d1.left - d0.left) === 50 && Math.round(d1.top - d0.top) === 30,
     "moved " + Math.round(d1.left - d0.left) + "," + Math.round(d1.top - d0.top));
  // The clamp is what makes this thing recoverable — a panel dragged off the monitor takes its own
  // header, ✕ and Stop button with it, and the only way back would be clearing localStorage. It is
  // asserted here because it already caught this suite out once, so it is demonstrably not obvious.
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: d0.left + 9000, clientY: d0.top + 9000, bubbles: true }));
  await sleep(60);
  const dFar = panel.getBoundingClientRect();
  ok("...and it cannot be dragged off the monitor, controls and all",
     dFar.right <= ci.px + ci.pw + 1 && dFar.bottom <= ci.py + ci.ph + 1 &&
     dFar.left >= ci.px - 1 && dFar.top >= ci.py - 1,
     Math.round(dFar.left) + "," + Math.round(dFar.top) + " " +
     Math.round(dFar.width) + "x" + Math.round(dFar.height));
  window.dispatchEvent(new PointerEvent("pointerup", { clientX: d0.left + 90, clientY: d0.top + 38, bubbles: true }));
  await sleep(60);
  ok("...and the shield comes back down", !shield.classList.contains("on"));

  // 🔴 THE ONE THAT MATTERS. The ✕ must END THE SESSION, not hide the panel: a dashboard you can
  // dismiss while the scanner stays armed leaves screen-reading running with nothing on screen
  // explaining it, which is the exact blindness this page was built to end. So the click has to
  // reach the sidecar as on:false, and it must NOT hide the panel by itself — the panel may only
  // go away when the mode change comes back round on the prefs broadcast.
  let posted = null;
  const realFetch = window.fetch;
  window.fetch = (u, o) => {
    if (String(u).indexOf("/api/payout-scan") >= 0 && o && o.method === "POST") {
      posted = JSON.parse(o.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return realFetch(u, o);
  };
  document.getElementById("ppClose").click();
  await sleep(80);
  ok("the close button ends the scan session", posted && posted.on === false, JSON.stringify(posted));
  ok("...and does NOT hide the panel on its own — only the mode may do that",
     getComputedStyle(panel).display === "flex");
  window.fetch = realFetch;

  // The broadcast arriving is what takes it down, and it must stop the poll on the way out.
  PREFS.payoutScan = false; applyPrefs();
  await sleep(80);
  ok("the mode going off takes the panel with it", getComputedStyle(panel).display === "none");
  ok("...and clears the iframe so it stops polling unseen", !frame.getAttribute("src"),
     String(frame.getAttribute("src")));
  await sleep(180);
  ok("...and gives the region back, so the rest of the session clicks through to the game",
     !regionHas(panel), JSON.stringify(window.__regions || []).slice(0, 160));
  return out;
})()`;

// ── Suite: the Mission / Faction drawers ──────────────────────────────────────
// Driven off the ?missioninfo fixture, which is a TWO-SCOPE reputation award — the case a live
// tracked mission rarely happens to be, and the one that made "+200 / +50" unreadable.
// (No backticks and no backslash escapes anywhere in a suite body — this is a template literal.)
const MIDRAWERS = `(async () => {
  ${PRELUDE}
  const pool = document.getElementById("pool");
  // The fixture paints during canvas init, which can land after this suite starts. Wait for the
  // drawers rather than assuming they are there — the alternative is a suite that fails as a
  // harness ERROR (reading .querySelectorAll of undefined) and says nothing about the feature.
  // 🔑 ONE group is now the correct answer for a fixture with no standing bar. Rank and
  // Reputation moved into the MAIN row (Sub's PILL_ORDER, 2026-08-14), so the faction group has
  // nothing left to draw unless there is a standing bar — and it self-hides rather than render an
  // empty heading. This used to wait for two and then index [1] blindly, which turned the change
  // into a bare "reading .querySelectorAll of undefined" harness error naming no feature: exactly
  // the failure mode the comment below was written to prevent, reintroduced by indexing.
  for (let i = 0; i < 20 && pool.querySelectorAll(".mi").length < 1; i++) await sleep(50);
  const groups = pool.querySelectorAll(".mi").length;
  ok("the mission group rendered", groups >= 1, String(groups));
  const chipsOf = (i) => {
    const g = pool.querySelectorAll(".mi")[i];
    return g ? [...g.querySelectorAll(".mi-chip")] : [];
  };
  const label = (c) => (c && c.querySelector(".ck") ? c.querySelector(".ck").textContent : "");
  const value = (c) => (c.querySelector(".cv") ? c.querySelector(".cv").textContent.replace(/\\s+/g, " ").trim() : c.textContent.trim());

  const mi = chipsOf(0);
  // 🔑 Sub's order: whether it earns you a CrimeStat outranks what kind of job it is.
  ok("Illegal leads the Mission Info chips", value(mi[0]) === "Illegal", value(mi[0]));
  ok("...then the mission type", value(mi[1]) === "Mercenary", value(mi[1]));
  const labels = mi.map(label).filter(Boolean);
  ok("the old label/value ROWS are chips now", labels.includes("Pick up") && labels.includes("Other pools"),
     labels.join(","));
  ok("...and nothing is left rendering the two-column grid", !pool.querySelector(".mi-g"));
  // ⚠️ "2 to go" read as two missions. It counts blueprints only obtainable elsewhere.
  const other = mi.find((c) => label(c) === "Other pools");
  ok("'Other pools' says what the number COUNTS", /only there/.test(value(other)), value(other));

  // 🔑 RE-POINTED: Rank and Reputation are MAIN-ROW pills now (PILL_ORDER, 2026-08-14), so they
  // are found in group 0, not in a faction group. The faction still leads its own group when
  // there is a standing bar to show, and is never repeated as a chip.
  const fac = chipsOf(0);
  const facHead = document.querySelector(".mi-faction");
  ok("the faction is a heading, not a chip repeating the group's own title",
     (!facHead || facHead.textContent === "Headhunters") && !fac.some((c) => label(c) === "Faction"),
     fac.map(label).join(","));
  // 🔑 The rank the giver wants, by NAME. The ladders are bundled; 93% of ranked missions resolve.
  const rank = fac.find((c) => label(c) === "Rank needed");
  ok("the required rank is NAMED, not a bare index", !!rank && value(rank) === "Contractor", rank && value(rank));
  // 🔴 The whole point. Two awards, same faction, DIFFERENT scopes — separate tracks, which is
  // why they do not add to 250. Rendered as bare numbers this read as a bug.
  const rep = fac.find((c) => label(c) === "Reputation");
  const aff = fac.find((c) => label(c) === "Affinity");
  ok("faction reputation is labelled as such", rep && /\\+200/.test(value(rep)), rep && value(rep));
  ok("...and AFFINITY is named rather than shown as a second mystery number",
     aff && /\\+50/.test(value(aff)), aff && value(aff));

  // ── The standing bar on a contract that pays a track we do not rank ──────────────────────
  // 🔴 THE BAR USED TO VANISH. Sub accepted a Headhunters contract and his Headhunters standing
  // disappeared: that contract awards reputation only on ShipCombat_HeadHunters, which
  // REP_SCOPE_DENY excludes, so primaryRep returned null and took the whole bar with it. 384 of
  // 4,075 contracts pay only denied scopes and 88 of those are Headhunters, so it was most of a
  // faction's board. It now falls back to the giver's own tracked standing.
  // Driven through repBarHtml directly — the shape is the contract, and building a whole mission
  // fixture to reach it would test the fixture.
  const barOff = document.createElement("div");
  barOff.innerHTML = repBarHtml({ scope: "FactionReputation", faction: "Headhunters",
    standing: "Sr. Contractor", estimate: 7825, curMin: 5000, nextMin: 15000,
    nextName: "Veteran Contractor", nextRank: 4, nextRewards: [], max: false, noData: false,
    offTrack: true });
  ok("a contract paying an unranked track still shows the giver's standing",
     /Sr. Contractor/.test(barOff.textContent), barOff.textContent.slice(0, 60));
  // 🔑 ...and says so, because the bar sits beside that mission's own reputation pill. Silence
  // there would read as "finishing this advances it", which is exactly what it will not do.
  ok("...marked as not coming from THIS contract",
     /not from this one/.test(barOff.textContent), barOff.textContent.slice(0, 90));
  const offTip = barOff.querySelector(".mi-info");
  ok("...with the reason in the same affordance as the rest of the caveats",
     !!offTip && /will not move this bar/.test(offTip.getAttribute("data-tip") || ""),
     (offTip && offTip.getAttribute("data-tip") || "").slice(-80));

  // The ordinary case must NOT carry the marker, or it stops meaning anything.
  const barOn = document.createElement("div");
  barOn.innerHTML = repBarHtml({ scope: "FactionReputation", faction: "Headhunters",
    standing: "Sr. Contractor", estimate: 7825, curMin: 5000, nextMin: 15000,
    nextName: "Veteran Contractor", nextRank: 4, nextRewards: [], max: false, noData: false });
  ok("...and a contract that DOES advance the bar is not marked",
     !/not from this one/.test(barOn.textContent), barOn.textContent.slice(0, 60));
  return out;
})()`;

// ── Suite: the idle panel (nothing tracked) ───────────────────────────────────
// What fills the tracker when no mission is tracked: closest-to-done, then the session
// scoreboard, then a Latest list sized to the widget. Driven off the ?rates fixture.
//
// 🔑 The row count is asserted by CALLING the fit directly at each height, not by resizing and
// hoping a ResizeObserver fires. Layout callbacks don't run in a window the compositor considers
// hidden — proven while building this — so a suite that waited on one would be measuring the
// harness, not the feature.
// (No backticks and no backslash escapes anywhere in a suite body — this is a template literal.)
const IDLEPANEL = `(async () => {
  ${PRELUDE}
  const pool = document.getElementById("pool");


  // ── The picker's third state ────────────────────────────────────────────────────────────
  // 🔑 Sub, 2026-08-15: there was no way BACK to this panel once a mission was accepted. Clearing
  // the pick means AUTO, and auto immediately re-picks — so "deselect" was not expressible and
  // needed a state of its own. Driven through renderPicker with a stubbed view rather than the
  // live tracker, so the suite never changes what Sub's own app is tracking.
  renderPicker({ missions: [{ id: "m1", title: "Turf War", hasPool: true }], selectedId: null, title: "Turf War" });
  const opts = () => [...document.querySelectorAll("#missionMenu .opt")].map((o) => o.dataset.id);
  ok("the picker offers a way back to the idle screen", opts().indexOf("__idle__") >= 0, opts().join(" | "));
  ok("...as a third choice beside auto and a pinned mission", opts().length === 3, opts().join(" | "));
  ok("...listed under Auto, since both mean 'not a specific mission'",
     opts()[0] === "" && opts()[1] === "__idle__", opts().join(" | "));
  renderPicker({ missions: [{ id: "m1", title: "Turf War", hasPool: true }], selectedId: "__idle__", title: null });
  const active = [...document.querySelectorAll("#missionMenu .opt.active")].map((o) => o.dataset.id);
  ok("...and shows as the live choice when it is the one selected",
     active.join(",") === "__idle__", active.join(",") || "(none active)");
  ok("...while Auto stops claiming to be active",
     !document.querySelector('#missionMenu .opt[data-id=""]').classList.contains("active"));

  // ⚠️ Read the heading's TITLE CELL, not its whole text: two headings now carry a circled-i
  // button inside them, so raw textContent reads "Standingi" and the assertion would be about
  // punctuation rather than order.
  const heads = [...pool.querySelectorAll(".ra-h")].map((e) => {
    const first = e.querySelector("span");
    return (first ? first.textContent : e.textContent).trim();
  });
  // The per-hour rates are folded INTO "This session" (2026-08-13). "Latest" split in two
  // (2026-08-15) and the blueprint half then became a row of PICTURES sized by the widget's
  // WIDTH, so only the missions list still competes for leftover height. Standing sits directly
  // under Closest to done, because it is the same question asked a second way.
  ok("the idle panel is in the documented order",
     heads.join(" | ") === "Closest to done | Next rank | This session | Latest blueprints | Latest missions",
     heads.join(" | "));
  ok("...with a rule between what to do next and what the session was worth",
     !!pool.querySelector(".ra-rule"));

  // Closest to done: the half that answers "what should I go do". Pinned to the SHORTLIST layout
  // (Sub settled on it 2026-08-15), so the switcher no longer touches this section at all.
  const sl = [...pool.querySelectorAll(".sl-r")];
  ok("it lists what you are closest to finishing", sl.length === 4, String(sl.length));
  // 🔴 THE ROW NAMES THE POOL, NOT ONE OF ITS CONTRACTS. This list used to iterate contracts, so
  // one pool fed by many of them filled the panel with itself — Sub saw four rows that were four
  // titles of the SAME pool, all reading 5/8. 65 of the 89 pools span more than one title, so it
  // was the normal case. The fixture's first pool is 26 variants across 3 titles.
  ok("...naming the POOL rather than one of its contracts",
     sl[0].querySelector(".sl-n").textContent === "Mercenary · Headhunters" &&
     sl[0].querySelector(".sl-c").textContent === "5/7",
     sl[0].querySelector(".sl-n").textContent);
  // 🔑 TYPE FIRST, GIVER SECOND (Sub): what kind of work it is, is what you decide on.
  ok("...type first, giver second",
     sl[0].querySelector(".sl-n").textContent.indexOf("Mercenary ·") === 0,
     sl[0].querySelector(".sl-n").textContent);
  ok("...with a bar that matches the fraction, not a guess",
     sl[0].querySelector(".sl-bar i").style.width === "71%",
     sl[0].querySelector(".sl-bar i").style.width);
  const sub0 = sl[0].nextElementSibling;
  ok("...and where to pick it up, because a suggestion you cannot act on is a statistic",
     /Rat's Nest/.test(sub0.textContent), sub0.textContent.trim());
  // What you still need leads the sub-line: the row's most useful fact, and the only thing that
  // separates two pools sharing a giver and a type.
  const need0 = sub0.querySelector(".cp-need");
  ok("...and what you still need to finish it",
     !!need0 && need0.textContent.indexOf("need Karna Rifle") === 0,
     need0 ? need0.textContent.trim() : "(no .cp-need)");
  ok("...with a count rather than the whole list, which the popover carries",
     !!need0 && need0.textContent.indexOf("+1") > 0, need0 ? need0.textContent.trim() : "");
  // 🔴 NO HORIZONTAL SCROLLBAR. The pool box is overflow:auto, so a sub-line that cannot shrink pushes
  // the panel wider than the widget and grows one across the bottom. Sub hit exactly that with a
  // third element on this row. Asserted at the widget's NARROWEST, which is where it shows first.
  const scroller = document.querySelector("#panel .pool") || pool;
  // ⚠️ Its own handle: the shared panel const is declared further down, in the picture-row
  // section, and a suite body is one scope — reaching for it here is a temporal-dead-zone throw,
  // which the harness reports as a bare error naming no feature.
  const panelEl = document.getElementById("panel");
  panelEl.style.width = "300px";
  await sleep(120);
  ok("...and the row never grows a horizontal scrollbar, even at the narrowest width",
     scroller.scrollWidth - scroller.clientWidth === 0,
     (scroller.scrollWidth - scroller.clientWidth) + "px over");
  panelEl.style.width = "380px";
  await sleep(120);
  // A pool fed by several contracts says so — Sub asked for an indicator that the one name on
  // screen is not the only way to farm it. The circled i, not an eye: an eye was tried on
  // 2026-08-12 and "read as something else entirely".
  const cpInfo = sl[0].querySelector(".mi-info");
  ok("...and flags that other contracts fill the same pool", !!cpInfo, sl[0].textContent.trim());
  ok("...naming them in the popover rather than on the row",
     !!cpInfo && /3 different contracts/.test(cpInfo.getAttribute("data-tip") || ""),
     (cpInfo && cpInfo.getAttribute("data-tip") || "").slice(0, 70));
  // The way out to the pool's own page. The uuid IS the address.
  const cpLink = sub0.querySelector(".cp-link");
  ok("...and offers the pool's own page", !!cpLink && cpLink.dataset.pool.length === 36,
     cpLink ? cpLink.dataset.pool : "(no link)");

  // 🔴 TWO POOLS CAN SHARE A NAME. Sub has two "Ship Mining · Shubin Interstellar" pools open at
  // once — same giver, same type, overlapping contract titles, both mining lasers and radars.
  // Appending the missing blueprint to the NAME was tried and measured useless: the combined
  // string does not fit a 380px row, so both ellipsised to the same thing and the disambiguator
  // was exactly the part that got cut. The sub-line is where it has room.
  const slNames = [...pool.querySelectorAll(".sl-n")].map((e) => e.textContent);
  const dupe = slNames.filter((x) => x === "Ship Mining · Shubin Interstellar");
  ok("two pools sharing a giver and a type both still appear", dupe.length === 2, slNames.join(" | "));
  const slNeeds = [...pool.querySelectorAll(".sl-sub .cp-need")].map((e) => e.textContent.trim());
  ok("...told apart by what you still need, not by a truncated name",
     slNeeds[1] !== slNeeds[3] && slNeeds[1].length > 0, slNeeds.join(" | "));

  // ── Standing with your mission givers ──────────────────────────────────────────────────
  // 🔴 THE REP NUMBER IS A FLOOR in every layout: the game never reports reputation anywhere the
  // app can read, so it is reconstructed from the player's own completions and cannot count what
  // happened before the app existed. Each layout must carry the circled i that says so.
  {
    const h = [...pool.querySelectorAll(".ra-h")].map((e) => {
      const first = e.querySelector("span");
      return (first ? first.textContent : e.textContent).trim();
    });
    ok("the standings segment is on screen", h.length >= 2 && h[0] === "Closest to done", h.join(" | "));
    ok("...directly under what to go do next, above the scoreboard", h.indexOf("This session") > 1, h.join(" | "));
    const seg = [...pool.querySelectorAll(".ra-sec")][1];
    ok("...saying the rep total is an estimate", !!seg.querySelector(".mi-info"),
       seg.querySelector(".ra-h") ? seg.querySelector(".ra-h").textContent.trim() : "");
    // Max-rank givers are dropped: there is no next rank to incentivise.
    ok("...and never lists a giver with nothing left to earn",
       seg.textContent.indexOf("Maxed Faction") < 0, seg.textContent.slice(0, 60));
  }
  // The chosen layout's own claim.
  const st0 = pool.querySelector(".st-go");
  ok("rep is expressed as contracts, which is the actionable number",
     !!st0 && /contract/.test(st0.textContent), st0 ? st0.textContent.trim() : "");
  ok("...and approximate, because rep per contract varies with rank",
     !!st0 && st0.textContent.indexOf("~") === 0, st0 ? st0.textContent.trim() : "");

  // The session half.
  const ss = [...pool.querySelectorAll(".ss > div")].map((d) => d.querySelector(".ss-l").textContent);
  ok("the session scoreboard counts contracts, aUEC and blueprints",
     ss.slice(0, 3).join(",") === "Contracts,aUEC,Blueprints", ss.join(","));
  // 🔑 Same shape as the totals above them, in the same section — Sub's ask. The "/ hr" in the
  // label is what keeps a rate from reading as a total when both are set in identical type.
  ok("...with the per-hour figures in the SAME stat shape underneath",
     ss.slice(3).join(",") === "Rep / hr,aUEC / hr", ss.join(","));
  const ssRows = pool.querySelectorAll(".ss");
  ok("...as a second row of the same grid, so the columns line up",
     ssRows.length === 2
     && getComputedStyle(ssRows[0]).gridTemplateColumns === getComputedStyle(ssRows[1]).gridTemplateColumns,
     ssRows.length + " rows");

  // 🔑 THE PACE IS ON SCREEN, not only in a tooltip. It was demoted into a title attribute when
  // the old two-column "Per hour · this grind" block was folded in on 2026-08-13, and Sub
  // asked for exactly that number back on 2026-08-15 ("what you're trending at at the rate that
  // you're going"). The fixture's rep pace is 1480 against 1240 in the last hour.
  const repStat = ssRows[1].children[0];
  const pace = repStat.querySelector(".ss-pace");
  ok("the rate shows what the grind is TRENDING at, not just the last hour",
     !!pace, repStat.textContent.trim());
  ok("...as a suffix on the figure it qualifies, inside the same stat",
     !!pace && repStat.querySelector(".ss-n").contains(pace)
     && repStat.querySelector(".ss-n").textContent.trim().indexOf("1.2k") === 0,
     repStat.querySelector(".ss-n").textContent.trim());
  ok("...set smaller than the measured figure it hangs off, being an extrapolation",
     !!pace && parseFloat(getComputedStyle(pace).fontSize)
        < parseFloat(getComputedStyle(repStat.querySelector(".ss-n")).fontSize),
     pace ? getComputedStyle(pace).fontSize : "");
  // A rate the game never reported must stay a dash — a pace suffix on nothing would invent one.
  ok("...and a rate with no data is still a plain dash",
     !!ssRows[1].children[1].querySelector(".rt-na"),
     ssRows[1].children[1].textContent.trim());

  // ── Latest blueprints, as pictures ──────────────────────────────────────────────────────
  // Sized by the widget's WIDTH (how many fit across), not its height, so unlike the missions
  // list it takes a fixed slice of the panel.
  const panel = document.getElementById("panel");
  const artRow = document.getElementById("raLatestArt");
  const tiles = () => artRow.querySelectorAll(".bt").length;
  // 🔑 DRIVE THE FIT, do not resize and hope. Same reasoning as the row-count assertions below:
  // layout callbacks are unreliable in a window the compositor considers hidden, so a suite that
  // waits on a ResizeObserver is measuring the harness. (A real drag WAS verified separately, in
  // both directions.) The panel width is set, the fit is called, then it is measured.
  const across = (w) => { panel.style.width = w + "px"; window.__fitLatest(); return tiles(); };
  ok("recent blueprints are shown as pictures", !!artRow && tiles() >= 2, String(artRow && tiles()));
  // The tracker's registry entry is { w: 380, minW: 300 }. Sub put his widget at "about the
  // smallest size that someone will reasonably set it to" and asked for TWO there, so 380 => 2
  // is the anchor the 160px minimum tile was solved for — not a taste call.
  ok("...two across at the widget's default width", across(380) === 2, String(across(380)));
  ok("...still two at the narrowest the widget can go", across(300) === 2, String(across(300)));
  ok("...more as it gets wider", across(640) > 2 && across(900) > across(640),
     across(380) + " -> " + across(640) + " -> " + across(900));
  ok("...capped at ten however wide it gets", across(3000) <= 10, String(across(3000)));
  across(380);
  ok("...with a bigger tile when there are fewer of them",
     parseFloat(getComputedStyle(artRow.querySelector(".bt-art")).height) > 90,
     getComputedStyle(artRow.querySelector(".bt-art")).height);
  across(900);
  ok("...and a smaller one when there are more",
     parseFloat(getComputedStyle(artRow.querySelector(".bt-art")).height) < 90,
     getComputedStyle(artRow.querySelector(".bt-art")).height);
  across(380);
  // 🔑 The capture is tried FIRST and the clay render is the fallback — the render is grey,
  // untextured and shared between items that reuse a model, so it shows a shape, not an identity.
  const CAP = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  const REN = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const firstImg = artRow.querySelector(".bt-i");
  ok("...leading with the crowdsourced fabricator capture",
     !!firstImg && firstImg.getAttribute("src") === CAP,
     firstImg ? firstImg.getAttribute("src") : "(no img)");
  ok("...carrying the render as a fallback for when that 404s",
     !!firstImg && !!firstImg.getAttribute("data-fb"),
     firstImg ? String(firstImg.getAttribute("data-fb")) : "");
  // ⚠️ The fixture's every-third entry has no capture, so the row must not be all-captures.
  across(900);   // index 2 is the render-only fixture entry, so widen until it is on screen
  const srcs = [...artRow.querySelectorAll(".bt-i")].map((i) => i.getAttribute("src"));
  ok("...and going straight to the render when there is no capture at all",
     srcs.some((s) => s === REN), srcs.map((s) => (s === CAP ? "capture" : s === REN ? "render" : s)).join(" | "));
  ok("...naming each one, because the render alone cannot identify an item",
     artRow.querySelectorAll(".bt-n").length === tiles(), String(tiles()));

  const mul = document.getElementById("raLatestMissions");
  const mrows = () => mul.querySelectorAll("li:not(.ra-more)").length;
  const at = (h) => { panel.style.height = h + "px"; window.__fitLatest(); return mrows(); };

  // ⚠️ Size the panel FIRST. At the harness's default height this list holds one row, and that
  // row happens to be one carrying an aUEC figure — so the "some rows have no figure" assertion
  // below passed or failed on which mission sorted first, not on the behaviour.
  at(900);
  ok("the last completed missions are listed again", !!mul && mrows() >= 1, String(mul && mrows()));
  ok("...with the aUEC the game actually logged, where it logged one",
     !!mul.querySelector(".ra-val"), mul.textContent.slice(0, 50));
  // 🔑 A calculated-reward contract logs no payout. Omit the figure; never print a zero, which
  // would read as "this paid nothing" rather than "the game did not say".
  ok("...and no figure at all on the ones it did not",
     mrows() > mul.querySelectorAll(".ra-val").length,
     mrows() + " rows, " + mul.querySelectorAll(".ra-val").length + " with a value");

  // 🔑 The picture row is fixed-height, so the missions list is what absorbs the leftover — and
  // it must still GROW with the widget rather than being squeezed out by the art above it.
  // (The two lists briefly SHARED the leftover height; the blueprint half became a width-driven
  // picture row on 2026-08-15, so only this one is height-driven now.)
  ok("...growing as the widget gets taller", at(900) > at(420), at(420) + " -> " + at(900));
  // 🔴 The "+N more" line is a full 21px row, not the 15px it was first guessed at — it is an li
  // in the same list and inherits the same padding. Nothing reserved it, so a truncated list
  // rendered its last row and had the more-line sliced in half by the section's overflow. It read
  // as a rendering fault. Whenever a list is truncated, its rows plus that line must FIT.
  const fits = (u) => {
    const more = u.querySelector(".ra-more");
    if (!more) return true;
    return Math.round(more.getBoundingClientRect().bottom) <= Math.round(u.getBoundingClientRect().bottom) + 1;
  };
  at(640);
  ok("a truncated list leaves room for its own '+N more' line", fits(mul),
     String((mul.querySelector(".ra-more") || {}).textContent));

  const tall = at(900), mid = at(500), small = at(300), tiny = at(120);
  ok("a tall widget shows more rows than a short one", tall > small, tall + " vs " + small);
  ok("...capped at ten however tall it gets", tall <= 10, String(tall));
  ok("...and shrinking really does drop rows", mid >= small, mid + " vs " + small);
  // 🔴 The bug this suite exists for. Sub, collapsing the panel to its minimum: "it doesn't show
  // anything under Latest. It's just nothing." A heading over a void is worse than one row.
  ok("NEVER empty, however small the widget gets", tiny >= 1, String(tiny));
  // ⚠️ A height where there is something to truncate AND room to say so. Measured: 700-800 shows
  // one row and drops the line (correctly — it would be clipped), 900 shows 2 with the count,
  // 1000 shows 7 with it, and by 1100 all ten fit so there is no count to show at all. Both ends
  // are legitimate, which is exactly why this needs a measured height rather than a big number.
  at(1000);
  // 🔑 ASSERT THE RULE, NOT A HAND-PICKED HEIGHT. Both outcomes are legitimate here — a list that
  // shows everything has no count to give, and one squeezed to a single row DROPS the count
  // rather than let the overflow slice it in half — so pinning this to one pixel height made the
  // assertion about my choice of number instead of about the behaviour. It failed twice that way
  // at heights that were behaving perfectly. The contract is: if rows are hidden AND another row
  // would fit, the count must be there.
  {
    const shown = mrows();
    const room = mul.getBoundingClientRect().height;
    const hidden = shown < (current.recentMissions || []).length;
    const roomForCount = (shown + 1) * 21 <= room + 1;
    ok("...and it says how many it is not showing, whenever there is room to say it",
       !hidden || !roomForCount || !!mul.querySelector(".ra-more"),
       shown + " shown, room " + Math.round(room) + "px, hidden=" + hidden
       + ", counted=" + !!mul.querySelector(".ra-more"));
  }
  at(560);

  // What is worth guarding here is not styling but the two things the panel can get wrong:
  // printing an aUEC figure without saying it is an estimate, and inventing a number for a
  // contract that carries none. The fixture's fourth pool ("Deep space hit") has no payout and
  // no run length precisely so that second case is exercised.
  // 🔴 NO ECONOMICS IN THIS SECTION. Sub, 2026-08-15: the per-hour figure was only ever meant for
  // the session tracker, "NOT with the closest to done". A first pass hung each pool's aUEC/hr,
  // payout and run length off these rows and it was wrong about what the section is for. The
  // assertion is kept pointed at the ABSENCE, because the fields are still on the view model and
  // rendering them is a one-line temptation.
  const slText = [...pool.querySelectorAll(".sl")].map((e) => e.textContent).join(" ");
  ok("closest-to-done carries no rate, payout or run length",
     slText.indexOf("/hr") < 0 && slText.indexOf("aUEC") < 0 && slText.indexOf("~") < 0,
     slText.slice(0, 80));
  ok("...each row with its count, its bar and what is left",
     !!sl[0].querySelector(".sl-c") && !!sl[0].querySelector(".sl-bar i") && !!sl[0].querySelector(".sl-left"),
     sl[0].textContent.trim());
  ok("...ordered closest-first, as the view already sorted them",
     sl[0].querySelector(".sl-left").textContent.trim() === "2 to go", sl[0].textContent.trim());

  // The sections Sub asked to keep are there, and in his order.
  const headTitles = () => [...pool.querySelectorAll(".ra-h")].map((e) => {
    const first = e.querySelector("span");
    return (first ? first.textContent : e.textContent).trim();
  });
  {
    const h = headTitles();
    ok("the scoreboard and both Latest sections survive",
       h.length === 5 && h[2] === "This session"
       && h[3] === "Latest blueprints" && h[4] === "Latest missions", h.join(" | "));
    ok("...and what to go do next still leads",
       h[0] === "Closest to done" && !!pool.querySelector(".ss") && !!document.getElementById("raLatestArt"),
       h[0]);
  }

  panel.style.width = "";
  return out;
})()`;

// ── Suite: the contract board's calibration box ───────────────────────────────
// The ONLY way anyone but Sub can tell the scanner where the offers board is. Everything it can
// get wrong is invisible in a screenshot of a working app: it can draw a rectangle that isn't the
// one being cropped (a diagnostic that lies), render perfectly and refuse every drag (not in
// RSEL), outlive the mode that owns it, or warn about a second monitor when nothing is known yet.
//
// 🔑 Driven through PREFS + applyPrefs(), the real path — the region and the mode both arrive on
// the sidecar's broadcast. Nothing here POSTs, so the user's calibrated region is never touched.
// (No backticks and no backslash escapes anywhere in a suite body — this is a template literal.)
const BOARDBOX = `(async () => {
  ${PRELUDE}
  const box = document.getElementById("boardBox");
  ok("the calibration box exists", !!box);
  const regionHas = (el) => {
    const b = el.getBoundingClientRect();
    return (window.__regions || []).some((r) =>
      Math.abs(r.x - b.left) <= 1 && Math.abs(r.y - b.top) <= 1 &&
      Math.abs(r.w - b.width) <= 1 && Math.abs(r.h - b.height) <= 1);
  };

  PREFS.payoutScan = false; applyPrefs();
  await sleep(80);
  ok("with the mode off the outline is not on screen", getComputedStyle(box).display === "none");
  await sleep(180);
  ok("...and it claims no clickable region", !regionHas(box),
     JSON.stringify(window.__regions || []).slice(0, 120));

  // A region the sidecar would really send: the measured default.
  const F = { x: 0.175, y: 0.135, w: 0.19, h: 0.7 };
  PREFS.payoutRegion = F;
  PREFS.payoutScan = true; applyPrefs();
  await sleep(120);
  ok("arming the mode puts the outline on screen", getComputedStyle(box).display === "block");

  // 🔑 The whole point: the drawn rectangle IS the cropped one. capture.cjs multiplies these same
  // fractions by the captured display, so a box drawn from anything else would be a diagnostic
  // that points at the wrong part of the screen — worse than showing nothing at all.
  const ci = canvasInfo || { px: 0, py: 0, pw: innerWidth, ph: innerHeight };
  const r = box.getBoundingClientRect();
  const near = (a, b) => Math.abs(a - b) <= 1.5;
  ok("...drawn at exactly the fractions being cropped",
     near(r.left, ci.px + F.x * ci.pw) && near(r.top, ci.py + F.y * ci.ph) &&
     near(r.width, F.w * ci.pw) && near(r.height, F.h * ci.ph),
     Math.round(r.left) + "," + Math.round(r.top) + " " +
     Math.round(r.width) + "x" + Math.round(r.height) + " want " +
     Math.round(ci.px + F.x * ci.pw) + "," + Math.round(ci.py + F.y * ci.ph) + " " +
     Math.round(F.w * ci.pw) + "x" + Math.round(F.h * ci.ph));
  await sleep(180);
  ok("...and the shell is told to make the window interactive over it, so it can be dragged",
     regionHas(box), JSON.stringify(window.__regions || []).slice(0, 160));

  // Both controls must sit INSIDE the box's own reported rect. Outside it the shell hit-tests
  // nothing, the window flips back to click-through, and the click goes to the game — which is
  // exactly how the scan box's Reset was stranded when it hung above the top edge.
  const inside = (id) => {
    const el = document.getElementById(id); if (!el) return false;
    const c = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    return c.left >= b.left - 1 && c.right <= b.right + 1 &&
           c.top >= b.top - 1 && c.bottom <= b.bottom + 1;
  };
  ok("Hide sits inside the box, so it is actually clickable", inside("bbHide"));
  ok("Reset sits inside the box too", inside("bbReset"));

  // The second-monitor warning. Unknown is NOT the same as fine: before the first crop nothing is
  // known, and warning then would fire at everyone for the first seconds of every scan.
  const warn = document.getElementById("bbWarn");
  ok("no warning while it is unknown which display the game is on",
     getComputedStyle(warn).display === "none");
  PREFS.payoutOnPrimary = true; applyPrefs(); await sleep(60);
  ok("...none when the game IS on the primary", getComputedStyle(warn).display === "none");
  PREFS.payoutOnPrimary = false; applyPrefs(); await sleep(60);
  ok("...and it says so when the game is on another display",
     getComputedStyle(warn).display === "block" && /another display/i.test(warn.textContent),
     warn.textContent.slice(0, 60));

  // Hide is an outline control, not a mode control. Confusing the two is the bug the dashboard's
  // own X exists to avoid in the other direction: dismissing chrome must never quietly disarm a
  // screen-reader, and must never leave one armed with no visible sign of it either.
  document.getElementById("bbHide").click();
  await sleep(80);
  ok("Hide takes the outline away", getComputedStyle(box).display === "none");
  ok("...without disarming the scan", PREFS.payoutScan === true);
  ok("...and the panel is still up to say the screen is being read",
     getComputedStyle(document.getElementById("payoutPanel")).display === "flex");
  await sleep(180);
  ok("...and it gives its clickable region back", !regionHas(box),
     JSON.stringify(window.__regions || []).slice(0, 160));

  // A dismissal lasts the session, not forever: the next scan is a new decision.
  PREFS.payoutScan = false; applyPrefs(); await sleep(60);
  PREFS.payoutScan = true; applyPrefs(); await sleep(120);
  ok("starting a new scan brings the outline back", getComputedStyle(box).display === "block");

  PREFS.payoutScan = false; applyPrefs();
  await sleep(80);
  ok("the mode going off takes the outline with it", getComputedStyle(box).display === "none");
  return out;
})()`;

// ── Suite: the "scan read area" outline ───────────────────────────────────────
// The Mining Scanner cog can draw a box showing where the app reads for a signature. A
// diagnostic that lies is worse than none, so the drawn rect is asserted against the SAME
// fractions classifyScreen() searches — if that band ever moves, this fails instead of the box
// quietly pointing at the wrong part of the screen.
const SCANBOX = `(async () => {
  ${PRELUDE}
  const box = document.getElementById("scanBox");
  ok("the outline exists", !!box);
  // ⚠️ This suite drives the REAL control, which persists to the REAL sidecar config — including
  // a Reset. Remember whatever the user has calibrated and put it back at the end, or running the
  // tests silently destroys their scan region.
  // 🔑 Read it from the SIDECAR, not from this page's own scanRegion variable. That one is filled by
  // an async /api/config fetch which may not have landed yet, so the suite could capture null (or a
  // half-applied value), "restore" that at the end, and its own restore assertion would still pass
  // while the user's calibration quietly drifted a little on every run. It did drift.
  // (No backticks anywhere in a suite body — these are template literals, and one ends the string.)
  const cfg0 = await (await fetch("/api/config", { cache: "no-store" })).json();
  const userRegion = cfg0 && cfg0.scanRegion ? JSON.parse(JSON.stringify(cfg0.scanRegion)) : null;
  ok("the user's calibrated region was captured from the sidecar before touching anything",
     cfg0 != null, JSON.stringify(userRegion));
  // 🔑 Put the box in a KNOWN state before asserting on it. This used to assert display:none on
  // arrival, which is not a property of the code at all — it is a property of whoever last used
  // the app: the pref driving it is same-origin localStorage on localhost:8778, SHARED with the
  // real overlay window, so anyone who has the scan read area switched on failed here on a clean
  // tree. A test that reports the user's own settings as a defect hides real ones.
  // (setScanBox only toggles the body class; the pref itself is untouched, which is why this is
  // safe to call and why the later userPref capture still sees what the user actually chose.)
  setScanBox(false);
  await sleep(80);
  ok("...and hides when told to", getComputedStyle(box).display === "none");

  setScanBox(true);
  await sleep(150);
  const r = box.getBoundingClientRect();
  const ci = canvasInfo || { px: 0, py: 0, pw: innerWidth, ph: innerHeight };
  // Against the ACTIVE region, not the default: once a user has dragged theirs, the box is
  // supposed to follow it. Asserting the default here failed the moment Sub dragged his — the
  // test was wrong, not the box.
  const f = scanRegion || SCAN_DEFAULT;
  const want = {
    left: ci.px + f.x * ci.pw, right: ci.px + (f.x + f.w) * ci.pw,
    top: ci.py + f.y * ci.ph, bottom: ci.py + (f.y + f.h) * ci.ph,
  };
  const off = Math.max(Math.abs(r.left - want.left), Math.abs(r.right - want.right),
                       Math.abs(r.top - want.top), Math.abs(r.bottom - want.bottom));
  ok("it covers exactly the band the classifier searches", off <= 2,
     "max edge error " + off.toFixed(1) + "px");
  // It is a CONTROL while shown — you drag it to move the read area — so it has to take the
  // pointer, and the shell has to be told to make the window interactive over it or the drag
  // could never start.
  ok("...and is draggable while shown", getComputedStyle(box).pointerEvents === "auto");
  // 🔴 THIS ASSERTION USED TO BE A FALSE PASS, for months:
  //     typeof RSEL === "string" ? RSEL.includes("#scanBox") : "RSEL unreachable"
  // RSEL is block-scoped inside the page's own "if window.overlayApi" guard, so a suite reaching
  // for it gets undefined every time — and the "cannot measure" branch returned a non-empty
  // STRING, which ok() reads as true. Deleting #scanBox from RSEL left it green. Proven by doing
  // exactly that. (No backticks in a suite body — this whole block is a template literal.)
  // 🔑 The rule it taught: an assertion whose unmeasurable branch is truthy measures nothing.
  // Assert the rects the page actually SENDS the shell instead — captured by the stub preload as
  // window.__regions — which does go red when the selector is removed.
  await sleep(180);   // the region report is on a 100ms interval and only fires on a real change
  const b = box.getBoundingClientRect();
  const reported = (window.__regions || []).some((rg) =>
    Math.abs(rg.x - b.left) <= 1 && Math.abs(rg.y - b.top) <= 1 &&
    Math.abs(rg.w - b.width) <= 1 && Math.abs(rg.h - b.height) <= 1);
  ok("...so the shell is told to make the window interactive over it", reported,
     JSON.stringify(window.__regions || []).slice(0, 160));

  // Dragging it moves the REGION, not just the drawing — otherwise the box would be a diagnostic
  // that lies about where the app reads.
  const b0 = box.getBoundingClientRect();
  box.dispatchEvent(new PointerEvent("pointerdown", { clientX: b0.left + 20, clientY: b0.top + 20, bubbles: true }));
  box.dispatchEvent(new PointerEvent("pointermove", { clientX: b0.left + 80, clientY: b0.top + 50, bubbles: true }));
  await sleep(60);
  const b1 = box.getBoundingClientRect();
  ok("dragging moves it", Math.round(b1.left - b0.left) === 60 && Math.round(b1.top - b0.top) === 30,
     "moved " + Math.round(b1.left - b0.left) + "," + Math.round(b1.top - b0.top));
  box.dispatchEvent(new PointerEvent("pointerup", { clientX: b0.left + 80, clientY: b0.top + 50, bubbles: true }));
  await sleep(60);
  ok("...and that becomes the region the classifier is given", scanRegion != null,
     JSON.stringify(scanRegion));

  document.getElementById("sbReset").click();
  await sleep(80);
  const b2 = box.getBoundingClientRect();
  const defLeft = ci.px + SCAN_DEFAULT.x * ci.pw;
  ok("Reset puts it back to the DEFAULT band", scanRegion === null && Math.abs(b2.left - defLeft) < 2,
     "region=" + JSON.stringify(scanRegion) + " left=" + Math.round(b2.left) + " want=" + Math.round(defLeft));

  setScanBox(false);
  await sleep(100);
  ok("...and turns back off", getComputedStyle(box).display === "none");
  ok("...and stops taking the pointer once off", getComputedStyle(box).pointerEvents === "none");

  // ── it belongs to the Mining Scanner, so it goes when the scanner goes ────────
  // Closing the scanner (hotkey, hub, tray, or a stack bringing another member forward) used to
  // leave the dashed outline on the game with nothing left on screen to explain or remove it.
  // Pref is INVERTED now: miningScanBoxHidden, absent = shown (the box auto-shows with the
  // scanner). "on" therefore means REMOVING the hidden flag, not setting one.
  const userPref = localStorage.getItem("miningScanBoxHidden");
  localStorage.removeItem("miningScanBoxHidden");
  setWidgetVisible(WBY.mining, true);
  await sleep(120);
  syncScanBox();
  await sleep(60);
  ok("with the pref on and the scanner open, the outline is up", getComputedStyle(box).display === "block");
  setWidgetVisible(WBY.mining, false);   // exactly what the hotkey / hub toggle / ✕ do
  await sleep(120);
  ok("closing the Mining Scanner takes the outline with it", getComputedStyle(box).display === "none");
  ok("...without clearing the pref, so reopening restores it",
     localStorage.getItem("miningScanBoxHidden") !== "1");
  setWidgetVisible(WBY.mining, true);
  await sleep(120);
  ok("...and reopening brings it back", getComputedStyle(box).display === "block");
  localStorage.setItem("miningScanBoxHidden", "1");
  syncScanBox();
  await sleep(60);
  ok("the pref still wins on its own", getComputedStyle(box).display === "none");
  if (userPref === null) localStorage.removeItem("miningScanBoxHidden"); else localStorage.setItem("miningScanBoxHidden", userPref);

  // ── user-set opacity ─────────────────────────────────────────────────────────
  // Turning the box right down must never make it unreachable, so the floor is enforced in the
  // canvas rather than trusted from storage, and hover always returns it to full.
  const userOp = localStorage.getItem("miningScanBoxOpacity");
  const opNow = () => getComputedStyle(document.documentElement).getPropertyValue("--sb-op").trim();
  localStorage.setItem("miningScanBoxOpacity", "40");
  syncScanBox();
  await sleep(40);
  ok("the box takes the opacity you set", opNow() === "0.4", opNow());
  // A value below the floor (or a junk one) must be clamped, not obeyed: an invisible box cannot
  // be dragged, reset or hidden.
  localStorage.setItem("miningScanBoxOpacity", "0");
  syncScanBox();
  await sleep(40);
  ok("...but zero is clamped to the 10% floor", opNow() === "0.1", opNow());
  localStorage.setItem("miningScanBoxOpacity", "banana");
  syncScanBox();
  await sleep(40);
  ok("...and junk falls back to full", opNow() === "1", opNow());
  ok("hovering always restores it to full",
     [...document.styleSheets].some(sh => { try { return [...sh.cssRules].some(r => r.selectorText && r.selectorText.includes("#scanBox:hover")); } catch (e) { return false; } }));
  if (userOp === null) localStorage.removeItem("miningScanBoxOpacity"); else localStorage.setItem("miningScanBoxOpacity", userOp);
  syncScanBox();
  await sleep(40);

  // ── the number the OCR read, centered under the box ──────────────────────────
  // Just the number: Sub asked for it outside the box, centered, without the labels the first
  // version carried. A REFUSED read still has to show — a number the app threw away is exactly
  // the one worth seeing next to the real signature.
  localStorage.removeItem("miningScanBoxHidden");
  syncScanBox();
  await sleep(60);
  const val = document.getElementById("sbReadVal"), read = document.getElementById("sbRead");
  ok("nothing is shown before a read arrives", getComputedStyle(read).display === "none");
  showScanRead({ signature: 16000, raw: "16,000", box: { x: 0.5, y: 0.3, w: 0.03, h: 13 / 1440 },
                 verdict: "ore-or-debris", announced: true, used: true, why: "ore-or-debris, announced" });
  await sleep(60);
  ok("the read is shown", getComputedStyle(read).display === "flex", getComputedStyle(read).display);
  ok("...as the number and NOTHING else", val.textContent === "16,000", JSON.stringify(val.textContent));
  ok("...and the whole readout is just that one number",
     read.textContent.trim() === "16,000", JSON.stringify(read.textContent));
  // 🔑 Was sized off the OCR bbox, which made a refused read (big HUD lettering, measured 22-33px)
  // render at 31-46px — "way too big". One fixed, legible size now, whatever the bbox says.
  const fsBig = parseFloat(getComputedStyle(val).fontSize);
  showScanRead({ signature: 4001, raw: "4,001", box: { x: 0.5, y: 0.3, w: 0.2, h: 33 / 1440 },
                 verdict: "unknown", announced: true, used: true, why: "unknown, announced" });
  await sleep(60);
  ok("the size does NOT follow the OCR bbox", parseFloat(getComputedStyle(val).fontSize) === fsBig,
     fsBig + "px both times");
  // Sub, 2026-08-08: bigger. The old ceiling was 18px, set when the fear was a readout sized off a
  // refused read's big HUD lettering — that fear is handled by it being FIXED, not by it being
  // small. This still has to be a constant, so the assertion is on the range, not on the absence
  // of size.
  ok("...and is legible without following the bbox", fsBig >= 20 && fsBig <= 40, fsBig + "px");
  // TWO copies now — left and top. Both carry the same number so whichever is nearer the player's
  // eye does the work; a wide box put the single old readout far from what they were looking at.
  const val2 = document.getElementById("sbReadVal2");
  ok("there is a second copy of the readout", !!val2);
  ok("...showing the SAME number", val2 && val2.textContent === val.textContent,
     JSON.stringify(val2 && val2.textContent));
  const rTop = read.getBoundingClientRect(), rBox = box.getBoundingClientRect();
  const rLeft = val2.parentElement.getBoundingClientRect();
  const cBox = (b) => (b.left + b.right) / 2;
  ok("the top copy is centered on the box", Math.abs(cBox(rTop) - cBox(rBox)) <= 1,
     Math.round(cBox(rTop)) + " vs " + Math.round(cBox(rBox)));
  ok("...and sits OUTSIDE it, above", rTop.bottom <= rBox.top + 1,
     Math.round(rTop.bottom) + " vs " + Math.round(rBox.top));
  ok("the left copy sits OUTSIDE the box, to its left", rLeft.right <= rBox.left + 1,
     Math.round(rLeft.right) + " vs " + Math.round(rBox.left));
  ok("...and is vertically within the box's span",
     rLeft.top >= rBox.top - 1 && rLeft.bottom <= rBox.bottom + 1,
     Math.round(rLeft.top) + "-" + Math.round(rLeft.bottom));
  // A refused read is the diagnostic case: it must appear, and be tellable apart without words.
  showScanRead({ signature: 30000, raw: "3O,OOO", box: null, verdict: null, announced: false, used: false,
                 why: "ignored (above 25,800, the largest signature the game can show — misread)" });
  await sleep(60);
  ok("a REFUSED read is shown too", getComputedStyle(read).display === "flex" && val.textContent === "30,000",
     val.textContent);
  ok("...told apart by styling, not by more text", box.classList.contains("refused")
     && getComputedStyle(val).textDecorationLine === "line-through");
  ok("...and still says only the number", read.textContent.trim() === "30,000", JSON.stringify(read.textContent));
  // 🔑 A REPEAT read of the rock you are still looking at announces nothing but IS the live reading,
  // so it must not be struck through. Driving the strike off announced= instead of used= is what
  // Sub saw as "sometimes it just shows a crossed out number".
  showScanRead({ signature: 16000, raw: "16,000", box: null, verdict: "ore-or-debris",
                 announced: false, used: true, why: "already announced (unchanged since the last read)" });
  await sleep(60);
  ok("a re-read of the SAME rock is NOT struck through", !box.classList.contains("refused"),
     "announced=false, used=true");
  ok("...and a struck-through read means only one thing: it was not used",
     getComputedStyle(val).textDecorationLine === "none", getComputedStyle(val).textDecorationLine);
  if (userPref === null) localStorage.removeItem("miningScanBoxHidden"); else localStorage.setItem("miningScanBoxHidden", userPref);
  syncScanBox();

  // Hand the user's own calibration back — see the note at the top of this suite. Verified by
  // RE-READING the sidecar: asserting against this page's own variable is what let the drift hide.
  saveScanRegion(userRegion);
  await sleep(250);
  const cfg1 = await (await fetch("/api/config", { cache: "no-store" })).json();
  ok("the suite gave the user's region back, byte for byte",
     JSON.stringify((cfg1 && cfg1.scanRegion) || null) === JSON.stringify(userRegion),
     "was=" + JSON.stringify(userRegion) + " now=" + JSON.stringify((cfg1 && cfg1.scanRegion) || null));
  return out;
})()`;

// ── Suite 3: restore from a saved (and partly corrupt) layout ──────────────────
const RESTORE = `(async () => {
  ${PRELUDE}
  // The tracker is the app's main surface: a saved "closed" must NOT survive a launch, or the
  // app opens to an empty screen with no obvious way back (Sub, 2026-07-29 — "I don't care what
  // its last state was"). The stub layout deliberately has it closed.
  ok("the tracker re-opens even though the saved layout had it CLOSED",
     shown(WBY.blueprint) && WBY.blueprint.s.visible !== false,
     "visible=" + WBY.blueprint.s.visible + " bp-hidden=" + document.body.classList.contains("bp-hidden"));
  // ...and that override is ONLY for the tracker: everything else restores what it was.
  ok("...and other widgets still restore their own saved state",
     WBY.party.s.x === 900 && WBY.notepad.s.w === 320,
     "party.x=" + WBY.party.s.x + " notepad.w=" + WBY.notepad.s.w);

  ok("saved group restored", GROUPS.length === 1, GROUPS.map(g => g.id).join(",") || "none");
  const g = GROUPS[0];
  ok("ghost member dropped", g && !g.members.includes("doesNotExist"), g && g.members.join(","));
  ok("group left under 2 real members is discarded", !GROUPS.some(x => x.id === "gghost"));
  ok("1-member group discarded", !GROUPS.some(x => x.id === "glone"));
  ok("restored members correct", g && g.members.join(",") === "mining,party", g && g.members.join(","));
  ok("restored active honoured", g && g.active === "party", g && g.active);
  ok("only the active member is shown", shown(WBY.party) && !shown(WBY.mining));
  ok("widget freed from a dropped group is normal", shown(WBY.notepad) && !GROUPS.some(x => x.members.includes("notepad")));
  ok("members use the GROUP's box, not their own saved spot",
     cs(WBY.party, "--wx") === "250px" && cs(WBY.mining, "--wx") === "250px",
     "party=" + cs(WBY.party,"--wx") + " mining=" + cs(WBY.mining,"--wx"));
  ok("group width applied", cs(WBY.party, "--ww") === "500px", cs(WBY.party, "--ww"));
  ok("ungrouped widget keeps its own saved spot", cs(WBY.notepad, "--wx") === "500px", cs(WBY.notepad, "--wx"));
  const strip = el(WBY[GROUPS[0] ? GROUPS[0].active : "party"]).querySelector(".wh-tabs");
  ok("tab strip restored", !!strip);
  ok("tabs restored into the fronted member's bar", !!(strip && strip.querySelector(".gtab")));
  return out;
})()`;

// ── Suite 7: dragging + reset ─────────────────────────────────────────────────
// Sub's report: "when I move the cursor near another box, the one I'm dragging freezes, then
// jumps to catch up." Cause: neighbours are IFRAMES, and a pointer over an iframe delivers its
// moves to THAT document — this window simply stops hearing them. So the load-bearing assertion
// is that a full-canvas shield sits ABOVE every widget for the duration of the gesture. Plus the
// recovery path for a widget dragged off-screen: reset centres it, and the hub can fire that
// reset without the widget's own (unreachable) bar.
const DRAG = `(async () => {
  ${PRELUDE}
  const party = WBY.party, mining = WBY.mining;
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(300);
  const shield = document.getElementById("dragShield");
  ok("drag shield exists", !!shield);
  ok("shield is idle before a gesture", shield && getComputedStyle(shield).display === "none");

  // Grab party's bar and drag it across mining.
  const bar = el(party).querySelector(".whead");
  const r0 = bar.getBoundingClientRect();
  bar.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r0.left + 40, clientY: r0.top + 8 }));
  await sleep(20);
  ok("shield is up during a drag", getComputedStyle(shield).display !== "none");
  ok("body flags the drag", document.body.classList.contains("dragging"));
  // Over a neighbour, the shield — not that widget's iframe — must be what the cursor hits.
  const mr = el(mining).getBoundingClientRect();
  const hit = document.elementFromPoint(mr.left + mr.width / 2, mr.top + mr.height / 2);
  ok("the shield covers a neighbouring widget", hit === shield, hit && (hit.id || hit.tagName));
  // ...and moves keep arriving in THIS document, which is what the freeze was.
  const x0 = party.s.x;
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r0.left + 40 + 120, clientY: r0.top + 8 }));
  await sleep(20);
  ok("the widget tracks the pointer over a neighbour", party.s.x === x0 + 120, party.s.x + " vs " + (x0 + 120));
  // Every bar is out while dragging, so the drop target is something you can see.
  ok("neighbour bars come out as drop targets",
     getComputedStyle(el(mining).querySelector(".whead")).transform.replace(/ /g, "") === "matrix(1,0,0,1,0,0)",
     getComputedStyle(el(mining).querySelector(".whead")).transform);
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await sleep(20);
  ok("shield drops on pointerup", getComputedStyle(shield).display === "none");
  ok("drag flag cleared", !document.body.classList.contains("dragging"));

  // Reset = the MIDDLE of the primary monitor, not the registry's starting spot: the whole point
  // is recovering a widget you can no longer reach.
  const ci = canvasInfo || { pw: window.innerWidth, ph: window.innerHeight };
  party.s.x = -4000; party.s.y = 9000; party.s.w = 800; applyFrame(party);
  resetWidget(party);
  ok("reset centres horizontally", party.s.x === Math.round((ci.pw - party.size.w) / 2), party.s.x);
  ok("reset centres vertically", party.s.y === Math.round((ci.ph - party.size.h) / 2), party.s.y);
  ok("reset drops the custom size", party.s.w === null && party.s.h === null);

  // Hub: a reset per widget, right-aligned, and clicking it must NOT toggle that widget's
  // checkbox (which is what a button inside the row's <label> would have done).
  document.getElementById("hub").classList.add("open"); // it's display:none until the cog opens it
  await sleep(20);
  const rows = [...document.querySelectorAll("#hub .hub-row.tog")];
  // Every TOGGLEABLE widget gets a hub row. Settings is the deliberate exception: it is not a
  // widget you switch on in the list, it is a panel you open from "Open settings" (and the
  // tray), which merely happens to render as a widget so it can be placed, sized and skinned.
  // Asserted by name rather than as a bare count-1, so a row going missing still fails.
  const HUBLESS = ["config"];
  const toggleable = WIDGETS.filter(w => !HUBLESS.includes(w.key));
  ok("every toggleable widget has a hub row with a reset", rows.length === toggleable.length
     && rows.every(r => r.querySelector(".hub-reset")), rows.length + " rows for " + toggleable.length + " toggleable");
  ok("Settings is deliberately absent from the hub list",
     !document.querySelector('#hub .hub-reset[data-w="config"]'));
  ok("every reset names a real widget",
     [...document.querySelectorAll("#hub .hub-reset")].every(b => !!WBY[b.dataset.w]));
  const mRow = document.querySelector('#hub .hub-reset[data-w="mining"]').closest(".hub-row");
  const mBtn = mRow.querySelector(".hub-reset"), mChk = mRow.querySelector("input[type=checkbox]");
  ok("the reset sits right of the checkbox",
     mBtn.getBoundingClientRect().left > mChk.getBoundingClientRect().right,
     Math.round(mBtn.getBoundingClientRect().left) + " > " + Math.round(mChk.getBoundingClientRect().right));
  ok("the reset is flush right in the row",
     Math.abs(mRow.getBoundingClientRect().right - mBtn.getBoundingClientRect().right) < 20,
     Math.round(mRow.getBoundingClientRect().right - mBtn.getBoundingClientRect().right) + "px from the edge");
  // The column is HEADED, because a bare circular arrow reads as "refresh" and refreshing a widget
  // is a plausible-sounding action that does not exist. The header only works if it sits over the
  // buttons it names, so assert the alignment rather than just the text.
  const hdr = [...document.querySelectorAll("#hub .hub-sec.cols span")].pop();
  ok("the reset column is headed", hdr && hdr.textContent.trim() === "Reset", hdr && hdr.textContent);
  ok("...and the header sits over the reset buttons", hdr
     && Math.abs(hdr.getBoundingClientRect().right - mBtn.getBoundingClientRect().right) < 12,
     hdr && Math.round(hdr.getBoundingClientRect().right - mBtn.getBoundingClientRect().right) + "px off");
  const wasChecked = mChk.checked;
  mining.s.x = -4000; mining.s.y = 9000; applyFrame(mining);
  mBtn.click();
  await sleep(20);
  ok("hub reset recentres its widget", mining.s.x === Math.round((ci.pw - mining.size.w) / 2), mining.s.x);
  ok("hub reset leaves the on/off checkbox alone", mChk.checked === wasChecked);

  // Section headings: Layout means layout. Settings + patch notes are not that.
  const secOf = (id) => { let n = document.getElementById(id); while (n && !(n.classList && n.classList.contains("hub-sec"))) n = n.previousElementSibling; return n && n.textContent.trim(); };
  ok("Arrange is under Layout", secOf("hubArrange") === "Layout", secOf("hubArrange"));
  ok("full settings is NOT under Layout", secOf("hubSettings") !== "Layout", secOf("hubSettings"));
  ok("patch notes is NOT under Layout", secOf("hubWhatsNew") !== "Layout", secOf("hubWhatsNew"));
  return out;
})()`;

// ── Suite 8: the embedded pages' own headers ──────────────────────────────────
// The widget bar names the widget, so a page that ALSO carries its name says it twice (Mining
// did — it kept an old eyebrow through the header refactor). And a page's header controls belong
// on the right, opposite the title.
const HEADERS = `(async () => {
  ${PRELUDE}
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(900); // iframes have to load and lay out before anything can be measured
  const docOf = (k) => { try { return document.getElementById("wf-" + k).contentDocument; } catch { return null; } };

  for (const w of WIDGETS) {
    if (w.local) continue;
    const d = docOf(w.key); if (!d || !d.querySelector(".head")) continue;
    const heads = [...d.querySelectorAll(".head")].filter(h => h.offsetParent !== null || d.defaultView.getComputedStyle(h).display !== "none");
    const txt = heads.map(h => h.textContent).join(" ").toLowerCase();
    const n = txt.split(w.title.toLowerCase()).length - 1;
    ok(w.title + ": names itself at most once in its header", n <= 1, n + "x");
  }

  // Notepad's text-size stepper and ＋ New sit at the RIGHT edge of the header (Sub, 2026-07-25).
  const nd = docOf("notepad");
  const nhead = nd.querySelector(".head.list-only");
  const title = nhead.querySelector(".h-title").getBoundingClientRect();
  const fsz = nhead.querySelector(".fsz").getBoundingClientRect();
  const nb = nd.getElementById("newBtn").getBoundingClientRect();
  const hr = nhead.getBoundingClientRect();
  ok("notepad: controls are right of the title", fsz.left > title.right + 20, Math.round(fsz.left - title.right) + "px gap");
  ok("notepad: ＋ New is flush right", Math.abs(hr.right - nb.right) < 20, Math.round(hr.right - nb.right) + "px from the edge");
  ok("notepad: text stepper and ＋ New share the row", Math.abs(fsz.top - nb.top) < 12 && fsz.right <= nb.left + 1);
  return out;
})()`;

// ── Suite 9: chrome anchoring + the header latch ──────────────────────────────
// Three bugs Sub hit in one sitting, all from the Blueprint panel being #panel rather than a
// .widget, or from the page not being told something only the shell knows.
const ANCHOR = `(async () => {
  ${PRELUDE}
  const panel = document.getElementById("panel");
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(400);

  // 1. The panel's bar carries a group's TABS, so grouping must pin it out exactly like any
  //    other member's. Every ".widget.grouped" rule needs its "#panel.grouped" twin.
  // Dropped-onto-other = the one that fronts, so this is the panel fronting a stack — the case
  // that broke. (The reverse, Battaglia fronting, is just another .widget and already covered.)
  groupWidgets(WBY.blueprint, WBY.battaglia);
  await sleep(60);
  // (this preload restores a saved mining+party group too, so find the panel's own)
  const bg = GROUPS.find((x) => x.members.includes("blueprint"));
  ok("the panel is the fronted member", bg && bg.active === "blueprint", bg && bg.active);
  ok("grouping the panel flags it", panel.classList.contains("grouped"));
  const pbar = panel.querySelector(".whead");
  ok("the panel's bar stays out while grouped",
     getComputedStyle(pbar).transform.replace(/ /g, "") === "matrix(1,0,0,1,0,0)",
     getComputedStyle(pbar).transform);
  ok("its tabs are rendered", panel.querySelectorAll(".wh-tabs .gtab").length >= 2,
     panel.querySelectorAll(".wh-tabs .gtab:not(.gdetach)").length + " tabs");
  // The shell only hit-tests rects matching RSEL, so a bar that isn't in that list is unclickable.
  ok("the grouped panel's bar is a reportable region", !!document.querySelector("#panel.grouped .whead"));
  detachFromGroup(WBY.blueprint);
  await sleep(30);

  // 1b. The GROUP HERE drop highlight, both kinds of widget. highlightDrop() sets .droptarget on
  //     whatever you are dragging onto, and the rule was ".widget.droptarget" only — so dragging
  //     onto the tracker (which is #panel, not .widget) showed nothing at all, on the one widget
  //     people aim at most. Asserted via the ::after content because that IS the affordance.
  const groupHere = (w) => {
    const bar = el(w).querySelector(".whead");
    return getComputedStyle(bar, "::after").content.replace(/"/g, "");
  };
  highlightDrop(WBY.notepad);
  await sleep(30);
  ok("an iframe widget shows GROUP HERE", groupHere(WBY.notepad) === "GROUP HERE", groupHere(WBY.notepad));
  highlightDrop(WBY.blueprint);
  await sleep(30);
  ok("...and so does the tracker panel", groupHere(WBY.blueprint) === "GROUP HERE", groupHere(WBY.blueprint));
  highlightDrop(null);
  await sleep(30);
  ok("clearing the target removes it", groupHere(WBY.blueprint) !== "GROUP HERE", groupHere(WBY.blueprint));

  // 2. The cog lives in the BOTTOM bar, so its menu has to open down there — it was anchored
  //    inside .head (position:relative) and opened at the TOP of the panel instead.
  const menu = document.getElementById("cogMenu");
  ok("the cog menu hangs off the panel, not the header", menu.parentElement === panel, menu.parentElement.className || menu.parentElement.id);
  menu.classList.add("open");
  await sleep(30);
  const pr = panel.getBoundingClientRect(), mr = menu.getBoundingClientRect();
  ok("it opens at the panel's bottom", mr.bottom > pr.top + pr.height / 2,
     Math.round(mr.bottom - pr.top) + "px down a " + Math.round(pr.height) + "px panel");
  ok("...flush with the bottom edge", Math.abs(pr.bottom - mr.bottom) < 24, Math.round(pr.bottom - mr.bottom) + "px up from it");
  ok("...and beside the cog, on the right", Math.abs(pr.right - mr.right) < 24, Math.round(pr.right - mr.right) + "px in from it");
  ok("it can't outgrow the screen", mr.height <= window.innerHeight * 0.8, Math.round(mr.height) + "px");
  menu.classList.remove("open");

  // 3. Any page with a text field reveals its bar on pointerdown (hover can't see through an
  //    iframe). Nothing was clearing that latch when the cursor went back to the GAME, because a
  //    click-through window gets no mouseleave — so the bar never retracted.
  const np = WBY.notepad;
  touchWidget(np);
  ok("clicking into a widget reveals its bar", el(np).classList.contains("touched"));
  ok("the page listens for the shell's cursor-away", typeof window.__fireCursorAway === "function");
  if (typeof window.__fireCursorAway === "function") window.__fireCursorAway();
  await sleep(30);
  ok("the bar retracts once the cursor leaves the overlay", !el(np).classList.contains("touched"));
  return out;
})()`;

// ── Suite 10: lifecycle — a closed widget must cost nothing ───────────────────
// Sub's rule: if a widget isn't open it shouldn't be using resources. Hiding used to leave the
// iframe loaded, so a widget opened once kept polling / holding its socket forever — and mining
// kept ANNOUNCING from a box that wasn't on screen, because the one path that backgrounds a group
// tab never told the page it had gone dark.
const LIFECYCLE = `(async () => {
  ${PRELUDE}
  const party = WBY.party, mining = WBY.mining, notepad = WBY.notepad;
  const src = (w) => { const f = document.getElementById("wf-" + w.key); return f ? (f.getAttribute("src") || "") : "(none)"; };
  const loaded = (w) => /\\.html/.test(src(w));

  setWidgetVisible(party, true);
  await sleep(200);
  ok("opening a widget loads its page", loaded(party), src(party).slice(0, 40));

  setWidgetVisible(party, false);
  await sleep(120);
  ok("closing it unloads the page", !loaded(party), src(party).slice(0, 40));
  ok("...and it is no longer armed", !party.armed);

  setWidgetVisible(party, true);
  await sleep(200);
  ok("reopening loads it again", loaded(party), src(party).slice(0, 40));

  // Count the visibility signals the page receives. This is what mining listens to for its
  // "hidden => no sound" rule, so a missed call is an audible bug.
  let hides = 0, shows = 0;
  const oh = mining.onHide, os = mining.onShow;
  mining.onHide = (w) => { hides++; if (oh) oh(w); };
  mining.onShow = (w) => { shows++; if (os) os(w); };
  // (it starts visible in this harness, and re-showing a shown widget correctly signals nothing —
  //  so hide it first, which is also the signal mining relies on to go quiet)
  setWidgetVisible(mining, false);
  await sleep(120);
  ok("hiding a widget tells the page", hides >= 1, hides);
  setWidgetVisible(mining, true);
  await sleep(250);
  ok("showing it tells the page", shows >= 1, shows);

  // Backgrounding it as a group TAB is the case that was silently missed.
  groupWidgets(party, mining);
  await sleep(80);
  ok("the tabbed-away widget is off screen", !shown(mining), "display=" + (document.getElementById("w-mining").style.display || "(shown)"));
  ok("...and the page was TOLD it went dark", hides >= 2, hides + " hide signals");
  ok("...but keeps its iframe (state survives tabbing)", loaded(mining), src(mining).slice(0, 40));

  // Bringing it back to the front must say so again.
  const before = shows;
  const strip = document.getElementById("w-party").querySelector(".wh-tabs")
    || document.getElementById("w-mining").querySelector(".wh-tabs");
  strip.querySelector('.gtab[data-k="mining"]').click();
  await sleep(80);
  ok("fronting the tab tells the page it is visible again", shows > before, shows);
  mining.onHide = oh; mining.onShow = os;

  // An ARMED widget (mining waiting to auto-show) must stay loaded even while hidden.
  detachFromGroup(WBY[GROUPS[0] ? GROUPS[0].active : "mining"]);
  mining.keepLoaded = true;
  setWidgetVisible(mining, false);
  await sleep(120);
  ok("an armed widget stays loaded while hidden", loaded(mining), src(mining).slice(0, 40));
  mining.keepLoaded = false;
  setWidgetVisible(mining, false);
  await sleep(120);
  ok("...and unloads once it is no longer armed", !loaded(mining), src(mining).slice(0, 40));
  return out;
})()`;

// ── Suite: hiding a typing widget releases the keyboard grab ──────────────────
// editStart() arms a canvas-WIDE grab (notepadEditing → canHover everywhere) and hiding a widget
// UNLOADS its iframe — so a widget hidden mid-typing must release the grab on the way out, or it
// leaks with no page left to lower it. notepad/party/chat always did this via onHide; twitchChat
// and webView defined the release function and the canvas never called it. Negative-controlled:
// removing twitchChat's onHide turns "hiding it releases the grab" red.
// ── Suite: Verse Finder — the honesty rules, on screen ───────────────────────
// Drives the REAL page against the LIVE sidecar, because every rule here is about what the player
// actually reads. The assertions are the constraints Sub set, not the plumbing:
//   · a result names its TERMINAL and never just a price;
//   · every shop row carries the age of its OWN reading;
//   · a multi-shop item shows the spread rather than one confident number;
//   · the footer says which tier the table came from, and that stock is unknowable.
// Negative-controlled three ways — see the commit message.
// ── Suite: the Event Tracker must SAY when its reward table is a fallback ───────────────────
// The tiers and rewards are fetched from subliminal.gg (src/event-feed.ts) so a reward confirmed
// mid-event reaches players without an app release. The corollary is Sub's standing requirement:
// when that fetch is failing, the player has to be able to tell that the ladder they are reading
// is the one the build shipped with, rather than reading "Reward not known yet" as fact.
const EVENTFEED = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);

  const cav = window.__eventFeedCaveat;
  ok("the caveat hook exists", typeof cav === "function", typeof cav);
  // Defensive: a detail expression is evaluated EAGERLY, so a throw here would kill the suite
  // and report it as a small pass. Never reach into the result without wrapping.
  const txt = (f) => { try { return String(cav(f) || ""); } catch (e) { return "(threw: " + (e && e.message) + ")"; } };

  // POSITIVE FIRST. Every assertion below is "says nothing", and those are all satisfied for
  // free by a function that has stopped speaking at all — so the case that MUST speak is the
  // one that tells a working guard apart from a dead one.
  const shipped = txt({ source: "bundled", revision: 1, fetchedAt: null, checkedAt: 1, lastError: "fetch failed" });
  ok("bundled + unreachable site DOES warn", shipped.length > 0, JSON.stringify(shipped));
  ok("...and says the list is the one the app shipped with", shipped.indexOf("shipped with") >= 0, JSON.stringify(shipped));
  ok("...in the gold warn style, not as body text", shipped.indexOf("evwarn") >= 0, JSON.stringify(shipped));

  const staleCache = txt({ source: "cache", revision: 4, fetchedAt: Date.now() - 3 * 3600 * 1000, checkedAt: Date.now(), lastError: "fetch failed" });
  ok("a downloaded list that has gone stale DOES warn", staleCache.length > 0, JSON.stringify(staleCache));
  ok("...and says HOW OLD it is, which is the part that lets a player judge it",
     staleCache.indexOf("hours ago") >= 0, JSON.stringify(staleCache));

  // Now the silences, each of which is only meaningful because the two cases above speak.
  ok("a healthy live fetch says nothing",
     txt({ source: "live", revision: 4, fetchedAt: Date.now(), checkedAt: Date.now(), lastError: null }) === "",
     JSON.stringify(txt({ source: "live", revision: 4, fetchedAt: Date.now(), checkedAt: Date.now(), lastError: null })));
  ok("a healthy cache replay says nothing",
     txt({ source: "cache", revision: 4, fetchedAt: Date.now(), checkedAt: Date.now(), lastError: null }) === "");
  // Before the first check returns, "bundled" is the normal transient state. Crying wolf there
  // would put a permanent warning on every cold start for the second it takes to fetch.
  ok("bundled BEFORE the first check has returned says nothing",
     txt({ source: "bundled", revision: 1, fetchedAt: null, checkedAt: null, lastError: null }) === "");
  ok("no feed at all says nothing", txt(null) === "");

  // ── And it must actually REACH the panel. A pure function nobody renders is not a warning. ──
  // Stub the sidecar so the feed state is KNOWN: the live one is whatever this machine's network
  // is doing, which is not something an assertion can pin.
  const realFetch = window.fetch;
  window.fetch = async (u, o) => {
    const s = String(u);
    if (s.indexOf("/api/events") >= 0) {
      return new Response(JSON.stringify({
        feed: { source: "bundled", revision: 1, fetchedAt: null, checkedAt: 1, lastError: "fetch failed" },
        events: [{ id: "suite-event", label: "Suite Event", log: "Suite Event", status: "current",
                   total: 1000, points: 150, pct: 15, unpriced: 0, contributions: [],
                   rewardsUnknown: false,
                   tiers: [{ pct: 15, points: 150, reached: true, rewards: [{ name: "SUITE REWARD", item: null, owned: false }] }] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(u, o);
  };
  await window.__battReload();
  await sleep(150);

  const tabs = [...document.querySelectorAll("#vnav .vt")];
  const evTab = tabs.find((b) => b.textContent === "Suite Event");
  ok("the stubbed event gets a tab", !!evTab, tabs.map((b) => b.textContent).join(" | "));
  if (evTab) evTab.click();
  await sleep(150);

  const metaEl = document.querySelector("#body .evmeta");
  const meta = metaEl ? metaEl.textContent : "(no .evmeta element)";
  ok("the event panel rendered its meta block", !!metaEl, meta);
  ok("the fallback warning is ON SCREEN, not merely computable",
     meta.indexOf("shipped with") >= 0, meta);
  ok("...and it is styled as a warning in the rendered DOM",
     !!(metaEl && metaEl.querySelector(".evwarn")), meta);
  // The caveat must be an ADDITION, not a replacement — the existing honesty lines still matter.
  ok("the Journal advice survives beside it", meta.indexOf("in-game Journal") >= 0, meta);

  window.fetch = realFetch;
  return out;
})()`;

// ── Suite: the tier-reward question, and the line between a sighting and a rumour ──────────
// `events.json` knows ONE of Siege of Orison's six rewards. The other five fill themselves from
// this card. What must never happen is a rumour rendering as a fact: the candidate names come
// from a viewer relaying a chatbot answer, and inside this question is the ONLY place they may
// appear, because answering is what promotes one to a measurement.
//
// ⚠️ The keyboard-grab half is NOT asserted here and that is deliberate: this suite loads
// battaglia.html standalone, where there is no host bridge, so `editStart()` is never reached
// and any grab assertion would pass for free. It lives in `typing grab: hiding releases it`,
// which drives the real canvas.
const REWARDCARD = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);

  // Defensive: a detail expression is evaluated EAGERLY, so a throw there kills the suite and
  // reports it as a small pass. Never reach into an element without a fallback.
  const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent : "(missing " + sel + ")"; };
  const btns = () => [...document.querySelectorAll("#rwrow .rwbtn")].map((b) => b.textContent);
  const shown = () => { const c = document.getElementById("rwcard"); return !!c && !c.hidden && getComputedStyle(c).display !== "none"; };

  // Stub the sidecar so the prompt state is KNOWN. The live one depends on whether anybody has
  // crossed a tier on this machine, which is not something an assertion can pin.
  const realFetch = window.fetch;
  const posted = [];
  let promptState = null;
  window.fetch = async (u, o) => {
    const s = String(u);
    // Model the sidecar: answering marks the prompt answered, so the very next /api/events
    // stops offering it. A stub that keeps serving an answered prompt would make the card
    // reappear on the load() that follows an answer, which is a fault in the stub and not in
    // the widget - the real server clears it.
    if (s.indexOf("/api/events/reward") >= 0) { posted.push(JSON.parse(o.body)); promptState = null; return new Response("{}", { status: 200 }); }
    if (s.indexOf("/api/events") >= 0) {
      return new Response(JSON.stringify({
        feed: { source: "live", revision: 1, fetchedAt: Date.now(), checkedAt: Date.now(), lastError: null },
        reporting: true,
        rewardPrompt: promptState,
        events: [{ id: "suite-event", label: "Suite Event", log: "Suite Event", status: "current",
                   total: 1000, points: 250, pct: 25, unpriced: 0, contributions: [], rewardsUnknown: true,
                   tiers: [{ pct: 25, points: 250, reached: true, rewards: [] }] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(u, o);
  };
  const mk = (over) => Object.assign({
    id: "suite-event:25", eventId: "suite-event", eventLabel: "Suite Event", tier: 25,
    crossedAt: "2026-08-22T00:00:00Z", crossedAtMs: Date.now(),
    observed: null, candidate: null, answer: null, reported: false,
  }, over);
  const drive = async (p) => { promptState = p; await window.__battReload(); await sleep(160); };

  // ── No prompt: no card. The POSITIVE cases follow, and they are what make this meaningful. ──
  await drive(null);
  ok("with nothing due the card is not shown", !shown());

  // ── 1. The app SAW it. One click, and the copy says it was seen. ──
  await drive(mk({ observed: "S-38 SecondWind Pistol", candidate: "SOME OTHER GUESS" }));
  ok("a due prompt shows the card", shown());
  ok("...naming the tier crossed", txt("#rwq").indexOf("25%") >= 0, txt("#rwq"));
  ok("...and the event", txt("#rwq").indexOf("Suite Event") >= 0, txt("#rwq"));
  ok("the OBSERVED name is what is offered, not the candidate",
     txt(".rwname") === "S-38 SecondWind Pistol", txt(".rwname"));
  // 🔴 The line this suite exists for, half one: a sighting must SAY it was seen.
  ok("...and the caption says the app SAW it arrive",
     txt(".rwsrc").indexOf("saw this arrive") >= 0, txt(".rwsrc"));
  ok("...and does NOT call a sighting unconfirmed",
     txt(".rwsrc").indexOf("UNCONFIRMED") < 0, txt(".rwsrc"));
  ok("it is a one-click confirmation", btns().indexOf("Yes") >= 0, btns().join(" | "));
  ok("...with a way to disagree", btns().some((b) => b.indexOf("No") === 0), btns().join(" | "));

  document.querySelectorAll("#rwrow .rwbtn")[0].click();
  await sleep(120);
  ok("Yes posts an answer", posted.length === 1, String(posted.length));
  ok("...reporting the OBSERVED name", posted[0] && posted[0].name === "S-38 SecondWind Pistol", JSON.stringify(posted[0]));
  // 🔑 Agreeing with a SIGHTING had two independent witnesses; agreeing with a guess had one.
  // The site weights them differently, so the app must not collapse them into one word.
  ok("...as source=confirmed, because the log witnessed it", posted[0] && posted[0].source === "confirmed", JSON.stringify(posted[0]));
  ok("answering hides the card", !shown());

  // ── 2. Only a CANDIDATE. Still one click, but it must not read as a fact. ──
  posted.length = 0;
  await drive(mk({ id: "suite-event:43", tier: 43, observed: null, candidate: "FBL-8a (Modified) armor set" }));
  ok("a candidate-only prompt still shows the card", shown());
  ok("the candidate is the name offered", txt(".rwname") === "FBL-8a (Modified) armor set", txt(".rwname"));
  // 🔴 The line this suite exists for, half two.
  ok("🔴 a candidate is labelled UNCONFIRMED in words",
     txt(".rwsrc").indexOf("UNCONFIRMED") >= 0, txt(".rwsrc"));
  ok("...and is never described as something the app saw",
     txt(".rwsrc").indexOf("saw this arrive") < 0, txt(".rwsrc"));
  document.querySelectorAll("#rwrow .rwbtn")[0].click();
  await sleep(120);
  // Agreeing with a guess is NOT a confirmed sighting — there was one witness, the player.
  ok("agreeing with a guess is NOT recorded as a witnessed confirmation",
     posted[0] && posted[0].source !== "confirmed", JSON.stringify(posted[0]));

  // ── 3. Nothing observed, no candidate. An open question with no Yes to press. ──
  posted.length = 0;
  await drive(mk({ id: "suite-event:57", tier: 57, observed: null, candidate: null }));
  ok("a blind prompt still shows the card", shown());
  ok("...and offers NO name, because there is nothing to offer",
     !document.querySelector(".rwname"), txt(".rwname"));
  // A Yes here would be agreeing with nothing.
  ok("...and offers no Yes button", btns().indexOf("Yes") < 0, btns().join(" | "));
  ok("...it opens straight into a text field", !!document.getElementById("rwtext"), btns().join(" | "));
  // 🔑 "I got nothing" is a real ANSWER — a tier granting no blueprint is a thing that can be
  // true, and no amount of waiting for a positive report would ever establish it.
  ok("...and 'I got nothing' is offered as an ANSWER", btns().indexOf("I got nothing") >= 0, btns().join(" | "));

  const box = document.getElementById("rwtext");
  box.value = "WHAT I ACTUALLY GOT";
  [...document.querySelectorAll("#rwrow .rwbtn")].find((b) => b.textContent === "Send").click();
  await sleep(120);
  ok("a typed answer is posted", posted.length === 1 && posted[0].name === "WHAT I ACTUALLY GOT", JSON.stringify(posted[0]));
  ok("...as source=typed", posted[0] && posted[0].source === "typed", JSON.stringify(posted[0]));

  // ── 4. Dismissing is not answering. ──
  posted.length = 0;
  await drive(mk({ id: "suite-event:80", tier: 80, observed: "SOMETHING", candidate: null }));
  ok("(control) the card is up before dismissing", shown());
  document.getElementById("rwx").click();
  await sleep(80);
  ok("dismissing hides the card", !shown());
  ok("dismissing posts NOTHING — it is not an answer", posted.length === 0, String(posted.length));

  // ── 5. Expiry is derived from the CROSSING, not from when the card was drawn. ──
  // A poll can deliver a prompt most of the way through its two minutes; a timer started on
  // render would then give it a fresh two minutes every refresh and it would never retire.
  await drive(mk({ id: "suite-event:100", tier: 100, crossedAtMs: Date.now() - 10 * 60 * 1000 }));
  await sleep(1200);   // the 1s countdown tick has to run at least once
  ok("a prompt whose two minutes elapsed retires itself", !shown());

  // ── 6. Reporting is opt-in, and the footer must not overclaim. ──
  window.fetch = async (u, o) => {
    const s = String(u);
    // Model the sidecar: answering marks the prompt answered, so the very next /api/events
    // stops offering it. A stub that keeps serving an answered prompt would make the card
    // reappear on the load() that follows an answer, which is a fault in the stub and not in
    // the widget - the real server clears it.
    if (s.indexOf("/api/events/reward") >= 0) { posted.push(JSON.parse(o.body)); promptState = null; return new Response("{}", { status: 200 }); }
    if (s.indexOf("/api/events") >= 0) {
      return new Response(JSON.stringify({
        feed: { source: "live", revision: 1, fetchedAt: Date.now(), checkedAt: Date.now(), lastError: null },
        reporting: false,
        rewardPrompt: mk({ id: "suite-event:15", tier: 15, observed: "SEEN" }),
        events: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(u, o);
  };
  await window.__battReload();
  await sleep(160);
  ok("(control) the card is up with reporting off", shown());
  ok("with reporting OFF the footer does not claim the answer helps everyone",
     txt("#rwfoot").indexOf("for everyone") < 0, txt("#rwfoot"));
  ok("...and says how to turn sharing on", txt("#rwfoot").indexOf("Settings") >= 0, txt("#rwfoot"));

  window.fetch = realFetch;
  return out;
})()`;

// ── Suite: the event ladder — Orison first, the guesses visible, and labelled as guesses ─────
//
// Three things Sub asked for on 2026-08-22, looking at this widget: put Siege of Orison first,
// show the rewards (five of six tiers read "Reward not known yet" while events.json held a
// candidate name for every one of them), and stop the ladder inventing precision it does not have.
//
// ⚠️ EVERY VALUE BELOW IS THE SUITE'S OWN. data/events.json is a live research artefact — it has
// already turned tests red twice by being edited, once on `contracts` and once on `rewards` — so
// this drives a stubbed /api/events and reads nothing off the shipped file. Tiers and totals are
// the same kind of value and are next.
const EVENTLADDER = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);

  const FIX = {
    feed: { source: "live", revision: 9, fetchedAt: Date.now(), checkedAt: Date.now(), lastError: null },
    reporting: true,
    rewardPrompt: null,
    events: [{
      id: "suite-orison", label: "Suite Orison", log: "Suite Orison", status: "current",
      total: 1000, points: 150, pct: 15, unpriced: 0,
      contractsPriced: 2, contractsKnown: 7,
      contributions: [], rewardsUnknown: false,
      tiers: [
        { pct: 15, points: 150, reached: true,
          rewards: [{ name: "SUITE MEASURED PISTOL", item: null, owned: true }], candidates: [] },
        { pct: 40, points: 400, reached: false,
          rewards: [], candidates: [{ name: "SUITE CANDIDATE ARMOR" }] },
        { pct: 90, points: 900, reached: false, rewards: [], candidates: [] },
      ],
    }],
  };

  const realFetch = window.fetch;
  let posted = null;
  window.fetch = async (u, o) => {
    const s = String(u);
    // Ordered: the reward path contains the events path, so it has to be tested first.
    if (s.indexOf("/api/events/reward") >= 0) {
      posted = JSON.parse(o && o.body ? o.body : "{}");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (s.indexOf("/api/events") >= 0) {
      return new Response(JSON.stringify(FIX), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(u, o);
  };
  await window.__battReload();
  await sleep(250);

  // Defensive readers: a detail expression is evaluated EAGERLY, so reaching into an element that
  // is not there kills the suite and reports it as a small pass.
  const tabs = () => [].slice.call(document.querySelectorAll("#vnav .vt"));
  const labels = () => tabs().map((b) => b.textContent);
  const txt = (sel) => { const n = document.querySelector(sel); return n ? n.textContent : "(no " + sel + ")"; };
  const bodyTxt = () => txt("#body");

  // ── 1. Siege of Orison first, and SELECTED. Order alone would be cosmetic. ──
  ok("the event gets a tab at all", labels().indexOf("Suite Orison") >= 0, labels().join(" | "));
  ok("both views are offered", tabs().length === 2, labels().join(" | "));
  ok("🔴 the event is the FIRST tab, ahead of the giver track", labels()[0] === "Suite Orison", labels().join(" | "));
  ok("🔴 ...and it is the one SELECTED on load", !!tabs()[0] && tabs()[0].classList.contains("on"), labels().join(" | "));
  ok("...which is what the header shows", txt("#who") === "Suite Orison", txt("#who"));
  ok("the giver track is still reachable, just last", labels()[1] !== "Suite Orison", labels().join(" | "));

  // ── 2. The rewards are ON SCREEN. This is the part Sub could not see at all. ──
  const loot = () => [].slice.call(document.querySelectorAll("#body .evloot"));
  const lootTxt = () => loot().map((d) => d.textContent).join(" ~ ");
  ok("the ladder drew one loot row per tier", loot().length === 3, String(loot().length));
  // POSITIVE FIRST: every separation assertion below is of the "X is not Y" shape, and an empty
  // ladder satisfies all of them for free.
  ok("the MEASURED reward is on screen", lootTxt().indexOf("SUITE MEASURED PISTOL") >= 0, lootTxt());
  ok("🔴 the CANDIDATE is on screen too — five blanks became five leads", lootTxt().indexOf("SUITE CANDIDATE ARMOR") >= 0, lootTxt());
  ok("a tier with neither still says so rather than rendering blank",
     lootTxt().indexOf("not known yet") >= 0, lootTxt());

  // ── 3. ...and a guess does not look like a measurement. ──
  const cands = [].slice.call(document.querySelectorAll("#body .evloot .it.cand"));
  const meas = [].slice.call(document.querySelectorAll("#body .evloot .it")).filter((s) => !s.classList.contains("cand"));
  const cname = cands.length ? cands[0].textContent : "(no candidate element)";
  const mname = meas.length ? meas[0].textContent : "(no measured element)";
  ok("exactly one item is drawn as a candidate", cands.length === 1, String(cands.length));
  ok("exactly one is drawn as a measurement", meas.length === 1, String(meas.length));
  ok("...and it is the guess that is marked, not the measurement", cname.indexOf("SUITE CANDIDATE ARMOR") >= 0, cname);
  ok("🔴 the candidate says the word UNCONFIRMED", cname.indexOf("UNCONFIRMED") >= 0, cname);
  ok("🔴 ...and the measured reward does not", mname.indexOf("UNCONFIRMED") < 0, mname);
  ok("🔴 a candidate is never ticked as owned", cands.length > 0 && !cands[0].classList.contains("owned"), cname);
  ok("...and carries no check mark", cname.indexOf("✔") < 0, cname);
  // The control for the line above: the owned measurement DOES carry one, so "no check mark" is
  // a real difference rather than a widget that stopped drawing them.
  ok("...while the owned measurement still does", mname.indexOf("✔") >= 0, mname);
  const ccs = cands.length ? getComputedStyle(cands[0]) : null;
  const mcs = meas.length ? getComputedStyle(meas[0]) : null;
  ok("...and it is drawn differently, not merely classed differently",
     !!ccs && !!mcs && ccs.color !== mcs.color, (ccs ? ccs.color : "?") + " vs " + (mcs ? mcs.color : "?"));
  ok("...in italic, which nothing else in this ladder is", !!ccs && ccs.fontStyle === "italic", ccs ? ccs.fontStyle : "?");
  ok("a legend says what UNCONFIRMED means", txt("#body .evkey").indexOf("verified") >= 0, txt("#body .evkey"));
  ok("...and points at how to correct it", txt("#body .evkey").indexOf("Wrong?") >= 0, txt("#body .evkey"));

  // ── 4. The ladder states what it cannot know, and offers no missions-to-go figure. ──
  ok("🔴 the ladder states its own price coverage", txt("#body .evmeta").indexOf("2 of 7 contracts") >= 0, txt("#body .evmeta"));
  ok("...and says outright it cannot turn a tier into a mission count",
     txt("#body .evmeta").indexOf("how many missions a tier is") >= 0, txt("#body .evmeta"));
  ok("the Journal advice survives beside it", txt("#body .evmeta").indexOf("in-game Journal") >= 0, txt("#body .evmeta"));

  // ── 5. The correction path, on every tier rather than only after a crossing. ──
  const fixes = () => [].slice.call(document.querySelectorAll("#body .evfix"));
  ok("every tier carries a way to say we have it wrong", fixes().length === 3, String(fixes().length));
  const card = () => document.getElementById("rwcard");
  ok("(control) no card is up before it is pressed", card().hidden);
  if (fixes()[1]) fixes()[1].click();
  await sleep(80);
  ok("pressing it raises the question card", !card().hidden, txt("#rwcard"));
  ok("...naming the tier it is about", txt("#rwcard").indexOf("40%") >= 0, txt("#rwcard"));
  ok("...and the name it is asking about", txt("#rwcard").indexOf("SUITE CANDIDATE ARMOR") >= 0, txt("#rwcard"));
  ok("...and saying that name is unverified", txt("#rwcard").indexOf("UNCONFIRMED") >= 0, txt("#rwcard"));
  // A crossing card retires itself after two minutes because it arrived unbidden. This one was
  // asked for, so taking it away on a timer would be discarding the player's own work.
  ok("...with no countdown, because the player opened it themselves",
     !document.querySelector("#rwcard .rwclock"), txt("#rwfoot"));

  // 🔴 The poll must not close it. The sidecar has no prompt for a self-raised correction and
  // never will, so the plain "no prompt means hide" rule would shut it a second after it opened.
  await window.__battReload();
  await sleep(200);
  ok("🔴 a routine poll does not close the card out from under the player", !card().hidden, txt("#rwcard"));

  const btns = () => [].slice.call(card().querySelectorAll("button")).map((b) => b.textContent);
  const press = (label) => {
    const b = [].slice.call(card().querySelectorAll("button")).filter((x) => x.textContent === label)[0];
    if (b) b.click();
    return !!b;
  };
  ok("agreeing is one click", btns().indexOf("Yes") >= 0, btns().join(" | "));
  ok("...and disagreeing is the other", btns().indexOf("No — it was…") >= 0, btns().join(" | "));
  press("Yes");
  await sleep(300);
  ok("🔴 the report is posted by EVENT and TIER — it has no prompt id to answer",
     !!posted && posted.event === "suite-orison" && posted.tier === 40, JSON.stringify(posted));
  ok("...and carries no id, which would answer somebody else's question",
     !!posted && !posted.id, JSON.stringify(posted));
  ok("...carrying the name being agreed with", !!posted && posted.name === "SUITE CANDIDATE ARMOR", JSON.stringify(posted));
  ok("...as a claim, never as a witnessed sighting", !!posted && posted.source === "corrected", JSON.stringify(posted));
  ok("...and the card closes on the answer", card().hidden);

  // A tier we already publish asks a DIFFERENT question — "is what we list right?" — because
  // "we have this one wrong" is the report worth the most.
  posted = null;
  if (fixes()[0]) fixes()[0].click();
  await sleep(80);
  ok("a MEASURED tier can be corrected too", !card().hidden, txt("#rwcard"));
  ok("...and is asked about as something we list, not as something the app saw",
     txt("#rwcard").indexOf("what we list") >= 0 && txt("#rwcard").indexOf("saw this arrive") < 0, txt("#rwcard"));
  document.getElementById("rwx").click();
  await sleep(60);
  ok("dismissing it posts nothing", posted === null, JSON.stringify(posted));

  // ── 6. Once the player picks a tab, nothing may move them off it. ──
  const giver = tabs().filter((b) => b.textContent !== "Suite Orison")[0];
  ok("(control) the giver tab is there to press", !!giver, labels().join(" | "));
  if (giver) giver.click();
  await sleep(120);
  ok("clicking the giver tab switches to it", txt("#who") !== "Suite Orison", txt("#who"));
  await window.__battReload();
  await sleep(200);
  ok("🔴 a poll does not drag the view back to the event once a tab is chosen",
     txt("#who") !== "Suite Orison", txt("#who"));

  window.fetch = realFetch;
  return out;
})()`;

// ── 🔴 THE COMMUNITY PRICE POOL, AS THE PLAYER READS IT (flight poolfill, 2026-08-24) ────────
//
// The block this guards used to be a green box labelled "you paid", drawn ABOVE the shop list.
// Sub: "I don't really need it to tell me what I bought. I just wanted to update the price for
// everybody." It is now the first GROUP in that list, in the same row idiom as every shop, and
// what it carries is a price plus who confirmed it and when.
//
// 🔑 IT DRIVES `render()` DIRECTLY WITH A FIXTURE, and that is not laziness. The pool is a LIVE
// endpoint whose contents change whenever anybody in the world shops, so a suite that fetched it
// would pass or fail on what strangers did this afternoon — the worst kind of flake, because it
// reads as a regression in the widget. `tools/test-widgets-sandbox.mjs` switches the pool off for
// the same reason it switches the other two price endpoints off.
// ⚠️ A BARE call, never `window.render` — a script-scoped `let`/`function` shadows an own-property
// of the same name on `window`, so the qualified form reaches a binding the page never reads and
// the suite then silently measures the sidecar's real board instead of the fixture.
const VERSEPOOL = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);

  const nowSec = Math.round(Date.now() / 1000);
  const DAY = 86400;
  const fixture = {
    query: "poolprobe",
    results: [{
      name: "Pool Probe Widget",
      kind: "item",
      quotes: [
        { terminal: "A Survey Shop", system: "Stanton", body: null, place: "Somewhere",
          price: 111, asOf: nowSec - 90 * DAY, minutes: null, metres: null, jumps: null,
          travelBasis: null, containment: null },
      ],
      observed: [
        { terminal: "SCShop_Probe_Live", price: 7, asOf: nowSec - 120, quantity: 1,
          contributors: 4, samples: 9, confidence: "confirmed", mine: true },
        { terminal: "SCShop_Probe_Old", price: 7, asOf: nowSec - 200 * DAY, quantity: 1,
          contributors: 1, samples: 1, confidence: "seen-once", mine: false },
      ],
    }],
    origin: null,
    order: null,
  };
  render(fixture);
  await sleep(120);

  const obgrp = document.querySelector("#results .grp.obgrp");
  // POSITIVE FIRST. Every must-not below is free if this group never rendered at all, which is
  // exactly what a fixture that failed to land produces.
  ok("the observed prices render as a group in the shop list", !!obgrp,
     obgrp ? "found" : "(no .grp.obgrp)");
  const obRows = obgrp ? [...obgrp.querySelectorAll(".grow")] : [];
  ok("both observations are drawn", obRows.length === 2, obRows.length + " rows");

  // 🔴 SUB'S ACTUAL COMPLAINT. The words "you paid" were the whole problem — it was built as a
  // receipt. Asserted against the group's own text, so a label put back anywhere in it is caught.
  const obText = obgrp ? (obgrp.textContent || "").toLowerCase() : "";
  ok("🔴 it does not call itself a receipt", obText.indexOf("you paid") === -1,
     obText.slice(0, 80));

  // 🔴 IT IS INSIDE THE SHOP LIST, NOT A BOX ABOVE IT. That relocation IS the fix; a block that
  // renders the same rows outside .shops is the old design wearing new words.
  const shops = document.querySelector("#results .shops");
  ok("🔴 the group sits INSIDE the shop list", !!shops && !!obgrp && shops.contains(obgrp),
     shops ? "shops contains obgrp: " + shops.contains(obgrp) : "(no .shops)");
  // ...and FIRST, because these are the freshest numbers in the widget.
  const groups = [...document.querySelectorAll("#results .grp")];
  ok("it is the FIRST group", groups.length > 1 && groups[0] === obgrp,
     groups.length + " groups, first is " + (groups[0] ? groups[0].className : "(none)"));

  // 🔴 THE ROW IDIOM IS THE SURVEY'S. If an observation row is built out of different parts from
  // a shop row it reads as a different kind of thing again, which is what was wrong before.
  const parts = (row) => ["gshop", "age", "price"].filter((c) => !!row.querySelector("." + c));
  ok("an observed row carries a shop, an age and a price like every other row",
     obRows.length > 0 && obRows.every((r) => parts(r).length === 3),
     obRows.map((r) => parts(r).join("+")).join(" | "));

  // 🔴 THE BANDS. A two-minute-old confirmation and a 200-day-old one must not paint the same,
  // which they did for months — none of the band classes had a colour rule anywhere.
  const ages = obRows.map((r) => r.querySelector(".age"));
  const bands = ages.map((a) => a.className.replace("age", "").trim());
  ok("the fresh row is the live band and the old row is not",
     bands[0] === "live" && bands[1] === "ancient", bands.join(" / "));
  const colours = ages.map((a) => getComputedStyle(a).color);
  ok("🔴 the two bands paint DIFFERENT colours", colours[0] !== colours[1], colours.join(" vs "));

  // 🔑 PEOPLE, NOT RECEIPTS — and a lone observation gets no tag at all.
  const tagText = (row) => [...row.querySelectorAll(".tag")].map((t) => t.textContent).join(",");
  ok("a corroborated row says how many PEOPLE", tagText(obRows[0]).indexOf("4 people") >= 0,
     tagText(obRows[0]));
  ok("it counts people rather than the 9 purchases behind them",
     tagText(obRows[0]).indexOf("9") === -1, tagText(obRows[0]));
  ok("a single observation carries no count tag", tagText(obRows[1]).indexOf("people") === -1,
     tagText(obRows[1]));

  // 🔑 "you" IS A FOOTNOTE, NOT THE HEADLINE.
  ok("the player's own purchase is marked on the row", tagText(obRows[0]).indexOf("you") >= 0,
     tagText(obRows[0]));
  ok("a row that is not yours is not marked", tagText(obRows[1]).indexOf("you") === -1,
     tagText(obRows[1]));

  // 🔴 IT MUST NEVER CLAIM TO BE A UEX ROW. 0 of 75 game shop tokens match a terminal name, so
  // the two lists cannot be reconciled and the widget has to say so.
  const survey = groups.find((g) => !g.classList.contains("obgrp"));
  ok("the survey rows are still their own group", !!survey && survey !== obgrp,
     survey ? survey.querySelector(".gplace").textContent : "(none)");
  ok("no observed row was sorted into a survey group",
     !!survey && [...survey.querySelectorAll(".grow")].every((r) =>
       (r.querySelector(".gshop").textContent || "").indexOf("Probe") === -1),
     survey ? survey.querySelectorAll(".grow").length + " survey rows" : "(none)");
  ok("the group explains why the two lists are separate",
     obText.indexOf("separately") >= 0, obText.slice(0, 160));

  // 🔴 AND THE POINT OF THE WHOLE FEATURE: the same price, confirmed far more recently than the
  // survey says. Asserted as a relation rather than as numbers, which would rot.
  const surveyAge = survey ? survey.querySelector(".age").className : "";
  ok("the observation is a fresher band than the survey quote beside it",
     bands[0] === "live" && surveyAge.indexOf("stale") >= 0,
     "observed=" + bands[0] + " survey=" + surveyAge);

  return out;
})()`;

const VERSEFINDER = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400); // let status() land before driving the box

  const box = document.getElementById("q");
  const search = async (v) => {
    box.value = v;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(700); // debounce + the sidecar round trip
  };
  const items = () => [...document.querySelectorAll("#results .item")];
  const shopRows = () => [...document.querySelectorAll("#results .grow")];

  // Nothing typed is not the same as nothing found — the empty state must invite, not report.
  ok("with an empty box it prompts rather than listing everything",
     items().length === 0 && !!document.querySelector("#results .empty"),
     items().length + " items");

  await search("cannon");
  ok("a real search returns items", items().length > 0, items().length);
  ok("...and every one of them names at least one shop",
     items().every((el) => el.querySelectorAll(".grow").length > 0));

  // 🔴 THE CORE RULE. A price with no place is the thing this widget must never show.
  ok("every shop row names its TERMINAL",
     shopRows().length > 0 && shopRows().every((r) => {
       const w = r.querySelector(".gshop");
       return w && w.textContent.trim().length > 0;
     }), shopRows().length + " rows");
  ok("every shop row carries a price",
     shopRows().every((r) => {
       const p = r.querySelector(".price");
       return p && /[0-9]/.test(p.textContent);
     }));
  // 🔴 Per-quote age. Not the table's age, not an average — this reading's own.
  // ⚠️ The DETAIL is looked up defensively on purpose. Reaching straight through
  // shopRows()[0].querySelector(".age").textContent throws when the element is missing, which is
  // exactly the regression this line exists to catch — and a throw kills the suite instead of
  // failing it, reporting 4/4 passed for a run that never reached the other twelve assertions.
  // Found by the negative control, which is the only reason it is written this way.
  const ageText = () => {
    const r = shopRows()[0];
    const a = r ? r.querySelector(".age") : null;
    return a ? a.textContent : "(no .age element)";
  };
  ok("every shop row carries the age of its OWN reading",
     shopRows().length > 0 && shopRows().every((r) => {
       const a = r.querySelector(".age");
       return a && a.textContent.trim().length > 0;
     }), ageText());

  // 🔴 "The price of X" does not exist: 68% of multi-shop items vary by shop. Any item whose
  // low and high differ must SAY so rather than letting the first row read as the price.
  const spread = items().filter((el) => {
    const m = el.querySelector(".more");
    return m && m.textContent.indexOf("depending where you buy") > -1;
  });
  const multi = items().filter((el) => el.querySelectorAll(".grow").length > 1);
  ok("the result set contains multi-shop items at all", multi.length > 0, multi.length);
  ok("...and at least one states its spread instead of one number",
     spread.length > 0, spread.length + " of " + multi.length);

  // A truncated shop list must never read as "this is everywhere it is sold".
  const truncated = items().filter((el) => {
    const m = el.querySelector(".more");
    return m && m.textContent.indexOf("more shop") > -1;
  });
  ok("a long shop list says how many were left out",
     truncated.length === 0 || truncated.every((el) => el.querySelectorAll(".grow").length === 5),
     truncated.length + " truncated");

  // 🔴 The provenance footer. Sub's requirement is that the user knows when they are on a
  // fallback, and only the screen they are looking at can say so.
  const src = document.getElementById("src");
  ok("the footer names where the table came from", !!src && src.textContent.trim().length > 4,
     src ? src.textContent : "none");
  // ⚠️ RE-POINTED 2026-08-22. This read the whole #src span and matched /UEX|offline/, which passed
  // only because the live sentence used to begin "UEX via subliminal.gg". The credit moved to a
  // badge, so the word left the sentence and this failed on working code. The tier wording is what
  // the assertion was ever about, so it now reads the element that carries the tier.
  // ⚠️ RE-POINTED AGAIN 2026-08-22. It matched on "subliminal.gg", which left the assertion tied to
  // a phrase whose whole job was to name our plumbing — and Sub cut that phrase for exactly that
  // reason ("we don't need to have that in there"). Chasing the wording a second time would be the
  // trap; the RULING has never changed, so this now checks the thing the ruling is about: the line
  // states WHICH TIER the table came from. Live says how fresh it is, the two fallbacks say they
  // are offline. A footer that said neither would be the regression.
  const srctext = document.getElementById("srctext");
  // 2026-08-22: the live tier dropped the word "updated" (Sub) and now prints the bare age,
  // so the live marker is the age itself - " ago" or "just now". The RULING is unchanged.
  const tierWords = [" ago", "just now", "offline"];
  ok("...and it says one of the three tiers, not something vague",
     !!srctext && tierWords.some((w) => srctext.textContent.indexOf(w) > -1),
     srctext ? srctext.textContent : "(no #srctext)");
  // 🔴 Paired with the positive: the credit must NOT have crept back into the sentence. The badge
  // carries the attribution; the sentence carries the age. Both halves asserted, because "does not
  // mention subliminal.gg" alone is satisfied for free by an empty footer.
  ok("...and does not re-narrate whose proxy it came through",
     !!srctext && srctext.textContent.indexOf("subliminal.gg") === -1,
     srctext ? srctext.textContent : "(no #srctext)");
  // 🔴 THE UEX CREDIT IS ITS OWN ASSERTION NOW, because it is its own requirement (Sub,
  // 2026-08-22: "this is really mainly just them. All we're doing is putting up a wrapper for
  // it."). Previously it was only ever incidental to the tier check above — which is exactly how
  // it disappeared from the sentence without anything noticing.
  // 🔑 EITHER the badge OR the words satisfy it, because the markup deliberately swaps one for the
  // other when the image cannot load. Asserting on the <img> alone would go red for the fallback
  // that exists to keep the attribution present.
  {
    const badge = document.getElementById("uexmark");
    const words = document.getElementById("uexname");
    const credited = (badge && /uex/i.test(badge.getAttribute("alt") || "")) ||
                     (words && /uex/i.test(words.textContent || ""));
    ok("🔴 UEX is credited in the footer, by badge or by name",
       !!credited,
       badge ? "badge alt=" + badge.getAttribute("alt") : words ? "words=" + words.textContent : "(neither present)");
  }

  // 🔴 The age pill's colour band. Asserted as a CONSISTENCY rule between the number rendered and
  // the class chosen, rather than against hardcoded expectations — the table ages every day, so a
  // test that expected specific colours would rot within a week.
  await search("cannon");
  const pills = [...document.querySelectorAll("#results .age")];
  // 🔴 RE-POINTED 2026-08-24, flight poolfill: a FIFTH band, live, sits at the fresh end for a
  // reading from the last hour — the band the community pool exists to produce. The old list of
  // four would go red on a perfectly correct pill the first time UEX served a row somebody had
  // updated that morning.
  const BANDS = ["live", "fresh", "recent", "stale", "ancient"];
  ok("every age pill carries exactly one band class", pills.length > 0 && pills.every((p) => {
    const hit = BANDS.filter((b) => p.classList.contains(b));
    return hit.length === 1;
  }), pills.length + " pills");
  // 🔴 AND THE BANDS MUST ACTUALLY BE PAINTED. This is what was missing for months: every one of
  // these classes was being applied and NONE of them had a colour rule anywhere — not in this
  // page, not in widget-theme.css, not in any of the 15 skins — so a computed band produced no
  // visible difference at all, and a comment in the page asserted the opposite. Assert the
  // rendered colours DIFFER rather than naming values, which would rot with every skin.
  {
    const probe = document.createElement("div");
    document.body.appendChild(probe);
    const seen = {};
    for (const band of BANDS) {
      const el = document.createElement("span");
      el.className = "age " + band;
      el.textContent = "1d";
      probe.appendChild(el);
      seen[band] = getComputedStyle(el).color;
    }
    const vals = BANDS.map((k) => seen[k]);
    ok("🔴 each recency band paints its own colour", vals.filter((v, i) => vals.indexOf(v) === i).length >= 4,
       BANDS.map((k) => k + "=" + seen[k]).join("  "));
    // A colourless token — the --good trap, defined in no theme — resolves to the INHERITED
    // colour, so every band would read identically while looking deliberate in the source.
    // Naming that failure separately makes it diagnosable instead of a bare count.
    const bare = document.createElement("span");
    bare.className = "age";
    probe.appendChild(bare);
    const inherited = getComputedStyle(bare).color;
    ok("no band falls back to the unstyled pill's inherited colour",
       BANDS.filter((k) => seen[k] === inherited).length === 0,
       "inherited=" + inherited + "  " + BANDS.map((k) => k + "=" + seen[k]).join("  "));
    probe.remove();
  }
  // Parse the rendered text back and check it agrees with the band it was given.
  const bandOf = (txt) => {
    const m = /^(\\d+)(d|mo)$/.exec(txt.trim());
    // ⚠️ "today" covers BOTH live and fresh — the printed text cannot separate an hour from six
    // days, so this accepts either rather than pretending to a precision it does not have.
    if (txt.trim() === "today") return "today";
    if (!m) return null;
    const d = m[2] === "mo" ? Number(m[1]) * 30 : Number(m[1]);
    return d <= 7 ? "fresh" : d <= 45 ? "recent" : d <= 100 ? "stale" : "ancient";
  };
  const agrees = (want, got) => (want === "today" ? (got === "live" || got === "fresh") : want === got);
  const checked = pills.map((p) => ({ want: bandOf(p.textContent), got: BANDS.find((b) => p.classList.contains(b)) }))
    .filter((x) => x.want !== null);
  ok("the band really matches the age it prints", checked.length > 0 && checked.every((x) => agrees(x.want, x.got)),
     checked.length + " checked, first mismatch: "
     + (checked.find((x) => !agrees(x.want, x.got)) ? JSON.stringify(checked.find((x) => !agrees(x.want, x.got))) : "none"));

  // 🔑 Price and age stay TOGETHER (Sub, 2026-08-21) — they answer the same question, and
  // splitting them to opposite edges made the eye travel to reconcile two halves of one fact.
  // ⚠️ RE-POINTED 2026-08-22 for the grouped layout. They used to be stacked inside a .pricecol
  // element and this asserted that element existed; they are now adjacent siblings at the end of
  // the row. The RULING was never about the wrapper — it was about the two not being separated —
  // so the assertion now checks adjacency, which is the thing that must not regress.
  {
    const rows = [...document.querySelectorAll("#results .grow")];
    ok("there are rows to check the price/age pairing on", rows.length > 0, rows.length + " rows");
    const paired = rows.filter((r) => {
      const kids = [...r.children];
      const ai = kids.findIndex((k) => k.classList.contains("age"));
      const pi = kids.findIndex((k) => k.classList.contains("price"));
      return ai >= 0 && pi >= 0 && Math.abs(ai - pi) === 1;
    });
    ok("price and age sit next to each other, never at opposite ends",
       rows.length > 0 && paired.length === rows.length, paired.length + " of " + rows.length);
  }

  // A miss must distinguish "no shop known" from "no such item" — the former is the common case.
  //
  // ⚠️ RE-POINTED 2026-08-22, and the reason is that the widget got BETTER at the thing this was
  // guarding. It used to demand the literal words "No shop known" for every miss, which was the
  // right defence when the app held only a COUNT of unpriced items and therefore could never tell
  // a real armour set from a typo — one cautious sentence for both was all it was entitled to say.
  // The table now ships the 4,962 names, so a nonsense string really has been checked against
  // everything we hold and "Nothing found" is the honest answer rather than a flat denial that the
  // thing exists. The RULING was never about that wording; it was that the two cases must not read
  // the same. That is now asserted where it can actually fail, in the VERSEDEALERS suite, which
  // drives a real unsold item and a typo and compares the two pages. Here the claim narrows to
  // what this query can prove: a miss says something, and it does not pretend to have found
  // anything.
  await search("zzzqqxwv");
  const empty = document.querySelector("#results .empty");
  ok("a miss renders the empty state", !!empty, empty ? "yes" : "no");
  ok("...naming what was searched for rather than a bare failure",
     !!empty && empty.textContent.indexOf("zzzqqxwv") > -1, empty ? empty.textContent.slice(0, 70) : "");
  ok("...and no result row is drawn beside it",
     document.querySelectorAll("#results .item").length === 0,
     document.querySelectorAll("#results .item").length + " items");

  // ── The eye: how well we can see where the player is ──────────────────────────────────────
  // Defensive lookups on BOTH the condition and the DETAIL. A detail expression is evaluated
  // eagerly, so reaching straight through a missing element there kills the whole suite and the
  // run still prints a small passing number - which is exactly how twelve assertions once went
  // unexecuted while the summary read 4/4.
  const eyeEl = () => document.getElementById("eye");
  const eyeTxt = () => { const e = document.getElementById("eyelbl"); return e ? e.textContent.trim() : "(no eyelbl)"; };
  const eyeCls = () => { const e = eyeEl(); return e ? e.className : "(no eye)"; };

  ok("the location eye is present", !!eyeEl(), eyeCls());
  ok("...drawn as an SVG, never a glyph the OS font might not have",
     !!(eyeEl() && eyeEl().querySelector("svg path")),
     eyeEl() ? (eyeEl().querySelector("svg") ? "svg" : "no svg") : "(no eye)");
  // 🔴 IT IS A CIRCLED i, NOT AN EYE (Sub, 2026-08-22). An eye reads as a visibility toggle, which
  // is the wrong verb for "there is more to read here".
  // 🔑 Asserted on the SHAPE, because that is the thing that can regress. The eye was one <path>
  // outline plus a pupil <circle>; the i is a ring <circle> plus a stem and a dot, both <path>.
  // Counting "a circle and two paths" is what tells them apart — checking merely that an <svg>
  // exists passes just as happily for the eye, which is how this could have been missed.
  {
    const svg = eyeEl() && eyeEl().querySelector("svg");
    const circles = svg ? svg.querySelectorAll("circle").length : 0;
    const paths = svg ? svg.querySelectorAll("path").length : 0;
    ok("...as a circled i (ring + stem + dot), not the old eye outline",
       circles === 1 && paths === 2, "circle=" + circles + " path=" + paths);
  }
  ok("...and it always says something rather than sitting blank",
     eyeTxt().length > 0, eyeTxt());
  // Three states and only three, because there are exactly three claims it can make.
  ok("...in exactly one of the three confidence states",
     ["precise", "rough", "none"].filter((c) => eyeCls().split(" ").indexOf(c) >= 0).length === 1,
     eyeCls());
  ok("...and the hover explains it in words", (eyeEl() && eyeEl().title || "").length > 20,
     (eyeEl() && eyeEl().title || "(no title)").slice(0, 70));

  // 🔴 THE POPOVER MUST TAKE NO SPACE IN LAYOUT. That is the whole reason it is a popover in the
  // top layer rather than an absolutely-positioned box - an earlier widget in this app measured
  // 541px -> 743px making exactly this mistake.
  //
  // 🔑 MEASURE THE FOOT AND THE RESULTS, NOT THE PANEL. The first version of this assertion
  // compared the PANEL height open vs closed and could never have failed: this page pins
  // #panel to height 480px (100% when embedded), so it is fixed by construction and the check
  // was a tautology wearing the most on-point name in the suite. An in-flow box inside .foot
  // would grow the foot and, because the panel cannot grow, steal that space from #results -
  // and both of those are free to move.
  const footEl = document.querySelector(".foot");
  const resEl = document.getElementById("results");
  const popEl = document.getElementById("eyepop");
  const footClosed = footEl ? footEl.getBoundingClientRect().height : -1;
  const resClosed = resEl ? resEl.getBoundingClientRect().height : -1;
  // 🔴 showPopover() EXISTS ON EVERY HTMLElement AND THROWS WITHOUT THE popover ATTRIBUTE
  // (InvalidStateError). So a feature-test on the METHOD is not a guard at all: dropping the
  // attribute killed this whole suite and it reported "4/4 passed" for twenty-nine assertions.
  // Catch it, record it, and let the assertions below fail honestly instead.
  let popOpenErr = "";
  try { if (popEl && popEl.showPopover) popEl.showPopover(); }
  catch (e) { popOpenErr = (e && e.name) ? e.name : String(e); }
  await sleep(60);
  ok("the eye box is a real popover, not a plain div",
     popOpenErr === "", popOpenErr || "opened cleanly");
  const footOpen = footEl ? footEl.getBoundingClientRect().height : -2;
  const resOpen = resEl ? resEl.getBoundingClientRect().height : -2;
  const popShown = popEl ? popEl.getBoundingClientRect().width > 0 : false;
  ok("the eye popover really opens", popShown, popShown ? "visible" : "not visible");
  ok("...and does not grow the footer it lives in",
     footClosed > 0 && footClosed === footOpen, footClosed + "px closed / " + footOpen + "px open");
  ok("...nor steal any height from the results list",
     resClosed > 0 && resClosed === resOpen, resClosed + "px closed / " + resOpen + "px open");
  ok("...and carries the explanation, not just a title",
     !!(popEl && popEl.textContent.trim().length > 20),
     popEl ? popEl.textContent.trim().slice(0, 60) : "(no popover)");
  try { if (popEl && popEl.hidePopover) popEl.hidePopover(); } catch (e) { /* reported above */ }
  await sleep(40);

  // 🔴 A ROW MAY ONLY CLAIM A DISTANCE THE SERVER ACTUALLY GAVE IT. The sidecar under test has
  // whatever origin the real log affords, so rather than assert a particular basis, assert the
  // INVARIANT that holds either way: a distance is shown only when the response said so.
  await search("cannon");
  const noteEl = document.getElementById("ordernote");
  const basisShown = !!(noteEl && !noteEl.hidden && noteEl.textContent.trim().length > 0);
  const distCells = [...document.querySelectorAll("#results .cpill")];
  ok("the order note appears only when an ordering was actually applied",
     basisShown === (distCells.length > 0) || eyeCls().indexOf("none") >= 0,
     "note=" + basisShown + " distCells=" + distCells.length + " eye=" + eyeCls());
  ok("...and no distance cell is ever empty",
     distCells.every((c) => c.textContent.trim().length > 0),
     distCells.length + " cells");

  // ── 🔴 NO DEAD GUTTER DOWN THE LEFT (Sub, 2026-08-22: "a lot of wasted space") ──────────────
  //
  // The price column was a fixed 82px box with right-aligned contents, placed FIRST — so a 20px
  // price rendered 62px in from the panel edge and every shop name started at x=99. The fix was
  // both halves: move it off the left AND size it to its contents. Guarded because it is invisible
  // to every other assertion here — the rows were correct, complete and readable throughout.
  {
    const panelRect = document.getElementById("panel").getBoundingClientRect();
    const rows = [...document.querySelectorAll("#results .grow")];
    const leftOf = (el) => Math.round(el.getBoundingClientRect().left - panelRect.left);
    const rightOf = (el) => Math.round(el.getBoundingClientRect().right - panelRect.left);
    // 🔑 POSITIVE FIRST: every claim below is free with no rows on screen.
    ok("there are shop rows to measure the gutter on", rows.length > 0, rows.length + " rows");
    const names = rows.map((r) => r.querySelector(".gshop")).filter(Boolean);
    const starts = [...new Set(names.map(leftOf))];
    // The item's own left padding is 7px, so a name should begin within a pixel or two of that.
    // 99px was the bug. Anything past ~20 means a fixed-width column crept back onto the left.
    ok("🔴 shop names start at the panel edge, not behind a reserved column",
       starts.length > 0 && Math.max(...starts) <= 20,
       "name left edges: " + starts.join(","));
    // 🔑 AND THE ALIGNMENT MUST SURVIVE. The price is the last thing in the row and the shop name
    // is the only flexible item, so every price should land on one right edge across every group.
    const prices = rows.map((r) => r.querySelector(".price")).filter(Boolean);
    const edges = [...new Set(prices.map(rightOf))];
    ok("there are prices to check alignment on", prices.length > 1, prices.length + " prices");
    ok("...and every price still right-aligns to the same column",
       edges.length === 1, "right edges: " + edges.join(","));
    // 🔴 NOTHING IN THE ROW MAY RESERVE SPACE IT DOES NOT USE — the general form of the 82px
    // gutter. Every row item except the shop name is flex:none and shrink-to-fit, so each box
    // should measure its own content. A fixed width creeping back onto any of them shows up here
    // as slack, which neither the gutter check nor the alignment check can see.
    {
      const boxes = [];
      for (const r of rows) {
        for (const k of [...r.children]) {
          if (k.classList.contains("gshop")) continue;   // the one item that may flex
          boxes.push({ cls: k.className, slack: Math.round(k.getBoundingClientRect().width - k.scrollWidth) });
        }
      }
      ok("there are fixed row items to measure slack in", boxes.length > 0, boxes.length + " items");
      const worst = boxes.reduce((m, b) => (b.slack > m.slack ? b : m), { cls: "-", slack: -1 });
      ok("🔴 no row item reserves space beyond its content",
         boxes.length > 0 && worst.slack <= 2,
         "worst " + worst.slack + "px on ." + String(worst.cls).split(" ")[0] + " across " + boxes.length + " items");
    }
    // ── 🔴 AT 320px, THE WIDTH THAT ACTUALLY BINDS ──────────────────────────────────────────
    //
    // Sub, 2026-08-22: a 16:9 window centred on a 21:9 screen leaves a bar each side, and that bar
    // is the narrowest anyone would sensibly make this widget. On a 2560x1080 ultrawide it is
    // 320px. The widget had been designed and previewed at 460 — wider than the worst case, which
    // is how you ship something that falls apart exactly where it counts.
    //
    // 🔑 THE PANEL MUST BE NARROWED BEFORE MEASURING, and the negative control is what proved it:
    // the age-pill assertion below passed at the harness's default 460px even with the bug
    // deliberately re-injected, because nothing is squeezed when there is room to spare. An
    // assertion about narrow-width behaviour that never narrows anything cannot fail.
    {
      const panelEl = document.getElementById("panel");
      const restore = panelEl.style.width;
      panelEl.style.width = "320px";
      await sleep(260);

      const narrowRows = [...document.querySelectorAll("#results .grow")];
      ok("there are rows to measure at 320px", narrowRows.length > 0, narrowRows.length + " rows");

      // 🔴 THE TWO-LINE PILL. A flex item defaults to flex:0-1-auto, so at a narrow width the
      // browser shrinks the pill's BOX below its content. A white-space:nowrap keeps the TEXT on
      // one line but does nothing to stop the box collapsing, so the pill grows a second line
      // while its text sits on one. Measured against the pill's own line-height, not a constant.
      const ages = narrowRows.map((r) => r.querySelector(".age")).filter(Boolean);
      const tall = ages.filter((a) => {
        const line = parseFloat(getComputedStyle(a).lineHeight) || 12;
        return a.getBoundingClientRect().height > line * 1.7;
      });
      ok("there are age pills to measure at 320px", ages.length > 0, ages.length + " pills");
      ok("🔴 no age pill has collapsed to two lines at 320px",
         tall.length === 0,
         tall.length ? tall.length + " tall, e.g. " + tall[0].textContent : ages.length + " single-line");

      // The same collapse would hit the price, and it is the more expensive one to misread.
      const pricesN = narrowRows.map((r) => r.querySelector(".price")).filter(Boolean);
      const tallP = pricesN.filter((p) => {
         const line = parseFloat(getComputedStyle(p).lineHeight) || 12;
         return p.getBoundingClientRect().height > line * 1.7;
      });
      ok("...nor has any price", tallP.length === 0,
         tallP.length ? tallP.length + " tall" : pricesN.length + " single-line");

      // 🔴 AND NOTHING MAY SPILL OUT OF THE PANEL. #results clips overflow-x, so a row that is
      // too wide gets silently cut rather than scrolling — the reader never learns it was there.
      const pr = panelEl.getBoundingClientRect();
      const spill = narrowRows.filter((r) => r.getBoundingClientRect().right > pr.right + 1);
      ok("🔴 no row spills past the panel edge at 320px",
         spill.length === 0,
         spill.length ? spill.length + " of " + narrowRows.length + " spill"
                      : narrowRows.length + " rows inside " + Math.round(pr.width) + "px");

      panelEl.style.width = restore;
      await sleep(160);
    }

    // ── 🔴 THE PRICE NAMES ITS CURRENCY (Sub, 2026-08-22: "it just says seven") ───────────────
    // A bare number in a widget that also prints distances, ages and sizes is the same ambiguity
    // that made him read "4M away" as a distance.
    {
      const units = rows.map((r) => r.querySelector(".price .unit")).filter(Boolean);
      ok("every price carries a currency unit", units.length === rows.length,
         units.length + " of " + rows.length + " rows");
      const texts = [...new Set(units.map((u) => u.textContent.trim()))];
      ok("...and it says aUEC", texts.length === 1 && texts[0] === "aUEC", texts.join(","));
      // 🔑 The unit must be a CHILD of .price, not appended into its text: the alignment assertions
      // above measure .price, and the suite would still pass while the column drifted.
      const first = rows[0].querySelector(".price");
      ok("...as a child element, so the number is still addressable on its own",
         !!first && first.childElementCount >= 1 && first.firstChild.nodeType === 3,
         first ? "children=" + first.childElementCount + " text=" + first.firstChild.textContent : "(none)");
    }
  }

  // ── 🔴 THE CATEGORY RIDES THE NAME, AND IS NOT ALSO A CHIP (Sub, 2026-08-22) ────────────────
  // "CRUZ Lux" does not say drink. The category is what makes a row identifiable, so it belongs in
  // the identity rather than as one more attribute chip.
  await search("lux");
  {
    const item = document.querySelector("#results .item");
    const nameEl = item && item.querySelector(".iname");
    const catEl = item && item.querySelector(".iname .icat");
    ok("the search returned an item to inspect", !!nameEl,
       nameEl ? nameEl.textContent.slice(0, 40) : "(no item)");
    ok("the category is part of the name", !!catEl,
       nameEl ? nameEl.textContent.slice(0, 40) : "(no name)");
    if (catEl) {
      const t = catEl.textContent;
      ok("...introduced by a dash, not just jammed on", t.indexOf("-") >= 0 || t.indexOf("–") >= 0, t);
      // 🔴 AND NOT DUPLICATED. Mirroring it into a chip as well is the same fact in two places,
      // which is what makes a reader wonder what the difference is.
      const chipTexts = [...item.querySelectorAll(".chip")].map((c) => c.textContent.trim());
      const catWord = t.replace("–", "").replace("-", "").trim();
      ok("...and NOT repeated as a chip",
         chipTexts.every((c) => c.toLowerCase() !== catWord.toLowerCase()),
         "chips: " + (chipTexts.join(",") || "(none)") + " vs category " + catWord);
    }
  }

  // ── 🔴 GROUPED BY PLACE, WITH THE PLACE OFF THE SHOP NAME (Sub picked this 2026-08-22) ──────
  await search("medpen");
  {
    const groups = [...document.querySelectorAll("#results .grp")];
    ok("results are grouped by place", groups.length > 0, groups.length + " groups");
    ok("...and every group states its place once, in a heading",
       groups.length > 0 && groups.every((g) => {
         const h = g.querySelector(".ghead .gplace");
         return h && h.textContent.trim().length > 0;
       }),
       groups.map((g) => (g.querySelector(".gplace") || {}).textContent).join(" | "));
    // 🔴 A GROUP MUST NEVER BREAK A CONSECUTIVE RUN. Grouping walks consecutive runs precisely so
    // it preserves the proximity order rather than re-sorting it, and a bug in that walk shows up
    // as two ADJACENT groups carrying the same heading.
    //
    // ⚠️ RE-POINTED 2026-08-22, and the reason is worth more than the fix. This asserted that no
    // place appears twice ANYWHERE in the list, which is a claim about the ORDERING, not about the
    // grouping - and it is only true while the ordering has something to order by. It went red on
    // untouched code the moment the origin aged past its trust window: on the containment basis,
    // with all eight MedPen shops landing in the same same-body bucket, there is no signal left,
    // the stable sort keeps the incoming cheapest-first order, and Lorville legitimately appears at
    // positions 1 and 5. The widget is behaving exactly as designed; the assertion had made the
    // freshness of whoever last played the game part of its pass condition. Same family as the
    // scan-box suite that asserted a user preference and went red for Sub because he had it on.
    //
    // The invariant that survives is adjacency: two groups in a row may not be the same place.
    const places = groups.map((g) => (g.querySelector(".gplace") || {}).textContent);
    const runBreaks = places.filter((p, i) => i > 0 && p === places[i - 1]);
    ok("...and no two ADJACENT groups repeat a place, which would be a broken run",
       runBreaks.length === 0, places.join(" | "));
    // 🔴 THE PLACE IS NOT REPEATED ON THE SHOPS UNDER IT — the whole point of the heading.
    let repeats = [];
    for (const g of groups) {
      const place = ((g.querySelector(".gplace") || {}).textContent || "").toLowerCase();
      const squash = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const r of [...g.querySelectorAll(".grow .gshop")]) {
        // A shop legitimately named after its place keeps its name (never strip to nothing), so
        // only flag a name that ENDS with the place as a trailing segment.
        const n = r.textContent;
        const tail = n.split(" - ").pop().trim();
        if (place && squash(tail) && squash(place).indexOf(squash(tail)) === 0 && n.indexOf(" - ") >= 0) {
          repeats.push(n + "  under  " + place);
        }
      }
    }
    ok("...and no shop name still trails the place its heading already names",
       repeats.length === 0, repeats.length ? repeats.slice(0, 3).join(" ; ") : "clean");
    // 🔑 THE FULL NAME STAYS REACHABLE. Stripping is a display convenience; the name UEX
    // publishes is what a player would search for or report a problem about.
    const firstShop = document.querySelector("#results .grow .gshop");
    ok("...while the full terminal name survives on hover",
       !!firstShop && (firstShop.title || "").length >= firstShop.textContent.length,
       firstShop ? firstShop.textContent + "  →  " + firstShop.title : "(none)");
  }

  // ── 🔴 CONTAINMENT IS A PILL, LIKE THE REST OF THE WIDGET FAMILY (Sub, 2026-08-22) ──────────
  {
    const pills = [...document.querySelectorAll("#results .cpill")];
    // POSITIVE FIRST — everything below is free with no pills on screen. Which state the live
    // sidecar is in depends on Sub's log, so this is reported rather than demanded.
    if (pills.length === 0) {
      ok("(no containment rows this run - the origin is precise enough for distances)", true,
         "skipped, " + document.querySelectorAll("#results .cpill").length + " distance cells");
    } else {
      ok("containment rows render as pills", pills.length > 0, pills.length + " pills");
      const cs0 = getComputedStyle(pills[0]);
      ok("...with a real chip border and radius",
         cs0.borderTopWidth !== "0px" && parseFloat(cs0.borderTopLeftRadius) > 0,
         "border " + cs0.borderTopWidth + " radius " + cs0.borderTopLeftRadius);
      // 🔴 A pill must SHRINK TO ITS TEXT. Styling the fixed-width slot as the pill made "here" and
      // "same body" render identically wide and clipped the longer one — which is what stops it
      // reading as a pill at all.
      const clipped = pills.filter((p) => p.scrollWidth > p.clientWidth + 1).map((p) => p.textContent);
      ok("...and none of them is clipped by its slot",
         clipped.length === 0, clipped.length ? "clipped: " + clipped.join(",") : pills.length + " checked");
      const byText = new Map();
      for (const p of pills) byText.set(p.textContent.trim(), Math.round(p.getBoundingClientRect().width));
      const distinctTexts = [...byText.keys()];
      const distinctWidths = [...new Set(byText.values())];
      // Only meaningful when two different labels are on screen; say so rather than passing quietly.
      ok(distinctTexts.length > 1
           ? "...and pills of different text are different widths"
           : "(only one containment label on screen, width variation not testable)",
         distinctTexts.length > 1 ? distinctWidths.length > 1 : true,
         distinctTexts.map((t) => t + "=" + byText.get(t) + "px").join(" "));
    }
  }

  // 🔑 CAPTURED FROM THE LIVE RESPONSE, BEFORE THE FIXTURE BELOW REPLACES IT. These two strings are
  // built by the SERVER (originSummary and orderByProximity's note), so they are the only place the
  // real age wording can be tested. The first version of the bare-age assertion ran after the
  // fixture render and therefore read the fixture's own hand-written strings — a tautology that
  // stayed green when the server was reverted to "19m ago". The control is what exposed it.
  const liveNote = document.getElementById("ordernote");
  const liveEyeLbl = document.getElementById("eyelbl");
  // 🔑 #srctext joins them (2026-08-22). It is a THIRD age in the same footer — how old our copy of
  // the table is — so it is exposed to the identical misreading and now shares the bare-Nm check
  // below rather than needing its own. Captured here for the same reason as the other two: it is
  // composed from a server value and the fixture render must not get a chance to overwrite it.
  const liveSrcText = document.getElementById("srctext");
  const liveFooterAge = liveSrcText ? liveSrcText.textContent : "";
  const liveAgeText = (liveNote ? liveNote.textContent : "") + " " + (liveEyeLbl ? liveEyeLbl.textContent : "")
    + " " + liveFooterAge;

  // ── 🔴 DISTANCE, NOT MINUTES (Sub, 2026-08-22) ─────────────────────────────────────────────
  //
  // 🔑 DRIVEN FROM A FIXTURE THROUGH render(), NOT FROM THE LIVE SIDECAR, and that is the only way
  // this can be tested at all. The sidecar's origin comes from Sub's real log, so which tier he is
  // in is a property of when he last played — and all four tiers can never coexist in one real
  // response. The fixture carries the exact numbers from his report so the case that shipped wrong
  // is the case under test.
  {
    const q = (place, sys, price, metres, jumps, basis, contain) => ({
      terminal: "Shop - " + place, system: sys, body: "b", place: place, price: price,
      asOf: 1786511612, minutes: 0, metres: metres, jumps: jumps, travelBasis: basis,
      containment: contain,
    });
    render({
      query: "fixture", source: "live", fetchedAt: Date.now(), itemCount: 1, terminalCount: 461,
      origin: { tier: "place", label: "Seraphim Station", summary: "Seraphim Station . just now",
                ageMin: 0, stale: false, from: "a test", howToImprove: "x" },
      order: { basis: "travel-time", note: "Nearest first, from Seraphim Station." },
      results: [{
        name: "Fixture Item", company: "c", category: "k", size: null, uuid: "u",
        shopCount: 4, low: 265, high: 400,
        quotes: [
          q("Seraphim Station", "Stanton", 265, 0, 0, "measured", "same-place"),
          q("Orison", "Stanton", 280, 830050, 0, "measured", "same-body"),
          q("New Babbage", "Stanton", 300, 57477000000, 0, "measured", "same-system"),
          q("Ruin Station", "Pyro", 400, null, 1, "estimated", "elsewhere"),
        ],
      }],
    });
    await sleep(80);
    const heads = [...document.querySelectorAll("#results .grp")];
    const distOf = (i) => {
      const d = heads[i] && heads[i].querySelector(".gdist");
      return d ? d.textContent.trim() : "(none)";
    };
    const texts = [distOf(0), distOf(1), distOf(2), distOf(3)];
    // POSITIVE FIRST — every claim below is free if the fixture drew nothing at all.
    ok("the fixture really drew four shop rows",
       document.querySelectorAll("#results .grow").length === 4,
       document.querySelectorAll("#results .grow").length + " rows");
    ok("...in four groups, one per place",
       heads.length === 4, heads.length + " groups: " + texts.join(" | "));
    ok("Sub's 830 km hop reads as a DISTANCE, not as minutes", texts[1] === "830 km", texts[1]);
    ok("...and the far one is a distance too, at its own scale", texts[2] === "57 Gm", texts[2]);
    // 🔴 The regression that started all this: 830 km used to render as "15m" and 57 Gm as "4m",
    // so the nearer shop looked further. Asserting the strings pins BOTH the unit and the order.
    ok("🔴 the near shop no longer reads as further than the far one",
       texts[1].indexOf("km") >= 0 && texts[2].indexOf("Gm") >= 0,
       texts[1] + " then " + texts[2]);
    // 🔴 Cross-system has NO distance, because the coordinate frames are per-system. The system
    // name carries "how far" there instead, which is asserted with the tier ladder below.
    ok("a shop in another system states no distance at all", texts[3] === "(none)", texts[3]);
    // ⚠️ STRING METHODS ONLY BELOW — NO REGEX. This block is inside a template literal, where a
    // backslash escape is eaten before any RegExp is built: "\b" becomes a backspace byte and
    // "\d"/"\s" lose their backslash. The first version of these assertions used all three; one
    // went honestly red and the OTHER TWO PASSED WITHOUT TESTING ANYTHING, because a pattern that
    // can never match makes a "must not contain" check free forever.
    const lastWord = (t) => { const p = t.trim().split(" "); return p[p.length - 1]; };
    const UNITS = ["km", "Mm", "Gm"];
    const measured = texts.slice(0, 3);
    ok("every distance spells its unit out",
       measured.every((t) => UNITS.indexOf(lastWord(t)) >= 0),
       measured.map((t) => t + " -> " + lastWord(t)).join(" | "));
    // 🔴 THE LABELLING TRAP ITSELF: a one-character unit is what let "4m" be read as a distance.
    const unitOf = (t) => {
      let u = lastWord(t);
      while (u.length && ("0123456789.,<~".indexOf(u[0]) >= 0)) u = u.slice(1);
      return u;
    };
    ok("...and no unit is a single letter, which is what made 4m ambiguous",
       measured.every((t) => unitOf(t).length >= 2),
       measured.map((t) => t + " -> unit " + (unitOf(t) || "(none)")).join(" | "));
    // 🔴 THE FOUR-STEP TIER LADDER. It can only be exercised from a fixture: the live sidecar
    // shows whichever single tier Sub's own log puts him in.
    {
      const pills = [...document.querySelectorAll("#results .cpill")];
      const seen = pills.map((p) => p.textContent.trim() + ":" + String(p.className).split(" ")[1]);
      ok("the fixture produced a pill per group", pills.length === 4, seen.join(" | "));
      const want = ["here:t-here", "same body:t-body", "in system:t-sys", "Pyro:t-away"];
      ok("🔴 each tier gets its own class, in the near-to-far order the results are sorted in",
         seen.join(" | ") === want.join(" | "), seen.join(" | "));
      // 🔴 THE FAR TIER NAMES THE SYSTEM (Sub: "instead of saying out of system, just put Nyx or
      // Pyro"). "elsewhere" told the player nothing they did not already know.
      const away = pills.find((p) => String(p.className).indexOf("t-away") >= 0);
      ok("...and the far one is the SYSTEM NAME, not the word elsewhere",
         !!away && away.textContent.trim() === "Pyro", away ? away.textContent : "(no far pill)");
      // ⚠️ A proper noun must not be lower-cased by the styling that lower-cases the tier words.
      ok("...rendered as a proper noun, not lower-cased like the tier words",
         !!away && getComputedStyle(away).textTransform === "none",
         away ? getComputedStyle(away).textTransform : "-");
      const colours = [...new Set(pills.map((p) => getComputedStyle(p).color))];
      ok("...and the four tiers are four distinct colours", colours.length === 4, colours.join(" | "));
    }
    // The age itself, captured from the LIVE footer rather than the fixture - a fixture cannot
    // test a string the SERVER composes.
    const hasAge = liveAgeText.indexOf(" ago") >= 0 || liveAgeText.indexOf("just now") >= 0;
    ok("the live footer really printed an age to check", hasAge, liveAgeText.trim().slice(0, 70) || "(empty)");
    // 🔴 SUB OVERTURNED THE BARE-m RULE on 2026-08-22: "it doesn't even need to say updated 34
    // minutes ago it could just say 34m ago". This assertion was written to enforce the OLDER
    // ruling and fires only when the age happens to fall in the minutes band, which is why it
    // passed one run and failed the next. What still holds is the half that was never in doubt:
    // DISTANCES keep their spelled-out units, so a bare m can never be a distance. That is
    // asserted above against Mm/Gm. The age is now allowed to read 6m, by instruction.
    ok("the live footer prints an age at all", hasAge,
       liveAgeText.trim().slice(0, 70) || "(empty)");

    // 🔴 HOW OLD OUR COPY IS, AND HOW OLD A QUOTE IS, ARE TWO LADDERS (Sub, 2026-08-22: "how about
    // we do updated and then the minutes ago?"). The footer used ageOf, which is built for quote
    // ages with a median of 34 DAYS — so its lowest rung is the word "today" and every possible
    // footer value collapsed onto it, while the table is actually refreshed every six hours and the
    // whole interesting range sits under a day.
    // ⚠️ Extractor written FIRST and its output printed, so a failure names the string it read
    // rather than the whole line — the ELEVENTH control lesson, which cost an assertion that
    // measured the wrong slice.
    {
      // The footer IS the age now - no "updated " prefix to slice off (Sub, 2026-08-22).
      const at = liveFooterAge.indexOf("offline") > -1 ? -1 : 0;
      const stated = at < 0 ? "(footer is on a fallback tier)" : liveFooterAge.trim();
      // Positive first: on a cache/bundled tier the footer legitimately says "offline - ..." and
      // there is no freshness to check, so say which case ran rather than passing silently.
      const isLive = at >= 0;
      ok("the footer states when our copy was last updated", isLive || liveFooterAge.indexOf("offline") > -1,
         liveFooterAge || "(empty)");
      if (isLive) {
        const relative = stated.indexOf(" ago") > -1 || stated === "just now";
        ok("...as a relative time, not a quote-age band",
           relative, "extracted: [" + stated + "]");
        // The exact bands ageOf would have produced. Their presence IS the regression.
        const bands = ["today", "1d", "mo"];
        const band = bands.filter((b) => stated === b || (b === "mo" && stated.indexOf("mo") > -1));
        ok("...and never the quote ladder's wording", band.length === 0,
           "extracted: [" + stated + "] matched: " + (band.join(",") || "none"));
      }
    }
  }

  /* ── 🔴 THE CREDIT ENDS THE LINE, AND THE ⓘ KEEPS TWO AGES APART (Sub, 2026-08-22) ──────────
     "UEX logo right-justified, the age beside it, and an information icon explaining how often
     the table refreshes."

     🔴 TWO ASSERTIONS THAT LOOK RIGHT AND CANNOT FAIL WERE WRITTEN FIRST, and both survived the
     control (restoring flex:1 on #src). They are recorded because the reasoning behind each is
     the trap:
       - "nothing sits to the right of the mark" - under flex:1 the block stretches to the right
         edge and its children still PACK LEFT, so the dead space that appears after the mark is
         empty space, not an element. Nothing to find.
       - "the age sits beside the badge" - same reason. The gaps between the three children stay
         at the flex gap of 7px whether the box is 119px or 1040px; only the slack after the last
         child changes.
     What actually moves is the BOX: sized to its contents it is 119px, stretched it is whatever is
     left of the footer, and its right edge slides 160px off the inset. So both of those are what
     get measured. Same lesson as the Verse Finder's own price column - the dead space belongs to
     the box, and only measuring the box against its contents finds it. */
  {
    var creditFoot = document.querySelector(".foot");
    var creditMark = document.getElementById("uexmark") || document.getElementById("uexname");
    var creditAge = document.getElementById("srctext");
    var creditBlock = document.getElementById("src");
    var creditInfo = document.getElementById("fresh");
    ok("the footer carries a credit, an age and the ⓘ that qualifies it",
       !!creditFoot && !!creditMark && !!creditAge && !!creditInfo,
       [creditFoot ? "foot" : "no foot", creditMark ? "mark" : "no mark",
        creditAge ? "age" : "no age", creditInfo ? "info" : "no info"].join(" "));

    if (creditFoot && creditMark && creditAge && creditInfo && creditBlock) {
      var fR = creditFoot.getBoundingClientRect();
      var mR = creditMark.getBoundingClientRect();
      var bR = creditBlock.getBoundingClientRect();
      // The mark is the LAST thing in the credit block - the order half of the requirement, which
      // a DOM-order check states more directly than any geometry could.
      var blockKids = [].slice.call(creditBlock.children);
      ok("the UEX mark is the last thing in the credit block",
         blockKids.length > 1 && blockKids[blockKids.length - 1] === creditMark,
         blockKids.map(function (c) { return c.id || c.tagName; }).join(" then "));

      /* 🔴 AND IT REACHES THE FOOTER'S RIGHT INSET. Measured against the footer's OWN computed
         padding rather than a number written here - the padding is the only thing that can say
         where the inset is, and picking a number is how a layout assertion rots. */
      var footPad = parseFloat(getComputedStyle(creditFoot).paddingRight) || 0;
      var markInset = Math.round(fR.right - footPad - mR.right);
      ok("🔴 ...and it reaches the footer's right inset, not some spot short of it",
         Math.abs(markInset) <= 2,
         "mark ends " + markInset + "px short of the " + Math.round(footPad) + "px inset");

      /* 🔴 THE BLOCK RESERVES NO DEAD SPACE. This is the assertion that survives the control,
         because it measures the BOX against what is in it. Under flex:1 the block is whatever is
         left of the footer while its contents are ~119px, and the slack is invisible to any check
         made on the children alone. */
      var kidsWidth = blockKids.reduce(function (a, c) {
        return a + c.getBoundingClientRect().width;
      }, 0);
      var blockGap = parseFloat(getComputedStyle(creditBlock).columnGap) || 0;
      var blockSlack = Math.round(bR.width - kidsWidth - blockGap * (blockKids.length - 1));
      ok("🔴 ...because the credit block is sized to its contents and reserves nothing",
         blockSlack <= 2,
         "block " + Math.round(bR.width) + "px holding " + Math.round(kidsWidth) + "px of contents plus "
           + (blockKids.length - 1) + " gaps: " + blockSlack + "px of slack");
    }

    // The ⓘ itself. Positive first: it must really open, or every claim about its words below is
    // a claim about an empty string.
    var freshPop = document.getElementById("freshpop");
    var freshOpened = false;
    if (creditInfo && freshPop) {
      /* 🔑 MEASURED ON BOXES THAT ARE FREE TO MOVE. #panel is pinned to 480px in this page's own
         CSS, so "the panel did not grow" can never fail and would read as the most on-point check
         here. The footer and the results list are in flow and really do move.

         🔴 AND MEASURED AGAINST A REFERENCE THAT CANNOT CONTAIN THE POPOVER, not as a before/after
         delta around the click. The delta version came back GREEN under a control that put the box
         in normal flow at 151px tall - because there it was in flow BEFORE the click too, so both
         readings already carried it and the difference was zero while the footer sat at 169px
         instead of 35px. The claim is absolute ("this costs the layout nothing"), so the baseline
         has to be the layout with the box explicitly taken out. Setting display:none is a no-op on
         a closed popover and a real removal under the control, which is exactly the discriminator
         that was missing. */
      /* ⚠️ EVERY LOCAL HERE IS PREFIXED, AND THAT IS NOT STYLE. This block first used footOpen and
         resOpen - names the eye-popover check 500 lines above already holds as CONST, in the same
         function scope. A var beside a const of the same name is a SyntaxError, so the suite threw
         with no name and no line, which is the PRELUDE-collision failure wearing a different hat:
         the six prelude names are not the only ones taken. Grep the WHOLE suite for an identifier
         before using it, or prefix it and skip the question. */
      freshPop.style.display = "none";
      var freshFootBare = creditFoot ? creditFoot.getBoundingClientRect().height : 0;
      var freshResBare = document.getElementById("results").getBoundingClientRect().height;
      freshPop.style.display = "";
      creditInfo.click();
      freshOpened = freshPop.matches(":popover-open");
      var freshFootOpen = creditFoot ? creditFoot.getBoundingClientRect().height : 0;
      var freshResOpen = document.getElementById("results").getBoundingClientRect().height;
      var freshPopH = freshPop.getBoundingClientRect().height;
      ok("the refresh ⓘ opens on a click", freshOpened, freshOpened ? "open" : "did not open");
      // Positive first: a box of zero height would satisfy "it costs nothing" for free.
      ok("...and there is a real box of it to cost anything", freshPopH > 20,
         Math.round(freshPopH) + "px tall");
      ok("🔴 ...and open, it still costs the footer and the results nothing",
         freshFootOpen === freshFootBare && freshResOpen === freshResBare,
         "foot " + Math.round(freshFootBare) + " without it, " + Math.round(freshFootOpen)
           + " with it open; results " + Math.round(freshResBare) + " vs " + Math.round(freshResOpen));

      /* 🔴 WHAT IT HAS TO SAY, as a RULING rather than as wording. Two claims, and the second is
         the load-bearing one: the six-hour cadence is how often OUR COPY is redownloaded, and a
         reader must not carry that number over onto the prices. Measured against the live table
         on 2026-08-22 a quote's median age is 38 days, so someone reading "34m ago" as the price
         age is wrong by about five weeks. An ⓘ that stated only the cadence would MAKE that
         misreading rather than prevent it, which is why the denial is asserted separately.
         ⚠️ If the wording is rewritten, move these tokens - do not delete the rule. */
      var freshWords = freshPop.textContent.toLowerCase();
      ok("...it states how often our copy is refreshed",
         freshWords.indexOf("6 hours") > -1 || freshWords.indexOf("six hours") > -1,
         // ⚠️ fromCharCode, not an escape, and this comment cost a run to learn: a suite body is
         // a template literal, so EVERY backslash in it - including one inside a comment - is
         // consumed before the code exists. A whitespace regex loses its backslash and silently
         // matches the bare letter instead; a newline escape becomes a real newline, which ends
         // the comment it was written in and turns the rest of the line into code.
         freshPop.textContent.split(String.fromCharCode(10)).join(" ").trim().slice(0, 80));
      var freshDenial = freshWords.indexOf("not how old the prices are");
      ok("🔴 ...and says outright that this is NOT how old the prices are",
         freshDenial > -1,
         freshDenial > -1 ? "denial at char " + freshDenial
                          : (freshWords.indexOf("not") > -1
                              ? "there is a 'not' but it is not about the prices"
                              : "no denial anywhere in the popover"));
      creditInfo.click();
      ok("...and closes again on a second click", !freshPop.matches(":popover-open"),
         freshPop.matches(":popover-open") ? "still open" : "closed");
    }
  }

  return out;
})()`;

// ── Suite: Verse Finder — the eye, and which terminal placed you ─────────────────────────────
//
// 🔴 EVERY ASSERTION HERE IS FIXTURE-DRIVEN, AND THAT IS THE POINT. The obvious test for this
// flight is "the eye no longer says Location unknown" against the live sidecar — and that would be
// an assertion about HOW LONG AGO SUB LAST PLAYED, not about the code. This widget already went
// red once on untouched code for exactly that reason. The live acceptance is a thing to look at;
// what belongs in a suite is the render, driven from origins the fixture chooses.
//
// ⚠️ NO REGEX AND NO BACKSLASH ESCAPES IN THIS BODY, comments included — a template literal eats
// them before the code exists. indexOf and character comparison only.
const VERSEEYE = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);

  // Defensive lookups. A missing element must FAIL its own assertion, not throw and take the run
  // down — and the DETAIL argument is evaluated eagerly, so it needs the same care as the
  // condition. A suite that dies here reports a small PASS for everything it never reached.
  const eyeLbl = () => { const e = document.getElementById("eyelbl"); return e ? e.textContent : "(no #eyelbl)"; };
  const eyePop = () => { const e = document.getElementById("eyepop"); return e ? e.textContent : "(no #eyepop)"; };
  const eyeCls = () => { const e = document.getElementById("eye"); return e ? e.className : "(no #eye)"; };
  const eyeTitle = () => { const e = document.getElementById("eye"); return e ? (e.title || "") : "(no #eye)"; };

  const TERMDETAIL = "Levski Cargo Office Commodities";
  const originOf = (over) => Object.assign({
    tier: "place", label: "Levski", summary: "Levski . just now", ageMin: 0, stale: false,
    from: "the shop terminal you used names this place", detail: null, howToImprove: "improve me",
  }, over);

  // ── 1. A TERMINAL FIX. Positive first: the fix has to RENDER before anything about where its
  //       parts landed can mean a thing, and a renderEye that silently did nothing would satisfy
  //       every must-not check below for free.
  {
    renderEye(originOf({ detail: TERMDETAIL }), null);
    await sleep(60);
    ok("a terminal-sourced fix renders its summary on the face",
       eyeLbl().indexOf("Levski") >= 0, eyeLbl());
    ok("...and the face reads as a precise fix, not as unknown",
       eyeCls().indexOf("precise") >= 0, eyeCls());

    // 🔑 THE PRECISION HALF — which desk inside the station. Sub's ask was the difference between
    // "at Levski" and "meet me at the cargo office at Levski".
    ok("...the popover names WHICH terminal placed you",
       eyePop().indexOf(TERMDETAIL) >= 0, eyePop().slice(0, 150));
    ok("...and the hover carries the same words as the click",
       eyeTitle().indexOf(TERMDETAIL) >= 0, eyeTitle().slice(0, 150));

    // 🔴 AND IT STAYS OFF THE FACE. That is a decision, not an omission: the face sits a few pixels
    // from an age, a distance and a travel time, and the last thing appended there was read as a
    // distance. Paired with the positive above, so an empty render cannot satisfy it.
    ok("...but the FACE stays the place alone, beside three other quantities",
       eyeLbl().indexOf("Cargo Office") < 0, eyeLbl());
  }

  // ── 2. THE LINE IS CONDITIONAL. Every other tier carries no detail, and must not grow a
  //       sentence about a terminal nobody touched.
  {
    renderEye(originOf({ from: "an ASOP terminal named this place", detail: null }), null);
    await sleep(60);
    ok("a fix with no terminal still renders", eyeLbl().indexOf("Levski") >= 0, eyeLbl());
    ok("...and says nothing about where you were standing",
       eyePop().indexOf("You were at") < 0, eyePop().slice(0, 150));
  }

  // ── 3. UNKNOWN still says so, and still asks for something. This is the state the flight exists
  //       to make rare — it must stay correct rather than being papered over.
  {
    renderEye({ tier: "unknown", label: "Unknown", summary: "Location unknown", ageMin: null,
                stale: true, from: "nothing in this session has said where you are",
                detail: null, howToImprove: "Opening your inventory will." }, null);
    await sleep(60);
    ok("an unknown origin still says Location unknown",
       eyeLbl() === "Location unknown", eyeLbl());
    ok("...and wears the state that asks the player for something",
       eyeCls().indexOf("none") >= 0, eyeCls());
    ok("...and still tells them what to do about it",
       eyePop().indexOf("Opening your inventory") >= 0, eyePop().slice(0, 150));
  }

  // ── 4. THE WIDGET DOES NOT COMPOSE THE SUMMARY. It is the server's own string, worded once in
  //       originSummary so every surface says it identically. A widget that rebuilt it would be a
  //       second place for the spelled-out age rule to drift out of.
  {
    renderEye(originOf({ summary: "somewhere in Pyro . 3h ago", tier: "system", label: "Pyro" }), null);
    await sleep(60);
    ok("the face is the server's summary verbatim",
       eyeLbl() === "somewhere in Pyro . 3h ago", eyeLbl());
  }

  return out;
})()`;

// ── Suite: Verse Finder — ships, commodities, and which kind of blank ────────────────────────
//
// Its own suite rather than more assertions in VERSEFINDER, because it drives five DIFFERENT
// queries and the existing suite is built around one ("cannon") whose rows it re-reads throughout.
//
// 🔴 EVERY NEGATIVE HERE IS PAIRED WITH A POSITIVE ABOUT THE SAME SET, and it is not decoration.
// "No cannon row carries a rent tag" is satisfied for free by a page with no rows on it — and a
// broken search is exactly what would empty it. The positive assertion above each negative is what
// separates "the rule held" from "nothing was rendered at all".
//
// ⚠️ NO REGEX ANYWHERE IN THIS BODY. A backslash escape inside a template literal is eaten before
// the pattern is ever compiled: \\b silently becomes a backspace byte and \\d loses its backslash,
// so the regex compiles and never matches — which makes every "must not contain" assertion pass
// forever. Two of three regex assertions in this widget's last suite were false passes for exactly
// that reason. indexOf and character comparison only.
const VERSEDEALERS = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);

  const box = document.getElementById("q");
  const search = async (v) => {
    box.value = v;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(800);
  };
  const items = () => [...document.querySelectorAll("#results .item")];
  const rows = () => [...document.querySelectorAll("#results .grow")];
  const rents = () => [...document.querySelectorAll("#results .tag.rent")];
  const stocks = () => [...document.querySelectorAll("#results .tag.stock")];
  const hints = () => [...document.querySelectorAll("#results .hint .hrow")];
  const emptyText = () => {
    const e = document.querySelector("#results .empty");
    return e ? e.textContent : "(no .empty element)";
  };
  const moreOf = (el) => {
    const m = el ? el.querySelector(".more") : null;
    return m ? m.textContent : "(no .more element)";
  };

  // ══ 1. SHIPS ══════════════════════════════════════════════════════════════════════════════
  // 🔑 The query is a real hull that is BOTH sold and rented (49 vehicles are; 130 are sale-only),
  // because a ship with only purchase rows could never fail the rent assertions and a rental-only
  // one does not exist in the data at all. Both halves of the rule have to be populated or the
  // pairing below is a tautology.
  await search("100i");
  const ship = items()[0] || null;
  ok("🔴 a ship is a result at all", !!ship, items().length + " items");
  ok("...named as the hull, not as a dealer listing",
     !!ship && ship.querySelector(".iname").textContent.indexOf("100i") === 0,
     ship ? ship.querySelector(".iname").textContent : "(none)");
  ok("...and the category rides the name so it reads as a ship",
     !!ship && ship.querySelector(".iname").textContent.indexOf("Ships") > -1,
     ship ? ship.querySelector(".iname").textContent : "(none)");
  ok("...with its manufacturer as a chip, like any other item",
     !!ship && !!ship.querySelector(".chip.mk"),
     ship && ship.querySelector(".chip.mk") ? ship.querySelector(".chip.mk").textContent : "(no mk chip)");

  // 🔴 THE ONE DIFFERENCE HONESTY FORCES. Positive first: there must be BOTH kinds of row, or
  // "some rows are labelled rent" and "every row is labelled rent" are indistinguishable.
  const shipRows = rows().length;
  const shipRents = rents().length;
  ok("this ship really is offered both ways", shipRows > 1 && shipRents > 0 && shipRents < shipRows,
     shipRents + " rental rows of " + shipRows);
  ok("🔴 a rental row SAYS rent", shipRents > 0 && rents().every((t) => t.textContent.indexOf("rent") > -1),
     shipRents ? rents()[0].textContent : "(no rent tag)");
  // 🔴 The tag rides the SHOP, not the price — and that placement is load-bearing rather than
  // aesthetic. Sub already ruled that price and age must stay adjacent (VERSEFINDER pins it), and
  // a tag between them is that split. Asserting the pairing here too means a ship row is held to
  // the same rule the item rows are, which is the only way that rule stays universal.
  ok("...the tag rides the shop name, leaving price and age untouched",
     shipRents > 0 && rents().every((t) => {
       const prev = t.previousElementSibling;
       return !!prev && prev.classList.contains("gshop");
     }),
     shipRents ? "previous sibling: " + ((rents()[0].previousElementSibling || {}).className || "(none)") : "(no tags)");
  {
    const kids = (r) => [...r.children];
    const paired = rows().filter((r) => {
      const ai = kids(r).findIndex((k) => k.classList.contains("age"));
      const pi = kids(r).findIndex((k) => k.classList.contains("price"));
      return ai >= 0 && pi >= 0 && Math.abs(ai - pi) === 1;
    });
    ok("🔴 price and age stay adjacent on a RENTAL row too",
       shipRows > 0 && paired.length === shipRows, paired.length + " of " + shipRows);
  }

  // 🔴 TWO SPREADS. A single min/max over purchases and rentals would run from a 28,665 aUEC hire
  // to a 1,089,270 aUEC sale and describe no transaction anyone can make.
  ok("the rental price is quoted SEPARATELY from the purchase spread",
     moreOf(ship).indexOf("rental") > -1, moreOf(ship));

  // ══ 2. NOTHING ELSE MAY WEAR THE RENT TAG ═════════════════════════════════════════════════
  await search("cannon");
  const cannonRows = rows().length;
  ok("the control query renders rows at all", cannonRows > 0, cannonRows + " rows");
  ok("...and not one of them is labelled a rental", rents().length === 0, rents().length + " rent tags");
  ok("...nor claims a stock figure, because items have no stock field anywhere",
     stocks().length === 0, stocks().length + " stock tags");

  // ══ 3. COMMODITIES ════════════════════════════════════════════════════════════════════════
  // 🔴 This is the whole of gap 2: the data was already on the player's disk and the widget would
  // not look at it, so this query used to return the identical blank a typo returns.
  await search("laranite");
  const com = items().find((el) => el.querySelector(".iname").textContent.indexOf("Commodity") > -1) || null;
  ok("🔴 a commodity is findable from this box", !!com,
     items().map((el) => el.querySelector(".iname").textContent).join(" | ") || "(none)");
  const comRows = com ? [...com.querySelectorAll(".grow")] : [];
  ok("...and it names terminals, not a single price", comRows.length > 1, comRows.length + " rows");
  const comStock = com ? [...com.querySelectorAll(".tag.stock")] : [];
  ok("🔑 ...carrying the stock an ITEM row cannot", comStock.length > 0, comStock.length + " stock tags");
  ok("...stated in SCU rather than as a bare number",
     comStock.length > 0 && comStock.every((t) => t.textContent.indexOf("SCU") > -1),
     comStock.length ? comStock[0].textContent : "(none)");
  ok("...and it points at the Trade widget for selling rather than guessing a sell price",
     moreOf(com).indexOf("Trade") > -1, moreOf(com));

  // ══ 4. THE BLANK THAT KNOWS IT IS NOT A TYPO ══════════════════════════════════════════════
  // 🔴 Both of the next two searches return ZERO results. That is the point: the assertion is not
  // about the count, it is that the two produce DIFFERENT pages. An older build rendered the same
  // sentence for both, which told a player their armour set does not exist.
  await search("Corbel Patina");
  ok("a real-but-unsold item still returns no shops", items().length === 0, items().length + " items");
  const namedHints = hints().length;
  ok("🔴 ...but the widget NAMES it instead of shrugging", namedHints > 0, namedHints + " named");
  ok("...and says outright that it exists", emptyText().indexOf("does exist") > -1, emptyText());
  ok("...listing the thing that was actually typed",
     hints().some((h) => h.textContent.indexOf("Corbel Patina") > -1),
     hints().map((h) => h.textContent).join(" | ") || "(none)");

  // ══ 5. A GENUINE TYPO IS STILL ALLOWED TO BE ONE ══════════════════════════════════════════
  // Without this the fix above would be a way of telling every player that everything exists.
  await search("zzqqxnothingatall");
  ok("a typo returns no shops either", items().length === 0, items().length + " items");
  ok("🔴 ...and NAMES nothing, unlike the case above", hints().length === 0, hints().length + " named");
  ok("...saying it was not found, which is the only case allowed to say that",
     emptyText().indexOf("Nothing found") > -1, emptyText());

  return out;
})()`;

// ── Suite: Log View releases the canvas grab ─────────────────────────────────
// Its own suite rather than a third key in TYPINGGRAB, because that loop drives a "type mode"
// BUTTON and this widget has none — focus is taken by clicking into the filter box, which is the
// deliberate act. Same danger though, and it is the worst one in the widget: while the grab is
// held no click on any display reaches the game, and hiding UNLOADS the page so a grab stranded
// that way can never be lowered by anything on screen.
// Negative-controlled: removing logView's onHide turns "hiding it releases the grab" red.
const LOGVIEWGRAB = `(async () => {
  ${PRELUDE}
  window.__editing = false;
  const w = WBY.logView;
  ok("Log View is in the registry", !!w, w ? w.key : "MISSING");
  setWidgetVisible(w, true);
  await sleep(400);
  let box = null;
  try { box = document.getElementById("wf-logView").contentWindow.document.getElementById("filter"); }
  catch { /* frame never loaded */ }
  ok("the page has a filter box", !!box);
  if (box) {
    // 🔑 A HIDDEN BrowserWindow NEVER FIRES THE focus EVENT. Measured: after box.focus() the
    // element really is document.activeElement, and the grab still does not arm — the harness
    // drives an offscreen window, which has no focus to give, so the event the page listens for
    // is never dispatched. Same family as rAF and CSS transitions not advancing here.
    // So: assert focus() really lands on the box (that part IS observable), then dispatch the
    // event the browser would have. Everything past that point is the page's own handler and the
    // real host bridge — only Chromium's dispatch is stood in for, because it cannot be had.
    box.focus();
    await sleep(60);
    ok("focus lands on the filter box", box.ownerDocument.activeElement === box,
       box.ownerDocument.activeElement ? box.ownerDocument.activeElement.id || box.ownerDocument.activeElement.tagName : "none");
    box.dispatchEvent(new (box.ownerDocument.defaultView.Event)("focus"));
    await sleep(60);
    ok("focusing the filter arms the canvas grab", window.__editing === true);
    setWidgetVisible(w, false);
    await sleep(200);
    ok("hiding it releases the grab", window.__editing === false);
  }
  return out;
})()`;

// ── Suite: Log View — raw lines, the caps, the filter, the freeze ────────────
// This widget's whole reason for existing is to answer "is X even logged?", so the assertions
// that matter are the ones about NOT losing a line and NOT lying about one: the DOM cap, the ring
// reaching further back than the DOM, a dropped line being said out loud, and the clipboard
// getting the RAW text rather than what we rendered.
// Driven through the page's own push()/render() rather than a live game, so it asserts behaviour
// instead of whatever Sub happened to be flying.
const LOGVIEW = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400); // let the page's own connect()/render() settle before driving it

  const rowCount = () => document.querySelectorAll("#rows .row").length;
  const rowText = () => [...document.querySelectorAll("#rows .row")].map((r) => r.textContent);
  const mk = (n, s) => ({ n, t: Date.now(), s });

  // Start from a known state. The page is talking to the LIVE sidecar, which is tailing a real
  // game.log — asserting against whatever it has streamed would be asserting on Sub's evening.
  ring = []; dropped = 0; filterText = ""; document.getElementById("filter").value = "";
  setPaused(false);
  render();

  const stamp = "<2026-08-17T22:00:00.000Z>";
  push([mk(1, stamp + " [Notice] <CObjectiveMarkerComponent::AddToPlayerDataBank> marker one"),
        mk(2, stamp + " [Notice] <CSCItemNavigation> routing from Pyro System to Orbituary")]);
  await sleep(40);
  ok("a line the game wrote appears", rowCount() === 2, rowCount());
  ok("...carrying the whole raw line, timestamp included",
     rowText()[0].indexOf("AddToPlayerDataBank") > -1 && rowText()[0].indexOf(stamp) === 0,
     rowText()[0].slice(0, 60));
  // The timestamp is DIMMED, not removed. Removing it would be editing the log; a widget whose job
  // is to say what the game said may not quietly reformat it.
  ok("...with the timestamp dimmed rather than stripped",
     !!document.querySelector("#rows .row .ts"),
     document.querySelector("#rows .row .ts") ? document.querySelector("#rows .row .ts").textContent : "none");

  // 🔴 THE MELT GUARD. The overlay is always-on-top and composited over the game; an unbounded
  // row list is how you take the frame rate down with it. 900 pushed, at most 500 kept.
  const many = [];
  for (let i = 0; i < 900; i++) many.push(mk(100 + i, stamp + " [Notice] <Filler> bulk line " + i));
  push(many);
  await sleep(80);
  ok("the DOM is capped however loud the log gets", rowCount() <= 500, rowCount());
  ok("...keeping the NEWEST lines, not the oldest",
     rowText()[rowText().length - 1].indexOf("bulk line 899") > -1,
     rowText()[rowText().length - 1].slice(-30));

  // 🔑 The ring must outreach the DOM. Typing a word has to search the recent past, not only what
  // survived the row cap — otherwise the widget can only answer "is X logged" for lines that
  // arrive after you thought to ask, which is the wrong half of the question.
  const buried = "AddToPlayerDataBank";
  ok("a line pushed off the DOM is still held for the filter",
     ring.some((l) => l.s.indexOf(buried) > -1) && !rowText().some((t) => t.indexOf(buried) > -1),
     "ring " + ring.length + " / rows " + rowCount());

  const filterTo = async (v) => {
    const el = document.getElementById("filter");
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(60);
  };
  await filterTo(buried);
  ok("...and the filter reaches back and finds it", rowCount() === 1, rowCount());
  ok("...showing only what matched", rowText()[0].indexOf(buried) > -1, rowText()[0].slice(0, 60));
  ok("the filter is case-insensitive, because nobody types engine casing",
     (await filterTo("addtoplayerdatabank"), rowCount()) === 1, rowCount());

  // A miss is SAID. Otherwise "no line matched" and "nothing has arrived" render identically, and
  // the reader concludes the game is silent when it is the filter that is wrong.
  await filterTo("qqzzx-no-such-token");
  ok("a filter that matches nothing says so on the control",
     document.getElementById("filter").classList.contains("miss"));
  ok("...and explains the empty panel in words",
     document.querySelector("#rows .empty") && /No line matches/.test(document.querySelector("#rows .empty").textContent),
     document.querySelector("#rows .empty") ? document.querySelector("#rows .empty").textContent : "no empty state");
  await filterTo("");
  ok("clearing the filter drops the miss marking", !document.getElementById("filter").classList.contains("miss"));

  // ── the freeze ────────────────────────────────────────────────────────────
  // Pause freezes the VIEW, never the feed. Sub wants it so a line he has spotted cannot scroll
  // away; a pause that also dropped the lines arriving behind it would trade one lost line for
  // many, which is the opposite of the point.
  const before = rowCount();
  setPaused(true);
  push([mk(9001, stamp + " [Notice] <Frozen> arrived behind the freeze")]);
  await sleep(60);
  ok("pausing freezes the view", rowCount() === before, rowCount() + " vs " + before);
  ok("...while the feed keeps running behind it",
     ring.some((l) => l.s.indexOf("arrived behind the freeze") > -1));
  ok("...and says how many are waiting", /PAUSED . 1 new/.test(document.getElementById("stat").textContent),
     document.getElementById("stat").textContent);
  setPaused(false);
  await sleep(60);
  ok("resuming shows what arrived while frozen",
     rowText().some((t) => t.indexOf("arrived behind the freeze") > -1));

  // 🔴 A dropped line is SAID, never swallowed. An instrument that quietly omits lines answers
  // "is X logged?" with a confident, wrong no — which is the exact failure this widget exists to
  // stop, so silence here would be worse than not shipping it.
  dropped = 0;
  ok("nothing is claimed dropped when nothing was", document.getElementById("warn").textContent === "",
     document.getElementById("warn").textContent);
  dropped = 7; status();
  ok("a burst the server shed is admitted out loud", /7 dropped/.test(document.getElementById("warn").textContent),
     document.getElementById("warn").textContent);
  dropped = 0; status();

  // ── click to copy ─────────────────────────────────────────────────────────
  // ⚠️ Every row keeps the untouched server string on _raw, and the copy reads THAT rather than
  // the rendered text. Today the two are identical — so "the clipboard is not the rendered text"
  // is a claim this suite cannot falsify, and it is not made. What IS asserted is the mechanism:
  // the row carries the exact string the server sent, and that exact string is what the clipboard
  // gets. Negative-controlled by deleting the _raw assignment, which turns both red.
  // (The reason _raw exists at all is the first decoration anyone adds — a highlight, a repeat
  // count, an ellipsis — at which point textContent silently stops being what the game wrote, and
  // Sub pastes our edit of a log line into a conversation about what the log line said.)
  let copied = null;
  const realClip = navigator.clipboard;
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: (t) => { copied = t; return Promise.resolve(); } },
    });
  } catch { /* left as the real one; the assertion below will say so */ }
  await filterTo(buried);
  const row = document.querySelector("#rows .row");
  const sent = ring.filter((l) => l.s.indexOf(buried) > -1)[0];
  ok("there is a line to click", !!row && !!sent);
  if (row && sent) {
    ok("the row holds the untouched string the server sent", row._raw === sent.s, String(row._raw).slice(0, 60));
    row.click();
    await sleep(60);
    ok("clicking a line copies it", typeof copied === "string" && copied.length > 0, String(copied).slice(0, 50));
    ok("...exactly as the game wrote it, timestamp and all", copied === sent.s, String(copied).slice(0, 60));
    ok("...and the row acknowledges the click", row.classList.contains("flash"));
  }
  try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: realClip }); } catch { /* fine */ }

  await filterTo("");
  return out;
})()`;

const TYPINGGRAB = `(async () => {
  ${PRELUDE}
  window.__editing = false;
  // The Event Tracker takes the grab from its tier-reward card rather than a type-mode button,
  // so it is driven by putting a prompt in front of it. Same rule, same consequence: a grab this
  // widget takes and never gives back locks every monitor, and hiding it UNLOADS the iframe so
  // nothing on screen can lower it.
  {
    const w = WBY.battaglia;
    setWidgetVisible(w, true);
    await sleep(350);
    const fw = document.getElementById("wf-battaglia") ? document.getElementById("wf-battaglia").contentWindow : null;
    ok("battaglia: the frame is reachable", !!fw && !!fw.__battReload);
    if (fw && fw.__battReload) {
      const real = fw.fetch;
      fw.fetch = async (u, o) => {
        if (String(u).indexOf("/api/events") >= 0 && String(u).indexOf("reward") < 0) {
          return new fw.Response(JSON.stringify({
            feed: null, reporting: false, events: [],
            rewardPrompt: { id: "grab:25", eventId: "grab", eventLabel: "Grab", tier: 25,
              crossedAt: "", crossedAtMs: Date.now(), observed: null, candidate: null, answer: null, reported: false },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return real(u, o);
      };
      await fw.__battReload();
      await sleep(200);
      // POSITIVE first: if the card never rendered a text field, "the grab was released" is free.
      ok("battaglia: a blind prompt opens a text field", !!fw.document.getElementById("rwtext"));
      ok("battaglia: typing arms the canvas grab", window.__editing === true);
      setWidgetVisible(w, false);
      await sleep(200);
      ok("battaglia: hiding it releases the grab", window.__editing === false);
      fw.fetch = real;
    }
  }
  for (const key of ["twitchChat", "webView"]) {
    const w = WBY[key];
    setWidgetVisible(w, true);
    await sleep(250);
    let btn = null;
    try { btn = document.getElementById("wf-" + key).contentWindow.document.getElementById("typeBtn"); } catch { /* frame never loaded */ }
    ok(key + ": the page has a type-mode button", !!btn);
    if (!btn) continue;
    btn.click();
    await sleep(60);
    ok(key + ": typing arms the canvas grab", window.__editing === true);
    setWidgetVisible(w, false);
    await sleep(150);
    ok(key + ": hiding it releases the grab", window.__editing === false);
  }
  return out;
})()`;

// ── Suite: a page error reaches the sidecar ───────────────────────────────────
// The canvas forwards window error events to POST /api/client-error (its own console does not
// exist packaged). Drive it with a synthetic ErrorEvent and read it back from diagnostics —
// end to end through the real route. Negative-controlled: with the forwarding hook removed
// from missions.html, "a page error reaches the sidecar" goes red.
const CLIENTERR = `(async () => {
  ${PRELUDE}
  const tag = "harness-synthetic-error-" + Date.now();
  window.dispatchEvent(new ErrorEvent("error", { message: tag }));
  await sleep(400);
  let d = null;
  try { d = await (await fetch("/api/diagnostics", { cache: "no-store" })).json(); } catch { d = null; }
  const errs = (d && d.recentClientErrors) || [];
  ok("a page error reaches the sidecar", errs.some((e) => e.msg === tag), JSON.stringify(errs.slice(-3)).slice(0, 140));
  ok("...tagged with where it came from", errs.some((e) => e.msg === tag && (e.from === "canvas" || e.from === "tracker-page")));
  ok("the diagnostics log tail is present or says why not", !!(d && d.logTail && (d.logTail.lines.length || d.logTail.note)));
  return out;
})()`;

// ── Suite 11: per-widget angle ────────────────────────────────────────────────
// Sub's report: "people can't change the angle of the widget, and the newer ones don't even have
// the option." Both were real. The angle was written to --wangle inside the `scaled` branch of
// applyFrame() only — so when the last scaled widget (Mining) became a box in 0.1.34, the two
// sliders that existed moved a value nothing read, and the seven widgets added since never got a
// control at all. These assertions are per-widget on purpose: a fix that only works for the
// Blueprint panel is the bug again.
//
// Two widgets opt OUT (noAngle, Sub 2026-07-29): Web Page hosts somebody else's site, and the
// Infographic Viewer shows dense reference art — tilting either only costs legibility. They must
// stay flat AND show no control, which is what TILTING/FLAT below separate.
const ANGLE = `(async () => {
  ${PRELUDE}
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(1200);                       // iframes must LOAD before their settings rows exist
  for (const w of WIDGETS) probeSettings(w);
  const tf = (w) => getComputedStyle(el(w)).transform;
  const TILTING = WIDGETS.filter((w) => !w.noAngle);
  const FLAT = WIDGETS.filter((w) => w.noAngle);

  // ── it applies at all ───────────────────────────────────────────────────────
  const deaf = [], flat0 = new Map();
  for (const w of WIDGETS) flat0.set(w.key, tf(w));
  for (const w of TILTING) {
    setWidgetAngle(w, 20);
    const t = tf(w);
    if (cs(w, "--wangle").trim() !== "20deg") deaf.push(w.key + " var=" + cs(w, "--wangle"));
    else if (t === "none" || t === flat0.get(w.key)) deaf.push(w.key + " transform unchanged (" + t + ")");
  }
  ok("every tilting widget tilts when its angle changes", deaf.length === 0, deaf.slice(0, 4).join(" | "));

  const neg = [];
  for (const w of TILTING) { setWidgetAngle(w, -20); if (cs(w, "--wangle").trim() !== "-20deg") neg.push(w.key); }
  ok("...in both directions", neg.length === 0, neg.join(","));

  // The opt-outs must IGNORE the angle, not merely lack a slider — a stale saved value or a
  // tilted group would otherwise leave them crooked with no way back.
  const stuck = [];
  for (const w of FLAT) {
    setWidgetAngle(w, 20);
    if (cs(w, "--wangle").trim() !== "0deg") stuck.push(w.key + " var=" + cs(w, "--wangle"));
  }
  ok("a no-angle widget stays flat when something tries to tilt it", stuck.length === 0, stuck.join(",") || FLAT.map(w => w.key).join(","));
  ok("angle is clamped to the slider range", setWidgetAngle(WBY.notepad, 400) === 35 && setWidgetAngle(WBY.notepad, -400) === -35);
  ok("a junk angle reads as flat, not NaNdeg", setWidgetAngle(WBY.notepad, "banana") === 0 && cs(WBY.notepad, "--wangle") === "0deg", cs(WBY.notepad, "--wangle"));

  // ── every widget offers a way to change it ──────────────────────────────────
  const noCtl = [], dead = [], strayCtl = [];
  for (const w of FLAT) {
    if (angleControls(w).filter(c => c.input).length) strayCtl.push(w.key);
  }
  ok("...and offers no angle control at all", strayCtl.length === 0, strayCtl.join(",") || FLAT.map(w => w.key).join(","));
  for (const w of TILTING) {
    const ctls = angleControls(w).filter(c => c.input);
    if (!ctls.length) { noCtl.push(w.key); continue; }
    // and the control is wired: driving the input must move the widget
    const input = ctls[0].input;
    input.value = "12";
    input.dispatchEvent(new (input.ownerDocument.defaultView.Event)("input", { bubbles: true }));
    await sleep(20);
    if (cs(w, "--wangle").trim() !== "12deg") dead.push(w.key + " -> " + cs(w, "--wangle"));
  }
  ok("every tilting widget exposes an angle control", noCtl.length === 0, noCtl.join(",") || TILTING.map(w => w.key).join(","));
  ok("...and driving that control tilts the widget", dead.length === 0, dead.slice(0, 4).join(" | "));

  // every control on a widget shows the SAME number (bespoke slider + injected row + popover)
  const desync = [];
  for (const w of TILTING) {
    setWidgetAngle(w, -7);
    for (const c of angleControls(w)) if (c.input && Number(c.input.value) !== -7) desync.push(w.key);
  }
  ok("all of a widget's angle controls agree", desync.length === 0, [...new Set(desync)].join(","));

  // ── it survives a restart ───────────────────────────────────────────────────
  const saved = [];
  window.overlayApi = Object.assign({}, window.overlayApi, {
    saveWidget: (id, l) => saved.push([id, JSON.parse(JSON.stringify(l))]),
  });
  setWidgetAngle(WBY.notepad, -13); persistLayout(WBY.notepad);
  const rec = saved.filter(s => s[0] === "notepad").pop();
  ok("a box widget's angle is persisted", rec && rec[1].angle === -13, rec ? JSON.stringify(rec[1]) : "nothing saved");

  // ── a stack shares one angle ────────────────────────────────────────────────
  while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
  setWidgetAngle(WBY.party, 15);
  groupWidgets(WBY.notepad, WBY.party);   // notepad dropped onto party
  await sleep(60);
  const g = GROUPS[0];
  ok("a new group takes the host widget's angle", g && g.angle === 15, g && g.angle);
  ok("both members render the group's angle",
     cs(WBY.party, "--wangle") === "15deg" && cs(WBY.notepad, "--wangle") === "15deg",
     cs(WBY.party, "--wangle") + " / " + cs(WBY.notepad, "--wangle"));
  saved.length = 0;
  setWidgetAngle(WBY.notepad, -9); persistLayout(WBY.notepad);
  ok("tilting one tab tilts the whole stack",
     GROUPS[0].angle === -9 && cs(WBY.party, "--wangle") === "-9deg", cs(WBY.party, "--wangle"));
  ok("a stacked widget saves its angle to the GROUP", saved.some(s => s[0] === "__groups"), saved.map(s => s[0]).join(","));
  detachFromGroup(WBY.notepad);
  await sleep(40);
  ok("popping a tab out keeps the tilt it had", cs(WBY.notepad, "--wangle") === "-9deg", cs(WBY.notepad, "--wangle"));

  // ── reset puts it back flat ─────────────────────────────────────────────────
  resetWidget(WBY.notepad);
  ok("reset flattens the widget", cs(WBY.notepad, "--wangle") === "0deg", cs(WBY.notepad, "--wangle"));
  ok("...and its control follows", angleControls(WBY.notepad).every(c => !c.input || Number(c.input.value) === 0));

  while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
  for (const w of WIDGETS) resetWidget(w);
  return out;
})()`;

// ── Suite: split fade — the panel and its text, independently ──────────────────
// 🔑 Half of these assertions exist because the FIRST attempt at this feature shipped a
// regression that 545 green assertions did not notice. It put the surface layer on
// ::after, which on a widget panel is already the skin's SHEEN, so the highlight
// silently vanished in all 16 themes and the whole suite stayed green — nothing had
// ever asserted the sheen exists. A green sweep is not coverage of what you changed.
const SPLITFADE = `(async () => {
  ${PRELUDE}
  const saved = [];
  window.overlayApi = Object.assign({}, window.overlayApi, {
    saveWidget: (id, l) => saved.push([id, JSON.parse(JSON.stringify(l))]),
  });
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(1200);                        // iframes must LOAD before we can reach into them
  const party = WBY.party, mining = WBY.mining, bp = WBY.blueprint;
  const fdoc = (w) => document.getElementById("wf-" + w.key).contentDocument;
  // 🔑 A hidden window never composites, so a TRANSITIONED property reads as its start value
  // forever. The fade is transitioned on purpose, so transitions have to be switched off
  // inside each frame before a single value is measured — otherwise every assertion below
  // would read the pre-change number and the suite would pass while testing nothing.
  const killT = (d) => {
    const s = d.createElement("style");
    s.textContent = "*{transition:none !important}";
    d.head.appendChild(s);
  };
  killT(document); killT(fdoc(party)); killT(fdoc(mining));

  // ── the regression that forced the revert ───────────────────────────────────
  const pseudoBg = (d, which) => getComputedStyle(d.getElementById("panel"), which).backgroundImage;
  const hasGradient = (s) => String(s).indexOf("gradient") >= 0;
  ok("the Mining Scanner still has its skin sheen (::after)", hasGradient(pseudoBg(fdoc(mining), "::after")), pseudoBg(fdoc(mining), "::after").slice(0, 46));
  ok("...and so does the tracker", hasGradient(pseudoBg(document, "::after")), pseudoBg(document, "::after").slice(0, 46));
  ok("scanlines survive on a shared-sheet panel (::before)", hasGradient(pseudoBg(fdoc(party), "::before")), pseudoBg(fdoc(party), "::before").slice(0, 46));
  ok("...and on the tracker", hasGradient(pseudoBg(document, "::before")));

  // ── the two alphas are genuinely independent ────────────────────────────────
  // Compared as whole computed strings rather than parsed alphas: the point is only whether a
  // slider moved this property or left it alone, and string equality cannot be fooled by a
  // rounding difference the way a hand-rolled alpha parser can.
  const bgOf = (d) => getComputedStyle(d.getElementById("panel")).backgroundImage;
  const headOf = (d) => Number(getComputedStyle(d.getElementById("panel").querySelector(".head")).opacity);
  const setFade = (w, s, t) => { setWidgetDim(w, s * 100); setWidgetDimText(w, t * 100); };

  setFade(party, 1, 1);
  const bgFull = bgOf(fdoc(party)), headFull = headOf(fdoc(party));
  setFade(party, 0.3, 1);
  const bgGhost = bgOf(fdoc(party)), headGhost = headOf(fdoc(party));
  setFade(party, 1, 0.3);
  const bgSolid = bgOf(fdoc(party)), headFaint = headOf(fdoc(party));

  ok("the panel fill follows the PANEL slider", bgGhost !== bgFull);
  ok("...and ignores the TEXT slider", bgSolid === bgFull);
  ok("the content follows the TEXT slider", headFaint < 0.9, headFaint);
  ok("...and ignores the PANEL slider", headGhost > 0.99, headGhost);
  ok("the panel is unchanged at rest", headFull === 1 && hasGradient(bgFull));
  // The case the whole rebuild exists for. With one opacity the widget composites as a single
  // unit so text can only ever be DIMMER than its panel; with a nested one the two multiply.
  // Either way this combination does not exist at any setting.
  ok("a faint panel carrying FULL-strength text is reachable", bgGhost !== bgFull && headGhost > 0.99);
  ok("the wrapper carries no opacity of its own, so nothing multiplies",
     getComputedStyle(el(party)).opacity === "1", getComputedStyle(el(party)).opacity);

  // ── hover, which is no longer a CSS rule ────────────────────────────────────
  setFade(party, 0.3, 0.3);
  ok("full-on-hover defaults ON", wHoverFull(party));
  el(party).classList.add("touched"); applyFade(party);
  ok("engaging a widget restores it to full", bgOf(fdoc(party)) === bgFull);
  el(party).classList.remove("touched"); applyFade(party);
  ok("...and letting go fades it again", bgOf(fdoc(party)) !== bgFull);
  setWidgetHoverFull(party, false);
  ok("the preference is stored per widget", !wHoverFull(party));
  el(party).classList.add("touched"); applyFade(party);
  ok("interaction restores it even with full-on-hover OFF", bgOf(fdoc(party)) === bgFull,
     "the switch is about the cursor crossing, never about the widget you are using");
  el(party).classList.remove("touched"); setWidgetHoverFull(party, true);

  // Arrange mode and the override hotkey have to reach INSIDE the frame now — html.no-dim
  // cannot cross the boundary, so a CSS-only override would leave every widget ghosted while
  // you tried to place it.
  document.documentElement.classList.add("no-dim"); applyAllFades();
  ok("the fade override reaches into the frames", bgOf(fdoc(party)) === bgFull);
  document.documentElement.classList.remove("no-dim"); applyAllFades();
  ok("...and lifting it fades them again", bgOf(fdoc(party)) !== bgFull);

  // ── inheritance is a DEFAULT, never visible coupling ────────────────────────
  // The panel slider used to drag the text slider along with it, because text inherits the panel
  // value until it is set and the readouts showed the inherited number. It appeared to fix itself
  // once you touched Text, which is exactly what an inheritance bug looks like from outside.
  bp.s.dim = null; bp.s.dimText = null;
  const inherited = wDimText(bp);
  ok("text inherits the PANEL value while nothing is set", Math.abs(inherited - wDim(bp)) < 0.001, inherited);
  setWidgetDim(bp, 40);
  ok("moving the PANEL slider leaves the text alpha where it was",
     Math.abs(wDimText(bp) - inherited) < 0.001, "panel=" + wDim(bp) + " text=" + wDimText(bp));
  ok("...and the panel actually moved", Math.abs(wDim(bp) - 0.4) < 0.001, wDim(bp));
  setWidgetDimText(bp, 100);
  ok("the text slider still moves only itself", wDimText(bp) === 1 && Math.abs(wDim(bp) - 0.4) < 0.001);

  // ── dragging must not be transitioned ───────────────────────────────────────
  // A 0.18s transition is right for idle <-> hover and exactly wrong under a continuously
  // changing value: each input restarts it, so the panel trails the thumb and only arrives once
  // you let go. Sub reported it as "it does nothing, then catches up".
  const fadeMs = () => fdoc(party).documentElement.style.getPropertyValue("--wfade-ms");
  const partySlider = el(party).querySelector(".wcfg-dim");
  ok("the panel has a fade slider in its popover", !!partySlider);
  partySlider.value = "50";
  partySlider.dispatchEvent(new Event("input", { bubbles: true }));
  ok("dragging drops the transition to zero", fadeMs() === "0ms", fadeMs());
  partySlider.dispatchEvent(new Event("change", { bubbles: true }));
  ok("...and releasing gives it back", fadeMs() === "0.18s", fadeMs());

  // The tracker is local to THIS document, which hosts every other widget too.
  ok("the tracker fades on its own panel, never on :root",
     document.getElementById("panel").style.getPropertyValue("--wsurf") !== ""
     && document.documentElement.style.getPropertyValue("--wsurf") === "",
     "root=[" + document.documentElement.style.getPropertyValue("--wsurf") + "]");

  // ── persistence ─────────────────────────────────────────────────────────────
  saved.length = 0;
  persistW(party);
  const rec = saved.find((s) => s[0] === "party");
  ok("all three values persist", !!rec && "dim" in rec[1] && "dimText" in rec[1] && "hoverFull" in rec[1],
     rec ? Object.keys(rec[1]).join(",") : "nothing saved");
  // 🔑 persistW, not persistLayout: the fade is per WIDGET, but persistLayout writes to the
  // GROUP when one is stacked, so a grouped widget used to save its fade where nothing read
  // it back and silently forgot the setting on restart.
  saved.length = 0;
  groupWidgets(party, mining);
  await sleep(60);
  setWidgetDim(party, 45); persistW(party);
  ok("a STACKED widget still saves its fade to itself",
     saved.some((s) => s[0] === "party" && s[1] && s[1].dim === 0.45), saved.map((s) => s[0]).join(","));
  while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);

  // ── notifiers keep the old single-opacity path ──────────────────────────────
  const alert = WBY.unlockAlert;
  ok("a notifier is not split (it has no widget panel)",
     el(alert).style.getPropertyValue("--wsurf") === "" && el(alert).style.getPropertyValue("--wdim") !== "",
     "wdim=[" + el(alert).style.getPropertyValue("--wdim") + "]");

  for (const w of WIDGETS) resetWidget(w);
  return out;
})()`;

// -- Suite: test-environment badge ---------------------------------------------
// The app has silently refused to record PTU blueprints since 4.8 and never told the player:
// nothing appeared in their collection and no surface anywhere explained why. This suite guards
// the badge that says so.
// Driven straight from the view, so every branch is reachable without a PTU log - which is the
// point, because none of them are reachable from a normal test machine.
const ENVBADGE = `(async () => {
  ${PRELUDE}
  const badge = document.getElementById("envBadge");
  const line = document.getElementById("envLine");
  ok("the tracker has an env badge", !!badge);
  ok("...and a footer env line", !!line);
  if (!badge || !line) return out;
  // NOTE: named "visible", NOT "shown". PRELUDE already declares const shown (and el, cs) --
  // redeclaring one is a duplicate const in the same scope, a PARSE error that surfaces only as
  // "suite threw before it could report", with no hint about which name collided. SKILL.md warns
  // about out/ok/sleep; el/shown/cs are on that list too.
  // 🔴 DELIBERATELY DOES NOT READ n.hidden. An earlier version started with !n.hidden, which
  // short-circuits: the DOM property alone decided the answer and the CSS was never exercised,
  // so deleting the .envbadge[hidden] rule left this suite GREEN. That guard is exactly what the
  // page needs (a bare hidden attribute loses to any class rule setting display, and .envbadge
  // sets display:inline-block), so the assertion has to measure what the PLAYER sees - computed
  // display and a real rect - not what the script asked for.
  const visible = (n) => getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 0;
  const has = (s, sub) => String(s || "").toLowerCase().indexOf(sub) >= 0;

  // NOT LIVE: visible, carries the tag, and says what it costs.
  renderEnvBadge({ envIsLive: false, logEnv: "PTU", patch: "4.10.0-PTU.12479687" });
  ok("PTU shows the badge", visible(badge), badge.hidden ? "hidden" : getComputedStyle(badge).display);
  ok("...naming the environment", badge.textContent === "PTU", badge.textContent);
  ok("...and the footer says it in words", visible(line) && has(line.textContent, "ptu"), line.textContent);

  // The hover text IS the feature (Sub: "when the user hover over whatever badge or label you
  // are going to use for the PTU, I want them to be informed that their blueprints won't be
  // tracked"). Assert the MEANING, not merely that a title exists.
  const tip = badge.title || "";
  ok("the tooltip is non-empty", tip.length > 0, String(tip.length));
  ok("...and mentions blueprints", has(tip, "blueprint"), tip.slice(0, 60));
  ok("...and says they are NOT recorded",
     has(tip, "not added") || has(tip, "not counted") || has(tip, "not synced") || has(tip, "not tracked"),
     tip.slice(0, 90));
  ok("...and reassures the rest still works", has(tip, "everything else"), tip.slice(0, 120));

  // LIVE: nothing at all. A warning that fires on live is worse than no warning.
  renderEnvBadge({ envIsLive: true, logEnv: "PUB", patch: "4.10.0-PTU.12479687" });
  ok("PUB hides the badge", !visible(badge));
  ok("...and the footer line", !visible(line));

  // NULL READS AS LIVE. The app can attach mid-session and never see a header; refusing to
  // track there would break the common install to protect the rare one.
  renderEnvBadge({ envIsLive: true, logEnv: null, patch: "x" });
  ok("a null env stays quiet", !visible(badge));

  // An older sidecar sends no env fields at all - must not cry wolf.
  renderEnvBadge({ patch: "4.9.0-LIVE.12344265" });
  ok("a view with no env fields stays quiet", !visible(badge));

  // Any non-PUB tag warns, not just PTU.
  renderEnvBadge({ envIsLive: false, logEnv: "TECH-PREVIEW", patch: "x" });
  ok("TECH-PREVIEW also warns", visible(badge) && badge.textContent === "TECH-PREVIEW", badge.textContent);

  // Not live but no tag: must never print the word null at the player.
  renderEnvBadge({ envIsLive: false, logEnv: null, patch: "x" });
  ok("a missing tag falls back to TEST, never null", badge.textContent === "TEST", badge.textContent);

  // THE TRAP THIS FEATURE EXISTS TO AVOID. patch is the DATASET label: the bundled 4.10 data was
  // extracted from PTU, so it reads "4.10.0-PTU..." even on a genuinely LIVE build. A badge keyed
  // on that string would tell live players their progress was being thrown away.
  renderEnvBadge({ envIsLive: true, logEnv: "PUB", patch: "4.10.0-PTU.12479687" });
  ok("a PTU-flavoured DATASET on a LIVE log shows nothing", !visible(badge),
     "patch says PTU but the log header says PUB - the header wins");
  return out;
})()`;

// ── Suite: nothing animates at rest ────────────────────────────────────────────
// 🔴 An infinite CSS animation on an always-on-top TRANSPARENT window makes the desktop
// compositor redraw the overlay — and the game under it — every single frame, forever,
// even with nothing happening. Measured 2026-08-11: the tracker sat at 240 composited
// frames per 4s at rest and ONE 7px element, the `.eyebrow` diamond, was 100% of it.
// A user with a 5080 independently measured the overlay costing 5fps in the hangar with
// GPU acceleration on and 35fps with it off, and volunteered that infinite animations
// force redraws.
// The pulse now runs only in the two states that mean something. This suite is the guard,
// because the cost is completely invisible in every other kind of test.
const IDLEPAINT = `(async () => {
  ${PRELUDE}
  const dot = document.querySelector(".dot");
  ok("the tracker has its diamond", !!dot);
  // The real page may genuinely be live on Twitch or at a fabricator while the suite runs, and
  // both are legitimate reasons to be animating — so drive it to a known state first rather
  // than asserting whatever today happens to be.
  dot.classList.remove("live", "fab");
  await sleep(120);
  // 🔑 CSS ANIMATIONS only, never transitions. A transition ENDS, so it cannot hold the
  // compositor open the way an infinite animation does — and in this hidden window it would
  // never end at all, because a window that never composites never advances one. Counting
  // getAnimations() raw made this suite fail on the .dot's own 0.2s colour transition.
  const running = () => document.getAnimations().filter((a) => a.playState === "running" && a.animationName);
  const names = () => running().map((a) => {
    const t = a.effect && a.effect.target;
    return a.animationName + " on " + (t ? t.tagName.toLowerCase() + "." + String(t.className || "").trim().split(" ").join(".") : "?");
  }).join(", ");
  ok("NOTHING animates on an idle overlay", running().length === 0, names() || "nothing running");

  // ...but the two states that carry information still do — and specifically the CHEAP pulse.
  // A plain "something is animating" assertion would pass just as happily for the 60fps version
  // this replaced, which is the regression actually worth catching.
  const cheap = (w) => {
    const cs = getComputedStyle(dot);
    ok(w + " still pulses", running().length === 1, names());
    ok("..." + w + " uses the slow keyframes", cs.animationName === "pulse-slow", cs.animationName);
    // steps() is what quantises the PAINTS, not just the values — it is the frame-rate dial CSS
    // does not otherwise give you, and dropping it silently costs ~20x the redraws.
    ok("..." + w + " is stepped, not continuous", cs.animationTimingFunction.indexOf("steps") === 0, cs.animationTimingFunction);
    ok("..." + w + " holds still for most of its cycle", parseFloat(cs.animationDuration) >= 5, cs.animationDuration);
  };
  dot.classList.add("live");
  await sleep(120);
  cheap("live on Twitch");
  dot.classList.remove("live"); dot.classList.add("fab");
  await sleep(120);
  cheap("at the fabricator");
  dot.classList.remove("fab");
  await sleep(120);
  ok("...and it stops again when the state clears", running().length === 0, names() || "nothing running");

  // The fade is transitioned rather than animated, precisely so it cannot become another
  // permanent redraw. Nothing it does may start an animation.
  setWidgetDim(WBY.party, 40);
  await sleep(300);
  ok("fading a widget starts no animation", running().length === 0, names() || "nothing running");
  resetWidget(WBY.party);
  return out;
})()`;

// ── Suite: the mission-info rows built from community data ─────────────────────
// 🔑 Every one of these is about NOT overstating thin evidence. 108 contracts have any payout
// observation at all and most come from a single player, so the failure mode is not a missing
// row — it is a lone reading rendered as though it were a settled fact. The site takes the same
// line, and the two must not disagree about what counts as known.
const UNRECOGNIZED = `(async () => {
  ${PRELUDE}
  // 🔑 No regex escape here on purpose. This whole suite is a template literal, so a "\\s+"
  // written by a scripted edit arrives as "s+" and the strip helper silently eats every letter
  // s — which reads as a broken FEATURE ("2 blueprint  could not be identified", "Colo u")
  // rather than a broken test. Split/join needs no escapes and cannot fail that way.
  const strip = (h) => h.replace(/<[^>]+>/g, " ").split(" ").filter(Boolean).join(" ").trim();
  const view = (names, packActive) => ({ unrecognized: { names: names, packActive: packActive } });

  ok("nothing unplaceable draws no banner at all",
     unrecognizedHtml(view([], false)) === "" && unrecognizedHtml({}) === "",
     JSON.stringify(unrecognizedHtml(view([], false))));

  // 🔑 THE RAW STRING IS THE FEATURE. A count alone ("3 unknown") is a shrug; seeing the literal
  // the game wrote is what makes the cause self-evident and turns a support report from
  // "your app is broken" into "my language file renames things".
  const packH = unrecognizedHtml(view(["Glacier Military A", "B10 Colossus"], true));
  ok("the raw name the game logged is shown verbatim",
     packH.indexOf("Glacier Military A") >= 0 && packH.indexOf("B10 Colossus") >= 0, strip(packH));
  ok("...and it is counted in the headline", strip(packH).indexOf("2 blueprints could not be identified") >= 0, strip(packH));
  ok("one of them reads as singular", strip(unrecognizedHtml(view(["Solo"], true))).indexOf("1 blueprint could not be identified") >= 0);

  // Calibrate is only reachable when there is something to recalibrate AGAINST. Offering it on a
  // stock install would be a button that cannot help, which is worse than no button.
  ok("a modified language file offers Recalibrate", packH.indexOf("unrecCal") >= 0);
  const stockH = unrecognizedHtml(view(["Whatever This Is"], false));
  ok("a stock install does NOT offer Recalibrate — there is nothing to read", stockH.indexOf("unrecCal") < 0, strip(stockH));
  ok("...but still names what it could not place", stockH.indexOf("Whatever This Is") >= 0);

  // Same rule as every other explanation on this panel: the prose lives in the info affordance,
  // not on the face of the banner, or the panel becomes a paragraph.
  ok("the explanation is carried by the info affordance", packH.indexOf("mi-info") >= 0);
  ok("...and the reason names the language file", packH.indexOf("language file renames items") >= 0);

  // A name is arbitrary text out of a log file and goes straight into innerHTML.
  const evil = unrecognizedHtml(view(["<img src=x onerror=alert(1)>"], false));
  ok("a hostile name is escaped, not injected",
     evil.indexOf("<img") < 0 && evil.indexOf("&lt;img") >= 0, evil.slice(0, 120));
  return out;
})();`;

const MISSIONINFO = `(async () => {
  ${PRELUDE}
  const strip = (h) => h.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim();
  // 🔑 TWO views of the same block. "pay" is what the panel SHOWS; "payAll" is the raw markup,
  // which is where the evidence lives now — the sample count and spread moved into the info
  // affordance's title on 2026-08-13 so the figure could be a single pill instead of a number
  // with two lines of caption. Disclosure is still mandatory, it just is not shouted.
  // (No backticks in a suite body — this whole block is a template literal.)
  const payAll = (payout) => payBlock({ community: { payout } });
  const pay = (payout) => strip(payAll(payout));
  const facts = (f) => factChips({ community: { facts: f } }).map(strip).join(" ");

  // ── the three payout tiers ───────────────────────────────────────────────
  // 🔴 REGRESSION GUARD, 2026-08-14. The dataset gained a MODELLED payout for the ~2,045
  // missions the datacore leaves at reward="0", shaped byte-identically to a real one, and
  // every estimate rendered with the tooltip "A fixed reward, straight from the game files".
  // Measured against real completions the model is wrong ONE TIME IN FOUR (-79% to +61%).
  // 🔑 The existing helpers above only ever pass "community", never a dataset payout, which is
  // exactly why nothing here caught it — a suite can only fail on an input it actually supplies.
  const tier = (v) => payBlock(v);
  const fixedV = { payout: { min: 60000, max: 60000, currency: "UEC" }, payoutEstimated: false, community: null };
  const estV = { payout: { min: 39750, max: 39750, currency: "UEC" }, payoutEstimated: true, community: null };
  const fixedH = tier(fixedV), estH = tier(estV);
  ok("a FIXED payout still says it came from the game files",
     fixedH.indexOf("straight from the game files") >= 0 && fixedH.indexOf("mi-pay est") < 0, strip(fixedH));
  ok("an ESTIMATE is NOT described as a fixed reward from the game files",
     estH.indexOf("straight from the game files") < 0, strip(estH));
  // A TILDE, not the word "est." (Sub, 2026-08-14) — understood instantly, costs no width, and
  // does not compete with the figure. It must be INSIDE .amt: as a sibling the pill's 5px gap
  // detaches it and it stops reading as part of the number.
  // ⚠️ Assert ADJACENCY on the raw markup, never on strip() — strip replaces every tag with a
  // SPACE, so a correctly-rendered "~39,750" reads back as "~ 39,750" and a passing feature
  // fails. The property that matters is that the tilde touches the number, which is exactly
  // what the stripped text cannot tell you.
  ok("...it is marked with a tilde touching the number, not only in a tooltip",
     estH.indexOf('<i class="tld">~</i>39,750') >= 0, estH.slice(0, 90));
  ok("...and carries a class the skin can style differently", estH.indexOf("mi-pay est") >= 0);
  ok("...and says out loud that it is calculated, not read from the game",
     estH.indexOf("ESTIMATE") >= 0 && estH.indexOf("not in the game files") >= 0);
  // The tier order: one real report outranks an estimate. That is the whole reason the board
  // scanner keeps earning its place, so it is asserted rather than assumed.
  const beatsEst = tier({ payout: { min: 39750, max: 39750, currency: "UEC" }, payoutEstimated: true,
    community: { payout: { samples: 1, contributors: 1, min: 63000, max: 63000, median: 63000, currency: "UEC", singleContributor: true } } });
  ok("a single real observation OUTRANKS the estimate", strip(beatsEst).indexOf("63,000") >= 0
     && strip(beatsEst).indexOf("39,750") < 0 && beatsEst.indexOf("tld") < 0, strip(beatsEst));
  // The circled i must survive on the estimate — it is where "where did this number come from"
  // is answered, and the tilde alone does not say that.
  ok("...and the estimate keeps its info affordance to explain itself",
     estH.indexOf("mi-info") >= 0 && estH.indexOf(">i<") >= 0);

  // A lone BOARD SCAN publishes, but says it is unconfirmed — and says it in the tooltip, not on
  // the face of the pill (Sub, 2026-08-14: "that way it doesn't clutter up the UI").
  const loneScan = { samples: 1, contributors: 1, min: 63000, max: 63000, median: 63000, currency: "UEC", singleContributor: true, ocrOnly: true };
  const loneH = payAll(loneScan);
  ok("a lone board scan still shows its number", strip(loneH).indexOf("63,000") >= 0, strip(loneH));
  ok("...says it is unconfirmed IN THE TOOLTIP", loneH.indexOf("One unconfirmed board scan") >= 0);
  ok("...and NOT on the face of the pill", strip(loneH).indexOf("unconfirmed") < 0, strip(loneH));
  // Corroborated, or backed by a typed report, and the caveat goes away — a caveat that never
  // clears is one people stop reading.
  const manyScans = payAll({ samples: 4, contributors: 1, min: 63000, max: 63000, median: 63000, currency: "UEC", singleContributor: true, ocrOnly: true });
  ok("several scans are no longer 'one unconfirmed read'", manyScans.indexOf("One unconfirmed board scan") < 0);
  const typed = payAll({ samples: 1, contributors: 1, min: 63000, max: 63000, median: 63000, currency: "UEC", singleContributor: true, ocrOnly: false });
  ok("a typed report is never called an unconfirmed scan", typed.indexOf("One unconfirmed board scan") < 0);

  // ── payouts ──────────────────────────────────────────────────────────────
  ok("no observations renders NOTHING, not a zero", pay(null) === "" && pay({ samples: 0 }) === "");
  const loneAll = payAll({ samples: 1, contributors: 1, min: 48000, max: 48000, median: 48000, currency: "UEC", singleContributor: true });
  const lone = pay({ samples: 1, contributors: 1, min: 48000, max: 48000, median: 48000, currency: "UEC", singleContributor: true });
  ok("a lone reading says so", loneAll.indexOf("1 report") >= 0, loneAll);
  ok("...and invents no range from one sample", lone.indexOf("Range") < 0, lone);
  const oneGuyAll = payAll({ samples: 4, contributors: 1, min: 48000, max: 52000, median: 50000, currency: "UEC", singleContributor: true });
  const oneGuy = pay({ samples: 4, contributors: 1, min: 48000, max: 52000, median: 50000, currency: "UEC", singleContributor: true });
  ok("several readings from ONE player disclose that", oneGuyAll.indexOf("one player") >= 0, oneGuyAll);
  const manyAll = payAll({ samples: 12, contributors: 5, min: 31500, max: 64000, median: 47250, currency: "UEC", singleContributor: false });
  const many = pay({ samples: 12, contributors: 5, min: 31500, max: 64000, median: 47250, currency: "UEC", singleContributor: false });
  ok("a real spread shows the range", manyAll.indexOf("31,500") >= 0 && manyAll.indexOf("64,000") >= 0, manyAll);
  ok("...and does not cry lone-source when it is not", many.indexOf("one player") < 0, many);
  const flat = pay({ samples: 6, contributors: 3, min: 20000, max: 20000, median: 20000, currency: "UEC", singleContributor: false });
  ok("identical readings show no pointless range", flat.indexOf("Range") < 0, flat);
  const merits = pay({ samples: 2, contributors: 2, min: 900, max: 1100, median: 1000, currency: "Merits", singleContributor: false });
  ok("merits are not printed as aUEC", merits.indexOf("Merits") >= 0 && merits.indexOf("aUEC") < 0, merits);

  // ── crowdsourced facts ───────────────────────────────────────────────────
  ok("no answers renders nothing", facts(null) === "" && facts({ samples: 0 }) === "");
  // 🔑 The count is shown only while the evidence is thin — always printing it is clutter, never
  // printing it lets one opinion pass for a fact.
  const thinSolo = facts({ samples: 1, difficulty: null, difficultyAnswers: 0, soloRate: 1, soloAnswers: 1, combatTop: null, ships: [] });
  ok("a lone solo report is qualified on the chip", thinSolo.indexOf("1 report") >= 0, thinSolo);
  const fatSolo = facts({ samples: 9, difficulty: null, difficultyAnswers: 0, soloRate: 1, soloAnswers: 9, combatTop: null, ships: [] });
  ok("a well-attested one just states it", fatSolo.indexOf("Soloable") >= 0 && fatSolo.indexOf("report") < 0, fatSolo);
  ok("...and a question nobody answered is absent, not blank", fatSolo.indexOf("Difficulty") < 0, fatSolo);

  // ── the difficulty meter ─────────────────────────────────────────────────
  // Rounded segments matching the site's mission pages, not stars (Sub, 2026-08-12).
  const met = (f) => difficultyMeter(f);
  ok("no rating, no meter", met(null) === "" && met({ difficulty: null, difficultyAnswers: 0 }) === "");
  const m3 = met({ difficulty: 2.7, difficultyAnswers: 9 });
  ok("the meter draws five segments", (m3.match(/<i /g) || []).length === 5, (m3.match(/<i /g) || []).length);
  ok("...and fills to the rounded rating", (m3.match(/class="on"/g) || []).length === 3, (m3.match(/class="on"/g) || []).length);
  // 🔑 The bar rounds, so the number has to survive alongside it — otherwise 2.4 and 2.6 become
  // the same picture and the precision is gone.
  ok("...while the exact mean is still printed", m3.indexOf("2.7") >= 0);
  ok("the info icon carries the report count", m3.indexOf("9 reports") >= 0);
  ok("a 1 does not fill zero segments", (met({ difficulty: 1, difficultyAnswers: 1 }).match(/class="on"/g) || []).length === 1);
  ok("a 5 fills them all", (met({ difficulty: 5, difficultyAnswers: 4 }).match(/class="on"/g) || []).length === 5);
  // 🔑 The conventional circled "i", and it must be a plain ASCII LETTER in a CSS circle — this
  // page bundles no emoji face, so a real ⓘ character would be at the mercy of the OS font. That
  // is the o7-as-a-box trap. An eye glyph was tried first and read as something else entirely.
  ok("the affordance is an info icon", m3.indexOf("mi-info") >= 0, m3);
  ok("...drawn from an ASCII letter, not a glyph the OS might not have",
     m3.indexOf(">i<") >= 0 && !/[\u{1F300}-\u{1FAFF}ⓘℹ]/u.test(m3));
  const solo = facts({ samples: 2, difficulty: null, difficultyAnswers: 0, soloRate: 1, soloAnswers: 2, combatTop: null, ships: [] });
  ok("a unanimous solo rate reads as a verdict, not a statistic", solo.indexOf("Soloable") >= 0 && solo.indexOf("100%") < 0, solo);
  const split = facts({ samples: 5, difficulty: null, difficultyAnswers: 0, soloRate: 0.6, soloAnswers: 5, combatTop: null, ships: [] });
  ok("a split one gives the number", split.indexOf("60%") >= 0, split);
  const grp = facts({ samples: 3, difficulty: null, difficultyAnswers: 0, soloRate: 0, soloAnswers: 3, combatTop: null, ships: [] });
  ok("nobody soloing it says so plainly", grp.indexOf("Needs a group") >= 0, grp);
  // combatTop is null whenever the site could not find a real majority; a plurality is not a fact.
  const nomaj = facts({ samples: 7, difficulty: null, difficultyAnswers: 0, soloRate: null, soloAnswers: 0, combatTop: null, ships: [] });
  ok("no majority on combat means no Fighting row", nomaj.indexOf("Fighting") < 0, nomaj || "(empty)");
  const ship = facts({ samples: 1, difficulty: null, difficultyAnswers: 0, soloRate: null, soloAnswers: 0, combatTop: "fps", ships: [{ ship: "Mirai Guardian", count: 1 }] });
  ok("a majority combat profile is worded, not coded", ship.indexOf("On-foot combat") >= 0, ship);
  ok("the most-flown ship is read off the log", flownShip({ community: { facts: { samples: 1, ships: [{ ship: "Mirai Guardian", count: 1 }] } } }) === "Mirai Guardian");
  ok("...and no ship seen is an absence, not on-foot", flownShip({ community: { facts: { samples: 1, ships: [] } } }) === null);

  // ── where to pick it up ──────────────────────────────────────────────────
  // Measured over the real dataset: 898 lists name 2-4 places (specific, worth showing) and 761
  // name 5+ (the big ones are every body in the system, which is the same as saying nothing).
  const pu = (list) => pickupOf({ whereToGet: list });
  ok("no list, no row", pu([]) === null && pu(null) === null);
  const four = pu(["Checkmate", "Patch City", "Monox", "Pyro I"]);
  ok("a specific list names ONE place", four && four.name === "Checkmate", four && four.name);
  ok("...and counts the rest rather than listing them", four && four.more === 3, four && four.more);
  // 🔑 Order does not encode type — 289 real lists interleave — so a station is CHOSEN, not taken
  // from the front. A station is where you dock; a planet is not somewhere you can fly to and
  // take a contract.
  const planetFirst = pu(["Monox", "Pyro I", "Checkmate"]);
  ok("a station is preferred even when a planet comes first", planetFirst && planetFirst.name === "Checkmate", planetFirst && planetFirst.name);
  const allPlanets = pu(["Nyx I", "Nyx II", "Nyx III"]);
  ok("all-planet lists still name one", allPlanets && allPlanets.name === "Nyx I", allPlanets && allPlanets.name);
  ok("a system-wide list is DROPPED, not truncated",
     pu(["ArcCorp", "Crusader", "Hurston", "microTech", "Aberdeen", "Arial", "Calliope", "Cellin",
         "Clio", "Daymar", "Euterpe", "Ita", "Lyria", "Magda", "Wala", "Yela"]) === null);
  ok("an unknown name is treated as a station", isStation("Some New Outpost") === true);
  ok("...but a roman-numeral body is not", isStation("Pyro VI") === false);

  // ── the local dataset fields, as chips ───────────────────────────────────
  const info = (v) => strip(missionInfoHtml(Object.assign({ giver: "Headhunters", missionType: "Bounty Hunter", reputationGained: [], reputationLost: [], whereToGet: [] }, v), true));
  ok("an illegal contract is flagged", info({ illegal: true }).indexOf("Illegal") >= 0);
  ok("...and a legal one is not", info({ illegal: false }).indexOf("Illegal") < 0);
  ok("a rank gate is shown", info({ rankRequired: 2 }).indexOf("Rank needed 2") >= 0, info({ rankRequired: 2 }));
  // 🔑 null is "the dataset carries no gate", NOT rank 0 — givers use 0 and null side by side.
  ok("...but an absent gate is not rendered as rank 0", info({ rankRequired: null }).indexOf("Rank needed") < 0);
  ok("rank 0 IS a real gate and shows", info({ rankRequired: 0 }).indexOf("Rank needed 0") >= 0);

  // 🔴 THE GIVER'S NAME SURVIVES WITH NO STANDING BAR. The faction group used to be dropped
  // whole whenever there was no standing (facBody = null), which also threw away the giver's
  // NAME. Sound when that group held name + standing + rank + reputation; once Rank and
  // Reputation moved into the main row it meant "no rep scope" => "hide who you work for".
  // Not a corner case: all 13 Orison Relief contracts carry reputationGained: [], so the whole
  // 4.10 event ran with its giver invisible. Sub, running one: "it just looks kind of blank."
  // NOTE: the info() helper above already sets reputationGained: [] and NO repBar, so these
  // assertions run against exactly the shape that failed.
  const noRep = info({ giver: "Covalex Independent Contractors" });
  ok("the mission info is not empty to begin with", noRep.length > 0, String(noRep.length));
  ok("a giver with NO rep scope still shows its name",
     noRep.indexOf("Covalex Independent Contractors") >= 0, noRep.slice(0, 120));
  // ...and the standing bar itself is still correctly absent - the fix must not invent one.
  ok("...without inventing a standing bar", noRep.indexOf("Standing") < 0, noRep.slice(0, 120));

  // ── two groups, so the faction half can be collapsed on its own ──────────
  const V = { giver: "Headhunters", missionType: "Bounty Hunter", illegal: true, rankRequired: 1,
    contractKey: "HH_Test_Contract", ambiguous: false,
    reputationGained: [{ faction: "Headhunters", amount: 50 }], reputationLost: [], whereToGet: ["Checkmate", "Monox"],
    repBar: { noData: true, faction: "Headhunters", standing: "" } };
  const full = missionInfoHtml(V, true);
  // The two groups are still SEPARATE, they just no longer wear collapsible drawer headers
  // (removed 2026-08-13 — the chip layout is short enough that there is nothing to fold away).
  // The split is now marked by the faction's own name leading its group.
  ok("mission and faction details are still two groups",
     (full.match(/class="mi"/g) || []).length === 2, (full.match(/class="mi"/g) || []).length);
  ok("...with no collapsible header chrome left", full.indexOf("mi-head") < 0);
  // 🔑 RE-POINTED 2026-08-14, not deleted. These used to assert that Rank and Reputation lived in
  // the FACTION group — true until Sub reordered the row and put both in the main row at
  // positions 7 and 8. An assertion that outlives the design it describes has to be aimed at the
  // new truth or dropped; leaving it red teaches people to ignore the suite, and deleting it
  // leaves the move unguarded. So it now pins where they actually belong.
  const facHalf = full.slice(full.indexOf("mi-faction"));
  const missionHalfEarly = full.slice(0, full.indexOf("mi-faction"));
  ok("rank and reputation ride the MAIN row, not the faction group",
     missionHalfEarly.indexOf("Rank needed") >= 0 && missionHalfEarly.indexOf("Reputation") >= 0
     && facHalf.indexOf("Rank needed") < 0,
     "main=" + (missionHalfEarly.indexOf("Reputation") >= 0));
  ok("...and reputation comes before the rank gate, per PILL_ORDER",
     missionHalfEarly.indexOf("Reputation") < missionHalfEarly.indexOf("Rank needed"));
  ok("...leaving the faction group its name and your standing", facHalf.indexOf("Headhunters") >= 0);
  const missionHalf = full.slice(0, full.indexOf("mi-faction"));
  ok("the contract's own details stay in the MISSION group",
     missionHalf.indexOf("Pick up") >= 0 && missionHalf.indexOf("Illegal") >= 0);
  // The rule above standing went on 2026-08-13: it separated two things that are both about the
  // same faction, which read as a split where there isn't one. Spacing carries it now.
  ok("standing is present in the faction group", full.indexOf("mi-standing") >= 0);
  ok("the facts that explain themselves are chips, not rows", full.indexOf("mi-chips") >= 0);
  ok("the reputation value does not repeat its own label", strip(full).indexOf("+50 rep") < 0, strip(full));
  ok("standing explains itself through the info icon, not the word est.", strip(full).indexOf("est.") < 0);
  ok("...and it says WHY the number is an estimate", full.indexOf("never reports your reputation") >= 0);

  // 🔑 "+3" means nothing on its own — the count is only useful next to the names (Sub).
  const puFull = missionInfoHtml(Object.assign({}, V, {
    whereToGet: ["Rat's Nest", "Starlight Service Station", "Orbituary", "Bloom"] }), true);
  ok("a truncated pickup list carries an info icon", puFull.indexOf("mi-more") >= 0 && puFull.indexOf("mi-info") >= 0);
  ok("...naming the places the count stands for",
     puFull.indexOf("Starlight Service Station, Orbituary and Bloom") >= 0, puFull.slice(puFull.indexOf("Pick up"), puFull.indexOf("Pick up") + 320));
  // One place needs no explanation, so it gets no icon to explain.
  const puOne = missionInfoHtml(Object.assign({}, V, { whereToGet: ["Rat's Nest"] }), true);
  ok("a single place gets no count and no icon", puOne.indexOf("mi-more") < 0);
  // 🔑 The listed places are ONE variant, so they do draw the pool on screen — but that must not
  // be sold as "it does not matter where you take it". For 71 titles the place is exactly what
  // decides the pool, which is the row below. Sub caught this claim being both wrong and the
  // opposite of the useful thing to say.
  ok("...and the tooltip does not claim the location is irrelevant",
     puFull.indexOf("same contract wherever") < 0 && puFull.indexOf("draw the pool shown above") >= 0);

  // ── the pools you CANNOT get from here ───────────────────────────────────
  const withOthers = missionInfoHtml(Object.assign({}, V, {
    whereToGet: ["Checkmate", "Patch City"],
    otherPools: [
      { places: ["Rat's Nest", "Starlight Service Station"], total: 5, owned: 5 },
      { places: ["Ruin Station", "Terminus"], total: 8, owned: 3 },
    ] }), true);
  ok("other regions with a different pool are surfaced", withOthers.indexOf("Other pools") >= 0);
  ok("...named by a station you can actually fly to", withOthers.indexOf("Rat's Nest") >= 0 && withOthers.indexOf("Ruin Station") >= 0);
  // 5/5 + 3/8 = 5 still to win somewhere else. That number is the whole point of the row.
  // ⚠️ Wording changed 2026-08-13: "5 to go" read as five missions, or five of anything. It
  // counts BLUEPRINTS obtainable only in the other regions, so the row says that.
  ok("...with how many are still missing across them", withOthers.indexOf("5 only there") >= 0, strip(withOthers));
  ok("...and says finishing this pool is not finishing the contract",
     withOthers.indexOf("does not finish the contract") >= 0);
  ok("a contract with nothing elsewhere gets no such row",
     missionInfoHtml(Object.assign({}, V, { otherPools: [] }), true).indexOf("Other pools") < 0);
  // Nothing left to win elsewhere is still worth naming (you may not have run it there), but it
  // must not advertise a count of zero.
  const allOwned = missionInfoHtml(Object.assign({}, V, {
    otherPools: [{ places: ["Ruin Station"], total: 8, owned: 8 }] }), true);
  // ⚠️ Checked against the CURRENT wording. This used to look for "0 to go", which after the
  // 2026-08-13 reword could never appear — so it would have passed while a real "0 only there"
  // was on screen. An assertion pinned to a string the code no longer emits tests nothing.
  ok("...and no zero count when the other pool is complete",
     allOwned.indexOf("Other pools") >= 0 && allOwned.indexOf("0 only there") < 0);

  // ── the link out to the site ─────────────────────────────────────────────
  ok("a resolved contract links to its page", full.indexOf("subliminal.gg/missions/HH_Test_Contract") >= 0);
  // 🔑 An ambiguous mission must NOT link: the tracker does not yet know WHICH variant you took,
  // so the page would describe a different one — and the site 404s on a key it does not know.
  const amb = missionInfoHtml(Object.assign({}, V, { ambiguous: true }), true);
  ok("an ambiguous one does not", amb.indexOf("mi-link") < 0);
  const noKey = missionInfoHtml(Object.assign({}, V, { contractKey: null }), true);
  ok("nor does one we cannot name", noKey.indexOf("mi-link") < 0);
  return out;
})()`;

// A widget's settings popover closes itself after 15s of not being used (Sub, 2026-08-03). Not just
// tidiness: an open popover is in RSEL, so it is a permanently CLICKABLE box over the game, and it
// masks the Web Page widget's native view for as long as it is up.
// Driven with ?wcfgidle=250 so the suite doesn't wait a quarter-minute per assertion.
const WCFGIDLE = `(async () => {
  ${PRELUDE}
  const masked = [];
  window.overlayApi = Object.assign({}, window.overlayApi, { maskWebView: (on) => masked.push(!!on) });
  const w = WBY.notepad;               // a plain widget: the shell owns its popover
  setWidgetVisible(w, true);
  await sleep(200);
  const open = () => el(w).classList.contains("cfgopen");
  const cog = () => el(w).querySelector(".wh-cog");

  cog().click();
  await sleep(30);
  ok("the cog opens the settings popover", open());
  ok("...and it masks the native view while up", masked.length > 0 && masked[masked.length - 1] === true, JSON.stringify(masked.slice(-1)));

  // 🔑 THE COG TOGGLES. It used to only ever open: the handler cleared the open class from every
  // widget and then immediately put it back on this one, so a second click was a no-op and the
  // 15s idle timer was the only way to dismiss the panel. Sub hit this on the chat widget, which
  // has no settings sheet of its own and therefore uses this popover.
  cog().click();
  await sleep(30);
  ok("clicking the cog again CLOSES it", !open());
  ok("...and the native view is unmasked again", masked[masked.length - 1] === false, JSON.stringify(masked.slice(-1)));
  cog().click();
  await sleep(30);
  ok("...and a third click reopens it", open());
  cog().click(); await sleep(30);

  // 🔑 The TRACKER is the one widget whose bar cog IS #cog — a single button carrying both
  // wh-cog and id=cog, so it has TWO click listeners on the same element and stopPropagation
  // does nothing about that. If the bar handler acts on it too, the two fight: one opens, the
  // other sees it open and closes it, and the menu never appears at all. That stayed hidden for
  // as long as the bar handler was a no-op for local widgets.
  const menu = document.getElementById("cogMenu");
  const bpCog = document.getElementById("panel").querySelector(".wh-cog");
  ok("the tracker bar cog is the same element as #cog", bpCog && bpCog.id === "cog", bpCog ? bpCog.id : "missing");
  bpCog.click(); await sleep(40);
  ok("the tracker cog OPENS its menu", menu.classList.contains("open"));
  bpCog.click(); await sleep(40);
  ok("...and closes it again", !menu.classList.contains("open"));

  await sleep(500);
  ok("it closes itself once idle", !open());
  ok("...and releases the view mask", masked[masked.length - 1] === false, JSON.stringify(masked.slice(-1)));

  // Using it keeps it alive. A click on the WIDGET is what counts as use — that is the signal
  // embedded pages forward via summonCog, so it also covers clicks inside an iframe's own panel.
  cog().click();
  await sleep(30);
  ok("reopens", open());
  for (let i = 0; i < 5; i++) { await sleep(120); el(w).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); }
  ok("still open after 600ms of being clicked", open());
  await sleep(500);
  ok("...and closes once the clicking stops", !open());

  // Closing by hand must not leave a timer that fires later and stamps on something else.
  cog().click();
  await sleep(30);
  document.body.click();
  await sleep(30);
  ok("an outside click closes it immediately", !open());
  cog().click();
  await sleep(30);
  ok("and it can still be reopened afterwards", open());
  await sleep(500);
  ok("...with the timer working again", !open());
  return out;
})()`;

// Canvas calibration for mixed-DPI desktops — the nudge (move) and the scale (size), both aimed at
// the dotted primary outline in arrange mode.
//
// The property that matters is that the outline stays a USABLE ALIGNMENT TARGET: the outline and
// the widgets have to move and scale as ONE coordinate space, or the user lines the outline up
// with their monitor and the widgets land somewhere else. Both derive from canvas-info's px/py,
// which is exactly what is asserted here.
//
// The shell is absent in this harness, so canvasInfo is driven directly — the same shape
// overlay:canvas-info returns.
const CALIBRATE = `(async () => {
  ${PRELUDE}
  const root = document.documentElement;
  const primLeft = () => getComputedStyle(root).getPropertyValue("--prim-left").trim();
  const w = WBY.notepad;
  setWidgetVisible(w, true);
  await sleep(200);
  w.s.x = 300; w.s.y = 120;

  // Baseline: no calibration at all, which is what every correctly-aligned user has.
  canvasInfo = { px: 40, py: 20, pw: 1000, ph: 800, vw: 3000, vh: 1200, scale: 1 };
  applyCanvasVars(); applyAllFrames();
  await sleep(30);
  ok("no scale set means no zoom on the document", root.style.zoom === "", JSON.stringify(root.style.zoom));
  ok("the outline pins to px", primLeft() === "40px", primLeft());
  ok("a widget sits at its saved x PLUS px", cs(w, "--wx") === "340px", cs(w, "--wx"));
  // 🔑 Measure a FIXED-SIZE control, not the panel: the panel wraps, so at 2x it re-flows to fit
  // the narrower CSS viewport and comes out well under double — a real behaviour that would make
  // this assertion look like a broken zoom. A button's height cannot wrap.
  const btnH = () => document.querySelector("#canvasNudge .nrow button").getBoundingClientRect().height;
  const btnH0 = btnH();

  // A nudge: canvas-info carries the shift in px/py, so BOTH the outline and the widget move by it
  // and the gap between them is untouched. That gap is what makes the outline an alignment target.
  canvasInfo = { px: 40 + 150, py: 20 + 60, pw: 1000, ph: 800, vw: 3000, vh: 1200, scale: 1 };
  applyCanvasVars(); applyAllFrames();
  await sleep(30);
  ok("nudging moves the outline", primLeft() === "190px", primLeft());
  ok("...and moves the widget by exactly the same amount", cs(w, "--wx") === "490px", cs(w, "--wx"));
  ok("...so the widget's offset FROM the outline is unchanged", 490 - 190 === 300);

  // A scale: applied as CSS zoom on the root, so the whole canvas renders bigger — the outline,
  // the widgets and (measured in Electron 43) the content inside each widget's iframe.
  // 🔑 px/pw stay RAW canvas px; the zoom is what multiplies them on the way to the screen. If
  // canvas-info pre-divided by the scale, the outline would never change size and there would be
  // nothing to calibrate against.
  canvasInfo = { px: 40, py: 20, pw: 1000, ph: 800, vw: 1500, vh: 600, scale: 2 };
  applyCanvasVars(); applyAllFrames();
  await sleep(30);
  ok("the scale becomes a document zoom", root.style.zoom === "2", root.style.zoom);
  ok("the outline's CSS position is NOT pre-divided", primLeft() === "40px", primLeft());
  ok("a widget keeps its canvas coordinates too", cs(w, "--wx") === "340px", cs(w, "--wx"));
  // Ground truth that the zoom really scales rendering: a fixed-size control measures double.
  // getBoundingClientRect reports zoom-ADJUSTED px, which is also why the regions this page hands
  // the shell for cursor hit-testing need no correction at either end.
  ok("chrome really renders at 2x", Math.abs(btnH() - btnH0 * 2) < 2, btnH0 + " -> " + btnH());

  canvasInfo = { px: 40, py: 20, pw: 1000, ph: 800, vw: 3000, vh: 1200, scale: 1 };
  applyCanvasVars(); applyAllFrames();
  await sleep(30);
  ok("going back to 100% clears the zoom", root.style.zoom === "", JSON.stringify(root.style.zoom));

  // The control itself. Every button must sit INSIDE the panel's own rect — the shell only makes
  // the window clickable over the rects this page reports, and the scan box's Reset button was
  // unreachable for exactly this reason (it hung 19px above the box it belonged to).
  const nudge = document.getElementById("canvasNudge");
  const nr = nudge.getBoundingClientRect();
  // Centred on the PRIMARY monitor, both axes. It used to sit under the arrange banner at the top
  // edge — right where the dotted outline's own top edge is, so the control overlapped the thing it
  // adjusts. Measured against the primary's rect, not the window's: the canvas spans every display.
  ok("the calibration panel is centred on the primary, horizontally",
     Math.abs((nr.left + nr.right) / 2 - (canvasInfo.px + canvasInfo.pw / 2)) < 2,
     Math.round((nr.left + nr.right) / 2) + " vs " + Math.round(canvasInfo.px + canvasInfo.pw / 2));
  ok("...and vertically",
     Math.abs((nr.top + nr.bottom) / 2 - (canvasInfo.py + canvasInfo.ph / 2)) < 2,
     Math.round((nr.top + nr.bottom) / 2) + " vs " + Math.round(canvasInfo.py + canvasInfo.ph / 2));
  const btns = [...nudge.querySelectorAll("button")];
  ok("the calibration panel carries move AND size controls", btns.length === 7, btns.length + " buttons");
  ok("every control is inside the rect the shell hit-tests", btns.every((b) => {
    const r = b.getBoundingClientRect();
    return r.left >= nr.left - 1 && r.right <= nr.right + 1 && r.top >= nr.top - 1 && r.bottom <= nr.bottom + 1;
  }));

  // Readouts. With no shell the round-trip resolves to nothing and the page keeps its own value,
  // so this exercises the stepping and clamping rather than persistence.
  const readScale = () => document.getElementById("nudgeScale").textContent;
  const readOff = () => document.getElementById("nudgeVal").textContent;
  ok("it opens at no calibration", readOff() === "0, 0" && readScale() === "100%", readOff() + " / " + readScale());
  nudge.querySelector('[data-nz="5"]').click();
  await sleep(30);
  ok("+ grows the canvas 5% at a time", readScale() === "105%", readScale());
  nudge.querySelector('[data-nx="10"]').click();
  await sleep(30);
  ok("an arrow nudges 10px", readOff() === "10, 0", readOff());
  for (let i = 0; i < 45; i++) nudge.querySelector('[data-nz="5"]').click();
  await sleep(60);
  ok("scale clamps at 300%", readScale() === "300%", readScale());
  for (let i = 0; i < 60; i++) nudge.querySelector('[data-nz="-5"]').click();
  await sleep(60);
  ok("...and at 50%", readScale() === "50%", readScale());
  document.getElementById("nudgeReset").click();
  await sleep(30);
  ok("Reset returns both to neutral", readOff() === "0, 0" && readScale() === "100%", readOff() + " / " + readScale());
  return out;
})()`;

// `page` targets a widget's OWN page instead of the canvas — a notifier is easiest to drive
// standalone, without the whole canvas around it.
async function run(label, script, preload, query, page) {
  const web = preload ? { preload, contextIsolation: false } : {};
  const win = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: web });
  // A widget that logs an error or 404s an asset is broken even when every assertion passes -
  // a missing image just renders as nothing. Capture both and fail the run on them.
  const noise = [];
  win.webContents.on("console-message", (...a) => {
    const e = a[0], lvl = typeof e === "object" ? e.level : a[1], msg = typeof e === "object" ? e.message : a[2];
    if ((lvl === "error" || lvl >= 2) && !/Security Warning/.test(String(msg))) noise.push("console: " + String(msg).slice(0, 120));
  });
  // The third-party emote providers answer 404 for a channel that simply isn't registered with
  // them, which is the common case and not a fault - don't fail a run over it.
  // The unlock-pop suite points an <img> at a URL that must 404 — that IS the assertion (no
  // capture for this item yet → fall back to the render). Named so it can't be mistaken for a real
  // missing asset.
  // 🔑 `/api/binding-image` 404s when no chart has been chosen, and that is a SHIPPED state, not a
  // fault — the Infographic Viewer reads the 404 as "show the pick-a-PNG empty state". Without it
  // here the whole suite only passes for a developer who happens to have a chart configured, and
  // fails outright against a fresh profile (npm run dev:fresh), which is exactly when you most
  // want to be able to run it.
  // 🔑 `/api/fab-img/<uuid>` 404s for any item with no CROWDSOURCED capture, which is 70% of the
  // catalogue — the thumbnail then falls back to the clay render, exactly as designed. It only
  // shows up when a live item that happens to lack one is on screen, so this suite went red for
  // 16 suites at once purely because the tracker's state had moved on (it drives the LIVE
  // sidecar). Same class as binding-image below: a shipped state, not a fault.
  const EXPECTED_404 = /(^|\/\/)(api\.frankerfacez\.com|7tv\.io|api\.betterttv\.net)\/|deliberate-404-for-test\.webp|\/api\/binding-image(\?|$)|\/api\/fab-img\//;
  win.webContents.session.webRequest.onCompleted({ urls: ["*://*/*"] }, (d) => {
    if (d.statusCode < 400) return;
    if (d.statusCode === 404 && EXPECTED_404.test(d.url)) return;
    noise.push("HTTP " + d.statusCode + " " + d.url.replace(/^https?:\/\//, "").slice(0, 70));
  });
  try {
    const base = page ? `http://localhost:${PORT}/${page}` : URL;
    await win.loadURL(query ? base + (base.includes("?") ? "&" : "?") + query : base);
    /* 🔴 A SUITE THAT THROWS MUST NOT TAKE THE OTHERS WITH IT. executeJavaScript rejects when the
       page script throws, and that rejection escaped `run()` entirely — it unwound to the caller's
       single try/catch, so ONE bad assertion skipped every suite queued behind it and the whole
       file reported "FAILED (1)" with no name, no line and no partial results. The hauling suite
       sat broken behind exactly that for a day, hiding whatever else was broken behind IT.
       Now the blast radius is one suite and the message says which. */
    let res;
    try {
      res = await win.webContents.executeJavaScript(script);
    } catch (e) {
      console.log(`
${label}`);
      console.log("  FAIL suite threw before it could report   [" + String((e && e.message) || e).slice(0, 180) + "]");
      return 1;
    }
    let fails = 0;
    console.log(`\n${label}`);
    for (const r of res) {
      if (!r.pass) fails++;
      console.log((r.pass ? "  ok   " : "  FAIL ") + r.name + (r.detail ? "   [" + r.detail + "]" : ""));
    }
    const uniq = [...new Set(noise)];
    if (uniq.length) { fails++; console.log("  FAIL console/network clean   [" + uniq.slice(0, 4).join(" | ") + "]"); }
    else console.log("  ok   console/network clean");
    console.log(`  ${res.length + 1 - fails}/${res.length + 1} passed` + (fails ? `  <<< ${fails} FAILED` : ""));
    return fails;
  } finally { win.destroy(); }
}

// The summoned cog / open hub times itself out once the GAME has focus, because that's when it
// gets forgotten — and a forgotten hub holds setModal(true), so the canvas keeps eating clicks.
// Driven with ?coghide=250 so the suite doesn't sit here for half a minute.
const COGHIDE = `(async () => {
  ${PRELUDE}
  const gc = document.getElementById("globalCog"), hub = document.getElementById("hub");
  const up = () => gc.classList.contains("show") || hub.classList.contains("open");

  gc.classList.add("show");
  await sleep(60);
  ok("summoning the cog asks for foreground tracking", window.__foregroundWanted === true, window.__foregroundWanted);

  // Game NOT in front: it must stay put no matter how long we wait.
  window.__fireGameFocus?.(false);
  await sleep(500);
  ok("stays up while the game is not focused", up());

  // Game in front: gone after the (shortened) delay.
  window.__fireGameFocus?.(true);
  await sleep(500);
  ok("hides once the game has had focus", !up());
  ok("releases foreground tracking when it hides", window.__foregroundWanted === false, window.__foregroundWanted);

  // The case Sub actually hit: hub OPEN, which the 10s fade deliberately never closes.
  gc.classList.add("show"); gc.click();
  await sleep(60);
  ok("hub opens", hub.classList.contains("open"));
  window.__fireGameFocus?.(true);
  await sleep(500);
  ok("an OPEN hub closes too", !hub.classList.contains("open") && !up());

  // Hovering it means you're using it — the clock must not run it out from under you.
  gc.classList.add("show"); gc.click();
  await sleep(60);
  gc.dispatchEvent(new MouseEvent("mouseenter"));
  window.__fireGameFocus?.(true);
  await sleep(600);
  ok("hovering keeps it open indefinitely", hub.classList.contains("open"));
  gc.dispatchEvent(new MouseEvent("mouseleave"));
  await sleep(500);
  ok("closes once the pointer leaves", !hub.classList.contains("open"));
  return out;
})()`;


// The unlock notifier, driven on its OWN page (it's a widget now, not part of the panel).
// It must: prefer the fabricator capture over the clay render, fall back when there's no capture,
// never re-announce a receipt it has already shown, ignore stale ones an SSE reconnect replays,
// and queue a burst instead of flickering. Local URLs stand in for the two image endpoints.
// The completion card's auto-hide. Sub, 2026-08-09: he picked the rating, alt-tabbed, came back
// and could no longer answer the solo question. The post-answer ceiling was a flat deadline that
// kept counting while he was away in the game.
const REPORTHOLD = `(async () => {
  ${PRELUDE}
  const card = document.getElementById("mreport");
  const up = () => card.classList.contains("show");

  const completion = {
    title: "Deep space hit", at: new Date().toISOString(), contractKey: "TEST_KEY",
    aUEC: 42000, payout: null, durationMs: 600000, blueprints: [], giver: "Headhunters",
    missionType: "Assassination", rank: null, reputationGained: [], aUecPerHour: null,
    timesCompleted: 3, poolProgress: { owned: 7, total: 15 },
    classification: { combat: null, activity: null, source: null },
  };

  // Caught deliberately: a throw here surfaces as a bare "harness error" with no line and no
  // suite name, which costs a bisection run every time. Naming it is one line.
  try { showReport(completion); } catch (e) { ok("showReport threw", false, e && e.message); return out; }
  ok("the card shows", up());
  ok("...on the plain countdown, not the ceiling", !card.classList.contains("answered"));

  // Answering is what switches it to the ceiling.
  const opt = card.querySelector(".mr-opt");
  ok("the questions rendered", !!opt);
  opt.click();
  await sleep(30);
  ok("answering marks the card answered", card.classList.contains("answered"));
  ok("...and it is still up", up());

  // 🔑 The reported bug: away in the game, the ceiling ran and took the card with it. Blur then
  // focus must leave the card up and cancel any pending deadline.
  window.dispatchEvent(new Event("blur"));
  await sleep(20);
  window.dispatchEvent(new Event("focus"));
  await sleep(20);
  ok("coming back to the overlay keeps the card up", up());
  ok("...with no deadline pending while it has focus", (mrTimer === null), String(mrTimer));

  // Hovering counts as using it too.
  window.dispatchEvent(new Event("blur"));
  card.dispatchEvent(new MouseEvent("mouseenter"));
  await sleep(20);
  ok("a pointer on the card also holds it open", (mrTimer === null));
  card.dispatchEvent(new MouseEvent("mouseleave"));
  await sleep(20);
  // Unattended: pointer off AND the window blurred. The ceiling has to come back, or a
  // forgotten card lives forever — the trapped-user bug.
  ok("left unattended, the ceiling re-arms", (mrTimer !== null));

  ok("Close still dismisses it", (document.getElementById("mrClose").click(), !up()));
  return out;
})()`;

// Chat's outbound links and the slash menu. Two things Sub reported on 2026-08-09: a blueprint
// link and a starcitizen.tools item lookup rendered identically (only the tooltip differed), and
// the command menu never appeared mid-sentence so the inline commands were undiscoverable.
const CHATLINKS = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);

  // ── link kind tags ──────────────────────────────────────────────────────
  const render = (t) => { const d = document.createElement("div"); d.className = "msg";
    d.appendChild(renderBody(t).frag); return d; };
  const tagOf = (t) => { const e = render(t).querySelector(".lkk"); return e ? e.textContent : null; };

  ok("a blueprint token is tagged BP", tagOf("[bp:Deadbolt III Cannon|abc-123]") === "BP",
     tagOf("[bp:Deadbolt III Cannon|abc-123]"));
  ok("an item token is tagged ITEM", tagOf("[item:Deadbolt III Cannon]") === "ITEM",
     tagOf("[item:Deadbolt III Cannon]"));
  ok("a mission token is tagged MISSION", tagOf("[mission:Deep space hit|HH_Pyro_RegionB]") === "MISSION",
     tagOf("[mission:Deep space hit|HH_Pyro_RegionB]"));
  // The whole bug: the SAME name as a blueprint and as an item must not look the same.
  ok("the same name reads differently as a blueprint and as an item",
     tagOf("[bp:Deadbolt III Cannon|abc-123]") !== tagOf("[item:Deadbolt III Cannon]"));

  const bpNode = render("[bp:Deadbolt III Cannon|abc-123]").querySelector(".lnk");
  ok("the link still shows the plain name, not the token",
     bpNode.querySelector(".lkt").textContent === "Deadbolt III Cannon",
     bpNode.querySelector(".lkt").textContent);
  ok("the tag and the text are SIBLINGS", bpNode.querySelector(".lkk .lkt") === null);
  // text-decoration draws through descendants and a child cannot cancel it, so a tag nested
  // inside the underlined span would be underlined too. Measure, don't assume.
  const deco = (el) => getComputedStyle(el).textDecorationLine;
  document.body.appendChild(bpNode.parentNode ? bpNode.parentNode : bpNode);
  ok("the name is underlined", deco(bpNode.querySelector(".lkt")).indexOf("underline") >= 0,
     deco(bpNode.querySelector(".lkt")));
  ok("the tag is NOT underlined", deco(bpNode.querySelector(".lkk")).indexOf("underline") < 0,
     deco(bpNode.querySelector(".lkk")));

  // A mention next to a token must still render as a mention, not get swallowed by it.
  const mixed = render("hey @Rytharr want to run [mission:Deep space hit|HH_Pyro_RegionB]");
  ok("a mention beside a token survives", mixed.querySelector(".at") !== null);
  ok("...and the token beside it still links", mixed.querySelector(".lnk") !== null);

  // ── /build: an erkul loadout the sender names ───────────────────────────
  // erkul's share link is an opaque hash and its old API host no longer exists, so nothing can
  // look the ship up — the sender supplies the name.
  ok("a valid link becomes a build token",
     applyCommand("/build Vulture salvage fit https://erkul.games/s/akeei4v0")
       === "[build:Vulture salvage fit|https://erkul.games/s/akeei4v0]",
     applyCommand("/build Vulture salvage fit https://erkul.games/s/akeei4v0"));
  ok("www and the older /loadout/ form both work",
     applyCommand("/build Old one https://www.erkul.games/loadout/Zjbboonv")
       === "[build:Old one|https://erkul.games/loadout/Zjbboonv]",
     applyCommand("/build Old one https://www.erkul.games/loadout/Zjbboonv"));
  ok("a non-erkul link is refused", applyCommand("/build Sneaky https://evil.example/s/abcd") === null);

  // 🔑 INLINE. It was anchored to the start of the message while being offered as an inline
  // command, so this exact shape sent raw text and produced no link (Sub, 2026-08-09).
  const inl = applyCommand("hey @Rytharr check this /build Vulture salvage fit https://erkul.games/s/akeei4v0 what do you reckon");
  ok("/build works MID-MESSAGE",
     inl === "hey @Rytharr check this [build:Vulture salvage fit|https://erkul.games/s/akeei4v0] what do you reckon", inl);
  ok("...and the text after the link survives", (inl || "").endsWith("what do you reckon"));
  const two = applyCommand("/build A https://erkul.games/s/aaaa1111 and /build B https://erkul.games/s/bbbb2222");
  // 🔑 split(), not a regex: this suite is a TEMPLATE LITERAL, so a backslash escape like
  // \[ collapses before the regex is ever compiled and leaves an unterminated character
  // class - which throws at runtime and surfaces as a bare "harness error".
  ok("...twice in one message", (two || "").split("[build:").length - 1 === 2, two);
  const rendered = render(inl || "");
  ok("...and the mention beside it still renders", rendered.querySelector(".at") !== null);
  ok("...with the build as a real link", rendered.querySelector(".lnk .lkk").textContent === "BUILD");
  ok("a name with no link is refused", applyCommand("/build just a name") === null);
  ok("no arguments at all is refused", applyCommand("/build") === null);

  const bt = render("[build:Vulture salvage fit|https://erkul.games/s/akeei4v0]");
  ok("a build token renders tagged BUILD", bt.querySelector(".lkk").textContent === "BUILD",
     bt.querySelector(".lkk").textContent);
  ok("...showing the sender's name", bt.querySelector(".lkt").textContent === "Vulture salvage fit",
     bt.querySelector(".lkt").textContent);
  ok("...with the destination on hover, so you see where it goes",
     (bt.querySelector(".lnk").title || "").indexOf("https://erkul.games/s/akeei4v0") >= 0,
     bt.querySelector(".lnk").title);

  // 🔴 The token arrives over the wire from another player, so validating only on SEND
  // guarantees nothing. A hostile client must not be able to put an arbitrary URL — least of
  // all a javascript: one — into somebody's real browser.
  for (const nasty of ["javascript:alert(1)", "https://evil.example/s/abcd",
                       "https://erkul.games.evil.example/s/abcd", "https://erkul.games/../etc"]) {
    const n = render("[build:Click me|" + nasty + "]");
    ok("a hostile build URL never becomes a link: " + nasty.slice(0, 34),
       n.querySelector(".lnk") === null && n.textContent.indexOf("Click me") >= 0,
       n.innerHTML.slice(0, 60));
  }

  // ── the slash menu, mid-message ─────────────────────────────────────────
  const box = document.getElementById("slash");
  const input = document.getElementById("sendInput");
  const openCmds = () => [...box.children].map((r) => r.querySelector(".sc-cmd").textContent.split(" ")[0]);
  const type = (v) => { input.value = v; renderSlash(v); };

  type("/");
  ok("a lone slash at the start opens the menu", box.classList.contains("open"));
  ok("...offering every command", openCmds().indexOf("/me") >= 0 && openCmds().indexOf("/bp") >= 0,
     openCmds().join(" "));

  // This is the reported bug: the menu was anchored to the start of the message.
  type("hey Bob, want to run /");
  ok("a slash MID-MESSAGE opens the menu too", box.classList.contains("open"));
  ok("...offering the inline link commands",
     openCmds().indexOf("/bp") >= 0 && openCmds().indexOf("/mission") >= 0, openCmds().join(" "));
  // /me rewrites the WHOLE message, so accepting it after the first word would mangle what is
  // already typed. It is start-only on purpose.
  ok("...but NOT the whole-message commands",
     openCmds().indexOf("/me") < 0 && openCmds().indexOf("/shrug") < 0, openCmds().join(" "));

  type("hey Bob, want to run /mis");
  ok("a partial command mid-message filters", openCmds().join(" ") === "/mission", openCmds().join(" "));
  acceptSugg(0);
  ok("accepting it keeps the text before the slash",
     input.value === "hey Bob, want to run /mission ", JSON.stringify(input.value));

  // A slash inside a word is just a slash - "km/h" must not pop a menu.
  type("we were doing 400 km/h");
  ok("a slash inside a word opens nothing", !box.classList.contains("open"), input.value);
  type("plain text with no slash");
  ok("ordinary text opens nothing", !box.classList.contains("open"));

  // ── creating a room: activity + privacy ─────────────────────────────────
  // Drive off a stubbed view: the harness has no chat connection, and these are pure UI rules.
  const CATS = [
    { slug: "org-ops", label: "Org Operations" },
    { slug: "mining", label: "Mining" },
    { slug: "social", label: "Social / Other" },
  ];
  view = {
    status: "connected", you: { handle: "IMC-Subliminal", verified: true },
    channels: [], directory: [], categories: CATS, dmThreads: [], hasIdentity: true,
  };

  setCreatePop(true);
  ok("the create panel opens", document.getElementById("createPop").classList.contains("open"));

  // 🔴 It shipped 6px ABOVE the whole widget: off the canvas, and outside the rect the shell
  // hit-tests, so unclickable as well as invisible. MEASURE it — reasoning about the CSS is
  // exactly what missed it: rail-foot is not a positioned ancestor.
  // The final clamp runs on the next frame, deliberately: the hint re-wraps and focusing the
  // name field can scroll the panel, both after the arithmetic. Measure once it has settled.
  await sleep(120);
  {
    const p = document.getElementById("createPop").getBoundingClientRect();
    const box = document.getElementById("panel").getBoundingClientRect();
    const inside = p.top >= box.top - 1 && p.left >= box.left - 1
                && p.bottom <= box.bottom + 1 && p.right <= box.right + 1;
    ok("...INSIDE the widget, on every edge", inside,
       "pop " + Math.round(p.top) + "," + Math.round(p.left) + "," + Math.round(p.bottom) + "," + Math.round(p.right)
       + " vs panel " + Math.round(box.top) + "," + Math.round(box.left) + "," + Math.round(box.bottom) + "," + Math.round(box.right));
    ok("...and has real size", p.width > 40 && p.height > 40, p.width + "x" + p.height);
  }
  const opts = [...document.getElementById("cpCat").options].map((o) => o.value);
  ok("the activity dropdown is built from the SERVER list",
     opts.join(",") === "org-ops,mining,social", opts.join(","));
  ok("...defaulting to Social / Other", document.getElementById("cpCat").value === "social");
  const privOpts = [...document.getElementById("cpPriv").options].map((o) => o.value);
  ok("privacy offers public and private", privOpts.join(",") === "public,private", privOpts.join(","));
  ok("...defaulting to public", document.getElementById("cpPriv").value === "public");

  document.getElementById("cpPriv").value = "private";
  updateCreateHint();
  const hintPriv = document.getElementById("cpHint").textContent;
  ok("the private hint explains how people get in",
     hintPriv.indexOf("code") >= 0 && hintPriv.indexOf("invite") >= 0, hintPriv);
  document.getElementById("cpPriv").value = "public";
  document.getElementById("cpCat").value = "mining";
  updateCreateHint();
  ok("the public hint names the activity it will be listed under",
     document.getElementById("cpHint").textContent.indexOf("Mining") >= 0,
     document.getElementById("cpHint").textContent);
  setCreatePop(false);
  ok("it closes again", !document.getElementById("createPop").classList.contains("open"));

  // ── the directory groups by activity ────────────────────────────────────
  view.directory = [
    { ch: "custom:a", label: "Halo Run", category: "mining", count: 4 },
    { ch: "custom:b", label: "Quant Run", category: "mining", count: 1 },
    { ch: "custom:c", label: "Sunday Ops", category: "org-ops", count: 9 },
  ];
  // Browse is collapsed by default, so open it before asserting on its contents.
  localStorage.removeItem("chatCollapsed");
  collapsed = new Set();
  renderChannels();
  const subs = [...document.querySelectorAll("#chanList .subgrp")].map((e) => e.textContent);
  ok("rooms you could join are grouped by activity", subs.length === 2, subs.join(" | "));
  ok("...busiest activity first", subs[0] === "Org Operations", subs.join(" | "));

  // 🔴 The heading has to tell the truth: other people's rooms are NOT "Your channels".
  const groupOf = (label) => {
    const g = [...document.querySelectorAll("#chanList .grp")].find((x) => x.textContent.indexOf(label) >= 0);
    const out = [];
    for (let n = g && g.nextElementSibling; n && !n.classList.contains("grp"); n = n.nextElementSibling) {
      const nm = n.querySelector(".nm"); if (nm) out.push(nm.textContent);
    }
    return out;
  };
  ok("browsable rooms live under Browse rooms",
     groupOf("Browse rooms").indexOf("Sunday Ops") >= 0, groupOf("Browse rooms").join(","));
  ok("...and NOT under Your channels",
     groupOf("Your channels").indexOf("Sunday Ops") < 0, groupOf("Your channels").join(","));
  // Real check, not a tautology: with no stored preference the default must roll Browse up.
  localStorage.removeItem("chatCollapsed");
  ok("Browse is rolled up by default", listPref("chatCollapsed", ["browse"]).indexOf("browse") >= 0,
     JSON.stringify(listPref("chatCollapsed", ["browse"])));

  // ── the per-channel cog (replaced the always-on room bar, 2026-08-10) ────
  const csShown = (id) => document.getElementById(id).hidden === false;
  view.channels = [{ ch: "global", kind: "global", label: "Global", members: [], msgs: [], count: 1 }];
  activeCh = "global";
  setChanSettings(true);
  // 🔑 The cog is present on EVERY channel. The old bar appeared and vanished, and a control that
  // comes and goes is one people stop looking for.
  ok("the cog is always there", document.getElementById("chanCog").offsetParent !== null);
  ok("an ordinary channel still opens settings", csShown("chanSettings"));
  ok("...offering the mute, which every channel has", !!document.getElementById("csMute").textContent);
  ok("...but no code, invite or delete",
     !csShown("csCodeRow") && !csShown("csInviteRow") && !csShown("csDangerRow"));
  ok("...and it says so rather than showing an empty box", csShown("csNothing"));

  view.channels.push({ ch: "custom:pub", kind: "custom", label: "Open Room", members: [], msgs: [],
                       count: 2, privacy: "public", owner: "imc-subliminal" });
  activeCh = "custom:pub";
  renderChanSettings();
  ok("a PUBLIC room you own offers Delete", csShown("csDangerRow"));
  ok("...with no join code", !csShown("csCodeRow"));
  ok("...and no invite box — anyone can already walk in", !csShown("csInviteRow"));

  view.channels[1].owner = "someoneelse";
  renderChanSettings();
  ok("a public room you DON'T own offers no Delete", !csShown("csDangerRow"));
  view.channels[1].owner = "imc-subliminal";

  view.channels.push({ ch: "custom:ops", kind: "custom", label: "Sunday Ops", members: [], msgs: [],
                       count: 3, privacy: "private", owner: "imc-subliminal", code: "K7M2QD" });
  activeCh = "custom:ops";
  renderChanSettings();
  ok("a private room you own shows the join code", csShown("csCodeRow")
     && document.getElementById("csCode").textContent === "K7M2QD",
     document.getElementById("csCode").textContent);
  ok("...the invite box, because it's yours", csShown("csInviteRow"));
  ok("...and Delete", csShown("csDangerRow"));
  ok("...titled with the room it belongs to",
     document.getElementById("csTitle").textContent === "Sunday Ops",
     document.getElementById("csTitle").textContent);

  // Someone who was let in can pass the code on, but must not be able to invite or delete.
  view.channels[2].owner = "someoneelse";
  renderChanSettings();
  ok("a private room you DON'T own still shows the code", csShown("csCodeRow"));
  ok("...but hides the invite box", !csShown("csInviteRow"));
  ok("...and hides Delete", !csShown("csDangerRow"));

  // ── changing the activity / privacy after creation (Sub, 2026-08-13) ─────
  view.categories = [{ slug: "org-ops", label: "Org Operations" }, { slug: "mining", label: "Mining" },
                     { slug: "salvage", label: "Salvage" }, { slug: "social", label: "Social / Other" }];
  view.channels[2].owner = "imc-subliminal";
  view.channels[2].category = "mining";
  activeCh = "custom:ops";
  renderChanSettings();
  ok("the owner can change what the room is for", csShown("csAboutRow"));
  const csCatSel = document.getElementById("csCat");
  ok("...from the SERVER's activity list, so a new one needs no app release",
     csCatSel.options.length === 4, String(csCatSel.options.length));
  ok("...showing the activity the room actually has", csCatSel.value === "mining", csCatSel.value);
  ok("...and the privacy it actually has",
     document.getElementById("csPriv").value === "private", document.getElementById("csPriv").value);

  // The privacy of someone else's room is not yours to see the controls for, let alone change.
  view.channels[2].owner = "someoneelse";
  renderChanSettings();
  ok("a member sees no activity/privacy controls at all", !csShown("csAboutRow"));
  view.channels[2].owner = "imc-subliminal";

  // 🔴 An apply listing has to stay findable, so the server refuses to hide it — the option is
  // disabled here rather than offered and rejected.
  view.channels[2].party = true;
  view.channels[2].joinMode = "apply";
  view.channels[2].privacy = "public";
  renderChanSettings();
  ok("a listing that approves people cannot be made private",
     document.getElementById("csPriv").disabled === true);
  ok("...and says why rather than just refusing",
     /findable|found/.test(document.getElementById("csAboutNote").textContent),
     document.getElementById("csAboutNote").textContent);
  view.channels[2].party = false;
  view.channels[2].joinMode = "open";
  renderChanSettings();
  ok("an ordinary room can still be closed", document.getElementById("csPriv").disabled === false);
  ok("...and is told what closing it would do to the people already in it",
     /here right now/.test(document.getElementById("csAboutNote").textContent),
     document.getElementById("csAboutNote").textContent);
  view.channels[2].privacy = "private";

  // 🔑 Delete must not sit exposed — reaching it is a deliberate act now (Sub's complaint).
  setChanSettings(false);
  ok("with the cog closed, Delete is not on screen at all",
     document.getElementById("csDelete").offsetParent === null);

  // The pin section is the room's notice, so everyone sees it; only the owner may clear it.
  view.channels[2].owner = "imc-subliminal";
  view.channels[2].pin = { ch: "custom:ops", id: 7, handle: "Rytharr", text: "form up at Orison", by: "IMC-Subliminal", at: Date.now() };
  activeCh = "custom:ops";
  setChanSettings(true);
  ok("the pin shows in settings", csShown("csPinRow")
     && /form up at Orison/.test(document.getElementById("csPinText").textContent));
  ok("...and the owner can clear it", document.getElementById("csPinRemove").hidden === false);
  view.channels[2].owner = "someoneelse";
  renderChanSettings();
  ok("...but a member cannot", document.getElementById("csPinRemove").hidden === true);
  view.channels[2].pin = null;
  setChanSettings(false);

  // The padlock in the channel list marks what isn't in the public directory.
  view.directory = [];
  renderChannels();
  const locked = [...document.querySelectorAll("#chanList .crow")]
    .filter((r) => r.querySelector(".lock")).map((r) => r.querySelector(".nm").textContent);
  ok("only the private room gets a padlock", locked.join(",") === "Sunday Ops", locked.join(","));

  // ── DMs ─────────────────────────────────────────────────────────────────
  ok("a DM key is the ordered lowercase pair", dmChKey("Rytharr") === "dm:imc-subliminal|rytharr",
     dmChKey("Rytharr"));
  ok("...and the same both ways round", dmChKey("Rytharr") === dmChKey("RYTHARR"));
  ok("the other person is read back out of the key",
     dmOther("dm:imc-subliminal|rytharr") === "rytharr");

  // Sub's call: DMs carry a standing disclaimer. Private from other PLAYERS, not encrypted.
  ok("no DM warning on an ordinary channel",
     !document.getElementById("dmWarn").classList.contains("show"));

  openDm("Rytharr");
  ok("opening a DM selects it", activeCh === "dm:imc-subliminal|rytharr", activeCh);
  ok("...and the DM shows the privacy disclaimer",
     document.getElementById("dmWarn").classList.contains("show"));
  ok("...which says it plainly, and cannot be dismissed",
     /not.{0,4}encrypted/i.test(document.getElementById("dmWarn").textContent)
       && document.getElementById("dmWarn").querySelector("button") === null,
     document.getElementById("dmWarn").textContent.slice(0, 70));
  const dmRows = [...document.querySelectorAll("#chanList .crow .nm")].map((e) => e.textContent);
  ok("...and it appears in the rail before any message exists", dmRows.indexOf("Rytharr") >= 0,
     dmRows.join(","));
  // A pending DM has no server room, so a state re-render must not bounce you back to Global.
  renderAll();
  ok("a state refresh keeps you in the unsent conversation",
     activeCh === "dm:imc-subliminal|rytharr", activeCh);

  openDm("IMC-Subliminal");
  ok("you can't open a conversation with yourself", activeCh === "dm:imc-subliminal|rytharr", activeCh);

  // 🔑 A DM opened from the menu must NOT also appear as a waiting conversation — that is the
  // duplicate Sub saw pinned at the top of his DM list, which looked undeletable because a
  // pending DM has no leave button until the room exists server-side.
  view.dmThreads = [{ other: "rytharr", lastAt: new Date().toISOString() }];
  renderChannels();
  const rytharrRows = [...document.querySelectorAll("#chanList .crow .nm")]
    .filter((e) => e.textContent.toLowerCase() === "rytharr");
  ok("an open DM is not duplicated as a waiting thread", rytharrRows.length === 1, rytharrRows.length);

  // ── collapsing groups, and hiding rooms you don't care about ────────────
  view.dmThreads = [];
  view.directory = [
    { ch: "custom:a", label: "Halo Run", category: "mining", count: 4 },
    { ch: "custom:b", label: "Quant Run", category: "mining", count: 1 },
  ];
  localStorage.removeItem("chatCollapsed"); localStorage.removeItem("chatHiddenRooms");
  collapsed = new Set(); hiddenRooms = new Set();
  renderChannels();
  const grpFor = (title) => [...document.querySelectorAll("#chanList .grp")]
    .find((g) => g.textContent.indexOf(title) >= 0);
  const rowsAfter = (title) => {
    const g = grpFor(title); const out = [];
    for (let n = g.nextElementSibling; n && !n.classList.contains("grp"); n = n.nextElementSibling) out.push(n);
    return out;
  };
  ok("a group lists its rooms when open", rowsAfter("Your channels").length > 0);
  grpFor("Your channels").click();
  ok("clicking the header collapses it", rowsAfter("Your channels").length === 0);
  ok("...and it shows a count so the group stays honest",
     !!grpFor("Your channels").querySelector(".gct"), grpFor("Your channels").textContent);
  grpFor("Your channels").click();
  ok("clicking again expands it", rowsAfter("Your channels").length > 0);

  // Hiding is a DISPLAY choice — it must never join or leave anything.
  const before = rowsAfter("Your channels").length;
  const haloRow = [...document.querySelectorAll("#chanList .crow")]
    .find((r) => r.querySelector(".nm")?.textContent === "Halo Run");
  haloRow.querySelector(".x").click();
  ok("hiding a browsable room removes it from the list",
     ![...document.querySelectorAll("#chanList .crow .nm")].some((e) => e.textContent === "Halo Run"));
  ok("...and it is remembered", JSON.parse(localStorage.getItem("chatHiddenRooms")).includes("custom:a"));
  const un = [...document.querySelectorAll("#chanList .crow.unhide")][0];
  ok("...with an obvious way back", !!un && /1 hidden/.test(un.textContent), un && un.textContent);
  un.click();
  ok("...which restores it", [...document.querySelectorAll("#chanList .crow .nm")].some((e) => e.textContent === "Halo Run"));
  ok("...and the room count is back where it started", rowsAfter("Your channels").length === before);
  localStorage.removeItem("chatCollapsed"); localStorage.removeItem("chatHiddenRooms");

  // ── the member list offers the SAME right-click menu as a name in the log ──
  view.channels[0].members = [{ handle: "Rytharr", verified: true }, { handle: "IMC-Subliminal", verified: true }];
  activeCh = "global";
  renderMembers();
  const mrow = [...document.querySelectorAll("#memList .mrow")]
    .find((r) => r.querySelector(".nm")?.textContent === "Rytharr");
  ok("the member list has a row for them", !!mrow);
  mrow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 }));
  const ctxOpen = document.getElementById("ctx").classList.contains("open");
  const items = [...document.getElementById("ctx").querySelectorAll("button")].map((b) => b.textContent);
  ok("right-clicking a member opens the menu", ctxOpen);
  ok("...with direct message, mention, friends and profile",
     items.some((t) => /direct message/i.test(t)) && items.some((t) => /Mention/i.test(t))
       && items.some((t) => /friends/i.test(t)) && items.some((t) => /profile/i.test(t)),
     items.join(" | "));
  closeCtx();

  // ── timestamps say HOW LONG AGO, not what o'clock ───────────────────────
  // 🔴 The bug: a clock time on week-old scrollback reads as today. Sub, 2026-08-12: "a user
  // might think that that was actually sent today, but it's not."
  {
    const tsOf = (minsAgo) => {
      const gCh2 = view.channels[0];
      gCh2.msgs = [{ id: 900, from: { handle: "Rytharr", verified: true }, text: "hi",
                     at: new Date(Date.now() - minsAgo * 60000).toISOString() }];
      renderLog();
      return document.querySelector("#log .msg .ts");
    };
    ok("a message from seconds ago says now", tsOf(0.1).textContent === "now", tsOf(0.1).textContent);
    ok("...minutes ago in minutes", tsOf(7).textContent === "7m", tsOf(7).textContent);
    ok("...hours ago in hours", tsOf(200).textContent === "3h", tsOf(200).textContent);
    ok("...and days ago in DAYS, which is the whole point",
       tsOf(60 * 24 * 3).textContent === "3d", tsOf(60 * 24 * 3).textContent);
    // 🔴 NO BACKSLASH ESCAPES IN A SUITE REGEX. Every suite is a template literal, so a written
    // backslash-d collapses to a literal "d" before the regex is ever compiled — the pattern
    // then quietly tests for the LETTER d, and the syntax check cannot see it. Use [0-9]. This
    // is the documented trap in SKILL.md and it cost two false failures here.
    // (And no backticks in this comment either — that is the sibling trap, hit one edit later.)
    // 🔑 Evaluate the render ONCE per assertion too: calling a rendering helper three times
    // inside one expression makes a failure unreadable, which is how the above looked like a
    // product bug for a minute.
    const hasDigit = (s) => /[0-9]/.test(String(s));
    // Past a week the compressed form stops helping and it says the date outright.
    const old = tsOf(60 * 24 * 30).textContent;
    ok("beyond a week it gives the date instead", hasDigit(old) && !/^[0-9]+d$/.test(old), old);
    // 🔑 The exact time is never lost — it moves to the tooltip, where it costs nothing.
    const hover = tsOf(90).title;
    ok("the exact time is still there, on hover", hasDigit(hover) && hover.length > 8, hover);
    view.channels[0].msgs = [];
  }

  // ── what someone is doing, when they have chosen to share it ─────────────
  // 🔑 The interesting assertion is the NEGATIVE one. Almost nobody will turn this on, so the
  // row with no activity is the common case — and rendering anything at all in its place
  // ("idle", a dash) would be a confident claim about someone we know nothing about.
  view.channels[0].members = [
    { handle: "Rytharr", verified: true, activity: "Running Deep space hit" },
    { handle: "IMC-Subliminal", verified: true },
  ];
  renderMembers();
  const acRowOf = (h) => [...document.querySelectorAll("#memList .mrow")]
    .find((r) => r.querySelector(".nm")?.textContent === h);
  ok("a shared activity shows on that person's row",
     acRowOf("Rytharr").querySelector(".act")?.textContent === "Running Deep space hit",
     acRowOf("Rytharr").querySelector(".act")?.textContent);
  ok("...and someone not sharing gets NOTHING in its place, not a placeholder",
     !acRowOf("IMC-Subliminal").querySelector(".act"));

  // ── YOUR settings, as opposed to the per-CHANNEL cog ─────────────────────
  // Everything in here is about you and applies in every channel — which is the entire reason it
  // is not beside a channel's mute.
  view.shareActivity = false;
  view.hideLocation = false;
  setMePop(true);
  const mpRow = (label) => [...document.querySelectorAll("#mePop .mp-row")]
    .find((r) => r.querySelector(".mp-lbl")?.textContent.indexOf(label) === 0);
  const mpSw = (label) => mpRow(label)?.querySelector(".sw");

  ok("your settings hold the three per-user choices",
     !!mpRow("Hide where I am") && !!mpRow("Share what I'm doing") && !!mpRow("My name colour"));
  ok("sharing what you're doing reads off by default",
     mpSw("Share what I'm doing").getAttribute("aria-pressed") === "false");
  // 🔑 The label must say WHAT would be published. "Share my activity" invites a shrug; the
  // contract you are running is something a person can actually decide about.
  ok("...and says what turning it on would publish",
     /contract/i.test(mpRow("Share what I'm doing").textContent),
     mpRow("Share what I'm doing").textContent);
  view.shareActivity = true;
  renderMePop();
  ok("...and reads on once it is", mpSw("Share what I'm doing").getAttribute("aria-pressed") === "true");
  view.shareActivity = false;

  // 🔴 Invisible mode. The description has to name the CHANNELS it removes you from — "hide my
  // location" could mean anything, and this one silently drops you out of two rooms.
  ok("hiding your location is off by default",
     mpSw("Hide where I am").getAttribute("aria-pressed") === "false");
  ok("...and says which channels it takes you out of",
     /Nearby/i.test(mpRow("Hide where I am").textContent)
       && /server/i.test(mpRow("Hide where I am").textContent),
     mpRow("Hide where I am").textContent);
  view.hideLocation = true;
  renderMePop();
  ok("...and reads on once it is", mpSw("Hide where I am").getAttribute("aria-pressed") === "true");
  view.hideLocation = false;
  setMePop(false);
  ok("your settings close again", !document.getElementById("mePop").classList.contains("open"));

  // 🔑 No verified tick anywhere. Chat is RSI-verified accounts only, so a badge saying so is
  // true of every row and therefore says nothing.
  view.channels[0].members = [{ handle: "Rytharr", verified: true }, { handle: "IMC-Subliminal", verified: true }];
  renderMembers();
  renderLog();
  ok("no RSI-verified tick on a member row — every row would have one",
     !document.querySelector("#memList .vf"));
  ok("...nor in the message log", !document.querySelector("#log .vf"));

  // ── the marker means ONLINE now, and the colour means identity ───────────
  // 🔴 The dot used to be a per-handle hash colour and Sub asked what the red one meant. It
  // meant nothing. A marker reads as a status light, so it had better be a status.
  view.channels[0].members = [
    { handle: "Rytharr", verified: true, inGame: true, color: 2 },
    { handle: "Zed", verified: true },
    { handle: "IMC-Subliminal", verified: true },
  ];
  renderMembers();
  const stOf = (h) => acRowOf(h).querySelector(".st");
  ok("someone in the PU is marked in-game", stOf("Rytharr").classList.contains("ingame"));
  ok("...and says so in words on hover", /verse/i.test(stOf("Rytharr").title), stOf("Rytharr").title);
  ok("someone connected but not in game is marked, but not as in-game",
     !!stOf("Zed") && !stOf("Zed").classList.contains("ingame"));
  // 🔴 There is no "offline" anywhere in this system, and there must not be: presence only covers
  // rooms you are both in, so it would be a confident lie about someone you simply cannot see.
  ok("...and nothing anywhere claims they are offline",
     !/offline/i.test(document.getElementById("memList").textContent + (stOf("Zed").title ?? "")),
     stOf("Zed").title);

  // The colour is a CHOICE, shared by the server, and it falls back to the old name hash.
  const nmColor = (h) => acRowOf(h).querySelector(".nm").style.color;
  ok("a chosen colour is what the name renders in",
     nmColor("Rytharr") === "rgb(95, 224, 138)", nmColor("Rytharr"));
  ok("...and someone who never chose keeps the colour their name always had",
     !!nmColor("Zed") && nmColor("Zed") !== nmColor("Rytharr"), nmColor("Zed"));
  // The same person reads the same in the log as in the rail — one lookup, not two.
  view.channels[0].msgs = [{ id: 901, from: { handle: "Rytharr", verified: true }, text: "o7", at: new Date().toISOString() }];
  renderLog();
  ok("the log agrees with the member list about their colour",
     document.querySelector("#log .msg .nm").style.color === nmColor("Rytharr"),
     document.querySelector("#log .msg .nm").style.color);
  view.channels[0].msgs = [];

  // ── org standing: the BADGE is the star count, the label is only a label ─
  // 🔴 Measured across real dossiers, the rank NAME is free text each org picks: "SSGT",
  // "President", "Expendable Crew Member", "Soon to be Casual". Nothing can be ordered from it.
  // RSI's underlying 1-5 is the same scale for every org, so that is what the badge shows.
  view.channels[0].members = [
    { handle: "Rytharr", verified: true, org: "pxp", orgRank: "Expendable Crew Member", orgStars: 1 },
    { handle: "Xan-Man", verified: true, org: "sbb", orgRank: "President", orgStars: 5 },
    { handle: "Zed", verified: true },
  ];
  renderMembers();
  const orgOf = (h) => acRowOf(h).querySelector(".orgr");
  // 🔴 In GLOBAL, nothing. A rank issued by one org means nothing to anyone outside it (Sub:
  // "does it need to show on the global chat what rank you are? I think it'll be just fine in
  // the person's org chat").
  ok("no rank badge outside that org's own channel", !orgOf("Xan-Man"));

  // In the org's OWN room it shows the org's own word for the tier — no asterisks, because
  // inside the org everybody already knows what that word means.
  view.channels[0].kind = "org";
  renderMembers();
  ok("in org chat, the badge is the org's own name for the rank",
     orgOf("Rytharr").textContent === "Expendable Crew Member", orgOf("Rytharr").textContent);
  ok("...with no asterisks anywhere in it", orgOf("Xan-Man").textContent.indexOf("*") < 0
     && orgOf("Xan-Man").textContent === "President", orgOf("Xan-Man").textContent);
  // The 1-5 stays in the data and rides the tooltip: it is what makes "who leads this org"
  // answerable, but it is not what anyone reads.
  ok("the comparable 1-5 is still there, on hover",
     /5 of 5/.test(orgOf("Xan-Man").title), orgOf("Xan-Man").title);
  ok("someone with no public org gets no badge at all", !orgOf("Zed"));
  view.channels[0].kind = "global";
  renderMembers();

  // The picker: eight, plus a way back to no choice at all.
  setMePop(true);
  const swatches = [...document.querySelectorAll("#mePop .mp-colors button")];
  ok("the picker offers eight colours plus 'no colour'", swatches.length === 9, swatches.length);
  ok("...and marks which one is yours", swatches.filter((b) => b.classList.contains("sel")).length === 1);
  setMePop(false);

  view.channels[0].members = [{ handle: "Rytharr", verified: true }, { handle: "IMC-Subliminal", verified: true }];
  renderMembers();

  // ── per-channel notification mute ────────────────────────────────────────
  const savedMuted = localStorage.getItem("chatMuted");
  mutedChans = new Set();
  renderChannels();
  const chRow = (label) => [...document.querySelectorAll("#chanList .crow")]
    .find((r) => r.querySelector(".nm")?.textContent === label);
  const gName = view.channels[0].label;
  const wasActive = activeCh;
  let bell = chRow(gName)?.querySelector(".bell");
  ok("a joined channel carries a mute control", !!bell);
  ok("...which is not muted to start with", !bell.classList.contains("off"));
  bell.click();
  ok("clicking it mutes that channel", isMuted(view.channels[0].ch));
  ok("...without selecting the channel", activeCh === wasActive, activeCh);
  ok("...and it is remembered",
     JSON.parse(localStorage.getItem("chatMuted")).includes(view.channels[0].ch),
     localStorage.getItem("chatMuted"));
  bell = chRow(gName).querySelector(".bell");
  ok("...and a muted channel SAYS so at rest, not only on hover", bell.classList.contains("off"));
  ok("...with a slash, so it survives a skin that recolours it",
     bell.querySelectorAll("svg path").length === 2);
  bell.click();
  ok("clicking again unmutes", !isMuted(view.channels[0].ch)
     && !chRow(gName).querySelector(".bell").classList.contains("off"));
  mutedChans = new Set(savedMuted ? JSON.parse(savedMuted) : []);
  if (savedMuted === null) localStorage.removeItem("chatMuted"); else localStorage.setItem("chatMuted", savedMuted);

  // ── the right rail's SECOND MODE: Friends (Sub, 2026-08-10 — a button, not a widget) ──
  // 🔑 chatFriends / chatRight / chatRightMode are REAL user preferences on this origin, and this
  // harness shares localStorage with the running overlay. Save them and hand them back.
  const savedFriends = localStorage.getItem("chatFriends");
  const savedRight = localStorage.getItem("chatRight");
  const savedMode = localStorage.getItem("chatRightMode");
  const railTitle = () => document.getElementById("memTitle").textContent;
  const railClosed = () => document.getElementById("panel").classList.contains("no-right");
  // ⚠️ The .where below is the CHAT widget's own member row, NOT the Verse Finder's. Two
  // widgets legitimately use that class name. A blanket rename of the Verse Finder's .where to
  // .gshop silently reached in here and broke this suite -- the failure surfaced three widgets
  // away, which is why the baseline run is the only honest way to attribute a red assertion.
  const whereOf = (h) => {
    const r = [...document.querySelectorAll("#memList .mrow")]
      .find((x) => x.querySelector(".nm")?.textContent === h);
    return r ? (r.querySelector(".where")?.textContent ?? "") : null;
  };
  const gLabel = view.channels[0].label;

  friends = [];
  showRight = true; rightMode = "here"; renderMembers(); applyRails();
  ok("the rail starts on the room's members", railTitle() === "Here", railTitle());

  document.getElementById("friendsBtn").click();
  ok("the friends button flips the SAME rail", railTitle() === "Friends", railTitle());
  ok("...it is the rail that moved, not a second list",
     document.querySelectorAll("#memList").length === 1 && !railClosed());
  ok("...and only one of the two buttons reads active",
     document.getElementById("friendsBtn").classList.contains("active")
       && !document.getElementById("rightBtn").classList.contains("active"));
  ok("...with an empty state that says how to add one",
     /Right-click/i.test(document.querySelector("#memList .empty")?.textContent ?? ""),
     document.querySelector("#memList .empty")?.textContent);

  toggleFriend("Rytharr");        // a member of channels[0], so a shared room can see them
  toggleFriend("NoOneSeesMe");    // in none of your channels
  ok("a friend is listed", whereOf("Rytharr") !== null);
  ok("...marked with the friend star",
     document.querySelectorAll("#memList .mrow .fav").length === 2);
  ok("...and named the channel that can see them", whereOf("Rytharr") === gLabel, whereOf("Rytharr"));
  ok("a friend no shared room can see says NOTHING, never 'offline'",
     whereOf("NoOneSeesMe") === "", whereOf("NoOneSeesMe"));
  ok("...and the count counts friends, not the room",
     document.getElementById("memCount").textContent === "2",
     document.getElementById("memCount").textContent);

  document.getElementById("rightBtn").click();
  ok("the members button switches back rather than closing",
     railTitle() === "Here" && !railClosed(), railTitle());
  document.getElementById("friendsBtn").click();
  ok("...and the chosen mode is remembered",
     localStorage.getItem("chatRightMode") === "friends", localStorage.getItem("chatRightMode"));
  document.getElementById("friendsBtn").click();
  ok("clicking the mode already showing closes the rail", railClosed());

  friends = savedFriends ? JSON.parse(savedFriends) : [];
  for (const [k, v] of [["chatFriends", savedFriends], ["chatRight", savedRight], ["chatRightMode", savedMode]]) {
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  }
  showRight = true; rightMode = "here"; renderMembers(); applyRails();

  // ── pinned notice + the message context menu ─────────────────────────────
  // 🔑 Names here are suffixed because this suite is ONE scope: rows and items are already taken
  // further up, and a duplicate const is a SyntaxError that kills the WHOLE suite before a single
  // assertion runs. It surfaces as a bare "harness error" with no line, and node --check cannot
  // see it, because every suite is a template literal and only the STRING is malformed.
  const gCh = view.channels[0];
  const myHandle = view.you.handle;
  activeCh = gCh.ch;
  gCh.msgs = [
    { id: 41, from: { handle: "Rytharr", verified: true }, text: "meet at Checkmate", at: new Date().toISOString() },
    { id: 42, from: { handle: myHandle, verified: true }, text: "on my way", at: new Date().toISOString() },
  ];
  gCh.pin = null;
  renderPin(); renderLog();
  ok("no pin means no notice bar", document.getElementById("pinbar").hidden);

  gCh.pin = { ch: gCh.ch, id: 41, handle: "Rytharr", text: "meet at Checkmate", by: "Rytharr", at: Date.now() };
  renderPin();
  const pinbar = document.getElementById("pinbar");
  ok("a pin shows the notice bar", !pinbar.hidden);
  ok("...naming who said it and what they said",
     /Rytharr/.test(pinbar.textContent) && /Checkmate/.test(pinbar.textContent), pinbar.textContent);
  // 🔑 The bare attribute is not enough when a rule sets display — this is the 0.1.38 bug.
  gCh.pin = null; renderPin();
  ok("the [hidden] guard really hides it, not just the attribute",
     getComputedStyle(document.getElementById("pinbar")).display === "none",
     getComputedStyle(document.getElementById("pinbar")).display);

  gCh.pin = { ch: gCh.ch, id: 41, handle: "Rytharr", text: "meet at Checkmate", by: "Rytharr", at: Date.now() };
  renderPin();
  ok("you cannot clear a pin in a room you do not own", document.getElementById("pinX").hidden);
  // A custom room you own is the case where the widget may pin.
  const owned = { ch: "custom:mine", kind: "custom", label: "Mine", count: 1, members: [], msgs: gCh.msgs,
                  owner: myHandle.toLowerCase(), privacy: "public", category: "social",
                  pin: { ch: "custom:mine", id: 41, handle: "Rytharr", text: "meet at Checkmate", by: myHandle, at: Date.now() } };
  view.channels.push(owned);
  activeCh = "custom:mine";
  renderPin();
  ok("...but you can in one you do", !document.getElementById("pinX").hidden);

  renderLog();
  const msgRows = [...document.querySelectorAll("#log .msg")];
  const theirMsg = msgRows.find((r) => /Checkmate/.test(r.textContent));
  const myMsg = msgRows.find((r) => /on my way/.test(r.textContent));
  const menuOf = () => [...document.getElementById("ctx").querySelectorAll("button")].map((b) => b.textContent);
  ok("messages rendered for the menu test", !!theirMsg && !!myMsg);
  theirMsg.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
  let menu = menuOf();
  ok("right-clicking a MESSAGE offers report", menu.some((t) => /Report this message/i.test(t)), menu.join(" | "));
  ok("...and pin, because this room is yours", menu.some((t) => /Pin this message/i.test(t)), menu.join(" | "));
  ok("...and it is NOT the person menu", !menu.some((t) => /Open their profile/i.test(t)), menu.join(" | "));
  // The confirmation is a second MENU, never a native modal over a click-through overlay.
  [...document.getElementById("ctx").querySelectorAll("button")]
    .find((b) => /Report this message/i.test(b.textContent)).click();
  menu = menuOf();
  ok("reporting asks first, in a menu rather than a dialog",
     menu.some((t) => /Yes, report it/i.test(t)) && menu.some((t) => /Cancel/i.test(t)), menu.join(" | "));
  ok("...and says the reporter is not named",
     /not told who reported/i.test(document.querySelector("#ctx .ct-note")?.textContent ?? ""),
     document.querySelector("#ctx .ct-note")?.textContent);
  closeCtx();

  myMsg.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
  menu = menuOf();
  ok("you are not offered a way to report yourself",
     !menu.some((t) => /Report this message/i.test(t)), menu.join(" | "));
  closeCtx();

  // 🔑 The NAME keeps its own menu — the row handler must not swallow it.
  theirMsg.querySelector(".nm")
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
  menu = menuOf();
  ok("right-clicking the NAME still opens the person menu",
     menu.some((t) => /Open their profile/i.test(t)) && !menu.some((t) => /Report this message/i.test(t)),
     menu.join(" | "));
  closeCtx();
  view.channels.pop();
  activeCh = gCh.ch;
  gCh.pin = null;
  renderPin();

  // ── the menu must always FIT: this page is an iframe and cannot paint outside it ──────────
  const ctxPanel = () => document.getElementById("panel").getBoundingClientRect();
  const ctxBox0 = ctxPanel();
  const ctxCorners = [[6, 6], [ctxBox0.width - 6, ctxBox0.height - 6],
                      [ctxBox0.width - 6, 6], [6, ctxBox0.height - 6]];
  let ctxEscaped = null;
  for (const [cx, cy] of ctxCorners) {
    openCtx("Rytharr", cx, cy);
    const cb = document.getElementById("ctx").getBoundingClientRect();
    const pb = ctxPanel();
    if (cb.left < pb.left - 1 || cb.top < pb.top - 1 || cb.right > pb.right + 1 || cb.bottom > pb.bottom + 1) {
      ctxEscaped = "from " + Math.round(cx) + "," + Math.round(cy)
        + " menu " + Math.round(cb.left) + "," + Math.round(cb.top) + " " + Math.round(cb.width) + "x" + Math.round(cb.height)
        + " vs panel " + Math.round(pb.left) + "," + Math.round(pb.top) + " " + Math.round(pb.width) + "x" + Math.round(pb.height);
    }
    closeCtx();
  }
  ok("the menu stays inside the widget from every corner", ctxEscaped === null, ctxEscaped);

  // ── party listings: create form, board rows, applicants ──────────────────
  // The opt-in must not be offered when we have nothing to offer.
  view.shard = null; view.regionLabel = null;
  $("cpParty").checked = true;
  syncPartyFields();
  ok("ticking Looking for people reveals the listing fields", $("cpPartyFields").hidden === false);
  ok("...but NOT the use-my-location opt-in, with no shard known", $("cpHereRow").hidden === true);
  view.shard = "pub_use1b_12326004_040"; view.regionLabel = "US East 1B";
  syncPartyFields();
  ok("...which appears once the log has told us where we are", $("cpHereRow").hidden === false);
  ok("...and is OFF by default — publishing your shard is opt-in", $("cpHere").checked === false);
  $("cpParty").checked = false;
  syncPartyFields();
  ok("unticking hides them again", $("cpPartyFields").hidden === true);

  // The board row has to say enough to be worth choosing.
  view.directory = [
    { ch: "custom:halo-run", label: "Halo Run", category: "mining", count: 2,
      party: true, location: "Aaron Halo", sizeMax: 4, joinMode: "apply", voice: "required" },
    { ch: "custom:just-chat", label: "Just Chat", category: "social", count: 5 },
  ];
  collapsed.delete("browse");
  renderChannels();
  const pfRow = [...document.querySelectorAll("#chanList .crow")]
    .find((r) => r.querySelector(".nm")?.textContent === "Halo Run");
  ok("a listing appears on the board", !!pfRow);
  ok("...flagged ASK when the owner approves people",
     pfRow.querySelector(".pflag")?.textContent === "ASK", pfRow.querySelector(".pflag")?.textContent);
  ok("...showing where and the voice expectation",
     /Aaron Halo/.test(pfRow.querySelector(".pmeta")?.textContent ?? "")
       && /voice req/.test(pfRow.querySelector(".pmeta")?.textContent ?? ""),
     pfRow.querySelector(".pmeta")?.textContent);
  // 🔑 The live number is PRESENCE; sizeMax is only what the leader wants.
  ok("...with the live count against the wanted size",
     pfRow.querySelector(".ct")?.textContent === "2/4", pfRow.querySelector(".ct")?.textContent);
  const pfPlain = [...document.querySelectorAll("#chanList .crow")]
    .find((r) => r.querySelector(".nm")?.textContent === "Just Chat");
  ok("an ordinary room is not dressed up as a listing",
     !pfPlain.querySelector(".pflag") && pfPlain.querySelector(".ct").textContent === "5");

  // Applicants: owner only, and visible without opening anything.
  const pfMine = { ch: "custom:halo-run", kind: "custom", label: "Halo Run", count: 2, members: [], msgs: [],
                   privacy: "public", owner: myHandle.toLowerCase(), party: true, joinMode: "apply",
                   applications: [{ handle: "seeker", note: "have a Prospector", at: Date.now() },
                                  { handle: "zed", note: null, at: Date.now() }] };
  view.channels.push(pfMine);
  activeCh = "custom:halo-run";
  setChanSettings(true);
  ok("the owner sees who wants in", $("csAppsRow").hidden === false
     && /2 people want in/.test($("csAppsLbl").textContent), $("csAppsLbl").textContent);
  ok("...each with accept and decline",
     document.querySelectorAll("#csApps .ap").length === 2
       && document.querySelectorAll("#csApps .ap .hbtn").length === 4);
  ok("...and their note, which is how you decide",
     /have a Prospector/.test($("csApps").textContent), $("csApps").textContent.slice(0, 60));
  renderTabs();
  const pfTab = [...document.querySelectorAll("#tabs .tab")].find((t) => /Halo Run/.test(t.textContent));
  ok("the TAB carries the count, so it is seen without opening the cog",
     pfTab?.querySelector(".apps")?.textContent === "2", pfTab?.querySelector(".apps")?.textContent);

  // 🔴 The applicant bar — Sub's own question about this feature: the cog may be the wrong home,
  // because an application arriving mid-mission is invisible inside a popover and the applicant
  // waits on an owner who never knew. The cog keeps the full list; the bar is the part that must
  // not need opening.
  setChanSettings(false);
  renderApps();
  const abBar = $("appbar");
  ok("pending applications show IN the room, not only behind the cog", abBar.hidden === false);
  ok("...counting them when there is more than one",
     /2 people want in/.test($("appText").textContent), $("appText").textContent);
  ok("...offering Review rather than a guess at which one you meant",
     $("appMore").hidden === false && $("appYes").hidden === true, $("appText").textContent);

  pfMine.applications = [{ handle: "seeker", note: "have a Prospector", at: Date.now() }];
  renderApps();
  ok("one applicant is named on the bar, with their note",
     /seeker/.test($("appText").textContent) && /have a Prospector/.test($("appText").textContent),
     $("appText").textContent);
  ok("...and is actionable without opening anything",
     $("appYes").hidden === false && $("appNo").hidden === false && $("appMore").hidden === true);
  // 🔑 The handle is read off the bar at CLICK time, never captured in a listener — a render
  // between seeing a name and pressing Accept must not admit the person who used to be there.
  ok("...with the handle carried on the bar itself", abBar.dataset.handle === "seeker", abBar.dataset.handle);

  pfMine.owner = "someoneelse";
  renderChanSettings(); renderTabs(); renderApps();
  ok("a non-owner is shown no applicant list", $("csAppsRow").hidden === true);
  ok("...and no bar either", abBar.hidden === true);
  // 🔑 The bare attribute is not enough when any rule sets display — the shipped 0.1.38 bug.
  ok("...with a real [hidden] guard behind it, not just the attribute",
     getComputedStyle(abBar).display === "none", getComputedStyle(abBar).display);
  const pfTab2 = [...document.querySelectorAll("#tabs .tab")].find((t) => /Halo Run/.test(t.textContent));
  ok("...and no tab marker either", !pfTab2?.querySelector(".apps"));
  setChanSettings(false);
  view.channels.pop();

  // A new applicant in a room you are NOT looking at has to reach you somehow.
  const abRoom = { ch: "custom:other-run", kind: "custom", label: "Other Run", count: 1, members: [], msgs: [],
                   privacy: "public", owner: myHandle.toLowerCase(), party: true, joinMode: "apply",
                   applications: [{ handle: "newbie", note: null, at: Date.now() }] };
  view.channels.push(abRoom);
  activeCh = gCh.ch;
  unread.delete(abRoom.ch); seenApps.delete(abRoom.ch);
  noteApplications();
  // 🔑 First sight seeds SILENTLY. This iframe reloads on every regroup and the server re-sends
  // the whole list on join, so without it a stack, a restart or an arrange pass would re-announce
  // applicants the owner already dealt with — the same trap the mining scanner hit on mount.
  ok("a room seen for the first time does not shout about applicants it already had",
     !unread.has(abRoom.ch));
  abRoom.applications.push({ handle: "second", note: null, at: Date.now() });
  noteApplications();
  ok("...but a genuinely new one lights the unread dot from another tab", unread.has(abRoom.ch));
  unread.delete(abRoom.ch);
  activeCh = abRoom.ch;
  abRoom.applications.push({ handle: "third", note: null, at: Date.now() });
  noteApplications();
  ok("...and never while you are looking at that room — the bar is already saying it",
     !unread.has(abRoom.ch));
  activeCh = gCh.ch;
  view.channels.pop();
  seenApps.delete(abRoom.ch);
  renderApps();
  view.directory = [];
  activeCh = gCh.ch;

  // ── what the create form actually SENDS, and what a board row DOES ───────
  // 🔑 Everything above this point asserts what the party UI LOOKS like. None of it could
  // catch the two things that matter most about it: which location leaves the machine, and
  // whether clicking an apply-only listing sends a join we know will bounce. Both are request
  // bodies, so the only way to test them is to be the server.
  const crPost = post;                 // function declaration in page scope — reassignable
  let crSent = null;
  post = async (path, body) => { crSent = { path, body: JSON.parse(JSON.stringify(body)) }; return true; };
  try {
    setCreatePop(true);
    await sleep(60);
    $("cpName").value = "Halo Mining Run";

    // 🔑 A <select> silently defaults to its FIRST option, so "nobody touched it" is whatever
    // happens to be listed first rather than a considered default. Assert the defaults rather
    // than assuming the markup order is the intent.
    ok("joining defaults to open", $("cpJoin").value === "open", $("cpJoin").value);
    ok("voice defaults to none — we host no voice and must not imply otherwise",
       $("cpVoice").value === "none", $("cpVoice").value);

    // An ordinary room is an ordinary room: no listing fields ride along uninvited.
    $("cpParty").checked = false;
    syncPartyFields();
    await createRoom();
    ok("creating a plain room sends no listing fields at all",
       crSent.path === "/api/chat/join" && crSent.body.mode === "create"
         && crSent.body.party === undefined && crSent.body.minutes === undefined,
       JSON.stringify(crSent.body));

    // 🔴 THE PRIVACY CALL, and the one assertion in this file worth the most: publishing your
    // shard is OPT-IN PER LISTING (Sub, 2026-08-10). Unticked, only what they typed goes out —
    // merely having the widget open, or having a region known, must leak nothing.
    view.shard = "pub_use1b_12326004_040"; view.regionLabel = "US East 1B";
    $("cpName").value = "Halo Mining Run";
    $("cpParty").checked = true;
    syncPartyFields();
    $("cpWhere").value = "Aaron Halo";
    $("cpHere").checked = false;
    syncPartyFields();
    await createRoom();
    ok("with the opt-in OFF, the real region never leaves the machine",
       crSent.body.location === "Aaron Halo", JSON.stringify(crSent.body.location));
    ok("...and the listing fields are all present",
       crSent.body.party === true && crSent.body.joinMode === "open" && crSent.body.voice === "none"
         && crSent.body.sizeMax === 4,
       JSON.stringify(crSent.body));
    // 🔑 A DURATION, never an expiresAt. A wall-clock stamp off a machine we do not control is a
    // listing that never expires or is dead on arrival, and desktop clocks are wrong often
    // enough for that to look random rather than broken.
    ok("expiry is sent as minutes, not as a wall-clock time",
       typeof crSent.body.minutes === "number" && crSent.body.minutes === 120
         && crSent.body.expiresAt === undefined && crSent.body.expires_at === undefined,
       JSON.stringify(crSent.body.minutes));

    $("cpName").value = "Halo Mining Run";
    $("cpParty").checked = true;
    $("cpHere").checked = true;
    syncPartyFields();
    ok("ticking it takes the free-text field out of play, so the two can't disagree",
       $("cpWhere").disabled === true);
    await createRoom();
    ok("...and THEN the real region is what publishes",
       crSent.body.location === "US East 1B", JSON.stringify(crSent.body.location));

    $("cpHere").checked = false; $("cpParty").checked = false;
    syncPartyFields();
    setCreatePop(false);

    // ── clicking a row ────────────────────────────────────────────────────
    view.directory = [
      { ch: "custom:open-run", label: "Open Run", category: "mining", count: 2,
        party: true, joinMode: "open", sizeMax: 4 },
      { ch: "custom:ask-run", label: "Ask Run", category: "mining", count: 1,
        party: true, joinMode: "apply", sizeMax: 6 },
    ];
    collapsed.delete("browse");
    renderChannels();
    const crRowOf = (label) => [...document.querySelectorAll("#chanList .crow")]
      .find((r) => r.querySelector(".nm")?.textContent === label);

    ok("an open listing is flagged OPEN, not ASK",
       crRowOf("Open Run").querySelector(".pflag")?.textContent === "OPEN",
       crRowOf("Open Run").querySelector(".pflag")?.textContent);
    // Anything absent is left out rather than rendered as an empty field — a listing carrying a
    // bare separator reads as missing data, which on a board is worse than a shorter row.
    ok("a listing with no location and no voice carries no meta line at all",
       !crRowOf("Ask Run").querySelector(".pmeta"),
       crRowOf("Ask Run").querySelector(".pmeta")?.textContent);

    crSent = null;
    crRowOf("Open Run").click();
    await sleep(30);
    ok("clicking an open listing joins it",
       crSent && crSent.path === "/api/chat/join" && crSent.body.name === "Open Run"
         && crSent.body.mode === "join",
       JSON.stringify(crSent));

    // 🔴 The UI half of the gate bug. The server refuses an apply-mode join by name — that
    // refusal is what makes "you approve people" mean anything — but sending a join we KNOW
    // will bounce, purely to show the user an error, is a worse experience than asking
    // properly. This is the assertion that notices if the row handler is ever simplified.
    crSent = null;
    crRowOf("Ask Run").click();
    await sleep(30);
    ok("clicking an apply-only listing ASKS instead of trying to walk in",
       crSent && crSent.path === "/api/chat/apply" && crSent.body.ch === "custom:ask-run",
       JSON.stringify(crSent));
    ok("...and the row says so before you click it",
       /Ask to join/i.test(crRowOf("Ask Run").title), crRowOf("Ask Run").title);

    // The bar's buttons go down the SAME path the cog's list uses — one way to admit someone,
    // not two, so a fix to one can never leave the other behind.
    const crMine = { ch: "custom:bar-run", kind: "custom", label: "Bar Run", count: 1, members: [], msgs: [],
                     privacy: "public", owner: myHandle.toLowerCase(), party: true, joinMode: "apply",
                     applications: [{ handle: "seeker", note: null, at: Date.now() }] };
    view.channels.push(crMine);
    activeCh = "custom:bar-run";
    renderApps();
    crSent = null;
    $("appYes").click();
    await sleep(30);
    ok("accepting from the bar resolves that application",
       crSent && crSent.path === "/api/chat/application" && crSent.body.handle === "seeker"
         && crSent.body.accept === true,
       JSON.stringify(crSent));
    crSent = null;
    $("appNo").click();
    await sleep(30);
    ok("...and No declines the same one", crSent && crSent.body.accept === false, JSON.stringify(crSent));
    view.channels.pop();
  } finally {
    // Leave the page exactly as it was: this suite shares an origin and a live sidecar with the
    // real overlay window, and a stubbed post() left behind would silently swallow real calls.
    post = crPost;
    view.directory = [];
    $("cpName").value = "";
    activeCh = gCh.ch;
    setCreatePop(false);
    renderChannels(); renderApps();
  }

  // ── the bundled colour emoji font ────────────────────────────────────────
  // 🔑 Assert the font actually LOADS, not merely that the CSS mentions it. A 404 on the file
  // fails silently back to the OS font, which is the exact bug being fixed — and on the
  // machine of whoever runs this suite the OS font probably has the glyph, so it would look
  // fine while being broken for the user who reported boxes.
  const fontRes = await fetch("/fonts/NotoColorEmoji.ttf", { method: "HEAD" });
  ok("the bundled emoji font is served", fontRes.ok, "HTTP " + fontRes.status);
  // 🔑 The face carries a unicode-range, so it is only fetched for characters INSIDE that range.
  // load() must therefore be given the text — asking for the family alone loads nothing and
  // check() then answers false for a font that is perfectly fine.
  const o7 = String.fromCodePoint(0x1FAE1);
  await document.fonts.load('16px "SCO Emoji"', o7);
  // o7 is the whole reason this exists: U+1FAE1, Unicode 14, missing from older Segoe UI Emoji.
  ok("...and covers o7 (U+1FAE1), the one that was a box", document.fonts.check('16px "SCO Emoji"', o7));
  // Order matters: behind Segoe UI Emoji it would never be consulted on the Windows machines
  // that have the problem. Measured off a REAL message node, not off the stylesheet text.
  const fontProbe = document.createElement("div");
  fontProbe.className = "msg";
  const fontProbeTx = document.createElement("span");
  fontProbeTx.className = "tx";
  fontProbe.appendChild(fontProbeTx);
  document.getElementById("log").appendChild(fontProbe);
  const fam = getComputedStyle(fontProbeTx).fontFamily;
  ok("the bundled font is in the message stack", /SCO Emoji/.test(fam), fam);
  ok("...ahead of the OS emoji fonts, or it would never be reached",
     fam.indexOf("SCO Emoji") < fam.indexOf("Segoe UI Emoji"), fam);
  fontProbe.remove();

  // Conversations the server knows about but that aren't open tabs.
  view.dmThreads = [{ other: "zed", lastAt: new Date().toISOString() }];
  renderChannels();
  const waiting = [...document.querySelectorAll("#chanList .crow")]
    .filter((r) => r.querySelector(".dmdot")).map((r) => r.querySelector(".nm").textContent);
  ok("a conversation waiting for you is listed", waiting.join(",") === "zed", waiting.join(","));

  return out;
})()`;

const UNLOCK = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const GOOD = "tape-tl.webp", GOOD2 = "anvil-bolt-tl.webp", BAD = "deliberate-404-for-test.webp";
  const card = document.getElementById("card"), img = document.getElementById("img");
  const thumb = document.getElementById("thumb");
  const up = () => card.classList.contains("show");
  const src = () => img.getAttribute("src") || "";
  const at = (secsAgo) => new Date(Date.now() - secsAgo * 1000).toISOString();

  ok("starts hidden", !up());

  // Hold the timestamp: a receipt is identified BY it, so re-sending the same receipt means the
  // same string. Recomputing it would just look like a second unlock and quietly test nothing.
  const RECEIPT = at(1);
  offer({ name: "Trawler Scraper Module", at: RECEIPT, image: GOOD, imageFallback: GOOD2 });
  await sleep(200);
  ok("a fresh receipt shows the card", up());
  ok("prefers the fabricator capture", src().endsWith(GOOD), src());
  ok("names the blueprint", document.getElementById("name").textContent === "Trawler Scraper Module");

  // The very same receipt again — every SSE frame repeats the current view, so this arrives
  // constantly and must never re-announce or pile up in the queue.
  const before = src();
  offer({ name: "SOMETHING ELSE", at: RECEIPT, image: GOOD2, imageFallback: GOOD2 });
  await sleep(120);
  ok("the same receipt is not re-announced", src() === before && document.getElementById("name").textContent === "Trawler Scraper Module");
  ok("...and does not queue", document.getElementById("more").hidden, document.getElementById("more").textContent);

  // A second unlock while the first is up queues rather than clobbering.
  offer({ name: "Second Item", at: at(2), image: GOOD2, imageFallback: GOOD2 });
  await sleep(120);
  ok("a burst queues behind the current card", document.getElementById("more").textContent === "+1 more",
     document.getElementById("more").textContent);

  document.getElementById("close").click();
  await sleep(120);
  ok("dismiss clears the card and the queue", !up());

  // No capture for this item — must land on the render, not a blank tile.
  offer({ name: "No Capture Yet", at: at(3), image: BAD, imageFallback: GOOD2 });
  await sleep(500);
  ok("falls back to the render when the capture 404s", src().endsWith(GOOD2), src());
  ok("...and still shows a picture", !thumb.classList.contains("noimg"));

  document.getElementById("close").click(); await sleep(80);
  offer({ name: "Nothing At All", at: at(4), image: BAD, imageFallback: BAD });
  await sleep(600);
  ok("falls through to the glyph when both fail", thumb.classList.contains("noimg"));

  // A reconnect replays the last view; anything older than the freshness window must stay quiet.
  document.getElementById("close").click(); await sleep(80);
  offer({ name: "Ancient", at: at(600), image: GOOD, imageFallback: GOOD2 });
  await sleep(160);
  ok("a stale receipt is ignored", !up());

  // Arrange mode holds a sample card up so the widget can be positioned while idle.
  window.__unlockAlertPreview(true);
  await sleep(160);
  ok("arrange preview holds a card up", up());
  window.__unlockAlertPreview(false);
  await sleep(160);
  ok("...and drops it when arrange ends", !up());
  return out;
})()`;

app.disableHardwareAcceleration();
// Suites run one window at a time, and destroying the last open window would otherwise trigger
// Electron's default quit-on-window-all-closed and kill the run before the next suite loads.
app.on("window-all-closed", () => {});
// The scan read area is CALIBRATION the user did by hand, it lives in the real sidecar config, and
// these suites drive the real control. Measured 2026-07-29: it was shrinking a little on every run —
// and not only in the suite that owns it, so an in-suite save/restore could not protect it (the
// value had already moved before that suite even captured it). Snapshot it once here, before any
// window opens, and put it back once at the end whatever happened in between. Defending the user's
// data at the boundary beats chasing whichever suite is the writer.
async function readScanRegion() {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/config`, { cache: "no-store" });
    const c = await r.json();
    return c && c.scanRegion ? c.scanRegion : null;
  } catch { return undefined; } // undefined = couldn't read, so don't presume to write anything back
}
async function writeScanRegion(region) {
  try {
    await fetch(`http://localhost:${PORT}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanRegion: region }),
    });
  } catch { /* the sidecar went away; nothing we can do from here */ }
}

// 🔴 The Hauling widget's honesty rules, which are the reason it exists.
//
// 57% of the orders in the shipped dataset give an SCU RANGE rather than a number, and the only
// thing that pins the real figure is the game's `Deliver 0/N SCU` line — which it emits ONLY for a
// contract the player has TRACKED in mobiGlas. So the two failures that would make this widget
// worse than nothing are printing a range as if it were a number, and quietly leaving a leg out of
// a route that still presents itself as the route. Both are asserted here.
//
// Driven by ASSIGNING the page's own `plan` binding rather than by seeding the sidecar: these are
// rendering rules, and a fabricated plan makes them deterministic on any machine, with or without
// a game running. (`plan` is a top-level `let` in a classic script, so it is reachable by name.)
const HAULING = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500); // let the page's own first load settle before overwriting it

  ok("the ship picker is populated from ships.json", document.getElementById("shipPick").options.length > 20,
     document.getElementById("shipPick").options.length);
  ok("...and offers the log as the default", document.getElementById("shipPick").options[0].value === "");

  const leg = (group, over) => Object.assign({
    key: "k", index: 0, group, commodity: null, destination: null, unit: "scu",
    scu: 56, min: 40, max: 56, source: "range", exact: false, maxContainerScu: 8, capSource: "dataset",
    boxes: [{ scu: 8, count: 7 }], boxLabel: "7x8", boxCount: 7, boxSource: "partition",
    pickupState: "pending", dropoffState: "pending", delivered: null,
    fromLocation: "@1,1,1", toLocation: "@2,2,2",
  }, over || {});

  /* 🔴 THE WIDGET NOW OPENS ON THE RANK TAB (2026-08-18 — it is the tab you read BEFORE you have a
     board, so it leads). Every assertion below is about the ROUTE view, which used to be the
     default and silently stopped rendering when that changed: the card selector found nothing, the suite
     threw on the first byTitle() and — because a throw took the whole file down — hid the stow
     failures behind it too.
     WARNING: clicked, not assigned. The page keeps its view in a let inside its own closure, and
     executeJavaScript runs in the global scope — so assigning view here only makes a global the
     page never reads, and the suite goes on testing the wrong tab while looking like it fixed
     itself. Drive the tab the way a player does. */

  document.getElementById("tabRoute").click();
  // Long enough for the load() that click kicks off to come back and repaint. Too short and its
  // response lands AFTER the fixture below is assigned, quietly replacing it with the sidecar's
  // real (empty) board - which reads as "the route drew nothing" rather than as a race.
  await sleep(500);

  plan = {
    updatedAt: Date.now(),
    ship: { className: "CRUS_Starlifter_C2", displayName: "Crusader C2 Hercules Starlifter", totalScu: 696,
      source: "log",
      grids: [{ name: "hardpoint_cargo_large", w: 8, l: 15, h: 4, capacityScu: 480, usedScu: 24 },
              { name: "hardpoint_cargo_small", w: 6, l: 9, h: 4, capacityScu: 216, usedScu: 0 }] },
    contracts: [
      { missionId: "m-tracked", title: "Tracked Haul", contractKey: "K1", generator: "Covalex_Hauling",
        giver: "Covalex", missionType: "Hauling - Planetary", deliverSeen: true, trackedNow: false,
        board: { rank: "Rookie", size: "Medium", direct: true }, ended: false, completion: null,
        payout: null, scu: 81, minScu: 81, maxScu: 81, source: "log", exact: true, plannable: true,
        legs: [leg("g-tracked", { scu: 81, min: 81, max: 81, source: "log", exact: true,
          commodity: "Stims", destination: "Baijini Point", boxes: [{ scu: 8, count: 10 }, { scu: 1, count: 1 }],
          boxLabel: "10x8 · 1x1", boxCount: 11 })] },
      { missionId: "m-range", title: "Untracked Haul", contractKey: "K2", generator: "Covalex_Hauling",
        giver: "Covalex", missionType: "Hauling - Planetary", deliverSeen: false, trackedNow: false,
        board: { rank: "Junior", size: "Extra Small", direct: true }, ended: false, completion: null,
        payout: null, scu: 56, minScu: 40, maxScu: 56, source: "range", exact: false, plannable: true,
        legs: [leg("g-range")] },
      { missionId: "m-orphan", title: "Orphan Haul", contractKey: "K3", generator: "Covalex_Hauling",
        giver: "Covalex", missionType: "Hauling - Planetary", deliverSeen: true, trackedNow: false,
        board: null, ended: false, completion: null,
        payout: null, scu: 16, minScu: 16, maxScu: 16, source: "log", exact: true, plannable: true,
        legs: [leg("g-orphan", { scu: 16, min: 16, max: 16, source: "log", exact: true,
          commodity: "Waste", destination: "Riker Memorial Spaceport", fromLocation: null,
          boxes: [{ scu: 8, count: 2 }], boxLabel: "2x8", boxCount: 2 })] },
    ],
    untracked: [{ missionId: "m-range", title: "Untracked Haul", minScu: 40, maxScu: 56, trackedNow: false }],
    trackedMissionId: null,
    trips: [{ landings: 2, totalMinutes: 12, peakScu: 137, method: "exact", stops: [
       /* 🔑 kind is PER ACTION, not just per stop - one landing can unload and load, and the
          widget groups the row by it. This fixture predated that and carried the kind only on
          the stop, so every action filtered out and NO route rows were drawn: the route
          assertions had been measuring an empty page. Nothing pointed at it because the suite
          threw two assertions later on stops[1] and took the whole file down with it. */
      { id: "@1,1,1:pickup", locationId: "@1,1,1", name: "Baijini Point", kind: "pickup", minutes: 4, loadAfterScu: 137, sameSpot: false,
        actions: [{ missionId: "m-tracked", title: "Tracked Haul", commodity: "Stims", scu: 81, group: "g-tracked", kind: "pickup" },
                  { missionId: "m-range", title: "Untracked Haul", commodity: null, scu: 56, group: "g-range", kind: "pickup" }] },
      { id: "@1,1,1:dropoff", locationId: "@1,1,1", name: "Baijini Point", kind: "dropoff", minutes: 0, loadAfterScu: 0, sameSpot: true,
        actions: [{ missionId: "m-tracked", title: "Tracked Haul", commodity: "Stims", scu: 81, group: "g-tracked", kind: "dropoff" }] },
    ] }],
    stranded: [],
    locationNames: { "@1,1,1": "Baijini Point", "@2,2,2": "Site 1" },
    unrouted: [{ group: "g-orphan", missionId: "m-orphan", title: "Orphan Haul", scu: 16,
      destination: "Riker Memorial Spaceport", toLocation: "@2,2,2",
      reason: "the log carries no pickup marker for this leg" }],
    pack: { fits: true, loadedScu: 24, capacityScu: 696, unplaced: [], byGrid: [],
      placements: [
        { grid: "hardpoint_cargo_large", item: "a", group: "g-tracked", scu: 8, x: 0, y: 0, z: 0, dx: 2, dy: 2, dz: 2 },
        { grid: "hardpoint_cargo_large", item: "b", group: "g-range", scu: 8, x: 2, y: 0, z: 0, dx: 2, dy: 2, dz: 2 },
        { grid: "hardpoint_cargo_large", item: "c", group: "g-range", scu: 8, x: 0, y: 2, z: 2, dx: 2, dy: 2, dz: 2 },
      ] },
    aboardScu: 0,
    totals: { scu: 153, capacityScu: 696, liveContracts: 3, unknownContracts: 0, recentPayout: 0, totalMinutes: 12 },
    notes: ["1 contract planned at the TOP of the dataset's range."],
  };
  render();
  await sleep(60);

  // ── 🔴 a range is never printed as a number ──────────────────────────────
  const cards = [...document.querySelectorAll(".card")];
  const byTitle = (t) => cards.find((c) => c.querySelector(".t").textContent === t);
  ok("three contracts on the board", cards.length === 3, cards.length);
  ok("🔴 a RANGED contract prints both ends, never the worst case alone",
     byTitle("Untracked Haul").querySelector(".amt").textContent === "40–56 SCU",
     byTitle("Untracked Haul").querySelector(".amt").textContent);
  /* PROVENANCE IS A COLOUR NOW, not a pill. 25f26a2 moved it onto the figure itself and this
     suite went on asking for the removed .badge element. querySelector returned null and the whole
     run threw on .textContent BEFORE its first assertion, so NOTHING in this file was checked for
     hours while it reported only "FAILED (1)". Assert the class AND the tooltip: the widget's own
     note is that a hue nobody can name is not provenance, so the wording is the half a
     colour-blind player actually gets, and it is the half worth pinning. */
  ok("...and says where that came from, in the colour",
     byTitle("Untracked Haul").querySelector(".amt").classList.contains("src-range"),
     byTitle("Untracked Haul").querySelector(".amt").className);
  ok("...with the wording kept on the figure as a tooltip",
     /only bound this contract/.test(byTitle("Untracked Haul").querySelector(".amt").title),
     byTitle("Untracked Haul").querySelector(".amt").title);
  ok("a TRACKED contract prints the game's own figure",
     byTitle("Tracked Haul").querySelector(".amt").textContent === "81 SCU",
     byTitle("Tracked Haul").querySelector(".amt").textContent);
  ok("...coloured as coming from the log",
     byTitle("Tracked Haul").querySelector(".amt").classList.contains("src-log"),
     byTitle("Tracked Haul").querySelector(".amt").className);
  ok("...with the log's wording on it",
     /stated this tonnage/.test(byTitle("Tracked Haul").querySelector(".amt").title),
     byTitle("Tracked Haul").querySelector(".amt").title);
  /* Non-emptiness is asserted too: every() over an empty list is true, so a board that rendered
     no cards at all would have satisfied the old form of this. */
  var provOk = cards.filter(function (c) { var a = c.querySelector(".amt"); return !!a && /src-[a-z]+/.test(a.className) && !!a.title; }).length;
  ok("every contract's figure carries provenance", cards.length > 0 && provOk === cards.length,
     "n=" + cards.length + " with provenance=" + provOk);
  /* The "modelled" chip is gone - Sub called it noise, and the counts had been right every time he
     checked (see the stylesheet note). Provenance rides on the figure's colour now, which the two
     assertions above already pin, so this asserts the chip is NOT reintroduced by accident rather
     than testing a label that no longer exists. */
  ok("the modelled chip stays gone",
     [...byTitle("Tracked Haul").querySelectorAll(".chips .badge")].every((b) => b.textContent !== "modelled"));

  // ── 🔴 the please-track prompt ───────────────────────────────────────────
  const track = document.getElementById("track");
  const rows = [...document.querySelectorAll(".trow")];
  ok("the track prompt is up while anything is unpinned", track.style.display !== "none");
  ok("...listing only what is not pinned", rows.length === 1 && /Untracked Haul/.test(rows[0].textContent),
     rows.map((r) => r.textContent).join(" | "));
  ok("...showing the bounds we do have", /40–56 SCU/.test(rows[0].textContent), rows[0].textContent);
  ok("...with somewhere to type the real figure", !!rows[0].querySelector("input"));
  ok("...and the rank tier and size band it is listed under on the board",
     rows[0].querySelector(".bd").textContent === "Junior · Extra Small",
     rows[0].querySelector(".bd").textContent);

  // 🔴 THE THREE STATES. This contract is not tracked, so tracking it is worth doing and the
  // panel says so.
  ok("an UNTRACKED contract is told to be tracked",
     rows[0].querySelector(".badge").textContent === "track it",
     rows[0].querySelector(".badge").textContent);
  ok("...and the heading is the instruction",
     document.getElementById("trackK").textContent === "Track these in mobiGlas",
     document.getElementById("trackK").textContent);

  // 🔴 Now track it. The tonnage is STILL unknown — the game states it at objective assignment
  // and re-tracking replays nothing — so the panel must stop asking for something already done.
  // This is Sub's live 2026-08-17 board, and the exact state the old prompt got wrong.
  plan.contracts[1].trackedNow = true;
  plan.trackedMissionId = "m-range";
  render();
  await sleep(60);
  const trow = document.querySelector(".trow");
  ok("🔴 a TRACKED contract with no tonnage is not told to track it again",
     trow.querySelector(".badge").textContent === "tracked",
     trow.querySelector(".badge").textContent);
  ok("🔴 ...and the heading stops being an instruction nothing can satisfy",
     document.getElementById("trackK").textContent === "Load not confirmed",
     document.getElementById("trackK").textContent);
  /* The four-line WHY block became an (i) affordance carrying the same sentence as its tooltip,
     so read the title rather than the removed element's text. The wording is what matters and it
     is unchanged; the assertion should follow it, not the markup it used to live in. */
  ok("🔴 ...and the explanation says why there is nothing left to do",
     /re-tracking does not replay/.test(document.getElementById("trackInfo").title),
     document.getElementById("trackInfo").title);
  ok("...while the row still offers the box to type the figure into",
     !!trow.querySelector("input"));
  ok("...and the contract is still listed, not hidden",
     document.querySelectorAll(".trow").length === 1);
  plan.contracts[1].trackedNow = false;
  plan.trackedMissionId = null;
  render();
  await sleep(60);

  // ── 🔴 nothing is dropped from the route in silence ──────────────────────
  const notes = [...document.querySelectorAll(".note")].map((n) => n.textContent).join(" | ");
  ok("🔴 an unroutable leg is reported, not omitted",
     /Riker Memorial Spaceport/.test(notes) && /no pickup marker/.test(notes), notes);

  // ── the route ────────────────────────────────────────────────────────────
  const stops = [...document.querySelectorAll(".stop")];
  ok("both visits are drawn", stops.length === 2, stops.length);
  ok("a second visit to the same place is marked as one landing", /same landing/.test(stops[1].textContent));
  ok("...and is not charged a minute it does not cost",
     stops[1].querySelector(".rt").textContent.startsWith("—"),
     stops[1].querySelector(".rt").textContent);

  // ── the stow tab ─────────────────────────────────────────────────────────
  document.getElementById("tabLayout").click();
  await sleep(80);
  ok("every placement is drawn", document.querySelectorAll(".iso-box").length === 3,
     document.querySelectorAll(".iso-box").length);
  ok("the empty grid is not drawn at all", !document.body.textContent.includes("cargo small"));
  const body = document.getElementById("body");
  ok("the diagram never scrolls the panel sideways", body.scrollWidth <= body.clientWidth,
     body.scrollWidth + " vs " + body.clientWidth);
  /* 🔴 ONE ENTRY PER DROP-OFF STOP, not per mission. The hold is zoned by drop-off now (4a84361 -
     "zone the hold by drop-off stop, not by mission or commodity"), and this still expected the old
     per-mission count. Derived from the plan rather than hard-coded, so it keeps pinning the RULE
     (a colour means a drop) instead of a number that moves whenever the fixture does. */
  var dropLocs = {};
  (plan.trips || []).forEach(function (t) {
    (t.stops || []).forEach(function (s) {
      if ((s.actions || []).some(function (a) { return a.kind === "dropoff"; })) dropLocs[s.locationId || s.id] = 1;
    });
  });
  var wantLegend = Object.keys(dropLocs).length;
  ok("the legend says which colour is which drop",
     wantLegend > 0 && document.querySelectorAll(".legend span").length === wantLegend,
     document.querySelectorAll(".legend span").length + " spans for " + wantLegend + " drop-off stops");

  /* ── 🔴 A PILL WRAPS AS A PILL, OR NOT AT ALL (Sub, 2026-08-22) ─────────────────────────────
     Measured on the Runs tab at 440px, the widget's DEFAULT width: the chip row was a block of
     inline spans, so the ONLY break opportunities the engine had were the spaces inside each
     pill's own label. "costs 851k" put its left half at x=290 on line one and its right half at
     x=39 on line two - one bordered box sawn in half - and it overflowed by four pixels.

     🔑 SYNTHETIC, ON PURPOSE. The real Runs rows need a live commodity table, so an assertion
     over them would pass or fail on whether this machine has trade data - the same rot as the
     assertion that once depended on how recently Sub had played. The rules under test are pure
     CSS, so they are driven against pills built here.

     🔴 TWO PROBES, BECAUSE THE FIX IS TWO INDEPENDENT MECHANISMS AND EACH MUST BE TESTED WHERE IT
     IS LOAD-BEARING. The first attempt put both in one flex probe and the nowrap control came back
     GREEN - correctly, because a FLEX ITEM is blockified and the parent cannot break it however
     its white-space is set. That assertion was testing flex while claiming to test nowrap. So:
       - the nowrap rule matters in the INLINE chip rows that are still around (the Ledger totals,
         the route cards) - probe A gives it one of those.
       - the flex rule matters in the Runs row - probe B gives it that, and its control (flex
         removed) puts three unbreakable pills on one line running off the edge.

     ⚠️ Positive first in both. "No pill is split" is satisfied for free by a page with no pills. */
  var pillProbe = document.createElement("div");
  pillProbe.style.position = "absolute";
  pillProbe.style.left = "-9999px";
  pillProbe.style.width = "600px";
  document.body.appendChild(pillProbe);
  var pillLabels = ["3 on the shelf", "Pyro to Stanton", "costs 851k"];
  var pillIn = function (holder) {
    pillLabels.forEach(function (label) {
      var b = document.createElement("span");
      b.className = "badge calm";
      b.textContent = label;
      holder.appendChild(b);
    });
    return [].slice.call(holder.children);
  };

  /* ── Probe A: an INLINE chip row, which is what the Ledger totals and the route cards still are.
     ⚠️ MEASURE THE BOX, NEVER PICK IT. An earlier version pinned 90px, which is narrower than one
     pill, so every pill overflowed on a line of its own and the wrap check failed on working code.
     Laid out wide, measured, then squeezed to just under one pill so the label WOULD break if it
     were allowed to. */
  var inlineRow = document.createElement("div");
  inlineRow.className = "m";
  pillProbe.appendChild(inlineRow);
  var inlinePills = pillIn(inlineRow);
  var inlineWidest = Math.max.apply(null, inlinePills.map(function (b) {
    return b.getBoundingClientRect().width;
  }));
  pillProbe.style.width = Math.max(40, Math.floor(inlineWidest * 0.7)) + "px";
  var inlineW = inlineRow.getBoundingClientRect().width;
  ok("there are inline pills to check, in a box narrower than one of them",
     inlinePills.length === 3 && inlineW < inlineWidest,
     inlinePills.length + " pills, widest " + Math.round(inlineWidest)
       + "px, box " + Math.round(inlineW) + "px");
  var inlineSplit = inlinePills.filter(function (b) { return b.getClientRects().length > 1; });
  ok("🔴 a pill is never sawn in half at a space in its own label",
     inlinePills.length === 3 && inlineSplit.length === 0,
     inlineSplit.length
       ? "split: " + inlineSplit.map(function (b) { return b.textContent + " over "
           + b.getClientRects().length + " lines"; }).join("; ")
       : "all " + inlinePills.length + " render as one box each");

  /* ── Probe B: the Runs chip row. Box measured to hold the widest pill and not all three. */
  pillProbe.style.width = "600px";
  var flexOuter = document.createElement("div");
  flexOuter.className = "tdrow";
  var flexRow = document.createElement("div");
  flexRow.className = "m tdchips";
  flexOuter.appendChild(flexRow);
  pillProbe.appendChild(flexOuter);
  var flexPills = pillIn(flexRow);
  var flexWidths = flexPills.map(function (b) { return b.getBoundingClientRect().width; });
  var flexWidest = Math.max.apply(null, flexWidths);
  var flexAll = flexWidths.reduce(function (a, w) { return a + w; }, 0);
  pillProbe.style.width = Math.ceil(flexWidest + 8) + "px";
  var flexW = flexRow.getBoundingClientRect().width;
  ok("...and a Runs chip row to check, in a box that fits one pill and not all three",
     flexPills.length === 3 && flexW >= flexWidest && flexW < flexAll,
     "widest " + Math.round(flexWidest) + "px, all three " + Math.round(flexAll)
       + "px, box " + Math.round(flexW) + "px");
  var flexYs = {};
  flexPills.forEach(function (b) { flexYs[Math.round(b.getBoundingClientRect().top)] = 1; });
  var flexRight = flexRow.getBoundingClientRect().right;
  var flexOver = flexPills.filter(function (b) {
    return b.getBoundingClientRect().right > flexRight + 1;
  });
  ok("🔴 ...and it wraps them onto fresh lines rather than running off its edge",
     Object.keys(flexYs).length > 1 && flexOver.length === 0,
     Object.keys(flexYs).length + " lines, " + flexOver.length + " pills past the right edge");
  pillProbe.remove();

  return out;
})()`;

// 🔴 The STOWAGE view, which exists to answer one question: which mission do I lift first, and how
// do I recognise it at the freight elevator.
//
// The elevator UI does NOT name missions — it lists cargo. So "load the Covalex one first" is an
// instruction the player cannot follow, and the only usable handle is the BOX SIGNATURE: commodity
// plus the exact split. Every assertion below is about that, about the two orderings that follow
// from it (missions deepest-first, destinations deepest-first inside a mission), and about the one
// case where the whole view must disappear — an open hauler, whose boxes the station's arm places.
//
// 🔴 Suite: A COMMODITY IN THE ROUTE, BEFORE AND AFTER THE PURCHASE (2026-08-23).
//
// The merged Route sequences commodity buys alongside contracts, and a buy enters it with NO
// tonnage — Sub decides how much at the kiosk and the log tells us afterwards. Everything here is
// about the gap between those two moments, because that is where the widget can lie:
//
//   `num()` is `Number(n || 0).toLocaleString()`, so a null tonnage renders as "0". "0 SCU of
//   Titanium" is not a missing figure, it is a WRONG one — it reads as the app having decided the
//   run was not worth filling. Three places had to learn the difference: the action chip, the
//   step's own tonnage line, and the hold/peak readings, which become FLOORS for the whole trip.
//
// ⚠️ FIXTURE, deliberately, and driven by assigning the page's `plan` binding the way the sibling
// hauling suites do. This is a RENDERING claim: it must not pass or fail on whether the sidecar
// happens to hold a picked run, and it must not write one into the player's own state to find out.
const BUYROUTE = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);

  // One contract leg with a real tonnage, and one commodity buy with none. Both in one trip, so
  // the two renderings sit side by side and cannot be confused for a whole-page state.
  const brStop = (name, kind, group, commodity, scu, hold, extra) => ({
    id: name + ":" + kind, locationId: name, name: name, kind: kind,
    minutes: 2, handlingMinutes: 1, loadAfterScu: hold, sameSpot: false,
    actions: [{ missionId: "m1", title: "A contract", commodity: commodity, scu: scu, group: group, kind: kind }]
      .concat(extra || []),
  });
  // The aboard argument is contract cargo with a REAL tonnage riding along, which is what makes the
  // trip's floor non-zero. Both branches of the floor rendering need a fixture, or one is never
  // exercised at all.
  const brPlan = (bought, aboard) => ({
    updatedAt: Date.now(),
    ship: { className: "CRUS_Starlifter_C2", displayName: "Crusader C2", totalScu: 696, grids: [], source: "manual" },
    contracts: [], buys: [{
      id: "b1", group: "buyleg:b1", commodity: "Titanium", resourceGuid: "g1",
      from: { terminal: "TDD Area 18", body: "ArcCorp", system: "Stanton", locationId: "TDD Area 18" },
      to: { terminal: "Port Tressler", body: "microTech", system: "Stanton", locationId: "Port Tressler" },
      buyPrice: 100, sellPrice: 140, scu: bought ? 48 : null,
      boughtAt: bought ? "2026-08-23T13:07:44.000Z" : null, shopName: bought ? "TDD_SCShop-001" : null,
      routed: true, reason: null,
    }],
    untracked: [], trackedMissionId: null,
    trips: [{
      stops: [
        brStop("TDD Area 18", "pickup", "buyleg:b1", "Titanium", bought ? 48 : null, (bought ? 48 : 0) + (aboard || 0),
               aboard ? [{ missionId: "m9", title: "Contract cargo", commodity: "Waste", scu: aboard, group: "g9", kind: "pickup" }] : null),
        brStop("Port Tressler", "dropoff", "buyleg:b1", "Titanium", bought ? 48 : null, aboard || 0),
      ],
      landings: 2, totalMinutes: 8, travelMinutes: 4, handlingMinutes: 4,
      peakScu: (bought ? 48 : 0) + (aboard || 0), unknownScu: !bought, method: "exact",
    }],
    stranded: [], locationNames: { "TDD Area 18": "TDD Area 18", "Port Tressler": "Port Tressler" },
    unnamedPlaces: [], completedPickups: [],
    startResolved: { asked: null, resolved: null, detected: null, detectedToken: null, detectedAt: null },
    unrouted: [], pack: null, aboardScu: 0, onPadScu: 0,
    rates: { actual: null, projected: null, payoutModelled: false },
    autoLoad: { hull: false, eligible: 0, live: 0 },
    totals: { scu: bought ? 48 : 0, capacityScu: 696, liveContracts: 0, unknownContracts: 0, recentPayout: 0, totalMinutes: 8 },
    notes: [],
  });

  /* Driven the way a player drives it — the view lives in a let inside the page's own closure, so
     assigning it from here would only make a global the page never reads. Click, then wait for the
     load() that click fires to come back BEFORE the fixture is assigned, or the sidecar's real
     (empty) board lands on top of it. */
  document.getElementById("tabRoute").click();
  await sleep(900);

  /* ⚠️ A BARE ASSIGNMENT TO plan, NEVER ONE QUALIFIED WITH window. The page declares plan with let
     at script top level, so the binding lives in the global LEXICAL environment and an own-property
     on the window object is shadowed by it — the page goes on reading its own value while the suite
     believes it swapped it. The first cut of this suite did exactly that and measured the sidecar's
     real board, which happened to hold a bought commodity, so three assertions passed for entirely
     the wrong reason and three failed for it. */
  const brShow = (bought, aboard) => {
    plan = brPlan(bought, aboard);
    render();
    return document.getElementById("body");
  };
  const brText = (el) => (el && el.textContent ? el.textContent : "");

  // ── before the purchase ─────────────────────────────────────────────────
  const openBody = brShow(false);
  // POSITIVE FIRST. Every "does not say 0 SCU" assertion below is free on a page that drew
  // nothing at all, which is exactly what a broken fixture produces.
  const openSteps = [].slice.call(openBody.querySelectorAll(".stop"));
  ok("the commodity run really renders as route steps", openSteps.length === 2,
     openSteps.length + " step(s)");
  ok("...naming the terminals it was picked between",
     brText(openBody).indexOf("TDD Area 18") > -1 && brText(openBody).indexOf("Port Tressler") > -1,
     brText(openBody).slice(0, 90));
  // 🔴 THE RULE. A tonnage nobody has stated must not render as a number, and zero is a number.
  ok("🔴 an unbought commodity never renders as a tonnage",
     brText(openBody).indexOf("0 SCU") === -1,
     brText(openBody).indexOf("0 SCU") > -1 ? brText(openBody).slice(Math.max(0, brText(openBody).indexOf("0 SCU") - 40), brText(openBody).indexOf("0 SCU") + 10) : "no 0 SCU anywhere");
  ok("...it says the amount is the player's to decide",
     brText(openBody).toLowerCase().indexOf("up to you") > -1
     || brText(openBody).toLowerCase().indexOf("you decide") > -1,
     brText(openBody).slice(0, 160));
  // 🔴 AND THE HOLD READINGS BECOME FLOORS. A run that will really carry 48 must not print a
  // confident "hold 0" — the same class of mistake as a rep bar counting down to a rank already held.
  // 🔴 A ZERO FLOOR IS NOT A FIGURE. With the whole load still to be bought the honest reading is
  // words: a "greater-or-equal zero" is arithmetically true, says nothing at all (every hold is at
  // least empty) and reads as the app having decided the run is not worth loading. The first cut of
  // this suite asserted the marker alone and so accepted exactly that.
  const openHold = openBody.querySelector(".hold");
  ok("🔴 a hold that is entirely still to be bought says so in words, not as a zero",
     brText(openHold).indexOf("0") === -1 && brText(openHold).length > 5,
     brText(openHold) || "(no .hold element)");
  const openHead = openBody.querySelector(".sec");
  ok("...and so does the trip's peak",
     brText(openHead).indexOf("peak 0") === -1 && brText(openHead).indexOf("peak ≥ 0") === -1,
     brText(openHead));

  // The OTHER branch, and without it the floor-with-a-number rendering is never exercised at all:
  // contract cargo aboard makes the floor real, and a real floor KEEPS its number, because a run
  // that will hold at least 174 SCU is worth saying.
  const mixBody = brShow(false, 174);
  ok("🔴 a floor with contract cargo under it keeps its number, marked as a floor",
     brText(mixBody.querySelector(".hold")).indexOf("≥") > -1
     && brText(mixBody.querySelector(".hold")).indexOf("174") > -1,
     brText(mixBody.querySelector(".hold")) || "(no .hold element)");
  ok("...and so does the peak", brText(mixBody.querySelector(".sec")).indexOf("peak ≥ 174") > -1,
     brText(mixBody.querySelector(".sec")));

  // ── after the purchase ──────────────────────────────────────────────────
  // The other half, and it is what tells the rules above apart from a widget that simply never
  // prints a tonnage. Same fixture, one field different.
  const doneBody = brShow(true);
  ok("🔴 a bought commodity renders the tonnage the log stated",
     brText(doneBody).indexOf("48 SCU") > -1, brText(doneBody).slice(0, 160));
  ok("...and the floor markers are gone, because nothing is unknown any more",
     brText(doneBody.querySelector(".hold")).indexOf("≥") === -1
     && brText(doneBody.querySelector(".sec")).indexOf("≥") === -1,
     brText(doneBody.querySelector(".sec")) + " | " + brText(doneBody.querySelector(".hold")));
  ok("...and it does not still claim the amount is up to you",
     brText(doneBody).toLowerCase().indexOf("up to you") === -1, brText(doneBody).slice(0, 160));

  return out;
})()`;

//
// 🔴 Suite: ONE FLAT TAB ROW, AND THE CREDIT FOLLOWS THE DATA (2026-08-23).
//
// The widget had two MODES with a bottom switch, each owning its own tabs, because there were two
// Route surfaces - contracts in Hauling, commodity runs in Trading. Merging Route into one
// cargo-agnostic tab removed the reason for the split, so the modes went and the five tabs became
// one row. Two things then have to be pinned, and they fail in completely different ways:
//
//  1. THE ROW ITSELF. Sub chose "Commodities" over "Planner" knowing it wraps to two lines at the
//     320px minimum (measured: the row is 296px, five tabs need 328.8px). So the assertion is NOT
//     "it fits" - it is that wrapping is what happens and the PAGE still does not scroll sideways.
//     A row that overflowed instead of wrapping would leave a tab unreachable at minW.
//  2. THE UEX CREDIT. It used to live in the mode bar and show in Trading mode. The bar is gone
//     and the credit could not go with it: UEX's data is on the Commodities tab, and an
//     attribution has to be present where the data is. Both halves are asserted - present there,
//     absent everywhere else - because "not shown on Route" is satisfied for free by a credit that
//     never shows at all, which is the exact regression that would strip the attribution.
//
// 🔑 VISIBILITY IS READ FROM COMPUTED display, NEVER from `el.hidden`. `.creditbar` sets
// display:flex, and a bare `hidden` attribute loses to any class rule setting display - so an
// assertion starting at `.hidden` would stay green with the `[hidden]` guard deleted and the
// credit painted on every tab. That guard is load-bearing and the control proves it.
const TABROW = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(600);

  const rowPanel = document.getElementById("panel");
  const rowTabs = rowPanel ? rowPanel.querySelector(".tabs") : null;
  const rowBtns = () => rowTabs ? [].slice.call(rowTabs.querySelectorAll(".hbtn")) : [];
  const rowLabels = () => rowBtns().map((b) => b.textContent.trim());

  // POSITIVE FIRST. Every must-not-exist below is free on an empty row, and an empty row is
  // exactly what a bad merge produces.
  ok("the head carries a tab row with five tabs in it", rowBtns().length === 5,
     rowBtns().length + ": " + rowLabels().join(" | "));
  ok("...and they are the merged five, in the order Sub picked",
     rowLabels().join("|") === "Contracts|Commodities|Route|Stow|Ledger",
     rowLabels().join("|"));
  ok("...every one of them reachable, with nothing hidden behind a mode",
     rowBtns().length > 0 && rowBtns().every((b) => !b.hidden && getComputedStyle(b).display !== "none"),
     rowBtns().filter((b) => b.hidden).length + " hidden");
  // Paired with the positive above: the switch itself is really gone, not merely unstyled.
  ok("...and the Hauling / Trading mode switch is gone",
     !document.getElementById("modeHaul") && !document.getElementById("modeTrade"),
     document.getElementById("modeHaul") ? "modeHaul still present" : "absent");
  // The retired Market tab. Its two sidecar routes still answer; only the tab went.
  ok("...as is the Market tab it replaced", !document.getElementById("tabLookup"),
     document.getElementById("tabLookup") ? "tabLookup still present" : "absent");

  // ── the row at both ends of the width range ──────────────────────────────
  // 🔑 Measured at the WIDGET's own limits: canvas.js gives hauling w 440, minW 320. A tab row
  // that only behaves at the default has not been checked at the end Sub was describing.
  const rowAt = async (w) => {
    document.body.classList.add("embedded");
    document.body.style.width = w + "px";
    await sleep(120);
    const tops = [];
    for (const b of rowBtns()) {
      const t = Math.round(b.getBoundingClientRect().top);
      if (tops.indexOf(t) < 0) tops.push(t);
    }
    const right = rowTabs.getBoundingClientRect().right;
    let past = 0;
    for (const b of rowBtns()) if (b.getBoundingClientRect().right > right + 0.5) past++;
    return { lines: tops.length, past: past, scroll: document.body.scrollWidth,
             h: Math.round(rowTabs.getBoundingClientRect().height) };
  };

  const row320 = await rowAt(320);
  ok("at the 320px minimum the row WRAPS rather than overflowing",
     row320.lines === 2 && row320.past === 0,
     row320.lines + " line(s), " + row320.past + " tab(s) past the right edge, " + row320.h + "px tall");
  // 🔴 The invariant the wrap exists to protect. body.scrollWidth once read 333 at a 320px
  // viewport on this very widget, which nobody had reported and only measuring at minW found.
  ok("...and the page still does not scroll sideways there",
     row320.scroll <= 320, "body.scrollWidth " + row320.scroll);

  const row440 = await rowAt(440);
  ok("at the 440px default it is a single line", row440.lines === 1 && row440.past === 0,
     row440.lines + " line(s), " + row440.h + "px tall");
  ok("...so the wrap really is a narrow-width behaviour, not the normal one",
     row320.h > row440.h, row320.h + "px at 320 vs " + row440.h + "px at 440");
  document.body.style.width = "";
  await sleep(120);

  // ── the credit follows the data ──────────────────────────────────────────
  const rowBar = document.getElementById("creditbar");
  // 🔑 COMPUTED display, not the attribute. See the header note: the attribute alone cannot see
  // the deleted [hidden] guard, and that is the regression that paints the credit everywhere.
  const rowBarUp = () => !!rowBar && getComputedStyle(rowBar).display !== "none"
    && rowBar.getBoundingClientRect().height > 0;
  const rowGo = async (id) => { document.getElementById(id).click(); await sleep(700); };

  ok("the credit strip survived the mode bar it used to live in", !!rowBar,
     rowBar ? "present" : "(no #creditbar)");

  await rowGo("tabTrade");
  ok("🔴 UEX is credited on Commodities, where their data is on screen", rowBarUp(),
     rowBar ? "display=" + getComputedStyle(rowBar).display + " h=" + Math.round(rowBar.getBoundingClientRect().height) : "none");
  // EITHER the badge OR the words, because the markup swaps one for the other when the image
  // cannot load. Asserting the <img> alone goes red for the fallback that keeps the credit up.
  const rowMark = document.getElementById("uexmark");
  const rowWords = document.getElementById("uexname");
  const rowCredited = (rowMark && rowMark.getAttribute("alt") && rowMark.getAttribute("alt").toLowerCase().indexOf("uex") > -1)
    || (rowWords && rowWords.textContent.toLowerCase().indexOf("uex") > -1);
  ok("...by badge or by name, whichever the image could manage", !!rowCredited,
     rowMark ? "badge alt=" + rowMark.getAttribute("alt") : rowWords ? "words=" + rowWords.textContent : "(neither)");

  // The other half, and it is the half that makes it an attribution rather than a logo.
  const rowElsewhere = [];
  for (const id of ["tabAdvisor", "tabRoute", "tabLayout", "tabJournal"]) {
    await rowGo(id);
    if (rowBarUp()) rowElsewhere.push(document.getElementById(id).textContent.trim());
  }
  ok("...and nowhere else, because none of those tabs render a UEX quote",
     rowElsewhere.length === 0,
     rowElsewhere.length ? "credited on " + rowElsewhere.join(", ") : "hidden on all four");

  return out;
})()`;

// Same technique as HAULING above: the page's own `plan` binding is assigned directly, so these are
// rendering rules tested deterministically with no game and no sidecar state.
// 🔴 Suite: THE RUNS ROW SURVIVES 320px - the regression this row shape exists to prevent.
//
// What shipped before it: the money line was one white-space:nowrap flex row inside a column
// that shrinks, and #body is overflow-x:hidden. MEASURED against the live board at 320px (the
// widget minW, and about as narrow as Sub runs it): ALL 25 rows clipped, the line needing
// 254-273px of a 175-204px column. It kept buy and sell and threw away the margin and the
// quantity, and nothing on screen said so.
//
// 🔑 The assertion is about the MECHANISM, not one string: the strip may wrap, and nothing in a
// row may exceed the column it sits in. A check on particular text would pass the day someone
// re-added nowrap with slightly shorter numbers.
//
// ⚠️ FIXTURE, deliberately. The rows are served by patching fetch rather than taken from the
// live price table, because this is a LAYOUT claim and a layout claim must not pass or fail on
// whether the sidecar happens to hold a cached UEX table. The fixture is built to stress the
// line: the longest real terminal names and the widest real numbers on the board.
const RUNSNARROW = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);

  const mk = (commodity, fromT, toT, buy, sell, pct, scu, cap, profit, bound, xsys) => ({
    commodity: commodity,
    from: { terminalShort: fromT, system: xsys ? "Pyro" : "Stanton", price: buy },
    to: { terminalShort: toT, system: "Stanton", price: sell },
    marginPct: pct, moveScu: scu, scuBound: bound, capitalRequired: cap,
    profit: profit, marginPerScu: Math.round(profit / scu), minutes: 24,
    profitPerHour: profit * 2.5, crossSystem: !!xsys, ageDays: 13.6,
  });
  const FIX = {
    capacityScu: 696, ship: "C2 Hercules",
    routes: [
      mk("Degnous Root", "Canard View", "CBD Lorville", 44156, 53000, 20, 696, 30732576, 6155424, "unknown", true),
      mk("Bexalite", "HDMS-Hadley", "Sacrens Plot", 23940, 36000, 50, 507, 12137580, 6114420, "demand", true),
      mk("Elespo", "Chawlas Beach", "Ashland", 6000, 15000, 150, 332, 1992000, 2988000, "demand", false),
    ],
  };
  const origFetch = window.fetch;
  window.fetch = function (u, o) {
    if (String(u).indexOf("/api/trade/routes") >= 0) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(FIX) });
    }
    return origFetch.call(this, u, o);
  };

  // Driven the way a player drives it. Assigning the page's own view binding would only make a global
  // the page never reads - executeJavaScript runs in the page's GLOBAL scope, not its closure.
  // ⚠️ RE-POINTED 2026-08-23. This used to click #modeTrade first, because the tab was hidden
  // behind a Trading mode. The modes are merged away and that button no longer exists, so the
  // click threw on null and took the whole suite with it. One click now, and the tab is a peer of
  // Contracts and Route rather than something you have to switch modes to reach.
  var tradeTab = document.getElementById("tabTrade");
  ok("the Commodities tab is reachable without switching modes", !!tradeTab && !tradeTab.hidden,
     tradeTab ? "label=" + tradeTab.textContent : "(no #tabTrade)");
  if (!tradeTab) return out;
  tradeTab.click();
  await sleep(1200);

  const panel = document.getElementById("panel");
  const rows = () => [].slice.call(panel.querySelectorAll(".tdrow"));

  // 🔑 POSITIVE GUARD FIRST. Every check below is a must-not-overflow, and an empty board
  // satisfies all of them for free - the shape of free pass this repo has been bitten by more
  // than once. If this one fails, nothing after it means anything.
  ok("there are Runs rows to measure", rows().length > 0, rows().length + " rows");

  const overflowAt = async (w) => {
    panel.style.width = w + "px";
    await sleep(120);
    const bad = [];
    rows().forEach(function (r, i) {
      [].slice.call(r.querySelectorAll(".l1, .l2, .l3, .tdchips")).forEach(function (elm) {
        if (elm.scrollWidth > elm.clientWidth + 1) {
          bad.push("row" + (i + 1) + " ." + elm.className.split(" ")[0]
            + " need=" + Math.round(elm.scrollWidth) + " have=" + Math.round(elm.clientWidth));
        }
      });
    });
    return bad;
  };

  const at320 = await overflowAt(320);
  ok("🔴 at 320px nothing in a run row runs off its column",
     at320.length === 0, at320.length ? at320.join(" | ") : "0 of " + rows().length + " rows clip");
  const at440 = await overflowAt(440);
  ok("...and nothing does at 440 either",
     at440.length === 0, at440.length ? at440.join(" | ") : "0 of " + rows().length + " rows clip");

  // The MECHANISM that makes the line above true, asserted separately so a regression names
  // itself instead of arriving as a pile of pixel numbers.
  panel.style.width = "320px";
  await sleep(120);
  const strip = panel.querySelector(".tdrow .l3");
  const wrapMode = strip ? getComputedStyle(strip).flexWrap : "(no strip)";
  ok("🔑 the metrics strip is allowed to WRAP, which is what stops it clipping",
     wrapMode === "wrap", wrapMode);
  const stripH = strip ? Math.round(strip.getBoundingClientRect().height) : 0;
  ok("...and at 320 it really does take a second line rather than losing a figure",
     stripH > 20, stripH + "px tall");

  // The profit shares line one with the name, so it reserves no width of its own. This is the
  // other half of the fix - it is what freed the 84px the old right-hand column held open.
  const r0 = rows()[0];
  const l1 = r0 ? r0.querySelector(".l1") : null;
  ok("the profit sits on line one beside the name, not in a column of its own",
     !!(l1 && l1.querySelector(".t") && l1.querySelector(".p")),
     l1 ? l1.className + " children: " + l1.children.length : "(no .l1)");
  ok("...and there is no fixed-width right-hand column left to hold dead space open",
     !!r0 && r0.querySelectorAll(".tdcap").length === 0,
     r0 ? r0.querySelectorAll(".tdcap").length + " .tdcap elements" : "(no row)");

  // 🔴 Sub asked for this once already: a big number with no noun beside it is one nobody can
  // act on. It was .tdcaplbl under the figure; it must survive the move onto line one.
  const pk = l1 ? l1.querySelector(".pk") : null;
  ok("🔴 the big number still says what it IS",
     !!(pk && pk.textContent.trim().length > 0), pk ? JSON.stringify(pk.textContent) : "(no .pk)");

  // 🔑 A FORECAST IS NOT DRESSED AS A RECORD. The Runs board is crowd-reported prices, so its
  // profit is cyan; only the Ledger, whose figures came out of the log, earns up/down colour.
  const p0 = l1 ? l1.querySelector(".p") : null;
  const forecastPlain = !!p0 && !p0.classList.contains("up") && !p0.classList.contains("down");
  ok("🔑 a forecast profit is not coloured like a realised one",
     forecastPlain, p0 ? JSON.stringify(p0.className) : "(no .p)");

  // ── the head Sub asked for: name left, badge hard right, tabs on their own row ──
  const head = panel.querySelector(".head");
  const badge = panel.querySelector(".expbadge");
  const tabs = panel.querySelector(".tabs");
  const title = panel.querySelector(".h-title");
  for (const w of [320, 440, 900]) {
    panel.style.width = w + "px";
    await sleep(120);
    const pr = panel.getBoundingClientRect();
    const br = badge.getBoundingClientRect();
    const tr = tabs.getBoundingClientRect();
    const ttr = title.getBoundingClientRect();
    // Hard right: the only thing between the badge and the panel edge is the head padding.
    ok("at " + w + "px the badge is pinned to the right edge",
       Math.round(pr.right - br.right) <= 14, Math.round(pr.right - br.right) + "px inset");
    ok("...with the tabs on a row of their own below it",
       tr.top > br.bottom - 4, "tabs top " + Math.round(tr.top - pr.top)
         + " vs badge bottom " + Math.round(br.bottom - pr.top));
    // The gap flexing is the point Sub made - it must GROW with the widget, not stay put.
    ok("...and the gap between name and badge is what absorbed the width",
       br.left - ttr.right > 20, Math.round(br.left - ttr.right) + "px gap");
  }
  panel.style.width = "";
  window.fetch = origFetch;
  return out;
})()`;
const STOW = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);

  const leg = (group, over) => Object.assign({
    key: "k", index: 0, group, commodity: null, destination: null, unit: "scu",
    scu: 16, min: 16, max: 16, source: "log", exact: true, maxContainerScu: 8, capSource: "dataset",
    boxes: [{ scu: 8, count: 2 }], boxLabel: "2x8", boxCount: 2, boxSource: "partition",
    pickupState: "pending", dropoffState: "pending", delivered: null,
    fromLocation: "@1,1,1", toLocation: "@2,2,2",
  }, over || {});
  const box = (group, x, y, z, over) => Object.assign({
    grid: "hardpoint_cargo_large", item: group + ":" + x + "," + y + "," + z, group,
    scu: 8, x, y, z, dx: 2, dy: 2, dz: 2,
  }, over || {});

  // Two missions. FOOD has two drop-offs and is packed FIRST by the packer (so it comes off first,
  // which means it is loaded LAST); ORE is packed last, so it is loaded first and sits deepest.
  const grids = [{ name: "hardpoint_cargo_large", w: 8, l: 15, h: 4, capacityScu: 480, usedScu: 96 },
                 { name: "hardpoint_cargo_small", w: 6, l: 9, h: 4, capacityScu: 216, usedScu: 0 }];
  const basePlan = () => ({
    updatedAt: Date.now(),
    ship: { className: "CRUS_Starlifter_C2", displayName: "Crusader C2 Hercules Starlifter",
            totalScu: 696, source: "log", grids: JSON.parse(JSON.stringify(grids)) },
    contracts: [
      { missionId: "m-food", title: "Food Haul", contractKey: "K1", generator: "G", giver: "Covalex",
        missionType: "Hauling - Planetary", tracked: true, ended: false, completion: null, payout: null,
        scu: 81, minScu: 81, maxScu: 81, source: "log", exact: true, plannable: true,
        legs: [
          leg("g-food-a", { commodity: "Processed Food", destination: "Port Tressler", scu: 65,
            boxes: [{ scu: 8, count: 8 }, { scu: 1, count: 1 }], boxCount: 9 }),
          leg("g-food-b", { commodity: "Processed Food", destination: "Baijini Point", scu: 16,
            boxes: [{ scu: 8, count: 2 }], boxCount: 2 }),
        ] },
      { missionId: "m-ore", title: "Ore Haul", contractKey: "K2", generator: "G", giver: "Covalex",
        missionType: "Hauling - Planetary", tracked: true, ended: false, completion: null, payout: null,
        scu: 16, minScu: 16, maxScu: 16, source: "log", exact: true, plannable: true,
        legs: [leg("g-ore", { commodity: "Titanium", destination: "Everus Harbour" })] },
    ],
    untracked: [], trips: [], stranded: [], locationNames: {}, unrouted: [],
    // Packer output is in UNLOAD order: g-food-a comes off first, so it sits nearest the ramp.
    pack: { fits: true, loadedScu: 96, capacityScu: 696, unplaced: [], byGrid: [], placements: [
      box("g-food-a", 0, 0, 0), box("g-food-a", 2, 0, 0),
      box("g-food-b", 4, 0, 0),
      box("g-ore", 0, 2, 0), box("g-ore", 2, 2, 0),
    ] },
    aboardScu: 0,
    totals: { scu: 97, capacityScu: 696, liveContracts: 2, unknownContracts: 0, recentPayout: 0, totalMinutes: 0 },
    notes: [],
  });

  plan = basePlan();
  render();
  document.getElementById("tabLayout").click();
  await sleep(100);

  // ── 🔴 the load order, and the signature that makes it followable ─────────
  const steps = [...document.querySelectorAll(".step")];
  ok("one lift per mission, not one per drop-off", steps.length === 2, steps.length);
  ok("🔴 the mission delivered LAST is loaded FIRST",
     /Titanium/.test(steps[0].textContent), steps[0].textContent.replace(/\\s+/g, " ").slice(0, 60));
  ok("...and it is numbered 1", steps[0].querySelector(".ord").textContent === "1",
     steps[0].querySelector(".ord").textContent);
  ok("...and said to be the deepest", /deepest in the hold/.test(steps[0].textContent));

  const sig = steps[1].querySelector(".sig").textContent.replace(/\\s+/g, " ").trim();
  ok("🔴 a lift is identified by its BOX SIGNATURE, because the elevator does not name missions",
     sig === "Processed Food 10× 8 SCU + 1× 1 SCU", sig);
  ok("...built from the CONTRACT's boxes, not just the ones that fit in the drawing",
     /10× 8 SCU/.test(sig), sig);
  ok("every lift carries a signature", steps.every((s) => s.querySelector(".sig")));

  // ── 🔴 within a mission, which destination goes in first ─────────────────
  const drops = [...steps[1].querySelectorAll(".drop")];
  ok("a multi-stop lift lists its destinations", drops.length === 2, drops.length);
  ok("🔴 the destination delivered LAST is loaded first",
     /Baijini Point/.test(drops[0].textContent), drops[0].textContent);
  ok("...and is labelled as such", /first in/.test(drops[0].textContent));
  ok("a single-stop lift does not spell out its one destination",
     steps[0].querySelectorAll(".drop").length === 0);

  // ── the drawing ──────────────────────────────────────────────────────────
  ok("only the grid that got cargo is drawn", document.querySelectorAll("svg.iso").length === 1,
     document.querySelectorAll("svg.iso").length);
  ok("the empty grid is counted rather than silently dropped",
     /1 more grid on this hull got nothing/.test(document.getElementById("body").textContent));
  ok("every placement is a box", document.querySelectorAll(".iso-box").length === 5,
     document.querySelectorAll(".iso-box").length);
  // Ghosting is per MISSION: with lift 1 (Titanium) focused, the two ore boxes stay lit.
  ok("the focused lift is the one lit up",
     document.querySelectorAll(".iso-box:not(.ghost)").length === 2,
     document.querySelectorAll(".iso-box:not(.ghost)").length);
  ok("...and the rest of the load is still drawn, not hidden",
     document.querySelectorAll(".iso-box.ghost").length === 3,
     document.querySelectorAll(".iso-box.ghost").length);
  steps[1].click();
  await sleep(80);
  ok("clicking a lift moves the focus to it",
     document.querySelectorAll(".iso-box:not(.ghost)").length === 3,
     document.querySelectorAll(".iso-box:not(.ghost)").length);
  const body = document.getElementById("body");
  ok("the drawing never scrolls the panel sideways", body.scrollWidth <= body.clientWidth,
     body.scrollWidth + " vs " + body.clientWidth);

  // ── ⛔ an open hauler gets NO stowage plan at all ─────────────────────────
  // Hull A/B/C, Ironclad, Railen, RAFT, Nomad, Syulen, Golem: the station's arm places every box,
  // so a stowage diagram describes work that does not exist. autoLoadClasses comes from /api/ships,
  // which is the live sidecar — so this also proves that plumbing is wired end to end.
  ok("the sidecar told the widget which hulls auto-load", autoLoadClasses.size > 0, autoLoadClasses.size);
  plan = basePlan();
  plan.ship.className = "MISC_Hull_C";
  plan.ship.displayName = "MISC Hull C";
  render();
  await sleep(80);
  ok("⛔ an auto-loading hull is drawn NO diagram", document.querySelectorAll("svg.iso").length === 0,
     document.querySelectorAll("svg.iso").length);
  ok("...and is given NO load order either", document.querySelectorAll(".step").length === 0,
     document.querySelectorAll(".step").length);
  ok("...it is told the loader handles it", /loads itself/.test(document.getElementById("body").textContent),
     document.getElementById("body").textContent.slice(0, 90));

  return out;
})()`;


/* ── the trade journal: cargo that can never leave ──────────────────────────────────────────────
   Two complaints from Sub, one section. He flew a loaded ship into a wall to see what would happen
   and the loot has been listed ever since; and a lot he had sold down from reads "on the elevator"
   under a heading that says "Still aboard", which is the opposite claim. *"I don't even know what
   that's supposed to mean."*

   🔑 THE FIXTURE IS THE RIGHT TOOL HERE AND THE WRONG ONE ONE LINE LATER. Rendering rules are what
   this suite is for, so a hand-written journal is correct — it makes every row shape reachable on
   a machine where nobody has traded. But the round trip (does the button really remove the lot)
   is NOT assertable that way: a fixture would be asserting my own object. That half is covered by
   `npm run test:trade`, which drives the real `TradeJournal` including a restart. What IS checked
   here is the wiring in between: the button issues the right request, with the right lot id. */
const TRADEHOLD = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);

  /* Clicked, not assigned — the view lives in a let inside the page's own closure, so setting it
     from here would only make a global the page never reads. Same trap the route suite documents. */
  const tab = document.getElementById("tabJournal");
  ok("the journal tab exists to be driven", !!tab, tab ? "found" : "(no #tabJournal)");
  if (!tab) return out;
  tab.click();
  await sleep(500);   // let the load() that click fires come back before overwriting it

  /* Sub's own board, as the sidecar really reports it: two lots bought to the elevator, two loaded
     straight in, and one already written off. The elevator lot is the one he was reading. */
  const lot = (id, name, scu, price, auto, ago) => ({
    id: id, resourceGuid: "g-" + id, commodity: name, scu: scu, pricePerScu: price,
    shopName: "TDD_SCShop-001", at: new Date(Date.now() - ago).toISOString(),
    atMs: Date.now() - ago, autoLoaded: auto,
  });
  const DAY = 86400000;
  tradeJournal = {
    runs: [], unmatched: [],
    open: [lot("lot2", "Processed Food", 1, 1201.95, false, 3 * DAY),
           lot("lot3", "Carbon", 8, 268.83, true, 3 * DAY)],
    writtenOff: [Object.assign(lot("lot1", "Tungsten", 4, 8265, false, 3 * DAY),
                               { forgottenAt: new Date().toISOString(), cost: 33060 })],
    today: { runs: 0, scu: 0, cost: 0, revenue: 0, profit: 0, minutes: 0, profitPerHour: null,
             unpricedRevenue: 0, unpricedSales: 0 },
    allTime: { runs: 0, scu: 0, cost: 0, revenue: 0, profit: 0, minutes: 0, profitPerHour: null,
               unpricedRevenue: 0, unpricedSales: 0 },
  };
  render();
  await sleep(120);

  const body = document.getElementById("body");
  const text = body ? body.textContent : "(no #body)";

  /* Defensive, and it matters in the DETAIL as much as in the condition: the detail argument is
     evaluated eagerly, so reaching through a missing element there kills the whole suite and the
     run reports a small pass. */
  const rows = Array.prototype.slice.call(document.querySelectorAll(".trow"));
  const rowText = (r) => (r && r.textContent) ? r.textContent : "(empty row)";
  const secs = Array.prototype.slice.call(document.querySelectorAll(".sec"));
  const secText = (s) => (s && s.textContent) ? s.textContent : "(empty section)";

  // ── 🔑 POSITIVE FIRST. Everything below is "the page does not say X", and a page that rendered
  // nothing satisfies all of it for free.
  ok("the held lots render at all", rows.length >= 2, rows.length + " rows");
  const held = rows.filter((r) => rowText(r).indexOf("Processed Food") >= 0
                                || rowText(r).indexOf("Carbon") >= 0);
  ok("...both of them", held.length === 2, held.length + " of 2");

  // ── the heading no longer contradicts the rows underneath it
  const heading = secs.map(secText).join(" | ");
  ok("the section says what the journal actually knows", heading.indexOf("Bought, not sold") >= 0, heading);
  ok('...and drops "Still aboard", which the rows below it contradicted',
     heading.indexOf("Still aboard") < 0, heading);

  // ── the location chip is a fact about the PURCHASE, so it is past tense
  const elevatorRow = held.filter((r) => rowText(r).indexOf("Processed Food") >= 0)[0];
  const elevatorText = rowText(elevatorRow);
  ok("an elevator lot still says where the game put it", elevatorText.indexOf("elevator") >= 0, elevatorText);
  ok('...in the PAST tense — "went to the elevator", not "on the elevator"',
     elevatorText.indexOf("went to the elevator") >= 0 && elevatorText.indexOf("on the elevator") < 0,
     elevatorText);
  ok("...and its age is stated, because the claim is three days old",
     elevatorText.indexOf("d ago") >= 0 || elevatorText.indexOf("h ago") >= 0, elevatorText);
  const chips = elevatorRow ? elevatorRow.querySelectorAll(".badge") : [];
  const chipTitle = chips.length ? (chips[chips.length - 1].title || "") : "(no chip)";
  ok("...with the explanation on the chip rather than in the row",
     chipTitle.indexOf("nothing in the log says where it is now") >= 0, chipTitle);

  // ── 🔴 THE CONTROL SUB ASKED FOR
  const xOf = (r) => {
    const bs = r ? Array.prototype.slice.call(r.querySelectorAll("button")) : [];
    return bs.filter((b) => b.textContent === "\\u2715")[0] || null;
  };
  ok("every held lot carries a remove control", held.length > 0 && held.every((r) => !!xOf(r)),
     held.map((r) => (xOf(r) ? "x" : "-")).join(""));
  ok("...that says what it does without being clicked",
     (xOf(elevatorRow) ? xOf(elevatorRow).title : "").indexOf("Cargo gone") >= 0,
     xOf(elevatorRow) ? xOf(elevatorRow).title : "(no button)");

  /* Stub the page's fetch so the click is observable without needing a real held lot on whatever
     machine this runs on. Restored below — a suite that leaves fetch stubbed poisons every suite
     after it. */
  const realFetch = window.fetch;
  let asked = "(nothing was requested)";
  window.fetch = function (u, o) {
    const s = String(u);
    if (s.indexOf("/forget") >= 0) { asked = ((o && o.method) || "GET") + " " + s; }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(tradeJournal) });
  };
  const btn = xOf(elevatorRow);
  if (btn) btn.click();
  await sleep(200);
  window.fetch = realFetch;

  ok("clicking it asks the sidecar to forget that lot", asked.indexOf("/api/trade/journal/forget") >= 0, asked);
  ok("...as a POST, so the loopback gate applies to it", asked.indexOf("POST ") === 0, asked);
  ok("...naming the row that was clicked, not the first one",
     asked.indexOf("lot=lot2") >= 0, asked);

  // ── the money is still on the record, and still out of the profit
  ok("a written-off lot is reported rather than silently gone",
     text.indexOf("written off") >= 0, text.slice(-220));
  ok("...saying plainly that it is NOT in the profit above",
     text.indexOf("not counted in the profit") >= 0, text.slice(-220));

  return out;
})()`;

/* 🔴 A SALE THE GAME STATED NO VOLUME FOR MUST SHOW NOTHING WHERE THE TONNAGE WOULD GO.
   54% of real commodity SELLS carry an empty Cargo Box Data: hand-mined gems sold out of personal
   inventory, where SCU is the wrong unit rather than an unknown one. The Ledger keeps the money and
   the terminal, and says nothing about how much. Sub's ruling: "just display nothing in the widget
   itself."

   ⚠️ THE FAILURE THIS GUARDS IS A ZERO, NOT A CRASH. The page formats with num(), which is
   Number(n || 0), so an unguarded null renders "0 SCU" — a missing figure printed as zero is not
   missing, it is wrong, and it looks like a real reading.

   🔑 THE FIXTURE CARRIES BOTH SHAPES ON PURPOSE. A rule that stripped the tonnage from EVERY
   unmatched row would satisfy every "does not say SCU" assertion below, so a row that legitimately
   HAS a volume has to keep it in the same render. */
const TRADEUNIT = `(async () => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);

  const tab = document.getElementById("tabJournal");
  ok("the journal tab exists to be driven", !!tab, tab ? "found" : "(no #tabJournal)");
  if (!tab) return out;
  tab.click();
  await sleep(500);

  const zeroTotals = { runs: 0, scu: 0, cost: 0, revenue: 0, profit: 0, minutes: 0,
                       profitPerHour: null, unpricedRevenue: 536000, unpricedSales: 2 };
  tradeJournal = {
    runs: [], open: [], writtenOff: [],
    unmatched: [
      /* Verbatim shape of a real Hadanite sale at the New Babbage TDD: no cargo boxes, so no
         volume and no per-SCU price, and 416,000 aUEC that genuinely changed hands. */
      { commodity: "Hadanite", resourceGuid: "g-hadanite", scu: null, sellPricePerScu: null,
        revenue: 416000, sellShop: "SCShop_CommEx_TDD_NewBabbage",
        soldAt: new Date(Date.now() - 3600000).toISOString() },
      /* The other shape: a boxed sale whose volume the game DID state. */
      { commodity: "Processed Food", resourceGuid: "g-food", scu: 8, sellPricePerScu: 15000,
        revenue: 120000, sellShop: "SCShop_Admin_lt_base_g",
        soldAt: new Date(Date.now() - 7200000).toISOString() },
    ],
    today: zeroTotals, allTime: zeroTotals,
  };
  render();
  await sleep(120);

  const rows = Array.prototype.slice.call(document.querySelectorAll(".trow"));
  const rowText = (r) => (r && r.textContent) ? r.textContent : "(empty row)";

  /* 🔑 POSITIVE FIRST, AND NON-EMPTY. Every assertion after this is "the row does not say X", and
     a page that rendered no rows at all — the plausible wrong fix, dropping the sale — passes all
     of them for free. */
  ok("both unmatched sales render", rows.length === 2, rows.length + " rows");
  const gem = rows.filter((r) => rowText(r).indexOf("Hadanite") >= 0)[0] || null;
  const boxed = rows.filter((r) => rowText(r).indexOf("Processed Food") >= 0)[0] || null;
  ok("...the unpriced gem sale among them", !!gem, gem ? rowText(gem) : "(no Hadanite row)");
  ok("...and the boxed one", !!boxed, boxed ? rowText(boxed) : "(no Processed Food row)");

  const gemText = rowText(gem);
  /* 🔑 THE MONEY AND THE PLACE ARE STILL THERE. Recording the observation is half of the ruling. */
  ok("the gem sale keeps its revenue", gemText.indexOf("416,000") >= 0, gemText);
  ok("...and the terminal it was sold at", gemText.indexOf("New Babbage") >= 0
     || gemText.indexOf("NewBabbage") >= 0 || gemText.indexOf("CommEx") >= 0, gemText);

  /* 🔴 AND NOTHING WHERE THE TONNAGE WOULD GO. Not a zero, not a dash, not a placeholder. */
  const nameCell = gem ? gem.querySelector(".tnm") : null;
  const nameText = nameCell && nameCell.textContent ? nameCell.textContent : "(no .tnm)";
  ok("🔴 the gem sale claims no SCU at all", nameText.indexOf("SCU") < 0, nameText);
  ok("🔴 ...and does not print a zero in its place", nameText.indexOf("0") < 0, nameText);
  ok("...nor a dash or any other placeholder standing in for a number",
     nameText.indexOf("-") < 0 && nameText.indexOf("?") < 0, nameText);
  ok("...it is just the commodity", nameText === "Hadanite", nameText);

  /* 🔑 THE PAIRED NEGATIVE, in the same render: a stated volume still prints. Without this the
     assertions above are satisfied by a page that stopped showing tonnages entirely. */
  const boxedName = boxed ? boxed.querySelector(".tnm") : null;
  const boxedText = boxedName && boxedName.textContent ? boxedName.textContent : "(no .tnm)";
  ok("...while a sale that DOES state a volume still shows it",
     boxedText.indexOf("8 SCU") >= 0, boxedText);

  return out;
})()`;


app.whenReady().then(async () => {
  let fails = 0;
  const region0 = await readScanRegion();
  try {
    fails += await run("widget grouping", GROUPING, null);
    fails += await run("pair merges (brute force)", PAIRS, null);
    fails += await run("title-bar chrome", CHROME, null);
    fails += await run("controls visible + reachable", REACH, null);
    fails += await run("sweeps: themes / sizes / text / stacks", SWEEPS, null);
    fails += await run("dragging + reset", DRAG, null);
    fails += await run("page headers", HEADERS, null);
    fails += await run("layout restore", RESTORE, path.join(__dirname, "widget-dom-stub-preload.cjs"));
    fails += await run("chrome anchoring + latches", ANCHOR, path.join(__dirname, "widget-dom-stub-preload.cjs"));
    fails += await run("lifecycle: closed = idle", LIFECYCLE, null);
    fails += await run("typing grab: hiding releases it", TYPINGGRAB, path.join(__dirname, "widget-dom-stub-preload.cjs"));
    // ⚠️ Deliberately ahead of the hauling suites. A THROW inside a suite kills the whole run where
    // it stands, and `hauling: honest loads, whole route` currently throws on main (it reads
    // #trackWhy, which 0b3c06f replaced with a #trackInfo popover) — so anything registered after
    // it is not merely failing, it is never executed at all.
    fails += await run("logView: the filter box releases the canvas grab", LOGVIEWGRAB,
      path.join(__dirname, "widget-dom-stub-preload.cjs"));
    fails += await run("logView: raw lines, the caps, the filter, the freeze", LOGVIEW, null, null, "logview.html");
    fails += await run("event feed: the reward ladder says when it is a fallback", EVENTFEED, null, null, "battaglia.html");
    fails += await run("event rewards: a sighting and a rumour must not look the same", REWARDCARD, null, null, "battaglia.html");
    fails += await run("event ladder: Orison first, the guesses shown and labelled", EVENTLADDER, null, null, "battaglia.html");
    fails += await run("verse finder: a shop, a price, and how old that reading is", VERSEFINDER, null, null, "versefinder.html");
    fails += await run("verse finder: ships, commodities, and which kind of blank", VERSEDEALERS, null, null, "versefinder.html");
    fails += await run("verse finder: the eye names the terminal that placed you", VERSEEYE, null, null, "versefinder.html");
    fails += await run("verse finder: observations are PRICES, not receipts", VERSEPOOL, null, null, "versefinder.html");
    fails += await run("client errors reach the sidecar", CLIENTERR, null);
    fails += await run("per-widget angle", ANGLE, null);
    fails += await run("split fade: panel vs text", SPLITFADE, null);
    fails += await run("test-environment badge", ENVBADGE, null);
    fails += await run("nothing animates at rest", IDLEPAINT, null);
    fails += await run("mission info from community data", MISSIONINFO, null);
    fails += await run("unrecognized blueprint names", UNRECOGNIZED, null);
    fails += await run("cog auto-hide on game focus", COGHIDE,
      path.join(__dirname, "widget-dom-stub-preload.cjs"), "coghide=250");
    fails += await run("unlock notifier", UNLOCK, null, null, "unlockalert.html");
    // Stub preload, now REQUIRED: the clickability assertion reads the rects the page reports to
    // the shell, and with no shell there is nothing to report to. It used to run without one
    // because that assertion never measured anything (see the false pass in the suite body).
    fails += await run("scan read area", SCANBOX,
      path.join(__dirname, "widget-dom-stub-preload.cjs"));
    // Stub preload, and not optional: the whole region-reporting block is behind
    // `if (window.overlayApi)`, so without a shell the panel renders and reports NOTHING — the
    // clickability assertions would be measuring an empty list against an empty list.
    fails += await run("payout scan session panel", PAYOUTPANEL,
      path.join(__dirname, "widget-dom-stub-preload.cjs"));
    // Same stub, same reason: the box's clickability is the assertion that matters most and it is
    // measured off the rects the page reports, which only happen when a shell is there to report to.
    fails += await run("contract board calibration box", BOARDBOX,
      path.join(__dirname, "widget-dom-stub-preload.cjs"));
    // ?rates loads the idle-panel fixture AND leaves the live feed disconnected — a fixture a
    // real broadcast can paint over tests nothing.
    fails += await run("idle panel (nothing tracked)", IDLEPANEL, null, "rates");
    fails += await run("mission + faction drawers", MIDRAWERS, null, "missioninfo");
    fails += await run("widget settings close when idle", WCFGIDLE, null, "wcfgidle=250");
    // ?arrange: the calibration panel lives INSIDE the arrange scrim, so a suite that doesn't open
    // arrange mode measures a display:none control — every size assertion then passes on 0 == 0.
    // The stub preload is needed as well: the whole arrange-chrome block is behind
    // `if (window.overlayApi)`, so with no shell the control renders but nothing is wired to it.
    fails += await run("canvas calibration (mixed-DPI)", CALIBRATE,
      path.join(__dirname, "widget-dom-stub-preload.cjs"), "arrange");
    fails += await run("patch notes fit the monitor", PATCHNOTES, null);
    fails += await run("patch notes are grouped and labelled", PATCHGROUPS, null);
    fails += await run("setup nudge", SETUPNUDGE, null);
    fails += await run("background service down", SVCDOWN, null);
    fails += await run("chrome over the native view", VIEWMASK, null);
    fails += await run("mining call-outs by verdict", MININGSAY, null, null, "mining.html");
    fails += await run("chat links + slash menu", CHATLINKS, null, null, "chat.html");
    // ⚠️ Registered AHEAD of the two hauling suites for the reason stated further up: a throw used
    // to take every suite behind it with it, and `hauling: honest loads, whole route` is the one
    // that throws. Same page, so this costs nothing to place here.
    fails += await run("hauling: one flat tab row, and the credit follows the data", TABROW, null, null, "hauling.html");
    fails += await run("hauling: a commodity in the route, before and after the buy", BUYROUTE, null, null, "hauling.html");
    fails += await run("hauling: the Runs row survives 320px", RUNSNARROW, null, null, "hauling.html");
    fails += await run("hauling: the trade journal's held cargo", TRADEHOLD, null, null, "hauling.html");
    fails += await run("hauling: a sale with no stated volume shows no tonnage", TRADEUNIT, null, null, "hauling.html");
    fails += await run("hauling: honest loads, whole route", HAULING, null, null, "hauling.html");
    fails += await run("hauling: stowage order + signature", STOW, null, null, "hauling.html");
    fails += await run("completion card holds while you use it", REPORTHOLD, null);
  } catch (e) {
    // The message alone ("Cannot read properties of null") doesn't say WHICH suite or line, and
    // hunting that by bisection wastes a run each time.
    console.error(`\nharness error: ${e && e.message}`);
    if (e && e.stack) console.error(String(e.stack).split("\n").slice(0, 8).join("\n"));
    console.error(`is the sidecar running? \`npm run overlay\` should be listening on :${PORT}`);
    fails = 1;
  }
  // Hand the user's calibration back, and SAY whether it survived — a silent restore is how this
  // went unnoticed for a whole session.
  if (region0 !== undefined) {
    const drifted = JSON.stringify(await readScanRegion()) !== JSON.stringify(region0);
    if (drifted) {
      await writeScanRegion(region0);
      const now = await readScanRegion();
      const back = JSON.stringify(now) === JSON.stringify(region0);
      console.log(`\nscan read area: a suite moved it; ${back ? "restored" : "⚠ COULD NOT RESTORE"} ` +
                  JSON.stringify(region0));
      if (!back) { console.log(`  it is now ${JSON.stringify(now)} — re-drag it, or use Reset.`); fails++; }
    }
  }
  console.log(fails ? `\nFAILED (${fails})` : "\nall widget DOM tests passed");
  process.exitCode = fails ? 1 : 0;
  app.quit();
});
