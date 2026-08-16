// The contract advisor: title parsing, the two effort regimes, and the claims this module
// makes about the shipped datasets.
//
//   npx tsx src/hauling-advisor.test.ts
//
// 🔑 The second half runs against data/blueprints.latest.json + data/hauling-orders.json for
// real. That is deliberate: every headline in hauling-advisor.ts's doc comment is a measurement,
// and a measurement nobody re-checks is a rumour. If CIG reshuffles the rep table these tests
// fail loudly instead of the widget quietly giving bad advice.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HAULING_LADDER,
  buildContracts,
  climbToNextRung,
  handlingEffort,
  isStub,
  parseBoardTitle,
  parseRouteShape,
  rankContracts,
  regimeFor,
  rungAt,
  type AdvisorContract,
  type AdvisorMission,
} from "./hauling-advisor.js";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

// ── Titles ────────────────────────────────────────────────────────────────────────────────
console.log("\n── board titles ──");
const t1 = parseBoardTitle("Experienced Rank - Direct Medium Cargo Haul");
check("rank, size and Direct all come out", t1.rank === "Experienced" && t1.size === "Medium" && t1.direct);
const t2 = parseBoardTitle("Junior Rank - Small Cargo Haul");
check("no Direct means multi-drop", t2.rank === "Junior" && t2.size === "Small" && !t2.direct);
const t3 = parseBoardTitle("Rookie Rank - Direct Extra Small Cargo Haul");
check("Extra Small beats Small to the match", t3.size === "Extra Small", String(t3.size));
const t4 = parseBoardTitle("Opportunity for Independent Cargo Hauler");
check("an off-pattern promo yields nulls, not guesses", t4.rank === null && t4.size === null);
check("empty title is safe", parseBoardTitle("").rank === null);

// ── Route shape ───────────────────────────────────────────────────────────────────────────
console.log("\n── route shape ──");
const s1 = parseRouteShape("HaulCargo_SingleToMulti4_Processed_Stims_Stanton1_SmallGrade");
check("SingleToMulti4 is 1 pickup, 4 drops", s1.pickups === 1 && s1.dropoffs === 4);
const s2 = parseRouteShape("HaulCargo_Multi3ToSingle_Waste_Scrap_Stanton2");
check("Multi3ToSingle is 3 pickups, 1 drop", s2.pickups === 3 && s2.dropoffs === 1);
const s3 = parseRouteShape("HaulCargo_AToB_Gas_Hydrogen_CrossStanton");
check("AToB is 1 and 1", s3.pickups === 1 && s3.dropoffs === 1);
// 🔑 The reason shape is read from the key and not from orders.length.
const s4 = parseRouteShape("HaulCargo_SingleToMulti2_Processed_ProcessedFood_Stanton3_SmallGrade", 4);
check("4 orders across 2 drops is still 2 drops", s4.dropoffs === 2, `got ${s4.dropoffs}`);
const s5 = parseRouteShape("HaulCargo_SingleToMulti_Bulk_Mixed", 3);
check("an unnumbered shape falls back to the order count", s5.dropoffs === 3);

// ── The ladder ────────────────────────────────────────────────────────────────────────────
console.log("\n── the ladder ──");
check("a fresh account is Trainee", rungAt(0).current.name === "Trainee" && rungAt(0).next?.name === "Rookie");
check("249 rep is still Rookie", rungAt(249).current.name === "Rookie");
check("250 rep is Junior", rungAt(250).current.name === "Junior");
check("Master is the top rung", rungAt(999_999).current.name === "Master" && rungAt(999_999).next === null);
check("the ladder ascends", HAULING_LADDER.every((r, i) => i === 0 || r.minRep > HAULING_LADDER[i - 1].minRep));

// ── Effort, and the regime split ──────────────────────────────────────────────────────────
console.log("\n── effort ──");
const mk = (over: Partial<AdvisorContract> = {}): AdvisorContract => ({
  key: "HaulCargo_AToB_Test", title: "Junior Rank - Direct Small Cargo Haul", giver: "Covalex",
  missionType: "Hauling - Planetary", rank: "Junior", size: "Small",
  shape: { pickups: 1, dropoffs: 1, raw: "AToB" },
  rep: 500, payout: 50_000, scuLo: 32, scuHi: 32,
  boxesAtScuLo: 8, boxesAtScuHi: 8, boxesMax: 8, maxContainerScu: 4,
  ...over,
});

