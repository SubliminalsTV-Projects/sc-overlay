/**
 * HAULING — NAMING A PLACE THE GAME NEVER NAMED.
 *
 * Lifted verbatim out of hauling.html (2026-08-19). Same page, same scope: classic scripts on one
 * document share a global lexical environment, so nothing here is exported and nothing that calls
 * it changed. Load order is preserved — this file sits exactly where the block used to sit.
 */
  /**
   * 🔴 NAME A PLACE THE GAME NEVER NAMED — Sub's most-asked-for control.
   *
   * Only a TRACKED drop-off carries a name (the Deliver line's "… to <D>"), so pickups are
   * essentially always anonymous and show as "Site 1". The answer is remembered against the
   * place's COORDINATES (the planner's location id is the position rounded to the kilometre), so
   * it is asked once and never again — including across game restarts, when the zoneHostId this
   * could otherwise have been keyed on is reissued.
   *
   * 🔑 Rows are REUSED across renders, keyed by location id, for the same reason the load
   * checklist reuses its rows: a plan push mid-typing would otherwise destroy the input under the
   * player's cursor and the field would look dead. That bug cost a session once already.
   */
  const placeRows = new Map();
  /** locationId -> the suggestions currently showing, and which one arrow keys have landed on. */
  let sugFor = null, sugList = [], sugIndex = -1;

  /** Show the places you already named, so a wrong one can be corrected. Off by default. */
  let placesEditMine = false;

  function renderPlaces() {
    const el = $("places");
    /* 🔴 GONE — naming happens on the STOP now. Sub: "That is a waste of UI space. We already have
       the name of the place down there in one, two and three... Why can't I just click that and
       then type in the name?"
       He is right, and it was not only about space: the panel asked "name this place" with a bare
       site id and a commodity, and on a two-pickup Waste contract BOTH rows read the same — there
       was no way to tell which physical stop it meant. On the route row there is no ambiguity,
       because the row IS the stop, in order, with its tonnage and its commodity beside it. */
    el.style.display = "none";
    return;
    /* eslint-disable no-unreachable -- kept: savePlace/askPlaces below still serve the inline editor */
    const all = (plan && plan.unnamedPlaces) || [];
    /* 🔴 A QUESTION YOU HAVE ANSWERED IS NOT A QUESTION. The plan hands back places you named as
       well as places nobody has, so a wrong name stays correctable — but listing them by default
       filled the panel with rows that had nothing to ask. Sub: "the names are already filled in,
       I don't understand why that's in there in the UI clouding up space for nothing."
       So: unanswered by default, and the answered ones behind a count you can click. */
    const mine = all.filter((p) => p.yours);
    const list = placesEditMine ? all : all.filter((p) => !p.yours);
    if (!list.length && !mine.length) { el.style.display = "none"; return; }
    el.style.display = "";
    $("placesN").textContent = list.length
      ? list.length + (list.length > 1 ? " places" : " place")
      : mine.length + " named by you";
    /* The count is the way back to a name you got wrong. Only clickable when there is something
       behind it, so it never looks like a control that does nothing. */
    const nEl = $("placesN");
    nEl.style.cursor = mine.length ? "pointer" : "";
    nEl.title = mine.length
      ? (placesEditMine ? "Hide the ones you have already named." : mine.length + " named by you — click to correct one.")
      : "";
    nEl.onclick = mine.length ? (e) => { e.stopPropagation(); placesEditMine = !placesEditMine; renderPlaces(); } : null;
    $("placesInfo").title = "The game only names a place when it states a delivery objective, so"
      + " pickups and untracked legs arrive anonymous. Type the name and it sticks to those"
      + " coordinates — you will not be asked about this place again.";
    const holder = $("placesList");
    const seen = new Set();
    for (const p of list) {
      seen.add(p.locationId);
      let r = placeRows.get(p.locationId);
      if (!r) {
        const row = document.createElement("div");
        row.className = "prow";
        const top = document.createElement("div"); top.className = "top";
        const site = document.createElement("span"); site.className = "site";
        const role = document.createElement("span"); role.className = "role";
        top.append(site, role);
        const inp = document.createElement("input");
        inp.type = "text";
        // 🔑 The empty box only offers places the game has already named, so the hint says so
        // rather than promising a list that is not there yet on a first run.
        inp.placeholder = "Type where this is…";
        inp.autocomplete = "off";
        // Same canvas keyboard grab as the tonnage boxes — see grabOn/grabOff. Reusing it is not
        // tidiness: the shell suspends the interact key while a field is live, and a field that
        // did not take the grab would type into the game instead.
        inp.addEventListener("focus", () => grabOn(inp));
        inp.addEventListener("blur", () => { grabOff(); setTimeout(() => closeSug(p.locationId), 120); });
        inp.addEventListener("pointerdown", () => { wantFocus = inp; });
        inp.addEventListener("input", () => askPlaces(p.locationId, inp.value, row));
        inp.addEventListener("keydown", (e) => onSugKey(e, p.locationId, inp, row));
        // Emptying the box is how a wrong name is undone, and `change` is what catches it —
        // `keydown`'s Enter path only ever saves a non-empty pick.
        inp.addEventListener("change", () => { if (!inp.value.trim()) savePlace(p.locationId, ""); });
        row.append(top, inp);
        r = { row, site, role, inp };
        placeRows.set(p.locationId, r);
      }
      // 🔑 A place YOU named shows its Site-style slot as "yours" and pre-fills the box, so the
      // answer can be corrected or emptied. Clearing the box deletes the name — see savePlace.
      r.site.textContent = p.yours ? "yours" : p.label;
      r.role.textContent = p.role === "pickup" ? "you pick up here"
        : p.role === "both" ? "you pick up and drop off here" : "you drop off here";
      if (p.commodity) r.role.textContent += "  ·  " + p.commodity;
      if (p.yours) r.role.textContent += "  ·  clear the box to undo";
      if (document.activeElement !== r.inp) r.inp.value = p.yours || "";
      holder.appendChild(r.row);   // appendChild MOVES an existing node, so this fixes order too
    }
    for (const [id, r] of placeRows) {
      if (!seen.has(id)) { r.row.remove(); placeRows.delete(id); }
    }
  }

  /**
   * Ask the server to rank the candidates. Debounced: one request per character is fine at this
   * size, but a burst while someone types fast is pure waste.
   *
   * 🔴 A COMMODITY LEG ASKS A DIFFERENT QUESTION. Sub: *"right now I can change the drop-off point
   * or the pickup point to someplace where you can't even pick up Neon. It shows places that are
   * used before, but the only thing that matters is where you can pick it up from and where you can
   * drop it off at."* With a commodity and a side, the sidecar answers from the price table's
   * `buyAt`/`sellAt` instead of from "places you have been" — the same source the Commodities tab's
   * slots use, so the two surfaces cannot offer different answers to one question.
   *
   * ⚠️ A CONTRACT stop passes no context and keeps the old list, deliberately: it is an anonymous
   * set of coordinates the game handed you, no price table has an opinion about it, and there
   * "used before + dataset" is exactly right.
   */
  let sugTimer = null;
  function askPlaces(locationId, q, row) {
    const ctx = (placeRows.get(locationId) || {}).ctx || null;
    clearTimeout(sugTimer);
    sugTimer = setTimeout(async () => {
      try {
        let u = "/api/hauling/places?q=" + encodeURIComponent(q);
        if (ctx && ctx.commodity && ctx.side) {
          u += "&commodity=" + encodeURIComponent(ctx.commodity) + "&side=" + encodeURIComponent(ctx.side);
        }
        const r = await fetch(u, { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        showSug(locationId, j.places || [], row, !!j.constrained, ctx);
      } catch { /* sidecar down — typing still saves, it just cannot suggest */ }
    }, 90);
  }

  function closeSug(locationId) {
    if (sugFor !== locationId) return;
    const r = placeRows.get(locationId);
    r?.row.querySelector(".psug")?.remove();
    sugFor = null; sugList = []; sugIndex = -1;
  }

  function showSug(locationId, places, row, constrained, ctx) {
    row.querySelector(".psug")?.remove();
    sugFor = locationId; sugList = places; sugIndex = places.length ? 0 : -1;
    /* 🔴 A CONSTRAINED LIST WITH NOTHING IN IT STILL HAS SOMETHING TO SAY. An empty dataset list
       means "no match for what you typed"; an empty PRICE-TABLE list means "nowhere trades this",
       which is a fact about the commodity rather than about the typing. Returning early on both
       would make those two look identical, and only one of them is the player's to fix. */
    if (!places.length && !constrained) return;
    const box = document.createElement("div");
    box.className = "psug";
    if (constrained) {
      const head = document.createElement("span");
      head.className = "phead";
      head.textContent = ctx && ctx.side === "buy"
        ? places.length + (places.length === 1 ? " place sells " : " places sell ") + (ctx.commodity || "this")
        : places.length + (places.length === 1 ? " place buys " : " places buy ") + ((ctx && ctx.commodity) || "this");
      box.appendChild(head);
    }
    places.forEach((p, i) => {
      const d = document.createElement("div");
      if (i === sugIndex) d.className = "on";
      const n = document.createElement("span");
      if (p.seen) n.className = "seen";
      n.textContent = p.name;
      d.appendChild(n);
      if (p.hint) { const h = document.createElement("span"); h.className = "h"; h.textContent = p.hint; d.appendChild(h); }
      /* The price, and the stock or demand behind it. A list of only VALID places may as well also
         say which of them is worth picking — that is the difference between a filter and a
         recommendation, and the figures are already in the payload. */
      if (p.price !== undefined && p.price !== null) {
        const pr = document.createElement("span");
        pr.className = "pr " + (ctx && ctx.side === "buy" ? "buyp" : "sellp");
        pr.textContent = num(Math.round(p.price))
          + (p.scu === null || p.scu === undefined ? "" : "  ·  " + num(p.scu) + " SCU");
        d.appendChild(pr);
      }
      // pointerdown, not click: the input's blur fires first on a click and would close the list
      // out from under the pointer.
      d.addEventListener("pointerdown", (e) => { e.preventDefault(); savePlace(locationId, p.name, p); });
      box.appendChild(d);
    });
    if (constrained && !places.length) {
      const none = document.createElement("span");
      none.className = "pfoot";
      none.textContent = "Nowhere in the price table trades this, so there is nothing to move it to.";
      box.appendChild(none);
    }
    row.appendChild(box);
  }

  /** Arrow keys walk the list, Enter takes the highlighted one, Escape gives up. Enter with
   *  nothing highlighted saves exactly what was typed — a place the datasets have never heard of
   *  is a real case (locations.json has no city spaceports at all). */
  function onSugKey(e, locationId, inp, row) {
    const box = row.querySelector(".psug");
    if (e.key === "Escape") { closeSug(locationId); inp.blur(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!sugList.length) return;
      e.preventDefault();
      sugIndex = (sugIndex + (e.key === "ArrowDown" ? 1 : sugList.length - 1)) % sugList.length;
      if (box) [...box.children].forEach((c, i) => c.classList.toggle("on", i === sugIndex));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const hit = sugIndex >= 0 ? sugList[sugIndex] : null;
      const pick = hit ? hit.name : inp.value.trim();
      if (pick) savePlace(locationId, pick, hit);
    }
  }

  /**
   * Two very different writes behind one gesture, and which one happens is decided by whether the
   * stop is a COMMODITY leg.
   *
   * 🔴 ON A CONTRACT STOP this NAMES a place: `config.haulingPlaces[locationId]` is a display name
   * for a set of coordinates the game never named. That is all it has ever done.
   *
   * 🔴 ON A COMMODITY LEG THAT WAS THE BUG. The stop relabelled and the route went on buying where
   * it always had — a control whose apparent effect and its real effect differ, which is worse than
   * one that merely offers the wrong options, and it was doing both. A commodity leg now RE-POINTS
   * the pick, which is what "change the pickup" has to mean.
   *
   * ⚠️ Free text still names rather than moves, even on a commodity leg: a terminal the price table
   * has never heard of cannot be re-pointed to, and refusing the keystroke outright would take away
   * naming a place for no gain. Only a pick from the list carries the body and system a re-point
   * needs, which is exactly why the whole suggestion object is threaded through rather than a name.
   */
  async function savePlace(locationId, name, place) {
    const ctx = (placeRows.get(locationId) || {}).ctx || null;
    closeSug(locationId);
    const r = placeRows.get(locationId);
    if (r && r.inp) { r.inp.value = name; r.inp.blur(); }

    if (ctx && ctx.buyId && place && place.price !== undefined) {
      try {
        const res = await fetch("/api/hauling/buy/repoint", {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
          body: JSON.stringify({
            id: ctx.buyId,
            side: ctx.side === "buy" ? "from" : "to",
            terminal: { terminal: place.name, body: place.body || null, system: place.system || null },
            price: place.price,
          }),
        });
        const j = await res.json().catch(() => null);
        // 🔴 A REFUSAL IS SAID. "It did not move" and "it did not move because the log already
        // recorded this purchase" are different messages, and only the second tells the player what
        // to do next. Silence here would be the original bug wearing a better list.
        routeNote(j && j.moved ? "" : "That run did not move — " + ((j && j.why) || "the app's background service is not answering") + ".");
      } catch {
        routeNote("The app's background service is not answering, so that run did not move.");
      }
      load();
      return;
    }

    try {
      await fetch("/api/hauling/place", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId, name }),
      });
    } catch { /* not saved — the row stays, so it can be tried again */ }
    load();
  }
