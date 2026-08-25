/**
 * HAULING — THE ROUTE TAB: where to go in what order, and the contract board underneath it.
 *
 * Lifted verbatim out of hauling.html (2026-08-19). Same page, same scope: classic scripts on one
 * document share a global lexical environment, so nothing here is exported and nothing that calls
 * it changed. Load order is preserved — this file sits exactly where the block used to sit.
 */
  /** contract group -> the commodity any of its legs names. Built per render: only the DROP-OFF
   *  objective states it, so a pickup row has to borrow it from its own contract. */
  let commodityOfGroup = new Map();
  /** leg group -> the leg, plus its contract's missionId. Lets a route row reach its own leg's
   *  pickup index and bounds without walking the contract list again. */
  let legByGroupUI = new Map();

  /**
   * A load figure that may be a FLOOR — the hold on a run carrying a commodity nobody has bought
   * yet, and the trip's peak, which is the same reading one level up.
   *
   * 🔴 A ZERO FLOOR IS NOT A FIGURE AND MUST NOT BE PRINTED AS ONE. "peak ≥ 0 SCU" is arithmetically
   * true and says nothing at all — every hold is at least empty. It reads worse than that, in fact:
   * a 0 on screen beside a run the player is about to fill looks like the app having decided the run
   * is not worth loading, which is the same wrong-number-instead-of-no-number mistake `num()` makes
   * on a null. When the whole load is still to be bought, the words are the honest rendering.
   *
   * ⚠️ A NON-ZERO floor keeps its number, because that one is genuinely useful: a board carrying
   * 174 SCU of contracts plus an unbought buy really will hold at least 174.
   */
  function floorScu(scu, unknown) {
    if (!unknown) return num(scu) + " SCU";
    return scu > 0 ? "≥ " + num(scu) + " SCU" : "what you buy";
  }

  /** One line under the route, for the only thing here that can refuse. Cleared by the next action
   *  rather than on a timer — a message that vanishes while you are reading it is worse than one
   *  that waits. Same rule as the Commodities tab's own note. */
  let routeMsg = "";
  function routeNote(text) { routeMsg = text; }

  /**
   * Is this stop a COMMODITY leg, and if so which side of which run?
   *
   * 🔴 THE SCOPE IS THE SAFETY PROPERTY. Only a stop whose every action belongs to one commodity
   * pick, on one side, naming one commodity gets the constrained picker and the re-point write. A
   * contract stop, or a stop where a contract and a commodity share one landing, falls through to
   * the ordinary place-naming behaviour — because there the price table has no opinion and a
   * re-point would move a leg the player was not editing.
   *
   * 🔑 `group` is "buyleg:<buy id>" (see `buyGroup` in hauling-plan.ts), which is how a commodity
   * action is told from a contract one and how the pick's id is recovered. It is a GROUPING key,
   * not a mission reference — the solver has never read it as one.
   */
  function buyLegCtx(s) {
    return buyLegCtxOf((s && s.actions) || []);
  }

  /**
   * The same question asked of ONE ROW's actions rather than a whole stop.
   *
   * 🔑 A landing draws one row per SIDE (DROP OFF, then PICK UP), so a stop where a run is
   * delivered and another is collected is two rows and `buyLegCtx(stop)` correctly refuses it —
   * there is no single thing to move. But the REMOVE control lives on a row, and that row may well
   * be unambiguous while the stop around it is not. Asking per row is what lets the ✕ appear on
   * both halves of a shared landing instead of on neither.
   */
  function buyLegCtxOf(acts) {
    if (!acts.length) return null;
    const PREFIX = "buyleg:";
    let commodity = null;
    let side = null;
    let buyId = null;
    for (const a of acts) {
      const g = String(a.group || "");
      if (g.indexOf(PREFIX) !== 0) return null;               // a contract shares this landing
      const id = g.slice(PREFIX.length);
      const kind = a.kind === "dropoff" ? "sell" : "buy";
      if (buyId === null) { buyId = id; side = kind; commodity = a.commodity || null; }
      // Two different runs, or both ends of one, on a single landing: there is no single thing to
      // move, so offer nothing rather than guess which.
      else if (id !== buyId || kind !== side || (a.commodity || null) !== commodity) return null;
    }
    if (!buyId || !commodity) return null;
    return { buyId, side, commodity };
  }

  /**
   * Forget a commodity pick, from the Route side.
   *
   * ⚠️ SAME ENDPOINT THE COMMODITIES TAB USES. The two controls are two doors onto one action, so
   * there is one write and one re-solve — not a second removal path that could disagree with the
   * first about what "removed" means.
   * 🔑 The confirmation is the RESULT: after `load()` both legs are gone from the list you are
   * looking at, which is more convincing than a dialog and costs no click. A mis-click is cheap to
   * undo — the run goes back from the Commodities board — and nothing about money moves.
   */
  async function dropBuyLeg(ctx) {
    try {
      const res = await fetch("/api/hauling/buy/forget?id=" + encodeURIComponent(ctx.buyId),
        { method: "POST", cache: "no-store" });
      // 🔴 A refusal is said rather than swallowed: a ✕ that silently does nothing is exactly the
      // complaint this control exists to answer.
      routeNote(res.ok ? "" : "That run could not be removed.");
    } catch {
      routeNote("The app's background service is not answering, so that run was not removed.");
    }
    load();
  }

  function renderRoute() {
    commodityOfGroup = new Map();
    legByGroupUI = new Map();
    for (const c of (plan?.contracts || [])) {
      for (const l of (c.legs || [])) {
        legByGroupUI.set(l.group, { ...l, missionId: c.missionId });
      }
    }
    for (const t of (plan?.trips || [])) {
      for (const st of t.stops) {
        for (const a of (st.actions || [])) {
          if (a.commodity && !commodityOfGroup.has(a.group)) commodityOfGroup.set(a.group, a.commodity);
        }
      }
    }
    const body = $("body");
    body.textContent = "";
    for (const n of plan.notes) {
      const d = document.createElement("div"); d.className = "note"; d.textContent = n;
      body.appendChild(d);
    }
    if (routeMsg) {
      const d = document.createElement("div"); d.className = "note"; d.textContent = routeMsg;
      body.appendChild(d);
    }
    /* 🔴 A PICK THAT COULD NOT BE ROUTED IS SAID, never silently absent — same rule as `unrouted`
       for a contract leg. The player pressed a button and something has to have happened; a run
       that quietly did not appear reads as the button being broken. */
    for (const b of (plan.buys || [])) {
      if (b.routed) continue;
      const d = document.createElement("div"); d.className = "note";
      d.textContent = b.commodity + ": " + b.reason + ".";
      body.appendChild(d);
    }
    if (!plan.trips.length) {
      const d = document.createElement("div"); d.className = "empty";
      // ⚠️ This tab sequences BOTH sources now, so the empty state has to name both — telling a
      // player to accept a contract when they came here to plan a commodity run is the widget
      // describing a version of itself that no longer exists.
      d.textContent = plan.contracts.length
        ? "Nothing left to fly — every accepted leg is delivered."
        : "Accept a hauling contract, or pick a run on the Commodities tab, and it shows up here.";
      body.appendChild(d);
    }
    plan.trips.forEach((trip, ti) => {
      const sec = document.createElement("div");
      sec.className = "sec";
      const h = document.createElement("span");
      h.textContent = plan.trips.length > 1 ? "Trip " + (ti + 1) : "Route";
      const n = document.createElement("span");
      n.className = "n";
      // 🔴 "peak" IS A FLOOR ON A RUN CARRYING AN UNBOUGHT COMMODITY — see the hold reading below,
      // which this is the trip-level version of. Same reasoning, same rendering.
      n.textContent = trip.landings + " stops · " + fmtMins(trip.totalMinutes)
        + " · peak " + floorScu(trip.peakScu, trip.unknownScu);
      // The optimiser falls back to a heuristic past 14 visits — say so rather than imply optimal.
      if (trip.method === "heuristic") n.textContent += " · approx.";
      sec.append(h, n);
      body.appendChild(sec);
      // ⛔ NO "you are here" row. It was added on the theory that a route should name its origin,
      // and Sub rejected it flatly: he knows where he is standing — he is standing there. Step 1
      // must be the next thing he DOES, not a restatement of the present. A numbered list that
      // spends its first line on something requiring no action is one step of pure noise.
      // 🔴 ONE NUMBERED STEP = ONE ACTION. A landing that unloads and then loads used to be a
      // single row carrying every chip at once, which Sub described exactly right: "a bunch of
      // shit written in number one — I don't know what I need to drop off or what I need to pick
      // up". Numbering is what a player follows, so the numbers have to match the things they do.
      // Drop-offs lead at a landing: that is the order at a freight elevator, and it is what the
      // solver models. So a mixed landing becomes "1. DROP OFF … / 2. PICK UP …", same place,
      // marked as one landing so it never reads as two flights.
      let step = 0;
      // Already collected, not yet delivered. Greyed, ahead of the live steps, because that is
      // where they happened — the contract then reads start to finish and the interim state is
      // visible instead of having to be inferred from a route that opens mid-sentence.
      if (ti === 0) {
        for (const cp of (plan.completedPickups || [])) {
          step++;
          const row = document.createElement("div");
          row.className = "stop pickup done";
          const numEl = document.createElement("div");
          numEl.className = "num";
          numEl.textContent = "✓";
          /* 🔴 "Collected" is not "aboard". The game finishes a pickup objective the moment it
             releases the cargo to the freight lift — eleven seconds before the platform even starts
             rising, on Sub's own measured run. So the row says which it is: still on the pad where
             you are standing, or genuinely with you because you have since moved on. */
          const onPad = cp.where === "onPad";
          numEl.title = onPad
            ? "The game has released this to the freight lift — it is on the pad here, not in your ship yet."
            : "Collected, and you have moved on since — so it is in your hold.";
          const mid = document.createElement("div");
          mid.className = "mid";
          const nm = document.createElement("div");
          nm.className = "nm";
          nm.textContent = step + ". PICKED UP — " + (plan.locationNames[cp.locationId] || cp.locationId || "unknown");
          const acts = document.createElement("div");
          acts.className = "acts";
          const chip = document.createElement("span");
          const dot = document.createElement("i");
          dot.style.cssText = "display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:4px;background:" + colourOf(cp.group);
          chip.appendChild(dot);
          const c = document.createElement("span");
          c.className = "c";
          c.textContent = (cp.commodity ? cp.commodity + " " : "") + num(cp.scu) + " SCU  ·  "
            + (onPad ? "on the pad here" : "aboard");
          chip.title = cp.title || "";
          chip.appendChild(c);
          acts.appendChild(chip);
          const rt = document.createElement("div");
          rt.className = "rt";
          rt.textContent = "—";
          /* 🔴 THE TONNAGE USED TO SIT BESIDE THE NAME AND EAT IT. `.rt` is flex:none, so a step
             reading "6 SCU of Medical Supplies" took whatever width it liked and `.mid` shrank
             until the place name ellipsised — worst exactly when the commodity name was longest,
             which is when you most need to know where you are going. Sub: "the amount of SCU of
             whatever is truncating the pickup and drop off location. The pickup and drop off
             location should just go span across the whole thing."
             🔑 Split by LENGTH, not wholesale. Only the tonnage moves down; the travel time is
             two or three mono characters and can never squeeze anything, so it stays beside the
             name where it has always been. Moving the whole of `.rt` also worked but cost every
             stop two extra lines of height for no benefit. */
          const under = document.createElement("div");
          // ⚠️ Its OWN class, NOT "rt". Reusing .rt put a second .rt in every row, and the suite
          // selects the travel time with querySelector(".rt") — which then matched this block
          // instead (it sits inside .mid, earlier in document order) and read a tonnage where
          // it expected a duration. Overloading a class the tests select on is the bug.
          under.className = "tons";
          // ⚠️ ELEMENT children only. The travel time is set with `rt.textContent = …`, so it is a
          // TEXT NODE sibling of .ld/.hold — a childNodes sweep drags it down too, which is
          // exactly what the first attempt did (the time vanished from the name row).
          while (rt.firstElementChild) under.appendChild(rt.firstElementChild); // .ld, .hold
          mid.append(nm, acts);
          if (under.childNodes.length) mid.appendChild(under);
          row.append(numEl, mid, rt);
          body.appendChild(row);
        }
      }
      trip.stops.forEach((s, i) => {
        const groups = [
          { kind: "dropoff", verb: "DROP OFF", acts: s.actions.filter((a) => a.kind === "dropoff") },
          { kind: "pickup", verb: "PICK UP", acts: s.actions.filter((a) => a.kind === "pickup") },
        ].filter((g) => g.acts.length);
        groups.forEach((g, gi) => {
          // Only the first row of a landing owns the flight time; a second action at the same
          // place is not another journey.
          const sameLanding = (s.sameSpot && i > 0) || gi > 0;
          step++;
          const row = document.createElement("div");
          row.className = "stop " + g.kind + (sameLanding ? " same" : "");
          const numEl = document.createElement("div");
          numEl.className = "num";
          numEl.textContent = g.kind === "dropoff" ? "↓" : "↑";
          numEl.title = g.kind === "dropoff" ? "Unload here" : "Load here";
          const mid = document.createElement("div");
          mid.className = "mid";
          const nm = document.createElement("div");
          nm.className = "nm";
          const label = step + ". " + g.verb + " — " + s.name + (sameLanding ? "  (same landing)" : "");
          const nmt = document.createElement("span");
          nmt.className = "nmt";
          nmt.textContent = label;
          nm.appendChild(nmt);
          /* 🔴 NAME IT WHERE YOU SEE IT. This replaces the "Name these places" panel outright: the
             row already knows which stop it is, in what order, carrying what — so there is nothing
             to disambiguate and nothing to scroll to. Click the name, type, Enter.
             The keyboard grab is the SHARED one (grabOn/grabOff): without it every keystroke goes
             to the game instead of the box. */
          if (s.locationId) {
            /* 🔴 AN AFFORDANCE NOBODY CAN SEE IS NOT A FEATURE. Sub: "there is no indication in the
               UI that lets me know that I can click on Shubin Mining or any location and change
               where we need to go. So the person would have to alt-tab to it and click inside just
               to figure that out." So the name carries a dotted underline and a pencil — visible
               without shouting, and the pencil is the part that reads as "editable" at a glance. */
            nm.title = "Click to name this place. It sticks to these coordinates.";
            nm.style.cursor = "text";
            nm.classList.add("editable");
            const pen = document.createElement("span");
            pen.className = "pen";
            pen.textContent = "✎";
            nm.appendChild(pen);
            nm.addEventListener("click", (e) => {
              e.stopPropagation();
              if (nm.querySelector("input")) return;
              const inp = document.createElement("input");
              inp.type = "text";
              inp.className = "nminp";
              inp.value = (plan.unnamedPlaces || []).find((x) => x.locationId === s.locationId)?.yours || "";
              inp.placeholder = s.name;
              nmt.textContent = step + ". " + g.verb + " — ";
              nmt.appendChild(inp);
              const restore = () => {
                closeSug(s.locationId);
                placeRows.delete(s.locationId);
                nmt.textContent = label;
              };
              /* 🔴 IT HAS TO SUGGEST, OR IT CANNOT BE USED. Sub, on the first cut of this: "it
                 doesn't auto correct it for me... I can't put the exact name in there." He is
                 right — these are proper nouns out of the game ("Riker Memorial Spaceport"), and a
                 free-text box asks him to spell something he only ever saw on a screen.
                 The suggestion list is the SAME machinery the old panel used; registering this
                 editor in `placeRows` under the locationId is all it needs, so ask/close/arrow-keys
                 all work unchanged and there is no second implementation to drift. */
              placeRows.set(s.locationId, { row: nm, inp, ctx: buyLegCtx(s) });
              inp.addEventListener("focus", () => { grabOn(inp); askPlaces(s.locationId, inp.value, nm); });
              inp.addEventListener("blur", () => { grabOff(); setTimeout(() => closeSug(s.locationId), 120); });
              inp.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); wantFocus = inp; });
              inp.addEventListener("input", () => askPlaces(s.locationId, inp.value, nm));
              inp.addEventListener("keydown", (ev) => {
                // Arrows/Enter over the suggestion list first — it owns those keys while it is open.
                onSugKey(ev, s.locationId, inp, nm);
                if (ev.defaultPrevented) { ev.stopPropagation(); return; }
                if (ev.key === "Enter") { ev.preventDefault(); savePlace(s.locationId, inp.value.trim()); }
                // Escape puts the row back without saving — a mis-click must cost nothing.
                else if (ev.key === "Escape") { ev.preventDefault(); inp.blur(); restore(); }
                ev.stopPropagation();
              });
              inp.focus();
              inp.select();
            });
          }
          /* 🔴 REMOVING A COMMODITY RUN BELONGS HERE, NOT ON THE COMMODITIES TAB (Sub, 2026-08-25).
             The Commodities board is a ranked top-25 of what is worth carrying RIGHT NOW, and its
             "In route ✓" button is the only way a pick could be un-picked — so a run drops out of
             reach the moment it stops ranking. Measured on Sub's own board that day: four picks in
             the route, and only ONE of them had a row to click. The other three were unremovable
             from anywhere in the app.
             🔑 Sub's reasoning is the better one and it is why this is not merely a second control:
             "on the commodities tab, you're picking a pickup and drop-off location that the user
             may not wind up following through with" — the Route is where the commitment lives, so
             the Route is where it is withdrawn.
             🔑 BOTH ENDS GO, AND THAT IS FREE RATHER THAN BUILT. A pick is ONE record server-side
             and both legs carry `group: "buyleg:<its id>"`, so forgetting the id removes the pickup
             and the drop-off in the same re-solve. There is no pairing logic here to drift — the
             thing being deleted was always one thing. */
          const legCtx = buyLegCtxOf(g.acts);
          if (legCtx) {
            const drop = document.createElement("button");
            drop.type = "button";
            drop.className = "dropleg";
            drop.textContent = "✕";
            drop.title = "Remove " + legCtx.commodity + " from the route — both the pickup and the"
              + " drop-off. Nothing you have already bought is forgotten: this is the plan, not the"
              + " Ledger.";
            // 🔴 The name editor opens on a click anywhere in `.nm`, so this must not bubble — a ✕
            // that also opened a rename box would be the worst of both.
            drop.addEventListener("pointerdown", (ev) => ev.stopPropagation());
            drop.addEventListener("click", (ev) => {
              ev.stopPropagation();
              dropBuyLeg(legCtx);
            });
            nm.appendChild(drop);
          }
          const acts = document.createElement("div");
          acts.className = "acts";
          for (const a of g.acts) {
            const chip = document.createElement("span");
            const dot = document.createElement("i");
            dot.style.cssText = "display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:4px;background:" + colourOf(a.group);
            chip.appendChild(dot);
            const c = document.createElement("span");
            c.className = "c";
            // An untracked contract does not name its commodity, so the tonnage carries the row and
            // the contract's title goes in the tooltip rather than swamping the line.
            const named = a.commodity || commodityOfGroup.get(a.group);
            const lg = legByGroupUI.get(a.group);
            const split = lg && lg.pickupCount > 1 && g.kind === "pickup";
            /* A split pickup shows the SPREAD, not a share dressed up as a figure — see the plan's
               MORE PICKUPS THAN DROP-OFFS note. The exact ones (pinned, or worked out from the
               others) print as one number like anything else. */
            /* 🔴 A COMMODITY YOU HAVE NOT BOUGHT YET HAS NO TONNAGE, AND `num()` WOULD PRINT IT AS
               "0 SCU". That is the worst possible wording: zero is a measurement, and this is the
               absence of one — the player would read "0 SCU of Titanium" as the app having decided
               the run was not worth filling. Sub's design is that the tonnage arrives from the log
               when he buys, so the chip says exactly that and no number is invented.
               🔑 `a.scu == null` covers null and undefined and nothing else; `!a.scu` would catch a
               genuine zero as well, which is a different claim. */
            const unbought = a.scu == null && !split;
            c.textContent = unbought
              ? (named || "Commodity") + " — how much is up to you"
              : (named ? named + " " : "")
                + (split && !lg.exact && lg.min != null && lg.max != null && lg.min !== lg.max
                     ? lg.min + "–" + lg.max
                     : num(split ? lg.scu : a.scu))
                + " SCU";
            chip.title = unbought
              ? "You decide how much when you get there. The app reads the real figure off your"
                + " purchase and updates the route, the hold and the Stow tab."
              : (a.title || "");
            chip.appendChild(c);
            /* 🔴 THE BOX GOES WHERE THE ANSWER IS. Nothing states how much comes from each pickup —
               and Sub's point settles that it never will: a 1–5 SCU spread in the game data is a
               RANDOM roll per instance, re-rolled if the contract is taken again. So the figure can
               only come from him, standing at the elevator looking at it.
               One box per pickup, and the LAST one is never asked for — it is the total less the
               others. Two pickups means one number, ever. */
            if (split) {
              const key = lg.missionId + "#p" + lg.pickupIndex;
              if (lg.source === "derived") {
                const d = document.createElement("span");
                d.className = "pinderived";
                d.textContent = "worked out";
                d.title = "The contract total less what you typed at the other pickups, so this one"
                  + " did not need asking about.";
                chip.appendChild(d);
              } else {
                const pi = document.createElement("input");
                pi.type = "number";
                pi.step = "1";
                // Bounded by what this pickup can possibly be — see the leg's min/max.
                if (Number.isFinite(lg.min)) pi.min = String(lg.min);
                if (Number.isFinite(lg.max)) pi.max = String(lg.max);
                pi.className = "pinbox";
                pi.value = pins[key] != null ? pins[key] : "";
                pi.placeholder = lg.min != null && lg.max != null && lg.min !== lg.max ? lg.min + "–" + lg.max : "SCU";
                pi.title = "How much you actually pick up here. Type one and the other pickup is"
                  + " worked out for you.";
                pi.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); wantFocus = pi; });
                pi.addEventListener("click", (ev) => ev.stopPropagation());
                pi.addEventListener("focus", () => grabOn(pi));
                pi.addEventListener("blur", () => grabOff());
                pi.addEventListener("change", () => {
                  const raw = Number(pi.value);
                  // Typing ignores min/max — only the spinner respects them — so clamp here too.
                  const lo = Number.isFinite(lg.min) ? lg.min : 1;
                  const hi = Number.isFinite(lg.max) ? lg.max : Infinity;
                  const v = Math.min(Math.max(Math.round(raw), lo), hi);
                  if (Number.isFinite(raw) && raw > 0) { pins[key] = v; pi.value = String(v); }
                  else delete pins[key];
                  savePins();
                  load();
                });
                pi.addEventListener("keydown", (ev) => {
                  if (ev.key === "Enter") { ev.preventDefault(); pi.blur(); }
                  else if (ev.key === "Escape") { ev.preventDefault(); pi.value = pins[key] != null ? pins[key] : ""; pi.blur(); }
                  ev.stopPropagation();
                });
                chip.appendChild(pi);
              }
            }
            acts.appendChild(chip);
            acts.appendChild(document.createTextNode("   "));
          }
          const rt = document.createElement("div");
          rt.className = "rt";
          rt.textContent = sameLanding ? "—" : fmtMins(s.minutes);
          // 🔴 THE STEP'S OWN TONNAGE. A step headed DROP OFF states how much comes off; a step
          // headed PICK UP states how much goes on. See the .ld note in the stylesheet.
          const moved = g.acts.reduce((n, a) => n + (a.scu || 0), 0);
          const ld = document.createElement("div");
          ld.className = "ld";
          /* 🔴 A TONNAGE WITHOUT ITS COMMODITY IS A RIDDLE. Sub: "the number one pickup says 6 SCU,
             but it doesn't tell me what of." A pickup leg often has no commodity of its own — only
             the drop-off objective names it — so the name is inherited from the same contract's
             other legs rather than left blank. */
          const cargo = [...new Set(g.acts.map((a) => a.commodity || commodityOfGroup.get(a.group)).filter(Boolean))];
          /* 🔴 SAME RULE AS THE CHIP: a step whose cargo is not bought yet has no tonnage, and
             summing `a.scu || 0` prints the absence of a figure as a zero. `moved` is what is
             KNOWN; the unbought part is said in words rather than folded into it. */
          const anyUnknown = g.acts.some((a) => a.scu == null);
          ld.textContent = anyUnknown && moved === 0
            ? "you decide here"
            : num(moved) + " SCU" + (anyUnknown ? " + what you buy" : "")
              + (cargo.length === 1 ? " of " + cargo[0] : "");
          ld.title = anyUnknown
            ? "Part of this step is a commodity you have not bought yet, so this is at least what"
              + " moves here — never the whole of it."
            : g.kind === "dropoff" ? "Comes off here." : "Goes on here.";
          rt.appendChild(ld);
          // Where the hold ends up is a fact about the LANDING, not about this action, so it is
          // stated once, quietly, on the landing's last row.
          if (gi === groups.length - 1) {
            const hold = document.createElement("div");
            hold.className = "hold";
            /* 🔴 A FLOOR IS NOT A FIGURE. `trip.unknownScu` comes straight from the solver and means
               some leg on this trip has no tonnage yet, so every hold reading on it is a LOWER
               BOUND. Printing "hold 174" beside a run that will really carry 250 is the app telling
               the player their ship is emptier than it is going to be — the same class of mistake as
               a rep bar counting down to a rank the log already proved. */
            const floor = !!trip.unknownScu;
            hold.textContent = "hold " + floorScu(s.loadAfterScu, floor).replace(" SCU", "");
            hold.title = floor
              ? "At least this much when you leave — this run carries a commodity you have not"
                + " bought yet, so the real figure can only be higher."
              : "In the hold when you leave this stop.";
            rt.appendChild(hold);
          }
          /* 🔴 THE TONNAGE USED TO SIT BESIDE THE NAME AND EAT IT. `.rt` is flex:none, so a step
             reading "6 SCU of Medical Supplies" took whatever width it liked and `.mid` shrank
             until the place name ellipsised — worst exactly when the commodity name was longest,
             which is when you most need to know where you are going. Sub: "the amount of SCU of
             whatever is truncating the pickup and drop off location. The pickup and drop off
             location should just go span across the whole thing."
             🔑 Split by LENGTH, not wholesale. Only the tonnage moves down; the travel time is
             two or three mono characters and can never squeeze anything, so it stays beside the
             name where it has always been. Moving the whole of `.rt` also worked but cost every
             stop two extra lines of height for no benefit. */
          const under = document.createElement("div");
          // ⚠️ Its OWN class, NOT "rt". Reusing .rt put a second .rt in every row, and the suite
          // selects the travel time with querySelector(".rt") — which then matched this block
          // instead (it sits inside .mid, earlier in document order) and read a tonnage where
          // it expected a duration. Overloading a class the tests select on is the bug.
          under.className = "tons";
          // ⚠️ ELEMENT children only. The travel time is set with `rt.textContent = …`, so it is a
          // TEXT NODE sibling of .ld/.hold — a childNodes sweep drags it down too, which is
          // exactly what the first attempt did (the time vanished from the name row).
          while (rt.firstElementChild) under.appendChild(rt.firstElementChild); // .ld, .hold
          mid.append(nm, acts);
          if (under.childNodes.length) mid.appendChild(under);
          row.append(numEl, mid, rt);
          body.appendChild(row);
        });
      });
    });
    if (plan.stranded.length) {
      const d = document.createElement("div");
      d.className = "note";
      d.textContent = plan.stranded.length + " contract(s) will not fit this ship even on their own.";
      body.appendChild(d);
    }
    /* 🔴 Legs that must be carried but could not be routed. Never folded away: a route that is
       missing legs while presenting itself as THE route is the one failure that would make this
       widget worse than no widget. */
    if (plan.unrouted.length) {
      const names = locNames();
      const sec = document.createElement("div");
      sec.className = "sec";
      const h = document.createElement("span"); h.textContent = "Not in the route";
      const n = document.createElement("span"); n.className = "n"; n.textContent = plan.unrouted.length + " leg(s)";
      sec.append(h, n);
      body.appendChild(sec);
      for (const u of plan.unrouted) {
        const d = document.createElement("div");
        d.className = "note";
        const leg = legOf(u.group);
        d.textContent = (u.destination || destOf(leg, names)) + " · " + num(u.scu) + " SCU — " + u.reason + ".";
        body.appendChild(d);
      }
    }
    renderContracts(body);
  }

  /** The board itself: what is accepted, how much it is, and how sure we are. */
  function renderContracts(body) {
    const list = plan.contracts.filter((c) => showDone || !c.ended);
    if (!list.length) return;
    const sec = document.createElement("div");
    sec.className = "sec fold" + (foldContracts ? " closed" : "");
    const caret = document.createElement("span"); caret.className = "caret"; caret.textContent = foldContracts ? "▸" : "▾";
    const h = document.createElement("span"); h.textContent = "Contracts";
    const n = document.createElement("span"); n.className = "n"; n.textContent = list.length + " on the board";
    sec.append(caret, h, n);
    sec.title = "Show or hide the contract details.";
    sec.addEventListener("click", () => {
      foldContracts = !foldContracts;
      try { localStorage.setItem(FOLD_KEY, foldContracts ? "1" : "0"); } catch { /* private mode */ }
      render();
    });
    body.appendChild(sec);
    if (foldContracts) return;
    const shown = list.filter((c) => !dropped.includes(c.missionId));
    if (dropped.length) {
      /* Never a one-way door. A contract removed because it looked stuck is exactly the one you
         will want back when it turns out it was not. */
      const dr = document.createElement("div"); dr.className = "droprow";
      const lbl = document.createElement("span");
      lbl.textContent = dropped.length + " removed from this list";
      const b = document.createElement("button");
      b.type = "button"; b.textContent = "put them back";
      b.addEventListener("click", () => { dropped = []; saveDropped(); load(); });
      dr.append(lbl, b);
      body.appendChild(dr);
    }
    for (const c of shown) {
      const card = document.createElement("div");
      card.className = "card" + (c.ended ? " done" : "") + (c.hidden ? " setaside" : "");
      const top = document.createElement("div");
      top.className = "top";
      const t = document.createElement("div"); t.className = "t"; t.textContent = c.title || c.contractKey;
      // 🔴 The figure carries its own provenance, in its colour. The badge that used to sit beside
      // it is gone — see the .amt.src-* note in the stylesheet — but the reason it existed has not
      // changed, so the same wording is still on the number as a tooltip.
      const amt = document.createElement("div");
      amt.className = "amt src-" + (c.source || "unknown");
      amt.textContent = fmtScu(c);
      amt.title = (BADGE[c.source] || BADGE.unknown)[1];
      /* Ticked = in the plan. Unticking greys the card and pulls it out of the route WITHOUT
         removing it, which is the whole point: you are asking "what does this run look like
         without that one", and you need to still see it to ask again. */
      if (!c.ended) {
        const tick = document.createElement("button");
        tick.type = "button";
        tick.className = "cardtick";
        tick.textContent = c.hidden ? "" : "✓";
        tick.title = c.hidden
          ? "Not in the plan. Tick to put it back in the route."
          : "In the plan. Untick to see the route without it — the contract stays on the board.";
        tick.setAttribute("aria-pressed", c.hidden ? "false" : "true");
        tick.addEventListener("click", (e) => {
          e.stopPropagation();
          hidden = c.hidden ? hidden.filter((id) => id !== c.missionId) : hidden.concat([c.missionId]);
          saveHidden();
          load();
        });
        top.appendChild(tick);
      }
      top.append(t, amt);
      /* 🔴 SET ASIDE. A player decides to skip a contract long before they open mobiGlas to abandon
         it, and until then it drags the route and the hold around with it. The game reports a real
         abandon on its own (`CompletionType[Abandon]`), which ends the contract outright — this is
         only the gap before that, and it is reversible: track it in mobiGlas and it comes straight
         back. Not offered on an ended contract, which is already out of the plan. */
      if (!c.ended) {
        const x = document.createElement("button");
        x.type = "button";
        x.className = "cardx";
        x.textContent = "✕";
        x.title = "Remove this contract from the list entirely. For one the game never closed out,"
          + " so it sits here forever and cannot be done. Reversible — a line appears at the top of"
          + " the list to put them back.";
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          dropped = dropped.concat([c.missionId]);
          saveDropped();
          load();
        });
        top.appendChild(x);
      }
      const sub = document.createElement("div");
      sub.className = "sub";
      const where = [];
      if (c.giver) where.push(c.giver);
      if (c.missionType) where.push(c.missionType);
      const done = c.legs.filter((l) => l.dropoffState === "completed").length;
      where.push(done + "/" + c.legs.length + " delivered");
      if (c.ended) where.push(c.completion || "ended");
      if (c.payout != null) where.push(num(c.payout) + " aUEC");
      for (const w of where) { const s = document.createElement("span"); s.textContent = w; sub.appendChild(s); }
      card.append(top, sub);
      // Box chips per leg. ⚠️ A partitioned split is a MODEL of what the game will hand you, not a
      // reading of it — the engine partitions server-side and logs nothing for SCU hauls.
      for (const l of c.legs) {
        if (!l.boxLabel && !l.boxCount) continue;
        const chips = document.createElement("div");
        chips.className = "chips";
        const dot = document.createElement("i");
        dot.style.cssText = "display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:5px;background:" + colourOf(l.group);
        chips.appendChild(dot);
        const txt = document.createElement("span");
        const parts = [];
        if (l.destination) parts.push("→ " + l.destination);
        if (l.commodity) parts.push(l.commodity);
        txt.textContent = parts.join("  ·  ");
        chips.appendChild(txt);
        // 🔴 ONE PILL PER BOX SIZE — the SIZE reads large, the COUNT is a small multiplier beside it.
        // As a run of text, "12 × 8" was read as a box DIMENSION, and a row of four of them was the
        // most cluttered thing on the card. A box has one shape, so its size is its whole identity;
        // how many of them is secondary. Falls back to the flat label when a leg has no breakdown.
        if (l.boxes && l.boxes.length) {
          for (const b of l.boxes) {
            const pill = document.createElement("span");
            pill.className = "boxpill src-" + (l.boxSource || "partition");
            const size = document.createElement("b");
            size.textContent = b.scu + " SCU";
            const mult = document.createElement("i");
            mult.textContent = "×" + b.count;
            pill.append(size, mult);
            pill.title = b.count + " box" + (b.count > 1 ? "es" : "") + " of " + b.scu + " SCU";
            chips.appendChild(pill);
          }
        } else if (l.boxCount) {
          const pill = document.createElement("span");
          pill.className = "boxpill src-" + (l.boxSource || "partition");
          pill.textContent = l.boxCount + " boxes";
          chips.appendChild(pill);
        }
        if (l.maxContainerScu != null) {
          const cap = document.createElement("span");
          cap.className = "boxcap";
          cap.textContent = "max " + l.maxContainerScu + (l.capSource === "assumed" ? "?" : "");
          cap.title = l.capSource === "assumed"
            ? "No cap declared for this contract — the largest box that exists was assumed."
            : "The largest box size this contract declares.";
          chips.appendChild(cap);
        }
        if (l.boxSource === "partition") {
          chips.title = "Provisional: the game never logs the box split for a cargo haul, so this is the"
            + " largest-box-first model against this contract's own container cap.";
        } else if (l.boxSource === "manifest") {
          chips.title = "Read from the log — the game enumerated every box for this contract.";
        }
        if (l.dropoffState === "completed") {
          const tick = document.createElement("span"); tick.className = "tick"; tick.textContent = "  ✓";
          chips.appendChild(tick);
        }
        card.appendChild(chips);
      }
      body.appendChild(card);
    }
    body.appendChild(sourceKey(list));
  }

  /** The key for the provenance colours. Built from what is actually on screen — a legend listing
   *  states no card is in is a legend nobody reads twice. */
  function sourceKey(list) {
    const key = document.createElement("div");
    key.className = "srckey";
    const seen = new Set(list.map((c) => c.source || "unknown"));
    for (const l of list.flatMap((c) => c.legs)) if (l.boxLabel || l.boxCount) seen.add("box:" + (l.boxSource || "partition"));
    const ROWS = [
      ["log", "var(--green)", "SCU stated by the game"],
      ["manifest", "var(--green)", "SCU listed box by box"],
      ["pinned", "var(--cyan-bright)", "SCU you typed in"],
      ["dataset", "var(--cyan-dim)", "SCU from the game files"],
      ["range", "var(--gold)", "SCU only bounded"],
      ["unknown", "var(--red)", "SCU unknown"],
      ["box:manifest", "var(--green)", "boxes listed by the game"],
      ["box:partition", "var(--gold)", "boxes worked out here"],
    ];
    for (const [id, colour, label] of ROWS) {
      if (!seen.has(id)) continue;
      const s = document.createElement("span");
      const i = document.createElement("i"); i.style.background = colour;
      s.append(i, document.createTextNode(label));
      key.appendChild(s);
    }
    return key;
  }
