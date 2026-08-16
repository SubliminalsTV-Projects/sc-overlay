// The stowage brain: where every box goes, and in what order to lift it.
//
//   npx tsx src/cargo-stow.test.ts
//
// The graded property is HANDLING, never density. A layout that uses less hold but buries the first
// drop-off is a worse layout, and several tests below assert exactly that.

import { join } from "node:path";
import { expandPartition, partitionScu, type BoxSpec } from "./cargo-boxes.js";
import type { GridSpec } from "./cargo-pack.js";
import {
  boxSignature,
  buildLifts,
  planStowage,
  stowFromPlan,
  type StowBox,
  type StowLeg,
  type StowPlacement,
  type StowPlan,
} from "./cargo-stow.js";
import { A2_GRIDS, C2_GRIDS, SIX_CONTRACTS } from "./hauling-fixtures.js";
import { HaulingDataStore } from "./hauling-data.js";
import { HaulingTracker } from "./hauling.js";
import { HAUL_SCENARIOS, haulReplayLines } from "./dev-replay.js";
import { boxSetFrom, buildHaulingPlan } from "./hauling-plan.js";
import { parseLine } from "./parser.js";
import { parseMissionEvent } from "./missions-parser.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

// ── the canonical box table, straight off `data/hauling-orders.json` ───────
// Y-MAJOR, and that matters: grids carry asymmetric maxBox caps (the C2's small grid is x:6, y:8),
// so a box's axes decide whether it is legal there.
const BOXES: Record<number, StowBox> = {
  1: { scu: 1, dims: [1, 1, 1] },
  2: { scu: 2, dims: [1, 2, 1] },
  4: { scu: 4, dims: [2, 2, 1] },
  8: { scu: 8, dims: [2, 2, 2] },
  16: { scu: 16, dims: [2, 4, 2] },
  24: { scu: 24, dims: [2, 6, 2] },
  32: { scu: 32, dims: [2, 8, 2] },
};
const BOX_SET: readonly BoxSpec[] = Object.values(BOXES).map((b) => ({ ...b, confidence: "confirmed" as const }));

/** Split an SCU total the way the game does and hand back physical boxes. */
const split = (scu: number, cap: number): StowBox[] =>
  expandPartition(partitionScu(scu, cap, BOX_SET)).map((b) => ({ scu: b.scu, dims: b.dims }));

const leg = (missionId: string, dest: string, commodity: string, scu: number, cap: number, n = 0): StowLeg => ({
  group: `${missionId}#${n}`,
  missionId,
  destination: dest,
  commodity,
  boxes: split(scu, cap),
});

// Real hulls, verbatim from `data/ships.json`.
const HULL_C_GRIDS: GridSpec[] = Array.from({ length: 16 }, (_, i) => ({
  name: `bay ${i + 1}`,
  w: 8,
  l: 8,
  h: 6,
  maxBox: { x: 2, y: 8, z: 2 },
}));

// ── invariants every layout must satisfy ───────────────────────────────────

