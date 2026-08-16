// Build data/ships.json (sc-ships/1) — every flyable hull's CARGO GRID GEOMETRY.
//
// The hauling optimiser has to answer "will these boxes fit in the ship I am actually
// flying, and where do I put them". That needs real grid dimensions, not a total SCU
// number: a 32 SCU box is a 2x8 stick, and whether it fits depends on a grid's X and Y,
// not on how much room is left in it.
//
// ── How a hull finds its grids, and why it takes two rules ──────────────────
// 🔑 CIG uses TWO naming conventions for cargo grids and neither one covers every hull.
// This cost a rewrite, so it is written down:
//
//   1. LOADOUT (Starlifter style). The ship entity XML names the grid outright:
//        <SItemPortLoadoutEntryParams itemPortName="hardpoint_cargo_large"
//                                     entityClassName="CRUS_Starlifter_CargoGrid_Large" />
//      Here the ITEM name carries no variant — C2, M2 and A2 all reference
//      `CRUS_Starlifter_CargoGrid_Large`-ish names, and the variant lives on the
//      CONTAINER RECORD behind it (`crus_starlifter_cargogrid_large_c2.xml`).
//
//   2. PREFIX (Constellation style). The ship entity does NOT mention its main bay at
//      all — the Taurus's 168 SCU hold appears nowhere in its loadout. The grid is
//      attached inside the ship's `.socpak` object container, which is a packed archive
//      we cannot read. What we CAN rely on is that the container record is named for the
//      hull: `RSI_Constellation_Taurus_CargoGrid_Main`.
//
// So: take the union. Loadout first (it is authoritative and carries multiplicity — the
// Hull C mounts the same grid class eight times), then prefix-matched records the loadout
// never mentioned. Neither rule alone is enough; the Taurus reports 6 SCU on rule 1 and
// the C2 reports 0 on rule 2.
//
// ⚠️ The prefix rule is guarded — see PREFIX_GUARD below — because a bare
// "starts with the hull name" test hands the Origin 600i the 600i Touring's grid.
//
// Usage: node tools/build-ships.mjs [<mirror version dir>] [<out.json>]
//   default mirror: newest dir under C:/Users/subli/SC-Data-Mirror/versions
//   default out:    data/ships.json
// Verify with: node tools/verify-ships.mjs   (diffs against upstream scunpacked-data)
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MIRROR_ROOT = "C:/Users/subli/SC-Data-Mirror/versions";
const CELL = 1.25; // metres per cargo cell — one 1 SCU box is exactly one cell

// Non-flyable hulls: AI variants, unmanned salvage targets, boarding templates, wrecks.
// These carry real grids and would otherwise land in the dataset as ships nobody can fly.
const SHIP_DENY = [
  /_pu_ai(_|$)/, /_ai_template(_|$)/, /_unmanned(_|$)/, /_ai_civ(_|$)/, /_ai_crim(_|$)/,
  /_ai_super(_|$)/, /_ai_override(_|$)/, /_ai_defendship(_|$)/, /_ai_dropship(_|$)/,
  /_ai_ea_/, /_shipboarded(_|$)/, /_boarded(_|$)/, /_hijacked(_|$)/, /_dead(_|$)/,
  /_derelict(_|$)/, /_wreck(_|$)/, /_test(_|$)/, /_template$/, /_indestructible(_|$)/,
  /_nointerior(_|$)/, /_modifiers(_|$)/, /_ea_pir(_|$)/, /_tutorial(_|$)/, /_temp$/,
];

/** After stripping `<hullclass>_` off a container-record name, the remainder must START
 *  with the grid marker. 🔑 WITHOUT THIS the Origin 600i (`ORIG_600i`) prefix-matches
 *  `orig_600i_touring_cargogrid_*` and silently inherits a different ship's hold. With it,
 *  the remainder `touring_cargogrid_main` is rejected while the Taurus's `cargogrid_main`
 *  passes. The rule is "the very next token is the grid, not another variant". */
