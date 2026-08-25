/**
 * WHERE IS `SCShop_Levski_CargoOffice_ITEM`? — THE ONE PLACE THAT ANSWERS IT.
 *
 * A community price observation carries the GAME's name for a shop. Every other part of the Verse
 * Finder is keyed by UEX's name for it, and the two do not meet: **0 of 75** game tokens match a
 * UEX terminal name and no string comparison bridges them. So the answer has to be looked up, and
 * two separate efforts now produce that lookup:
 *
 *   THE HAND-CURATED MAP     `E:\tmp\joinmap.json` — a human reading tokens against the terminal
 *                            list. Names a terminal, and says how sure it is.
 *   THE LOG REPLAY           flight `shoploc` — replays the location service over the shared-log
 *                            corpus and reports where the player STOOD when they used that shop.
 *                            Frequently places a token it cannot name.
 *
 * 🔑 THEY ARE ONE INTERFACE, NOT TWO CODE PATHS. `ShopPlacement` is what the renderer consumes and
 * `fromJoinMap` / `fromShopLoc` are adapters onto it. A third source — a curated file Sub edits, a
 * later UEX field — is a fourth adapter and touches nothing downstream.
 *
 * 🔴 THIS MODULE DERIVES NOTHING. It has no matcher, no fuzzy compare and no learning: it reads
 * what a source states and merges the statements. That is deliberate, and `price-pool.ts` says why
 * — a LEARNED token→place map poisoned 5 of 27 pairings the one time it was tried, because
 * `SCShop_Cargo_Office` exists at 13 stations. An ambiguous token stays ambiguous here forever.
 *
 * ── 🔴 PRECISION IS LOAD-BEARING, AND HERE IS THE MEASUREMENT THAT MAKES IT SO ────────────────
 *
 * "Exact" means we know the KIOSK. "Place-level" means we know the STATION and have a good guess at
 * the kiosk. It is tempting to treat those as the same thing, because a station's kiosks obviously
 * all charge the same — and they obviously do not. Measured over the shipped table, every item ×
 * place group holding two or more terminals:
 *
 *   2,149 groups · 1,669 agree (77.7%) · **480 DISAGREE (22.3%)**
 *   worst: *Gallant Rifle Battery (45 Cap)* at Seraphim Station — Live Fire Weapons **36 aUEC**,
 *   Armor **396 aUEC**. An 11× error, on a row, presented as the freshest number in the widget.
 *
 * So a place-level placement may never carry a PRICE onto a terminal row. What it may do is
 * refresh that row's AGE when the price it saw is the price already there — see `foldsOnto` — and
 * otherwise it sorts as a row of its own under the right station, which is a true statement and a
 * useful one.
 */

/** How well a source knows which kiosk a token is.
 *
 *  🔴 `exact` may fold a price onto a UEX row. `place-level` may not — it is the right station and
 *  possibly the wrong kiosk, and the 22.3% figure above is what that costs when it is wrong. */
export type PlacePrecision = "exact" | "place-level";

/** Which catalogue a terminal name belongs to. Item terminals and commodity terminals are
 *  different namespaces from different UEX tables — "Levski" is a commodity terminal and there is
 *  no item terminal by that name — so a token resolved for one may not be looked up in the other. */
export type PlaceKind = "item" | "commodity";

/**
 * Everything anyone knows about one game shop token. Every field is independently optional,
 * because the two sources are strong in opposite places: the curated map names terminals it cannot
 * place, and the replay places tokens it cannot name.
 */
