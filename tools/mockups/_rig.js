/**
 * SHARED SCAFFOLD FOR THE THREE COMMODITIES-TAB MOCKUPS.
 *
 * 🔴 THIS IS A MOCKUP RIG, NOT PRODUCT CODE. Nothing here is wired to the sidecar and nothing
 * here should be copied into `overlay/` as-is. It exists so three designs can be judged against
 * the SAME real data, in the REAL widget chrome, at the REAL widget size.
 *
 * What is genuine:
 *   - every figure comes from `_mock-data.js`, captured live from /api/trade/{status,routes,commodity}
 *   - the CSS is `overlay/widget-theme.css` + `overlay/skins.css` + a verbatim copy of the
 *     `<style>` block out of `overlay/hauling.html` (`_hauling-style.css`)
 *   - the helpers below (num/tdMoney/tdAge/tdPct/tdPair/tdQty/tdChip/tdSpineRow) are lifted from
 *     `overlay/hauling-tab-trade.js` so a mocked row renders exactly like a shipped one
 *
 * Every proposed addition is marked with a comment beginning NEW, so the difference between "what
 * exists today" and "what is being proposed" can be read off the file rather than guessed at.
 */

/* ── lifted verbatim from the shipping widget ─────────────────────────────── */

const num = (n) => Number(n || 0).toLocaleString();

function tdMoney(n) {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (Math.abs(v) >= 10_000) return Math.round(v / 1000) + "k";
  return v.toLocaleString();
}

function tdAge(days) {
  if (days === null || days === undefined) return null;
  if (days >= 1) return Math.round(days) + "d";
  const h = Math.round(days * 24);
  return h >= 1 ? h + "h" : "just now";
}

function tdAgeClass(days) {
  if (days === null || days === undefined) return "warn";
  return days < 2 ? "age0" : days < 7 ? "age1" : "age2";
}

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

function tdPair(parent, buy, sell) {
  const s = document.createElement("span");
  s.className = "pair";
  const b = document.createElement("span"); b.className = "buy"; b.textContent = num(buy);
  const a = document.createElement("span"); a.className = "arrow"; a.textContent = "→";
  const v = document.createElement("span"); v.className = "sell"; v.textContent = num(sell);
  s.append(b, a, v);
  parent.appendChild(s);
  return s;
}

function tdQty(parent, value, unit) {
  const s = document.createElement("span");
  s.className = "q";
  s.appendChild(document.createTextNode(String(value)));
  if (unit) { const u = document.createElement("u"); u.textContent = " " + unit; s.appendChild(u); }
  parent.appendChild(s);
  return s;
}

function tdMdot(parent) {
  const s = document.createElement("span");
  s.className = "mdot";
  s.textContent = "·";
  parent.appendChild(s);
  return s;
}

function tdBtn(parent, label, on, title, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "hbtn" + (on ? " on" : "") + (cls ? " " + cls : "");
  b.textContent = label;
  if (title) b.title = title;
  parent.appendChild(b);
  return b;
}

/**
 * The shipped row shape, plus ONE new option.
 *
 * `spec.rail` is the only addition: when true the profit figure and the "+ Route" control move out
 * of the text block into a right-hand column, which is Sub's ask —
 *   "if it was right-justified in its own kind of column, or the same column as the price".
 * Options B and C use it; option A leaves the row alone and only right-justifies the button.
 */