const PREFIX_GUARD = /^cargo_?grid(_|$)/;

/** Is every dimension an exact whole number of 1.25 m cells?
 *  🔑 THE FILTER THAT MATTERS. Personal lockers and armoury cubbies are also
 *  "inventory containers" with interiorDimensions, but they are sized in centimetres
 *  (1.75 m cubes). No external cargo box ever goes in one. Demanding exact 1.25 m
 *  multiples drops them cleanly, with no hand-maintained denylist to keep in sync. */
function isCellAligned(d) {
  for (const v of [d.x, d.y, d.z]) {
    if (typeof v !== "number" || v <= 0) return false;
    if (Math.abs(v / CELL - Math.round(v / CELL)) > 1e-6) return false;
  }
  return true;
}
const toCells = (v) => Math.round(v / CELL);

// ── Locate the mirror ──────────────────────────────────────────────────────
function newestVersionDir() {
  const dirs = readdirSync(MIRROR_ROOT).filter((d) => statSync(join(MIRROR_ROOT, d)).isDirectory());
  if (!dirs.length) throw new Error(`no version dirs under ${MIRROR_ROOT}`);
  // Names are `<version>-<channel>.<changelist>`; the trailing changelist orders them.
  return dirs.sort((a, b) => (Number(a.split(".").pop()) || 0) - (Number(b.split(".").pop()) || 0)).pop();
}

const versionDir = process.argv[2] || join(MIRROR_ROOT, newestVersionDir());
const outPath = process.argv[3] || join(process.cwd(), "data", "ships.json");
const work = join(versionDir, "_work");
const recordsDir = join(work, "raw", "Data", "Libs", "Foundry", "Records");
const containersDir = join(recordsDir, "inventorycontainers");
const entitiesDir = join(recordsDir, "entities");
const itemsDir = join(work, "processed", "items");
const shipsIdxDir = join(work, "processed", "ships");

for (const p of [containersDir, entitiesDir, itemsDir, shipsIdxDir]) {
  if (!existsSync(p)) {
    console.error(`missing ${p}\n  (expected an extracted mirror — see the sc-data-mirror skill)`);
    process.exit(1);
  }
}
const version = versionDir.split(/[\\/]/).filter(Boolean).pop();

