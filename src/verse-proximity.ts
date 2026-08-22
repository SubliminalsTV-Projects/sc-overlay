/**
 * VERSE FINDER — ORDERING SHOPS BY HOW CLOSE THEY ARE, AND SAYING WHICH KIND OF CLOSE.
 *
 * Sub's ask: results sorted by how near they are to the player. The honest version of that ask is
 * harder than it sounds, because the two halves have completely different confidence:
 *
 *   THE DESTINATION IS EXACT.   Measured 2026-08-21: all 461 shop terminals in the table resolve
 *                               to a starmap place that has coordinates, with ZERO ambiguity.
 *   THE ORIGIN IS INFERRED.     Nothing in `game.log` fires when the player LEAVES anywhere, so
 *                               where they are is always a last-known, sometimes hours old.
 *
 * 🔴 SO THE UNCERTAINTY IS ENTIRELY ON THE PLAYER'S SIDE, AND THAT IS WHAT THE ORDERING MUST
 * DEGRADE ON. `player-origin.ts` already grades the reading (place / body / system / unknown, with
 * a trust window each); this module turns that grade into a KIND of ordering, and every result
 * says which kind it got. Three bases, and they are genuinely different claims:
 *
 *   "travel-time"   a real origin with coordinates — minutes, from `travel-model.ts`.
 *   "containment"   we know roughly where you are: same place, then same body, then same system.
 *                   No numbers, because a number here would be invented precision.
 *   "none"          we do not know where you are. Order is left ALONE (cheapest first) and the UI
 *                   says why. 🔴 Never a default origin — putting the player somewhere plausible
 *                   and presenting the resulting distances as fact is the exact mistake this
 *                   codebase names: "an ambiguous match resolves to NOTHING, because putting the
 *                   player at the wrong outpost is worse than not knowing."
 *
 * 🔴 A STALE READING IS DOWNGRADED TO CONTAINMENT, NOT RENDERED AS MINUTES. "You are 6 minutes
 * away" computed from a fix taken forty minutes ago is a precise-looking statement about a place
 * the player has probably left. Containment survives that ("still in Stanton" is very likely true
 * even if "still at Area18" is not), which is why it is the fallback rather than silence.
 *
 * -- THE TERMINAL -> STARMAP JOIN, and why it is by name AND system ---------------------------
 *
 * UEX gives a terminal a `place`/`body`/`sys` NAME; `locations-xyz` is keyed by starmap UUID. The
 * bridge is `locations.json`, which carries both. Measured over the whole table:
 *
 *   443 of 461 resolve on the terminal's own `place`, 18 more on its `body`. 100%, 0 ambiguous.
 *
 * ⚠️ NAME ALONE IS NOT ENOUGH, and the gateways prove it: "Nyx Gateway" exists in BOTH Stanton and
 * Pyro, which is precisely why UEX writes them as "Nyx Gateway (Stanton)". Matching on name only
 * would silently place a Pyro shop in Stanton — a wrong answer that looks like a right one. So the
 * key is name + system, and the parenthesised suffix is stripped before matching.
 * 🔑 Unrelated to travel-model's finding that some gateway NAMES are lies (Stanton's "Nyx Gateway"
 * really leads to Magnus). That is about topology and `deriveGateways` handles it; this is only
 * about where the station physically sits, for which the name is a perfectly good key.
 */
import type { ResolvedQuote } from "./item-search.js";
import type { ShopTerminal } from "./item-shops.js";
import type { OriginVerdict } from "./player-origin.js";
import { travelMinutes, type TravelDeps, type TravelBasis } from "./travel-model.js";

export type OrderBasis = "travel-time" | "containment" | "none";

export type Containment = "same-place" | "same-body" | "same-system" | "elsewhere";

