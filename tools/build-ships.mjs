// Build data/ships.json (sc-ships/1) — every flyable ship's CARGO GRID GEOMETRY.
//
// The hauling optimiser has to answer "will these boxes fit in the ship I am actually
// flying, and where do I put them". That needs real grid dimensions, not a total SCU
// number: a 32 SCU box is a 2x8 stick and whether it fits depends on the grid's X and Y,
// not on how much room is left.
//
// 🔑 WHY THE MIRROR'S `_work/processed/items` AND NOT THE RAW XML CHAIN.
// The plan routed this the long way round — ship entity -> cargogrid item port ->
// `containerParams` UUID -> `inventorycontainers/ships/*.xml`. That chase is unnecessary:
// the mirror's processed item JSON already carries `interiorDimensions` and
// `maxPermittedItemSize` inline on the cargo-grid item itself. `containerParams` is still
// there as a UUID, but nothing downstream needs it. One less join, one less thing to break
// when CIG moves a file.
//
// The ship -> grid link still comes from the raw entity XML, because that is the only
// authoritative statement of which grids a hull actually mounts:
//   <SItemPortLoadoutEntryParams itemPortName="hardpoint_cargo_large"
//                                entityClassName="CRUS_Starlifter_CargoGrid_Large" />
// Matching on filename would be a guess; this is the game's own loadout.
//
// Usage: node tools/build-ships.mjs [<mirror version dir>] [<out.json>]
//   default mirror: newest dir under C:/Users/subli/SC-Data-Mirror/versions
//   default out:    data/ships.json
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const MIRROR_ROOT = "C:/Users/subli/SC-Data-Mirror/versions";
const CELL = 1.25; // metres per cargo cell — one 1 SCU box

// ── Filters ────────────────────────────────────────────────────────────────
// Non-flyable hulls: AI variants, unmanned salvage targets, boarding templates. These
// carry real grids and would otherwise land in the dataset as ships nobody can fly.
const SHIP_DENY = [
  /_pu_ai(_|$)/, /_ai_template(_|$)/, /_unmanned(_|$)/, /_ai_civ(_|$)/, /_ai_crim(_|$)/,
  /_shipboarded(_|$)/, /_dead(_|$)/, /_derelict(_|$)/, /_wreck(_|$)/, /_test(_|$)/,
  /_template$/, /_indestructible(_|$)/, /_nointerior(_|$)/, /_modifiers(_|$)/,
];

/** Is every dimension an exact whole number of 1.25 m cells?
 *  🔑 THE FILTER THAT MATTERS. Personal lockers and armoury cubbies are also
 *  "inventory containers" with interiorDimensions, but they are sized in centimetres
 *  (1.75 m cubes) rather than cargo cells. They are not cargo grids and no external box
 *  ever goes in one. Demanding exact 1.25 m multiples drops them cleanly, with no
 *  hand-maintained denylist of grid names to keep in sync. */
function isCellAligned(d) {
  for (const v of [d.x, d.y, d.z]) {
    if (typeof v !== "number" || v <= 0) return false;
    const cells = v / CELL;
    if (Math.abs(cells - Math.round(cells)) > 1e-6) return false;
  }
  return true;
}

const toCells = (v) => Math.round(v / CELL);

// ── Locate the mirror ──────────────────────────────────────────────────────
function newestVersionDir() {
  const dirs = readdirSync(MIRROR_ROOT).filter((d) => statSync(join(MIRROR_ROOT, d)).isDirectory());
  if (!dirs.length) throw new Error(`no version dirs under ${MIRROR_ROOT}`);
  // Directory names are `<version>-<channel>.<changelist>`; the changelist orders them.
  return dirs.sort((a, b) => (Number(a.split(".").pop()) || 0) - (Number(b.split(".").pop()) || 0)).pop();
}

const versionDir = process.argv[2] || join(MIRROR_ROOT, newestVersionDir());
const outPath = process.argv[3] || join(process.cwd(), "data", "ships.json");
const work = join(versionDir, "_work");
const itemsDir = join(work, "processed", "items");
const shipsIdxDir = join(work, "processed", "ships");
const entitiesDir = join(work, "raw", "Data", "Libs", "Foundry", "Records", "entities");

for (const p of [itemsDir, shipsIdxDir, entitiesDir]) {
  if (!existsSync(p)) {
    console.error(`missing ${p}\n  (expected an extracted mirror — see the sc-data-mirror skill)`);
    process.exit(1);
  }
}
const version = versionDir.split(/[\\/]/).filter(Boolean).pop();

// ── 1. Index every cargo grid item by class name ───────────────────────────
// Cheap pre-filter on the raw text before parsing: only a few hundred of the ~24k item
// files are cargo grids, and JSON.parse on all of them is 30+ seconds of nothing.
console.log(`[ships] indexing cargo grids from ${itemsDir}`);
const grids = new Map(); // lowercased class name -> {w,l,h, maxBox}
let itemsScanned = 0, gridsSkipped = 0;