// ── 1. Grid geometry, from the raw container records ───────────────────────
// These 450-odd small XML files are the complete, authoritative set. The mirror's
// processed `ship-items.json` only carries 143 of them, so it is not usable here.
const attr = (s, name) => {
  const m = s.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
};
const vec = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>`));
  if (!m) return null;
  const v = { x: Number(attr(m[0], "x")), y: Number(attr(m[0], "y")), z: Number(attr(m[0], "z")) };
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? v : null;
};

const grids = new Map(); // lowercased class name -> {w,l,h,maxBox}
let recordsSeen = 0, recordsDropped = 0;

(function walkContainers(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walkContainers(p); continue; }
    if (!e.name.endsWith(".xml")) continue;
    const xml = readFileSync(p, "utf8");
    recordsSeen++;
    // Root tag is `<InventoryContainer.<CLASSNAME> ...>` — the class name is the suffix.
    const root = xml.match(/<InventoryContainer\.([A-Za-z0-9_]+)/);
    if (!root) continue;
    // 🔑 `*_template` records are CIG's editor prototypes, not bays any hull mounts, and
    // they are sized like it: every one is a 35 m cube (28x28x28 cells = 21,952 SCU).
    // They are unreachable through the loadout rule but the prefix rule walks straight
    // into them — `drak_caterpillar_cargogrid_template` turned a 576 SCU ship into a
    // 22,528 SCU one. Drop them at the source so neither rule can see them.
    if (/_template$/i.test(root[1])) { recordsDropped++; continue; }
    const dims = vec(xml, "interiorDimensions");
    if (!dims || !isCellAligned(dims)) { recordsDropped++; continue; }
    const maxBox = vec(xml, "maxPermittedItemSize");
    grids.set(root[1].toLowerCase(), {
      // The record's own UUID. This is the identity the two rules are deduped on — see
      // `seenRefs` below.
      ref: attr(xml.slice(0, 400), "__ref"),
      w: toCells(dims.x), l: toCells(dims.y), h: toCells(dims.z),
      maxBox: maxBox && isCellAligned(maxBox)
        ? { x: toCells(maxBox.x), y: toCells(maxBox.y), z: toCells(maxBox.z) } : null,
    });
  }
})(containersDir);
console.log(`[ships] ${grids.size} cargo grids from ${recordsSeen} container records (${recordsDropped} non-cargo dropped)`);

// ── 2. Grid geometry as reachable by ITEM name ─────────────────────────────
// A loadout entry names an ITEM (`CRUS_Starlifter_CargoGrid_Large`), not the container
// record behind it (`..._large_c2`). The processed item JSON already carries the resolved
// `interiorDimensions` inline, so this resolves the loadout side without chasing the
// `containerParams` UUID through another join.
const itemGrids = new Map();
let itemsScanned = 0;
for (const f of readdirSync(itemsDir)) {
  if (!f.endsWith(".json")) continue;
  const txt = readFileSync(join(itemsDir, f), "utf8");
  itemsScanned++;
  if (!txt.includes('"interiorDimensions"')) continue; // cheap pre-filter: 21k files, ~2k hits
  let j;
  try { j = JSON.parse(txt); } catch { continue; }
  const dims = findFirst(j, "interiorDimensions");
  if (!dims || !isCellAligned(dims)) continue;
  const maxBox = findFirst(j, "maxPermittedItemSize");
  itemGrids.set(f.replace(/\.json$/, "").toLowerCase(), {
    // 🔑 `containerParams` is the UUID of the container record this item resolves to, and
    // it is the ONLY thing tying the two rules together: the Reclaimer's loadout mounts
    // item `AEGS_Reclaimer_CargoGrid_Large` four times while the record behind it is
    // named `AEGS_Reclaimer_CargoGrid`. Deduping on names let the prefix rule add that
    // same 27 SCU bay a fifth time; deduping on this UUID does not.
    // (`\s*` matters — the mirror writes these files pretty-printed, so the colon is
    // followed by a space and a tight `":"` pattern silently matches nothing.)
    ref: (txt.match(/"containerParams":\s*"([0-9a-f-]{36})"/) ?? [])[1] ?? null,
    w: toCells(dims.x), l: toCells(dims.y), h: toCells(dims.z),
    maxBox: maxBox && isCellAligned(maxBox)
      ? { x: toCells(maxBox.x), y: toCells(maxBox.y), z: toCells(maxBox.z) } : null,
  });
}
console.log(`[ships] ${itemGrids.size} cargo grids reachable by item name (of ${itemsScanned} items)`);

/** Depth-first search for the first object value of `key`. The grid params nest several
 *  components deep and the exact path differs between hulls; the key is unique enough
 *  that searching for it beats hardcoding a path that breaks every patch. */
function findFirst(node, key) {
  if (node == null || typeof node !== "object") return null;
  if (!Array.isArray(node) && node[key] != null && typeof node[key] === "object") return node[key];
  for (const v of Object.values(node)) {
    const hit = findFirst(v, key);
    if (hit) return hit;
  }
  return null;
}

// ── 3. Display names ───────────────────────────────────────────────────────
const shipIndex = new Map();
for (const f of readdirSync(shipsIdxDir)) {
  if (!f.endsWith(".json")) continue;
  try {
    const j = JSON.parse(readFileSync(join(shipsIdxDir, f), "utf8"));
    shipIndex.set(f.replace(/\.json$/, "").toLowerCase(), {
      className: j.ClassName ?? null,
      displayName: j.Name ?? null,
      isSpaceship: j.IsSpaceship === true,
    });
  } catch { /* one malformed index row must not take the build down */ }
}

const gridNames = [...grids.keys()];

// ── 4. Walk hulls, resolve grids by both rules ─────────────────────────────
const LOADOUT_TAG = /<SItemPortLoadoutEntryParams\b[^>]*>/g;

/** Every cargo grid a hull mounts through its loadout, with multiplicity. */
function loadoutGrids(xml) {
  const out = [];
  for (const m of xml.matchAll(LOADOUT_TAG)) {
    const name = attr(m[0], "entityClassName");
    if (!name) continue;
    const key = name.toLowerCase();
    const g = itemGrids.get(key) ?? grids.get(key);
    if (g) out.push({ port: attr(m[0], "itemPortName") ?? null, grid: g });
  }
  return out;
}

// Collect every hull worth emitting, and read its loadout once.
const hulls = [];
let denied = 0;
for (const sub of ["spaceships", "groundvehicles"]) {
  const dir = join(entitiesDir, sub);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".xml")) continue;
    const stem = f.replace(/\.xml$/, "").toLowerCase();
    if (SHIP_DENY.some((re) => re.test(stem))) { denied++; continue; }
    const meta = shipIndex.get(stem) ?? {};
    hulls.push({
      cls: meta.className ?? stem,
      displayName: meta.displayName ?? null,
      isSpaceship: meta.isSpaceship ?? (sub === "spaceships"),
      mounted: loadoutGrids(readFileSync(join(dir, f), "utf8")),
    });
  }
}

// 🔑 PASS 1 — which container records does ANY hull's loadout reach?
// This is what makes the prefix rule safe. Deduping per-hull by name failed (the
// Reclaimer's loadout mounts item `AEGS_Reclaimer_CargoGrid_Large`, whose record is
// named `AEGS_Reclaimer_CargoGrid`, so the prefix rule added that same 27 SCU bay a
// fifth time); deduping per-hull by record UUID failed too, because a record reachable
// under one name can still be prefix-matched under another.
//
// The real invariant is simpler: if a record is reachable through the loadout system at
// all, then the loadout is the authority on who mounts it and how many times, and the
// prefix rule has no business touching it. Prefix exists ONLY for bays that live inside
// a hull's packed `.socpak` and are therefore invisible to every loadout in the game —
// the Constellation Taurus's 168 SCU hold being the case that forced this rule.
const loadoutReachable = new Set();
for (const h of hulls) for (const m of h.mounted) if (m.grid.ref) loadoutReachable.add(m.grid.ref);
console.log(`[ships] ${loadoutReachable.size} of ${grids.size} grid records are reachable through some hull's loadout`);