export interface ProximityQuote extends ResolvedQuote {
  /** Minutes to fly there, or null when this ordering does not produce numbers.
   *
   *  ⚠️ THIS IS THE ORDERING KEY, NOT THE THING TO SHOW. It is composed from a jump estimate and an
   *  effective quantum speed with no fixed spool term, so it is optimistic at short range — see
   *  `inSystemMinutes`. `metres` below is exact, and is what the widget renders. */
  minutes: number | null;
  /**
   * 🔴 STRAIGHT-LINE DISTANCE, AND ONLY WHEN THAT PHRASE MEANS SOMETHING — null across systems.
   *
   * Sub asked to see distance rather than minutes, and distance is the honest half of this pair:
   * every one of the 461 terminals resolves to a starmap place with real metre coordinates, so
   * this number is measured where the minutes are modelled.
   *
   * 🔑 It is null for a cross-system shop ON PURPOSE. `locations-xyz` is per-system frames — its
   * own `units` field says "coordinates are NOT comparable across systems" — so subtracting a Pyro
   * coordinate from a Stanton one produces a number with no meaning. `jumps` is what carries
   * "how far" in that case, because that is genuinely what the answer is.
   */
  metres: number | null;
  /** Wormhole transits between you and this shop; 0 for same-system. Null when no route was built. */
  jumps: number | null;
  /** Only as measured as the route's weakest leg — a cross-system hop is always "estimated",
   *  because the wormhole transit itself has never been measured. */
  travelBasis: TravelBasis | null;
  /** How this shop relates to where the player is. Present on BOTH numeric and containment
   *  ordering: it is what lets the UI group rows without re-deriving anything. */
  containment: Containment | null;
}

export interface ProximityOrder {
  basis: OrderBasis;
  /** One plain sentence naming what the order means, rendered verbatim. The UI must never invent
   *  its own wording for this — the whole point is that the claim matches the evidence. */
  note: string;
  quotes: ProximityQuote[];
}

/** A minimal view of `locations.json`, so this module needs no loader of its own. */
export interface LocationRecord {
  name?: string;
  system?: string;
  parent?: string | null;
  parentName?: string | null;
}

/* ── The terminal -> starmap place index ─────────────────────────────────────────────────────── */

export interface TerminalIndex {
  /** Terminal NAME -> starmap place id. Terminal names are unique in the table (461/461,
   *  measured), and `collisions` is carried so that stopping being true is visible rather than
   *  silently resolving to whichever one was indexed last. */
  byTerminal: Map<string, string>;
  resolved: number;
  total: number;
  collisions: number;
  /** Terminals whose name matched more than one starmap place and were therefore REFUSED rather
   *  than guessed. Surfaced so a data change makes itself known instead of mis-placing a shop. */
  ambiguous: number;
}

const lower = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/** "Nyx Gateway (Stanton)" -> "nyx gateway". UEX disambiguates with a parenthesised system; we
 *  disambiguate with the system field, so the suffix is noise here. */
export function stripSystemSuffix(name: string | null | undefined): string {
  return lower(name).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * The match key: lowercased, parenthetical dropped, and every non-alphanumeric removed.
 *
 * 🔴 UEX AND THE STARMAP DISAGREE ABOUT SPACES. UEX writes "Area 18"; the starmap says "Area18".
 * Matching the literal strings sent every Area 18 shop to its FALLBACK — the planet ArcCorp —
 * so the join still read 100% while quietly placing city shops at a planet's centre. A coverage
 * number cannot see that class of error; only looking at what matched can.
 *
 * ⚠️ This is deliberately NOT the punctuation-stripping that `item-search.ts` warns against. That
 * warning is about SUBSTRING matching, where squashing lets "Atlas" match "Grey**cat Las**er"
 * across a word boundary. Here the whole key must be equal, so squashing can only ever merge two
 * names that differ by spacing or punctuation. Measured over the real table: of 36 squashed keys
 * holding more than one place, **0 join genuinely different spellings** — every one is the starmap
 * carrying repeated rows under an identical name (28 "Derelict Outpost" in Pyro alone).
 */
export function matchKey(name: string | null | undefined): string {
  return stripSystemSuffix(name).replace(/[^a-z0-9]/g, "");
}

/** "Stanton System" -> "stanton". */
export function systemKey(s: string | null | undefined): string {
  return lower(s).replace(/\s+system\s*$/, "").trim();
}

export function buildTerminalIndex(
  terminals: readonly ShopTerminal[],
  locations: Record<string, LocationRecord>,
): TerminalIndex {
  // key@system -> ids. Built once; the table is ~2,000 places.
  const byNameSys = new Map<string, string[]>();
  for (const [id, rec] of Object.entries(locations)) {
    const n = matchKey(rec?.name);
    if (!n) continue;
    const k = n + "@" + systemKey(rec?.system);
    const cur = byNameSys.get(k);
    if (cur) cur.push(id);
    else byNameSys.set(k, [id]);
  }

  const byTerminal = new Map<string, string>();
  let resolved = 0;
  let collisions = 0;
  let ambiguous = 0;
  for (const t of terminals) {
    if (byTerminal.has(t.n)) { collisions++; continue; }
    const sys = systemKey(t.sys);
    // Place first, body second. A shop's `place` is where you actually dock; `body` is the
    // fallback for the handful of terminals UEX files against a moon with no settlement named.
    for (const cand of [matchKey(t.place), matchKey(t.body)]) {
      if (!cand) continue;
      const ids = byNameSys.get(cand + "@" + sys);
      if (!ids?.length) continue;
      // 🔴 AN AMBIGUOUS NAME RESOLVES TO NOTHING. The starmap holds 28 places called "Derelict
      // Outpost" in Pyro; taking the first would put a shop at an arbitrary one of them, which is
      // this codebase's named failure — "putting the player at the wrong outpost is worse than not
      // knowing". No shop in the table hits this today (measured: 0), and the counter is what
      // makes it visible if a patch ever changes that.
      if (ids.length > 1) { ambiguous++; break; }
      byTerminal.set(t.n, ids[0]);
      resolved++;
      break;
    }
  }
  return { byTerminal, resolved, total: terminals.length, collisions, ambiguous };
}

/* ── Containment ─────────────────────────────────────────────────────────────────────────────── */

/** Walk a place's parent chain, nearest first. Guarded against a cycle in the data, which would
 *  otherwise hang the sidecar rather than merely mis-sort a list. */
function ancestry(id: string, locations: Record<string, LocationRecord>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = locations[cur]?.parent ?? null;
  }
  return out;
}

