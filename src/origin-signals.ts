/**
 * WHERE IS THE PLAYER — HARVESTING THE SIGNALS `player-origin.ts` GRADES.
 *
 * `player-origin.ts` decides how much to believe a set of readings. It does not go and get them;
 * this does. The split is deliberate — the grading rules are testable arithmetic, while the
 * harvest is a pile of log-shaped special cases, and mixing them makes neither reviewable.
 *
 * -- WHAT ACTUALLY EXISTS, and what each one is worth ----------------------------------------
 *
 * 🔴 THE GAME NEVER SAYS "THE PLAYER IS AT (x, y, z)". There is no player-position line in
 * `game.log` — three separate sessions have now looked. Every signal below is a side effect of
 * the player DOING something, which has one consequence that governs this whole module:
 *
 * 🔴 NOTHING FIRES WHEN THE PLAYER LEAVES. Every reading is a last-known, never a current
 * position, and it can only ever decay by assumption. That is why `player-origin.ts` carries a
 * trust window per tier rather than a single freshness rule, and why this module stamps every
 * signal with the time the LOG said it happened rather than the time we parsed it.
 *
 *   ASOP / inventory / freight  a NAMED PLACE. The strongest tier, and the only one that can be
 *                               specific enough to route from. Fires when you open a terminal.
 *   Terrain report              a BODY, every 10 minutes, but only while near one. The one signal
 *                               that fires ON ITS OWN — everything else needs the player to act.
 *                               🔴 It carries NO coordinates: it is `cells`, `meshes` and a name.
 *   Quantum navigation          the SYSTEM. You cannot leave a system without a jump, and a jump
 *                               writes more of these, so it does not decay.
 *
 * 🔑 A COARSER, NEWER READING IS NOT AN UPGRADE — it is evidence you MOVED. `resolveOrigin`
 * handles that (a "near Daymar" after an "at Area18" means the Area18 fix is wrong, not merely
 * old). This module's job is only to report each reading honestly and let it judge.
 *
 * -- AN UNRESOLVABLE TOKEN PRODUCES NO SIGNAL ------------------------------------------------
 *
 * 🔴 Not a signal with a guessed id. `hauling-locations.ts` already states the rule this follows:
 * "an ambiguous match resolves to NOTHING, because putting the player at the wrong outpost is
 * worse than not knowing". A signal we cannot place is silently useless; a signal placed WRONG
 * makes the widget confidently order shops around a location the player has never been to.
 */
import type { OriginSignal } from "./player-origin.js";
import type { Place } from "./location.js";
import { matchKey, systemKey, type LocationRecord } from "./verse-proximity.js";

/**
 * What a shop terminal can say. Assembled by `PlayerLocation`, graded here.
 *
 * 🔑 TWO INDEPENDENT PATHS AND ONE LABEL, and keeping them apart is the entire design:
 *   - `boundToken` is what a location line named while the player stood at this terminal. Precise
 *     and certain, and NOT independent — it dies with the signal it learned from.
 *   - `shopName` is the game's own asset name for the shop, resolved against the starmap. That one
 *     is genuinely independent of every other signal, which is what makes it insurance.
 *   - `label` is only ever WHICH DESK. It is never evidence of a place.
 */
export interface TerminalFix {
  at: number;
  /** The game's asset name, e.g. `SCShop_Levski_CargoOffice_Commodities`. */
  shopName: string;
  /** The specific physical kiosk inside the shop, when the line carried one. Opaque, and kept for
   *  precision: it is the difference between "at Levski" and "at this desk at Levski". */
  kioskId: string | null;
  /** `shopName` made readable — "Levski Cargo Office Commodities". */
  label: string;
  /** The place token bound to this terminal in THIS session, or null. Never persisted. */
  boundToken: string | null;
}

export interface SignalInputs {
  /** `PlaceWatcher.current()` — the terrain report's body, or space, or unknown. */
  place?: Place | null;
  /** `SystemWatcher.current()` — "stanton" | "pyro" | "nyx" | null. */
  system?: string | null;
  /** From the hauling tracker: the last place an ASOP terminal named. */
  atLocation?: { token: string; at: number } | null;
  /** From the hauling tracker: the last place an inventory move named. */
  atLocationId?: { id: string; at: number } | null;
  /** From the hauling tracker: a freight-elevator move, which names its platform. */
  cargoMove?: { direction: "down" | "up"; platform: string; at: number } | null;
  /**
   * `atLocationId` after `PlayerLocation` has resolved it to a readable token.
   *
   * 🔴 THE RAW FIELD ABOVE CAN NEVER PRODUCE A SIGNAL, and for a long time nobody noticed. The game
   * writes "where am I" as a readable token at a location inventory and as a bare NUMBER at the
   * ASOP, at any item moved to local storage, and at the freight kiosk. `resolveToken` cannot turn
   * `3490636373` into anything, so the more frequent of the two shapes was dropped in silence.
   * Measured over 533 logs, feeding it in is worth **+11.2 points of place-tier freshness (135.8 h)**
   * — and place is the only tier a per-station distance can come from.
   */
  boundPlace?: { token: string; at: number } | null;
  /** The last shop terminal the player used. See `TerminalFix`. */
  terminal?: TerminalFix | null;
}

export interface SignalDeps {
  locations: Record<string, LocationRecord>;
  /**
   * Resolve one of the game's own location tokens (`RR_ARC_LEO`, `ArcCorp_Area045`) to a starmap
   * place id.
   *
   * 🔑 INJECTED rather than imported. `matchLocationToken` in `hauling-locations.ts` already does
   * this well — it knows the alias map, the four `RR_*_LEO` orbital stations that no table
   * derives, and the subsequence rule that joins `SamsonSonsSalvageCenter` to "Samson & Son's
   * Salvage Center". Importing it would drag `HaulingDataStore` into this module and into every
   * test of it; taking it as a function keeps this pure and lets the sidecar wire in the real one.
   * Returning null must mean "I could not place it", never a guess.
   */
  resolveToken?: (token: string) => string | null;
  now?: () => number;
}

/**
 * The `OriginDeps` that MATCH the ids this collector emits.
 *
 * 🔴 `resolveOrigin`'s contradiction check compares `systemOf(place.id)` against the system
 * signal's own `id`, and `bodyOfPlace(place.id)` against the body signal's `id`. Those are string
 * equality tests, so the grader is only correct if the deps and the signals speak the SAME
 * namespace. `player-origin.ts` is deliberately agnostic about which namespace that is — its own
 * tests use domain tokens ("lyria", "stanton") — and this collector uses starmap UUIDs throughout,
 * because those are what `locations-xyz` is keyed by and therefore what a distance can be computed
 * from.
 *
 * 🔑 Exported from HERE, beside the code that chooses the namespace, rather than left for each
 * call site to rebuild. Getting it wrong does not throw: it makes every place fix look like it
 * contradicts the system it is in, so the grader silently discards the precise reading and reports
 * the coarse one. That is exactly what happened the first time this was wired up — a fresh ASOP
 * fix at Area18 graded as "somewhere in Stanton", and nothing anywhere said why.
 */
export function originDepsFor(locations: Record<string, LocationRecord>) {
  const star = new Map<string, string | null>();
  return {
    /** The place's parent — a body id in the same starmap namespace. */
    bodyOfPlace: (placeId: string): string | null => locations[placeId]?.parent ?? null,
    /** The STAR of the place's system, memoised per system. */
    systemOf: (id: string): string | null => {
      const sys = systemKey(locations[id]?.system);
      if (!sys) return null;
      if (!star.has(sys)) star.set(sys, starOf(locations, sys)?.id ?? null);
      return star.get(sys) ?? null;
    },
  };
}

/** name -> ids, over the whole starmap. Built per call; the table is ~2,000 rows and this runs
 *  once per request, not per row. */
function nameIndex(locations: Record<string, LocationRecord>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [id, rec] of Object.entries(locations)) {
    const k = matchKey(rec?.name);
    if (!k) continue;
    const cur = m.get(k);
    if (cur) cur.push(id);
    else m.set(k, [id]);
  }
  return m;
}

/** Exactly one place of this name, optionally constrained to a system. Anything else is null —
 *  see the module header on why a guess is worse than nothing. */
function uniqueByName(
  idx: Map<string, string[]>,
  locations: Record<string, LocationRecord>,
  name: string | null | undefined,
  system?: string | null,
): string | null {
  const k = matchKey(name);
  if (!k) return null;
  let ids = idx.get(k);
  if (!ids?.length) return null;
  const sys = systemKey(system);
  if (sys && ids.length > 1) {
    const narrowed = ids.filter((id) => systemKey(locations[id]?.system) === sys);
    if (narrowed.length) ids = narrowed;
  }
  return ids.length === 1 ? ids[0] : null;
}