function violations(grids: readonly GridSpec[], plan: StowPlan): string[] {
  const bad: string[] = [];
  const cells = new Map<string, string>();
  for (const p of plan.placements) {
    const g = grids[p.gridIndex];
    if (!g) {
      bad.push(`${p.boxId}: grid index ${p.gridIndex} does not exist`);
      continue;
    }
    if (p.x < 0 || p.y < 0 || p.z < 0 || p.x + p.dx > g.w || p.y + p.dy > g.l || p.z + p.dz > g.h) {
      bad.push(`${p.boxId}: out of bounds at ${p.x},${p.y},${p.z} +${p.dx}x${p.dy}x${p.dz} in ${g.name}`);
      continue;
    }
    if (p.dx * p.dy * p.dz !== p.scu) bad.push(`${p.boxId}: ${p.dx}x${p.dy}x${p.dz} is not ${p.scu} SCU`);
    const cap = g.maxBox;
    if (cap && (p.dx > cap.x || p.dy > cap.y || p.dz > cap.z)) {
      bad.push(`${p.boxId}: ${p.dx}x${p.dy}x${p.dz} breaks ${g.name}'s cap ${cap.x}x${cap.y}x${cap.z}`);
    }
    for (let x = p.x; x < p.x + p.dx; x++)
      for (let y = p.y; y < p.y + p.dy; y++)
        for (let z = p.z; z < p.z + p.dz; z++) {
          const key = `${p.gridIndex}|${x},${y},${z}`;
          const owner = cells.get(key);
          if (owner) bad.push(`${p.boxId} overlaps ${owner} at ${key}`);
          else cells.set(key, p.boxId);
        }
  }
  // Nothing rests on thin air. Partial overhang is allowed — the grid snaps and holds it — so the
  // rule is "something underneath", not "everything underneath".
  for (const p of plan.placements) {
    if (p.z === 0) continue;
    let held = false;
    for (let x = p.x; x < p.x + p.dx && !held; x++)
      for (let y = p.y; y < p.y + p.dy && !held; y++)
        if (cells.has(`${p.gridIndex}|${x},${y},${p.z - 1}`)) held = true;
    if (!held) bad.push(`${p.boxId}: resting on nothing at ${p.x},${p.y},${p.z}`);
  }
  return bad;
}

/** Does any box sit on top of a DIFFERENT mission's box? That is burial, and it is the thing the
 *  objective exists to avoid. (A mission stacked on itself is fine — you lift it as one job.) */
function buries(placements: readonly StowPlacement[]): string[] {
  const cells = new Map<string, StowPlacement>();
  for (const p of placements)
    for (let x = p.x; x < p.x + p.dx; x++)
      for (let y = p.y; y < p.y + p.dy; y++)
        for (let z = p.z; z < p.z + p.dz; z++) cells.set(`${p.gridIndex}|${x},${y},${z}`, p);
  const out: string[] = [];
  for (const p of placements) {
    if (p.z === 0) continue;
    for (let x = p.x; x < p.x + p.dx; x++)
      for (let y = p.y; y < p.y + p.dy; y++) {
        const under = cells.get(`${p.gridIndex}|${x},${y},${p.z - 1}`);
        if (under && under.missionId !== p.missionId) out.push(`${p.boxId} sits on ${under.boxId}`);
      }
  }
  return out;
}

/** Bounding box of a mission's cargo within one grid. */
function extent(placements: readonly StowPlacement[], missionId: string, gridIndex: number) {
  const own = placements.filter((p) => p.missionId === missionId && p.gridIndex === gridIndex);
  if (!own.length) return null;
  return {
    x0: Math.min(...own.map((p) => p.x)),
    x1: Math.max(...own.map((p) => p.x + p.dx)),
    y0: Math.min(...own.map((p) => p.y)),
    y1: Math.max(...own.map((p) => p.y + p.dy)),
    z0: Math.min(...own.map((p) => p.z)),
    z1: Math.max(...own.map((p) => p.z + p.dz)),
  };
}

const disjoint = (a: ReturnType<typeof extent>, b: ReturnType<typeof extent>): boolean => {
  if (!a || !b) return true;
  return a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0 || a.z1 <= b.z0 || b.z1 <= a.z0;
};

// ══ 1. auto-load ships need no plan at all ═════════════════════════════════

{
  const legs = [leg("m1", "Riker", "Aluminum", 64, 8)];
  const auto = planStowage(HULL_C_GRIDS, legs, { shipClass: "MISC_Hull_C", shipName: "MISC Hull C" });
  check("an auto-loading hull returns early", auto.autoLoad && auto.placements.length === 0 && auto.loadOrder.length === 0);
  check("…and says why, rather than showing an empty diagram", /auto-load/i.test(auto.handling.reason), auto.handling.reason);
  const manual = planStowage(C2_GRIDS, legs, { shipClass: "CRUS_Starlifter_C2" });
  check("a C2 does not auto-load, so it gets a plan", !manual.autoLoad && manual.placements.length === 8);
}

