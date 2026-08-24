/**
 * gemmass — DOES A COMMODITY'S SALE PRICE DEPEND ON THE MASS OF THE ITEM SOLD?
 *
 * Read-only probe over the EXTRACTED datacore (no p4k extraction — the retained 4.10 PTU drop
 * already carries every record this needs, unforged to plain direct-attribute XML).
 *
 * It answers the datacore half of the question by enumerating every commodity CARRYABLE entity
 * class and printing, per commodity, the fields that could possibly carry a mass or a variable
 * per-unit value:
 *
 *   Mass                             SEntityRigidPhysicsControllerParams/@Mass
 *   capacity SCU                     ResourceContainer/capacity/SStandardCargoUnit
 *   occupancy SCU                    AttachDef/inventoryOccupancyVolume/SStandardCargoUnit
 *   defaultCompositionFillFactor     ResourceContainer/@defaultCompositionFillFactor
 *   generateRandomQuality            ResourceContainer/@generateRandomQuality
 *   immutable / mutabilityLevel      ResourceContainer/@immutable, @mutabilityLevel
 *   composition entries              ResourceContainerDefaultCompositionEntry/@entry,@weight
 *
 * 🔴 THE MEASUREMENT IS NEGATIVE-CONTROLLED, and the control runs every time (`--control`).
 * A silently-failing regex over 61,848 XML files produces a confident, precise, wrong number, and
 * a number in a strip becomes a product decision. So the probe refuses to report at all unless it
 * can first reproduce, from the files, a set of values established by hand:
 *
 *   - the 1 SCU Lindinium box has Mass exactly 1266
 *   - the eighth-SCU Lindinium hand carryable has Mass exactly 78 and capacity exactly 0.125
 *   - both name resource 392b4dca-449a-4d4d-8fef-beab024d9ee7 (the GUID the shared logs carry)
 *
 * If any of those three drift, every other number here is suspect and the probe exits non-zero
 * rather than printing a table nobody can trust.
 *
 * Usage:
 *   npx tsx tools/probe-gemmass.ts                 # default mirror version
 *   npx tsx tools/probe-gemmass.ts --version <code>
 *   npx tsx tools/probe-gemmass.ts --control       # run the hand-checked control only
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIRROR = "C:/Users/subli/SC-Data-Mirror/versions";
const DEFAULT_VERSION = "4.10.0-PTU.12479687";

/** The resourceGUID the shared logs carry for Lindinium. Established from the log, not guessed. */
const LINDINIUM_RESOURCE = "392b4dca-449a-4d4d-8fef-beab024d9ee7";

/** The eight commodities the empty-manifest sell population is dominated by. */
const GEMS = ["hadanite", "sadaryx", "dolivine", "beradom", "glacosite", "feynmaline",
  "aphorite", "beryl"];
/** Contrast controls: ordinary cargo. If a "gem signal" shows here too, it is not the signal. */
const ORDINARY = ["titanium", "agricium", "laranite", "quantanium", "aluminum", "tungsten"];

interface Carryable {
  file: string;
  family: "1h" | "2h" | "tractorbeamonly";
  cls: string;
  commodity: string;
  mass: number | null;
  capacityScu: number | null;
  occupancyScu: number | null;
  fillFactor: number | null;
  randomQuality: string | null;
  immutable: string | null;
  mutability: string | null;
  composition: { entry: string; weight: string }[];
  locName: string | null;
}

function attr(s: string, name: string): string | null {
  const m = s.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}