export interface ShopPlacement {
  /** The game's own token, verbatim. */
  token: string;
  /** UEX's name for this terminal, when a source can name one. Null is the common case. */
  terminal: string | null;
  /** How sure that name is. Null exactly when `terminal` is null. */
  precision: PlacePrecision | null;
  /** Which terminal namespace `terminal` belongs to. */
  kind: PlaceKind | null;
  /** Starmap place id, when a source can place it. This is the id everything downstream sorts by. */
  placeId: string | null;
  /** A readable name for that place, for the group heading. */
  place: string | null;
  /**
   * How precise `placeId` is — `place` is a station, `body` a planet or moon, `system` a star.
   *
   * 🔑 A COARSE ID IS SAFE AND HONEST, which is why it is carried rather than refused.
   * `containmentOf` walks the ancestry either way and the best it can return for a star id is
   * `same-system` — exactly the precision that was available. `shoploc`'s `usage.location` says the
   * same thing.
   *
   * ⚠️ `system` CAN BE A JUMP OUT OF DATE. `SystemWatcher` never expires and the wormhole emits no
   * route event, so a player who jumped Stanton → Nyx keeps reporting Stanton until they next spool
   * a drive: 11 of 83 tokens carry a contradicting system observation, 8 of them Levski. It costs
   * ordering, never a price, so it is recorded rather than acted on here.
   */
  tier: "place" | "body" | "system" | null;
}

/** The lookup the rest of the app sees. Deliberately a function rather than a Map, so a future
 *  source that needs to compute an answer needs no change downstream. */
export type ShopPlacer = (token: string) => ShopPlacement | null;

/* ── The rule the renderer asks about ────────────────────────────────────────────────────────── */

/**
 * May this placement put a confirmation onto the UEX row for `terminal`, and on what terms?
 *
 *   "price"   fold outright — the confirmation's price and age both land on the row.
 *   "age"     refresh the row's AGE and mark it confirmed, but leave the price alone.
 *   null      do not fold. The confirmation becomes a row of its own under `placeId`.
 *
 * 🔴 THE `place-level` RULE IS "ONLY WHEN THE PRICE AGREES", AND IT IS NOT A CORRELATE DRESSED AS
 * EVIDENCE. The question a fold answers is "is *this row's* price still current?". When a
 * place-level observation saw the same number the row already carries, that question is answered
 * TRUE whichever kiosk at that station was observed — the two candidate kiosks do not disagree
 * about it, so nothing is being attributed. When the numbers differ, which kiosk it was becomes the
 * whole question, and that is exactly the 36-vs-396 case. So the refusal is not caution about a
 * correlate; it is refusing to answer a question we do not have the evidence for.
 *
 * 🔑 AND IT NEVER MOVES THE PRICE. Sub's ruling that ours beats UEX's applies to `exact`, where we
 * know whose row it is. A place-level fold that could move a number would be that ruling applied to
 * a row we cannot identify.
 */
export function foldsOnto(
  precision: PlacePrecision,
  observedPrice: number,
  rowPrice: number,
): "price" | "age" | null {
  if (precision === "exact") return "price";
  return observedPrice === rowPrice ? "age" : null;
}

/* ── The merge ───────────────────────────────────────────────────────────────────────────────── */

const RANK: Record<PlacePrecision, number> = { exact: 2, "place-level": 1 };

/**
 * Fold several sources' statements about one token into one.
 *
 * 🔴 TWO SOURCES NAMING DIFFERENT TERMINALS RESOLVES TO NEITHER. That is this codebase's standing
 * rule — "putting the player at the wrong outpost is worse than not knowing" — applied to shops.
 * The place survives the disagreement, because two sources naming different kiosks at the same
 * station still agree about the station, and that is the useful half.
 *
 * ⚠️ A stronger precision does NOT win a disagreement about the name. `exact` means the source is
 * confident, not that it is right, and preferring the confident one is how one bad curated row
 * would silently outrank a measurement over 4,258 observations.
 */
