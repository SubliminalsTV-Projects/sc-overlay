/**
 * HAULING — THE RANK TAB (the advisor): what to go looking for, and how far the next rank is.
 *
 * Lifted verbatim out of hauling.html (2026-08-19). Same page, same scope: classic scripts on one
 * document share a global lexical environment, so nothing here is exported and nothing that calls
 * it changed. Load order is preserved — this file sits exactly where the block used to sit.
 */
  /**
   * 🔴 THE ADVISOR — what to go looking for, and how far the next rank is.
   *
   * Ranks contract TYPES, not board rows. Nothing here reads the screen: the shipped datasets are
   * scored and the player matches the answer against the board BY ITS TITLE, because the title is
   * the whole model spelled out — "Experienced Rank - Direct Medium Cargo Haul" is rung, shape and
   * size band in one string.
   *
   * 🔑 Reputation is a pure function of the RUNG. Across the 393 real contracts in the three core
   * families every tier awards exactly one value — Rookie 50, Junior 500, Member 1000, Experienced
   * 2000, Senior 4000, Master 8000 — so the advice is "climb the ladder, then take the SMALLEST
   * size band that rung offers", because a smaller band is fewer boxes for the same flat rep.
   *
   * ⚠️ These are SOLO estimates: every contract scored as if it were the only one you took, which
   * is the right number for an accept/skip decision at the board and NOT comparable with the Route
   * tab's, which re-scores the accepted set with real packing.
   */
  let advisor = null;
  let advisorGoal = "rep";
  /* Which family of hauling contracts. "" is all of them, which is deliberately NOT the default —
     see the type filter's note in the endpoint: Interstellar is a separate economy and blending it
     into a reputation ranking gives an order that is wrong for both. Remembered, because a player
     works one board for hours. */
  const TYPE_KEY = "sc-hauling-advisor-type";
  let advisorType = (() => { try { return localStorage.getItem(TYPE_KEY) ?? "Hauling - Planetary"; } catch { return "Hauling - Planetary"; } })();
  async function loadAdvisor() {
    try {
      const r = await fetch("/api/hauling/advisor?goal=" + advisorGoal
        + "&type=" + encodeURIComponent(advisorType), { cache: "no-store" });
      if (r.ok) advisor = await r.json();
    } catch { /* sidecar down — keep whatever we had */ }
    if (view === "advisor") render();
  }
  function setAdvisorType(t) {
    advisorType = t;
    try { localStorage.setItem(TYPE_KEY, t); } catch { /* private mode */ }
    loadAdvisor();
  }

  function renderAdvisor() {
    const body = $("body");
    body.textContent = "";
    if (!advisor) {
      const d = document.createElement("div"); d.className = "empty";
      d.textContent = "Working out what is worth flying…";
      body.appendChild(d);
      loadAdvisor();
      return;
    }
    /* 🔴 NO SHIP, NO BOARD. Every number on this list is per unit of WORK, and the work depends on
       what your hold can take — so ranking a board without knowing the hull is guessing and then
       printing the guess as advice. Sub's ruling: "If we don't know what ship they're in, then
       show them nothing and tell them you need to specify a ship or get in one." */
    if (advisor.needShip) {
      const d = document.createElement("div"); d.className = "empty";
      d.textContent = "Pick your ship, or climb into one.";
      const w = document.createElement("div"); w.className = "empty sub";
      w.textContent = "This list ranks contracts by what they cost YOU to fly, and that depends on"
        + " your hold — which boxes fit, and how many trips they take. Without a hull it would be a"
        + " guess dressed up as advice.";
      body.appendChild(d); body.appendChild(w);
      return;
    }
    body.appendChild(renderStanding());
    /* Named a hull ships.json does not carry. The board still lists — hiding every contract because
       OUR data is short is worse than not checking the fit — but it must say so, or an unfittable
       contract looks vetted. */
    if (advisor.fitUnchecked) {
      const w = document.createElement("div"); w.className = "droprow";
      w.textContent = "We do not have cargo-grid data for this ship, so nothing below has been"
        + " checked against your hold. Everything is listed.";
      body.appendChild(w);
    }
    body.appendChild(renderTypeFilter());
    const sec = document.createElement("div");
    sec.className = "sec";
    const h = document.createElement("span");
    h.textContent = "Best for the work";
    /* 🔑 The toggle lives HERE, in the open, not in the cog. The two orderings genuinely disagree —
       across the 427 rep-paying contracts the median one moves 35 places between them — so
       flipping back and forth IS the feature, and a control you have to go find is a control that
       does not get used. */
    const seg = document.createElement("span");
    seg.className = "goalseg";
    for (const [id, label, tip] of [
      ["rep", "Reputation", "Rank by reputation earned per unit of work."],
      ["money", "aUEC", "Rank by aUEC earned per unit of work. It is a different order."],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hbtn" + (advisorGoal === id ? " on" : "");
      b.textContent = label;
      b.title = tip;
      b.addEventListener("click", () => { advisorGoal = id; loadAdvisor(); });
      seg.appendChild(b);
    }
    const n = document.createElement("span");
    n.className = "n";
    // The unit is not decoration — under a manual hull there IS no published per-box timing, so
    // the honest denominator is boxes, and saying so is what stops the number being read as time.
    n.textContent = "per hour, loading and flying";
    n.title = advisor.regime === "auto"
      ? "This hull auto-loads, so the cost is the station arm's published seconds."
      : "You load this hull by hand, and the tractor-beam grind has no published timing — so the"
        + " cost is box COUNT. Sub: six 1 SCU boxes is about the same work as six 32 SCU boxes.";
    sec.append(h, seg, n);
    body.appendChild(sec);

    let ruled = false;
    advisor.contracts.forEach((c, i) => {
      /* The locked block is appended after the open one (see the endpoint), so the first locked row
         is where "what you could be flying" turns into "what the next rung opens up". Saying so is
         the difference between a useful preview and a list that looks mis-sorted. */
      if (c.locked && !ruled) {
        ruled = true;
        const s = document.createElement("div");
        s.className = "sec";
        const sh = document.createElement("span"); sh.textContent = "What the next rank opens up";
        const sn = document.createElement("span"); sn.className = "n"; sn.textContent = "not on your board yet";
        s.append(sh, sn);
        body.appendChild(s);
      }
      const row = document.createElement("div");
      row.className = "arow" + (c.locked ? " locked" : "");
      const nEl = document.createElement("div"); nEl.className = "n"; nEl.textContent = String(i + 1);
      const mid = document.createElement("div"); mid.className = "mid";
      const t = document.createElement("div"); t.className = "t";
      t.textContent = c.title || c.key;
      t.title = c.key + (c.giver ? "  ·  " + c.giver : "");
      const m = document.createElement("div"); m.className = "m";
      const bits = [];
      bits.push(c.boxes + " box" + (c.boxes === 1 ? "" : "es"));
      bits.push(c.scuLo === c.scuHi ? c.scuLo + " SCU" : c.scuLo + "–" + c.scuHi + " SCU");
      if (c.dropoffs > 1) bits.push(c.dropoffs + " drops");
      if (c.rep > 0) bits.push(num(c.rep) + " rep");
      if (c.payout) bits.push(num(c.payout) + " aUEC");
      // How many commodity variants wear this exact title. Not trivia: it is roughly how likely
      // you are to actually find one of these on a board.
      if (c.variants > 1) bits.push(c.variants + " variants");
      m.textContent = bits.join("  ·  ");
      mid.append(t, m);
      if (c.locked) {
        const lp = document.createElement("span");
        lp.className = "lockpill";
        lp.textContent = "  needs " + c.rank + " with " + (c.giver || "this giver");
        lp.title = "Above your standing WITH THAT GIVER, so it is not on your board yet."
          + " Reputation is per faction — being Member with Covalex does not open Ling Family work.";
        m.appendChild(lp);
      }
      const r = document.createElement("div"); r.className = "r";
      const v = document.createElement("div"); v.className = "v";
      /* The headline is the SORT key, and the sort is per hour — see rankContracts. Showing one
         number and ordering by another is how a list looks broken. */
      const hourly0 = advisorGoal === "rep" ? c.repPerHour : c.moneyPerHour;
      const rate = advisorGoal === "rep" ? c.repRate : c.moneyRate;
      v.textContent = Number.isFinite(hourly0)
        ? (hourly0 >= 1000 ? Math.round(hourly0 / 1000) + "k" : Math.round(hourly0))
        : (rate >= 100 ? Math.round(rate) : rate.toFixed(rate >= 10 ? 1 : 2));
      const u = document.createElement("div"); u.className = "u";
      u.textContent = advisorGoal === "rep" ? "rep/hr" : "aUEC/hr";
      r.append(v, u);
      /* 🔴 PER BOX IS THE SORT, PER HOUR IS THE SENSE. Ranked by rep/box the list opened with 41.7
         rep/box and Sub had to work out for himself that it was tiny 1 SCU boxes — "we need another
         number to quantify that so that the user doesn't think that there's some sort of a
         mistake." Per box is what the work FEELS like and is the right key; per hour is the only
         one you can hold against an evening. Both, so neither has to be guessed at. */
      const ph = document.createElement("div"); ph.className = "ph";
      /* Guarded. A missing figure must cost this ONE line, not the whole tab: the first cut threw
         on undefined here and the Rank tab came back empty with no error anyone could see. */
      ph.textContent = (rate >= 100 ? Math.round(rate) : rate.toFixed(rate >= 10 ? 1 : 2))
        + (advisor.regime === "auto"
             ? (advisorGoal === "rep" ? " rep/s loading" : " aUEC/s loading")
             : (advisorGoal === "rep" ? " rep/box" : " aUEC/box"));
      ph.title = "What the work feels like in the hand — per box you move (or per second of the"
        + " station arm's published loading time, on a hull that loads itself)."
        + "  The list is"
        + " ordered by the per-hour figure above, which also counts the stops and the flying between"
        + " them: about " + Math.round(c.minutes || 0) + " minutes for one run of this.";
      r.appendChild(ph);
      /* 🔴 THE ROW IS A LINK. Everything this widget can say about a contract type is already on
         the row; the rest — what it pays where, who gives it, what it looks like — lives on the
         site, which has the whole dataset and room to show it. Opened in the real browser rather
         than in the overlay, because reading a page over the game is not what the overlay is for. */
      row.classList.add("clickable");
      row.title = "Open this contract on subliminal.gg";
      row.addEventListener("click", () => {
        const url = "https://subliminal.gg/missions/" + encodeURIComponent(c.key);
        // `openUrl` is the bridge every other widget uses (chat, battaglia) — it hands the link to
        // the OS browser. Standalone has no host, so fall back to window.open there.
        if (host()?.openUrl) host().openUrl(url);
        else window.open(url, "_blank", "noopener");
      });
      row.append(nEl, mid, r);
      body.appendChild(row);
    });
  }

  /**
   * 🔴 WHERE YOU STAND — READ, NOT ASKED.
   *
   * This was a rank dropdown and a rep box, and both were wrong. The app has been accruing
   * reputation per giver from every log backup all along (307 credited completions at the time),
   * so it already knew Covalex 5,400 while the widget was asking Sub to type it. And he could not
   * have answered anyway: mobiGlas draws a BAR, never an integer, so the only place that number
   * exists for a player to read is this app. Asking was circular.
   *
   * 🔑 ONE ROW PER GIVER. Four factions share the `Hauling` scope and reputation accrues to the
   * FACTION, so "how far to the next rank" is four different questions. Sub spotted the hazard
   * before the code did: a single ladder would have offered him Member-tier Ling Family work
   * against a standing he earned entirely with Covalex.
   */
  function renderStanding() {
    const wrap = document.createElement("div");
    wrap.className = "stand";
    const climbs = advisor.climbs || [];
    if (!climbs.length) {
      const d = document.createElement("div");
      d.className = "climb none";
      d.textContent = "No hauling standing seen yet — finish a contract and this fills in.";
      wrap.appendChild(d);
      return wrap;
    }
    for (const c of climbs) wrap.appendChild(renderClimb(c));
    return wrap;
  }

  /**
   * Which family of hauling contracts to rank.
   *
   * 🔑 Defaults to Planetary rather than "all", and that is a correctness choice as much as a
   * convenience one. `Hauling - Interstellar` is a SEPARATE ECONOMY — its Rookie tier pays 50 or
   * 100 and its Master tier pays 0 or 200, where every core Master pays 8000 — so a single ranking
   * across all families produces an order that is wrong for whichever board you are standing at.
   * The label carries that warning rather than burying it.
   */
  function renderTypeFilter() {
    const wrap = document.createElement("div");
    wrap.className = "typebar";
    const all = document.createElement("button");
    all.type = "button";
    all.className = "hbtn" + (advisorType === "" ? " on" : "");
    all.textContent = "All";
    all.title = "Every hauling family at once. Useful for a survey, misleading for a decision — the"
      + " families do not share an economy.";
    all.addEventListener("click", () => setAdvisorType(""));
    wrap.appendChild(all);
    // Short names: the panel is 420px and "Hauling - Interstellar" four times over is the whole row.
    for (const t of (advisor.types || [])) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hbtn" + (advisorType === t.name ? " on" : "");
      b.textContent = t.name.replace(/^Hauling\s*-\s*/, "").replace(/^Hauling$/, "Contract");
      b.title = t.name + " — " + t.count + " contract types."
        + (/Interstellar/.test(t.name)
          ? "  ⚠️ A separate economy: its Master tier pays 0-200 rep where every other Master pays 8,000. Do not compare its rates with the others'."
          : "");
      b.addEventListener("click", () => setAdvisorType(t.name));
      wrap.appendChild(b);
    }
    return wrap;
  }

  /** "How long to the next rank", for one giver. */
  function renderClimb(c) {
    const d = document.createElement("div");
    d.className = "climb";
    const who = document.createElement("div");
    who.className = "sub";
    who.style.marginTop = "0";
    who.textContent = c.giver + "  ·  " + c.rung + "  ·  " + num(c.standing) + " rep";
    who.title = "Accrued by this app from your completed contracts. The game never states it — "
      + "mobiGlas only draws the bar.";
    d.appendChild(who);
    if (!c.next) {
      const t = document.createElement("div");
      t.textContent = "Top of the ladder.";
      d.appendChild(t);
      return d;
    }
    /* 🔴 NO RATE, NO TIME. The modelled per-run figure counts only box handling — no flying, no
       quantum, no walk to the elevator — so quoting it as "time to rank" would understate by most
       of the real time. Say the rep and say what would fix it. */
    if (c.hours == null) {
      const t = document.createElement("div");
      t.textContent = num(c.repNeeded) + " rep to " + c.next + ".";
      const s = document.createElement("span"); s.className = "sub";
      s.textContent = "Finish a contract and this becomes a time, from your own rate.";
      t.appendChild(s);
      d.appendChild(t);
      return d;
    }
    const line = document.createElement("div");
    const big = document.createElement("span");
    big.className = "big";
    big.textContent = fmtMins(c.hours * 60);
    line.append(big, document.createTextNode(" to " + c.next));
    const s = document.createElement("span");
    s.className = "sub";
    s.textContent = num(c.repNeeded) + " rep to go · at your " + Math.round(c.repPerHour) + " rep/h";
    s.title = "Against the reputation an hour you are actually earning, which includes the flying"
      + " and the loading — not a model of either.";
    line.appendChild(s);
    // Runs of the best contract open to you WITH THIS GIVER, and a measured time per run when
    // enough contracts have finished to have one.
    const rb = advisor.runsOfBest;
    if (rb && rb.runs && rb.giver === c.giver) {
      const r = document.createElement("span");
      r.className = "sub";
      const rm = advisor.runMinutes;
      r.textContent = "≈ " + rb.runs + " × " + rb.title
        + (rm ? "  ·  ~" + fmtMins(rm.median) + " each" : "");
      r.title = "Runs of the best contract open to you with this giver, at " + num(rb.rep) + " rep each."
        + (rm ? "  Run time is the median of your own " + rm.samples + " finished contract(s), accept to turn-in." : "");
      line.appendChild(r);
    }
    d.appendChild(line);
    return d;
  }

  /**
   * 🔴 BEFORE YOU LEAVE — check the board for a load going your way.
   *
   * Sub asked for this and gave the reason: "I'm very forgetful, and I'm sure people who are using
   * this maybe might be too." An empty leg is the most expensive thing in hauling, and the moment
   * to fix it is while you are still standing at a terminal.
   *
   * 🔑 It could not be built until the log gave up the player's position. The widget had no idea
   * you were anywhere, so it had nothing to be "about to leave" FROM. Now that
   * `RequestLocationInventory` (and the numeric ids bound to it) place you, the prompt can name
   * where you are and where you are already going.
   *
   * ⚠️ It never claims a contract EXISTS. The board is not in the log — only accepted contracts
   * are — so this is a reminder to look, phrased as one. Sub's own fallback wording: "just
   * generically say, before you leave double check to make sure that there aren't any missions
   * that take cargo from your current location."
   */
  const DEPART_KEY = "sc-hauling-depart-off";
  let departOff = (() => { try { return localStorage.getItem(DEPART_KEY) === "1"; } catch { return false; } })();

  function renderDepart() {
    const el = $("depart");
    el.textContent = "";
    const sr = (plan && plan.startResolved) || {};
    const here = sr.detected;
    // Only while we actually know where you are, and only on the Route tab — the Stow and Rank
    // tabs are not about leaving.
    if (departOff || !here || view !== "route") { el.style.display = "none"; return; }
    const names = locNames();
    // Where you are still going, in route order, minus the place you are standing.
    const ahead = [];
    for (const t of plan.trips) for (const st of t.stops) {
      const loc = String(st.id || "").replace(/:(pickup|dropoff)$/, "");
      if (loc === here) continue;
      if (!ahead.includes(st.name)) ahead.push(st.name);
    }
    if (!ahead.length) { el.style.display = "none"; return; }
    el.style.display = "";
    const k = document.createElement("div");
    k.className = "k";
    k.textContent = "Before you leave " + (names[here] || "here");
    const t = document.createElement("div");
    t.className = "t";
    t.appendChild(document.createTextNode("Check the board for anything loading here and dropping at "));
    ahead.slice(0, 4).forEach((n, i, a) => {
      const b = document.createElement("b");
      b.textContent = n;
      t.appendChild(b);
      if (i < a.length - 1) t.appendChild(document.createTextNode(i === a.length - 2 ? " or " : ", "));
    });
    t.appendChild(document.createTextNode(" — you are going there anyway."));
    const x = document.createElement("button");
    x.type = "button"; x.className = "x"; x.textContent = "✕";
    x.title = "Stop reminding me. Turn it back on in the widget's settings.";
    x.addEventListener("click", () => {
      departOff = true;
      try { localStorage.setItem(DEPART_KEY, "1"); } catch { /* private mode */ }
      render();
    });
    el.append(k, t, x);
  }
