/* ArchVerse per-widget appearance compatibility layer — Alpha 22.
 *
 * Upstream now owns independent Fade panel / Fade text / Full on hover controls. ArchVerse keeps
 * the one control upstream still does not have: text/chrome brightness (25%..200%). Any saved
 * Alpha-20/21 Window transparency value is migrated once into upstream's panel fade, then the old
 * transparency control disappears so two independent systems never fight over panel alpha.
 */
(() => {
  "use strict";
  if (typeof WIDGETS === "undefined" || !Array.isArray(WIDGETS)) return;

  const STORE_KEY = "archverseWidgetAppearanceV1";
  const MIGRATE_KEY = "archverseWidgetAppearanceFadeMigratedV1";
  const BRIGHT_MIN = 25, BRIGHT_MAX = 200;
  const TEXT_TOKENS = [
    "--cyan", "--cyan-bright", "--cyan-text", "--cyan-dim", "--faint",
    "--gold", "--amber", "--green", "--red", "--title",
    "--leg", "--epic", "--rare", "--unc", "--common",
  ];

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch { saved = {}; }
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n)));
  const pref = (w) => {
    const p = saved[w.key] || {};
    return { brightness: clamp(Number.isFinite(+p.brightness) ? +p.brightness : 100, BRIGHT_MIN, BRIGHT_MAX),
             transparency: clamp(Number.isFinite(+p.transparency) ? +p.transparency : 0, 0, 100) };
  };
  function store(w, next) {
    saved[w.key] = { ...pref(w), ...next };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch {}
  }

  function parseColor(raw) {
    const v = String(raw || "").trim(); if (!v) return null;
    let m = v.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
    if (m) return { r:+m[1], g:+m[2], b:+m[3], a:m[4] == null ? 1 : +m[4] };
    m = v.match(/^#([0-9a-f]{3,8})$/i); if (!m) return null;
    let h=m[1]; if (h.length===3 || h.length===4) h=h.split("").map(c=>c+c).join("");
    if (h.length!==6 && h.length!==8) return null;
    return { r:parseInt(h.slice(0,2),16), g:parseInt(h.slice(2,4),16), b:parseInt(h.slice(4,6),16),
             a:h.length===8 ? parseInt(h.slice(6,8),16)/255 : 1 };
  }
  const rgba=(c)=>`rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${clamp(c.a,0,1).toFixed(4)})`;
  function brighten(c,pct) {
    const f=pct/100;
    if (f<=1) return {...c,r:c.r*f,g:c.g*f,b:c.b*f};
    const k=Math.min(1,f-1);
    return {...c,r:c.r+(255-c.r)*k,g:c.g+(255-c.g)*k,b:c.b+(255-c.b)*k};
  }
  function appearanceTarget(w) {
    if (w.local) return { doc:document, target:wEl(w) };
    try {
      const doc=frameEl(w)?.contentDocument;
      if (!doc?.documentElement || doc.location.href === "about:blank") return null;
      return { doc, target:doc.documentElement };
    } catch { return null; }
  }
  function applyBrightness(w) {
    const ctx=appearanceTarget(w); if (!ctx?.target) return;
    const {doc,target}=ctx, p=pref(w);
    for (const name of TEXT_TOKENS) target.style.removeProperty(name);
    if (p.brightness !== 100) {
      const cs=doc.defaultView.getComputedStyle(target);
      for (const name of TEXT_TOKENS) {
        const c=parseColor(cs.getPropertyValue(name)); if (c) target.style.setProperty(name,rgba(brighten(c,p.brightness)));
      }
    }
    target.style.setProperty("--archverse-text-brightness",String(p.brightness/100));
    updateReadouts(w);
  }

  function migrateLegacyTransparency(w) {
    let done={}; try { done=JSON.parse(localStorage.getItem(MIGRATE_KEY)||"{}")||{}; } catch {}
    if (done[w.key]) return;
    const old=pref(w).transparency;
    // Only seed upstream panel fade if the player actually changed the old setting and upstream
    // does not already carry an explicit panel fade. Upstream clamps fade to 20% minimum.
    if (old > 0 && typeof w.s?.dim !== "number") {
      w.s.dim=clamp(1-old/100,0.2,1);
      try { if (typeof persistW === "function") persistW(w); } catch {}
      try { if (typeof applyFade === "function") applyFade(w); else if (typeof applyDim === "function") applyDim(w); } catch {}
    }
    done[w.key]=true;
    try { localStorage.setItem(MIGRATE_KEY,JSON.stringify(done)); } catch {}
  }

  function addRow(w,root,ownMenu) {
    if (!root || root.querySelector(`.av-brightness-only[data-av-widget="${w.key}"]`)) return;
    const box=root.ownerDocument.createElement("div");
    box.className="av-brightness-only"; box.dataset.avWidget=w.key;
    const p=pref(w);
    box.innerHTML=(ownMenu?'<div style="padding:8px 12px 3px;font-size:8.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--cyan-dim,#7fa7bb)">ArchVerse</div>':'')+
      '<div class="av-brightness-row" style="display:flex;align-items:center;gap:7px;padding:6px 12px" title="Brightens or dims text/chrome without changing the panel fade">'+
      '<span style="flex:1;font-size:11px;letter-spacing:.04em;opacity:.88">Text brightness</span>'+
      `<input type="range" class="av-range" min="${BRIGHT_MIN}" max="${BRIGHT_MAX}" step="1" value="${p.brightness}" style="width:92px;height:4px;cursor:pointer;accent-color:var(--gold,#FFD27A)" />`+
      '<b class="av-value" style="min-width:38px;text-align:right;font-size:10px;opacity:.8"></b></div>';
    root.appendChild(box);
    const input=box.querySelector(".av-range");
    input?.addEventListener("input",(e)=>{ e.stopPropagation(); store(w,{brightness:+input.value}); applyBrightness(w); });
    input?.addEventListener("change",(e)=>e.stopPropagation()); input?.addEventListener("click",(e)=>e.stopPropagation());
    updateReadouts(w);
  }
  function updateReadouts(w) {
    const p=pref(w), roots=[]; const el=wEl(w); if (el) roots.push(el);
    try { const own=wSettingsRoot(w); if (own && !roots.includes(own)) roots.push(own); } catch {}
    for (const root of roots) root.querySelectorAll(`.av-brightness-only[data-av-widget="${w.key}"]`).forEach((box)=>{
      const input=box.querySelector(".av-range"), out=box.querySelector(".av-value");
      if (input) input.value=String(p.brightness); if (out) out.textContent=Math.round(p.brightness)+"%";
    });
  }
  function sync(w) {
    migrateLegacyTransparency(w);
    addRow(w,wEl(w)?.querySelector(".wcfg"),false);
    let own=null; try { own=wSettingsRoot(w); } catch {}
    if (own) addRow(w,own,true);
    applyBrightness(w);
  }
  const observed=new WeakSet();
  function observeTheme(w) {
    const ctx=appearanceTarget(w); if (!ctx) return;
    const root=ctx.doc.documentElement; if (observed.has(root)) return; observed.add(root);
    new MutationObserver((rs)=>{ if (rs.some(r=>r.attributeName==="data-theme")) setTimeout(()=>applyBrightness(w),0); })
      .observe(root,{attributes:true,attributeFilter:["data-theme"]});
  }
  for (const w of WIDGETS) {
    if (!w.local) frameEl(w)?.addEventListener("load",()=>setTimeout(()=>{sync(w);observeTheme(w);},0));
    sync(w); observeTheme(w);
  }
  setInterval(()=>{ for (const w of WIDGETS) if (w.local || w.armed) { sync(w); observeTheme(w); } },1200);
})();