// ══ 2. 🔑 THE OBJECTIVE — three small missions in a C2 ═════════════════════
// Sub's exact fear: 72 SCU of cargo in a 696 SCU hold, crammed together for no reason.

{
  const legs = [
    leg("food", "Riker Memorial", "Processed Food", 24, 8),
    leg("alu", "Baijini Point", "Aluminum", 16, 4),
    leg("stims", "SAL-5", "Stims", 32, 8),
  ];
  const plan = planStowage(C2_GRIDS, legs, { shipClass: "CRUS_Starlifter_C2" });
  check("three small missions in a C2: layout is physically legal", violations(C2_GRIDS, plan).length === 0, violations(C2_GRIDS, plan)[0] ?? "");
  check("…everything fits", plan.fits && plan.loadedScu === 72);
  check("🔑 …and NOTHING has to be moved to reach anything", plan.handling.moves === 0, `moves=${plan.handling.moves} via ${plan.handling.strategy}`);
  check("…so the verdict is 'spread'", plan.handling.verdict === "spread", plan.handling.reason);
  check("…the widget can say why", /spare/.test(plan.handling.reason), plan.handling.reason);

  const [a, b, c] = ["food", "alu", "stims"].map((m) => extent(plan.placements, m, 0));
  check("…the three missions occupy separate slabs of hold", disjoint(a, b) && disjoint(b, c) && disjoint(a, c));
  check("…with 624 SCU still spare", plan.handling.slackScu === 624, String(plan.handling.slackScu));
  // Not sardine-packed: no mission is standing on another one, and nothing built a second storey
  // it did not need with 624 SCU of floor going spare.
  check("…no mission is stacked on another", buries(plan.placements).length === 0, buries(plan.placements)[0] ?? "");
  check("…and nothing touches anything belonging to another mission", plan.handling.strategy.includes("gap"), `strategy=${plan.handling.strategy}`);
}

// ══ 3. a nearly-full load collapses to dense LIFO ══════════════════════════
// The brief expected this to start costing shuffling. It does not, and that is worth pinning down:
// the hold is only two levels deep, so filling it back-to-front in load order leaves the first
// drop-off on top at the ramp and the last one at the bottom of the back. Perfect LIFO survives a
// full ship. What breaks it is test 3b, not fullness.

{
  const legs = [
    leg("m1", "Riker Memorial", "Titanium", 160, 32),
    leg("m2", "Baijini Point", "Aluminum", 160, 32),
    leg("m3", "SAL-5", "Stims", 128, 16),
    leg("m4", "SAL-2", "Waste", 128, 16),
  ];
  const plan = planStowage(C2_GRIDS, legs, { shipClass: "CRUS_Starlifter_C2" });
  check("576 SCU into a 696 SCU C2: layout is physically legal", violations(C2_GRIDS, plan).length === 0, violations(C2_GRIDS, plan)[0] ?? "");
  check("…everything fits", plan.fits && plan.loadedScu === 576, `${plan.loadedScu} SCU, ${plan.unplaced.length} unplaced`);
  check("…separation no longer fits, so a dense layout wins", plan.handling.strategy.startsWith("dense"), plan.handling.strategy);
  check("🔑 …and dense LIFO still buries nothing at 83% full", plan.handling.moves === 0, `${plan.handling.moves} moves via ${plan.handling.strategy}`);
  check("…every stop unloads clean, not just the first", plan.handling.perStop.every((s) => s.moves === 0), JSON.stringify(plan.handling.perStop));
  // The shape that makes it work: first drop-off nearest the ramp, last drop-off deepest.
  const depth = (m: string) => Math.min(...plan.placements.filter((p) => p.missionId === m).map((p) => p.y));
  check("…first drop-off sits nearest the ramp, last one deepest", depth("m1") < depth("m4"), `m1 at y=${depth("m1")}, m4 at y=${depth("m4")}`);
}