export function containmentOf(
  originId: string,
  originTier: OriginVerdict["tier"],
  placeId: string | null,
  locations: Record<string, LocationRecord>,
): Containment {
  if (!placeId) return "elsewhere";
  if (placeId === originId) return "same-place";

  const shopChain = ancestry(placeId, locations);
  // The origin may itself be a body or a system token rather than a place id, so compare against
  // the shop's whole chain rather than assuming the origin is a leaf.
  if (shopChain.includes(originId)) return originTier === "system" ? "same-system" : "same-body";

  const originChain = ancestry(originId, locations);
  for (const a of originChain) {
    if (a === originId) continue;
    if (shopChain.includes(a)) {
      // The shallowest shared ancestor that is not the system is a body; the system is the system.
      const sameSys = systemKey(locations[a]?.system) === systemKey(locations[placeId]?.system);
      return a === originChain[originChain.length - 1] && sameSys ? "same-system" : "same-body";
    }
  }
  if (systemKey(locations[originId]?.system) &&
      systemKey(locations[originId]?.system) === systemKey(locations[placeId]?.system)) {
    return "same-system";
  }
  return "elsewhere";
}

const CONTAINMENT_RANK: Record<Containment, number> = {
  "same-place": 0, "same-body": 1, "same-system": 2, elsewhere: 3,
};

/**
 * How old the fix is, in words.
 *
 * 🔴 THE UNIT IS ALWAYS SPELLED, because "m" is ambiguous between metres, megametres and minutes
 * and all three are live in this widget — Sub read "New Babbage 4M away" as a distance when it was
 * this figure. Same rule as `originSummary`, which is where the other copy lives.
 *
 * ⚠️ AND IT ROLLS OVER TO HOURS. Seen live on Sub's dev app after an overnight gap: the note read
 * **"seen 649 min ago"**. Not wrong, but nobody counts in hundreds of minutes, and it sat beside a
 * summary from `originSummary` that had correctly said "11h ago" — the same quantity, in the same
 * footer, in two different units. A shared helper is the point: the rollover has to move in one
 * place or the two drift apart again.
 */
function agoPhrase(ageMin: number): string {
  if (ageMin < 60) return Math.round(ageMin) + " min ago";
  const h = ageMin / 60;
  if (h < 24) return Math.round(h) + "h ago";
  return Math.round(h / 24) + "d ago";
}

/* ── The ordering ────────────────────────────────────────────────────────────────────────────── */

export interface ProximityDeps {
  index: TerminalIndex;
  locations: Record<string, LocationRecord>;
  travel: TravelDeps;
  origin: OriginVerdict;
}

