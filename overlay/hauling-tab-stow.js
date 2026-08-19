/**
 * HAULING — THE STOW TAB: the load order, and the isometric holds that illustrate it.
 *
 * This file RENDERS. The geometry and the model live in hauling-stow.js (StowView), and the
 * packing lives in the sidecar — see that file's header for why the order is the content and the
 * picture is only its illustration.
 *
 * Lifted verbatim out of hauling.html (2026-08-19). Same page, same scope: classic scripts on one
 * document share a global lexical environment, so nothing here is exported and nothing that calls
 * it changed. Load order is preserved — this file sits exactly where the block used to sit.
 */
  /**
   * 🔴 THE STOWAGE VIEW — what to load first, and where every box goes.
   *
   * The order comes first and the picture second, because the picture is not the instruction. The
   * instruction is "go to the elevator and lift THIS mission", and the freight elevator UI does not
   * name missions — it lists cargo. So each step leads with its BOX SIGNATURE (commodity + the
   * exact split) which is the only handle the player has on which lift is which.
   *
   * Focus is the answer to the many-grid problem. A Caterpillar has 14 grids, a Carrack 9, an Idris
   * 25; drawing every box on every grid at once is wallpaper. Step 1 is focused on open, so the
   * first thing on screen is the first thing to do, and everything else is still visible behind it.
   */
  function renderStow() {
    const body = $("body");
    body.textContent = "";
    if (!plan.ship) {
      const d = document.createElement("div"); d.className = "empty";
      d.textContent = "Pick the ship you are flying and the stowage plan appears here.";
      body.appendChild(d);
      return;
    }
    const m = StowView.model(plan, { autoLoadClasses: autoLoadClasses });

    /* ⛔ Open haulers load themselves — the station's arm places every box and the player never
       touches one. A stowage diagram for a Hull C describes work that does not exist, so it is not
       drawn at all rather than drawn and ignored. */
    /* 🔴 THE HULL IS ONLY HALF THE QUESTION, and this claimed the whole of it. Sub, on a Hull A:
       "it's lying to us. It says the hull A loads itself. It only loads itself on specific
       missions." Automated loading needs an open hauler AND a contract that offers it, and the
       widget cannot promise the second thing just because it can see the first.
       So the no-plan card is only drawn when EVERY live contract qualifies. A mixed board still
       gets a stowage diagram — because some of it really does have to be stowed by hand — with a
       line saying which part the arm will take. */
    /* ⚠️ ABSENT is not "none qualify". A plan without the field at all is one this widget did not
       build (an older sidecar, a fixture), and treating that as "no contract auto-loads" would
       silently swap the behaviour rather than degrade — the same shape of bug that blanked the
       Rank tab when a field went missing from a projection. Absent => the old hull-only rule. */
    const al = plan.autoLoad;
    const allAuto = m.autoLoad && (!al || (al.live > 0 && al.eligible === al.live));
    if (allAuto) {
      const d = document.createElement("div");
      d.className = "noplan";
      const k = document.createElement("div"); k.className = "k";
      k.textContent = (plan.ship.displayName || plan.ship.className) + " loads itself.";
      const why = document.createElement("div"); why.className = "why";
      why.textContent = "It is an open hauler and every contract on your board is a rank that offers"
        + " automated loading, so the station's arm places every box for you — nothing to stow by"
        + " hand and no order to load in. Use the Route tab for where to fly.";
      d.append(k, why);
      body.appendChild(d);
      return;
    }
    if (m.autoLoad && al && al.eligible > 0) {
      const n = document.createElement("div"); n.className = "droprow";
      n.textContent = "The station's arm will load " + al.eligible + " of your " + al.live
        + " contracts. The rest are below the rank that offers it, so they are stowed by hand — that"
        + " is what this diagram is for.";
      body.appendChild(n);
    } else if (m.autoLoad && al) {
      const n = document.createElement("div"); n.className = "droprow";
      n.textContent = (plan.ship.displayName || plan.ship.className) + " can be loaded by the"
        + " station's arm, but none of these contracts are a rank that offers it — so this load is"
        + " yours to stow.";
      body.appendChild(n);
    }

    if (!m.boxes.length) {
      const d = document.createElement("div"); d.className = "empty";
      d.textContent = plan.pack
        ? "Nothing to load — no accepted contract has a known load yet."
        : "Waiting for the packer.";
      body.appendChild(d);
      return;
    }

    // Focus survives a re-render, but only while its mission is still on the board.
    if (!m.steps.some((s) => s.missionId === focusMission)) focusMission = m.steps[0].missionId;

    body.appendChild(renderSteps(m));
    body.appendChild(renderGrids(m));
  }

  /** The ordered load list. Step 1 is what to lift first — its boxes end up deepest in the hold. */
  function renderSteps(m) {
    const wrap = document.createElement("div");
    wrap.className = "steps";
    const sec = document.createElement("div");
    sec.className = "sec";
    const h = document.createElement("span"); h.textContent = "Load in this order";
    const n = document.createElement("span"); n.className = "n";
    n.textContent = m.steps.length + " lift" + (m.steps.length > 1 ? "s" : "") + " · "
      + m.boxes.length + " boxes";
    n.title = m.derivedOrder
      ? "Read off the packer's own placement order — the last drop-off sits deepest, so it is lifted first."
      : "Stated by the stowage planner.";
    sec.append(h, n);
    wrap.appendChild(sec);

    m.steps.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "step" + (s.missionId === focusMission ? " on" : "") + (s.ambiguous ? " clash" : "");
      row.style.borderLeftColor = StowView.shade(s.missionId, 0);
      row.title = "Show only this lift in the diagram.";
      const ord = document.createElement("div");
      ord.className = "ord";
      ord.style.background = StowView.shade(s.missionId, 0);
      ord.textContent = String(s.n);
      const mid = document.createElement("div");
      mid.className = "mid";

      /* 🔴 The signature. Commodity first, because that is the column the elevator shows, then the
         exact box split, because two Processed Food hauls are told apart by 10x8+1x1 vs 4x16. */
      const sig = document.createElement("div");
      sig.className = "sig";
      const what = document.createElement("span"); what.className = "what";
      const parts = s.signature.split(" — ");
      what.textContent = parts[0];
      sig.append(what);
      if (parts[1]) sig.appendChild(document.createTextNode("  " + parts[1]));
      sig.title = "Find this at the freight elevator — it does not name missions, so its contents"
        + " are how you identify it." + (s.title ? "  (" + s.title + ")" : "");

      const meta = document.createElement("div");
      meta.className = "meta";
      const bits = [num(s.scu) + " SCU"];
      if (i === 0 && m.steps.length > 1) bits.push("deepest in the hold");
      if (i === m.steps.length - 1 && m.steps.length > 1) bits.push("last on, first off");
      if (s.grids.length) bits.push(s.grids.map((g) => StowView.gridLabel(g, plan.ship && plan.ship.className)).join(" + "));
      meta.textContent = bits.join("  ·  ");
      mid.append(sig, meta);

      /* Within one mission, which destination's boxes go in first. Same rule one level down: the
         last drop-off is loaded first, so the drops are listed in load order too. */
      if (s.drops.length > 1) {
        const drops = document.createElement("div");
        drops.className = "drops";
        s.drops.forEach((d, di) => {
          const r = document.createElement("div");
          r.className = "drop";
          const dot = document.createElement("i"); dot.style.background = d.colour;
          const nm = document.createElement("span"); nm.className = "d";
          nm.textContent = "→ " + (d.destination || "drop-off");
          const bx = document.createElement("span"); bx.className = "b";
          bx.textContent = d.boxes.map((b) => b.count + "×" + b.scu).join(" · ");
          r.append(dot, nm, bx);
          if (di === 0) {
            const dp = document.createElement("span"); dp.className = "deep"; dp.textContent = "first in";
            dp.title = "This destination is delivered last, so its boxes are loaded deepest.";
            r.appendChild(dp);
          }
          drops.appendChild(r);
        });
        mid.appendChild(drops);
      }

      /* ⚠️ An instruction the player cannot act on is worse than no instruction — but so is the
         same paragraph six times. One line, naming the lifts it collides with, and the reasoning
         in the tooltip. */
      if (s.ambiguous) {
        const c = document.createElement("div");
        c.className = "clash-why";
        c.textContent = "Same signature as lift " + list(s.clashWith) + " — any order between them"
          + (s.clashFixable ? ", or track them to learn the commodity." : ".");
        c.title = "The freight elevator lists cargo, not missions, so two lifts with the same"
          + " commodity and the same box split are indistinguishable there.";
        mid.appendChild(c);
      }

      row.append(ord, mid);
      row.addEventListener("click", () => { focusMission = s.missionId; render(); });
      wrap.appendChild(row);
    });
    return wrap;
  }

  /** The isometric holds. Only grids that received cargo are drawn; the rest are counted. */
  function renderGrids(m) {
    const names = locNames();
    const wrap = document.createElement("div");
    wrap.className = "gridwrap";
    const svgs = [];
    const focused = m.steps.find((s) => s.missionId === focusMission);
    const sec = document.createElement("div");
    sec.className = "sec";
    const h = document.createElement("span"); h.textContent = "Where it goes";
    const n = document.createElement("span"); n.className = "n";
    n.textContent = focused ? "lift " + focused.n + " lit up" : "";
    sec.append(h, n);
    wrap.appendChild(sec);

    for (const g of m.grids) {
      const mine = focused ? g.boxes.filter((b) => b.missionId === focusMission).length : 0;
      const lbl = document.createElement("div");
      lbl.className = "glabel";
      const gn = document.createElement("span"); gn.className = "gn";
      gn.textContent = g.label;
      const meta = document.createElement("span");
      meta.textContent = g.spec.w + "×" + g.spec.l + "×" + g.spec.h + " · "
        + num(g.spec.usedScu) + "/" + num(g.spec.capacityScu) + " SCU · " + g.boxes.length + " boxes";
      lbl.append(gn, meta);
      if (mine) {
        const here = document.createElement("span");
        here.className = "here";
        here.textContent = "· " + mine + " from this lift";
        lbl.appendChild(here);
      }
      wrap.appendChild(lbl);

      const box = document.createElement("div");
      box.className = "isowrap";
      const svg = StowView.iso(g.spec, g.boxes, { focus: focusMission, depthOf: depthOf, spin: stowSpin });
      box.appendChild(svg);
      /* 🔑 The turn-around sits ON the picture, bottom-left, because that is the only thing it acts
         on and a whole toolbar row for one control was wasted space. Sub asked for rotation twice
         while a header button for it was already shipping — he never found it up there. */
      const turn = document.createElement("button");
      turn.type = "button";
      turn.className = "spincorner" + (stowSpin ? " on" : "");
      turn.innerHTML = "&#8635;";
      turn.title = stowSpin
        ? "Looking from the far end — the door is behind you. Click to turn back."
        : "Turn the hold around. A fixed camera always hides the boxes behind the front row.";
      turn.addEventListener("click", () => {
        stowSpin = !stowSpin;
        try { localStorage.setItem(SPIN_KEY, stowSpin ? "1" : "0"); } catch { /* private mode */ }
        render();
      });
      box.appendChild(turn);
      svgs.push(svg);
      wrap.appendChild(box);
    }
    /* 🔑 ONE SCALE ACROSS THE PAGE. Each drawing takes the share of the panel width its own footprint
       deserves against the biggest hold on the ship, so a cell is a cell everywhere and the C2's
       6x9 cubby visibly IS the smaller hold. Sized by ratio rather than by measuring the panel, so
       it survives a resize with no relayout. */
    const widest = Math.max.apply(null, svgs.map((s) => Number(s.dataset.vbw)));
    for (const s of svgs) s.style.width = (Number(s.dataset.vbw) / widest * 100) + "%";

    /* 🔴 THE KEY IS ONE ROW PER DROP-OFF ZONE, numbered with the ROUTE's own step numbers.
       It used to be one row per leg, so Sub's board — three missions, two destinations — produced
       three rows in two colours for what is physically two areas of the hold. The zone is the unit
       that matters, because everything for a stop leaves the ship together; the commodities inside
       it are listed because he still wants to know what he is looking at, but they are detail
       within the zone rather than a reason to separate it. */
    const steps = dropStepIndex();
    const zones = new Map();
    for (const b of m.boxes) {
      const z = StowView.zoneOf(plan, b.group);
      let row = zones.get(z);
      if (!row) {
        const at = steps.get(z);
        row = { colour: colourOf(b.group), step: at ? at.step : null,
                name: at ? at.name : destOf(legOf(b.group), names), items: new Map(), boxes: 0 };
        zones.set(z, row);
      }
      const leg = legOf(b.group);
      const what = (leg && leg.commodity) || "cargo";
      row.items.set(what, (row.items.get(what) || 0) + (b.scu || 0));
      row.boxes++;
    }
    const legend = document.createElement("div");
    legend.className = "legend zones";
    // In route order, so the key reads top-to-bottom the way the run is flown.
    for (const row of [...zones.values()].sort((a, b) => (a.step ?? 99) - (b.step ?? 99))) {
      const el = document.createElement("span");
      const i = document.createElement("i"); i.style.background = row.colour;
      const label = (row.step ? "Stop " + row.step + " · " : "") + row.name;
      const what = [...row.items].map(([k, v]) => k + " " + num(v)).join(" · ");
      el.append(i, document.createTextNode(label));
      const sub = document.createElement("b");
      sub.textContent = what + "  ·  " + row.boxes + " box" + (row.boxes === 1 ? "" : "es");
      el.appendChild(sub);
      el.title = "Everything for this stop comes off together, so it is one area of the hold —"
        + " the commodities inside it do not need separating.";
      legend.appendChild(el);
    }
    wrap.appendChild(legend);

    if (m.emptyGrids > 0) {
      const d = document.createElement("div");
      d.className = "note";
      d.style.color = "var(--faint)";
      d.textContent = m.emptyGrids + " more grid" + (m.emptyGrids > 1 ? "s" : "")
        + " on this hull got nothing, so " + (m.emptyGrids > 1 ? "they are" : "it is") + " not drawn.";
      wrap.appendChild(d);
    }
    for (const w of m.warnings) {
      const d = document.createElement("div"); d.className = "note"; d.textContent = w;
      wrap.appendChild(d);
    }
    if (m.unplaced.length) {
      const d = document.createElement("div");
      d.className = "note";
      d.textContent = m.unplaced.length + " boxes ("
        + num(m.unplaced.reduce((s, u) => s + u.scu, 0)) + " SCU) do not fit — this is more than one trip.";
      wrap.appendChild(d);
    }
    return wrap;
  }