for (const f of readdirSync(itemsDir)) {
  if (!f.endsWith(".json")) continue;
  const txt = readFileSync(join(itemsDir, f), "utf8");
  itemsScanned++;
  if (!txt.includes('"interiorDimensions"')) continue;
  let j;
  try { j = JSON.parse(txt); } catch { continue; }

  const dims = findFirst(j, "interiorDimensions");
  if (!dims) continue;
  if (!isCellAligned(dims)) { gridsSkipped++; continue; }

  const maxBox = findFirst(j, "maxPermittedItemSize");
  grids.set(f.replace(/\.json$/, "").toLowerCase(), {
    w: toCells(dims.x),
    l: toCells(dims.y),
    h: toCells(dims.z),
    maxBox: maxBox && isCellAligned(maxBox)
      ? { x: toCells(maxBox.x), y: toCells(maxBox.y), z: toCells(maxBox.z) }
      : null,
  });
}
console.log(`[ships] ${grids.size} cell-aligned cargo grids (${gridsSkipped} non-cargo containers dropped) from ${itemsScanned} items`);

/** Depth-first search for the first value of `key` anywhere in a nested object. The item
 *  JSON nests the grid params several components deep and the exact path differs between
 *  hulls; the key is unique enough that searching for it beats hardcoding a path. */
function findFirst(node, key) {
  if (node == null || typeof node !== "object") return null;
  if (!Array.isArray(node) && node[key] != null && typeof node[key] === "object") return node[key];
  for (const v of Object.values(node)) {
    const hit = findFirst(v, key);
    if (hit) return hit;
  }
  return null;
}

// ── 2. Ship display names ──────────────────────────────────────────────────
const shipIndex = new Map(); // lowercased file stem -> {className, displayName, isSpaceship}
for (const f of readdirSync(shipsIdxDir)) {
  if (!f.endsWith(".json")) continue;
  try {
    const j = JSON.parse(readFileSync(join(shipsIdxDir, f), "utf8"));
    shipIndex.set(f.replace(/\.json$/, "").toLowerCase(), {
      className: j.ClassName ?? null,
      displayName: j.Name ?? null,
      isSpaceship: j.IsSpaceship === true,
    });
  } catch { /* a malformed index row must not take the build down */ }
}

// ── 3. Walk ship entities, resolve their mounted grids ─────────────────────
const LOADOUT_RE = /<SItemPortLoadoutEntryParams[^>]*\bitemPortName="([^"]*)"[^>]*\bentityClassName="([^"]*)"/g;
const ships = {};
let denied = 0, noGrid = 0;

for (const sub of ["spaceships", "groundvehicles"]) {
  const dir = join(entitiesDir, sub);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".xml")) continue;
    const stem = f.replace(/\.xml$/, "").toLowerCase();
    if (SHIP_DENY.some((re) => re.test(stem))) { denied++; continue; }

    const xml = readFileSync(join(dir, f), "utf8");
    const found = [];
    for (const m of xml.matchAll(LOADOUT_RE)) {
      const grid = grids.get(m[2].toLowerCase());
      if (grid) found.push({ port: m[1], ...grid });
    }
    if (!found.length) { noGrid++; continue; }

    const meta = shipIndex.get(stem) ?? {};
    // Biggest grid first — the widget shows the main bay first, and the packer should
    // fill the roomiest grid before spilling into an auxiliary one.
    found.sort((a, b) => b.w * b.l * b.h - a.w * a.l * a.h);
    ships[meta.className ?? stem] = {
      className: meta.className ?? stem,
      displayName: meta.displayName ?? null,
      isSpaceship: meta.isSpaceship ?? (sub === "spaceships"),
      totalScu: found.reduce((n, g) => n + g.w * g.l * g.h, 0),
      grids: found,
    };
  }
}

const payload = {
  schema: "sc-ships/1",
  version,
  shipCount: Object.keys(ships).length,
  /** Metres per cargo cell. Every dimension in `grids` is in CELLS, not metres. */
  cellMetres: CELL,
  ships,
};
writeFileSync(outPath, JSON.stringify(payload));

console.log(`[ships] ${payload.shipCount} hulls with cargo grids  (${denied} AI/variant denied, ${noGrid} with no grid)`);
console.log(`[ships] -> ${outPath} (${(readFileSync(outPath).length / 1024).toFixed(0)} KB)`);

// ── 4. Self-check against known-good figures ───────────────────────────────
// These three are the plan's acceptance test, independently confirmed against published
// SCU. If a future patch (or a refactor here) moves them, the build says so loudly rather
// than shipping a quietly wrong dataset.
const EXPECT = { CRUS_Starlifter_C2: 696, CRUS_Starlifter_M2: 522, CRUS_Starlifter_A2: 216 };
let bad = 0;
for (const [cls, want] of Object.entries(EXPECT)) {
  const got = ships[cls]?.totalScu;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${cls.padEnd(22)} ${got ?? "(missing)"} SCU (expect ${want})`);
}
if (bad) {
  console.error(`[ships] ${bad} reference hull(s) disagree — dataset NOT trustworthy`);
  process.exit(1);
}