function num(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** The `<ResourceContainer ...> ... </ResourceContainer>` block, or "" when the entity has none. */
function resourceContainerBlock(xml: string): string {
  const i = xml.indexOf("<ResourceContainer ");
  if (i < 0) return "";
  const j = xml.indexOf("</ResourceContainer>", i);
  return j < 0 ? xml.slice(i) : xml.slice(i, j);
}

/** The `<inventoryOccupancyVolume> ... </inventoryOccupancyVolume>` block. */
function occupancyBlock(xml: string): string {
  const i = xml.indexOf("<inventoryOccupancyVolume>");
  if (i < 0) return "";
  const j = xml.indexOf("</inventoryOccupancyVolume>", i);
  return j < 0 ? "" : xml.slice(i, j);
}

function parseCarryable(file: string, family: Carryable["family"], xml: string): Carryable {
  const rc = resourceContainerBlock(xml);
  const occ = occupancyBlock(xml);

  // Mass lives on the rigid-body params, which appear once per entity.
  const physI = xml.indexOf("<SEntityRigidPhysicsControllerParams ");
  const phys = physI < 0 ? "" : xml.slice(physI, physI + 400);

  const clsM = xml.match(/^<EntityClassDefinition\.([A-Za-z0-9_]+)/);
  const cls = clsM ? clsM[1] : "(unparsed)";

  const composition: { entry: string; weight: string }[] = [];
  for (const m of rc.matchAll(/<ResourceContainerDefaultCompositionEntry\s+([^/>]*)\/>/g)) {
    composition.push({ entry: attr(m[1], "entry") ?? "?", weight: attr(m[1], "weight") ?? "?" });
  }

  // The commodity token is the tail of the class name after the size/type prefix.
  const lower = cls.toLowerCase();
  const cm = lower.match(/commodity_(?:metal_|mineral_|gas_|agricultural_)?(?:ore_)?([a-z0-9]+)$/);

  return {
    file, family, cls,
    commodity: cm ? cm[1] : lower.split("_").pop() ?? lower,
    mass: num(attr(phys, "Mass")),
    capacityScu: num(attr(rc.slice(0, rc.indexOf("</capacity>") + 1 || rc.length),
      "standardCargoUnits")),
    occupancyScu: num(attr(occ, "standardCargoUnits")),
    fillFactor: num(attr(rc.slice(0, rc.indexOf(">")), "defaultCompositionFillFactor")),
    randomQuality: attr(rc.slice(0, rc.indexOf(">")), "generateRandomQuality"),
    immutable: attr(rc.slice(0, rc.indexOf(">")), "immutable"),
    mutability: attr(rc.slice(0, rc.indexOf(">")), "mutabilityLevel"),
    composition,
    locName: attr(xml, "Name"),
  };
}

function collect(version: string): Carryable[] {
  const root = join(MIRROR, version, "_work/raw/Data/Libs/Foundry/Records/entities/scitem/carryables");
  if (!existsSync(root)) {
    console.error(`carryables tree not found: ${root}`);
    process.exit(2);
  }
  const out: Carryable[] = [];
  for (const family of ["1h", "2h", "tractorbeamonly"] as const) {
    const dir = join(root, family);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".xml")) continue;
      const file = join(dir, name);
      let xml: string;
      try { xml = readFileSync(file, "utf8"); } catch { continue; }
      out.push(parseCarryable(file, family, xml));
    }
  }
  return out;
}

/**
 * 🔴 THE NEGATIVE CONTROL. Values established by reading three files end to end by hand.
 * Everything this probe prints rests on the same extractors these assertions exercise, so a
 * regex that silently stops matching fails HERE rather than in the middle of a table.
 */
function control(all: Carryable[]): boolean {
  let ok = true;
  const say = (pass: boolean, what: string, detail: string) => {
    if (!pass) ok = false;
    console.log(`  ${pass ? "ok  " : "FAIL"}  ${what}  [${detail}]`);
  };

  console.log("negative control — hand-checked values re-derived from the files:");

  const box1 = all.find(c => c.cls.toLowerCase() === "carryable_tbo_fl_1scu_commodity_metal_lindinium");
  say(!!box1, "the 1 SCU Lindinium box record was found", box1 ? box1.cls : "NOT FOUND");
  say(box1?.mass === 1266, "its Mass is 1266", String(box1?.mass));
  say(box1?.capacityScu === 1, "its ResourceContainer capacity is 1 SCU", String(box1?.capacityScu));
  say(box1?.composition[0]?.entry === LINDINIUM_RESOURCE,
    "it names the shared-log resourceGUID", box1?.composition[0]?.entry ?? "none");

  const hand = all.find(c => c.cls.toLowerCase()
    === "carryable_2h_fl_eighthscu_commodity_metal_lindinium");
  say(!!hand, "the eighth-SCU Lindinium hand carryable was found", hand ? hand.cls : "NOT FOUND");
  say(hand?.mass === 78, "its Mass is 78", String(hand?.mass));
  say(hand?.capacityScu === 0.125, "its capacity is 0.125 SCU", String(hand?.capacityScu));
  say(hand?.composition[0]?.entry === LINDINIUM_RESOURCE,
    "it names the same resourceGUID as the box", hand?.composition[0]?.entry ?? "none");

  // A positive control on the CORPUS, not just on two records: if the walk collapsed to almost
  // nothing, every "no commodity has X" line below would be free.
  say(all.length > 200, "the carryable walk found a populated corpus", `${all.length} entities`);
  const withRc = all.filter(c => c.capacityScu !== null).length;
  say(withRc > 100, "and most of them really do carry a ResourceContainer", `${withRc} with capacity`);

  return ok;
}