/**
 * WHICH TIER A STARMAP ROW MAY BE REPORTED AT — decided by the row, never by the source.
 *
 * 🔴 THE RULE EXISTS BECAUSE A NAME IS NOT A TIER. "Pyro" is a row in `locations.json` and its type
 * is `Star`; five of the shop names in the corpus contain it. Resolving one and reporting a `place`
 * would put the player at the centre of a sun, and every distance computed from it would be wrong
 * by an orbit. The row already carries the answer, so the source never has to guess.
 *
 * `SolarSystem` rows are excluded outright rather than mapped to `system`: they are parentless AND
 * coordinate-less (`starOf` says so below), so nothing can be measured from one.
 */
export function tierOfRecord(rec: LocationRecord | undefined): "place" | "body" | "system" | null {
  const t = String(rec?.type ?? "");
  if (!t) return null;
  if (t === "Star") return "system";
  if (t === "SolarSystem") return null;
  if (t === "Planet" || t === "Moon") return "body";
  return "place";
}

/**
 * Read a place out of a shop's own asset name.
 *
 * 🔑 THE INDEPENDENT SOURCE. Every other signal in this module comes from the game telling us where
 * the player is; this one comes from what the shop calls itself, so it keeps working if CIG stops
 * writing the others. Measured over 533 logs: **28 of 61 distinct shop names resolve to exactly one
 * starmap row and 0 resolve ambiguously**, covering 1,873 of 2,549 shop lines.
 *
 * 🔴 EXACTLY ONE ROW, ACROSS THE WHOLE NAME, OR NOTHING. A shop name is several words and more than
 * one may be a row; two rows means the name has not identified a place and the module's standing
 * rule applies — an ambiguous match resolves to nothing, because putting the player at the wrong
 * outpost is worse than not knowing. This is also what disarms the finding that killed the
 * persisted map: `SCShop_AdminOffice_Nyx_SocialStation` sits at three different Keeger bases and
 * matches **no** row here, because "Nyx" is a Star and "SocialStation" is not a place.
 *
 * ⚠️ Words shorter than four characters are skipped. They are initials and codes (`H`, `XS`, `lt`,
 * `FW`) and matching them against a 2,000-row name table is how a two-letter shop prefix becomes a
 * confident claim about an outpost.
 */
function uniqueFromShopName(
  idx: Map<string, string[]>,
  locations: Record<string, LocationRecord>,
  shopName: string,
): { id: string; tier: "place" | "body" | "system" } | null {
  const stem = shopName.replace(/^SCShop_?/i, "").replace(/-\d+$/, "");
  const hits = new Map<string, string>();   // match key -> the single id it named
  for (const raw of stem.split(/[_\-]+/)) {
    const k = matchKey(raw);
    if (!k || k.length < 4) continue;
    const ids = idx.get(k);
    // A word naming several rows is not an identification; it also must not be allowed to sink the
    // whole name, because "Levski Cargo Office" would then lose to the word "Office" naming twelve
    // outposts. It contributes nothing, which is what `continue` says.
    if (!ids || ids.length !== 1) continue;
    hits.set(k, ids[0]);
  }
  const ids = [...new Set(hits.values())];
  if (ids.length !== 1) return null;
  const tier = tierOfRecord(locations[ids[0]]);
  return tier ? { id: ids[0], tier } : null;
}

/** The star at a system's origin. It is the root of every place in that system, which is what
 *  makes it usable as a containment anchor for a system-level reading. */
function starOf(
  locations: Record<string, LocationRecord>,
  system: string | null | undefined,
): { id: string; label: string } | null {
  const sys = systemKey(system);
  if (!sys) return null;
  for (const [id, rec] of Object.entries(locations)) {
    if (systemKey(rec?.system) !== sys) continue;
    // The Star is the only parentless row that has coordinates; "Stanton System" (SolarSystem)
    // is parentless too and has none, so it cannot anchor anything.
    if (!rec?.parent && (rec as { type?: string })?.type === "Star") {
      return { id, label: rec.name ?? sys };
    }
  }
  return null;
}

/**
 * Turn whatever the session currently knows into a list of readings.
 *
 * Order is irrelevant — `resolveOrigin` picks by tier and recency — so this appends whatever it
 * can place and drops the rest.
 */
