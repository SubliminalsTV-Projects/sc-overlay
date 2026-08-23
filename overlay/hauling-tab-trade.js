/**
 * HAULING - THE COMMODITIES TAB: buy low somewhere, haul it, sell high somewhere else.
 *
 * Phase 2. Contracts/Route/Stow are about work the GAME gave you; this one is about cargo you
 * choose to buy with your own money. Nothing here comes from the log - it is the one tab that
 * works with the game closed.
 *
 * ⚠️ RENAMED "Planner" -> "Commodities" 2026-08-23 (Sub), when the two modes were merged into one
 * flat tab row. The id `tabTrade`, the `trade` view name and every `trade`/`td` prefix in here are
 * what the code and the widget suite address, so they stay - only the LABEL moved. Same rule the
 * Log -> Ledger rename followed.
 *
 * 🔴 IT IS ONE OF TWO SOURCES, NOT A DESTINATION. It used to be a tab BECAUSE it was not part of
 * Route; that stopped being true when Route became cargo-agnostic. What is picked here is meant to
 * end up sequenced in Route alongside the contracts - opportunistically, filling the hold the
 * contracts leave empty. Route never ranks the two against each other: contracts rank among
 * themselves in their tab, commodities among themselves in this one.
 *
 * Same file conventions as its siblings: a classic script sharing one lexical scope with
 * hauling.html, so every name here is prefixed `trade`/`td` and nothing is exported.
 *
 * 🔴 THE STANDING CONSTRAINT, AND THE REASON HALF THIS FILE EXISTS: prices are per-terminal and
 * they move. There is no such thing as "the price of Titanium". So every route row carries its own
 * age, which is the OLDER of its two quotes; and where stock is unreported the profit is a
 * CEILING, marked with a `≤`, never a bare number.
 *
 * -- Rebuilt 2026-08-19 after Sub reviewed the first cut ------------------------------------
 *
 * Four of his seven notes were real bugs, not taste, and they are worth recording because three
 * of them were invisible to every test that passed:
 *
 * 1. 🔴 **The run showed what it COST and never what it SOLD FOR.** "I don't know where it really
 *    says how much you're going to get when you sell it." Correct - the row carried a buy-side
 *    capital figure and a margin, so the sell price could only be recovered by arithmetic. The
 *    money line now states `BUY x → SELL y` outright. This is the most important fix here.
 * 2. 🔴 **The big number was unlabelled.** "Is that profit? Because that's not clear." It is, and
 *    it now says so underneath. A number with no noun is a number nobody can act on.
 * 3. 🔴 **The stock toggle changed its LABEL between states**, so "Any stock" could equally have
 *    been the current state or the button's effect - genuinely unreadable. The label is now fixed
 *    ("Confirmed stock") and only the lit state changes. A toggle must never rename itself.
 * 4. 🔴 **The commodity input sat inside `.psug`**, an absolutely-positioned dropdown container,
 *    so it rendered below the panel and had to be scrolled to. It is an ordinary in-flow field.
 *
 * And the one that changes what the tab is FOR:
 *
 * 🔑 **A SYSTEM FILTER IS NOT A NICETY.** Sub: "Fallow Field, where I can buy Bexalite, is in
 * Pyro. But I'm in Stanton." A ranked list whose top rows are in another system is not a
 * recommendation, it is a trap - the travel cost is real and the tiered model already charges 25
 * minutes for the jump. The filter defaults to the system the log says you are in, and falls back
 * to showing everything when the log has not said, because guessing wrong would silently hide the
 * routes you can actually fly.
 */

  /* ── state ──────────────────────────────────────────────────────────────── */

  let tradeData = null;        // last /api/trade/routes response
  let tradeStatus = null;      // last provenance block, for first paint before any query
  let tradeBusy = false;
  let tradeErr = "";
  /* ⛔ `tradeMode` IS GONE. It chose between "routes" and "commodity" — the Runs list and the
     one-commodity lookup — and the lookup was the Market tab, which Sub retired when the tabs were
     merged (the Verse Finder already answers "where can I buy X", and the Runs list answers "what
     is worth carrying"). With one view left there is nothing to choose, so `tradeLookup`,
     `tradeNames` and `tradeQuery` went with it.
     🔑 Backhaul was never a mode — it is a FILTER on routes, the same question with the
     destination pinned — so it is unaffected. */
  let tradeToBody = null;
  /** "" = every system. Defaulted from the log once, then it is the player's choice. */
  let tradeSystem = null;      // null = not yet defaulted
  const TD_STOCK_KEY = "sc-trade-known-stock";
  const TD_UNIT_KEY = "sc-trade-unit";
  /** "run" = what the whole trip clears. "scu" = what one unit is worth carrying. Two real
   *  answers to two different questions, and the second is what stays comparable across rows
   *  whose hold fills differ. */
  let tradeUnit = (() => { try { return localStorage.getItem(TD_UNIT_KEY) === "scu" ? "scu" : "run"; } catch { return "run"; } })();
  const TD_SYS_KEY = "sc-trade-system";
  const TD_PERIOD_KEY = "sc-trade-period";
  /** "today" | "all". Replaces the SECOND totals block the Ledger used to stack under the
   *  first: the same two rollups, one at a time. Persisted, because which one a player cares
   *  about is a habit rather than a per-visit decision. */
  let journalPeriod = (() => {
    try { return localStorage.getItem(TD_PERIOD_KEY) === "all" ? "all" : "today"; }
    catch { return "today"; }
  })();
  let tradeKnownOnly = (() => { try { return localStorage.getItem(TD_STOCK_KEY) === "1"; } catch { return false; } })();

  /* ── helpers ────────────────────────────────────────────────────────────── */

  /** "2d" / "18h" / "just now". 🔑 Never rounds an old quote down to something reassuring. */
  function tdAge(days) {
    if (days === null || days === undefined) return null;
    if (days >= 1) return Math.round(days) + "d";
    const h = Math.round(days * 24);
    return h >= 1 ? h + "h" : "just now";
  }
  /** Sub asked for the age to be "weighted with a colour". Three bands, because a quote you have
   *  to think about is a quote you do not read. */
  function tdAgeClass(days) {
    if (days === null || days === undefined) return "warn";
    return days < 2 ? "age0" : days < 7 ? "age1" : "age2";
  }

  function tdMoney(n) {
    const v = Math.round(Number(n) || 0);
    if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
    if (Math.abs(v) >= 10_000) return Math.round(v / 1000) + "k";
    return v.toLocaleString();
  }

  /**
   * The margin, as a SIGNED percentage (Sub, 2026-08-22: "(53% margin)" becomes "(+53%)", green).
   *
   * 🔑 The word "margin" was doing no work — it sits two elements away from a column labelled
   * "profit", and it cost 55px on the one line in this row that has to survive a 320px panel.
   * The SIGN does work the phrase never did: a losing run used to hide its minus inside a
   * sentence, and it is now the first character, with the colour agreeing with it.
   */
  function tdPct(marginPct) {
    const v = Math.round(Number(marginPct) || 0);
    const s = document.createElement("span");
    s.className = "pct" + (v < 0 ? " down" : "");
    s.textContent = "(" + (v > 0 ? "+" : "") + v + "%)";
    return s;
  }

  function tdChip(parent, text, cls) {
    const s = document.createElement("span");
    s.className = "badge" + (cls ? " " + cls : "");
    s.textContent = text;
    parent.appendChild(s);
    return s;
  }

  /** `23,940 → 36,000` as ONE unbreakable item. Gold out, green in — those two colours are what
   *  let the `buy` and `sell` words go, and dropping them is ~65px back on the line that has to
   *  survive 320px. It is a single span so the pair can never be split across a wrap: half a
   *  price pair is two orphaned numbers, not a price. */
  function tdPair(parent, buy, sell) {
    const s = document.createElement("span");
    s.className = "pair";
    const b = document.createElement("span"); b.className = "buy"; b.textContent = num(buy);
    const a = document.createElement("span"); a.className = "arrow"; a.textContent = "→";
    const v = document.createElement("span"); v.className = "sell"; v.textContent = num(sell);
    s.append(b, a, v);
    parent.appendChild(s);
    return s;
  }

  /** A figure with its unit riding it, dimmer than the figure: `507 SCU`, `12.14M in`. The unit is
   *  a real element rather than part of the string so it can be styled down — a number and its
   *  unit set at the same weight read as one longer number. */
  function tdQty(parent, value, unit) {
    const s = document.createElement("span");
    s.className = "q";
    s.appendChild(document.createTextNode(String(value)));
    if (unit) {
      const u = document.createElement("u");
      u.textContent = " " + unit;
      s.appendChild(u);
    }
    parent.appendChild(s);
    return s;
  }

  /** The separator between metrics. Its own element so it can be dimmed to the point of being
   *  rhythm rather than content, and so a wrap never leaves one stranded at the start of a line. */
  function tdMdot(parent) {
    const s = document.createElement("span");
    s.className = "mdot";
    s.textContent = "·";
    parent.appendChild(s);
    return s;
  }

  /** ONE ROW SHAPE FOR RUNS AND FOR THE LEDGER — see the `.tdrow` note in hauling.html.
   *
   *  `spec` is: { rank, title, profit, profitClass, profitLabel, route, rate, buy, sell,
   *               marginPct, metrics: [[value, unit], ...] }
   *  and the caller appends its own chips to the returned `chips` element.
   *
   *  🔑 Shared deliberately. A forecast run and a recorded run are DIFFERENT claims — that is the
   *  whole reason the Ledger exists — but they are the same SHAPE, and building them twice is how
   *  the money line ended up correct in one renderer and clipped in the other. The difference
   *  between the two lives in what the caller passes, not in a second copy of the layout. */
  function tdSpineRow(spec) {
    const row = document.createElement("div");
    row.className = "arow tdrow";
    if (spec.rank !== undefined && spec.rank !== null) {
      const nEl = document.createElement("div");
      nEl.className = "n";
      nEl.textContent = String(spec.rank);
      row.appendChild(nEl);
    }
    const mid = document.createElement("div"); mid.className = "mid";

    const l1 = document.createElement("div"); l1.className = "l1";
    const t = document.createElement("div"); t.className = "t"; t.textContent = spec.title;
    const p = document.createElement("span");
    p.className = "p" + (spec.profitClass ? " " + spec.profitClass : "");
    p.textContent = spec.profit;
    const pk = document.createElement("span"); pk.className = "pk";
    pk.textContent = spec.profitLabel;
    l1.append(t, p, pk);
    mid.appendChild(l1);

    const l2 = document.createElement("div"); l2.className = "l2";
    const rt = document.createElement("span"); rt.className = "r"; rt.textContent = spec.route;
    l2.appendChild(rt);
    if (spec.rate) {
      const hr = document.createElement("span"); hr.className = "hr"; hr.textContent = spec.rate;
      l2.appendChild(hr);
    }
    mid.appendChild(l2);

    const l3 = document.createElement("div"); l3.className = "l3";
    tdPair(l3, spec.buy, spec.sell);
    l3.appendChild(tdPct(spec.marginPct));
    for (const m of spec.metrics || []) {
      tdMdot(l3);
      tdQty(l3, m[0], m[1]);
    }
    mid.appendChild(l3);

    const chips = document.createElement("div"); chips.className = "m tdchips";
    mid.appendChild(chips);

    row.appendChild(mid);
    return { row, chips, title: t, profit: p, strip: l3 };
  }

  function tdBtn(parent, label, on, title, fn) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hbtn" + (on ? " on" : "");
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", fn);
    parent.appendChild(b);
    return b;
  }

  /** The provenance strip: one pill and an ⓘ, replacing the two paragraphs of the first cut.
   *  🔑 THREE STATES, THREE COLOURS, because "offline by choice", "tried and failed" and "fresh"
   *  are different facts and must not read alike. */
  function tdProvenance(bar, d) {
    const pill = document.createElement("span");
    const dot = document.createElement("span");
    dot.className = "dot";
    pill.appendChild(dot);
    const txt = document.createElement("span");

    let tip;
    if (!d) {
      pill.className = "tdsrc cache";
      txt.textContent = "loading";
      tip = "Fetching the price table.";
    } else if (d.source === "live") {
      pill.className = "tdsrc live";
      txt.textContent = "live";
      const mins = d.fetchedAt ? Math.round((Date.now() - d.fetchedAt) / 60000) : null;
      tip = "Live prices, community-reported through UEX."
        + (mins !== null ? " Our copy was refreshed " + (mins < 1 ? "just now" : mins < 90 ? mins + " minutes ago" : Math.round(mins / 60) + " hours ago") + "." : "")
        + " Reports come from players, so each row shows its OWN age — that is the number worth"
        + " trusting, not how recently we refreshed."
        + (d.droppedOffline ? " " + d.droppedOffline + " terminals are hidden: UEX has prices for them but they are not in the game right now." : "");
    } else if (d.source === "cache") {
      pill.className = "tdsrc cache";
      txt.textContent = "last known";
      const mins = d.fetchedAt ? Math.round((Date.now() - d.fetchedAt) / 60000) : null;
      tip = "Showing the last good copy of the price table"
        + (mins !== null ? ", from " + (mins > 90 ? Math.round(mins / 60) + " hours" : mins + " minutes") + " ago" : "")
        + ". " + (d.lastError ? "The live feed is unreachable (" + d.lastError + ")." : "The live feed has not answered yet.")
        + " Prices are still real, just older than usual.";
    } else if (!d.canRefresh) {
      pill.className = "tdsrc bundled";
      txt.textContent = "offline";
      tip = "Live price updates are switched off, so these are the prices bundled with the app"
        + (d.version ? " (" + d.version + ")" : "")
        + ". They work with no network at all, but most routes will not know how much stock is on"
        + " the shelf — those profit figures are ceilings, not estimates.";
    } else {
      pill.className = "tdsrc bundled";
      txt.textContent = "not live";
      tip = "The live price feed is unreachable"
        + (d.lastError ? " (" + d.lastError + ")" : "")
        + ", so these are the prices bundled with the app"
        + (d.version ? " (" + d.version + ")" : "")
        + ". Most routes will not know how much stock is on the shelf — those profit figures are"
        + " ceilings, not estimates.";
    }
    pill.appendChild(txt);
    pill.title = tip;
    bar.appendChild(pill);

    // 🔑 A real <button> + popover: `title` alone cannot be opened by clicking, and Sub has
    // already hit that once on a different info affordance and reported it as doing nothing.
    const info = document.createElement("button");
    info.type = "button";
    info.className = "tdi";
    info.textContent = "i";
    info.title = tip;
    info.setAttribute("popovertarget", "tdInfoPop");
    bar.appendChild(info);

    let pop = document.getElementById("tdInfoPop");
    if (!pop) {
      pop = document.createElement("div");
      pop.id = "tdInfoPop";
      pop.className = "tdpop";
      pop.setAttribute("popover", "");
      document.body.appendChild(pop);
    }
    // ⚠️ Filled on open and cleared on close, so the explanation is never also sitting inside the
    // pill's own textContent.
    pop.addEventListener("beforetoggle", (e) => {
      pop.textContent = e.newState === "open" ? tip : "";
    });
  }

  /* ── loading ────────────────────────────────────────────────────────────── */

  function tdCapacity() {
    if (plan && plan.shipScu) return plan.shipScu;
    return null;
  }

  async function loadTrade() {
    tradeBusy = true;
    tradeErr = "";
    try {
      const cap = tdCapacity();
      const p = new URLSearchParams();
      if (cap) p.set("capacity", String(cap));
      else if (shipPick) p.set("ship", shipPick);
      else p.set("capacity", "64");
      if (tradeSystem) p.set("fromSystem", tradeSystem);
      if (tradeToBody) p.set("toBody", tradeToBody);
      if (tradeKnownOnly) p.set("knownStock", "1");
      p.set("limit", "25");
      const r = await fetch("/api/trade/routes?" + p.toString(), { cache: "no-store" });
      const j = await r.json();
      tradeData = j;
      tradeStatus = j;
      if (!r.ok) tradeErr = j && j.error ? j.error : "HTTP " + r.status;
    } catch {
      // 🔴 Keep whatever we had. A trade board that blanks on a hiccup is worse than a stale one.
      tradeErr = "sidecar unreachable";
    }
    tradeBusy = false;
    if (view === "trade") render();
  }

  /** Provenance + the system list, before any query has been run. Also the one place the system
   *  filter gets its default, which is why it runs before the first `loadTrade()`. */
  async function loadTradeStatus() {
    try {
      const r = await fetch("/api/trade/status", { cache: "no-store" });
      if (!r.ok) return;
      tradeStatus = await r.json();
      if (tradeSystem === null) {
        let saved = null;
        try { saved = localStorage.getItem(TD_SYS_KEY); } catch { /* private mode */ }
        if (saved !== null) tradeSystem = saved;
        else {
          // 🔑 Default to where the log says you are — but only if that system actually has
          // somewhere to buy, or the first thing the player sees is an empty board.
          const here = (tradeStatus.here || "").toLowerCase();
          const match = (tradeStatus.systems || []).find((s) => s.toLowerCase() === here);
          tradeSystem = match || "";
        }
      }
    } catch { /* the routes call reports its own failure */ }
  }

  /* ⛔ `loadTradeNames` / `loadTradeCommodity` went with the Market tab (2026-08-23). They fed the
     one-commodity lookup, whose whole surface was that tab. `GET /api/trade/names` and
     `GET /api/trade/commodity` are untouched on the sidecar and still answer — if a commodity
     picker on the merged Route wants either, it calls them; it does not need this code back. */

  /** Kick everything the tab needs, in the order that makes the first paint correct. */
  async function openTrade() {
    await loadTradeStatus();
    await loadTrade();
  }

  /* ── picking a run into the merged Route ─────────────────────────────────── */

  /**
   * Is this picked buy the same run as this ranked row?
   *
   * 🔑 MATCHED ON COMMODITY AND BOTH TERMINALS, which is what a run IS — not on price, and not on
   * a synthetic id the row does not have. Prices move between refreshes, so a price in the key
   * would make an already-picked row un-recognise itself the moment the table updated and offer to
   * add it a second time.
   */
  function tdSameRun(buy, r) {
    if (!buy || !r) return false;
    const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
    return same(buy.commodity, r.commodity)
      && same(buy.from.terminal, r.from.terminalShort)
      && same(buy.to.terminal, r.to.terminalShort);
  }

  /**
   * Send a run to the Route tab.
   *
   * ⚠️ The SHORT terminal name is what is sent, deliberately: it is what a player reads on the
   * board, and it is what the route's name-merge compares against the game's own drop-off names.
   * The long form ("Admin - Baijini Point") would never match a Deliver line and every pick would
   * cost its own landing.
   * ⚠️ NO TONNAGE. See the button. The body goes because the tiered travel model prices a leg off
   * which world each end is on; without it every buy leg ties and the route stops ordering.
   */
  async function tdPickBuy(r) {
    try {
      const res = await fetch("/api/hauling/buy", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({
          commodity: r.commodity,
          from: { terminal: r.from.terminalShort, body: r.from.body, system: r.from.system },
          to: { terminal: r.to.terminalShort, body: r.to.body, system: r.to.system },
          buyPrice: r.from.price,
          sellPrice: r.to.price,
        }),
      });
      const j = await res.json().catch(() => null);
      // 🔴 SAID OUT LOUD, not swallowed. Without a commodity uuid the log can never match the
      // purchase to this pick, so the tonnage will stay unknown for ever — which would otherwise
      // look exactly like the feature being broken once the player got there and bought some.
      tdBuyMsg(j && j.ok === false
        ? "That run could not be added."
        : j && j.matchable === false
          ? "Added — but this commodity is not in the app's own table, so it cannot fill the tonnage in for you when you buy."
          : "");
    } catch {
      tdBuyMsg("The app's background service is not answering, so that was not saved.");
    }
    await load();     // re-solve: the route is server-side and the plan is what the row reads
    render();
  }

  async function tdDropBuy(id) {
    try {
      await fetch("/api/hauling/buy/forget?id=" + encodeURIComponent(id), { method: "POST", cache: "no-store" });
      tdBuyMsg("");
    } catch {
      tdBuyMsg("The app's background service is not answering, so that was not removed.");
    }
    await load();
    render();
  }

  /** One line under the bar, for the only two things that can go wrong here. Cleared on the next
   *  action rather than on a timer — a message that vanishes while you are reading it is worse
   *  than one that waits. */
  let tdBuyNote = "";
  function tdBuyMsg(text) { tdBuyNote = text; }

  /* ── the routes view ────────────────────────────────────────────────────── */

  function tdRenderRoutes(body) {
    const d = tradeData;
    if (!d || !d.routes) {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = tradeBusy ? "Working out what is worth carrying…" : (tradeErr || "No price data yet.");
      body.appendChild(e);
      return;
    }
    if (d.error === "capacity_required" || d.error === "unknown_ship") {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = d.error === "unknown_ship"
        ? "That hull is not in the ship data, so its hold size is unknown."
        : "Pick a ship first — every figure here depends on how much you can carry.";
      body.appendChild(e);
      return;
    }
    if (!d.routes.length) {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = tradeKnownOnly
        ? "Nothing with confirmed stock here. Turn off “Confirmed stock” to see the rest."
        : tradeSystem
          ? "No profitable run starting in " + tradeSystem + " for this hold. Try “All systems”."
          : "No profitable run found for this hold.";
      body.appendChild(e);
      return;
    }

    const sec = document.createElement("div");
    sec.className = "sec";
    const h = document.createElement("span");
    h.textContent = tradeToBody ? "On your way to " + tradeToBody : "Worth carrying";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = (d.ship ? d.ship + " · " : "") + num(d.capacityScu) + " SCU hold";
    sec.append(h, n);
    body.appendChild(sec);

    d.routes.forEach((r, i) => {
      // 🔑 PER RUN vs PER SCU. Both are real answers to different questions: "what does this trip
      // clear" and "what is each unit worth carrying". Per-SCU is also the only figure that stays
      // comparable when two rows have wildly different hold fills, which is why it is offered
      // rather than derived in the player's head.
      // "≤" is not decoration — with stock unreported the per-run figure is a ceiling off the hold
      // alone. The per-SCU figure is exact either way, so it never carries one.
      const perScu = tradeUnit === "scu";
      // ⚠️ The profit stays CYAN here, never green. This is a forecast off crowd-reported prices;
      // green and red belong to the Ledger, where the figure came out of the player's own log.
      // Same rule as `.facts .est`: a number the app worked out is never dressed like one it was
      // told.
      const { row, chips } = tdSpineRow({
        rank: i + 1,
        title: r.commodity,
        profit: perScu
          ? num(Math.round(r.marginPerScu))
          : (r.scuBound === "unknown" ? "≤ " : "") + tdMoney(r.profit),
        profitLabel: perScu ? "per scu" : "profit",
        route: r.from.terminalShort + "  →  " + r.to.terminalShort,
        rate: perScu ? tdMoney(r.profit) + " total" : tdMoney(r.profitPerHour) + "/hr",
        buy: Math.round(r.from.price),
        sell: Math.round(r.to.price),
        marginPct: r.marginPct,
        // Quantity and capital, which used to be a chip each. They are numbers, so they belong on
        // the numbers line — and "costs 12.14M" as a pill was the widest chip in the row.
        metrics: [[num(r.moveScu), "SCU"], [tdMoney(r.capitalRequired), "in"]],
      });

      // 🔴 CHIPS ARE EXCEPTIONS ONLY NOW. Four per row was the old shape, and two of the four said
      // nothing: "Pyro" on a run that never leaves Pyro, and "fills your hold" when neither the
      // shelf nor the buyer is the binding constraint. A chip that is true of most rows is a chip
      // nobody reads, and at 320px it costs a whole line to say so.
      const age = tdAge(r.ageDays);
      tdChip(chips, age ? age + " old" : "age unknown", tdAgeClass(r.ageDays));
      // Which side bound the load — but only when something DID. `hold` means nothing bound it,
      // and the section header already states the hold size.
      if (r.scuBound === "unknown") tdChip(chips, "stock unknown", "warn");
      else if (r.scuBound === "stock") tdChip(chips, num(r.moveScu) + " on the shelf", "calm");
      else if (r.scuBound === "demand") tdChip(chips, "buyer takes " + num(r.moveScu), "calm");
      // The system pair, and it is loud when they differ — that is the jump.
      // 🔑 The same-system chip survives ONLY when the filter is showing every system, which is the
      // one case where the row cannot be assumed to start where the last one did.
      if (r.crossSystem) tdChip(chips, (r.from.system || "?") + " → " + (r.to.system || "?"), "xsys");
      else if (!tradeSystem && r.from.system) tdChip(chips, r.from.system, "calm");

      /* 🔴 THE ONE CONTROL THAT MAKES THIS TAB A SOURCE RATHER THAN A LIST. Picking a run sends it
         to the merged Route, which sequences it alongside the contracts.
         ⚠️ IT SENDS NO TONNAGE, AND MUST NEVER GROW A FIELD FOR ONE. Sub: "they don't need to pick
         it. They can decide when they get there and when they buy it, we'll know how much they
         bought and then it'll override it." The SCU box that would obviously belong here is exactly
         the thing that was ruled out — a number typed here would be indistinguishable on the Route
         screen from one the log measured.
         🔑 The button is a TOGGLE against the plan's own list, not against local state: the plan is
         where a pick lives (a widget iframe reloads on regroup), so the row reads its state from
         the same place the route does and the two cannot disagree. */
      const picked = ((plan && plan.buys) || []).find((b) => tdSameRun(b, r));
      tdBtn(chips, picked ? "In route ✓" : "+ Route", !!picked,
        picked
          ? "Remove this run from the Route tab. Nothing you have already bought is forgotten — this is the plan, not the Ledger."
          : "Sequence this run in the Route tab, alongside your contracts. It goes in with no tonnage: the app fills that in from the log when you actually buy.",
        () => (picked ? tdDropBuy(picked.id) : tdPickBuy(r)));

      body.appendChild(row);
    });
  }

  /* ── the tab ────────────────────────────────────────────────────────────── */

  function renderTrade() {
    const body = $("body");
    body.textContent = "";

    // One bar, one control height. See the CSS note: this deliberately avoids `.goalseg`, whose
    // override is what made the first cut's pills three different sizes.
    const bar = document.createElement("div");
    bar.className = "tdbar";
    tdProvenance(bar, tradeStatus);

    // ⚠️ Runs / Look up used to be buttons in here, then TOP TABS. Look up (Market) is retired
    // and this bar carries only the Runs filters, unconditionally — the `tradeMode` guard that used
    // to wrap all of this went with the second view it was choosing between.
    const sep2 = document.createElement("span"); sep2.className = "sep"; bar.appendChild(sep2);
    // 🔑 THE SYSTEM FILTER. Built from the systems that actually have a buy terminal, so it can
    // never offer a choice that only ever returns nothing.
    const systems = (tradeStatus && tradeStatus.systems) || [];
    if (systems.length > 1) {
      const lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = "buy in";
      bar.appendChild(lbl);
      const pick = (s) => {
        tradeSystem = s;
        try { localStorage.setItem(TD_SYS_KEY, s); } catch { /* private mode */ }
        loadTrade();
      };
      tdBtn(bar, "All", tradeSystem === "", "Every system", () => pick(""));
      for (const s of systems) {
        const isHere = tradeStatus && tradeStatus.here
          && s.toLowerCase() === String(tradeStatus.here).toLowerCase();
        tdBtn(bar, s, tradeSystem === s, isHere ? "Where the log says you are" : "Buy in " + s,
          () => pick(s));
      }
    }

    const sep3 = document.createElement("span"); sep3.className = "sep"; bar.appendChild(sep3);
    // 🔴 A FIXED LABEL. The first cut swapped between "Any stock" and "Confirmed stock only",
    // which made it impossible to tell the state from the action.
    tdBtn(bar, "Confirmed stock", tradeKnownOnly,
      "Only show runs where someone has reported how much is actually on the shelf", () => {
        tradeKnownOnly = !tradeKnownOnly;
        try { localStorage.setItem(TD_STOCK_KEY, tradeKnownOnly ? "1" : "0"); } catch { /* private mode */ }
        loadTrade();
      });

    const sep4 = document.createElement("span"); sep4.className = "sep"; bar.appendChild(sep4);
    const setUnit = (u) => {
      tradeUnit = u;
      try { localStorage.setItem(TD_UNIT_KEY, u); } catch { /* private mode */ }
      render();   // a display choice; the data is unchanged, so no refetch
    };
    tdBtn(bar, "Per run", tradeUnit === "run", "What the whole trip clears", () => setUnit("run"));
    tdBtn(bar, "Per SCU", tradeUnit === "scu", "What one SCU is worth carrying", () => setUnit("scu"));

    const dest = tdPlanDestination();
    if (dest) {
      tdBtn(bar, "Backhaul", !!tradeToBody,
        "You are already flying to " + dest + " — what is worth carrying along?", () => {
          tradeToBody = tradeToBody ? null : dest;
          loadTrade();
        });
    }
    body.appendChild(bar);

    if (tdBuyNote) {
      const n = document.createElement("div");
      n.className = "note";
      n.textContent = tdBuyNote;
      body.appendChild(n);
    }
    tdRenderRoutes(body);
  }

  /* ── the log: what you actually did ─────────────────────────────────────────
     🔴 THE DISTINCTION THAT MAKES THIS TAB WORTH HAVING. Runs is a FORECAST off crowd-reported
     prices; this is a RECORD, where every figure came out of the game's own log. So it is allowed
     to be exact, and it is the only screen here that is.

     And the rule it must never break: a sale is only profit if we saw the purchase. A sale whose
     buy was never in any log we read has no cost basis, so it is reported as REVENUE in its own
     group and never folded into a profit total. */

  let tradeJournal = null;

  async function loadJournal() {
    try {
      const r = await fetch("/api/trade/journal", { cache: "no-store" });
      if (r.ok) tradeJournal = await r.json();
    } catch { /* keep whatever we had */ }
    if (view === "journal") render();
  }

  /**
   * How long ago, from an ISO timestamp. Coarse on purpose — the question this answers is "is this
   * from this session or from last week", and a lot bought four days ago does not need a minute
   * count to make the point.
   *
   * 🔑 It states the age and asserts NOTHING ELSE. An old unsold lot is very likely gone, but
   * "likely" would have to be a threshold nobody has measured, and this file's whole discipline is
   * that a figure is either read or it is not claimed. The age is read; the conclusion is the
   * player's, and the ✕ beside it is how they record it.
   */
  function tdAgo(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "at an unknown time";
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 60) return mins + "m ago";
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return hrs + "h ago";
    return Math.round(hrs / 24) + "d ago";
  }

  /**
   * Take a lot off the list. Re-reads rather than splicing the local copy: the server owns this
   * state, and a widget that edited its own array would show a removal that had not actually been
   * written and would come back on the next refresh.
   *
   * ⚠️ No confirm dialog. This is one row of a personal ledger, the action is recorded rather than
   * destructive (the lot is kept, written off), and a modal over a game is worse than a mis-click.
   */
  async function forgetLot(lot) {
    if (!lot || !lot.id) return;
    try {
      await fetch("/api/trade/journal/forget?lot=" + encodeURIComponent(lot.id), { method: "POST" });
    } catch { /* offline sidecar: the reload below simply shows the unchanged list */ }
    await loadJournal();
    render();
  }

  /** "57m" / "2h 14m". Minutes, because a trade run is a minutes-scale thing. */
  function tdDur(mins) {
    const m = Math.max(0, Math.round(Number(mins) || 0));
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  /** Terminal tokens as the LOG writes them (`TDD_SCShop-001`, `SCShop_Admin_Area18`). Nothing
   *  joins these to the price table's terminal names yet, so they are tidied rather than
   *  translated — inventing a mapping would be the confidently-wrong kind of wrong. */
  function tdShop(token) {
    if (!token) return "somewhere";
    return String(token).replace(/^SCShop[_-]?/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "somewhere";
  }

  /** 🔑 SAME LOCAL-DAY BUCKET AS THE SERVER (`isToday` in src/trade-journal.ts). The block's
   *  figures come from `j.today`, which the sidecar computed; the LIST is filtered here. If the
   *  two disagreed, the headline would say two runs over a list of three and nothing on screen
   *  would say which was lying. Same machine, same clock, same comparison. */
  function tdIsToday(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return false;
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth()
      && d.getDate() === n.getDate();
  }

  /** 🔴 THE BALANCE BLOCK — the change that makes this tab a LEDGER rather than a log.
   *
   *  It replaces two stacked totals blocks (Today, then All time) that between them spent a
   *  MEASURED 193px before the first entry appeared, and one of which was usually all zeroes.
   *  Meanwhile the two facts a trader actually needs — what capital is tied up in the hold, and
   *  what was sold with no cost basis — sat at the BOTTOM under quiet headers. On Sub's own
   *  journal that meant a headline of +304 while 37,789 sat unshown in his ship: the buried
   *  number was 124x the printed one.
   *
   *  Three accounts, side by side, above everything:
   *    REALISED      - closed trades. The only one of the three that is profit.
   *    HELD AT COST  - capital in unsold lots. Deliberately NOT period-filtered: it is a position
   *                    NOW, not something that happened today, and its label omits the period so
   *                    it cannot be read as one.
   *    NO COST BASIS - sold, purchase never seen. Revenue with nothing to subtract.
   *
   *  🔑 ALL THREE ARE ALWAYS DRAWN, with an em dash when empty. A figure that appears only when
   *  something has gone wrong is one nobody learns to read, and its absence is then
   *  indistinguishable from it never having been computed. */
  function tdBalance(body, t, open) {
    const bal = document.createElement("div");
    bal.className = "bal";
    const per = journalPeriod === "today" ? "today" : "all time";

    const cell = (label, value, cls, sub, tip) => {
      const d = document.createElement("div");
      const k = document.createElement("div"); k.className = "k"; k.textContent = label;
      const v = document.createElement("div"); v.className = "v" + (cls ? " " + cls : "");
      v.textContent = value;
      const u = document.createElement("div"); u.className = "u"; u.textContent = sub;
      if (tip) d.title = tip;
      d.append(k, v, u);
      bal.appendChild(d);
      return d;
    };

    // 🔑 THE LABEL NEVER CARRIES THE PERIOD, and the value is abbreviated. Both exist so three
    // columns survive 320px without folding — see the note on `.bal` in hauling.html. The
    // period rides the sub-line, where it is still on screen and no longer the thing that
    // decides whether the heading fits.
    cell("Realised",
      t.runs ? (t.profit >= 0 ? "+" : "") + tdMoney(t.profit) : "—",
      t.runs ? (t.profit >= 0 ? "up" : "down") : "none",
      per + (t.runs ? " · " + t.runs + (t.runs === 1 ? " run" : " runs") : " · none"),
      "Profit from trades we saw both ends of — everything else on this row is deliberately"
        + " outside it."
        + (t.runs ? "\n\n" + num(Math.round(t.profit)) + " aUEC from " + t.runs
            + (t.runs === 1 ? " run, " : " runs, ") + tdDur(t.minutes) + " in cargo." : ""));

    // Held is a NOW figure — see the note above. It never takes the period.
    const heldCost = open.reduce((a, o) => a + (Number(o.pricePerScu) || 0) * (Number(o.scu) || 0), 0);
    const heldScu = open.reduce((a, o) => a + (Number(o.scu) || 0), 0);
    cell("Held at cost",
      open.length ? tdMoney(heldCost) : "—",
      open.length ? "held" : "none",
      open.length ? open.length + (open.length === 1 ? " lot · " : " lots · ") + num(heldScu) + " SCU"
        : "nothing unsold",
      "What you paid for cargo you have not sold yet. Not a profit and not a loss — it is the"
        + " money you are standing on, and what you have left to buy the next run with."
        + (open.length ? "\n\n" + num(Math.round(heldCost)) + " aUEC across " + open.length
            + (open.length === 1 ? " lot." : " lots.") : ""));

    cell("No cost basis",
      t.unpricedSales ? tdMoney(t.unpricedRevenue) : "—",
      t.unpricedSales ? "down" : "none",
      per + (t.unpricedSales ? " · " + t.unpricedSales
        + (t.unpricedSales === 1 ? " sale" : " sales") : " · none"),
      "Sold, but we never saw it bought, so there is no cost to subtract. Reported as revenue"
        + " and deliberately kept out of the profit figure."
        + (t.unpricedSales ? "\n\n" + num(Math.round(t.unpricedRevenue)) + " aUEC of revenue." : ""));
    body.appendChild(bal);
  }

  /** A section heading with the swatch that ties it to its figure in the balance block. */
  function tdAcctSec(body, label, acct, note) {
    const sec = document.createElement("div");
    sec.className = "sec";
    const dot = document.createElement("span");
    dot.className = "acct " + acct;
    const h = document.createElement("span"); h.textContent = label;
    sec.append(dot, h);
    if (note) {
      const n = document.createElement("span"); n.className = "n"; n.textContent = note;
      sec.appendChild(n);
    }
    body.appendChild(sec);
    return sec;
  }

  function renderJournal() {
    const body = $("body");
    body.textContent = "";

    const bar = document.createElement("div");
    bar.className = "tdbar";
    // 🔴 THE PERIOD SWITCH REPLACES THE SECOND TOTALS BLOCK. The same two rollups, one at a time,
    // in a control that also states which one you are reading - where two stacked blocks made you
    // recover that from a heading you had already scrolled past.
    const setPeriod = (p) => {
      journalPeriod = p;
      try { localStorage.setItem(TD_PERIOD_KEY, p); } catch { /* private mode */ }
      render();
    };
    tdBtn(bar, "Today", journalPeriod === "today", "What today's closed trades made",
      () => setPeriod("today"));
    tdBtn(bar, "All time", journalPeriod === "all", "Every closed trade on record",
      () => setPeriod("all"));
    const sep = document.createElement("span"); sep.className = "sep"; bar.appendChild(sep);
    tdBtn(bar, "Refresh", false, "Re-read the journal", () => loadJournal());
    body.appendChild(bar);

    const j = tradeJournal;
    if (!j) {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = "Reading your trade log…";
      body.appendChild(e);
      return;
    }

    const t = journalPeriod === "today" ? j.today : j.allTime;
    const runs = journalPeriod === "today" ? j.runs.filter((r) => tdIsToday(r.soldAt)) : j.runs;

    // 🔑 THE BLOCK IS DRAWN EVEN WHEN EVERY FIGURE IS EMPTY. Three em dashes are a reading; a
    // blank screen is not, and "the app is broken" is the other way to read one.
    tdBalance(body, t, j.open);

    if (!j.runs.length && !j.open.length && !j.unmatched.length
        && !(j.writtenOff && j.writtenOff.length)) {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = "Nothing recorded yet.";
      body.appendChild(e);
      const w = document.createElement("div"); w.className = "empty sub";
      // 🔑 Say WHY it can be empty, because "the app is broken" is the other reading and it is
      // the wrong one. Purchases are only seen while the app is running or in a recent log.
      w.textContent = "Buys and sells are picked up from the game log while the app is running. "
        + "A trade made before you started it — or long enough ago that its log has rotated away — "
        + "cannot be recovered.";
      body.appendChild(w);
      return;
    }

    if (runs.length) {
      tdAcctSec(body, journalPeriod === "today" ? "Sold today" : "Sold", "realised",
        runs.length + (runs.length === 1 ? " run" : " runs"));

      for (const r of runs.slice(0, 40)) {
        // ⚠️ The SAME row shape as the Runs board, and the one difference is the one that matters:
        // this figure is green or red because it came out of the player's own log. A forecast may
        // never be dressed this way - see the note on `.tdrow .l1 .p` in hauling.html.
        const { row, chips } = tdSpineRow({
          title: r.commodity || "Unknown commodity",
          profit: (r.profit >= 0 ? "+" : "") + tdMoney(r.profit),
          profitClass: r.profit >= 0 ? "up" : "down",
          profitLabel: "profit",
          route: tdShop(r.buyShop) + "  →  " + tdShop(r.sellShop),
          rate: new Date(r.soldAt).toLocaleString([], {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          }),
          buy: Math.round(r.buyPricePerScu),
          sell: Math.round(r.sellPricePerScu),
          marginPct: r.marginPct,
          metrics: [[num(r.scu), "SCU"], [tdDur(r.minutes), "held"]],
        });
        // One chip, and only when there is a rate to state. `profitPerHour` is null when the buy
        // and the sell share a timestamp, which is not a rate of zero - it is no rate at all.
        if (r.profitPerHour !== null && r.profitPerHour !== undefined) {
          tdChip(chips, tdMoney(r.profitPerHour) + "/hr", "calm");
        }
        body.appendChild(row);
      }
    } else if (journalPeriod === "today" && j.allTime.runs) {
      // 🔑 Not a bare "nothing" - an empty TODAY beside a non-empty record reads as a broken app
      // unless the record is named and the way to it is on screen.
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = "No closed trades today. "
        + j.allTime.runs + (j.allTime.runs === 1 ? " run" : " runs") + " on record — "
        + "switch to All time to see them.";
      body.appendChild(e);
    }
    /* ── bought and not yet sold ───────────────────────────────────────────────
       🔴 THIS SECTION SAID TWO CONTRADICTORY THINGS AT ONCE. The heading was "Still aboard" and a
       row under it could read "on the elevator" — which means the exact opposite, i.e. NOT aboard.
       Sub, looking at his own board: *"the stuff that I turned in, it says on the elevator. I don't
       even know what that's supposed to mean."*

       Two separate faults, and only one of them was the wording:

       1. 🔑 `autoLoaded` IS A FACT ABOUT THE MOMENT OF PURCHASE, NOT A LOCATION. It is the
          `autoLoading[0|1]` flag off the buy line: where the game put the cargo when you paid for
          it. Nothing in the log ever updates it, so rendering it in the present tense is a claim
          the app cannot keep true for one minute past the sale, let alone the three days Sub's lot
          had been sitting there. Past tense, and the age beside it, is the whole repair — the
          information is still useful ("that one is a walk"), it just stops being asserted as now.
       2. The lot Sub was reading really was a leftover, and the journal was right about it: he
          bought 2 SCU of Processed Food on 2026-08-19, one auto-loaded and one to the elevator,
          and sold 1. FIFO closed the auto-loaded lot and left the elevator one. Verified against
          the corpus: there has been no commodity buy or sell in ANY log since 18:49 that day, so
          nothing is missing from the record. It reads wrong because it is worded wrong.

       ⚠️ The heading no longer says where anything is, because the journal does not know. */
    if (j.open.length) {
      const sec = document.createElement("div");
      sec.className = "sec";
      const dot = document.createElement("span"); dot.className = "acct held";
      const h = document.createElement("span"); h.textContent = "Bought, not sold";
      const n = document.createElement("span"); n.className = "n";
      n.textContent = num(j.open.reduce((a, o) => a + o.scu, 0)) + " SCU unsold";
      sec.append(dot, h, n);
      body.appendChild(sec);
      for (const o of j.open.slice(0, 20)) {
        const row = document.createElement("div");
        row.className = "trow";
        const nm = document.createElement("div");
        nm.className = "tnm";
        nm.textContent = (o.commodity || "Unknown") + " · " + num(o.scu) + " SCU";
        const val = document.createElement("div"); val.className = "tval";
        val.textContent = "cost " + num(Math.round(o.pricePerScu)) + "/SCU · " + tdShop(o.shopName)
          + " · " + tdAgo(o.at);
        row.append(nm, val);
        // Past tense on purpose — see the note above. The title carries the part that will not fit.
        if (o.autoLoaded === false) {
          tdChip(val, "went to the elevator", "warn").title =
            "When you bought it, the game put it on the freight elevator rather than into the ship. "
            + "That is where it started; nothing in the log says where it is now.";
        } else if (o.autoLoaded === true) {
          tdChip(val, "loaded straight in", "calm").title =
            "When you bought it, the game put it straight into the ship. That is where it started; "
            + "nothing in the log says where it is now.";
        }
        /* 🔴 THE ONE CONTROL THIS FLIGHT ADDS. Cargo that was destroyed never produces a sale, so
           the lot can never close on its own — Sub flew a loaded ship into a wall to see what would
           happen and it has been listed ever since. There is no automatic cure: a commodity lot's
           only identity is its `resourceGUID`, which never appears on an inventory or destruction
           line anywhere in the 480-log corpus, so nothing the game writes can be joined to it. The
           player is the only witness. See `trade-journal.ts` for the measurements.
           🔑 It writes the lot OFF rather than deleting it — the money really was spent, so the
           cost stays on the record and out of the profit total. */
        tdBtn(row, "✕", false,
          "Cargo gone? Take it off the list. The cost stays on record and out of profit.",
          () => forgetLot(o));
        body.appendChild(row);
      }
    }

    /* 🔑 ONE LINE, NOT A SECTION. Write-offs are the player's word rather than the log's, so they
       have to be visible — a profit total quietly ignoring cargo you paid for is optimistic in
       exactly the way this file refuses to be about revenue. But they are also the least
       interesting thing here, and Sub asked for this stuff to go AWAY. So: stated, once, with the
       money named, and never folded into anything above. */
    if (j.writtenOff && j.writtenOff.length) {
      const w = document.createElement("div");
      w.className = "note";
      const cost = j.writtenOff.reduce((a, x) => a + (Number(x.cost) || 0), 0);
      w.textContent = j.writtenOff.length + (j.writtenOff.length === 1 ? " lot" : " lots")
        + " written off · " + tdMoney(cost) + " spent and not counted in the profit above.";
      body.appendChild(w);
    }

    if (j.unmatched.length) {
      const sec = document.createElement("div");
      sec.className = "sec";
      const dot = document.createElement("span"); dot.className = "acct nobasis";
      const h = document.createElement("span"); h.textContent = "Sold — cost unknown";
      sec.append(dot, h);
      body.appendChild(sec);
      const why = document.createElement("div");
      why.className = "note";
      why.textContent = "We did not see these bought, so there is no cost to subtract. "
        + "Shown as revenue, and deliberately left out of the profit above.";
      body.appendChild(why);
      for (const u of j.unmatched.slice(0, 20)) {
        const row = document.createElement("div");
        row.className = "trow";
        const nm = document.createElement("div");
        nm.className = "tnm";
        nm.textContent = (u.commodity || "Unknown") + " · " + num(u.scu) + " SCU";
        const val = document.createElement("div"); val.className = "tval";
        val.textContent = num(Math.round(u.revenue)) + " revenue · " + tdShop(u.sellShop);
        row.append(nm, val);
        body.appendChild(row);
      }
    }
  }

  /** Where the current route plan is heading, if anywhere - the backhaul anchor. Deliberately the
   *  LAST stop's body: an intermediate stop is somewhere you are passing through, and cargo bought
   *  for it has to come off before the run is done. */
  function tdPlanDestination() {
    try {
      const trips = (plan && plan.trips) || [];
      const last = trips[trips.length - 1];
      if (!last || !last.stops || !last.stops.length) return null;
      const stop = last.stops[last.stops.length - 1];
      const names = (plan && plan.locationNames) || {};
      return stop.destination || names[stop.location] || null;
    } catch { return null; }
  }
