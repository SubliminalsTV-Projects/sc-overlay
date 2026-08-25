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
  /* ── THE FUNNEL: what -> buy at -> sell at (2026-08-25) ─────────────────────────────────────
     Sub picked this out of three mockups. His own words for what it is:

       "we'll let them search for the buy-in location. And we'll let them search for the drop-off
        location once they pick the pickup location."

     🔑 THREE SLOTS, AND AN UNSET SLOT IS A FILTER THAT IS NOT APPLIED. With all three empty this
     tab is byte-for-byte the leaderboard it has always been, so nobody has had anything taken away
     — the board has been given a steering wheel. Each filled slot narrows the SAME list; there is
     never a second view and never a mode.

     🔴 EVERY SLOT VALUE COMES FROM DATA, NEVER FROM TYPING. `what` is picked off
     /api/trade/names, and the terminals are picked off `buyAt`/`sellAt` — so a place the commodity
     cannot be bought at is UNREACHABLE rather than merely discouraged. That is the same property
     the Route tab's picker needs, which is why they share one source.

     🔑 THE BODY IS ALWAYS /api/trade/routes. The slots only add query params. There is exactly one
     solver and the widget does no arithmetic of its own — the alternative was a second code path
     producing rows, which is the mistake this file's header already warns about.

     ⛔ `tradeSystem` and `tradeToBody` ARE GONE and must not come back as separate state. They were
     "where a run starts" and "where it ends" living in two variables with two controls; they are
     `tdBuyAt` and `tdSellAt` now, and Backhaul writes into the second one rather than owning a
     third. Two writers on one filter is how a control and the thing it controls drift apart. */

  /** null = unset. Otherwise `{ kind: "system" | "body" | "terminal", name }`. The KIND decides
   *  which query param it becomes, which is why it travels with the name. */
  let tdBuyAt = null;
  let tdSellAt = null;
  /** "" = any commodity. Exact, because it was picked from the names list. */
  let tdWhat = "";
  /** Which slot is open for editing, and what has been typed into it. */
  let tdOpen = null;           // "what" | "buy" | "sell" | null
  let tdTyped = "";
  /** /api/trade/commodity for `tdWhat`, so a slot can offer that commodity's real terminals. */
  let tdLookup = null;
  /** /api/trade/names, fetched once. */
  let tdNames = null;
  /** Slot state is remembered — which system you trade in is a habit, not a per-visit decision. */
  const TD_WHAT_KEY = "sc-trade-what";
  const TD_BUYAT_KEY = "sc-trade-buyat";
  const TD_SELLAT_KEY = "sc-trade-sellat";
  const TD_HOLD_KEY = "sc-trade-hold";
  const TD_UNIT_KEY = "sc-trade-unit";
  /**
   * How much the player intends to buy, when that is not "as much as the ship holds".
   *
   * 🔴 THIS IS NOT THE PICK'S TONNAGE AND MUST NEVER BECOME IT. The standing ruling — that a run
   * sent to the Route carries NO tonnage, because the log will state what was really bought — is
   * about the QUANTITY OF A PURCHASE. This is the `capacity` the finder ranks against, which has
   * always been an input (it is what the ship picker feeds) and is a question about the SEARCH, not
   * a claim about a transaction. `tdPickBuy` still sends no tonnage; nothing here changes that.
   * 🔑 null = auto, i.e. the whole hold. Stored as a number so `0` and "unset" cannot be confused.
   */
  let tdHold = (() => {
    try {
      const raw = localStorage.getItem(TD_HOLD_KEY);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    } catch { return null; }
  })();
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

  /**
   * The provenance strip: one pill and an ⓘ, replacing the two paragraphs of the first cut.
   * 🔑 THREE STATES, THREE COLOURS, because "offline by choice", "tried and failed" and "fresh"
   * are different facts and must not read alike.
   *
   * 🔴 IT RENDERS INTO THE CREDIT BAR NOW, beside UEX's own mark (Sub, 2026-08-25) — see the
   * `#uexfresh` comment in hauling.html. Still ONE writer: this function.
   *
   * ⚠️ THE AGE ON THE FACE IS WHEN WE LAST FETCHED THE TABLE, NOT HOW OLD THE PRICES ARE, and
   * those differ by about five weeks — the live table's median row age measured 38 days on
   * 2026-08-22, against a six-hourly refresh. That is exactly the misreading the ⓘ has always
   * existed to deny, which is why the age ships WITH the pill that carries the ⓘ rather than as a
   * bare number somewhere else, and why the denial is the second sentence of the tip rather than
   * the last. Per-row age is still on every row and is still the number worth trusting.
   */
  function tdProvenance(bar, d) {
    /** "2h" / "3d" for a fetch time, or "" when there is nothing to say. */
    const fetched = (at) => {
      if (!at) return "";
      const mins = Math.round((Date.now() - at) / 60000);
      if (mins < 60) return mins < 1 ? "just now" : mins + "m";
      const hrs = Math.round(mins / 60);
      return hrs < 48 ? hrs + "h" : Math.round(hrs / 24) + "d";
    };
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
      const age = fetched(d.fetchedAt);
      txt.textContent = age ? "live · " + age : "live";
      const mins = d.fetchedAt ? Math.round((Date.now() - d.fetchedAt) / 60000) : null;
      tip = "Live prices, community-reported through UEX."
        + (mins !== null ? " Our copy was refreshed " + (mins < 1 ? "just now" : mins < 90 ? mins + " minutes ago" : Math.round(mins / 60) + " hours ago") + "." : "")
        + " Reports come from players, so each row shows its OWN age — that is the number worth"
        + " trusting, not how recently we refreshed."
        + (d.droppedOffline ? " " + d.droppedOffline + " terminals are hidden: UEX has prices for them but they are not in the game right now." : "");
    } else if (d.source === "cache") {
      pill.className = "tdsrc cache";
      const age = fetched(d.fetchedAt);
      txt.textContent = age ? "cache · " + age : "cache";
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

    /* 🔴 THE PILL NO LONGER CARRIES AN ⓘ OF ITS OWN — the UEX ⓘ in the credit sentence carries
       this exact text instead (Sub, 2026-08-25, asked for one ⓘ per SOURCE). Three ⓘ in a 440px
       strip is clutter, and two of them would have explained the same subject: the pill IS the
       freshness of UEX's table, so "how fresh is this" and "what is UEX" are one answer. The pill
       keeps its `title` for hover; the click affordance moved rather than being dropped, which is
       the same rule as the pill itself moving rather than being copied. */
    setCreditTip("uex", tip);
  }

  /**
   * Fill one of the two credit ⓘ popovers, and its button's hover `title`.
   *
   * 🔑 A real <button> + popover, because `title` alone cannot be opened by CLICKING and Sub has
   * already hit that once on a different info affordance and reported it as doing nothing. The
   * popover is in the TOP LAYER, so it is immune to every ancestor's `overflow` and takes no space
   * in layout — which is what makes it safe to hang out of a 440px strip.
   * ⚠️ Filled on open and cleared on close, so the explanation is never also sitting inside the
   * strip's own textContent.
   */
  function setCreditTip(which, tip) {
    const btn = document.getElementById(which === "sco" ? "scoInfo" : "uexInfo");
    if (!btn) return;
    btn.title = tip;
    const id = which === "sco" ? "scoInfoPop" : "uexInfoPop";
    let pop = document.getElementById(id);
    if (!pop) {
      pop = document.createElement("div");
      pop.id = id;
      pop.className = "tdpop";
      pop.setAttribute("popover", "");
      document.body.appendChild(pop);
      pop.addEventListener("beforetoggle", (e) => {
        pop.textContent = e.newState === "open" ? (pop.dataset.tip || "") : "";
      });
    }
    // Held on the element rather than closed over, so a re-render replaces the text instead of
    // stacking another listener that would fight the first one for the same node.
    pop.dataset.tip = tip;
  }

  /* ── loading ────────────────────────────────────────────────────────────── */

  /**
   * How much hold the board should rank against.
   *
   * 🔴 `plan.shipScu` NEVER EXISTED. It appeared exactly once in this repository — on the line that
   * read it — and nothing has ever written it; the sidecar publishes `plan.ship.totalScu`. So this
   * function returned null on every call for its whole life and `loadTrade()` fell through to the
   * hardcoded 64. Sub's C2 Hercules holds **696**, and the board was ranking every run for a 64 SCU
   * hold: `scuBound: "hold"` on the top rows means that wrong number was the BINDING constraint, so
   * the ORDER was wrong, not merely the profit figures. Sub, 2026-08-25: "I'm buying a Griseum
   * right now… and it says 64 SCU. However, in-game, I could buy 256 SCU."
   * 🔑 The family is the one this codebase has hit repeatedly — a payload is rebuilt or renamed and
   * a reader keeps naming the old field. `undefined` is falsy, so the fallback swallowed it in
   * silence and the number on screen was always plausible.
   *
   * 🔑 THE OVERRIDE OUTRANKS THE SHIP, because it is the player telling us something we cannot
   * detect: how much they actually intend to buy. A full hold is the DEFAULT, not the rule.
   */
  function tdCapacity() {
    if (tdHold && tdHold > 0) return tdHold;
    const totals = plan && plan.ship && plan.ship.totalScu;
    if (typeof totals === "number" && totals > 0) return totals;
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
      tdSlotParams(p);
      /* 🔑 A PINNED BUY NEEDS A LONGER LIST. With `fromTerminal` set the finder returns one row per
         DESTINATION rather than one per buy point, and that list IS the answer to "where can I take
         this" — capping it at 25 would silently hide drop-offs, which on a commodity like Neon (19
         sell terminals) is most of the safe ones. Everywhere else 25 is still right: those rows are
         one decision each and nobody reads past the first screen. */
      p.set("limit", tdBuyAt && tdBuyAt.kind === "terminal" ? "60" : "25");
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

  /**
   * Turn the three slots into query params.
   *
   * 🔑 The KIND decides the param, which is why a slot stores it rather than just a name: a system,
   * a body and a terminal are three different filters and the finder has a separate option for
   * each. Getting this wrong is silent — `fromSystem: "Ashland"` matches nothing and reads exactly
   * like "there are no routes".
   */
  function tdSlotParams(p) {
    if (tdWhat) p.set("commodity", tdWhat);
    const put = (slot, sys, body, term) => {
      if (!slot || !slot.name) return;
      p.set(slot.kind === "system" ? sys : slot.kind === "body" ? body : term, slot.name);
    };
    put(tdBuyAt, "fromSystem", "fromBody", "fromTerminal");
    put(tdSellAt, "toSystem", "toBody", "toTerminal");
  }

  /** Provenance + the system list, before any query has been run. Also the one place the buy-at
   *  slot gets its default, which is why it runs before the first `loadTrade()`. */
  async function loadTradeStatus() {
    try {
      const r = await fetch("/api/trade/status", { cache: "no-store" });
      if (!r.ok) return;
      tradeStatus = await r.json();
      if (tdBuyAt === null) tdBuyAt = tdRestoreBuyAt();
      if (tdWhat === "") { try { tdWhat = localStorage.getItem(TD_WHAT_KEY) || ""; } catch { /* private mode */ } }
      if (tdSellAt === null) { try { tdSellAt = JSON.parse(localStorage.getItem(TD_SELLAT_KEY) || "null"); } catch { tdSellAt = null; } }
      if (tdWhat) loadTdLookup();
    } catch { /* the routes call reports its own failure */ }
  }

  /**
   * What the buy-at slot should say on a cold start.
   *
   * 🔑 DEFAULT TO WHERE THE LOG SAYS YOU ARE — but only if that system actually has somewhere to
   * buy, or the first thing the player sees is an empty board. This is the rule the old `buy in`
   * pills had and it is worth keeping: Sub's own reason for wanting a system filter at all was
   * "Fallow Field, where I can buy Bexalite, is in Pyro. But I'm in Stanton."
   *
   * ⚠️ It also migrates the OLD `sc-trade-system` preference. Dropping it would silently forget the
   * filter every existing user has already set, which reads as the app resetting itself.
   */
  function tdRestoreBuyAt() {
    let saved = null;
    try { saved = localStorage.getItem(TD_BUYAT_KEY); } catch { /* private mode */ }
    if (saved !== null) { try { return JSON.parse(saved); } catch { /* corrupt — fall through */ } }
    let legacy = null;
    try { legacy = localStorage.getItem(TD_SYS_KEY); } catch { /* private mode */ }
    if (legacy !== null) return legacy ? { kind: "system", name: legacy } : null;
    const here = ((tradeStatus && tradeStatus.here) || "").toLowerCase();
    const match = ((tradeStatus && tradeStatus.systems) || []).find((s) => s.toLowerCase() === here);
    return match ? { kind: "system", name: match } : null;
  }

  /* ⛔ `loadTradeNames` / `loadTradeCommodity` went with the Market tab (2026-08-23) and are BACK
     (2026-08-25) for the funnel — but they feed SLOT OPTIONS now, not a second view. The rows on
     screen still come from /api/trade/routes and nothing else, which is what keeps one solver. */

  /** Every tradable commodity, for the `what` slot. Fetched once; the table does not change while
   *  the process is up. */
  async function loadTdNames() {
    if (tdNames) return;
    try {
      const r = await fetch("/api/trade/names", { cache: "no-store" });
      if (r.ok) tdNames = (await r.json()).names || [];
    } catch { /* the slot falls back to whatever the board already shows */ }
    if (view === "trade") render();
  }

  /** The chosen commodity's real buy and sell terminals, for the two place slots. */
  async function loadTdLookup() {
    if (!tdWhat) { tdLookup = null; return; }
    const want = tdWhat;
    try {
      const r = await fetch("/api/trade/commodity?name=" + encodeURIComponent(want), { cache: "no-store" });
      // ⚠️ Guard against an out-of-order answer: two quick picks can land backwards, and the slot
      // would then offer the PREVIOUS commodity's terminals under the current commodity's name.
      if (r.ok && tdWhat === want) tdLookup = await r.json();
    } catch { tdLookup = null; }
    if (view === "trade") render();
  }

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
      /* 🔴 NAME THE SLOT THAT EMPTIED IT, NEWEST CONSTRAINT FIRST. "No profitable run found" over a
         filter the player set two clicks ago is indistinguishable from a broken feature, and the
         funnel makes that far easier to walk into than the single system pill ever did — three
         constraints can compose down to nothing while each one looks reasonable on its own. */
      /* 🔴 SAY WHICH SIDE IS MISSING WHEN A COMMODITY HAS ONLY ONE. `/api/trade/names` is every
         commodity that can be BOUGHT somewhere — it does not promise anyone buys it back, and the
         table really does hold such commodities (Agricium: 4 buy terminals, 0 sell). Without this
         the funnel offers a name and then answers with "nothing worth carrying", which reads as the
         filter being broken rather than as a fact about the commodity. Found by a test that picked
         one of them at random. */
      const noSell = !!(tdWhat && tdLookup && (tdLookup.sellAt || []).length === 0);
      const noBuy = !!(tdWhat && tdLookup && (tdLookup.buyAt || []).length === 0);
      e.textContent = noSell
        ? "Nobody in the price table buys " + tdWhat + " back, so there is no run for it — only places to buy it."
        : noBuy
          ? "Nowhere in the price table sells " + tdWhat + ", so there is nothing to pick up."
          : tdSellAt
          ? "Nothing worth carrying to " + tdSellAt.name + (tdWhat ? " — try another commodity, or clear “sell at”." : " — clear “sell at” to see everywhere.")
          : tdBuyAt && tdWhat
            ? "No profitable run for " + tdWhat + " out of " + tdBuyAt.name + ". Clear “buy at” to see it from everywhere."
            : tdWhat
              ? "Nothing worth carrying for " + tdWhat + " with this hold."
              : tdBuyAt
                ? "No profitable run starting in " + tdBuyAt.name + " for this hold. Clear “buy at” for every system."
                : "No profitable run found for this hold.";
      body.appendChild(e);
      return;
    }

    tdTradeoff(body);

    const sec = document.createElement("div");
    sec.className = "sec";
    const h = document.createElement("span");
    /* 🔑 THE HEADING SAYS WHICH QUESTION IS BEING ANSWERED, because the funnel changes it. With a
       buy pinned these rows are DESTINATIONS, not runs to choose between — same row shape, but the
       decision in front of the player is a different one and the header is where that is said. */
    h.textContent = tdBuyAt && tdBuyAt.kind === "terminal"
      ? "Take it to"
      : tdWhat ? tdWhat + " runs"
        : tdSellAt ? "On your way to " + tdSellAt.name
          : "Worth carrying";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = tdBuyAt && tdBuyAt.kind === "terminal"
      ? d.routes.length + (d.routes.length === 1 ? " place · from " : " places · from ") + tdBuyAt.name
      : (d.ship ? d.ship + " · " : "") + num(d.capacityScu) + " SCU hold";
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
      else if (!tdBuyAt && r.from.system) tdChip(chips, r.from.system, "calm");

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
      /* 🔴 RIGHT-JUSTIFIED, IN A COLUMN OF ITS OWN (Sub, 2026-08-25): "it's a massive pill right
         next to the smaller pills for the different commodities. I think if it was right-justified
         in its own kind of column, or the same column as the price, that would look a lot better."
         `.tdrow .tdchips .hbtn { margin-left: auto }` does it in one declaration — and because the
         chip row ends at the row's own padding, the button lands on exactly the right edge `.p` and
         `.pk` already use, which is the "same column as the price" reading too.
         ⛔ NOT a right-hand RAIL beside the price, which is what the mockup drew. A rail reserves
         its width on every row at every width, and Sub removed precisely that on 2026-08-23 after
         measuring it at 320px: the old `money + tdcap` shape needed 260px in 176 and clipped the
         margin and the quantity off four rows at once. See the note above `.tdrow .l1` in
         hauling.html. Pushing the button right costs nothing and re-opens nothing. */
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
    /* 🔴 THE PROVENANCE PILL RENDERS INTO THE CREDIT BAR, not into this filter bar (Sub,
       2026-08-25: "next to the UEX badge at the bottom"). It is a MOVE — `tdProvenance` is still
       the only writer — and it is emptied first, because `#uexfresh` lives outside `#body` and so
       survives the `body.textContent = ""` above that clears everything else on this tab. Without
       the clear it would accumulate one pill per render, forever. */
    const fresh = $("uexfresh");
    if (fresh) { fresh.textContent = ""; tdProvenance(fresh, tradeStatus); }

    // ⚠️ Runs / Look up used to be buttons in here, then TOP TABS. Look up (Market) is retired
    // and this bar carries only the Runs filters, unconditionally — the `tradeMode` guard that used
    // to wrap all of this went with the second view it was choosing between.
    /* ⛔ THE `buy in` PILL ROW IS GONE — it did not shrink, it MOVED. It was "where a run starts",
       which is the funnel's second slot, and leaving a second control writing the same filter is
       how a control and the thing it controls drift apart. The bar keeps only what is genuinely
       about DISPLAY (Per run / Per SCU), which is also why this bar is now one row where it used
       to wrap to two. */

    /* ⛔ "CONFIRMED STOCK" IS GONE (Sub, 2026-08-25). It hid rows on an axis the player can already
       read off the row: every row carries its own age pill and a `stock unknown` / `N on the shelf`
       chip, so the toggle asked people to re-derive from a filter what the row already states.
       Sub: "It seems like whatever confirms it is like the amount of days since it's last been
       updated. The player can see that themselves. We don't need to help them sort that out."
       Second reason, and the one that made it actively bad: as a lit/unlit pill with a fixed label
       there was no way to tell whether it was currently adding rows or removing them.
       🔑 The server still accepts `knownStock=1` on /api/trade/routes — the widget simply stops
       sending it. Nothing else in the app ever did, so the parameter is now unused, like `budget`
       and `maxAgeDays` beside it. Left alone deliberately: deleting a query parameter is a sidecar
       change, and this is a display decision. */

    const sep4 = document.createElement("span"); sep4.className = "sep"; bar.appendChild(sep4);
    const setUnit = (u) => {
      tradeUnit = u;
      try { localStorage.setItem(TD_UNIT_KEY, u); } catch { /* private mode */ }
      render();   // a display choice; the data is unchanged, so no refetch
    };
    tdBtn(bar, "Per run", tradeUnit === "run", "What the whole trip clears", () => setUnit("run"));
    tdBtn(bar, "Per SCU", tradeUnit === "scu", "What one SCU is worth carrying", () => setUnit("scu"));

    /* 🔑 BACKHAUL IS A SHORTCUT INTO THE `sell at` SLOT, not a filter of its own. "I am already
       flying there" is exactly `toBody`, which is what that slot sets — so it writes into `tdSellAt`
       and reads its lit state from it. One filter, two ways to reach it, and the slot shows the
       answer so the player can see what the button did. */
    const dest = tdPlanDestination();
    if (dest) {
      const on = !!(tdSellAt && tdSellAt.kind === "body" && tdSellAt.name === dest);
      tdBtn(bar, "Backhaul", on,
        "You are already flying to " + dest + " — what is worth carrying along?", () => {
          tdSetSlot("sell", on ? null : { kind: "body", name: dest });
        });
    }
    body.appendChild(bar);

    tdFunnel(body);

    if (tdBuyNote) {
      const n = document.createElement("div");
      n.className = "note";
      n.textContent = tdBuyNote;
      body.appendChild(n);
    }
    tdRenderRoutes(body);
  }

  /* ── the funnel ─────────────────────────────────────────────────────────── */

  /** Write a slot, persist it, and refetch. `null` clears.
   *
   *  🔴 CLEARING `what` CLEARS THE TERMINALS UNDER IT. A terminal slot only ever holds a place that
   *  sells or buys the CHOSEN commodity — leave it behind and the next commodity is filtered by a
   *  terminal that has nothing to do with it, which returns nothing and looks like a broken board.
   *  A system or a body survives, because those are true of any commodity. */
  function tdSetSlot(which, value) {
    if (which === "hold") { tdSetHold(value); return; }
    if (which === "what") {
      tdWhat = value || "";
      tdLookup = null;
      for (const slot of ["buy", "sell"]) {
        const cur = slot === "buy" ? tdBuyAt : tdSellAt;
        if (cur && cur.kind === "terminal") tdSetSlotState(slot, null);
      }
      try { localStorage.setItem(TD_WHAT_KEY, tdWhat); } catch { /* private mode */ }
      if (tdWhat) loadTdLookup();
    } else {
      tdSetSlotState(which, value);
    }
    tdOpen = null;
    tdTyped = "";
    loadTrade();
    render();
  }

  /** Set or clear the hold override. Anything that is not a positive whole number clears it. */
  function tdSetHold(n) {
    tdHold = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    try {
      if (tdHold) localStorage.setItem(TD_HOLD_KEY, String(tdHold));
      else localStorage.removeItem(TD_HOLD_KEY);
    } catch { /* private mode */ }
    tdOpen = null;
    tdTyped = "";
    loadTrade();
    render();
  }

  function tdSetSlotState(which, value) {
    if (which === "buy") tdBuyAt = value; else tdSellAt = value;
    try {
      localStorage.setItem(which === "buy" ? TD_BUYAT_KEY : TD_SELLAT_KEY, JSON.stringify(value));
    } catch { /* private mode */ }
  }

  /** Open a slot for editing, or close it if it is already open. */
  function tdOpenSlot(which) {
    tdOpen = tdOpen === which ? null : which;
    tdTyped = "";
    if (tdOpen === "what") loadTdNames();
    render();
  }

  /**
   * The three slots.
   *
   * 🔑 AN UNSET SLOT MUST NOT READ LIKE A VALUE. It is dim, italic, and says what filling it would
   * do rather than sitting there looking like a choice somebody made. That is the same reasoning as
   * the fixed "Confirmed stock" label: a control whose state and whose effect look alike is
   * unreadable.
   */
  function tdFunnel(body) {
    const f = document.createElement("div");
    f.className = "funnel";
    const nBuy = tdLookup && tdLookup.buyAt ? tdLookup.buyAt.length : null;
    const nSell = tdLookup && tdLookup.sellAt ? tdLookup.sellAt.length : null;
    tdSlot(f, "what", "what", tdWhat, "any commodity",
      tdWhat && nBuy !== null ? nBuy + " · " + nSell : "");
    tdSlot(f, "buy", "buy at", tdBuyAt ? tdBuyAt.name : "", "anywhere",
      tdWhat && nBuy !== null ? nBuy + (nBuy === 1 ? " place" : " places") : "");
    /* ⚠️ NOT LOCKED until a buy is picked, which is what the mockup drew and what building it
       corrected. "Sell it in Stanton" is a perfectly good filter on its own — it is the whole
       "get me out of Pyro" move — and it maps straight onto `toSystem`. Locking it would have made
       the safest question the tab can answer the one thing you cannot ask first. */
    tdSlot(f, "sell", "sell at", tdSellAt ? tdSellAt.name : "", "anywhere",
      tdWhat && nSell !== null ? nSell + (nSell === 1 ? " place" : " places") : "");
    /* 🔴 THE FOURTH SLOT, AND IT BELONGS IN THE FUNNEL RATHER THAN THE BAR. The bar's own comment
       says it keeps only what is about DISPLAY; how much you intend to buy changes the QUERY — it
       is the `capacity` parameter, the same one the ship feeds — so it goes where the other query
       constraints live. Sub, 2026-08-25: "we needed the ability for a person in the commodities tab
       to be able to modify how much they want to buy."
       🔑 THE PLACEHOLDER STATES THE AUTO VALUE RATHER THAN THE WORD "auto". A slot reading "auto"
       makes the player open it just to find out what auto MEANS, and this is the number every
       profit figure on the screen is computed from — it has to be legible without a click. That is
       also what would have made the 64-vs-696 bug visible on sight instead of invisible for
       months. */
    const autoScu = plan && plan.ship && plan.ship.totalScu;
    tdSlot(f, "hold", "buy", tdHold ? num(tdHold) + " SCU" : "",
      typeof autoScu === "number" && autoScu > 0 ? num(autoScu) + " SCU — a full hold" : "a full hold",
      tdHold && typeof autoScu === "number" && autoScu > 0 ? "of " + num(autoScu) : "");
    body.appendChild(f);
    // ⚠️ `hold` is a free numeric entry, so it has no option list. Without this guard the list box
    // opens empty under it and reads as a search that found nothing.
    if (tdOpen && tdOpen !== "hold") tdSlotList(body);
  }

  function tdSlot(f, which, label, value, placeholder, hint) {
    const row = document.createElement("div");
    row.className = "slot" + (tdOpen === which ? " open" : "");
    row.dataset.slot = which;
    const k = document.createElement("span"); k.className = "k"; k.textContent = label;
    row.appendChild(k);

    if (tdOpen === which) {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = tdTyped;
      inp.placeholder = value || placeholder;
      inp.autocomplete = "off";
      /* 🔴 THE SHARED CANVAS GRAB, not a local one. Without it every keystroke goes to the game
         instead of the box — and the release has to be the shared one too, or hiding the widget
         mid-type strands the interact key with no UI left to lower it. Same contract as the
         tonnage boxes and the place editor. */
      inp.addEventListener("focus", () => grabOn(inp));
      inp.addEventListener("blur", () => grabOff());
      inp.addEventListener("pointerdown", (e) => { e.stopPropagation(); wantFocus = inp; });
      inp.addEventListener("input", () => { tdTyped = inp.value; tdRedrawSlotList(); });
      // 🔑 A numeric slot needs a numeric keyboard on any touch surface and, more importantly here,
      // it must not offer the browser's text autofill over a figure the page already states.
      if (which === "hold") { inp.type = "number"; inp.min = "1"; inp.step = "1"; }
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); inp.blur(); tdOpen = null; tdTyped = ""; render(); }
        else if (e.key === "Enter") {
          e.preventDefault();
          /* 🔴 A BAD NUMBER CLEARS BACK TO AUTO RATHER THAN PINNING A NONSENSE HOLD. Typing "abc"
             or "0" is a mistake, and the honest response is the ship's real capacity — not a 0 SCU
             hold, which would empty the board and read as the tab being broken. Same reasoning as
             `num()` never printing a missing tonnage as "0". */
          if (which === "hold") { tdSetHold(Math.floor(Number(inp.value))); return; }
          const first = tdSlotOptions(which)[0];
          if (first) tdPickOption(which, first);
        }
        e.stopPropagation();
      });
      // Committing on blur too: a player who types a number and clicks the board has said what they
      // meant, and losing it to a missed Enter is the kind of small betrayal that stops people
      // using a control at all.
      if (which === "hold") {
        inp.addEventListener("change", () => tdSetHold(Math.floor(Number(inp.value))));
      }
      row.appendChild(inp);
      // Focus after the row is in the document, or the caret lands nowhere.
      setTimeout(() => { try { inp.focus(); inp.select(); } catch { /* gone */ } }, 0);
    } else {
      const v = document.createElement("span");
      v.className = "v" + (value ? "" : " off");
      v.textContent = value || placeholder;
      v.addEventListener("click", () => tdOpenSlot(which));
      row.appendChild(v);
    }

    if (hint) { const h = document.createElement("span"); h.className = "h"; h.textContent = hint; row.appendChild(h); }
    if (value) {
      const x = document.createElement("button");
      x.type = "button"; x.className = "x"; x.textContent = "✕";
      x.title = "Clear this";
      x.addEventListener("click", (e) => { e.stopPropagation(); tdSetSlot(which, null); });
      row.appendChild(x);
    }
    f.appendChild(row);
    return row;
  }

  /**
   * What a slot may offer.
   *
   * 🔴 THIS IS THE WHOLE SAFETY PROPERTY OF THE FUNNEL. Terminals come from `buyAt`/`sellAt`, so a
   * place the commodity cannot be bought or sold at is not merely discouraged — there is no code
   * path that offers it. Systems are always offered because a system is true of any commodity.
   *
   * 🔑 With a buy terminal pinned, the sell options come from the ROWS the server just returned, so
   * each one can state what that run actually clears. Those are the finder's own figures; the
   * widget does no arithmetic and the two can never disagree.
   */
  function tdSlotOptions(which) {
    const typed = tdTyped.trim().toLowerCase();
    let opts = [];
    if (which === "what") {
      opts = (tdNames || []).map((n) => ({ kind: "commodity", name: n }));
    } else {
      const systems = ((tradeStatus && tradeStatus.systems) || [])
        .map((s) => ({ kind: "system", name: s, sub: "anywhere in " + s }));
      let terminals = [];
      if (which === "sell" && tdBuyAt && tdBuyAt.kind === "terminal" && tradeData && tradeData.routes) {
        terminals = tradeData.routes.map((r) => ({
          kind: "terminal", name: r.to.terminalShort, price: r.to.price, system: r.to.system,
          sub: r.to.body + " · +" + tdMoney(r.profit) + " · ~" + r.minutes + "m"
            + (r.crossSystem ? " · a jump" : ""),
        }));
      } else if (tdLookup) {
        const ends = which === "buy" ? (tdLookup.buyAt || []) : (tdLookup.sellAt || []);
        terminals = ends.map((e) => ({
          kind: "terminal", name: e.terminalShort, price: e.price, system: e.system,
          sub: e.body + (e.scu === null || e.scu === undefined ? "" : " · " + num(e.scu) + " SCU")
            + (e.asOf ? " · " + tdAge((Date.now() - e.asOf * 1000) / 86400000) + " old" : ""),
        }));
      }
      /* 🔴 "BUY WHERE I AM", AND THE NAME IS THE SERVER'S, NOT THE GAME'S. The label the log gives
         ("Stanton Gateway") is not what UEX calls the terminal ("Stanton Gateway (Nyx)"), and
         `sameTerminal` matches exactly — sending the game's name returns an empty board, which
         reads as "nothing to buy here" rather than as a name that did not match. So the sidecar
         resolves it against the real quote table and hands back `hereTerminal`, or null. Null means
         no option: a "buy here" that pins the wrong station is worse than no button.
         🔑 It leads the list because it is the one entry the player does not have to know the name
         of, and it names the game's own wording underneath so the two are visibly the same place.
         ⚠️ Filtered out of `terminals` as well, or it appears twice under two different subtitles. */
      const hereName = which === "buy" && tradeStatus ? tradeStatus.hereTerminal : null;
      let here = [];
      if (hereName) {
        const gameName = tradeStatus.herePlace;
        const already = terminals.find((t) => t.name === hereName);
        here = [{
          kind: "terminal", name: hereName, price: already ? already.price : undefined,
          system: already ? already.system : undefined,
          sub: "where you are now" + (gameName && gameName !== hereName ? " · the game says " + gameName : ""),
        }];
        terminals = terminals.filter((t) => t.name !== hereName);
      }
      opts = here.concat(systems).concat(terminals);
    }
    if (!typed) return opts;
    /* Prefix before contains, so typing the start of a name puts it first — the ranking people
       expect from a box they are typing a known word into. */
    const starts = opts.filter((o) => o.name.toLowerCase().startsWith(typed));
    const has = opts.filter((o) => !o.name.toLowerCase().startsWith(typed) && o.name.toLowerCase().includes(typed));
    return starts.concat(has);
  }

  function tdPickOption(which, opt) {
    if (which === "what") tdSetSlot("what", opt.name);
    else tdSetSlot(which, { kind: opt.kind, name: opt.name });
  }

  /** Redraw only the option list while typing — re-rendering the whole tab would destroy the input
   *  under the player's cursor, which is the bug the place editor's row reuse exists to prevent. */
  function tdRedrawSlotList() {
    const old = document.querySelector("#body .slotlist");
    if (!old || !tdOpen) return;
    const fresh = tdBuildSlotList(tdOpen);
    old.replaceWith(fresh);
  }

  function tdSlotList(body) { body.appendChild(tdBuildSlotList(tdOpen)); }

  function tdBuildSlotList(which) {
    const l = document.createElement("div");
    l.className = "slotlist";
    const opts = tdSlotOptions(which);
    if (!opts.length) {
      const e = document.createElement("div");
      e.className = "o none";
      /* Say WHICH kind of nothing this is. "No matches" over an unloaded names list and over a
         genuine typo look identical, and only one of them is the player's fault. */
      e.textContent = which === "what" && !tdNames ? "Loading the commodity list…"
        : which !== "what" && !tdWhat ? "Pick a commodity first to see individual terminals."
          : "Nothing matches “" + tdTyped + "”.";
      l.appendChild(e);
      return l;
    }
    /* A hairline where systems end and terminals begin. The two are genuinely different kinds of
       answer — "anywhere in Pyro" against "this kiosk" — and without it the list reads as one
       ranking in which Stanton is somehow above Rustville. Derived from the data rather than from a
       count, so it stays correct when a filter removes every system or every terminal. */
    let sawTerminal = false;
    for (const o of opts.slice(0, 40)) {
      const d = document.createElement("div");
      d.className = "o " + (which === "buy" ? "buy" : which === "sell" ? "sell" : "what");
      if (o.kind === "terminal" && !sawTerminal) { sawTerminal = true; if (l.children.length) d.classList.add("firstterm"); }
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = o.name;
      if (o.sub) { const s = document.createElement("span"); s.className = "sub"; s.textContent = o.sub; nm.appendChild(s); }
      d.appendChild(nm);
      if (o.kind === "terminal" && o.system) {
        const b = document.createElement("span");
        /* 🔑 A JUMP, NOT A DANGER. The app knows the jump and does not know the risk. The badge
           carries a FILL rather than only a colour, because `--cyan-bright` and `--amber` compute
           30 units apart on the Drake skin and a colour-only distinction disappears there. */
        b.className = "sysb " + (tdHomeSystem() && o.system === tdHomeSystem() ? "home" : "away");
        b.textContent = o.system;
        d.appendChild(b);
      }
      if (o.price !== undefined && o.price !== null) {
        const pr = document.createElement("span"); pr.className = "pr"; pr.textContent = num(Math.round(o.price));
        d.appendChild(pr);
      }
      // pointerdown, not click: the input's blur fires first on a click and would close the list
      // out from under the pointer. Same reason the place suggestions use it.
      d.addEventListener("pointerdown", (e) => { e.preventDefault(); tdPickOption(which, o); });
      l.appendChild(d);
    }
    return l;
  }

  /** Where the log says the player is, or null. Only ever used to tint a badge. */
  function tdHomeSystem() {
    const here = (tradeStatus && tradeStatus.here) || null;
    if (!here) return null;
    const match = ((tradeStatus && tradeStatus.systems) || []).find((s) => s.toLowerCase() === String(here).toLowerCase());
    return match || null;
  }

  /**
   * 🔴 WHAT THE SAFER CHOICE COSTS, IN WORDS, ONCE.
   *
   * This is the one thing grafted from mockup C, and it is the reason the funnel is worth more than
   * a filter: a ranked list sorts by ONE number, and the decision Sub described has two. On the real
   * Neon board out of Last Landings the best-paying drop-off and the best-per-hour drop-off are
   * different terminals in different systems — more money for more time, or less money and you
   * never leave the system. No leaderboard can show that, because showing it means naming two
   * winners.
   *
   * 🔑 BOTH FIGURES COME OFF THE SERVER'S OWN ROWS. Nothing here is recomputed, so this line cannot
   * disagree with the rows underneath it.
   * ⚠️ It only appears when the two really are different rows. A "trade-off" between a row and
   * itself is noise, and a line that is always there is one nobody reads.
   */
  function tdTradeoff(body) {
    const rows = (tradeData && tradeData.routes) || [];
    if (!tdBuyAt || tdBuyAt.kind !== "terminal" || rows.length < 2) return;
    const byHour = rows[0];               // the finder returns them ranked per hour
    let byMoney = rows[0];
    for (const r of rows) if (r.profit > byMoney.profit) byMoney = r;
    if (byMoney === byHour) return;

    const t = document.createElement("div");
    t.className = "tradeoff";
    const txt = (s) => document.createTextNode(s);
    const strong = (s) => { const b = document.createElement("b"); b.textContent = s; return b; };
    t.append(
      txt("Two different answers. "),
      strong(byMoney.to.terminalShort + (byMoney.to.system ? " (" + byMoney.to.system + ")" : "")),
      txt(" clears " + tdMoney(byMoney.profit) + " in ~" + byMoney.minutes + " min. "),
      strong(byHour.to.terminalShort + (byHour.to.system ? " (" + byHour.to.system + ")" : "")),
      txt(" clears " + tdMoney(byHour.profit) + " in ~" + byHour.minutes + " min — "
        + tdMoney(byMoney.profit - byHour.profit) + " less"
        /* Only claim the system is the reason when it actually is. Saying "but you never leave the
           system" about two rows in the same system would be a sentence the data does not support. */
        + (byMoney.crossSystem && !byHour.crossSystem
          ? ", and it stays in " + (byHour.to.system || "system") + "."
          : ", and it is quicker.")),
    );
    body.appendChild(t);
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
        // 🔴 NOTHING WHERE THE TONNAGE WOULD GO WHEN THE GAME STATED NO VOLUME. `u.scu` is null for
        // a sale out of personal inventory - hand-mined gems, sold at a commodity exchange with no
        // cargo-box manifest, which is 54% of real sells. `num()` is Number(n || 0), so printing it
        // unguarded reads "0 SCU": a missing figure rendered as zero is not missing, it is wrong.
        // No placeholder and no dash either - Sub's ruling is to show nothing, and the revenue and
        // the terminal on the other half of the row already say everything that is true.
        nm.textContent = u.scu === null || u.scu === undefined
          ? (u.commodity || "Unknown")
          : (u.commodity || "Unknown") + " · " + num(u.scu) + " SCU";
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