export function collectOriginSignals(inputs: SignalInputs, deps: SignalDeps): OriginSignal[] {
  const { locations } = deps;
  const idx = nameIndex(locations);
  const out: OriginSignal[] = [];
  const sys = inputs.system ?? null;

  const pushPlace = (id: string | null, at: number, source: string) => {
    if (!id) return;
    out.push({ tier: "place", id, label: locations[id]?.name ?? id, at, source });
  };

  // -- PLACE, from the three things that name one -------------------------------------------
  // 🔑 All three are the same tier on purpose. They differ in which terminal you touched, not in
  // how well they locate you, and inventing a hierarchy between them would be a preference
  // dressed as evidence.
  const token = (t: string | null | undefined): string | null => {
    if (!t) return null;
    const viaResolver = deps.resolveToken?.(t) ?? null;
    if (viaResolver) return viaResolver;
    // Fall back to a plain name match. The resolver knows far more, but it is optional and a
    // token that IS a place name should not need it.
    return uniqueByName(idx, locations, t, sys);
  };

  if (inputs.atLocation) {
    pushPlace(token(inputs.atLocation.token), inputs.atLocation.at,
              "an ASOP terminal named this place");
  }
  if (inputs.atLocationId) {
    pushPlace(token(inputs.atLocationId.id), inputs.atLocationId.at,
              "the last place the game saw you open an inventory");
  }
  if (inputs.cargoMove) {
    pushPlace(token(inputs.cargoMove.platform), inputs.cargoMove.at,
              "a freight elevator you used");
  }
  // The game's numeric location id, already turned back into a token by `PlayerLocation`. Same
  // tier as the three above and for the same reason: it is the same fact from a different terminal.
  if (inputs.boundPlace) {
    pushPlace(token(inputs.boundPlace.token), inputs.boundPlace.at,
              "the game's own location id for where you were");
  }

  // -- A SHOP TERMINAL ------------------------------------------------------------------------
  // 🔴 Two paths, and the ORDER states the preference: what a location line named here beats what
  // the shop's asset name says about itself, because the first is an observation and the second is
  // a label. The fallback is not redundancy for its own sake — it is the only source here that
  // survives CIG removing the location line, which is the whole reason it exists.
  if (inputs.terminal) {
    const t = inputs.terminal;
    const bound = t.boundToken ? token(t.boundToken) : null;
    if (bound) {
      out.push({
        tier: "place", id: bound, label: locations[bound]?.name ?? t.boundToken!, at: t.at,
        source: "a shop terminal you used, at a place the log had named",
        detail: t.label,
      });
    } else {
      const named = uniqueFromShopName(idx, locations, t.shopName);
      // ⚠️ The RECORD decides the tier. Five shop names in the corpus resolve to "Pyro", which is a
      // Star — reporting those as a place would put the player at the centre of a sun.
      if (named) {
        out.push({
          tier: named.tier, id: named.id, label: locations[named.id]?.name ?? named.id, at: t.at,
          source: named.tier === "place"
            ? "the shop terminal you used names this place"
            : "the shop terminal you used names this system",
          detail: t.label,
        });
      }
    }
  }

  // -- BODY, from the terrain report ---------------------------------------------------------
  // ⚠️ Only a `planet` reading locates you. A `space` reading says you are near NOTHING, which is
  // real information but not a position — emitting it as a body would put the player at whatever
  // place happened to share the name "space".
  if (inputs.place && inputs.place.kind === "planet") {
    const id = uniqueByName(idx, locations, inputs.place.name, sys);
    if (id) {
      out.push({
        tier: "body", id, label: locations[id]?.name ?? inputs.place.name,
        at: inputs.place.at,
        source: "the game reported terrain streaming near this body",
      });
    }
  }

  // -- SYSTEM, from quantum navigation -------------------------------------------------------
  if (sys) {
    const star = starOf(locations, sys);
    if (star) {
      out.push({
        tier: "system", id: star.id, label: star.label,
        // 🔴 No timestamp rides the system reading, and `resolveOrigin` gives this tier an
        // infinite trust window anyway — you cannot leave a system without a jump, and a jump
        // writes more of these. Stamping it `now` is therefore honest rather than flattering:
        // it really is current.
        at: deps.now ? deps.now() : Date.now(),
        source: "the last quantum route named this system",
      });
    }
  }

  return out;
}
