/**
 * STOWAGE VIEW — the isometric picture of the hold, and the order to fill it in.
 *
 * Sub's ask, in his words: "an isometric view of every cargo grid the ship has, with each mission's
 * boxes colour-coded, showing where to put what — plus the order to load them in."
 *
 * ── 🔴 WHAT THIS VIEW IS ACTUALLY FOR ─────────────────────────────────────────────────────────
 *
 * The freight elevator UI **does not name missions**. It lists cargo. So a player standing at the
 * elevator with four accepted contracts cannot be told "load the Covalex one first" — that
 * instruction is unfollowable. What they CAN do is recognise a mission by its contents: the
 * commodity, and the exact box configuration. "Processed Food — 10x 8 SCU + 1x 1 SCU" is findable
 * in two seconds; "mission 2" is not findable at all.
 *
 * That is why the load order here leads with a **box signature** and the diagram is the supporting
 * illustration, not the other way round. ⚠️ Two missions can share a signature — when they do it is
 * said out loud, because an instruction the player cannot act on is worse than no instruction.
 *
 * ── 🤝 THIS MODULE RENDERS. IT DOES NOT PACK ──────────────────────────────────────────────────
 *
 * Placements come from the packer (`src/cargo-pack.ts` -> `plan.pack`) and are drawn EXACTLY as
 * given. Nothing here re-derives a position, chooses a grid, or second-guesses a fit. If a box
 * looks wrong on screen it is a packer bug and belongs in the packer.
 *
 * ── ⛔ AND SOME SHIPS GET NO DIAGRAM AT ALL ────────────────────────────────────────────────────
 *
 * Open haulers (Hull A/B/C, Ironclad, Railen, RAFT, Nomad, Syulen, Golem) auto-load: the station's
 * arm places every box and the player never touches one. Drawing them a stowage plan is worse than
 * drawing nothing, because it implies work that does not exist. `autoLoad` short-circuits the whole
 * view. See `src/hauling-autoload.ts` for the list and why it is hand-maintained.
 *
 * ── 📐 GEOMETRY IS EXACT ──────────────────────────────────────────────────────────────────────
 *
 * 1 cell = 1.25 m = 1 SCU, so the drawing is to scale and a grid's cell count IS its SCU rating.
 * Boxes: 1 -> 1x1x1 · 2 -> 1x2x1 · 4 -> 2x2x1 · 8 -> 2x2x2 · 16 -> 2x4x2 · 24 -> 2x6x2 · 32 -> 2x8x2.
 */