// PASS 2 — emit.
const ships = {};
let noGrid = 0, viaPrefix = 0;
for (const h of hulls) {
  const found = h.mounted.map(({ port, grid: { ref, ...geom } }) => ({ port, via: "loadout", ...geom }));

  const pfx = h.cls.toLowerCase() + "_";
  for (const name of gridNames) {
    if (!name.startsWith(pfx)) continue;
    if (!PREFIX_GUARD.test(name.slice(pfx.length))) continue;
    const { ref, ...geom } = grids.get(name);
    if (ref && loadoutReachable.has(ref)) continue;
    found.push({ port: name, via: "prefix", ...geom });
    viaPrefix++;
  }

  if (!found.length) { noGrid++; continue; }
  // Biggest grid first: the widget shows the main bay first, and the packer should fill
  // the roomiest hold before spilling into an auxiliary one.
  found.sort((a, b) => b.w * b.l * b.h - a.w * a.l * a.h);
  ships[h.cls] = {
    className: h.cls,
    displayName: h.displayName,
    isSpaceship: h.isSpaceship,
    totalScu: found.reduce((n, g) => n + g.w * g.l * g.h, 0),
    grids: found,
  };
}

console.log(`[ships] mirror pass: ${Object.keys(ships).length} hulls (${viaPrefix} grids by prefix, ${denied} AI/variant denied, ${noGrid} with no grid)`);

