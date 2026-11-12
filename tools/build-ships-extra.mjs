// Build data/ships-extra.json — cargo grids for hulls that tools/build-ships.mjs cannot see.
//
// Why a second file and not a fix inside build-ships.mjs: build-ships needs the dumper's
// processed tree AND upstream scunpacked-data, and both lag a fresh patch. The RSI Galaxy
// arrived in 4.10.3 LIVE, which upstream has not published and the mirror never fully
// exported. Everything this script needs is in the raw datacore alone (one unforge, no PHP).
// HaulingDataStore merges this file OVER ships.json, so a hull here wins even after a later
// ships.json regeneration adds a (possibly wrong) row for the same class.
//
// 🔴 TWO THINGS build-ships.mjs GETS WRONG FOR THE GALAXY, which is why it is not just "re-run it":
//   1. The Galaxy's loadouts name every item by UUID (`entityClassReference`) and never by
//      `entityClassName`. build-ships reads only the name, so its loadout rule finds nothing.
//   2. Its PREFIX rule would then match all five `rsi_galaxy_cargogrid_*` records ONCE each:
//      500 SCU, with the medical module's 4 SCU cubby and an unmounted garage lift counted in,
//      and the module's two 256 SCU bays counted once. The real cargo-module total is 720.
//
// What it measures, per entry below: the hull's own default loadout (minus the module port),
// plus the chosen module's loadout, plus ONE level of nesting — an item mounted there whose own
// default loadout carries a cargo grid. That last step is the Galaxy's cargo lift: the cargo
// module mounts a lift (`hardpoint_lift` -> door item) and the lift mounts the grid.
//
// Usage: node tools/build-ships-extra.mjs [<mirror version dir>] [<out.json>]
//   default mirror: C:/Users/subli/SC-Data-Mirror/versions/4.10.3-LIVE.13165946
//   default out:    data/ships-extra.json
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const CELL = 1.25;
const versionDir = process.argv[2] || "C:/Users/subli/SC-Data-Mirror/versions/4.10.3-LIVE.13165946";
const outPath = process.argv[3] || join(process.cwd(), "data", "ships-extra.json");
const records = join(versionDir, "_work", "raw", "Data", "Libs", "Foundry", "Records");
const version = versionDir.split(/[\\/]/).filter(Boolean).pop();

/** The hulls to measure. `module` is the scitem record filled into the hull's `hardpoint_module`
 *  port; the log names the ship by hull class only, so the module is an assumption this file
 *  states openly in `displayName` and `module`. */
const ENTRIES = [
  {
    className: "RSI_Galaxy",
    displayName: "RSI Galaxy (Cargo Module)",
    hull: "entities/spaceships/rsi_galaxy.xml",
    modulePort: "hardpoint_module",
    module: "entities/scitem/ships/module/rsi/rsi_galaxy_module_cargo.xml",
  },
  {
    // Not modular. Its three grids hang straight off the hull, but its loadout is all
    // entityClassReference (0 names, 131 refs), so build-ships.mjs sees none of them.
    className: "ANVL_Liberator",
    displayName: "Anvil Liberator",
    hull: "entities/spaceships/anvl_liberator.xml",
  },
];

/** Hand-checked against the records on 4.10.3-LIVE.13165946 (2026-11-12). The build refuses to
 *  write if any of these moves, so a patch that changes one of these hulls says so loudly. */
const EXPECT = {
  RSI_Galaxy: { totalScu: 720, grids: ["4x16x4", "4x16x4", "6x12x2", "2x4x4", "2x4x4"] },
  ANVL_Liberator: { totalScu: 400, grids: ["6x8x4", "4x8x4", "4x5x4"] },
};

if (!existsSync(records)) {
  console.error(`missing ${records}\n  (needs an unforged datacore — see the sc-data-mirror skill)`);
  process.exit(1);
}

