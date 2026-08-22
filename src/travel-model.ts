/**
 * HOW LONG IT TAKES TO GET THERE — the one travel model, shared by everything that shows a distance.
 *
 * 🔴 THIS FILE EXISTS BECAUSE THE NUMBERS WERE IN THREE PLACES. `trade-finder.ts` carried its own
 * copies of `LEG_SAME_BODY_MINUTES` and `LEG_CROSS_BODY_MINUTES` with a comment admitting it —
 * "duplicated rather than imported because that module keeps them private… if they are ever
 * retuned, both places must move." They are about to be retuned, and the Verse Finder wants them
 * too, so there is now exactly one home. Nothing here is private; anything that shows a distance
 * imports from here.
 *
 * -- Sub's model for a cross-system leg -----------------------------------------------------
 *
 *   "We don't need to know the distance between one system and another because you have to jump
 *    through the wormhole. We already have the data on how long that takes. So we just know how
 *    long it takes to get from one planet to the Nyx Gateway, and then from the Stanton Gateway on
 *    the other side, we measure the distance from that to whatever in Nyx."
 *
 * Three parts: origin -> outbound gateway (in-system), the jump (a fixed cost), inbound gateway ->
 * destination (in-system). Per-system coordinate frames are fine for this, and are the reason the
 * decomposition is the right shape: you never compare a Stanton coordinate to a Pyro one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Vec3 { x: number; y: number; z: number }

/* ── Measured floors, terminal to terminal ──────────────────────────────────────────────────
 *
 * Moved here verbatim from `hauling-route.ts`, which derived them and is now an importer.
 *
 * ⚠️ These EXCLUDE the per-stop base that hauling-plan adds as handling (STOP_BASE_MINUTES,
 * "approach, park, and get to the kiosk"). The measurement is kiosk-to-kiosk, so it already
 * contains that minute — charging both would double-count it. leg + base reproduces the floor:
 *   same body   5 + 1 = 6 min   (Baijini <-> Wala outposts 5m32s-7m14s, outpost -> outpost 5m10s)
 *   cross body  6 + 1 = 7 min   (48 cross-body trips in 18 months of logs; floor 6m59s)
 */
export const LEG_SAME_BODY_MINUTES = 5;
export const LEG_CROSS_BODY_MINUTES = 6;

/**
 * 🔴 QUANTUM SPEED — CORRECTED, AND THE OLD VALUE WAS WRONG BY ~1,171x.
 *
 * `hauling-route.ts` carried `travelSpeedMps: 200_000`. Against metre coordinates that predicts
 * **4,790 minutes** for Crusader -> microTech, a leg that really takes about four. It never
 * misbehaved only because it was never exercised: `locations.json`'s `markerXyz` table ships
 * EMPTY (0 entries — see the comments at `hauling-plan.ts:685` and `:954`), so `posOf` returned
 * null everywhere and the router always fell back to the region constants above. Wiring
 * `locations-xyz` in is exactly what wakes the dead term up, so it had to be fixed first.
 *
 * Measured 2026-08-21, and it is worth stating the corroboration because a single reading of a
 * flown leg is weak evidence:
 *   distance Crusader -> microTech   57.48 Gm   (locations-xyz)   vs 59.46 Gm recorded independently
 *                                                                    in hauling-route's own comment
 *   time for that leg                4.09 min   (30 logs, QT events) vs 4m10s recorded independently
 *   => implied speed                 2.34e8 m/s
 * Two sources agreeing within 3% on the distance and 2% on the time is what makes this a
 * correction rather than a guess.
 *
 * 🔑 The extraction: the `[QuantumTravel]` channel emits `<Player Selected Quantum Target>` then
 * `<Quantum Drive Arrived - Arrived at Final Destination>`, with `<Calculate Route>` naming the
 * destination in between. 14 completed legs across 10 sessions: median 2.61 min, p90 4.09.
 */
export const QUANTUM_SPEED_MPS = 2.34e8;

/**
 * ⚠️ BELOW THIS RANGE YOU CANNOT SPOOL A QUANTUM DRIVE — you fly there.
 *
 * Sub: "It might be possible to jump from the station to the gate if it's far enough away. It
 * depends on how far away it is. I want to say it's like 20,000 kilometers."
 *
 * 🔴 RECOLLECTION, NOT MEASUREMENT — flagged the same way the jump cost is. It matters because a
 * gateway can be much closer to a station than to the star, and quoting a quantum time for a hop
 * the drive would refuse is the sort of confident wrongness this codebase keeps paying for. If it
 * is ever measured, this is the constant to move.
 */
export const QUANTUM_MIN_RANGE_M = 20_000_000; // 20,000 km

/** Normal-space cruise, for hops under the quantum floor. Deliberately conservative and clearly
 *  an estimate — it exists so a sub-quantum hop is not quoted at quantum speed, not to be precise. */
export const CRUISE_SPEED_MPS = 1_000;

/**
 * 🔴 THE JUMP ITSELF — AN ESTIMATE, AND LABELLED AS ONE EVERYWHERE IT SURFACES.
 *
 * Sub: "We already know that jumping through the wormhole takes about four minutes. Let's just
 * leave it at that. It doesn't need to be that precise."
 *
 * It could not be measured from the logs, and the reason is worth keeping so nobody re-runs the
 * search: **the wormhole transit emits no route event.** It is not a quantum jump — there is no
 * `Calculate Route` and no `Quantum Drive Arrived`. The system simply changes between one
 * `Projected Start Location is X` line and the next naming Y. Across 30 logs the three real
 * transitions bracket 14, 34 and 41 minutes, and each window contains flying to the gateway, the
 * transit, and flying away; one also contains a hangar sequence and a changed ship entity id, so
 * the player landed and re-shipped inside it. None isolates the tunnel.
 *
 * 🔑 One deliberate gateway transit, clock noted at entry and exit, would settle it.
 */
export const JUMP_MINUTES = 4;

/** Every figure this module produces says which of these it is. A caller that renders a number
 *  without also rendering this is exactly the false precision the widget rules forbid. */
export type TravelBasis = "measured" | "estimated";

export interface TravelLeg {
  kind: "in-system" | "jump";
  minutes: number;
  from: string;
  to: string;
  basis: TravelBasis;
  /** Present on in-system legs: whether the drive could actually spool for this hop. */
  quantum?: boolean;
}

export interface TravelEstimate {
  minutes: number;
  /** "estimated" when ANY part of the route was estimated — a route is only as measured as its
   *  weakest leg, and averaging the two would be the lie. */
  basis: TravelBasis;
  legs: TravelLeg[];
  /** Systems traversed, in order. Length > 2 means more than one jump. */
  path: string[];
  /** Set when no route could be built, so the caller can say why rather than showing a number. */
  unknown?: string;
}

/* ── The gateway graph ──────────────────────────────────────────────────────────────────────── */

export interface GatewayInfo {
  /** System the gateway physically sits in. */
  system: string;
  /** System it leads to. */
  target: string;
  /** Position in `system`'s own frame, metres. */
  pos: Vec3;
  name: string;
}

interface XyzPlace { pos: [number, number, number]; system: string }
interface LocationRow { name?: string; system?: string; type?: string; parentName?: string }

const vec = (p: [number, number, number]): Vec3 => ({ x: p[0], y: p[1], z: p[2] });
export function euclidean(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
const norm = (s: string): string => s.toLowerCase().replace(/ system$/, "").trim();

/**
 * 🔴 A GATEWAY'S NAME IS NOT EVIDENCE OF WHERE IT GOES — the jump point beside it is.
 *
 * This is the whole reason gateways are DERIVED here rather than hardcoded. Measured against the
 * shipped data 2026-08-21: every gateway has a jump point 27-71 km away, and on two of them the
 * names disagree —
 *
 *   Stanton "Nyx Gateway"  <- beside "Stanton - Magnus Jump Point"
 *   Nyx     "Stanton Gateway" <- beside "Nyx - Castra Jump Point"
 *
 * Those two are the Magnus and Castra gateways wearing the wrong labels, and trusting the names
 * would invent a one-jump Stanton <-> Nyx route the game does not have. **Stanton to Nyx is two
 * jumps, via Pyro.** Only Stanton<->Pyro and Pyro<->Nyx survive the check.
 *
 * ⚠️ Neither Magnus nor Castra (nor Terra, Bremen, Odin, Tohil, Virgil, Cano, Hadrian, Oso) has a
 * single location row — they are not in the game — so the mislabelled gateways have nothing to
 * connect to even in principle.
 *
 * Deriving it means a patch that adds a system, renames a gateway or fixes CIG's labelling is a
 * data refresh rather than a code change. The RULE is the durable part, not the table.
 */
export function deriveGateways(
  locations: Record<string, LocationRow>,
  places: Record<string, XyzPlace>,
): GatewayInfo[] {
  const placed = Object.entries(locations)
    .filter(([id]) => places[id])
    .map(([id, v]) => ({
      name: (v.name ?? "").trim(),
      type: v.type ?? "",
      system: norm(v.system ?? ""),
      pos: vec(places[id].pos),
    }));
  const jumps = placed.filter((p) => /jump ?point/i.test(p.name));
  const out: GatewayInfo[] = [];
  for (const g of placed) {
    const m = /^(.+) Gateway$/.exec(g.name);
    // Clinics are co-located CHILDREN of a gateway ("Pyro Gateway Clinic", type Outpost) and must
    // not be mistaken for one; only the Manmade station itself is the gateway.
    if (!m || g.type !== "Manmade") continue;
    const target = norm(m[1]);
    if (!target || target === g.system) continue;
    // The cross-check. Nearest jump point in the same system must name the same target.
    let near: { name: string; d: number } | null = null;
    for (const j of jumps) {
      if (j.system !== g.system) continue;
      const d = euclidean(g.pos, j.pos);
      if (!near || d < near.d) near = { name: j.name, d };
    }
    if (!near || !new RegExp(target.replace(/[^a-z0-9]/g, ""), "i").test(near.name.replace(/[^a-z0-9]/gi, ""))) continue;
    out.push({ system: g.system, target, pos: g.pos, name: g.name });
  }
  // A gateway with no reciprocal partner is unusable however well-named — Stanton's Terra Gateway
  // is real and agrees with its jump point, and Terra simply does not exist to arrive in.
  return out.filter((g) => out.some((o) => o.system === g.target && o.target === g.system));
}

/** Shortest system path using only reciprocal gateway pairs. Breadth-first: the graph is three
 *  nodes today, and staying general costs nothing. */
export function systemPath(gateways: GatewayInfo[], from: string, to: string): string[] | null {
  const a = norm(from), b = norm(to);
  if (!a || !b) return null;
  if (a === b) return [a];
  const adj = new Map<string, string[]>();
  for (const g of gateways) {
    if (!adj.has(g.system)) adj.set(g.system, []);
    adj.get(g.system)!.push(g.target);
  }
  const seen = new Set([a]);
  const queue: string[][] = [[a]];
  while (queue.length) {
    const path = queue.shift()!;
    const last = path[path.length - 1];
    for (const next of adj.get(last) ?? []) {
      if (seen.has(next)) continue;
      const grown = [...path, next];
      if (next === b) return grown;
      seen.add(next);
      queue.push(grown);
    }
  }
  return null;
}

/** One in-system hop, in minutes.
 *
 *  🔑 The quantum floor is what makes this more than distance/speed: a hop shorter than the drive's
 *  minimum range is flown, not jumped, and quoting quantum speed for it would understate it wildly. */
export function inSystemMinutes(a: Vec3, b: Vec3): { minutes: number; quantum: boolean } {
  const d = euclidean(a, b);
  if (d <= 0) return { minutes: 0, quantum: false };
  const quantum = d >= QUANTUM_MIN_RANGE_M;
  const speed = quantum ? QUANTUM_SPEED_MPS : CRUISE_SPEED_MPS;
  // 🔴 NO OVERHEAD IS ADDED ON THE QUANTUM PATH, and that is not an omission.
  //
  // `QUANTUM_SPEED_MPS` was derived as distance / TOTAL measured time — and the measured time is
  // target-selected to arrived, so it already contains spool, align and drop-out. Adding the ~3
  // minutes `hauling-route`'s comment attributes to those charges them twice: the first version of
  // this function did exactly that and put Crusader -> microTech at 7.09 min against the ~4.1 that
  // two independent sources record. The test caught it, which is the whole reason it reproduces a
  // real leg rather than asserting the arithmetic back at itself.
  //
  // ⚠️ THE CONSEQUENCE, stated rather than hidden: this is an EFFECTIVE speed, exact at the range
  // it was measured (57 Gm) and optimistic for short quantum hops, where a fixed spool cost is a
  // larger share of the trip. Separating the two needs a fit across legs of differing length —
  // one measurement is one equation in two unknowns, and the events work already paid for guessing
  // at that. The cruise path keeps a small fixed minute because its speed was never fitted at all.
  const overhead = quantum ? 0 : 1;
  return { minutes: d / speed / 60 + overhead, quantum };
}

export interface TravelDeps {
  gateways: GatewayInfo[];
  /** Position of a place in its own system's frame, or null when we do not have it. */
  posOf(placeId: string): Vec3 | null;
  /** Which system a place is in. */
  systemOf(placeId: string): string | null;
}

/**
 * The composed estimate: origin -> outbound gateway, the jump, inbound gateway -> destination,
 * repeated for each hop of the system path.
 *
 * 🔴 Returns `unknown` rather than a number whenever it cannot build the route honestly. Putting a
 * plausible figure on a route we could not resolve is the failure this codebase names explicitly:
 * "an ambiguous match resolves to NOTHING, because putting the player at the wrong outpost is
 * worse than not knowing."
 */
export function travelMinutes(from: string, to: string, deps: TravelDeps): TravelEstimate {
  const none = (why: string): TravelEstimate =>
    ({ minutes: 0, basis: "estimated", legs: [], path: [], unknown: why });
  const sysA = deps.systemOf(from), sysB = deps.systemOf(to);
  if (!sysA || !sysB) return none("unknown system");
  const path = systemPath(deps.gateways, sysA, sysB);
  if (!path) return none("no known route between " + sysA + " and " + sysB);

  const posA = deps.posOf(from), posB = deps.posOf(to);
  if (!posA || !posB) return none("no coordinates for that place");

  const legs: TravelLeg[] = [];
  let cursor = posA, cursorName = from;
  for (let i = 0; i < path.length - 1; i++) {
    const here = path[i], next = path[i + 1];
    const out = deps.gateways.find((g) => g.system === here && g.target === next);
    const inbound = deps.gateways.find((g) => g.system === next && g.target === here);
    if (!out || !inbound) return none("no usable gateway between " + here + " and " + next);
    const hop = inSystemMinutes(cursor, out.pos);
    legs.push({ kind: "in-system", minutes: hop.minutes, from: cursorName, to: out.name, basis: "measured", quantum: hop.quantum });
    // 🔴 The one estimated leg, and it makes the whole route estimated.
    legs.push({ kind: "jump", minutes: JUMP_MINUTES, from: out.name, to: inbound.name, basis: "estimated" });
    cursor = inbound.pos;
    cursorName = inbound.name;
  }
  const last = inSystemMinutes(cursor, posB);
  legs.push({ kind: "in-system", minutes: last.minutes, from: cursorName, to, basis: "measured", quantum: last.quantum });

  const minutes = legs.reduce((s, l) => s + l.minutes, 0);
  return {
    minutes,
    basis: legs.some((l) => l.basis === "estimated") ? "estimated" : "measured",
    legs,
    path,
  };
}

/** Load the shipped coordinate table. Returns an empty map rather than throwing — a build without
 *  the dataset must degrade to the region constants, not fail to start. */
export function loadPlaces(dataDir: string): Record<string, XyzPlace> {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "locations-xyz.latest.json"), "utf8")) as { places?: Record<string, XyzPlace> };
    return raw.places ?? {};
  } catch { return {}; }
}