check("an unknown ship is manual", regimeFor(null) === "manual" && regimeFor("AEGS_Vulture") === "manual");
check("a Hull C auto-loads", regimeFor("MISC_Hull_C") === "auto");

const manual = handlingEffort(mk(), "manual");
check("manual cost is the box count and no seconds", manual.cost === 8 && manual.seconds === null);

// 32 SCU @ cap 4 = eight 4-boxes = 8 * 5s = 40s each way, plus 2 stops * 120s base.
const auto = handlingEffort(mk(), "auto");
check("auto = per-stop base + both directions of box time", auto.seconds === 2 * 120 + 2 * 40, String(auto.seconds));

// 🔑 The flat base is charged PER STOP, which is what makes multi-drop expensive under auto-load.
const auto4 = handlingEffort(mk({ shape: { pickups: 1, dropoffs: 4, raw: "SingleToMulti4" } }), "auto");
check("a 4-drop run pays the base five times", auto4.seconds === 5 * 120 + 2 * 40, String(auto4.seconds));
check("...while the manual cost is unchanged by stop count", handlingEffort(mk({ shape: { pickups: 1, dropoffs: 4, raw: "SingleToMulti4" } }), "manual").cost === manual.cost);

// Same SCU, bigger boxes: auto gets cheaper (fewer, cheaper-per-SCU boxes), manual gets cheaper
// too (fewer boxes) — the regimes only diverge once stop count enters.
const big = mk({ maxContainerScu: 32, boxesAtScuLo: 1, boxesAtScuHi: 1, boxesMax: 1, scuHi: 32 });
check("a 32 SCU box beats eight 4s under auto", handlingEffort(big, "auto").seconds! < auto.seconds!);

// ⚠️ Greedy partitioning is not monotone, so effort must price the WORST end, not the high end.
const jagged = mk({ scuLo: 7, scuHi: 8, boxesAtScuLo: 3, boxesAtScuHi: 2, boxesMax: 3, maxContainerScu: 4 });
check("effort uses the worse end when fewer SCU means more boxes", handlingEffort(jagged, "manual").boxes === 3);

// ── Ranking ───────────────────────────────────────────────────────────────────────────────
console.log("\n── ranking ──");
const pool: AdvisorContract[] = [
  mk({ key: "A_rookie", rank: "Rookie", rep: 50, payout: 50_000 }),
  mk({ key: "B_master", rank: "Master", rep: 8000, payout: 300_000 }),
  mk({ key: "C_junior", rank: "Junior", rep: 500, payout: 60_000 }),
];
const asJunior = rankContracts(pool, { rep: 250, goal: "rep" });
check("the locked Master contract sorts last", asJunior[asJunior.length - 1].contract.key === "B_master");
check("...and is flagged, not hidden", asJunior.find((r) => r.contract.key === "B_master")!.locked);
check("the best unlocked contract leads", asJunior[0].contract.key === "C_junior");
check("dropping locked rows works", rankContracts(pool, { rep: 250, includeLocked: false }).length === 2);
check("no standing given means nothing is locked", rankContracts(pool, {}).every((r) => !r.locked));

const byMoney = rankContracts([mk({ key: "cheap", rep: 8000, payout: 1000 }), mk({ key: "rich", rep: 1, payout: 900_000 })], { goal: "money" });
check("the money goal reorders", byMoney[0].contract.key === "rich");

// Ties break toward the shorter run.
const tie = rankContracts([
  mk({ key: "long", rep: 500, shape: { pickups: 1, dropoffs: 4, raw: "SingleToMulti4" } }),
  mk({ key: "short", rep: 500, shape: { pickups: 1, dropoffs: 1, raw: "AToB" } }),
], { goal: "rep" });
check("equal rates break toward fewer stops", tie[0].contract.key === "short");