function tdSpineRow(spec) {
  const row = document.createElement("div");
  row.className = "arow tdrow" + (spec.rail ? " railed" : "");   /* NEW: .railed */
  if (spec.rank !== undefined && spec.rank !== null) {
    const nEl = document.createElement("div");
    nEl.className = "n";
    nEl.textContent = String(spec.rank);
    row.appendChild(nEl);
  }
  const mid = document.createElement("div"); mid.className = "mid";

  const l1 = document.createElement("div"); l1.className = "l1";
  const t = document.createElement("div"); t.className = "t"; t.textContent = spec.title;
  l1.appendChild(t);

  const p = document.createElement("span");
  p.className = "p" + (spec.profitClass ? " " + spec.profitClass : "");
  p.textContent = spec.profit;
  const pk = document.createElement("span"); pk.className = "pk";
  pk.textContent = spec.profitLabel;

  if (!spec.rail) l1.append(p, pk);
  mid.appendChild(l1);

  const l2 = document.createElement("div"); l2.className = "l2";
  const rt = document.createElement("span"); rt.className = "r"; rt.textContent = spec.route;
  l2.appendChild(rt);
  if (spec.rate) {
    const hr = document.createElement("span"); hr.className = "hr"; hr.textContent = spec.rate;
    l2.appendChild(hr);
  }
  mid.appendChild(l2);

  const l3 = document.createElement("div"); l3.className = "l3";
  tdPair(l3, spec.buy, spec.sell);
  l3.appendChild(tdPct(spec.marginPct));
  for (const m of spec.metrics || []) { tdMdot(l3); tdQty(l3, m[0], m[1]); }
  mid.appendChild(l3);

  const chips = document.createElement("div"); chips.className = "m tdchips";
  mid.appendChild(chips);
  row.appendChild(mid);

  /* NEW: the right rail. Last child of the row, so its right edge comes from the row's own
     padding — an auto-width right-aligned column is free at the end of a row and needs no spacer.
     (The Verse Finder's `.pricecol` learned that the expensive way.) */
  let rail = null;
  if (spec.rail) {
    rail = document.createElement("div");
    rail.className = "rail";
    const rp = document.createElement("div"); rp.className = "rp";
    rp.appendChild(p);
    const rk = document.createElement("div"); rk.className = "rk"; rk.textContent = spec.profitLabel;
    rail.append(rp, rk);
    row.appendChild(rail);
  }
  return { row, chips, rail, title: t, profit: p, strip: l3 };
}

/* ── rig-only helpers ─────────────────────────────────────────────────────── */

/** The widget head, verbatim in shape from hauling.html. `active` is which tab is lit. */
function rigHead(panel, active) {
  const head = document.createElement("div");
  head.className = "head";
  const dia = document.createElement("span"); dia.className = "dia";
  const hname = document.createElement("span"); hname.className = "hname";
  const title = document.createElement("span"); title.className = "h-title"; title.textContent = "Hauling";
  const badge = document.createElement("span"); badge.className = "expbadge"; badge.textContent = "EXPERIMENTAL";
  hname.append(title, badge);
  const tabs = document.createElement("span"); tabs.className = "tabs";
  for (const t of ["Contracts", "Commodities", "Route", "Stow", "Ledger"]) {
    tdBtn(tabs, t, t === active, null);
  }
  head.append(dia, hname, tabs);
  panel.appendChild(head);
  return head;
}

/** Ship + start rows, so the mockup is honest about how much height is left for the tab body. */
function rigSummary(panel) {
  const s = document.createElement("div");
  s.className = "summary";
  const r1 = document.createElement("div"); r1.className = "shiprow";
  /* The ids are load-bearing: `#shipPick, #startPick` is how hauling.html styles these, and a
     select without one renders as a bare white box. That exact bug is recorded in the CSS. */
  const sel = document.createElement("select"); sel.id = "shipPick";
  sel.appendChild(new Option("MISC Freelancer MAX", "1"));
  const src = document.createElement("span"); src.className = "src"; src.textContent = "from the log";
  r1.append(sel, src);
  const r2 = document.createElement("div"); r2.className = "shiprow";
  const sel2 = document.createElement("select"); sel2.id = "startPick";
  sel2.appendChild(new Option("Ruin Station", "1"));
  const sync = document.createElement("button"); sync.className = "hbtn"; sync.id = "syncLoc"; sync.textContent = "Sync";
  const why = document.createElement("span"); why.className = "whyinfo"; why.textContent = "ⓘ";
  r2.append(sel2, sync, why);
  s.append(r1, r2);
  panel.appendChild(s);
  return s;
}