const attr = (s, name) => (s.match(new RegExp(`\\b${name}="([^"]*)"`)) ?? [])[1] ?? null;
const vec = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>`));
  if (!m) return null;
  const v = { x: Number(attr(m[0], "x")), y: Number(attr(m[0], "y")), z: Number(attr(m[0], "z")) };
  return [v.x, v.y, v.z].every(Number.isFinite) ? v : null;
};
const cells = (v) => Math.round(v / CELL);
const aligned = (d) => [d.x, d.y, d.z].every((v) => v > 0 && Math.abs(v / CELL - Math.round(v / CELL)) < 1e-6);

// ── uuid -> record file, for scitem items and inventory containers ──────────
const byRef = new Map();
function index(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { index(p); continue; }
    if (!e.name.endsWith(".xml")) continue;
    const head = readFileSync(p, "utf8").slice(0, 600);
    const ref = attr(head, "__ref");
    if (ref) byRef.set(ref, p);
  }
}
index(join(records, "entities", "scitem"));
index(join(records, "inventorycontainers"));
console.log(`[ships-extra] indexed ${byRef.size} records`);

/** Every loadout entry in a record as {port, ref}. Both spellings, so a hull that names items
 *  (most of them) and one that references them (the Galaxy) read the same way. */
const LOADOUT = /<SItemPortLoadoutEntryParams\b[^>]*>/g;
function loadout(xml) {
  const out = [];
  for (const m of xml.matchAll(LOADOUT)) {
    const ref = attr(m[0], "entityClassReference");
    if (ref) out.push({ port: attr(m[0], "itemPortName"), ref });
  }
  return out;
}

/** The grid an item resolves to, or null if it is not a cargo grid. */
function gridOf(ref) {
  const file = byRef.get(ref);
  if (!file) return null;
  const containerRef = attr(readFileSync(file, "utf8"), "containerParams");
  const cfile = containerRef && byRef.get(containerRef);
  if (!cfile || !/[\\/]inventorycontainers[\\/]cargogrid[\\/]/.test(cfile)) return null;
  const xml = readFileSync(cfile, "utf8");
  const d = vec(xml, "interiorDimensions");
  if (!d || !aligned(d)) return null;
  const mb = vec(xml, "maxPermittedItemSize");
  return {
    w: cells(d.x), l: cells(d.y), h: cells(d.z),
    maxBox: mb && aligned(mb) ? { x: cells(mb.x), y: cells(mb.y), z: cells(mb.z) } : null,
  };
}

const ships = {};
let bad = 0;
for (const e of ENTRIES) {
  const hullXml = readFileSync(join(records, e.hull), "utf8");
  const mounts = e.module
    ? [...loadout(hullXml).filter((m) => m.port !== e.modulePort),
       ...loadout(readFileSync(join(records, e.module), "utf8"))]
    : loadout(hullXml);
  const grids = [];
  for (const m of mounts) {
    const g = gridOf(m.ref);
    if (g) { grids.push({ port: m.port, via: "loadout", ...g }); continue; }
    // One level down: an item mounted here whose OWN default loadout carries a grid (the lift).
    const file = byRef.get(m.ref);
    if (!file) continue;
    for (const inner of loadout(readFileSync(file, "utf8"))) {
      const ig = gridOf(inner.ref);
      if (ig) grids.push({ port: `${m.port}/${inner.port}`, via: "loadout", ...ig });
    }
  }
  grids.sort((a, b) => b.w * b.l * b.h - a.w * a.l * a.h);
  const totalScu = grids.reduce((n, g) => n + g.w * g.l * g.h, 0);
  ships[e.className] = {
    className: e.className,
    displayName: e.displayName,
    isSpaceship: true,
    totalScu,
    grids,
    source: "mirror-raw",
    ...(e.module ? { module: e.module.split("/").pop().replace(/\.xml$/, "") } : {}),
  };
  const want = EXPECT[e.className];
  const shape = grids.map((g) => `${g.w}x${g.l}x${g.h}`).join(",");
  const ok = !want || (want.totalScu === totalScu && want.grids.join(",") === shape);
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${e.className} ${totalScu} SCU  [${shape}]`);
  for (const g of grids) console.log(`         ${String(g.port).padEnd(40)} ${g.w}x${g.l}x${g.h} = ${g.w * g.l * g.h} SCU, max box ${g.maxBox ? `${g.maxBox.x}x${g.maxBox.y}x${g.maxBox.z}` : "none"}`);
}
if (bad) {
  console.error(`[ships-extra] ${bad} hull(s) moved from the hand-checked figures — NOT written`);
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify({
  schema: "sc-ships-extra/1",
  version,
  /** Merged OVER ships.json by HaulingDataStore. Dimensions are in cells, like ships.json. */
  cellMetres: CELL,
  shipCount: Object.keys(ships).length,
  ships,
}, null, 1) + "\n");
console.log(`[ships-extra] -> ${outPath}`);