export function mergePlacements(parts: readonly ShopPlacement[]): ShopPlacement | null {
  const rows = parts.filter((p) => p && p.token);
  if (!rows.length) return null;
  const out: ShopPlacement = {
    token: rows[0].token,
    terminal: null,
    precision: null,
    kind: null,
    placeId: null,
    place: null,
    tier: null,
  };

  const named = rows.filter((r) => r.terminal);
  const distinct = new Set(named.map((r) => r.terminal));
  if (distinct.size === 1 && named.length) {
    let best = named[0];
    for (const r of named) {
      if (RANK[r.precision ?? "place-level"] > RANK[best.precision ?? "place-level"]) best = r;
    }
    out.terminal = best.terminal;
    out.precision = best.precision ?? "place-level";
    out.kind = best.kind ?? null;
  }

  const placed = rows.filter((r) => r.placeId);
  const distinctPlaces = new Set(placed.map((r) => r.placeId));
  // Same rule one level up: two sources putting the token at two different STATIONS is a
  // disagreement we cannot settle, so the token is unplaced rather than placed at one of them.
  if (distinctPlaces.size === 1 && placed.length) {
    out.placeId = placed[0].placeId;
    out.place = placed.find((r) => r.place)?.place ?? null;
    // 🔑 THE FINEST TIER ANY SOURCE CLAIMED, because they all agreed on the id. Taking the coarsest
    // would understate precision we demonstrably have; taking a tier from a DIFFERENT id is what
    // the equality check above already rules out.
    out.tier = placed.find((r) => r.tier === "place")?.tier
      ?? placed.find((r) => r.tier === "body")?.tier
      ?? placed.find((r) => r.tier)?.tier
      ?? null;
  }
  // A named terminal with no place is still worth keeping — the terminal index knows where its
  // terminals are, so naming one is itself a placement by another road.
  if (!out.terminal && !out.placeId) return null;
  return out;
}

/* ── The adapters ────────────────────────────────────────────────────────────────────────────── */

/**
 * The hand-curated map (`joinmap.json`).
 *
 * `conf` rows are `[token, observations, terminalName, kind, precision]`. `unconf` rows carry a
 * reason and a candidate list and state NOTHING this module can use — a token with two candidate
 * stores is the ambiguity the whole file exists to preserve, so it is dropped rather than guessed.
 */
export function fromJoinMap(doc: unknown): ShopPlacement[] {
  const d = (doc ?? {}) as { conf?: unknown };
  if (!Array.isArray(d.conf)) return [];
  const out: ShopPlacement[] = [];
  for (const raw of d.conf) {
    if (!Array.isArray(raw)) continue;
    const token = typeof raw[0] === "string" ? raw[0].trim() : "";
    const terminal = typeof raw[2] === "string" ? raw[2].trim() : "";
    if (!token || !terminal) continue;
    const kind: PlaceKind = raw[3] === "commodity" ? "commodity" : "item";
    // ⚠️ ANYTHING THAT IS NOT LITERALLY "exact" IS TREATED AS place-level. An unrecognised tag from
    // a later build of the map must degrade to the cautious reading, never to the one that can put
    // a wrong price on a row.
    const precision: PlacePrecision = raw[4] === "exact" ? "exact" : "place-level";
    out.push({ token, terminal, precision, kind, placeId: null, place: null, tier: null });
  }
  return out;
}

/**
 * The log replay (flight `shoploc`'s `report.json`).
 *
 * Its `verdict` is the field to read, not the presence of `terminal`:
 *   `terminal`         it named the kiosk — `exact`.
 *   `place`            it placed the token and could not name the kiosk.
 *   `place-dependent`  the same token is used at several stations. Places NOTHING, deliberately:
 *                      this is `SCShop_Cargo_Office` and its 13 stations.
 *   `unresolved`       nothing.
 */
export function fromShopLoc(doc: unknown): ShopPlacement[] {
  const d = (doc ?? {}) as { reports?: unknown };
  if (!Array.isArray(d.reports)) return [];
  const out: ShopPlacement[] = [];
  for (const raw of d.reports) {
    const r = (raw ?? {}) as {
      token?: unknown; verdict?: unknown; terminal?: unknown;
      places?: unknown; kind?: unknown;
    };
    const token = typeof r.token === "string" ? r.token.trim() : "";
    if (!token) continue;
    if (r.verdict !== "terminal" && r.verdict !== "place") continue;
    const places = Array.isArray(r.places) ? r.places : [];
    // 🔴 ONE PLACE OR NONE. A verdict of `place` with two entries is the ambiguous case wearing the
    // confident verdict's clothes, and taking the first would be picking an outpost at random.
    const first = places.length === 1
      ? (places[0] ?? {}) as { id?: unknown; name?: unknown }
      : {} as { id?: unknown; name?: unknown };
    const placeId = typeof first.id === "string" ? first.id : null;
    const place = typeof first.name === "string" ? first.name : null;
    const terminal = r.verdict === "terminal" && typeof r.terminal === "string" ? r.terminal.trim() : null;
    if (!terminal && !placeId) continue;
    out.push({
      token,
      terminal: terminal || null,
      precision: terminal ? "exact" : null,
      kind: terminal ? (r.kind === "commodity" ? "commodity" : "item") : null,
      placeId,
      place,
      // Only a single-place verdict reaches here, so the id is always a station.
      tier: placeId ? "place" : null,
    });
  }
  return out;
}