// ══ 3b. what ACTUALLY forces shuffling: an interleaved route ═══════════════
// Contract A delivers at stop 1 and stop 3, contract B at stop 2. The freight elevator lifts BY
// MISSION and will not split A across two lifts, so no load order is perfect LIFO for both. This
// is the case the widget has to explain rather than silently produce a worse plan for.

{
  const legs: StowLeg[] = [
    leg("early-and-late", "stop 1", "Titanium", 120, 16, 0),
    leg("middle", "stop 2", "Aluminum", 120, 16, 0),
    { ...leg("early-and-late", "stop 3", "Titanium", 120, 16, 1) },
    leg("last", "stop 4", "Stims", 120, 16, 0),
  ];
  const plan = planStowage(C2_GRIDS, legs, {
    shipClass: "CRUS_Starlifter_C2",
    missionTitles: { "early-and-late": "Multi-drop Titanium", middle: "Aluminum run", last: "Stims run" },
  });
  check("interleaved route: layout is still physically legal", violations(C2_GRIDS, plan).length === 0, violations(C2_GRIDS, plan)[0] ?? "");
  check("…everything fits", plan.fits && plan.loadedScu === 480);
  check("🔑 …but something must be buried, and it says 'tight'", plan.handling.verdict === "tight" && plan.handling.moves > 0, `${plan.handling.moves} moves`);
  check("…and it blames the interleave, not the hold", /either side of another contract/.test(plan.handling.reason), plan.handling.reason);
  check("…naming the contract that causes it", plan.handling.reason.includes("Multi-drop Titanium"), plan.handling.reason);
  check("…and says what would fix it", plan.notes.some((n) => /back to back/.test(n)), plan.notes.join(" | "));
}

// ══ 4. boxes are mission-bound — no consolidation, ever ════════════════════
// Three aluminium contracts to three destinations are three stacks, not one.

{
  const legs = [
    leg("a1", "Riker Memorial", "Aluminum", 32, 8),
    leg("a2", "Baijini Point", "Aluminum", 32, 8),
    leg("a3", "SAL-5", "Aluminum", 32, 8),
  ];
  const plan = planStowage(C2_GRIDS, legs, { shipClass: "CRUS_Starlifter_C2" });
  check("identical commodity, three missions: still three separate stacks", plan.placements.every((p) => p.missionId === p.group.split("#")[0]));
  const groups = new Set(plan.placements.map((p) => p.group));
  check("…three groups, twelve boxes, nothing merged", groups.size === 3 && plan.placements.length === 12);
  const [x, y, z] = ["a1", "a2", "a3"].map((m) => extent(plan.placements, m, 0));
  check("…and they do not share a cell of hold", disjoint(x, y) && disjoint(y, z) && disjoint(x, z));
  check("…nothing has to be moved", plan.handling.moves === 0, `${plan.handling.moves} via ${plan.handling.strategy}`);
}

// ══ 5. LIFO by route order, and the elevator lifts BY MISSION ══════════════