(function (global) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  /* True isometric: all three axes foreshorten equally, so a 1x1x1 box draws as a cube rather than
     the squashed 2:1 pixel-art variant. Screen units are CELLS — the SVG viewBox does the scaling,
     which is what keeps an 8x15 grid and a 4x1 grid on the same page at the same true scale. */
  const KX = Math.cos(Math.PI / 6);   // 0.8660…
  const KY = Math.sin(Math.PI / 6);   // 0.5

  /**
   * Cell coordinate -> screen point, in cell units. +x goes right-and-down, +y left-and-down,
   * +z straight up, so the near corner of the drawing is (w, y_max, 0).
   *
   * ⚠️ The two screen axes must not be parallel, which rules out the obvious way to turn the hold
   * around: negating y here makes the x and y basis vectors anti-parallel and the whole drawing
   * collapses to a flat ribbon. `iso()` mirrors the COORDINATES instead — see `flip` there.
   */
  function project(x, y, z) {
    return [(x - y) * KX, (x + y) * KY - z];
  }
  const pt = (x, y, z) => project(x, y, z).join(",");

  /**
   * ⚠️ FALLBACK ONLY. The packer states each box's footprint AS PLACED (`dx/dy/dz`), because a
   * 16 SCU box is 2x4 or 4x2 depending on whether it was yawed and the drawing cannot guess which.
   * This table is the un-yawed geometry from `data/hauling-orders.json`, used only when a placement
   * arrives without dims — the drawing is then right about size and possibly wrong about rotation,
   * which is still better than not drawing the box at all. `warnings` says so when it happens.
   */
  const BOX_DIMS = {
    1: [1, 1, 1], 2: [1, 2, 1], 4: [2, 2, 1], 8: [2, 2, 2],
    16: [2, 4, 2], 24: [2, 6, 2], 32: [2, 8, 2],
  };

  // ── colour ──────────────────────────────────────────────────────────────────
  //
  // 🔑 One MISSION, one hue. That is the unit the player thinks in and the unit the freight
  // elevator lifts in, so it has to be the unit the eye groups by. A mission's separate drop-offs
  // then shift lightness within that hue: same family, different shade, which reads as "same
  // mission, second stop" without spending a second hue on it.

  function hashHue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  /* 🔑 ONE definition of a leg's shade step, used by every call site — the route chips, the
     contract cards, the stow legend and the boxes themselves. When the legend and the diagram
     computed this separately they disagreed the moment load order differed from leg order, and a
     legend that names the wrong colour is worse than no legend. */
  function missionOf(plan, group) {
    for (const c of (plan && plan.contracts) || []) {
      for (const l of c.legs || []) if (l.group === group) return c.missionId;
    }
    return String(group || "").split("#")[0];
  }
  /** A leg's index within its own contract. */
  function depthOf(plan, group) {
    for (const c of (plan && plan.contracts) || []) {
      const i = (c.legs || []).findIndex((l) => l.group === group);
      if (i >= 0) return i;
    }
    return 0;
  }

  /** Mission hue + a per-destination lightness step. `depth` is the leg's index in its contract.
   *  🔑 A ghosted box keeps its FULL colour and is dimmed by opacity alone. Desaturating it
   *  collapsed nine missions into one lavender mass the moment anything was focused, which threw
   *  away the colour-coding that is the point of drawing the hold in the first place. */
  function shade(missionId, depth) {
    const hue = hashHue(String(missionId || ""));
    return "hsl(" + hue + " 62% " + Math.max(38, 64 - (depth || 0) * 11) + "%)";
  }
  /** Face shading. The top catches the light, the two visible walls fall away from it. */
  const FACE = { top: 1, right: 0.78, left: 0.56 };
  /** Darken towards the panel's own near-black rather than towards grey, so a shaded face still
   *  reads as the same mission's colour instead of drifting off its hue. */
  function faceFill(base, k) {
    return "color-mix(in srgb, " + base + " " + Math.round(k * 100) + "%, #04121a)";
  }

  // ── the model ───────────────────────────────────────────────────────────────

  /**
   * Turn a `/api/hauling/plan` response into everything the view needs, and nothing else.
   *
   * `opts.autoLoadClasses` — a Set of ship classes that auto-load, from `/api/ships`. Only consulted
   * when the plan does not state `ship.autoLoad` itself. Absent on both = we draw the diagram, which
   * is the safe direction to be wrong in: a manual loader shown no plan is stranded, an auto-loader
   * shown one just ignores it.
   */
  function model(plan, opts) {
    opts = opts || {};
    const warnings = [];
    const ship = (plan && plan.ship) || null;
    const grids = (ship && ship.grids) || [];
    const autoLoad = !!(ship && (ship.autoLoad != null
      ? ship.autoLoad
      : opts.autoLoadClasses && opts.autoLoadClasses.has(ship.className)));

    // Every leg, by its group key — the join between a packed box and the contract it belongs to.
    const legByGroup = new Map();
    for (const c of (plan && plan.contracts) || []) {
      for (const l of c.legs || []) legByGroup.set(l.group, { c: c, leg: l });
    }

    const raw = (plan && plan.pack && plan.pack.placements) || [];
    const boxes = [];
    let dimless = 0;
    for (const p of raw) {
      /* Two shapes are accepted on purpose: the packer's own `{grid, item, group, dx,dy,dz}` and
         the stowage brain's `{gridIndex, boxId, missionId, destination}`. They are the same fact
         written two ways, and accepting both is what let this view and the packer be built at the
         same time without one blocking the other. */
      const gridIndex = p.gridIndex != null
        ? p.gridIndex
        : grids.findIndex((g) => g.name === p.grid);
      const gridName = p.grid != null ? p.grid : (grids[gridIndex] && grids[gridIndex].name) || "";
      const group = p.group != null ? p.group
        : p.missionId != null ? p.missionId + "#" + (p.destination || "") : "";
      const found = legByGroup.get(group);
      let dx = p.dx, dy = p.dy, dz = p.dz;
      if (dx == null || dy == null || dz == null) {
        const d = BOX_DIMS[p.scu] || [1, 1, 1];
        dx = d[0]; dy = d[1]; dz = d[2];
        dimless++;
      }
      boxes.push({
        id: p.item != null ? p.item : p.boxId,
        group: group,
        missionId: p.missionId != null ? p.missionId : (found ? found.c.missionId : group.split("#")[0]),
        gridIndex: gridIndex,
        gridName: gridName,
        x: p.x, y: p.y, z: p.z, dx: dx, dy: dy, dz: dz, scu: p.scu,
      });
    }
    if (dimless) {
      warnings.push(dimless + " boxes arrived without a placed footprint, so their rotation in the "
        + "drawing is a guess. The packer states dx/dy/dz — that is the field to fix.");
    }

    /* ── LOAD ORDER ───────────────────────────────────────────────────────────
       LIFO: the last drop-off has to sit deepest, so it is loaded FIRST. The packer lays groups
       down in UNLOAD order (first stop nearest the ramp), so the order boxes come out of
       `placements` is the unload order and reversing it is the load order. Read off the packer's
       own output — not recomputed from the route, which would be a second opinion nobody asked for.

       `plan.load` overrides all of this when the stowage brain states it, because it knows about
       constraints this reversal cannot see. */
    let groupOrder = [];
    if (plan && Array.isArray(plan.load) && plan.load.length) {
      for (const step of plan.load) {
        for (const g of (step.groups || (step.group ? [step.group] : []))) {
          if (!groupOrder.includes(g)) groupOrder.push(g);
        }
      }
    }
    const derived = !groupOrder.length;
    if (derived) {
      const unload = [];
      for (const b of boxes) if (b.group && !unload.includes(b.group)) unload.push(b.group);
      groupOrder = unload.reverse();
    } else {
      /* 🔴 `groupOrder` is UNLOAD order — position 0 is the load nearest the door, coming off
         first. Loading runs the other way: you put the deepest cargo in first and finish with
         whatever comes off first. Reading the unload order straight out as a load list told Sub to
         load the wrong end of the ship, and he found out at the drop-off. */
      groupOrder = groupOrder.slice().reverse();
    }

    /* The elevator lifts BY MISSION, so a mission's drops are one lift even when the route
       separates them. Each mission takes the position of its earliest appearance in the load
       order, and its own drops keep their relative order inside it. */
    const steps = [];
    const byMission = new Map();
    for (const g of groupOrder) {
      const found = legByGroup.get(g);
      const missionId = found ? found.c.missionId : g.split("#")[0];
      let step = byMission.get(missionId);
      if (!step) {
        step = {
          n: steps.length + 1,
          missionId: missionId,
          title: found ? found.c.title : null,
          contractKey: found ? found.c.contractKey : null,
          source: found ? found.c.source : "unknown",
          drops: [],
          boxes: [],
          scu: 0,
          boxCount: 0,
          commodities: [],
          grids: [],
          signature: "",
          ambiguous: false,
        };
        byMission.set(missionId, step);
        steps.push(step);
      }
      const leg = found ? found.leg : null;
      const mine = boxes.filter((b) => b.group === g);
      const depth = depthOf(plan, g);
      /* 🔑 The box list comes from the CONTRACT, not from what got placed. The signature has to
         match what the freight elevator shows, and the elevator shows the whole mission — so a load
         that spills over into a second trip must still be identified by all of its boxes. `placed`
         is the subset that made it into the drawing. */
      const drop = {
        group: g,
        depth: depth,
        destination: leg ? dropName(plan, leg) : null,
        commodity: leg ? leg.commodity : null,
        scu: leg && leg.scu != null ? leg.scu : mine.reduce((s, b) => s + (b.scu || 0), 0),
        boxes: leg && leg.boxes && leg.boxes.length ? leg.boxes.slice() : tally(mine),
        boxCount: leg && leg.boxCount ? leg.boxCount : mine.length,
        placed: mine.length,
        colour: shade(missionId, depth),
      };
      step.drops.push(drop);
      step.boxes.push.apply(step.boxes, mine);
      step.scu += drop.scu;
      step.boxCount += drop.boxCount;
      if (drop.commodity && step.commodities.indexOf(drop.commodity) < 0) step.commodities.push(drop.commodity);
      for (const b of mine) if (b.gridName && step.grids.indexOf(b.gridName) < 0) step.grids.push(b.gridName);
    }
    for (const s of steps) {
      s.n = steps.indexOf(s) + 1;
      // Roll the contract's own box lists up across the mission's drops — one lift, one signature.
      const by = new Map();
      for (const d of s.drops) for (const b of d.boxes) by.set(b.scu, (by.get(b.scu) || 0) + b.count);
      s.tally = [...by.entries()].sort((a, b) => b[0] - a[0]).map((e) => ({ scu: e[0], count: e[1] }));
      s.signature = signatureOf(s);
    }

    /* ⚠️ Two missions CAN have the same signature — same commodity, same split. The elevator then
       cannot tell them apart either, and "load this one first" becomes an instruction with no
       referent. Say so rather than issue it, and NAME the lifts it collides with: on a full board
       four of twelve lifts can collide, and "this one is ambiguous" repeated four times is noise
       where "same as lifts 10 and 11" is an answer.

       🔑 Most real collisions are caused by an UNKNOWN commodity — an untracked contract signs as
       "Cargo", so two different goods look alike. That is fixable by the player, so it is said. */
    const bySig = new Map();
    for (const s of steps) {
      if (!bySig.has(s.signature)) bySig.set(s.signature, []);
      bySig.get(s.signature).push(s);
    }
    for (const s of steps) {
      const peers = bySig.get(s.signature).filter((p) => p !== s);
      s.ambiguous = peers.length > 0;
      s.clashWith = peers.map((p) => p.n);
      // Only worth suggesting when knowing the commodity could actually break the tie.
      s.clashFixable = s.ambiguous && bySig.get(s.signature).some((p) => !p.commodities.length);
    }

    // Only grids that actually received cargo are drawn. On a Caterpillar (14 grids) or a Carrack
    // (9) the alternative is a page of empty rhombuses with the answer buried in it.
    const used = [];
    for (let i = 0; i < grids.length; i++) {
      const mine = boxes.filter((b) => b.gridName === grids[i].name);
      if (!mine.length) continue;
      used.push({ index: i, spec: grids[i], boxes: mine, label: gridLabel(grids[i].name, ship && ship.className) });
    }

    return {
      autoLoad: autoLoad,
      ship: ship,
      grids: used,
      emptyGrids: grids.length - used.length,
      boxes: boxes,
      steps: steps,
      derivedOrder: derived,
      unplaced: (plan && plan.pack && plan.pack.unplaced) || [],
      warnings: warnings,
    };
  }

  /** Box counts, biggest first. The shape a signature is written from. */
  function tally(boxes) {
    const by = new Map();
    for (const b of boxes) by.set(b.scu, (by.get(b.scu) || 0) + 1);
    return [...by.entries()].sort((a, b) => b[0] - a[0]).map((e) => ({ scu: e[0], count: e[1] }));
  }

  /**
   * 🔴 THE BOX SIGNATURE — the whole point of the load order.
   *
   * The elevator lists cargo, not missions, so this string is the only handle the player has on
   * "which one is this". Commodity first because that is the column they read; then the exact
   * split, because two Processed Food hauls are told apart by 10x8+1x1 versus 4x16.
   */
  function signatureOf(step) {
    const what = step.commodities.length ? step.commodities.join(" + ") : "Cargo";
    const split = step.tally.map((t) => t.count + "× " + t.scu + " SCU").join(" + ");
    return split ? what + " — " + split : what;
  }

  /** A leg's drop-off in the same words the route uses, falling back to the plan's own naming. */
  function dropName(plan, leg) {
    const names = (plan && plan.locationNames) || {};
    return leg.destination || names[leg.toLocation] || null;
  }

  /* 🔴 A HOLD IS SOMEWHERE ON THE SHIP, and "cargo large" does not tell you where to walk. Sub,
     loading a C2 with a door at each end: "I would like to have it be called Rear and Front."

     CIG names the position itself on 91 ports across the fleet — front, rear, back, nose, tail,
     mid, centre, left, right — so that is read straight off the port and needs no table. The
     Hercules is not one of them: it says only `hardpoint_cargo_large` / `_small`, which is why the
     hull table below exists.

     ⚠️ The table is DELIBERATELY tiny. Guessing "the big grid is always at the back" would be a
     rule invented from one airframe; a hull is only listed once someone has actually stood in it. */
  var POSITION_WORDS = [
    ["front", "Front"], ["nose", "Front"],
    ["rear", "Rear"], ["back", "Rear"], ["tail", "Rear"],
    ["mid", "Mid"], ["center", "Mid"], ["centre", "Mid"],
  ];
  var SIDE_WORDS = [["left", "Left"], ["right", "Right"]];

  /** Hulls whose ports do not state a position, confirmed by someone who flies them.
   *  Crusader Hercules (Sub, 2026-08-17): "the small one's always in the front, the big one's in
   *  the rear" — and each grid has its own door, which is the whole reason the label matters. */
  var GRID_POSITION_BY_HULL = {
    CRUS_Starlifter_C2: { hardpoint_cargo_large: "Rear", hardpoint_cargo_small: "Front" },
    CRUS_Starlifter_M2: { hardpoint_cargo_large: "Rear", hardpoint_cargo_small: "Front" },
  };

  /** `hardpoint_cargo_large` on a C2 -> `Rear`. Falls back to the readable port name. */
  function gridLabel(name, shipClass) {
    var port = String(name || "");
    var byHull = shipClass && GRID_POSITION_BY_HULL[shipClass];
    if (byHull && byHull[port]) return byHull[port];
    var low = port.toLowerCase();
    var pos = null, side = null;
    for (var i = 0; i < POSITION_WORDS.length; i++) if (low.indexOf(POSITION_WORDS[i][0]) >= 0) { pos = POSITION_WORDS[i][1]; break; }
    for (var j = 0; j < SIDE_WORDS.length; j++) if (low.indexOf(SIDE_WORDS[j][0]) >= 0) { side = SIDE_WORDS[j][1]; break; }
    if (pos && side) return pos + " " + side.toLowerCase();
    if (pos) return pos;
    if (side) return side;
    return port.replace(/^hardpoint_/, "").replace(/_/g, " ");
  }

  // ── the drawing ─────────────────────────────────────────────────────────────

  /**
   * One grid, isometric, drawn in CELL units with the viewBox doing the scaling.
   *
   * Painter's algorithm: boxes further from the viewer are drawn first. The viewer sits along
   * (+x, +y, +z), so `x + y + z` ascending is the depth order — exact for the axis-aligned,
   * non-overlapping, grid-snapped boxes this packer produces.
   *
   * `opts.focus` — a missionId. Its boxes keep full colour, everything else goes ghost, which is
   * how a 25-grid Idris or a 14-grid Caterpillar stays readable: you look at one lift at a time.
   */
  function iso(spec, boxes, opts) {
    opts = opts || {};
    const w = spec.w, l = spec.l, h = spec.h;
    const svg = document.createElementNS(NS, "svg");
    // Padding in cell units, enough for the topmost box's silhouette and a label.
    const pad = 0.6;
    const minX = -l * KX - pad, maxX = w * KX + pad;
    const minY = -h - pad, maxY = (w + l) * KY + pad;
    svg.setAttribute("viewBox", [minX, minY, maxX - minX, maxY - minY].join(" "));
    svg.setAttribute("class", "iso");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    /* 🔑 The viewBox width in CELLS, published so the caller can size several grids against a
       common maximum. Without it every grid stretched to the panel width and a C2's 6x9 cubby was
       drawn with bigger cells than its 8x15 main hold — which reads as the cubby being the larger
       hold, the exact opposite of the truth. */
    svg.dataset.vbw = String(maxX - minX);

    const poly = (pts, cls, fill, extra) => {
      const el = document.createElementNS(NS, "polygon");
      el.setAttribute("points", pts);
      if (cls) el.setAttribute("class", cls);
      if (fill) el.setAttribute("fill", fill);
      if (extra) for (const k in extra) el.setAttribute(k, extra[k]);
      svg.appendChild(el);
      return el;
    };
    const line = (a, b, cls) => {
      const el = document.createElementNS(NS, "line");
      const p = project(a[0], a[1], a[2]), q = project(b[0], b[1], b[2]);
      el.setAttribute("x1", p[0]); el.setAttribute("y1", p[1]);
      el.setAttribute("x2", q[0]); el.setAttribute("y2", q[1]);
      el.setAttribute("class", cls);
      svg.appendChild(el);
      return el;
    };

    /* 🔴 THE CAMERA STANDS AT THE RAMP. `y = 0` is the grid entrance — the packer lays the first
       drop-off's boxes there so they come off first — so y=0 must be the edge NEAREST the viewer.
       The projection puts high y nearest, so the hold is mirrored end-for-end on the way in: a
       box spanning [y, y+dy] is drawn at [l-y-dy, l-y]. Drawn from the other end the picture is a
       mirror of the hold the player is about to walk into, which is worse than no picture — it
       would put the boxes they unload first at the back. */
    /* 🔴 SPIN — walk round to the other end of the hold.
       Sub, mid-load: "the isometric view is just hiding three boxes that I kind of forgot about."
       A fixed camera always has a blind side, and the boxes behind the front row are exactly the
       ones you need to see before you start stacking.
       ⚠️ It cannot be a 2D transform of the finished drawing. Rotating the SCENE 180° about the
       vertical maps to `C - px` horizontally but `C - py - 2z` vertically — the z term means the
       picture is not a rotation of itself. So the COORDINATES turn, and the projection is left
       alone (see the warning on `project`).
       Everything below works in VIEW space: the walls and floor sit at view 0 and stay the far
       side whichever way round we stand, so only the boxes need mapping. */
    const spin = !!opts.spin;
    /** Min corner of a box in view space — the near/far sense of both axes flips together. */
    const vx = (x, dx) => (spin ? w - x - dx : x);
    const vy = (y, dy) => (spin ? y : l - y - dy);
    const flip = (y, d) => vy(y, d || 0);

    // The two FAR walls (the back of the hold, seen from the entrance) plus the floor: an open box
    // seen from the ramp. Without them a stack of boxes floats in nothing and the grid's real size
    // is invisible.
    poly([pt(0, 0, 0), pt(w, 0, 0), pt(w, l, 0), pt(0, l, 0)].join(" "), "iso-floor");
    poly([pt(0, 0, 0), pt(w, 0, 0), pt(w, 0, h), pt(0, 0, h)].join(" "), "iso-wall");
    poly([pt(0, 0, 0), pt(0, l, 0), pt(0, l, h), pt(0, 0, h)].join(" "), "iso-wall iso-wall-b");

    /* 🔴 WHERE THE DOOR IS. Without it the picture is a box of cargo with no orientation, and once
       the view can spin there is nothing at all to tell you which way round you are looking.
       The ramp is raw y=0; in view space that is the NEAR edge normally and the FAR edge when spun,
       which is exactly the information the label carries. */
    (function drawDoor() {
      const dy = spin ? 0 : l;                       // the ramp edge, in view space
      const mid = w / 2;
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "iso-door");
      svg.appendChild(g);
      const bar = document.createElementNS(NS, "polyline");
      bar.setAttribute("points", [pt(0, dy, 0), pt(w, dy, 0)].join(" "));
      bar.setAttribute("class", "iso-door-bar");
      g.appendChild(bar);
      const t = document.createElementNS(NS, "text");
      const p = project(mid, dy, 0);
      // Nudge clear of the floor edge — outward when the door is near, inward when it is behind.
      t.setAttribute("x", p[0]);
      t.setAttribute("y", p[1] + (spin ? -0.35 : 0.95));
      t.setAttribute("class", "iso-door-label");
      t.setAttribute("text-anchor", "middle");
      t.textContent = spin ? "DOOR (behind)" : "DOOR";
      g.appendChild(t);
    })();

    // Cell rules, so the SCU scale is readable off the floor itself.
    for (let x = 1; x < w; x++) line([x, 0, 0], [x, l, 0], "iso-rule");
    for (let y = 1; y < l; y++) line([0, y, 0], [w, y, 0], "iso-rule");
    // Height rules on the far walls: one per 2-cell floor, the hard cap on how tall a box can be.
    for (let z = 2; z <= h; z += 2) {
      line([0, 0, z], [w, 0, z], "iso-rule");
      line([0, 0, z], [0, l, z], "iso-rule");
    }

    /* Painter's algorithm, in MIRRORED space: the viewer is along (+x, +y', +z), so the away-most
       corner is the min corner and ascending `x + y' + z` puts the back of the hold down first.
       Exact for the axis-aligned, non-overlapping, grid-snapped boxes this packer emits. */
    const depthKey = (b) => vx(b.x, b.dx) + vy(b.y, b.dy) + b.z;
    const order = boxes.slice().sort((a, b) =>
      depthKey(a) - depthKey(b) || a.z - b.z || vy(a.y, a.dy) - vy(b.y, b.dy) || vx(a.x, a.dx) - vx(b.x, b.dx));

    for (const b of order) {
      const ghost = !!(opts.focus && b.missionId !== opts.focus);
      const depth = opts.depthOf ? opts.depthOf(b.group) : 0;
      const base = shade(b.missionId, depth);
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "iso-box" + (ghost ? " ghost" : ""));
      g.setAttribute("data-mission", b.missionId || "");
      g.setAttribute("data-group", b.group || "");
      svg.appendChild(g);
      // y0/y1 are in MIRRORED space, so y1 is the box's ramp-facing side.
      const x0 = vx(b.x, b.dx), x1 = x0 + b.dx, z0 = b.z, z1 = b.z + b.dz;
      const y0 = vy(b.y, b.dy), y1 = y0 + b.dy;
      // The two walls that face the ramp — the near wall (falling away to the lower left) and the
      // right-hand wall (x = x1) — then the lit top.
      const faces = [
        [[pt(x0, y1, z0), pt(x1, y1, z0), pt(x1, y1, z1), pt(x0, y1, z1)].join(" "), FACE.left],
        [[pt(x1, y0, z0), pt(x1, y1, z0), pt(x1, y1, z1), pt(x1, y0, z1)].join(" "), FACE.right],
        [[pt(x0, y0, z1), pt(x1, y0, z1), pt(x1, y1, z1), pt(x0, y1, z1)].join(" "), FACE.top],
      ];
      for (const f of faces) {
        const el = document.createElementNS(NS, "polygon");
        el.setAttribute("points", f[0]);
        el.setAttribute("fill", faceFill(base, f[1]));
        el.setAttribute("class", "iso-face");
        g.appendChild(el);
      }
      // The SCU figure, on the top face, only where it will actually fit.
      if (b.dx * b.dy >= 4 && !ghost) {
        const c = project(x0 + b.dx / 2, y0 + b.dy / 2, z1);   // y0 is already mirrored
        const t = document.createElementNS(NS, "text");
        t.setAttribute("x", c[0]); t.setAttribute("y", c[1]);
        t.setAttribute("class", "iso-num");
        t.setAttribute("font-size", Math.min(1.5, Math.min(b.dx, b.dy) * 0.85));
        t.textContent = String(b.scu);
        g.appendChild(t);
      }
      const title = document.createElementNS(NS, "title");
      title.textContent = b.scu + " SCU";
      g.appendChild(title);
    }
    return svg;
  }

  global.StowView = {
    model: model,
    iso: iso,
    shade: shade,
    missionOf: missionOf,
    depthOf: depthOf,
    hashHue: hashHue,
    signatureOf: signatureOf,
    gridLabel: gridLabel,
    tally: tally,
    project: project,
    BOX_DIMS: BOX_DIMS,
  };
})(window);
