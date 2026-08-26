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
  /** The starmap's own classification — `Star`, `Planet`, `Moon`, `LandingZone`, `Manmade`,
   *  `Outpost`, `Asteroid`… 🔑 Declared because it is LOAD-BEARING, not decorative: it is what
   *  decides which TIER a name resolves at. "Pyro" is a row in this table and it is a Star, so a
   *  source that merely mentions the word may not report a place — see `tierOfRecord` in
   *  `origin-signals.ts`. `starOf` below had been casting for this field for want of a
   *  declaration. */
  type?: string;
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
  /**
   * 🔴 `matchKey(place) + "@" + systemKey(system)` -> starmap ids. THE SAME MAP `byTerminal` IS
   * BUILT FROM, kept rather than discarded so a row that is not in the terminal table can still be
   * placed from its own place/body/system.
   *
   * This is what commodities needed. `byTerminal` is keyed on ITEM-shop terminal names out of
   * `data/item-shops.json`, and no commodity terminal is in that file — so every commodity quote
   * resolved to null, `containmentOf` returned "elsewhere" for all of them, and the Verse Finder
   * silently fell back to ordering commodities by PRICE. Sub, 2026-08-25, standing on Stanton
   * Gateway (Nyx): "when I search for methane, it doesn't show the place that I'm currently at. It
   * shows a place in pyro that has it. And I am not in pyro." The Nyx row was there — seventh,
   * behind two Pyro terminals that were merely cheaper.
   * ⚠️ Ambiguity is refused here exactly as it is for terminals; see `placeIdFromNames`.
   */
  byPlaceName: Map<string, string[]>;
}

/**
 * Place a row from its own place/body/system rather than from a terminal name.
 *
 * 🔑 PLACE FIRST, BODY SECOND — the same order and the same reason as `buildTerminalIndex`: a
 * shop's `place` is where you dock, and `body` is the fallback for rows filed against a moon with
 * no settlement named.
 * 🔴 MORE THAN ONE MATCH RESOLVES TO NOTHING. The starmap holds 28 places called "Derelict Outpost"
 * in Pyro alone, and putting the player at an arbitrary one of them is this codebase's named
 * failure. A null here costs an ordering; a guess states a location that is wrong.
 */