/**
 * Order a set of shops, and say what the order means.
 *
 * 🔴 CALL THIS BEFORE TRUNCATING TO N SHOPS, NOT AFTER. `searchItems` returns the CHEAPEST
 * `quotesPerItem` quotes; re-sorting those by distance yields "the nearest of the eight cheapest",
 * which is not what was asked and is wrong exactly when it matters — the median item has 4 shops
 * but the p90 has 19 and the maximum 159.
 */
export function orderByProximity(
  quotes: readonly ResolvedQuote[],
  deps: ProximityDeps,
): ProximityOrder {
  const { origin, index, locations, travel } = deps;
  const plain = (): ProximityQuote[] =>
    quotes.map((q) => ({ ...q, minutes: null, metres: null, jumps: null, travelBasis: null, containment: null }));

  if (origin.tier === "unknown" || !origin.id) {
    return {
      basis: "none",
      note: "Not sorted by distance — nothing this session has said where you are.",
      quotes: plain(),
    };
  }

  const placeOf = (q: ResolvedQuote): string | null => index.byTerminal.get(q.terminal) ?? null;
  const contain = (q: ResolvedQuote): Containment =>
    containmentOf(origin.id!, origin.tier, placeOf(q), locations);

  // 🔴 Stale, or a system-level fix, orders by containment. Minutes from a reading we have already
  // decided not to trust would be precision we do not have.
  const coarse = origin.stale || origin.tier === "system";
  if (!coarse) {
    // 🔑 The straight-line distance is only meaningful inside ONE system's frame, so it is computed
    // here rather than inside travelMinutes: that function deliberately decomposes a cross-system
    // route into legs in two different frames, and there is no single distance to hand back.
    const originPos = travel.posOf(origin.id!);
    const originSys = travel.systemOf(origin.id!);
    const rows: ProximityQuote[] = quotes.map((q) => {
      const pid = placeOf(q);
      const est = pid ? travelMinutes(origin.id!, pid, travel) : null;
      const usable = est && !est.unknown;
      const shopPos = pid ? travel.posOf(pid) : null;
      const sameSystem = !!pid && !!originSys && travel.systemOf(pid) === originSys;
      return {
        ...q,
        minutes: usable ? est!.minutes : null,
        metres: sameSystem && originPos && shopPos
          ? Math.hypot(originPos.x - shopPos.x, originPos.y - shopPos.y, originPos.z - shopPos.z)
          : null,
        // `path` is the systems traversed, so the transits between them is one less.
        jumps: usable ? Math.max(0, est!.path.length - 1) : null,
        travelBasis: usable ? est!.basis : null,
        containment: contain(q),
      };
    });
    // Only claim a travel-time ordering if we actually produced some times.
    if (rows.some((r) => r.minutes !== null)) {
      rows.sort((a, b) => {
        if (a.minutes === null && b.minutes === null) return a.price - b.price;
        // 🔑 A shop we could not route to sorts LAST rather than first. A missing number is not a
        // zero, and this is the `??`-over-a-sparse-column mistake wearing different clothes.
        if (a.minutes === null) return 1;
        if (b.minutes === null) return -1;
        return a.minutes - b.minutes || a.price - b.price;
      });
      return {
        basis: "travel-time",
        note: `Nearest first, from ${origin.label}${origin.ageMin != null && origin.ageMin >= 1 ? ` (seen ${agoPhrase(origin.ageMin)})` : ""}.`,
        quotes: rows,
      };
    }
  }

  // 🔴 Containment ordering states NO distance either. The reason is the same one that downgrades
  // it here in the first place: we do not know precisely where the player is, so a metre figure
  // would be exact-looking arithmetic off an inexact origin — the same false precision as minutes,
  // wearing a unit the player is even more likely to believe.
  const rows: ProximityQuote[] = quotes.map((q) => ({
    ...q, minutes: null, metres: null, jumps: null, travelBasis: null, containment: contain(q),
  }));
  rows.sort((a, b) =>
    CONTAINMENT_RANK[a.containment!] - CONTAINMENT_RANK[b.containment!] || a.price - b.price);
  return {
    basis: "containment",
    note: coarse
      ? `Closest first, roughly — ${origin.label} is the last place we saw you${origin.ageMin != null && origin.ageMin >= 1 ? `, ${agoPhrase(origin.ageMin)}` : ""}.`
      : `Closest first, roughly — we know you are near ${origin.label} but not where exactly.`,
    quotes: rows,
  };
}
