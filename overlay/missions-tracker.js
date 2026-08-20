/**
 * MISSION & BP TRACKER — everything the tracker panel itself draws.
 *
 * The blueprint pool and its tiles, the mission info and faction drawers, the pill row
 * (`PILL_ORDER`), the community facts, mission search, the completion report card, the manual
 * picker, and the "verify from logs" control. This is the WIDGET. The canvas that hosts it — and
 * hosts every other widget — is canvas.js.
 *
 * The split is by REASON TO CHANGE: this file moves when the mission data or its presentation
 * moves; canvas.js moves when the widget system does.
 *
 * ⚠️ Several functions here are part of the widget suite's public surface — it calls
 * `missionInfoHtml`, `gameFactPills`, `communityPills`, `factChips` and friends directly. Nothing
 * in the source says so. Grep tools/widget-dom-test.cjs before changing what one of them RETURNS.
 *
 * Lifted verbatim out of missions.html (2026-08-19). Classic scripts on one page share a global
 * lexical environment, so nothing here is exported and not one call site moved; load order is
 * preserved exactly.
 */
  // Time label parts from an ISO stamp: absolute date+clock (the "date and timestamp")
  // plus a relative "2h ago" hint. The time-format setting picks which one to show.
  function fmtWhen(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    let rel;
    if (min < 1) rel = "just now";
    else if (min < 60) rel = min + "m ago";
    else if (min < 1440) rel = Math.floor(min / 60) + "h ago";
    else rel = Math.floor(min / 1440) + "d ago";
    return { date: date + " " + clock, rel };
  }

  // Idle per-hour rates: aUEC + rep, "last 60m" (actual) and extrapolated session "pace".
  // aUEC shows "—" when unknown (calculated-reward missions log no payout) — never a false 0.
  // (ratesHtml — a separate "Per hour · this grind" block with its own two-column table — was
  // folded into the session section on 2026-08-13 and removed with its last caller. The rates now
  // use the same stat treatment as the totals, one section, one shape.)

  // ── Closest to done ───────────────────────────────────────────────────────────
  // 🔴 NO ECONOMICS HERE. A first pass hung each pool's aUEC/hr, payout and run length off these
  // rows; Sub, 2026-08-15: the per-hour figure "just meant a tracker that basically tracks how
  // much money they've been making per hour with the missions that they've done, NOT with the
  // closest to done". That number belongs to the session block and lives there. This section
  // answers one question — how close am I — and every layout below answers it with the title, the
  // count, the bar and where to pick it up, exactly as it always did.
  //
  // The pool facts are still on the view model (payMin/payMax/durMin/rep/cooldownMin/…) and are
  // deliberately left there un-rendered: they are cheap, they are measured, and the moment
  // anything wants them they are one field access away rather than a round trip through the
  // dataset. Do not "tidy" them out of src/missions.ts.
  const poolLeft = (p) => ({ left: p.total - p.owned, pct: Math.round((p.owned / p.total) * 100) });

  // ── A pool's name, and the way out to its page ────────────────────────────────────────────
  // 🔑 THE HEADLINE IS THE POOL, NOT A CONTRACT. `poolName` is giver + type ("United Wayfarers
  // Club · Refueling"), which says what the collection IS where a contract title only ever named
  // one of the (up to 79) ways to farm it.
  const poolTitle = (p) => p.poolName || p.title;

  /** How many contracts feed this pool, and what they are called — the "there is more here than
   *  the one name you can see" affordance. Sub asked for an eye; the panel's settled idiom for
   *  "there is more to know" is the circled i (an eye glyph was tried on 2026-08-12 and "read as
   *  something else entirely"), so it is that. Self-hides for a single-contract pool. */
  function poolMoreInfo(p) {
    const titles = p.missionTitles || [];
    const missing = p.missing || [];
    const places = p.places || [];
    if (titles.length < 2 && !missing.length) return "";
    const shown = titles.slice(0, 6);
    const parts = [];
    if (missing.length) {
      parts.push("Still missing: " + missing.slice(0, 10).join(", ")
        + (missing.length > 10 ? ", +" + (missing.length - 10) + " more" : ""));
    }
    if (titles.length > 1) {
      parts.push(titles.length + " different contracts fill this pool, so you are never stuck"
        + " waiting for one to come back:\n• " + shown.join("\n• ")
        + (titles.length > shown.length ? "\n• …and " + (titles.length - shown.length) + " more" : "")
        + (p.variants > titles.length
            ? "\n\n" + p.variants + " variants of them are on the boards you can reach."
            : ""));
    } else if (titles.length === 1) {
      parts.push("One contract fills this pool: " + titles[0] + ".");
    }
    // 🔑 The places live in here as well as on the row. The row's copy is the first thing
    // truncation eats on a narrow widget, and a pickup point you cannot read is not a pickup point.
    if (places.length) parts.push("Pick it up at: " + places.join(", ") + ".");
    return info(parts.join("\n\n"));
  }

  /** What you still need, leading the sub-line. This is the row's most useful fact AND the thing
   *  that tells two same-named pools apart — Sub has two "Shubin Interstellar · Ship Mining" pools
   *  open at once and nothing in the taxonomy separates them. First name plus a count, because the
   *  full list is in the info popover and a row cannot hold five blueprint names. */
  function poolNeed(p) {
    const m = p.missing || [];
    if (!m.length) return "";
    return '<span class="cp-need">need ' + escapeHtml(m[0])
      + (m.length > 1 ? ' <span class="cp-need-n">+' + (m.length - 1) + "</span>" : "")
      + "</span>";
  }

  // (poolTell — a contract title only ONE of two same-named pools offers, so you could tell
  //  them apart at the board — was removed 2026-08-15. Sub: the second row carried too much, and
  //  the pool NAME already gets you there: pick the category, then find a mission from that
  //  giver. Two measurements are worth keeping. For the titles two same-named pools SHARE they
  //  are byte-identical on rank, locations and payout, so for those there was no tell to give.
  //  And its own max-width was half of a HORIZONTAL SCROLLBAR: two flex:none children at 46% and
  //  62% come to 108% before the fixed-width link is placed.)

  // ── Latest blueprints, as pictures ────────────────────────────────────────────────────────
  // 🔑 TWO IMAGE SOURCES AND THE CAPTURE WINS. `image` is the crowdsourced fabricator capture —
  // what a player recognises. `imageFallback` is a generated clay render: grey, untextured, and
  // SHARED between items that reuse a model, so it shows a shape rather than an identity. The
  // capture 404s for anything nobody has captured, so we chain.
  // ⚠️ Chain with a FLAG, never by comparing img.src to the fallback URL — `.src` reads back as
  // the resolved ABSOLUTE url, so a relative fallback never compares equal and the handler
  // re-sets the same broken source forever.
  // 🔑 Item art is PORTRAIT (measured: capture 373x746, render 168x273). A square tile is the
  // worst of both — it crops the width away AND makes the row taller than it needs to be.
  function blueprintTile(b) {
    const label = escapeHtml(b.name);
    const art = b.image
      ? '<img class="bt-i" alt="" loading="lazy" src="' + escapeAttr(b.image) + '"'
        + (b.imageFallback ? ' data-fb="' + escapeAttr(b.imageFallback) + '"' : "") + ">"
      : (b.imageFallback
          ? '<img class="bt-i" alt="" loading="lazy" src="' + escapeAttr(b.imageFallback) + '">'
          : '<span class="bt-none">◆</span>');
    const w = fmtWhen(b.at);
    const when = w ? (PREFS.timeRelative ? w.rel : w.date) : "";
    return '<figure class="bt" title="' + escapeAttr(b.name) + '">'
      + '<span class="bt-art">' + art + "</span>"
      + '<figcaption class="bt-n">' + label + "</figcaption>"
      + '<span class="bt-w">' + escapeHtml(when) + "</span></figure>";
  }
  // One delegated handler for the whole page: a capture that 404s swaps to the render ONCE.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!img || img.tagName !== "IMG" || !img.classList.contains("bt-i")) return;
    const fb = img.getAttribute("data-fb");
    if (!fb) { img.classList.add("bt-dead"); return; }
    img.removeAttribute("data-fb");   // the flag: one swap, never a loop
    img.src = fb;
  }, true);   // capture phase — error does not bubble

  // ⚠️ THE POOL PAGE DOES NOT EXIST YET. Sub is coordinating it with the website flight
  // (2026-08-15); the uuid is the whole address, so nothing here needs to change when it lands.
  // Until then this link 404s — which is why it is rendered ONLY when the shell can open a real
  // browser (overlayApi.openUrl), never as a bare href a standalone/OBS view would follow, and
  // why it is one small labelled control rather than the row itself being clickable.
  // 🔑 This must match where the SITE actually serves the pool page. It was `/pools/<uuid>` while
  // the widget was built, and the site landed it at `/missions/pool/<uuid>` — the button 404'd for
  // nobody to notice, because the app never fetches this URL, it just opens a browser. Sub's call
  // 2026-08-16: the site keeps its path, the app follows it.
  const POOL_PAGE_BASE = "https://subliminal.gg/missions/pool/";
  function poolLink(p) {
    if (!p.poolUuid) return "";
    return '<button type="button" class="cp-link" data-pool="' + escapeAttr(p.poolUuid) + '">'
      + "see all contracts</button>";
  }
  // 🔑 openUrl(), never target=_blank — a second always-on-top window over the game is exactly
  // what this app exists to avoid. https only, enforced shell-side.
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".cp-link");
    if (!b) return;
    const url = POOL_PAGE_BASE + encodeURIComponent(b.dataset.pool);
    if (window.overlayApi && window.overlayApi.openUrl) window.overlayApi.openUrl(url);
  });

  // ── Standing with your mission givers ─────────────────────────────────────────────────────
  // Sub, 2026-08-15: a segment that auto-picks up to four givers and shows where you stand, to
  // make going back for the next rank feel worth it. Three ways of arguing that, switchable.
  //
  // 🔴 THE REP NUMBER IS A FLOOR, IN ALL THREE. The game never reports reputation anywhere the app
  // can read, so it is reconstructed from the player's own completions and cannot count anything
  // earned before the app was installed or in a log since rotated away. That is why the tracked
  // mission's rep bar already carries a circled i, and why every layout here carries one too.
  const REP_TIP =
    "Reconstructed from your own completion history, so it is a FLOOR: anything you earned before"
    + " installing the app, or in a log that has since rotated away, cannot be counted."
    + "\n\nThe game does not report reputation anywhere the app can read, so there is no way to"
    + " check it against the real number. Treat the rank you are shown as the worst case — you may"
    + " already be further along.";
  /** Faction name, trimmed of the tail that makes a 380px row truncate for nothing. */
  const facName = (f) => String(f || "").replace(/\s+(Incorporated|Interstellar|Independent Contractors)$/i, "");

  function standingsHtml(v) {
    // 🔑 A giver at MAX RANK is dropped: there is no next rank to work toward, so listing them is
    // an invitation to nothing. That is what `toGo == null` means.
    const st = (v.standings || []).filter((s) => s.toGo != null);
    if (!st.length) return "";
    return standingsContracts(st);
  }

  // ── STANDINGS · "Next rank" ───────────────────────────────────────────────────────────────
  // Sub picked this over a progress-bar row and a "what it unlocks" row on 2026-08-16.
  // 🔑 REP IS AN ABSTRACTION; CONTRACTS ARE AN ACTION. "5,300 rep to Prestige 2" does not tell you
  // whether that is an evening or a month — "~27 contracts" does, and that is the number that
  // decides whether you go. Derived from the MEDIAN rep this giver's missions award, so it is
  // approximate by construction and says so with a tilde.
  function standingsContracts(st) {
    let html = '<div class="ra-sec"><div class="ra-h ra-h-row"><span>Next rank</span>'
      // ⚠️ Its OWN container class, not `.sl`. Closest-to-done uses `.sl`, and while this section
      // shared it a test scoped to `.sl` silently read both — so "closest-to-done shows no rate"
      // started failing on this block's "~27 contracts". Neither class carries styling; the class
      // is here to keep the two sections tellable apart.
      + '<span class="ra-h-note">' + info(REP_TIP) + '</span></div><div class="stl">';
    for (const s of st.slice(0, 4)) {
      const eff = s.contractsToGo
        ? '~' + s.contractsToGo + (s.contractsToGo === 1 ? ' contract' : ' contracts')
        : compactNum(s.toGo) + ' rep';
      html += '<div class="st-r">'
        + '<span class="st-n">' + escapeHtml(facName(s.faction)) + '</span>'
        + '<span class="st-go">' + escapeHtml(eff) + '</span></div>'
        + '<div class="st-sub">' + escapeHtml(s.standing) + ' <span class="st-arrow">&rsaquo;</span> '
        + escapeHtml(s.nextName || 'next') + '</div>';
    }
    return html + '</div></div>';
  }

  // ── Closest to done ───────────────────────────────────────────────────────────────────────
  // Every pool the view carries rather than a top-two headline, one compact row each: "closest to
  // done" is a shortlist you scan, and four pools fit in the space two spent.
  //
  // Order is the view's own: fewest blueprints left first, which is what "closest" means.
  function closestShortlist(closest) {
    let html = '<div class="ra-sec"><div class="ra-h">Closest to done</div><div class="sl">';
    for (const p of closest) {
      const { left, pct } = poolLeft(p);
      html += '<div class="sl-r">'
        + '<span class="sl-n">' + escapeHtml(poolTitle(p)) + "</span>" + poolMoreInfo(p)
        + '<span class="sl-c">' + p.owned + "/" + p.total + "</span>"
        + '<span class="sl-bar"><i style="width:' + pct + '%"></i></span>'
        + '<span class="sl-left">' + left + " to go</span>"
        + "</div>"
        + '<div class="sl-sub">'
        + poolNeed(p) + (p.places.length ? '<span class="cp-w-p">' + escapeHtml(p.places.join(" · ")) + "</span>" : "<span></span>")
        + poolLink(p) + "</div>";
    }
    return html + "</div></div>";
  }

  // The idle panel — what fills the tracker when NOTHING is tracked. Two halves, in this order
  // (Sub, 2026-08-13): what you are closest to finishing, then what this session has been worth.
  //
  // 🔑 The order is the argument. "No mission tracked" is exactly the moment the useful question
  // is what to go do next, so the answer leads and the scoreboard follows behind a rule.
  function recentActivityHtml(v) {
    const missions = v.recentMissions || [];
    const blueprints = v.recentBlueprints || [];
    const closest = v.closestPools || [];
    const hasSession = !!(v.earnings && v.earnings.missions);
    if (!missions.length && !blueprints.length && !hasSession && !closest.length) return "";
    function whenCell(iso) {
      const w = fmtWhen(iso);
      if (!w) return '<span class="ra-when"></span>';
      // One or the other per the time-format setting: relative "2h ago" or absolute date+clock.
      const label = PREFS.timeRelative ? w.rel : w.date;
      return '<span class="ra-when"><span class="ra-date">' + label + "</span></span>";
    }
    let html = '<div class="recent">';

    // ── Closest to done ────────────────────────────────────────────────────────────────────
    if (closest.length) html += closestShortlist(closest);

    // ── Standing with your mission givers ──────────────────────────────────────────────────
    // Directly under "what to go do next", because it IS that question asked a second way: the
    // pools say what to finish, this says who to finish it for. Above the rule, so the scoreboard
    // half still reads as the separate thing it is.
    html += standingsHtml(v);

    // ── This session ───────────────────────────────────────────────────────────────────────
    // Behind a rule, because it answers a different question from everything above it.
    // 🔑 ONE section, not two (Sub, 2026-08-13). Totals and rates were separate blocks in
    // different shapes — a stat row above a little two-column table — and they are the same
    // subject: what this session has been worth. The rates now use the SAME stat treatment, so
    // the whole thing reads as one grid instead of a panel change halfway down.
    // The per-hour figures keep "/ hr" in their labels: a rate next to a total, in identical
    // type, is exactly where the two could be confused.
    const e = v.earnings;
    if ((e && e.missions) || missions.length || blueprints.length) {
      html += '<div class="ra-rule"></div>';
      if (e && e.missions) {
        const stat = (n, label, cls, title) =>
          '<div' + (title ? ' title="' + escapeAttr(title) + '"' : "") + '>'
          + '<div class="ss-n' + (cls ? " " + cls : "") + '">' + n + "</div>"
          + '<div class="ss-l">' + escapeHtml(label) + "</div></div>";
        const na = '<span class="rt-na">—</span>';
        html += '<div class="ra-sec"><div class="ra-h">This session</div>'
          + '<div class="ss">'
          + stat(e.missions, "Contracts")
          + stat(e.aUECTotal != null ? compactNum(e.aUECTotal) : na, "aUEC", "gold",
              "Total from missions whose payout the game actually logged.")
          + stat(blueprints.length, "Blueprints", "green")
          + "</div>"
          // Second row, same shape: what that works out to per hour.
          //
          // 🔑 THE PACE IS ON SCREEN, NOT IN THE TOOLTIP (Sub, 2026-08-15). The old separate
          // "Per hour · this grind" block was a two-column table — last 60m AND pace — and when it
          // was folded into this section on 2026-08-13 the pace was demoted into a `title`. Sub
          // asked for it back in the words "what you're trending at at the rate that you're
          // going", which is precisely the number that went missing; what he did NOT ask for is
          // the old block's second shape. So it returns as a suffix on the figure it qualifies,
          // inside the stat treatment that is already here — one section, one shape, both numbers.
          //
          // ⚠️ The arrow is a plain ASCII-safe glyph rendered from a text node, not an emoji:
          // missions.html links no emoji face, so anything outside the base fonts is at the mercy
          // of the OS. Same trap that turned o7 into a box.
          + '<div class="ss ss-rates">'
          + stat(rateWithPace(e.repLastHr, e.repPace, na), "Rep / hr", null,
              "Reputation earned in the last 60 minutes"
              + (e.repPace != null
                  ? ", and the pace this whole grind is trending at (" + e.repPace.toLocaleString() + "/hr)."
                  : "."))
          + stat(rateWithPace(e.aUECLastHr, e.aUECPace, na), "aUEC / hr", "gold",
              "aUEC in the last 60 minutes, from missions with a known payout"
              + (e.aUECPace != null
                  ? ", and the pace this whole grind is trending at (" + e.aUECPace.toLocaleString() + "/hr)."
                  : "."))
          + "</div></div>";
      }
    }

    // ── Latest blueprints, then Latest missions ────────────────────────────────────────────
    // 🔑 Both rendered EMPTY here and filled by fitLists() once the boxes have been measured —
    // how many rows fit is a function of the widget's height, which this string knows nothing
    // about. The two SHARE what is left of the panel, half each, 1–10 rows apiece (Sub,
    // 2026-08-15: "have it split that space that latest currently occupies").
    if (blueprints.length) {
      // 🔑 The blueprint half is a PICTURE ROW now (Sub, 2026-08-15). It sizes itself from the
      // widget's WIDTH, not its height, so unlike the missions list below it takes a fixed slice
      // of the panel rather than competing for the leftover — one row of art, truncated to
      // whatever fits across.
      html += '<div class="ra-sec ra-bp-sec"><div class="ra-h">Latest blueprints</div>'
        // 🔑 The art box needs an ABSOLUTE height. A percentage height on a centred grid item
        // resolves against an auto row, i.e. to `auto`, and `object-fit` then has nothing to do —
        // that is exactly how the completion card rendered a 169x338 image inside a 92px box with
        // overflow chopping it. Fewer across means a bigger tile, so the height rides the count.
        // Rendered EMPTY and filled by fitBlueprintArt() once the row has a measured WIDTH —
        // how many fit across is a property of the widget's size, which this string cannot know.
        + '<div class="bt-row" id="raLatestArt"></div></div>';
    }
    if (missions.length) {
      html += '<div class="ra-sec ra-latest-sec ra-latest-mis-sec"><div class="ra-h">Latest missions</div>'
        + '<ul class="ra-list ra-latest" id="raLatestMissions"></ul></div>';
    }
    return html + "</div>";
  }

  /** "1.2k ↗1.5k" — what the last hour actually paid, and what the grind is trending at.
   *
   *  🔑 The pace is DIMMER AND SMALLER on purpose. The two are not equally solid: the last-60m
   *  figure is measured, the pace is an extrapolation that is noisy until a session has some
   *  length to it. Same type and weight would present them as two readings of the same kind.
   *  🔑 Omitted entirely when the pace is null (the first minute of a grind) or when it matches
   *  the hour figure — an arrow pointing at the number it came from is noise, not information. */
  function rateWithPace(lastHr, pace, na) {
    if (lastHr == null) return na;
    const now = compactNum(lastHr);
    if (pace == null) return now;
    const then = compactNum(pace);
    if (then === now) return now;
    return now + '<span class="ss-pace">↗' + then + "</span>";
  }

  /** Compact aUEC — a session total is a big number in a narrow column. */
  function compactNum(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, "") + "m";
    // ⚠️ One decimal below 10k. Rounding to whole thousands turned 1,240 rep/hr into a flat "1k",
    // which is a 20% lie on exactly the range these figures live in — a grind hour is thousands,
    // not tens of thousands. Above 10k the decimal stops earning its width.
    if (v >= 10000) return Math.round(v / 1000) + "k";
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(v);
  }

  // ── How many "Latest" rows fit ────────────────────────────────────────────────────────────
  // The list takes whatever height is left after everything above it, so the count is a property
  // of the WIDGET's size, not of the data.
  //
  // 🔴 ALWAYS AT LEAST ONE. Sub, 2026-08-13, collapsing the panel to its minimum: "it doesn't show
  // anything under Latest. It's just nothing." A heading over a void is worse than a heading over
  // one row — so the floor is one, enforced by the CSS min-height as well as here, and the section
  // overflows rather than rendering empty. Nobody sizes the widget that small on purpose, but the
  // state has to be coherent when they do.
  //
  // 🔑 TWO lists now share that space, half each (Sub, 2026-08-15). The split is measured ONCE
  // over the room both of them have together, rather than letting flexbox hand each section a box
  // and reading it back — a list whose height is an output of the count cannot also be the input
  // to it, which is the same feedback loop the observer note below is about.
  // 🔑 MEASURED, not estimated (2026-08-15): a row is 21.0px and the "+N more" line is ALSO 21.0px
  // — it is an `li` in the same list, so it inherits the same 3px padding, and its smaller type
  // buys nothing. It was guessed at 15px, which under-reserved by 6px and left the line clipped by
  // the section's overflow. So a truncated list costs exactly one extra ROW; there is no separate
  // constant to keep in sync.
  const LATEST_MIN = 1, LATEST_MAX = 10, LATEST_ROW_PX = 21;
  let latestShown = -1, latestMisShown = -1;
  // One observer for the life of the page, re-pointed at whatever list is currently on screen.
  // Watching the PANEL rather than the list itself: the list's own height is an output of this
  // computation, so observing it is a feedback loop waiting to happen.
  let latestRO = null;
  // Coalesced deferred re-check. One pending pair at a time, so a drag that fires the observer on
  // every pixel schedules one follow-up, not hundreds.
  let reFitT = null;
  function reFit() {
    if (reFitT) return;
    reFitT = setTimeout(() => { reFitT = null; fitLatest(); setTimeout(fitLatest, 90); }, 0);
  }
  function observeLatest() {
    // 🔴 NOT requestAnimationFrame. It does not fire in a window the compositor considers hidden,
    // and this overlay is hidden all the time — toggled off in the hub, behind the game, or a
    // background page in a test harness. Hanging the initial fit on a frame that may never come is
    // how the heading ended up over an empty list. `setTimeout` runs regardless.
    // Two of them, because the first can still land before layout has settled; both are idempotent
    // — fitLatest returns immediately unless the ANSWER changed — so the redundancy costs nothing.
    setTimeout(fitLatest, 0);
    setTimeout(fitLatest, 80);
    if (!window.ResizeObserver) return;
    // Measuring inside the observer callback is already post-layout, so there is nothing to defer
    // to and nothing to wait for.
    // 🔴 THE OBSERVER ALONE IS NOT ENOUGH, and the failure is a SILENT OFF-BY-ONE rather than a
    // dead panel. Measured 2026-08-15 across seven widget widths: the fit was right at 380, 640,
    // 720 and 900 but one step low at 540 — and re-running it by hand at that same width gave the
    // right answer, so the arithmetic was never wrong. This overlay is hidden constantly (toggled
    // off, behind the game, a background page in the harness) and a window the compositor
    // considers hidden delivers resize callbacks late, once, or not at all.
    // So the callback ALSO re-checks on a timer, the same defence observeLatest() already uses for
    // the first layout pass. Both fits early-return unless the ANSWER changed, so a redundant run
    // costs nothing and cannot loop.
    // 🔴 THE CALLBACK ONLY SCHEDULES — it must not touch the DOM. Fitting inline made the picture
    // row's height change cascade into the missions section, which IS observed, so the observer
    // re-fired during its own delivery: "ResizeObserver loop completed with undelivered
    // notifications", caught by the suite's console check in an unrelated suite. Deferring the
    // work out of the delivery breaks the cycle, and reFit coalesces so a drag schedules one
    // follow-up rather than one per pixel.
    if (!latestRO) latestRO = new ResizeObserver(() => reFit());
    latestRO.disconnect();
    // Observe the SECTION, not the panel: in the canvas the panel is a widget whose box can be
    // replaced, and an observer pointed at a detached node silently never fires again.
    // BOTH list sections — observing only the first meant resizing never re-fitted the second.
    // 🔴 NOT `.ra-bp-sec`. Observing the picture row's own section made the fit rewrite the very
    // box it was watching — Chromium reported "ResizeObserver loop completed with undelivered
    // notifications" and the widget suite's console check caught it in a DIFFERENT suite entirely.
    // The comment above already said observing the list is a feedback loop waiting to happen; the
    // picture row is the same trap wearing different clothes. `#panel` below is what changes WIDTH
    // and is never written to by the fit, so it is the safe thing to watch for this.
    for (const sec of document.querySelectorAll(".ra-latest-sec")) latestRO.observe(sec);
    const panel = document.getElementById("panel");
    if (panel) latestRO.observe(panel);
  }
  /** One row of either list. `val` is the optional gold figure — only missions carry one. */
  function latestRow(name, at, val) {
    const w = fmtWhen(at);
    const label = w ? (PREFS.timeRelative ? w.rel : w.date) : "";
    return '<li><span class="ra-glyph">◆</span><span class="ra-name">' + escapeHtml(name) + "</span>"
      + (val ? '<span class="ra-val">' + escapeHtml(val) + "</span>" : "")
      + '<span class="ra-when"><span class="ra-date">' + escapeHtml(label) + "</span></span></li>";
  }
  function fillList(ul, rows, n) {
    let h = "";
    for (const r of rows.slice(0, n)) h += latestRow(r.name, r.at, r.val);
    const rest = rows.length - n;
    // 🔴 THE "NEVER EMPTY" FLOOR CAN OUTVOTE THE RESERVATION, and then the +N line has nowhere to
    // go. At the widget's smallest the box holds less than two rows, so `rowsFor` clamps up to one
    // — correct, a heading over a void is worse — but that one row already fills the box and the
    // more-line gets sliced by the overflow, which is the very fault the reservation exists to
    // prevent. When it cannot fit, it is DROPPED: the count is a nicety, a half-cut line is a bug.
    const room = ul.getBoundingClientRect().height;
    if (rest > 0 && (n + 1) * LATEST_ROW_PX <= room + 1) h += '<li class="ra-more">+' + rest + " more</li>";
    ul.innerHTML = h;
  }
  // ── How many blueprint pictures fit ACROSS ────────────────────────────────────────────────
  // The mirror of fitLatest: that one divides leftover HEIGHT into rows, this one divides the
  // row's WIDTH into tiles. Sub, 2026-08-15: "the wider the widget is, the more blueprints show
  // up" — so it is measured, not chosen, and the switcher went back to picking layouts.
  //
  // 🔑 THE NUMBERS COME FROM THE WIDGET'S OWN REGISTRY ENTRY, not from taste. The tracker is
  // `{ w: 380, minW: 300 }`, and Sub put his own widget at "about the smallest size that someone
  // will reasonably set it to" and asked for TWO there. A 160px minimum tile lands 2 at the 380
  // default, 3 at ~540 and 4 at ~720 — checked against those three widths rather than eyeballed.
  // 🔑 The floor is 2 for the same reason the Latest list's floor is 1: below it the tiles just
  // shrink (the grid track is `minmax(0, 1fr)`), which is better than a heading over one lonely
  // picture at a size nobody uses on purpose.
  const BP_MIN = 2, BP_MAX = 10, BP_TILE_PX = 160, BP_GAP_PX = 8;
  // Fewer across means a bigger tile. Item art is PORTRAIT (measured: capture 373x746, render
  // 168x273), so height rides the count rather than being one fixed number that suits neither.
  const BP_ART_H = { 2: 104, 3: 78, 4: 60 };
  let bpShown = -1;
  function fitBlueprintArt() {
    const row = document.getElementById("raLatestArt");
    if (!row || !current) { bpShown = -1; return; }
    const all = current.recentBlueprints || [];
    if (!all.length) return;
    const w = row.getBoundingClientRect().width;
    let n = Math.floor((w + BP_GAP_PX) / (BP_TILE_PX + BP_GAP_PX));
    if (!Number.isFinite(n) || n < BP_MIN) n = BP_MIN;
    if (n > BP_MAX) n = BP_MAX;
    if (n > all.length) n = all.length;
    // Only touch the DOM when the ANSWER changes — this runs off a ResizeObserver, and rebuilding
    // the row on every pixel of a drag would re-request every image.
    if (n === bpShown) return;
    bpShown = n;
    row.style.setProperty("--bt-across", String(n));
    row.style.setProperty("--bt-h", (BP_ART_H[n] || 56) + "px");
    row.innerHTML = all.slice(0, n).map(blueprintTile).join("");
  }

  function fitLatest() {
    fitBlueprintArt();
    if (!current) { latestShown = latestMisShown = -1; return; }
    const bpUl = document.getElementById("raLatest");
    const msUl = document.getElementById("raLatestMissions");
    if (!bpUl && !msUl) { latestShown = latestMisShown = -1; return; }
    const bps = (current.recentBlueprints || []).map((b) => ({ name: b.name, at: b.at, val: null }));
    // 🔑 aUEC is COMPACT here, not toLocaleString as the original list had it. "54.5k" beside a
    // contract title and a timestamp fits a 380px panel; "54,500 aUEC" pushed the title into an
    // ellipsis. It is also a REAL logged award, so it takes no estimate tilde — unlike everything
    // in the closest-to-done section, which is modelled.
    const mss = (current.recentMissions || []).map((m) => ({
      name: m.title || "Mission", at: m.at,
      val: m.aUEC != null ? compactNum(m.aUEC) : null,
    }));

    // 🔑 MEASURE EACH LIST'S OWN BOX; do not compute a share. Deriving it as "panel bottom minus
    // list top, less a heading and a gap" was off by whatever margins the headings carry, so the
    // reserved space and the box flexbox actually handed over disagreed and the "+N more" line
    // still got clipped. The uls are `flex:1` inside `flex:1` sections with overflow:hidden, so
    // their height is a pure function of the CONTAINER — content cannot grow them, and there is
    // therefore no feedback loop in reading them back. That is what makes this exact.
    //
    // 🔑 The halves are weighted by how much DATA each list has, not by what is rendered — so
    // twelve blueprints beside one mission does not leave half the panel blank, and ten beside
    // ten is the even split Sub asked for. Data-driven, so this cannot feed back either.
    if (bpUl && msUl) {
      bpUl.parentElement.style.flexGrow = String(Math.min(bps.length, LATEST_MAX));
      msUl.parentElement.style.flexGrow = String(Math.min(mss.length, LATEST_MAX));
    }
    // A truncated list has to pay for its own "+N more" line — one row's worth. Nothing reserved
    // it before, so the last thing in the list was sliced in half by the section's overflow and
    // read as a rendering fault rather than as "there is more".
    const rowsFor = (px, len) => {
      let n = Math.floor(px / LATEST_ROW_PX);
      if (n < len) n -= 1;
      if (!Number.isFinite(n)) n = LATEST_MIN;
      return Math.max(LATEST_MIN, Math.min(LATEST_MAX, len, n));
    };
    const nBp = bpUl ? rowsFor(bpUl.getBoundingClientRect().height, bps.length) : -1;
    const nMs = msUl ? rowsFor(msUl.getBoundingClientRect().height, mss.length) : -1;

    // Only touch the DOM when the ANSWER changes — this runs off a ResizeObserver, and rewriting
    // the same list on every pixel of a drag is the idle-repaint mistake again.
    if (bpUl && nBp !== latestShown) { latestShown = nBp; fillList(bpUl, bps, nBp); }
    if (msUl && nMs !== latestMisShown) { latestMisShown = nMs; fillList(msUl, mss, nMs); }
    if (!bpUl) latestShown = -1;
    if (!msUl) latestMisShown = -1;
  }

  // The "Blueprint Received" toast moved OUT of this panel into its own placeable notifier widget
  // (overlay/unlockalert.html, registry key `unlockAlert`). It was pinned to the panel's bottom
  // edge — the one place a notification is useless, since that's not where anyone is looking; Sub
  // unlocked a blueprint and never saw it fire. The widget subscribes to /missions/events and
  // reads justReceived itself, so nothing here needs to forward it.

  function render(v) {
    current = v;
    if (v.prefs) { PREFS = v.prefs; applyPrefs(); }
    isLive = !!v.live; updateDiamond();
    const panel = $("panel");
    // Show the dataset version, and flag when the player's actual build isn't the one
    // we have data for (pools are an approximation from the same family).
    let patchTxt = v.patch || "";
    if (v.build && v.patch && !v.patch.includes(v.build)) patchTxt += " · build " + v.build;
    $("patch").textContent = patchTxt;
    renderEnvBadge(v);
    $("appVer").innerHTML = "SC Overlay" + (v.appVersion ? " v" + escapeHtml(v.appVersion) : "") + ' <span class="fv-beta">BETA</span>';
    $("collected").textContent = v.collectedTotal ?? 0;
    // The report is the ONLY completion summary now — the old in-panel `.cc` card (duration +
    // blueprint tiles appended under the mission header) is deleted, not hidden. It ran
    // everywhere, so the report does too rather than leaving OBS browser sources with nothing
    // on completion. `#completed` keeps only the plain persistent "Mission complete" state text.
    $("completed").innerHTML = (!v.completion && v.completed) ? '<span class="completed">Mission complete</span>' : "";
    renderReport(v);
    renderPicker(v);

    if (!v.contractKey) {
      $("title").textContent = "No mission tracked";
      $("sub").textContent = "";
      document.querySelector(".progress").style.display = "none";
      $("catbar").innerHTML = "";
      const recent = recentActivityHtml(v);
      if (recent) {
        // Idle state: what you're closest to finishing, then what this session has been worth.
        panel.classList.remove("empty");
        $("msg").innerHTML = "";
        $("pool").innerHTML = recent;
        $("pool").classList.add("idle");
        // The list is written EMPTY above; how many rows it holds depends on the height it ends
        // up with, which only exists after layout. Reset first so a re-render with different data
        // recomputes instead of trusting the previous answer.
        latestShown = latestMisShown = bpShown = -1;
        observeLatest();
      } else {
        panel.classList.add("empty");
        $("pool").innerHTML = "";
        const hasList = v.missions && v.missions.length;
        $("msg").innerHTML = '<div class="msg">' +
          (hasList ? "Pick one from the dropdown above, or track a mission in-game." :
                     "Track a mission in-game to see its blueprint pool.") + "</div>";
      }
      return;
    }
    $("title").textContent = v.title || v.contractKey;
    $("sub").textContent = (v.generator || "").replace(/_/g, " ");

    const progress = document.querySelector(".progress");
    if (!v.hasPool || !v.pools.length) {
      // No blueprint pool: lead with the mission info we DO have (faction, type, rep) —
      // auto-expanded since there's nothing else on screen — plus any static payout
      // and/or ITEM rewards (Wikelo ships, armor, scrip). Bare message only if truly empty.
      //
      // 🔴 AN EVENT MISSION IS STILL A MISSION — Sub's ruling, 2026-08-19. This branch used to
      // hand a dynamic-event contract straight to renderEventTrack() and `return`, so the reward
      // LADDER replaced the mission report entirely: running an Orison Relief haul told you what
      // unlocks at 43% and nothing about the contract you were actually flying. The ladder is the
      // EVENT TRACKER widget's job ("the event tracker is the one that's going to have to have
      // this thing that tells you what percent you get what loot at"); this panel's job is
      // "what is this contract". So the report renders as it would for any pool-less mission and
      // the event contributes ONE line pointing at the widget.
      const info = missionInfoHtml(v, true);
      const rew = rewardsHtml(v);
      const ev = v.eventTrack
        ? '<div class="rewnote"><b>Counts toward ' + escapeHtml(v.eventTrack.name) + '.</b> ' +
          escapeHtml(v.eventTrack.note) + ' Reward tiers are in the Event Tracker.</div>'
        // Only claim "no blueprints" when it is NOT an event mission: an event contract pays
        // through the contribution ladder, so saying it drops nothing would be false.
        : '<div class="rewnote">This mission doesn’t drop blueprints.</div>';
      if (info || rew || v.eventTrack) {
        panel.classList.remove("empty");
        $("msg").innerHTML = "";
        $("catbar").innerHTML = "";
        progress.style.display = "none"; // no blueprint progress to count
        $("pool").innerHTML = info + rew + ev;
        return;
      }
      panel.classList.add("empty");
      $("pool").innerHTML = "";
      $("msg").innerHTML = '<div class="msg"><b>No blueprint reward</b>This mission doesn’t drop blueprints.</div>';
      return;
    }
    panel.classList.remove("empty");
    progress.style.display = "";
    $("msg").innerHTML = "";
    $("frac").textContent = v.totals.owned + "/" + v.totals.total;

    // Flatten pool entries, computing each blueprint's display odds within ITS pool
    // (odds are per-pool), then regroup by fabricator category for display.
    const items = [];
    for (const pool of v.pools) {
      // Real odds of getting a specific blueprint = its weight / the pool's total,
      // not the raw per-entry chance (which is 1.0 for every entry → misleading 100%).
      const poolSum = pool.blueprints.reduce((a, b) => a + (b.chance || 0), 0) || 1;
      const missing = pool.blueprints.filter((x) => !x.owned).length;
      for (const b of pool.blueprints) {
        // base = weight / pool total; adjusted = 1 / what you still need (owned → —).
        const oddsP = oddsMode === "adjusted"
          ? (b.owned ? null : (missing > 0 ? 1 / missing : 0))
          : (b.chance || 0) / poolSum;
        items.push({ ...b, oddsP });
      }
    }

    // Per-tab counts drive the filter bar (computed before filtering so counts are stable).
    const counts = {};
    for (const it of items) {
      const c = counts[it.tab] || (counts[it.tab] = { total: 0, owned: 0 });
      c.total++; if (it.owned) c.owned++;
    }
    if (activeTab && !counts[activeTab]) activeTab = null; // selected tab not in this pool
    renderCatbar(counts);

    // Filter by the selected category tab (the icon bar at top). No in-line
    // category/sub-category headers — just the rows, grouped by tab order so a
    // filtered/unfiltered list stays visually tidy.
    const shown = activeTab ? items.filter((it) => it.tab === activeTab) : items;
    const ordered = TABS.flatMap((tab) => shown.filter((it) => it.tab === tab.key));

    // The list leads with what you can still GET (paginated, 8/page); what you've already
    // COLLECTED is hidden under a "Collected" disclosure by default (poolShowCollected).
    const need = ordered.filter((it) => !it.owned);
    const have = ordered.filter((it) => it.owned);
    // Reset to the first page whenever the tracked mission or the category filter changes.
    const pkey = (v.contractKey || "") + "|" + (activeTab || "");
    if (pkey !== poolKey) { poolKey = pkey; poolPage = 0; }
    const PER = 8;
    const pages = Math.max(1, Math.ceil(need.length / PER));
    if (poolPage > pages - 1) poolPage = pages - 1;
    const pageRows = need.slice(poolPage * PER, poolPage * PER + PER);

    let html = missionInfoHtml(v) + rewardsHtml(v);
    if (v.ambiguous) html += '<div class="ambig">⚠ Multiple mission tiers share this name — showing all possible drops. Your actual mission draws from one tier, so odds are approximate.</div>';
    html += unrecognizedHtml(v);
    if (need.length || have.length) html += '<div class="poolhead">Blueprint pool<span class="ph-sub">1 random blueprint per completion</span></div>';
    html += pageRows.map(rowHtml).join("");
    if (!need.length && have.length) html += '<div class="allgot">✓ You already have every blueprint in this pool.</div>';
    if (pages > 1) {
      html += '<div class="pgnav">' +
        '<button class="pgbtn" data-pg="prev"' + (poolPage === 0 ? " disabled" : "") + ' title="Previous page">‹</button>' +
        '<span class="pgind">' + (poolPage + 1) + " / " + pages + "</span>" +
        '<button class="pgbtn" data-pg="next"' + (poolPage >= pages - 1 ? " disabled" : "") + ' title="Next page">›</button>' +
      "</div>";
    }
    // Collected disclosure — owned blueprints tuck here; click to expand/collapse (owned rows
    // keep their ✔ and stay click-to-toggle). Hidden by default so the list shows what to chase.
    if (have.length) {
      html += '<div class="grphead" data-grp="collected"><span class="car">' + (poolShowCollected ? "▾" : "▸") +
        '</span>Collected<span class="gcnt">' + have.length + "</span></div>";
      if (poolShowCollected) html += have.map(rowHtml).join("");
    }
    $("pool").innerHTML = html;
  }

  // One blueprint row (odds already computed into b.oddsP).
  function rowHtml(b) {
    const ovr = b.source === "manual" ? '<span class="ovr">[manual]</span>'
      : b.source === "default" ? '<span class="ovr def">[default]</span>' : "";
    const ch = b.oddsP == null
      ? '<span class="chance">—</span>'
      : '<span class="chance">' + (b.oddsP * 100 >= 10 ? Math.round(b.oddsP * 100) : (b.oddsP * 100).toFixed(1)) + "%</span>";
    return '<div class="row ' + (b.owned ? "owned" : "") + '" data-name="' + escapeAttr(b.name) + '"'
      + ' data-source="' + escapeAttr(b.source || "") + '" title="Click to toggle owned">' +
      '<span class="mark">' + (b.owned ? "✔" : "") + "</span>" +
      '<span class="name">' + escapeHtml(b.name) + ovr + "</span>" + ch +
    "</div>";
  }

  // Fabricator filter bar: all 10 tabs; tabs with no blueprint in the current pool
  // are greyed (non-clickable), the selected tab is highlighted, and a count badge
  // shows how many blueprints each tab holds.
  function renderCatbar(counts) {
    $("catbar").innerHTML = TABS.map((t) => {
      const c = counts[t.key];
      const cls = "cat" + (c ? "" : " off") + (activeTab === t.key ? " active" : "");
      const title = t.label + (c ? " · " + c.owned + "/" + c.total + " owned" : " · none in this pool");
      const cnt = c ? '<span class="cnt">' + c.total + "</span>" : "";
      return '<div class="' + cls + '" data-tab="' + t.key + '" title="' + escapeAttr(title) +
        '" style="--u:url(\'icons/' + t.icon + '\')"><span class="ci"></span>' + cnt + "</div>";
    }).join("");
  }

  // Dynamic-event reward ladder (Return of XenoThreat): shown on an event mission that
  // has no blueprint pool. A note + each contribution-% tier with its rewards and owned
  // checks. Rows carry data-name so the existing click-to-toggle handler works.
  // 🔑 renderEventTrack() lived here and drew the whole contribution ladder inside this panel.
  // Removed with the branch above: the ladder belongs to the Event Tracker widget, which owns
  // "what percent gets you what loot". Its per-tier collapse state (`evOpen`) went with it.

  /**
   * "You are on a test server and your blueprints are NOT being recorded."
   *
   * 🔑 Driven by `v.envIsLive`, which the tracker copies straight off the same `isLiveEnv` the
   * gating uses — so the badge cannot claim one thing while the recorder does another.
   * 🔴 NOT derived from `v.patch`. That string is the DATASET label and currently reads
   * "4.10.0-PTU.12479687" purely because the bundled 4.10 data was extracted from PTU; on a real
   * LIVE 4.10 build it would still say PTU, and a badge keyed on it would tell live players their
   * progress was being thrown away.
   * 🔑 A null env is LIVE and shows nothing — attaching mid-session with no header is the common
   * case, and crying wolf there is worse than staying quiet.
   */
  function renderEnvBadge(v) {
    const badge = $("envBadge"), line = $("envLine");
    if (!badge || !line) return;                 // standalone/older markup — never throw over chrome
    if (v.envIsLive !== false) {                 // true, or absent on an older sidecar
      badge.hidden = true; line.hidden = true;
      return;
    }
    const tag = (v.logEnv || "TEST").toUpperCase();
    badge.textContent = tag;
    badge.title = "You're playing on " + tag + ", a test environment. Blueprints you earn here are " +
      "NOT added to your collection and are not synced — only LIVE progress counts. " +
      "Everything else in the app works normally.";
    badge.hidden = false;
    line.textContent = "· " + tag + " — blueprints not counted";
    line.hidden = false;
  }

  function escapeHtml(s){return s.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));}
  function escapeAttr(s){return s.replace(/"/g,"&quot;");}

  // Static payout as display text, or null. Most missions are runtime-calculated
  // (no static amount in the game data) — those stay silent rather than guessing.
  // min 0/null = "up to max"; MER = prison merits.
  function payoutText(p) {
    if (!p || !p.max) return null;
    const cur = (p.currency || "").toUpperCase() === "MER" ? "merits" : "aUEC";
    const n = (x) => Number(x).toLocaleString();
    if (p.min && p.min !== p.max) return n(p.min) + "–" + n(p.max) + " " + cur;
    if (!p.min) return "up to " + n(p.max) + " " + cur;
    return n(p.max) + " " + cur;
  }

  // Collapsible "Mission Info" drawer: faction/giver, mission type, and reputation
  // gained/lost. Collapsed by default on a pooled mission (tap to expand); forced
  // open when the mission has no pool (forceOpen) so the panel isn't bare. Returns ""
  // when there's nothing to show. Payout is deliberately NOT here — it's only known
  // for sure after completion, shown by the mission-complete card.
  /** Several awards against the SAME standing (same faction + scope) collapse to one row: the
   *  LARGEST — which is the one the standing estimate credits — carrying the others as `extra`
   *  so they can be disclosed rather than silently dropped or misleadingly stacked. */
  function collapseSameStanding(list) {
    const by = new Map();
    for (const r of list || []) {
      const k = (r.faction || "") + "|" + (r.scope || "");
      const g = by.get(k);
      if (!g) { by.set(k, Object.assign({}, r, { extra: [] })); continue; }
      if (Number(r.amount || 0) > Number(g.amount || 0)) { g.extra.push(g.amount); g.amount = r.amount; }
      else g.extra.push(r.amount);
    }
    return [...by.values()];
  }
  /** "· +60 also listed" — the awards this mission lists against the same standing that the
   *  estimate does NOT count. The data says nothing about what they're for, so neither do we. */
  function extraHint(r) {
    if (!r.extra || !r.extra.length) return "";
    const more = r.extra.map((a) => "+" + Number(a || 0).toLocaleString()).join(" ");
    return ' <span class="mi-hint" title="This mission lists more than one reputation award against the same standing. ' +
      'Checked against the in-game standing bar (2026-07-29): the extra one is NOT added to your standing, ' +
      'so only the largest is counted here.">' +
      escapeHtml(more) + " also listed</span>";
  }
  // (repRows — a labelled block listing each rep award as its own row — went with the 2026-08-13
  // chip pass; every award is now a chip named after its own scope.)
  // Reputation progress bar for the tracked mission's giver: current standing NAME + a
  // fill toward the next rank. A LOWER-BOUND estimate (server-side rep is never logged),
  // so the readout is qualified "est." and the caption uses "~".
  function repBarHtml(rb) {
    const num = (x) => Number(x || 0).toLocaleString();
    let pct, cap, empty = false;
    if (rb.noData) {
      // No completions summed for this giver yet — don't fake a standing, prompt a verify.
      pct = 0; empty = true;
      cap = "no completions tracked yet · run Verify from logs";
    } else if (rb.max) {
      pct = 100;
      cap = "Top standing reached";
    } else {
      const span = (rb.nextMin - rb.curMin) || 1;
      pct = Math.max(0, Math.min(100, ((rb.estimate - rb.curMin) / span) * 100));
      cap = "~" + num(rb.estimate) + " / " + num(rb.nextMin) +
        ' <span class="nx">→ ' + escapeHtml(rb.nextName || "") + "</span>";
      // What that rank hands over. Battaglia gates ships here (Golem, Prospector, MOLE) and the
      // bar used to be a bare number — a target with no stated prize. Named, it's a reason to grind.
      const unlocks = rb.nextRewards || [];
      if (unlocks.length) {
        cap += '<div class="rb-unlock" title="Reaching ' + escapeAttr(rb.nextName || "the next rank") +
          " with " + escapeAttr(rb.faction) + ' unlocks this.">unlocks ' +
          escapeHtml(unlocks.slice(0, 2).join(" · ")) +
          (unlocks.length > 2 ? " +" + (unlocks.length - 2) + " more" : "") + "</div>";
      }
    }
    const standing = rb.noData ? "—" : escapeHtml(rb.standing);
    // 🔑 An eye rather than the word "est." (Sub, 2026-08-12). The qualifier mattered but the
    // abbreviation explained nothing — it told you the number was approximate without telling you
    // WHY, which is the part that stops it looking like a bug. The reason is specific and worth
    // stating: the game never reports your reputation anywhere the app can read, so this is
    // reconstructed from your own logs and is a floor, not a reading.
    let why = rb.noData
      ? "Star Citizen never reports your reputation in any form the app can read, so standing is worked out from the missions in your own logs. None have been counted for " + rb.faction + " yet — run Verify from logs to read your history."
      : "Star Citizen never reports your exact reputation in any form the app can read, so this is worked out from the missions in your own logs since the 4.8 wipe. It is a lower bound: anything earned before you installed the app, or since deleted, cannot be counted.";
    // 🔴 SAY THAT THIS CONTRACT WILL NOT MOVE IT. The bar used to VANISH on these contracts —
    // Sub accepted a Headhunters mission and his Headhunters standing disappeared, because the
    // contract pays into a combat sub-track the app does not rank (384 of 4,075 do; 88 of them
    // Headhunters). Showing his real standing is the right answer to "where do I stand with these
    // people". Showing it SILENTLY next to that mission's own "+500 reputation" pill would be a
    // different lie, so the caption is marked and the reason is in the same affordance.
    if (rb.offTrack) {
      why += "\n\nThis contract's reputation goes to a separate track that has no rank ladder the"
        + " app can read, so finishing it will not move this bar. The standing shown is what you"
        + " have earned from " + rb.faction + "'s other work.";
    }
    return '<div class="mi-row"><span class="mi-k">Standing</span><span class="mi-v">' + standing +
      (rb.noData ? ' <span class="mi-hint">no data</span>' : "") +
      (rb.offTrack && !rb.noData ? ' <span class="mi-hint">not from this one</span>' : "") +
      info(why) + '</span></div>' +
      '<div class="rb' + (empty ? " floor" : "") + '"><div class="rb-track"><div class="rb-fill" style="width:' +
      pct.toFixed(1) + '%"></div></div><div class="rb-cap">' + cap + "</div></div>";
  }
  // ── Community data: what everyone else found out about this contract ──────────────────────
  // Two things the shipped dataset cannot know — what the contract actually PAID (calculated at
  // accept time, absent from the game files) and what players said about it afterwards. The
  // sidecar fetches both; see the note beside communityFor().
  //
  // 🔑 EVERY ROW STATES HOW MANY REPORTS IT RESTS ON. A single sample rendered as a bare number
  // is indistinguishable from a settled fact, and this is exactly the data most likely to be
  // thin — 108 contracts have any payout at all, most of them from one player. A wrong number
  // presented confidently is worse than no number, which is the same rule the site follows.
  const money = (n) => Number(n || 0).toLocaleString();
  const reports = (n) => n + (n === 1 ? " report" : " reports");
  // "A, B and C" — this goes inside a sentence in a tooltip, where a bare "A · B · C" reads as a
  // fragment rather than as prose.
  const listWords = (a) => (a.length <= 1 ? (a[0] || "") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);

  // ── Where to pick it up: ONE useful name, or nothing ──────────────────────────────────────
  // Measured over the real dataset (4,075 contracts, 1,659 with a list, 51 distinct names):
  //   2–4 places … 898 lists — genuinely specific, worth naming
  //   5+ places … 761 lists — effectively "anywhere in the system"; the big ones name all 16
  //               Stanton bodies or 19 Pyro points, which is the same as naming none, only longer
  // So a long list is DROPPED entirely rather than truncated (Sub: "if it's a mission that could
  // be picked up everywhere in that system, it wouldn't need to have this"). Truncating it to
  // "+15 more" would have kept the row while throwing away the only thing it was telling you.
  const PICKUP_MAX = 4;
  // 🔑 Order does NOT reliably encode type — 289 lists interleave stations and planets — so the
  // kind is classified, not inferred from position. Every planet and moon currently in the data;
  // anything else is treated as a station, which is the safe default in both directions: a name
  // we have never seen is far more likely to be a new outpost than a new planet, and a station is
  // the name worth showing anyway (it is where you actually dock to take the contract).
  const PLANETS = new Set([
    "ArcCorp", "Crusader", "Hurston", "microTech",
    "Aberdeen", "Arial", "Calliope", "Cellin", "Clio", "Daymar", "Euterpe", "Ita",
    "Lyria", "Magda", "Wala", "Yela",
    "Monox", "Bloom", "Terminus", "Adir", "Fairo", "Fuego", "Ignis", "Vatra", "Vuur",
  ]);
  const isStation = (n) => !PLANETS.has(n) && !/^(Pyro|Nyx)\s+[IVX]+$/i.test(n);
  function pickupOf(v) {
    const list = v.whereToGet || [];
    if (!list.length || list.length > PICKUP_MAX) return null;
    // Prefer a station: "Checkmate" is somewhere you dock, "Pyro I" is a whole planet.
    const name = list.find(isStation) || list[0];
    // The OTHER places, in order, for the info tooltip. "+3" on its own means nothing to anyone
    // who did not write it (Sub, 2026-08-12) — the count is only useful next to the names.
    const rest = list.filter((p) => p !== name);
    return { name, more: rest.length, all: list.join(" · "), rest };
  }
  // The headline number, given size instead of a label. A fixed payout from the game files is
  // certain and needs no qualifier; a crowdsourced one always states what it rests on.
  //
  // 🔴 THREE TIERS, AND THEY MUST NOT LOOK ALIKE (2026-08-14). The dataset gained a MODELLED
  // payout for the ~2,045 missions the datacore leaves at reward="0", shaped byte-identically
  // to a real one, so until this branched every estimate rendered with the tooltip "A fixed
  // reward, straight from the game files" — a flat untruth for half the catalogue. Measured
  // against real completions the model is wrong ONE TIME IN FOUR, by −79% to +61%.
  //   1. observed  — real players' median. Wins whenever it exists, including over an estimate.
  //   2. fixed     — a real <contractReward> in the game files. Certain.
  //   3. estimated — the model. Marked, dimmed, and never stated as fact.
  // 🔑 The order is deliberate: an estimate is the ONLY tier a single real report outranks, and
  // that is exactly the case the board scanner exists to produce. Never delete the scanner
  // because the model usually agrees — the scanner is what measures whether it still does.
  function payBlock(v) {
    const p = v.community && v.community.payout;
    const fixed = payoutText(v.payout);
    if (!p || !p.samples) {
      if (!fixed) return "";
      // Tier 3: say it is an estimate IN the number, not only in the tooltip. "est." is the
      // shortest thing that cannot be mistaken for part of the figure, and the whole block is
      // dimmed so it reads as weaker than a fixed reward sitting in the same chip row.
      if (v.payoutEstimated) {
        // 🔑 A TILDE, not the word "est." (Sub, 2026-08-14). "~39,750" is understood instantly
        // and costs no width, where a lead-in word competed with the figure it qualified — the
        // same reasoning that moved the sample count into the info affordance. It sits INSIDE
        // .amt so it hugs the number; as a sibling the pill's 5px gap would detach it and it
        // would read as a separate mark rather than as part of the value.
        return '<div class="mi-pay est">'
          + '<span class="amt"><i class="tld">~</i>' + escapeHtml(fixed) + "</span>"
          + info("An ESTIMATE, not a number from the game. The game works this contract's"
              + " reward out when you accept it, so it is not in the game files at all — this is"
              + " calculated from a formula fitted to CIG's own data."
              + "\n\nChecked against real completions it lands within rounding about three times"
              + " in four, and the misses can be large in either direction. Treat it as a"
              + " ballpark until somebody reports what it actually paid.") + "</div>";
      }
      return '<div class="mi-pay">'
        + '<span class="amt">' + escapeHtml(fixed) + "</span>"
        + info("A fixed reward, straight from the game files.") + "</div>";
    }
    const cur = p.currency === "UEC" ? "aUEC" : (p.currency || "");
    const spread = p.samples > 1 && p.max > p.min ? money(p.min) + " – " + money(p.max) : null;
    const note = p.singleContributor && p.samples === 1
      ? "1 report" : reports(p.samples) + (p.singleContributor ? ", one player" : "");
    // 🔑 The evidence moved INTO the affordance (Sub, 2026-08-13). "3 reports · one player" beside
    // the number was a second line of caption competing with the figure it qualified — but it must
    // not be dropped, because how thin the evidence is IS the caveat on the number. So it goes
    // where the rest of this panel already puts its qualifications: the circled i.
    // 🔑 "Unconfirmed" goes in the TOOLTIP, never on the face of the pill (Sub, 2026-08-14) —
    // the panel is already dense and this is a qualification, not a headline. Same call as the
    // sample count, which moved in here on 2026-08-13 for the same reason.
    // Only worth saying while it is genuinely uncorroborated: a scan seen several times is no
    // longer "one unconfirmed read", and repeating the caveat everywhere would train people to
    // ignore it in the one place it matters.
    const lone = p.ocrOnly && p.samples === 1
      ? "\n\nOne unconfirmed board scan — nobody has reported what it actually paid yet, and the"
        + " board rounds what it shows."
      : "";
    const why = "Read off the contract board by players running this. The game works most payouts"
      + " out when you accept, so this is the only place the number exists."
      + "\n\nBased on " + note + (spread ? ". Seen between " + spread + "." : ".") + lone;
    return '<div class="mi-pay">'
      + '<span class="amt">' + money(p.median) + '</span><span class="cur">' + escapeHtml(cur) + "</span>"
      + info(why) + "</div>";
  }
  // 🔑 ARRAY-SHAPED WRAPPERS, KEPT ON PURPOSE. The pills became a keyed object so PILL_ORDER
  // could address each one by name — but `factChips()` is a PUBLIC SHAPE the widget suite calls
  // directly, and quietly turning an array into an object broke it with
  // "factChips(...).map is not a function". A renderer's internal restructure must not change a
  // contract something else depends on: the keyed builders got new names and these two keep the
  // old ones, so the suite and any other caller see exactly what they always did.
  const gameFactChips = (v) => Object.values(gameFactPills(v));
  const factChips = (v) => Object.values(communityPills(v));

  // The conventional circled "i". A plain ASCII letter styled by CSS — this page bundles no emoji
  // face, so a ⓘ character would render at the mercy of the OS font, the same trap that turned o7
  // into a box.
  //
  // 🔑 IT ANSWERS A CLICK AS WELL AS A HOVER (Sub, 2026-08-14). `title` alone is hover-only and
  // there is NO browser API to open one from script, so clicking genuinely did nothing and the
  // affordance had to be discovered. Both now work and neither is a reimplementation of the
  // other: `title` is untouched (so the hover path cannot regress) and a top-layer popover
  // carries the click. Nothing is measured — `popovertarget` does the toggle, light-dismiss and
  // Escape; CSS anchoring does the placement. See the .mi-tip rule for why both of those matter.
  //
  // ⚠️ The two must never be on screen together, so the title is pulled while the popover is open
  // and put back on close — handled by the delegated `beforetoggle` listener below, once for the
  // whole page rather than per element, since these are rebuilt by innerHTML on every render.
  let infoSeq = 0;
  const info = (title) => {
    const id = "mi-tip-" + ++infoSeq, anchor = "--mi-a-" + infoSeq;
    const t = escapeAttr(title);
    return '<button type="button" class="mi-info" popovertarget="' + id + '"'
      + ' style="anchor-name: ' + anchor + '" aria-label="Explain this" title="' + t + '"'
      + ' data-tip="' + t + '">i</button>'
      + '<span class="mi-tip" popover id="' + id + '" style="position-anchor: ' + anchor + '"></span>';
  };
  // Fill the popover on OPEN and empty it on close, and suppress the native tooltip while it is
  // up so a hover-then-click never stacks the two. Title restored from `data-tip`, so nothing
  // depends on the handler having seen the open — an element rebuilt by a re-render simply
  // arrives with its title intact.
  //
  // 🔑 THE TEXT LIVES IN ONE PLACE (`data-tip`) AND IS COPIED IN ONLY WHILE SHOWN. Rendering it
  // into the popover up front put the whole explanation inside the pill's `textContent` — and
  // `npm run test:widgets` caught it immediately: `...and NOT on the face of the pill` reads
  // textContent, which does not care that a closed popover is display:none. The assertion was
  // RIGHT and the honest fix was to stop duplicating the string, not to teach the test to ignore
  // hidden nodes — an assertion narrowed to accommodate a change stops guarding what it was
  // written for. It also keeps ~200 characters per icon out of the DOM on every render.
  // 🔑 CAPTURE phase: `beforetoggle` does NOT bubble, so a normal delegated listener would never
  // fire. Capture still reaches a non-bubbling event on its way down to the target, which is what
  // makes ONE listener enough for icons that innerHTML replaces on every render — per-element
  // handlers would have to be re-attached each time, and the ones that were missed would silently
  // keep both tooltips.
  document.addEventListener("beforetoggle", (e) => {
    const tip = e.target;
    if (!tip?.classList?.contains?.("mi-tip")) return;
    const btn = document.querySelector('[popovertarget="' + CSS.escape(tip.id) + '"]');
    if (!btn) return;
    if (e.newState === "open") {
      tip.textContent = btn.dataset.tip || "";
      btn.removeAttribute("title");
    } else {
      tip.textContent = "";
      if (btn.dataset.tip) btn.setAttribute("title", btn.dataset.tip);
    }
  }, true);

  // ── Mission lookup ────────────────────────────────────────────────────────────────────────
  // Look a contract up without leaving the game. The brief is rendered by missionInfoHtml(), the
  // SAME function the live panel uses, so a searched mission and a tracked one cannot drift into
  // looking like different features — the sidecar's /api/mission-preview returns a view-shaped
  // payload for exactly that reason.
  //
  // 🔴 TYPING HERE TAKES THE KEYBOARD FOR THE WHOLE CANVAS. `notepadEditing` makes canHover true
  // for every widget on every display, so while it is on, no click reaches the game. That is
  // correct for a search box and catastrophic if it is ever left on — it is the same grab that
  // shipped as "the chat app is forcing me to click it" when helpers switched it on and nothing
  // switched it off. So: exactly ONE deliberate act turns it on (the magnifying glass), and
  // closeSearch() is the ONLY way out and is called from every exit — ✕, Escape, picking a
  // result's Back, the widget being hidden, and the panel losing the search entirely.
  const msGrab = (on) => { try { window.overlayApi?.notepadEditing?.(!!on); } catch { /* standalone */ } };
  let msTimer = null, msRows = [];

  function closeSearch() {
    const box = $("msearch");
    if (!box || box.hidden) return;
    box.hidden = true;
    $("msBrief").hidden = true;
    $("msResults").innerHTML = "";
    $("msInput").value = "";
    msRows = [];
    if (msTimer) { clearTimeout(msTimer); msTimer = null; }
    msGrab(false); // unconditional: the one line that must never be skipped
  }
  function openSearch() {
    const box = $("msearch");
    if (!box) return;
    box.hidden = false;
    $("msBrief").hidden = true;
    $("msResults").innerHTML = '<div class="ms-note">Type a mission name.</div>';
    msGrab(true);
    // preventScroll: focusing an element inside a scrollable panel otherwise scrolls it, which
    // has moved absolutely-positioned chrome out from under its own clamp before.
    try { $("msInput").focus({ preventScroll: true }); } catch { $("msInput").focus(); }
  }

  function renderResults(rows) {
    msRows = rows || [];
    if (!msRows.length) {
      $("msResults").innerHTML = '<div class="ms-note">Nothing matched.</div>';
      return;
    }
    // 🔑 Every row says how many contracts share the name. 540 titles cover more than one, and
    // "1 of 253" is the difference between a brief that looks incomplete and one that is honest
    // about what it could not narrow down.
    $("msResults").innerHTML = msRows.map((r, i) => {
      const meta = [];
      if (r.giver) meta.push(escapeHtml(r.giver));
      if (r.variants > 1) meta.push(r.variants + " variants");
      if (r.hasPool) meta.push("blueprints");
      return '<button type="button" class="ms-row" data-i="' + i + '">'
        + '<span class="ms-t">' + escapeHtml(r.title) + "</span>"
        + (meta.length ? '<span class="ms-m">' + meta.join(" · ") + "</span>" : "")
        + "</button>";
    }).join("");
  }

  function runSearch(q) {
    if (!q.trim()) { $("msResults").innerHTML = '<div class="ms-note">Type a mission name.</div>'; return; }
    fetch("/api/mission-search?q=" + encodeURIComponent(q))
      .then((r) => r.json())
      .then((d) => renderResults(d && d.missions))
      .catch(() => { $("msResults").innerHTML = '<div class="ms-note">Search unavailable.</div>'; });
  }

  function showBrief(title) {
    $("msBrief").hidden = false;
    $("msBriefBody").innerHTML = '<div class="ms-note">Loading…</div>';
    fetch("/api/mission-preview?title=" + encodeURIComponent(title))
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (!p) { $("msBriefBody").innerHTML = '<div class="ms-note">No details for that one.</div>'; return; }
        // The preview is view-shaped on purpose, so the live renderer takes it as-is.
        const info = missionInfoHtml(p, true) || '<div class="ms-note">No details for that one.</div>';
        const count = p.variants > 1 ? '<span class="ms-count">1 of ' + p.variants + " variants</span>" : "";
        const pool = p.total > 0
          ? '<div class="ms-note">Blueprint pool — you own ' + p.owned + " of " + p.total
            + (p.ambiguous ? ", merged across variants that drop different pools" : "") + ".</div>"
          : "";
        $("msBriefBody").innerHTML = '<div class="ms-title">' + escapeHtml(p.title) + count + "</div>" + pool + info;
      })
      .catch(() => { $("msBriefBody").innerHTML = '<div class="ms-note">Could not load that mission.</div>'; });
  }

  $("msOpen")?.addEventListener("click", openSearch);
  $("msClose")?.addEventListener("click", closeSearch);
  $("msBack")?.addEventListener("click", () => { $("msBrief").hidden = true; });
  $("msInput")?.addEventListener("input", (e) => {
    const q = e.target.value;
    if (msTimer) clearTimeout(msTimer);
    // Debounced: the dataset lookup is local and cheap, but a request per keystroke would still
    // re-render the list under the caret on every letter.
    msTimer = setTimeout(() => runSearch(q), 140);
  });
  $("msInput")?.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSearch(); });
  $("msResults")?.addEventListener("click", (e) => {
    const row = e.target.closest?.(".ms-row");
    if (!row) return;
    const r = msRows[Number(row.dataset.i)];
    if (r) showBrief(r.title);
  });
  // A 1–5 meter matching the site's mission pages. The rating is a MEAN, so the bar rounds while
  // the number beside it keeps the precision — a bar alone would turn 2.4 and 2.6 into the same
  // picture, and the whole point of the number is telling those apart.
  function difficultyMeter(f) {
    if (!f || f.difficulty == null || !f.difficultyAnswers) return "";
    const lvl = Math.max(1, Math.min(5, Math.round(f.difficulty)));
    let segs = "";
    for (let i = 1; i <= 5; i++) segs += '<i class="' + (i <= lvl ? "on" : "") + '"></i>';
    return '<div class="mi-meter"><span class="k">Difficulty</span>'
      + '<span class="mi-seg" role="img" aria-label="' + f.difficulty + ' out of 5">' + segs + "</span>"
      + '<span class="num">' + f.difficulty + "</span>"
      + info("Averaged from " + reports(f.difficultyAnswers) + " by players who ran this contract. 1 is easy, 5 is hard.")
      + "</div>";
  }
  function chip(text, cls, title) {
    return '<span class="mi-chip' + (cls ? " " + cls : "") + '"'
      + (title ? ' title="' + escapeAttr(title) + '"' : "") + ">" + escapeHtml(text) + "</span>";
  }
  /** A chip carrying a LABEL and a VALUE — what replaced the two-column grid. `html` is already
   *  escaped by the caller (several of these carry an info affordance or a count span). */
  function kchip(label, html, cls, title) {
    return '<span class="mi-chip' + (cls ? " " + cls : "") + '"'
      + (title ? ' title="' + escapeAttr(title) + '"' : "") + ">"
      + '<span class="ck">' + escapeHtml(label) + "</span>"
      + '<span class="cv' + (cls === "pos" || cls === "neg" ? " " + cls : "") + '">' + html + "</span>"
      + "</span>";
  }
  /** What each reputation SCOPE is called in plain words. The dataset carries 17 distinct scopes
   *  and 998 missions award more than one, so a panel that prints only numbers is asking the
   *  player to guess which track each belongs to — the thing that made "+200 / +50" unreadable.
   *  Anything not listed falls back to "Reputation", which is what every scope is a kind of. */
  const SCOPE_LABEL = {
    FactionReputation: "Reputation",
    Affinity: "Affinity",
    // The rest are per-activity tracks; their own word is the useful label.
    BountyHunter: "Bounty hunting", BountyHunter_BountyHuntersGuild: "Guild standing",
    Hauling: "Hauling", Security: "Security", Courier: "Courier", Assassination: "Assassination",
    HiredMuscle: "Hired muscle", Emergency: "Emergency", Technician: "Technician",
    Salvaging: "Salvaging", Smuggling: "Smuggling", Theft: "Theft", Worker: "Worker",
    Maintenance: "Maintenance", HandyMan: "Handyman", Wikelo: "Wikelo",
    MissionProviderReputation_Battaglia: "Battaglia standing",
  };
  // Worded so the chip needs no heading — "Soloable" says what it is, "Soloable: yes" does not
  // say any more (Sub, 2026-08-12).
  const COMBAT_CHIP = { none: "No combat", fps: "On-foot combat", ship: "Ship combat", both: "Ship + on-foot" };
  // ── Contract facts from the game files (mission-facts.<cl>.json) ─────────────────────────────
  // Chips, per Sub's pick of option A1 — no new structure, they join the row that already exists.
  //
  // 🔑 "RETAKE AFTER 15m" IS THE PERSONAL COOLDOWN, and it is not the same thing as the run
  // length: the Ling Hauling contract takes 27 minutes to run and can be retaken 15 minutes after
  // it is finished. An earlier draft showed `boardRespawnMin` here by accident — that is when an
  // EXPIRED offer reappears on the Contract Manager, which Sub correctly cut: nobody watches an
  // offer time out and then waits for it to come back.
  // 🔑 Every chip self-hides. Coverage runs 46–77%, so a fixed set would print blanks on half the
  // catalogue — the same reason the payout row has always been conditional.
  function gameFactPills(v) {
    const f = v && v.facts;
    const out = {};
    if (!f) return out;
    if (f.cd != null) {
      out.retake = chip("Retake after " + f.cd + "m", "time",
        "How long after finishing this contract before you can accept it again"
        + (f.cdVar ? ", give or take " + f.cdVar + " minutes" : "") + ".");
    }
    if (f.dur != null) {
      out.run = chip("~" + f.dur + "m run", null,
        "Roughly how long the contract itself takes — the designers' expected duration, not a cooldown.");
    }
    if (f.diff != null) {
      out.difficulty = chip("Difficulty " + f.diff + "/7", null,
        "CIG's own blended difficulty rating for this contract, on their 1–7 scale.");
    }
    // ⚠️ Only ever asserts the NEGATIVE. An unrecognised contract also has no flag, so "you can
    // retry" is never claimed — the same rule the Illegal chip follows.
    if (f.noRetry) {
      out.noretry = chip("No retry if failed", "crime",
        "Fail this contract and you cannot accept it again.");
    }
    return out;
  }

  function communityPills(v) {
    const f = v.community && v.community.facts;
    const out = {};
    if (!f || !f.samples) return out;
    // 🔑 The sample count is shown ON THE CHIP only while the evidence is THIN, and lives in the
    // tooltip once it is not. Printing "· 14 reports" beside every fact is the clutter Sub was
    // objecting to; hiding it entirely is how one person's opinion starts looking like a fact.
    // Showing it exactly when it is small serves both — the number appears precisely when it is
    // the thing you need to know.
    const THIN = 2;
    const thin = (n) => (n <= THIN ? " · " + reports(n) : "");
    // Difficulty is NOT a chip — it has its own meter row (see difficultyMeter).
    if (f.soloRate != null && f.soloAnswers) {
      // A verdict when it is unanimous, a number when it is not: "100% solo" off two reports is a
      // statistic-shaped way of saying "both of them soloed it".
      const pct = Math.round(f.soloRate * 100);
      const word = pct >= 100 ? "Soloable" : pct <= 0 ? "Needs a group" : pct + "% solo";
      out.solo = chip(word + thin(f.soloAnswers), "said", "From " + reports(f.soloAnswers) + ".");
    }
    // Only a real majority, never a plurality — the site takes the same line, and a 3-2-2 split
    // is not a fact about the mission.
    if (f.combatTop && COMBAT_CHIP[f.combatTop]) {
      out.combat = chip(COMBAT_CHIP[f.combatTop], "said", "What most players who answered reported.");
    }
    return out;
  }
  // Read from the log rather than asked, so there is no "declined to answer" — but an absent
  // ship is NOT "on foot", it is just a ship nobody was seen in. Only report what was seen.
  function flownShip(v) {
    const f = v.community && v.community.facts;
    const s = f && (f.ships || [])[0];
    return s && s.ship ? s.ship : null;
  }

  // `forceOpen` is vestigial — it used to force both drawers open on a pool-less mission so the
  // panel wasn't bare. Nothing collapses any more, so it is accepted and ignored rather than
  // chased through three call sites for no behaviour change.
  function missionInfoHtml(v, _forceOpen) {
    const giver = v.giver, type = v.missionType;
    const rg = v.reputationGained || [], rl = v.reputationLost || [];
    const payTxt = payoutText(v.payout);
    const pickup = pickupOf(v);
    if (!giver && !type && !rg.length && !rl.length && !payTxt && !pickup && !(v.community && v.community.payout)) return "";
    let body = "", facBody = "";
    {
      // ── 1. Chips: everything that explains itself in a word or two ──────────────────────
      // 🔑 Absence is not innocence — an unrecognised mission also reads illegal:false — so this
      // only ever asserts that something IS criminal, never that it is safe.
      // 🔑 Illegal LEADS (Sub, 2026-08-13, swapping it ahead of the type). Whether a contract
      // will earn you a CrimeStat outranks what kind of contract it is — it is the one fact here
      // that changes whether you take the job at all.
      // 🔑 EVERY PILL IS KEYED, and PILL_ORDER below is the single place that decides the row.
      // They used to be pushed in construction order across four different places, so "move the
      // difficulty pill up" meant finding which block built it and re-threading the pushes. Now
      // the build order is irrelevant and the order is data.
      const K = Object.assign({}, gameFactPills(v), communityPills(v));
      if (v.illegal) K.illegal = chip("Illegal", "crime", "Criminal work — expect a CrimeStat for taking this.");
      if (type) K.type = chip(type);

      // ── 2. The money, given size ────────────────────────────────────────────────────────
      // ── 3. Everything that genuinely needs a label, in a tight two-column grid ──────────
      // Two grids now: what the CONTRACT is, and who the FACTION is. Split because they answer
      // different questions and one of them is skippable (Sub, 2026-08-12).
      // 🔴 CHIPS, not a two-column grid (Sub, 2026-08-13, picking option C for both drawers).
      // Every row spent a whole line on a label with the right half of the panel empty; as chips
      // they sit side by side and the same facts take roughly half the height. They also WRAP
      // instead of truncating, so a narrow widget keeps every fact — Sub was explicit that
      // nothing may be dropped for being narrow.
      // `fgrid` is gone: Rank and Reputation moved into the main row (see PILL_ORDER), so the
      // Faction group now carries the faction name and your standing bar only.
      const grid = [];
      const gRow = (k, html, cls) => grid.push(kchip(k, html, cls));
      // 🔑 Only shown once the VARIANT is resolved. Same-title variants are offered in different
      // regions drawing from DIFFERENT pools, so before the tracker knows which one you took,
      // naming places would send you somewhere that cannot drop what this panel lists —
      // view() returns an empty list while ambiguous for exactly that reason.
      if (pickup) {
        // The count keeps the "there are others" signal compact; the info icon is what makes it
        // mean something, by naming them.
        // 🔑 These places are one VARIANT, so they really do draw the pool shown above — but do
        // NOT generalise that to "it doesn't matter where you take it". For 71 titles the place
        // is exactly what decides the pool, which is what the Other pools row below is for.
        gRow("Pick up", escapeHtml(pickup.name)
          + (pickup.more
            ? ' <span class="mi-more">+' + pickup.more + "</span>"
              + info("Also offered at " + listWords(pickup.rest)
                + " — all of these draw the pool shown above.")
            : ""));
      }
      // 🔴 The pools you CANNOT get from here. Same contract name, different region, different
      // blueprints — and finishing the list above is not finishing the contract (Sub, 2026-08-12:
      // "I want people to know that they need to go to other places to wrap this pool up").
      // Only ever present when the pools genuinely differ; 460 of the 540 multi-variant titles
      // are one pool offered in several places, and sending someone across the system for
      // blueprints they can already win here would be worse than saying nothing.
      const others = v.otherPools || [];
      if (others.length) {
        const left = others.reduce((a, o) => a + (o.total - o.owned), 0);
        const where = others
          .map((o) => (o.places.length ? (o.places.find(isStation) || o.places[0]) : "elsewhere"))
          .filter((p, i, a) => a.indexOf(p) === i);
        const detail = others
          .map((o) => (o.places.length ? listWords(o.places.slice(0, 4)) : "another region")
            + " — " + o.owned + " of " + o.total + " owned")
          .join("; ");
        // ⚠️ "2 to go" was wrong, and Sub read it exactly as written: it sounds like two missions,
        // or two of anything. It counts BLUEPRINTS that this contract can only give you somewhere
        // else, so it says that.
        gRow("Other pools", escapeHtml(where.join(" · "))
          + (left ? ' <span class="mi-more">' + left + " only there</span>" : "")
          + info("This contract runs in other regions from a DIFFERENT blueprint pool, so finishing"
            + " the pool above does not finish the contract. Take it from " + detail + "."));
      }
      const ship = flownShip(v);
      if (ship) gRow("Usually flown", escapeHtml(ship));

      // ── Faction Info ────────────────────────────────────────────────────────────────────
      // Faction first, then what it costs you to be liked by them, then where you stand.
      // Reputation sits directly under Faction because it is the same subject (Sub's order).
      // 🔑 The faction is a HEADING, not a chip. The drawer is already called "Faction Info", so a
      // row reading "Faction: Headhunters" spent a line repeating a word you had just read.
      const facName = giver ? '<div class="mi-faction">' + escapeHtml(giver) + "</div>" : "";
      // The rank the GIVER wants — a fact about your relationship with them, so it lives here
      // rather than beside the contract's own details.
      // 🔑 null means the dataset carries no gate, NOT rank 0: givers use 0 and null side by side.
      // 🔑 By NAME where the ladder has one ("Contractor", not "2") — Sub asked for this and the
      // names were already bundled. 93% resolve; the rest fall back to the number rather than
      // inventing a rung.
      if (v.rankRequired != null) {
        K.rank = kchip("Rank needed", escapeHtml(v.rankRequiredName || String(v.rankRequired)), null);
      }
      // Reputation. One chip per scope — see the note in repSection.
      const repSection = (list0, neg, label) => {
        // 🔑 A mission can list SEVERAL awards against the SAME standing — 12 of the 33 Battaglia
        // missions do (200+40, 200+60, 100+60). Rendered raw that's two identical faction names
        // stacked with different numbers, which reads as a bug. The game data carries nothing to
        // say what the second one is for (same faction, same scope, no label), so we don't invent
        // a story: show the larger — the one the standing estimate actually credits — and disclose
        // the rest instead of hiding it. Sub's read was that they don't simply add to +360.
        const list = collapseSameStanding(list0);
        if (!list.length) return;
        // 🔴 NAME THE SCOPE. This used to render every award for the same faction as a bare
        // number, so a Headhunters contract read "Headhunters +200 / Headhunters +50" — the same
        // name twice with no explanation, which is exactly what Sub could not make sense of.
        // The data DOES say what they are: the two entries carry different `scope` values,
        // FactionReputation and Affinity. They are separate tracks, which is why they don't add
        // to 250. Affinity appears 1,222 times across the dataset — it is not an anomaly.
        // 🔑 One chip per scope, labelled with the scope's own word, and the faction named only
        // when it ISN'T the giver (rep with someone else is the surprising case worth spelling
        // out; rep with the contract's own faction is not).
        for (const r of list) {
          const amt = (neg ? "−" : "+") + Number(r.amount || 0).toLocaleString();
          const own = !r.faction || r.faction === giver;
          const scopeWord = SCOPE_LABEL[r.scope] || (neg ? "Rep lost" : "Reputation");
          const label = own ? scopeWord : (r.faction + " " + scopeWord.toLowerCase());
          // Several scopes can pay out, so reputation is a LIST under one key rather than one
          // pill — the order below places the group, and the scopes keep their own order in it.
          (K.rep || (K.rep = [])).push(kchip(label, amt + extraHint(r), neg ? "neg" : "pos"));
        }
      };
      repSection(rg, false, "Reputation");
      repSection(rl, true, "Rep lost");

      // ── 4. Standing: its own group behind a rule ────────────────────────────────────────
      // A different KIND of fact — it is about you, not about the contract (Sub, 2026-08-12).
      let standing = "";
      if (v.repBar) {
        standing = repBarHtml(v.repBar);
      } else if (v.inferredRank != null) {
        standing = '<div class="mi-row" title="Lowest rank you must be — the game only offers this giver&#39;s rank-'
          + v.inferredRank + ' missions at that standing. Your exact rep isn&#39;t in the game log.">'
          + '<span class="mi-k">Your rank</span><span class="mi-v">' + v.inferredRank
          + '+ <span class="mi-hint">inferred</span></span></div>';
      }

      // Through to the full write-up. Only when we actually resolved WHICH contract this is —
      // an ambiguous one would link to a page describing a different variant, and the site
      // 404s on a key it does not know.
      const link = v.contractKey && !v.ambiguous
        ? '<a class="mi-chip mi-link" href="https://subliminal.gg/missions/' + encodeURIComponent(v.contractKey)
          + '" target="_blank" rel="noopener" title="Open this contract on subliminal.gg">More on the site →</a>'
        : "";

      // 🔑 ONE chip row, not two (Sub, 2026-08-13: "why can't Pick up at Checkmate be on the same
      // row as Illegal and Mercenary? I have my widget plenty wide enough"). They were two
      // separate containers — self-describing chips, then the labelled ones — so the second set
      // always started a new line no matter how much room was left on the first. They are the
      // same kind of thing and now share a container, wrapping only when they genuinely run out
      // of width. The link is the last chip in that row for the same reason.
      // 🔑 The payout rides IN the chip row, straight after what KIND of contract it is (Sub,
      // 2026-08-13). It had a line of its own directly under the chips, which on a wide widget
      // was a nearly-empty row holding one number — the money belongs beside the facts that
      // describe the job, not stacked beneath them.
      const pay = payBlock(v);
      if (pay) K.payout = pay;
      if (link) K.site = link;
      // `grid` keeps its own internal order (pick up, then other pools, then usually flown) —
      // those three are built as a sequence and Sub ordered them as a block.
      K.grid = grid;

      // 🔴 THE ROW ORDER, AND THE ONLY PLACE IT IS DECIDED (Sub, 2026-08-14). To change the row,
      // move a line here — nothing else. Reads top-to-bottom as it renders left-to-right.
      //
      // 🔑 Reputation and Rank moved OUT of the Faction group into the main row, which is the one
      // structural consequence of this order: that group now holds the faction name and your
      // standing bar only. It still coheres — who you are working for and where you stand with
      // them — but it is a smaller block than it was, and the rule above it now separates less.
      // 🔑 The payout keeps its own larger treatment; it is placed IN the row, not turned into a
      // plain chip, so the one number people scan for still reads as the headline.
      const PILL_ORDER = [
        "illegal",     // is it criminal work
        "type",        // what kind of contract
        "difficulty",  // how hard the game files call it
        "solo",        // player-reported
        "combat",      // player-reported
        "payout",      // the money
        "rep",         // standing awarded (a list — one per scope)
        "rank",        // standing required
        "retake",      // wait before you can take it again
        "noretry",     // fail and you are locked out
        "run",         // how long a run takes
        "grid",        // pick up · other pools · usually flown
        "site",        // through to the full write-up
      ];
      const allChips = PILL_ORDER.flatMap((k) => {
        const v2 = K[k];
        return v2 == null ? [] : Array.isArray(v2) ? v2 : [v2];
      });
      body = '<div class="mi-body">'
        + (allChips.length ? '<div class="mi-chips">' + allChips.join("") + "</div>" : "")
        + difficultyMeter(v.community && v.community.facts)
        + "</div>";
      facBody = '<div class="mi-body">'
        + facName

        + (standing ? '<div class="mi-standing">' + standing + "</div>" : "")
        + "</div>";
      // A group with nothing in it is worse than no group — don't draw an empty drawer header.
      //
      // 🔴 THE GIVER'S NAME IS CONTENT. This used to read `if (!standing) facBody = null`, which
      // threw the whole group away — INCLUDING facName — whenever there was no standing bar. That
      // was sound when the group held name + standing + rank + reputation; once Rank and
      // Reputation moved out into the main row (2026-08-14) the group became name + standing, and
      // "no standing" started meaning "hide who you are working for".
      // It bites every giver with no rep scope, which is not a corner case: all 13 Orison Relief
      // contracts carry `reputationGained: []`, so the entire 4.10 event ran with its giver
      // invisible. Sub, running one: "we're missing the data from like the mission giver... it
      // just looks kind of blank."
      // Drop the group only when it genuinely has nothing — no name AND no standing.
      if (!standing && !facName) facBody = null;
    }
    // 🔑 NO DRAWERS. These were two collapsible sections with headers and carets, because the
    // label/value rows they used to hold ran long enough that someone might want them out of the
    // way (Sub, 2026-08-12: "maybe somebody doesn't care about the Faction Info"). As chips they
    // take roughly half the height, so there is nothing left worth hiding — and a header plus a
    // caret to collapse three chips costs more space than the chips do (Sub, 2026-08-13).
    // The faction's own name still leads its group, so the two subjects stay legible without
    // chrome announcing them.
    const section = (html) => (html === null ? "" : '<div class="mi">' + html + "</div>");
    return section(body) + section(facBody);
  }

  // Payout line + ITEM rewards (actual items — not blueprints; display-only).
  /**
   * Blueprints we recorded but could not name.
   *
   * 🔑 It shows the RAW string the game wrote, verbatim and in monospace. That is the whole
   * design: "Glacier Military A" or "Omnisky-III-Kanone" sitting there explains the cause
   * without anyone having to read the sentence above it, and turns a support report from
   * "your app is broken" into "my language file renames things". A count alone ("3 unknown")
   * would be a shrug.
   *
   * ONE banner, never one per row — a wall of warnings is worse than a single clear one. And
   * Calibrate is offered only when a modified language file is actually present: on a stock
   * install there is nothing to recalibrate against, so the button would be a dead end.
   */
  function unrecognizedHtml(v) {
    const u = v.unrecognized;
    if (!u || !u.names || !u.names.length) return "";
    const list = u.names.map((n) => "<li>" + escapeHtml(n) + "</li>").join("");
    const why = u.packActive
      ? "Your game's language file renames items, and these names are not in it — it may have been updated since the app last read it."
      : "Your game logged these blueprint names, but they match nothing in the current patch's data.";
    return '<div class="unrec">⚠ ' + escapeHtml(v.unrecognized.names.length === 1 ? "1 blueprint could not be identified" : u.names.length + " blueprints could not be identified")
      + " " + info(why + " They are not counted in your pools.")
      + "<ul>" + list + "</ul>"
      + (u.packActive ? '<button type="button" class="unrec-cal" id="unrecCal">Recalibrate from my language file</button>' : "")
      + "</div>";
  }

  // Delegated, because the banner is rebuilt by innerHTML on every render — a listener bound to
  // the button itself would be thrown away by the next frame.
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest && e.target.closest("#unrecCal");
    if (!btn) return;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Reading your language file…";
    try {
      const r = await (await fetch("/api/localization/calibrate", { method: "POST" })).json();
      // The seed re-runs server-side, so anything now resolvable has already been re-credited
      // and the next view frame simply arrives without it.
      btn.textContent = r && r.entries ? "Done — " + r.entries + " names loaded" : "Done";
    } catch {
      btn.textContent = "Could not read it — is the game installed where the app is pointed?";
      btn.disabled = false;
    }
  });

  function rewardsHtml(v) {
    // Physical item rewards (actual items/ships, NOT blueprints). The log never reports item
    // awards, so ticking is MANUAL + local-only — it never touches the blueprint count or sync.
    // Ticking one confirms you got it and tucks it under the "Received" disclosure so it leaves
    // the main view (recoverable — expand to un-tick a misclick).
    const items = v.itemRewards || [];
    if (!items.length) return "";
    const need = items.filter((i) => !i.owned);
    const got = items.filter((i) => i.owned);
    const itemRow = (it) =>
      '<div class="row ' + (it.owned ? "owned" : "") + '" data-item="' + escapeAttr(it.name) + '" title="Manual — tick it once it\'s in your hangar">' +
        '<span class="mark">' + (it.owned ? "✔" : "") + "</span>" +
        '<span class="name">' + escapeHtml(it.name) + "</span>" +
        (it.amount > 1 ? '<span class="chance">×' + it.amount + "</span>" : "") +
      "</div>";
    const parts = ['<div class="poolhead">Physical Rewards<span class="ph-sub">not a blueprint · tick when you get it</span></div>'];
    for (const it of need) parts.push(itemRow(it));
    if (got.length) {
      parts.push('<div class="grphead" data-grp="gotitems"><span class="car">' + (physOpen ? "▾" : "▸") + '</span>Received<span class="gcnt">' + got.length + "</span></div>");
      if (physOpen) for (const it of got) parts.push(itemRow(it));
    }
    return '<div class="rew">' + parts.join("") + "</div>";
  }

  // m:ss for a mission duration. Used by the mission report below (the old in-panel summary
  // card this comment used to describe is gone — the report replaced it).
  function fmtDur(ms){ if(ms==null) return null; const s=Math.max(0,Math.round(ms/1000)); const m=Math.floor(s/60); return m+":"+String(s%60).padStart(2,"0"); }

  // ── Mission report ──────────────────────────────────────────────────────────────────────
  // The after-mission card. It TAKES OVER this widget for ~40s, then uncovers it. Driven by
  // v.completion, which during its hold describes the mission that just ENDED regardless of
  // which mission the panel is tracking — so a player running several contracts at once gets a
  // report for the one they actually finished, not the one they happen to have pinned.
  // This is the ONLY completion summary; the old in-panel `.cc` card was deleted, not hidden.
  const REPORT_HOLD_MS = 40000;
  // Once someone touches the card the countdown is cancelled — Sub's rule: "if they start
  // interacting with it, let it stay up". This is the ceiling on that, NOT a second countdown:
  // a card that can never close is the trapped-user bug this project keeps rediscovering.
  //
  // 🔑 The ceiling only runs while the player is AWAY — pointer off the card and the overlay
  // window not focused. It used to be a flat three minutes from the last click, which expired
  // on someone who answered the first question, alt-tabbed into the game for a couple of
  // minutes, and came back to finish: the card was gone and the remaining questions could
  // never be answered (Sub, 2026-08-09: "will it eventually time out and not let me select
  // whether or not I did it solo? that's what happened to me sometimes").
  //
  // Answers are POSTed per click, so nothing already given was lost — what was lost was the
  // chance to give the rest, which is the crowdsourced data the card exists to collect.
  //
  // The anti-trap guarantee is intact and is why this is a pause rather than a removal:
  // the timer is ARMED by default and re-arms the moment you leave, so a card you walk away
  // from still tidies itself up. Ten minutes rather than three, because "alt-tab, fly the next
  // leg, come back and finish answering" is the behaviour being supported and three was inside
  // it. The ceiling only has to beat "forgotten", not "busy".
  const REPORT_MAX_MS = 600000;
  // 🔑 mrCard is the completion the card was BUILT from, and it is why this is not read off
  // `current.completion`. The card deliberately outlives that: the server holds a completion for
  // 30s, the card for 40s, and indefinitely once you touch it. So `current.completion` goes NULL
  // with the card still on screen — and every re-render guarded on it silently stopped happening.
  // Answers kept saving and kept POSTing; only the repaint was skipped, so selecting an option did
  // nothing VISIBLE and an answer already given could not be changed. Close still worked, because
  // its handler never reads the completion — which is what made it look like a stacking bug
  // (Sub, 2026-08-10: "that's the only button I can click"). Hold the object, don't re-fetch it.
  let mrAt = null, mrTimer = null, mrRaf = null, mrContract = null, mrAnswers = {}, mrCard = null;

  const DIFFICULTY = [[1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"]];
  const COMBAT_OPTS = [["fps", "On foot"], ["ship", "Ship"], ["mixed", "Both"], ["none", "No combat"]];
  const COMBAT_SAYS = { fps: "on-foot combat", ship: "ship combat", mixed: "on-foot and ship combat", none: "no combat" };

  function mrStat(val, lbl) {
    return '<div class="mr-stat"><div class="mr-val">' + escapeHtml(val) + '</div><div class="mr-slbl">' + escapeHtml(lbl) + '</div></div>';
  }

  function reportBody(c) {
    const meta = [];
    if (c.giver) meta.push("<b>" + escapeHtml(c.giver) + "</b>");
    if (c.missionType) meta.push(escapeHtml(c.missionType));
    if (c.rank != null) meta.push("rank " + c.rank);
    let h = '<div class="mr-title">' + escapeHtml(c.title || "Mission") + "</div>";
    if (meta.length) h += '<div class="mr-meta">' + meta.join(" · ") + "</div>";

    const stats = [];
    // 🔑 THE SAME RANKING AS THE WEBSITE, and the LABEL is what carries the provenance. The
    // number is the same size in every tier, so a player is never asked to read a caveat before
    // trusting a figure — the word under it says where it came from:
    //   1. what the game logged you were paid  → "aUEC"        (certain, this run)
    //   2. what players have reported          → "reported"    (the only truth for a
    //                                                           calculated-reward contract)
    //   3. a fixed reward in the game files    → "payout"      (certain, authored by CIG)
    //   4. the fitted model                    → "estimated"   (~, wrong ~1 in 4)
    // 🔴 Tier 4 must never wear tier 3's label. Every modelled payout is shaped `min === max`,
    // so before this branched it rendered identically to a real fixed reward on a card that
    // reads as "here is what you just earned".
    if (c.aUEC != null) {
      stats.push(mrStat("+" + c.aUEC.toLocaleString(), "aUEC"));
    } else if (mrCommunityPay && mrCommunityPay.samples) {
      const cur = mrCommunityPay.currency === "MER" ? "merits" : "aUEC";
      stats.push(mrStat("~" + Number(mrCommunityPay.median).toLocaleString() + " " + cur, "reported"));
    } else {
      const pt = payoutText(c.payout);
      if (pt) stats.push(mrStat(c.payoutEstimated ? "~" + pt : pt, c.payoutEstimated ? "estimated" : "payout"));
    }
    const dur = fmtDur(c.durationMs);
    if (dur) stats.push(mrStat(dur, "time"));
    // 🔑 Option B1 (Sub's pick): one more stat tile rather than a new row. It answers the question
    // the pool bar below immediately raises — "can I just run that again?" — and it is the
    // PERSONAL COOLDOWN, the wait after finishing, not the board-respawn timer that was cut.
    // Self-hides on the 45% of contracts with no cooldown in the game files.
    if (c.facts && c.facts.cd != null) stats.push(mrStat(c.facts.cd + "m", "retake in"));
    // Only meaningful next to a payout, and deliberately absent on calculated-reward missions
    // rather than shown as a zero — see completionRate().
    if (c.aUecPerHour != null) stats.push(mrStat(Math.round(c.aUecPerHour / 1000) + "k", "aUEC/hr"));
    if (c.timesCompleted) stats.push(mrStat("×" + c.timesCompleted, "completed"));
    const bps = c.blueprints || [];
    if (bps.length) stats.push(mrStat("+" + bps.length, "blueprint" + (bps.length > 1 ? "s" : "")));
    if (stats.length) h += '<div class="mr-stats">' + stats.join("") + "</div>";

    if (bps.length) {
      // 🔑 The floor is 2, not 1. A single drop used to get a full-width hero tile, which on a
      // 380px panel is an enormous picture of one helmet — Sub: make it "the same size as if
      // they had unlocked two", i.e. half. Laying one tile into a 2-column grid gives exactly
      // that cell size with no separate single-drop rule to keep in step.
      const cols = Math.min(Math.max(bps.length, 2), 3);
      h += '<div class="mr-bps" style="--cols:' + cols + '">' + bps.map(mrBpTile).join("") + "</div>";
    }

    // Pool standing AFTER the run — the single most on-brand thing this card can say, and the
    // reason someone runs the mission again.
    if (c.poolProgress && c.poolProgress.total > 0) {
      const p = c.poolProgress, pct = Math.round((p.owned / p.total) * 100);
      h += '<div class="mr-pool"><div class="mr-poolhead">Blueprint pool<b>' + p.owned + " / " + p.total + "</b></div>" +
           '<div class="mr-track"><i style="width:' + pct + '%"></i></div></div>';
    }

    if (c.reputationGained && c.reputationGained.length) {
      // `faction` is the readable name; `scope` is the internal ladder id ("FactionReputation").
      const r = c.reputationGained.map((x) => escapeHtml(x.faction || x.scope) + " +" + x.amount).join(" · ");
      h += '<div class="mr-meta" style="margin-top:9px">Reputation ' + r + "</div>";
    }

    return h; // the ask block is rendered separately into its own pinned slot
  }

  function mrBpTile(b) {
    const first = b.image || b.imageFallback, second = b.image ? b.imageFallback : null;
    // Chain the fallback with a FLAG, never by comparing img.src to the fallback URL — .src
    // reads back absolute, so a relative fallback never compares equal and the handler
    // re-sets the same broken source forever.
    const onerr = second
      ? "if(!this.dataset.fb){this.dataset.fb=1;this.src=this.getAttribute('data-alt');return;}this.parentElement.classList.add('noimg');this.remove()"
      : "this.parentElement.classList.add('noimg');this.remove()";
    const thumb = first
      ? '<span class="mr-bp-thumb"><img src="' + escapeHtml(first) + '"' + (second ? ' data-alt="' + escapeHtml(second) + '"' : "") +
        ' alt="" onerror="' + onerr + '"></span>'
      : '<span class="mr-bp-thumb noimg"></span>';
    return '<div class="mr-bp">' + thumb + '<span class="mr-bp-name">' + escapeHtml(b.name || "Blueprint") + "</span></div>";
  }

  // The crowdsourcing block. Nothing here is required and there is no submit button — each
  // control posts on click, and ignoring the whole section is how you opt out.
  function reportAsk(c) {
    if (!c.contractKey) return ""; // never resolved to a dataset mission — nothing to file against
    let h = '<div class="mr-ask"><div class="mr-askhead">Help everyone else</div>';

    const known = c.classification && c.classification.combat;
    if (known) {
      // Already answered by the game files (59% of missions) — so state it as a fact instead of
      // asking. Telling the player what we know is worth more than a redundant question.
      h += '<div class="mr-known">Game data says this is <b>' + COMBAT_SAYS[known] + "</b>.</div>";
    } else {
      h += '<div class="mr-q"><div class="mr-qlbl">What did this mission involve?</div><div class="mr-opts">' +
        COMBAT_OPTS.map(([v, l]) => '<span class="mr-opt' + (mrAnswers.combat === v ? " on" : "") + '" data-q="combat" data-v="' + v + '">' + l + "</span>").join("") +
        "</div></div>";
    }

    h += '<div class="mr-q"><div class="mr-qlbl">How hard was it?</div><div class="mr-opts mr-scale">' +
      DIFFICULTY.map(([v, l]) => '<span class="mr-opt' + (mrAnswers.difficulty === v ? " on" : "") + '" data-q="difficulty" data-v="' + v + '">' + l + "</span>").join("") +
      '</div><div class="mr-ends"><span>Trivial</span><span>Brutal</span></div></div>';

    h += '<div class="mr-q"><div class="mr-qlbl">Did you run it solo?</div><div class="mr-opts">' +
      [["1", "Solo"], ["0", "With a crew"]].map(([v, l]) =>
        '<span class="mr-opt' + (mrAnswers.solo === (v === "1") ? " on" : "") + '" data-q="solo" data-v="' + v + '">' + l + "</span>").join("") +
      "</div></div>";

    if (mrAnswers.saved) h += '<div class="mr-thanks">Thanks — that\'s saved.</div>';
    return h + "</div>";
  }

  // 🔑 The report lives INSIDE #panel, and `body.bp-hidden #panel {display:none}` means a closed
  // Mission & BP Tracker would make it structurally impossible to show — a regression the earlier
  // screen-centred version did not have. Someone who closes the widget would silently stop seeing
  // what they unlocked and stop being asked anything. So the report un-hides the panel for its own
  // duration and puts it back exactly as it was; `w.s.visible` is never touched, so the user's
  // actual preference survives, and the restore is unconditional so it cannot strand the panel open.
  let mrForcedPanel = false;
  function showReport(c) {
    if (document.body.classList.contains("bp-hidden")) {
      document.body.classList.remove("bp-hidden");
      mrForcedPanel = true;
    }
    // Lift the tracker above every other widget while the card is up — see #panel.canvas.mr-open.
    $("panel")?.classList.add("mr-open");
    mrContract = c.contractKey;
    mrCard = c;
    mrAnswers = {};
    // Pre-select whatever this player said last time about this contract, so a re-run shows
    // their own answer rather than asking the same question from blank.
    if (c.contractKey) {
      fetch("/api/mission-feedback?key=" + encodeURIComponent(c.contractKey))
        .then((r) => r.json())
        .then((d) => {
          if (!d || !d.answer || mrContract !== c.contractKey) return;
          if (d.answer.combat) mrAnswers.combat = d.answer.combat;
          if (d.answer.difficulty) mrAnswers.difficulty = d.answer.difficulty;
          if (d.answer.solo != null) mrAnswers.solo = d.answer.solo;
          $("mrAsk").innerHTML = reportAsk(c);
        })
        .catch(() => { /* no prefill — the questions just start blank */ });
    }
    // No abandoned variant any more — an abandon never produces a completion at all.
    $("mrBody").innerHTML = reportBody(c);
    $("mrAsk").innerHTML = reportAsk(c);
    const box = $("mreport");
    box.classList.remove("answered");
    mrAnswered = false;   // a new completion starts on the plain countdown, not the ceiling
    box.classList.add("show");
    mrCountdown(REPORT_HOLD_MS);
  }

  // Show the card once per completion. `at` is the identity — without it every view tick during
  // the 30s server-side hold would restart the countdown and the card would never expire.
  // The card outlives v.completion on purpose: the server holds for 30s, the report for 40s,
  // and a card that vanished mid-answer would throw away the answer.
  //
  // 🔑 But a completion is NOT complete when it fires. The game logs "Contract Complete" and
  // then "Received Blueprint" about half a second later, so the card is necessarily built
  // before the drop is known and `blueprints` is empty at that instant (reproduced: [] at
  // completion, populated 0.5s on). Rendering once per `at` meant the blueprint you just
  // unlocked never appeared. So the body re-renders while the SAME completion is showing
  // whenever its contents change — without touching the countdown, and without disturbing
  // answers, which are re-derived from mrAnswers rather than read out of the DOM.
  // 🔑 The community payout is IN the signature. `communityFor()` is a cached async fetch, so on
  // a first-seen contract it resolves AFTER the card is already up — without this the card would
  // keep showing the estimate for its whole life even though the real reported figure had
  // arrived, which is the one case the tiering exists for.
  function reportSig(c, cpay) {
    return [c.at, (c.blueprints || []).map((b) => b.name).join("|"), c.aUEC,
            c.poolProgress ? c.poolProgress.owned + "/" + c.poolProgress.total : "", c.timesCompleted,
            cpay ? cpay.median + "/" + cpay.samples : ""].join("~");
  }
  let mrSig = "";
  // The resolved community payout for the card currently up. Held rather than re-read for the
  // same reason `mrCard` is: the card outlives `v.completion`, so anything re-derived from the
  // live view at render time goes null out from under it.
  let mrCommunityPay = null;
  // 🔑 Wrapped, and it REPORTS to the sidecar. This window is a detached GUI process: a throw in
  // here shows nothing, logs nothing, and leaves a missing card indistinguishable from a card the
  // tracker never sent — which is exactly the hole a real missed report (2026-07-31T01:33:50Z)
  // fell into. The sidecar side already logs that it built the card, so the pair of lines says
  // which half failed. Diagnostics must go to sidecar.log; console.log here goes nowhere.
  function mrNote(msg) {
    try { fetch("/api/dev/note?msg=" + encodeURIComponent(msg)).catch(() => {}); } catch { /* never break render */ }
  }
  function renderReport(v) {
    const c = v.completion;
    if (!c) return;
    try {
      // During the hold `v.contractKey` IS the completed mission, so the view's community block
      // already describes this contract — no second lookup needed.
      const cpay = (v.community && v.community.payout) || null;
      if (c.at !== mrAt) {
        mrAt = c.at; mrCommunityPay = cpay; mrSig = reportSig(c, cpay);
        showReport(c);
        mrNote('report shown for "' + (c.title || "?") + '"');
        return;
      }
      const sig = reportSig(c, cpay);
      if (sig === mrSig) return;
      mrSig = sig;
      mrCommunityPay = cpay;
      if ($("mreport").classList.contains("show")) { mrCard = c; $("mrBody").innerHTML = reportBody(c); $("mrAsk").innerHTML = reportAsk(c); }
    } catch (err) {
      mrNote("report FAILED to render: " + (err && err.message ? err.message : err));
    }
  }

  // The hairline countdown. Driven by rAF against a real deadline rather than a CSS transition
  // so cancelling it mid-flight leaves the bar where it is instead of snapping.
  function mrCountdown(ms) {
    const bar = $("mrBar"), end = Date.now() + ms;
    if (mrTimer) clearTimeout(mrTimer);
    if (mrRaf) cancelAnimationFrame(mrRaf);
    const tick = () => {
      const left = Math.max(0, end - Date.now());
      bar.style.transform = "scaleX(" + (left / ms) + ")";
      if (left > 0) mrRaf = requestAnimationFrame(tick);
    };
    tick();
    mrTimer = setTimeout(hideReport, ms);
  }

  /* The post-interaction ceiling. Runs only while the card is unattended: the pointer is off it
     AND the overlay window doesn't have focus. Either of those means the player is still with
     it, and a card that vanishes out from under someone mid-answer is the bug this replaced. */
  let mrAnswered = false, mrHovered = false, mrWinFocused = false;
  function armReportCeiling() {
    if (!mrAnswered) return;
    if (mrTimer) { clearTimeout(mrTimer); mrTimer = null; }
    if (mrHovered || mrWinFocused) return;      // being used — no deadline while that's true
    mrTimer = setTimeout(hideReport, REPORT_MAX_MS);
  }
  {
    const card = $("mreport");
    card.addEventListener("mouseenter", () => { mrHovered = true; armReportCeiling(); });
    card.addEventListener("mouseleave", () => { mrHovered = false; armReportCeiling(); });
    // Alt-tabbing to the overlay is "I am dealing with this now"; alt-tabbing away re-arms.
    // 🔑 Plain window events, not the shell's focus IPC: this has to hold in the widget harness
    // and in a browser tab too, where overlayApi doesn't exist at all.
    window.addEventListener("focus", () => { mrWinFocused = true; armReportCeiling(); });
    window.addEventListener("blur", () => { mrWinFocused = false; armReportCeiling(); });
  }

  function hideReport() {
    if (mrTimer) { clearTimeout(mrTimer); mrTimer = null; }
    if (mrRaf) { cancelAnimationFrame(mrRaf); mrRaf = null; }
    mrAnswered = false;
    $("mreport").classList.remove("show");
    $("panel")?.classList.remove("mr-open"); // back into the normal stacking order
    if (mrForcedPanel) { document.body.classList.add("bp-hidden"); mrForcedPanel = false; }
    // 🔑 mrAt is NOT cleared. It's the "already shown this completion" marker, and the server
    // keeps serving v.completion for its full 30s hold — so clearing it here would make the very
    // next view tick decide this was a new completion and pop the card straight back up. A ✕ has
    // to mean gone.
    mrContract = null; mrAnswers = {}; mrCard = null;
  }

  // `?harness=1` = the widget DOM suite, which drives the LIVE sidecar and the LIVE config. A stray
  // synthetic click on a question would file a rating no human ever gave, straight into the
  // crowdsourced set — the one kind of corruption that can't be spotted later, because a fabricated
  // answer looks exactly like a real one.
  const MR_HARNESS = new URLSearchParams(location.search).has("harness");
  function sendFeedback() {
    if (!mrContract || MR_HARNESS) return;
    fetch("/api/mission-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractKey: mrContract,
        combat: mrAnswers.combat ?? null,
        difficulty: mrAnswers.difficulty ?? null,
        solo: mrAnswers.solo ?? null,
      }),
    }).then((r) => { if (r.ok) { mrAnswers.saved = true; } })
      // saved stays false, so the card never claims a save that didn't happen — and any later
      // answer click re-posts all three fields, so a dropped request heals itself.
      .catch(() => {});
  }

  $("mrX").addEventListener("click", hideReport);
  $("mrClose").addEventListener("click", hideReport);
  $("mreport").addEventListener("click", (e) => {
    const opt = e.target.closest(".mr-opt");
    if (!opt) return;
    const q = opt.dataset.q, raw = opt.dataset.v;
    // Clicking the selected value again clears it — an accidental tap must be undoable, or the
    // first answer someone gives is permanent and the data is worse for it.
    if (q === "difficulty") { const v = Number(raw); mrAnswers.difficulty = mrAnswers.difficulty === v ? null : v; }
    else if (q === "solo") { const v = raw === "1"; mrAnswers.solo = mrAnswers.solo === v ? null : v; }
    else { mrAnswers.combat = mrAnswers.combat === raw ? null : raw; }
    sendFeedback();
    // Interaction cancels the countdown (Sub's rule) — replaced by the ceiling, not by nothing.
    $("mreport").classList.add("answered");
    if (mrRaf) { cancelAnimationFrame(mrRaf); mrRaf = null; }
    mrAnswered = true;
    armReportCeiling();
    if (mrCard) $("mrAsk").innerHTML = reportAsk(mrCard); // only the answers change; leave the summary alone
  });

  // Mission picker: the log can't tell us which mission you've *selected* to track,
  // so list every accepted mission and let you choose. Auto = newest with a pool.
  function renderPicker(v) {
    const pick = $("missionPick");
    const list = v.missions || [];
    // 🔑 The title is ALWAYS on screen now — it is the heading, not the control's label — so an
    // empty list drops the affordance instead of hiding the element. `render()` owns the text;
    // this function owns only whether it can be clicked and how the choice was made.
    pick.classList.toggle("nopick", list.length < 1);
    // "auto" = no pinned mission, so the newest one with blueprints is being followed.
    document.querySelector(".titlerow")?.classList.toggle("is-auto", !v.selectedId && !!v.title);
    if (list.length < 1) { $("missionMenu").innerHTML = ""; return; }
    // Disambiguate duplicate mission titles with a (1)/(2) suffix.
    const counts = {}; list.forEach((m) => (counts[m.title] = (counts[m.title] || 0) + 1));
    const seen = {};
    // 🔑 THREE STATES, not two. Auto (no pick) follows the newest pooled mission; a mission pins
    // that one; and "None" parks the panel on the idle screen. Sub, 2026-08-15: there was no way
    // back to the idle screen once anything was accepted, because clearing the pick means AUTO and
    // auto immediately re-picks. It sits directly under Auto, since both are answers to "don't
    // show me a specific mission".
    const rows = [
      '<div class="opt' + (v.selectedId ? "" : " active") + '" data-id="">Auto — newest with blueprints</div>',
      '<div class="opt' + (v.selectedId === "__idle__" ? " active" : "") + '" data-id="__idle__">None — back to the idle screen</div>',
    ];
    for (const m of list) {
      let label = (m.hasPool ? "◆ " : "○ ") + m.title;
      if (counts[m.title] > 1) { seen[m.title] = (seen[m.title] || 0) + 1; label += " (" + seen[m.title] + ")"; }
      rows.push('<div class="opt' + (v.selectedId === m.id ? " active" : "") + '" data-id="' + escapeAttr(m.id) + '">' + escapeHtml(label) + "</div>");
    }
    $("missionMenu").innerHTML = rows.join("");
  }
  $("missionBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    if ($("missionPick").classList.contains("nopick")) return; // nothing to choose from
    $("missionMenu").classList.toggle("open");
  });
  $("missionMenu").addEventListener("click", (e) => {
    const opt = e.target.closest(".opt");
    if (!opt) return;
    fetch("/api/missions/select", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missionId: opt.getAttribute("data-id") }),
    });
    $("missionMenu").classList.remove("open");
  });
  document.addEventListener("click", () => $("missionMenu").classList.remove("open"));

  function setOwned(name, owned) {
    fetch("/api/missions/own", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, owned }),
    });
  }

  // Guaranteed ITEM rewards — manual, local-only tick (never counted/synced).
  function setGuaranteedOwned(name, owned) {
    fetch("/api/missions/own-item", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, owned }),
    });
  }

  // Click a blueprint to manually toggle owned (seeds pre-existing inventory).
  // Marking owned is one click; UN-marking asks first, so an accidental click while
  // looking at an item can't silently wipe a blueprint you actually own.
  $("pool").addEventListener("click", (e) => {
    // The "Mission Info" drawer header toggles its details. Only collapsible on a
    // pooled mission — pool-less missions force it open, so a click there is a no-op.
    // (#miHead / #facHead — the two drawer headers — were removed on 2026-08-13 along with their
    // collapse state; the chip layout is short enough that there is nothing to fold away.)
    // Through to the mission's page on subliminal.gg. The shell opens it in the real browser —
    // a second always-on-top window over the game is the last thing anyone wants. Standalone
    // (OBS source, product page) there is no shell, so the plain href does the work.
    const site = e.target.closest(".mi-link");
    if (site && window.overlayApi && window.overlayApi.openUrl) {
      e.preventDefault();
      window.overlayApi.openUrl(site.getAttribute("href"));
      return;
    }
    // Blueprint-pool pagination arrows.
    const pg = e.target.closest(".pgbtn");
    if (pg) {
      if (!pg.disabled) { poolPage += pg.getAttribute("data-pg") === "next" ? 1 : -1; if (current) render(current); }
      return;
    }
    // The "Collected" disclosure reveals/hides the owned blueprints.
    if (e.target.closest('.grphead[data-grp="collected"]')) {
      poolShowCollected = !poolShowCollected;
      if (current) render(current);
      return;
    }
    // The Physical Rewards "Received" disclosure reveals/hides the ticked-off items.
    if (e.target.closest('.grphead[data-grp="gotitems"]')) {
      physOpen = !physOpen;
      if (current) render(current);
      return;
    }
    // Guaranteed ITEM reward rows tick off in one click. Manual-only + low stakes, so
    // no un-tick confirm (blueprints get one because they guard real collection data).
    const itemRow = e.target.closest(".row[data-item]");
    if (itemRow) {
      setGuaranteedOwned(itemRow.getAttribute("data-item"), !itemRow.classList.contains("owned"));
      return;
    }

    const row = e.target.closest(".row");
    if (!row || !current) return;
    const name = row.getAttribute("data-name");

    if (e.target.classList.contains("cf-yes")) { setOwned(name, false); return; }
    if (e.target.classList.contains("cf-no")) {
      row.classList.remove("confirming");
      const c = row.querySelector(".confirm"); if (c) c.remove();
      return;
    }
    if (row.classList.contains("confirming")) return; // wait for a confirm choice

    if (!row.classList.contains("owned")) { setOwned(name, true); return; } // owning: no prompt

    // Un-owning: confirm first.
    row.classList.add("confirming");
    const el = document.createElement("div");
    el.className = "confirm";
    // 🔑 Say when the LOG disagrees with what you are about to do. Un-ticking something the game
    // actually gave you is almost always a misclick — Sub's was — and the app knows the
    // difference, so it should not ask the same neutral question for both cases.
    const src = row.getAttribute("data-source");
    const logged = src === "in-game" || src === "fab";
    el.innerHTML = '<span class="cf-q">'
      + (logged ? "Your logs say you got this — remove anyway?" : "Mark not owned?") + "</span>"
      + '<button class="cf-no">Keep</button><button class="cf-yes">Remove</button>';
    row.appendChild(el);
  });

  // Re-scan every game log (current + backups) for received blueprints.
  $("verify").addEventListener("click", async () => {
    const btn = $("verify");
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Verifying…"; $("vstatus").textContent = "";
    try {
      const r = await (await fetch("/api/missions/verify", { method: "POST" })).json();
      // `unresolved` = receipts we WITNESSED but can't tie to a dataset item. They count
      // as collected locally yet can never sync, so the site shows them missing and the
      // player re-adds them by hand. Silent until now — surface the count, and hang the
      // names off the tooltip so a report names them without needing the log.
      const unres = Array.isArray(r.unresolved) ? r.unresolved : [];
      $("vstatus").textContent = r.ok
        ? "scanned " + r.files + " live logs · +" + r.added + " new"
          + (r.restored ? " · " + r.restored + " restored" : "")
          + (r.skipped ? " · " + r.skipped + " PTU skipped" : "")
          + (unres.length ? " · " + unres.length + " unknown" : "")
        : "verify failed";
      $("vstatus").title = unres.length
        ? "Received but not in the dataset (can't sync):\n" + unres.join("\n")
        : "";
    } catch {
      $("vstatus").textContent = "verify failed";
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });
