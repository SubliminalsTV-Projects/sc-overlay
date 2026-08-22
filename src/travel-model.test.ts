/**
 * The shared travel model — `npx tsx src/travel-model.test.ts`.
 *
 * Driven against the REAL shipped data, because every claim here is a property of that data and a
 * fixture would keep passing after CIG renamed a gateway. The headline case cannot even be
 * expressed against a fixture: "Stanton's Nyx Gateway is really the Magnus one" is only a fact
 * about `locations.json` + `locations-xyz`, and inventing a fixture that says so would be
 * asserting my own assumption back at myself.
 *
 * 🔴 THE TWO THINGS THIS FILE EXISTS TO STOP:
 *   1. Believing a gateway's NAME. Two of the seven lie, and trusting them invents a one-jump
 *      Stanton <-> Nyx route the game does not have.
 *   2. Quoting a travel time as fact when part of it is a guess. The jump is an estimate; a route
 *      containing one is an estimate all the way through.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deriveGateways, systemPath, inSystemMinutes, travelMinutes, euclidean,
  QUANTUM_SPEED_MPS, QUANTUM_MIN_RANGE_M, JUMP_MINUTES,
  type Vec3, type GatewayInfo,
} from "./travel-model.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
};

const dataDir = fileURLToPath(new URL("../data", import.meta.url));
const locations = (JSON.parse(readFileSync(dataDir + "/locations.json", "utf8")) as { locations: Record<string, { name?: string; system?: string; type?: string }> }).locations;
const places = (JSON.parse(readFileSync(dataDir + "/locations-xyz.latest.json", "utf8")) as { places: Record<string, { pos: [number, number, number]; system: string }> }).places;

console.log("the data both halves stand on");
check("locations.json loaded", Object.keys(locations).length > 1000, String(Object.keys(locations).length));
check("coordinates loaded", Object.keys(places).length > 1000, String(Object.keys(places).length));

const gws = deriveGateways(locations, places);
const label = (g: GatewayInfo) => g.system + "->" + g.target;

console.log("\n🔴 a gateway's NAME is not evidence — the jump point beside it is");
// POSITIVE FIRST. Every negative below is free on an empty list, and an empty list is exactly what
// an over-strict rule produces — so the count has to be established before anything is excluded.
check("gateways were derived at all", gws.length > 0, String(gws.length));
check("...exactly the four that survive the cross-check", gws.length === 4, gws.map(label).join(" "));
for (const pair of ["stanton->pyro", "pyro->stanton", "pyro->nyx", "nyx->pyro"]) {
  check("kept: " + pair, gws.some((g) => label(g) === pair));
}
// 🔴 The mislabels. These two ARE in the data, named exactly as you would trust, and are wrong.
const nyxGwInStanton = Object.values(locations).some((v) => v.name === "Nyx Gateway" && /stanton/i.test(v.system ?? ""));
check("Stanton really does ship a place called \"Nyx Gateway\"", nyxGwInStanton);
check("...and we refuse it (its jump point says Magnus)", !gws.some((g) => label(g) === "stanton->nyx"));
const stantonGwInNyx = Object.values(locations).some((v) => v.name === "Stanton Gateway" && /nyx/i.test(v.system ?? ""));
check("Nyx really does ship a place called \"Stanton Gateway\"", stantonGwInNyx);
check("...and we refuse it (its jump point says Castra)", !gws.some((g) => label(g) === "nyx->stanton"));
// A gateway that agrees with its jump point but has nowhere to arrive is still unusable.
check("Stanton's Terra Gateway is dropped for having no partner", !gws.some((g) => label(g) === "stanton->terra"));

console.log("\n🔴 the topology is a CHAIN — Stanton to Nyx is two jumps");
check("Stanton -> Pyro is one hop", JSON.stringify(systemPath(gws, "Stanton", "Pyro")) === '["stanton","pyro"]',
  JSON.stringify(systemPath(gws, "Stanton", "Pyro")));
check("Stanton -> Nyx routes VIA PYRO", JSON.stringify(systemPath(gws, "Stanton", "Nyx")) === '["stanton","pyro","nyx"]',
  JSON.stringify(systemPath(gws, "Stanton", "Nyx")));
check("...which is three systems, i.e. two jumps", (systemPath(gws, "Stanton", "Nyx") ?? []).length === 3);
check("same system is a zero-jump path", JSON.stringify(systemPath(gws, "Pyro", "Pyro")) === '["pyro"]');
check("an unknown system has no route", systemPath(gws, "Stanton", "Magnus") === null);

console.log("\n🔴 the quantum floor — a short hop is FLOWN, not jumped");
const at = (m: number): Vec3 => ({ x: m, y: 0, z: 0 });
const far = inSystemMinutes(at(0), at(QUANTUM_MIN_RANGE_M * 10));
const near = inSystemMinutes(at(0), at(QUANTUM_MIN_RANGE_M / 10));
check("a long hop uses the drive", far.quantum === true);
check("a hop under the floor does NOT", near.quantum === false, (QUANTUM_MIN_RANGE_M / 10 / 1000) + " km");
check("...and is therefore SLOWER despite being shorter", near.minutes > far.minutes,
  near.minutes.toFixed(1) + " min vs " + far.minutes.toFixed(1) + " min");

console.log("\n🔴 the corrected speed reproduces a leg measured two independent ways");
const find = (n: string): Vec3 | null => {
  const e = Object.entries(locations).find(([id, v]) => v.name === n && places[id]);
  return e ? { x: places[e[0]].pos[0], y: places[e[0]].pos[1], z: places[e[0]].pos[2] } : null;
};
const cru = find("Crusader"), mic = find("microTech");
check("both bodies are placed", !!cru && !!mic);
if (cru && mic) {
  const gm = euclidean(cru, mic) / 1e9;
  check("Crusader -> microTech is ~57-60 Gm", gm > 55 && gm < 62, gm.toFixed(2) + " Gm");
  const mins = inSystemMinutes(cru, mic).minutes;
  // Logs say 4.09 min; hauling-route's own comment says 4m10s. Anything in 3-6 reproduces both.
  check("...and the model puts it near the ~4 min both sources recorded", mins > 3 && mins < 6, mins.toFixed(2) + " min");
  // The control that gives that number meaning: the OLD constant could not have passed it.
  const old = euclidean(cru, mic) / 200_000 / 60;
  check("...where the old 200,000 m/s constant predicted thousands of minutes", old > 1000, Math.round(old) + " min");
}

console.log("\n🔴 a route containing the jump is ESTIMATED all the way through");
const sysOf = (id: string): string | null => {
  const v = locations[id];
  return v?.system ? v.system.toLowerCase().replace(/ system$/, "") : null;
};
const posOf = (id: string): Vec3 | null => places[id] ? { x: places[id].pos[0], y: places[id].pos[1], z: places[id].pos[2] } : null;
const idOf = (n: string): string | null => Object.entries(locations).find(([id, v]) => v.name === n && places[id])?.[0] ?? null;
const deps = { gateways: gws, posOf, systemOf: sysOf };
const idCru = idOf("Crusader"), idMic = idOf("microTech");
check("two Stanton places resolve", !!idCru && !!idMic);
if (idCru && idMic) {
  const same = travelMinutes(idCru, idMic, deps);
  check("a same-system route is MEASURED", same.basis === "measured", same.basis);
  check("...with no jump leg", !same.legs.some((l) => l.kind === "jump"));
  check("...and a real duration", same.minutes > 0 && !same.unknown, same.minutes.toFixed(1));
}
// Cross-system: Stanton -> Pyro.
const idPyroPlace = Object.entries(locations).find(([id, v]) => places[id] && /pyro/i.test(v.system ?? "") && v.name === "Ruin Station")?.[0]
  ?? Object.entries(locations).find(([id, v]) => places[id] && /pyro/i.test(v.system ?? ""))?.[0] ?? null;
check("a Pyro place resolves", !!idPyroPlace);
if (idCru && idPyroPlace) {
  const cross = travelMinutes(idCru, idPyroPlace, deps);
  check("a cross-system route is built", !cross.unknown, cross.unknown ?? "ok");
  check("...it is ESTIMATED, because the jump is", cross.basis === "estimated", cross.basis);
  check("...it contains exactly one jump", cross.legs.filter((l) => l.kind === "jump").length === 1);
  check("...the jump costs what Sub settled on", cross.legs.find((l) => l.kind === "jump")?.minutes === JUMP_MINUTES);
  check("...and it is decomposed, not a flat number", cross.legs.length === 3, String(cross.legs.length));
  check("...longer than the flat 25-minute placeholder it replaces? (either way, it is COMPOSED)",
    cross.minutes > 0, cross.minutes.toFixed(1) + " min");
}
// Stanton -> Nyx must cost TWO jumps.
const idNyx = Object.entries(locations).find(([id, v]) => places[id] && /nyx/i.test(v.system ?? "") && v.name === "Levski")?.[0]
  ?? Object.entries(locations).find(([id, v]) => places[id] && /nyx/i.test(v.system ?? ""))?.[0] ?? null;
check("a Nyx place resolves", !!idNyx);
if (idCru && idNyx) {
  const two = travelMinutes(idCru, idNyx, deps);
  check("Stanton -> Nyx is built", !two.unknown, two.unknown ?? "ok");
  check("...and costs TWO jumps, not one", two.legs.filter((l) => l.kind === "jump").length === 2,
    String(two.legs.filter((l) => l.kind === "jump").length));
  check("...routed through Pyro", two.path.join(">") === "stanton>pyro>nyx", two.path.join(">"));
}

console.log("\n🔴 it says UNKNOWN rather than inventing a number");
check("no coordinates -> unknown", !!travelMinutes("nope", "nope2", { ...deps, systemOf: () => "stanton", posOf: () => null }).unknown);
check("unknown system -> unknown", !!travelMinutes("a", "b", { ...deps, systemOf: () => null }).unknown);
check("...and unknown carries no minutes", travelMinutes("a", "b", { ...deps, systemOf: () => null }).minutes === 0);
check("a system with no gateway route -> unknown", !!travelMinutes("a", "b", {
  gateways: [], posOf: () => ({ x: 0, y: 0, z: 0 }), systemOf: (id) => (id === "a" ? "stanton" : "pyro"),
}).unknown);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
