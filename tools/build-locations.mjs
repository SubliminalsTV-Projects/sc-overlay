// Build data/locations.json (sc-locations/1) — the place names a hauling route runs between.
//
// 🔑 WHY A SNAPSHOT AND NOT A LIVE CALL. The overlay has to name a drop-off while the
// player is mid-run, offline, or on a plane. sc-api (192.168.1.97:8180) is Sub's box on his
// LAN; it is not reachable from a user's machine and never will be. So this is a build-time
// snapshot, like commodities.json, refreshed per patch.
//
// ── The alias problem, and the free answer ─────────────────────────────────
// The game log never writes "Area18". It writes internal codes — `Stanton3_Area18`,
// `RR_ARC_LEO`, `Stanton1b`. The plan budgeted a hand-maintained alias table for this.
// It turns out sc-api already carries the code: every location has a `tag.name` holding
// exactly that internal identifier. So the alias table is DERIVED, not authored, and it
// stays correct across patches for free. A hand-written table would have started wrong
// and rotted; this cannot.
//
// Usage: node tools/build-locations.mjs [<api base>] [<out.json>]
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API = process.argv[2] || "http://192.168.1.97:8180";
const outPath = process.argv[3] || join(process.cwd(), "data", "locations.json");
const PAGE = 200;

async function page(n) {
  const url = `${API}/api/locations?page%5Bsize%5D=${PAGE}&page%5Bnumber%5D=${n}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

console.log(`[locations] source ${API}/api/locations`);
let first;
try { first = await page(1); }
catch (e) {
  console.error(`[locations] cannot reach sc-api: ${e.message}`);
  console.error(`[locations] (it is Sub's LAN box — this builder only runs on his network)`);
  process.exit(1);
}
const total = first.meta?.total ?? 0;
const pages = Math.ceil(total / PAGE);
console.log(`[locations] ${total} locations across ${pages} pages`);

const rows = [...first.data];
for (let n = 2; n <= pages; n++) {
  const p = await page(n);
  rows.push(...p.data);
  if (n % 3 === 0 || n === pages) process.stdout.write(`\r[locations] fetched ${rows.length}/${total}   `);
}
process.stdout.write("\n");

// ── Trim ───────────────────────────────────────────────────────────────────
// The raw feed is ~6 MB, most of it lore descriptions and image URLs that no overlay
// widget will ever render. Kept: identity, hierarchy, and the quantum radii the router
// needs to reason about approach distance.
const locations = {};
const aliases = {};
let withTag = 0, withQt = 0;

for (const r of rows) {
  if (!r.uuid) continue;
  const q = r.quantum_travel ?? {};
  const loc = {
    name: r.name ?? null,
    slug: r.slug ?? null,
    type: r.type?.name ?? null,
    classification: r.type?.classification ?? null,
    parent: r.parent?.uuid ?? null,
    parentName: r.parent?.name ?? null,
    star: r.star?.name ?? null,
    system: typeof r.system === "string" ? r.system : (r.system?.name ?? null),
    /** The internal identifier the game log uses for this place, when it has one. */
    code: r.tag?.name ?? null,
    /** Can you quantum straight to it? Routing needs this — a location you cannot QT to
     *  costs a hop through its parent. */
    qtDestination: r.type?.valid_quantum_travel_destination ?? null,
  };
  // Radii only where they exist; most interior locations have none.
  if (q.arrival_radius || q.obstruction_radius) {
    loc.qt = { arrival: q.arrival_radius ?? null, obstruction: q.obstruction_radius ?? null };
    withQt++;
  }
  locations[r.uuid] = loc;

  if (loc.code) {
    withTag++;
    // ⚠️ Codes are NOT unique — several locations can share a tag (a station and its
    // landing zone). Keep a list rather than silently letting the last one win, and let
    // the consumer disambiguate by type.
    (aliases[loc.code.toLowerCase()] ??= []).push(r.uuid);
  }
}

// ── Composite codes ────────────────────────────────────────────────────────
// 🔑 The log writes `Stanton3_Area18`, and sc-api's own tags stop one level short: Area18
// carries no tag, but its parent ArcCorp carries `Stanton3`. So the log's identifier is
// `<parent's code>_<location name, spaces stripped>`. Verified against a live game.log:
// `Stanton3_Area18` and `Pyro2_Outpost_...` both decompose exactly that way.
//
// This is why the alias table is derived rather than hand-written — the same rule covers
// every landing zone, station and outpost in both systems, and it keeps working when CIG
// adds more. The plan budgeted hand-maintenance for this; it is not needed.
let composites = 0;
for (const [uuid, loc] of Object.entries(locations)) {
  const parentCode = loc.parent ? locations[loc.parent]?.code : null;
  if (!parentCode || !loc.name) continue;
  const key = `${parentCode}_${loc.name.replace(/[^A-Za-z0-9]/g, "")}`.toLowerCase();
  const list = (aliases[key] ??= []);
  if (!list.includes(uuid)) { list.push(uuid); composites++; }
}
console.log(`[locations] ${composites} composite <parentCode>_<Name> aliases derived`);

const payload = {
  schema: "sc-locations/1",
  source: `${API}/api/locations`,
  locationCount: Object.keys(locations).length,
  /** lowercased internal code (as it appears in game.log) -> [location uuid, ...] */
  aliases,
  /** 🔑 Marker XYZ -> location. Deliberately EMPTY at build time and grown at runtime:
   *  no offline source maps a CreateMarker position to a place name, so this is seeded
   *  from observation. See the coordinate-frame note in the flight's landing notes before
   *  trusting any entry — the frame has to be pinned down first. */
  markerXyz: {},
  locations,
};
writeFileSync(outPath, JSON.stringify(payload));

console.log(`[locations] ${payload.locationCount} locations, ${withTag} with an internal code, ${withQt} with quantum radii`);
console.log(`[locations] ${Object.keys(aliases).length} distinct codes -> ${outPath} (${(readFileSync(outPath).length / 1024).toFixed(0)} KB)`);

// ── Self-check ─────────────────────────────────────────────────────────────
// A handful of places every hauling route touches. If sc-api reshapes its payload these
// go null and the build says so, rather than shipping a file of empty names.
const byName = (n) => Object.values(locations).find((l) => l.name === n);
let bad = 0;
for (const n of ["Area18", "Lorville", "New Babbage", "Orison", "Everus Harbor", "Port Tressler"]) {
  const l = byName(n);
  const ok = !!l;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n.padEnd(16)} ${ok ? `${l.type ?? "?"} / ${l.parentName ?? "?"} / code=${l.code ?? "-"}` : "(not found)"}`);
}
// The alias forms actually observed in a real game.log. These are the whole reason the
// table exists, so they are checked by name.
for (const code of ["stanton3_area18", "stanton1_lorville", "stanton4_newbabbage"]) {
  const hit = aliases[code];
  const ok = !!hit?.length;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} alias ${code.padEnd(22)} ${ok ? hit.map((u) => locations[u].name).join(", ") : "(unresolved)"}`);
}
if (!payload.locationCount) { console.error("[locations] empty dataset"); process.exit(1); }
if (bad) { console.error(`[locations] ${bad} check(s) failed — dataset NOT trustworthy`); process.exit(1); }
