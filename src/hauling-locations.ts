/**
 * HAULING — TURNING THE GAME'S LOCATION TOKENS INTO A PLACE ON THIS BOARD.
 *
 * The log names places in its own dialect (`RR_ARC_LEO`, `ArcCorp_Area045`) and marks others only
 * by coordinates. This is the join to the names a player recognises, and it is deliberately
 * conservative: an ambiguous match resolves to NOTHING, because putting the player at the wrong
 * outpost is worse than not knowing — the router would confidently order around it.
 *
 * Lifted verbatim out of hauling-plan.ts (2026-08-19). CANON_PLANET's doc comment travels with the
 * const it documents; in the old file the two had drifted apart with SECONDS_PER_BOX between them.
 */
import type { HaulingDataStore } from "./hauling-data.js";
import type { Vec3 } from "./hauling-route.js";

/** Stanton's four planets, by the code the contract key writes. Confirmed by Sub, 2026-08-17.
 *
 *  🔑 This exists because the DATASET cannot answer it. `Stanton4` carries two Planet records:
 *  "microTech" and "Green". Green is not a place in the game — it is microTech's internal name
 *  left in the files, and the data says so plainly once you look: microTech has 59 children
 *  (every moon and outpost), Green has ZERO. An orphan planet is a ghost record.
 *
 *  Kept to the four planets on purpose. It disambiguates; it is not a translation table, and a
 *  code absent from here degrades to no label rather than to a guess. */
export const CANON_PLANET: Record<string, string> = {
  stanton1: "hurston",
  stanton2: "crusader",
  stanton3: "arccorp",
  stanton4: "microtech",
};

/**
 * 🔴 `RR_<BODY>_LEO` IS THAT PLANET'S ORBITAL STATION, and nothing in the data says so.
 *
 * 🔑 THE NAMING, decoded by Sub: **RR = Rest & Relax** (the in-fiction operator of the stations and
 * rest stops) and **LEO = Low Earth Orbit**. So the family reads as "the R&R station in low orbit
 * around <body>", which makes the whole `RR_` namespace predictable rather than a set of magic
 * strings: `RR_CRU_L1` is the R&R stop at Crusader's first Lagrange point, `RR_JP_NyxPyro` the one
 * at the Nyx–Pyro jump point, and `RR_ARC_LEO` the one in orbit around ArcCorp — Baijini Point.
 *
 * Sub, standing in Baijini with the terminal open, asked the fair question: can you tell I am here
 * yet? The answer was no. Baijini's token shares not one letter with "Baijini Point", so the name
 * join returned null and the router still had no origin. Every token tested before that was a
 * mining area or a salvage centre, where log and dataset happen to spell the place alike — the
 * orbital stations are the case that breaks it, and they are where a hauler spends half their time.
 *
 * ⚠️ Only the LEO leg needs a table, and it genuinely cannot be derived. Each of these planets
 * carries several `Manmade` children that are all QT destinations with no code — ArcCorp has
 * Baijini Point, Comm Array ST3-90 and Orbital Relay AC-421 as siblings — and nothing in the row
 * distinguishes the station you can land at from the relay you cannot. The other `RR_` families
 * need nothing: they resolve through locations.json's own alias map once the prefix is stripped.
 */
const LEO_STATION: Record<string, string> = {
  arc: "Baijini Point",
  hur: "Everus Harbor",
  cru: "Seraphim Station",
  mic: "Port Tressler",
};

/**
 * Join the game's own location token to a place on this board, best evidence first.
 *
 *   1. locations.json's ALIAS table, which already knows `Stanton2_Orison` → Orison,
 *      `Nyx_Levski` → Levski and `cru_l1` → CRU L1. Exact, and it covers most tokens.
 *   2. The LEO table above, for the four orbital stations the alias map has no entry for.
 *   3. A NAME match, letters and digits only, as a subsequence in either direction — because the
 *      log writes `ArcCorp_Area045` where the dataset writes "ArcCorp **Mining** Area 045", and
 *      `SamsonSonsSalvageCenter` where the board says "Samson & Son's Salvage Center".
 *
 * ⚠️ Subsequence, not substring, and the DIGITS have to survive: "Area045" and "Area048" differ by
 * one character. An ambiguous match resolves to NOTHING — putting the player at the wrong outpost
 * is worse than not knowing, because the router would then confidently order around it.
 */
export function matchLocationToken(
  token: string,
  names: ReadonlyMap<string, string>,
  data: HaulingDataStore,
): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const isSub = (a: string, b: string) => {
    let i = 0;
    for (const c of b) { if (c === a[i]) i++; if (i === a.length) return true; }
    return i === a.length;
  };
  /**
   * Board ids whose name matches `want`; null unless exactly one does.
   *
   * 🔴 AN EXACT MATCH WINS OUTRIGHT, and it did not used to. The fuzzy arm accepts a name whose
   * letters appear IN ORDER inside the other, which is far too loose for short names: "Ita" is a
   * subsequence of "SeraphimStation" (i…t…a), so looking up Crusader's orbital station returned
   * TWO hits and the "exactly one" rule threw the real answer away with the coincidence.
   *
   * Measured on Sub's live app, 2026-08-22: he was docked at RR_CRU_LEO, the log said so, the
   * parser produced it and the hauling tracker held it — and the Verse Finder still reported
   * "Location unknown" with no distances, because this function returned null. Every downstream
   * symptom was one coincidental subsequence.
   *
   * ⚠️ The safety property is UNCHANGED: still one answer or none, never a guess. Two exact
   * matches are still genuinely ambiguous and still resolve to nothing — putting the player at
   * the wrong outpost stays worse than not knowing.
   */
  const onBoard = (want: string): string | null => {
    const w = norm(want);
    if (!w) return null;
    const exact: string[] = [];
    const fuzzy: string[] = [];
    for (const [id, name] of names) {
      const n = norm(name);
      if (!n) continue;
      if (n === w) exact.push(id);
      else if (isSub(w, n) || isSub(n, w)) fuzzy.push(id);
    }
    if (exact.length) return exact.length === 1 ? exact[0] : null;
    return fuzzy.length === 1 ? fuzzy[0] : null;
  };

  // 1 — the dataset's own alias map, on the whole token and on the RR_-stripped form.
  for (const probe of [token, token.replace(/^RR_/i, "")]) {
    const named = data.byCode(probe).map((l) => l.name).filter((n): n is string => !!n);
    for (const n of named) {
      const hit = onBoard(n);
      if (hit) return hit;
    }
  }
  // 2 — the orbital stations, which the alias map does not carry.
  const leo = /^RR_([A-Za-z0-9]+)_LEO$/i.exec(token);
  if (leo) {
    const station = LEO_STATION[leo[1].toLowerCase()];
    if (station) return onBoard(station);
  }
  // 3 — the raw token's own words. Drop the leading body code; it names the moon, not the site.
  return onBoard(token.split("_").slice(1).join(""));
}

/** Position -> a stable location id. Rounded to the kilometre so a marker re-emitted on spawn-in
 *  with a few metres of drift is still the same place. */
export function posKey(p: Vec3 | null | undefined): string | null {
  if (!p) return null;
  return `@${Math.round(p.x / 1000)},${Math.round(p.y / 1000)},${Math.round(p.z / 1000)}`;
}