// ── 5. Merge upstream, which can see inside the .socpaks ───────────────────
// 🔴 THE LIMIT OF THE MIRROR, AND WHY THIS STEP EXISTS.
// Neither rule above can recover how MANY times a hull mounts a bay when the mounting
// happens inside a packed `.socpak`. The container record says a MISC Hull B bay is
// 2x8x2; it does not say the Hull B has sixteen of them. Measured against upstream, that
// cost 18 of 108 hulls — the Hull B read 32 SCU instead of 512, the Carrack 88 instead of
// 456. The count is not anywhere in Libs/Foundry/Records: not on the ship entity, not in
// cargomanifest, not in a capacity record. It is in the socpak layer files, which are not
// shipped in the extracted tree.
//
// StarCitizenWiki/scunpacked-data unpacks those and publishes a resolved `CargoGrids[]`.
// So upstream leads for geometry, and the mirror pass above becomes the independent
// check (83 of 101 hulls agreed exactly, which is what makes upstream trustworthy here)
// plus the fallback for hulls upstream has not published.
//
// ⚠️ THE TRADE: upstream lags this mirror by about a changelist. That is the right side
// to err on for THIS dataset — cargo geometry barely moves between patches, whereas a
// hull reading 16x under would quietly wreck every pack the solver produces. It is the
// opposite trade from blueprints.latest.json, where currency is the whole point.
const UPSTREAM = "https://raw.githubusercontent.com/StarCitizenWiki/scunpacked-data/master/ships";
const CACHE = join(tmpdir(), "sc-overlay-scunpacked-cache");
const OFFLINE = process.argv.includes("--offline");
mkdirSync(CACHE, { recursive: true });

async function upstreamGrids(cls) {
  const file = join(CACHE, `${cls.toLowerCase()}.json`);
  let txt = null;
  if (existsSync(file)) txt = readFileSync(file, "utf8");
  else if (!OFFLINE) {
    const res = await fetch(`${UPSTREAM}/${cls.toLowerCase()}.json`);
    txt = res.status === 404 ? "404" : res.ok ? await res.text() : null;
    if (txt) writeFileSync(file, txt);
  }
  if (!txt || txt === "404") return null;
  let j;
  try { j = JSON.parse(txt); } catch { return null; }
  if (!Array.isArray(j.CargoGrids)) return null;
  return j.CargoGrids.map((g) => ({
    port: g.Class ?? null,
    via: "upstream",
    w: Math.round(g.X / CELL), l: Math.round(g.Y / CELL), h: Math.round(g.Z / CELL),
    maxBox: g.MaxSize
      ? { x: Math.round(g.MaxSize.X / CELL), y: Math.round(g.MaxSize.Y / CELL), z: Math.round(g.MaxSize.Z / CELL) }
      : null,
  })).filter((g) => g.w > 0 && g.l > 0 && g.h > 0);
}

// 🔑 Iterate every surviving hull, NOT just the ones the mirror found grids for. The
// Cutlass Black is the reason: its bays are socpak-mounted AND its records are named for
// the base `DRAK_Cutlass`, so both mirror rules come up empty and it never enters `ships`
// at all. Same for the Mercury Star Runner, Andromeda, Prospector and MOLE. Merging only
// over hulls the mirror already knew would have silently shipped a dataset missing most
// of the mid-size haulers.
let agreed = 0, corrected = 0, mirrorOnly = 0, added = 0;
const corrections = [];
const shape = (l) => l.map((g) => `${g.w}x${g.l}x${g.h}`).sort().join(",");