check("mission type filters", rankContracts(pool, { missionType: "Hauling - Stellar" }).length === 0);

// ── Climb ─────────────────────────────────────────────────────────────────────────────────
console.log("\n── climb to the next rung ──");
const climb = climbToNextRung(mk({ rep: 500 }), 250, "manual");
check("Junior->Member needs 5000 rep", climb.repNeeded === 5000 && climb.to?.name === "Member");
check("...which is 10 runs at 500 a go", climb.runs === 10);
check("manual reports boxes, never seconds", climb.boxes === 80 && climb.seconds === null);
const climbAuto = climbToNextRung(mk({ rep: 500 }), 250, "auto");
check("auto reports seconds too", climbAuto.seconds === 10 * (2 * 120 + 2 * 40));
check("a zero-rep contract climbs nothing", climbToNextRung(mk({ rep: 0 }), 250, "auto").runs === null);
check("at the top there is nowhere to climb", climbToNextRung(mk(), 999_999, "auto").to === null);

// ══ Against the shipped datasets ══════════════════════════════════════════════════════════
console.log("\n── the shipped data ──");
const dataDir = join(import.meta.dirname, "..", "data");
const missions = JSON.parse(readFileSync(join(dataDir, "blueprints.latest.json"), "utf8"))
  .missions as Record<string, AdvisorMission>;
const orders = JSON.parse(readFileSync(join(dataDir, "hauling-orders.json"), "utf8"))
  .contracts as Record<string, { orders?: { maxContainerSize?: number; minScu?: number; maxScu?: number }[] }>;

const allHaul = Object.keys(missions).filter((k) => k.startsWith("HaulCargo"));
check("853 HaulCargo keys, as briefed", allHaul.length === 853, String(allHaul.length));

const stubs = allHaul.filter((k) => isStub(missions[k], orders[k]?.orders ?? []));
check("412 of them are generator stubs", stubs.length === 412, String(stubs.length));
check("...and every literal TEMPLATE key is among them",
  allHaul.filter((k) => /TEMPLATE/i.test(k)).every((k) => isStub(missions[k], orders[k]?.orders ?? [])));
// ⚠️ Each signal alone misclassifies a real contract — this is why isStub needs both.
check("a capped contract with no generatorClass is NOT a stub",
  !isStub(missions["HaulCargo_AToB_RefinedOre_Laranite_Stanton1"], orders["HaulCargo_AToB_RefinedOre_Laranite_Stanton1"]?.orders ?? []));

const real = buildContracts(missions, orders);
check("441 real contracts survive", real.length === 441, String(real.length));

// 🔑 THE HEADLINE. Within the three CORE families, rep is a pure function of the rank tier: not
// a median, the only value in the set. Interstellar is excluded and tested separately below.
const core = real.filter((c) => c.missionType !== "Hauling - Interstellar");
const REP_BY_RANK: Record<string, number> = {
  Rookie: 50, Junior: 500, Member: 1000, Experienced: 2000, Senior: 4000, Master: 8000,
};
for (const [rank, expected] of Object.entries(REP_BY_RANK)) {
  const rs = core.filter((c) => c.rank === rank);
  const off = rs.filter((c) => c.rep !== expected);
  check(`core: every ${rank} contract awards exactly ${expected} rep (n=${rs.length})`,
    rs.length > 0 && off.length === 0,
    off.length ? `${off.length} outliers, e.g. ${off[0].key}=${off[0].rep}` : "");
}

// ⚠️ Interstellar is the one family that breaks the tier rule, and only at the two ends.
const inter = real.filter((c) => c.missionType === "Hauling - Interstellar");
check("Interstellar exists and is small", inter.length === 48, String(inter.length));
for (const rank of ["Junior", "Member", "Experienced", "Senior"] as const) {
  const rs = inter.filter((c) => c.rank === rank);
  check(`Interstellar ${rank} still matches core (n=${rs.length})`, rs.every((c) => c.rep === REP_BY_RANK[rank]));
}
const interMaster = inter.filter((c) => c.rank === "Master");
check("Interstellar Master pays almost no rep — money contracts, rep switched off",
  interMaster.length > 0 && interMaster.every((c) => c.rep <= 200),
  `reps: ${[...new Set(interMaster.map((c) => c.rep))].join(",")}`);