{
  //  route: m1 first, then m2's two stops, then m3.
  const legs: StowLeg[] = [
    leg("m1", "stop A", "Stims", 16, 8),
    { ...leg("m2", "stop B", "Waste", 16, 8, 0) },
    { ...leg("m2", "stop C", "Scrap", 16, 8, 1) },
    leg("m3", "stop D", "Silicon", 16, 8),
  ];
  const lifts = buildLifts(legs);
  check("outer sort is mission, in reverse route order", lifts.map((l) => l.missionId).join(",") === "m3,m2,m1", lifts.map((l) => l.missionId).join(","));
  check("inner sort is that mission's own stops, reversed", lifts[1].legs.map((l) => l.group).join(",") === "m2#1,m2#0");
  check("a mission is never split across two lifts", new Set(lifts.map((l) => l.missionId)).size === lifts.length);

  const plan = planStowage(C2_GRIDS, legs, { shipClass: "CRUS_Starlifter_C2" });
  check("load steps run 1..n with no gaps", plan.loadOrder.map((s) => s.step).join(",") === "1,2,3");
  check("every placement carries the lift it rides", plan.placements.every((p) => p.loadStep === plan.loadOrder.find((s) => s.missionId === p.missionId)!.step));
  check("m2's two drop-offs ride ONE lift", plan.loadOrder.find((s) => s.missionId === "m2")!.destinations.length === 2);
  check("…deepest-loaded first within the lift", plan.loadOrder.find((s) => s.missionId === "m2")!.destinations[0].group === "m2#1");
  check("no stop needs anything moved", plan.handling.moves === 0, `${plan.handling.moves} via ${plan.handling.strategy}`);
}

// ══ 6. 🔴 the elevator cannot name a mission — the box signature ═══════════

{
  check(
    "a signature is commodity plus box configuration",
    boxSignature(["Processed Food"], [{ scu: 8, count: 10 }, { scu: 1, count: 1 }]) === "Processed Food — 10x 8 SCU + 1x 1 SCU",
    boxSignature(["Processed Food"], [{ scu: 8, count: 10 }, { scu: 1, count: 1 }]),
  );
  check(
    "Sub's 81 SCU Stims haul reads back exactly as he described it",
    boxSignature(["Stims"], partitionScu(81, 8, BOX_SET).boxes.map((b) => ({ scu: b.scu, count: b.count }))) ===
      "Stims — 10x 8 SCU + 1x 1 SCU",
  );
  check("a multi-commodity mission names both", boxSignature(["Waste", "Scrap"], [{ scu: 8, count: 11 }]) === "Waste + Scrap — 11x 8 SCU");

  // Every lift carries one.
  const legs = [leg("m1", "Riker", "Stims", 81, 8), leg("m2", "Baijini", "Silicon", 93, 8)];
  const plan = planStowage(C2_GRIDS, legs, { shipClass: "CRUS_Starlifter_C2" });
  check("every load step carries a signature", plan.loadOrder.every((s) => s.signature.length > 0));
  check("…and none of them clash", plan.signatureClashes.length === 0 && plan.loadOrder.every((s) => !s.ambiguous));
}

// ══ 7. ⚠️ two missions that look identical on the elevator ════════════════

{
  // Same commodity, same total, same cap -> the same boxes. The elevator cannot tell them apart,
  // and neither can we; the only honest move is to say so.
  const adjacent = planStowage(
    C2_GRIDS,
    [leg("twinA", "Riker", "Aluminum", 32, 8), leg("twinB", "Baijini", "Aluminum", 32, 8)],
    { shipClass: "CRUS_Starlifter_C2" },
  );
  check("a shared signature is detected", adjacent.signatureClashes.length === 1 && adjacent.signatureClashes[0].missionIds.length === 2, JSON.stringify(adjacent.signatureClashes));
  check("…both lifts are flagged ambiguous", adjacent.loadOrder.every((s) => s.ambiguous && s.ambiguousWith.length === 1));
  check("…back-to-back lifts, so the ORDER does not matter", adjacent.loadOrder.every((s) => !s.orderMatters));
  check("…and it is said out loud", adjacent.notes.some((n) => /identical on the elevator/.test(n)), adjacent.notes.join(" | "));

  // Now separate them in the route, so the player must actually tell them apart before lifting.
  const split3 = planStowage(
    C2_GRIDS,
    [
      leg("twinA", "Riker", "Aluminum", 32, 8),
      leg("other", "SAL-5", "Stims", 24, 8),
      leg("twinB", "Baijini", "Aluminum", 32, 8),
    ],
    { shipClass: "CRUS_Starlifter_C2" },
  );
  const twins = split3.loadOrder.filter((s) => s.ambiguous);
  check("…separated in the load order, the order DOES matter", twins.length === 2 && twins.every((s) => s.orderMatters), JSON.stringify(twins.map((s) => [s.step, s.orderMatters])));
  check("…and the warning is the sharper one", split3.notes.some((n) => n.startsWith("⚠️")), split3.notes.join(" | "));

  // Different box configuration for the same commodity is NOT a clash — that is the whole point of
  // putting the box breakdown in the fingerprint.
  const distinct = planStowage(
    C2_GRIDS,
    [leg("p", "Riker", "Aluminum", 32, 8), leg("q", "Baijini", "Aluminum", 32, 4)],
    { shipClass: "CRUS_Starlifter_C2" },
  );
  check("same commodity, different boxes: told apart", distinct.signatureClashes.length === 0, JSON.stringify(distinct.loadOrder.map((s) => s.signature)));
}