/** The provenance pill, verbatim in shape. */
function rigProvenance(bar) {
  const pill = document.createElement("span");
  pill.className = "tdsrc live";
  const dot = document.createElement("span"); dot.className = "dot";
  const txt = document.createElement("span"); txt.textContent = "live";
  pill.append(dot, txt);
  bar.appendChild(pill);
  const info = document.createElement("button");
  info.type = "button"; info.className = "tdi"; info.textContent = "i";
  bar.appendChild(info);
  return pill;
}

function rigSep(bar) {
  const s = document.createElement("span"); s.className = "sep"; bar.appendChild(s); return s;
}

function rigLbl(bar, text) {
  const s = document.createElement("span"); s.className = "lbl"; s.textContent = text;
  bar.appendChild(s); return s;
}

/** The section header the routes list already draws. */
function rigSec(body, left, right, cls) {
  const sec = document.createElement("div");
  sec.className = "sec" + (cls ? " " + cls : "");
  const h = document.createElement("span"); h.textContent = left;
  sec.appendChild(h);
  if (right) { const n = document.createElement("span"); n.className = "n"; n.textContent = right; sec.appendChild(n); }
  body.appendChild(sec);
  return sec;
}

/** The UEX credit strip, which must be present wherever UEX quotes are on screen. */
function rigCredit(panel) {
  const bar = document.createElement("div");
  bar.className = "creditbar";
  const b = document.createElement("button");
  b.className = "uexbadge"; b.type = "button";
  const img = document.createElement("img");
  img.id = "uexmark";   /* `.uexbadge #uexmark { height: 17px }` — without the id it draws full size */
  img.src = "../../overlay/logos/uex-powered.png";
  img.alt = "Powered by UEX";
  img.onerror = () => img.replaceWith(Object.assign(document.createElement("span"), { id: "uexname", textContent: "Powered by UEX" }));
  b.appendChild(img);
  bar.appendChild(b);
  panel.appendChild(bar);
  return bar;
}

/* ── data shaping (all from the real payloads) ────────────────────────────── */

/** Days since a UEX `asOf` (seconds), against the moment the fixture was captured. */
const CAPTURED_AT = 1787621798518;
function ageOf(asOf) { return asOf ? Math.max(0, (CAPTURED_AT - asOf * 1000) / 86_400_000) : null; }

/** Every buy × sell pairing of one commodity, priced against a hold. Same arithmetic the finder
 *  uses (`marginPerScu`, hold/stock/demand bound), so the numbers agree with the ranked board. */
function pairingsFor(look, capacityScu) {
  const out = [];
  for (const b of look.buyAt) {
    for (const s of look.sellAt) {
      const margin = s.price - b.price;
      if (margin <= 0) continue;
      let moveScu = capacityScu, bound = "hold";
      if (b.scu !== null && b.scu !== undefined && b.scu < moveScu) { moveScu = b.scu; bound = "stock"; }
      if (s.scu !== null && s.scu !== undefined && s.scu < moveScu) { moveScu = s.scu; bound = "demand"; }
      if (b.scu === null || b.scu === undefined) bound = "unknown";
      const cross = b.system !== s.system;
      const minutes = (cross ? 25 : b.body === s.body ? 4 : 8) + 5 * 2;
      const ages = [ageOf(b.asOf), ageOf(s.asOf)].filter((x) => x !== null);
      out.push({
        commodity: look.commodity, from: b, to: s,
        marginPerScu: margin, marginPct: (margin / b.price) * 100,
        moveScu, scuBound: bound,
        capitalRequired: moveScu * b.price,
        profit: moveScu * margin,
        minutes, profitPerHour: (moveScu * margin) / (minutes / 60),
        crossSystem: cross,
        ageDays: ages.length ? Math.max(...ages) : null,
      });
    }
  }
  return out.sort((a, b) => b.profit - a.profit);
}
