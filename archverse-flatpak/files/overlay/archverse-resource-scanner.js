/* ArchVerse Resource Scanner overlay extension.
 * Loaded AFTER mining.html's stock script by tools/archverse-overlay-patches.mjs.
 *
 * Goals:
 *  - Rename the user-facing Mining Scanner to Resource Scanner without renaming the
 *    internal `mining` routes/storage keys (keeps upstream compatibility).
 *  - Recognise the resource classes the current 4.9 P4K data can safely support.
 *  - NEVER call a 2,000-multiple "debris" from signature alone. Salvage voice/UI
 *    requires `scan.salvageConfirmed === true`, a hook reserved for a positive
 *    salvage-specific screen detector.
 */
(() => {
  "use strict";

  const HARVESTABLES = [
    "Amiant", "Amioship Lague", "Armillaria", "Decari", "Degnous", "Flareweed",
    "Fotia", "Golden Medmon", "Heart of the Woods", "Molina Mold", "Pingala",
    "Pitambu", "Prota", "Ranta Dung", "Revenant", "Sunset Berry", "Wuotan",
  ];
  const HAND_GEMS = [
    "Aphorite", "Carinite", "Dolivine", "Hadanite", "Jaclium", "Janalite",
    "Sadaryx", "Saldynium",
  ];
  const HARVEST_SIG = 2000;
  const HAND_GEM_SIG = 3000;

  // User-facing rename. Internal names stay `mining` deliberately so hotkeys, saved
  // widget geometry, IPC, routes and existing config continue to work.
  document.title = "Resource Scanner";
  const title = document.querySelector(".h-title");
  if (title) title.textContent = "Resource Scanner";
  const sub = document.querySelector(".sub");
  if (sub) sub.textContent = "Resource signatures · Mining targets · Refinery timers";
  const scanHead = document.querySelector('.sec-h[data-sec="scan"]');
  if (scanHead) {
    for (const node of [...scanHead.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE && /Signature Scanner/i.test(node.nodeValue || "")) {
        node.nodeValue = "Resource Signatures";
      }
    }
  }
  const every = document.getElementById("segEvery");
  if (every) every.textContent = "Every mineral";
  const genericChk = document.getElementById("debrisChk");
  const genericLabel = genericChk && genericChk.closest("label");
  if (genericLabel) {
    genericLabel.title = "Call out safe generic resource classes such as a hand-mineable gemstone. Signature-only salvage candidates stay silent until salvageable debris is positively confirmed.";
    for (const node of [...genericLabel.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE && /Call out debris/i.test(node.nodeValue || "")) {
        node.nodeValue = " Call out generic resource contacts";
      }
    }
  }

  const style = document.createElement("style");
  style.textContent = `
    .scan-now .av-kind { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:8px;
      border:1px solid var(--divider); color:var(--cyan-bright); font-size:8.5px; font-weight:700;
      letter-spacing:.1em; text-transform:uppercase; vertical-align:2px; }
    .scan-now .av-candidates { line-height:1.45; max-height:42px; overflow:hidden; text-overflow:ellipsis; }
    .scan-now .av-safe { color:var(--green); }
    .scan-now .av-caution { color:var(--amber); }
    .av-place-bar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin:2px 0 7px;
      font-size:10.5px; color:var(--faint); }
    .av-place-name { color:var(--cyan-dim); font-weight:600; }
    .av-place-age { opacity:.7; }
    .av-place-modes { display:inline-flex; gap:3px; margin-left:auto; }
    .av-place-modes button { border:1px solid var(--divider); background:rgba(var(--accent-rgb),.05);
      color:var(--faint); border-radius:7px; font-size:9px; padding:2px 6px; cursor:pointer; }
    .av-place-modes button.on { color:var(--cyan-bright); border-color:var(--border); background:rgba(var(--accent-rgb),.14); }
  `;
  document.head.appendChild(style);

  // Upstream game.log terrain context is a HINT only. ArchVerse deliberately does not
  // promote a space hint into salvage confirmation: `salvageConfirmed` remains the only gate.
  const scanNow = document.getElementById("scanNow");
  // Current upstream has its own Location strip and Auto/Planet/Space controls. Let that UI own
  // location whenever it exists; older ArchVerse bases still get the fallback strip below.
  const upstreamPlaceBar = document.getElementById("placeBar");
  if (!upstreamPlaceBar && scanNow && !document.getElementById("avPlaceBar")) {
    const bar = document.createElement("div");
    bar.id = "avPlaceBar"; bar.className = "av-place-bar";
    scanNow.parentNode.insertBefore(bar, scanNow);
  }
  const PLACE_MODES = [["auto","Auto"],["planet","Planet"],["space","Space"]];
  function effectivePlaceKind() {
    const mode = view && view.placeMode || "auto";
    if (mode === "planet" || mode === "space") return mode;
    return view && view.place && view.place.kind || "unknown";
  }
  function renderPlace() {
    if (upstreamPlaceBar) return;
    const el = document.getElementById("avPlaceBar"); if (!el) return;
    const p = view && view.place || { kind:"unknown" };
    const mode = view && view.placeMode || "auto";
    let label = "Location unknown";
    if (mode === "planet") label = "Planet-side";
    else if (mode === "space") label = "In space";
    else if (p.kind === "planet") label = p.name && p.name !== "(set by you)" ? p.name : "Planet-side";
    else if (p.kind === "space") label = "In space";
    let age = "";
    if (mode === "auto" && view && view.placeAgeMs != null) {
      const m = Math.max(0, Math.floor(Number(view.placeAgeMs) / 60000));
      age = '<span class="av-place-age">' + (m < 1 ? "just now" : m + "m ago") + '</span>';
    } else if (mode !== "auto") age = '<span class="av-place-age">set by you</span>';
    el.innerHTML = '<span class="av-place-name">' + escapeHtml(label) + '</span>' + age +
      '<span class="av-place-modes">' + PLACE_MODES.map(([k,n]) =>
        '<button type="button" class="' + (mode === k ? "on" : "") + '" data-av-place="' + k + '">' + n + '</button>').join("") + '</span>';
  }
  document.addEventListener("click", (ev) => {
    const b = ev.target && ev.target.closest && ev.target.closest("button[data-av-place]");
    if (!b) return;
    fetch("/api/mining/place-mode", { method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({mode:b.dataset.avPlace}) }).catch(() => {});
  });

  function classifyResource(sc) {
    const sig = Number(sc && sc.signature);
    const matches = Array.isArray(sc && sc.matches) ? sc.matches : [];
    // Positive evidence always beats the numeric signature. This property is NOT
    // produced by the old scanner yet; until a salvage-specific detector sets it,
    // debris is intentionally never announced as salvageable.
    if (sc && sc.salvageConfirmed === true) return "salvage";
    if (matches.some((m) => String(m && m.name).toLowerCase() === "hand-mined gem")) return "gem";
    if (matches.length) return "mineral";
    if (sig === HAND_GEM_SIG) return "gem";
    if (sig === HARVEST_SIG) return "harvestable-or-salvage";
    if (Number.isFinite(sig) && sig >= HARVEST_SIG && sig % 2000 === 0) return "salvage-candidate";
    return "unknown";
  }

  function listLine(label, values) {
    const full = values.join(" · ");
    return '<div class="sig av-candidates" title="' + escapeHtml(full) + '">' +
      escapeHtml(label) + ": " + escapeHtml(full) + "</div>";
  }

  // Replace stock scan rendering. Known minerals keep the existing target/rarity UI,
  // but a signature that merely fits the 2,000-panel pattern is presented as a
  // CANDIDATE, never as confirmed debris.
  renderScan = function archverseRenderResourceScan() {
    renderPlace();
    const el = $("scanNow");
    const sc = view.scan;
    $("scanBadge").textContent = sc ? Number(sc.signature).toLocaleString() : "";
    if (!sc) {
      el.className = "scan-now empty";
      el.textContent = "Scan a resource contact — I'll identify what the signature can prove.";
      return;
    }
    el.className = "scan-now";
    const m = Array.isArray(sc.matches) ? sc.matches : [];
    const sig = '<div class="sig">signature ' + Number(sc.signature).toLocaleString() + '</div>';
    const kind = classifyResource(sc);

    if (kind === "gem") {
      el.innerHTML = '<div class="rock">Hand-mineable Gem<span class="av-kind">GEM</span></div>' +
        '<div class="meta">RS 3,000 identifies the gem class; the individual gem is not unique from RS alone.</div>' +
        sig + listLine("Possible", HAND_GEMS);
      return;
    }
    if (kind === "harvestable-or-salvage") {
      el.innerHTML = '<div class="rock av-caution">Resource Contact<span class="av-kind">SHARED 2,000</span></div>' +
        '<div class="meta">' + (effectivePlaceKind() === "planet" ? "Planet-side hint: harvestable is more likely; salvage remains unconfirmed." : effectivePlaceKind() === "space" ? "Space hint: debris panel is more likely; salvageability remains UNCONFIRMED." : "Could be a harvestable or a debris panel; salvageability is UNCONFIRMED.") + '</div>' +
        sig + listLine("Known harvestables sharing this class", HARVESTABLES);
      return;
    }
    if (kind === "salvage") {
      el.innerHTML = '<div class="rock av-safe">Salvageable Debris<span class="av-kind">SALVAGE</span></div>' +
        '<div class="meta">Positive salvage confirmation — safe to call out.</div>' + sig;
      return;
    }
    if (kind === "salvage-candidate") {
      el.innerHTML = '<div class="rock av-caution">Salvage Candidate<span class="av-kind">UNCONFIRMED</span></div>' +
        '<div class="meta">' + (effectivePlaceKind() === "planet" ? "Planet-side hint makes harvestables more likely. This RS multiple does NOT prove salvage." : effectivePlaceKind() === "space" ? "Space hint makes debris panels more likely, but it still does NOT prove the debris is salvageable." : "The RS value fits a debris-panel multiple, but that does NOT prove the debris is salvageable.") + '</div>' + sig;
      return;
    }
    if (kind === "unknown") {
      el.innerHTML = '<div class="rock" style="color:var(--cyan-dim)">Unknown Resource Contact</div>' +
        '<div class="meta">No safe match in the resource table — not announced.</div>' + sig;
      return;
    }

    // Known mineral: preserve upstream target selection and ambiguity display, but
    // intentionally remove the old "or debris" badge. A multiple-of-2,000 collision
    // is not enough evidence to call salvage.
    const isTarget = m.some((x) => targetSet.has(x.name));
    const main = m.find((x) => targetSet.has(x.name)) || m[0];
    const rest = m.filter((x) => x !== main);
    const family = Array.isArray(main.contains) && main.contains.length ? listLine("Could contain", main.contains) : "";
    const kindLabel = main.rarity === "Asteroid" ? "ASTEROID" : "MINERAL";
    el.innerHTML = '<div class="rock">' + escapeHtml(main.name) + '<span class="av-kind">' + kindLabel + '</span>' + rarPill(main.rarity) + '</div>' +
      '<div class="meta">' + main.count + (main.count > 1 ? " contacts" : " contact") + ' in cluster' +
      (rest.length ? ' · or ' + rest.map((x) => escapeHtml(x.name) + " ×" + x.count).join(", ") : "") + '</div>' +
      '<div class="sig">signature ' + Number(sc.signature).toLocaleString() + (isTarget ? ' · TARGET' : '') + '</div>' + family;
  };

  // Replace stock voice/flash logic. The critical guarantee is here: no path says
  // "Debris" or "Salvageable debris" unless salvageConfirmed is explicitly true.
  onNewScan = function archverseOnNewResourceScan(sc) {
    const kind = classifyResource(sc);
    const matches = Array.isArray(sc.matches) ? sc.matches : [];
    const isTarget = matches.some((m) => targetSet.has(m.name));
    const real = matches.length > 0 || sc.confirmed === true;

    if (hiddenMode) {
      if (real && kind !== "unknown") maybeAutoShow();
      return;
    }

    const el = $("scanNow");
    const flash = () => { el.classList.remove("hit"); void el.offsetWidth; el.classList.add("hit"); };

    if (kind === "unknown") return;
    if (kind === "harvestable-or-salvage" || kind === "salvage-candidate") {
      // Useful enough to surface in a Resource Scanner, but deliberately silent:
      // the signature does not identify the object strongly enough for a voice call.
      maybeAutoShow();
      flash();
      return;
    }
    if (kind === "gem") {
      maybeAutoShow();
      flash();
      if (debrisOn()) speak("Hand-mineable gemstone");
      return;
    }
    if (kind === "salvage") {
      maybeAutoShow();
      flash();
      if (debrisOn()) speak("Salvageable debris");
      return;
    }

    // Known mineral: retain target/every-mineral behaviour from upstream.
    maybeAutoShow();
    if (isTarget) { flash(); chime(); }
    const name = (matches.find((m) => targetSet.has(m.name)) || matches[0]).name;
    const mode = localStorage.getItem("miningSpeakMode") || "target";
    if (mode === "every" || isTarget) {
      speakClips(["c_thatlookslike", nameSlug(name)], "That looks like " + name);
    }
  };

  // Positive-confirmation bridge for the next detector step. A future screen reader
  // should call this ONLY after seeing a salvage-specific HUD/object cue. Keeping the
  // gate explicit prevents the numeric signature heuristic from ever sneaking back in.
  window.__archverseConfirmSalvage = (signature) => {
    if (!view || !view.scan || Number(view.scan.signature) !== Number(signature)) return false;
    view.scan.salvageConfirmed = true;
    renderScan();
    onNewScan(view.scan);
    return true;
  };

  // Re-render the latest state if it arrived before this extension loaded.
  try { renderScan(); } catch { /* state not ready yet */ }
})();