/**
 * 🔴 `data/shop-terminals.json` — flight `shoploc`'s SHIPPED artifact, and the one this app reads
 * at runtime. Schema `sc-shop-terminals/1`, 83 tokens. Read its `usage` block before changing any
 * of the four rules below; each one is written there in as many words.
 *
 *   `outcome: "named"`     → a UEX terminal. Folds, at `exact`.
 *   `outcome: "placed"`    → the log says WHERE at some tier and nothing joins it to a terminal
 *                            name. Sorts inline, names nothing.
 *   `outcome: "unplaced"`  → the log never said where the player was. Nothing.
 *   `verdict: "place-dependent"` → refused outright. See below; this is not the same as `unplaced`.
 *
 * 🔴 `outcome: "placed"` NEVER LICENSES NAMING A KIOSK, and `provisionalTerminal` is not a back
 * door into it. The file marks that field *"believable, not corroborated, and not safe to attribute
 * a price with"* — 14 tokens carry one — so this adapter ignores it completely. A name we are not
 * sure of is the poisoning `shoploc` spent a whole flight avoiding.
 *
 * 🔴 A `place-dependent` TOKEN IS REFUSED ENTIRELY, EVEN THOUGH IT HAS A USABLE `location.id`, AND
 * THAT IS THE ONE PLACE THIS ADAPTER IS STRICTER THAN THE FILE. The tower measured what such a
 * token's price means: the same prefab shop is priced PER STATION, and against UEX across the exact
 * stations where one token was observed — Dolivine identical, Party Favors 4.1%, Processed Food
 * 7.1%, Hydrogen 10.0%, Stims 11.5%, **Compboard 22.2% (27,000 → 33,000)**. The community pool has
 * already collapsed those stations into ONE median before this app ever sees them, so rendering
 * such a row is showing a figure blended across shops that measurably disagree — which the same
 * finding forbids. It still SORTS in principle; there is simply no honest number to put on the row,
 * so it is counted instead of drawn. 9 tokens of 83.
 * ⚠️ `usage.place-dependent` says such a token is *"still resolvable AT RUNTIME — the app already
 * knows where the player is"*. **That is true only for this player's OWN new observations.** A
 * pooled row stores the shop token, not the contributor's position, so using the local player's
 * location to name it would attribute a stranger's price to a station they were never at. There is
 * no code path here that reads player position, and there must never be one.
 */
