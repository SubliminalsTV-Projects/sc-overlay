// Build data/hauling-orders.json (sc-hauling-orders/1) — what a hauling contract asks you
// to carry, known from its contract key alone.
//
// 🔑 WHY THIS EXISTS. The log's `"New Objective: Deliver 0/N SCU of <C> to <D>"` line is the
// natural source for a contract's cargo, but it only fires for contracts the player has
// TRACKED in mobiGlas. This dataset is the cross-check for tracked contracts and the
// fallback for untracked ones: given the mission key that `CLocalMissionPhaseMarker::
// CreateMarker` always emits, it says which commodity, how much, and — critically for the
// packer — the largest box the contract will ever hand you.
//
// ── Two sources, merged ────────────────────────────────────────────────────
//   1. contracts/ (the contract generator, via the mirror's processed JSON) — 1,109
//      hauling contracts with resolved `HaulingOrders[]`. Richer: carries the resource
//      UUID and per-order SCU ranges. This is the primary.
//   2. missionbroker/pu_missions/cargo/*.xml — 869 records carrying the same
//      `maxContainerSize`/`minSCU`/`maxSCU` attributes. Used to fill gaps.
//
// Both key on the same string: the contract's DebugName / MissionBrokerEntry root tag
// (`HaulCargo_AToB_Gas_Hydrogen_Stanton1`). That is deliberate — it is the same key
// `data/mission-facts.latest.json` uses (1,101 of 1,109 hauling contracts join it), so a
// consumer gets expected duration and difficulty from that file for free.
//
// Usage: node tools/build-hauling-orders.mjs [<mirror version dir>] [<out.json>]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const MIRROR_ROOT = "C:/Users/subli/SC-Data-Mirror/versions";
const CELL = 1.25;

function newestVersionDir() {
  const dirs = readdirSync(MIRROR_ROOT).filter((d) => statSync(join(MIRROR_ROOT, d)).isDirectory());
  if (!dirs.length) throw new Error(`no version dirs under ${MIRROR_ROOT}`);
  return dirs.sort((a, b) => (Number(a.split(".").pop()) || 0) - (Number(b.split(".").pop()) || 0)).pop();
}

const versionDir = process.argv[2] || join(MIRROR_ROOT, newestVersionDir());
const outPath = process.argv[3] || join(process.cwd(), "data", "hauling-orders.json");
const work = join(versionDir, "_work");
const contractsDir = join(work, "processed", "contracts");
const itemsDir = join(work, "processed", "items");
const recordsDir = join(work, "raw", "Data", "Libs", "Foundry", "Records");
const brokerDir = join(recordsDir, "missionbroker", "pu_missions", "cargo");
const loadingParams = join(recordsDir, "globalcargoloadingparams", "globalcargoloadingdata.xml");

for (const p of [contractsDir, itemsDir]) {
  if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(1); }
}
const version = versionDir.split(/[\\/]/).filter(Boolean).pop();

