/**
 * HAULING - THE TRADE TAB: buy low somewhere, haul it, sell high somewhere else.
 *
 * Phase 2. The Route/Stow/Rank tabs are all about CONTRACTS the game gave you; this one is about
 * cargo you choose to buy with your own money, which is why it is a tab and not a section of Route.
 * Nothing here comes from the log - it is the one tab that works with the game closed.
 *
 * Same file conventions as its siblings: a classic script sharing one lexical scope with
 * hauling.html, so every name here is prefixed `trade`/`td` and nothing is exported.
 *
 * 🔴 THE STANDING CONSTRAINT, AND IT IS THE REASON HALF THIS FILE EXISTS: prices are per-terminal
 * and they move. There is no such thing as "the price of Titanium". So:
 *
 *   - The COMMODITY view never prints one number. It prints a range, the terminal count behind it,
 *     and the age spread, and only then lists individual terminals.
 *   - Every ROUTE row carries its own age, and that age is the OLDER of its two quotes.
 *   - The provenance strip is always on screen, never a tooltip. Sub's requirement was explicit:
 *     the user needs to know when they are looking at the fallback. Silence is the failure mode.
 *
 * 🔑 AND THE `unknown` BADGE IS THE MOST IMPORTANT THING ON THE ROW. On the bundled snapshot stock
 * is reported for only ~13% of routes, so a hold-filling profit figure is a CEILING rather than a
 * recommendation - measured: 8 of 8 top routes come back `unknown` on bundled data and 0 of 8 on
 * live. A row that quietly showed "674,560 aUEC" for cargo that may not be on the shelf is exactly
 * the false precision this widget is not allowed to have.
 */

  /* ── state ──────────────────────────────────────────────────────────────── */

  let tradeData = null;        // last /api/trade/routes response
  let tradeLookup = null;      // last /api/trade/commodity response
  let tradeNames = null;       // autocomplete list
  let tradeBusy = false;
  let tradeErr = "";
  /** "routes" | "commodity" - the two halves Sub asked for. Backhaul is a FILTER on routes rather
   *  than a third mode, because it is the same question with the destination pinned. */
  let tradeMode = "routes";
  /** Pinned destination for the backhaul case: null = anywhere. */
  let tradeToBody = null;
  let tradeQuery = "";
  const TD_STOCK_KEY = "sc-trade-known-stock";
  /** Hide routes whose stock nobody has reported. Remembered because it is a stance, not a mood. */
  let tradeKnownOnly = (() => { try { return localStorage.getItem(TD_STOCK_KEY) === "1"; } catch { return false; } })();

  /* ── helpers ────────────────────────────────────────────────────────────── */

  /** "2d" / "18h" / "just now". 🔑 Never rounds an old quote down to something reassuring. */
  function tdAge(days) {
    if (days === null || days === undefined) return null;
    if (days >= 1) return Math.round(days) + "d";
    const h = Math.round(days * 24);
    return h >= 1 ? h + "h" : "just now";
  }

  /** aUEC, shortened only where the magnitude is the point. */
  function tdMoney(n) {
    const v = Math.round(Number(n) || 0);
    if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
    if (Math.abs(v) >= 10_000) return Math.round(v / 1000) + "k";
    return v.toLocaleString();
  }

  function tdChip(parent, text, cls) {
    const s = document.createElement("span");
    s.className = "badge" + (cls ? " " + cls : "");
    s.textContent = text;
    parent.appendChild(s);
    return s;
  }

  /**
   * The provenance strip. Always drawn, and it says three different things for three genuinely
   * different states, because "we are offline by choice", "we tried and failed" and "this is
   * fresh" must not read alike.
   */
  function tdProvenance(host, d) {
    const row = document.createElement("div");
    row.className = "note";
    if (!d) { row.textContent = "Prices: loading…"; host.appendChild(row); return; }
    let text;
    if (d.source === "live") {
      const mins = d.fetchedAt ? Math.round((Date.now() - d.fetchedAt) / 60000) : null;
      text = "Prices: live" + (mins !== null ? ", our copy refreshed " + (mins < 1 ? "just now" : mins + "m ago") : "");
    } else if (d.source === "cache") {
      const mins = d.fetchedAt ? Math.round((Date.now() - d.fetchedAt) / 60000) : null;
      text = "Prices: last good copy" + (mins !== null ? " from " + (mins > 90 ? Math.round(mins / 60) + "h" : mins + "m") + " ago" : "")
        + (d.lastError ? " — UEX unreachable (" + d.lastError + ")" : "");
    } else if (!d.canRefresh) {
      text = "Prices: bundled snapshot" + (d.version ? " (" + d.version + ")" : "") + " — live updates are switched off";
    } else {
      text = "Prices: bundled snapshot" + (d.version ? " (" + d.version + ")" : "")
        + " — " + (d.lastError ? "UEX unreachable (" + d.lastError + ")" : "no live copy yet");
    }
    row.textContent = text;
    host.appendChild(row);

    // 🔑 A crowd-sourced table is not the live game, and saying the refresh interval would imply
    // it is. The honest sentence names the per-row ages instead, which are on every row anyway.
    const sub = document.createElement("div");
    sub.className = "note";
    sub.textContent = d.source === "bundled"
      ? "Stock is unreported for most routes in the bundled snapshot — profit figures marked “stock unknown” are ceilings, not estimates."
      : "Community-reported, so each row shows its own age. " + (d.droppedOffline ? d.droppedOffline + " terminals hidden: priced by UEX but not in the game right now." : "");
    if (sub.textContent.trim()) host.appendChild(sub);
  }

  /* ── loading ────────────────────────────────────────────────────────────── */

  /** The hold to plan against. Prefers the picker, falls back to whatever the plan detected. */
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
      else p.set("capacity", "64"); // nothing known yet; the strip says so and the picker fixes it
      if (tradeToBody) p.set("toBody", tradeToBody);
      if (tradeKnownOnly) p.set("knownStock", "1");
      p.set("limit", "25");
      const r = await fetch("/api/trade/routes?" + p.toString(), { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { tradeErr = j && j.error ? j.error : "HTTP " + r.status; tradeData = j; }
      else tradeData = j;
    } catch (e) {
      // 🔴 Keep whatever we had. A trade board that blanks on a hiccup is worse than a stale one.
      tradeErr = "sidecar unreachable";
    }
    tradeBusy = false;
    if (view === "trade") render();
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
      tradeLookup = r.ok ? j : { error: (j && j.error) || "HTTP " + r.status, commodity: name, ...j };
    } catch {
      tradeLookup = { error: "sidecar unreachable", commodity: name };
    }
    if (view === "trade") render();
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
        ? "Nothing with confirmed stock right now. Turn off “confirmed stock only” to see the rest."
        : "No profitable run found for this hold.";
      body.appendChild(e);
      return;
    }

    const sec = document.createElement("div");
    sec.className = "sec";
    const h = document.createElement("span");
    h.textContent = tradeToBody ? "Worth carrying to " + tradeToBody : "Worth carrying";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = (d.ship ? d.ship + " · " : "") + num(d.capacityScu) + " SCU hold";
    sec.append(h, n);
    body.appendChild(sec);

    d.routes.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "arow";
      const nEl = document.createElement("div"); nEl.className = "n"; nEl.textContent = String(i + 1);
      const mid = document.createElement("div"); mid.className = "mid";

      const t = document.createElement("div"); t.className = "t";
      t.textContent = r.commodity;
      mid.appendChild(t);

      // Where from, where to - the short names a player reads off the board.
      const m = document.createElement("div"); m.className = "m";
      m.textContent = r.from.terminalShort + "  →  " + r.to.terminalShort;
      mid.appendChild(m);

      const chips = document.createElement("div"); chips.className = "m";
      tdChip(chips, "+" + num(Math.round(r.marginPerScu)) + "/SCU");
      // 🔴 The bound, always, and named. "You can move 48" is not actionable; "the seller only has
      // 48 on the shelf" is - it tells the player what to change.
      if (r.scuBound === "unknown") {
        tdChip(chips, "stock unknown", "cap");
      } else if (r.scuBound === "stock") {
        tdChip(chips, num(r.moveScu) + " SCU on the shelf");
      } else if (r.scuBound === "demand") {
        tdChip(chips, "buyer takes " + num(r.moveScu) + " SCU");
      } else {
        tdChip(chips, "fills your hold");
      }
      const age = tdAge(r.ageDays);
      // An untimestamped quote says so rather than looking fresh by omission.
      tdChip(chips, age ? "quoted " + age + " ago" : "age unknown");
      if (r.crossSystem) tdChip(chips, "cross-system");
      // ⚠️ Capital and load live down here, NOT in the right-hand column. Measured: that column is
      // 86px on a 420px widget, and three lines of figures wrapped into an 88px block that read as
      // broken text. Chips wrap by design; a fixed narrow column does not.
      tdChip(chips, "costs " + tdMoney(r.capitalRequired));
      mid.appendChild(chips);

      // Two lines only, both nowrap: what the run clears, and the rate it clears it at.
      const right = document.createElement("div"); right.className = "tdcap";
      const profit = document.createElement("div");
      profit.className = "tdprofit";
      // 🔑 "≤" is not decoration. With stock unreported this figure is a ceiling derived from the
      // hold, and printing it bare would be the false precision this widget exists to avoid.
      profit.textContent = (r.scuBound === "unknown" ? "≤ " : "") + tdMoney(r.profit);
      const per = document.createElement("div");
      per.className = "tdrate";
      per.textContent = tdMoney(r.profitPerHour) + "/hr";
      right.append(profit, per);

      row.append(nEl, mid, right);
      body.appendChild(row);
    });
  }

  /* ── the commodity view ─────────────────────────────────────────────────── */

  /** One side's range. 🔴 Never a lone number - the range and the count are the answer. */
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

    if (s.stalestDays !== null && s.stalestDays !== undefined) {
      const ages = document.createElement("div");
      ages.className = "note";
      ages.textContent = "Quotes range from " + tdAge(s.freshestDays) + " to " + tdAge(s.stalestDays) + " old.";
      body.appendChild(ages);
    }

    for (const e of ends.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "trow";
      const nm = document.createElement("div");
      nm.textContent = e.terminalShort + (e.system ? "  · " + e.system : "");
      const val = document.createElement("div");
      val.className = "cap";
      const age = tdAge(e.asOf === null || e.asOf === undefined ? null : (Date.now() - e.asOf * 1000) / 86400000);
      const scu = e.scu === null || e.scu === undefined
        ? "stock unknown"
        : num(e.scu) + " SCU " + (kind === "buy" ? "in stock" : "wanted");
      val.textContent = num(e.price) + "  ·  " + scu + (age ? "  ·  " + age : "");
      row.append(nm, val);
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

    // The one derived number worth stating, and only when both ends are real.
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

    tdProvenance(body, tradeData || tradeLookup);

    // Mode + filters. Same `goalseg` treatment the Rank tab uses for its goal switch.
    const bar = document.createElement("div");
    bar.className = "sec";
    const seg = document.createElement("span");
    seg.className = "goalseg";
    for (const [id, label] of [["routes", "Runs"], ["commodity", "Look up"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hbtn" + (tradeMode === id ? " on" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        tradeMode = id;
        if (id === "commodity") loadTradeNames();
        render();
      });
      seg.appendChild(b);
    }
    bar.appendChild(seg);

    if (tradeMode === "routes") {
      const stock = document.createElement("button");
      stock.type = "button";
      stock.className = "hbtn" + (tradeKnownOnly ? " on" : "");
      stock.textContent = tradeKnownOnly ? "Confirmed stock only" : "Any stock";
      stock.title = "Hide runs where nobody has reported how much is actually on the shelf";
      stock.addEventListener("click", () => {
        tradeKnownOnly = !tradeKnownOnly;
        try { localStorage.setItem(TD_STOCK_KEY, tradeKnownOnly ? "1" : "0"); } catch { /* private mode */ }
        loadTrade();
      });
      bar.appendChild(stock);

      // 🔑 THE BACKHAUL. Only offered when the route plan actually has somewhere to be - an empty
      // dropdown of destinations you are not flying to is worse than no dropdown.
      const dest = tdPlanDestination();
      if (dest) {
        const bh = document.createElement("button");
        bh.type = "button";
        bh.className = "hbtn" + (tradeToBody ? " on" : "");
        bh.textContent = tradeToBody ? "Anywhere" : "On my way to " + dest;
        bh.title = "You are already flying there — what is worth carrying along?";
        bh.addEventListener("click", () => { tradeToBody = tradeToBody ? null : dest; loadTrade(); });
        bar.appendChild(bh);
      }
    }
    body.appendChild(bar);

    if (tradeMode === "commodity") {
      const wrap = document.createElement("div");
      wrap.className = "psug";
      const input = document.createElement("input");
      input.type = "text";
      input.id = "tradeQ";
      input.placeholder = "Commodity name";
      input.value = tradeQuery;
      input.setAttribute("list", "tradeNames");
      // ⚠️ A text field on a widget takes the canvas-wide keyboard grab, which is why this one is
      // wired to the page's existing typing helpers rather than calling focus() on its own.
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