// ⚠️ The claim that reverses the brief: route shape is not the discriminator once rank is fixed.
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const repPerBox = (cs: AdvisorContract[]) => median(cs.map((c) => c.rep / Math.max(1, c.boxesMax)));
for (const [rank, size] of [["Junior", "Small"], ["Rookie", "Small"], ["Experienced", "Medium"]] as const) {
  const cell = core.filter((c) => c.rank === rank && c.size === size);
  const direct = cell.filter((c) => c.shape.dropoffs === 1 && c.shape.pickups === 1);
  const multi = cell.filter((c) => c.shape.dropoffs > 1 || c.shape.pickups > 1);
  const ratio = repPerBox(multi) / Math.max(0.001, repPerBox(direct));
  check(`${rank}/${size}: shape moves rep/box under 2x (n=${cell.length})`,
    direct.length > 0 && multi.length > 0 && ratio < 2 && ratio > 0.5, `multi/direct = ${ratio.toFixed(2)}`);
}
// ...whereas the rung moves it by an order of magnitude at a FIXED size band.
const small = (r: string) => repPerBox(core.filter((c) => c.rank === r && c.size === "Small"));
check("the rung moves rep/box 20x from Rookie to Experienced at the same size band",
  small("Experienced") / small("Rookie") >= 20, `${small("Rookie").toFixed(1)} -> ${small("Experienced").toFixed(1)}`);
// ...and inside one rung, the smaller size band wins, because rep is flat per tier but boxes are not.
const expSmall = repPerBox(core.filter((c) => c.rank === "Experienced" && c.size === "Small"));
const expLarge = repPerBox(core.filter((c) => c.rank === "Experienced" && c.size === "Large"));
check("within a rung, Small beats Large on rep/box by 2.5x", expSmall >= expLarge * 2.5,
  `Small ${expSmall.toFixed(1)} vs Large ${expLarge.toFixed(1)}`);

// ⚠️ And the regime really does reorder the list — the reason this module takes a ship at all.
const withRep = real.filter((c) => c.rep > 0);
const order = (regime: "auto" | "manual") =>
  new Map(rankContracts(withRep, { ship: regime === "auto" ? "MISC_Hull_C" : null, goal: "rep" })
    .map((r, i) => [r.contract.key, i]));
const mo = order("manual"), ao = order("auto");
const shifts = withRep.map((c) => Math.abs(mo.get(c.key)! - ao.get(c.key)!)).sort((a, b) => a - b);
check("swapping regime shifts the median contract 10+ places", shifts[Math.floor(shifts.length / 2)] >= 10,
  `median ${shifts[Math.floor(shifts.length / 2)]}, max ${shifts[shifts.length - 1]}`);
check("the two regimes disagree about the best contract",
  rankContracts(withRep, { goal: "rep" })[0].contract.key !==
  rankContracts(withRep, { ship: "MISC_Hull_C", goal: "rep" })[0].contract.key);

// Sanity, plus the non-monotone partition documented on AdvisorContract.
check("scuLo <= scuHi always", real.every((c) => c.scuLo <= c.scuHi));
check("boxesMax really is the worst end", real.every((c) => c.boxesMax === Math.max(c.boxesAtScuLo, c.boxesAtScuHi)));
check("every real contract carries at least one box", real.every((c) => c.boxesMax >= 1));
check("every real contract has a container cap", real.every((c) => c.maxContainerScu >= 1));
// 🔑 Documented, not hypothetical: fewer SCU really can need more boxes.
const nonMonotone = real.filter((c) => c.boxesAtScuLo > c.boxesAtScuHi);
check("the non-monotone partition case is present in shipped data", nonMonotone.length === 1,
  nonMonotone.map((c) => `${c.key} ${c.scuLo}scu=${c.boxesAtScuLo}box vs ${c.scuHi}scu=${c.boxesAtScuHi}box`).join("; "));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
