/**
 * HAULING - THE TRADE TAB: buy low somewhere, haul it, sell high somewhere else.
 *
 * Phase 2. The Route/Stow/Rank tabs are all about CONTRACTS the game gave you; this one is about
 * cargo you choose to buy with your own money, which is why it is a tab and not a section of
 * Route. Nothing here comes from the log - it is the one tab that works with the game closed.
 *
 * Same file conventions as its siblings: a classic script sharing one lexical scope with
 * hauling.html, so every name here is prefixed `trade`/`td` and nothing is exported.
 *
 * 🔴 THE STANDING CONSTRAINT, AND THE REASON HALF THIS FILE EXISTS: prices are per-terminal and
 * they move. There is no such thing as "the price of Titanium". So the commodity view prints a
 * RANGE with its terminal count and age spread; every route row carries its own age, which is the
 * OLDER of its two quotes; and where stock is unreported the profit is a CEILING, marked with a
 * `≤`, never a bare number.
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
  let tradeLookup = null;      // last /api/trade/commodity response
  let tradeNames = null;       // autocomplete list
  let tradeStatus = null;      // last provenance block, for first paint before any query
  let tradeBusy = false;
  let tradeErr = "";
  /** "routes" | "commodity". Backhaul is a FILTER on routes rather than a third mode, because it
   *  is the same question with the destination pinned. */
  let tradeMode = "routes";
  let tradeToBody = null;
  let tradeQuery = "";
  /** "" = every system. Defaulted from the log once, then it is the player's choice. */
  let tradeSystem = null;      // null = not yet defaulted
  const TD_STOCK_KEY = "sc-trade-known-stock";
  const TD_UNIT_KEY = "sc-trade-unit";
  /** "run" = what the whole trip clears. "scu" = what one unit is worth carrying. Two real
   *  answers to two different questions, and the second is what stays comparable across rows
   *  whose hold fills differ. */
  let tradeUnit = (() => { try { return localStorage.getItem(TD_UNIT_KEY) === "scu" ? "scu" : "run"; } catch { return "run"; } })();
  const TD_SYS_KEY = "sc-trade-system";
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

  async function loadTradeNames() {
    if (tradeNames) return;
    try {
      const r = await fetch("/api/trade/names", { cache: "no-store" });
      if (r.ok) tradeNames = (await r.json()).names || [];
    } catch { /* autocomplete is a nicety, never a blocker */ }
  }

  async function loadTradeCommodity(name) {
    tradeQuery = name;
    if (!name) { tradeLookup = null; render(); return; }
    try {
      const r = await fetch("/api/trade/commodity?name=" + encodeURIComponent(name), { cache: "no-store" });
      const j = await r.json();
      tradeLookup = r.ok ? j : Object.assign({ error: (j && j.error) || "HTTP " + r.status, commodity: name }, j);
      tradeStatus = j;
    } catch {
      tradeLookup = { error: "sidecar unreachable", commodity: name };
    }
    if (view === "trade") render();
  }

  /** Kick everything the tab needs, in the order that makes the first paint correct. */
  async function openTrade() {
    await loadTradeStatus();
    await loadTrade();
  }

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
      const row = document.createElement("div");
      row.className = "arow tdrow";
      const nEl = document.createElement("div"); nEl.className = "n"; nEl.textContent = String(i + 1);
      const mid = document.createElement("div"); mid.className = "mid";

      const t = document.createElement("div"); t.className = "t";
      t.textContent = r.commodity;
      mid.appendChild(t);

      const m = document.createElement("div"); m.className = "m";
      m.textContent = r.from.terminalShort + "  →  " + r.to.terminalShort;
      mid.appendChild(m);

      // 🔴 THE MONEY LINE. What you pay, what you get, the return on it, and how much of it —
      // the four facts the first cut made you derive.
      const money = document.createElement("div");
      money.className = "money";
      const bk = document.createElement("span"); bk.className = "k"; bk.textContent = "buy";
      const bv = document.createElement("span"); bv.className = "buy"; bv.textContent = num(Math.round(r.from.price));
      const ar = document.createElement("span"); ar.className = "arrow"; ar.textContent = "→";
      const sk = document.createElement("span"); sk.className = "k"; sk.textContent = "sell";
      const sv = document.createElement("span"); sv.className = "sell"; sv.textContent = num(Math.round(r.to.price));
      // 🔑 The percentage is the figure that makes two rows comparable when their prices are
      // orders of magnitude apart — a 12,444 margin on Bexalite and a 298 on Processed Food are
      // 53% and 25%, and the second is the one whose capital you get back fastest.
      const pc = tdPct(r.marginPct);
      const qt = document.createElement("span"); qt.className = "qty"; qt.textContent = "× " + num(r.moveScu) + " SCU";
      money.append(bk, bv, ar, sk, sv, pc, qt);
      mid.appendChild(money);

      // `tdchips`, not just `m`: the chip row wraps by PILL, and only this class makes it flex.
      // Left on `.m` as well so nothing selecting `.m` (the suite included) changes meaning.
      const chips = document.createElement("div"); chips.className = "m tdchips";
      const age = tdAge(r.ageDays);
      tdChip(chips, age ? age + " old" : "age unknown", tdAgeClass(r.ageDays));
      if (r.scuBound === "unknown") tdChip(chips, "stock unknown", "warn");
      else if (r.scuBound === "stock") tdChip(chips, num(r.moveScu) + " on the shelf", "calm");
      else if (r.scuBound === "demand") tdChip(chips, "buyer takes " + num(r.moveScu), "calm");
      else tdChip(chips, "fills your hold", "calm");
      // The system pair, and it is loud when they differ — that is the 25-minute jump.
      if (r.crossSystem) tdChip(chips, (r.from.system || "?") + " → " + (r.to.system || "?"), "xsys");
      else if (r.from.system) tdChip(chips, r.from.system, "calm");
      tdChip(chips, "costs " + tdMoney(r.capitalRequired), "calm");
      mid.appendChild(chips);

      const right = document.createElement("div"); right.className = "tdcap";
      const profit = document.createElement("div");
      profit.className = "tdprofit";
      // 🔑 PER RUN vs PER SCU. Both are real answers to different questions: "what does this trip
      // clear" and "what is each unit worth carrying". Per-SCU is also the only figure that stays
      // comparable when two rows have wildly different hold fills, which is why it is offered
      // rather than derived in the player's head.
      // "≤" is not decoration — with stock unreported the per-run figure is a ceiling off the
      // hold alone. The per-SCU figure is exact either way, so it never carries one.
      const perScu = tradeUnit === "scu";
      profit.textContent = perScu
        ? num(Math.round(r.marginPerScu))
        : (r.scuBound === "unknown" ? "≤ " : "") + tdMoney(r.profit);
      const lbl = document.createElement("div");
      lbl.className = "tdcaplbl";
      lbl.textContent = perScu ? "per scu" : "profit";
      const per = document.createElement("div");
      per.className = "tdrate";
      per.textContent = perScu ? tdMoney(r.profit) + " total" : tdMoney(r.profitPerHour) + "/hr";
      right.append(profit, lbl, per);

      row.append(nEl, mid, right);
      body.appendChild(row);
    });
  }

  /* ── the commodity view ─────────────────────────────────────────────────── */

  function tdRenderSide(body, label, s, ends, kind) {
    const sec = document.createElement("div");
    sec.className = "sec";
    const h = document.createElement("span"); h.textContent = label;
    const n = document.createElement("span"); n.className = "n";
    if (!s) {
      n.textContent = kind === "buy" ? "nowhere sells it to you" : "nowhere buys it";
      sec.append(h, n); body.appendChild(sec);
      return;
    }
    n.textContent = s.terminals + (s.terminals === 1 ? " terminal" : " terminals");
    sec.append(h, n);
    body.appendChild(sec);

    const range = document.createElement("div");
    range.className = "note";
    // 🔑 Low-high first, median beside it. A median standing alone is the false-precision trap.
    range.textContent = s.low === s.high
      ? num(s.low) + " aUEC/SCU at every terminal"
      : num(s.low) + " – " + num(s.high) + " aUEC/SCU (middle " + num(s.median) + ")";
    body.appendChild(range);

    for (const e of ends.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "trow";
      const nm = document.createElement("div");
      nm.textContent = e.terminalShort + (e.system ? "  · " + e.system : "");
      const val = document.createElement("div");
      val.className = "cap";
      const days = e.asOf === null || e.asOf === undefined ? null : (Date.now() - e.asOf * 1000) / 86400000;
      const scu = e.scu === null || e.scu === undefined
        ? "stock unknown"
        : num(e.scu) + " SCU " + (kind === "buy" ? "in stock" : "wanted");
      val.textContent = num(e.price) + "  ·  " + scu;
      row.append(nm, val);
      const a = tdAge(days);
      if (a) tdChip(val, a, tdAgeClass(days));
      body.appendChild(row);
    }
    if (ends.length > 8) {
      const more = document.createElement("div");
      more.className = "note";
      more.textContent = "…and " + (ends.length - 8) + " more.";
      body.appendChild(more);
    }
  }

  function tdRenderCommodity(body) {
    const l = tradeLookup;
    if (!l) {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = "Type a commodity to see what it costs and where it sells.";
      body.appendChild(e);
      return;
    }
    if (l.error) {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = l.error === "unknown_commodity"
        ? "Nothing called “" + (l.name || tradeQuery) + "” in the price data."
        : "Could not look that up (" + l.error + ").";
      body.appendChild(e);
      return;
    }
    const sec = document.createElement("div");
    sec.className = "sec";
    const h = document.createElement("span"); h.textContent = l.commodity;
    sec.appendChild(h);
    body.appendChild(sec);

    tdRenderSide(body, "Buy it at", l.buy, l.buyAt || [], "buy");
    tdRenderSide(body, "Sell it at", l.sell, l.sellAt || [], "sell");

    if (l.buy && l.sell && l.sell.high > l.buy.low) {
      const best = document.createElement("div");
      best.className = "note";
      best.textContent = "Best spread on this table: " + num(l.sell.high - l.buy.low)
        + " aUEC/SCU, buying at " + num(l.buy.low) + " and selling at " + num(l.sell.high)
        + " — two different terminals, and each price is only as good as its age above.";
      body.appendChild(best);
    }
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

    // ⚠️ Runs / Look up used to be buttons in here. They are TOP TABS now (Sub's two-mode
    // structure), so this bar carries only the filters that belong to whichever one is showing.
    if (tradeMode === "routes") {
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
    }
    body.appendChild(bar);

    if (tradeMode === "commodity") {
      const wrap = document.createElement("div");
      wrap.className = "tdfind";
      const input = document.createElement("input");
      input.type = "text";
      input.id = "tradeQ";
      input.placeholder = "Commodity name — try Titanium";
      input.value = tradeQuery;
      input.setAttribute("list", "tradeNames");
      input.setAttribute("autocomplete", "off");
      input.addEventListener("change", () => loadTradeCommodity(input.value.trim()));
      wrap.appendChild(input);
      if (tradeNames && tradeNames.length) {
        const dl = document.createElement("datalist");
        dl.id = "tradeNames";
        for (const nm of tradeNames) {
          const o = document.createElement("option");
          o.value = nm;
          dl.appendChild(o);
        }
        wrap.appendChild(dl);
      }
      body.appendChild(wrap);
      tdRenderCommodity(body);
    } else {
      tdRenderRoutes(body);
    }
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

  function tdTotalsRow(body, label, t) {
    const sec = document.createElement("div");
    sec.className = "sec";
    const h = document.createElement("span"); h.textContent = label;
    const n = document.createElement("span"); n.className = "n";
    n.textContent = t.runs + (t.runs === 1 ? " run" : " runs");
    sec.append(h, n);
    body.appendChild(sec);

    const big = document.createElement("div");
    big.className = "tdtot";
    const v = document.createElement("span");
    v.className = "v " + (t.profit >= 0 ? "up" : "down");
    v.textContent = (t.profit >= 0 ? "+" : "") + num(Math.round(t.profit));
    const k = document.createElement("span"); k.className = "k"; k.textContent = "aUEC profit";
    big.append(v, k);
    body.appendChild(big);

    const chips = document.createElement("div");
    chips.className = "m tdtotchips";
    tdChip(chips, num(Math.round(t.scu)) + " SCU moved", "calm");
    tdChip(chips, tdDur(t.minutes) + " in cargo", "calm");
    if (t.profitPerHour !== null && t.profitPerHour !== undefined) {
      tdChip(chips, tdMoney(t.profitPerHour) + "/hr", "calm");
    }
    tdChip(chips, "turned " + tdMoney(t.cost) + " into " + tdMoney(t.revenue), "calm");
    // 🔴 Never inside the profit figure. Surfaced so it cannot be mistaken for missing money.
    if (t.unpricedSales) {
      tdChip(chips, tdMoney(t.unpricedRevenue) + " unpriced", "warn");
    }
    body.appendChild(chips);
  }

  function renderJournal() {
    const body = $("body");
    body.textContent = "";

    const bar = document.createElement("div");
    bar.className = "tdbar";
    tdProvenance(bar, tradeStatus);
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
    if (!j.runs.length && !j.open.length && !j.unmatched.length) {
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

    tdTotalsRow(body, "Today", j.today);
    if (j.allTime.runs > j.today.runs) tdTotalsRow(body, "All time", j.allTime);

    if (j.runs.length) {
      const sec = document.createElement("div");
      sec.className = "sec";
      const h = document.createElement("span"); h.textContent = "Runs";
      sec.appendChild(h);
      body.appendChild(sec);

      for (const r of j.runs.slice(0, 40)) {
        const row = document.createElement("div");
        row.className = "arow tdrow";
        const mid = document.createElement("div"); mid.className = "mid";

        const t = document.createElement("div"); t.className = "t";
        t.textContent = r.commodity || "Unknown commodity";
        mid.appendChild(t);

        const m = document.createElement("div"); m.className = "m";
        m.textContent = tdShop(r.buyShop) + "  →  " + tdShop(r.sellShop);
        mid.appendChild(m);

        const money = document.createElement("div");
        money.className = "money";
        const bk = document.createElement("span"); bk.className = "k"; bk.textContent = "buy";
        const bv = document.createElement("span"); bv.className = "buy"; bv.textContent = num(Math.round(r.buyPricePerScu));
        const ar = document.createElement("span"); ar.className = "arrow"; ar.textContent = "→";
        const sk = document.createElement("span"); sk.className = "k"; sk.textContent = "sell";
        const sv = document.createElement("span"); sv.className = "sell"; sv.textContent = num(Math.round(r.sellPricePerScu));
        const pc = tdPct(r.marginPct);
        const qt = document.createElement("span"); qt.className = "qty"; qt.textContent = "× " + num(r.scu) + " SCU";
        money.append(bk, bv, ar, sk, sv, pc, qt);
        mid.appendChild(money);

        const chips = document.createElement("div"); chips.className = "m tdchips";
        tdChip(chips, "took " + tdDur(r.minutes), "calm");
        if (r.profitPerHour !== null && r.profitPerHour !== undefined) {
          tdChip(chips, tdMoney(r.profitPerHour) + "/hr", "calm");
        }
        tdChip(chips, new Date(r.soldAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), "calm");
        mid.appendChild(chips);

        const right = document.createElement("div"); right.className = "tdcap";
        const p = document.createElement("div");
        p.className = "tdprofit " + (r.profit >= 0 ? "up" : "down");
        p.textContent = (r.profit >= 0 ? "+" : "") + tdMoney(r.profit);
        const lbl = document.createElement("div"); lbl.className = "tdcaplbl"; lbl.textContent = "profit";
        right.append(p, lbl);

        row.append(mid, right);
        body.appendChild(row);
      }
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
      const h = document.createElement("span"); h.textContent = "Bought, not sold";
      const n = document.createElement("span"); n.className = "n";
      n.textContent = num(j.open.reduce((a, o) => a + o.scu, 0)) + " SCU unsold";
      sec.append(h, n);
      body.appendChild(sec);
      for (const o of j.open.slice(0, 20)) {
        const row = document.createElement("div");
        row.className = "trow";
        const nm = document.createElement("div");
        nm.textContent = (o.commodity || "Unknown") + " · " + num(o.scu) + " SCU";
        const val = document.createElement("div"); val.className = "cap";
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
      const h = document.createElement("span"); h.textContent = "Sold — cost unknown";
      sec.appendChild(h);
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
        nm.textContent = (u.commodity || "Unknown") + " · " + num(u.scu) + " SCU";
        const val = document.createElement("div"); val.className = "cap";
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