// ══ 8. the interface contract with `stowview` ══════════════════════════════

{
  const plan = planStowage(C2_GRIDS, [leg("m1", "Riker", "Stims", 81, 8)], { shipClass: "CRUS_Starlifter_C2" });
  const p = plan.placements[0];
  const keys = ["boxId", "missionId", "destination", "gridIndex", "x", "y", "z", "scu"];
  check("every agreed field is present on every placement", plan.placements.every((q) => keys.every((k) => k in q)));
  check("…in cell coordinates, integers throughout", plan.placements.every((q) => [q.x, q.y, q.z, q.dx, q.dy, q.dz].every(Number.isInteger)));
  check("…plus the footprint AS PLACED, which the renderer cannot derive from scu alone", "dx" in p && "dy" in p && "dz" in p);
  check("…and grids are addressed by index, matching plan.grids", plan.placements.every((q) => plan.grids[q.gridIndex] !== undefined));
  check("grid usage adds up", plan.grids.reduce((s, g) => s + g.usedScu, 0) === plan.loadedScu);
  check("box ids are unique", new Set(plan.placements.map((q) => q.boxId)).size === plan.placements.length);
  check("the load list references only real boxes", plan.loadOrder.flatMap((s) => s.boxIds).every((id) => plan.placements.some((q) => q.boxId === id)));
  check("…and covers every one of them", new Set(plan.loadOrder.flatMap((s) => s.boxIds)).size === plan.placements.length);
}

// ══ 9. hull shapes the answer — a ship is grids, not a pool of SCU ═════════

{
  const legs = [
    leg("m1", "Riker", "Stims", 48, 8),
    leg("m2", "Baijini", "Waste", 48, 8),
    leg("m3", "SAL-5", "Scrap", 48, 8),
  ];
  // The A2 is ONE grid, 6x18x2 — a single level, so separation has to happen along its length.
  const a2 = planStowage(A2_GRIDS, legs, { shipClass: "RSI_Starlifter_A2" });
  check("A2 (one 6x18x2 grid): legal", violations(A2_GRIDS, a2).length === 0, violations(A2_GRIDS, a2)[0] ?? "");
  check("…everything on the one level", a2.fits && a2.placements.every((p) => p.z === 0));
  check("…and still nothing buried", a2.handling.moves === 0, `${a2.handling.moves} via ${a2.handling.strategy}`);

  // Ironclad Assault: two big grids, so two missions get a bay each and the third shares.
  const IRONCLAD_ASSAULT: GridSpec[] = [
    { name: "hold centre", w: 6, l: 20, h: 6, maxBox: { x: 2, y: 8, z: 2 } },
    { name: "hold", w: 6, l: 20, h: 6, maxBox: { x: 2, y: 8, z: 2 } },
  ];
  const ic = planStowage(IRONCLAD_ASSAULT, legs, { shipClass: "SOMETHING_MANUAL" });
  check("Ironclad Assault (2 grids, 3 missions): legal", violations(IRONCLAD_ASSAULT, ic).length === 0, violations(IRONCLAD_ASSAULT, ic)[0] ?? "");
  check("…nothing buried", ic.handling.moves === 0, `${ic.handling.moves} via ${ic.handling.strategy}`);

  // 🔑 Two grids beat one tall one: the second grid's FLOOR is cheaper to reach than the first
  // grid's shelf, and a packer that fills one grid to the ceiling before touching the next gets
  // this backwards. 144 SCU that would fit in bay 1 alone should not all go into bay 1.
  check("…and the second bay is used rather than stacking the first to the roof", new Set(ic.placements.map((p) => p.gridIndex)).size === 2, JSON.stringify(ic.grids.map((g) => g.usedScu)));
}