let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < hulls.length) {
    const h = hulls[i++];
    const cls = h.cls;
    let up;
    try { up = await upstreamGrids(cls); } catch { up = null; }

    let mine = ships[cls];
    if (!mine) {
      // Mirror knew nothing. Only worth an entry if upstream says it carries cargo.
      if (!up || !up.length) continue;
      up.sort((a, b) => b.w * b.l * b.h - a.w * a.l * a.h);
      ships[cls] = {
        className: cls, displayName: h.displayName, isSpaceship: h.isSpaceship,
        totalScu: up.reduce((n, g) => n + g.w * g.l * g.h, 0),
        grids: up, source: "upstream",
      };
      added++;
      continue;
    }
    if (!up || !up.length) { mine.source = "mirror"; mirrorOnly++; continue; }
    const upScu = up.reduce((n, g) => n + g.w * g.l * g.h, 0);
    if (upScu === mine.totalScu && shape(up) === shape(mine.grids)) {
      // Two pipelines, same answer — keep the mirror's version, which carries real
      // hardpoint names rather than grid class names.
      mine.source = "mirror+upstream";
      agreed++;
    } else {
      corrections.push({ cls, from: mine.totalScu, to: upScu, fromN: mine.grids.length, toN: up.length });
      up.sort((a, b) => b.w * b.l * b.h - a.w * a.l * a.h);
      mine.grids = up;
      mine.totalScu = upScu;
      mine.source = "upstream";
      corrected++;
    }
  }
}));

console.log(`[ships] upstream merge: ${agreed} agreed, ${corrected} corrected, ${added} added (mirror saw no grids), ${mirrorOnly} mirror-only (not published upstream)`);
if (corrections.length) {
  console.log(`[ships] corrected by upstream (mirror could not see socpak multiplicity):`);
  for (const c of corrections.sort((a, b) => (b.to - b.from) - (a.to - a.from))) {
    console.log(`         ${c.cls.padEnd(38)} ${String(c.from).padStart(5)} -> ${String(c.to).padStart(5)} SCU   (${c.fromN} -> ${c.toN} grids)`);
  }
}

const payload = {
  schema: "sc-ships/1",
  version,
  /** The upstream snapshot geometry was taken from; lags `version` by ~a changelist. */
  upstream: "StarCitizenWiki/scunpacked-data@master",
  shipCount: Object.keys(ships).length,
  /** Metres per cargo cell. Every dimension under `grids` is in CELLS, not metres. */
  cellMetres: CELL,
  ships,
};
writeFileSync(outPath, JSON.stringify(payload));
console.log(`[ships] -> ${outPath} (${(readFileSync(outPath).length / 1024).toFixed(0)} KB)`);

// ── 6. Self-check against published SCU ────────────────────────────────────
// Independently-known figures. If a future patch — or a refactor here — moves one, the
// build says so loudly rather than shipping a quietly wrong dataset. Extend freely.
// The Hull B / Carrack / Cutlass entries are deliberate regression guards: each was
// wrong before the upstream merge landed, and each would fail silently without a check.
const EXPECT = {
  CRUS_Starlifter_C2: 696, CRUS_Starlifter_M2: 522, CRUS_Starlifter_A2: 216,
  RSI_Constellation_Taurus: 174, RSI_Constellation_Andromeda: 96,
  MISC_Hull_A: 64, MISC_Hull_B: 512, MISC_Hull_C: 4608,
  DRAK_Caterpillar: 576, RSI_Polaris: 576, AEGS_Reclaimer: 420,
  MISC_Freelancer_MAX: 120, ANVL_Carrack: 456, DRAK_Cutlass_Black: 46,
  CRUS_Star_Runner: 114, CRUS_Spirit_C1: 64, DRAK_Corsair: 72,
};
let bad = 0;
for (const [cls, want] of Object.entries(EXPECT)) {
  const got = ships[cls]?.totalScu;
  if (got !== want) bad++;
  console.log(`  ${got === want ? "ok  " : "FAIL"} ${cls.padEnd(26)} ${got ?? "(missing)"} SCU (expect ${want})`);
}
if (bad) {
  console.error(`[ships] ${bad} reference hull(s) disagree — dataset NOT trustworthy`);
  process.exit(1);
}