function main(): void {
  const vi = process.argv.indexOf("--version");
  const version = vi >= 0 ? process.argv[vi + 1] : DEFAULT_VERSION;
  console.log(`gemmass — datacore probe over ${version}\n`);

  const all = collect(version);
  const passed = control(all);
  console.log("");
  if (!passed) {
    console.error("CONTROL FAILED — the extractors no longer reproduce hand-checked values.");
    console.error("Every number this probe would print is suspect. Refusing to print a table.");
    process.exit(1);
  }
  if (process.argv.includes("--control")) return;

  const commodities = new Map<string, Carryable[]>();
  for (const c of all) {
    if (!commodities.has(c.commodity)) commodities.set(c.commodity, []);
    commodities.get(c.commodity)!.push(c);
  }

  // ---- Q1: is there a mass, a mass RANGE, or a varying per-unit value? ----
  console.log("=== Q1  mass, and whether it varies ===");
  const massBearing = all.filter(c => c.mass !== null);
  console.log(`entities carrying a Mass attribute: ${massBearing.length} of ${all.length}`);
  const rangeAttrs = new Set<string>();
  for (const c of all) {
    const xml = readFileSync(c.file, "utf8");
    for (const m of xml.matchAll(/\b(min|max)([A-Za-z]*[Mm]ass[A-Za-z]*)="/g)) {
      rangeAttrs.add(m[1] + m[2]);
    }
  }
  console.log(`mass RANGE attributes (min*Mass / max*Mass) anywhere in these records: ` +
    `${rangeAttrs.size === 0 ? "NONE" : [...rangeAttrs].join(", ")}`);

  // Mass per SCU, per commodity, per family — a constant here means mass is derived from volume.
  console.log("\nmass per SCU (capacity), by commodity and carry family:");
  const interesting = [...GEMS, "lindinium", ...ORDINARY];
  for (const name of interesting) {
    const rows = commodities.get(name) ?? [];
    if (!rows.length) { console.log(`  ${name.padEnd(12)} (no carryable entities found)`); continue; }
    const byFam = new Map<string, number[]>();
    for (const r of rows) {
      if (r.mass === null || !r.capacityScu) continue;
      const k = r.family;
      if (!byFam.has(k)) byFam.set(k, []);
      byFam.get(k)!.push(r.mass / r.capacityScu);
    }
    const parts: string[] = [];
    for (const [fam, vals] of byFam) {
      const lo = Math.min(...vals), hi = Math.max(...vals);
      parts.push(`${fam}=${lo.toFixed(1)}${hi - lo > 0.5 ? `..${hi.toFixed(1)}` : ""}`);
    }
    console.log(`  ${name.padEnd(12)} ${parts.join("  ")}`);
  }

  // ---- Q2: is there a "sold by SCU" vs "sold by unit/mass" flag? ----
  console.log("\n=== Q2  any flag distinguishing sold-by-SCU from sold-by-unit ===");
  const flagVals = new Map<string, Set<string>>();
  for (const c of all) {
    for (const [k, v] of [
      ["generateRandomQuality", c.randomQuality],
      ["defaultCompositionFillFactor", c.fillFactor === null ? null : String(c.fillFactor)],
      ["immutable", c.immutable],
      ["mutabilityLevel", c.mutability],
    ] as const) {
      if (v === null) continue;
      if (!flagVals.has(k)) flagVals.set(k, new Set());
      flagVals.get(k)!.add(v);
    }
  }
  for (const [k, v] of flagVals) {
    console.log(`  ${k.padEnd(30)} distinct values across all commodity carryables: ${[...v].join(", ")}`);
  }

  // ---- Q3: does the gem/ordinary split show up anywhere? ----
  console.log("\n=== Q3  gems vs ordinary cargo — carry families and SCU sizes ===");
  const show = (label: string, names: string[]) => {
    console.log(`  -- ${label} --`);
    for (const name of names) {
      const rows = commodities.get(name) ?? [];
      const fams = new Map<string, number[]>();
      for (const r of rows) {
        if (!fams.has(r.family)) fams.set(r.family, []);
        if (r.capacityScu !== null) fams.get(r.family)!.push(r.capacityScu);
      }
      const desc = [...fams].map(([f, s]) =>
        `${f}[${[...new Set(s)].sort((a, b) => a - b).join(",")}]`).join(" ");
      console.log(`     ${name.padEnd(12)} ${rows.length.toString().padStart(3)} entities  ${desc}`);
    }
  };
  show("gems (dominate the empty-manifest population)", GEMS);
  show("Lindinium (the commodity in the evidence)", ["lindinium"]);
  show("ordinary cargo (contrast control)", ORDINARY);

  // Which commodities have a sub-1-SCU carryable at all? That is the closest thing to a
  // "sold as a unit rather than by the SCU" signal the entity data has.
  console.log("\n  commodities with a sub-1-SCU carryable (hand-carried unit):");
  const subScu = new Map<string, number[]>();
  for (const c of all) {
    if (c.capacityScu !== null && c.capacityScu < 1) {
      if (!subScu.has(c.commodity)) subScu.set(c.commodity, []);
      subScu.get(c.commodity)!.push(c.capacityScu);
    }
  }
  const names = [...subScu.keys()].sort();
  console.log(`     ${names.length} commodities: ${names.join(", ")}`);
  console.log(`     of the 8 gems, ${GEMS.filter(g => subScu.has(g)).length} have one`);
  console.log(`     of the ${ORDINARY.length} ordinary controls, ` +
    `${ORDINARY.filter(o => subScu.has(o)).length} have one` +
    ` (${ORDINARY.filter(o => subScu.has(o)).join(", ") || "none"})`);
}

main();
