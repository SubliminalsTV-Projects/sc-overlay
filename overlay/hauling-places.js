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

  /** Ask the server to rank the candidates. Debounced: one request per character is fine at this
   *  size, but a burst while someone types fast is pure waste. */
  let sugTimer = null;
  function askPlaces(locationId, q, row) {
    clearTimeout(sugTimer);
    sugTimer = setTimeout(async () => {
      try {
        const r = await fetch("/api/hauling/places?q=" + encodeURIComponent(q), { cache: "no-store" });
        if (!r.ok) return;
        const places = (await r.json()).places || [];
        showSug(locationId, places, row);
      } catch { /* sidecar down — typing still saves, it just cannot suggest */ }
    }, 90);
  }

  function closeSug(locationId) {
    if (sugFor !== locationId) return;
    const r = placeRows.get(locationId);
    r?.row.querySelector(".psug")?.remove();
    sugFor = null; sugList = []; sugIndex = -1;
  }

  function showSug(locationId, places, row) {
    row.querySelector(".psug")?.remove();
    sugFor = locationId; sugList = places; sugIndex = places.length ? 0 : -1;
    if (!places.length) return;
    const box = document.createElement("div");
    box.className = "psug";
    places.forEach((p, i) => {
      const d = document.createElement("div");
      if (i === sugIndex) d.className = "on";
      const n = document.createElement("span");
      if (p.seen) n.className = "seen";
      n.textContent = p.name;
      d.appendChild(n);
      if (p.hint) { const h = document.createElement("span"); h.className = "h"; h.textContent = p.hint; d.appendChild(h); }
      // pointerdown, not click: the input's blur fires first on a click and would close the list
      // out from under the pointer.
      d.addEventListener("pointerdown", (e) => { e.preventDefault(); savePlace(locationId, p.name); });
      box.appendChild(d);
    });
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
      const pick = sugIndex >= 0 && sugList[sugIndex] ? sugList[sugIndex].name : inp.value.trim();
      if (pick) savePlace(locationId, pick);
    }
  }

  async function savePlace(locationId, name) {
    closeSug(locationId);
    const r = placeRows.get(locationId);
    if (r) { r.inp.value = name; r.inp.blur(); }
    try {
      await fetch("/api/hauling/place", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId, name }),
      });
    } catch { /* not saved — the row stays, so it can be tried again */ }
    load();
  }