export function fromShopTerminals(doc: unknown): ShopPlacement[] {
  const d = (doc ?? {}) as { tokens?: unknown };
  const tokens = (d.tokens ?? {}) as Record<string, unknown>;
  if (!tokens || typeof tokens !== "object") return [];
  const out: ShopPlacement[] = [];
  for (const [token, raw] of Object.entries(tokens)) {
    const r = (raw ?? {}) as {
      outcome?: unknown; verdict?: unknown; terminal?: unknown;
      // Declared but never read — see the header. It is here so the negative control that tries to
      // use it can COMPILE; a control that dies on a type error is red for the wrong reason and
      // proves nothing about the rule it aimed at.
      provisionalTerminal?: unknown;
      location?: unknown; soldBy?: unknown;
    };
    if (!token) continue;
    // The blend case. Refused before anything else, so no later branch can rescue it.
    if (r.verdict === "place-dependent") continue;

    const loc = (r.location ?? {}) as { tier?: unknown; id?: unknown; name?: unknown };
    const tierRaw = loc.tier;
    const tier = tierRaw === "place" || tierRaw === "body" || tierRaw === "system" ? tierRaw : null;
    const placeId = tier && typeof loc.id === "string" ? loc.id : null;

    // 🔑 `soldBy` DECIDES THE NAMESPACE, and it has to: item terminals and commodity terminals are
    // different UEX tables. Measured over the 14 named tokens — the 12 `item` ones all appear in
    // `data/item-shops.json` and the 2 `commodity` ones (both TDD counters) appear in neither, as
    // they should. Looking one up in the other's table returns nothing forever, which is
    // indistinguishable from "nobody has bought this".
    const soldBy = Array.isArray(r.soldBy) ? r.soldBy : [];
    const kind: PlaceKind = soldBy.includes("commodity") ? "commodity" : "item";
    const named = r.outcome === "named" && typeof r.terminal === "string" && r.terminal.trim()
      ? r.terminal.trim() : null;

    if (!named && !placeId) continue;
    out.push({
      token,
      terminal: named,
      precision: named ? "exact" : null,
      kind: named ? kind : null,
      placeId,
      place: typeof loc.name === "string" ? loc.name : null,
      tier,
    });
  }
  return out;
}

/** The normalised file this app ships (`data/shop-places.json`), which is what the adapters above
 *  are used to BUILD. Read forward: every field is defaulted individually, and a row that states
 *  nothing usable is skipped rather than taking the file down. */
export function fromShopPlacesFile(doc: unknown): ShopPlacement[] {
  const d = (doc ?? {}) as { shops?: unknown };
  const shops = (d.shops ?? {}) as Record<string, unknown>;
  if (!shops || typeof shops !== "object") return [];
  const out: ShopPlacement[] = [];
  for (const [token, raw] of Object.entries(shops)) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const terminal = typeof r.terminal === "string" ? r.terminal.trim() : "";
    const placeId = typeof r.placeId === "string" ? r.placeId.trim() : "";
    if (!terminal && !placeId) continue;
    out.push({
      token,
      terminal: terminal || null,
      precision: terminal ? (r.precision === "exact" ? "exact" : "place-level") : null,
      kind: terminal ? (r.kind === "commodity" ? "commodity" : "item") : null,
      placeId: placeId || null,
      place: typeof r.place === "string" ? r.place : null,
      // Absent means "a station", which is what every row this file has ever carried is — the
      // curated map only ever names kiosks. A coarser tier has to be stated.
      tier: placeId
        ? (r.tier === "system" || r.tier === "body" ? r.tier : "place")
        : null,
    });
  }
  return out;
}

/* ── Building the lookup ─────────────────────────────────────────────────────────────────────── */

/** Index a flat list of statements into the one lookup the app uses. Statements about the same
 *  token are merged by `mergePlacements`, so the caller may concatenate every source's output and
 *  hand it over in one array. */
export function buildPlacer(parts: readonly ShopPlacement[]): ShopPlacer {
  const byToken = new Map<string, ShopPlacement[]>();
  for (const p of parts) {
    if (!p?.token) continue;
    const a = byToken.get(p.token);
    if (a) a.push(p);
    else byToken.set(p.token, [p]);
  }
  const merged = new Map<string, ShopPlacement>();
  for (const [token, rows] of byToken) {
    const m = mergePlacements(rows);
    if (m) merged.set(token, m);
  }
  return (token) => merged.get((token || "").trim()) ?? null;
}

/** How many tokens the lookup can name, place, or both — for `/api/verse/status`, so a diagnostics
 *  report can tell "the map is missing" apart from "the map covers nothing you searched for". */
export function placerCoverage(parts: readonly ShopPlacement[]): {
  tokens: number; named: number; exact: number; placed: number;
} {
  const placer = buildPlacer(parts);
  const tokens = new Set(parts.map((p) => p.token));
  let named = 0, exact = 0, placed = 0;
  for (const t of tokens) {
    const p = placer(t);
    if (!p) continue;
    if (p.terminal) { named++; if (p.precision === "exact") exact++; }
    if (p.placeId) placed++;
  }
  return { tokens: tokens.size, named, exact, placed };
}