// ══ 10. Sub's six real contracts, on the ship he actually flies ════════════

{
  const legs: StowLeg[] = SIX_CONTRACTS.flatMap((c) =>
    c.legs.map((l, i) => ({
      group: `${c.id}#${i}`,
      missionId: c.id,
      destination: l.to,
      commodity: l.commodity,
      boxes: split(l.scu, c.maxContainerScu),
    })),
  );
  const titles = Object.fromEntries(SIX_CONTRACTS.map((c) => [c.id, c.title]));
  const plan = planStowage(C2_GRIDS, legs, { shipClass: "CRUS_Starlifter_C2", missionTitles: titles });

  check("the whole real board: layout is physically legal", violations(C2_GRIDS, plan).length === 0, violations(C2_GRIDS, plan)[0] ?? "");
  check("…320 SCU aboard, nothing left behind", plan.fits && plan.loadedScu === 320, `${plan.loadedScu} SCU`);
  check("…six lifts, one per contract", plan.loadOrder.length === 6);
  check("…each carrying its contract's title and a signature", plan.loadOrder.every((s) => s.title && s.signature.includes("—")));
  check("…the 8 SCU Aluminium contract is eight 1 SCU boxes", plan.loadOrder.find((s) => s.missionId === "c3")!.signature === "Aluminum — 8x 1 SCU");
  check("…c1's two drop-offs ride one lift", plan.loadOrder.find((s) => s.missionId === "c1")!.destinations.length === 2);
  check("🔑 …and nothing has to be shifted anywhere on the run", plan.handling.moves === 0, `${plan.handling.moves} moves via ${plan.handling.strategy}`);
  check("…so the verdict is 'spread', with 376 SCU spare", plan.handling.verdict === "spread" && plan.handling.slackScu === 376, plan.handling.reason);
  console.log(`        strategy=${plan.handling.strategy}  ${plan.handling.reason}`);
  for (const s of plan.loadOrder) console.log(`        ${s.step}. ${s.signature}  ->  ${s.destinations.map((d) => d.destination).join(", ")}`);
}

// ══ 11. the objective is HANDLING, not space ══════════════════════════════
// The proof that this is not a bin-packer wearing a hat: given room, it spends hold to avoid work.

{
  const legs = [
    leg("m1", "stop 1", "Stims", 64, 8),
    leg("m2", "stop 2", "Waste", 64, 8),
    leg("m3", "stop 3", "Scrap", 64, 8),
  ];
  const roomy = planStowage(C2_GRIDS, legs, { shipClass: "CRUS_Starlifter_C2" });
  check("192 SCU in a 696 SCU C2: nothing buried", roomy.handling.moves === 0, `${roomy.handling.moves} via ${roomy.handling.strategy}`);
  check("…and it stayed on the floor rather than stacking two levels deep", roomy.placements.every((p) => p.z === 0), `max z=${Math.max(...roomy.placements.map((p) => p.z))}`);

  // The same cargo in a hold with no slack has no choice, and says so.
  const TIGHT: GridSpec[] = [{ name: "tight", w: 4, l: 6, h: 4, maxBox: { x: 4, y: 6, z: 2 } }];
  const tight = planStowage(TIGHT, legs, { shipClass: "SOMETHING_MANUAL" });
  check("the same cargo in a 96 SCU hold: legal", violations(TIGHT, tight).length === 0, violations(TIGHT, tight)[0] ?? "");
  check("…over capacity, and it says which boxes are left", !tight.fits && tight.unplaced.length > 0 && tight.notes.some((n) => /more than one trip/.test(n)));
  check("…and it does not pretend the run is clean", tight.handling.verdict === "tight" && /Over capacity/.test(tight.handling.reason), tight.handling.reason);
}

