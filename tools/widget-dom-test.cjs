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

  // 11 = the 9 canvas widgets + the Blueprint panel (a local, non-iframe widget) + Settings.
  // Bump this deliberately when a widget is added — it is the one assertion that notices a
  // registry entry going missing, which would otherwise just look like a widget quietly absent.
  ok("registry has 12 widgets (incl. the Blueprint panel and Settings)", typeof WIDGETS !== "undefined" && WIDGETS.length === 12, typeof WIDGETS !== "undefined" ? WIDGETS.length : "unreachable");
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
      if (!fits(act)) {
        const o = innerFit(act);
        clipped.push(a.key + "+" + b.key + " grouped -> " + act.key + " overflows by " + o.overflowX + "x" + o.overflowY);
      }
      // Ungroup. A widget INHERITING the stack's box is intended (you sized that stack on
      // purpose), so don't demand the original size back. What must never happen is what Sub hit:
      // a widget landing at a size nobody chose, or shrinking/growing a bit more on every cycle.
      while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
      await sleep(60); // mining re-measures on a timer
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
  const sizeBad = [];
  for (const w of WIDGETS) {
    for (const [lbl, ww, hh] of [["min", w.size.minW, w.size.minH], ["max", w.size.maxW, w.size.maxH]]) {
      if (ww == null) continue;
      w.s.w = Math.min(ww, 1600); w.s.h = Math.min(hh, 1200); // keep it inside the test viewport
      applyFrame(w); await sleep(20);
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
  ok("...so the shell is told to make the window interactive over it",
     typeof RSEL === "string" ? RSEL.includes("#scanBox") : "RSEL unreachable");

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
  const EXPECTED_404 = /(^|\/\/)(api\.frankerfacez\.com|7tv\.io|api\.betterttv\.net)\/|deliberate-404-for-test\.webp|\/api\/binding-image(\?|$)/;
  win.webContents.session.webRequest.onCompleted({ urls: ["*://*/*"] }, (d) => {
    if (d.statusCode < 400) return;
    if (d.statusCode === 404 && EXPECTED_404.test(d.url)) return;
    noise.push("HTTP " + d.statusCode + " " + d.url.replace(/^https?:\/\//, "").slice(0, 70));
  });
  try {
    const base = page ? `http://localhost:${PORT}/${page}` : URL;
    await win.loadURL(query ? base + (base.includes("?") ? "&" : "?") + query : base);
    const res = await win.webContents.executeJavaScript(script);
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

  // The switch is a per-USER privacy choice, so it sits with the rail that shows the effect —
  // not in the per-channel cog.
  view.shareActivity = false;
  renderMembers();
  ok("the share switch reads off by default",
     $("shareAct").getAttribute("aria-pressed") === "false", $("shareAct").getAttribute("aria-pressed"));
  // 🔑 The tooltip must say WHAT would be published. "Share my activity" invites a shrug; the
  // contract you are running is something a person can actually decide about.
  ok("...and says what turning it on would publish",
     /contract/i.test($("shareAct").title), $("shareAct").title);
  view.shareActivity = true;
  renderMembers();
  ok("...and lights up when it is on",
     $("shareAct").getAttribute("aria-pressed") === "true"
       && /Click to stop/i.test($("shareAct").title), $("shareAct").title);
  view.shareActivity = false;
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
    fails += await run("per-widget angle", ANGLE, null);
    fails += await run("split fade: panel vs text", SPLITFADE, null);
    fails += await run("nothing animates at rest", IDLEPAINT, null);
    fails += await run("cog auto-hide on game focus", COGHIDE,
      path.join(__dirname, "widget-dom-stub-preload.cjs"), "coghide=250");
    fails += await run("unlock notifier", UNLOCK, null, null, "unlockalert.html");
    fails += await run("scan read area", SCANBOX, null);
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