// ── 1. The canonical box set ───────────────────────────────────────────────
// 🔴 THIS IS THE ANSWER TO THE 24-vs-32 QUESTION, shipped as data so nothing downstream
// has to hardcode it or re-argue it. Both sizes are real. They just belong to different
// contract types, which is why two people who fly different missions both "knew" the
// other was wrong: 24 SCU appears ONLY in Hauling - Interstellar contracts, while 32 SCU
// is the workhorse of Hauling - Stellar.
//
// Geometry comes from the box entities' own `inventoryOccupancyDimensions`; the size list
// is cross-checked against `globalcargoloadingdata.xml`, whose per-size load-time
// attributes (`oneSCU`, ..., `twentyFourSCU`, `thirtyTwoSCU`) are CIG's own enumeration
// of every box the auto-loader knows.
const BOX_SIZES = [1, 2, 4, 8, 16, 24, 32];
const boxes = {};
for (const scu of BOX_SIZES) {
  // Any commodity of that size will do — the crate geometry is per-size, not per-commodity.
  const f = readdirSync(itemsDir).find((n) => n.includes(`_${scu}scu_commodity`) && n.endsWith(".json"));
  if (!f) { console.warn(`[hauling] no ${scu} SCU box entity found`); continue; }
  const txt = readFileSync(join(itemsDir, f), "utf8");
  const m = txt.match(/"inventoryOccupancyDimensions":\s*\{[^}]*\}/);
  if (!m) { console.warn(`[hauling] ${scu} SCU box has no occupancy dimensions`); continue; }
  const d = JSON.parse(`{${m[0]}}`).inventoryOccupancyDimensions;
  boxes[scu] = { scu, x: Math.round(d.x / CELL), y: Math.round(d.y / CELL), z: Math.round(d.z / CELL) };
}
// Cross-check against the engine's own size enum, so a patch that adds a size (or drops
// one) shows up here instead of silently producing an under-specified packer.
if (existsSync(loadingParams)) {
  const xml = readFileSync(loadingParams, "utf8");
  const tag = xml.match(/<autoLoadingBoxSizeLoadingTime\b[^>]*>/)?.[0] ?? "";
  const WORD = { one: 1, two: 2, four: 4, eight: 8, sixteen: 16, twentyFour: 24, thirtyTwo: 32 };
  const declared = [...tag.matchAll(/\b([a-zA-Z]+)SCU="/g)].map((m) => WORD[m[1]]).filter(Boolean);
  const missing = declared.filter((s) => !boxes[s]);
  const extra = BOX_SIZES.filter((s) => !declared.includes(s));
  if (missing.length || extra.length) {
    console.warn(`[hauling] ⚠️ box set drift — engine declares ${declared.join(",")}; we ship ${Object.keys(boxes).join(",")}`);
  } else {
    console.log(`[hauling] box set agrees with the engine enum: ${declared.join(", ")} SCU`);
  }
}

// ── 2. Commodity names ─────────────────────────────────────────────────────
// Reuse the app's own bundled commodity map rather than shipping a second name table that
// can drift away from it. The resource UUID on a hauling order IS the commodity UUID.
let commodityName = () => null;
try {
  const c = JSON.parse(readFileSync(join(process.cwd(), "data", "commodities.json"), "utf8"));
  commodityName = (uuid) => c.commodities?.[uuid]?.name ?? null;
} catch {
  console.warn("[hauling] data/commodities.json unreadable — orders will carry UUIDs only");
}

// ── 3. Contract generator (primary) ────────────────────────────────────────
const contracts = {};
let scanned = 0, unnamed = 0;

// ⚠️ Fields are OMITTED rather than written as null. `-1` means "no cap" and `0` means
// "does not apply to this order kind"; both are sentinels, and writing them through as
// null invites a consumer to read a 0 SCU box out of them. Absent means unknown — the
// caller falls back to the tracked objective line. Omitting also keeps ~150 KB out of a
// file that ships inside the installer.
const order = (o) => {
  const out = { kind: o.Kind ?? null };
  if (o.UUID) { out.resource = o.UUID; out.commodity = commodityName(o.UUID); }
  if (o.MaxContainerSize > 0) out.maxContainerSize = o.MaxContainerSize;
  if (o.MinScu > 0) out.minScu = o.MinScu;
  if (o.MaxScu > 0) out.maxScu = o.MaxScu;
  if (o.MinAmount > 0) out.minAmount = o.MinAmount;
  if (o.MaxAmount > 0) out.maxAmount = o.MaxAmount;
  return out;
};

for (const f of readdirSync(contractsDir)) {
  if (!f.endsWith(".json")) continue;
  const txt = readFileSync(join(contractsDir, f), "utf8");
  if (!txt.includes('"HaulingOrders"')) continue;
  let j;
  try { j = JSON.parse(txt); } catch { continue; }
  if (!Array.isArray(j.HaulingOrders) || !j.HaulingOrders.length) continue;
  scanned++;
  if (!j.DebugName) { unnamed++; continue; }
  contracts[j.DebugName] = {
    missionType: j.MissionType?.Name ?? null,
    giver: j.MissionGiver ?? null,
    orders: j.HaulingOrders.map(order),
    source: "contracts",
  };
}
console.log(`[hauling] ${Object.keys(contracts).length} contracts from the contract generator (${scanned} scanned, ${unnamed} unnamed)`);

// ── 4. Mission broker (fill) ───────────────────────────────────────────────
// Same attributes, different tree. Adds keys the generator does not carry and fills
// orders where the generator recorded only sentinels.
const num = (s, n) => { const m = s.match(new RegExp(`\\b${n}="([^"]*)"`)); return m ? Number(m[1]) : NaN; };
let brokerAdded = 0, brokerFilled = 0;
if (existsSync(brokerDir)) {
  for (const f of readdirSync(brokerDir)) {
    if (!f.endsWith(".xml")) continue;
    const xml = readFileSync(join(brokerDir, f), "utf8");
    const key = xml.match(/<MissionBrokerEntry\.([A-Za-z0-9_]+)/)?.[1];
    if (!key) continue;
    // ⚠️ The tag here is `<HaulingOrder_Resource>` / `<HaulingOrder_DropOff>` — NOT the
    // `HaulingOrderContent_*` spelling used over in contracts/contractgenerator/. Two
    // trees, two names for the same idea. Matching the wrong one fails silently (empty
    // order list, "0 contracts added"), which is why the counts below are logged.
    const orders = [];
    for (const m of xml.matchAll(/<HaulingOrder_([A-Za-z]+)\b[^>]*>/g)) {
      const mcs = num(m[0], "maxContainerSize"), lo = num(m[0], "minSCU"), hi = num(m[0], "maxSCU");
      const res = m[0].match(/\bresource="([0-9a-f-]{36})"/)?.[1] ?? null;
      const o = { kind: m[1] };
      if (res) { o.resource = res; o.commodity = commodityName(res); }
      if (mcs > 0) o.maxContainerSize = mcs;
      if (lo > 0) o.minScu = lo;
      if (hi > 0) o.maxScu = hi;
      orders.push(o);
    }
    if (!orders.length) continue;
    const existing = contracts[key];
    if (!existing) {
      contracts[key] = { missionType: null, giver: null, orders, source: "missionbroker" };
      brokerAdded++;
    } else if (existing.orders.every((o) => o.maxContainerSize === undefined) && orders.some((o) => o.maxContainerSize != null)) {
      // The generator recorded no cap for any order but the broker does — take the
      // broker's, and say so, because the two trees genuinely disagree here.
      existing.orders = orders;
      existing.source = "contracts+missionbroker";
      brokerFilled++;
    }
  }
}
console.log(`[hauling] mission broker: ${brokerAdded} contracts added, ${brokerFilled} filled a missing container cap`);

// ── 5. Emit ────────────────────────────────────────────────────────────────
const all = Object.values(contracts);
const capCounts = {};
for (const c of all) for (const o of c.orders) if (o.maxContainerSize) capCounts[o.maxContainerSize] = (capCounts[o.maxContainerSize] ?? 0) + 1;

const payload = {
  schema: "sc-hauling-orders/1",
  version,
  contractCount: all.length,
  /** Every cargo box size in the game, with its footprint in CELLS (1 cell = 1.25 m).
   *  `maxContainerSize` on an order indexes into this. */
  boxes,
  contracts,
};
writeFileSync(outPath, JSON.stringify(payload));
console.log(`[hauling] ${payload.contractCount} contracts -> ${outPath} (${(readFileSync(outPath).length / 1024).toFixed(0)} KB)`);
console.log(`[hauling] container caps in use: ${Object.entries(capCounts).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}SCU x${v}`).join(", ")}`);

// ── 6. Self-check ──────────────────────────────────────────────────────────
// The box geometry is the packer's core input; a silent change here would be invisible
// until layouts started coming out wrong.
const EXPECT_BOX = { 1: "1x1x1", 2: "1x2x1", 4: "2x2x1", 8: "2x2x2", 16: "2x4x2", 24: "2x6x2", 32: "2x8x2" };
let bad = 0;
for (const [scu, want] of Object.entries(EXPECT_BOX)) {
  const b = boxes[scu];
  const got = b ? `${b.x}x${b.y}x${b.z}` : "(missing)";
  if (got !== want) bad++;
  console.log(`  ${got === want ? "ok  " : "FAIL"} ${String(scu).padStart(2)} SCU box  ${got.padEnd(8)} (expect ${want})`);
}
if (!all.length) { console.error("[hauling] no contracts extracted"); process.exit(1); }
if (bad) { console.error(`[hauling] ${bad} box size(s) wrong — dataset NOT trustworthy`); process.exit(1); }