// ══ 12. degenerate inputs ═════════════════════════════════════════════════

{
  const noShip = planStowage([], [leg("m1", "Riker", "Stims", 24, 8)], {});
  check("no ship picked: no crash, and it says what to do", !noShip.fits && noShip.notes.some((n) => /Pick the ship/.test(n)));
  const noCargo = planStowage(C2_GRIDS, [], { shipClass: "CRUS_Starlifter_C2" });
  check("no cargo: an empty plan that still fits", noCargo.fits && noCargo.placements.length === 0 && noCargo.loadOrder.length === 0);
  const emptyLeg = planStowage(C2_GRIDS, [{ group: "g", missionId: "m", destination: null, commodity: null, boxes: [] }], {});
  check("a leg with no boxes is skipped rather than crashing", emptyLeg.fits && emptyLeg.loadOrder.length === 0);
}

// ══ 13. end to end through the REAL plan builder ══════════════════════════
// The coordination risk this file cannot catch by inspection: `stowFromPlan` describes the slice of
// HaulingPlan it reads with a structural type, so a rename over in hauling-plan.ts would compile
// here and fail in the widget. Feeding it the genuine article is the only check that means
// anything — and it also proves the auto-load early return fires off real log data.

{
  const data = new HaulingDataStore(join(process.cwd(), "data"));
  const set = boxSetFrom(data.boxes());

  const viewOf = (ids: string[], shipOverride?: string) => {
    const tracker = new HaulingTracker();
    let n = 0;
    for (const id of ids) {
      for (const s of HAUL_SCENARIOS.filter((x) => x.id === id)) {
        const missionId = `0000000${++n}-0000-4000-8000-00000000000${n}`;
        for (const line of haulReplayLines(shipOverride ? { ...s, ship: shipOverride } : s, missionId)) {
          const ev = parseMissionEvent(parseLine(line));
          if (ev) tracker.apply(ev);
        }
      }
    }
    return tracker.view();
  };

  const plan = buildHaulingPlan(viewOf(["haul-untracked", "haul-items"]), data);
  const stow = stowFromPlan(plan, set);
  check("a real HaulingPlan goes straight in", !stow.autoLoad && stow.placements.length > 0, `${stow.placements.length} boxes`);
  check("…the ship comes off the plan", stow.grids.length === (plan.ship?.grids.length ?? 0) && stow.grids.length > 0);
  check("…contract titles reach the load list without being passed in", stow.loadOrder.every((s) => s.title !== null), JSON.stringify(stow.loadOrder.map((s) => s.title)));
  check("…every placement is legal", violations((plan.ship?.grids ?? []) as GridSpec[], stow).length === 0, violations((plan.ship?.grids ?? []) as GridSpec[], stow)[0] ?? "");
  check("…and the exact 9-box manifest is laid out box for box", stow.loadOrder.some((s) => s.signature.endsWith("8x 8 SCU + 1x 1 SCU")), JSON.stringify(stow.loadOrder.map((s) => s.signature)));

  // 🔑 The same contracts on a Hull C: the game loads it, so there is nothing to lay out.
  const auto = stowFromPlan(buildHaulingPlan(viewOf(["haul-untracked"], "MISC_Hull_C"), data), set);
  check("an auto-loading hull off the real log returns early", auto.autoLoad && auto.placements.length === 0, auto.handling.reason);
}

console.log(failures ? `\n${failures} FAILED` : "\nall ok");
process.exit(failures ? 1 : 0);