export function placeIdFromNames(
  index: TerminalIndex,
  place: string | null | undefined,
  body: string | null | undefined,
  system: string | null | undefined,
): string | null {
  const sys = systemKey(system);
  for (const cand of [matchKey(place), matchKey(body)]) {
    if (!cand) continue;
    const ids = index.byPlaceName.get(cand + "@" + sys);
    if (!ids?.length) continue;
    if (ids.length > 1) return null;
    return ids[0];
  }
  return null;
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
  return { byTerminal, resolved, total: terminals.length, collisions, ambiguous, byPlaceName: byNameSys };
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
 * 🔴 CAP THE LIST WITHOUT SILENTLY DELETING A WHOLE TIER — Sub's report, 2026-08-23:
 * *"The Verse Finder can only show me what is available in this system. Which of course things in
 * the system should be at the top, but it shouldn't be excluded."*
 *
 * He was right, and the cause was NOT a filter. Nothing in this feature has ever filtered by
 * system; `orderByProximity` ranks `elsewhere` last exactly as designed, and then the caller keeps
 * the first N. Those two correct behaviours compose into an exclusion: once N near shops exist,
 * every far shop falls off the end and the widget cannot say so, because a count of hidden shops
 * ("+152 more") does not tell you that one of them is the only one in Pyro.
 *
 * Measured on the shipped table with the player at Levski (a stale place fix, so containment
 * ordering) — `MedPen (Hemozal)`, 157 shops:
 *
 *   full list   4 same-place · 14 same-system · 32 elsewhere
 *   kept (8)    4 same-place ·  4 same-system ·  0 elsewhere     <- all 32 far rows gone
 *
 * So the rule: **every containment tier that has an answer gets to state its best one.** After the
 * cap, any tier present in the full list but absent from the kept rows contributes its FIRST row —
 * which, because the sort is tier-then-price (or minutes-then-price), is the cheapest/nearest shop
 * that tier has. Ranked last, never removed.
 *
 * 🔑 IT APPENDS RATHER THAN TRADING A SLOT, and that is the whole argument for the shape. Reserving
 * a slot inside the cap costs a near row: at a cap of 5 the MedPen card would show its 4 same-place
 * shops plus Pyro and drop all 14 same-system ones, which is Sub's complaint again pointing the
 * other way. Adding is strictly more information than he has today; trading is a different loss.
 * The growth is bounded by the number of tiers (3 at most, and only for an item that really does
 * span all of them), so a card can never run away.
 *
 * ⚠️ A no-op whenever nothing is being hidden, and a no-op when `containment` is null — that is the
 * "we do not know where you are" basis, where every row shares one tier and there is no tier to
 * rescue. Both fall out of the rule rather than being special-cased.
 */
export function reserveTierRows(
  quotes: readonly ProximityQuote[],
  cap: number,
): ProximityQuote[] {
  const kept = quotes.slice(0, Math.max(1, cap));
  if (kept.length >= quotes.length) return kept;
  const seen = new Set<Containment | null>();
  for (const q of kept) seen.add(q.containment);
  const extra: ProximityQuote[] = [];
  // The dropped rows in their existing order, so each tier's first survivor is its best row.
  for (const q of quotes.slice(kept.length)) {
    if (seen.has(q.containment)) continue;
    seen.add(q.containment);
    extra.push(q);
  }
  return extra.length ? kept.concat(extra) : kept;
}

/**
 * 🔴 KEEP ONE PLACE'S ROWS TOGETHER — the widget groups by CONSECUTIVE RUN, so a place split in
 * two draws its heading twice.
 *
 * The renderer's own comment says "results are already ordered by proximity, so shops at the same
 * place are already adjacent". That held while every row's rank came from a distance, because two
 * shops at one station share one distance. It stops holding on a TIE: three `elsewhere` rows all
 * priced 128,145 sort by nothing at all, so Orison · New Babbage · Orison is a legal order — and
 * flight `onerow` made ties routine by appending community rows to the end of the list.
 *
 * 🔑 A STABLE PARTITION, NOT A SECOND SORT KEY. Each place keeps the rank its BEST row earned and
 * its rows keep the order they were already in, so nothing outranks anything it did not outrank
 * before: this can only move a row FORWARD to join its own place, never past a place that beat it.
 * Adding `place` as a tie-break inside the comparator would instead reorder rows that were
 * correctly separated on price.
 */
function keepPlacesTogether<T extends { place: string | null; system: string | null }>(rows: T[]): T[] {
  const order: string[] = [];
  const byPlace = new Map<string, T[]>();
  for (const r of rows) {
    // System included: two systems really do hold a "Nyx Gateway", and merging them would be the
    // name-alone join this file's header warns about, arriving through the back door.
    // ⚠️ Through `systemKey`, because the starmap writes "Stanton System" and UEX writes "Stanton".
    // A row whose location fell back to the starmap would otherwise form a place of its own that
    // reads identically to the real one — the duplicate this function exists to prevent.
    const k = JSON.stringify([lower(r.place), systemKey(r.system)]);
    let a = byPlace.get(k);
    if (!a) { byPlace.set(k, a = []); order.push(k); }
    a.push(r);
  }
  if (order.length === rows.length) return rows;
  const out: T[] = [];
  for (const k of order) out.push(...byPlace.get(k)!);
  return out;
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

  // 🔑 `placeId` FIRST, AND THAT IS WHAT PUTS A COMMUNITY CONFIRMATION IN THE SAME LIST. A row
  // synthesized from an observation has no UEX terminal to look up — that is the whole reason it
  // could not be folded onto one — but it does know its starmap place, so it can be ordered by
  // exactly the same rule as every surveyed shop. Without this the only way to show such a row
  // would be a second list ordered by something else, which is the design Sub rejected.
  /* 🔑 THREE SOURCES, MOST SPECIFIC FIRST, AND THE THIRD IS WHAT MADE COMMODITIES SORTABLE.
     `placeId` is a placement we were handed. `byTerminal` is the UEX item-shop table. Neither
     covers a commodity quote — its terminal is not in `data/item-shops.json` — so without the
     third arm every commodity row placed as null, read as "elsewhere", and the whole list fell
     back to price order while still calling itself proximity-ordered. See `byPlaceName`.
     ⚠️ The order matters and is not arbitrary: a name lookup is the WEAKEST evidence of the three
     and must never outrank a real placement or the surveyed table. */
  const placeOf = (q: ResolvedQuote): string | null =>
    q.placeId
    ?? index.byTerminal.get(q.terminal)
    ?? placeIdFromNames(index, q.place, q.body, q.system);
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
        quotes: keepPlacesTogether(rows),
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
    quotes: keepPlacesTogether(rows),
    note: coarse
      ? `Closest first, roughly — ${origin.label} is the last place we saw you${origin.ageMin != null && origin.ageMin >= 1 ? `, ${agoPhrase(origin.ageMin)}` : ""}.`
      : `Closest first, roughly — we know you are near ${origin.label} but not where exactly.`,
  };
}
