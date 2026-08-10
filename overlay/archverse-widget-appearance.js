/* ArchVerse per-widget appearance controls.
 * Loaded AFTER missions.html's stock script by tools/archverse-overlay-patches.mjs.
 *
 * Adds two independent sliders to every widget:
 *   Text brightness      25% .. 200% (default 100%)
 *   Window transparency  0% .. 100% (default 0% = stock appearance)
 *
 * The controls intentionally alter THEME TOKENS rather than iframe opacity. That is
 * what lets the panel glass disappear while text stays bright and readable.
 */
(() => {
  "use strict";

  if (typeof WIDGETS === "undefined" || !Array.isArray(WIDGETS)) return;

  const STORE_KEY = "archverseWidgetAppearanceV1";
  const BRIGHT_MIN = 25;
  const BRIGHT_MAX = 200;
  const TRANS_MIN = 0;
  const TRANS_MAX = 100;
  const TEXT_TOKENS = [
    "--cyan", "--cyan-bright", "--cyan-text", "--cyan-dim", "--faint",
    "--gold", "--amber", "--green", "--red", "--title",
    "--leg", "--epic", "--rare", "--unc", "--common",
  ];
  const BACKGROUND_TOKENS = ["--panel-top", "--panel-bot", "--panel-solid", "--scan", "--sheen"];

  let saved = {};
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch { saved = {}; }

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n)));
  function pref(w) {
    const p = saved[w.key] || {};
    return {
      brightness: clamp(Number.isFinite(+p.brightness) ? +p.brightness : 100, BRIGHT_MIN, BRIGHT_MAX),
      transparency: clamp(Number.isFinite(+p.transparency) ? +p.transparency : 0, TRANS_MIN, TRANS_MAX),
    };
  }
  function store(w, next) {
    saved[w.key] = { ...pref(w), ...next };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ }
    return saved[w.key];
  }

  function parseColor(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    let m = s.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
    m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgba = (c) => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.max(0, Math.min(1, c.a)).toFixed(4)})`;
  function brighten(c, pct) {
    const f = pct / 100;
    if (f <= 1) return { ...c, r: c.r * f, g: c.g * f, b: c.b * f };
    const k = Math.min(1, f - 1);
    return { ...c, r: c.r + (255 - c.r) * k, g: c.g + (255 - c.g) * k, b: c.b + (255 - c.b) * k };
  }

  function appearanceTarget(w) {
    if (w.local) return { doc: document, target: wEl(w) };
    try {
      const doc = frameEl(w)?.contentDocument;
      if (!doc || !doc.documentElement || doc.location.href === "about:blank") return null;
      return { doc, target: doc.documentElement };
    } catch { return null; }
  }

  function applyAppearance(w) {
    const ctx = appearanceTarget(w); if (!ctx || !ctx.target) return;
    const { doc, target } = ctx;
    const p = pref(w);
    const tokens = [...TEXT_TOKENS, ...BACKGROUND_TOKENS];

    // Remove only our token overrides before reading the active manufacturer theme.
    // Otherwise a Drake -> Anvil switch would brighten yesterday's Drake orange forever.
    for (const name of tokens) target.style.removeProperty(name);
    const cs = doc.defaultView.getComputedStyle(target);
    const base = new Map(tokens.map((name) => [name, cs.getPropertyValue(name).trim()]));

    for (const name of TEXT_TOKENS) {
      const c = parseColor(base.get(name));
      if (c) target.style.setProperty(name, rgba(brighten(c, p.brightness)));
    }
    const keep = 1 - p.transparency / 100;
    for (const name of BACKGROUND_TOKENS) {
      const c = parseColor(base.get(name));
      if (c) target.style.setProperty(name, rgba({ ...c, a: c.a * keep }));
    }

    target.style.setProperty("--archverse-text-brightness", String(p.brightness / 100));
    target.style.setProperty("--archverse-window-transparency", String(p.transparency / 100));
    updateReadouts(w);
  }

  function rowMarkup(kind, label, min, max, value, title) {
    return '<div class="av-appearance-row av-' + kind + '" style="display:flex;align-items:center;gap:7px;padding:6px 12px" title="' + title + '">' +
      '<span style="flex:1;font-size:11px;letter-spacing:.04em;opacity:.88">' + label + '</span>' +
      '<input type="range" class="av-range" min="' + min + '" max="' + max + '" step="1" value="' + value + '" style="width:92px;height:4px;cursor:pointer;accent-color:var(--gold,#FFD27A)" />' +
      '<b class="av-value" style="min-width:38px;text-align:right;font-size:10px;opacity:.8"></b>' +
      '</div>';
  }

  function wireRow(w, row, key) {
    if (!row || row.dataset.avWired === "1") return;
    row.dataset.avWired = "1";
    const input = row.querySelector(".av-range");
    if (!input) return;
    input.addEventListener("input", (e) => {
      e.stopPropagation();
      store(w, { [key]: +input.value });
      applyAppearance(w);
    });
    input.addEventListener("change", (e) => { e.stopPropagation(); });
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  function addRows(w, root, ownMenu) {
    if (!root || root.querySelector(`.av-appearance[data-av-widget="${w.key}"]`)) return;
    const doc = root.ownerDocument;
    const wrap = doc.createElement("div");
    wrap.className = "av-appearance";
    wrap.dataset.avWidget = w.key;
    const p = pref(w);
    wrap.innerHTML = (ownMenu ? '<div style="padding:8px 12px 3px;font-size:8.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--cyan-dim,#7fa7bb)">Appearance</div>' : "") +
      rowMarkup("brightness", "Text brightness", BRIGHT_MIN, BRIGHT_MAX, p.brightness,
        "Brightens or dims text/chrome without changing the window background.") +
      rowMarkup("transparency", "Window transparency", TRANS_MIN, TRANS_MAX, p.transparency,
        "Fades the widget glass/background only. Text brightness remains independent.");
    root.appendChild(wrap);
    wireRow(w, wrap.querySelector(".av-brightness"), "brightness");
    wireRow(w, wrap.querySelector(".av-transparency"), "transparency");
    updateReadouts(w);
  }

  function injectWrapperRows(w) {
    const root = wEl(w)?.querySelector(".wcfg");
    if (root) addRows(w, root, false);
  }
  function injectOwnRows(w) {
    let root = null;
    try { root = wSettingsRoot(w); } catch { root = null; }
    if (root) addRows(w, root, true);
  }
  function updateReadouts(w) {
    const p = pref(w);
    const roots = [];
    const el = wEl(w);
    if (el) roots.push(el);
    try { const own = wSettingsRoot(w); if (own && !roots.includes(own)) roots.push(own); } catch { /* iframe */ }
    for (const root of roots) {
      root.querySelectorAll(`.av-appearance[data-av-widget="${w.key}"]`).forEach((box) => {
        const br = box.querySelector(".av-brightness"), tr = box.querySelector(".av-transparency");
        if (br) { br.querySelector(".av-range").value = p.brightness; br.querySelector(".av-value").textContent = Math.round(p.brightness) + "%"; }
        if (tr) { tr.querySelector(".av-range").value = p.transparency; tr.querySelector(".av-value").textContent = Math.round(p.transparency) + "%"; }
      });
    }
  }

  const observedDocs = new WeakSet();
  function observeTheme(w) {
    const ctx = appearanceTarget(w); if (!ctx) return;
    const root = ctx.doc.documentElement;
    if (observedDocs.has(root)) return;
    observedDocs.add(root);
    new MutationObserver((records) => {
      if (records.some((r) => r.attributeName === "data-theme")) setTimeout(() => applyAppearance(w), 0);
    }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  }

  function syncWidget(w) {
    injectWrapperRows(w);
    injectOwnRows(w);
    applyAppearance(w);
    observeTheme(w);
  }

  // The Blueprint panel is local; every other entry owns a stable iframe element even
  // when its src is unloaded. Attach once so a close/reopen immediately restores prefs.
  for (const w of WIDGETS) {
    injectWrapperRows(w);
    if (!w.local) {
      const frame = frameEl(w);
      frame?.addEventListener("load", () => setTimeout(() => syncWidget(w), 0));
    }
    syncWidget(w);
  }

  // Own settings menus can be defined slightly after an iframe's load/ready callback.
  // A low-frequency idempotent probe keeps controls present across unload/re-arm cycles.
  setInterval(() => {
    for (const w of WIDGETS) {
      if (w.local || w.armed) {
        injectOwnRows(w);
        observeTheme(w);
      }
    }
  }, 1200);

  // Parent theme changes affect the local Blueprint panel; embedded pages receive the
  // theme through the existing syncWidgetTheme() path and their own observers above.
  new MutationObserver(() => setTimeout(() => {
    const bp = typeof WBY !== "undefined" ? WBY.blueprint : null;
    if (bp) applyAppearance(bp);
  }, 0)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
